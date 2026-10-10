/* --- FILE: /simulation/sim-runs-ui.js ---
   Market Simulation, mục "Nhật ký": lưu từng lần mô phỏng (bảng finance_sim_runs qua API saveSimRun), tự chấm điểm khi các mốc 1 tuần / 1 tháng / 3 tháng đã tới
   (so với VN-Index và giá thật, chỉ dùng dữ liệu sau ngày chạy), cây sống của một lần chạy (nhánh thực tế đã đi + sự kiện đã đánh dấu -> xác suất có điều kiện phía trước),
   và ghi quyết định vào Nhật Ký Quyết Định kèm liên kết tới lần mô phỏng làm căn cứ. Mọi phép tính ở /lib/sim-score.js (có kiểm thử). */

SIM.runs = { state: 'idle', list: [], error: '', sel: null, series: null, seriesKey: '', scores: {}, decisions: [], decState: 'idle', jform: null, saving: false };

// ---------- lưu lần chạy ----------
function runChosenDefault(res) { const hh = res.byHorizon[res.byHorizon.length - 1]; return (hh.best && hh.best.ce) || res.policies[0].id; }
function runSaveHtml(res) {
    if (!res || !res.asOf) return '';
    const saved = SIM.run.savedId;
    const chosen = runChosenDefault(res);
    return '<section class="tl-card sim-save"><div class="tl-card-head"><h3><i class="fa-solid fa-bookmark"></i> Lưu lần chạy để tự chấm điểm</h3>' + (saved ? '<div class="tl-card-tools"><a class="sim-btn ghost sm" href="#runs/' + sE(saved) + '">Mở trong Nhật ký <i class="fa-solid fa-arrow-right"></i></a></div>' : '') + '</div>' +
        (saved ? '<p class="tl-hint" style="margin:0"><i class="fa-solid fa-circle-check" style="color:var(--success-color)"></i> Đã lưu. Khi các mốc tới, mục Nhật ký so dự báo này với VN-Index thật và với danh mục nếu cứ giữ nguyên; từ đó bạn cũng ghi được quyết định vào Nhật Ký Quyết Định.</p>'
            : '<div class="sim-form"><label class="sim-field">Cách xử lý bạn chọn<select class="tl-select" id="rs-chosen">' + res.policies.map((p) => '<option value="' + sE(p.id) + '"' + (p.id === chosen ? ' selected' : '') + '>' + sE(p.label) + '</option>').join('') + '</select></label>' +
            '<label class="sim-field" style="grid-column:span 2">Ghi chú (vì sao, điều gì sẽ làm bạn đổi ý)<input class="tl-input" id="rs-note" maxlength="1000" placeholder="Ví dụ: giữ, nhưng nếu tuần đầu thị trường giảm mạnh thì hạ 30%"></label></div>' +
            '<div class="sim-actions" style="margin-top:10px"><button type="button" class="sim-btn sm" onclick="simSaveRun(\'run\')"' + (SIM.runs.saving ? ' disabled' : '') + '><i class="fa-solid fa-bookmark"></i> Lưu vào nhật ký mô phỏng</button>' +
            '<span class="tl-hint" style="margin:0">Lưu dự báo (lưới phân vị, xác suất nhánh, cây' + (res.events && res.events.length ? ', ' + res.events.length + ' sự kiện bối cảnh' : '') + ') đúng như lúc này: dự báo đã lưu không sửa được, để chấm điểm công bằng.</span></div>') + '</section>';
}
function outlookSaveHtml(R) {
    if (!R || SIM.market.state !== 'ok') return '';
    const saved = SIM.market.savedId && SIM.market.savedKey === runOutlookKey();
    return '<div class="sim-actions sim-outlook-save">' + (saved ? '<a class="sim-btn ghost sm" href="#runs/' + sE(SIM.market.savedId) + '"><i class="fa-solid fa-circle-check"></i> Đã lưu triển vọng này · mở Nhật ký</a>'
        : '<button type="button" class="sim-btn ghost sm" onclick="simSaveRun(\'outlook\')"' + (SIM.runs.saving ? ' disabled' : '') + '><i class="fa-solid fa-bookmark"></i> Lưu triển vọng để tự chấm điểm</button>') +
        '<span class="tl-hint" style="margin:0">Mỗi lần lưu là một dự báo được chấm khi tới mốc: sau vài chục lần sẽ biết mô hình (và bối cảnh AI) có đáng tin không.</span></div>';
}
const runOutlookKey = () => (SIM.market.model ? SIM.market.model.lastDate : '') + '|' + (typeof ctxKey === 'function' ? ctxKey() : '');
async function simSaveRun(source) {
    if (SIM.runs.saving) return;
    const M = SIM.market;
    let res, base = null, meta;
    if (source === 'outlook') {
        if (M.state !== 'ok') return;
        const withCtx = !!(SIM.ctx && SIM.ctx.use && M.ctxResult && ctxEvents().length);
        res = withCtx ? M.ctxResult : M.result; base = withCtx ? M.result : null;
        meta = { asOf: M.model.lastDate, indexLevel: M.model.indexLevel, subject: 'outlook', chosen: 'hold', events: SIM.ctx ? SIM.ctx.cards : [], cash: 0, debt: 0 };
    } else {
        res = SIM.run.result; if (!res || !res.asOf) return;
        if (M.state === 'ok' && M.model && M.model.lastDate === res.asOf && res.events && res.events.length) base = M.result;
        const el = document.getElementById('rs-chosen');
        meta = { asOf: res.asOf, indexLevel: res.indexLevel, subject: res.subject, chosen: el ? el.value : runChosenDefault(res), events: SIM.ctx ? SIM.ctx.cards : [], cash: res.book ? res.book.cash : null, debt: res.book ? res.book.debt : null };
    }
    const snap = SimScore.snapshot(res, base, meta);
    const noteEl = document.getElementById('rs-note');
    const label = source === 'outlook' ? 'Triển vọng VN-Index' : 'Mô phỏng ' + subjectWord();
    SIM.runs.saving = true; render();
    try {
        const r = await simCall('saveSimRun', { email: SIM.email, run: { snapshot: snap, subject: meta.subject, chosen: meta.chosen, label: label, note: noteEl ? noteEl.value : '' } });
        if (source === 'outlook') { SIM.market.savedId = r && r.id; SIM.market.savedKey = runOutlookKey(); } else SIM.run.savedId = r && r.id;
        SIM.runs.state = 'idle';                     // danh sách phải đọc lại
        showToast((r && r.message) || 'Đã lưu.');
    } catch (e) { showToast(e.message || String(e), 'error'); }
    SIM.runs.saving = false; render();
}

// ---------- tải danh sách + chấm điểm ----------
function runsRoute(id) {
    if (id && id !== SIM.runs.sel) { SIM.runs.sel = id; SIM.runs.jform = null; SIM.runs.decState = 'idle'; }
    if (SIM.runs.state === 'idle') runsLoad();
    else if (SIM.runs.sel && SIM.runs.decState === 'idle') runsLoadDecisions();
}
async function runsLoad() {
    SIM.runs.state = 'loading'; SIM.runs.error = ''; if (SIM.view === 'runs') render();
    try {
        const list = await simCall('listSimRuns', { email: SIM.email, limit: 120 });
        SIM.runs.list = (list || []).filter((r) => r && r.snapshot && r.snapshot.v === SimScore.VERSION);
        // VN-Index trước để chấm phần thị trường; giá các mã (danh mục giữ nguyên) chỉ tải khi có lần chạy đã tới mốc
        let inp = await getInputs([]);
        runsScoreAll(inp.input);
        const due = SIM.runs.list.filter((r) => (SIM.runs.scores[r.id] || {}).horizons && SIM.runs.scores[r.id].horizons.some((h) => h.due));
        const syms = [...new Set([].concat.apply([], due.map((r) => (r.snapshot.positions || []).map((p) => p.symbol).filter((s) => s !== MarketSim.INDEX))))].slice(0, 40);
        if (syms.length) { try { inp = await getInputs(syms); runsScoreAll(inp.input); } catch (e) { /* không tải được giá các mã: vẫn chấm phần VN-Index */ } }
        SIM.runs.state = 'ok';
        if (!SIM.runs.sel && SIM.runs.list.length) SIM.runs.sel = SIM.runs.list[0].id;
    } catch (e) { SIM.runs.state = 'error'; SIM.runs.error = e.message || String(e); }
    if (SIM.view === 'runs') { render(); if (SIM.runs.sel) runsLoadDecisions(); }
}
function runsScoreAll(series) {
    SIM.runs.series = series; SIM.runs.scores = {};
    SIM.runs.list.forEach((r) => { SIM.runs.scores[r.id] = SimScore.scoreRun(r.snapshot, series); });
}
async function runsLoadDecisions() {
    const id = SIM.runs.sel; if (!id) return;
    SIM.runs.decState = 'loading';
    try { const all = await simCall('listDecisions', { email: SIM.email }); SIM.runs.decisions = (all || []).filter((d) => d.sim_run_id === id); SIM.runs.decState = 'ok'; }
    catch (e) { SIM.runs.decisions = []; SIM.runs.decState = 'error'; }
    if (SIM.view === 'runs' && SIM.runs.sel === id) render();
}
function runsSelect(id) { location.hash = '#runs/' + id; }
async function runsSetMark(id, eventId, val) {
    const r = SIM.runs.list.find((x) => x.id === id); if (!r) return;
    const marks = Object.assign({}, r.marks || {});
    if (val === 'yes') marks[eventId] = true; else if (val === 'no') marks[eventId] = false; else delete marks[eventId];
    r.marks = marks; render();
    try { await simCall('updateSimRun', { email: SIM.email, id: id, patch: { marks: marks } }); } catch (e) { showToast(e.message || String(e), 'error'); }
}
async function runsSaveNote(id) {
    const el = document.getElementById('rn-note'), r = SIM.runs.list.find((x) => x.id === id); if (!el || !r) return;
    try { await simCall('updateSimRun', { email: SIM.email, id: id, patch: { note: el.value } }); r.note = el.value.trim() || null; showToast('Đã lưu ghi chú.'); } catch (e) { showToast(e.message || String(e), 'error'); }
}
async function runsDelete(id) {
    if (!confirm('Xoá lần mô phỏng này khỏi nhật ký? Quyết định đã ghi trong Nhật Ký Quyết Định vẫn giữ nguyên.')) return;
    try { await simCall('deleteSimRun', { email: SIM.email, id: id }); SIM.runs.list = SIM.runs.list.filter((x) => x.id !== id); if (SIM.runs.sel === id) SIM.runs.sel = SIM.runs.list.length ? SIM.runs.list[0].id : null; location.hash = SIM.runs.sel ? '#runs/' + SIM.runs.sel : '#runs'; render(); }
    catch (e) { showToast(e.message || String(e), 'error'); }
}

// ---------- ghi vào Nhật Ký Quyết Định ----------
function runReasonText(r) {
    const s = r.snapshot, pol = (s.policies.find((p) => p.id === s.chosen) || s.policies[0]), last = s.outcome[s.outcome.length - 1];
    return 'Market Simulation ' + fmtDate(s.asOf) + ' (' + sNum(s.paths) + ' đường' + (s.events.length ? ', ' + s.events.length + ' sự kiện bối cảnh' : '') + '): chọn "' + pol.label + '". Sau ' + hzLabel(last.h) + ': trung vị ' + sPct(last.median, 1, true) +
        ', khoảng 90% ' + sPct(last.q05, 1, true) + ' … ' + sPct(last.q95, 1, true) + ', P(lỗ >10%) ' + sProb(last.pLoss10) + (s.chosen !== s.policies[0].id ? '; Giữ nguyên trung vị ' + sPct(last.holdMedian, 1, true) : '') + '.' + (r.note ? ' ' + r.note : '');
}
function runsOpenJournal(id) {
    const r = SIM.runs.list.find((x) => x.id === id); if (!r) return;
    const pos = (r.snapshot.positions || []).filter((p) => p.symbol !== MarketSim.INDEX);
    const sym = pos.length ? pos[0].symbol : 'VNINDEX';
    SIM.runs.jform = { runId: id, symbol: sym, action: r.snapshot.chosen === 'hold' ? 'hold' : (/^(trim|cash|stop|trail|tp)/.test(r.snapshot.chosen) ? 'sell' : 'hold'), price: pos.length ? pos[0].price : null, reason: runReasonText(r), horizon: 3, confidence: '' };
    render();
    const el = document.getElementById('jf-reason'); if (el) el.focus();
}
function runsJformSymbol(sym) {
    const f = SIM.runs.jform; if (!f) return; const r = SIM.runs.list.find((x) => x.id === f.runId);
    const p = r ? (r.snapshot.positions || []).find((x) => x.symbol === sym) : null;
    f.symbol = sym; f.price = p ? p.price : (sym === 'VNINDEX' && r ? r.snapshot.indexLevel : null); render();
}
async function runsSaveDecision() {
    const f = SIM.runs.jform; if (!f) return;
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const price = Number(String(val('jf-price')).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'));
    const decision = { symbol: f.symbol, action: val('jf-action'), date: new Date().toISOString().slice(0, 10), price: price > 0 ? price : null, reason: val('jf-reason'),
        horizonMonths: val('jf-horizon') ? Number(val('jf-horizon')) : null, confidence: val('jf-conf') ? Number(val('jf-conf')) : null, tags: ['mô phỏng'], simRunId: f.runId };
    try {
        const msg = await simCall('saveDecision', { email: SIM.email, decision: decision });
        showToast(typeof msg === 'string' ? msg : 'Đã ghi quyết định.'); SIM.runs.jform = null; runsLoadDecisions();
    } catch (e) { showToast(e.message || String(e), 'error'); }
}
function runsCloseJournal() { SIM.runs.jform = null; render(); }

// ---------- vẽ ----------
const runStatusTag = (h) => {
    if (!h) return '<span class="sim-muted">—</span>';
    if (!h.due) return '<span class="sim-muted" title="Còn ' + h.sessionsLeft + ' phiên">còn ' + h.sessionsLeft + ' phiên</span>';
    const t = h.in50 ? ['ok', 'trong 50%'] : (h.in90 ? ['warn', 'trong 90%'] : ['bad', 'ngoài 90%']);
    return '<span class="' + sCls(h.ret) + '">' + sPct(h.ret, 1, true) + '</span> <span class="sim-tag ' + t[0] + '" title="PIT ' + sNum(h.pit, 2) + ': xác suất dự báo nằm dưới giá trị thật">' + t[1] + '</span>';
};
const subjectLabel = (s) => ({ mine: 'Danh mục của tôi', group: 'Danh mục nhóm', index: 'VN-Index', custom: 'Tự chọn mã', outlook: 'Triển vọng' }[s] || s);
function renderRunsView() {
    const R = SIM.runs;
    if (R.state === 'loading' || R.state === 'idle') return loadingHtml('Đang tải nhật ký mô phỏng và VN-Index để chấm điểm…');
    if (R.state === 'error') return errorHtml('Không tải được nhật ký mô phỏng: ' + R.error + (/finance_sim_runs/.test(R.error) ? ' (quản trị cần chạy finance-sim-runs-migration.sql)' : ''), 'runsLoad()');
    if (!R.list.length) return '<section class="tl-card"><div class="tl-empty"><i class="fa-solid fa-bookmark"></i>Chưa lưu lần mô phỏng nào. Ở mục <b>Mô phỏng</b> (sau khi chạy) hoặc <b>Triển vọng</b>, bấm <b>Lưu</b> để giữ dự báo lại; khi các mốc 1 tuần / 1 tháng / 3 tháng tới, trang tự so với thực tế.</div></section>';
    return runsAggregateHtml() + runsTableHtml() + runsDetailHtml();
}
function runsAggregateHtml() {
    const R = SIM.runs, items = R.list.map((r) => ({ snap: r.snapshot, score: R.scores[r.id] })), agg = SimScore.aggregate(items, [5, 21, 63]);
    const matured = agg.reduce((s, a) => s + a.n, 0);
    const cov = (v, nom, n) => { if (!n) return '<span class="sim-muted">—</span>'; const d = Math.abs(v - nom); return '<span class="sim-tag ' + (n < 8 ? '' : (d <= 0.1 ? 'ok' : (d <= 0.2 ? 'warn' : 'bad'))) + '">' + sProb(v) + '</span>'; };
    const rows = agg.map((a) => '<tr><td><b>' + hzLabel(a.h) + '</b></td><td>' + a.n + '</td><td>' + cov(a.cover50, 0.5, a.n) + '</td><td>' + cov(a.cover90, 0.9, a.n) + '</td><td>' + (a.n ? '<span class="sim-pit" aria-label="Biểu đồ PIT">' + a.pit.map((p) => '<span style="height:' + Math.max(2, Math.min(26, p * 130)).toFixed(0) + 'px"></span>').join('') + '</span>' : '—') + '</td><td>' + (a.crps === null ? '—' : sPct(a.crps, 2)) + '</td>' +
        '<td class="' + sCls(a.bss) + '">' + (a.bss === null ? '—' : (a.bss >= 0 ? '+' : '−') + Math.abs(a.bss).toFixed(2)) + '</td>' +
        '<td>' + (a.ctx.n ? sPct(a.ctx.crps, 2) + ' / ' + sPct(a.ctx.crpsBase, 2) + ' <span class="sim-tag ' + (a.ctx.crps < a.ctx.crpsBase ? 'ok' : 'bad') + '">' + (a.ctx.crps < a.ctx.crpsBase ? 'bối cảnh tốt hơn' : 'bối cảnh kém hơn') + '</span> <span class="sim-muted">(' + a.ctx.n + ')</span>' : '<span class="sim-muted">chưa có</span>') + '</td>' +
        '<td>' + (a.hold.n ? cov(a.hold.cover90, 0.9, a.hold.n) + ' <span class="sim-muted">(' + a.hold.n + ')</span>' : '—') + '</td></tr>').join('');
    return '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-scale-balanced"></i> Dự báo đã lưu đúng đến đâu</h3><span class="tl-hint" style="margin:0">' + R.list.length + ' lần lưu · ' + matured + ' lượt đã tới mốc</span></div>' +
        '<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Mốc</th><th>Đã tới</th><th>Thực tế trong khoảng 50%</th><th>trong 90%</th><th>PIT</th><th title="Sai số xác suất liên tục của VN-Index: càng thấp càng tốt">CRPS</th><th title="Điểm kỹ năng Brier của xác suất 3 nhánh so với tần suất lịch sử trước ngày chạy">BSS nhánh</th><th title="Chỉ các lần chạy có bối cảnh: CRPS có bối cảnh / chỉ lịch sử, trên cùng các lần đó">Có bối cảnh / chỉ lịch sử</th><th title="Danh mục lúc chạy nếu cứ giữ nguyên, so với dự báo của Giữ nguyên">Danh mục trong 90%</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="tl-hint">Chỉ chấm bằng dữ liệu SAU ngày chạy: mốc 1 tuần = 5 phiên giao dịch sau ngày dữ liệu cuối của lần chạy. Mô hình tốt: thực tế nằm trong khoảng 50% khoảng một nửa số lần và trong khoảng 90% khoảng 9/10 số lần; PIT gần phẳng; BSS dương. Dưới 8 lượt thì chưa tô màu: quá ít để kết luận. Các lần lưu sát nhau dùng chung một giai đoạn thị trường nên không độc lập hẳn. CRPS ở đây tính xấp xỉ từ 39 phân vị đã lưu.</p></section>';
}
function runsTableHtml() {
    const R = SIM.runs;
    const rows = R.list.map((r) => {
        const s = r.snapshot, sc = R.scores[r.id] || { horizons: [] }, pol = s.policies.find((p) => p.id === s.chosen) || s.policies[0];
        return '<tr class="' + (r.id === R.sel ? 'sel' : '') + '"><td><button type="button" class="sim-row-btn" onclick="runsSelect(\'' + sE(r.id) + '\')">' + sE(fmtDate(s.asOf)) + '</button><div class="sim-muted" style="font-size:0.72rem">lưu ' + sE(new Date(r.created_at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })) + '</div></td>' +
            '<td>' + sE(subjectLabel(r.subject)) + (s.events.length ? '<span class="sim-tag warn" title="Có ' + s.events.length + ' sự kiện bối cảnh">bối cảnh</span>' : '') + '</td><td>' + sE(s.subject === 'outlook' ? '—' : pol.label) + '</td>' +
            s.horizons.map((h, i) => '<td>' + runStatusTag(sc.horizons[i]) + '</td>').join('') + '</tr>';
    }).join('');
    return '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-list"></i> Các lần đã lưu</h3><div class="tl-card-tools"><button type="button" class="sim-btn ghost sm" onclick="SIM.runs.state=\'idle\';simInputsCache={};runsLoad()"><i class="fa-solid fa-rotate"></i> Tải lại</button></div></div>' +
        '<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Ngày dữ liệu</th><th>Đối tượng</th><th>Cách xử lý đã chọn</th><th>VN-Index sau 1 tuần</th><th>sau 1 tháng</th><th>sau 3 tháng</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="tl-hint">Nhãn: thực tế nằm trong khoảng 50% / 90% của dự báo lúc đó, hay ngoài 90%. Bấm ngày để xem chi tiết và cây sống.</p></section>';
}
function runsDetailHtml() {
    const R = SIM.runs, r = R.list.find((x) => x.id === R.sel);
    if (!r) return '';
    const s = r.snapshot, sc = R.scores[r.id] || { horizons: [], prefix: '' }, L = s.indexLevel;
    const pol = s.policies.find((p) => p.id === s.chosen) || s.policies[0];
    const qAt = (g, lv) => { const i = s.levels.findIndex((x) => Math.abs(x - lv) < 1e-9); return i === -1 || !g ? null : g[i]; };
    const fc = s.horizons.map((h, i) => {
        const g = s.grid.index[i], x = sc.horizons[i] || {}, o = s.outcome[i] || {};
        return '<tr><td><b>' + hzLabel(h) + '</b>' + (x.date ? '<div class="sim-muted" style="font-size:0.72rem">tới ' + sE(fmtDate(x.date)) + '</div>' : '') + '</td><td>' + sNum(L * (1 + qAt(g, 0.05))) + ' … ' + sNum(L * (1 + qAt(g, 0.95))) + '</td><td>' + sNum(L * (1 + qAt(g, 0.5))) + '</td><td>' + (x.due ? '<b>' + sNum(L * (1 + x.ret)) + '</b>' : '—') + '</td><td>' + runStatusTag(x) + '</td>' +
            '<td>' + (x.due ? BR_WORD[x.branch] + ' <span class="sim-muted">(dự báo ' + sProb(s.branchProb[i][x.branch]) + ')</span>' : '—') + '</td>' +
            '<td>' + (s.subject === 'outlook' ? '—' : sPct(o.median, 1, true) + ' <span class="sim-muted">' + sPct(o.q05, 0, true) + '…' + sPct(o.q95, 0, true) + '</span>') + '</td><td>' + (x.hold ? '<span class="' + sCls(x.hold.ret) + '">' + sPct(x.hold.ret, 1, true) + '</span>' + (x.hold.in90 ? '' : ' <span class="sim-tag bad">ngoài 90%</span>') : '—') + '</td></tr>';
    }).join('');
    const head = '<section class="tl-card" id="run-detail"><div class="tl-card-head"><h3><i class="fa-solid fa-bookmark"></i> ' + sE(r.label || subjectLabel(r.subject)) + ' · ' + sE(fmtDate(s.asOf)) + '</h3><div class="tl-card-tools">' +
        (s.subject !== 'outlook' ? '<button type="button" class="sim-btn sm" onclick="runsOpenJournal(\'' + sE(r.id) + '\')"><i class="fa-solid fa-book"></i> Ghi vào Nhật Ký Quyết Định</button>' : '') +
        '<button type="button" class="sim-btn ghost sm" onclick="runsDelete(\'' + sE(r.id) + '\')"><i class="fa-solid fa-trash-can"></i> Xoá</button></div></div>' +
        '<p class="sim-prose" style="margin:0 0 10px">VN-Index lúc chạy ' + sNum(L, 2) + ' · ' + sNum(s.paths) + ' đường · mô hình ' + sE(s.model) + (s.events.length ? ' · ' + s.events.length + ' sự kiện bối cảnh' : ' · chỉ lịch sử') + (s.subject !== 'outlook' ? ' · NAV ' + sVnd(s.nav0) + ' · đã chọn <b>' + sE(pol.label) + '</b>' + (s.bestFinal && s.bestFinal !== s.chosen ? ' <span class="sim-muted">(mô phỏng xếp "' + sE((s.policies.find((p) => p.id === s.bestFinal) || {}).label) + '" hợp khẩu vị nhất)</span>' : '') : '') + '</p>' +
        '<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Mốc</th><th>VN-Index dự báo 90%</th><th>Trung vị</th><th>Thực tế</th><th>Đánh giá</th><th>Nhánh thực tế</th><th>Cách đã chọn: dự báo</th><th>Danh mục giữ nguyên: thực tế</th></tr></thead><tbody>' + fc + '</tbody></table></div>' +
        '<div class="sim-chart" style="margin-top:12px"><canvas id="run-fan" aria-label="Dự báo VN-Index lúc lưu và giá trị thực tế"></canvas></div><div class="sim-legend"><span><i style="background:var(--sim-band-outer)"></i>90% dự báo</span><span><i style="background:var(--sim-band-inner)"></i>50%</span><span><i style="background:var(--finance-accent)"></i>Trung vị dự báo</span><span><i style="background:var(--text-muted)"></i>VN-Index thực tế</span></div>' +
        '<div class="sim-form" style="margin-top:12px"><label class="sim-field" style="grid-column:1/-1">Ghi chú<input class="tl-input" id="rn-note" maxlength="1000" value="' + sE(r.note || '') + '" placeholder="Vì sao chọn cách này, điều gì sẽ làm bạn đổi ý"></label></div><div class="sim-actions" style="margin-top:6px"><button type="button" class="sim-btn ghost sm" onclick="runsSaveNote(\'' + sE(r.id) + '\')">Lưu ghi chú</button></div></section>';
    return head + runsLiveHtml(r, sc) + runsJournalHtml(r);
}
// Cây sống: nút hiện tại theo nhánh thực tế + sự kiện đã đánh dấu; xác suất có điều kiện của các nhánh phía trước
function runsLiveHtml(r, sc) {
    const s = r.snapshot, marks = r.marks || {};
    const markedId = Object.keys(marks).find((k) => (s.eventTrees || []).some((t) => t.id === k));
    const live = SimScore.liveTree(s, sc.prefix, markedId ? { eventId: markedId, happened: marks[markedId] } : null);
    const branchCell = (id) => id.replace(/^[YN]/, '').split('').map((c, i) => '<span>' + STAGE_LABEL[i] + ': <b>' + BR_WORD[+c] + '</b></span>').join('<span class="sep">›</span>');
    const nodeRow = (x) => '<tr><td><div class="sim-crumbs" style="margin:0">' + branchCell(x.id) + '</div></td><td><b>' + sProb(x.cond) + '</b></td><td>' + sPct(x.im, 1, true) + '</td><td>' + (s.subject === 'outlook' ? '—' : sPct(x.hm, 1, true)) + '</td><td>' + (x.best && s.subject !== 'outlook' ? sE((s.policies.find((p) => p.id === x.best) || {}).label || '') : '—') + '</td></tr>';
    const where = live.path ? 'Thực tế đã đi: <div class="sim-crumbs" style="display:inline-flex;margin:0 0 0 4px">' + branchCell(live.path) + '</div>' : 'Chưa qua mốc nào: ' + (sc.horizons[0] ? 'còn ' + sc.horizons[0].sessionsLeft + ' phiên tới mốc 1 tuần.' : '');
    const evRows = (s.events || []).map((e) => {
        const v = marks[e.id], hasTree = (s.eventTrees || []).some((t) => t.id === e.id);
        return '<div class="sim-live-ev"><div><b>' + sE(e.title) + '</b> <span class="sim-muted">· ' + sProb(e.p) + ' khả năng lúc chạy</span>' + (e.signposts.length ? '<ul>' + e.signposts.map((x) => '<li>' + sE(x) + '</li>').join('') + '</ul>' : '') + '</div>' +
            '<div class="sim-seg" role="group" aria-label="Sự kiện đã xảy ra chưa">' + [['', 'Chưa rõ'], ['yes', 'Đã xảy ra'], ['no', 'Không xảy ra']].map((o) => '<button type="button" aria-pressed="' + ((o[0] === 'yes' && v === true) || (o[0] === 'no' && v === false) || (o[0] === '' && v === undefined)) + '" onclick="runsSetMark(\'' + sE(r.id) + '\',\'' + sE(e.id) + '\',\'' + o[0] + '\')"' + (!hasTree && o[0] ? ' title="Sự kiện này không có cây riêng (chỉ 3 sự kiện đầu có): đánh dấu chỉ để ghi nhớ"' : '') + '>' + o[1] + '</button>').join('') + '</div></div>';
    }).join('');
    return '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-seedling"></i> Cây sống</h3><span class="tl-hint" style="margin:0">' + (live.eventTitle ? 'theo sự kiện: ' + sE(live.eventTitle) + ' (' + (live.root === 'Y' ? 'đã xảy ra' : 'không xảy ra') + ')' : 'theo VN-Index') + '</span></div>' +
        '<p class="sim-prose" style="margin:0 0 10px">' + where + (live.stalled ? ' <span class="sim-muted">(nhánh tiếp theo có quá ít đường trong lần chạy này nên dừng ở nút gần nhất)</span>' : '') + (live.current ? ' Lúc chạy, xác suất tới nút này là <b>' + sProb(live.current.p) + '</b>.' : '') + '</p>' +
        (live.done ? '<p class="tl-hint">Đã qua cả 3 mốc: cây đã khép lại. Xem phần chấm điểm ở trên.</p>'
            : '<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Từ đây tới mốc cuối</th><th>Xác suất có điều kiện</th><th>VN-Index tích luỹ (trung vị)</th><th>Giữ nguyên (trung vị)</th><th>Hợp khẩu vị nhất ở nhánh</th></tr></thead><tbody>' + live.ahead.map(nodeRow).join('') + '</tbody></table></div>' +
            '<p class="tl-hint">Xác suất có điều kiện đọc từ cây đã lưu (không mô phỏng lại): đã biết các giai đoạn đã qua, phần còn lại của cây được chuẩn hoá lại. Nếu thị trường đang đi nhánh mà cách hợp khẩu vị khác cách bạn đã chọn, đó là lúc xem lại kế hoạch.</p>') +
        (evRows ? '<h4 class="sim-sub">Sự kiện của bối cảnh lúc chạy: đánh dấu khi đã rõ</h4><div class="sim-live-evs">' + evRows + '</div><p class="tl-hint">Đánh dấu một sự kiện (trong 3 sự kiện đầu) đã xảy ra hay không thì cây sống chuyển sang cây theo sự kiện đó, gốc tương ứng. Theo dõi các dấu hiệu bên dưới mỗi sự kiện để biết khi nào đã rõ.</p>' : '') + '</section>';
}
function runsJournalHtml(r) {
    const R = SIM.runs, f = R.jform && R.jform.runId === r.id ? R.jform : null, s = r.snapshot;
    const list = R.decState === 'ok' && R.decisions.length ? '<div class="sim-table-wrap"><table class="sim-table"><thead><tr><th>Ngày</th><th>Mã</th><th>Hành động</th><th>Lý do</th></tr></thead><tbody>' +
        R.decisions.map((d) => '<tr><td>' + sE(fmtDate(d.decided_at)) + '</td><td><b>' + sE(d.symbol) + '</b></td><td>' + sE({ buy: 'Mua', sell: 'Bán', hold: 'Giữ', skip: 'Bỏ qua' }[d.action] || d.action) + '</td><td class="sim-muted">' + sE(String(d.reason || '').slice(0, 140)) + '</td></tr>').join('') + '</tbody></table></div><p class="tl-hint">Xem và đánh giá lại ở <a href="/mastersheet/assets/#journal">Nhật Ký Quyết Định</a>.</p>' : '';
    let form = '';
    if (f) {
        const syms = (s.positions || []).map((p) => p.symbol).filter((x) => x !== MarketSim.INDEX);
        if (!syms.length || s.positions.some((p) => p.symbol === MarketSim.INDEX)) syms.push('VNINDEX');
        form = '<div class="sim-form" style="margin-top:6px"><label class="sim-field">Mã<select class="tl-select" onchange="runsJformSymbol(this.value)">' + syms.map((x) => '<option' + (x === f.symbol ? ' selected' : '') + '>' + sE(x) + '</option>').join('') + '</select></label>' +
            '<label class="sim-field">Hành động<select class="tl-select" id="jf-action">' + [['buy', 'Mua'], ['sell', 'Bán'], ['hold', 'Giữ'], ['skip', 'Bỏ qua']].map((o) => '<option value="' + o[0] + '"' + (o[0] === f.action ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>' +
            '<label class="sim-field">Giá lúc quyết định<input class="tl-input num" id="jf-price" inputmode="decimal" value="' + (f.price ? sNum(f.price) : '') + '"></label>' +
            '<label class="sim-field">Thời hạn (tháng)<input class="tl-input num" id="jf-horizon" inputmode="numeric" value="' + sE(f.horizon) + '"></label>' +
            '<label class="sim-field">Mức tự tin<select class="tl-select" id="jf-conf"><option value="">—</option>' + [1, 2, 3, 4, 5].map((n) => '<option value="' + n + '">' + n + '/5</option>').join('') + '</select></label>' +
            '<label class="sim-field" style="grid-column:1/-1">Lý do<textarea class="tl-input" id="jf-reason" rows="3" maxlength="1000">' + sE(f.reason) + '</textarea></label></div>' +
            '<div class="sim-actions" style="margin-top:8px"><button type="button" class="sim-btn sm" onclick="runsSaveDecision()"><i class="fa-solid fa-floppy-disk"></i> Ghi quyết định</button><button type="button" class="sim-btn ghost sm" onclick="runsCloseJournal()">Huỷ</button>' +
            '<span class="tl-hint" style="margin:0">Ghi một dòng cho mỗi mã; dòng có nhãn "mô phỏng" và liên kết về lần chạy này.</span></div>';
    }
    if (!f && !list) return s.subject === 'outlook' ? '' : '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-book"></i> Nhật Ký Quyết Định</h3></div><p class="tl-hint" style="margin:0">' + (R.decState === 'loading' ? 'Đang tải…' : 'Chưa có quyết định nào ghi từ lần mô phỏng này. Bấm <b>Ghi vào Nhật Ký Quyết Định</b> để lưu lý do (điền sẵn tóm tắt mô phỏng) và sau này đánh giá lại.') + '</p></section>';
    return '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-book"></i> Nhật Ký Quyết Định từ lần chạy này</h3></div>' + list + form + '</section>';
}
function mountRunsCharts() {
    const R = SIM.runs, r = R.list.find((x) => x.id === R.sel), c = document.getElementById('run-fan');
    if (!r || !c || !R.series) return;
    const s = r.snapshot, L = s.indexLevel, H = s.horizons[s.horizons.length - 1];
    // quạt dự báo dựng lại từ lưới đã lưu (nội suy tuyến tính giữa phiên 0 và các mốc), đường thực tế từ VN-Index sau ngày chạy
    const qAt = (k, lv) => { if (k < 0) return 0; const i = s.levels.findIndex((x) => Math.abs(x - lv) < 1e-9); return s.grid.index[k][i]; };
    const band = (lv) => { const out = []; for (let t = 0; t <= H; t++) { let k = 0; while (k < s.horizons.length && s.horizons[k] < t) k++; const t1 = s.horizons[k], t0 = k ? s.horizons[k - 1] : 0, w = t1 > t0 ? (t - t0) / (t1 - t0) : 1; out.push(1 + qAt(k - 1, lv) + w * (qAt(k, lv) - qAt(k - 1, lv))); } return out; };
    const i0 = SimScore.originIndex(R.series.dates, s.asOf), act = [];
    if (i0 >= 0) for (let t = 0; t <= H && i0 + t < R.series.index.length; t++) act.push(R.series.index[i0 + t] / R.series.index[i0]);
    SimCharts.fan(c, { bands: { q05: band(0.05), q25: band(0.25), q50: band(0.5), q75: band(0.75), q95: band(0.95) }, base: L, fmt: (v) => sNum(v), markers: s.horizons, labels: HZ_LABEL, height: 230, startLabel: 'Ngày chạy', overlay: act.length > 1 ? { data: act, label: 'Thực tế' } : null });
}
