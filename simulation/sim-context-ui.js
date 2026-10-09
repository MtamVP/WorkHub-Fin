/* --- FILE: /simulation/sim-context-ui.js ---
   Market Simulation, mục "Bối cảnh": lấy bối cảnh bằng AI (Edge Function market-news-ai, chế độ scenarios: AI đọc tin + trạng thái thị trường dạng số, trả SỰ KIỆN có cấu trúc
   và dẫn tin), hiện thành thẻ người dùng chỉnh được, và quy đổi thẻ đang bật thành cú sốc cho bộ máy mô phỏng (MarketSim.eventFromCard: độ lớn hiệu chỉnh theo lịch sử VN-Index).
   AI không đặt con số xác suất hay độ lớn: chỉ mức thô; người dùng chỉnh được mọi thứ. Thẻ và lựa chọn lưu trong trình duyệt (wh.sim.ctx.v1). */

const SIM_CTX_KEY = 'wh.sim.ctx.v1';
SIM.ctx = { state: 'idle', data: null, error: '', code: null, cards: [], use: true, cached: false, ageSec: 0 };

function ctxSave() {
    try { localStorage.setItem(SIM_CTX_KEY, JSON.stringify({ data: SIM.ctx.data, cards: SIM.ctx.cards, use: SIM.ctx.use })); } catch (e) { /* bỏ qua */ }
}
function ctxRestore() {
    try {
        const s = JSON.parse(localStorage.getItem(SIM_CTX_KEY) || 'null'); if (!s) return;
        if (Array.isArray(s.cards)) SIM.ctx.cards = s.cards.slice(0, 16).map(SimContext.normalizeCard);
        if (s.data && typeof s.data === 'object') { SIM.ctx.data = { summary: String(s.data.summary || '').slice(0, 400), model: String(s.data.model || '').slice(0, 60), generatedAt: s.data.generatedAt || null, itemCount: Number(s.data.itemCount) || 0, skipped: Array.isArray(s.data.skipped) ? s.data.skipped.slice(0, 10) : [] }; SIM.ctx.state = 'ok'; }
        SIM.ctx.use = s.use !== false;
    } catch (e) { /* mặc định */ }
}
// Sự kiện đưa vào bộ máy (rỗng nếu tắt bối cảnh hoặc chưa có thang độ lớn)
function ctxEvents() {
    if (!SIM.ctx.use || !SIM.market.model || !SIM.market.model.eventScale) return [];
    return SIM.ctx.cards.map((c) => MarketSim.eventFromCard(c, SIM.market.model.eventScale)).filter(Boolean);
}
const ctxKey = () => JSON.stringify(ctxEvents().map((e) => [e.id, e.p, e.win, e.sign, Math.round(e.jM * 1e5), Math.round(e.jS * 1e5), e.sectors]));

// ---------- lấy bối cảnh bằng AI ----------
async function ctxFetch() {
    if (SIM.ctx.state === 'loading') return;
    if (SIM.market.state !== 'ok') { showToast('Đợi mô hình thị trường dựng xong rồi lấy bối cảnh.', 'error'); return; }
    SIM.ctx.state = 'loading'; SIM.ctx.error = ''; SIM.ctx.code = null; if (SIM.view === 'context') render();
    try {
        if (typeof sbClient === 'undefined' || !sbClient) throw Object.assign(new Error('Chưa sẵn sàng'), { code: 'not_ready' });
        const state = SimContext.marketState(SIM.market.model, SIM.market.result);
        const r = await sbClient.functions.invoke('market-news-ai', { body: { mode: 'scenarios', state: state } });
        if (r.error) { let d = null; try { d = await r.error.context.json(); } catch (e) { /* không đọc được nội dung lỗi */ } throw Object.assign(new Error((d && d.error) || r.error.message || 'Lỗi'), { code: d && d.code }); }
        const d = r.data;
        if (!d || d.ok === false || !Array.isArray(d.events)) throw Object.assign(new Error((d && d.error) || 'Không lấy được bối cảnh'), { code: d && d.code });
        SIM.ctx.cards = SimContext.mergeAi(SIM.ctx.cards, d.events);
        SIM.ctx.data = { summary: d.summary || '', model: d.model || '', generatedAt: d.generatedAt || null, itemCount: d.itemCount || 0, skipped: d.skipped || [] };
        SIM.ctx.cached = !!d.cached; SIM.ctx.ageSec = Number(d.ageSec) || 0; SIM.ctx.state = 'ok';
        ctxSave(); ctxChanged();
    } catch (e) { SIM.ctx.state = 'error'; SIM.ctx.error = String(e && e.message ? e.message : e).slice(0, 200); SIM.ctx.code = e && e.code || null; }
    if (SIM.view === 'context') render();
}

// ---------- chỉnh thẻ ----------
function ctxFind(id) { return SIM.ctx.cards.find((c) => c.id === id); }
function ctxSet(id, field, value) {
    const c = ctxFind(id); if (!c) return;
    const pct = (v) => { const s = String(v).trim(); if (s === '') return null; const n = Number(s.replace(',', '.')); return isFinite(n) ? n / 100 : null; };
    if (field === 'prob') c.prob = pct(value);
    else if (field === 'marketMove' || field === 'sectorMove') c[field] = pct(value);
    else if (field === 'on') c.on = !!value;
    else c[field] = value;
    const n = SimContext.normalizeCard(c); Object.assign(c, n);
    ctxSave(); ctxChanged(); render();
}
function ctxToggleSector(id, sector, on) {
    const c = ctxFind(id); if (!c) return;
    c.sectors = on ? c.sectors.concat([sector]) : c.sectors.filter((s) => s !== sector);
    ctxSet(id, 'sectors', c.sectors);
}
function ctxAdd() { const c = SimContext.cardNew(); SIM.ctx.cards.push(c); ctxSave(); ctxChanged(); render(); const el = document.getElementById('ev-title-' + c.id); if (el) el.focus(); }
function ctxRemove(id) { SIM.ctx.cards = SIM.ctx.cards.filter((c) => c.id !== id); ctxSave(); ctxChanged(); render(); }
function ctxSetUse(on) { SIM.ctx.use = !!on; ctxSave(); ctxChanged(); render(); }
// Bối cảnh đổi: triển vọng có sự kiện phải tính lại; kết quả mô phỏng danh mục cũ được đánh dấu là chưa theo bối cảnh mới
function ctxChanged() {
    SIM.market.ctxResult = null; SIM.market.ctxKey = null;
    if (SIM.view === 'outlook' || SIM.view === 'context') ctxRefreshOutlook();
}
let ctxOutlookTimer = null;
function ctxRefreshOutlook() {
    clearTimeout(ctxOutlookTimer);
    ctxOutlookTimer = setTimeout(async function () {
        if (SIM.market.state !== 'ok') return;
        const evs = ctxEvents(), key = ctxKey();
        if (!evs.length) { SIM.market.ctxResult = null; SIM.market.ctxKey = null; if (SIM.view === 'outlook' || SIM.view === 'context') render(); return; }
        if (SIM.market.ctxKey === key && SIM.market.ctxResult) return;
        try {
            const r = await withModel([], () => SimWorker.call('simulate', { book: { cash: 0, debt: 0, positions: [{ symbol: MarketSim.INDEX, qty: 1, price: SIM.market.model.indexLevel }] }, policies: [{ id: 'hold', label: 'VN-Index' }], opts: simOpts({ paths: Math.max(10000, Number(SIM.settings.paths) || 0), events: evs }) }));
            if (key !== ctxKey()) return;            // người dùng đã chỉnh tiếp trong lúc tính
            SIM.market.ctxResult = r && r.ok ? r : null; SIM.market.ctxKey = key;
        } catch (e) { SIM.market.ctxResult = null; }
        if (SIM.view === 'outlook' || SIM.view === 'context') render();
    }, 350);
}

// ---------- vẽ ----------
const DIR_WORD = { up: 'tăng', down: 'giảm', mixed: 'chưa rõ chiều' }, WIN_WORD = { '1w': 'trong 1 tuần', '1m': 'trong 1 tháng', '3m': 'trong 3 tháng' };
const LIK_WORD = { low: 'thấp', medium: 'vừa', high: 'cao' }, MAG_WORD = { small: 'nhỏ', medium: 'vừa', large: 'lớn' };
function ctxEffectText(c) {
    const ev = MarketSim.eventFromCard(Object.assign({}, c, { on: true }), SIM.market.model.eventScale);
    if (!ev) return 'Không có tác động (xác suất hoặc mức bằng 0).';
    const mv = (j) => sPct(Math.exp(j) - 1, 1).replace('−', '');
    const dir = ev.sign > 0 ? '+' : (ev.sign < 0 ? '−' : '±');
    return 'Vào mô phỏng: <b>' + sProb(ev.p) + '</b> khả năng xảy ra ' + WIN_WORD[c.window] + '; nếu xảy ra, VN-Index ' + dir + mv(ev.jM) + ' trong một phiên' + (ev.jS ? ', cổ phiếu ' + sE(ev.sectors.join(', ')) + ' thêm ' + dir + mv(ev.jS) : '') + '.';
}
function ctxCardHtml(c) {
    const sc = SIM.market.model.eventScale, sel = (field, opts, v) => '<select class="tl-select" onchange="ctxSet(\'' + c.id + '\',\'' + field + '\',this.value)">' + opts.map((o) => '<option value="' + o[0] + '"' + (o[0] === v ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';
    const pctVal = (v) => (v === null || v === undefined ? '' : String(Math.round(v * 1000) / 10).replace('.', ','));
    const prior = MarketSim.EVENT_PRIOR[c.likelihood];
    const refs = c.refs.length ? '<div class="sim-ev-refs">' + c.refs.map((r) => '<a href="' + sE(r.link) + '" target="_blank" rel="noopener noreferrer" onclick="return simOpenLink(event, this.href)" title="' + sE(r.sourceName ? r.sourceName + ': ' + r.title : r.title) + '"><i class="fa-regular fa-newspaper"></i> ' + sE(r.title) + (r.sourceName ? ' <span class="sim-muted">· ' + sE(r.sourceName) + '</span>' : '') + '</a>').join('') + '</div>' : '';
    const signs = c.signposts.length ? '<div class="sim-ev-signs"><span class="k">Dấu hiệu theo dõi</span><ul>' + c.signposts.map((s) => '<li>' + sE(s) + '</li>').join('') + '</ul></div>' : '';
    // phạm vi "cả thị trường" mà AI vẫn nhắc vài ngành: nói rõ là chưa tính riêng (chỉ tính khi bật phạm vi ngành)
    const secLabel = c.scope === 'sector' ? 'Tác động riêng ngành: ' + sE(c.sectors.join(', '))
        : 'Tác động cả thị trường' + (c.sectors.length ? ' <span class="sim-muted">(AI nhắc tới ' + sE(c.sectors.join(', ')) + '; chưa tính riêng)</span>' : '');
    const sectors = '<details class="sim-ev-sectors"><summary>' + secLabel + '</summary>' +
        '<div class="sim-actions" style="margin:8px 0 0"><label class="sim-check"><input type="checkbox"' + (c.scope === 'sector' ? ' checked' : '') + (c.sectors.length ? '' : ' disabled') + ' onchange="ctxSet(\'' + c.id + '\',\'scope\',this.checked ? \'sector\' : \'market\')"> Tính riêng cho các ngành đã chọn</label></div><div class="sim-chips">' +
        SimContext.SECTORS.map((s) => '<label class="sim-check"><input type="checkbox"' + (c.sectors.indexOf(s) !== -1 ? ' checked' : '') + ' onchange="ctxToggleSector(\'' + c.id + '\',\'' + sE(s) + '\',this.checked)"> ' + sE(s) + '</label>').join('') + '</div></details>';
    const head = c.source === 'user'
        ? '<input class="tl-input sim-ev-title-in" id="ev-title-' + c.id + '" value="' + sE(c.title) + '" maxlength="110" aria-label="Tên sự kiện" onchange="ctxSet(\'' + c.id + '\',\'title\',this.value)">'
        : '<h4>' + sE(c.title) + '</h4>';
    return '<article class="sim-ev d-' + c.direction + (c.on ? '' : ' off') + '">' +
        '<div class="sim-ev-top"><span class="sim-tag">' + sE(c.category) + '</span><span class="sim-tag ' + (c.source === 'ai' ? 'warn' : 'ok') + '">' + (c.source === 'ai' ? 'AI gợi ý' : 'Bạn thêm') + '</span>' +
        '<label class="sim-check sim-ev-on"><input type="checkbox"' + (c.on ? ' checked' : '') + ' onchange="ctxSet(\'' + c.id + '\',\'on\',this.checked)"> Đưa vào mô phỏng</label></div>' +
        head + (c.rationale ? '<p class="sim-ev-why">' + sE(c.rationale) + '</p>' : '') + refs + signs +
        '<div class="sim-form sim-ev-form">' +
        '<label class="sim-field">Xác suất xảy ra (%)<input class="tl-input num" inputmode="decimal" value="' + pctVal(c.prob) + '" placeholder="' + Math.round(prior * 100) + ' (khả năng ' + LIK_WORD[c.likelihood] + ')" onchange="ctxSet(\'' + c.id + '\',\'prob\',this.value)"></label>' +
        '<label class="sim-field">Thời điểm' + sel('window', [['1w', 'Trong 1 tuần'], ['1m', 'Trong 1 tháng'], ['3m', 'Trong 3 tháng']], c.window) + '</label>' +
        '<label class="sim-field">Hướng' + sel('direction', [['down', 'Giảm'], ['up', 'Tăng'], ['mixed', 'Chưa rõ chiều']], c.direction) + '</label>' +
        '<label class="sim-field">Mức tác động' + sel('magnitude', [['small', 'Nhỏ (~' + sPct(sc.small, 1) + ')'], ['medium', 'Vừa (~' + sPct(sc.medium, 1) + ')'], ['large', 'Lớn (~' + sPct(sc.large, 1) + ')']], c.magnitude) + '</label>' +
        '<label class="sim-field">Mức thị trường (%)<input class="tl-input num" inputmode="decimal" value="' + pctVal(c.marketMove) + '" placeholder="theo mức" onchange="ctxSet(\'' + c.id + '\',\'marketMove\',this.value)"></label>' +
        (c.scope === 'sector' ? '<label class="sim-field">Mức riêng ngành (%)<input class="tl-input num" inputmode="decimal" value="' + pctVal(c.sectorMove) + '" placeholder="theo mức" onchange="ctxSet(\'' + c.id + '\',\'sectorMove\',this.value)"></label>' : '') +
        '</div>' + sectors +
        '<p class="sim-ev-effect">' + ctxEffectText(c) + '</p>' +
        (c.source === 'user' ? '<div class="sim-actions" style="margin-top:6px"><button type="button" class="sim-btn ghost sm" onclick="ctxRemove(\'' + c.id + '\')"><i class="fa-solid fa-trash-can"></i> Xoá sự kiện</button></div>' : '') +
        '</article>';
}
function ctxCompareHtml() {
    const base = SIM.market.result, cr = SIM.market.ctxResult; if (!base || !cr) return '';
    const L = SIM.market.model.indexLevel, rows = base.byHorizon.map((b, i) => {
        const c = cr.byHorizon[i];
        const cell = (x, y, f) => '<td>' + f(x) + '</td><td><b>' + f(y) + '</b></td>';
        return '<tr><td><b>' + hzLabel(b.h) + '</b></td>' + cell(L * (1 + b.index.median), L * (1 + c.index.median), (v) => sNum(v)) + cell(b.index.pLoss10, c.index.pLoss10, sProb) + cell(b.index.pGain10, c.index.pGain10, sProb) + '</tr>';
    }).join('');
    return '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-scale-balanced"></i> Bối cảnh làm thay đổi gì</h3><span class="tl-hint" style="margin:0">' + ctxEvents().length + ' sự kiện đang bật</span></div>' +
        '<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Mốc</th><th>Trung vị · chỉ lịch sử</th><th>· có bối cảnh</th><th>P(giảm &gt;10%) · lịch sử</th><th>· bối cảnh</th><th>P(tăng &gt;10%) · lịch sử</th><th>· bối cảnh</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="tl-hint">Cùng một bộ đường lịch sử, chỉ khác phần cú sốc của các sự kiện đang bật. Sự kiện là quan điểm cộng thêm lên mô hình lịch sử (giống "quan điểm" trong Black-Litterman): lịch sử vốn đã chứa những biến cố bình thường, nên chỉ bật sự kiện bạn tin là ĐẶC BIỆT của giai đoạn này, tránh tính hai lần.</p></section>';
}
function renderContextView() {
    if (SIM.market.state !== 'ok') return SIM.market.state === 'error' ? errorHtml('Chưa có mô hình thị trường: ' + SIM.market.error, 'simLoadMarket(true)') : loadingHtml('Đang dựng mô hình thị trường…');
    const C = SIM.ctx, sc = SIM.market.model.eventScale;
    let aiBox;
    if (C.state === 'loading') aiBox = '<div class="sim-progress"><span class="spin"></span>AI đang đọc khoảng 60 tin mới nhất và trạng thái thị trường để liệt kê sự kiện, thường 10-60 giây (mô hình mới nhất của Google hay quá tải nên có lúc phải chuyển xuống mô hình khác)…</div>';
    else if (C.state === 'error') aiBox = '<p class="tl-hint"><b class="sim-down">' + (C.code === 'no_key' ? 'Tính năng AI chưa được bật: quản trị cần đặt khoá GEMINI_API_KEY trong Supabase.' : sE(C.error)) + '</b></p>';
    else if (C.data) {
        const when = C.data.generatedAt ? new Date(C.data.generatedAt) : null;
        aiBox = (C.data.summary ? '<p class="sim-ctx-summary">' + sE(C.data.summary) + '</p>' : '') +
            '<p class="tl-hint"><b>Do AI tổng hợp</b> (' + sE(C.data.model || 'AI') + ')' + (when && isFinite(when) ? ' lúc ' + sE(when.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })) : '') + ' từ ' + sNum(C.data.itemCount) + ' tin' + (C.cached ? ', dùng lại kết quả của ' + Math.round(C.ageSec / 60) + ' phút trước' : '') + '. AI chỉ đọc tiêu đề và mô tả ngắn nên có thể sai, thiếu, hoặc nói quá chắc: mở tin gốc để kiểm, và chỉnh lại mọi thẻ theo đánh giá của bạn.' +
            (C.data.skipped && C.data.skipped.length ? ' Đã chuyển xuống mô hình này vì ' + C.data.skipped.length + ' mô hình tốt hơn đang hết hạn mức hoặc lỗi.' : '') + '</p>';
    } else aiBox = '<p class="tl-hint" style="margin-top:0">AI đọc khoảng 60 tin mới nhất từ các báo tài chính cùng trạng thái thị trường hiện tại (chỉ số liệu), rồi liệt kê các sự kiện có thể làm thị trường đổi hướng trong 3 tháng tới: mỗi sự kiện có hướng, mức tác động thô, khả năng thô, thời điểm, ngành bị ảnh hưởng, dấu hiệu theo dõi và tin làm căn cứ. AI không đưa ra con số xác suất hay giá.</p>';
    const head = '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-wand-magic-sparkles"></i> Bối cảnh thị trường</h3><div class="tl-card-tools">' +
        '<label class="sim-check"><input type="checkbox"' + (C.use ? ' checked' : '') + ' onchange="ctxSetUse(this.checked)"> Dùng bối cảnh trong mô phỏng</label>' +
        '<button type="button" class="sim-btn sm" onclick="ctxFetch()"' + (C.state === 'loading' ? ' disabled' : '') + '><i class="fa-solid fa-wand-magic-sparkles"></i> ' + (C.data ? 'Lấy bối cảnh mới' : 'Lấy bối cảnh bằng AI') + '</button>' +
        '<button type="button" class="sim-btn ghost sm" onclick="ctxAdd()"><i class="fa-solid fa-plus"></i> Thêm sự kiện tự nhập</button></div></div>' + aiBox +
        '<p class="tl-hint">Quy đổi mức thô thành số theo chính lịch sử VN-Index (độ lớn của các nhịp 5 phiên): nhỏ ≈ ' + sPct(sc.small, 1) + ', vừa ≈ ' + sPct(sc.medium, 1) + ', lớn ≈ ' + sPct(sc.large, 1) + '. Khả năng thô: thấp 15%, vừa 35%, cao 60%. Sự kiện theo ngành: cổ phiếu trong ngành chịu thêm ' + MarketSim.SECTOR_MULT + ' lần mức đó, thị trường chung ' + Math.round(MarketSim.SECTOR_SPILL * 100) + '%. Mọi con số chỉnh được trên từng thẻ.' + (SIM.ctx.cards.some((c) => c.source === 'ai') ? ' Lấy bối cảnh mới sẽ thay các thẻ AI (giữ phần bạn đã chỉnh nếu trùng tiêu đề) và giữ nguyên thẻ bạn tự thêm.' : '') + '</p></section>';
    const cards = C.cards.length ? '<div class="sim-evs">' + C.cards.map(ctxCardHtml).join('') + '</div>' : (C.state === 'loading' ? '' : '<section class="tl-card"><div class="tl-empty"><i class="fa-solid fa-layer-group"></i>Chưa có sự kiện. Bấm <b>Lấy bối cảnh bằng AI</b> hoặc <b>Thêm sự kiện tự nhập</b>.</div></section>');
    if (C.use && ctxEvents().length && !SIM.market.ctxResult) ctxRefreshOutlook();
    return head + (C.use ? ctxCompareHtml() : '') + cards;
}
// Liên kết tin: trong app Tauri mở bằng trình duyệt ngoài
function simOpenLink(ev, href) {
    if (!/^https:\/\//i.test(String(href))) return false;
    if (typeof openExternalUrl === 'function') { if (ev && ev.preventDefault) ev.preventDefault(); openExternalUrl(href); return false; }
    return true;
}

// Phần "Tác động từng sự kiện" trong kết quả mô phỏng danh mục
function eventImpactHtml(res, hk) {
    if (!res.events || !res.events.length) return '';
    const lab = (id) => (res.policies.find((p) => p.id === id) || {}).label || id;
    const rows = res.events.map((e) => {
        const h = e.byHorizon[hk];
        if (!h.yes) return '<tr><td>' + sE(e.title) + '</td><td>' + sProb(h.share) + '</td><td colspan="5" class="sim-muted">Chưa có đường nào xảy ra trước mốc này</td></tr>';
        const diff = h.yes.port.mean - (h.no ? h.no.port.mean : 0);
        return '<tr><td><b>' + sE(e.title) + '</b>' + (e.exposed.length ? '<div class="sim-muted" style="font-size:0.72rem">ảnh hưởng riêng: ' + sE(e.exposed.join(', ')) + '</div>' : '') + '</td><td>' + sProb(h.share) + '</td>' +
            '<td class="' + sCls(h.yes.port.mean) + '">' + sPct(h.yes.port.mean, 2, true) + '</td><td>' + (h.no ? sPct(h.no.port.mean, 2, true) : '—') + '</td><td class="' + sCls(diff) + '"><b>' + sPct(diff, 2, true) + '</b></td><td>' + sPct(h.yes.port.cvar95, 1) + '</td><td>' + (h.best ? sE(lab(h.best.ce)) : '—') + '</td></tr>';
    }).join('');
    return '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-bolt"></i> Tác động từng sự kiện của bối cảnh</h3><span class="tl-hint" style="margin:0">Giữ nguyên · sau ' + hzLabel(res.horizons[hk]) + '</span></div>' +
        '<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Sự kiện</th><th>Đã xảy ra trong</th><th>Danh mục nếu xảy ra</th><th>nếu không</th><th>Chênh lệch</th><th>CVaR 95% nếu xảy ra</th><th>Hợp khẩu vị nhất nếu xảy ra</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="tl-hint">"Đã xảy ra trong" là tỷ lệ đường mô phỏng có sự kiện trước mốc đang xem. Chênh lệch gồm cả tác động gián tiếp (các sự kiện khác cùng xảy ra ngẫu nhiên). Cột cuối cho biết nếu sự kiện thành hiện thực thì cách xử lý nào hợp khẩu vị nhất; muốn quyết định SAU khi thấy dấu hiệu, tạo kế hoạch có điều kiện.</p></section>';
}
