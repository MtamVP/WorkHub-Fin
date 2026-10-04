// Logic thuần: QUY ĐỊNH GIAO DỊCH CỔ PHIẾU THỊ TRƯỜNG VIỆT NAM -- biên độ giá theo sàn (HOSE ±7%, HNX ±10%, UPCoM ±15%), bước giá (HOSE: <10.000đ là 10đ, 10.000-49.950đ là 50đ, từ 50.000đ là 100đ; HNX/UPCoM 100đ),
// giá trần/sàn từ giá tham chiếu (làm tròn trần xuống, sàn lên theo bước giá), lô chẵn 100, chu kỳ thanh toán T+2 (cổ phiếu mua chưa về tài khoản chưa bán được; tiền bán chưa về), và thiệt hại khi cổ phiếu "kẹt sàn" nhiều phiên.
// Các quy định này tồn tại để kiểm lệnh TRƯỚC khi đặt: giá ngoài biên độ hoặc lệch bước giá bị từ chối ở sàn, bán cổ phiếu chưa về bị công ty chứng khoán từ chối.
// Nguồn quy tắc: quy chế giao dịch HOSE/HNX (đã đối chiếu số liệu thật: FPT tham chiếu 62,7 -> trần 67,0, sàn 58,4). KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VnMarket) và module.exports cho Vitest.
// Giới hạn: lịch nghỉ lễ KHÔNG nhúng sẵn -- danh sách phiên giao dịch được truyền vào (suy ra từ chuỗi VN-Index); thiếu thì chỉ bỏ qua thứ Bảy, Chủ Nhật. Giá tham chiếu UPCoM là bình quân gia quyền chứ không phải giá đóng cửa
// nên trần/sàn UPCoM tính từ giá đóng cửa chỉ là xấp xỉ (hàm trả cờ approx).
const VnMarket = (function () {
  const BAND = { HOSE: 0.07, HNX: 0.10, UPCOM: 0.15 };
  const LOT = 100;
  const SETTLE_DAYS = 2;
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const iso = (v) => String(v || '').slice(0, 10);
  const norm = (ex) => { const e = String(ex || '').toUpperCase(); return e === 'HSX' ? 'HOSE' : (BAND[e] ? e : 'HOSE'); };

  // Bước giá (đồng). ETF/chứng chỉ quỹ/chứng quyền có quy tắc khác nên trả null (không kiểm).
  function tickSize(price, exchange, type) {
    const t = String(type || 'STOCK').toUpperCase();
    if (t !== 'STOCK') return null;
    const p = num(price), ex = norm(exchange);
    if (ex !== 'HOSE') return 100;
    return p < 10000 ? 10 : (p < 50000 ? 50 : 100);
  }
  function roundToTick(price, exchange, mode, type) {
    const p = num(price), tick = tickSize(p, exchange, type);
    if (!tick) return p;
    const q = p / tick;
    const r = mode === 'down' ? Math.floor(q + 1e-9) : (mode === 'up' ? Math.ceil(q - 1e-9) : Math.round(q));
    return Math.round(r * tick * 100) / 100;
  }
  // Giá trần / sàn trong phiên từ giá tham chiếu. Nếu làm tròn khiến trần hoặc sàn trùng tham chiếu (giá rất thấp) thì lệch một bước giá.
  function limits(ref, exchange, type) {
    const r = num(ref), ex = norm(exchange), b = BAND[ex];
    if (!(r > 0)) return null;
    let ceiling = roundToTick(r * (1 + b), ex, 'down', type), floor = roundToTick(r * (1 - b), ex, 'up', type);
    const tick = tickSize(r, ex, type);
    if (tick) { if (ceiling <= r) ceiling = r + tick; if (floor >= r) floor = Math.max(tick, r - tick); }
    return { ref: r, ceiling: ceiling, floor: floor, bandPct: Math.round(b * 10000) / 100, tick: tick, exchange: ex, approx: ex === 'UPCOM' };
  }
  // Kiểm giá đặt: nằm trong [sàn, trần] và đúng bước giá. Trả { ok, reasons[], ...limits }
  function checkPrice(price, ref, exchange, type) {
    const p = num(price), L = limits(ref, exchange, type);
    if (!L || !(p > 0)) return { ok: true, skipped: true, reasons: [] };
    const reasons = [];
    const inBand = p >= L.floor - 1e-9 && p <= L.ceiling + 1e-9;
    if (!inBand) reasons.push(p > L.ceiling ? 'above_ceiling' : 'below_floor');
    const tick = tickSize(p, exchange, type);
    const onTick = !tick || Math.abs(p / tick - Math.round(p / tick)) < 1e-6;
    if (!onTick) reasons.push('off_tick');
    return Object.assign({ ok: reasons.length === 0, reasons: reasons, inBand: inBand, onTick: onTick, price: p }, L);
  }
  function lotCheck(quantity) { const q = num(quantity); return { ok: q > 0 && q % LOT === 0, oddLot: q > 0 && q % LOT !== 0, lot: LOT }; }

  // ---- lịch phiên và thanh toán ----
  const isWeekend = (d) => { const w = new Date(iso(d) + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; };
  const addDays = (d, n) => new Date(Date.parse(iso(d) + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  // Ngày giao dịch thứ n sau `date`. sessions: các phiên đã biết (tăng dần, từ VN-Index); phần vượt quá phiên đã biết đếm theo ngày trong tuần.
  function sessionAfter(date, n, sessions) {
    const d0 = iso(date), known = (sessions || []).map(iso).filter((x) => x > d0).sort();
    let cur = d0, k = 0, i = 0;
    while (k < n) {
      if (i < known.length) { cur = known[i++]; k++; continue; }
      cur = addDays(cur, 1);
      if (!isWeekend(cur)) k++;
    }
    return cur;
  }
  // Ngày cổ phiếu mua / tiền bán về tài khoản (T+2 phiên)
  function settleDate(tradeDate, sessions, days) { return sessionAfter(tradeDate, days === undefined ? SETTLE_DAYS : days, sessions); }

  // txns: sổ lệnh chưa xoá; today: ngày hiện tại. Trả cổ phiếu mua chưa về, tiền bán chưa về (theo mã), và cổ phiếu bán được.
  // Giả định: lệnh ghi theo ngày giao dịch (trade_date); lệnh nhập sao kê cũ đều đã thanh toán xong vì cách xa hơn T+2.
  function unsettled(txns, today, sessions) {
    const t = iso(today), buys = {}, sellCash = [];
    (txns || []).filter((x) => !x.deleted_at).forEach((x) => {
      const sd = settleDate(x.trade_date, sessions);
      if (sd <= t) return;       // đã về
      const sym = String(x.symbol).toUpperCase();
      if (x.type === 'buy') { const b = buys[sym] || (buys[sym] = { quantity: 0, lots: [] }); b.quantity += num(x.quantity); b.lots.push({ quantity: num(x.quantity), settleDate: sd, tradeDate: iso(x.trade_date) }); }
      else if (x.type === 'sell') sellCash.push({ symbol: sym, amount: num(x.quantity) * num(x.price) - num(x.fee) - num(x.tax), settleDate: sd, tradeDate: iso(x.trade_date) });
    });
    return { buys: buys, sellCash: sellCash, cashPending: sellCash.reduce((s, c) => s + c.amount, 0) };
  }
  // Số cổ phiếu bán được hôm nay của một mã = đang giữ - mua chưa về (không âm); trả cả ngày về sớm nhất
  function sellable(symbol, held, un) {
    const b = un && un.buys ? un.buys[String(symbol).toUpperCase()] : null;
    const locked = b ? Math.min(num(held), b.quantity) : 0;
    const next = b && b.lots.length ? b.lots.map((l) => l.settleDate).sort()[0] : null;
    return { sellable: Math.max(0, num(held) - locked), locked: locked, nextSettle: next };
  }

  // Kẹt sàn n phiên liên tiếp: giá mất 1-(1-b)^n (không bán được trong thời gian đó). Dùng cho kịch bản căng thẳng thanh khoản.
  function lockedLossPct(exchange, sessions) {
    const b = BAND[norm(exchange)], n = Math.max(0, Math.round(num(sessions)));
    return (1 - Math.pow(1 - b, n)) * 100;
  }

  return { BAND, LOT, SETTLE_DAYS, tickSize, roundToTick, limits, checkPrice, lotCheck, sessionAfter, settleDate, unsettled, sellable, lockedLossPct, norm };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VnMarket;
