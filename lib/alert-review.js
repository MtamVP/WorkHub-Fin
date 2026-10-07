// Logic thuần: ÔN LẠI CẢNH BÁO GIÁ. Cảnh báo theo giá trực tiếp (lib/live-alerts.js) kêu xong thì sao? Mỗi cảnh báo theo mã được ghi lại kèm giá lúc báo; các lần mở app sau đó cập nhật giá của phiên kế tiếp
// và giá gần nhất, để đo giá ĐI TIẾP theo chiều cảnh báo, QUAY ĐẦU hay ĐI NGANG. Từ đó biết ngưỡng 3/5/7% hay mức mục tiêu/cắt lỗ có hay báo hụt không. Lưu TRONG MÁY, không ghi sổ, không lên Supabase.
// Chiều của từng loại: mục tiêu và tăng mạnh = lên; cắt lỗ, giảm mạnh và tới giá mua = xuống (giá rẻ hơn). Chênh lệch luôn tính THEO CHIỀU CẢNH BÁO: dương = giá đi tiếp cùng chiều, âm = quay đầu.
// Giá phiên sau là giá lần cuối app thấy trong phiên đó (app không mở thì không có), nên đây là thống kê của riêng bạn, mẫu nhỏ; không phải kiểm định thống kê và không phải khuyến nghị.
// KHÔNG đụng DOM/mạng/tệp. Nạp bằng thẻ <script> thường (global AlertReview) và module.exports cho Vitest.
const AlertReview = (function () {
  const KEEP = 600, KEEP_DAYS = 180;
  const FLAT_PCT = 1;               // trong khoảng ±1% so với giá lúc báo = đi ngang
  const MIN_N = 10;                 // ít hơn thế thì chỉ liệt kê, không rút kết luận
  const KINDS = {
    target:    { label: 'Chạm giá mục tiêu', dir: 1, cont: 'giá còn đi tiếp lên sau khi chạm mục tiêu', rev: 'giá quay xuống sau khi chạm mục tiêu' },
    stop:      { label: 'Chạm ngưỡng cắt lỗ', dir: -1, cont: 'giá còn giảm tiếp sau khi chạm ngưỡng cắt lỗ', rev: 'giá hồi lại sau khi chạm ngưỡng cắt lỗ' },
    move_up:   { label: 'Tăng mạnh trong ngày', dir: 1, cont: 'giá còn tăng tiếp', rev: 'giá quay xuống' },
    move_down: { label: 'Giảm mạnh trong ngày', dir: -1, cont: 'giá còn giảm tiếp', rev: 'giá hồi lại' },
    buy:       { label: 'Tới giá muốn mua', dir: -1, cont: 'giá còn rẻ hơn', rev: 'giá hồi lại' },
  };
  const ORDER = ['target', 'stop', 'move_up', 'move_down', 'buy'];
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const iso = (v) => String(v || '').slice(0, 10);
  const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);

  // Ghi một cảnh báo mới. a: { symbol, kind, price, threshold, pct }; ctx: { date (ngày VN), time }. Cảnh báo cùng ngày + cùng khoá chỉ ghi một lần. Trả kho mới.
  function record(hist, a, ctx) {
    const h = Array.isArray(hist) ? hist.slice() : [], c = ctx || {};
    if (!a || !KINDS[a.kind] || !a.symbol || !(num(a.price) > 0) || !iso(c.date)) return h;
    const id = iso(c.date) + '|' + a.symbol + '|' + a.kind + '|' + (num(a.threshold) === null ? '' : num(a.threshold));
    if (h.some((x) => x.id === id)) return h;
    h.push({ id: id, date: iso(c.date), time: c.time || '', s: String(a.symbol).toUpperCase(), kind: a.kind, thr: num(a.threshold), price: Math.round(num(a.price)), pct: num(a.pct) === null ? null : r2(a.pct),
      d1: null, d1Date: null, last: null, lastDate: null });
    return prune(h, c.date);
  }

  function prune(hist, today) {
    const t = Date.parse(iso(today) + 'T00:00:00Z');
    let h = hist.filter((x) => !isFinite(t) || (t - Date.parse(x.date + 'T00:00:00Z')) / 86400000 <= KEEP_DAYS);
    if (h.length > KEEP) h = h.slice(-KEEP);
    return h;
  }

  // Cập nhật giá sau cảnh báo từ giá trực tiếp hiện có. quotes: { MÃ: { price, date } } (LiveQuotes.state.quotes); today: ngày VN.
  // d1 = giá lần cuối thấy trong phiên ĐẦU TIÊN sau ngày báo (cập nhật tới hết phiên đó); last = giá mới nhất. Trả { hist, changed }.
  function update(hist, quotes, today) {
    const q = quotes || {}, td = iso(today);
    let changed = false;
    const out = (hist || []).map((x) => {
      const k = q[x.s];
      if (!k || !(num(k.price) > 0)) return x;
      const d = iso(k.date) || td;
      if (!(d > x.date) || d > td) return x;                           // chưa sang phiên sau (hoặc dữ liệu lạ từ tương lai)
      const p = Math.round(num(k.price));
      let y = x;
      const set = (patch) => { y = Object.assign({}, y, patch); };
      if (!x.d1Date || x.d1Date === d) { if (x.d1 !== p || x.d1Date !== d) set({ d1: p, d1Date: d }); }
      if ((!x.lastDate || d >= x.lastDate) && (x.last !== p || x.lastDate !== d)) set({ last: p, lastDate: d });
      if (y !== x) changed = true;
      return y;
    });
    return { hist: out, changed: changed };
  }

  // Chênh lệch % so với giá lúc báo, THEO CHIỀU cảnh báo (dương = đi tiếp cùng chiều)
  function oriented(entry, price) {
    const k = KINDS[entry.kind], p = num(price);
    if (!k || !(p > 0) || !(entry.price > 0)) return null;
    return r2((p / entry.price - 1) * 100 * k.dir);
  }
  const verdictOf = (pct) => (pct === null ? null : (pct >= FLAT_PCT ? 'cont' : (pct <= -FLAT_PCT ? 'rev' : 'flat')));
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // Từng cảnh báo kèm kết quả (mới nhất trước). Hạn chế bằng limit.
  function rows(hist, limit) {
    const list = (hist || []).slice().sort((a, b) => (a.date === b.date ? (a.time < b.time ? 1 : -1) : (a.date < b.date ? 1 : -1)));
    return (limit ? list.slice(0, limit) : list).map((x) => {
      const d1 = oriented(x, x.d1), last = oriented(x, x.last);
      return Object.assign({}, x, { label: KINDS[x.kind].label, d1Pct: d1, lastPct: last, d1Verdict: verdictOf(d1), lastVerdict: verdictOf(last) });
    });
  }

  // Tổng hợp theo loại cảnh báo, chỉ tính cảnh báo ĐÃ có giá phiên sau (d1). Trả [{ kind, label, n, pending, cont, rev, flat, median, mean, enough, text }]
  function summarize(hist) {
    const out = [];
    ORDER.forEach((kind) => {
      const all = (hist || []).filter((x) => x.kind === kind);
      if (!all.length) return;
      const k = KINDS[kind], vals = all.map((x) => oriented(x, x.d1)).filter((v) => v !== null);
      const cont = vals.filter((v) => v >= FLAT_PCT).length, rev = vals.filter((v) => v <= -FLAT_PCT).length, flat = vals.length - cont - rev;
      const row = { kind: kind, label: k.label, total: all.length, n: vals.length, pending: all.length - vals.length, cont: cont, rev: rev, flat: flat,
        median: vals.length ? r2(median(vals)) : null, mean: vals.length ? r2(vals.reduce((s, v) => s + v, 0) / vals.length) : null, enough: vals.length >= MIN_N };
      row.text = !vals.length ? 'Chưa có phiên sau cảnh báo nào được ghi nhận.'
        : (row.enough ? Math.round(cont / vals.length * 100) + '% ' + k.cont + ', ' + Math.round(rev / vals.length * 100) + '% ' + k.rev + ', ' + Math.round(flat / vals.length * 100) + '% đi ngang (±' + FLAT_PCT + '%).'
          : 'Mới ' + vals.length + ' cảnh báo có phiên sau (cần từ ' + MIN_N + ' để rút nhận xét): ' + cont + ' ' + 'đi tiếp, ' + rev + ' quay đầu, ' + flat + ' đi ngang.');
      out.push(row);
    });
    return out;
  }

  // Hàng nhật ký quyết định gợi ý từ một cảnh báo (người dùng xem và sửa trước khi lưu). Trả null nếu loại cảnh báo không có mã.
  function decisionDraft(x) {
    const k = x && KINDS[x.kind];
    if (!k) return null;
    const when = (x.time ? x.time + ' ' : '') + iso(x.date).split('-').reverse().join('/');
    const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('vi-VN');
    const tags = ['cảnh báo giá'];
    if (x.kind === 'target') return { action: 'sell', symbol: x.s, date: iso(x.date), price: x.price, reason: 'Cảnh báo giá lúc ' + when + ': giá ' + fmt(x.price) + ' chạm mục tiêu ' + fmt(x.thr) + '. Quyết định: ', tags: tags };
    if (x.kind === 'stop') return { action: 'sell', symbol: x.s, date: iso(x.date), price: x.price, reason: 'Cảnh báo giá lúc ' + when + ': giá ' + fmt(x.price) + ' chạm ngưỡng cắt lỗ ' + fmt(x.thr) + '. Quyết định: ', tags: tags };
    if (x.kind === 'buy') return { action: 'buy', symbol: x.s, date: iso(x.date), price: x.price, reason: 'Cảnh báo giá lúc ' + when + ': mã trong Theo Dõi tới giá muốn mua ' + fmt(x.thr) + ' (giá ' + fmt(x.price) + '). Quyết định: ', tags: tags };
    const p = x.pct === null || x.pct === undefined ? '' : ' (' + (x.pct > 0 ? '+' : '−') + Math.abs(x.pct).toFixed(1).replace('.', ',') + '% so với tham chiếu)';
    return { action: 'hold', symbol: x.s, date: iso(x.date), price: x.price, reason: 'Cảnh báo giá lúc ' + when + ': ' + k.label.toLowerCase() + ' ' + fmt(x.price) + p + '. Quyết định: ', tags: tags };
  }

  const HEADER = ['Ngày', 'Giờ', 'Mã', 'Loại', 'Ngưỡng', 'Giá lúc báo', 'Giá phiên sau', 'Ngày phiên sau', '% phiên sau (theo chiều cảnh báo)', 'Giá gần nhất', 'Ngày gần nhất', '% gần nhất (theo chiều cảnh báo)'];
  function csvRows(hist) {
    const out = [HEADER];
    rows(hist).forEach((r) => out.push([r.date, r.time, r.s, r.label, r.thr === null ? '' : r.thr, r.price, r.d1 === null ? '' : r.d1, r.d1Date || '', r.d1Pct === null ? '' : r.d1Pct, r.last === null ? '' : r.last, r.lastDate || '', r.lastPct === null ? '' : r.lastPct]));
    return out;
  }

  return { KEEP, KEEP_DAYS, FLAT_PCT, MIN_N, KINDS, ORDER, record, update, oriented, rows, summarize, decisionDraft, csvRows, HEADER };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AlertReview;
