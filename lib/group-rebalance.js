// Logic thuần: CÂN BẰNG VỀ CHUẨN CHIẾN LƯỢC Ở CẤP NHÓM -- chạy RebalanceCalc.plan cho TỪNG thành viên theo cùng một danh mục chuẩn (finance_policy_weights), rồi gộp lại để quản lý thấy:
// ai lệch chuẩn nhiều nhất và cần giao dịch gì, tổng khối lượng mua/bán của CẢ NHÓM theo từng mã (so với thanh khoản: cả nhóm cùng mua một mã thì lệnh gộp có thể lớn hơn mức thị trường chịu được dù từng người
// đã nằm trong trần thanh khoản của riêng mình), và tổng chi phí. KHÔNG gợi ý khớp chéo giữa các thành viên (mua của người này bán của người kia): mỗi người giao dịch trên tài khoản của mình ở công ty chứng khoán.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global GroupRebalance) và module.exports cho Vitest. Công cụ hỗ trợ quyết định, không phải khuyến nghị.
const GroupRebalance = (function () {
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

  // input: {
  //   portfolios: [{ id, name, cash, debt, holdings: [{ symbol, quantity, price }] }]   -- GroupCalc.memberPortfolios
  //   policy: { ngành: % }, sectorOf(symbol), RC = RebalanceCalc, bandPts, includeOffPolicy, rates, adv: { MÃ: khối lượng TB ngày }, liqPct, liqDays,
  //   limitsFor(userId) -> giới hạn áp dụng cho người đó (đã lọc), LC, SC (LimitsCalc / SizingCalc)
  // }
  function build(input) {
    const x = input || {}, RC = x.RC;
    if (!RC) return { ok: false, reason: 'noLib' };
    const liqPct = x.liqPct > 0 ? x.liqPct : RC.DEFAULTS.liqPct, liqDays = x.liqDays > 0 ? x.liqDays : RC.DEFAULTS.liqDays;
    const members = [];
    let policyReason = null;
    (x.portfolios || []).forEach((p) => {
      const holdings = (p.holdings || []).filter((h) => num(h.quantity) > 0 && num(h.price) > 0).map((h) => ({ symbol: h.symbol, sector: x.sectorOf ? x.sectorOf(h.symbol) : 'Khác', quantity: h.quantity, price: h.price }));
      const lim = x.limitsFor ? x.limitsFor(p.id) : [];
      const r = RC.plan({
        holdings: holdings, cash: p.cash, debt: p.debt, policy: x.policy, bandPts: x.bandPts, includeOffPolicy: !!x.includeOffPolicy, rates: x.rates, adv: x.adv, liqPct: liqPct, liqDays: liqDays,
        limits: x.LC && x.SC ? { LC: x.LC, SC: x.SC, rows: lim } : undefined,
      });
      if (!r.ok) { if (r.reason === 'noPolicy' || r.reason === 'badPolicy') policyReason = r.reason; members.push({ id: p.id, name: p.name, ok: false, reason: r.reason }); return; }
      members.push({ id: p.id, name: p.name, ok: true, plan: r });
    });
    if (policyReason) return { ok: false, reason: policyReason };
    const done = members.filter((m) => m.ok);
    // gộp theo mã
    const bySym = {};
    done.forEach((m) => m.plan.trades.forEach((t) => {
      const s = bySym[t.symbol] || (bySym[t.symbol] = { symbol: t.symbol, sector: t.sector, buyQty: 0, sellQty: 0, buyValue: 0, sellValue: 0, buyers: [], sellers: [] });
      if (t.side === 'buy') { s.buyQty += t.quantity; s.buyValue += t.value; s.buyers.push(m.name); } else { s.sellQty += t.quantity; s.sellValue += t.value; s.sellers.push(m.name); }
    }));
    const symbols = Object.keys(bySym).map((k) => {
      const s = bySym[k], adv = num((x.adv || {})[k]), cap = adv > 0 ? adv * liqPct * liqDays : null;
      const side = s.buyQty >= s.sellQty ? 'buy' : 'sell', qty = Math.max(s.buyQty, s.sellQty);
      s.advPctBuy = adv > 0 ? s.buyQty / adv * 100 : null; s.advPctSell = adv > 0 ? s.sellQty / adv * 100 : null;
      s.overCap = cap !== null && (s.buyQty > cap || s.sellQty > cap);
      s.cap = cap; s.adv = adv > 0 ? adv : null; s.dominant = side; s.dominantQty = qty;
      s.opposing = s.buyQty > 0 && s.sellQty > 0;       // người này bán, người kia mua cùng mã: chỉ để biết, không gợi ý khớp chéo
      return s;
    }).sort((a, b) => (b.buyValue + b.sellValue) - (a.buyValue + a.sellValue));
    const warnings = [];
    symbols.filter((s) => s.overCap).forEach((s) => {
      const side = s.buyQty > (s.cap || Infinity) ? 'MUA' : 'BÁN', q = side === 'MUA' ? s.buyQty : s.sellQty;
      warnings.push('Cả nhóm cùng ' + side + ' ' + s.symbol + ' tổng ' + Math.round(q).toLocaleString('vi-VN') + ' cổ (' + Math.round(q / s.adv * 100) + '% khối lượng TB ngày) vượt trần ' + liqDays + ' phiên × ' + Math.round(liqPct * 100) + '%: nên chia nhỏ theo thời gian hoặc xen kẽ giữa các thành viên.');
    });
    const totals = done.reduce((t, m) => {
      const s = m.plan.summary; t.count += s.count; t.turnover += s.turnover; t.cost += s.cost; t.driftBefore += s.driftBefore * m.plan.nav; t.driftAfter += s.driftAfter * m.plan.navAfter; t.nav += m.plan.nav; t.navAfter += m.plan.navAfter;
      return t;
    }, { count: 0, turnover: 0, cost: 0, driftBefore: 0, driftAfter: 0, nav: 0, navAfter: 0 });
    totals.driftBefore = totals.nav > 0 ? totals.driftBefore / totals.nav : null;       // lệch trung bình có trọng số theo NAV
    totals.driftAfter = totals.navAfter > 0 ? totals.driftAfter / totals.navAfter : null;
    totals.needAction = done.filter((m) => m.plan.trades.length).length;
    const gaps = {};
    done.forEach((m) => m.plan.gaps.filter((g) => g.amount > 0).forEach((g) => { (gaps[g.sector] = gaps[g.sector] || { sector: g.sector, amount: 0, members: [] }); gaps[g.sector].amount += g.amount; gaps[g.sector].members.push(m.name); }));
    return { ok: true, members: members, symbols: symbols, totals: totals, gaps: Object.keys(gaps).map((k) => gaps[k]).sort((a, b) => b.amount - a.amount), warnings: warnings, liqPct: liqPct, liqDays: liqDays };
  }

  return { build };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GroupRebalance;
