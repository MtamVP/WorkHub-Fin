/* --- FILE: /mastersheet/assets/perf.js ---
   Tab Hiệu Suất > "Hiệu Quả So Với Chuẩn": TWR (Modified Dietz), alpha/beta, tracking error, information ratio, Sharpe/Sortino, up/down capture,
   tỷ lệ tháng thắng chuẩn, sụt giảm. Phép tính ở /lib/perf-calc.js (có kiểm thử). Dùng global của script.js: callGAS, targetEmail, showToast,
   escapeAssetHtml, cssVar, cssVarAlpha + Chart.js. */

const PP = {
    state: 'idle',            // idle | loading | ok | error
    error: '',
    inputs: null,
    bench: 'VNINDEX',
    range: 'all',
    rf: PerfCalc.DEFAULT_RF,
    result: null,
    charts: [],
};
const PP_KEY = 'wh.fin.perf.v1';
try {
    const saved = JSON.parse(localStorage.getItem(PP_KEY) || 'null');
    if (saved) {
        if (saved.rf >= 0 && saved.rf <= 0.3) PP.rf = Number(saved.rf);
        if (['VNINDEX', 'VN30'].includes(saved.bench)) PP.bench = saved.bench;
        if (['3m', '6m', 'ytd', '1y', 'all'].includes(saved.range)) PP.range = saved.range;
    }
} catch (e) { /* không có localStorage: dùng mặc định */ }

const ppEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const ppNum = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d });
const ppPct = (v, d, sign) => (v === null || v === undefined || !isFinite(v)) ? '—' : `${sign && v > 0 ? '+' : (v < 0 ? '−' : '')}${Math.abs(v).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d })}%`;
const ppDate = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : '—'; };

function ppSave() { try { localStorage.setItem(PP_KEY, JSON.stringify({ rf: PP.rf, bench: PP.bench, range: PP.range })); } catch (e) { /* bỏ qua */ } }

async function loadPerfPro(force) {
    const body = document.getElementById('pp-body');
    if (!body) return;
    document.getElementById('pp-bench').value = PP.bench;
    document.getElementById('pp-range').value = PP.range;
    document.getElementById('pp-rf').value = (PP.rf * 100).toFixed(1).replace(/\.0$/, '');
    if (PP.state === 'loading') return;
    if (PP.state === 'ok' && !force) { ppRender(); return; }
    PP.state = 'loading';
    body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang lấy lịch sử NAV và giá chuẩn…</div>';
    try {
        const r = await callGAS('getPerfInputs', { email: targetEmail, benchKey: PP.bench });
        if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
        PP.inputs = r.data; PP.state = 'ok';
    } catch (e) { PP.state = 'error'; PP.error = e.message || String(e); }
    ppRender();
}

function ppReload() { PP.bench = document.getElementById('pp-bench').value; PP.state = 'idle'; ppSave(); loadPerfPro(true); }
function ppChangeRange() { PP.range = document.getElementById('pp-range').value; ppSave(); ppRender(); }
function ppUseCurrentRf(v) { if (v >= 0 && v <= 0.3) { PP.rf = Number(v); const el = document.getElementById('pp-rf'); if (el) el.value = (PP.rf * 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); ppSave(); ppRender(); } }
function ppRf() {
    const v = Number(document.getElementById('pp-rf').value);
    if (!(v >= 0 && v <= 30)) { showToast('Lãi phi rủi ro từ 0 đến 30%/năm.', 'error'); return; }
    PP.rf = v / 100; ppSave(); ppRender();
}

function ppKpi(label, value, sub, cls, title) {
    return `<div class="tl-kpi"${title ? ` title="${ppEsc(title)}"` : ''}><span class="k">${ppEsc(label)}</span><span class="v ${cls || ''}">${value}</span><span class="s">${sub || ''}</span></div>`;
}
const ppUpDown = (v) => v > 0 ? 'tl-up' : (v < 0 ? 'tl-down' : '');

function ppRender() {
    const body = document.getElementById('pp-body');
    if (!body) return;
    PP.charts.forEach(c => { try { c.destroy(); } catch (e) { /* đã huỷ */ } }); PP.charts = [];
    if (PP.state === 'loading' || PP.state === 'idle') return;
    if (PP.state === 'error') { body.innerHTML = `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được: ${ppEsc(PP.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="loadPerfPro(true)">Thử lại</button></div>`; return; }
    const inp = PP.inputs;
    const range = PerfCalc.rangeFor(PP.range, new Date().toISOString().slice(0, 10));
    const rfSeries = PerfCalc.rfFromRates(inp.rates, '1Y');
    const a = PerfCalc.analyze({ navHistory: inp.navHistory, bench: inp.bench, rf: PP.rf, rfSeries, dividends: inp.dividends, range });
    PP.result = a;
    const benchName = PP.bench === 'VN30' ? 'VN30' : 'VN-Index';
    if (!a.ok && a.reason === 'few-points') {
        body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-chart-line"></i>Chưa đủ lịch sử NAV để phân tích (cần ít nhất vài lần chụp NAV). App tự chụp NAV mỗi ngày giao dịch — quay lại sau.</div>';
        return;
    }
    let html = '';
    if (inp.benchError) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được giá ${benchName}: ${ppEsc(inp.benchError)}. Các chỉ số so với chuẩn chưa tính được.</span></div>`;
    html += `<div class="rk-meta">${a.periods} kỳ chụp NAV từ <b>${ppDate(a.firstDate)}</b> đến <b>${ppDate(a.lastDate)}</b> (${a.days} ngày) · lợi suất đã loại nạp/rút vốn (Modified Dietz) · chuẩn: ${benchName}</div>`;
    const lines = PerfCalc.narrative(a);
    if (lines.length) html += `<div class="rk-warns">${lines.map(l => `<div class="rk-warn ${l.level === 'warn' ? 'med' : (l.level === 'good' ? 'good' : 'low')}"><i class="fa-solid ${l.level === 'warn' ? 'fa-triangle-exclamation' : (l.level === 'good' ? 'fa-circle-check' : 'fa-circle-info')}"></i><span>${ppEsc(l.text)}</span></div>`).join('')}</div>`;
    const k = [];
    k.push(ppKpi('Lợi suất (TWR)', ppPct(a.cumulativePct, 2, true), a.annualizedPct !== null ? `${ppPct(a.annualizedPct, 1, true)}/năm` : 'Chưa đủ 1 năm để quy năm', ppUpDown(a.cumulativePct), 'Lợi suất theo thời gian, đã loại ảnh hưởng của việc nạp/rút vốn'));
    if (a.hasBench) {
        k.push(ppKpi(`Chuẩn (${benchName})`, ppPct(a.benchCumulativePct, 2, true), a.benchAnnualizedPct !== null ? `${ppPct(a.benchAnnualizedPct, 1, true)}/năm` : '', ppUpDown(a.benchCumulativePct)));
        k.push(ppKpi('Vượt / thua chuẩn', ppPct(a.excessCumulativePct, 2, true), 'điểm % cùng kỳ', ppUpDown(a.excessCumulativePct)));
        if (a.hasPriceReturn && a.priceExcessCumulativePct !== undefined) k.push(ppKpi('Vượt chuẩn (lợi suất giá)', ppPct(a.priceExcessCumulativePct, 2, true), `đã loại ${ppNum(a.incomeReturnPct, 1)} điểm % cổ tức`, ppUpDown(a.priceExcessCumulativePct), 'VN-Index là chỉ số giá (không có cổ tức). Đây là so sánh công bằng: lợi suất danh mục sau khi trừ cổ tức tiền mặt nhận được so với chỉ số.'));
    }
    if (a.irrPct !== undefined && a.irrPct !== null) k.push(ppKpi('IRR (có trọng số dòng tiền)', ppPct(a.irrPct, 1, true), 'quy năm; khác TWR vì tính cả thời điểm nạp/rút', ppUpDown(a.irrPct), 'XIRR: phản ánh thời điểm bạn bỏ thêm / rút vốn. TWR loại bỏ yếu tố này nên đo kỹ năng chọn mã; IRR đo kết quả thực của riêng bạn.'));
    if (a.enough) {
        if (a.hasBench) {
            k.push(ppKpi('Alpha', ppPct(a.alphaPct, 1, true), a.alphaTStat !== undefined && a.alphaTStat !== null ? `t = ${ppNum(a.alphaTStat, 1)} ${Math.abs(a.alphaTStat) >= 2 ? '(đáng tin)' : '(chưa đủ bằng chứng)'}` : '', ppUpDown(a.alphaPct), 'Lợi suất vượt trội/năm sau khi loại phần do thị trường chung (beta × chuẩn). t-stat ≥ 2 mới nên coi là kỹ năng thật'));
            k.push(ppKpi('Beta', ppNum(a.beta, 2), `Tương quan ${ppNum(a.correlation, 2)} · R² ${ppNum(a.rSquared, 2)}`, '', 'Chuẩn đổi 1% thì danh mục thường đổi beta %'));
            k.push(ppKpi('Tracking error', ppPct(a.trackingErrorPct, 1), 'độ lệch so với chuẩn/năm', '', 'Độ lệch chuẩn của lợi suất vượt chuẩn, quy năm. Càng lớn danh mục càng khác chuẩn'));
            k.push(ppKpi('Information ratio', ppNum(a.informationRatio, 2), a.informationRatio === null ? 'Không xác định' : 'trên 0,5 là tốt', ppUpDown(a.informationRatio), 'Lợi suất vượt chuẩn/năm chia tracking error: kỹ năng trên mỗi đơn vị rủi ro chủ động'));
            k.push(ppKpi('Up capture', ppPct(a.upCapturePct, 0), `${a.upPeriods} ${a.captureBasis === 'month' ? 'tháng' : 'kỳ'} chuẩn tăng`, '', 'Tỷ lệ mức tăng của chuẩn mà danh mục hưởng được'));
            k.push(ppKpi('Down capture', ppPct(a.downCapturePct, 0), `${a.downPeriods} ${a.captureBasis === 'month' ? 'tháng' : 'kỳ'} chuẩn giảm`, '', 'Tỷ lệ mức giảm của chuẩn mà danh mục phải chịu. Thấp hơn up capture là tốt'));
            k.push(ppKpi('Tháng thắng chuẩn', `${a.monthsBeat}/${a.monthsCompared}`, a.winRateMonthsPct !== null ? ppPct(a.winRateMonthsPct, 0) : '', a.winRateMonthsPct >= 50 ? 'tl-up' : ''));
        }
        k.push(ppKpi('Sharpe', ppNum(a.sharpe, 2), a.rfMode === 'series' ? `lãi phi rủi ro theo ngày, TB ${ppNum(a.rf * 100, 2)}%` : `lãi phi rủi ro ${ppNum(PP.rf * 100)}%`, '', 'Lợi suất vượt lãi phi rủi ro trên mỗi đơn vị biến động'));
        k.push(ppKpi('Sortino', ppNum(a.sortino, 2), 'chỉ phạt biến động giảm', ''));
        k.push(ppKpi('Biến động / năm', ppPct(a.volatilityPct, 1), a.benchVolatilityPct ? `Chuẩn ${ppPct(a.benchVolatilityPct, 1)}` : ''));
        k.push(ppKpi('Sụt giảm tối đa', ppPct(a.maxDD, 1), a.maxDDPeak ? `${ppDate(a.maxDDPeak)} → ${ppDate(a.maxDDTrough)}` : '', 'tl-down', 'Mức giảm sâu nhất từ đỉnh xuống đáy của chuỗi TWR'));
        k.push(ppKpi('Calmar', ppNum(a.calmar, 2), 'lợi suất năm / sụt giảm tối đa', '', 'Cần chuỗi ≥ 1 năm'));
    }
    // Lãi phi rủi ro: có chuỗi TPCP theo ngày thì dùng; chưa đủ lịch sử thì gợi ý đổi mức cài tay sang lãi suất TPCP hiện tại
    const curY1 = rfSeries.length ? rfSeries[rfSeries.length - 1] : null;
    if (a.enough && curY1 && a.rfMode !== 'series') html += `<p class="tl-hint" style="margin:8px 0 0">Lãi phi rủi ro đang là mức cài tay <b>${ppNum(PP.rf * 100, 1)}%</b>. Lợi suất trái phiếu chính phủ 1 năm hiện tại là <b>${ppNum(curY1[1] * 100, 2)}%</b> (ghi nhận theo ngày từ ${ppDate(rfSeries[0][0])}, chưa phủ hết kỳ phân tích). <button type="button" class="tl-link" onclick="ppUseCurrentRf(${(curY1[1]).toFixed(5)})">Dùng ${ppNum(curY1[1] * 100, 2)}% làm mức cố định</button></p>`;
    else if (a.rfMode === 'series') html += `<p class="tl-hint" style="margin:8px 0 0">Lãi phi rủi ro lấy theo ngày từ lợi suất trái phiếu chính phủ 1 năm (phủ ${ppNum(a.rfSeriesShare * 100, 0)}% số kỳ; kỳ chưa có dữ liệu dùng mức cài tay ${ppNum(PP.rf * 100, 1)}%).</p>`;
    html += `<div class="tl-kpis">${k.join('')}</div>`;
    if (a.hasBench && a.curve) {
        html += `<div class="ce-group-title">Tăng trưởng gốc 100 so với chuẩn</div><div class="tl-card rk-chart-card"><div style="position:relative;height:250px"><canvas id="pp-curve"></canvas></div></div>`;
    }
    const months = (a.monthly || []).slice(-18);
    if (months.length) {
        html += `<div class="ce-group-title">Lợi suất từng tháng</div>
            <div class="tl-card rk-chart-card"><div style="position:relative;height:210px"><canvas id="pp-months"></canvas></div></div>
            <details class="tl-details"><summary>Bảng theo tháng</summary><div class="spreadsheet-wrapper"><table class="excel-table asset-table"><thead><tr><th>Tháng</th><th class="text-right">Danh mục</th><th class="text-right">${benchName}</th><th class="text-right">Vượt/thua</th></tr></thead><tbody>
            ${months.slice().reverse().map(m => `<tr><td>${m.month.slice(5)}/${m.month.slice(0, 4)}</td><td class="text-right ${ppUpDown(m.r)}">${ppPct(m.r, 2, true)}</td><td class="text-right">${ppPct(m.rb, 2, true)}</td><td class="text-right ${ppUpDown(m.excess)}">${ppPct(m.excess, 2, true)}</td></tr>`).join('')}
            </tbody></table></div></details>`;
    }
    html += `<details class="tl-details"><summary>Cách tính và giới hạn</summary><div class="tl-hint">
        Lợi suất mỗi kỳ giữa hai lần chụp NAV theo <b>Modified Dietz</b>: (NAV cuối − NAV đầu − vốn nạp ròng) / (NAV đầu + ½ vốn nạp ròng); nối các kỳ theo lãi kép là TWR. Chuẩn lấy cùng các ngày chụp.
        Alpha Jensen = (lợi suất vượt lãi phi rủi ro của danh mục − beta × của chuẩn) × số kỳ/năm. Information ratio = lợi suất vượt chuẩn/năm ÷ tracking error.
        Up/down capture tính trên lợi suất tháng khi có ≥ 6 tháng. Cần tối thiểu ${PerfCalc.MIN_PERIODS} kỳ mới tính chỉ số thống kê; chuỗi ngắn thì sai số rất lớn, <b>đừng kết luận về kỹ năng chỉ từ vài tháng</b>.</div></details>`;
    body.innerHTML = html;
    if (a.hasBench && a.curve) ppDrawCurve(a, benchName);
    if (months.length) ppDrawMonths(months, benchName);
}

function ppAxis() {
    return { ticks: { color: cssVar('--text-secondary') }, grid: { color: cssVar('--border-color') } };
}
function ppDrawCurve(a, benchName) {
    const canvas = document.getElementById('pp-curve');
    if (!canvas || typeof Chart === 'undefined') return;
    PP.charts.push(new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: a.curve.map(x => x.date), datasets: [
            { label: 'Danh mục', data: a.curve.map(x => x.p), borderColor: cssVar('--finance-accent'), backgroundColor: cssVarAlpha('--finance-accent', 0.12), fill: true, tension: 0.15, pointRadius: 0, borderWidth: 2 },
            { label: benchName, data: a.curve.map(x => x.b), borderColor: cssVar('--text-muted'), borderDash: [5, 4], fill: false, tension: 0.15, pointRadius: 0, borderWidth: 1.5 },
        ] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: cssVar('--text-secondary'), boxWidth: 14 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${ppNum(c.raw, 1)}` } } },
            scales: { x: Object.assign(ppAxis(), { ticks: { color: cssVar('--text-secondary'), maxTicksLimit: 8, callback: function (v) { const d = this.getLabelForValue(v); return d ? d.slice(5).split('-').reverse().join('/') : ''; } } }), y: ppAxis() } },
    }));
}
function ppDrawMonths(months, benchName) {
    const canvas = document.getElementById('pp-months');
    if (!canvas || typeof Chart === 'undefined') return;
    PP.charts.push(new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels: months.map(m => m.month.slice(5) + '/' + m.month.slice(2, 4)), datasets: [
            { label: 'Danh mục', data: months.map(m => m.r), backgroundColor: months.map(m => m.r >= 0 ? cssVarAlpha('--success-color', 0.75) : cssVarAlpha('--danger-color', 0.75)), borderRadius: 3 },
            { label: benchName, data: months.map(m => m.rb), backgroundColor: cssVarAlpha('--text-muted', 0.45), borderRadius: 3 },
        ] },
        options: { responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: cssVar('--text-secondary'), boxWidth: 14 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${ppPct(c.raw, 2, true)}` } } },
            scales: { x: ppAxis(), y: Object.assign(ppAxis(), { ticks: { color: cssVar('--text-secondary'), callback: (v) => v + '%' } }) } },
    }));
}
