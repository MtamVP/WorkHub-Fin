// Logic thuần: GỢI Ý MÃ THAY THẾ cho các vị thế đang bị gắn "đắt so với ngành" hoặc "tụt hậu so với thị trường" -- tìm trong CÙNG NGÀNH ICB những mã rẻ hơn rõ rệt, ROE không thấp hơn, đủ lớn và đủ thanh khoản,
// chưa nắm, không bị hạn chế, và không có số liệu "đẹp bất thường" (P/E dưới 4x, EPS tăng gấp đôi...). Xếp bằng điểm tổng hợp của lib/market-screener.js.
// ĐÂY LÀ DANH SÁCH ĐỂ NGHIÊN CỨU, KHÔNG PHẢI KHUYẾN NGHỊ ĐỔI MÃ: chưa tính thuế phí đổi mã, tác động giá của lệnh, hay lý do doanh nghiệp. KHÔNG đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global ReplacementIdeas) và module.exports cho Vitest. Cần MarketScreener (lib/market-screener.js) nạp trước.
const ReplacementIdeas = (function () {
  const MS = (typeof require === 'function' && typeof module !== 'undefined') ? require('./market-screener.js') : MarketScreener;
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const DEFAULTS = { k: 3, minCap: 1000e9, minAdv: 5e9, expensivePct: 70, edge: 20, maxDe: 2.5 };

  // holdings: [{ symbol, value }]; rows: kết quả MarketScreener.buildRows (cả thị trường); restricted: mảng mã bị hạn chế
  function suggest(holdings, rows, restricted, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const list = (holdings || []).filter((h) => num(h.value) > 0).map((h) => ({ symbol: String(h.symbol).toUpperCase(), value: num(h.value) }));
    const total = list.reduce((t, h) => t + h.value, 0);
    if (!list.length || !(total > 0)) return [];
    const by = {}; (rows || []).forEach((r) => { by[r.symbol] = r; });
    const held = {}; list.forEach((h) => { held[h.symbol] = true; });
    const block = {}; (restricted || []).forEach((s) => { block[String(s).toUpperCase()] = true; });
    const out = [];
    list.slice().sort((a, b) => b.value - a.value).forEach((h) => {
      const r = by[h.symbol];
      if (!r || !r.icb2_code) return;
      const reasons = [];
      if (r.valuationPct !== null && r.valuationPct >= o.expensivePct) reasons.push('Đắt so với ngành (phân vị định giá ' + Math.round(r.valuationPct) + ')');
      const lag = num(r.m.jdkRs) !== null && num(r.m.jdkMom) !== null && r.m.jdkRs < 100 && r.m.jdkMom < 100;
      if (lag) reasons.push('Tụt hậu so với thị trường (RS-Ratio ' + (Math.round(r.m.jdkRs * 10) / 10) + ', động lượng ' + (Math.round(r.m.jdkMom * 10) / 10) + ')');
      if (!reasons.length) return;
      const baseRoe = num(r.m.roae), basePct = r.valuationPct;
      const cands = [];
      (rows || []).forEach((c) => {
        if (c.symbol === h.symbol || c.icb2_code !== r.icb2_code || held[c.symbol] || block[c.symbol]) return;
        const m = c.m;
        if (!(num(m.marketcap) >= o.minCap) || !(num(m.advValue20) >= o.minAdv)) return;
        if (c.valuationPct === null) return;
        if (basePct !== null ? c.valuationPct > basePct - o.edge : c.valuationPct > 50) return;
        const roe = num(m.roae);
        if (roe === null || (baseRoe !== null ? roe < baseRoe : roe < 0.1)) return;
        if (!c.financial && num(m.debtToEquity) !== null && m.debtToEquity > o.maxDe) return;
        if (lag && !(num(m.jdkRs) !== null && m.jdkRs >= 100) && reasons.length === 1) return;     // lý do chỉ là tụt hậu: ứng viên cũng phải không tụt hậu
        const fl = MS.flags(c);
        if (fl.some((f) => /P\/E dưới 4x|gấp đôi|ROE trên 40%/.test(f))) return;
        const sc = MS.score(c);
        cands.push({ symbol: c.symbol, name: c.name, exchange: c.exchange, pe: num(m.pe), pb: num(m.pb), roe: roe, valuationPct: c.valuationPct, marketcap: num(m.marketcap), advValue20: num(m.advValue20), jdkRs: num(m.jdkRs), score: sc.total, flags: fl,
          why: 'phân vị định giá ' + Math.round(c.valuationPct) + (basePct !== null ? ' (so với ' + Math.round(basePct) + ')' : '') + ', ROE ' + (Math.round(roe * 1000) / 10) + '%' + (baseRoe !== null ? ' (so với ' + (Math.round(baseRoe * 1000) / 10) + '%)' : '') });
      });
      cands.sort((a, b) => (b.score === null ? -1 : b.score) - (a.score === null ? -1 : a.score) || b.marketcap - a.marketcap);
      out.push({ symbol: h.symbol, name: r.name, weightPct: h.value / total * 100, icb2_code: r.icb2_code, reasons: reasons, valuationPct: basePct, roe: baseRoe, pe: num(r.m.pe), pb: num(r.m.pb), candidates: cands.slice(0, o.k), candidateCount: cands.length });
    });
    return out;
  }

  return { DEFAULTS, suggest };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ReplacementIdeas;
