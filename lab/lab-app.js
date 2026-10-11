/* --- FILE: /lab/lab-app.js ---
   Phòng kiểm thử: định tuyến theo #tab, tải kho giá, đọc cấu hình từ biểu mẫu, chạy bộ máy lib/strategy-backtest.js ngay trong máy, lưu và mở lại các lần kiểm thử, phân tích yếu tố của danh mục.
   Tất cả tính toán chạy trong trình duyệt (kho giá tải về một lần, lưu trong IndexedDB); không có gì rời khỏi máy trừ việc lưu kết quả khi bạn bấm "Lưu". */
'use strict';
const LAB = {
    view: 'backtest', email: null, me: null,
    data: { state: 'idle', progress: { frac: 0, text: '' } }, panel: null, pit: [],
    draft: null, preset: 'momentum', errors: [], specWarnings: [], running: false, progress: '', result: null, logScale: false, saving: false,
    runs: { state: 'idle', list: [] }, trials: { count: 0, srVarDaily: null },
    fac: { state: 'idle', res: null, error: '', subject: 'mine', window: 504, custom: '' },
};
const TABS = { backtest: 'backtest', factors: 'factors' };
const V = LabViews, SB = StrategyBacktest, U = InsUtil;

// ---------- tiện ích ----------
async function labCall(action, params) {
    const r = await callGAS(action, Object.assign({ email: LAB.email }, params || {}));
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}
const tick = () => new Promise((res) => setTimeout(res, 0));
function setStatus(text) { const el = document.getElementById('lab-status'); if (el) el.innerHTML = text; }
function applyThemeIcon() { const ic = document.getElementById('theme-ic'); if (ic) ic.className = document.documentElement.getAttribute('data-theme') === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon'; }
function toggleDeskTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (dark) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('user-theme', dark ? 'light' : 'dark'); } catch (e) { /* bị chặn */ }
    applyThemeIcon();
}
function showToast(message, type) {
    if (typeof window.showToast === 'function' && window.showToast !== showToast) { window.showToast(message, type); return; }
    let el = document.getElementById('lab-toast');
    if (!el) { el = document.createElement('div'); el.id = 'lab-toast'; el.setAttribute('role', 'status'); el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;padding:10px 16px;border-radius:8px;font-size:.84rem;max-width:90vw;box-shadow:0 6px 24px rgba(0,0,0,.25)'; document.body.appendChild(el); }
    el.style.display = 'block'; el.textContent = message; el.style.background = type === 'error' ? 'var(--danger-color)' : 'var(--card-bg-elevated, #222)'; el.style.color = type === 'error' ? '#fff' : 'var(--text-primary)'; el.style.border = '1px solid var(--border-strong)';
    clearTimeout(el._t); el._t = setTimeout(function () { el.style.display = 'none'; }, 4200);
}
function specOf(preset) { const p = SB.PRESETS.find((x) => x.id === preset); return SB.normalizeSpec(p ? p.spec : {}).spec; }
function validateDraft() { const n = SB.normalizeSpec(LAB.draft); LAB.errors = n.errors; LAB.specWarnings = n.warnings; }
function savePrefs() { try { localStorage.setItem('lab-draft', JSON.stringify({ draft: LAB.draft, preset: LAB.preset, log: LAB.logScale })); } catch (e) { /* bị chặn */ } }
function restorePrefs() {
    try {
        const p = JSON.parse(localStorage.getItem('lab-draft') || 'null');
        if (p && p.draft) { const n = SB.normalizeSpec(p.draft); if (!n.errors.length) { LAB.draft = n.spec; LAB.preset = p.preset === 'custom' || SB.PRESETS.some((x) => x.id === p.preset) ? p.preset : 'custom'; } }
        LAB.logScale = !!(p && p.log);
    } catch (e) { /* chưa có hoặc bị chặn */ }
    if (!LAB.draft) LAB.draft = specOf('momentum');
}

// ---------- vẽ ----------
function html() { return LAB.view === 'factors' ? (typeof LabFactorViews !== 'undefined' ? LabFactorViews.factorsHtml(LAB) : '') : V.backtestHtml(LAB); }
function render() {
    const root = document.getElementById('lab-root');
    if (!root) return;
    try { root.innerHTML = html(); } catch (e) { console.error(e); root.innerHTML = U.card('triangle-exclamation', 'Không dựng được màn hình', U.empty('triangle-exclamation', U.esc(e.message || String(e)))); }
}
function renderDataBar() { const el = document.getElementById('lab-databar'); if (el) el.innerHTML = V.dataBarHtml(LAB); else render(); }
function route() {
    const h = String(location.hash || '').replace('#', '');
    LAB.view = TABS[h] ? h : 'backtest';
    if (typeof BenchNav !== 'undefined') BenchNav.setActive(LAB.view);
    document.querySelectorAll('.desk-nav a[href^="/lab/"]').forEach(function (a) { const on = a.getAttribute('href') === '/lab/#' + LAB.view; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    render();
    if (LAB.data.state === 'idle') labLoad(false);
    if (LAB.view === 'backtest' && LAB.runs.state === 'idle') labLoadRuns();
}

// ---------- dữ liệu ----------
async function labLoad(force) {
    if (LAB.data.state === 'loading') return;
    if (LAB.data.state === 'ready' && !force) return;
    LAB.data = { state: 'loading', progress: { frac: 0, text: 'Bắt đầu…' } };
    render();
    try {
        const r = await API.lab.loadPanel(function (p) { LAB.data.progress = p; renderDataBar(); });
        LAB.panel = r.panel;
        LAB.data.progress = { frac: 0.98, text: 'Đọc số liệu cơ bản theo thời điểm…' }; renderDataBar();
        let pit = { days: [], n: 0, first: null, last: null, backfill: 0 };
        try { pit = await API.lab.loadPit(); } catch (e) { console.error(e); showToast('Không tải được số liệu cơ bản theo thời điểm: ' + (e.message || e) + '. Chiến lược chỉ dùng chuỗi giá vẫn chạy được.', 'error'); }
        LAB.pit = pit.days;
        const mem = (performance && performance.memory) ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0;
        LAB.data = { state: 'ready', summary: BtPanel.summary(r.panel), pit: { n: pit.n, first: pit.first, last: pit.last, backfill: pit.backfill }, downloaded: r.downloaded, fromCache: r.fromCache, memoryMb: mem };
        setStatus('<span class="dot" style="background:var(--success-color)"></span> Kho giá đến ' + U.date(LAB.data.summary.last));
    } catch (e) {
        console.error(e);
        LAB.data = { state: 'error', error: e.message || String(e) };
    }
    render();
}
async function labLoadRuns() {
    LAB.runs = { state: 'loading', list: LAB.runs.list || [] };
    try { LAB.runs = { state: 'ok', list: await labCall('labListRuns') }; } catch (e) { LAB.runs = { state: 'error', error: e.message || String(e), list: [] }; }
    LAB.trials = API.lab.trials(LAB.runs.list);
    render();
}

// ---------- biểu mẫu ----------
function setPath(path, value) {
    const sp = LAB.draft, num = (v) => { const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
    const codes = (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    switch (path) {
        case 'name': sp.name = String(value).slice(0, 120); break;
        case 'period.from': sp.period.from = value || null; break;
        case 'period.to': sp.period.to = value || null; break;
        case 'universe.minAdv': { const n = num(value); if (n !== null) sp.universe.minAdv = n * 1e9; break; }
        case 'universe.minPrice': { const n = num(value); if (n !== null) sp.universe.minPrice = n; break; }
        case 'universe.minHistory': { const n = num(value); if (n !== null) sp.universe.minHistory = n; break; }
        case 'universe.icbIn': sp.universe.icbIn = codes(value); break;
        case 'universe.icbOut': sp.universe.icbOut = codes(value); break;
        case 'select.n': { const n = num(value); if (n !== null) sp.select.n = n; break; }
        case 'select.keep': { const n = num(value); if (n !== null) sp.select.keep = n / 100; break; }
        case 'maxWeight': { const n = num(value); if (n !== null) sp.maxWeight = n / 100; break; }
        case 'weighting': sp.weighting = value; break;
        case 'lag': { const n = num(value); if (n !== null) sp.lag = n; break; }
        case 'participation': { const n = num(value); if (n !== null) sp.participation = n / 100; break; }
        case 'costs.fee': { const n = num(value); if (n !== null) sp.costs.fee = n / 100; break; }
        case 'costs.tax': { const n = num(value); if (n !== null) sp.costs.tax = n / 100; break; }
        case 'costs.impact': sp.costs.impact = String(value) === '1'; break;
        case 'capital': { const n = num(value); if (n !== null) sp.capital = n * 1e9; break; }
        case 'rf': { const n = num(value); if (n !== null) sp.rf = n / 100; break; }
        default: return false;
    }
    return true;
}
function touched() { LAB.preset = 'custom'; validateDraft(); savePrefs(); render(); }
function labSet(path, value) { if (setPath(path, value)) touched(); }
function labPreset(id) { LAB.draft = specOf(id); LAB.preset = id; validateDraft(); savePrefs(); render(); }
function labReset() { labPreset('momentum'); }
function labFreq(f) { LAB.draft.rebalance = f; touched(); }
function labExchange(x, on) { const s = new Set(LAB.draft.universe.exchanges); if (on) s.add(x); else s.delete(x); LAB.draft.universe.exchanges = [...s]; touched(); }
function labAddFilter() { LAB.draft.filters.push({ key: 'pe', min: null, max: 15 }); touched(); }
function labDelFilter(i) { LAB.draft.filters.splice(i, 1); touched(); }
function labFilter(i, field, value) {
    const f = LAB.draft.filters[i]; if (!f) return;
    if (field === 'key') { f.key = value; f.min = null; f.max = null; if (!SB.BY_KEY[value]) return; } else f[field] = V.fromDisplay(f.key, value);
    touched();
}
function labAddRank() { if (LAB.draft.rank.length < 8) LAB.draft.rank.push({ key: 'roae', dir: 'high', w: 1 }); touched(); }
function labDelRank(i) { if (LAB.draft.rank.length > 1) LAB.draft.rank.splice(i, 1); touched(); }
function labRank(i, field, value) {
    const r = LAB.draft.rank[i]; if (!r) return;
    if (field === 'w') { const n = Number(String(value).replace(',', '.')); r.w = isFinite(n) && n > 0 ? n : 1; } else r[field] = value;
    touched();
}
function labLog(on) { LAB.logScale = !!on; savePrefs(); render(); }

// ---------- chạy ----------
async function labRun() {
    if (LAB.running) return;
    if (LAB.data.state !== 'ready') { showToast('Kho giá chưa tải xong.', 'error'); return; }
    const n = SB.normalizeSpec(LAB.draft);
    if (n.errors.length) { LAB.errors = n.errors; render(); return; }
    LAB.draft = n.spec; LAB.errors = []; LAB.specWarnings = n.warnings;
    LAB.running = true; LAB.progress = 'Chuẩn bị…'; render();
    await tick();
    const tr = API.lab.trials(LAB.runs.list, API.lab._hash(n.spec));
    const stages = { plan: 'Chọn mã theo từng kỳ…', universe: 'Dựng rổ đều toàn vũ trụ…', bootstrap: 'Bootstrap khoảng tin cậy…', random: 'Chạy rổ ngẫu nhiên…', sensitivity: 'Thử độ nhạy tham số…', done: 'Xong' };
    let res;
    try {
        res = await SB.run(LAB.panel, n.spec, { pit: LAB.pit, randomRuns: 150, trials: { count: tr.count, srVarDaily: tr.srVarDaily }, onProgress: function (st, f) { const el = document.getElementById('lab-prog'); const t = (stages[st] || st) + ' ' + Math.round((f || 0) * 100) + '%'; LAB.progress = t; if (el) el.textContent = t; } });
    } catch (e) { console.error(e); res = { ok: false, errors: ['Lỗi khi chạy: ' + (e.message || e)] }; }
    LAB.running = false; LAB.result = res; LAB.progress = '';
    if (res.ok) { API.lab.noteTrial(res); LAB.trials = API.lab.trials(LAB.runs.list); }
    savePrefs(); render();
    const el = document.getElementById('lab-result'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- lưu / mở lại ----------
async function labSave() {
    if (!LAB.result || !LAB.result.ok || LAB.saving) return;
    LAB.saving = true; render();
    try {
        const noteEl = document.getElementById('lab-note');
        await labCall('labSaveRun', { name: LAB.result.spec.name, note: noteEl ? noteEl.value : '', result: LAB.result });
        showToast('Đã lưu lần kiểm thử');
        await labLoadRuns();
    } catch (e) { showToast('Không lưu được: ' + (e.message || e), 'error'); }
    LAB.saving = false; render();
}
async function labOpenRun(id) {
    try {
        const r = await labCall('labGetRun', { id });
        const n = SB.normalizeSpec(r.spec);
        LAB.draft = n.spec; LAB.preset = 'custom'; validateDraft();
        LAB.result = Object.assign({}, r.summary, { ok: true }); savePrefs(); render();
        showToast('Đã mở lại: ' + r.name + '. Bấm "Chạy kiểm thử" để chạy lại trên dữ liệu mới nhất.');
        const el = document.getElementById('lab-result'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { showToast('Không mở được: ' + (e.message || e), 'error'); }
}
async function labDelRun(id) {
    if (!confirm('Xoá lần kiểm thử này khỏi danh sách đã lưu? (Số cấu hình đã thử vẫn được tính để trừ may rủi.)')) return;
    try { await labCall('labDeleteRun', { id }); await labLoadRuns(); } catch (e) { showToast('Không xoá được: ' + (e.message || e), 'error'); }
}

// ---------- khởi động ----------
document.addEventListener('DOMContentLoaded', async function () {
    applyThemeIcon();
    restorePrefs(); validateDraft();
    if (typeof BenchNav !== 'undefined') BenchNav.mount({ bench: 'lab', active: 'backtest' });
    window.addEventListener('hashchange', route);
    if (typeof sbClient !== 'undefined' && sbClient) {
        try { await sbClient.auth.getSession(); const { data } = await sbClient.auth.getUser(); LAB.email = data && data.user ? data.user.email : null; } catch (e) { /* chưa đăng nhập: dải báo phiên của api.js lo */ }
    }
    route();
});
window.__LAB = LAB;
