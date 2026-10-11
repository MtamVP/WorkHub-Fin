/* --- FILE: /insight/insight-views-b.js ---
   Màn hình Luận điểm và Sở hữu: chỉ dựng chuỗi HTML từ kết quả đã tính (lib/thesis-calc.js, ownership-calc.js). Sự kiện do insight-app.js xử lý. */
const InsViewsB = (function () {
  const U = (typeof require === 'function' && typeof module !== 'undefined') ? require('./insight-util.js') : InsUtil, e = U.esc;
  const TC = (typeof require === 'function' && typeof module !== 'undefined') ? require('../lib/thesis-calc.js') : ThesisCalc;
  const OC = (typeof require === 'function' && typeof module !== 'undefined') ? require('../lib/ownership-calc.js') : OwnershipCalc;
  const IDEA_STATUS = { idea: 'Ý tưởng', research: 'Nghiên cứu', review: 'Chờ phản biện', approved: 'Đã duyệt', in_portfolio: 'Đang trong danh mục' };
  const STATE_ICON = { ok: 'fa-circle-check', fail: 'fa-circle-xmark', unknown: 'fa-circle-question' };
  const STATE_TEXT = { ok: 'Đang đúng', fail: 'Đang sai', unknown: 'Chưa có số liệu' };

  function metricOptions(selected) {
    const groups = {}, order = [];
    TC.METRICS.forEach((m) => { if (!groups[m.group]) { groups[m.group] = []; order.push(m.group); } groups[m.group].push(m); });
    return order.map((g) => '<optgroup label="' + e(g) + '">' + groups[g].map((m) => '<option value="' + e(m.key) + '"' + (m.key === selected ? ' selected' : '') + '>' + e(m.label) + (m.unit && !m.manual ? ' (' + e(m.unit) + ')' : '') + '</option>').join('') + '</optgroup>').join('');
  }
  function condForm(ideaId, F) {
    const f = F || { metric: 'roae', op: '>=', threshold: '', severity: 'watch', label: '' }, manual = f.metric === 'manual';
    return '<div class="ins-form" style="padding:12px 14px;border-top:1px solid var(--border-color)" data-idea="' + e(ideaId) + '">' +
      '<label class="ins-field">Chỉ tiêu<select id="ins-cf-metric" onchange="insThesisFormMetric(this.value)">' + metricOptions(f.metric) + '</select></label>' +
      (manual ? '' : '<label class="ins-field">Phép so<select id="ins-cf-op">' + TC.OPS.map((o) => '<option value="' + e(o) + '"' + (f.op === o ? ' selected' : '') + '>' + e(TC.OP_LABEL[o]) + '</option>').join('') + '</select></label>' +
        '<label class="ins-field">Ngưỡng<input type="text" inputmode="decimal" id="ins-cf-th" value="' + e(f.threshold) + '" placeholder="vd 15"></label>') +
      '<label class="ins-field">Mức độ<select id="ins-cf-sev"><option value="watch"' + (f.severity === 'watch' ? ' selected' : '') + '>Cần chú ý (cảnh báo)</option><option value="critical"' + (f.severity === 'critical' ? ' selected' : '') + '>Quan trọng (phá vỡ luận điểm)</option></select></label>' +
      '<label class="ins-field">' + (manual ? 'Mô tả sự kiện' : 'Ghi chú (tuỳ chọn)') + '<input type="text" id="ins-cf-label" maxlength="120" value="' + e(f.label || '') + '" placeholder="' + (manual ? 'vd Được cấp phép dự án X' : '') + '"></label>' +
      '<div style="display:flex;gap:8px"><button class="ins-btn sm" onclick="insThesisSave(\'' + e(ideaId) + '\')"><i class="fa-solid fa-check"></i> Lưu</button><button class="ins-btn ghost sm" onclick="insThesisForm(null)">Huỷ</button></div></div>';
  }
  function condRow(c, canEdit, now) {
    const m = TC.BY_KEY[c.metric] || {}, st = c.state || 'unknown';
    const val = st === 'unknown' || c.value === null || c.value === undefined ? (m.manual ? '' : '<span class="ins-muted">chưa có</span>') : e(U.dec(c.value, Math.abs(c.value) >= 1000 ? 0 : (m.unit === 'x' ? 2 : 1))) + (m.unit ? ' <span class="ins-muted">' + e(m.unit) + '</span>' : '');
    const checked = c.last_checked ? 'Máy chủ kiểm ' + U.ago(c.last_checked, now) + (c.state_since ? ' · ' + (st === 'unknown' ? 'từ' : 'trạng thái này từ') + ' ' + U.date(c.state_since) : '') : 'Máy chủ chưa kiểm lần nào (chạy 19:35 mỗi ngày làm việc)';
    const manual = m.manual ? '<span class="ins-seg" role="group" aria-label="Xác nhận sự kiện"><button aria-pressed="' + (c.manualMet === true) + '" onclick="insThesisManual(\'' + e(c.id) + '\',true)"' + (canEdit ? '' : ' disabled') + '>Đã xảy ra</button><button aria-pressed="' + (c.manualMet === false) + '" onclick="insThesisManual(\'' + e(c.id) + '\',false)"' + (canEdit ? '' : ' disabled') + '>Không</button><button aria-pressed="' + (c.manualMet === null || c.manualMet === undefined) + '" onclick="insThesisManual(\'' + e(c.id) + '\',null)"' + (canEdit ? '' : ' disabled') + '>Chưa rõ</button></span>' : '';
    return '<div class="ins-cond"><span class="st ' + st + '" title="' + e(STATE_TEXT[st]) + '"><i class="fa-solid ' + STATE_ICON[st] + '"></i></span>' +
      '<div><div>' + e(TC.describe(c)) + ' ' + (c.severity === 'critical' ? U.tag('Quan trọng', 'bad') : U.tag('Chú ý', 'muted')) + '</div><div class="meta">' + e(checked) + '</div>' + (manual ? '<div style="margin-top:6px">' + manual + '</div>' : '') + '</div>' +
      '<div class="val">' + val + '</div><div class="act">' + (canEdit ? '<button class="ins-btn ghost sm danger" title="Xoá điều kiện" onclick="insThesisDel(\'' + e(c.id) + '\')"><i class="fa-solid fa-trash"></i></button>' : '') + '</div></div>';
  }
  function ideaCard(it, S) {
    const idea = it.idea, ev = it.ev, canEdit = S.me && (S.me.isManager || S.me.isAdmin || S.me.actorId === idea.user_id);
    const stt = TC.STATUS[ev.status];
    const tone = ev.status === 'broken' ? 'bad' : (ev.status === 'warning' ? 'warn' : (ev.status === 'intact' ? 'ok' : 'muted'));
    const head = '<div class="ins-idea-head"><span class="sym">' + e(idea.symbol) + '</span>' + U.tag(stt.label, tone) + U.tag(IDEA_STATUS[idea.status] || idea.status, 'muted') + (idea.direction === 'avoid' ? U.tag('Tránh', 'warn') : '') +
      '<span class="ttl">' + e(idea.title) + ' <span class="ins-muted">· ' + e(S.data.members[idea.user_id] || '') + '</span></span>' +
      (ev.score !== null ? '<span class="ins-muted ins-num" title="Tỷ lệ điều kiện đang đúng trong số đã có số liệu">' + U.dec(ev.score * 100, 0) + '% đúng</span>' : '') +
      (canEdit ? '<button class="ins-btn ghost sm" onclick="insThesisForm(\'' + e(idea.id) + '\')"><i class="fa-solid fa-plus"></i> Điều kiện</button>' : '') + '</div>';
    const conds = ev.conditions.map((c) => condRow(c, canEdit, S.now)).join('');
    let form = '';
    if (S.formIdea === idea.id) {
      const sug = S.suggestions[idea.id] || [];
      form = (sug.length && !S.form ? '<div style="padding:10px 14px;border-top:1px solid var(--border-color)"><div class="ins-muted" style="font-size:.74rem;margin-bottom:6px">Gợi ý từ số liệu hiện tại (ngưỡng quanh giá trị đang có, hãy chỉnh theo luận điểm của bạn):</div><div style="display:flex;flex-wrap:wrap;gap:6px">' +
        sug.map((s, i) => '<button class="ins-btn ghost sm" onclick="insThesisSuggest(\'' + e(idea.id) + '\',' + i + ')"><i class="fa-solid fa-plus"></i> ' + e(TC.describe(s)) + (s.severity === 'critical' ? ' (quan trọng)' : '') + '</button>').join('') + '</div></div>' : '') + condForm(idea.id, S.form);
    }
    return '<article class="ins-idea ' + ev.status + '">' + head + (conds || (S.formIdea === idea.id ? '' : '<div class="ins-cond" style="grid-template-columns:1fr"><span class="ins-muted">Chưa có điều kiện nào. ' + (canEdit ? 'Bấm "Điều kiện" để thêm — hoặc dùng gợi ý từ số liệu hiện tại.' : '') + '</span></div>')) + form + '</article>';
  }
  function thesisHtml(S) {
    if (S.state === 'loading') return U.loading('Đang tải ý tưởng, điều kiện và số liệu hiện tại…');
    if (S.state === 'error') return U.card('list-check', 'Luận điểm', U.empty('triangle-exclamation', e(S.error)) + '<div style="text-align:center"><button class="ins-btn sm" onclick="insLoad(\'thesis\',true)"><i class="fa-solid fa-rotate"></i> Thử lại</button></div>');
    const items = S.items;
    const withC = items.filter((x) => x.ev.status !== 'none');
    const cnt = (s) => withC.filter((x) => x.ev.status === s).length;
    const controls = '<div class="ins-bar"><div class="ins-seg" role="group" aria-label="Phạm vi"><button aria-pressed="' + (S.scope === 'mine') + '" onclick="insThesisScope(\'mine\')">Của tôi</button><button aria-pressed="' + (S.scope === 'all') + '" onclick="insThesisScope(\'all\')">Cả nhóm</button></div>' +
      '<button class="ins-btn ghost sm" onclick="insLoad(\'thesis\',true)"><i class="fa-solid fa-rotate"></i> Tải lại</button>' +
      '<span class="ins-muted" style="font-size:.76rem">Số liệu thị trường tới ' + U.date(S.snapshotDate) + ' · máy chủ tự kiểm 19:35 mỗi ngày làm việc và email khi điều kiện QUAN TRỌNG bị phá vỡ (nếu bạn bật email cảnh báo)</span></div>';
    const k = U.kpis([U.kpi('Ý tưởng đang mở', String(items.length), withC.length + ' có điều kiện'), U.kpi('Bị phá vỡ', String(cnt('broken')), 'điều kiện quan trọng đang sai', cnt('broken') ? 'bad' : 'good'), U.kpi('Cần chú ý', String(cnt('warning')), 'điều kiện thường đang sai', cnt('warning') ? 'warn' : 'good'), U.kpi('Còn nguyên', String(cnt('intact')), ''), U.kpi('Chưa đặt điều kiện', String(items.length - withC.length), 'thêm điều kiện để được theo dõi', items.length - withC.length ? 'warn' : '')]);
    if (!items.length) return controls + U.card('list-check', 'Luận điểm', U.empty('lightbulb', S.scope === 'mine' ? 'Bạn chưa có ý tưởng đang mở. Tạo ý tưởng ở trang Nghiên Cứu → Ý tưởng, rồi quay lại đây đặt điều kiện đo được cho luận điểm.' : 'Chưa có ý tưởng đang mở trong nhóm.'));
    const cards = items.map((it) => ideaCard(it, S)).join('');
    const logRows = S.logRows.map((l) => '<tr><td>' + U.date(l.at) + '</td><td class="t"><b>' + e(l.symbol) + '</b> ' + e(l.text) + '</td><td>' + (l.from ? U.tag(l.from === 'ok' ? 'đúng' : 'sai', l.from === 'ok' ? 'ok' : 'bad') + ' → ' : '') + U.tag(l.to === 'ok' ? 'đúng' : 'sai', l.to === 'ok' ? 'ok' : 'bad') + '</td></tr>').join('');
    return controls + k + cards + U.card('clock-rotate-left', 'Lần đổi trạng thái gần đây', S.logRows.length ? U.table(['Ngày', 'Điều kiện', 'Chuyển'], [logRows], { left: [1] }) : U.empty('clock-rotate-left', 'Chưa có điều kiện nào đổi trạng thái. Nhật ký này do máy chủ ghi khi điều kiện chuyển giữa đúng và sai.')) +
      U.note('<b>Cách dùng:</b> điều kiện là trạng thái PHẢI GIỮ ĐÚNG để luận điểm còn nguyên (vd "ROE ≥ 15%", "nợ/vốn ≤ 1", "giá ≥ giá cắt lỗ"). Điều kiện <b>quan trọng</b> sai = luận điểm bị phá vỡ; điều kiện <b>chú ý</b> sai = cảnh báo. Thiếu số liệu thì là "chưa có số liệu" — không bị coi là đúng hay sai. Dùng "sự kiện tự xác nhận" cho việc không đo tự động được.');
  }

  // ---------- Sở hữu ----------
  function ownershipHtml(S) {
    if (S.state === 'loading') return U.loading('Đang tải dữ liệu sở hữu…');
    if (S.state === 'error') return U.card('user-tie', 'Sở hữu', U.empty('triangle-exclamation', e(S.error)) + '<div style="text-align:center"><button class="ins-btn sm" onclick="insLoad(\'ownership\',true)"><i class="fa-solid fa-rotate"></i> Thử lại</button></div>');
    const controls = '<div class="ins-bar"><label class="ins-field">Tra cứu mã<input type="text" id="ins-own-sym" maxlength="12" placeholder="FPT" value="' + e(S.lookup || '') + '" onkeydown="if(event.key===\'Enter\')insOwnSelect(this.value)"></label>' +
      '<button class="ins-btn sm" onclick="insOwnSelect(document.getElementById(\'ins-own-sym\').value)"><i class="fa-solid fa-magnifying-glass"></i> Xem</button>' +
      '<button class="ins-btn ghost sm" onclick="insOwnSyncAll()"' + (S.syncing ? ' disabled' : '') + '><i class="fa-solid ' + (S.syncing ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-down') + '"></i> Đồng bộ các mã đang giữ / theo dõi</button>' +
      '<span class="ins-muted" style="font-size:.76rem">Máy chủ tự đồng bộ 19:15 mỗi ngày làm việc cho mã đang giữ, theo dõi và có ý tưởng mở</span></div>';
    const rows = S.rows.map((r) => {
      const sg = r.ins.signal, tone = sg === 'buy' ? 'ok' : (sg === 'sell' ? 'bad' : 'muted');
      return '<tr class="' + (S.sel === r.symbol ? 'sel' : '') + '"><td><button class="ins-link" onclick="insOwnSelect(\'' + e(r.symbol) + '\')"><b>' + e(r.symbol) + '</b></button>' + (r.held ? ' ' + U.tag('Đang giữ', 'muted') : '') + '</td>' +
        '<td>' + (r.room === null ? '<span class="ins-muted">—</span>' : U.dec(r.room, 1) + '% ' + U.tag(r.band.label, r.band.key === 'full' ? 'bad' : (r.band.key === 'tight' ? 'warn' : 'ok'))) + '</td>' +
        '<td>' + (r.synced ? U.tag(sg === 'buy' ? 'Mua ròng' : (sg === 'sell' ? 'Bán ròng' : (sg === 'neutral' ? 'Cân bằng' : 'Không có')), tone) + (r.ins.cluster ? ' ' + U.tag('Mua đồng loạt', 'ok') : '') : '<span class="ins-muted">chưa đồng bộ</span>') + '</td>' +
        '<td class="' + U.sign(r.ins.netQty) + '">' + (r.synced ? (r.ins.netQty > 0 ? '+' : '') + U.int(r.ins.netQty) : '—') + '</td><td>' + (r.synced && r.ins.pendingBuy + r.ins.pendingSell > 0 ? (r.ins.pendingBuy ? '<span class="ins-up">mua ' + U.int(r.ins.pendingBuy) + '</span> ' : '') + (r.ins.pendingSell ? '<span class="ins-down">bán ' + U.int(r.ins.pendingSell) + '</span>' : '') : '—') + '</td>' +
        '<td>' + (r.ins.last ? U.date(r.ins.last) : '—') + '</td><td>' + (r.syncedAt ? U.ago(r.syncedAt, S.now) : '—') + '</td></tr>';
    }).join('');
    const list = S.rows.length ? U.table(['Mã', 'Phòng khối ngoại còn', 'Nội bộ 90 ngày', 'Mua/bán ròng (cp)', 'Đăng ký còn hiệu lực', 'Công bố gần nhất', 'Đồng bộ'], [rows], { left: [0] }) : U.empty('user-tie', 'Chưa có mã nào đang giữ hoặc theo dõi. Nhập một mã ở ô "Tra cứu mã" để xem.');
    return controls + U.card('user-tie', 'Mã đang giữ và theo dõi', list + U.note('<b>Cách đọc:</b> giao dịch nội bộ là thông tin CÔNG BỐ. Người ra thông báo <b>đăng ký</b> mua/bán rồi mới thực hiện; chỉ giao dịch đã <b>thực hiện xong</b> mới tính vào mua/bán ròng, đăng ký còn hiệu lực hiển thị riêng. Lãnh đạo mua có thể là tín hiệu tích cực, nhưng bán thường vì nhiều lý do không liên quan đến triển vọng (thuế, trả nợ, chia tài sản). Phòng khối ngoại lấy từ VNDirect.')) + detailHtml(S);
  }
  function detailHtml(S) {
    const d = S.detail;
    if (!S.sel) return '';
    if (S.detailState === 'loading') return U.loading('Đang tải ' + S.sel + '…');
    if (!d) return '';
    const synced = d.sync && d.sync.ok;
    const conc = OC.concentration(d.holders.map((h) => ({ pct: h.pct === null ? null : Number(h.pct), publicDate: h.public_date })), S.today, 730);
    const trades = d.trades.map((t) => ({ id: t.id, trader: t.trader, action: t.action, status: t.status, before: t.shares_before === null ? null : Number(t.shares_before), after: t.shares_after === null ? null : Number(t.shares_after), registered: t.registered === null ? null : Number(t.registered), acquired: t.acquired === null ? null : Number(t.acquired), endDate: t.end_date, publicDate: t.public_date }));
    const s30 = OC.summarize(trades, S.today, 30), s90 = OC.summarize(trades, S.today, 90), s365 = OC.summarize(trades, S.today, 365);
    const room = d.ratios && d.ratios.foreignRoomLeftPct !== undefined && d.ratios.foreignRoomLeftPct !== null ? Number(d.ratios.foreignRoomLeftPct) : null, band = OC.roomBand(room);
    const net = (s) => '<span class="' + U.sign(s.netQty) + '">' + (s.netQty > 0 ? '+' : '') + U.int(s.netQty) + '</span>';
    const k = U.kpis([
      U.kpi('Nội bộ 30 ngày', net(s30) + ' cp', s30.buyers + ' người mua · ' + s30.sellers + ' người bán'),
      U.kpi('Nội bộ 90 ngày', net(s90) + ' cp', (s90.cluster ? 'MUA ĐỒNG LOẠT · ' : '') + s90.buyers + ' người mua · ' + s90.sellers + ' người bán', s90.cluster ? 'good' : ''),
      U.kpi('Nội bộ 12 tháng', net(s365) + ' cp', s365.trades + ' giao dịch công bố'),
      U.kpi('Phòng khối ngoại còn', room === null ? '—' : U.dec(room, 1) + '%', band.label, band.key === 'full' ? 'bad' : (band.key === 'tight' ? 'warn' : '')),
      U.kpi('Cổ đông ≥ 5%', conc.majorCount + ' · ' + U.dec(conc.majorPct, 1) + '%', 'top 3 nắm ' + U.dec(conc.top3Pct, 1) + '%' + (conc.stale ? ' · ' + conc.stale + ' dòng số cũ bị bỏ' : '')),
    ]);
    const holders = d.holders.map((h) => '<tr><td class="t"><b>' + e(h.owner_name) + '</b>' + (h.position ? ' <span class="ins-muted">· ' + e(h.position) + '</span>' : '') + '</td><td>' + (h.pct === null ? '—' : U.dec(Number(h.pct), 2) + '%') + '</td><td>' + (h.quantity === null ? '—' : U.int(h.quantity)) + '</td><td>' + U.date(h.public_date) + '</td></tr>').join('');
    const tr = d.trades.slice(0, 25).map((t) => '<tr><td>' + U.date(t.public_date) + '</td><td class="t"><b>' + e(t.trader || '') + '</b>' + (t.position ? ' <span class="ins-muted">· ' + e(t.position) + '</span>' : '') + '</td><td>' + U.tag(t.action === 'B' ? 'Mua' : 'Bán', t.action === 'B' ? 'ok' : 'bad') + ' ' + U.tag(t.status === 'done' ? 'Đã thực hiện' : (t.status === 'registered' ? 'Đăng ký' : 'Khác'), t.status === 'done' ? '' : 'muted') + '</td><td>' + (t.status === 'done' ? U.int(Math.abs(Number(t.acquired || 0))) : '(' + U.int(Math.abs(Number(t.registered || 0))) + ')') + '</td><td>' + (t.pct_after === null ? '—' : U.dec(Number(t.pct_after), 2) + '%') + '</td></tr>').join('');
    const hint = !synced ? U.note('Mã này chưa được đồng bộ' + (d.sync && !d.sync.ok ? ' (lần gần nhất lỗi: ' + e(d.sync.note || 'không rõ') + ')' : '') + '. <button class="ins-link" onclick="insOwnSync(\'' + e(d.symbol) + '\')">Đồng bộ ' + e(d.symbol) + ' ngay</button>', 'warn') : '<p class="tl-hint">Đồng bộ ' + U.ago(d.sync.synced_at, S.now) + '. <button class="ins-link" onclick="insOwnSync(\'' + e(d.symbol) + '\')">Làm mới</button></p>';
    return U.card('magnifying-glass', 'Chi tiết ' + d.symbol, hint + k + '<div class="ins-grid even">' + U.card('users', 'Cổ đông lớn đã công bố', d.holders.length ? U.table(['Cổ đông', 'Tỷ lệ', 'Số cổ phiếu', 'Công bố'], [holders], { left: [0] }) : U.empty('users', 'Chưa có dữ liệu cổ đông.')) +
      U.card('right-left', 'Giao dịch nội bộ gần đây (' + d.trades.length + ' trong 12 tháng)', d.trades.length ? U.table(['Công bố', 'Người giao dịch', 'Loại', 'Khối lượng', 'Tỷ lệ sau'], [tr], { left: [1] }) + '<p class="tl-hint">Khối lượng trong ngoặc là số đăng ký (chưa chắc thực hiện).</p>' : U.empty('right-left', 'Chưa có giao dịch nội bộ được công bố trong 12 tháng qua.')) + '</div>');
  }

  return { thesisHtml, ownershipHtml, detailHtml, condForm, metricOptions, IDEA_STATUS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = InsViewsB;
