/* --- FILE: /insight/insight-util.js ---
   Tiện ích dùng chung cho các màn hình Insight: thoát HTML, định dạng số / tiền / ngày kiểu Việt Nam, và các mảnh giao diện nhỏ (thẻ số liệu, nhãn, ghi chú, trạng thái rỗng).
   Chỉ dựng chuỗi HTML (không đụng DOM) nên kiểm thử được bằng Vitest. Nạp bằng thẻ <script> thường (global InsUtil) và module.exports. */
const InsUtil = (function () {
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (v) => v !== null && v !== undefined && v !== '' && isFinite(Number(v));
  // 1 234 567 -> "1.234.567"; null/NaN -> "—"
  const int = (v) => (isNum(v) ? Math.round(Number(v)).toLocaleString('vi-VN') : '—');
  const dec = (v, d) => (isNum(v) ? Number(v).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d }) : '—');
  // Tiền đồng rút gọn: 1,25 tỷ / 340 triệu / 12.500 đ
  function money(v, d) {
    if (!isNum(v)) return '—';
    const n = Number(v), a = Math.abs(n), s = n < 0 ? '−' : '';
    if (a >= 1e12) return s + dec(a / 1e12, d === undefined ? 2 : d) + ' nghìn tỷ';
    if (a >= 1e9) return s + dec(a / 1e9, d === undefined ? 2 : d) + ' tỷ';
    if (a >= 1e6) return s + dec(a / 1e6, d === undefined ? 1 : d) + ' triệu';
    return s + int(a) + ' đ';
  }
  // tỷ lệ phân số -> "12,3%"; withSign thêm dấu +
  function pct(v, d, withSign) {
    if (!isNum(v)) return '—';
    const x = Number(v) * 100, s = withSign && x > 0 ? '+' : (x < 0 ? '−' : '');
    return s + Math.abs(x).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d }) + '%';
  }
  // số đã là phần trăm (6,89) -> "6,89%"
  const pctN = (v, d, withSign) => (isNum(v) ? pct(Number(v) / 100, d, withSign) : '—');
  const date = (v) => { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(8) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '—'; };
  const dateShort = (v) => { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(8) + '/' + s.slice(5, 7) : '—'; };
  const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);          // ngày theo giờ Việt Nam
  const ago = (iso, now) => {
    const t = Date.parse(iso); if (!isFinite(t)) return '—';
    const m = Math.round(((now || Date.now()) - t) / 60000);
    if (m < 1) return 'vừa xong'; if (m < 60) return m + ' phút trước'; if (m < 1440) return Math.round(m / 60) + ' giờ trước';
    return Math.round(m / 1440) + ' ngày trước';
  };
  const sign = (v) => (!isNum(v) || Number(v) === 0 ? '' : (Number(v) > 0 ? 'ins-up' : 'ins-down'));

  const tag = (text, tone) => '<span class="ins-tag' + (tone ? ' ' + tone : '') + '">' + esc(text) + '</span>';
  const kpi = (k, v, s, tone) => '<div class="ins-kpi' + (tone ? ' ' + tone : '') + '"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
  const kpis = (list) => '<div class="ins-kpis">' + list.join('') + '</div>';
  const note = (html, tone) => '<div class="ins-note' + (tone ? ' ' + tone : '') + '">' + html + '</div>';
  const empty = (icon, html) => '<div class="ins-empty"><i class="fa-solid fa-' + esc(icon) + '"></i>' + html + '</div>';
  const loading = (text) => '<div class="ins-empty"><i class="fa-solid fa-spinner fa-spin"></i>' + esc(text || 'Đang tải…') + '</div>';
  const card = (icon, title, body, tools) => '<section class="tl-card"><div class="tl-card-head"><h3><i class="fa-solid fa-' + esc(icon) + '"></i> ' + esc(title) + '</h3>' + (tools ? '<div class="tl-card-tools">' + tools + '</div>' : '') + '</div>' + body + '</section>';
  const meter = (frac, tone) => '<div class="ins-meter' + (tone ? ' ' + tone : '') + '"><span style="width:' + Math.max(0, Math.min(100, Math.round((Number(frac) || 0) * 100))) + '%"></span></div>';
  const table = (head, rows, opts) => {
    const o = opts || {};
    return '<div class="ins-table-wrap"><table class="ins-table"><thead><tr>' + head.map((h, i) => '<th scope="col"' + (o.left && o.left.indexOf(i) !== -1 ? ' class="t"' : '') + '>' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  };
  // Mã cổ phiếu hợp lệ từ ô nhập
  const parseSymbols = (text, cap) => { const seen = {}, out = []; String(text || '').split(/[,;\s]+/).forEach((t) => { const s = t.trim().toUpperCase(); if (/^[A-Z0-9]{1,12}$/.test(s) && !seen[s]) { seen[s] = 1; out.push(s); } }); return out.slice(0, cap || 40); };

  // Đường kẻ ngang (lưới) và nhãn trục Y cho SVG: ticks đẹp trong [lo, hi]
  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1, step0 = span / (n || 4), mag = Math.pow(10, Math.floor(Math.log10(step0))), f = step0 / mag;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * Math.abs(hi || 1); v += step) out.push(v);
    return out;
  }

  return { esc, isNum, int, dec, money, pct, pctN, date, dateShort, today, ago, sign, tag, kpi, kpis, note, empty, loading, card, meter, table, parseSymbols, niceTicks };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = InsUtil;
