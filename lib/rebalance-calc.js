// Logic thuần: CÂN BẰNG LẠI DANH MỤC VỀ DANH MỤC CHUẨN CHIẾN LƯỢC -- từ tỷ trọng thực theo ngành và tỷ trọng mục tiêu của nhóm (finance_policy_weights), đề xuất các lệnh
// mua/bán cụ thể để đưa danh mục về chuẩn: chỉ ngành lệch quá biên độ mới giao dịch; bán ngành thừa theo tỷ lệ giá trị từng mã, mua ngành thiếu bằng tiền bán được + tiền mặt
// dư (không xuống dưới tiền mặt chuẩn); làm tròn lô 100; trừ phí/thuế; giới hạn khối lượng theo thanh khoản (tối đa liqDays phiên x liqPct khối lượng TB ngày) và theo giới hạn đầu tư
// (qua SizingCalc.maxQtyWithinLimits). Ngành thiếu mà chưa có mã nào trong danh mục thì KHÔNG tự chọn mã -- trả về như "khoảng trống" để người dùng tự chọn.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global RebalanceCalc) và module.exports cho Vitest. Công cụ hỗ trợ quyết định, không phải khuyến nghị.
const RebalanceCalc = (function () {
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const LOT = 100;
  const DEFAULTS = { bandPts: 2, lot: LOT, minValue: 2000000, liqPct: 0.2, liqDays: 3, rates: { buyFeeRate: 0.0015, sellFeeRate: 0.0015, sellTaxRate: 0.001 } };
  const floorLot = (q, lot) => Math.floor(Math.max(0, q) / lot + 1e-9) * lot;

  // input: {
  //   holdings: [{ symbol, sector, quantity, price }]   -- giá thị trường hiện tại
  //   cash, debt, policy: { ngành: % }, bandPts, lot, minValue, rates, adv: { MÃ: khối lượng TB ngày }, liqPct, liqDays,
  //   includeOffPolicy: false -- ngành không có trong chuẩn: mặc định giữ nguyên (coi là vị thế chủ động); true = coi mục tiêu 0% và bán dần
  //   limits: { LC, rows, SC }  -- LC = LimitsCalc, rows = giới hạn đang áp dụng (đã lọc), SC = SizingCalc (để cắt khối lượng mua theo giới hạn đầu tư)
  // }
  function plan(input) {
    const x = input || {};
    const lot = x.lot > 0 ? x.lot : DEFAULTS.lot, band = x.bandPts >= 0 ? Number(x.bandPts) : DEFAULTS.bandPts;
    const minValue = x.minValue >= 0 ? Number(x.minValue) : DEFAULTS.minValue;
    const rates = Object.assign({}, DEFAULTS.rates, x.rates || {});
    const liqPct = x.liqPct > 0 ? x.liqPct : DEFAULTS.liqPct, liqDays = x.liqDays > 0 ? x.liqDays : DEFAULTS.liqDays;
    const adv = x.adv || {};
    const cash = num(x.cash), debt = num(x.debt);
    const holdings = (x.holdings || []).map((h) => ({ symbol: String(h.symbol).toUpperCase(), sector: h.sector || 'Khác', quantity: num(h.quantity), price: num(h.price) }))
      .filter((h) => h.quantity > 0 && h.price > 0).map((h) => Object.assign(h, { value: h.quantity * h.price }));
    const targets = {};
    Object.keys(x.policy || {}).forEach((s) => { const v = num(x.policy[s]); if (v > 0) targets[s] = v; });
    if (!Object.keys(targets).length) return { ok: false, reason: 'noPolicy' };
    const sumT = Object.keys(targets).reduce((s, k) => s + targets[k], 0);
    if (sumT > 100.0001) return { ok: false, reason: 'badPolicy' };
    const mv = holdings.reduce((s, h) => s + h.value, 0);
    const nav = mv + cash - debt;
    if (!(nav > 0)) return { ok: false, reason: 'noNav' };
    const cashTargetPct = Math.max(0, 100 - sumT);

    const bySector = {};
    holdings.forEach((h) => { (bySector[h.sector] = bySector[h.sector] || { value: 0, items: [] }); bySector[h.sector].value += h.value; bySector[h.sector].items.push(h); });
    const names = Array.from(new Set(Object.keys(targets).concat(Object.keys(bySector))));
    const inScope = (s) => targets[s] !== undefined || !!x.includeOffPolicy;
    const sectors = names.map((s) => {
      const cur = bySector[s] ? bySector[s].value : 0;
      return { sector: s, inPolicy: targets[s] !== undefined, inScope: inScope(s), targetPct: targets[s] || 0, currentPct: cur / nav * 100, value: cur };
    }).sort((a, b) => b.targetPct - a.targetPct || b.currentPct - a.currentPct);
    sectors.forEach((r) => { r.driftPts = r.currentPct - r.targetPct; r.action = !r.inScope ? 'hold' : (r.driftPts > band ? 'sell' : (r.driftPts < -band ? 'buy' : 'ok')); });

    const warnings = [];
    const trades = [];
    const addNote = (t, n) => { t.notes = t.notes || []; if (t.notes.indexOf(n) < 0) t.notes.push(n); };

    // ---- bán ngành thừa: theo tỷ lệ giá trị từng mã ----
    sectors.filter((r) => r.action === 'sell' && bySector[r.sector]).forEach((r) => {
      const amount = r.driftPts / 100 * nav, items = bySector[r.sector].items.slice().sort((a, b) => b.value - a.value);
      items.forEach((h) => {
        const want = amount * h.value / r.value;
        let qty = Math.min(h.quantity, floorLot(want / h.price, lot));
        // phần còn lại dưới 1 lô mà ngành đang cần bán nhiều: bán hết cho gọn
        if (qty > 0 && h.quantity - qty < lot && want >= h.value * 0.5) qty = h.quantity;
        const t = { symbol: h.symbol, sector: h.sector, side: 'sell', quantity: qty, price: h.price, held: h.quantity, notes: [] };
        const a = num(adv[h.symbol]);
        if (a > 0 && qty > 0) { const cap = floorLot(a * liqPct * liqDays, lot); if (qty > cap) { qty = Math.min(qty, cap); t.quantity = qty; addNote(t, 'Giảm theo thanh khoản: tối đa ' + liqDays + ' phiên × ' + Math.round(liqPct * 100) + '% khối lượng TB ngày (' + Math.round(cap).toLocaleString('vi-VN') + ' cp)'); t.capped = 'liquidity'; } }
        if (qty <= 0 || qty * h.price < minValue) return;
        t.quantity = qty; trades.push(t);
      });
    });
    trades.forEach((t) => { t.value = t.quantity * t.price; t.fee = t.value * rates.sellFeeRate; t.tax = t.value * rates.sellTaxRate; t.net = t.value - t.fee - t.tax; });
    const proceeds = trades.reduce((s, t) => s + t.net, 0);

    // ---- mua ngành thiếu bằng tiền bán được + tiền mặt dư (không xuống dưới tiền mặt chuẩn) ----
    const reserve = cashTargetPct / 100 * nav;
    const funds = Math.max(0, cash + proceeds - reserve);
    const under = sectors.filter((r) => r.action === 'buy');
    const totalNeed = under.reduce((s, r) => s + (-r.driftPts) / 100 * nav, 0);
    const scale = totalNeed > 0 ? Math.min(1, funds / totalNeed) : 1;
    if (totalNeed > 0 && scale < 1) warnings.push('Tiền có thể dùng (' + Math.round(funds).toLocaleString('vi-VN') + ' đ, sau khi giữ tiền mặt chuẩn ' + (Math.round(cashTargetPct * 10) / 10) + '%) chỉ đủ ' + Math.round(scale * 100) + '% nhu cầu mua; các lệnh mua được giảm theo tỷ lệ.');
    const gaps = [];
    const pf = x.limits && x.limits.LC ? { holdings: holdings.map((h) => ({ symbol: h.symbol, value: h.value })), cash: cash, debt: debt } : null;
    if (pf) trades.filter((t) => t.side === 'sell').forEach((t) => {
      const after = x.limits.LC.applyTrade(pf, { type: 'sell', symbol: t.symbol, quantity: t.quantity, price: t.price, fee: t.fee, tax: t.tax });
      pf.holdings = after.holdings; pf.cash = after.cash;
    });
    under.forEach((r) => {
      const need = (-r.driftPts) / 100 * nav * scale;
      if (!bySector[r.sector]) { gaps.push({ sector: r.sector, amount: need, pct: need / nav * 100, targetPct: r.targetPct, currentPct: r.currentPct }); return; }
      const items = bySector[r.sector].items;
      items.forEach((h) => {
        const share = need * h.value / r.value;
        let qty = floorLot(share / (h.price * (1 + rates.buyFeeRate)), lot);
        const t = { symbol: h.symbol, sector: h.sector, side: 'buy', quantity: qty, price: h.price, held: h.quantity, notes: [] };
        const a = num(adv[h.symbol]);
        if (a > 0 && qty > 0) { const cap = floorLot(a * liqPct * liqDays, lot); if (qty > cap) { qty = cap; addNote(t, 'Giảm theo thanh khoản: tối đa ' + liqDays + ' phiên × ' + Math.round(liqPct * 100) + '% khối lượng TB ngày (' + Math.round(cap).toLocaleString('vi-VN') + ' cp)'); t.capped = 'liquidity'; } }
        if (qty > 0 && pf && x.limits.SC && x.limits.rows && x.limits.rows.length) {
          const m = x.limits.SC.maxQtyWithinLimits(x.limits.LC, x.limits.rows, pf, { symbol: h.symbol, price: h.price, fee: qty * h.price * rates.buyFeeRate, tax: 0 }, qty, lot);
          if (m.qty < qty) { qty = m.qty; t.capped = 'limit'; addNote(t, 'Giảm theo giới hạn đầu tư' + (m.binding && m.binding.text ? ': ' + m.binding.text : '')); }
        }
        if (qty <= 0 || qty * h.price < minValue) { if (t.capped) warnings.push('Không mua được ' + h.symbol + ' như kế hoạch (' + (t.capped === 'limit' ? 'chạm giới hạn đầu tư' : 'thanh khoản') + ').'); return; }
        t.quantity = qty; t.value = qty * h.price; t.fee = t.value * rates.buyFeeRate; t.tax = 0; t.net = -(t.value + t.fee);
        if (pf) { const after = x.limits.LC.applyTrade(pf, { type: 'buy', symbol: t.symbol, quantity: qty, price: t.price, fee: t.fee, tax: 0 }); pf.holdings = after.holdings; pf.cash = after.cash; }
        trades.push(t);
      });
    });
    if (gaps.length) warnings.push('Ngành ' + gaps.map((g) => g.sector).join(', ') + ' đang thiếu so với chuẩn nhưng chưa có mã nào trong danh mục: hãy chọn mã (Tổng Hợp CP / Ý tưởng) — phần tiền tương ứng được giữ lại dạng tiền mặt.');
    const offHeld = sectors.filter((r) => !r.inPolicy && r.value > 0 && !x.includeOffPolicy).map((r) => r.sector);
    if (offHeld.length) warnings.push('Giữ nguyên ngành ngoài chuẩn (coi là vị thế chủ động): ' + offHeld.join(', ') + '.');

    // ---- trạng thái sau cân bằng ----
    const after = {};
    holdings.forEach((h) => { after[h.symbol] = h.value; });
    let cashAfter = cash;
    trades.forEach((t) => { after[t.symbol] = (after[t.symbol] || 0) + (t.side === 'buy' ? t.value : -t.value); cashAfter += t.net; });
    const navAfter = Object.keys(after).reduce((s, k) => s + after[k], 0) + cashAfter - debt;
    const secOf = {}; holdings.forEach((h) => { secOf[h.symbol] = h.sector; });
    const afterBySector = {};
    Object.keys(after).forEach((sym) => { const s = secOf[sym]; afterBySector[s] = (afterBySector[s] || 0) + after[sym]; });
    sectors.forEach((r) => { r.afterPct = navAfter > 0 ? (afterBySector[r.sector] || 0) / navAfter * 100 : 0; r.afterDriftPts = r.afterPct - r.targetPct; });
    trades.forEach((t) => { t.weightBefore = t.held * t.price / nav * 100; const q = t.side === 'buy' ? t.held + t.quantity : t.held - t.quantity; t.weightAfter = navAfter > 0 ? q * t.price / navAfter * 100 : 0; });
    trades.sort((a, b) => (a.side === b.side ? b.value - a.value : (a.side === 'sell' ? -1 : 1)));
    const cashPctBefore = (cash - debt) / nav * 100, cashPctAfter = navAfter > 0 ? (cashAfter - debt) / navAfter * 100 : 0;
    const scope = sectors.filter((r) => r.inScope);
    const driftBefore = (scope.reduce((s, r) => s + Math.abs(r.driftPts), 0) + Math.abs(cashPctBefore - cashTargetPct)) / 2;
    const driftAfter = (scope.reduce((s, r) => s + Math.abs(r.afterDriftPts), 0) + Math.abs(cashPctAfter - cashTargetPct)) / 2;
    const cost = trades.reduce((s, t) => s + t.fee + t.tax, 0);
    return {
      ok: true, nav, navAfter, bandPts: band, cashTargetPct, cashPctBefore, cashPctAfter, sectors, trades, gaps, warnings,
      summary: { count: trades.length, turnover: trades.reduce((s, t) => s + t.value, 0), cost, costPctNav: cost / nav * 100, driftBefore, driftAfter, funds, proceeds, cashAfter },
    };
  }

  return { DEFAULTS, plan };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RebalanceCalc;
