/* --- FILE: /mastersheet/assets/attribution.js ---
   Tab Hiệu Suất > "Nguồn Gốc Lợi Nhuận": lãi/lỗ đến từ mã nào, ngành nào, bao nhiêu do thị trường chung và bao nhiêu do chọn mã/thời điểm,
   và kết quả theo từng loại quyết định trong nhật ký (kế hoạch đầy đủ hay thiếu, mức tự tin, định giá lúc quyết định, thẻ).
   Phép tính ở /lib/attribution-calc.js (có kiểm thử). Dùng global: callGAS, targetEmail, showToast, escapeAssetHtml, cssVar, cssVarAlpha,
   Chart.js, và JN/loadJournal (journal.js) để lấy các quyết định đã được đánh giá. */

const AT = {
    state: 'idle',            // idle | loading | ok | error
    error: '',
    inputs: null,
    range: 'ytd',
    result: null,
    decisions: null,          // kết quả byDecision hoặc null
    decisionState: 'idle',
    charts: [],
};
const AT_KEY = 'wh.fin.attr.v1';
try {
    const saved = JSON.parse(localStorage.getItem(AT_KEY) || 'null');
    if (saved && ['mtd', 'qtd', 'ytd', '1y', 'all'].includes(saved.range)) AT.range = saved.range;
} catch (e) { /* không có localStorage: dùng mặc định */ }

const atEsc = (s) => escapeAssetHtml(s === null || s === undefined ? '' : String(s));
const atNum = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toLocaleString('vi-VN', { minimumFractionDigits: d || 0, maximumFractionDigits: d === undefined ? 0 : d });
const atPct = (v, d, sign) => (v === null || v === undefined || !isFinite(v)) ? '—' : `${sign && v > 0 ? '+' : (v < 0 ? '−' : '')}${Math.abs(v).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d })}%`;
const atVnd = (v, sign) => (v === null || v === undefined || !isFinite(v)) ? '—' : `${v < 0 ? '−' : (sign && v > 0 ? '+' : '')}${Math.abs(Math.round(v)).toLocaleString('vi-VN')}`;
const atDate = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : '—'; };
const atCls = (v) => v > 0 ? 'tl-up' : (v < 0 ? 'tl-down' : '');

async function loadAttribution(force) {
    const body = document.getElementById('at-body');
    if (!body) return;
    document.getElementById('at-range').value = AT.range;
    if (AT.state === 'loading') return;
    if (AT.state === 'ok' && !force) { atRender(); return; }
    AT.state = 'loading';
    body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-spinner fa-spin"></i>Đang lấy sổ lệnh và giá lịch sử… (có thể mất vài giây)</div>';
    try {
        const r = await callGAS('getAttributionInputs', { email: targetEmail });
        if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
        AT.inputs = r.data; AT.state = 'ok';
    } catch (e) { AT.state = 'error'; AT.error = e.message || String(e); }
    atRender();
    if (AT.state === 'ok') atLoadDecisions();
}

function atChangeRange() {
    AT.range = document.getElementById('at-range').value;
    try { localStorage.setItem(AT_KEY, JSON.stringify({ range: AT.range })); } catch (e) { /* bỏ qua */ }
    atRender();
}

async function atLoadDecisions() {
    AT.decisionState = 'loading';
    atRenderDecisions();
    try {
        if (typeof JN === 'undefined') throw new Error('Thiếu mô-đun nhật ký');
        if (JN.evalState !== 'ok' || !JN.entries.length) await loadJournal();
        const list = JN.entries.filter(e => JN.evals[e.id]);
        AT.decisions = AttributionCalc.byDecision(list, JN.evals, (d) => DecisionJournal.planScore(d));
        AT.decisionState = 'ok';
    } catch (e) { AT.decisionState = 'error'; AT.decisionError = e.message || String(e); }
    atRenderDecisions();
}

function atKpi(label, value, sub, cls, title) {
    return `<div class="tl-kpi"${title ? ` title="${atEsc(title)}"` : ''}><span class="k">${atEsc(label)}</span><span class="v ${cls || ''}">${value}</span><span class="s">${sub || ''}</span></div>`;
}

function atRender() {
    const body = document.getElementById('at-body');
    if (!body) return;
    AT.charts.forEach(c => { try { c.destroy(); } catch (e) { /* đã huỷ */ } }); AT.charts = [];
    if (AT.state === 'loading' || AT.state === 'idle') return;
    if (AT.state === 'error') { body.innerHTML = `<div class="tl-empty text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Không tải được: ${atEsc(AT.error)}<br><button type="button" class="btn-tool" style="margin-top:10px" onclick="loadAttribution(true)">Thử lại</button></div>`; return; }
    const inp = AT.inputs;
    if (!inp.txns.length) { body.innerHTML = '<div class="tl-empty"><i class="fa-solid fa-diagram-successor"></i>Chưa có lệnh giao dịch nào để phân tích.</div>'; return; }
    const period = AttributionCalc.periodFor(AT.range, new Date().toISOString().slice(0, 10), inp.firstTxnDate);
    const r = AttributionCalc.analyze({ txns: inp.txns, actions: inp.actions, cashFlows: inp.cashFlows, histories: inp.histories, navHistory: inp.navHistory, from: period.from, to: period.to });
    AT.result = r;
    const t = r.totals;
    let html = '';
    if (inp.historyError) html += `<div class="conc-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Không lấy được giá lịch sử: ${atEsc(inp.historyError)}. Chưa tính được lãi/lỗ theo giá.</span></div>`;
    html += `<div class="rk-meta">Kỳ <b>${atDate(r.from)}</b> → <b>${atDate(r.to)}</b>${r.days ? ` (${r.days} phiên)` : ''} · lãi/lỗ đã gồm cổ tức, trừ phí và thuế · mẫu số đóng góp: ${r.baseKind === 'nav' ? 'NAV đầu kỳ + ½ vốn nạp ròng' : (r.baseKind === 'invested' ? 'vốn bình quân đã đầu tư (chưa có lịch sử NAV)' : 'chưa xác định')}</div>`;
    if (!r.rows.length) { body.innerHTML = html + '<div class="tl-empty"><i class="fa-solid fa-diagram-successor"></i>Không có mã nào nắm giữ hoặc giao dịch trong kỳ này.</div>'; return; }
    const k = [];
    k.push(atKpi('Lãi/lỗ trong kỳ', atVnd(t.pnl, true) + ' đ', t.contributionPct !== null ? `${atPct(t.contributionPct, 2, true)} đóng góp vào lợi suất` : '', atCls(t.pnl), 'Tổng lãi/lỗ các mã (đã chốt + chưa chốt + cổ tức − phí − thuế)'));
    if (r.hasBench) {
        k.push(atKpi('Nếu vào VN-Index', atVnd(t.benchPnl, true) + ' đ', 'cùng đường vốn từng mã', atCls(t.benchPnl), 'Lãi/lỗ nếu mỗi đồng vốn trong từng mã được bỏ vào chỉ số cùng thời gian: phần do thị trường chung'));
        k.push(atKpi('Do chọn mã / thời điểm', atVnd(t.activePnl, true) + ' đ', 'vượt/thua chỉ số trên cổ phiếu', atCls(t.activePnl), 'Lãi/lỗ trừ phần do thị trường chung: kết quả của việc chọn mã và canh thời điểm mua bán'));
        if (t.cashActivePnl !== null) k.push(atKpi('Giữ tiền mặt', atVnd(t.cashActivePnl, true) + ' đ', 'chi phí cơ hội so với chỉ số', atCls(t.cashActivePnl), 'Tiền mặt không sinh lời nên khi chỉ số tăng, phần tiền mặt là chi phí cơ hội (âm); khi chỉ số giảm là lợi thế'));
    }
    k.push(atKpi('Cổ tức đã nhận', atVnd(t.dividends) + ' đ', t.unassignedDividends ? `${atVnd(t.unassignedDividends)} đ không gắn mã` : ''));
    k.push(atKpi('Phí và thuế', atVnd(-t.fees) + ' đ', 'đã trừ vào lãi/lỗ', 'tl-down'));
    if (t.unexplained !== null) {
        const big = () => Math.abs(t.unexplained) > Math.max(1, (r.base || 0) * 0.005);
        k.push(atKpi('Chênh lệch chưa giải thích', atVnd(t.unexplained, true) + ' đ', `NAV thực tế ${atVnd(t.actualPnl, true)} đ so với sổ lệnh`, big() ? 'tl-down' : '', 'Biến động NAV (đã loại vốn nạp/rút) trừ lãi/lỗ giải thích được từ sổ lệnh. Lớn nghĩa là có lệnh/cổ tức nhập thiếu hoặc sai, hoặc tiền mặt thay đổi ngoài sổ'));
    }
    html += `<div class="tl-kpis">${k.join('')}</div>`;
    const lines = [];
    if (r.best.length) lines.push({ level: 'good', text: `Đóng góp lớn nhất: ${r.best.map(x => `${x.symbol} ${atVnd(x.pnl, true)} đ`).join(', ')}.` });
    if (r.worst.length) lines.push({ level: 'warn', text: `Kéo lùi nhiều nhất: ${r.worst.map(x => `${x.symbol} ${atVnd(x.pnl, true)} đ`).join(', ')}.` });
    if (r.hasBench && t.activePnl !== null) lines.push({ level: t.activePnl >= 0 ? 'good' : 'warn', text: t.activePnl >= 0 ? `Phần lớn lãi có được là nhờ chọn mã và thời điểm tốt hơn chỉ số (${atVnd(t.activePnl, true)} đ), phần còn lại do thị trường chung (${atVnd(t.benchPnl, true)} đ).` : `Danh mục kém chỉ số ${atVnd(Math.abs(t.activePnl))} đ trên phần cổ phiếu: chọn mã/thời điểm chưa tốt hơn việc chỉ giữ chỉ số.` });
    if (r.breadth.profitFactor !== null) lines.push({ level: 'info', text: `${r.breadth.winners} mã lãi, ${r.breadth.losers} mã lỗ; tổng lãi gấp ${atNum(r.breadth.profitFactor, 2)} lần tổng lỗ.${r.topShare !== null && r.topShare > 60 ? ` Một mã chiếm ${atNum(r.topShare)}% tổng lãi — kết quả phụ thuộc nhiều vào một khoản đầu tư.` : ''}` });
    if (r.missing.length) lines.push({ level: 'warn', text: `Chưa tính được ${r.missing.join(', ')} vì thiếu giá lịch sử tại đầu/cuối kỳ.` });
    if (lines.length) html += `<div class="rk-warns">${lines.map(l => `<div class="rk-warn ${l.level === 'warn' ? 'med' : (l.level === 'good' ? 'good' : 'low')}"><i class="fa-solid ${l.level === 'warn' ? 'fa-triangle-exclamation' : (l.level === 'good' ? 'fa-circle-check' : 'fa-circle-info')}"></i><span>${atEsc(l.text)}</span></div>`).join('')}</div>`;

    const rows = r.rows.filter(x => x.pnl !== null);
    html += `<div class="ce-group-title">Lãi/lỗ theo mã <small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(thị trường chung + chọn mã)</small></div>
        <div class="tl-card rk-chart-card"><div style="position:relative;height:${Math.max(180, rows.length * 30 + 50)}px"><canvas id="at-sym-chart"></canvas></div></div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table at-table"><thead><tr><th>Mã</th><th>Trạng thái</th><th class="text-right">Lãi/lỗ</th><th class="text-right">Đóng góp</th>${r.hasBench ? '<th class="text-right">Do thị trường</th><th class="text-right">Do chọn mã</th>' : ''}<th class="text-right">Cổ tức</th><th class="text-right">Phí/thuế</th></tr></thead><tbody>
        ${r.rows.map(x => `<tr><td><span class="symbol-name">${atEsc(x.symbol)}<span class="symbol-sub">${atEsc(x.sector)}</span></span></td>
            <td>${x.priceMissing ? '<span class="tl-badge warn">Thiếu giá</span>' : (x.held ? '<span class="tl-badge info">Đang giữ</span>' : '<span class="tl-badge mute">Đã bán hết</span>')}</td>
            <td class="text-right ${atCls(x.pnl)}"><b>${atVnd(x.pnl, true)}</b></td><td class="text-right ${atCls(x.contributionPct)}">${atPct(x.contributionPct, 2, true)}</td>
            ${r.hasBench ? `<td class="text-right">${atVnd(x.benchPnl, true)}</td><td class="text-right ${atCls(x.activePnl)}">${atVnd(x.activePnl, true)}</td>` : ''}
            <td class="text-right">${x.dividends ? atVnd(x.dividends) : '—'}</td><td class="text-right">${x.fees ? atVnd(-x.fees) : '—'}</td></tr>`).join('')}
        </tbody></table></div>`;
    html += `<div class="ce-group-title">Lãi/lỗ theo ngành</div>
        <div class="spreadsheet-wrapper"><table class="excel-table asset-table at-table"><thead><tr><th>Ngành</th><th class="text-right">Lãi/lỗ</th><th class="text-right">Đóng góp</th>${r.hasBench ? '<th class="text-right">Do thị trường</th><th class="text-right">Do chọn mã</th>' : ''}<th>Mã</th></tr></thead><tbody>
        ${r.sectors.map(s => `<tr><td>${atEsc(s.sector)}</td><td class="text-right ${atCls(s.pnl)}"><b>${atVnd(s.pnl, true)}</b></td><td class="text-right ${atCls(s.contributionPct)}">${atPct(s.contributionPct, 2, true)}</td>
            ${r.hasBench ? `<td class="text-right">${atVnd(s.benchPnl, true)}</td><td class="text-right ${atCls(s.activePnl)}">${atVnd(s.activePnl, true)}</td>` : ''}<td class="at-syms">${atEsc(s.symbols.join(', '))}</td></tr>`).join('')}
        </tbody></table></div>`;
    html += '<div id="at-decisions"></div>';
    html += `<details class="tl-details"><summary>Cách tính và giới hạn</summary><div class="tl-hint">
        Lãi/lỗ mỗi mã = giá trị cuối kỳ − giá trị đầu kỳ − tiền mua (kèm phí) + tiền bán (trừ phí, thuế) + cổ tức, với số cổ phiếu đã tính thưởng/tách. Gồm cả phần đã chốt và chưa chốt.
        “Do thị trường” = tổng (giá trị cuối phiên trước × lợi suất VN-Index phiên đó) trên đúng đường vốn của mã; “Do chọn mã” = phần còn lại. Đóng góp % = lãi/lỗ ÷ (NAV đầu kỳ + ½ vốn nạp ròng).
        Số liệu dựa trên các lệnh bạn đã nhập; dòng “chênh lệch chưa giải thích” giúp phát hiện lệnh thiếu. Chưa phân tách được theo tỷ trọng ngành của chỉ số (kiểu Brinson) vì không có quyền số ngành của VN-Index.</div></details>`;
    body.innerHTML = html;
    atDrawSymbols(rows, r.hasBench);
    atRenderDecisions();
}

function atDrawSymbols(rows, hasBench) {
    const canvas = document.getElementById('at-sym-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    const sorted = rows.slice().sort((a, b) => b.pnl - a.pnl);
    const ds = hasBench
        ? [{ label: 'Do thị trường', data: sorted.map(x => x.benchPnl), backgroundColor: cssVarAlpha('--text-muted', 0.5), stack: 's', borderRadius: 2 },
           { label: 'Do chọn mã', data: sorted.map(x => x.activePnl), backgroundColor: sorted.map(x => (x.activePnl || 0) >= 0 ? cssVarAlpha('--success-color', 0.8) : cssVarAlpha('--danger-color', 0.8)), stack: 's', borderRadius: 2 }]
        : [{ label: 'Lãi/lỗ', data: sorted.map(x => x.pnl), backgroundColor: sorted.map(x => x.pnl >= 0 ? cssVarAlpha('--success-color', 0.8) : cssVarAlpha('--danger-color', 0.8)), borderRadius: 2 }];
    AT.charts.push(new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels: sorted.map(x => x.symbol), datasets: ds },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: hasBench, labels: { color: cssVar('--text-secondary'), boxWidth: 14 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${atVnd(c.raw, true)} đ` } } },
            scales: { x: { stacked: true, ticks: { color: cssVar('--text-secondary'), callback: (v) => (v / 1e6).toLocaleString('vi-VN') + ' tr' }, grid: { color: cssVar('--border-color') } }, y: { stacked: true, ticks: { color: cssVar('--text-secondary') }, grid: { display: false } } } },
    }));
}

// ---------- Theo quyết định trong nhật ký ----------
function atGroupTable(title, groups, hint) {
    if (!groups || !groups.length) return '';
    return `<div class="at-dec-block"><div class="at-dec-title">${atEsc(title)}${hint ? ` <small>${atEsc(hint)}</small>` : ''}</div><div class="spreadsheet-wrapper"><table class="excel-table asset-table at-table"><thead><tr><th>Nhóm</th><th class="text-right">Số quyết định</th><th class="text-right">Tỷ lệ thắng</th><th class="text-right">Lợi suất TB</th><th class="text-right">Alpha TB (so với VN-Index)</th></tr></thead><tbody>
        ${groups.map(g => `<tr><td>${atEsc(g.label)}</td><td class="text-right">${g.n}</td><td class="text-right">${atPct(g.winRatePct, 0)}</td><td class="text-right ${atCls(g.avgReturnPct)}">${atPct(g.avgReturnPct, 1, true)}</td><td class="text-right ${atCls(g.avgAlphaPct)}">${atPct(g.avgAlphaPct, 1, true)}${g.alphaN && g.alphaN < 3 ? ' <small title="Mẫu quá nhỏ">*</small>' : ''}</td></tr>`).join('')}
        </tbody></table></div></div>`;
}

function atRenderDecisions() {
    const box = document.getElementById('at-decisions');
    if (!box) return;
    const head = '<div class="ce-group-title">Kết quả theo loại quyết định <small style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--text-muted)">(từ Nhật Ký — quyết định mua/giữ, tính tới hôm nay)</small></div>';
    if (AT.decisionState === 'loading') { box.innerHTML = head + '<div class="tl-empty" style="padding:16px"><i class="fa-solid fa-spinner fa-spin"></i>Đang đánh giá các quyết định…</div>'; return; }
    if (AT.decisionState === 'error') { box.innerHTML = head + `<div class="tl-empty text-danger" style="padding:16px">${atEsc(AT.decisionError || '')}</div>`; return; }
    const d = AT.decisions;
    if (!d || !d.total) { box.innerHTML = head + '<div class="tl-empty" style="padding:16px"><i class="fa-solid fa-book-open"></i>Chưa có quyết định nào được ghi và đánh giá trong tab Nhật Ký. Ghi lý do và kỳ vọng ngay lúc mua/bán để phân tích được phần này.</div>'; return; }
    const o = d.overall;
    const notes = [];
    const cal = d.calibration;
    if (cal.ok) notes.push({ level: cal.calibrated ? 'good' : 'warn', text: cal.calibrated ? `Mức tự tin có ý nghĩa: quyết định tự tin ≥ 4/5 có alpha trung bình ${atPct(cal.highAlpha, 1, true)}, cao hơn nhóm tự tin ≤ 2/5 (${atPct(cal.lowAlpha, 1, true)}).` : `Mức tự tin chưa phản ánh chất lượng: nhóm tự tin ≥ 4/5 có alpha ${atPct(cal.highAlpha, 1, true)}, không hơn nhóm tự tin ≤ 2/5 (${atPct(cal.lowAlpha, 1, true)}).` });
    const plan = d.byPlan.find(g => g.key === 'complete'), part = d.byPlan.find(g => g.key === 'partial');
    if (plan && part && plan.alphaN >= 3 && part.alphaN >= 3) notes.push({ level: plan.avgAlphaPct > part.avgAlphaPct ? 'good' : 'info', text: plan.avgAlphaPct > part.avgAlphaPct ? `Quyết định có kế hoạch đầy đủ (lý do, mục tiêu, cắt lỗ, thời hạn) có alpha ${atPct(plan.avgAlphaPct, 1, true)}, tốt hơn nhóm thiếu kế hoạch (${atPct(part.avgAlphaPct, 1, true)}).` : `Kế hoạch đầy đủ chưa cho alpha tốt hơn (${atPct(plan.avgAlphaPct, 1, true)} so với ${atPct(part.avgAlphaPct, 1, true)}) — quy trình tốt không đảm bảo kết quả từng quyết định, nhưng đáng theo dõi thêm khi có nhiều mẫu hơn.` });
    box.innerHTML = head +
        `<div class="tl-kpis">${[
            atKpi('Quyết định mua/giữ', String(d.buys), `${d.sells} quyết định bán/bỏ qua`),
            atKpi('Tỷ lệ thắng', atPct(o.winRatePct, 0), `${o.withReturn} quyết định có lợi suất`),
            atKpi('Lợi suất TB', atPct(o.avgReturnPct, 1, true), 'từ ngày quyết định tới nay', atCls(o.avgReturnPct)),
            atKpi('Alpha TB', atPct(o.avgAlphaPct, 1, true), 'so với VN-Index cùng kỳ', atCls(o.avgAlphaPct)),
            d.sells ? atKpi('Bán/bỏ qua đúng', atPct(d.sellQuality.goodPct, 0), `${d.sellQuality.good} đúng · ${d.sellQuality.bad} sai · ${d.sellQuality.neutral} trung tính`, '', 'Bán/bỏ qua mà giá sau đó giảm ≥ 10% là đúng; giá tăng ≥ 10% là bán sớm/bỏ lỡ') : '',
        ].join('')}</div>` +
        (notes.length ? `<div class="rk-warns">${notes.map(l => `<div class="rk-warn ${l.level === 'warn' ? 'med' : (l.level === 'good' ? 'good' : 'low')}"><i class="fa-solid ${l.level === 'warn' ? 'fa-triangle-exclamation' : (l.level === 'good' ? 'fa-circle-check' : 'fa-circle-info')}"></i><span>${atEsc(l.text)}</span></div>`).join('')}</div>` : '') +
        atGroupTable('Theo mức đầy đủ của kế hoạch', d.byPlan) + atGroupTable('Theo mức tự tin', d.byConfidence, '(1 = thấp, 5 = cao)') +
        atGroupTable('Theo định giá lúc quyết định', d.byVerdict) + atGroupTable('Theo thẻ', d.byTag.slice(0, 8)) +
        '<p class="tl-hint">Mẫu nhỏ cho kết quả rất nhiễu (dấu * = dưới 3 quyết định có alpha). Dùng để thấy xu hướng trong cách ra quyết định của chính bạn, không phải kết luận thống kê.</p>';
}
