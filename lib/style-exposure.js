// Logic thuần: HỒ SƠ PHONG CÁCH của danh mục -- danh mục nghiêng về giá trị hay tăng trưởng, vốn hoá lớn hay nhỏ, chất lượng cao hay thấp, động lượng, biến động, cổ tức -- so với toàn thị trường niêm yết.
// Mỗi nhân tố đo bằng PHÂN VỊ trung bình có trọng số giá trị vị thế trong phân phối của cả thị trường (mã vốn hoá từ 300 tỷ, thống kê 'ALL' của finance_sector_stats): 50 = trung lập, trên 50 = nghiêng về nhân tố đó.
// Dùng để hội đồng đầu tư nhìn ra "danh mục này thực chất đang đặt cược vào cái gì" ngoài tên mã. KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global StyleExposure) và module.exports cho Vitest.
// Cần PeerValuation (lib/peer-valuation.js) nạp trước.
const StyleExposure = (function () {
  const PV = (typeof require === 'function' && typeof module !== 'undefined') ? require('./peer-valuation.js') : PeerValuation;
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const MIN_COVERAGE = 0.5;       // nhân tố chỉ được báo khi các vị thế có số liệu chiếm ít nhất 50% giá trị

  // pctOf(metrics, stats) -> phân vị 0-100 của mã theo nhân tố (cao = nghiêng về tên nhân tố), hoặc null
  const FACTORS = [
    { key: 'value', label: 'Giá trị (rẻ)', high: 'rẻ hơn đa số thị trường theo P/E và P/B', low: 'đắt hơn đa số thị trường theo P/E và P/B',
      pct: (m, s) => { const a = [pc(m.pe, s.pe), pc(m.pb, s.pb)].filter((x) => x !== null); return a.length ? 100 - a.reduce((t, x) => t + x, 0) / a.length : null; } },
    { key: 'quality', label: 'Chất lượng (ROE)', high: 'có ROE cao hơn đa số thị trường', low: 'có ROE thấp hơn đa số thị trường', pct: (m, s) => pc(m.roae, s.roae) },
    { key: 'size', label: 'Quy mô lớn', high: 'vốn hoá lớn hơn đa số thị trường (thanh khoản tốt)', low: 'vốn hoá nhỏ/vừa so với thị trường: thanh khoản mỏng và rủi ro mã cao hơn', pct: (m, s) => pc(m.marketcap, s.marketcap) },
    { key: 'momentum', label: 'Động lượng (giá 12 tháng)', high: 'đang chạy theo xu hướng tăng: rủi ro đảo chiều khi thị trường xoay', low: 'nghiêng về mã đã giảm nhiều: ngược xu hướng, cần chắc chắn là rẻ chứ không phải kém', pct: (m, s) => pc(m.chg1y, s.chg1y) },
    { key: 'lowvol', label: 'Ít biến động (beta thấp)', high: 'có beta thấp hơn đa số thị trường: phòng thủ hơn', low: 'có beta cao hơn đa số thị trường: dao động mạnh hơn thị trường', pct: (m, s) => { const p = pc(m.beta, s.beta); return p === null ? null : 100 - p; } },
    { key: 'income', label: 'Cổ tức', high: 'có tỷ suất cổ tức cao hơn đa số thị trường', low: 'có tỷ suất cổ tức thấp hơn đa số thị trường', pct: (m, s) => pc(m.divYield, s.divYield) },
  ];
  function pc(v, st) { return v === null || v === undefined || !st ? null : PV.percentile(num(v), st.q); }

  // holdings: [{ symbol, value }]; bySymbol: { SYM: { metrics } }; marketStats: stats của 'ALL' ({pe:{q}, pb:{q}, roae:{q}, marketcap:{q}, chg1y:{q}, beta:{q}, divYield:{q}})
  function compute(holdings, bySymbol, marketStats) {
    const list = (holdings || []).filter((h) => num(h.value) > 0).map((h) => ({ symbol: String(h.symbol).toUpperCase(), value: num(h.value) }));
    const total = list.reduce((t, h) => t + h.value, 0), st = marketStats || {};
    if (!list.length || !(total > 0) || !Object.keys(st).length) return { factors: [], tilts: [], coverage: 0, total: total };
    const withData = list.filter((h) => bySymbol && bySymbol[h.symbol] && bySymbol[h.symbol].metrics);
    const coverage = withData.reduce((t, h) => t + h.value, 0) / total;
    const factors = FACTORS.map((f) => {
      let sum = 0, w = 0; const per = [];
      withData.forEach((h) => { const p = f.pct(bySymbol[h.symbol].metrics, st); if (p !== null) { sum += p * h.value; w += h.value; per.push({ symbol: h.symbol, pct: p, weight: h.value / total * 100 }); } });
      const cov = w / total, pct = cov >= MIN_COVERAGE && w > 0 ? sum / w : null;
      per.sort((a, b) => b.weight - a.weight);
      return { key: f.key, label: f.label, pct: pct, coverage: cov, positions: per, tone: pct === null ? 'mute' : (pct >= 80 || pct <= 20 ? 'warn' : 'ok') };       // đỏ chỉ khi nghiêng rất mạnh (cực trị), nghiêng vừa vẫn là màu thường
    });
    const tilts = [];
    FACTORS.forEach((f) => {
      const r = factors.find((x) => x.key === f.key);
      if (r.pct === null) return;
      if (r.pct >= 65) tilts.push({ key: f.key, side: 'high', text: 'Danh mục nghiêng rõ về nhân tố "' + f.label + '" (phân vị ' + Math.round(r.pct) + '): các mã nắm ' + f.high + '.' });
      else if (r.pct <= 35) tilts.push({ key: f.key, side: 'low', text: 'Danh mục nghiêng ngược nhân tố "' + f.label + '" (phân vị ' + Math.round(r.pct) + '): các mã nắm ' + f.low + '.' });
    });
    return { factors: factors, tilts: tilts, coverage: coverage, total: total, counted: withData.length, count: list.length };
  }

  return { FACTORS, MIN_COVERAGE, compute };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StyleExposure;
