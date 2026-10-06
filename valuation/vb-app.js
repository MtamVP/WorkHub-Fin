/* --- FILE: /valuation/vb-app.js ---
   Valuation Bench: bộ điều khiển trang. Định tuyến theo hash (#overview | #stock/FPT/tab | #methods), nạp dữ liệu một mã (Edge Function vb-data + thống kê ngành + lịch sử định giá),
   dựng ngữ cảnh cho VBEngine, giữ giả định người dùng đã chỉnh (lưu theo từng mã trong trình duyệt), tính lại, lưu bản định giá và áp dụng vào Danh Mục.
   Mọi phép tính nằm trong /lib/vb-*.js (có kiểm thử); file này chỉ lấy dữ liệu, điều phối và vẽ. Phần dựng giao diện từng tab ở vb-stock.js. */

const VU = ValuationUI;
const VB = {
    view: 'overview', symbol: null, tab: 'summary', bundle: null, result: null, loading: false, error: '', saved: [], history: [], overview: null,
    params: { dcf: {}, weights: {}, mos: 0.2, bank: {}, navAdj: [], sotp: [], erp: null, beta: null, sizePremium: null },
    tech: { window: 180, show: { sma20: true, sma50: true, sma200: true, bb: false, ich: false, st: false, vwap: false, volume: true } },
    names: {}, loadSeq: 0,
};
const VB_PARAMS_KEY = 'wh.vb.params.v1.';
const VB_RECENT_KEY = 'wh.vb.recent.v1';

// ---------- tiện ích ----------
async function call(action, params) {
    const r = await callGAS(action, params || {});
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}
function showToast(message, type) {
    const existing = document.querySelector('.toast-notification'); if (existing) existing.remove();
    const t = document.createElement('div'); t.className = 'toast-notification toast-' + (type || 'success');
    t.innerHTML = (type === 'error' ? '<i class="fa-solid fa-circle-exclamation"></i>' : '<i class="fa-solid fa-circle-check"></i>') + ' <span>' + VU.esc(message) + '</span>';
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 4000);
}
function applyThemeIcon() { const ic = document.getElementById('theme-ic'); if (ic) ic.className = document.documentElement.getAttribute('data-theme') === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon'; }
function toggleDeskTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('user-theme', next); } catch (e) { /* bỏ qua */ }
    applyThemeIcon(); if (typeof VBCharts !== 'undefined') VBCharts.redrawAll();
}
const vbE = (s) => VU.esc(s);
const vbN = (v, d) => VU.dec(v, d === undefined ? 0 : d);
const vbPct = (v, d, sign) => (v === null || v === undefined || !isFinite(v) ? '—' : VU.pct(v * 100, d === undefined ? 1 : d, sign));
const vbTy = (v) => (v === null || v === undefined || !isFinite(v) ? '—' : VU.dec(v / 1e9, 0));
const vbDate = (iso) => { const p = String(iso || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; };
const vbPill = (tone, text, icon, title) => '<span class="vb-pill ' + (tone || 'mute') + '"' + (title ? ' title="' + vbE(title) + '"' : '') + '>' + (icon ? '<i class="fa-solid ' + icon + '" aria-hidden="true"></i> ' : '') + vbE(text) + '</span>';

// ---------- khởi động và định tuyến ----------
document.addEventListener('DOMContentLoaded', function () {
    applyThemeIcon();
    if (typeof BenchNav !== 'undefined') BenchNav.mount({ bench: 'valuation', active: 'overview' });
    window.addEventListener('hashchange', route);
    route();
});
function parseHash() {
    const parts = String(location.hash || '').replace(/^#/, '').split('/').filter(Boolean);
    const view = ['stock', 'methods', 'accuracy', 'overview'].indexOf(parts[0]) !== -1 ? parts[0] : 'overview';
    const sym = view === 'stock' && parts[1] && /^[A-Za-z0-9]{1,12}$/.test(parts[1]) ? parts[1].toUpperCase() : null;
    const tab = ['summary', 'process', 'fundamental', 'valuation', 'technical', 'market', 'saved'].indexOf(parts[2]) !== -1 ? parts[2] : 'summary';
    return { view: view, sym: sym, tab: tab };
}
function setHash(view, sym, tab) { const h = '#' + view + (sym ? '/' + sym + (tab && tab !== 'summary' ? '/' + tab : '') : ''); if (location.hash !== h) location.hash = h; else route(); }
function route() {
    const h = parseHash();
    VB.view = h.view; VB.tab = h.tab;
    if (typeof BenchNav !== 'undefined') BenchNav.setActive(h.view === 'stock' ? 'stock' : (h.view === 'methods' ? 'methods' : (h.view === 'accuracy' ? 'accuracy' : 'overview')));
    const title = document.getElementById('vb-title');
    if (h.view === 'overview') { if (title) title.textContent = 'Valuation Bench'; renderOverview(); return; }
    if (h.view === 'methods') { if (title) title.textContent = 'Thư viện phương pháp'; renderMethods('all'); return; }
    if (h.view === 'accuracy') { if (title) title.textContent = 'Độ chính xác'; renderAccuracy(); return; }
    if (title) title.textContent = 'Hồ sơ cổ phiếu';
    if (!h.sym) { renderStockHome(); return; }
    if (VB.symbol === h.sym && VB.result && !VB.loading) { renderStock(); return; }
    loadStock(h.sym);
}

// ---------- giả định người dùng (theo mã) ----------
function loadParams(sym) {
    const base = loadParamsDefault();
    try { const s = JSON.parse(localStorage.getItem(VB_PARAMS_KEY + sym) || 'null'); if (s) return normalizeProcess(Object.assign(base, s)); } catch (e) { /* mặc định */ }
    return base;
}
function saveParams() { if (!VB.symbol) return; try { localStorage.setItem(VB_PARAMS_KEY + VB.symbol, JSON.stringify(VB.params)); } catch (e) { /* bỏ qua */ } }
function rememberRecent(sym) {
    try { const l = JSON.parse(localStorage.getItem(VB_RECENT_KEY) || '[]').filter(function (x) { return x !== sym; }); l.unshift(sym); localStorage.setItem(VB_RECENT_KEY, JSON.stringify(l.slice(0, 12))); } catch (e) { /* bỏ qua */ }
}
function recentList() { try { return JSON.parse(localStorage.getItem(VB_RECENT_KEY) || '[]'); } catch (e) { return []; } }

// ---------- nạp dữ liệu và tính ----------
function buildCtx() {
    const b = VB.bundle, v = b.vb || {}, p = b.peers, P = VB.params;
    const metrics = Object.assign({}, p && p.self ? p.self.metrics : {});
    if (P.beta !== null && P.beta !== undefined) metrics.beta = P.beta;
    const stats = p && p.sector ? p.sector.stats : null;
    return {
        symbol: VB.symbol, form: v.form || undefined, annualRows: v.annualRows || [], quarterRows: v.quarterRows || [], candles: v.candles, indexCandles: v.indexCandles,
        ratioSeries: v.ratioSeries || null, metrics: metrics, peerStats: stats, sectorStats: stats, sectorCode: p ? p.icb2_code : null, sectorName: p ? p.sectorName : null,
        histRows: b.history ? b.history.rows : [], bond10yPct: b.history ? b.history.bond10y : null,
        dcf: P.dcf, weights: P.weights, marginOfSafety: P.mos, bankInputs: P.bank, navAdjustments: P.navAdj, sotp: P.sotp,
        process: P.process, scorecard: typeof VB_SCORECARD !== 'undefined' ? VB_SCORECARD : null,
        adjustments: P.adjustments, driver: P.driver,
        peerOverride: P.peerSet && P.peerSet.mode === 'custom' && VB.customPeerRows && VB.customPeerRows.length >= 3 ? { stats: VBMultiples.statsFromRows(VB.customPeerRows, 3), symbols: VB.customPeerRows.map(function (x) { return x.symbol; }), minN: 3 } : null,
        erp: P.erp !== null && P.erp !== undefined ? P.erp : undefined, sizePremium: P.sizePremium !== null && P.sizePremium !== undefined ? P.sizePremium : undefined,
        mc: { n: 1500 },
    };
}
function recompute() {
    if (!VB.bundle) return;
    VB.result = VBEngine.analyze(buildCtx());
    saveParams();
}
async function loadStock(sym) {
    const seq = ++VB.loadSeq;
    VB.symbol = sym; VB.loading = true; VB.error = ''; VB.bundle = null; VB.result = null; VB.params = loadParams(sym); VB.customPeerRows = null;
    renderStock();
    try {
        const bundle = await call('getVbData', { symbol: sym, years: 8, candleYears: 5 });
        if (seq !== VB.loadSeq) return;
        VB.bundle = bundle; await ensureCustomPeers(); recompute(); rememberRecent(sym);
        try { VB.history = await call('getVbHistory', { symbol: sym, limit: 60 }); } catch (e) { VB.history = []; }
        if (seq !== VB.loadSeq) return;
        VB.loading = false; renderStock();
    } catch (e) {
        if (seq !== VB.loadSeq) return;
        VB.loading = false; VB.error = e.message || String(e); renderStock();
    }
}
function reloadStock() { if (VB.symbol) loadStock(VB.symbol); }

// Người dùng đổi một giả định: key nằm trong nhóm group ('dcf' | 'bank' | 'weights' | 'top'); value đã quy đổi về thập phân
function setParam(group, key, value) {
    if (group === 'dcf' || group === 'bank' || group === 'weights') {
        if (value === null || value === undefined || value === '' || (typeof value === 'number' && !isFinite(value))) delete VB.params[group][key]; else VB.params[group][key] = value;
    } else VB.params[key] = value;
    recompute(); renderStockBody();
}
// ---------- quy trình: người dùng chỉnh mô hình, vai trò, lý do, lý do chấp nhận ----------
function setProcArch(v) { VB.params.process.archetype = v || null; VB.params.process.roles = {}; VB.params.process.reasons = {}; recompute(); renderStockBody(); }
function setProcRole(key, role) {
    const pr = VB.params.process, row = VB.result && VB.result.process ? VB.result.process.rows.find(function (x) { return x.key === key; }) : null;
    if (!role || (row && role === row.defaultRole)) { delete pr.roles[key]; delete pr.reasons[key]; } else pr.roles[key] = role;
    recompute(); renderStockBody();
}
function setProcReason(key, text) { const pr = VB.params.process; if (String(text || '').trim()) pr.reasons[key] = String(text).trim().slice(0, 160); else delete pr.reasons[key]; recompute(); saveParams(); }
function setProcAck(text) { VB.params.process.ack = String(text || '').trim().slice(0, 600); recompute(); saveParams(); renderStockBody(); }
function resetProcess() { VB.params.process = { archetype: null, roles: {}, reasons: {}, ack: VB.params.process.ack || '' }; recompute(); renderStockBody(); }
function resetParams(what) {
    const d = { dcf: {}, weights: {}, bank: {}, navAdj: [], sotp: [] };
    if (what === 'all') { VB.params = loadParamsDefault(); } else if (d[what] !== undefined) VB.params[what] = d[what];
    if (what === 'dcf' || what === 'all') { VB.params.erp = null; VB.params.beta = null; VB.params.sizePremium = null; }
    recompute(); renderStockBody();
}
function loadParamsDefault() { return { dcf: {}, weights: {}, mos: 0.2, bank: {}, navAdj: [], sotp: [], erp: null, beta: null, sizePremium: null, process: { archetype: null, roles: {}, reasons: {}, ack: '' }, adjustments: [], peerSet: { mode: 'sector', symbols: [] }, driver: { enabled: false } }; }
function normalizeProcess(P) {
    if (!Array.isArray(P.adjustments)) P.adjustments = [];
    if (!P.peerSet || (P.peerSet.mode !== 'custom' && P.peerSet.mode !== 'sector')) P.peerSet = { mode: 'sector', symbols: [] };
    if (!Array.isArray(P.peerSet.symbols)) P.peerSet.symbols = [];
    if (!P.driver || typeof P.driver !== 'object') P.driver = { enabled: false }; const q = P.process || {}; P.process = { archetype: q.archetype || null, roles: q.roles || {}, reasons: q.reasons || {}, ack: q.ack || '' }; return P; }
// đọc ô nhập: inputEl.dataset.group / key / mode ('pct' chia 100, 'num', 'bool')
function onParamInput(el) {
    const g = el.dataset.group, k = el.dataset.key, mode = el.dataset.mode || 'num';
    if (mode === 'bool') { setParam(g, k, el.checked); return; }
    const raw = String(el.value).replace(',', '.').trim();
    if (raw === '') { setParam(g, k, null); return; }
    const n = Number(raw); if (!isFinite(n)) return;
    setParam(g, k, mode === 'pct' ? n / 100 : n);
}
function onWeightInput(key, el) { const raw = String(el.value).replace(',', '.').trim(); if (raw === '') setParam('weights', key, null); else if (isFinite(Number(raw))) setParam('weights', key, Math.max(0, Number(raw))); }
function onNavAdjChange() {
    const rows = document.querySelectorAll('.vb-navadj-row'), out = [];
    rows.forEach(function (r) { const label = r.querySelector('[data-f="label"]').value.trim(), amt = Number(String(r.querySelector('[data-f="amount"]').value).replace(',', '.')); if (label && isFinite(amt) && amt !== 0) out.push({ label: label, amount: amt * 1e9 }); });
    VB.params.navAdj = out; recompute(); renderStockBody();
}
function addNavAdj() { VB.params.navAdj = (VB.params.navAdj || []).concat([{ label: 'Điều chỉnh mới', amount: 1e9 }]); recompute(); renderStockBody(); }
function onSotpChange() {
    const out = [];
    document.querySelectorAll('.vb-sotp-row').forEach(function (r) {
        const name = r.querySelector('[data-f="name"]').value.trim(), metric = Number(String(r.querySelector('[data-f="metric"]').value).replace(',', '.')), mult = Number(String(r.querySelector('[data-f="multiple"]').value).replace(',', '.'));
        if (name && isFinite(metric) && isFinite(mult) && metric > 0 && mult > 0) out.push({ name: name, metric: metric * 1e9, multiple: mult });
    });
    VB.params.sotp = out; recompute(); renderStockBody();
}
function addSotp() { VB.params.sotp = (VB.params.sotp || []).concat([{ name: 'Mảng mới', metric: 100e9, multiple: 8 }]); recompute(); renderStockBody(); }

// ---------- lưu và áp dụng ----------
async function saveValuation() {
    const r = VB.result, note = (document.getElementById('vb-save-note') || {}).value || '';
    const pr = r && r.process;
    if (pr && pr.needsAck && !String(VB.params.process.ack || '').trim()) {      // quy trình còn mục không đạt / thiếu dữ liệu: buộc ghi lý do chấp nhận trước khi lưu
        showToast('Quy trình còn mục chưa đạt: ghi lý do chấp nhận ở bước 7 trước khi lưu', 'error');
        if (VB.tab !== 'process') { VB.tab = 'process'; renderStockBody(); }
        const box = document.getElementById('vb-proc-ack'); if (box) { box.scrollIntoView({ block: 'center' }); box.focus(); }
        return;
    }
    const rec = VBEngine.toRecord(r, { note: note.trim(), weights: VB.params.weights, marginOfSafety: VB.params.mos, process: VB.params.process, adjustments: VB.params.adjustments, driver: VB.params.driver, peerSet: VB.params.peerSet });
    if (!rec) { showToast('Chưa có giá trị hợp lý để lưu', 'error'); return; }
    const btn = document.getElementById('vb-save-btn'); if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu…'; }
    try {
        const res = await call('saveVbValuation', { record: rec });
        showToast(res.message || 'Đã lưu định giá', 'success');
        try { VB.history = await call('getVbHistory', { symbol: VB.symbol, limit: 60 }); } catch (e) { /* giữ cũ */ }
        renderStockBody();
    } catch (e) { showToast(e.message, 'error'); if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Lưu bản định giá'; } }
}
async function applyToPortfolio() {
    const s = VB.result && VB.result.synthesis; if (!s || !s.ok) return;
    const target = Math.round(s.fair.base), buy = Math.round(s.zones.accumulate.high);
    const msg = 'Áp dụng cho ' + VB.symbol + ' trong Danh Mục của bạn?\n\n• Giá mục tiêu: ' + VU.vnd(target) + ' (giá trị hợp lý đồng thuận)\n• Giá muốn mua: ' + VU.vnd(buy) + ' (đầu vùng tích lũy, biên an toàn ' + Math.round(VB.params.mos * 100) + '%)\n\nMã đang nắm: ghi vào giá mục tiêu. Mã chưa nắm: thêm/cập nhật mục Theo Dõi (cảnh báo giá chạy như cũ).';
    if (!window.confirm(msg)) return;
    try { showToast(await call('pushStockToPortfolio', { symbol: VB.symbol, targetPrice: target, buyBelow: buy }), 'success'); } catch (e) { showToast(e.message, 'error'); }
}
async function deleteSaved(id) {
    if (!window.confirm('Xoá bản định giá này? Không khôi phục được.')) return;
    try { showToast(await call('deleteVbValuation', { id: id }), 'success'); VB.history = await call('getVbHistory', { symbol: VB.symbol, limit: 60 }); if (VB.view === 'stock') renderStockBody(); else renderOverview(); } catch (e) { showToast(e.message, 'error'); }
}
async function restoreSaved(id) {
    try {
        const data = await call('getVbById', { id: id });
        if (!data) throw new Error('Không đọc được bản định giá');
        const a = data.assumptions || {};
        VB.params = Object.assign(loadParamsDefault(), { dcf: a.dcf ? pickEditable(a.dcf) : {}, bank: a.bank || {}, weights: a.weights || {}, mos: a.marginOfSafety === null || a.marginOfSafety === undefined ? 0.2 : a.marginOfSafety, process: a.process || null, adjustments: a.adjustments || [], driver: a.driver || { enabled: false }, peerSet: a.peerSet || null });
        normalizeProcess(VB.params);
        await ensureCustomPeers();
        recompute(); renderStockBody(); showToast('Đã nạp lại giả định của bản ngày ' + vbDate(data.created_at), 'success');
    } catch (e) { showToast(e.message, 'error'); }
}
// các khoá giả định DCF người dùng chỉnh được (loại ghi chú, chi tiết WACC và số liệu dẫn xuất)
const DCF_EDITABLE = ['wacc', 'g1', 'highYears', 'gTerminal', 'years', 'ebitMargin', 'marginTarget', 'marginYears', 'taxRate', 'taxTarget', 'salesToCapital', 'terminalRoic', 'exitMultiple', 'exitWeight', 'midYear', 'minorityShare'];
function pickEditable(a) { const o = {}; DCF_EDITABLE.forEach(function (k) { if (a[k] !== undefined && a[k] !== null) o[k] = a[k]; }); return o; }

// ---------- trang Tổng quan ----------
async function renderOverview() {
    const root = document.getElementById('vb-root'); if (!root) return;
    const recents = recentList();
    root.innerHTML = '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-magnifying-glass-chart"></i> Phân tích một cổ phiếu</h3>' + searchBoxHtml() +
        (recents.length ? '<div class="vb-recent">' + recents.map(function (s) { return '<button type="button" class="vl-chip" onclick="setHash(\'stock\',\'' + vbE(s) + '\')">' + vbE(s) + '</button>'; }).join('') + '</div>' : '') + '</div>' +
        '<div id="vb-ov-market"><div class="vb-skeleton"><div></div></div></div><div id="vb-ov-saved"><div class="vb-skeleton"><div></div></div></div>' +
        '<p class="vb-disclaimer">Valuation Bench là công cụ phân tích, không phải khuyến nghị đầu tư. Mọi giá trị ước tính rất nhạy với giả định; đọc kèm bảng nhạy cảm, độ tin cậy và các cờ cảnh báo. Dữ liệu miễn phí từ VNDirect, có thể trễ hoặc sai lệch với báo cáo gốc.</p>';
    const mk = document.getElementById('vb-ov-market'), sv = document.getElementById('vb-ov-saved');
    Promise.allSettled([call('getValuationHistory', { years: 6 }), call('listVbLatest', { limit: 200 })]).then(function (res) {
        if (VB.view !== 'overview') return;
        const hist = res[0].status === 'fulfilled' ? res[0].value : null, list = res[1].status === 'fulfilled' ? res[1].value : [];
        if (mk) mk.innerHTML = overviewMarketHtml(hist);
        if (sv) sv.innerHTML = overviewSavedHtml(list, res[1].status === 'rejected' ? res[1].reason.message : '');
    });
}
function searchBoxHtml() {
    return '<form class="vb-search" onsubmit="return openSymbolFromInput(event)"><input id="vb-sym-input" maxlength="12" placeholder="Mã, ví dụ FPT" aria-label="Mã cổ phiếu" autocomplete="off"><button type="submit" class="vb-btn"><i class="fa-solid fa-arrow-right"></i> Phân tích</button></form>';
}
function openSymbolFromInput(e) {
    if (e) e.preventDefault();
    const el = document.getElementById('vb-sym-input'), s = (el && el.value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(s)) { showToast('Nhập mã cổ phiếu hợp lệ (chữ và số, tối đa 12 ký tự)', 'error'); return false; }
    setHash('stock', s); return false;
}
function overviewMarketHtml(h) {
    if (!h || !h.rows || !h.rows.length || typeof ValuationAlerts === 'undefined') return '';
    const VH = ValuationHistory, pe = VH.summarize(VH.seriesOf(h.rows, 'ALL', 'pe_agg'), { years: 5 }), pb = VH.summarize(VH.seriesOf(h.rows, 'ALL', 'pb_agg'), { years: 5 });
    const spread = pe ? VH.earningsYieldSpread(pe.now, h.bond10y) : null, al = ValuationAlerts.build(h.rows, [], { bond10yPct: h.bond10y });
    const kpi = function (l, v, s) { return '<div class="vb-kpi"><span class="l">' + vbE(l) + '</span><span class="v">' + v + '</span><span class="s">' + s + '</span></div>'; };
    const grade = function (x) { return x && x.enough ? vbPill(x.label.tone === 'ok' ? 'ok' : (x.label.tone === 'warn' ? 'warn' : 'mute'), x.label.label) + ' <span class="vb-muted">phân vị ' + vbN(x.pct, 0) + '</span>' : 'chưa đủ lịch sử'; };
    return '<div class="vb-kpis">' + kpi('P/E thị trường (tổng hợp)', pe ? vbN(pe.now, 1) + 'x' : '—', grade(pe)) + kpi('P/B thị trường (tổng hợp)', pb ? vbN(pb.now, 2) + 'x' : '—', grade(pb)) +
        kpi('Lợi suất lợi nhuận − TPCP 10 năm', spread && spread.spreadPct !== null ? vbN(spread.spreadPct, 1) + ' đ%' : '—', spread ? 'lợi suất lợi nhuận ' + vbN(spread.earningsYieldPct, 1) + '% · TPCP ' + (spread.bondPct === null ? '—' : vbN(spread.bondPct, 2) + '%') : 'chưa có lãi suất') +
        kpi('Cảnh báo định giá thị trường', String(al.alerts.length), al.warn ? al.warn + ' cần xem' : 'không có tín hiệu cần xem') + '</div>' +
        (al.alerts.length ? '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-bell"></i> Tín hiệu định giá thị trường<span class="vl-muted">xem chi tiết ở Bản đồ</span></h3><ul class="vb-list">' + al.alerts.slice(0, 5).map(function (a) { return '<li class="' + (a.level === 'warn' ? 'neg' : 'pos') + '"><i class="fa-solid ' + (a.level === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info') + '"></i><span><b>' + vbE(a.title) + '</b><br><span class="vb-muted">' + vbE(a.detail) + '</span></span></li>'; }).join('') + '</ul></div>' : '');
}
function overviewSavedHtml(list, err) {
    const head = '<h3 class="vl-card-title"><i class="fa-solid fa-bookmark"></i> Định giá đã lưu của nhóm<span class="vl-muted">' + (list ? list.length : 0) + ' mã · bản mới nhất mỗi mã</span></h3>';
    if (err) return '<div class="vl-card">' + head + '<div class="vl-empty">Không tải được danh sách: ' + vbE(err) + '</div></div>';
    if (!list.length) return '<div class="vl-card">' + head + '<div class="vl-empty"><i class="fa-solid fa-scale-balanced"></i> Chưa có bản định giá nào. Mở một cổ phiếu, chỉnh giả định rồi bấm "Lưu bản định giá" để nhóm cùng xem và để Investment Workbench hiển thị.</div></div>';
    const rows = list.map(function (r) {
        const mos = r.margin_of_safety; const tone = mos === null ? '' : (mos >= 0.1 ? 'vb-up' : (mos <= -0.1 ? 'vb-down' : ''));
        return '<tr class="vb-clickable" onclick="setHash(\'stock\',\'' + vbE(r.symbol) + '\')"><td><b>' + vbE(r.symbol) + '</b></td><td>' + vbN(r.fair_low) + ' – <b>' + vbN(r.fair_base) + '</b> – ' + vbN(r.fair_high) + '</td><td>' + vbN(r.price) + '</td><td class="' + tone + '">' + vbPct(mos, 0, true) + '</td>' +
            '<td class="l">' + vbE(r.grade || '') + '</td><td class="l">' + vbE(r.tech_rating || '—') + '</td><td>' + (r.market_score === null ? '—' : vbN(r.market_score, 0)) + '</td><td>' + vbE(r.confidence || '—') + '</td><td>' + vbDate(r.as_of) + '</td><td class="l">' + vbE(r.author || '') + '</td></tr>';
    }).join('');
    return '<div class="vl-card">' + head + '<div class="vb-table-wrap"><table class="vb-table"><thead><tr><th class="l">Mã</th><th>Giá trị hợp lý (thấp – cơ sở – cao)</th><th>Giá lúc lưu</th><th>Biên an toàn</th><th class="l">Kết luận</th><th class="l">Kỹ thuật</th><th>Thị trường</th><th>Tin cậy</th><th>Ngày</th><th class="l">Người lưu</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}
function renderStockHome() {
    const root = document.getElementById('vb-root'); if (!root) return;
    const recents = recentList();
    root.innerHTML = '<div class="vl-card"><h3 class="vl-card-title"><i class="fa-solid fa-magnifying-glass-chart"></i> Chọn một cổ phiếu để định giá</h3>' + searchBoxHtml() +
        (recents.length ? '<div class="vb-recent">' + recents.map(function (s) { return '<button type="button" class="vl-chip" onclick="setHash(\'stock\',\'' + vbE(s) + '\')">' + vbE(s) + '</button>'; }).join('') + '</div>' : '') +
        '<p class="vb-note">Hồ sơ cổ phiếu gồm: <b>Tổng hợp</b> (khoảng giá các phương pháp, giá trị đồng thuận, vùng giá), <b>Cơ bản</b> (báo cáo, tỷ số, điểm chất lượng), <b>Định giá</b> (DCF, bội số, tài sản, ngân hàng), <b>Kỹ thuật</b> (biểu đồ nến và chỉ báo), <b>Thị trường</b> (bối cảnh), <b>Đã lưu</b>.</p></div>';
}

// ---------- thư viện phương pháp ----------
function renderMethods(group) {
    const root = document.getElementById('vb-root'); if (!root) return;
    const L = VBMethods.LIST.filter(function (m) { return group === 'all' || m.group === group; });
    root.innerHTML = '<div class="vb-lib-filter"><button type="button" class="vl-chip" aria-pressed="' + (group === 'all') + '" onclick="renderMethods(\'all\')">Tất cả (' + VBMethods.LIST.length + ')</button>' +
        Object.keys(VBMethods.GROUPS).map(function (g) { return '<button type="button" class="vl-chip" aria-pressed="' + (group === g) + '" onclick="renderMethods(\'' + g + '\')">' + vbE(VBMethods.GROUPS[g]) + '</button>'; }).join('') + '</div>' +
        '<div class="vb-lib">' + L.map(function (m) {
            return '<article class="vb-lib-card" id="m-' + vbE(m.id) + '"><h4>' + vbE(m.name) + ' ' + vbPill('info', VBMethods.GROUPS[m.group]) + '</h4><p>' + vbE(m.what) + '</p><code>' + vbE(m.formula) + '</code><p><b>Khi nào dùng:</b> ' + vbE(m.use) + '</p><p><b>Giới hạn:</b> ' + vbE(m.limit) + '</p><p><b>Cách đọc:</b> ' + vbE(m.read) + '</p></article>';
        }).join('') + '</div><p class="vb-disclaimer">Các công cụ này mô tả và ước lượng, không dự báo chắc chắn. Mọi phương pháp đều có giả định; không có phương pháp nào đúng một mình, vì thế Valuation Bench luôn hiển thị nhiều phương pháp cạnh nhau cùng độ tin cậy.</p>';
}
