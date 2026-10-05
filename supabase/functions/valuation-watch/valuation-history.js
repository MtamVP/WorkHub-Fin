// Logic thuần: LỊCH SỬ ĐỊNH GIÁ -- thị trường (và từng ngành) đang rẻ hay đắt SO VỚI CHÍNH LỊCH SỬ CỦA NÓ, đo bằng phân vị của P/E và P/B tổng hợp theo vốn hoá trong cửa sổ N năm.
// Dữ liệu: finance_valuation_history (Edge Function market-data-sync, mode "snapshot" hằng ngày và "history" bù ngược theo tháng). KHÔNG đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global ValuationHistory) và module.exports cho Vitest.
// Giới hạn cần nhớ: "rẻ so với lịch sử" không có nghĩa là sẽ tăng (cấu trúc lợi nhuận và lãi suất có thể đã đổi); phân ngành quá khứ lấy theo danh sách hiện tại (thiên lệch người sống sót nhẹ);
// P/E tổng hợp chỉ tính mã có lãi nên thấp hơn P/E thật của chỉ số khi nhiều doanh nghiệp lỗ.
const ValuationHistory = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const MIN_POINTS = 12;           // ít hơn 12 tháng dữ liệu thì không kết luận phân vị

  // Chuỗi [{ d: 'YYYY-MM-DD', v }] của một phạm vi ('ALL' hoặc mã ICB) và một chỉ số (pe_agg, pb_agg, pe_median, pb_median), tăng theo ngày
  function seriesOf(rows, scope, key) {
    return (rows || []).filter(function (r) { return r.scope === scope && num(r[key]) !== null && num(r[key]) > 0; })
      .map(function (r) { return { d: String(r.as_of).slice(0, 10), v: num(r[key]) }; })
      .sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
  }

  function labelFor(pct) {
    if (pct === null) return null;
    if (pct <= 20) return { key: 'cheap', label: 'Rẻ so với lịch sử', tone: 'ok' };
    if (pct <= 40) return { key: 'lowish', label: 'Hơi rẻ', tone: 'ok' };
    if (pct < 60) return { key: 'mid', label: 'Quanh trung bình', tone: 'mute' };
    if (pct < 80) return { key: 'highish', label: 'Hơi đắt', tone: 'warn' };
    return { key: 'rich', label: 'Đắt so với lịch sử', tone: 'warn' };
  }

  // series: kết quả seriesOf; opts.years: cửa sổ tính từ điểm cuối (mặc định 5 năm)
  function summarize(series, opts) {
    const o = opts || {}, years = o.years > 0 ? o.years : 5;
    if (!series || !series.length) return null;
    const last = series[series.length - 1];
    const cut = new Date(Date.parse(last.d + 'T00:00:00Z') - years * 365.25 * 86400000).toISOString().slice(0, 10);
    const win = series.filter(function (x) { return x.d >= cut; });
    if (win.length < MIN_POINTS) return { now: last.v, date: last.d, n: win.length, years: years, pct: null, label: null, enough: false };
    const vals = win.map(function (x) { return x.v; }), sorted = vals.slice().sort(function (a, b) { return a - b; });
    const mean = vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / (vals.length - 1));
    const below = vals.filter(function (v) { return v < last.v - 1e-12; }).length, equal = vals.filter(function (v) { return Math.abs(v - last.v) <= 1e-12; }).length;
    const pct = (below + equal / 2) / vals.length * 100;
    const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return { now: last.v, date: last.d, n: vals.length, years: years, enough: true, pct: pct, label: labelFor(pct), min: sorted[0], max: sorted[sorted.length - 1], mean: mean, median: mid, z: sd > 0 ? (last.v - mean) / sd : 0, vsMeanPct: (last.v / mean - 1) * 100 };
  }

  // Đường vẽ SVG ('M x y L x y ...') và điểm cuối cho biểu đồ nhỏ; w, h là kích thước khung
  function sparkline(series, w, h, pad) {
    if (!series || series.length < 2) return { d: '', last: null };
    const p = pad === undefined ? 2 : pad, vs = series.map(function (x) { return x.v; });
    const lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs), span = hi - lo || 1;
    const pts = series.map(function (x, i) { return [p + i / (series.length - 1) * (w - 2 * p), p + (1 - (x.v - lo) / span) * (h - 2 * p)]; });
    return { d: pts.map(function (q, i) { return (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join(' '), last: pts[pts.length - 1] };
  }

  // Bảng ngành: mỗi ngành một dòng (so với chính lịch sử của nó), rẻ nhất trước. key: 'pe_agg' hoặc 'pb_agg'; nameOf(scope) -> tên ngành
  function sectorBoard(rows, key, years, nameOf) {
    const scopes = []; (rows || []).forEach(function (r) { if (r.scope !== 'ALL' && scopes.indexOf(r.scope) === -1) scopes.push(r.scope); });
    const out = [];
    scopes.forEach(function (sc) {
      const s = seriesOf(rows, sc, key), sum = summarize(s, { years: years });
      if (sum && sum.enough) out.push({ scope: sc, name: nameOf ? nameOf(sc) : sc, series: s, summary: sum });
    });
    out.sort(function (a, b) { return a.summary.pct - b.summary.pct; });
    return out;
  }

  // Lợi suất lợi nhuận (1 / P/E) trừ lợi suất trái phiếu chính phủ 10 năm: phần bù cổ phiếu quan sát được (cùng ý với "mô hình Fed"). Âm hoặc thấp = cổ phiếu không còn rẻ so với trái phiếu.
  function earningsYieldSpread(peAgg, bond10yPct) {
    const pe = num(peAgg), b = num(bond10yPct);
    if (!(pe > 0)) return null;
    const ey = 100 / pe;
    return { earningsYieldPct: ey, bondPct: b, spreadPct: b === null ? null : ey - b };
  }

  return { MIN_POINTS, seriesOf, summarize, labelFor, sparkline, sectorBoard, earningsYieldSpread };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ValuationHistory;
globalThis.ValuationHistory = ValuationHistory;
