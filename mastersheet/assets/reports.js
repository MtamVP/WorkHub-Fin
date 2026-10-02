/* --- FILE: /mastersheet/assets/reports.js ---
   Tab "Báo Cáo": (1) lãi/lỗ đã chốt theo năm (FIFO có phí & thuế), (2) cân bằng danh mục theo tỷ trọng mục tiêu,
   (3) xuất DỮ LIỆU báo cáo cuối tháng (Excel/JSON, chỉ số liệu) để đưa cùng mẫu PowerPoint cho AI điền.
   Dùng global của script.js (callGAS, targetEmail, userEmail, showToast, escapeAssetHtml, formatVnd) + PortfolioCalc, MonthlyReport,
   XlsxWriter, FinCalc và saveBytesToDisk (ledger-tools.js). */

let realizedReport = null;
let rebalanceState = { targets: {}, holdings: [], cash: 0, watchPrices: {}, loaded: false };
let lastMonthly = null;

function initReportsTab() {
    loadRealizedReport();
    loadRebalance();
    initMonthlyReportControls();
}

function signedMoney(v) {
    const n = Math.round(Number(v) || 0);
    return (n > 0 ? '+' : (n < 0 ? '−' : '')) + Math.abs(n).toLocaleString('en-US');
}
function upDown(v) { return v > 0 ? 'tl-up' : (v < 0 ? 'tl-down' : ''); }

// ---------------------------------------------------------------------------------------------
// 1) Lãi/lỗ đã chốt theo năm
// ---------------------------------------------------------------------------------------------
async function loadRealizedReport() {
    const kpis = document.getElementById('rpt-realized-kpis');
    if (!kpis) return;
    const sel = document.getElementById('rpt-year');
    kpis.innerHTML = '<div class="tl-empty" style="grid-column:1/-1"><i class="fa-solid fa-spinner fa-spin"></i>Đang tính…</div>';
    try {
        const resp = await callGAS('getRealizedReport', { email: targetEmail, year: sel && sel.value ? sel.value : undefined });
        if (resp.status !== 'success') throw new Error(resp.message);
        realizedReport = resp.data;
        renderRealizedReport();
    } catch (e) {
        kpis.innerHTML = `<div class="tl-empty" style="grid-column:1/-1">Lỗi: ${escapeAssetHtml(e.message)}</div>`;
    }
}

function renderRealizedReport() {
    const r = realizedReport;
    const sel = document.getElementById('rpt-year');
    const years = r.years.length ? r.years : [r.year];
    sel.innerHTML = years.map(y => `<option value="${y}" ${y === r.year ? 'selected' : ''}>Năm ${y}</option>`).join('');
    const t = r.totals;
    const kpi = (k, v, s, cls, big) => `<div class="tl-kpi${big ? ' big' : ''}"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
    document.getElementById('rpt-realized-kpis').innerHTML =
        kpi('Lãi/lỗ đã chốt — ròng', signedMoney(t.netPnl) + ' ₫', 'Sau phí mua, phí bán và thuế bán', upDown(t.netPnl), true)
        + kpi('Lãi/lỗ gộp', signedMoney(t.grossPnl), 'Giá bán − giá vốn (chưa trừ phí/thuế)', upDown(t.grossPnl))
        + kpi('Phí + thuế', Math.round(t.fees + t.taxes).toLocaleString('en-US'), `Phí ${Math.round(t.fees).toLocaleString('en-US')} · Thuế ${Math.round(t.taxes).toLocaleString('en-US')}`)
        + kpi('Số lệnh bán', String(t.count), `${t.wins} thắng · ${t.losses} thua`)
        + kpi('Tỷ lệ thắng', t.winRate === null ? '—' : t.winRate.toFixed(0) + '%', t.count ? `Giữ bình quân ${Math.round(t.avgHoldingDays)} ngày` : '')
        + kpi('Cổ tức tiền', Math.round(r.dividendTotal).toLocaleString('en-US'), `Tổng gồm cổ tức: ${signedMoney(r.netIncludingDividends)}`);

    const bys = document.getElementById('rpt-bysymbol-body');
    bys.innerHTML = r.bySymbol.length ? r.bySymbol.map(s => `<tr>
        <td class="text-bold">${escapeAssetHtml(s.symbol)}</td>
        <td class="text-right">${Math.round(s.quantity).toLocaleString('en-US')}</td>
        <td class="text-right">${Math.round(s.proceeds).toLocaleString('en-US')}</td>
        <td class="text-right">${Math.round(s.costBasis).toLocaleString('en-US')}</td>
        <td class="text-right">${Math.round(s.fees + s.taxes).toLocaleString('en-US')}</td>
        <td class="text-right ${upDown(s.netPnl) === 'tl-up' ? 'pnl-up' : (s.netPnl < 0 ? 'pnl-down' : '')}"><b>${signedMoney(s.netPnl)}</b></td>
        <td class="text-right ${s.returnPct >= 0 ? 'pnl-up' : 'pnl-down'}">${s.returnPct === null ? '—' : (s.returnPct >= 0 ? '+' : '−') + Math.abs(s.returnPct).toFixed(1) + '%'}</td>
        <td class="text-right">${s.wins}/${s.losses}</td></tr>`).join('')
        : '<tr><td colspan="8" class="empty-state"><i class="fa-solid fa-scale-balanced"></i>Năm này chưa có lệnh bán nào.</td></tr>';

    const sales = document.getElementById('rpt-sales-body');
    sales.innerHTML = r.sales.length ? r.sales.map(s => `<tr>
        <td>${s.date}</td><td class="text-bold">${escapeAssetHtml(s.symbol)}</td>
        <td class="text-right">${Math.round(s.quantity).toLocaleString('en-US')}</td>
        <td class="text-right">${Math.round(s.price).toLocaleString('en-US')}</td>
        <td class="text-right">${s.quantity > 0 ? Math.round(s.costBasis / s.quantity).toLocaleString('en-US') : '—'}</td>
        <td class="text-right">${Math.round(s.buyFees).toLocaleString('en-US')}</td>
        <td class="text-right">${Math.round(s.sellFee).toLocaleString('en-US')}</td>
        <td class="text-right">${Math.round(s.tax).toLocaleString('en-US')}</td>
        <td class="text-right ${s.realizedNet >= 0 ? 'pnl-up' : 'pnl-down'}"><b>${signedMoney(s.realizedNet)}</b></td>
        <td class="text-right">${Math.round(s.avgHoldingDays)}</td></tr>`).join('')
        : '<tr><td colspan="10" class="empty-state">—</td></tr>';

    const warn = document.getElementById('rpt-realized-warn');
    warn.innerHTML = r.shortfalls > 0
        ? `<div class="tl-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Có <b>${r.shortfalls}</b> lệnh bán vượt khối lượng đang có (thiếu lệnh mua trước đó) — phần vượt không được tính lãi/lỗ. Hãy bổ sung lệnh mua ở Sổ Lệnh.</span></div>` : '';
}

function exportRealizedCsv() {
    if (!realizedReport) { showToast('Chưa có báo cáo để xuất.', 'error'); return; }
    const r = realizedReport, t = r.totals;
    const rows = [['Báo cáo lãi/lỗ đã chốt', 'Năm ' + r.year], [],
        ['Lãi/lỗ ròng', Math.round(t.netPnl)], ['Lãi/lỗ gộp', Math.round(t.grossPnl)], ['Phí mua (lô đã bán)', Math.round(t.buyFees)], ['Phí bán', Math.round(t.sellFees)], ['Thuế bán', Math.round(t.taxes)],
        ['Cổ tức tiền', Math.round(r.dividendTotal)], ['Tổng gồm cổ tức', Math.round(r.netIncludingDividends)], [],
        ['Theo mã'], ['Mã', 'KL bán', 'Tiền thu', 'Giá vốn', 'Phí+thuế', 'Lãi/lỗ ròng', '% trên vốn', 'Thắng', 'Thua']]
        .concat(r.bySymbol.map(s => [s.symbol, Math.round(s.quantity), Math.round(s.proceeds), Math.round(s.costBasis), Math.round(s.fees + s.taxes), Math.round(s.netPnl), s.returnPct === null ? '' : s.returnPct.toFixed(1), s.wins, s.losses]))
        .concat([[], ['Từng lệnh bán'], ['Ngày', 'Mã', 'KL', 'Giá bán', 'Giá vốn BQ', 'Phí mua', 'Phí bán', 'Thuế', 'Lãi/lỗ ròng', 'Ngày giữ']])
        .concat(r.sales.map(s => [s.date, s.symbol, Math.round(s.quantity), Math.round(s.price), s.quantity > 0 ? Math.round(s.costBasis / s.quantity) : '', Math.round(s.buyFees), Math.round(s.sellFee), Math.round(s.tax), Math.round(s.realizedNet), Math.round(s.avgHoldingDays)]));
    const bytes = new TextEncoder().encode(FinCalc.buildCsv(rows));
    saveBytesToDisk(`lai-lo-da-chot-${r.year}.csv`, bytes, 'text/csv;charset=utf-8')
        .then(p => { if (p) showToast('Đã lưu báo cáo năm ' + r.year, 'success'); })
        .catch(e => showToast('Lỗi: ' + escapeAssetHtml(e.message || String(e)), 'error'));
}

// ---------------------------------------------------------------------------------------------
// 2) Cân bằng danh mục
// ---------------------------------------------------------------------------------------------
async function loadRebalance() {
    const body = document.getElementById('rebal-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="8" class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải...</td></tr>';
    try {
        const [h, t, w, cd] = await Promise.all([
            callGAS('getHoldingsView', { email: targetEmail }), callGAS('getAllocationTargets', { email: targetEmail }),
            callGAS('getWatchlist', { email: targetEmail }), callGAS('getCashDebt', { email: targetEmail })
        ]);
        rebalanceState.holdings = h.data || [];
        rebalanceState.targets = t.data || {};
        rebalanceState.watchPrices = {};
        (w.data || []).forEach(x => { if (x.price > 0) rebalanceState.watchPrices[x.symbol] = x.price; });
        rebalanceState.cash = Number((cd.data || {}).cash) || 0;
        rebalanceState.loaded = true;
        renderRebalance();
    } catch (e) {
        body.innerHTML = `<tr><td colspan="8" class="empty-state text-danger">Lỗi: ${escapeAssetHtml(e.message)}</td></tr>`;
    }
}

function rebalanceOptions() {
    const g = (id) => document.getElementById(id);
    return {
        includeCash: g('rebal-cash') ? g('rebal-cash').checked : true,
        tolerancePct: g('rebal-tol') ? Math.max(0, parseFloat(g('rebal-tol').value) || 0) : 1,
        lotSize: g('rebal-lot') ? Math.max(1, parseInt(g('rebal-lot').value, 10) || 100) : 100,
        rates: typeof getFeeSettings === 'function' ? feeRatesOnly(getFeeSettings()) : undefined,
    };
}

function renderRebalance() {
    const body = document.getElementById('rebal-body');
    const s = rebalanceState;
    const symbols = Array.from(new Set(s.holdings.map(h => h.symbol).concat(Object.keys(s.targets).filter(k => k !== 'CASH'))));
    const plan = PortfolioCalc.rebalancePlan(s.holdings, s.cash, s.targets, s.watchPrices, rebalanceOptions());
    const byRow = Object.fromEntries(plan.rows.map(r => [r.symbol, r]));
    const heldBySym = Object.fromEntries(s.holdings.map(h => [h.symbol, h]));
    const base = plan.base || 1;
    const rowsHtml = symbols.map(sym => {
        const h = heldBySym[sym];
        const price = h ? h.marketPrice : (s.watchPrices[sym] || 0);
        const curVal = h ? h.marketValue : 0;
        const curPct = base > 0 ? curVal / base * 100 : 0;
        const tgt = s.targets[sym];
        const r = byRow[sym];
        let act = '<span class="text-muted">—</span>';
        if (r && r.action === 'buy') act = `<span class="tl-act buy">MUA ${r.shares.toLocaleString('en-US')}</span><div class="tl-hint">≈ ${Math.round(r.tradeValue).toLocaleString('en-US')} ₫</div>`;
        else if (r && r.action === 'sell') act = `<span class="tl-act sell">BÁN ${r.shares.toLocaleString('en-US')}</span><div class="tl-hint">≈ ${Math.round(r.tradeValue).toLocaleString('en-US')} ₫</div>`;
        else if (r && r.action === 'noPrice') act = '<span class="tl-badge warn">Chưa có giá</span>';
        else if (r && r.action === 'hold') act = '<span class="tl-badge ok">Đúng mục tiêu</span>';
        const diff = tgt === undefined ? null : curPct - tgt;
        return `<tr>
            <td class="text-bold">${escapeAssetHtml(sym)}</td>
            <td class="text-right">${price > 0 ? Math.round(price).toLocaleString('en-US') : '—'}</td>
            <td class="text-right">${h ? Math.round(h.quantity).toLocaleString('en-US') : '0'}</td>
            <td class="text-right">${curPct.toFixed(1)}%</td>
            <td class="text-right"><input type="number" class="tl-input num" style="width:80px" min="0" max="100" step="0.5" data-sym="${escapeAssetHtml(sym)}" value="${tgt === undefined ? '' : tgt}" placeholder="—" oninput="onRebalanceTargetInput(this)"> %</td>
            <td class="text-right ${diff === null ? '' : (diff > 0 ? 'pnl-down' : (diff < 0 ? 'pnl-up' : ''))}">${diff === null ? '—' : (diff > 0 ? '+' : (diff < 0 ? '−' : '')) + Math.abs(diff).toFixed(1) + ' đ.%'}</td>
            <td>${act}</td>
            <td>${(!h && tgt === undefined) ? '' : `<button class="icon-btn danger" title="Bỏ mã khỏi bảng mục tiêu" onclick="removeRebalanceSymbol('${escapeAssetHtml(sym)}')"><i class="fa-solid fa-xmark"></i></button>`}</td>
        </tr>`;
    });
    const cashPct = base > 0 && rebalanceOptions().includeCash ? (s.cash / base * 100) : 0;
    const cashTarget = s.targets.CASH;
    rowsHtml.push(`<tr><td class="text-bold"><i class="fa-solid fa-sack-dollar"></i> Tiền mặt</td><td class="text-right">—</td><td class="text-right">${Math.round(s.cash).toLocaleString('en-US')}</td>
        <td class="text-right">${cashPct.toFixed(1)}%</td>
        <td class="text-right"><input type="number" class="tl-input num" style="width:80px" min="0" max="100" step="0.5" data-sym="CASH" value="${cashTarget === undefined ? '' : cashTarget}" placeholder="—" oninput="onRebalanceTargetInput(this)"> %</td>
        <td class="text-right">—</td><td><span class="text-muted">${plan.cashAfter >= 0 ? 'Sau giao dịch còn ' + Math.round(plan.cashAfter).toLocaleString('en-US') + ' ₫' : ''}</span></td><td></td></tr>`);
    body.innerHTML = rowsHtml.join('');

    const sum = Object.values(s.targets).reduce((a, v) => a + (Number(v) || 0), 0);
    document.getElementById('rebal-sum').innerHTML =
        `<span>Tổng mục tiêu: <b class="${Math.abs(sum - 100) < 0.01 ? 'tl-up' : (sum > 100 ? 'tl-down' : '')}">${sum.toFixed(1)}%</b></span>`
        + `<span>NAV tính: <b>${Math.round(plan.base).toLocaleString('en-US')} ₫</b>${rebalanceOptions().includeCash ? ' (gồm tiền mặt)' : ''}</span>`
        + (plan.totalFees + plan.totalTax > 0 ? `<span>Phí + thuế ước tính: <b>${Math.round(plan.totalFees + plan.totalTax).toLocaleString('en-US')} ₫</b></span>` : '');
    document.getElementById('rebal-warn').innerHTML = plan.warnings.map(w => `<div class="tl-warn"><i class="fa-solid fa-triangle-exclamation"></i><span>${escapeAssetHtml(w)}</span></div>`).join('');
}

function onRebalanceTargetInput(input) {
    const sym = input.dataset.sym;
    const raw = String(input.value).trim();
    if (raw === '') delete rebalanceState.targets[sym];
    else rebalanceState.targets[sym] = Math.max(0, Math.min(100, parseFloat(raw) || 0));
    // vẽ lại phần tính toán nhưng không phá ô đang gõ: dùng debounce ngắn
    clearTimeout(onRebalanceTargetInput._t);
    onRebalanceTargetInput._t = setTimeout(() => { const pos = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.sym : null; renderRebalance(); if (pos) { const el = document.querySelector(`#rebal-body input[data-sym="${pos}"]`); if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; } } }, 400);
}

function addRebalanceSymbol() {
    const el = document.getElementById('rebal-new-symbol');
    const sym = String(el.value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(sym)) { showToast('Mã không hợp lệ', 'error'); return; }
    if (rebalanceState.targets[sym] === undefined) rebalanceState.targets[sym] = 0;
    el.value = '';
    renderRebalance();
}

function removeRebalanceSymbol(sym) {
    delete rebalanceState.targets[sym];
    renderRebalance();
}

async function saveRebalanceTargets() {
    try {
        const resp = await callGAS('saveAllocationTargets', { email: targetEmail, targets: rebalanceState.targets });
        if (resp.status !== 'success') throw new Error(resp.message);
        showToast(escapeAssetHtml(resp.message), 'success');
    } catch (e) {
        showToast('Lỗi: ' + escapeAssetHtml(e.message), 'error');
    }
}

// Điền mục tiêu = tỷ trọng hiện tại (làm điểm xuất phát để chỉnh)
function fillRebalanceFromCurrent() {
    const total = rebalanceState.holdings.reduce((s, h) => s + h.marketValue, 0) + (rebalanceOptions().includeCash ? rebalanceState.cash : 0);
    if (!(total > 0)) return;
    rebalanceState.targets = {};
    rebalanceState.holdings.forEach(h => { rebalanceState.targets[h.symbol] = Math.round(h.marketValue / total * 1000) / 10; });
    if (rebalanceOptions().includeCash) rebalanceState.targets.CASH = Math.round(rebalanceState.cash / total * 1000) / 10;
    renderRebalance();
}

// ---------------------------------------------------------------------------------------------
// 3) Báo cáo cuối tháng: xuất dữ liệu
// ---------------------------------------------------------------------------------------------
function initMonthlyReportControls() {
    const sel = document.getElementById('rpt-month');
    if (!sel || sel.options.length) return;
    const now = new Date();
    const opts = [];
    for (let i = 0; i < 18; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const v = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        opts.push(`<option value="${v}">Tháng ${d.getMonth() + 1}/${d.getFullYear()}${i === 0 ? ' (đang diễn ra)' : ''}</option>`);
    }
    sel.innerHTML = opts.join('');
    // Mặc định: tháng trước khi đang ở nửa đầu tháng (báo cáo cuối tháng thường làm sau khi tháng kết thúc), ngược lại tháng này
    if (now.getDate() <= 15) sel.selectedIndex = 1;
    renderMonthlyPlaceholder();
}

function renderMonthlyPlaceholder() {
    const box = document.getElementById('rpt-month-result');
    if (box && !lastMonthly) box.innerHTML = '<div class="tl-empty"><i class="fa-regular fa-file-excel"></i>Chọn tháng rồi bấm “Tạo dữ liệu báo cáo”. File xuất chỉ có số liệu — phần giải thích bạn tự viết.</div>';
}

async function buildMonthlyReport() {
    const month = document.getElementById('rpt-month').value;
    const btn = document.getElementById('rpt-month-btn');
    const html = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tổng hợp…';
    try {
        const resp = await callGAS('getMonthlyReportInputs', { email: targetEmail, month });
        if (resp.status !== 'success') throw new Error(resp.message);
        lastMonthly = { inputs: resp.data, deepDiveTxnId: '' };
        computeMonthlyReport();
    } catch (e) {
        lastMonthly = null;
        document.getElementById('rpt-month-result').innerHTML = `<div class="tl-empty">Lỗi: ${escapeAssetHtml(e.message)}</div>`;
    } finally {
        btn.disabled = false; btn.innerHTML = html;
    }
}

function computeMonthlyReport() {
    const m = lastMonthly;
    m.report = MonthlyReport.compute(m.inputs, { deepDiveTxnId: m.deepDiveTxnId || undefined });
    renderMonthlyReport();
}

function onDeepDiveChange(sel) {
    lastMonthly.deepDiveTxnId = sel.value;
    computeMonthlyReport();
}

function renderMonthlyReport() {
    const r = lastMonthly.report, k = r.kpi;
    const kpi = (lab, v, cls) => `<div class="tl-kpi"><span class="k">${lab}</span><span class="v ${cls || ''}">${v}</span></div>`;
    const pct = (v) => v === null ? '—' : MonthlyReport.fmtPct(v, 2);
    const trades = r.decisions.filter(d => d.txnId);
    const deepOptions = '<option value="">Tự chọn: quyết định đóng góp lớn nhất</option>' + trades.map(d =>
        `<option value="${escapeAssetHtml(d.txnId)}" ${lastMonthly.deepDiveTxnId === d.txnId ? 'selected' : ''}>${d.date.slice(8, 10)}/${d.date.slice(5, 7)} · ${d.action === 'BUY' ? 'Mua' : 'Bán'} ${escapeAssetHtml(d.symbol)} · ${Math.round(d.quantity).toLocaleString('en-US')}</option>`).join('');
    document.getElementById('rpt-month-result').innerHTML = `
        <div class="tl-kpis">
            ${kpi('Portfolio return', pct(k.portfolioReturnPct), upDown(k.portfolioReturnPct))}
            ${kpi('Benchmark (VN-Index)', pct(k.benchmarkReturnPct), upDown(k.benchmarkReturnPct))}
            ${kpi('Alpha', pct(k.alphaPct), upDown(k.alphaPct))}
            ${kpi('Max drawdown', pct(k.maxDrawdownPct), upDown(k.maxDrawdownPct))}
            ${kpi('Lãi/lỗ đầu tư', k.pnlMonth === null ? '—' : signedMoney(k.pnlMonth), upDown(k.pnlMonth))}
            ${kpi('Số lệnh', String(k.tradesCount))}
        </div>
        <div class="tl-month-grid"><label>Quyết định để phân tích sâu (slide 7–11)<select class="tl-select" onchange="onDeepDiveChange(this)">${deepOptions}</select></label></div>
        ${r.meta.warnings.length ? `<ul class="tl-note-list">${r.meta.warnings.map(w => `<li><i class="fa-solid fa-triangle-exclamation"></i><span>${escapeAssetHtml(w)}</span></li>`).join('')}</ul>` : ''}
        <div class="tl-card-tools" style="margin-top:12px">
            <button type="button" class="btn-save" onclick="downloadMonthlyXlsx()"><i class="fa-solid fa-file-excel"></i> Tải Excel (.xlsx)</button>
            <button type="button" class="btn-tool" onclick="downloadMonthlyJson()"><i class="fa-solid fa-file-code"></i> Tải JSON</button>
        </div>
        <p class="tl-hint">Excel gồm 9 sheet theo từng slide/biểu đồ của mẫu + sheet “08_Placeholders” liệt kê ô cần thay. Đưa file này cùng file mẫu PowerPoint cho AI để điền.</p>`;
}

function monthlyFileBase() {
    const r = lastMonthly.report;
    return `bao-cao-thang-${r.meta.month}`;
}

async function downloadMonthlyXlsx() {
    if (!lastMonthly || !lastMonthly.report) return;
    try {
        const bytes = XlsxWriter.build(MonthlyReport.toSheets(lastMonthly.report));
        const p = await saveBytesToDisk(monthlyFileBase() + '.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        if (p) showToast('Đã lưu ' + escapeAssetHtml(monthlyFileBase()) + '.xlsx', 'success');
    } catch (e) {
        showToast('Lỗi: ' + escapeAssetHtml(e.message || String(e)), 'error');
    }
}

async function downloadMonthlyJson() {
    if (!lastMonthly || !lastMonthly.report) return;
    try {
        const bytes = new TextEncoder().encode(JSON.stringify(lastMonthly.report, null, 2));
        const p = await saveBytesToDisk(monthlyFileBase() + '.json', bytes, 'application/json');
        if (p) showToast('Đã lưu ' + escapeAssetHtml(monthlyFileBase()) + '.json', 'success');
    } catch (e) {
        showToast('Lỗi: ' + escapeAssetHtml(e.message || String(e)), 'error');
    }
}
