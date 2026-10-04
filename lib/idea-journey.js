// Logic thuần: HÀNH TRÌNH Ý TƯỞNG -- theo một ý tưởng từ lúc đề xuất -> quản lý duyệt/bác -> đề xuất lệnh -> duyệt lệnh -> ghi lệnh -> kết quả (so với VN-Index), rồi tổng hợp cho cả nhóm để
// thấy QUY TRÌNH nào cho kết quả tốt: bao nhiêu ý tưởng đi tới được danh mục, mất bao lâu, ý tưởng đã duyệt mà không ai thực hiện lẽ ra lãi hay lỗ, ý tưởng bị bác sau đó đi đâu
// (người gác cổng duyệt đúng hay sai). Mọi con số đều kèm cỡ mẫu và chỉ kết luận khi đủ mẫu.
// Nối ý tưởng với lệnh qua (1) finance_order_requests.idea_id + txn_id (chắc chắn) và (2) nếu chưa có đề xuất liên kết: các lệnh MUA cùng mã của thành viên SAU ngày duyệt (suy đoán, gắn nhãn).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global IdeaJourney) và module.exports cho Vitest.
const IdeaJourney = (function () {
  const MIN_N = 4;          // dưới ngần này ý tưởng cùng nhóm thì không rút kết luận so sánh
  const IDLE_DAYS = 14;     // duyệt xong quá ngần này ngày mà chưa ai thực hiện -> "treo"
  const STUCK_DAYS = 3;     // đề xuất lệnh chờ duyệt quá ngần này ngày -> "kẹt"

  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const iso = (v) => String(v || '').slice(0, 10);
  const days = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(iso(b) + 'T00:00:00Z') - Date.parse(iso(a) + 'T00:00:00Z')) / 86400000)) : null);
  const median = (xs) => { const a = xs.filter((v) => v !== null && v !== undefined && isFinite(v)).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const mean = (xs) => { const a = xs.filter((v) => v !== null && v !== undefined && isFinite(v)); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };

  const PATHS = {
    pending:  { label: 'Chưa quyết định' },
    rejected: { label: 'Bị bác' },
    idle:     { label: 'Đã duyệt, chưa thực hiện' },
    executed: { label: 'Đã thực hiện' },
  };

  // input: { ideas: [IdeaFlow.normalize], requests: [finance_order_requests], txns: [finance_transactions chưa xoá], evals: { [ideaId]: IdeaFlow.evaluate }, today }
  function build(input) {
    const x = input || {};
    const today = iso(x.today || new Date().toISOString());
    const txns = (x.txns || []).filter((t) => !t.deleted_at);
    const txnById = {}; txns.forEach((t) => { txnById[String(t.id)] = t; });
    const reqsByIdea = {}; (x.requests || []).forEach((r) => { if (r.idea_id) (reqsByIdea[r.idea_id] = reqsByIdea[r.idea_id] || []).push(r); });
    const linkedTxn = new Set((x.requests || []).filter((r) => r.txn_id).map((r) => String(r.txn_id)));

    const rows = (x.ideas || []).map((i) => {
      const reqs = (reqsByIdea[i.id] || []).slice().sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : 1));
      const decided = !!i.decidedAt && i.status !== 'rejected';
      const rejected = i.status === 'rejected';
      // Lệnh đã ghi gắn qua đề xuất
      const executedReqs = reqs.filter((r) => r.status === 'executed' && r.txn_id && txnById[String(r.txn_id)]);
      let execTxns = executedReqs.map((r) => txnById[String(r.txn_id)]);
      let inferred = false;
      if (!execTxns.length && decided && i.direction === 'long' && i.decidedAt) {
        // suy đoán: lệnh MUA cùng mã sau ngày duyệt, chưa gắn với đề xuất nào
        execTxns = txns.filter((t) => t.type === 'buy' && String(t.symbol).toUpperCase() === i.symbol && iso(t.trade_date) >= iso(i.decidedAt) && !linkedTxn.has(String(t.id)));
        inferred = execTxns.length > 0;
      }
      const executed = i.direction === 'long' && execTxns.length > 0;
      const firstExec = execTxns.reduce((m, t) => (!m || iso(t.trade_date) < m ? iso(t.trade_date) : m), null);
      const execValue = execTxns.reduce((s, t) => s + num(t.quantity) * num(t.price), 0);
      const buyers = new Set(execTxns.map((t) => t.user_id)).size;
      const path = rejected ? 'rejected' : (executed ? 'executed' : (decided ? 'idle' : 'pending'));
      const e = (x.evals && x.evals[i.id]) || { status: 'nodata' };
      const hasEval = e.status !== 'nodata' && e.returnPct !== undefined;
      const sinceDecision = i.decidedAt ? days(i.decidedAt, today) : null;
      const flags = [];
      if (path === 'idle' && i.status !== 'closed' && sinceDecision !== null && sinceDecision >= IDLE_DAYS) flags.push('idle');
      if (reqs.some((r) => r.status === 'pending' && days(r.created_at, today) >= STUCK_DAYS)) flags.push('stuck');
      if (i.status === 'in_portfolio' && !executed && i.direction === 'long') flags.push('no_trade_found');
      return {
        id: i.id, symbol: i.symbol, title: i.title, direction: i.direction, userId: i.userId, status: i.status, path, inferred, flags,
        stages: { proposedAt: i.submittedAt || i.createdAt, decidedAt: i.decidedAt, decidedBy: i.decidedBy, requestedAt: reqs.length ? reqs[0].created_at : null, requestCount: reqs.length, firstExecAt: firstExec, closedAt: i.closedAt },
        days: { toDecide: days(i.submittedAt || i.createdAt, i.decidedAt), toRequest: days(i.decidedAt, reqs.length ? reqs[0].created_at : null), toExecute: days(i.decidedAt, firstExec), sinceDecision },
        exec: { count: execTxns.length, buyers, value: execValue },
        result: hasEval ? { returnPct: e.returnPct, alphaPct: e.alphaPct, indexPct: e.indexPct, win: !!e.win, closed: e.status === 'closed', days: e.days } : null,
        approvalRequests: reqs.map((r) => ({ id: r.id, status: r.status, value: num(r.value), createdAt: r.created_at, txnId: r.txn_id || null })),
      };
    });
    return { rows, summary: summarize(rows), today };
  }

  function groupStats(list) {
    const withR = list.filter((r) => r.result);
    const alphas = withR.map((r) => r.result.alphaPct).filter((v) => v !== null && v !== undefined);
    return { n: list.length, withResult: withR.length, avgReturn: mean(withR.map((r) => r.result.returnPct)), avgAlpha: mean(alphas), alphaN: alphas.length, winRate: withR.length ? withR.filter((r) => r.result.win).length / withR.length * 100 : null };
  }

  function summarize(rows) {
    const total = rows.length;
    const proposed = rows.filter((r) => r.stages.proposedAt && r.status !== 'idea' && r.status !== 'research').length;      // đã đưa ra phản biện / quyết định
    const decided = rows.filter((r) => r.stages.decidedAt || r.path === 'rejected').length;
    const approved = rows.filter((r) => r.path === 'idle' || r.path === 'executed').length;
    const executed = rows.filter((r) => r.path === 'executed').length;
    const rejected = rows.filter((r) => r.path === 'rejected').length;
    const closed = rows.filter((r) => r.status === 'closed').length;
    const by = { pending: [], rejected: [], idle: [], executed: [] };
    rows.forEach((r) => by[r.path].push(r));
    const stats = {}; Object.keys(by).forEach((k) => { stats[k] = groupStats(by[k]); });
    const timing = { toDecide: median(rows.map((r) => r.days.toDecide)), toRequest: median(rows.map((r) => r.days.toRequest)), toExecute: median(rows.map((r) => r.days.toExecute)) };
    const insights = [];
    const a = stats.executed, b = stats.idle, c = stats.rejected;
    const enough = (s) => s.alphaN >= MIN_N;
    if (enough(a) && enough(b) && a.avgAlpha !== null && b.avgAlpha !== null) {
      const d = b.avgAlpha - a.avgAlpha;
      if (d > 2) insights.push({ tone: 'warn', text: `Ý tưởng đã duyệt nhưng CHƯA ai thực hiện (${b.alphaN} ý tưởng) đang vượt VN-Index ${fmt(b.avgAlpha)} điểm, hơn ${fmt(d)} điểm so với ý tưởng đã thực hiện (${a.alphaN}): nhóm có thể đang bỏ lỡ cơ hội do chậm hoặc ngại thực hiện.` });
      else if (d < -2) insights.push({ tone: 'good', text: `Ý tưởng được thực hiện (${a.alphaN}) tốt hơn ý tưởng duyệt mà để đó (${b.alphaN}) ${fmt(-d)} điểm so với VN-Index: việc chọn ý tưởng nào đưa vào danh mục đang có giá trị.` });
    }
    if (enough(c) && (enough(a) || enough(b))) {
      const ap = approved ? weightedAlpha([stats.executed, stats.idle]) : null;
      if (ap !== null && c.avgAlpha !== null) {
        const d = ap - c.avgAlpha;
        if (d > 2) insights.push({ tone: 'good', text: `Người duyệt đang gác cổng tốt: ý tưởng được duyệt vượt VN-Index ${fmt(ap)} điểm, ý tưởng bị bác ${fmt(c.avgAlpha)} điểm (chênh ${fmt(d)}; mẫu ${c.alphaN} bị bác).` });
        else if (d < -2) insights.push({ tone: 'warn', text: `Ý tưởng bị bác (${c.alphaN}) lại vượt VN-Index ${fmt(c.avgAlpha)} điểm, hơn ý tưởng được duyệt ${fmt(-d)} điểm: nên xem lại tiêu chí bác.` });
      }
    }
    if (timing.toExecute !== null && timing.toExecute >= IDLE_DAYS) insights.push({ tone: 'warn', text: `Từ lúc duyệt tới lúc ghi lệnh đầu tiên trung vị ${timing.toExecute} ngày — dài hơn ${IDLE_DAYS} ngày: ý tưởng có thể đã mất lợi thế khi thực hiện.` });
    const idleCount = rows.filter((r) => r.flags.indexOf('idle') !== -1).length, stuckCount = rows.filter((r) => r.flags.indexOf('stuck') !== -1).length;
    if (idleCount) insights.push({ tone: 'info', text: `${idleCount} ý tưởng đã duyệt quá ${IDLE_DAYS} ngày mà chưa có lệnh nào.` });
    if (stuckCount) insights.push({ tone: 'info', text: `${stuckCount} ý tưởng có đề xuất lệnh chờ duyệt quá ${STUCK_DAYS} ngày.` });
    if (!insights.length && total) insights.push({ tone: 'mute', text: `Chưa đủ dữ liệu để kết luận quy trình nào hiệu quả hơn (cần từ ${MIN_N} ý tưởng có kết quả trong mỗi nhóm so sánh). Hiện ${executed} đã thực hiện, ${stats.idle.n} duyệt chưa thực hiện, ${rejected} bị bác.` });
    return { total, funnel: { total, proposed, decided, approved, executed, closed, rejected }, byPath: stats, timing, insights, minN: MIN_N };
  }

  function weightedAlpha(parts) { let n = 0, s = 0; parts.forEach((p) => { if (p.alphaN && p.avgAlpha !== null) { n += p.alphaN; s += p.avgAlpha * p.alphaN; } }); return n ? s / n : null; }
  function fmt(v) { return (v > 0 ? '+' : '') + (Math.round(v * 10) / 10).toLocaleString('vi-VN'); }

  return { PATHS, MIN_N, IDLE_DAYS, STUCK_DAYS, build, summarize };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = IdeaJourney;
