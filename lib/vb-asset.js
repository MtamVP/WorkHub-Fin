// Logic thuần của VALUATION BENCH: CÁC PHƯƠNG PHÁP ĐỊNH GIÁ BỔ TRỢ dựa trên thu nhập, cổ tức và tài sản -- bổ sung cho DCF và bội số:
//   * Số Graham (căn bậc hai của 22,5 × EPS × BVPS) và công thức giá trị nội tại của Graham (EPS × (8,5 + 2g) × 4,4 / Y)
//   * PEG của Lynch (P/E hợp lý ≈ tăng trưởng + tỷ suất cổ tức)
//   * Giá trị sức sinh lời EPV của Greenwald (lợi nhuận hoạt động chuẩn hoá / WACC: giá trị nếu KHÔNG có tăng trưởng)
//   * Giá trị tài sản ròng điều chỉnh (NAV/RNAV), NCAV (tài sản lưu động ròng, kiểu "net-net" của Graham), Tobin's Q đơn giản
//   * Mô hình cổ tức: Gordon, hai giai đoạn, H-model, định giá theo tỷ suất cổ tức mục tiêu
//   * Tổng các phần (SOTP) nhập tay theo từng mảng, giá trị theo lợi suất lợi nhuận yêu cầu
// Mỗi hàm trả null khi đầu vào không hợp lệ (không đoán) và kèm chú thích giới hạn; đây là công cụ phân tích, KHÔNG phải khuyến nghị.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VBAsset) và module.exports cho Vitest.
const VBAsset = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // Số Graham: giá tối đa nhà đầu tư phòng thủ nên trả = √(22,5 × EPS × BVPS) (tức P/E ≤ 15 và P/B ≤ 1,5). Cần EPS và BVPS dương.
  function graham(eps, bvps) {
    const e = num(eps), b = num(bvps);
    if (!(e > 0) || !(b > 0)) return null;
    return { value: Math.sqrt(22.5 * e * b), note: 'Giả định P/E tối đa 15 và P/B tối đa 1,5 (khung của Graham cho nhà đầu tư phòng thủ); thường thấp hơn giá của cổ phiếu tăng trưởng.' };
  }

  // Công thức giá trị nội tại của Graham (bản chỉnh 1974): V = EPS × (8,5 + 2g) × 4,4 / Y; g = tăng trưởng 7-10 năm (%), Y = lợi suất trái phiếu doanh nghiệp AAA (%).
  // Ở Việt Nam dùng lợi suất trái phiếu chính phủ 10 năm làm Y gần đúng; g kẹp 0-15% để tránh giá trị phi thực tế.
  function grahamGrowth(eps, growthPct, yieldPct) {
    const e = num(eps), g = num(growthPct), y = num(yieldPct);
    if (!(e > 0) || g === null || !(y > 0)) return null;
    const gc = clamp(g, 0, 15);
    return { value: e * (8.5 + 2 * gc) * 4.4 / y, growthUsed: gc, note: 'Y là lợi suất trái phiếu chính phủ 10 năm (4,4 là mức lợi suất AAA của Graham năm 1962). Nhạy cảm với Y: lãi suất thấp làm giá trị phình ra.' };
  }

  // PEG của Lynch: giá hợp lý khi P/E = tăng trưởng EPS (%) cộng tỷ suất cổ tức (%); EPS dương, g kẹp 0-30%.
  function lynch(eps, growthPct, divYieldPct) {
    const e = num(eps), g = num(growthPct);
    if (!(e > 0) || g === null) return null;
    const gc = clamp(g, 0, 30), fairPe = gc + (num(divYieldPct) || 0);
    return { value: e * fairPe, fairPe: fairPe, growthUsed: gc, note: 'P/E hợp lý ≈ g + tỷ suất cổ tức (PEG = 1). Chỉ phù hợp cổ phiếu tăng trưởng ổn định; chu kỳ hoặc lợi nhuận bất thường sẽ cho kết quả sai.' };
  }
  function peg(pe, growthPct) { const p = num(pe), g = num(growthPct); return p > 0 && g > 0 ? p / g : null; }

  // Giá trị sức sinh lời EPV (Greenwald): lợi nhuận hoạt động sau thuế chuẩn hoá / WACC; cộng tiền và tài sản không hoạt động, trừ nợ và cổ đông thiểu số.
  // inp: { normalizedEbit, taxRate, wacc, cash, associates, debt, minorities, shares, maintenanceAdj (đ: điều chỉnh capex duy trì khác khấu hao, trừ vào lợi nhuận) }
  function epv(inp) {
    const x = inp || {}, ebit = num(x.normalizedEbit), w = num(x.wacc), t = num(x.taxRate) === null ? 0.2 : num(x.taxRate), sh = num(x.shares);
    if (ebit === null || !(w > 0) || !(sh > 0)) return null;
    const nopat = Math.max(0, ebit * (1 - t) - (num(x.maintenanceAdj) || 0)), ev = nopat / w;
    const equity = ev + (num(x.cash) || 0) + (num(x.associates) || 0) - (num(x.debt) || 0) - (num(x.minorities) || 0);
    return { nopat: nopat, ev: ev, equity: equity, value: equity / sh, note: 'Giả định lợi nhuận hiện tại bền vững và không tăng trưởng. Phần giá cao hơn EPV là giá thị trường đang trả cho tăng trưởng.' };
  }

  // NCAV (Graham net-net): tài sản lưu động trừ TOÀN BỘ nợ phải trả. Giá < 2/3 NCAV/cổ phiếu là vùng "net-net" cổ điển (rất hiếm, thường là doanh nghiệp gặp khó).
  function ncav(period, shares) {
    const ca = num(period && period.currentAssets), tl = num(period && period.liabilities), sh = num(shares);
    if (ca === null || tl === null || !(sh > 0)) return null;
    const v = (ca - tl) / sh;
    return { value: v, perShare: v, threshold: v * 2 / 3, note: 'Tài sản lưu động chưa trừ hao hụt khi thanh lý (khoản phải thu, tồn kho có thể thấp hơn sổ sách).' };
  }

  // Giá trị tài sản ròng điều chỉnh: vốn chủ cổ đông công ty mẹ + các khoản điều chỉnh (đánh giá lại đất, bất động sản đầu tư, trừ tài sản vô hình...). adjustments: [{ label, amount (đ) }]
  function nav(period, shares, adjustments) {
    const eq = num(period && period.equity), sh = num(shares);
    if (eq === null || !(sh > 0)) return null;
    const adj = (adjustments || []).map(function (a) { return { label: a.label, amount: num(a.amount) || 0 }; });
    const total = eq + adj.reduce(function (s, a) { return s + a.amount; }, 0);
    return { book: eq / sh, value: total / sh, adjustments: adj, tangible: num(period.goodwill) !== null ? (eq - period.goodwill) / sh : null, note: 'Giá trị sổ sách là giá gốc lịch sử; với doanh nghiệp bất động sản, sản xuất nặng tài sản nên đánh giá lại tài sản bằng điều chỉnh nhập tay.' };
  }

  // Tobin's Q đơn giản = (vốn hoá + nợ phải trả) / tổng tài sản. Dưới 1: thị trường định giá thấp hơn giá trị sổ sách tài sản.
  function tobinQ(marketCap, period) {
    const mc = num(marketCap), ta = num(period && period.totalAssets), tl = num(period && period.liabilities);
    if (!(mc > 0) || !(ta > 0) || tl === null) return null;
    return { q: (mc + tl) / ta };
  }

  // ---- mô hình cổ tức ----
  function gordon(dps, g, ke) { const d = num(dps), gg = num(g), k = num(ke); if (!(d > 0) || gg === null || k === null || !(k > gg)) return null; return { value: d * (1 + gg) / (k - gg), note: 'D1 = D0 × (1 + g). Chỉ hợp với doanh nghiệp trả cổ tức đều và tăng ổn định.' }; }
  // Hai giai đoạn: tăng g1 trong n năm rồi g2 mãi mãi
  function ddmTwoStage(dps, g1, years, g2, ke) {
    const d0 = num(dps), a = num(g1), b = num(g2), k = num(ke), n = Math.max(1, Math.round(num(years) || 5));
    if (!(d0 > 0) || a === null || b === null || k === null || !(k > b)) return null;
    let pv = 0, d = d0;
    for (let t = 1; t <= n; t++) { d = d * (1 + a); pv += d / Math.pow(1 + k, t); }
    const tv = d * (1 + b) / (k - b);
    return { value: pv + tv / Math.pow(1 + k, n), pvDividends: pv, pvTerminal: tv / Math.pow(1 + k, n) };
  }
  // H-model: tăng trưởng giảm tuyến tính từ gS xuống gL trong 2H năm
  function hModel(dps, gShort, gLong, halfLife, ke) {
    const d0 = num(dps), gs = num(gShort), gl = num(gLong), h = num(halfLife), k = num(ke);
    if (!(d0 > 0) || gs === null || gl === null || h === null || k === null || !(k > gl)) return null;
    return { value: d0 * ((1 + gl) + h * (gs - gl)) / (k - gl) };
  }
  function yieldValue(dps, targetYield) { const d = num(dps), y = num(targetYield); return d > 0 && y > 0 ? { value: d / y, note: 'Giá để cổ tức hiện tại đạt tỷ suất mục tiêu; không tính tăng trưởng cổ tức.' } : null; }
  // Giá theo lợi suất lợi nhuận yêu cầu: EPS / (lãi suất phi rủi ro + phần bù)
  function earningsYieldValue(eps, requiredYield) { const e = num(eps), y = num(requiredYield); return e > 0 && y > 0 ? { value: e / y, impliedPe: 1 / y } : null; }

  // Tổng các phần: segments [{ name, metric (đ), multiple (x) }] -> EV từng mảng; trừ nợ ròng, thiểu số; cộng tài sản khác
  function sotp(segments, opts) {
    const o = opts || {}, rows = (segments || []).map(function (s) { const m = num(s.metric), x = num(s.multiple); return { name: s.name, metric: m, multiple: x, ev: m !== null && x !== null ? m * x : null }; }).filter(function (r) { return r.ev !== null; });
    if (!rows.length) return null;
    const ev = rows.reduce(function (s, r) { return s + r.ev; }, 0), sh = num(o.shares);
    const equity = ev + (num(o.cash) || 0) + (num(o.otherAssets) || 0) - (num(o.debt) || 0) - (num(o.minorities) || 0) - (num(o.holdingDiscountPct) ? ev * num(o.holdingDiscountPct) / 100 : 0);
    return { rows: rows, ev: ev, equity: equity, value: sh > 0 ? equity / sh : null, note: 'Bội số từng mảng do người dùng chọn: nên lấy từ doanh nghiệp cùng ngành thuần túy; áp chiết khấu tập đoàn (holding discount) 10-30% nếu cần.' };
  }

  return { graham, grahamGrowth, lynch, peg, epv, ncav, nav, tobinQ, gordon, ddmTwoStage, hModel, yieldValue, earningsYieldValue, sotp };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBAsset;
