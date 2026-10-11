/* --- FILE: /insight/insight-app.js ---
   Trang Insight: định tuyến theo #tab, tải dữ liệu từng tab (qua callGAS), gọi các thư viện tính toán thuần rồi dựng HTML bằng insight-views-*.js.
   Mỗi tab tải lười (lần đầu mở) và có nút "Tải lại"; lỗi của một tab không ảnh hưởng tab khác. Chọn lựa của người dùng (đối tượng, tỷ lệ, tầm nhìn...) được nhớ trong localStorage (có thể bị chặn: bọc try/catch). */
'use strict';
const INS = {
    view: 'thesis', email: null, me: null,
    liq: { state: 'idle', subject: 'mine', rate: 0.2, exitDays: 5, pipeValue: null, pipeDefault: null, raw: null, res: null, pipe: null, holdingsN: 0 },
    cash: { state: 'idle', params: { weeks: 13, buffer: '', debtRate: '' }, plan: [], inputs: null, cashNow: 0, debt: 0, orders: [], res: null, KINDS: null },
    rot: { state: 'idle', res: null, lines: [] },
    th: { state: 'idle', scope: 'mine', data: null, ctx: null, items: [], logRows: [], formIdea: null, form: null, suggestions: {}, snapshotDate: null, me: null, now: Date.now() },
    own: { state: 'idle', rows: [], sel: null, detail: null, detailState: 'idle', lookup: '', syncing: false, now: Date.now(), today: InsUtil.today(), tracked: [], held: [] },
    acc: { state: 'idle', hk: 'm6', val: null, ideas: null, decisions: null, earn: null, forecastForm: null, lastDate: null, step: '' },
    arch: { state: 'idle', status: null, cov: null, ready: null, lookup: {}, screen: { pe: '15', roe: '15', mcap: '1000' }, screenRes: null, defaultDate: '' },
};
const TABS = { thesis: 'th', liquidity: 'liq', cash: 'cash', ownership: 'own', rotation: 'rot', accuracy: 'acc', archive: 'arch' };
const LOADERS = {};
const I = InsUtil;

// ---------- tiện ích ----------
async function insCall(action, params) {
    const r = await callGAS(action, params || {});
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
}
function setStatus(text) { const el = document.getElementById('ins-status'); if (el) el.innerHTML = text; }
function applyThemeIcon() { const ic = document.getElementById('theme-ic'); if (ic) ic.className = document.documentElement.getAttribute('data-theme') === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon'; }
function toggleDeskTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (dark) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('user-theme', dark ? 'light' : 'dark'); } catch (e) { /* bị chặn */ }
    applyThemeIcon();
}
function showToast(message, type) {
    if (typeof window.showToast === 'function' && window.showToast !== showToast) { window.showToast(message, type); return; }
    let el = document.getElementById('ins-toast');
    if (!el) { el = document.createElement('div'); el.id = 'ins-toast'; el.setAttribute('role', 'status'); el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;padding:10px 16px;border-radius:8px;font-size:.84rem;font-weight:600;box-shadow:0 6px 18px rgba(0,0,0,.2);max-width:90vw'; document.body.appendChild(el); }
    el.textContent = message; el.style.background = type === 'error' ? 'var(--danger-color)' : 'var(--card-bg-elevated, #222)'; el.style.color = type === 'error' ? '#fff' : 'var(--text-primary)'; el.style.border = '1px solid var(--border-strong)'; el.style.display = 'block';
    clearTimeout(el._t); el._t = setTimeout(function () { el.style.display = 'none'; }, 4200);
}
function savePrefs() {
    try { localStorage.setItem('ins-prefs', JSON.stringify({ liqSubject: INS.liq.subject, liqRate: INS.liq.rate, liqExit: INS.liq.exitDays, weeks: INS.cash.params.weeks, debtRate: INS.cash.params.debtRate, buffer: INS.cash.params.buffer, scope: INS.th.scope, hk: INS.acc.hk })); } catch (e) { /* bị chặn */ }
}
function restorePrefs() {
    try {
        const p = JSON.parse(localStorage.getItem('ins-prefs') || '{}');
        if (p.liqSubject === 'mine' || p.liqSubject === 'group') INS.liq.subject = p.liqSubject;
        if ([0.1, 0.2, 0.3].indexOf(p.liqRate) !== -1) INS.liq.rate = p.liqRate;
        if ([3, 5, 10].indexOf(p.liqExit) !== -1) INS.liq.exitDays = p.liqExit;
        if ([8, 13, 26].indexOf(p.weeks) !== -1) INS.cash.params.weeks = p.weeks;
        if (typeof p.debtRate === 'string') INS.cash.params.debtRate = p.debtRate;
        if (typeof p.buffer === 'string') INS.cash.params.buffer = p.buffer;
        if (p.scope === 'mine' || p.scope === 'all') INS.th.scope = p.scope;
        if (['m3', 'm6', 'm12'].indexOf(p.hk) !== -1) INS.acc.hk = p.hk;
    } catch (e) { /* chưa có hoặc bị chặn */ }
}
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
const isoDaysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

// ---------- vẽ và định tuyến ----------
function html() {
    switch (INS.view) {
        case 'liquidity': return InsViewsA.liquidityHtml(INS.liq);
        case 'cash': return InsViewsA.cashHtml(Object.assign({}, INS.cash, { cash: INS.cash.cashNow, KINDS: CashflowCalc.KINDS }));
        case 'rotation': return InsViewsA.rotationHtml(INS.rot);
        case 'ownership': return InsViewsB.ownershipHtml(INS.own);
        case 'accuracy': return InsViewsC.accuracyHtml(INS.acc);
        case 'archive': return InsViewsC.archiveHtml(INS.arch);
        default: return InsViewsB.thesisHtml(INS.th);
    }
}
function render() {
    const root = document.getElementById('ins-root');
    if (!root) return;
    try { root.innerHTML = html(); } catch (e) { console.error(e); root.innerHTML = I.card('triangle-exclamation', 'Không dựng được màn hình', I.empty('triangle-exclamation', I.esc(e.message || String(e)))); }
}
function route() {
    const h = String(location.hash || '').replace('#', '');
    INS.view = TABS[h] ? h : 'thesis';
    if (typeof BenchNav !== 'undefined') BenchNav.setActive(INS.view);
    const S = INS[TABS[INS.view]];
    if (S.state === 'idle') insLoad(INS.view); else render();
}
function insLoad(view, force) {
    const S = INS[TABS[view]];
    if (S.state === 'loading') return Promise.resolve();
    if (S.state === 'ok' && !force) { if (INS.view === view) render(); return Promise.resolve(); }
    S.state = 'loading'; if (INS.view === view) render();
    setStatus('<i class="fa-solid fa-spinner fa-spin"></i> Đang tải');
    return Promise.resolve().then(() => LOADERS[view](!!force)).then(() => { S.state = 'ok'; setStatus(''); })
        .catch((e) => { console.error(e); S.state = 'error'; S.error = e.message || String(e); setStatus(''); })
        .then(() => { if (INS.view === view) render(); });
}

// ---------- Thanh khoản ----------
LOADERS.liquidity = async function () {
    const S = INS.liq;
    let positions, cash = 0;
    if (S.subject === 'mine') {
        const [hold, cd] = await Promise.all([insCall('getHoldingsView', { email: INS.email }), insCall('getCashDebt', { email: INS.email })]);
        positions = (hold || []).filter((h) => Number(h.quantity) > 0).map((h) => ({ symbol: h.symbol, quantity: Number(h.quantity), price: Number(h.marketPrice) || 0 }));
        cash = cd.cash || 0;
    } else {
        const data = await insCall('getGroupData');
        const g = GroupCalc.consolidate(GroupCalc.memberPortfolios(data));
        positions = g.symbols.filter((s) => s.quantity > 0).map((s) => ({ symbol: s.symbol, quantity: s.quantity, price: s.price || 0 }));
        cash = g.cash || 0;
    }
    S.holdingsN = positions.length;
    // ứng viên: mã theo dõi và ý tưởng mở chưa giữ
    const held = new Set(positions.map((p) => p.symbol));
    let cand = [];
    try {
        const [wl, ideas] = await Promise.all([insCall('getWatchlist', { email: INS.email }).catch(() => []), insCall('listIdeas').catch(() => ({ ideas: [] }))]);
        const fromIdeas = ((ideas && ideas.ideas) || []).filter((i) => ['approved', 'in_portfolio', 'review', 'research', 'idea'].indexOf(i.status) !== -1 && i.direction !== 'avoid').map((i) => i.symbol);
        cand = [...new Set((wl || []).map((x) => String(x.symbol || '').toUpperCase()).concat(fromIdeas.map((x) => String(x).toUpperCase())).filter((s) => /^[A-Z0-9]{1,12}$/.test(s) && !held.has(s)))].slice(0, 15);
    } catch (e) { cand = []; }
    const all = positions.map((p) => p.symbol).concat(cand).slice(0, 60);
    let vols = {}, hist = {}, note = '';
    if (all.length) {
        const [v, ph] = await Promise.all([insCall('getVolumeHistory', { symbols: all, days: 90 }).catch((e) => { note = e.message; return {}; }), insCall('getPriceHistories', { symbols: all, from: isoDaysAgo(130) }).catch(() => ({ histories: {} }))]);
        vols = v || {}; hist = (ph && ph.histories) || {};
    }
    const lastPx = (s) => { const h = hist[s] || []; return h.length ? Number(h[h.length - 1][1]) : 0; };
    positions.forEach((p) => { if (!(p.price > 0)) p.price = lastPx(p.symbol); });
    const nav = positions.reduce((s, p) => s + p.quantity * p.price, 0) + cash;
    S.raw = { positions: positions, cand: cand.map((s) => ({ symbol: s, price: lastPx(s) })).filter((c) => c.price > 0), vols: vols, hist: hist, nav: nav, volumeNote: note };
    S.pipeDefault = Math.round(nav * 0.05 / 1e6) * 1e6 || null;
    if (S.pipeValue === null) S.pipeValue = S.pipeDefault;
    liqCompute();
};
function liqCompute() {
    const S = INS.liq, R = S.raw;
    if (!R) return;
    const o = { rate: S.rate, exitDays: S.exitDays, maxDays: Math.max(10, S.exitDays * 2) };
    S.res = LiquidityCalc.analyze(R.positions.map((p) => ({ symbol: p.symbol, quantity: p.quantity, price: p.price })), R.vols, R.hist, o);
    S.pipe = R.cand.length && S.pipeValue > 0 ? LiquidityCalc.pipeline(R.cand.map((c) => ({ symbol: c.symbol, price: c.price, value: S.pipeValue })), R.vols, R.hist, o) : [];
}
function insLiq(k, v) {
    const S = INS.liq;
    if (k === 'subject') { if (S.subject === v) return; S.subject = v; S.state = 'idle'; S.res = null; savePrefs(); insLoad('liquidity', true); return; }
    if (k === 'rate') S.rate = Number(v);
    else if (k === 'exitDays') S.exitDays = Number(v);
    else if (k === 'pipeValue') S.pipeValue = num(v) > 0 ? num(v) : S.pipeDefault;
    savePrefs(); liqCompute(); render();
}

// ---------- Dòng tiền ----------
function planKey() { return 'ins-cash-plan:' + (INS.email || ''); }
function planLoad() { try { INS.cash.plan = JSON.parse(localStorage.getItem(planKey()) || '[]').filter((p) => p && p.id && p.date && p.amount > 0); } catch (e) { INS.cash.plan = []; } }
function planSave() { try { localStorage.setItem(planKey(), JSON.stringify(INS.cash.plan)); } catch (e) { showToast('Không lưu được kế hoạch trên máy này (trình duyệt chặn lưu trữ).', 'error'); } }
LOADERS.cash = async function () {
    const S = INS.cash;
    planLoad();
    const [inp, cd, orders] = await Promise.all([insCall('getCalendarInputs', { email: INS.email }), insCall('getCashDebt', { email: INS.email }), insCall('listOrderRequests', { email: INS.email, limit: 100 }).catch(() => [])]);
    S.inputs = inp; S.cashNow = cd.cash || 0; S.debt = cd.debt || 0; S.orders = orders || [];
    cashCompute();
};
function cashCompute() {
    const S = INS.cash, inp = S.inputs; if (!inp) return;
    const ctx = { today: inp.today, txns: inp.txns, actions: inp.actions, cashFlows: inp.cashFlows, dismissed: inp.dismissed };
    const qty = {}; inp.holdings.forEach((h) => { qty[h.symbol] = h.quantity; });
    const fc = CalendarCalc.dividendForecast(inp.events, ctx, qty, 9);
    const un = VnMarket.unsettled(inp.txns, inp.today);
    const planned = CashflowCalc.plannedFromOrders(S.orders, inp.today).concat(S.plan.map((p) => ({ id: p.id, date: p.date, kind: p.kind, symbol: p.symbol || null, amount: p.amount, note: p.note || '', source: 'plan' })));
    S.res = CashflowCalc.build({ today: inp.today, cash: S.cashNow, debt: S.debt, debtRate: num(S.params.debtRate), buffer: num(S.params.buffer), weeks: S.params.weeks, dividends: fc.items.map((i) => ({ date: i.date, symbol: i.symbol, amount: i.amount, kind: i.kind })), pendingSells: un.sellCash, planned: planned });
}
function insCash(k, v) {
    const P = INS.cash.params;
    if (k === 'weeks') P.weeks = Number(v); else if (k === 'buffer') P.buffer = String(v || '').replace(/[^\d]/g, ''); else if (k === 'debtRate') P.debtRate = String(v || '').replace(/[^\d.,]/g, '');
    savePrefs(); cashCompute(); render();
}
function insCashAdd() {
    const g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const amount = num(g('ins-cp-amount').replace(/[^\d.,]/g, '')), date = g('ins-cp-date'), kind = g('ins-cp-kind');
    if (!(amount > 0)) { showToast('Nhập số tiền lớn hơn 0.', 'error'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showToast('Chọn ngày.', 'error'); return; }
    const sym = g('ins-cp-symbol').trim().toUpperCase();
    INS.cash.plan.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind: kind, date: date, amount: amount, symbol: /^[A-Z0-9]{1,12}$/.test(sym) ? sym : null, note: g('ins-cp-note').trim().slice(0, 80) });
    planSave(); cashCompute(); render();
}
function insCashDel(id) { INS.cash.plan = INS.cash.plan.filter((p) => p.id !== id); planSave(); cashCompute(); render(); }

// ---------- Luân chuyển ngành ----------
LOADERS.rotation = async function () {
    const S = INS.rot;
    const series = await insCall('getSectorIndices', { from: isoDaysAgo(1100) });
    const names = {}; (MarketOverview.SECTOR_INDICES || []).forEach((x) => { names[x.code] = x.label; });
    S.res = SectorRotation.analyze(series, 'VNINDEX', names);
    S.lines = SectorRotation.narrate(S.res);
};

// ---------- Luận điểm ----------
function thesisCtx(idea, C) {
    const sym = String(idea.symbol).toUpperCase(), m = (C.snapshots || {})[sym] || null;
    const price = m && Number(m.marketcap) > 0 && Number(m.shares) > 0 ? Math.round(Number(m.marketcap) / Number(m.shares)) : null;
    const rt = (C.ratios || {})[sym];
    const synced = (C.synced || []).indexOf(sym) !== -1;
    const trades = ((C.insider || {})[sym] || []).map((t) => ({ id: t.id, trader: t.trader, action: t.action, status: t.status, before: t.shares_before === null ? null : Number(t.shares_before), after: t.shares_after === null ? null : Number(t.shares_after), registered: t.registered === null ? null : Number(t.registered), acquired: t.acquired === null ? null : Number(t.acquired), endDate: t.end_date, publicDate: t.public_date }));
    return { metrics: m, price: price, targetPrice: idea.target_price === null ? null : Number(idea.target_price), foreignRoomLeftPct: rt && rt.foreignRoomLeftPct !== undefined ? rt.foreignRoomLeftPct : null, insiderNet90d: synced ? OwnershipCalc.summarize(trades, I.today(), 90).netQty : null };
}
LOADERS.thesis = async function () {
    const S = INS.th;
    const [data, me] = await Promise.all([insCall('listThesis'), INS.me ? Promise.resolve(INS.me) : insCall('getLimitActor', { email: INS.email }).catch(() => null)]);
    INS.me = me; S.me = me; S.data = data;
    S.ctx = await insCall('getThesisContext', { symbols: data.ideas.map((i) => i.symbol) }).catch(() => ({ snapshots: {}, ratios: {}, insider: {}, synced: [], snapshotDate: null }));
    S.snapshotDate = S.ctx.snapshotDate; S.now = Date.now();
    thesisCompute();
};
function thesisCompute() {
    const S = INS.th, D = S.data; if (!D) return;
    const byIdea = {}; D.conditions.forEach((c) => { (byIdea[c.idea_id] = byIdea[c.idea_id] || []).push(c); });
    const myId = S.me ? S.me.actorId : null;
    let ideas = D.ideas.filter((i) => S.scope === 'all' || (myId && i.user_id === myId));
    S.items = ideas.map((idea) => {
        const conds = (byIdea[idea.id] || []).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).map((c) => ({ id: c.id, metric: c.metric, op: c.op, threshold: c.threshold === null ? null : Number(c.threshold), severity: c.severity, label: c.label, manualMet: c.manual_met, last_checked: c.last_checked, state_since: c.state_since, last_state: c.last_state }));
        return { idea: idea, ev: ThesisCalc.evaluateIdea(conds, thesisCtx(idea, S.ctx)) };
    }).sort((a, b) => (ThesisCalc.STATUS[a.ev.status].order - ThesisCalc.STATUS[b.ev.status].order) || (a.idea.updated_at < b.idea.updated_at ? 1 : -1));
    const ideaOf = {}; D.ideas.forEach((i) => { ideaOf[i.id] = i; });
    const condOf = {}; D.conditions.forEach((c) => { condOf[c.id] = c; });
    S.logRows = D.log.filter((l) => ideaOf[l.idea_id] && condOf[l.condition_id]).slice(0, 25).map((l) => ({ at: l.at, symbol: ideaOf[l.idea_id].symbol, text: ThesisCalc.describe({ metric: condOf[l.condition_id].metric, op: condOf[l.condition_id].op, threshold: condOf[l.condition_id].threshold, label: condOf[l.condition_id].label }), from: l.from_state, to: l.to_state }));
}
function insThesisScope(s) { INS.th.scope = s; savePrefs(); thesisCompute(); render(); }
function insThesisForm(ideaId) {
    const S = INS.th;
    S.formIdea = ideaId; S.form = null;
    if (ideaId) {
        const idea = S.data.ideas.find((i) => i.id === ideaId);
        const have = {}; S.data.conditions.filter((c) => c.idea_id === ideaId).forEach((c) => { have[c.metric + c.op] = 1; });
        S.suggestions[ideaId] = idea ? ThesisCalc.suggest({ stop: idea.stop_price, target: idea.target_price }, thesisCtx(idea, S.ctx)).filter((s) => !have[s.metric + s.op]) : [];
    }
    render();
}
function insThesisFormMetric(metric) {
    const S = INS.th, g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    S.form = { metric: metric, op: g('ins-cf-op') || '>=', threshold: g('ins-cf-th'), severity: g('ins-cf-sev') || 'watch', label: g('ins-cf-label') };
    render();
}
function insThesisSuggest(ideaId, i) { const s = (INS.th.suggestions[ideaId] || [])[i]; if (!s) return; INS.th.form = { metric: s.metric, op: s.op, threshold: String(s.threshold), severity: s.severity, label: s.label }; render(); }
async function insThesisSave(ideaId) {
    const g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const metric = g('ins-cf-metric');
    const input = { ideaId: ideaId, metric: metric, op: g('ins-cf-op') || '>=', threshold: g('ins-cf-th').replace(',', '.'), severity: g('ins-cf-sev'), label: g('ins-cf-label'), manualMet: null };
    const v = ThesisCalc.validate(input);
    if (!v.ok) { showToast(v.error, 'error'); return; }
    try { const msg = await insCall('saveThesisCondition', { email: INS.email, condition: input }); showToast(msg); INS.th.formIdea = null; INS.th.form = null; await thesisReload(); } catch (e) { showToast(e.message || String(e), 'error'); }
}
async function thesisReload() { INS.th.state = 'idle'; await insLoad('thesis', true); }
async function insThesisDel(id) { if (!confirm('Xoá điều kiện này khỏi luận điểm?')) return; try { await insCall('deleteThesisCondition', { email: INS.email, id: id }); await thesisReload(); } catch (e) { showToast(e.message || String(e), 'error'); } }
async function insThesisManual(id, met) { try { await insCall('setThesisManual', { email: INS.email, id: id, met: met }); await thesisReload(); } catch (e) { showToast(e.message || String(e), 'error'); } }

// ---------- Sở hữu ----------
LOADERS.ownership = async function () {
    const S = INS.own;
    S.today = I.today(); S.now = Date.now();
    const [hold, wl] = await Promise.all([insCall('getHoldingsView', { email: INS.email }).catch(() => []), insCall('getWatchlist', { email: INS.email }).catch(() => [])]);
    S.held = (hold || []).filter((h) => Number(h.quantity) > 0).map((h) => String(h.symbol).toUpperCase());
    const w = (wl || []).map((x) => String(x.symbol || '').toUpperCase());
    S.tracked = [...new Set(S.held.concat(w).filter((s) => /^[A-Z0-9]{1,12}$/.test(s)))].slice(0, 60);
    S.ov = await insCall('getOwnershipOverview', { symbols: S.tracked });
    ownCompute();
    if (S.sel) await ownLoadDetail(S.sel);
};
function ownCompute() {
    const S = INS.own, ov = S.ov; if (!ov) return;
    const bySym = {}; ov.trades.forEach((t) => { (bySym[t.symbol] = bySym[t.symbol] || []).push({ id: t.id, trader: t.trader, action: t.action, status: t.status, before: t.shares_before === null ? null : Number(t.shares_before), after: t.shares_after === null ? null : Number(t.shares_after), registered: t.registered === null ? null : Number(t.registered), acquired: t.acquired === null ? null : Number(t.acquired), endDate: t.end_date, publicDate: t.public_date }); });
    const sync = {}; ov.sync.forEach((x) => { sync[x.symbol] = x; });
    S.rows = ov.symbols.map((sym) => {
        const room = ov.ratios[sym] && ov.ratios[sym].foreignRoomLeftPct !== undefined && ov.ratios[sym].foreignRoomLeftPct !== null ? Number(ov.ratios[sym].foreignRoomLeftPct) : null;
        const sy = sync[sym];
        return { symbol: sym, held: S.held.indexOf(sym) !== -1, room: room, band: OwnershipCalc.roomBand(room), synced: !!(sy && sy.ok), syncedAt: sy ? sy.synced_at : null, ins: OwnershipCalc.summarize(bySym[sym] || [], S.today, 90) };
    }).sort((a, b) => (b.held - a.held) || (Math.abs(b.ins.netQty) - Math.abs(a.ins.netQty)) || (a.symbol < b.symbol ? -1 : 1));
}
async function ownLoadDetail(sym) {
    const S = INS.own; S.detailState = 'loading'; render();
    try { S.detail = await insCall('getOwnership', { symbol: sym }); S.detailState = 'ok'; } catch (e) { S.detail = null; S.detailState = 'error'; showToast(e.message || String(e), 'error'); }
    render();
}
async function insOwnSelect(raw) {
    const sym = String(raw || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(sym)) { showToast('Nhập mã cổ phiếu hợp lệ (vd FPT).', 'error'); return; }
    INS.own.sel = sym; INS.own.lookup = sym; await ownLoadDetail(sym);
}
async function insOwnSync(sym) {
    const S = INS.own;
    setStatus('<i class="fa-solid fa-spinner fa-spin"></i> Đang đồng bộ ' + I.esc(sym));
    try {
        const r = await insCall('syncOwnership', { symbols: [sym] });
        showToast(r.synced ? 'Đã đồng bộ ' + sym + ': ' + r.holders + ' cổ đông, ' + r.trades + ' giao dịch nội bộ.' : (r.skipped ? sym + ' vừa được đồng bộ trong 60 phút qua.' : 'Nguồn không trả dữ liệu cho ' + sym + '.'), r.synced || r.skipped ? undefined : 'error');
        S.ov = await insCall('getOwnershipOverview', { symbols: S.tracked.indexOf(sym) === -1 ? S.tracked.concat([sym]) : S.tracked }); if (S.tracked.indexOf(sym) === -1 && S.sel === sym) S.tracked = S.tracked.concat([sym]);
        S.today = I.today(); S.now = Date.now(); ownCompute(); await ownLoadDetail(sym);
    } catch (e) { showToast(e.message || String(e), 'error'); }
    setStatus('');
}
async function insOwnSyncAll() {
    const S = INS.own; if (S.syncing) return;
    const stale = S.rows.filter((r) => !r.synced || !r.syncedAt || Date.now() - Date.parse(r.syncedAt) > 24 * 3600000).map((r) => r.symbol);
    if (!stale.length) { showToast('Mọi mã đã được đồng bộ trong 24 giờ qua.'); return; }
    S.syncing = true; render();
    let done = 0, failed = 0;
    try {
        for (let i = 0; i < stale.length; i += 10) {
            setStatus('<i class="fa-solid fa-spinner fa-spin"></i> Đồng bộ ' + Math.min(i + 10, stale.length) + '/' + stale.length);
            try { const r = await insCall('syncOwnership', { symbols: stale.slice(i, i + 10) }); done += r.synced || 0; failed += r.failed || 0; } catch (e) { failed += Math.min(10, stale.length - i); }
        }
        S.ov = await insCall('getOwnershipOverview', { symbols: S.tracked }); S.today = I.today(); S.now = Date.now(); ownCompute();
        showToast('Đã đồng bộ ' + done + ' mã' + (failed ? ', ' + failed + ' mã lỗi' : '') + '.', failed && !done ? 'error' : undefined);
    } finally { S.syncing = false; setStatus(''); render(); }
}

// ---------- Độ chính xác ----------
LOADERS.accuracy = async function () {
    const S = INS.acc;
    S.step = 'Đang tải dự phóng đã lưu…';
    const inp = await insCall('getAccuracyInputs');
    if (!INS.me) INS.me = await insCall('getLimitActor', { email: INS.email }).catch(() => null);
    const sIdeas = inp.ideas.filter((i) => ['approved', 'in_portfolio', 'closed'].indexOf(i.status) !== -1);
    const items = { v: inp.valuations, i: sIdeas, d: inp.decisions.filter((d) => ['buy', 'sell', 'hold', 'skip'].indexOf(d.action) !== -1) };
    // mã cần giá: mới nhất trước, tối đa 40
    const dated = []; items.v.forEach((x) => dated.push([x.symbol, x.as_of])); items.i.forEach((x) => dated.push([x.symbol, String(x.created_at).slice(0, 10)])); items.d.forEach((x) => dated.push([x.symbol, x.decided_at]));
    dated.sort((a, b) => (a[1] < b[1] ? 1 : -1));
    const symbols = [...new Set(dated.map((x) => String(x[0]).toUpperCase()))].slice(0, 40);
    const from = dated.length ? dated.reduce((m, x) => (x[1] < m ? x[1] : m), dated[0][1]) : null;
    let fwd = { histories: {}, events: [], error: null };
    if (symbols.length && from) { S.step = 'Đang lấy giá lịch sử của ' + symbols.length + ' mã…'; render(); fwd = await insCall('getForwardInputs', { symbols: symbols, from: new Date(Date.parse(from) - 7 * 86400000).toISOString().slice(0, 10) }); }
    const adj = {}; symbols.forEach((s) => { if ((fwd.histories[s] || []).length) adj[s] = RiskCalc.adjustSeries(fwd.histories[s], fwd.events || [], s); });
    const bench = (fwd.histories || {}).VNINDEX ? RiskCalc.adjustSeries(fwd.histories.VNINDEX, [], 'VNINDEX') : [];
    S.lastDate = bench.length ? bench[bench.length - 1][0] : null; S.pricedSymbols = Object.keys(adj).length; S.missingPrices = symbols.filter((s) => !adj[s]);
    S.raw = { inp: inp, items: items, adj: adj, bench: bench };
    // dự phóng lợi nhuận: cần báo cáo thật
    S.step = 'Đang đối chiếu dự phóng lợi nhuận với báo cáo…';
    const fSyms = [...new Set(inp.forecasts.map((f) => f.symbol))].slice(0, 20);
    let act = { results: {}, errors: {} };
    if (fSyms.length) act = await insCall('getForecastActuals', { symbols: fSyms }).catch(() => ({ results: {}, errors: {} }));
    S.raw.actuals = act;
    accCompute();
};
function accCompute() {
    const S = INS.acc, R = S.raw; if (!R) return;
    const today = I.today(), name = (id) => R.inp.members[id] || '—';
    const FA = ForecastAccuracy;
    // 1) giá trị hợp lý
    const vScored = R.items.v.map((x) => FA.scoreValuation({ id: x.id, symbol: x.symbol, asOf: x.as_of, price: x.price, fairLow: x.fair_low, fairBase: x.fair_base, fairHigh: x.fair_high, userId: x.user_id, methods: (x.methods || []).map((m) => ({ key: m.key || m.id || m.name, name: m.name || m.label || m.key, base: m.base !== undefined ? m.base : (m.mid !== undefined ? m.mid : null) })) }, R.adj[x.symbol] || [], R.bench, today));
    const summaries = {}; FA.HORIZONS.forEach((h) => { summaries[h.key] = FA.summarizeValuations(vScored, h.key); });
    const authors = FA.groupBy(vScored.filter((s) => s.scorable && s.horizons[S.hk]), (s) => s.userId).map((g) => { const sm = FA.summarizeValuations(g.items, S.hk); return { name: name(g.group), n: sm.n, errMedian: sm.errMedian, direction: sm.direction }; }).sort((a, b) => b.n - a.n);
    const firstDue = {}; FA.HORIZONS.forEach((h) => { const d = R.items.v.map((x) => FA.addMonths(x.as_of, h.months)).filter((x) => x > today).sort()[0]; firstDue[h.key] = d || null; });
    S.val = { total: R.items.v.length, scorable: vScored.filter((s) => s.scorable).length, summaries: summaries, methods: FA.summarizeMethods(vScored), authors: authors, firstDue: firstDue };
    // 2) ý tưởng
    const iScored = R.items.i.map((x) => FA.scoreIdea({ id: x.id, symbol: x.symbol, direction: x.direction, status: x.status, entry: x.entry_price, target: x.target_price, stop: x.stop_price, horizonMonths: x.horizon_months, conviction: x.conviction, userId: x.user_id, startDate: String(x.created_at).slice(0, 10), closedAt: x.closed_at, closePrice: x.close_price, tags: x.tags }, R.adj[x.symbol] || [], R.bench, today));
    S.ideas = { total: R.items.i.length, summary: FA.summarizeOutcomes(iScored), calibration: FA.calibration(iScored, 'conviction'), firstDue: iScored.map((s) => s.pendingUntil).filter(Boolean).sort()[0] || null };
    // 3) quyết định
    const dScored = R.items.d.map((x) => FA.scoreDecision({ id: x.id, symbol: x.symbol, action: x.action, decidedAt: x.decided_at, priceAtDecision: x.price_at_decision, expected: x.expected_price, stop: x.stop_price, horizonMonths: x.horizon_months, confidence: x.confidence, userId: x.user_id, tags: x.tags }, R.adj[x.symbol] || [], R.bench, today));
    S.decisions = { total: R.items.d.length, summary: FA.summarizeOutcomes(dScored), calibration: FA.calibration(dScored, 'confidence'), firstDue: dScored.map((s) => s.pendingUntil).filter(Boolean).sort()[0] || null };
    // 4) dự phóng lợi nhuận
    const myId = INS.me ? INS.me.actorId : null, mgr = INS.me && (INS.me.isManager || INS.me.isAdmin);
    const eScored = R.inp.forecasts.map((f) => { const fin = R.actuals.results[f.symbol] || null; const sc = FA.scoreEarnings({ id: f.id, symbol: f.symbol, metric: f.metric, year: f.year, quarter: f.quarter, value: Number(f.value), userId: f.user_id }, fin); return Object.assign(sc, { madeAt: f.made_at, authorName: name(f.user_id), canDelete: mgr || f.user_id === myId, noData: !fin }); });
    S.earn = { rows: eScored, summary: FA.summarizeEarnings(eScored), forecastForm: S.forecastForm };
}
function insAcc(k, v) { if (k === 'hk') { INS.acc.hk = v; savePrefs(); accCompute(); render(); } }
async function insForecastAdd() {
    const g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const val = num(g('ins-fc-val'));
    if (val === null) { showToast('Nhập giá trị dự phóng (tỷ đồng).', 'error'); return; }
    const f = { symbol: g('ins-fc-sym'), metric: g('ins-fc-metric'), year: g('ins-fc-year'), quarter: g('ins-fc-q').trim(), value: val * 1e9, note: g('ins-fc-note') };
    try { const msg = await insCall('saveForecast', { email: INS.email, forecast: f }); showToast(msg); INS.acc.forecastForm = null; INS.acc.state = 'idle'; await insLoad('accuracy', true); } catch (e) { INS.acc.forecastForm = f; showToast(e.message || String(e), 'error'); }
}
async function insForecastDel(id) { if (!confirm('Xoá dự phóng này? Việc xoá sẽ làm mất một dự phóng đã ghi khỏi bảng chấm điểm.')) return; try { await insCall('deleteForecast', { email: INS.email, id: id }); INS.acc.state = 'idle'; await insLoad('accuracy', true); } catch (e) { showToast(e.message || String(e), 'error'); } }

// ---------- Kho dữ liệu ----------
LOADERS.archive = async function () {
    const S = INS.arch;
    S.status = await insCall('getPitStatus');
    S.cov = PitCalc.coverage(S.status.days, { isHoliday: (d) => VnHolidays.isHoliday(d), today: I.today() });
    S.ready = PitCalc.readiness(S.cov.days);
    S.defaultDate = S.cov.last || I.today();
};
async function insPitLookup() {
    const S = INS.arch, g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const date = g('ins-pit-date'), symbol = g('ins-pit-sym').trim().toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showToast('Chọn ngày.', 'error'); return; }
    S.lookup = { date: date, symbol: /^[A-Z0-9]{1,12}$/.test(symbol) ? symbol : '', state: 'loading' }; S.screenRes = null; render();
    try {
        const row = await insCall('getPitDay', { date: date });
        const day = row ? PitCalc.decodeDay(row) : null;
        const fund = day && S.lookup.symbol ? await insCall('getPitFundamentals', { symbol: S.lookup.symbol }).catch(() => []) : [];
        S.lookup = { date: date, symbol: S.lookup.symbol, state: 'ok', day: day, fund: fund };
    } catch (e) { S.lookup = { date: date, symbol: S.lookup.symbol, state: 'error', error: e.message || String(e) }; }
    render();
}
function insPitScreen() {
    const S = INS.arch, L = S.lookup, g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    if (!L || !L.day) return;
    S.screen = { pe: g('ins-sc-pe'), roe: g('ins-sc-roe'), mcap: g('ins-sc-mcap') };
    const pe = num(S.screen.pe), roe = num(S.screen.roe), mc = num(S.screen.mcap);
    const u = PitCalc.universeAsOf([L.day], L.date, (m) => (pe === null || (m.pe > 0 && m.pe <= pe)) && (roe === null || (m.roae !== null && m.roae * 100 >= roe)) && (mc === null || (m.marketcap !== null && m.marketcap >= mc * 1e9)), 400);
    u.rows.sort((a, b) => b.m.marketcap - a.m.marketcap);
    S.screenRes = { total: u.rows.length, rows: u.rows.slice(0, 30) };
    render();
}

// ---------- khởi động ----------
document.addEventListener('DOMContentLoaded', async function () {
    applyThemeIcon();
    restorePrefs();
    if (typeof BenchNav !== 'undefined') BenchNav.mount({ bench: 'insight', active: 'thesis' });
    window.addEventListener('hashchange', route);
    if (typeof sbClient !== 'undefined' && sbClient) {
        try { await sbClient.auth.getSession(); const { data } = await sbClient.auth.getUser(); INS.email = data && data.user ? data.user.email : null; } catch (e) { /* chưa đăng nhập: dải báo phiên của api.js lo */ }
    }
    route();
});
window.__INS = INS;
