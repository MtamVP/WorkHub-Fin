/* --- FILE: /simulation/sim-app.js ---
   Market Simulation: bộ điều khiển trang. Định tuyến theo hash (#outlook | #portfolio | #tree | #validate | #method), lấy dữ liệu (API getSimInputs, danh mục cá nhân / nhóm,
   danh sách theo dõi, định giá đã lưu), giao việc tính cho luồng nền (sim-worker.js; trình duyệt không hỗ trợ thì chạy ngay trên trang), giữ giả định và chính sách tự tạo
   trong trình duyệt. Mọi phép tính ở /lib/sim-models.js và /lib/market-sim.js (có kiểm thử); phần vẽ ở sim-views.js và sim-charts.js. */

const SIM_KEY = 'wh.sim.v1';
const SIM = {
    view: 'outlook', email: null,
    market: { state: 'idle', model: null, result: null, error: '', step: '' },
    subject: 'mine', custom: { symbols: 'FPT, HPG, MWG, VCB', amount: 100000000 }, watchlist: [],
    book: null, bookState: 'idle', bookError: '', bookKey: '',
    selected: ['hold', 'trim30', 'stop8', 'trail12', 'plan', 'dip', 'cash'], customPolicies: [],
    settings: { paths: 10000, model: 'blend', drift: 9, riskAversion: 3, target: 10, fee: 0.15, tax: 0.1, participation: 20, seed: 20261009, useFair: false, bands: [0.02, 0.04, 0.06] },
    run: { state: 'idle', result: null, error: '', hk: 2, sel: null, step: '', ms: 0 },
    validate: { state: 'idle', result: null, error: '' },
    treePath: '', settingsOpen: false, builderOpen: false,
    prepared: { key: null, model: null },
};

// ---------- lưu / đọc giả định ----------
function simSave() {
    try { localStorage.setItem(SIM_KEY, JSON.stringify({ subject: SIM.subject, custom: SIM.custom, selected: SIM.selected, customPolicies: SIM.customPolicies, settings: SIM.settings })); } catch (e) { /* bỏ qua */ }
}
function simRestore() {
    try {
        const s = JSON.parse(localStorage.getItem(SIM_KEY) || 'null'); if (!s) return;
        if (['mine', 'group', 'index', 'custom'].indexOf(s.subject) !== -1) SIM.subject = s.subject;
        if (s.custom && typeof s.custom.symbols === 'string') SIM.custom.symbols = s.custom.symbols.slice(0, 300);
        if (s.custom && Number(s.custom.amount) > 0) SIM.custom.amount = Number(s.custom.amount);
        if (Array.isArray(s.customPolicies)) SIM.customPolicies = s.customPolicies.slice(0, 8).map((p) => MarketSim.validatePolicy(p));
        const ids = MarketSim.PRESETS.map((p) => p.id).concat(SIM.customPolicies.map((p) => p.id));
        if (Array.isArray(s.selected)) SIM.selected = ['hold'].concat(s.selected.filter((id) => id !== 'hold' && ids.indexOf(id) !== -1)).slice(0, 10);
        if (s.settings) Object.keys(SIM.settings).forEach((k) => { if (k !== 'bands' && s.settings[k] !== undefined) SIM.settings[k] = s.settings[k]; });
    } catch (e) { /* mặc định */ }
}

// ---------- luồng nền ----------
const SimWorker = (function () {
    let w = null, broken = typeof Worker === 'undefined', seq = 0, lastPrepare = null, ictx = null, iIndex = null;
    const pending = {};
    function inline(msg) {
        if (msg.type === 'prepare') { ictx = MarketSim.prepare(msg.input, msg.opts); iIndex = msg.input.index; return MarketSim.describe(ictx); }
        if (!ictx && lastPrepare) inline(lastPrepare);
        if (msg.type === 'simulate') { if (!ictx || !ictx.ok) throw new Error('Mô hình chưa sẵn sàng.'); return MarketSim.simulate(ictx, msg.book, msg.policies, msg.opts); }
        if (msg.type === 'backtest') return MarketSim.backtest(MarketSim.logRets(iIndex || []), msg.opts);
        throw new Error('Lệnh không hợp lệ.');
    }
    function fail() { broken = true; if (w) { try { w.terminate(); } catch (e) { /* bỏ qua */ } } w = null; Object.keys(pending).forEach((id) => { const p = pending[id]; delete pending[id]; p.fallback(); }); }
    function ensure() {
        if (w || broken) return w;
        try {
            w = new Worker('sim-worker.js?v=1792400000001');
            w.onmessage = function (e) { const d = e.data || {}, p = pending[d.id]; if (!p) return; delete pending[d.id]; if (d.ok) p.res(d.data); else p.rej(new Error(d.error || 'Lỗi mô phỏng')); };
            w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); fail(); };
        } catch (e) { broken = true; w = null; }
        return w;
    }
    function call(type, payload) {
        const msg = Object.assign({ type: type }, payload || {});
        if (type === 'prepare') lastPrepare = msg;
        return new Promise(function (res, rej) {
            const fb = () => setTimeout(function () { try { res(inline(msg)); } catch (e) { rej(e); } }, 20);
            const ww = ensure();
            if (!ww) { fb(); return; }
            const id = ++seq; msg.id = id; pending[id] = { res: res, rej: rej, fallback: fb };
            try { ww.postMessage(msg); } catch (e) { delete pending[id]; fail(); fb(); }
        });
    }
    return { call: call, isInline: () => broken };
})();

// ---------- tiện ích ----------
async function simCall(action, params) {
    const r = await callGAS(action, params || {});
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}
function setStatus(text) { const el = document.getElementById('sim-status'); if (el) el.innerHTML = text; }
function applyThemeIcon() { const ic = document.getElementById('theme-ic'); if (ic) ic.className = document.documentElement.getAttribute('data-theme') === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon'; }
function toggleDeskTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('user-theme', next); } catch (e) { /* bỏ qua */ }
    applyThemeIcon(); SimCharts.redrawAll();
}
function showToast(message, type) {
    const old = document.querySelector('.toast-notification'); if (old) old.remove();
    const t = document.createElement('div'); t.className = 'toast-notification toast-' + (type || 'success'); t.setAttribute('role', 'status');
    t.innerHTML = '<i class="fa-solid ' + (type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check') + '"></i> <span>' + sE(message) + '</span>';
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 4000);
}
function simOpts(extra) {
    const s = SIM.settings;
    return Object.assign({ paths: Number(s.paths) || 10000, model: s.model, drift: Number(s.drift) / 100, riskAversion: Number(s.riskAversion) || 3, target: Number(s.target) / 100, fee: Number(s.fee) / 100, tax: Number(s.tax) / 100, participation: Number(s.participation) / 100, seed: Number(s.seed) || 1, bands: s.bands.slice() }, extra || {});
}

// ---------- định tuyến ----------
const SIM_VIEWS = ['outlook', 'portfolio', 'tree', 'validate', 'method'];
function route() {
    const h = String(location.hash || '').replace(/^#/, '').split('/')[0];
    SIM.view = SIM_VIEWS.indexOf(h) !== -1 ? h : 'outlook';
    if (typeof BenchNav !== 'undefined') BenchNav.setActive(SIM.view);
    const title = document.getElementById('sim-title');
    if (title) title.textContent = { outlook: 'Market Simulation', portfolio: 'Mô phỏng & quyết định', tree: 'Cây kịch bản', validate: 'Kiểm chứng mô hình', method: 'Phương pháp' }[SIM.view];
    if (SIM.view === 'portfolio' && SIM.bookState === 'idle') simLoadBook();
    render();
}
function render() {
    const root = document.getElementById('sim-root'); if (!root) return;
    const v = SIM.view;
    root.innerHTML = v === 'portfolio' ? renderPortfolioView() : v === 'tree' ? renderTreeView() : v === 'validate' ? renderValidateView() : v === 'method' ? renderMethodView() : renderOutlookView();
    if (v === 'outlook') mountOutlookCharts();
    if (v === 'portfolio') mountPortfolioCharts();
}

// ---------- mô hình thị trường + triển vọng ----------
let simInputsCache = {};
async function getInputs(symbols) {
    const key = symbols.slice().sort().join(',');
    if (simInputsCache[key] && Date.now() - simInputsCache[key].at < 30 * 60000) return simInputsCache[key];
    const raw = await simCall('getSimInputs', { symbols: symbols, days: 2555 });
    const input = MarketSim.fromHistories(raw, RiskCalc, { windowDays: 2600 });
    const out = { key: key, raw: raw, input: input, at: Date.now() };
    simInputsCache[key] = out;
    return out;
}
// Luồng nền chỉ giữ MỘT mô hình đã ước lượng: mỗi chuỗi "ước lượng rồi mô phỏng" phải chạy trọn trước khi chuỗi khác ước lượng lại (khoá tuần tự)
let simLock = Promise.resolve();
function withModel(symbols, fn) {
    const run = simLock.then(async () => fn(await prepareFor(symbols)));
    simLock = run.catch(() => { /* lỗi của chuỗi trước không chặn chuỗi sau */ });
    return run;
}
async function prepareFor(symbols) {
    const inp = await getInputs(symbols);
    const pkey = inp.key + '|' + inp.at;
    if (SIM.prepared.key === pkey) return { inp: inp, model: SIM.prepared.model };
    const model = await SimWorker.call('prepare', { input: inp.input, opts: { horizons: [5, 21, 63] } });
    if (!model || !model.ok) throw new Error(model && model.reason === 'short' ? 'Chưa đủ lịch sử VN-Index (cần ít nhất 260 phiên, có ' + (model.have || 0) + ').' : 'Không ước lượng được mô hình từ dữ liệu hiện có.');
    SIM.prepared = { key: pkey, model: model };
    return { inp: inp, model: model };
}
async function simLoadMarket(force) {
    if (SIM.market.state === 'loading') return;
    if (force) { simInputsCache = {}; SIM.prepared = { key: null, model: null }; }
    SIM.market = { state: 'loading', model: null, result: null, error: '', step: 'Đang lấy 7 năm lịch sử VN-Index…' }; render();
    setStatus('<i class="fa-solid fa-spinner fa-spin"></i> Đang dựng mô hình');
    try {
        const out = await withModel([], async (p) => {
            SIM.market.step = 'Đang mô phỏng ' + Math.max(10000, Number(SIM.settings.paths) || 0).toLocaleString('vi-VN') + ' đường cho VN-Index…'; if (SIM.view === 'outlook') render();
            const r = await SimWorker.call('simulate', { book: { cash: 0, debt: 0, positions: [{ symbol: MarketSim.INDEX, qty: 1, price: p.model.indexLevel }] }, policies: [{ id: 'hold', label: 'VN-Index' }], opts: simOpts({ paths: Math.max(10000, Number(SIM.settings.paths) || 0), expected: null }) });
            return { p: p, result: r };
        });
        const p = out.p, result = out.result;
        if (!result || !result.ok) throw new Error('Mô phỏng không chạy được.');
        SIM.market = { state: 'ok', model: p.model, result: result, error: '' };
        setStatus('<i class="fa-solid fa-circle-check" style="color:var(--success-color)"></i> Số liệu tới ' + sE(fmtDate(p.model.lastDate)) + (SimWorker.isInline() ? ' · chạy trên trang' : ''));
    } catch (e) {
        SIM.market = { state: 'error', error: e.message || String(e) }; setStatus('');
    }
    if (SIM.view === 'outlook' || SIM.view === 'tree' || SIM.view === 'validate') render();
}

// ---------- đối tượng mô phỏng ----------
function parseCustom(text) {
    const out = []; const seen = {};
    String(text || '').split(/[,;\s]+/).forEach((tok) => {
        const m = /^([A-Za-z0-9]{1,12})(?::(\d+(?:[.,]\d+)?))?$/.exec(tok.trim()); if (!m) return;
        const s = m[1].toUpperCase(); if (seen[s] || s === 'VNINDEX') return; seen[s] = 1;
        out.push({ symbol: s, w: m[2] ? Number(m[2].replace(',', '.')) : null });
    });
    return out.slice(0, 25);
}
function parseAmount(v) { const n = Number(String(v || '').replace(/[^\d]/g, '')); return n > 0 ? n : null; }
async function simLoadBook() {
    SIM.bookState = 'loading'; SIM.book = null; SIM.bookError = ''; if (SIM.view === 'portfolio') render();
    try {
        let book;
        if (SIM.subject === 'mine') {
            const [hold, cd] = await Promise.all([simCall('getHoldingsView', { email: SIM.email }), simCall('getCashDebt', { email: SIM.email })]);
            book = { cash: cd.cash || 0, debt: cd.debt || 0, positions: (hold || []).filter((h) => Number(h.quantity) > 0).map((h) => ({ symbol: h.symbol, qty: Number(h.quantity), price: Number(h.marketPrice) || 0 })) };
            if (!book.positions.length && !(book.cash > 0)) throw new Error('Danh mục của bạn đang trống. Chọn "Tự chọn mã" để mô phỏng một kế hoạch mua thử.');
        } else if (SIM.subject === 'group') {
            const data = await simCall('getGroupData');
            const g = GroupCalc.consolidate(GroupCalc.memberPortfolios(data));
            book = { cash: g.cash || 0, debt: g.debt || 0, positions: g.symbols.filter((s) => s.quantity > 0).map((s) => ({ symbol: s.symbol, qty: s.quantity, price: s.price || 0 })), note: 'Gộp danh mục ' + (data.members || []).length + ' thành viên nhóm Finance.' };
            if (!book.positions.length) throw new Error('Danh mục nhóm đang trống.');
        } else if (SIM.subject === 'index') {
            const amt = SIM.custom.amount || 100000000;
            book = { cash: 0, debt: 0, positions: [{ symbol: MarketSim.INDEX, qty: 1, price: amt }], note: 'Toàn bộ số tiền đi theo VN-Index (như một quỹ ETF chỉ số).', indexAmount: amt };
        } else {
            const list = parseCustom(SIM.custom.symbols), amt = SIM.custom.amount || 100000000;
            if (!list.length) throw new Error('Nhập ít nhất một mã, ví dụ: FPT, HPG, MWG.');
            const given = list.filter((x) => x.w > 0), rest = list.filter((x) => !(x.w > 0)), used = given.reduce((s, x) => s + x.w, 0);
            const each = rest.length ? Math.max(0, 100 - used) / rest.length : 0, tot = used + each * rest.length || 1;
            const inp = await getInputs(list.map((x) => x.symbol));
            const lastClose = (s) => { const h = (inp.raw.histories || {})[s] || []; return h.length ? Number(h[h.length - 1][1]) : 0; };
            const missing = [];
            book = { cash: amt, debt: 0, positions: [] };
            list.forEach((x) => {
                const price = lastClose(x.symbol), w = (x.w > 0 ? x.w : each) / tot;
                if (!(price > 0)) { missing.push(x.symbol); return; }
                const qty = Math.floor(amt * w / price / 100) * 100;
                if (qty > 0) { book.positions.push({ symbol: x.symbol, qty: qty, price: price }); book.cash -= qty * price; }
            });
            if (!book.positions.length) throw new Error(missing.length ? 'Không có giá cho: ' + missing.join(', ') + '.' : 'Số tiền quá nhỏ để mua được lô 100 cổ phiếu.');
            book.note = 'Mua thử theo giá đóng cửa gần nhất, làm tròn lô 100' + (missing.length ? '; không có giá: ' + missing.join(', ') : '') + '.';
        }
        SIM.book = book; SIM.bookState = 'ok';
    } catch (e) { SIM.bookState = 'error'; SIM.bookError = e.message || String(e); }
    if (SIM.view === 'portfolio') render();
}
function simSetSubject(s) {
    if (SIM.subject === s && SIM.bookState === 'ok') return;
    SIM.subject = s; simSave(); SIM.run = Object.assign({}, SIM.run, { state: 'idle', result: null }); simLoadBook();
    if (s === 'custom' && !SIM.watchlist.length) simCall('getWatchlist', { email: SIM.email }).then((w) => { SIM.watchlist = [...new Set((w || []).map((x) => String(x.symbol || '').toUpperCase()).filter(Boolean))]; if (SIM.view === 'portfolio') render(); }).catch(() => { /* không có danh sách theo dõi */ });
}
function simCustomChanged() {
    const s = document.getElementById('sim-custom-syms'), a = document.getElementById('sim-custom-amt');
    if (s) SIM.custom.symbols = s.value.slice(0, 300);
    if (a) { const n = parseAmount(a.value); if (n) SIM.custom.amount = Math.min(n, 1e13); }
    simSave(); SIM.run = Object.assign({}, SIM.run, { state: 'idle', result: null }); simLoadBook();
}
function simAddSymbol(sym) {
    const list = parseCustom(SIM.custom.symbols); if (list.some((x) => x.symbol === sym)) return;
    SIM.custom.symbols = (SIM.custom.symbols ? SIM.custom.symbols.replace(/[,\s]+$/, '') + ', ' : '') + sym; simSave(); simLoadBook();
}

// ---------- chính sách ----------
function simTogglePolicy(id, on) {
    if (id === 'hold') return;
    if (on && SIM.selected.indexOf(id) === -1) { if (SIM.selected.length >= 10) { showToast('Tối đa 10 cách xử lý mỗi lần so sánh.', 'error'); render(); return; } SIM.selected.push(id); }
    if (!on) SIM.selected = SIM.selected.filter((x) => x !== id);
    simSave(); render();
}
function simRemovePolicy(id) { SIM.customPolicies = SIM.customPolicies.filter((p) => p.id !== id); SIM.selected = SIM.selected.filter((x) => x !== id); simSave(); render(); }
function numOf(id) { const el = document.getElementById(id); if (!el || String(el.value).trim() === '') return null; const n = Number(String(el.value).replace(',', '.')); return isFinite(n) ? n : null; }
function simAddCustomPolicy() {
    const name = (document.getElementById('pb-name').value || '').trim();
    const raw = { id: 'c' + Date.now().toString(36), label: name || 'Chính sách tự tạo' };
    const sell = numOf('pb-sell'), buy = numOf('pb-buy'); if (sell || buy) raw.now = { sellPct: sell || 0, buyPct: buy || 0 };
    const stop = numOf('pb-stop'); if (stop) raw.stop = { pct: stop, trailing: document.getElementById('pb-trail').value === '1' };
    const take = numOf('pb-take'); if (take) raw.take = { pct: take, sellPct: numOf('pb-takesell') || 100 };
    const dip = numOf('pb-dip'); if (dip) raw.dip = { drop: dip, deployPct: numOf('pb-dipuse') || 50 };
    const st = document.getElementById('pb-rstage').value;
    if (st) raw.rules = [{ stage: Number(st), when: document.getElementById('pb-rwhen').value, act: document.getElementById('pb-ract').value, pct: numOf('pb-rpct') || 30 }];
    const p = MarketSim.validatePolicy(raw);
    if (!p.now && !p.stop && !p.take && !p.dip && !p.rules) { showToast('Chính sách chưa có hành động nào: điền ít nhất một ô.', 'error'); return; }
    addPolicy(p);
}
function addPolicy(p) {
    if (SIM.customPolicies.length >= 8) SIM.customPolicies.shift();
    SIM.customPolicies.push(p);
    if (SIM.selected.length >= 10) SIM.selected.splice(1, 1);
    SIM.selected.push(p.id); simSave();
    showToast('Đã thêm "' + p.label + '".');
}
function simPlanFromNode(nodeId, act, pct) {
    const stage = nodeId.length, word = pathWords(nodeId);
    const p = MarketSim.validatePolicy({ id: 'n' + nodeId + act + Date.now().toString(36).slice(-3), label: 'Nếu ' + word + ' thì ' + (act === 'sell' ? 'bán ' + pct + '%' : 'mua ' + pct + '% tiền'), rules: [{ stage: stage, when: ['down', 'flat', 'up'][+nodeId[stage - 1]], act: act, pct: pct, path: nodeId }] });
    addPolicy(p);
    location.hash = '#portfolio'; simRun();
}

// ---------- giả định ----------
function simSettingsChanged() {
    const s = SIM.settings, val = (id) => document.getElementById(id);
    const clamp = (v, lo, hi, d) => { const n = Number(String(v).replace(',', '.')); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    s.paths = clamp(val('st-paths').value, 500, 30000, 10000); s.model = ['blend', 'garch', 'hmm'].indexOf(val('st-model').value) !== -1 ? val('st-model').value : 'blend';
    s.drift = clamp(val('st-drift').value, -20, 30, 9); s.riskAversion = clamp(val('st-gamma').value, 1, 10, 3); s.target = clamp(val('st-target').value, 1, 200, 10);
    s.fee = clamp(val('st-fee').value, 0, 2, 0.15); s.tax = clamp(val('st-tax').value, 0, 2, 0.1); s.participation = clamp(val('st-part').value, 1, 100, 20);
    s.seed = Math.round(clamp(val('st-seed').value, 1, 2147483647, 20261009)); s.useFair = !!val('st-fair').checked;
    simSave();
}

// ---------- chạy mô phỏng ----------
function expectedFromFair(price, fair, drift) {          // cùng công thức với PortfolioOptimizer.expectedFromFair: khoảng cách giá đóng dần trong 2 năm, co một nửa về mức chung, chặn [-30%, +40%]
    if (!(price > 0 && fair > 0)) return null;
    const own = Math.pow(fair / price, 1 / 2) - 1;
    return Math.max(-0.3, Math.min(0.4, 0.5 * own + 0.5 * drift));
}
async function simRun() {
    if (SIM.run.state === 'running') return;
    if (SIM.bookState !== 'ok' || !SIM.book) { if (SIM.bookState !== 'loading') simLoadBook(); return; }
    const t0 = Date.now();
    SIM.run = Object.assign({}, SIM.run, { state: 'running', error: '', step: 'Đang lấy lịch sử giá và ước lượng mô hình cho từng mã…' }); render();
    try {
        const book = SIM.book, syms = book.positions.map((p) => p.symbol).filter((s) => s !== MarketSim.INDEX);
        let expected = null;
        if (SIM.settings.useFair && syms.length) {
            SIM.run.step = 'Đang tải giá trị hợp lý đã lưu…'; render();
            try {
                const vb = await simCall('getVbLatestMany', { symbols: syms }); expected = {};
                book.positions.forEach((x) => { const v = vb && vb[x.symbol]; const e = v ? expectedFromFair(x.price, Number(v.fair_base), Number(SIM.settings.drift) / 100) : null; if (e !== null) expected[x.symbol] = e; });
            } catch (e) { expected = null; }
        }
        SIM.run.step = 'Đang mô phỏng ' + Number(SIM.settings.paths).toLocaleString('vi-VN') + ' đường × ' + SIM.selected.length + ' cách xử lý…'; render();
        const all = MarketSim.PRESETS.concat(SIM.customPolicies), pols = SIM.selected.map((id) => all.find((x) => x.id === id)).filter(Boolean);
        const result = await withModel(syms, () => SimWorker.call('simulate', { book: { cash: book.cash, debt: book.debt, positions: book.positions }, policies: pols, opts: simOpts({ expected: expected }) }));
        if (!result || !result.ok) throw new Error(result && result.reason === 'nav' ? 'Giá trị ròng của danh mục không dương: không mô phỏng được.' : 'Mô phỏng không chạy được.');
        result.expectedUsed = expected ? Object.keys(expected).length : 0;
        SIM.run = Object.assign({}, SIM.run, { state: 'ok', result: result, error: '', ms: Date.now() - t0, sel: SIM.run.sel });
        SIM.treePath = '';
        if (SIM.market.state === 'idle' || SIM.market.state === 'error') simLoadMarket();
    } catch (e) { SIM.run = Object.assign({}, SIM.run, { state: 'error', error: e.message || String(e) }); }
    if (SIM.view === 'portfolio' || SIM.view === 'tree') render();
}
function simSetHorizon(i) { SIM.run.hk = i; render(); }
function simSelectPolicy(id) { SIM.run.sel = id; render(); }
function simTreeSelect(id) { SIM.treePath = SIM.treePath === id ? id.slice(0, -1) : id; render(); }

// ---------- kiểm chứng ----------
async function simRunBacktest() {
    if (SIM.validate.state === 'running' || SIM.market.state !== 'ok') return;
    SIM.validate = { state: 'running', result: null, error: '' }; render();
    try {
        const r = await withModel([], () => SimWorker.call('backtest', { opts: { paths: 1000, step: 10, refitEvery: 63, drift: Number(SIM.settings.drift) / 100, horizons: [5, 21, 63], bands: SIM.settings.bands } }));
        if (!r || !r.ok) throw new Error(r && r.reason === 'short' ? 'Chưa đủ lịch sử để kiểm chứng (cần ' + r.need + ' phiên, có ' + r.have + ').' : 'Không kiểm chứng được.');
        SIM.validate = { state: 'ok', result: r, error: '' };
    } catch (e) { SIM.validate = { state: 'error', result: null, error: e.message || String(e) }; }
    if (SIM.view === 'validate') render();
}

// ---------- khởi động ----------
document.addEventListener('DOMContentLoaded', async function () {
    applyThemeIcon();
    if (typeof BenchNav !== 'undefined') BenchNav.mount({ bench: 'simulation', active: 'outlook' });
    simRestore();
    window.addEventListener('hashchange', route);
    if (typeof sbClient !== 'undefined' && sbClient) {
        try { await sbClient.auth.getSession(); const { data } = await sbClient.auth.getUser(); SIM.email = data && data.user ? data.user.email : null; } catch (e) { /* chưa đăng nhập: dải báo phiên của api.js lo */ }
    }
    route();
    simLoadMarket();
});
