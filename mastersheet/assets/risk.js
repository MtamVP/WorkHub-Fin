/* --- FILE: /mastersheet/assets/risk.js ---
   Tab "Rủi Ro": danh mục đang rủi ro ở đâu? Tập trung theo mã/ngành, biến động, beta, VaR, sụt giảm, tương quan, kịch bản VN-Index giảm.
   Phép tính ở /lib/risk-calc.js (có kiểm thử); dữ liệu thô từ API.asset.getRiskInputs (danh mục + giá lịch sử + sự kiện doanh nghiệp).
   Dùng global của script.js: callGAS, targetEmail, showToast, escapeAssetHtml, cssVar, formatVnd + Chart.js. */

const RK = {
    state: 'idle',            // idle | loading | ok | error
    error: '',
    inputs: null,             // dữ liệu thô (giữ để đổi ngưỡng không phải tải lại)
    result: null,
    windowDays: 365,
    limits: { singleLimit: 25, sectorLimit: 40 },
    chart: null,
};
const RK_LIMITS_KEY = 'wh.fin.risk.limits';

try {
    const saved = JSON.parse(localStorage.getItem(RK_LIMITS_KEY) || 'null');
    if (saved && saved.singleLimit > 0 && saved.sectorLimit > 0) RK.limits = { singleLimit: Number(saved.singleLimit), sectorLimit: Number(saved.sectorLimit) };
} catch (e) { /* không có localStorage: dùng mặc định */ }

const rkEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const rkNum = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toLocaleString('vi-VN', { minimumFractionDigits: d || 0, maximumFractionDigits: d === undefined ? 0 : d });
const rkPct = (v, d, sign) => (v === null || v === undefined || !isFinite(v)) ? '—' : `${sign && v > 0 ? '+' : (v < 0 ? '−' : '')}${Math.abs(v).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d })}%`;
const rkDate = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : '—'; };
const rkVnd = (v) => v === null || v === undefined || !isFinite(v) ? '—' : `${v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('vi-VN')} đ`;

async function loadRisk(force) {
    const body = document.getElementById('rk-body');
    if (!body) return;
    if (RK.state === 'loading') return;
    if (RK.state === 'ok' && !force) { renderRisk(); return; }
    RK.state = 'loading';
    body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang lấy giá lịch sử và tính rủi ro… (có thể mất vài giây)</div>';
    try {
        const r = await callGAS('getRiskInputs', { email: targetEmail, windowDays: RK.windowDays });
        if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
        RK.inputs = r.data;
        RK.state = 'ok';
    } catch (e) {
        RK.state = 'error'; RK.error = e.message || String(e);
    }
    computeRisk();
    renderRisk();
}

function computeRisk() {
    if (RK.state !== 'ok' || !RK.inputs) { RK.result = null; return; }
    const i = RK.inputs;
    RK.result = RiskCalc.analyze({ holdings: i.holdings, cash: i.cash, debt: i.debt, histories: i.histories, events: i.events, navHistory: i.navHistory },
        { windowDays: RK.windowDays, singleLimit: RK.limits.singleLimit, sectorLimit: RK.limits.sectorLimit });
}

function rkChangeWindow(sel) { RK.windowDays = Number(sel.value) || 365; RK.state = 'idle'; loadRisk(true); }

function rkSaveLimits() {
    const single = Number(document.getElementById('rk-limit-single').value), sector = Number(document.getElementById('rk-limit-sector').value);
    if (!(single >= 5 && single <= 100) || !(sector >= 10 && sector <= 100)) { showToast('Ngưỡng mã từ 5–100%, ngưỡng ngành từ 10–100%.', 'error'); return; }
    RK.limits = { singleLimit: single, sectorLimit: sector };
    try { localStorage.setItem(RK_LIMITS_KEY, JSON.stringify(RK.limits)); } catch (e) { /* bỏ qua */ }
    computeRisk(); renderRisk();
    showToast('Đã lưu ngưỡng cảnh báo.', 'success');
}

// ---------- vẽ ----------
const RK_ICON = { high: 'fa-circle-exclamation', med: 'fa-triangle-exclamation', low: 'fa-circle-info' };

function rkKpi(label, value, sub, cls, title) {
    return `<div class="tl-kpi"${title ? ` title="${rkEsc(title)}"` : ''}><span class="k">${rkEsc(label)}</span><span class="v ${cls || ''}">${value}</span><span class="s">${sub || ''}</span></div>`;
}

function rkBar(pct, max, cls) {
    return `<span class="rk-bar ${cls || ''}"><i style="width:${Math.max(0, Math.min(100, pct / max * 100)).toFixed(1)}%"></i></span>`;
}

function rkWarnings(r) {
    if (!r.warnings || !r.warnings.length) {
        return '<div class="rk-ok"><i class="fa-solid fa-circle-check"></i><span>Không có cảnh báo nào theo các ngưỡng hiện tại.</span></div>';
    }
    return `<div class="rk-warns">${r.warnings.map(w => `<div class="rk-warn ${w.level}"><i class="fa-solid ${RK_ICON[w.level]}"></i><span>${rkEsc(w.text)}</span></div>`).join('')}</div>`;
}

function rkKpis(r) {
    const p = r.portfolio, c = r.concentration;
    const out = [];
    if (p) {
        out.push(rkKpi('Biến động / năm', rkPct(p.annVol, 1), `VN-Index ${rkPct(p.benchAnnVol, 1)}`, p.annVol > p.benchAnnVol * 1.3 ? 'tl-down' : '', 'Độ lệch chuẩn của lợi suất ngày × √252, tính với tỷ trọng hiện tại'));
        out.push(rkKpi('Beta', rkNum(p.beta, 2), p.beta !== null ? (p.beta > 1.05 ? 'Nhạy hơn thị trường' : (p.beta < 0.95 ? 'Ít nhạy hơn thị trường' : 'Gần như thị trường')) : '', '', 'VN-Index thay đổi 1% thì danh mục thường thay đổi khoảng beta %'));
        out.push(rkKpi('VaR 95% · 1 ngày', rkPct(p.varPct, 2), `Khoảng ${rkVnd(p.varVnd)} trên NAV hiện tại`, 'tl-down', 'Trong 100 phiên, chỉ khoảng 5 phiên lỗ nặng hơn mức này (theo lịch sử cửa sổ đang chọn)'));
        out.push(rkKpi('Lỗ trung bình ngày xấu', rkPct(p.cvarPct, 2), `Phiên xấu nhất ${rkPct(p.worstDayPct, 1)}`, 'tl-down', 'CVaR: trung bình các phiên nằm trong nhóm 5% tệ nhất'));
        out.push(rkKpi('Sụt giảm tối đa', rkPct(p.maxDD, 1), p.maxDDPeak ? `${rkDate(p.maxDDPeak)} → ${rkDate(p.maxDDTrough)}${p.maxDDRecovered ? ` · đã hồi ${rkDate(p.maxDDRecovered)}` : ' · chưa hồi'}` : 'Không có', 'tl-down', 'Mức giảm sâu nhất từ đỉnh xuống đáy nếu giữ danh mục hiện tại suốt kỳ'));
        out.push(rkKpi('Đang cách đỉnh', rkPct(p.curDD, 1), `VN-Index ${rkPct(p.benchCurDD, 1)}`, p.curDD <= -10 ? 'tl-down' : ''));
    }
    out.push(rkKpi('Số mã hiệu dụng', rkNum(c.effectiveN, 1), `${c.count} mã đang giữ`, '', 'Số mã “đều nhau” tương đương mức tập trung hiện tại (1 chia tổng bình phương tỷ trọng)'));
    out.push(rkKpi('Đòn bẩy / tiền mặt', r.debt > 0 ? `${rkNum(r.leverage, 2)}×` : rkPct(r.cashPct, 0), r.debt > 0 ? `Nợ ${rkVnd(r.debt)}` : 'Tiền mặt trên NAV', r.leverage > 1.001 ? 'tl-down' : '', 'Đòn bẩy = giá trị cổ phiếu / NAV'));
    return `<div class="tl-kpis">${out.join('')}</div>`;
}

function rkSymbolTable(r) {
    const hasStats = r.ok;
    const maxW = Math.max(...r.symbols.map(s => s.weightPct), 1);
    const maxR = hasStats ? Math.max(...r.symbols.map(s => s.riskSharePct || 0), 1) : 1;
    const rows = r.symbols.map(s => {
        const over = r.concentration.count >= 2 && s.weightPct >= r.options.singleLimit;
        const sub = typeof VN_NAMES !== 'undefined' ? VN_NAMES[String(s.symbol).toUpperCase()] : '';
        return `<tr>
            <td><span class="symbol-name">${rkEsc(s.symbol)}<span class="symbol-sub">${rkEsc(sub || s.sector)}</span></span></td>
            <td class="text-right">${rkVnd(s.value)}</td>
            <td><span class="rk-pair"><b class="${over ? 'tl-down' : ''}">${rkPct(s.weightPct, 1)}</b>${rkBar(s.weightPct, maxW, over ? 'over' : '')}</span></td>
            ${hasStats ? `<td><span class="rk-pair"><b class="${(s.riskSharePct || 0) >= s.weightPct * 1.5 && s.riskSharePct >= 25 ? 'tl-down' : ''}">${s.missing ? '—' : rkPct(s.riskSharePct, 1)}</b>${s.missing ? '' : rkBar(s.riskSharePct || 0, maxR, 'risk')}</span></td>
            <td class="text-right">${s.missing ? '—' : rkPct(s.annVol, 0)}</td>
            <td class="text-right">${s.missing ? '—' : rkNum(s.beta, 2)}</td>
            <td class="text-right tl-down">${s.missing ? '—' : rkPct(s.maxDD, 0)}</td>
            <td class="text-right ${s.missing ? '' : (s.fromHighPct <= -15 ? 'tl-down' : '')}">${s.missing ? '—' : rkPct(s.fromHighPct, 1)}</td>` : ''}
        </tr>`;
    }).join('');
    return `<div class="spreadsheet-wrapper"><table class="excel-table asset-table rk-table">
        <thead><tr><th>Mã</th><th class="text-right">Giá trị</th><th title="Tỷ trọng trên giá trị cổ phiếu">Tỷ trọng</th>
        ${hasStats ? `<th title="Phần biến động của cả danh mục do mã này gây ra (tính cả tương quan với các mã còn lại). Cao hơn tỷ trọng = mã này làm danh mục rung lắc nhiều hơn phần vốn nó chiếm">Đóng góp rủi ro</th>
        <th class="text-right">Biến động/năm</th><th class="text-right" title="So với VN-Index">Beta</th><th class="text-right">Sụt giảm tối đa</th><th class="text-right" title="Giá hiện tại so với đỉnh cao nhất trong kỳ">Cách đỉnh kỳ</th>` : ''}</tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}

function rkSectors(r) {
    const max = Math.max(...r.sectors.map(s => s.weightPct), 1);
    const lim = r.options.sectorLimit;
    return `<div class="rk-sectors">${r.sectors.map(s => {
        const over = s.sector !== FinCalc.UNKNOWN_SECTOR && s.symbols.length >= 2 && s.weightPct >= lim;
        return `<div class="rk-sector-row" title="${rkEsc(s.symbols.join(', '))}">
            <span class="rk-sector-name">${rkEsc(s.sector)}</span>
            ${rkBar(s.weightPct, Math.max(max, lim), over ? 'over' : '')}
            <span class="rk-sector-val"><b class="${over ? 'tl-down' : ''}">${rkPct(s.weightPct, 0)}</b>${r.ok && s.riskSharePct !== undefined ? `<small>rủi ro ${rkPct(s.riskSharePct, 0)}</small>` : ''}</span>
        </div>`;
    }).join('')}</div>`;
}

function rkCorrCell(v) {
    if (v === null) return '<td class="rk-corr">—</td>';
    const a = Math.round(Math.min(Math.abs(v), 1) * 70);
    const color = v >= 0 ? 'var(--danger-color)' : 'var(--success-color)';
    return `<td class="rk-corr" style="background:color-mix(in srgb, ${color} ${a}%, transparent)">${rkNum(v, 2)}</td>`;
}

function rkCorrelation(r) {
    const c = r.correlation;
    if (!c || c.symbols.length < 2) return '<div class="tl-empty" style="padding:14px">Cần ít nhất 2 mã có đủ dữ liệu giá để tính tương quan.</div>';
    const head = `<tr><th></th>${c.symbols.map(s => `<th class="rk-corr-h">${rkEsc(s)}</th>`).join('')}</tr>`;
    const rows = c.symbols.map((a, i) => `<tr><th class="rk-corr-h">${rkEsc(a)}</th>${c.matrix[i].map((v, j) => i === j ? '<td class="rk-corr self">1</td>' : rkCorrCell(v)).join('')}</tr>`).join('');
    const hi = c.pairs.filter(p => p.corr >= r.options.corrThreshold).slice(0, 4);
    return `<div style="overflow-x:auto"><table class="rk-corr-table">${head}${rows}</table></div>
        <p class="tl-hint">Tương quan càng gần <b>1</b> (đỏ đậm) thì hai mã càng lên/xuống cùng lúc, nên gom cả hai không giúp phân tán rủi ro.
        ${c.avg !== null ? `Trung bình các cặp: <b>${rkNum(c.avg, 2)}</b>.` : ''}
        ${hi.length ? `Cặp giống nhau nhất: ${hi.map(p => `<b>${rkEsc(p.a)}–${rkEsc(p.b)}</b> (${rkNum(p.corr, 2)})`).join(', ')}.` : 'Không có cặp nào vượt ngưỡng ' + rkNum(r.options.corrThreshold, 1) + '.'}</p>`;
}

function rkStress(r) {
    const rows = r.stress.map(s => `<tr><td>VN-Index ${rkPct(s.indexMovePct, 0, true)}</td>
        <td class="text-right tl-down"><b>${rkPct(s.portfolioPct, 1, true)}</b></td><td class="text-right tl-down">${rkVnd(s.vnd)}</td>
        <td class="rk-stress-detail">${s.bySymbol.slice().sort((a, b) => a.vnd - b.vnd).slice(0, 3).map(x => `${rkEsc(x.symbol)} ${rkPct(x.pct, 0, true)}`).join(' · ')}</td></tr>`).join('');
    return `<div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Kịch bản</th><th class="text-right">NAV ước tính</th><th class="text-right">Thay đổi</th><th>Mã giảm nhiều nhất</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="tl-hint">Ước tính = beta điều chỉnh của từng mã × mức giảm VN-Index, trên NAV hiện tại. Đây là mức <b>thường gặp</b> theo quá khứ, không phải mức tối đa — những phiên hoảng loạn có thể tệ hơn.</p>`;
}

function rkActual(r) {
    const a = r.actual;
    if (!a) return '';
    return `<p class="tl-hint"><b>Thực tế từ NAV bạn đã chụp</b> (${a.points} điểm, ${rkDate(a.from)} → ${rkDate(a.to)}, đã loại ngày nạp/rút vốn): sụt giảm tối đa <b class="tl-down">${rkPct(a.maxDD * 100, 1)}</b>${a.peakDate ? ` (${rkDate(a.peakDate)} → ${rkDate(a.troughDate)})` : ''}, hiện cách đỉnh <b>${rkPct(a.current * 100, 1)}</b>.</p>`;
}

function rkCoverage(r, i) {
    const cv = r.coverage;
    const notes = [];
    if (cv && cv.from) notes.push(`Giá từ <b>${rkDate(cv.from)}</b> đến <b>${rkDate(cv.to)}</b> (${cv.days} phiên)`);
    if (cv) notes.push(`${cv.used.length}/${r.symbols.length} mã đủ dữ liệu`);
    if (cv && cv.adjusted) notes.push('giá đã điều chỉnh theo cổ phiếu thưởng và cổ tức');
    let warn = '';
    if (i && i.historyError) warn += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được giá lịch sử: ${rkEsc(i.historyError)}. Các chỉ số biến động/VaR/tương quan chưa tính được; phần tập trung vẫn hiển thị.</span></div>`;
    if (i && i.eventsError) warn += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được sự kiện doanh nghiệp (${rkEsc(i.eventsError)}) nên giá chưa được điều chỉnh theo cổ phiếu thưởng — mã vừa chia thưởng có thể bị tính biến động cao hơn thực tế.</span></div>`;
    return `${warn}<div class="rk-meta">${notes.join(' · ')}</div>`;
}

// Dựng HTML phân tích rủi ro cho một kết quả RiskCalc.analyze. Dùng chung cho tab Rủi Ro cá nhân và Rủi Ro cấp nhóm (trang Toàn Nhóm).
// ctx: { inputs (có historyError/eventsError), limits:{sectorLimit}, windowDays, chartId }
function rkBuildHtml(r, ctx) {
    let html = rkCoverage(r, ctx.inputs) + `<div class="ce-group-title" style="margin-top:4px">Điều cần chú ý</div>${rkWarnings(r)}`;
    html += rkKpis(r);
    html += `<div class="ce-group-title">Từng mã: vốn chiếm bao nhiêu, rủi ro chiếm bao nhiêu</div>${rkSymbolTable(r)}`;
    html += `<div class="ce-group-title">Theo ngành <small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(ngưỡng ${rkNum(ctx.limits.sectorLimit)}%)</small></div>${rkSectors(r)}`;
    if (r.ok) {
        html += `<div class="ce-group-title">Danh mục từng sụt giảm bao nhiêu từ đỉnh <small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(nếu giữ tỷ trọng hiện tại suốt kỳ)</small></div>
            <div class="tl-card rk-chart-card"><div style="position:relative;height:260px"><canvas id="${ctx.chartId}"></canvas></div></div>${rkActual(r)}`;
        html += `<div class="ce-group-title">Các mã có đi cùng nhau không</div>${rkCorrelation(r)}`;
        html += `<div class="ce-group-title">Nếu thị trường giảm</div>${rkStress(r)}`;
        if (ctx.scope && typeof rkAdvancedHtml === 'function') html += rkAdvancedHtml(ctx.scope, r);   // thanh khoản, kịch bản lịch sử, kịch bản tự đặt
    } else if (r.reason === 'no-history') {
        html += '<div class="tl-empty" style="padding:16px"><i class="fa-solid fa-chart-line"></i>Chưa đủ giá lịch sử (cần tối thiểu ~40 phiên) để tính biến động, VaR, tương quan và kịch bản.</div>' + rkActual(r);
    }
    html += `<details class="tl-details"><summary>Cách tính và giới hạn</summary><div class="tl-hint">
        Mọi chỉ số thống kê là <b>hồi tố với tỷ trọng hiện tại</b> trên giá đóng cửa ${ctx.windowDays >= 700 ? '2 năm' : (ctx.windowDays >= 365 ? '1 năm' : '6 tháng')} gần nhất, so với VN-Index; tiền mặt coi như không sinh lời, nợ vay làm đòn bẩy (chưa tính lãi vay).
        Biến động = độ lệch chuẩn lợi suất ngày × √252. VaR 95% = phân vị 5% của lợi suất ngày. Đóng góp rủi ro = tỷ trọng × hiệp phương sai của mã với danh mục ÷ phương sai danh mục (cộng lại 100%).
        Kịch bản dùng beta điều chỉnh (0,67 × beta + 0,33). Ước lượng từ quá khứ, <b>không phải dự báo</b>, và không phản ánh rủi ro thanh khoản, tin xấu riêng của doanh nghiệp hay giá chạm sàn liên tiếp.
        Phân loại ngành theo bảng nội bộ cho các mã phổ biến; mã ngoài bảng xếp vào “Chưa phân ngành”.</div></details>`;
    return html;
}

function renderRisk() {
    const body = document.getElementById('rk-body');
    if (!body) return;
    const lim = document.getElementById('rk-limit-single');
    if (lim) { lim.value = RK.limits.singleLimit; document.getElementById('rk-limit-sector').value = RK.limits.sectorLimit; }
    if (RK.state === 'loading' || RK.state === 'idle') return;
    if (RK.state === 'error') {
        body.innerHTML = `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được dữ liệu: ${rkEsc(RK.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="loadRisk(true)">Thử lại</button></div>`;
        return;
    }
    const r = RK.result;
    if (RK.chart) { RK.chart.destroy(); RK.chart = null; }
    if (!r || r.reason === 'empty') {
        body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-shield-halved"></i>Chưa có mã nào đang giữ — thêm lệnh mua ở tab Sổ Lệnh để phân tích rủi ro.</div>';
        return;
    }
    const ctx = { inputs: RK.inputs, limits: RK.limits, windowDays: RK.windowDays, chartId: 'rk-dd-chart', scope: 'rk' };
    if (typeof rkxState === 'function') { const x = rkxState('rk'); x.rerender = renderRisk; x.market = RK.inputs; x.holdings = (RK.inputs.holdings || []).map(h => ({ symbol: h.symbol, quantity: h.quantity, value: h.marketValue })); }
    body.innerHTML = rkBuildHtml(r, ctx);
    if (r.ok) RK.chart = rkDrawChart(r, ctx.chartId);
}

function rkDrawChart(r, canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return null;
    const s = r.portfolio.ddSeries;
    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: s.map(x => x.date),
            datasets: [
                { label: 'Danh mục (tỷ trọng hiện tại)', data: s.map(x => x.portfolio), borderColor: cssVar('--danger-color'), backgroundColor: cssVarAlpha('--danger-color', 0.16), fill: true, tension: 0.15, pointRadius: 0, borderWidth: 2 },
                { label: 'VN-Index', data: s.map(x => x.bench), borderColor: cssVar('--text-muted'), borderDash: [5, 4], fill: false, tension: 0.15, pointRadius: 0, borderWidth: 1.5 },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: cssVar('--text-secondary'), boxWidth: 14 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${rkPct(c.raw, 1)}` } } },
            scales: {
                x: { ticks: { color: cssVar('--text-secondary'), maxTicksLimit: 8, callback: function (v) { const d = this.getLabelForValue(v); return d ? d.slice(5).split('-').reverse().join('/') : ''; } }, grid: { color: cssVar('--border-color') } },
                y: { max: 0, ticks: { color: cssVar('--text-secondary'), callback: (v) => `${v}%` }, grid: { color: cssVar('--border-color') } },
            },
        },
    });
}
