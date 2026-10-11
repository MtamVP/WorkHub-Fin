// Logic thuần: KHO DỮ LIỆU THEO THỜI ĐIỂM (point-in-time). Giải mã các bản chụp hằng ngày (finance_pit_market_daily) và lịch sử số liệu báo cáo (finance_pit_fundamentals) để trả lời câu hỏi
// "vào ngày D, người ta đã THẤY số liệu gì?" -- nền cho backtest không nhìn trước tương lai. Hàm chụp nằm ở cơ sở dữ liệu (fn_pit_capture, cron 12:05 UTC); thư viện này chỉ ĐỌC.
// Quy tắc dùng số liệu theo ngày (để backtest không gian lận):
//   * Bản chụp thị trường: lấy bản MỚI NHẤT có as_of <= ngày D (valueAsOf), và nói rõ cũ bao nhiêu ngày (stale) để người dùng loại bản quá cũ.
//   * Báo cáo tài chính: chỉ dùng dòng có seen_at <= D (fundamentalAsOf). Với giai đoạn TRƯỚC khi kho này bắt đầu chụp thì chưa có seen_at thật: dùng knownAt(kỳ báo cáo) = hạn công bố bảo thủ
//     (quý: +45 ngày, năm: +90 ngày kể từ cuối kỳ) -- chậm hơn thực tế nên an toàn, nhưng là ước lượng, không phải ngày công bố thật.
// KHÔNG đụng DOM/mạng. Nạp bằng thẻ <script> thường (global PitCalc) và module.exports cho Vitest.
const PitCalc = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const isoOf = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
  const dayMs = (iso) => Date.parse(iso.slice(0, 10) + 'T00:00:00Z');
  const addDays = (iso, n) => new Date(dayMs(iso) + n * 86400000).toISOString().slice(0, 10);
  const diffDays = (a, b) => Math.round((dayMs(a) - dayMs(b)) / 86400000);

  // Hạn công bố bảo thủ của một kỳ báo cáo. kind: 'quarter' | 'annual'. fiscalDate = ngày cuối kỳ (YYYY-MM-DD).
  const LAG = { quarter: 45, annual: 90 };
  function knownAt(fiscalDate, kind) {
    const f = String(fiscalDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
    return addDays(f, kind === 'annual' ? LAG.annual : LAG.quarter);
  }

  // Một dòng finance_pit_market_daily -> { asOf, n, cols, symbols, get(sym) -> {cột: giá trị}, has(sym) }. Dòng hỏng -> null.
  function decodeDay(row) {
    if (!row || !row.as_of || !Array.isArray(row.cols) || !row.data || typeof row.data !== 'object') return null;
    const cols = row.cols.slice(), idx = {};
    cols.forEach((c, i) => { idx[c] = i; });
    const data = row.data;
    const get = (sym) => {
      const arr = data[String(sym || '').toUpperCase()];
      if (!Array.isArray(arr)) return null;
      const o = {};
      cols.forEach((c, i) => { o[c] = c === 'icb2' ? (arr[i] === null || arr[i] === undefined ? null : String(arr[i])) : num(arr[i]); });
      return o;
    };
    return { asOf: isoOf(row.as_of), n: Number(row.n) || Object.keys(data).length, cols: cols, symbols: Object.keys(data), get: get, has: (s) => Array.isArray(data[String(s || '').toUpperCase()]), idx: idx };
  }

  // days: các dòng thô (không cần sắp xếp). Trả mảng đã giải mã, cũ trước mới sau, bỏ dòng hỏng.
  function decodeDays(rows) {
    return (rows || []).map(decodeDay).filter(Boolean).sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
  }

  // Bản chụp mới nhất có asOf <= date. maxStale (ngày lịch): quá cũ thì coi như không có (null) để backtest không dùng số liệu lỗi thời.
  function dayAsOf(days, date, maxStale) {
    const d = isoOf(date);
    let best = null;
    for (let i = 0; i < (days || []).length; i++) { if (days[i].asOf <= d) best = days[i]; else break; }
    if (!best) return null;
    const stale = diffDays(d, best.asOf);
    if (maxStale !== undefined && maxStale !== null && stale > maxStale) return null;
    return { day: best, stale: stale };
  }

  // Giá trị của một cột cho một mã vào ngày date. Trả { value, asOf, stale } hoặc null.
  function valueAsOf(days, symbol, col, date, maxStale) {
    const r = dayAsOf(days, date, maxStale === undefined ? 7 : maxStale);
    if (!r) return null;
    const m = r.day.get(symbol);
    if (!m || m[col] === undefined || m[col] === null) return null;
    return { value: m[col], asOf: r.day.asOf, stale: r.stale };
  }

  // Vũ trụ cổ phiếu vào ngày date: các hàng { symbol, m } của bản chụp phù hợp, để chạy bộ lọc "như ngày đó". predicate(m, symbol) -> boolean (tuỳ chọn).
  function universeAsOf(days, date, predicate, maxStale) {
    const r = dayAsOf(days, date, maxStale === undefined ? 7 : maxStale);
    if (!r) return { asOf: null, stale: null, rows: [] };
    const rows = [];
    r.day.symbols.forEach((s) => { const m = r.day.get(s); if (m && (!predicate || predicate(m, s))) rows.push({ symbol: s, m: m }); });
    return { asOf: r.day.asOf, stale: r.stale, rows: rows };
  }

  // Số liệu báo cáo của một mã ĐÃ BIẾT vào ngày date: dòng có seen_at <= date mới nhất. rows: finance_pit_fundamentals (mọi mã được).
  function fundamentalAsOf(rows, symbol, date) {
    const d = isoOf(date), sym = String(symbol || '').toUpperCase();
    let best = null;
    (rows || []).forEach((r) => {
      if (String(r.symbol || '').toUpperCase() !== sym || !r.seen_at) return;
      const s = isoOf(r.seen_at);
      if (s <= d && (!best || s > best.seenAt || (s === best.seenAt && String(r.quarter_key || '') > String(best.quarterKey || '')))) best = { seenAt: s, quarterKey: r.quarter_key || null, annualYear: r.annual_year || null, form: r.form || null, data: r.data || {} };
    });
    return best;
  }

  // Kỳ báo cáo mới nhất (quý) mà người ta CHẮC CHẮN đã biết vào ngày date, theo hạn công bố bảo thủ. quarters: [{year, quarter, fiscalDate?}], mới trước.
  function latestKnownQuarter(quarters, date) {
    const d = isoOf(date);
    const list = (quarters || []).slice().sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter));
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      const end = q.fiscalDate ? String(q.fiscalDate).slice(0, 10) : quarterEnd(q.year, q.quarter);
      const k = knownAt(end, q.quarter === 4 ? 'annual' : 'quarter');
      if (k && k <= d) return Object.assign({}, q, { knownAt: k });
    }
    return null;
  }
  function quarterEnd(year, quarter) {
    const m = [3, 6, 9, 12][Math.max(1, Math.min(4, quarter)) - 1];
    return year + '-' + String(m).padStart(2, '0') + '-' + String(new Date(Date.UTC(year, m, 0)).getUTCDate()).padStart(2, '0');
  }

  // Tình trạng kho: số ngày đã chụp, khoảng, các khoảng hở (chỉ tính ngày thường, bỏ cuối tuần và ngày lễ nếu có hàm isHoliday), số mã trung bình, và sau bao lâu thì đủ dữ liệu cho một cửa sổ kiểm thử.
  // days: kết quả decodeDays hoặc dòng thô/nhẹ chỉ có as_of và n (không cần tải cả dữ liệu từng mã). opts: { isHoliday(iso) -> boolean, today }
  function coverage(daysIn, opts) {
    const o = opts || {};
    const days = (daysIn || []).map((d) => (d && d.asOf ? { asOf: d.asOf, n: Number(d.n) || 0 } : (d && d.as_of ? { asOf: isoOf(d.as_of), n: Number(d.n) || 0 } : null))).filter(Boolean).sort((x, y) => (x.asOf < y.asOf ? -1 : x.asOf > y.asOf ? 1 : 0));
    if (!days.length) return { days: 0, first: null, last: null, gaps: [], missingDays: 0, avgSymbols: 0, minSymbols: 0, staleDays: null };
    const have = {}; days.forEach((d) => { have[d.asOf] = true; });
    const first = days[0].asOf, last = days[days.length - 1].asOf;
    const gaps = []; let missing = 0, runStart = null, runN = 0;
    for (let t = dayMs(first); t <= dayMs(last); t += 86400000) {
      const iso = new Date(t).toISOString().slice(0, 10), w = new Date(t).getUTCDay();
      const off = w === 0 || w === 6 || (o.isHoliday && o.isHoliday(iso));
      if (off || have[iso]) { if (runN) { gaps.push({ from: runStart, to: addDays(iso, -1), days: runN }); runN = 0; runStart = null; } continue; }
      if (!runN) runStart = iso;
      runN++; missing++;
    }
    if (runN) gaps.push({ from: runStart, to: last, days: runN });
    const sizes = days.map((d) => d.n);
    return {
      days: days.length, first: first, last: last, gaps: gaps, missingDays: missing,
      avgSymbols: Math.round(sizes.reduce((s, x) => s + x, 0) / sizes.length), minSymbols: Math.min.apply(null, sizes),
      staleDays: o.today ? diffDays(isoOf(o.today), last) : null,
    };
  }

  // Cần bao nhiêu ngày chụp để một backtest có ý nghĩa: ước lượng thô theo số kỳ cân bằng lại (mỗi kỳ cần cả cửa sổ xếp hạng lẫn cửa sổ nắm giữ). Chỉ là thang đo để hiển thị tiến độ.
  function readiness(dayCount, opts) {
    const o = Object.assign({ lookback: 63, hold: 21, minPeriods: 12 }, opts || {});
    const need = o.lookback + o.hold * o.minPeriods;
    const have = Math.max(0, Number(dayCount) || 0);
    const periods = have <= o.lookback ? 0 : Math.floor((have - o.lookback) / o.hold);
    return { have: have, need: need, pct: Math.min(1, have / need), periods: periods, ok: periods >= o.minPeriods };
  }

  return { LAG, knownAt, quarterEnd, decodeDay, decodeDays, dayAsOf, valueAsOf, universeAsOf, fundamentalAsOf, latestKnownQuarter, coverage, readiness, addDays, diffDays };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PitCalc;
