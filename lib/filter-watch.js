// Logic thuần: THEO DÕI BỘ LỌC ĐÃ LƯU. So kết quả của từng bộ lọc đã lưu (Thị trường) trên hai ảnh chụp thị trường của hai ngày khác nhau để biết mã nào MỚI LỌT VÀO và mã nào VỪA RỚT RA, kèm lý do rớt.
// Ảnh chụp cũ lấy từ lịch sử lưu trong máy (lib/market-history.js); không đụng mạng/DOM/tệp. Cần MarketScreener (lib/market-screener.js) nạp trước.
// Cẩn thận so sánh sai: nếu một tiêu chí của bộ lọc CHƯA CÓ số liệu ở ngày cũ (ví dụ ảnh chụp trước khi có biến động giá từ 1/1) thì mọi mã sẽ "mới lọt vào" chỉ vì thiếu dữ liệu. Bộ lọc đó được đánh dấu
// không so sánh được (comparable = false) kèm lý do, thay vì báo sai.
// Nạp bằng thẻ <script> thường (global FilterWatch) và module.exports cho Vitest.
const FilterWatch = (function () {
  const MS = (typeof require === 'function' && typeof module !== 'undefined') ? require('./market-screener.js') : MarketScreener;
  const MIN_COVER_RATIO = 0.3;      // số liệu ở ngày cũ phải phủ ít nhất 30% so với ngày mới thì mới so sánh được

  const present = (v) => v !== null && v !== undefined && v !== '' && isFinite(Number(v));
  function coverage(rows, key) {
    const c = MS.BY_KEY[key];
    if (!c || !rows || !rows.length) return 0;
    let n = 0; rows.forEach((r) => { if (present(c.get(r))) n++; });
    return n / rows.length;
  }
  const keyOf = (e) => e.row.symbol;

  // saved: [{ name, filters }]; prevRows / currRows: kết quả MarketScreener.buildRows của hai ngày. Trả mảng kết quả theo từng bộ lọc.
  function compare(saved, prevRows, currRows) {
    const curBySym = {}; (currRows || []).forEach((r) => { curBySym[r.symbol] = r; });
    return (saved || []).map((s) => {
      const f = MS.normalizeFilters(s.filters), keys = Object.keys(f.values);
      if (!keys.length && !f.icbs.length) return { name: s.name, comparable: false, why: 'Bộ lọc trống.' };
      const bad = keys.filter((k) => { const a = coverage(currRows, k), b = coverage(prevRows, k); return a === 0 || b < a * MIN_COVER_RATIO; });   // chưa có số liệu ở ngày mới (a = 0) cũng không so sánh được: bộ lọc sẽ trống cả hai ngày
      if (bad.length) return { name: s.name, comparable: false, why: 'Chưa có đủ số liệu ở hai ngày so sánh cho: ' + bad.map((k) => MS.BY_KEY[k].label).join('; ') + '.' };
      const cur = MS.evaluate(currRows, f).entries, prev = MS.evaluate(prevRows, f).entries;
      const curSet = new Set(cur.map(keyOf)), prevSet = new Set(prev.map(keyOf));
      const entered = cur.filter((e) => !prevSet.has(keyOf(e))).map((e) => ({ symbol: e.row.symbol, name: e.row.name || '', icb: e.row.icb2_code || null, score: e.score }));
      const left = prev.filter((e) => !curSet.has(keyOf(e))).map((e) => {
        const r = curBySym[e.row.symbol];
        if (!r) return { symbol: e.row.symbol, name: e.row.name || '', reason: 'không còn trong ảnh chụp thị trường' };
        const one = MS.evaluate([r], f), c = one.counts, why = [];
        Object.keys(c.failedBy).forEach((k) => why.push(MS.BY_KEY[k].label));
        Object.keys(c.missing).forEach((k) => why.push(MS.BY_KEY[k].label + ' (thiếu số liệu)'));
        if (!why.length && one.entries.length === 0) why.push('bị cắt bởi giới hạn số mã');
        else if (!why.length) why.push('xếp thấp hơn nên bị cắt bởi giới hạn số mã');
        return { symbol: e.row.symbol, name: r.name || e.row.name || '', reason: why.slice(0, 3).join('; ') };
      });
      return { name: s.name, comparable: true, nowCount: cur.length, beforeCount: prev.length, stayed: cur.length - entered.length, entered: entered, left: left };
    });
  }

  // Tóm tắt một dòng cho thông báo: "Tên: +AAA, +BBB (+2 mã khác); −CCC"
  function summaryLine(item, maxShow) {
    const n = maxShow || 4;
    if (!item.comparable || (!item.entered.length && !item.left.length)) return '';
    const part = (list, sign) => list.length ? list.slice(0, n).map((x) => sign + x.symbol).join(', ') + (list.length > n ? ' (+' + (list.length - n) + ' mã khác)' : '') : '';
    return item.name + ': ' + [part(item.entered, '+'), part(item.left, '−')].filter(Boolean).join('; ');
  }
  const totals = (items) => (items || []).reduce((t, i) => { if (i.comparable) { t.entered += i.entered.length; t.left += i.left.length; } return t; }, { entered: 0, left: 0 });

  return { compare, coverage, summaryLine, totals, MIN_COVER_RATIO };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FilterWatch;
