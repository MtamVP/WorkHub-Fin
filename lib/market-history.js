// Logic thuần: LƯU TRỮ LỊCH SỬ ẢNH CHỤP THỊ TRƯỜNG trong máy (mỗi ngày dữ liệu mới một tệp), để sau này kiểm chứng các mẫu lọc bằng số liệu thật thay vì phán đoán.
// Vì sao cần: finance_market_snapshot trên máy chủ bị ghi đè mỗi ngày, số liệu quá khứ (P/E, tăng trưởng, giá từ đầu năm...) không lấy lại được từ nguồn miễn phí.
// KHÔNG đụng DOM/mạng/tệp. Nạp bằng thẻ <script> thường (global MarketHistory) và module.exports cho Vitest / script Node.
// Định dạng tệp (sau khi giải nén gzip là JSON): { v: 1, asOf: 'YYYY-MM-DD', savedAt: ISO, rows: [{ s: mã, i: ICB2, d: ngày chỉ số ngày, q: ngày chỉ số quý, m: { chỉ số } }], stats: { icb2: { n, as_of, stats } } }
const MarketHistory = (function () {
  const VERSION = 1;
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  // Ngày dữ liệu chung của ảnh chụp: ngày chỉ số ngày phổ biến nhất (khớp với snapshotDate của Edge Function); thiếu thì dùng asOf của thống kê ngành.
  function snapshotDate(snapshot, stats) {
    const c = {};
    (snapshot || []).forEach((r) => { if (isDate(r.daily_date)) c[r.daily_date] = (c[r.daily_date] || 0) + 1; });
    let best = null, n = 0;
    Object.keys(c).forEach((k) => { if (c[k] > n || (c[k] === n && best !== null && k > best)) { best = k; n = c[k]; } });
    if (best) return best;
    let asOf = null;
    Object.keys(stats || {}).forEach((k) => { const a = stats[k] && stats[k].as_of; if (isDate(a) && (!asOf || a > asOf)) asOf = a; });
    return asOf;
  }

  // snapshot: [{ symbol, icb2_code, daily_date, quarter_date, metrics }]; stats: { icb2: { n, as_of, stats } }. Trả null nếu quá ít mã (nguồn hỏng một phần: không lưu rác).
  function pack(snapshot, stats, opts) {
    const o = opts || {}, minRows = o.minRows === undefined ? 500 : o.minRows;
    const rows = (snapshot || []).filter((r) => r && r.symbol && r.metrics && typeof r.metrics === 'object');
    if (rows.length < minRows) return null;
    const asOf = o.asOf || snapshotDate(rows, stats);
    if (!isDate(asOf)) return null;
    return {
      v: VERSION, asOf: asOf, savedAt: o.savedAt || new Date().toISOString(),
      rows: rows.map((r) => ({ s: String(r.symbol).toUpperCase(), i: r.icb2_code || null, d: r.daily_date || null, q: r.quarter_date || null, m: r.metrics })),
      stats: stats || {},
    };
  }

  // Tệp -> đúng dạng đầu vào của MarketScreener.buildRows: { snapshot, stats, asOf }
  function unpack(obj) {
    if (!obj || obj.v !== VERSION || !Array.isArray(obj.rows)) return null;
    return { asOf: obj.asOf, savedAt: obj.savedAt, stats: obj.stats || {}, snapshot: obj.rows.map((r) => ({ symbol: r.s, icb2_code: r.i, daily_date: r.d, quarter_date: r.q, metrics: r.m || {} })) };
  }

  const fileName = (asOf) => 'snapshot-' + asOf + '.json.gz';
  function dateOfFile(name) { const m = /^snapshot-(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(String(name || '')); return m ? m[1] : null; }

  // Cần lưu không? Chỉ khi ngày dữ liệu của máy chủ mới hơn ngày mới nhất đã lưu (mỗi ngày giao dịch tối đa một tệp).
  function shouldArchive(asOf, existingFiles) {
    if (!isDate(asOf)) return false;
    return !(existingFiles || []).some((f) => dateOfFile(f) === asOf);
  }

  // Tóm tắt thư mục lưu trữ cho giao diện: số ngày, ngày đầu/cuối, số khoảng trống (ngày làm việc không có tệp giữa hai mốc).
  function summarize(existingFiles) {
    const days = (existingFiles || []).map(dateOfFile).filter(Boolean).sort();
    if (!days.length) return { count: 0, first: null, last: null, gaps: 0 };
    let gaps = 0;
    for (let i = 1; i < days.length; i++) {
      const a = Date.parse(days[i - 1] + 'T00:00:00Z'), b = Date.parse(days[i] + 'T00:00:00Z');
      let d = 0; for (let t = a + 86400000; t < b; t += 86400000) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) d++; }
      gaps += d;
    }
    return { count: days.length, first: days[0], last: days[days.length - 1], gaps: gaps };
  }

  return { VERSION, snapshotDate, pack, unpack, fileName, dateOfFile, shouldArchive, summarize };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MarketHistory;
