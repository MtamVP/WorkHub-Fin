// Logic thuần của Bàn Tài Sản (không đụng DOM/Supabase): FIFO CÓ PHÍ & THUẾ, báo cáo lãi/lỗ đã chốt theo năm, cân bằng danh mục.
// Nạp bằng thẻ <script> thường (global PortfolioCalc) và module.exports cho Vitest -- cùng kiểu lib/finance-calc.js.
//
// Quy ước tiền: VND. Lô FIFO ghi giá vốn/CP (cost) và phí mua/CP (feePerUnit). Khi tách/gộp hoặc cổ tức cổ phiếu, số lượng nhân hệ số
// còn cost và feePerUnit chia hệ số (tổng giá trị không đổi). Bán: tiền thu = KL x giá; lãi/lỗ GỘP = tiền thu - giá vốn các lô đã tiêu thụ
// (đúng định nghĩa cũ của realized_pnl, KHÔNG đổi); lãi/lỗ RÒNG = gộp - phí mua của các lô đó - phí bán - thuế bán.
const PortfolioCalc = (function () {
  const EPS = 1e-9;

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

  // Sắp xếp sự kiện đúng như api.js (_replayFifo): ngày rồi thời điểm tạo.
  // Cùng ngày: sự kiện doanh nghiệp (chia tách, cổ tức cổ phiếu) LUÔN trước lệnh -- ngày giao dịch không hưởng quyền nghĩa là mua hôm đó không được hưởng và bán hôm đó là bán cổ phiếu ĐÃ điều chỉnh. Bản cũ xếp theo thời điểm nhập liệu (created_at) nên ghi sự kiện SAU khi đã nhập lệnh bán cùng ngày làm khớp lệnh bán vào số cổ phiếu chưa điều chỉnh (vd chia 2:1 rồi bán 2.000 cp: lãi +4 triệu thành lỗ -48 triệu).
  const KIND_ORDER = { action: 0, txn: 1 };
  function sortEvents(events) {
    return events.sort((a, b) => (new Date(a._date) - new Date(b._date)) || (KIND_ORDER[a._kind] - KIND_ORDER[b._kind]) || (new Date(a._ts) - new Date(b._ts)));
  }

  // txns: [{id, symbol, type:'buy'|'sell', quantity, price, fee, tax, trade_date, created_at}]
  // actions: [{symbol, action_type:'split'|'stock_dividend', ratio, ex_date, created_at}]
  function replayLedger(txns, actions) {
    const events = sortEvents([
      ...(txns || []).map(t => ({ ...t, _kind: 'txn', _date: t.trade_date, _ts: t.created_at })),
      ...(actions || []).map(a => ({ ...a, _kind: 'action', _date: a.ex_date, _ts: a.created_at })),
    ]);
    const lotsBySymbol = {};
    const sales = [];
    const realizedGrossByTxnId = {};

    events.forEach(ev => {
      if (ev._kind === 'action') {
        const lots = lotsBySymbol[ev.symbol];
        if (!lots || !lots.length) return;
        // split: ratio = số cổ phiếu mới / cũ (2:1 -> 2). stock_dividend: ratio = % thưởng (10% -> 0.1, hệ số 1.1)
        const multiplier = ev.action_type === 'split' ? num(ev.ratio) : (1 + num(ev.ratio));
        if (multiplier > 0) lots.forEach(lot => { lot.quantity *= multiplier; lot.cost /= multiplier; lot.feePerUnit /= multiplier; });
        return;
      }
      const symbol = ev.symbol;
      if (!lotsBySymbol[symbol]) lotsBySymbol[symbol] = [];
      const lots = lotsBySymbol[symbol];
      const qty = num(ev.quantity);
      const price = num(ev.price);
      if (ev.type === 'buy') {
        lots.push({ quantity: qty, cost: price, feePerUnit: qty > 0 ? num(ev.fee) / qty : 0, date: ev.trade_date });
        return;
      }
      let remaining = qty, costBasis = 0, buyFees = 0, dayWeighted = 0, consumedTotal = 0;
      const sellDate = new Date(ev.trade_date + 'T00:00:00');
      while (remaining > EPS && lots.length) {
        const lot = lots[0];
        const consumed = Math.min(lot.quantity, remaining);
        costBasis += lot.cost * consumed;
        buyFees += lot.feePerUnit * consumed;
        const heldDays = Math.max(0, Math.round((sellDate - new Date(lot.date + 'T00:00:00')) / 86400000));
        dayWeighted += heldDays * consumed;
        consumedTotal += consumed;
        lot.quantity -= consumed; remaining -= consumed;
        if (lot.quantity <= EPS) lots.shift();
      }
      const proceeds = qty * price;
      const sellFee = num(ev.fee);
      const tax = num(ev.tax);
      // Phần bán vượt khối lượng đang có (dữ liệu nhập sai thứ tự) không có giá vốn -- ghi nhận để báo, không tính vào lãi/lỗ.
      const covered = consumedTotal > 0 ? consumedTotal : 0;
      const proceedsCovered = covered * price;
      const realizedGross = proceedsCovered - costBasis;
      // Phí/thuế bán chia theo phần được phủ bởi lô (nếu bán vượt, chỉ tính phần tương ứng)
      const coveredRatio = qty > 0 ? covered / qty : 0;
      const sale = {
        txnId: ev.id, symbol, date: ev.trade_date, quantity: qty, price,
        proceeds, costBasis, buyFees, sellFee, tax,
        realizedGross,
        realizedNet: realizedGross - buyFees - (sellFee + tax) * coveredRatio,
        avgHoldingDays: covered > 0 ? dayWeighted / covered : 0,
        shortfall: Math.max(0, remaining),
      };
      sales.push(sale);
      realizedGrossByTxnId[ev.id] = realizedGross;
    });
    return { lotsBySymbol, sales, realizedGrossByTxnId };
  }

  // ---- Báo cáo lãi/lỗ đã chốt theo năm ----
  function yearOf(iso) { return Number(String(iso).slice(0, 4)); }

  function summarizeSales(list) {
    const t = { count: list.length, proceeds: 0, costBasis: 0, buyFees: 0, sellFees: 0, taxes: 0, grossPnl: 0, netPnl: 0, wins: 0, losses: 0, flat: 0, avgHoldingDays: 0, best: null, worst: null };
    let dayW = 0, qtyW = 0;
    list.forEach(s => {
      t.proceeds += s.proceeds; t.costBasis += s.costBasis; t.buyFees += s.buyFees; t.sellFees += s.sellFee; t.taxes += s.tax;
      t.grossPnl += s.realizedGross; t.netPnl += s.realizedNet;
      if (s.realizedNet > EPS) t.wins++; else if (s.realizedNet < -EPS) t.losses++; else t.flat++;
      dayW += s.avgHoldingDays * s.quantity; qtyW += s.quantity;
      if (!t.best || s.realizedNet > t.best.realizedNet) t.best = s;
      if (!t.worst || s.realizedNet < t.worst.realizedNet) t.worst = s;
    });
    t.avgHoldingDays = qtyW > 0 ? dayW / qtyW : 0;
    t.winRate = (t.wins + t.losses) > 0 ? t.wins / (t.wins + t.losses) * 100 : null;
    t.fees = t.buyFees + t.sellFees;
    return t;
  }

  // dividends: [{flow_date, symbol, amount}] -- chỉ cổ tức tiền (flow_type='dividend').
  function realizedReport(sales, dividends, year) {
    const years = Array.from(new Set([...(sales || []).map(s => yearOf(s.date)), ...(dividends || []).map(d => yearOf(d.flow_date))])).filter(y => y > 1990).sort((a, b) => b - a);
    const inYear = (sales || []).filter(s => yearOf(s.date) === year);
    const divInYear = (dividends || []).filter(d => yearOf(d.flow_date) === year);
    const bySymbolMap = {};
    inYear.forEach(s => { (bySymbolMap[s.symbol] = bySymbolMap[s.symbol] || []).push(s); });
    const bySymbol = Object.keys(bySymbolMap).map(symbol => {
      const sum = summarizeSales(bySymbolMap[symbol]);
      const quantity = bySymbolMap[symbol].reduce((q, s) => q + s.quantity, 0);
      const basis = sum.costBasis + sum.buyFees;
      return Object.assign(sum, { symbol, quantity, returnPct: basis > 0 ? sum.netPnl / basis * 100 : null });
    }).sort((a, b) => Math.abs(b.netPnl) - Math.abs(a.netPnl));
    const dividendTotal = divInYear.reduce((s, d) => s + num(d.amount), 0);
    const totals = summarizeSales(inYear);
    return {
      years, year, totals, bySymbol,
      sales: inYear.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
      dividends: divInYear.slice().sort((a, b) => (a.flow_date < b.flow_date ? 1 : -1)),
      dividendTotal,
      netIncludingDividends: totals.netPnl + dividendTotal,
    };
  }

  // ---- Phí & thuế ----
  // rates: { buyFeeRate, sellFeeRate, sellTaxRate } (số thập phân: 0.0015 = 0,15%). Làm tròn đến đồng.
  const DEFAULT_RATES = { buyFeeRate: 0.0015, sellFeeRate: 0.0015, sellTaxRate: 0.001 };

  function feesFor(side, quantity, price, rates) {
    const r = Object.assign({}, DEFAULT_RATES, rates || {});
    const value = num(quantity) * num(price);
    if (side === 'sell') return { fee: Math.round(value * r.sellFeeRate), tax: Math.round(value * r.sellTaxRate) };
    return { fee: Math.round(value * r.buyFeeRate), tax: 0 };
  }

  // ---- Cân bằng danh mục ----
  // holdings: [{symbol, quantity, marketPrice}]; cash: tiền mặt; targets: {SYMBOL: pct, CASH: pct}; priceOf: {SYMBOL: giá} cho mã chưa nắm.
  // opts: { includeCash=true, lotSize=100, tolerancePct=1, rates, sellWhole=true }
  // Mã có KHỐI LƯỢNG nhưng KHÔNG có mục tiêu thì không bị đụng tới (vẫn tính vào tổng NAV).
  function rebalancePlan(holdings, cash, targets, priceOf, opts) {
    const o = Object.assign({ includeCash: true, lotSize: 100, tolerancePct: 1, rates: DEFAULT_RATES }, opts || {});
    const rates = Object.assign({}, DEFAULT_RATES, o.rates || {});
    const held = {};
    (holdings || []).forEach(h => { held[h.symbol] = { quantity: num(h.quantity), price: num(h.marketPrice) }; });
    const prices = Object.assign({}, priceOf || {});
    Object.keys(held).forEach(s => { if (held[s].price > 0) prices[s] = held[s].price; });

    const marketValue = Object.keys(held).reduce((s, k) => s + held[k].quantity * (held[k].price || 0), 0);
    const cashValue = num(cash);
    const base = marketValue + (o.includeCash ? cashValue : 0);
    const targetSymbols = Object.keys(targets || {}).filter(s => s !== 'CASH');
    const targetSum = Object.keys(targets || {}).reduce((s, k) => s + num(targets[k]), 0);

    const rows = [];
    let cashDelta = 0; // >0: tiền thu về (bán nhiều hơn mua)
    targetSymbols.forEach(symbol => {
      const h = held[symbol] || { quantity: 0, price: 0 };
      const price = prices[symbol] || 0;
      const currentValue = h.quantity * (price || 0);
      const targetPct = num(targets[symbol]);
      const targetValue = base * targetPct / 100;
      const currentPct = base > 0 ? currentValue / base * 100 : 0;
      const diffPct = currentPct - targetPct;
      const row = { symbol, price, quantity: h.quantity, currentValue, currentPct, targetPct, targetValue, diffPct, action: 'hold', shares: 0, tradeValue: 0, fee: 0, tax: 0, afterPct: currentPct, note: '' };
      if (price <= 0) { row.action = 'noPrice'; row.note = 'Chưa có giá thị trường'; rows.push(row); return; }
      if (Math.abs(diffPct) < o.tolerancePct) { rows.push(row); return; }
      const deltaValue = targetValue - currentValue; // >0 mua
      const lot = Math.max(1, o.lotSize);
      if (deltaValue > 0) {
        const shares = Math.floor(deltaValue / price / lot) * lot;
        if (shares > 0) {
          const f = feesFor('buy', shares, price, rates);
          Object.assign(row, { action: 'buy', shares, tradeValue: shares * price, fee: f.fee, tax: 0 });
          cashDelta -= shares * price + f.fee;
        } else { row.note = 'Chênh lệch nhỏ hơn 1 lô'; }
      } else {
        let shares = Math.floor(-deltaValue / price / lot) * lot;
        // Mục tiêu 0% -> bán hết kể cả phần lẻ; không bao giờ bán vượt khối lượng đang có
        if (targetPct === 0) shares = h.quantity; else shares = Math.min(shares, h.quantity);
        if (shares > 0) {
          const f = feesFor('sell', shares, price, rates);
          Object.assign(row, { action: 'sell', shares, tradeValue: shares * price, fee: f.fee, tax: f.tax });
          cashDelta += shares * price - f.fee - f.tax;
        } else { row.note = 'Chênh lệch nhỏ hơn 1 lô'; }
      }
      const newValue = currentValue + (row.action === 'buy' ? row.tradeValue : (row.action === 'sell' ? -row.tradeValue : 0));
      row.afterPct = base > 0 ? newValue / base * 100 : 0;
      rows.push(row);
    });

    const cashAfter = cashValue + cashDelta;
    const cashTargetPct = targets && targets.CASH !== undefined ? num(targets.CASH) : null;
    const warnings = [];
    if (Math.abs(targetSum - 100) > 0.01 && targetSum > 0) warnings.push(targetSum > 100 ? 'Tổng tỷ trọng mục tiêu vượt 100%' : 'Tổng tỷ trọng mục tiêu chưa đủ 100% (phần còn lại không được phân bổ)');
    if (o.includeCash && cashAfter < -EPS) warnings.push('Không đủ tiền mặt cho các lệnh mua — cần thêm vốn hoặc bán bớt mã khác');
    if (!o.includeCash && cashAfter < -EPS) warnings.push('Các lệnh mua cần nhiều hơn tiền thu được từ lệnh bán — cần dùng thêm tiền mặt');
    return { base, marketValue, cash: cashValue, rows, cashDelta, cashAfter, cashTargetPct, targetSum, warnings,
             totalFees: rows.reduce((s, r) => s + r.fee, 0), totalTax: rows.reduce((s, r) => s + r.tax, 0) };
  }

  return { replayLedger, realizedReport, summarizeSales, feesFor, DEFAULT_RATES, rebalancePlan };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioCalc;
