// Logic thuần: MÔ HÌNH ĐỊNH GIÁ NÂNG CAO cho cổ phiếu Việt Nam, bổ sung cho lib/valuation-calc.js (P/E, P/B, DDM theo bội số mục tiêu người dùng nhập):
//   * Chi phí vốn chủ (CAPM): Ke = lãi phi rủi ro + beta x phần bù rủi ro cổ phiếu (+ phần bù khác). Lãi phi rủi ro lấy từ lợi suất trái phiếu chính phủ 10 năm theo ngày; beta điều chỉnh Blume.
//   * P/B hợp lý = (ROE - g) / (Ke - g): ngân hàng, chứng khoán định giá theo giá trị sổ sách và khả năng sinh lời trên vốn, không theo dòng tiền tự do (khó xác định với tổ chức tài chính).
//   * Thu nhập thặng dư (Residual Income): Giá trị = BVPS + hiện giá (ROE_t - Ke) x BVPS_{t-1}, ROE trôi dần về mức dài hạn; hợp với ngân hàng và doanh nghiệp có vốn chủ làm nền.
//   * FCFE nhiều giai đoạn: EPS tăng g1 trong N năm, rồi giảm dần về g cuối kỳ; dòng tiền cho cổ đông = EPS x (1 - g/ROE) (tái đầu tư vừa đủ để đạt tăng trưởng đó); giá trị cuối kỳ theo Gordon.
//   * Định giá ngược: tìm tăng trưởng g1 mà thị trường đang kỳ vọng để giá hiện tại là hợp lý.
//   * Bảng nhạy cảm giá trị theo (Ke, g), và điểm chất lượng minh bạch (tiêu chí đạt/không đạt kèm số liệu, tách bộ cho ngân hàng).
//   * Đối chiếu độc lập: số của app so với số cùng loại từ nguồn khác (beta, P/E, P/B, thanh khoản) -- lệch lớn là dấu hiệu nhập sai hoặc dữ liệu cũ.
// Đây là công cụ phân tích, KHÔNG phải khuyến nghị: mọi mô hình rất nhạy với giả định (chênh 1 điểm % trong Ke hoặc g làm giá trị đổi hàng chục %), nên luôn xem bảng nhạy cảm.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global ValuationModels) và module.exports cho Vitest.
const ValuationModels = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };      // null/rỗng KHÔNG được coi là 0
  const isNum = (v) => v !== null && v !== undefined && v !== '' && isFinite(Number(v));

  // ---- chi phí vốn ----
  const BLUME = (b) => 0.67 * b + 0.33;
  // inputs: { rf, beta, erp, extra } -- rf/erp/extra dạng thập phân (0,046). betaAdjust: true (mặc định) áp dụng Blume. Trả { ke, rf, beta, betaUsed, erp, extra } hoặc null nếu thiếu.
  function costOfEquity(inp) {
    const x = inp || {}, rf = num(x.rf), erp = num(x.erp), b = num(x.beta);
    if (rf === null || erp === null || b === null) return null;
    const bu = x.betaAdjust === false ? b : BLUME(b), extra = num(x.extra) || 0;
    return { ke: rf + bu * erp + extra, rf: rf, beta: b, betaUsed: bu, erp: erp, extra: extra };
  }

  // ---- P/B hợp lý ----
  function justifiedPB(p) {
    const roe = num(p.roe), g = num(p.g), ke = num(p.ke), bvps = num(p.bvps);
    if (roe === null || g === null || ke === null) return null;
    if (!(ke > g)) return { ok: false, reason: 'ke<=g' };
    const pb = (roe - g) / (ke - g);
    return { ok: true, pb: pb, fair: bvps !== null && bvps > 0 ? pb * bvps : null };
  }

  // ---- Thu nhập thặng dư ----
  // p: { bvps, roe, roeTerminal (mặc định = ke: về dài hạn không còn lợi nhuận vượt chi phí vốn), ke, g (tăng trưởng cuối kỳ), payout (0..1), years (mặc định 5) }
  function residualIncome(p) {
    const bv0 = num(p.bvps), roe = num(p.roe), ke = num(p.ke);
    if (!(bv0 > 0) || roe === null || ke === null) return null;
    const N = Math.max(1, Math.round(p.years || 5)), g = num(p.g) || 0, payout = Math.min(1, Math.max(0, num(p.payout) === null ? 0.3 : num(p.payout)));
    const roeT = num(p.roeTerminal) === null ? ke : num(p.roeTerminal);
    if (!(ke > g)) return { ok: false, reason: 'ke<=g' };
    let bv = bv0, pv = 0; const rows = [];
    for (let t = 1; t <= N; t++) {
      const roeT_t = roe + (roeT - roe) * (t / N);              // ROE trôi tuyến tính về mức dài hạn
      const ri = (roeT_t - ke) * bv, df = Math.pow(1 + ke, t);
      pv += ri / df;
      rows.push({ t: t, roe: roeT_t, bvStart: bv, ri: ri, pv: ri / df });
      bv = bv * (1 + roeT_t * (1 - payout));                  // sổ sách tăng nhờ lợi nhuận giữ lại
    }
    const riN1 = (roeT - ke) * bv, tv = riN1 / (ke - g), tvPv = tv / Math.pow(1 + ke, N);
    return { ok: true, value: bv0 + pv + tvPv, book: bv0, pvRi: pv, tvPv: tvPv, rows: rows, terminalSharePct: (bv0 + pv + tvPv) > 0 ? tvPv / (bv0 + pv + tvPv) * 100 : null };
  }

  // ---- FCFE nhiều giai đoạn ----
  // p: { eps0 (EPS gần nhất), roe (dùng tính tái đầu tư = g/ROE), ke, g1 (tăng trưởng giai đoạn 1), years1 (5), fadeYears (5), gT (tăng trưởng cuối kỳ), roeTerminal (mặc định = roe) }
  function fcfe(p) {
    const eps0 = num(p.eps0), roe = num(p.roe), ke = num(p.ke), g1 = num(p.g1), gT = num(p.gT);
    if (!(eps0 > 0) || !(roe > 0) || ke === null || g1 === null || gT === null) return null;
    if (!(ke > gT)) return { ok: false, reason: 'ke<=g' };
    const N1 = Math.max(0, Math.round(p.years1 === undefined ? 5 : p.years1)), N2 = Math.max(0, Math.round(p.fadeYears === undefined ? 5 : p.fadeYears));
    const roeT = num(p.roeTerminal) === null ? roe : num(p.roeTerminal);
    let eps = eps0, pv = 0; const rows = []; let t = 0;
    const step = (g, roeUsed) => {
      t++; eps = eps * (1 + g);
      const reinvest = Math.min(1, Math.max(0, g / roeUsed)), cf = eps * (1 - reinvest), df = Math.pow(1 + ke, t);
      pv += cf / df; rows.push({ t: t, g: g, eps: eps, reinvest: reinvest, fcfe: cf, pv: cf / df });
    };
    for (let i = 0; i < N1; i++) step(g1, roe);
    for (let i = 1; i <= N2; i++) { const w = i / (N2 + 1); step(g1 + (gT - g1) * w, roe + (roeT - roe) * w); }
    // giá trị cuối kỳ: EPS năm kế tiếp x (1 - gT/ROE_T) / (Ke - gT)
    const epsNext = eps * (1 + gT), cfNext = epsNext * (1 - Math.min(1, Math.max(0, gT / roeT))), tv = cfNext / (ke - gT), tvPv = tv / Math.pow(1 + ke, t);
    const value = pv + tvPv;
    return { ok: true, value: value, pvFcfe: pv, tvPv: tvPv, terminalSharePct: value > 0 ? tvPv / value * 100 : null, rows: rows };
  }

  // Định giá ngược: g1 mà FCFE cho giá trị = price (tìm bằng chia đôi). Trả { ok, g1 } hoặc { ok:false, reason: 'below'|'above' } khi nằm ngoài [-10%, 60%].
  function reverseFcfe(price, p) {
    const target = num(price);
    if (!(target > 0)) return null;
    const f = (g) => { const r = fcfe(Object.assign({}, p, { g1: g })); return r && r.ok ? r.value : null; };
    let lo = -0.10, hi = 0.60;
    const flo = f(lo), fhi = f(hi);
    if (flo === null || fhi === null) return null;
    if (target < flo) return { ok: false, reason: 'below', g1: lo };
    if (target > fhi) return { ok: false, reason: 'above', g1: hi };
    for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2, fm = f(mid); if (fm < target) lo = mid; else hi = mid; if (hi - lo < 1e-10) break; }
    return { ok: true, g1: (lo + hi) / 2 };
  }

  // Bảng nhạy cảm: model(ke, g) -> giá trị; kes, gs: mảng giá trị. Trả { kes, gs, grid[g][ke] } (null nếu ke<=g)
  function sensitivity(model, kes, gs) {
    return { kes: kes, gs: gs, grid: gs.map((g) => kes.map((ke) => { try { const v = model(ke, g); return isNum(v) ? v : null; } catch (e) { return null; } })) };
  }

  // ---- điểm chất lượng minh bạch ----
  // metrics: các chỉ số từ finance_stock_ratios.metrics (tỷ lệ là số thập phân). financial: true cho ngân hàng/tổ chức tài chính. Chỉ chấm tiêu chí có dữ liệu; điểm quy 0-100 theo số tiêu chí chấm được.
  const NONFIN = [
    ['roaa', 'Đang có lãi (ROAA > 0)', (m) => m.roaa > 0, (m) => pctTxt(m.roaa)],
    ['roae', 'ROE từ 12% trở lên', (m) => m.roae >= 0.12, (m) => pctTxt(m.roae)],
    ['roic', 'ROIC từ 10% trở lên', (m) => m.roic >= 0.10, (m) => pctTxt(m.roic)],
    ['cfoToSales', 'Lợi nhuận có tiền: CFO/doanh thu >= biên lợi nhuận ròng', (m) => m.cfoToSales >= m.netMargin && m.cfoToSales > 0, (m) => pctTxt(m.cfoToSales) + ' so với ' + pctTxt(m.netMargin), ['cfoToSales', 'netMargin']],
    ['positiveCfo2y', 'Dòng tiền kinh doanh dương 2 năm liền', (m) => m.positiveCfo2y >= 2, (m) => String(m.positiveCfo2y) + '/2'],
    ['deltaMargin', 'Biên lợi nhuận không xấu đi', (m) => m.deltaMargin >= 0, (m) => (m.deltaMargin >= 0 ? '+' : '') + (m.deltaMargin * 100).toFixed(1) + ' điểm %'],
    ['interestCoverage', 'Trả lãi vay dễ dàng (>= 3 lần)', (m) => m.interestCoverage >= 3, (m) => m.interestCoverage.toFixed(1) + ' lần'],
    ['debtToEquity', 'Nợ vay / vốn chủ <= 1', (m) => m.debtToEquity <= 1, (m) => m.debtToEquity.toFixed(2)],
    ['currentRatio', 'Thanh toán hiện tại >= 1', (m) => m.currentRatio >= 1, (m) => m.currentRatio.toFixed(2)],
    ['epsGrowthYoY', 'EPS tăng so với cùng kỳ', (m) => m.epsGrowthYoY > 0, (m) => pctTxt(m.epsGrowthYoY, true)],
    ['salesGrowthYoY', 'Doanh thu tăng so với cùng kỳ', (m) => m.salesGrowthYoY > 0, (m) => pctTxt(m.salesGrowthYoY, true)],
  ];
  const FIN = [
    ['roae', 'ROE từ 15% trở lên', (m) => m.roae >= 0.15, (m) => pctTxt(m.roae)],
    ['roaa', 'ROA từ 1% trở lên', (m) => m.roaa >= 0.01, (m) => pctTxt(m.roaa)],
    ['nim', 'Biên lãi ròng (NIM) từ 2,5%', (m) => m.nim >= 0.025, (m) => pctTxt(m.nim, false, 2)],
    ['badDebtCoverage', 'Dự phòng bao phủ nợ xấu >= 100%', (m) => m.badDebtCoverage >= 1, (m) => pctTxt(m.badDebtCoverage)],
    ['equityToAsset', 'Vốn chủ / tổng tài sản >= 8%', (m) => m.equityToAsset >= 0.08, (m) => pctTxt(m.equityToAsset)],
    ['epsGrowthYoY', 'EPS tăng so với cùng kỳ', (m) => m.epsGrowthYoY > 0, (m) => pctTxt(m.epsGrowthYoY, true)],
    ['pretaxGrowthYoY', 'Lợi nhuận trước thuế tăng', (m) => m.pretaxGrowthYoY > 0, (m) => pctTxt(m.pretaxGrowthYoY, true)],
  ];
  function pctTxt(v, sign, d) { const x = Number(v) * 100; return (sign && x > 0 ? '+' : '') + x.toFixed(d === undefined ? 1 : d) + '%'; }
  function qualityScore(metrics, opts) {
    const m = metrics || {}, rules = opts && opts.financial ? FIN : NONFIN;
    const items = rules.map((r) => {
      const needs = r[4] || [r[0]], has = needs.every((k) => isNum(m[k]));
      return { key: r[0], label: r[1], available: has, pass: has ? !!r[2](m) : null, value: has ? r[3](m) : null };
    });
    const scored = items.filter((i) => i.available);
    const passed = scored.filter((i) => i.pass).length;
    const score = scored.length >= 4 ? passed / scored.length * 100 : null;
    return { score: score, passed: passed, scored: scored.length, total: items.length, items: items, level: score === null ? 'unknown' : (score >= 75 ? 'good' : (score >= 50 ? 'mid' : 'weak')), financial: !!(opts && opts.financial) };
  }

  // ---- đối chiếu độc lập ----
  // pairs: [{ key, label, app, ref, tol (tỷ lệ chênh tương đối cho phép), absTol (chênh tuyệt đối cho phép, dùng cho beta) }]. Trả danh sách kèm cờ lệch.
  function crossCheck(pairs) {
    return (pairs || []).map((p) => {
      const a = num(p.app), r = num(p.ref);
      if (a === null || r === null) return { key: p.key, label: p.label, app: a, ref: r, status: 'na' };
      const abs = Math.abs(a - r), rel = r !== 0 ? abs / Math.abs(r) : null;
      const bad = p.absTol !== undefined ? abs > p.absTol : (rel !== null && rel > (p.tol === undefined ? 0.25 : p.tol));
      return { key: p.key, label: p.label, app: a, ref: r, diff: a - r, relPct: rel === null ? null : rel * 100, status: bad ? 'differs' : 'ok' };
    });
  }

  // Vị trí hiện tại so với bình quân lịch sử của chính mã (nguồn: P/E, P/B bình quân 1/3/5 năm). Trả tỷ lệ hiện tại / bình quân.
  function versusHistory(cur, avgs) {
    const c = num(cur); if (!(c > 0)) return null;
    const out = {}; Object.keys(avgs || {}).forEach((k) => { const a = num(avgs[k]); out[k] = a > 0 ? c / a : null; });
    return out;
  }

  return { BLUME, costOfEquity, justifiedPB, residualIncome, fcfe, reverseFcfe, sensitivity, qualityScore, crossCheck, versusHistory };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ValuationModels;
