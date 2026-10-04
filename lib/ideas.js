// Logic thuần: quy trình nghiên cứu và ý tưởng đầu tư của nhóm -- trạng thái, ai được chuyển trạng thái nào, mức đầy đủ của hồ sơ trước khi đưa ra phản biện,
// kết quả của ý tưởng (so với VN-Index), bảng thành tích theo thành viên, kiểm phiếu. KHÔNG đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global IdeaFlow) và module.exports cho Vitest.
//
// Đường đi: idea (ý tưởng) -> research (đang nghiên cứu) -> review (chờ phản biện) -> approved (đã duyệt) | rejected (bị bác) -> in_portfolio (đã vào danh mục) -> closed (đã đóng).
// Nguyên tắc: tác giả tự đưa ý tưởng đi tới "chờ phản biện" (phải đủ hồ sơ); chỉ quản lý danh mục duyệt/bác (bác phải có lý do; tự duyệt ý tưởng của chính mình được phép nhưng bắt
// buộc ghi lý do và bị đánh dấu); mọi ý tưởng đều theo dõi kết quả so với VN-Index kể từ ngày ghi nhận giá vào, kể cả bị bác (để biết quyết định bác đúng hay sai).
const IdeaFlow = (function () {
  const STATUSES = {
    idea:         { label: 'Ý tưởng',          tone: 'mute', order: 0 },
    research:     { label: 'Đang nghiên cứu',  tone: 'info', order: 1 },
    review:       { label: 'Chờ phản biện',    tone: 'warn', order: 2 },
    approved:     { label: 'Đã duyệt',         tone: 'ok',   order: 3 },
    rejected:     { label: 'Bị bác',           tone: 'bad',  order: 4 },
    in_portfolio: { label: 'Đã vào danh mục',  tone: 'ok',   order: 5 },
    closed:       { label: 'Đã đóng',          tone: 'mute', order: 6 },
  };
  const OPEN_STATUSES = ['idea', 'research', 'review', 'approved', 'in_portfolio'];
  const CLOSE_REASONS = { target: 'Đạt mục tiêu', stop: 'Chạm cắt lỗ', thesis_broken: 'Luận điểm không còn đúng', time: 'Hết thời hạn', other: 'Lý do khác' };
  const COMMENT_KINDS = { comment: 'Bình luận', challenge: 'Phản biện', answer: 'Trả lời' };
  const VOTES = { for: 'Ủng hộ', against: 'Phản đối', abstain: 'Trung lập' };

  // from -> { to -> 'author' | 'manager' | 'either' }
  const TRANSITIONS = {
    idea:         { research: 'author', closed: 'either' },
    research:     { review: 'author', idea: 'author', closed: 'either' },
    review:       { approved: 'manager', rejected: 'manager', research: 'either', closed: 'either' },
    approved:     { in_portfolio: 'either', research: 'either', closed: 'either' },
    rejected:     { research: 'author', closed: 'either' },
    in_portfolio: { closed: 'either' },
    closed:       {},
  };

  const MIN_READINESS_TO_REVIEW = 70;

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function opt(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; }
  function iso(v) { return String(v || '').slice(0, 10); }
  function daysBetween(a, b) { return Math.max(0, Math.round((Date.parse(iso(b) + 'T00:00:00Z') - Date.parse(iso(a) + 'T00:00:00Z')) / 86400000)); }
  function addMonths(isoDate, months) { const d = new Date(iso(isoDate) + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); }

  // Dòng DB -> dạng chuẩn
  function normalize(row) {
    const r = row || {};
    return {
      id: r.id || null, userId: r.user_id || r.userId || null, symbol: String(r.symbol || '').toUpperCase(), title: String(r.title || ''),
      direction: r.direction === 'avoid' ? 'avoid' : 'long', status: STATUSES[r.status] ? r.status : 'idea',
      thesis: String(r.thesis || ''), catalysts: String(r.catalysts || ''), risks: String(r.risks || ''),
      entry: opt(r.entry_price !== undefined ? r.entry_price : r.entry), indexEntry: opt(r.index_at_entry !== undefined ? r.index_at_entry : r.indexEntry),
      buyBelow: opt(r.buy_below !== undefined ? r.buy_below : r.buyBelow), target: opt(r.target_price !== undefined ? r.target_price : r.target),
      stop: opt(r.stop_price !== undefined ? r.stop_price : r.stop), horizonMonths: opt(r.horizon_months !== undefined ? r.horizon_months : r.horizonMonths),
      conviction: opt(r.conviction), valuation: r.valuation || null, tags: Array.isArray(r.tags) ? r.tags.slice() : [],
      submittedAt: r.submitted_at || null, decidedAt: r.decided_at || null, decidedBy: r.decided_by || null, decisionNote: String(r.decision_note || ''),
      closedAt: r.closed_at || null, closePrice: opt(r.close_price), indexClose: opt(r.index_at_close), closeReason: r.close_reason || null, closeNote: String(r.close_note || ''),
      statusChangedAt: r.status_changed_at || null, createdAt: r.created_at || null, updatedAt: r.updated_at || null,
    };
  }

  // Kiểm tra dữ liệu khi tạo/sửa (chưa tính mức đầy đủ để gửi phản biện)
  function validate(input) {
    const i = normalize(input);
    if (!/^[A-Z0-9]{1,12}$/.test(i.symbol)) return { ok: false, error: 'Mã cổ phiếu không hợp lệ' };
    if (i.title.trim().length < 3) return { ok: false, error: 'Nhập tiêu đề ý tưởng (ít nhất 3 ký tự)' };
    if (i.entry !== null && !(i.entry > 0)) return { ok: false, error: 'Giá ghi nhận phải lớn hơn 0' };
    ['buyBelow', 'target', 'stop'].forEach(function (k) { if (i[k] !== null && !(i[k] > 0)) i['__bad'] = k; });
    if (i.__bad) return { ok: false, error: 'Giá mục tiêu, giá muốn mua và cắt lỗ phải lớn hơn 0' };
    if (i.direction === 'long') {
      const ref = i.entry;
      if (ref && i.target !== null && i.target <= ref) return { ok: false, error: 'Ý tưởng mua: giá mục tiêu phải cao hơn giá ghi nhận' };
      if (ref && i.stop !== null && i.stop >= ref) return { ok: false, error: 'Ý tưởng mua: ngưỡng cắt lỗ phải thấp hơn giá ghi nhận' };
      if (i.buyBelow !== null && i.target !== null && i.buyBelow >= i.target) return { ok: false, error: 'Giá muốn mua phải thấp hơn giá mục tiêu' };
    }
    if (i.horizonMonths !== null && !(i.horizonMonths >= 1 && i.horizonMonths <= 120)) return { ok: false, error: 'Thời hạn từ 1 đến 120 tháng' };
    if (i.conviction !== null && !(i.conviction >= 1 && i.conviction <= 5)) return { ok: false, error: 'Mức tự tin từ 1 đến 5' };
    delete i.__bad;
    return { ok: true, idea: i };
  }

  // Mức đầy đủ của hồ sơ 0-100 + phần còn thiếu. canSubmit = đủ phần BẮT BUỘC (luận điểm, mục tiêu, rủi ro) và >= MIN_READINESS_TO_REVIEW.
  function readiness(idea) {
    const i = idea.thesis !== undefined && idea.entry !== undefined ? idea : normalize(idea);
    const parts = [
      { key: 'thesis', label: 'luận điểm (≥ 60 ký tự)', w: 30, ok: i.thesis.trim().length >= 60, required: true },
      { key: 'target', label: 'giá mục tiêu', w: 20, ok: i.target !== null && i.target > 0, required: true },
      { key: 'risks', label: 'rủi ro chính (≥ 20 ký tự)', w: 15, ok: i.risks.trim().length >= 20, required: true },
      { key: 'stop', label: 'ngưỡng cắt lỗ / điều kiện sai', w: 15, ok: i.stop !== null && i.stop > 0 },
      { key: 'horizon', label: 'thời hạn', w: 10, ok: i.horizonMonths !== null },
      { key: 'catalysts', label: 'chất xúc tác', w: 5, ok: i.catalysts.trim().length >= 10 },
      { key: 'valuation', label: 'định giá đính kèm', w: 5, ok: !!i.valuation },
    ];
    const score = parts.reduce(function (s, p) { return s + (p.ok ? p.w : 0); }, 0);
    const missing = parts.filter(function (p) { return !p.ok; }).map(function (p) { return p.label; });
    const requiredMissing = parts.filter(function (p) { return p.required && !p.ok; }).map(function (p) { return p.label; });
    return { score: score, missing: missing, requiredMissing: requiredMissing, canSubmit: !requiredMissing.length && score >= MIN_READINESS_TO_REVIEW };
  }

  // Ai được làm gì. actor: { userId, isManager }. Trả { ok, error, patch } -- patch là các cột cần ghi (chưa gồm updated_at).
  function transition(idea, to, actor, data) {
    const i = idea.thesis !== undefined && idea.entry !== undefined ? idea : normalize(idea);
    const d = data || {};
    const rule = (TRANSITIONS[i.status] || {})[to];
    if (!rule) return { ok: false, error: `Không thể chuyển từ “${STATUSES[i.status].label}” sang “${STATUSES[to] ? STATUSES[to].label : to}”` };
    const isAuthor = !!actor && actor.userId && actor.userId === i.userId;
    const isManager = !!(actor && actor.isManager);
    const allowed = rule === 'author' ? isAuthor : (rule === 'manager' ? isManager : (isAuthor || isManager));
    if (!allowed) return { ok: false, error: rule === 'manager' ? 'Chỉ quản lý danh mục được duyệt hoặc bác ý tưởng' : (rule === 'author' ? 'Chỉ tác giả được thực hiện bước này' : 'Chỉ tác giả hoặc quản lý được thực hiện bước này') };
    const note = String(d.note || '').trim();
    const patch = { status: to, status_changed_at: d.now || new Date().toISOString() };

    if (to === 'review') {
      const r = readiness(i);
      if (!r.canSubmit) return { ok: false, error: 'Chưa đủ hồ sơ để đưa ra phản biện — còn thiếu: ' + (r.requiredMissing.length ? r.requiredMissing.join(', ') : r.missing.join(', ')) + ` (đạt ${r.score}/${MIN_READINESS_TO_REVIEW} điểm)` };
      patch.submitted_at = patch.status_changed_at;
    } else if (to === 'approved' || to === 'rejected') {
      const selfDecision = isAuthor;
      if (to === 'rejected' && note.length < 3) return { ok: false, error: 'Bác ý tưởng phải ghi lý do' };
      if (selfDecision && note.length < 3) return { ok: false, error: 'Tự duyệt ý tưởng của chính mình phải ghi rõ lý do (và nên có người khác phản biện trước)' };
      patch.decided_at = patch.status_changed_at; patch.decided_by = actor.userId;
      patch.decision_note = (selfDecision ? '[Tự duyệt] ' : '') + note;
    } else if (to === 'closed') {
      if (!CLOSE_REASONS[d.reason]) return { ok: false, error: 'Chọn lý do đóng ý tưởng' };
      patch.close_reason = d.reason; patch.close_note = note || null; patch.closed_at = iso(patch.status_changed_at);
      if (opt(d.closePrice) !== null) patch.close_price = opt(d.closePrice);
      if (opt(d.indexClose) !== null) patch.index_at_close = opt(d.indexClose);
    } else if (to === 'research' && (i.status === 'review' || i.status === 'rejected' || i.status === 'approved')) {
      // Quay lại nghiên cứu: xoá kết quả duyệt/bác cũ để vòng phản biện sau bắt đầu lại
      patch.decided_at = null; patch.decided_by = null; patch.decision_note = note ? note : null; patch.submitted_at = null;
    }
    return { ok: true, patch: patch };
  }

  // Kết quả ý tưởng. ctx: { nowPrice, indexNow, today }. Ý tưởng "tránh": đúng khi giá giảm / kém chỉ số.
  function evaluate(idea, ctx) {
    const i = idea.thesis !== undefined && idea.entry !== undefined ? idea : normalize(idea);
    const c = ctx || {};
    const today = iso(c.today || new Date().toISOString());
    const out = { status: 'nodata', direction: i.direction };
    if (!(i.entry > 0)) return out;
    const closed = i.status === 'closed' && i.closePrice > 0;
    const end = closed ? i.closePrice : opt(c.nowPrice);
    if (!(end > 0)) return out;
    const sign = i.direction === 'avoid' ? -1 : 1;
    const startDate = iso(i.createdAt) || today;
    const endDate = closed && i.closedAt ? iso(i.closedAt) : today;
    out.status = closed ? 'closed' : 'open';
    out.end = end; out.priceReturnPct = (end / i.entry - 1) * 100; out.returnPct = sign * out.priceReturnPct;
    out.days = daysBetween(startDate, endDate);
    const idxEnd = closed ? i.indexClose : opt(c.indexNow);
    if (i.indexEntry > 0 && idxEnd > 0) {
      out.indexPct = (idxEnd / i.indexEntry - 1) * 100;
      out.alphaPct = sign * (out.priceReturnPct - out.indexPct);
    } else { out.indexPct = null; out.alphaPct = null; }
    if (i.direction === 'long' && i.target > i.entry) out.progressPct = (end - i.entry) / (i.target - i.entry) * 100;
    out.aboveTarget = i.direction === 'long' && i.target > 0 && end >= i.target;
    out.belowStop = i.direction === 'long' && i.stop > 0 && end <= i.stop;
    const horizonEnd = i.horizonMonths > 0 ? addMonths(startDate, i.horizonMonths) : null;
    out.horizonEnd = horizonEnd; out.overdue = !closed && !!horizonEnd && today > horizonEnd;
    out.win = out.returnPct > 0;
    return out;
  }

  // Bảng thành tích theo tác giả. ideas đã normalize; evals: { [id]: evaluate }. members: { [userId]: tên } (tuỳ chọn).
  function scoreboard(ideas, evals, members) {
    const by = {};
    (ideas || []).forEach(function (i) {
      const a = by[i.userId] || (by[i.userId] = { userId: i.userId, name: (members && members[i.userId]) || 'Thành viên', total: 0, byStatus: {}, approved: 0, rejected: 0, closed: 0, closedWins: 0, closedEdges: [], closedAlphas: [], openEdges: [], openAlphas: [], days: [] });
      a.total++; a.byStatus[i.status] = (a.byStatus[i.status] || 0) + 1;
      if (i.status === 'rejected') a.rejected++;
      if (i.decidedAt && i.status !== 'rejected') a.approved++;
      const e = evals && evals[i.id];
      if (!e || e.status === 'nodata') return;
      if (e.status === 'closed') { a.closed++; if (e.win) a.closedWins++; a.closedEdges.push(e.returnPct); if (e.alphaPct !== null) a.closedAlphas.push(e.alphaPct); a.days.push(e.days); }
      else if (OPEN_STATUSES.indexOf(i.status) !== -1 || i.status === 'rejected') { a.openEdges.push(e.returnPct); if (e.alphaPct !== null) a.openAlphas.push(e.alphaPct); }
    });
    const mean = function (x) { return x.length ? x.reduce(function (s, v) { return s + v; }, 0) / x.length : null; };
    return Object.keys(by).map(function (k) {
      const a = by[k];
      const decided = a.approved + a.rejected;
      return {
        userId: a.userId, name: a.name, total: a.total, byStatus: a.byStatus, approved: a.approved, rejected: a.rejected, closed: a.closed,
        approvalRatePct: decided ? a.approved / decided * 100 : null,
        winRatePct: a.closed ? a.closedWins / a.closed * 100 : null, avgClosedReturnPct: mean(a.closedEdges), avgClosedAlphaPct: mean(a.closedAlphas),
        avgOpenReturnPct: mean(a.openEdges), avgOpenAlphaPct: mean(a.openAlphas), avgDaysClosed: mean(a.days),
        open: a.total - a.closed,
      };
    }).sort(function (x, y) { return y.total - x.total; });
  }

  // Kiểm phiếu
  function voteTally(votes) {
    const t = { for: 0, against: 0, abstain: 0, total: 0 };
    (votes || []).forEach(function (v) { if (t[v.vote] !== undefined) { t[v.vote]++; t.total++; } });
    const decisive = t.for + t.against;
    t.supportPct = decisive ? t.for / decisive * 100 : null;
    t.leaning = !decisive ? 'none' : (t.for > t.against ? 'for' : (t.against > t.for ? 'against' : 'split'));
    return t;
  }

  // Phản biện chưa được tác giả trả lời: phản biện mà SAU nó chưa có "trả lời" của tác giả
  function openChallenges(comments, authorId) {
    const list = (comments || []).slice().sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; });
    const open = [];
    list.forEach(function (c) {
      if (c.kind === 'challenge') open.push(c);
      else if (c.kind === 'answer' && c.user_id === authorId && open.length) open.shift();
    });
    return open;
  }

  return { STATUSES, OPEN_STATUSES, CLOSE_REASONS, COMMENT_KINDS, VOTES, TRANSITIONS, MIN_READINESS_TO_REVIEW, normalize, validate, readiness, transition, evaluate, scoreboard, voteTally, openChallenges };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = IdeaFlow;
