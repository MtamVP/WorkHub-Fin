// Logic thuần: KIỂM CHỨNG BỘ LỌC ĐÃ LƯU bằng lịch sử ảnh chụp thị trường lưu trong máy. Câu hỏi: những mã từng LỌT VÀO bộ lọc, 1, 3, 6 tháng sau giá đi thế nào so với cả thị trường?
// Cách đo (không cần giá lịch sử, chỉ dùng ảnh chụp): sự kiện = một mã lọt vào bộ lọc ở ngày D (ngày đầu tiên bộ lọc so sánh được thì mọi mã đạt đều tính; các ngày sau chỉ tính mã mới lọt vào;
// mã rớt rồi vào lại trong 30 ngày không tính lần nữa). Lợi suất sau h tháng = biến động giá h tháng (chg1m / chg3m / chg6m) ghi trong ảnh chụp của ngày gần D + h tháng nhất (trong khoảng -2 đến +7 ngày),
// vì biến động h tháng của ảnh chụp ngày đó đúng là lợi suất từ D đến ngày đó. So với TRUNG VỊ lợi suất cùng kỳ của mọi mã có số liệu trong chính ảnh chụp ấy (không dùng chỉ số bên ngoài).
// Giới hạn phải nói rõ: (1) mã bị hủy niêm yết hoặc mất số liệu thì không có lợi suất và bị bỏ ra (thiên lệch người sống sót, thường làm kết quả đẹp hơn thực tế); (2) các sự kiện cùng ngày chịu cùng một nhịp thị trường nên
// số sự kiện lớn hơn số mẫu độc lập (vì vậy đếm cả số ngày lọt vào); (3) giá chưa điều chỉnh mọi sự kiện vốn nếu nguồn không điều chỉnh; (4) lịch sử chỉ có những ngày bạn mở app, có ngày trống; (5) không phải khuyến nghị đầu tư.
// KHÔNG đụng DOM/mạng/tệp. Nạp bằng thẻ <script> thường (global FilterValidate) và module.exports cho Vitest. Cần MarketScreener (lib/market-screener.js).
const FilterValidate = (function () {
  const MS = (typeof require === 'function' && typeof module !== 'undefined') ? require('./market-screener.js') : MarketScreener;
  const HORIZONS = [{ key: '1m', months: 1, field: 'chg1m', label: '1 tháng' }, { key: '3m', months: 3, field: 'chg3m', label: '3 tháng' }, { key: '6m', months: 6, field: 'chg6m', label: '6 tháng' }];
  const COOLDOWN_DAYS = 30, EARLY_DAYS = 2, LATE_DAYS = 7, MIN_COVER_RATIO = 0.3;
  const MIN_EVENTS = 30, MIN_DATES = 5;      // dưới mức này chỉ liệt kê số liệu, không rút nhận xét
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const r4 = (v) => (v === null ? null : Math.round(v * 10000) / 10000);
  const dayMs = (iso) => Date.parse(iso + 'T00:00:00Z');
  const diffDays = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);
  function addMonths(iso, m) { const d = new Date(dayMs(iso)); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); }
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // Rút gọn một ảnh chụp: rows = MarketScreener.buildRows; saved = [{ name, filters }]. Trả
  // { matches: { tên: [mã] }, cover: { tên: { tiêu chí: tỷ lệ mã có số liệu } }, ret: { MÃ: [chg1m, chg3m, chg6m] } } (ret chỉ giữ mã có ít nhất một số liệu)
  function extractDay(rows, saved) {
    const matches = {}, cover = {}, ret = {};
    (rows || []).forEach((r) => {
      const v = HORIZONS.map((h) => num(r.m && r.m[h.field]));
      if (v.some((x) => x !== null)) ret[r.symbol] = v;
    });
    (saved || []).forEach((s) => {
      const f = MS.normalizeFilters(s.filters), keys = Object.keys(f.values);
      if (!keys.length && !f.icbs.length) return;
      matches[s.name] = MS.evaluate(rows, f).entries.map((e) => e.row.symbol);
      const c = {};
      keys.forEach((k) => { const crit = MS.BY_KEY[k]; let n = 0; (rows || []).forEach((r) => { const x = crit.get(r); if (x !== null && x !== undefined && x !== '' && isFinite(Number(x))) n++; }); c[k] = rows && rows.length ? n / rows.length : 0; });
      cover[s.name] = c;
    });
    return { matches: matches, cover: cover, ret: ret };
  }

  // Lợi suất của một sự kiện sau h tháng: tìm ngày ảnh chụp gần D + h tháng nhất trong khoảng cho phép
  function findTarget(dates, date, months) {
    const t = addMonths(date, months);
    let best = null;
    for (let i = 0; i < dates.length; i++) {
      const gap = diffDays(t, dates[i]);
      if (gap >= -EARLY_DAYS && gap <= LATE_DAYS) { if (best === null || Math.abs(gap) < Math.abs(diffDays(t, dates[best]))) best = i; }
    }
    return { target: t, index: best };
  }

  // days: [{ date, matches, cover, ret }] (kết quả extractDay kèm ngày); saved: bộ lọc đã lưu; opts.minBench: số mã tối thiểu có số liệu để lấy trung vị thị trường (mặc định 100). Trả { dates, latest, filters: [ ... ] }
  function analyze(days, saved, opts) {
    const minBench = opts && opts.minBench !== undefined ? opts.minBench : 100;
    const ds = (days || []).filter((d) => d && d.date).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const dates = ds.map((d) => d.date), latest = dates.length ? dates[dates.length - 1] : null;
    const benchCache = {};
    const bench = (idx, hi) => { const k = idx + ':' + hi; if (benchCache[k] === undefined) { const vals = []; Object.keys(ds[idx].ret).forEach((s) => { const v = ds[idx].ret[s][hi]; if (v !== null) vals.push(v); }); benchCache[k] = vals.length >= minBench ? median(vals) : null; } return benchCache[k]; };
    const out = (saved || []).map((s) => {
      const info = { name: s.name, usableDays: 0, events: 0, entryDates: 0, firstDate: null, horizons: [], note: '' };
      const f = MS.normalizeFilters(s.filters), keys = Object.keys(f.values);
      if (!keys.length && !f.icbs.length) return Object.assign(info, { note: 'Bộ lọc trống.' });
      const maxCover = {}; keys.forEach((k) => { maxCover[k] = Math.max.apply(null, ds.map((d) => (d.cover && d.cover[s.name] && d.cover[s.name][k]) || 0).concat([0])); });
      const usable = ds.map((d) => d.matches && d.matches[s.name] && keys.every((k) => { const c = (d.cover[s.name] || {})[k] || 0; return c > 0 && c >= maxCover[k] * MIN_COVER_RATIO; }));
      info.usableDays = usable.filter(Boolean).length;
      if (!info.usableDays) return Object.assign(info, { note: 'Chưa có ngày nào đủ số liệu cho các tiêu chí của bộ lọc này trong lịch sử.' });
      const events = [], lastIn = {}; let prev = null, firstUsable = true;
      ds.forEach((d, i) => {
        if (!usable[i]) return;
        const cur = new Set(d.matches[s.name]), dateSet = new Set();
        cur.forEach((sym) => {
          if (!firstUsable && prev && prev.has(sym)) return;                    // đã có trong lần so sánh trước: không phải lọt vào mới
          if (lastIn[sym] && diffDays(lastIn[sym], d.date) < COOLDOWN_DAYS) { lastIn[sym] = d.date; return; }
          lastIn[sym] = d.date; events.push({ sym: sym, date: d.date, idx: i, start: firstUsable }); dateSet.add(d.date);
        });
        cur.forEach((sym) => { if (prev && prev.has(sym)) lastIn[sym] = d.date; });
        if (dateSet.size) info.entryDates += 1;
        prev = cur; firstUsable = false;
      });
      info.events = events.length; info.firstDate = events.length ? events[0].date : null;
      info.horizons = HORIZONS.map((h, hi) => {
        const row = { key: h.key, label: h.label, n: 0, pending: 0, noData: 0, dates: 0, median: null, medianExcess: null, meanExcess: null, beat: null, enough: false };
        const ex = [], rets = [], dset = new Set();
        events.forEach((e) => {
          const t = findTarget(dates, e.date, h.months);
          if (t.index === null) { if (t.target > latest) row.pending++; else row.noData++; return; }
          const r = ds[t.index].ret[e.sym], v = r ? r[hi] : null, b = bench(t.index, hi);
          if (v === null || v === undefined || b === null) { row.noData++; return; }
          rets.push(v); ex.push(v - b); dset.add(e.date);
        });
        row.n = ex.length; row.dates = dset.size;
        if (ex.length) { row.median = r4(median(rets)); row.medianExcess = r4(median(ex)); row.meanExcess = r4(ex.reduce((a, b) => a + b, 0) / ex.length); row.beat = r4(ex.filter((x) => x > 0).length / ex.length); }
        row.enough = row.n >= MIN_EVENTS && row.dates >= MIN_DATES;
        return row;
      });
      return info;
    });
    return { dates: dates, latest: latest, filters: out };
  }

  // Một dòng nhận xét cho một kỳ (an toàn: chỉ nói số đo được và mức chắc chắn)
  function line(h) {
    if (!h.n) return h.pending ? 'Chưa đủ thời gian: ' + h.pending + ' sự kiện chưa tới mốc ' + h.label + '.' : 'Chưa có sự kiện nào có số liệu ' + h.label + ' sau.';
    const pp = (v) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1).replace('.', ',') + ' điểm %';
    const base = 'Trung vị ' + pp(h.medianExcess) + ' so với thị trường, ' + Math.round(h.beat * 100) + '% số mã hơn thị trường (' + h.n + ' sự kiện, ' + h.dates + ' ngày lọt vào).';
    return h.enough ? base : base + ' Mẫu còn nhỏ (cần từ ' + MIN_EVENTS + ' sự kiện và ' + MIN_DATES + ' ngày lọt vào): chưa rút kết luận.';
  }

  return { HORIZONS, COOLDOWN_DAYS, MIN_EVENTS, MIN_DATES, extractDay, analyze, findTarget, line, addMonths };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FilterValidate;
