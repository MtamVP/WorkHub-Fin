// Logic: CẢNH BÁO THEO GIÁ TRỰC TIẾP trong Danh Mục. Khi trang đang mở và giá trực tiếp (lib/live-quotes.js) cập nhật, so từng mã đang nắm với giá mục tiêu, ngưỡng cắt lỗ và biến động trong ngày.
// CHỈ BÁO (thông báo hệ điều hành + thông báo trong app): không ghi vào sổ, NAV hay lịch sử. Mỗi mức chỉ báo 1 lần/ngày.
// Khoá chống lặp dùng CÙNG định dạng với notify-deadlines.js (checkPriceAlerts: "MÃ:target:giá", "MÃ:stop:giá") nên cảnh báo cron 5 phút và cảnh báo trực tiếp không báo trùng nhau; khoá biến động là "MÃ:move_up:3" / "MÃ:move_down:3".
// Chỉ xét dòng có giá trực tiếp (h.live) và chưa khoá giá. Nạp bằng thẻ <script> thường (global LiveAlerts) và module.exports cho Vitest.
const LiveAlerts = (function () {
  const MOVE_CHOICES = [0, 3, 5, 7];      // 0 = tắt cảnh báo biến động; mức cho phép chọn trên giao diện (% so với giá tham chiếu)
  const DEFAULT_MOVE = 5;
  const NAV_CHOICES = [0, 1, 2, 3, 5];     // báo khi NAV cả danh mục giảm vượt mức này (% so với NAV theo giá tham chiếu hôm qua); 0 = tắt
  const DEFAULT_NAV = 2;
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('vi-VN');
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

  function normalizeMove(v) { const n = Number(v); return MOVE_CHOICES.indexOf(n) >= 0 ? n : DEFAULT_MOVE; }
  function normalizeNav(v) { const n = Number(v); return NAV_CHOICES.indexOf(n) >= 0 ? n : DEFAULT_NAV; }

  // holdings: kết quả LiveQuotes.applyToHoldings. opts: { movePct } (0 = tắt). Trả mảng { symbol, kind: 'target'|'stop'|'move_up'|'move_down', price, threshold, key }.
  function evaluate(holdings, opts) {
    const o = opts || {}, move = o.movePct === undefined ? DEFAULT_MOVE : normalizeMove(o.movePct), out = [];
    (holdings || []).forEach((h) => {
      if (!h || !h.live || h.priceLocked) return;
      const price = num(h.marketPrice);
      if (!(price > 0)) return;
      const target = num(h.targetPrice), stop = num(h.stopLoss), sym = h.symbol;
      if (target > 0 && price >= target) out.push({ symbol: sym, kind: 'target', price: price, threshold: target, key: sym + ':target:' + target });
      if (stop > 0 && price <= stop) out.push({ symbol: sym, kind: 'stop', price: price, threshold: stop, key: sym + ':stop:' + stop });
      const pct = h.dayPct;
      if (move > 0 && typeof pct === 'number' && isFinite(pct)) {
        if (pct >= move) out.push({ symbol: sym, kind: 'move_up', price: price, threshold: move, pct: pct, key: sym + ':move_up:' + move });
        else if (pct <= -move) out.push({ symbol: sym, kind: 'move_down', price: price, threshold: move, pct: pct, key: sym + ':move_down:' + move });
      }
    });
    return out;
  }

  // Danh sách Theo Dõi đã áp giá trực tiếp (LiveQuotes.applyToWatchlist): mã CHƯA giữ có giá <= giá muốn mua thì báo "tới giá mua". Khoá "MÃ:buy:giá muốn mua" cùng định dạng với notify-deadlines.js.
  function evaluateWatch(list) {
    const out = [];
    (list || []).forEach((w) => {
      if (!w || !w.live || w.held || w.signal !== 'buy') return;
      out.push({ symbol: w.symbol, kind: 'buy', price: num(w.price), threshold: num(w.buyBelow), key: w.symbol + ':buy:' + w.buyBelow });
    });
    return out;
  }

  // CẤP DANH MỤC: NAV giảm trong ngày. pf: { dayPnl (đồng, theo giá tham chiếu hôm qua), nav (NAV hiện tại theo giá trực tiếp) }; opts: { navPct }.
  // Mẫu số là NAV theo giá tham chiếu = nav - dayPnl, nên tiền mặt cũng nằm trong mẫu số (danh mục nhiều tiền mặt giảm ít hơn danh mục cổ phiếu).
  function evaluatePortfolio(pf, opts) {
    const thr = opts && opts.navPct !== undefined ? normalizeNav(opts.navPct) : DEFAULT_NAV, out = [];
    if (!pf || !(thr > 0) || typeof pf.dayPnl !== 'number' || !isFinite(pf.dayPnl) || !(num(pf.nav) > 0)) return out;
    const prev = num(pf.nav) - pf.dayPnl;
    if (!(prev > 0)) return out;
    const pct = pf.dayPnl / prev * 100;
    if (pct <= -thr) out.push({ symbol: 'Danh mục', kind: 'nav_down', pct: pct, amount: pf.dayPnl, nav: num(pf.nav), threshold: thr, key: 'PF:nav_down:' + thr });
    return out;
  }

  // CẤP DANH MỤC: giới hạn đầu tư bị vượt theo giá trực tiếp. items: LimitsCalc.evaluate(...).items; kinds: LimitsCalc.KINDS (nhãn). Chỉ lấy mục status 'breach'.
  function evaluateLimits(items, kinds) {
    const k = kinds || {}, out = [];
    (items || []).forEach((i) => {
      if (!i || i.status !== 'breach') return;
      const meta = k[i.kind] || { label: i.kind, unit: '' };
      const cur = i.kind === 'max_position_vnd' ? fmt(i.current) + ' đ' : (i.kind === 'max_leverage' ? Number(i.current).toFixed(2).replace('.', ',') + '×' : Number(i.current).toFixed(1).replace('.', ',') + '%');
      const thr = i.kind === 'max_position_vnd' ? fmt(i.threshold) + ' đ' : (i.kind === 'max_leverage' ? Number(i.threshold).toFixed(2).replace('.', ',') + '×' : Number(i.threshold).toFixed(1).replace('.', ',') + '%');
      const text = i.kind === 'blocked_symbol' ? 'đang giữ mã bị cấm' : (i.kind === 'min_cash_pct' ? cur + ' < tối thiểu ' + thr : cur + ' > ' + thr);
      out.push({ symbol: i.subject, kind: 'limit', limitKind: i.kind, label: meta.label, text: text, current: i.current, threshold: i.threshold, key: 'LIM:' + i.kind + ':' + i.subject + ':' + i.threshold });
    });
    return out;
  }

  // Cảnh báo chưa báo trong ngày (notified: Set hoặc mảng các khoá đã báo)
  function fresh(alerts, notified) {
    const seen = notified instanceof Set ? notified : new Set(notified || []);
    return (alerts || []).filter((a) => !seen.has(a.key));
  }

  // Nội dung thông báo; cùng lời với notify-deadlines.js cho mục tiêu/cắt lỗ.
  function message(a) {
    if (a.kind === 'target') return { title: 'Chạm giá mục tiêu: ' + a.symbol, body: 'Giá ' + fmt(a.price) + ' ≥ mục tiêu ' + fmt(a.threshold) + ' — cân nhắc chốt lời.' };
    if (a.kind === 'buy') return { title: 'Tới giá muốn mua: ' + a.symbol, body: 'Giá ' + fmt(a.price) + ' ≤ mức muốn mua ' + fmt(a.threshold) + ' — mã trong danh sách theo dõi.' };
    if (a.kind === 'stop') return { title: 'Chạm ngưỡng cắt lỗ: ' + a.symbol, body: 'Giá ' + fmt(a.price) + ' ≤ ngưỡng ' + fmt(a.threshold) + ' — cân nhắc cắt lỗ.' };
    if (a.kind === 'nav_down') return { title: 'Danh mục giảm mạnh trong ngày', body: 'NAV giảm ' + Math.abs(num(a.pct)).toFixed(2).replace('.', ',') + '% (' + fmt(Math.abs(num(a.amount))) + ' đ) so với tham chiếu hôm qua; ngưỡng báo ' + a.threshold + '%.' };
    if (a.kind === 'limit') return { title: 'Vượt giới hạn: ' + a.label + (a.symbol ? ' ' + a.symbol : ''), body: a.text + ' theo giá trong phiên — cân nhắc giảm tỷ trọng hoặc xem lại giới hạn.' };
    const p = Math.abs(num(a.pct)).toFixed(2).replace('.', ',');
    return a.kind === 'move_up'
      ? { title: a.symbol + ' tăng mạnh trong ngày', body: 'Giá ' + fmt(a.price) + ' đang +' + p + '% so với tham chiếu (ngưỡng báo ' + a.threshold + '%).' }
      : { title: a.symbol + ' giảm mạnh trong ngày', body: 'Giá ' + fmt(a.price) + ' đang −' + p + '% so với tham chiếu (ngưỡng báo ' + a.threshold + '%).' };
  }
  const levelOf = (a) => (a.kind === 'stop' || a.kind === 'move_down' || a.kind === 'nav_down' || a.kind === 'limit' ? 'bad' : 'good');

  return { MOVE_CHOICES, DEFAULT_MOVE, NAV_CHOICES, DEFAULT_NAV, normalizeMove, normalizeNav, evaluate, evaluateWatch, evaluatePortfolio, evaluateLimits, fresh, message, levelOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LiveAlerts;
