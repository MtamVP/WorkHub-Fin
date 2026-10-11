// Logic thuần: THANH KHOẢN VÀ SỨC CHỨA của danh mục (và của danh mục nhóm đã gộp). Tab Rủi Ro đã cho biết bán hết mất mấy phiên (RiskCalc.liquidity); ở đây bổ sung bốn thứ nó chưa có:
//   1. CHI PHÍ TÁC ĐỘNG GIÁ khi thoát vị thế: cùng công thức với Market Simulation (impact = k x biến động ngày x căn(giá trị bán trong phiên / giá trị giao dịch TB), trần 10%), chia đều số phiên cần thiết.
//   2. SỨC CHỨA từng mã: còn mua thêm được bao nhiêu mà vẫn thoát trong D phiên khi chỉ chiếm `rate` khối lượng ngày.
//   3. HỆ SỐ QUY MÔ của cả danh mục: nhân danh mục lên tối đa bao nhiêu lần thì mọi vị thế vẫn thoát được trong D phiên (và mã nào chặn trước).
//   4. SO SÁNH Ý ĐỊNH VỚI SỨC CHỨA cho ứng viên (theo dõi/ý tưởng): quy mô dự định có xây được trong D phiên không.
// Giới hạn cần biết: khối lượng giao dịch quá khứ KHÔNG bảo đảm thanh khoản lúc cần bán (nhất là khi thị trường hoảng loạn, thanh khoản biến mất đúng lúc cần); mã chạm sàn có thể không bán được trong nhiều phiên liên tiếp;
// tác động giá là mô hình căn bậc hai đơn giản, không phải sổ lệnh thật. Mọi con số là CẬN TRÊN lạc quan về khả năng thoát.
// KHÔNG đụng DOM/mạng. Nạp bằng thẻ <script> thường (global LiquidityCalc) và module.exports cho Vitest.
const LiquidityCalc = (function () {
  const DEFAULTS = { rate: 0.2, window: 20, impactK: 0.8, impactCap: 0.1, sigDefault: 0.02, exitDays: 5, maxDays: 10, lot: 100 };
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const floorLot = (q, lot) => Math.max(0, Math.floor(q / lot) * lot);

  // Độ lệch chuẩn lợi suất ngày từ chuỗi giá [[ngày, giá]] (60 phiên gần nhất); null nếu < 10 quan sát
  function dailySigma(series) {
    const px = (series || []).map((r) => num(r[1])).filter((x) => x > 0).slice(-61), r = [];
    for (let i = 1; i < px.length; i++) r.push(Math.log(px[i] / px[i - 1]));
    if (r.length < 10) return null;
    const m = mean(r); return Math.sqrt(r.reduce((s, x) => s + (x - m) * (x - m), 0) / (r.length - 1));
  }
  // Khối lượng bình quân ngày (cổ phiếu) trong `window` phiên có giao dịch gần nhất; null nếu < 5 phiên
  function averageVolume(series, window) {
    const v = (series || []).map((p) => num(p[1])).filter((x) => x > 0);
    if (v.length < 5) return null;
    return mean(v.slice(-(window || DEFAULTS.window)));
  }
  // Chi phí tác động giá (tỷ lệ của giá trị) khi bán `value` trong MỘT phiên với giá trị giao dịch TB là advValue
  const impactFrac = (value, advValue, sigD, o) => (advValue > 0 ? Math.min(o.impactCap, o.impactK * sigD * Math.sqrt(Math.max(0, value) / advValue)) : null);

  // Lịch thoát đều trong n = ceil(days) phiên, mỗi phiên bán một phần bằng nhau; trả chi phí tác động tổng (đồng) và tỷ lệ.
  function exitCost(value, advValue, perDayValue, sigD, o) {
    if (!(value > 0) || !(advValue > 0) || !(perDayValue > 0)) return null;
    const n = Math.max(1, Math.ceil(value / perDayValue - 1e-9)), slice = value / n;
    const f = impactFrac(slice, advValue, sigD, o);
    return { sessions: n, cost: f * value, pct: f * 100 };
  }

  // holdings: [{symbol, quantity, price}] (value = quantity x price nếu không có). volumes: { MÃ: [[ngày, khối lượng cổ phiếu]] }. series: { MÃ: [[ngày, giá]] } để ước biến động (tuỳ chọn).
  // Trả { rows, missing, totals, scale, params }.
  function analyze(holdings, volumes, series, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const rows = [], missing = [];
    let total = 0, known = 0;
    (holdings || []).forEach((h) => {
      const qty = num(h.quantity), price = num(h.price), value = num(h.value) !== null ? num(h.value) : (qty > 0 && price > 0 ? qty * price : null);
      if (!(qty > 0) || !(price > 0) || !(value > 0)) return;
      total += value;
      const adv = averageVolume((volumes || {})[h.symbol], o.window);
      if (adv === null || !(adv > 0)) { missing.push(h.symbol); return; }
      known += value;
      const sigma = dailySigma((series || {})[h.symbol]), sigD = sigma === null ? o.sigDefault : sigma;
      const advValue = adv * price, perDay = o.rate * adv, perDayValue = perDay * price;
      const days = qty / perDay;
      const ec = exitCost(value, advValue, perDayValue, sigD, o);
      const maxQtyExit = perDay * o.exitDays;                  // vị thế tối đa còn thoát được trong exitDays phiên
      const maxQtyLimit = perDay * o.maxDays;
      rows.push({
        symbol: h.symbol, quantity: qty, price: price, value: value, adv: adv, advValue: advValue, perDay: perDay, days: days,
        pctOfAdv: qty / adv * 100, sigD: sigD, sigmaKnown: sigma !== null,
        exitCostPct: ec ? ec.pct : null, exitCostValue: ec ? ec.cost : null, exitSessions: ec ? ec.sessions : null,
        capacityQty: floorLot(maxQtyExit, o.lot), headroomQty: floorLot(Math.max(0, maxQtyExit - qty), o.lot), headroomValue: floorLot(Math.max(0, maxQtyExit - qty), o.lot) * price,
        over: qty > maxQtyExit,                                // vượt ngưỡng thoát trong exitDays
        overLimit: qty > maxQtyLimit,                          // vượt cả ngưỡng tối đa
        scaleMax: maxQtyExit / qty,                            // bao nhiêu lần vị thế hiện tại thì chạm ngưỡng
        level: days > o.maxDays ? 'high' : (days > o.exitDays ? 'med' : 'ok'),
      });
    });
    rows.sort((a, b) => b.days - a.days);
    const exitValue = rows.reduce((s, r) => s + r.value, 0);
    const wDays = exitValue > 0 ? rows.reduce((s, r) => s + r.days * r.value, 0) / exitValue : null;
    const slowValue = rows.filter((r) => r.days > o.exitDays).reduce((s, r) => s + r.value, 0);
    const totalCost = rows.reduce((s, r) => s + (r.exitCostValue || 0), 0);
    // Hệ số quy mô: nhân MỌI vị thế lên k lần (giữ tỷ trọng) thì vị thế đầu tiên vượt ngưỡng exitDays là ở k = min(scaleMax)
    const limiting = rows.slice().sort((a, b) => a.scaleMax - b.scaleMax)[0] || null;
    const scale = limiting ? { k: limiting.scaleMax, symbol: limiting.symbol, canGrow: limiting.scaleMax > 1, navAtLimit: known * limiting.scaleMax } : null;
    return {
      rows: rows, missing: missing,
      totals: { value: total, knownValue: known, coveragePct: total > 0 ? known / total * 100 : null, weightedDays: wDays, worstDays: rows.length ? rows[0].days : null,
        slowPct: exitValue > 0 ? slowValue / exitValue * 100 : null, exitCost: totalCost, exitCostPct: exitValue > 0 ? totalCost / exitValue * 100 : null },
      scale: scale, params: o,
    };
  }

  // Ứng viên (mã theo dõi / ý tưởng): intent = [{symbol, value (đồng) dự định, price}]. Có xây được trong exitDays phiên chỉ với `rate` khối lượng ngày không?
  // Trả từng mã { buildDays, maxValue (xây tối đa trong exitDays phiên), ok, pctOfAdv, cost } và khoảng cách còn thiếu.
  function pipeline(intents, volumes, series, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    return (intents || []).map((x) => {
      const adv = averageVolume((volumes || {})[x.symbol], o.window), price = num(x.price), value = num(x.value);
      if (adv === null || !(price > 0) || !(value > 0)) return { symbol: x.symbol, unknown: true };
      const sigma = dailySigma((series || {})[x.symbol]), sigD = sigma === null ? o.sigDefault : sigma;
      const perDayValue = o.rate * adv * price, advValue = adv * price;
      const ec = exitCost(value, advValue, perDayValue, sigD, o);
      const maxValue = Math.floor(perDayValue * o.exitDays / (o.lot * price)) * o.lot * price;
      return { symbol: x.symbol, value: value, buildDays: value / perDayValue, maxValue: maxValue, ok: value <= perDayValue * o.exitDays, shortfall: Math.max(0, value - maxValue), pctOfAdv: value / advValue * 100, costPct: ec ? ec.pct : null, sigmaKnown: sigma !== null };
    });
  }

  return { DEFAULTS, dailySigma, averageVolume, impactFrac, exitCost, analyze, pipeline };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LiquidityCalc;
