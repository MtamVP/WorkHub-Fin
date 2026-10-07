// Logic: CẢNH BÁO THEO GIÁ TRỰC TIẾP trong Danh Mục. Khi trang đang mở và giá trực tiếp (lib/live-quotes.js) cập nhật, so từng mã đang nắm với giá mục tiêu, ngưỡng cắt lỗ và biến động trong ngày.
// CHỈ BÁO (thông báo hệ điều hành + thông báo trong app): không ghi vào sổ, NAV hay lịch sử. Mỗi mức chỉ báo 1 lần/ngày.
// Khoá chống lặp dùng CÙNG định dạng với notify-deadlines.js (checkPriceAlerts: "MÃ:target:giá", "MÃ:stop:giá") nên cảnh báo cron 5 phút và cảnh báo trực tiếp không báo trùng nhau; khoá biến động là "MÃ:move_up:3" / "MÃ:move_down:3".
// Chỉ xét dòng có giá trực tiếp (h.live) và chưa khoá giá. Nạp bằng thẻ <script> thường (global LiveAlerts) và module.exports cho Vitest.
const LiveAlerts = (function () {
  const MOVE_CHOICES = [0, 3, 5, 7];      // 0 = tắt cảnh báo biến động; mức cho phép chọn trên giao diện (% so với giá tham chiếu)
  const DEFAULT_MOVE = 5;
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('vi-VN');
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

  function normalizeMove(v) { const n = Number(v); return MOVE_CHOICES.indexOf(n) >= 0 ? n : DEFAULT_MOVE; }

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

  // Cảnh báo chưa báo trong ngày (notified: Set hoặc mảng các khoá đã báo)
  function fresh(alerts, notified) {
    const seen = notified instanceof Set ? notified : new Set(notified || []);
    return (alerts || []).filter((a) => !seen.has(a.key));
  }

  // Nội dung thông báo; cùng lời với notify-deadlines.js cho mục tiêu/cắt lỗ.
  function message(a) {
    if (a.kind === 'target') return { title: 'Chạm giá mục tiêu: ' + a.symbol, body: 'Giá ' + fmt(a.price) + ' ≥ mục tiêu ' + fmt(a.threshold) + ' — cân nhắc chốt lời.' };
    if (a.kind === 'stop') return { title: 'Chạm ngưỡng cắt lỗ: ' + a.symbol, body: 'Giá ' + fmt(a.price) + ' ≤ ngưỡng ' + fmt(a.threshold) + ' — cân nhắc cắt lỗ.' };
    const p = Math.abs(num(a.pct)).toFixed(2).replace('.', ',');
    return a.kind === 'move_up'
      ? { title: a.symbol + ' tăng mạnh trong ngày', body: 'Giá ' + fmt(a.price) + ' đang +' + p + '% so với tham chiếu (ngưỡng báo ' + a.threshold + '%).' }
      : { title: a.symbol + ' giảm mạnh trong ngày', body: 'Giá ' + fmt(a.price) + ' đang −' + p + '% so với tham chiếu (ngưỡng báo ' + a.threshold + '%).' };
  }
  const levelOf = (a) => (a.kind === 'stop' || a.kind === 'move_down' ? 'bad' : 'good');

  return { MOVE_CHOICES, DEFAULT_MOVE, normalizeMove, evaluate, fresh, message, levelOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LiveAlerts;
