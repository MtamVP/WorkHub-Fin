// Logic thuần: BỘ SỐ LIỆU CHO HỘI ĐỒNG ĐẦU TƯ -- gom những thứ hội đồng thường hỏi mà báo cáo định kỳ chưa có: (1) quản trị: duyệt lệnh và kiểm soát trong kỳ, (2) kịch bản căng thẳng của cả nhóm,
// rồi tóm tắt hành trình ý tưởng và chất lượng khớp lệnh (đã tính ở IdeaJourney / ExecQuality, ở đây chỉ chọn và đặt tên). KHÔNG tính lại những gì đã có phép tính riêng; không đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global CommitteePack) và module.exports cho Vitest. Kết quả đưa vào GroupReport.build({ committee }) để xuất HTML/PDF/Excel.
const CommitteePack = (function () {
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const iso = (v) => String(v || '').slice(0, 10);
  const median = (xs) => { const a = xs.filter((v) => v !== null && isFinite(v)).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

  // input: { requests, audit, restricted, policy ({active, thresholdPct, thresholdVnd, validDays, selfApprovers}), from, to (YYYY-MM-DD, gồm cả hai đầu), today, AC = ApprovalCalc, nameOf(id) }
  function governance(input) {
    const x = input || {}, AC = x.AC, from = iso(x.from), to = iso(x.to), today = iso(x.today || x.to);
    const inRange = (d) => { const s = iso(d); return s >= from && s <= to; };
    const reqs = (x.requests || []).filter((r) => inRange(r.created_at));
    const eff = (r) => (AC ? AC.effectiveStatus(r, today) : r.status);
    const st = { total: reqs.length, pending: 0, approved: 0, rejected: 0, executed: 0, cancelled: 0, expired: 0 };
    reqs.forEach((r) => { const k = eff(r); if (st[k] !== undefined) st[k]++; });
    const decided = reqs.filter((r) => r.decided_at);
    const hours = decided.map((r) => (Date.parse(r.decided_at) - Date.parse(r.created_at)) / 3600000).filter((h) => isFinite(h) && h >= 0);
    const selfApproved = decided.filter((r) => r.status !== 'rejected' && r.decided_by && (r.decided_by === r.user_id || r.decided_by === r.created_by));
    const approvedLike = st.approved + st.executed + st.expired;      // đã được duyệt (dù sau đó đã dùng / hết hạn)
    const rejected = st.rejected;
    const auditAll = x.audit || [];
    const auditPeriod = auditAll.filter((a) => inRange(a.detected_at));
    const byKind = {}; auditPeriod.forEach((a) => { byKind[a.kind] = (byKind[a.kind] || 0) + 1; });
    const restrictedActive = (x.restricted || []).filter((r) => r.active).map((r) => ({ symbol: r.symbol, scope: r.user_id ? (x.nameOf ? x.nameOf(r.user_id) : 'Một thành viên') : 'Mọi thành viên', reason: r.reason, since: iso(r.created_at) }));
    const pol = x.policy || {};
    const pending = (x.requests || []).filter((r) => eff(r) === 'pending');
    return {
      policy: { active: !!pol.active, thresholdPct: pol.thresholdPct === undefined ? null : pol.thresholdPct, thresholdVnd: pol.thresholdVnd === undefined ? null : pol.thresholdVnd, validDays: pol.validDays || null, selfApprovers: (pol.selfApprovers || []).length },
      requests: Object.assign(st, { approvalRatePct: approvedLike + rejected > 0 ? approvedLike / (approvedLike + rejected) * 100 : null, medianDecideHours: median(hours), selfApproved: selfApproved.length, pendingNow: pending.length,
        oldestPendingDays: pending.length ? Math.max.apply(null, pending.map((r) => Math.max(0, Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(iso(r.created_at) + 'T00:00:00Z')) / 86400000)))) : null }),
      audit: { inPeriod: auditPeriod.length, byKind: byKind, openNow: auditAll.filter((a) => a.status === 'open').length, reviewedInPeriod: auditPeriod.filter((a) => a.status === 'reviewed').length },
      restricted: { count: restrictedActive.length, items: restrictedActive },
    };
  }

  // input: { risk (RiskCalc.analyze của cả nhóm), RiskCalc, StressCalc, LC, limits, maintenancePct, indexShocks (mặc định -10, -20), sectorShock (mặc định -20) }
  function stress(input) {
    const x = input || {}, r = x.risk;
    if (!r || !r.symbols || !r.symbols.length || !(num(r.nav) > 0) || !x.RiskCalc || !x.StressCalc) return null;
    const run = (label, custom, indexPct) => {
      const S = x.RiskCalc.customStress(r, custom);
      const c = x.StressCalc.consequences(r, S, { LC: x.LC, limits: x.limits, maintenancePct: x.maintenancePct });
      return { label: label, indexPct: indexPct === undefined ? null : indexPct, portfolioPct: S.portfolioPct, navAfter: S.navAfter, navLoss: -(S.navAfter - num(r.nav)), worst: S.worst ? { symbol: S.worst.symbol, pct: S.worst.pct } : null,
        newBreaches: c.limits ? c.limits.added.length : null, marginBreached: !!(c.margin && c.margin.before.hasDebt && c.margin.after.breached), hasDebt: !!(c.margin && c.margin.before.hasDebt) };
    };
    const scenarios = (x.indexShocks || [-10, -20]).map((s) => run('VN-Index ' + s + '%', { index: s, sectors: {}, symbols: {} }, s));
    const bySector = {}; r.symbols.forEach((s) => { bySector[s.sector] = (bySector[s.sector] || 0) + num(s.value); });
    const top = Object.keys(bySector).sort((a, b) => bySector[b] - bySector[a])[0];
    const sh = x.sectorShock === undefined ? -20 : x.sectorShock;
    if (top) scenarios.push(Object.assign(run('Ngành ' + top + ' ' + sh + '% (ngành lớn nhất)', { index: 0, sectors: { [top]: sh }, symbols: {} }), { sector: top }));
    const reverse = x.StressCalc.reverse(r, { LC: x.LC, limits: x.limits, maintenancePct: x.maintenancePct }).map((v) => ({ label: v.label, indexPct: v.indexPct, navLossPct: v.navLossPct === undefined ? null : v.navLossPct, note: v.note || '' }));
    return { nav: num(r.nav), scenarios: scenarios, reverse: reverse, maintenancePct: x.maintenancePct > 0 ? x.maintenancePct : null };
  }

  // Tóm tắt hành trình ý tưởng (IdeaJourney.build().summary) và chất lượng khớp lệnh (ExecQuality.build().summary) thành đối tượng gọn để đặt vào báo cáo
  function journey(summary) {
    if (!summary) return null;
    const f = summary.funnel || {}, t = summary.timing || {}, p = summary.byPath || {};
    const path = (k) => (p[k] ? { n: p[k].n, avgAlpha: p[k].avgAlpha, alphaN: p[k].alphaN } : { n: 0, avgAlpha: null, alphaN: 0 });
    return { funnel: { total: f.total || 0, decided: f.decided || 0, approved: f.approved || 0, executed: f.executed || 0, rejected: f.rejected || 0, closed: f.closed || 0 },
      timing: { toDecide: t.toDecide === undefined ? null : t.toDecide, toRequest: t.toRequest === undefined ? null : t.toRequest, toExecute: t.toExecute === undefined ? null : t.toExecute },
      paths: { executed: path('executed'), idle: path('idle'), rejected: path('rejected'), pending: path('pending') }, insights: (summary.insights || []).map((i) => ({ tone: i.tone, text: i.text })), minN: summary.minN || 4 };
  }
  function execution(summary, months) {
    if (!summary) return null;
    const v = (o) => ({ n: o ? o.n : 0, pct: o ? o.pct : null });
    return { months: months || null, n: summary.n || 0, value: summary.value || 0, cost: summary.cost || 0, costPct: summary.costPct === undefined ? null : summary.costPct,
      vsCloseBuy: v(summary.vsCloseBuy), vsCloseSell: v(summary.vsCloseSell), vsRef: v(summary.vsRef), delayDays: summary.delay ? summary.delay.days : null,
      forwardBuy: v(summary.forwardBuy), forwardSell: v(summary.forwardSell), insights: (summary.insights || []).map((i) => ({ tone: i.tone, text: i.text })) };
  }

  return { governance, stress, journey, execution };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CommitteePack;
