// Logic: DIỄN BIẾN LÃI/LỖ TRONG NGÀY của danh mục. Mỗi lần giá trực tiếp cập nhật, app ghi một điểm (tối đa 1 điểm/phút) vào bộ nhớ của máy (không gửi lên máy chủ) rồi vẽ đường lãi/lỗ hôm nay.
// Bộ nhớ là một đối tượng { 'YYYY-MM-DD': [[phút trong ngày (0-1439, giờ VN), lãi lỗ ngày (đồng), % ngày, giá trị thị trường], ...] }, chỉ giữ vài ngày gần nhất.
// Điểm đo lãi/lỗ so với giá tham chiếu hôm nay của các mã đang nắm tại thời điểm đó: nếu bạn mua/bán giữa phiên thì đường đổi mức tương ứng (không điều chỉnh).
// Hàm vẽ trả chuỗi SVG (không đụng DOM) nên kiểm thử được. Nạp bằng thẻ <script> thường (global LiveSeries) và module.exports cho Vitest.
const LiveSeries = (function () {
  const KEEP_DAYS = 10, OPEN = 540, AM_END = 690, PM_START = 780, CLOSE = 890;   // 9:00-11:30, 13:00-14:50; nghỉ trưa 90 phút bị nén khỏi trục
  const AXIS = (AM_END - OPEN) + (CLOSE - PM_START);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function vnParts(ms) { const t = new Date(ms + 7 * 3600000); return { date: t.toISOString().slice(0, 10), min: t.getUTCHours() * 60 + t.getUTCMinutes() }; }
  const hhmm = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

  // Ghi điểm (thay điểm cùng phút). v: { pnl, pct, mv }. Trả bộ nhớ mới (không sửa bộ nhớ cũ); bỏ qua giá trị không hợp lệ.
  function record(store, ms, v) {
    const s = Object.assign({}, store || {});
    if (!v || !isFinite(v.pnl) || !isFinite(v.pct)) return s;
    const p = vnParts(ms);
    if (p.min < OPEN - 15 || p.min > CLOSE + 40) return s;          // ngoài khung phiên (cho phép vài phút đệm ATO/ATC): không ghi
    const day = (s[p.date] || []).filter((r) => r[0] !== p.min);
    day.push([p.min, Math.round(v.pnl), Math.round(v.pct * 100) / 100, Math.round(Number(v.mv) || 0)]);
    day.sort((a, b) => a[0] - b[0]);
    s[p.date] = day;
    const keep = Object.keys(s).sort().slice(-KEEP_DAYS), out = {};
    keep.forEach((k) => { out[k] = s[k]; });
    return out;
  }
  const points = (store, date) => ((store && store[date]) || []).slice();

  // Thống kê: điểm đầu, cuối, cao nhất, thấp nhất
  function stats(pts) {
    if (!pts || !pts.length) return null;
    let hi = pts[0], lo = pts[0];
    pts.forEach((r) => { if (r[1] > hi[1]) hi = r; if (r[1] < lo[1]) lo = r; });
    return { first: pts[0], last: pts[pts.length - 1], high: hi, low: lo, n: pts.length };
  }

  // Số tiền gọn: 1.234.567 -> "1,2 tr", 12.345 -> "12 nghìn"; có dấu +/−
  function money(n) {
    const a = Math.abs(n), sign = n > 0 ? '+' : (n < 0 ? '−' : '');
    if (a >= 1e9) return sign + (a / 1e9).toFixed(2).replace('.', ',') + ' tỷ';
    if (a >= 1e6) return sign + (a / 1e6).toFixed(1).replace('.', ',') + ' tr';
    if (a >= 1e3) return sign + Math.round(a / 1e3) + ' nghìn';
    return sign + Math.round(a);
  }
  const xOf = (min, w) => {
    const m = Math.max(OPEN, Math.min(CLOSE, min)), t = m <= AM_END ? m - OPEN : (m < PM_START ? AM_END - OPEN : (AM_END - OPEN) + (m - PM_START));
    return (t / AXIS) * w;
  };

  // SVG đường lãi/lỗ trong ngày: đường 0 nét đứt, vùng tô tới đường 0, điểm cuối nhấn, nhãn cao/thấp, mốc giờ; từng điểm có tooltip. Ít hơn 2 điểm: trả chuỗi rỗng.
  function svg(pts, o) {
    if (!pts || pts.length < 2) return '';
    const opt = o || {}, W = opt.width || 640, H = opt.height || 120, PAD = 16, top = PAD, bot = H - 22, st = stats(pts);
    let lo = Math.min(0, st.low[1]), hi = Math.max(0, st.high[1]);
    if (hi - lo < 1) { hi += 1; lo -= 1; }
    const yOf = (v) => top + (hi - v) / (hi - lo) * (bot - top), y0 = yOf(0);
    const X = (r) => 8 + xOf(r[0], W - 16);
    const d = pts.map((r, i) => (i ? 'L' : 'M') + X(r).toFixed(1) + ' ' + yOf(r[1]).toFixed(1)).join(' ');
    const up = st.last[1] >= 0, cls = up ? 'ls-up' : 'ls-down';
    const area = d + ' L' + X(pts[pts.length - 1]).toFixed(1) + ' ' + y0.toFixed(1) + ' L' + X(pts[0]).toFixed(1) + ' ' + y0.toFixed(1) + ' Z';
    const lx = X(st.last), ly = yOf(st.last[1]);
    const ticks = [[540, '9:00'], [600, '10:00'], [690, '11:30 · 13:00'], [840, '14:00'], [890, '14:50']].map((t) => '<text class="ls-tick" x="' + (8 + xOf(t[0], W - 16)).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (t[0] === 540 ? 'start' : (t[0] === 890 ? 'end' : 'middle')) + '">' + t[1] + '</text>').join('');
    const step = Math.max(1, Math.ceil(pts.length / 60));
    const dots = pts.filter((r, i) => i % step === 0 || i === pts.length - 1).map((r) => '<circle class="ls-hit" cx="' + X(r).toFixed(1) + '" cy="' + yOf(r[1]).toFixed(1) + '" r="5"><title>' + esc(hhmm(r[0]) + ' · ' + money(r[1]) + ' (' + (r[2] >= 0 ? '+' : '−') + Math.abs(r[2]).toFixed(2).replace('.', ',') + '%)') + '</title></circle>').join('');
    const label = (r, txt, dy) => '<text class="ls-lab" x="' + Math.min(W - 8, Math.max(8, X(r))).toFixed(1) + '" y="' + (yOf(r[1]) + dy).toFixed(1) + '" text-anchor="middle">' + esc(txt) + '</text>';
    const marks = (st.high[0] !== st.last[0] && st.high[1] > 0 ? label(st.high, 'cao ' + money(st.high[1]), -5) : '') + (st.low[0] !== st.last[0] && st.low[1] < 0 ? label(st.low, 'thấp ' + money(st.low[1]), 12) : '');
    return '<svg class="live-series-svg ' + cls + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc('Lãi lỗ trong ngày: hiện ' + money(st.last[1]) + ', cao nhất ' + money(st.high[1]) + ', thấp nhất ' + money(st.low[1])) + '">' +
      '<line class="ls-zero" x1="8" x2="' + (W - 8) + '" y1="' + y0.toFixed(1) + '" y2="' + y0.toFixed(1) + '"/>' +
      '<path class="ls-area" d="' + area + '"/><path class="ls-line" d="' + d + '"/>' + marks +
      '<circle class="ls-end" cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="4"/>' + dots + ticks + '</svg>';
  }

  return { KEEP_DAYS, record, points, stats, money, svg, xOf, vnParts };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LiveSeries;
