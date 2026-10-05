// Logic thuần của VALUATION BENCH: ĐỊNH GIÁ THEO BỘI SỐ -- (1) tính các bội số hiện tại của một cổ phiếu (P/E, P/B, P/S, EV/EBITDA, EV/EBIT, EV/Sales, P/CF, tỷ suất FCF, cổ tức),
// (2) giá ngầm định khi áp bội số của nhóm ngang hàng (phân vị 20 / 50 / 80 của cùng ngành ICB) vào số liệu của chính cổ phiếu, (3) dải bội số lịch sử của chính nó (P/E, P/B) và giá ngầm định theo dải đó.
// Quy ước: bội số chỉ có nghĩa khi mẫu số dương (EPS, BVPS, EBITDA > 0); âm hoặc thiếu -> null và không tạo giá ngầm định. Nhóm ngang hàng cần tối thiểu 5 mã (cùng ngưỡng với lib/peer-valuation.js).
// Đây là công cụ phân tích, KHÔNG phải khuyến nghị: bội số ngành chưa tính khác biệt tăng trưởng, đòn bẩy, chất lượng; ngân hàng/tài chính chỉ so P/E và P/B.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VBMultiples) và module.exports cho Vitest.
const VBMultiples = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const MIN_N = 5;
  const KEYS = {
    pe: { label: 'P/E', unit: 'x', financialOk: true }, pb: { label: 'P/B', unit: 'x', financialOk: true }, ps: { label: 'P/S', unit: 'x', financialOk: false },
    evEbitda: { label: 'EV/EBITDA', unit: 'x', financialOk: false }, evSales: { label: 'EV/Doanh thu', unit: 'x', financialOk: false },
  };

  // ctx: { price, shares, period (kỳ năm hoặc TTM đã chuẩn hoá), prevPeriod (tuỳ chọn), eps (ghi đè), bvps (ghi đè), growthPct (tăng trưởng EPS %/năm, để tính PEG) }
  function compute(ctx) {
    const price = num(ctx.price), sh = num(ctx.shares), p = ctx.period || {};
    if (!(price > 0) || !(sh > 0)) return null;
    const mc = price * sh;
    const eps = num(ctx.eps) !== null ? num(ctx.eps) : (num(p.netIncome) !== null ? p.netIncome / sh : num(p.eps));
    const bvps = num(ctx.bvps) !== null ? num(ctx.bvps) : (num(p.equity) !== null ? p.equity / sh : null);
    const sps = num(p.revenue) !== null ? p.revenue / sh : null, cfps = num(p.cfo) !== null ? p.cfo / sh : null;
    const nonFin = p.form === undefined || p.form === 'NON_FINANCE';
    const debt = num(p.debt) || 0, cash = (num(p.cash) || 0) + (num(p.stInvest) || 0), min = num(p.nciEquity) || 0, assoc = num(p.ltInvest) || 0;
    const ev = nonFin ? mc + debt + min - cash - assoc : null;
    const out = { price: price, shares: sh, marketCap: mc, ev: ev, eps: eps, bvps: bvps, sps: sps, cfps: cfps };
    out.pe = eps > 0 ? price / eps : null;
    out.pb = bvps > 0 ? price / bvps : null;
    out.ps = sps > 0 ? price / sps : null;
    out.pcf = cfps > 0 ? price / cfps : null;
    out.evEbitda = ev !== null && num(p.ebitda) > 0 ? ev / p.ebitda : null;
    out.evEbit = ev !== null && num(p.ebit) > 0 ? ev / p.ebit : null;
    out.evSales = ev !== null && num(p.revenue) > 0 ? ev / p.revenue : null;
    out.earningsYield = out.pe ? 1 / out.pe : null;
    out.fcfYield = nonFin && num(p.fcf) !== null ? p.fcf / mc : null;
    out.dividendYield = num(p.divPaid) !== null ? p.divPaid / mc : null;
    out.peg = out.pe && num(ctx.growthPct) > 0 ? out.pe / ctx.growthPct : null;
    out.netCash = nonFin ? cash - debt : null;
    return out;
  }

  // Giá trị phân vị từ 11 điểm q (p0..p100): p ∈ [0,100], nội suy tuyến tính
  function at(q, pct) {
    if (!Array.isArray(q) || q.length < 2) return null;
    const a = q.map(num); if (a.some(function (x) { return x === null; })) return null;
    const x = Math.max(0, Math.min(100, pct)) / 100 * (a.length - 1), lo = Math.floor(x), hi = Math.ceil(x);
    return a[lo] + (a[hi] - a[lo]) * (x - lo);
  }

  // Giá ngầm định từ một bội số: low/base/high theo phân vị 20/50/80 của nhóm. fundamentals: kết quả compute + period; trả null nếu thiếu mẫu hoặc thiếu mẫu số.
  function priceFromMultiple(key, multiple, c, p) {
    if (multiple === null || !(multiple > 0)) return null;
    if (key === 'pe') return c.eps > 0 ? multiple * c.eps : null;
    if (key === 'pb') return c.bvps > 0 ? multiple * c.bvps : null;
    if (key === 'ps') return c.sps > 0 ? multiple * c.sps : null;
    if (key === 'evEbitda' || key === 'evSales') {
      const metric = key === 'evEbitda' ? num(p.ebitda) : num(p.revenue);
      if (!(metric > 0) || c.ev === null) return null;
      const ev = multiple * metric, debt = num(p.debt) || 0, cash = (num(p.cash) || 0) + (num(p.stInvest) || 0), min = num(p.nciEquity) || 0, assoc = num(p.ltInvest) || 0;
      return (ev - debt - min + cash + assoc) / c.shares;
    }
    return null;
  }

  // stats: thống kê ngành { pe: { n, median, q }, pb, ps, evEbitda, evSales }. isFinancial: ngân hàng/bảo hiểm/tài chính -> chỉ P/E, P/B.
  function peerImplied(c, p, stats, isFinancial) {
    const out = [];
    Object.keys(KEYS).forEach(function (k) {
      if (isFinancial && !KEYS[k].financialOk) return;
      const st = stats && stats[k];
      if (!st || !(num(st.n) >= MIN_N)) return;
      const lo = at(st.q, 20), mid = at(st.q, 50), hi = at(st.q, 80);
      const pl = priceFromMultiple(k, lo, c, p), pm = priceFromMultiple(k, mid, c, p), ph = priceFromMultiple(k, hi, c, p);
      if (pm === null) return;
      out.push({ key: k, label: KEYS[k].label, n: st.n, current: c[k], low: pl, base: pm, high: ph, multiples: { low: lo, base: mid, high: hi },
        note: 'Bội số ' + KEYS[k].label + ' của ' + st.n + ' mã cùng ngành (phân vị 20/50/80) áp vào số liệu của cổ phiếu.' });
    });
    return out;
  }

  // Dải bội số LỊCH SỬ của chính cổ phiếu: values = chuỗi bội số theo ngày (số dương); trả trung bình, độ lệch chuẩn, phân vị 20/50/80 và phân vị hiện tại
  function historyBand(values, current) {
    const v = (values || []).map(num).filter(function (x) { return x !== null && x > 0 && x < 500; });
    if (v.length < 60) return null;
    const sorted = v.slice().sort(function (a, b) { return a - b; }), n = v.length, mean = v.reduce(function (s, x) { return s + x; }, 0) / n;
    const sd = Math.sqrt(v.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0) / (n - 1));
    const q = function (p) { const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
    const c = num(current), below = c === null ? null : v.filter(function (x) { return x < c; }).length, equal = c === null ? null : v.filter(function (x) { return x === c; }).length;
    return { n: n, mean: mean, sd: sd, p20: q(0.2), p50: q(0.5), p80: q(0.8), min: sorted[0], max: sorted[n - 1], percentile: c === null ? null : (below + equal / 2) / n * 100, zScore: c === null || sd === 0 ? null : (c - mean) / sd };
  }

  // Giá ngầm định theo dải lịch sử của chính nó (low = p20, base = trung vị, high = p80)
  function historyImplied(key, band, c, p) {
    if (!band) return null;
    const lo = priceFromMultiple(key, band.p20, c, p), mid = priceFromMultiple(key, band.p50, c, p), hi = priceFromMultiple(key, band.p80, c, p);
    if (mid === null) return null;
    return { key: 'hist-' + key, label: KEYS[key].label + ' lịch sử của chính nó', n: band.n, current: c[key], low: lo, base: mid, high: hi, multiples: { low: band.p20, base: band.p50, high: band.p80 },
      note: 'Phân vị 20/50/80 của ' + KEYS[key].label + ' hàng ngày trong ' + band.n + ' phiên áp vào số liệu hiện tại: giả định doanh nghiệp quay về mức định giá thường thấy của chính nó (không đúng nếu cấu trúc kinh doanh hoặc lãi suất đã đổi).' };
  }

  return { MIN_N, KEYS, compute, at, priceFromMultiple, peerImplied, historyBand, historyImplied };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBMultiples;
