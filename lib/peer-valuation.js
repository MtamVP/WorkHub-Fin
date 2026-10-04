// Logic thuần: ĐỊNH GIÁ TƯƠNG ĐỐI SO VỚI NGÀNH -- một mã đang rẻ hay đắt so với các mã cùng ngành ICB, đo bằng PHÂN VỊ (không phải chỉ so với trung bình).
// Đầu vào là thống kê ngành do Edge Function market-data-sync (mode "snapshot") tính hằng ngày: mỗi chỉ số có 11 điểm phân vị q = [p0, p10, ..., p100], trung vị và số mã (n).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global PeerValuation) và module.exports cho Vitest.
// Giới hạn cần nhớ: P/E và P/B so sánh trong cùng ngành vẫn chưa tính khác biệt tăng trưởng/đòn bẩy giữa các mã; mã vốn hoá dưới 300 tỷ không nằm trong thống kê.
const PeerValuation = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const CHEAP = 30, EXPENSIVE = 70;      // phân vị định giá (0 = rẻ nhất ngành, 100 = đắt nhất)
  const MIN_N = 5;

  // Phân vị (0-100) của giá trị trong phân phối q (11 điểm p0..p100, tăng dần). Nội suy tuyến tính; ngoài khoảng thì kẹp 0/100; nhiều điểm bằng nhau thì lấy giữa.
  function percentile(value, q) {
    const v = num(value);
    if (v === null || !Array.isArray(q) || q.length < 2) return null;
    const a = q.map(num);
    if (a.some((x) => x === null)) return null;
    const last = a.length - 1, step = 100 / last;
    if (v <= a[0]) return v < a[0] ? 0 : (a[0] === a[last] ? 50 : 0);
    if (v >= a[last]) return v > a[last] ? 100 : 100;
    let lo = 0, hi = last;
    for (let i = 0; i < last; i++) { if (v >= a[i] && v <= a[i + 1]) { lo = i; hi = i + 1; if (a[i] !== a[i + 1]) break; } }
    if (a[hi] === a[lo]) return (lo + hi) / 2 * step;
    return (lo + (v - a[lo]) / (a[hi] - a[lo])) * step;
  }

  function item(value, st, higherIsBetter) {
    const v = num(value);
    if (v === null || !st || !(st.n >= MIN_N)) return null;
    const pct = percentile(v, st.q);
    if (pct === null) return null;
    return { value: v, median: st.median, ratio: st.median > 0 ? v / st.median : null, pct: pct, n: st.n, higherIsBetter: !!higherIsBetter };
  }

  // metrics: chỉ số của mã (finance_stock_ratios / finance_market_snapshot, tên ngắn pe, pb, roae, divYield, ps); stats: stats của ngành (hoặc toàn thị trường)
  function assess(metrics, stats) {
    const m = metrics || {}, s = stats || {};
    const items = { pe: item(m.pe, s.pe, false), pb: item(m.pb, s.pb, false), ps: item(m.ps, s.ps, false), roe: item(m.roae, s.roae, true), divYield: item(m.divYield, s.divYield, true) };
    const val = [items.pe, items.pb].filter((x) => x);
    const valuationPct = val.length ? val.reduce((t, x) => t + x.pct, 0) / val.length : null;
    const qualityPct = items.roe ? items.roe.pct : null;
    let verdict = null;
    if (valuationPct !== null) {
      if (valuationPct <= CHEAP) {
        if (qualityPct !== null && qualityPct < 25) verdict = { key: 'cheap-lowq', label: 'Rẻ nhưng chất lượng thấp', tone: 'warn', text: 'Định giá thấp hơn đa số mã cùng ngành, nhưng ROE cũng thuộc nhóm thấp: có thể rẻ vì lý do chính đáng (bẫy giá trị).' };
        else verdict = { key: 'cheap', label: 'Rẻ so với ngành', tone: 'ok', text: qualityPct !== null && qualityPct >= 50 ? 'Định giá thấp hơn đa số mã cùng ngành trong khi ROE từ trung bình trở lên.' : 'Định giá thấp hơn đa số mã cùng ngành.' };
      } else if (valuationPct >= EXPENSIVE) {
        if (qualityPct !== null && qualityPct >= 75) verdict = { key: 'rich-highq', label: 'Đắt nhưng chất lượng cao', tone: 'info', text: 'Định giá cao hơn đa số mã cùng ngành, đi kèm ROE thuộc nhóm cao: mức đắt có thể có lý do (premium chất lượng).' };
        else verdict = { key: 'rich', label: 'Đắt so với ngành', tone: 'warn', text: 'Định giá cao hơn đa số mã cùng ngành' + (qualityPct !== null && qualityPct < 50 ? ' mà ROE không nổi trội.' : '.') };
      } else verdict = { key: 'inline', label: 'Ngang ngành', tone: 'mute', text: 'Định giá nằm quanh mức trung vị của ngành.' };
    }
    return { items: items, valuationPct: valuationPct, qualityPct: qualityPct, verdict: verdict, n: (items.pe || items.pb || {}).n || null };
  }

  // Các mã cùng ngành xếp từ rẻ đến đắt (điểm = trung bình phân vị P/E và P/B), kèm ROE; mã `symbol` được đánh dấu và có thứ hạng.
  // rows: [{ symbol, metrics }] của cùng ngành; stats: stats ngành. opts.minCap: vốn hoá tối thiểu (đồng).
  function peerTable(rows, symbol, stats, opts) {
    const o = opts || {}, minCap = o.minCap === undefined ? 300e9 : o.minCap, sym = String(symbol || '').toUpperCase();
    const list = (rows || []).map((r) => {
      const a = assess(r.metrics, stats), mc = num((r.metrics || {}).marketcap);
      return { symbol: String(r.symbol).toUpperCase(), pe: a.items.pe ? a.items.pe.value : null, pb: a.items.pb ? a.items.pb.value : null, roe: num((r.metrics || {}).roae), marketcap: mc, score: a.valuationPct, self: String(r.symbol).toUpperCase() === sym };
    }).filter((r) => r.score !== null && (r.self || (r.marketcap !== null && r.marketcap >= minCap)));
    list.sort((x, y) => x.score - y.score);
    list.forEach((r, i) => { r.rank = i + 1; });
    const k = o.limit || 8, top = list.slice(0, k), me = list.find((r) => r.self);
    if (me && !top.some((r) => r.self)) top.push(me);
    return { total: list.length, rows: top, self: me || null };
  }

  return { CHEAP, EXPENSIVE, MIN_N, percentile, assess, peerTable };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PeerValuation;
