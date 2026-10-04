// Logic thuần: tính khối lượng mua theo ngân sách rủi ro và phân tích TRƯỚC lệnh (mất tối đa bao nhiêu, tỷ trọng sau lệnh, tỷ lệ lời/lỗ, thanh khoản).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global SizingCalc) và module.exports cho Vitest. Giới hạn đầu tư kiểm bằng LimitsCalc (truyền vào, không nạp cứng).
//
// Cách quỹ định cỡ vị thế: chọn số tiền chịu mất nếu sai (ngân sách rủi ro, % NAV) rồi chia cho mức lỗ trên mỗi cổ phiếu tới điểm cắt lỗ;
// sau đó khối lượng bị chặn trên bởi tiền mặt, giới hạn đầu tư của nhóm/cá nhân và thanh khoản của mã (không đẩy quá một phần khối lượng giao dịch ngày).
const SizingCalc = (function () {
  const LOT = 100;                 // lô chẵn HOSE/HNX
  const LIQ_PARTICIPATION = 0.2;   // mỗi phiên chỉ nên chiếm tối đa 20% khối lượng trung bình ngày
  const LIQ_DAYS_OK = 3;           // vào/ra trong 3 phiên là chấp nhận được
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const floorLot = (q, lot) => { const l = lot > 0 ? lot : LOT; return Math.max(0, Math.floor(num(q) / l + 1e-9) * l); };

  // Lỗ trên mỗi cổ phiếu nếu giá chạm điểm cắt lỗ, tính cả phí mua, phí bán và thuế bán.
  function riskPerShare(price, stop, rates) {
    const r = rates || {};
    const buy = num(r.buyFeeRate), sell = num(r.sellFeeRate), tax = num(r.sellTaxRate);
    if (!(price > 0) || !(stop > 0) || stop >= price) return null;
    return price * (1 + buy) - stop * (1 - sell - tax);
  }

  // Khối lượng lớn nhất (bội của lô, ≤ hiQty) mà mua vào không làm vi phạm giới hạn ở chế độ "ghi lý do" hoặc "chặn" (chế độ cảnh báo bị bỏ qua).
  // Vi phạm chỉ tăng theo khối lượng nên tìm nhị phân được.
  function maxQtyWithinLimits(LC, limits, pf, trade, hiQty, lot) {
    const L = lot > 0 ? lot : LOT;
    const hiLots = Math.floor(num(hiQty) / L);
    if (!LC || !limits || !limits.length || hiLots <= 0) return { qty: Math.max(0, hiLots) * L, binding: null };
    const ok = (k) => {
      const res = LC.checkTrade(limits, pf, Object.assign({}, trade, { type: 'buy', quantity: k * L }));
      return !res.violations.some((v) => v.mode !== 'warn');
    };
    if (ok(hiLots)) return { qty: hiLots * L, binding: null };
    let lo = 0, hi = hiLots;           // ok(lo) hoặc lo = 0; !ok(hi)
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ok(mid)) lo = mid; else hi = mid; }
    const blocker = LC.checkTrade(limits, pf, Object.assign({}, trade, { type: 'buy', quantity: hi * L })).violations.find((v) => v.mode !== 'warn') || null;
    return { qty: lo * L, binding: blocker };
  }

  // input: { nav, cash, price, stop, riskPct, lot, rates, adv, liqDays, limits: { LC, rows, pf, symbol } }
  // Trả { qty, binding: 'risk'|'cash'|'limit'|'liquidity'|'none', caps: {risk, cash, limit, liquidity}, riskPerShare, riskBudget, limitBlocker, warnings }
  function size(input) {
    const x = input || {};
    const nav = num(x.nav), price = num(x.price), lot = x.lot > 0 ? x.lot : LOT;
    const out = { qty: 0, binding: 'none', caps: { risk: null, cash: null, limit: null, liquidity: null }, riskPerShare: null, riskBudget: null, limitBlocker: null, warnings: [] };
    if (!(price > 0)) { out.warnings.push('Nhập giá dự kiến để tính khối lượng.'); return out; }
    if (!(nav > 0)) { out.warnings.push('NAV chưa dương nên không tính được tỷ lệ rủi ro.'); return out; }
    const rates = x.rates || {};
    const riskPct = num(x.riskPct);
    out.riskBudget = riskPct > 0 ? nav * riskPct / 100 : null;
    const rps = riskPerShare(price, num(x.stop), rates);
    out.riskPerShare = rps;
    if (num(x.stop) > 0 && x.stop >= price) out.warnings.push('Ngưỡng cắt lỗ phải thấp hơn giá mua.');
    if (rps && out.riskBudget) out.caps.risk = floorLot(out.riskBudget / rps, lot);
    else if (!(num(x.stop) > 0)) out.warnings.push('Chưa có ngưỡng cắt lỗ nên chưa tính được khối lượng theo rủi ro.');
    out.caps.cash = floorLot(num(x.cash) / (price * (1 + num(rates.buyFeeRate))), lot);
    if (num(x.adv) > 0) out.caps.liquidity = floorLot(num(x.adv) * LIQ_PARTICIPATION * (x.liqDays > 0 ? x.liqDays : LIQ_DAYS_OK), lot);
    // trần theo giới hạn: tìm trong khoảng bị chặn bởi các trần còn lại (tránh dò quá xa)
    const others = ['risk', 'cash', 'liquidity'].map((k) => out.caps[k]).filter((v) => v !== null);
    let ceiling = others.length ? Math.min.apply(null, others) : 0;
    if (x.limits && x.limits.LC && ceiling > 0) {
      const lim = x.limits;
      const r = maxQtyWithinLimits(lim.LC, lim.rows, lim.pf, { symbol: lim.symbol, price: price, fee: 0, tax: 0 }, ceiling, lot);
      if (r.binding) { out.caps.limit = r.qty; out.limitBlocker = r.binding; }   // chỉ coi là trần khi thật sự chặn (không thì các trần khác quyết định)
    }
    // Không có ngưỡng cắt lỗ thì không có cơ sở để đề xuất khối lượng (nếu chỉ theo tiền mặt sẽ đề xuất dồn hết vốn) -- trả 0 kèm lý do, các trần khác vẫn hiện để tham khảo.
    if (out.caps.risk === null) { out.binding = 'nostop'; return out; }
    const entries = Object.keys(out.caps).filter((k) => out.caps[k] !== null);
    const qty = Math.min.apply(null, entries.map((k) => out.caps[k]));
    out.qty = qty;
    // yếu tố đang chặn: ưu tiên giới hạn > tiền mặt > thanh khoản > rủi ro khi bằng nhau
    const order = ['limit', 'cash', 'liquidity', 'risk'];
    out.binding = order.find((k) => out.caps[k] !== null && out.caps[k] === qty) || 'none';
    if (qty === 0) out.warnings.push(out.binding === 'limit' ? 'Giới hạn đầu tư không cho phép mua thêm mã này.' : (out.binding === 'cash' ? 'Không đủ tiền mặt cho một lô.' : 'Ngân sách rủi ro không đủ cho một lô.'));
    return out;
  }

  // Phân tích một lệnh mua dự kiến. input: { nav, cash, price, qty, stop, target, currentValue, adv, riskPct, rates, lot }
  function assess(input) {
    const x = input || {};
    const price = num(x.price), qty = num(x.qty), nav = num(x.nav), rates = x.rates || {};
    const out = { value: price * qty, weightBefore: null, weightAfter: null, cashAfter: null, maxLoss: null, maxLossPctNav: null, rewardRisk: null, expectedGain: null,
      participationPct: null, daysToTrade: null, flags: [] };
    if (!(price > 0) || !(qty > 0)) return out;
    const fee = out.value * num(rates.buyFeeRate);
    out.cashAfter = num(x.cash) - out.value - fee;
    if (nav > 0) {
      out.weightBefore = num(x.currentValue) / nav * 100;
      out.weightAfter = (num(x.currentValue) + out.value) / nav * 100;
    }
    const rps = riskPerShare(price, num(x.stop), rates);
    if (rps) {
      out.maxLoss = rps * qty;
      if (nav > 0) out.maxLossPctNav = out.maxLoss / nav * 100;
    }
    if (num(x.target) > price && rps) {
      const gain = num(x.target) * (1 - num(rates.sellFeeRate) - num(rates.sellTaxRate)) - price * (1 + num(rates.buyFeeRate));
      out.expectedGain = gain * qty;
      out.rewardRisk = gain / rps;
    }
    if (num(x.adv) > 0) {
      out.participationPct = qty / x.adv * 100;
      out.daysToTrade = qty / (x.adv * LIQ_PARTICIPATION);
    }
    const lot = x.lot > 0 ? x.lot : LOT;
    const f = out.flags;
    if (!(num(x.stop) > 0)) f.push({ key: 'nostop', tone: 'warn', text: 'Chưa đặt ngưỡng cắt lỗ — không biết mất tối đa bao nhiêu.' });
    else if (x.stop >= price) f.push({ key: 'badstop', tone: 'bad', text: 'Ngưỡng cắt lỗ phải thấp hơn giá mua.' });
    if (out.maxLossPctNav !== null && num(x.riskPct) > 0 && out.maxLossPctNav > num(x.riskPct) * 1.05) f.push({ key: 'overrisk', tone: 'warn', text: 'Mất tối đa ' + out.maxLossPctNav.toFixed(2) + '% NAV, vượt ngân sách rủi ro ' + num(x.riskPct) + '%.' });
    if (out.rewardRisk !== null) {
      if (out.rewardRisk < 1) f.push({ key: 'rr', tone: 'bad', text: 'Lời kỳ vọng nhỏ hơn lỗ tối đa (tỷ lệ ' + out.rewardRisk.toFixed(2) + ':1).' });
      else if (out.rewardRisk < 2) f.push({ key: 'rr', tone: 'warn', text: 'Tỷ lệ lời/lỗ chỉ ' + out.rewardRisk.toFixed(2) + ':1 (thường cần từ 2:1).' });
    }
    if (out.cashAfter < 0) f.push({ key: 'cash', tone: 'bad', text: 'Không đủ tiền mặt: thiếu ' + Math.round(-out.cashAfter).toLocaleString('en-US') + ' đ.' });
    if (qty % lot !== 0) f.push({ key: 'lot', tone: 'info', text: 'Khối lượng lẻ lô — lô lẻ khớp chậm và có thể khác giá.' });
    if (out.daysToTrade !== null) {
      if (out.daysToTrade > 10) f.push({ key: 'liq', tone: 'bad', text: 'Cần khoảng ' + Math.ceil(out.daysToTrade) + ' phiên để vào lệnh nếu chỉ chiếm 20% khối lượng ngày — thanh khoản mỏng.' });
      else if (out.daysToTrade > LIQ_DAYS_OK) f.push({ key: 'liq', tone: 'warn', text: 'Cần khoảng ' + Math.ceil(out.daysToTrade) + ' phiên để vào lệnh (chiếm 20% khối lượng ngày).' });
    }
    return out;
  }

  return { LOT, LIQ_PARTICIPATION, LIQ_DAYS_OK, riskPerShare, floorLot, maxQtyWithinLimits, size, assess };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SizingCalc;
