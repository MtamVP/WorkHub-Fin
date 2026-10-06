// Logic thuần của VALUATION BENCH: ĐỊNH GIÁ DÒNG TIỀN CHIẾT KHẤU (FCFF) nhiều giai đoạn cho doanh nghiệp phi tài chính -- chi phí vốn bình quân (WACC), dự phóng doanh thu / biên EBIT / tái đầu tư,
// giá trị cuối kỳ theo Gordon (có ràng buộc ROIC) và/hoặc bội số thoát, cầu nối từ giá trị doanh nghiệp (EV) sang giá trị vốn chủ và giá mỗi cổ phiếu, bảng nhạy cảm, mô phỏng Monte Carlo (số ngẫu nhiên có hạt giống
// nên tái lập được), DCF ngược (thị trường đang kỳ vọng tăng trưởng/WACC/biên bao nhiêu), kịch bản có xác suất, và bộ giả định mặc định suy ra từ lịch sử.
// Đây là công cụ phân tích, KHÔNG phải khuyến nghị: giá trị cuối kỳ thường chiếm 60-80% EV nên rất nhạy với WACC và tăng trưởng dài hạn; luôn đọc kèm bảng nhạy cảm và Monte Carlo.
// Ngân hàng, chứng khoán, bảo hiểm KHÔNG dùng FCFF (nợ là nguyên liệu kinh doanh): dùng thu nhập thặng dư / P/B hợp lý trong lib/valuation-models.js.
// Đơn vị: đồng (VND); tỷ lệ là số thập phân (0,08 = 8%). KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VBDcf) và module.exports cho Vitest.
const VBDcf = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const BLUME = (b) => 0.67 * b + 0.33;
  const DEFAULTS = { years: 10, highYears: 5, gTerminal: 0.05, erp: 0.08, rfFallback: 0.045, taxRate: 0.2, salesToCapital: 1.5, midYear: false, exitWeight: 0, sizePremium: 0 };

  // ---- Chi phí vốn bình quân ----
  // inp: { rf, beta, erp, sizePremium, extra, kdPre (chi phí vay trước thuế), taxRate, equityValue (vốn hoá), debtValue (nợ vay), betaAdjust }
  function wacc(inp) {
    const x = inp || {}, rf = num(x.rf), beta = num(x.beta), erp = num(x.erp) === null ? DEFAULTS.erp : num(x.erp), tax = num(x.taxRate) === null ? DEFAULTS.taxRate : num(x.taxRate);
    if (rf === null || beta === null) return null;
    const bu = x.betaAdjust === false ? beta : BLUME(beta), size = num(x.sizePremium) || 0, extra = num(x.extra) || 0;
    const ke = rf + bu * erp + size + extra;
    const E = num(x.equityValue), D = num(x.debtValue) || 0, kdPre = num(x.kdPre) === null ? rf + 0.025 : num(x.kdPre);
    const kdPost = kdPre * (1 - tax);
    const we = E > 0 ? E / (E + D) : 1, wd = 1 - we;
    return { rf: rf, beta: beta, betaUsed: bu, erp: erp, sizePremium: size, extra: extra, ke: ke, kdPre: kdPre, kdPost: kdPost, tax: tax, we: we, wd: wd, wacc: we * ke + wd * kdPost };
  }

  // ---- Dự phóng ----
  // Đường tăng trưởng doanh thu: giai đoạn cao `highYears` năm ở g1, sau đó giảm tuyến tính về gTerminal ở năm cuối.
  function growthPath(a) {
    const N = Math.max(2, Math.round(a.years || DEFAULTS.years)), hy = clamp(Math.round(a.highYears === undefined ? DEFAULTS.highYears : a.highYears), 0, N), gT = a.gTerminal === undefined ? DEFAULTS.gTerminal : a.gTerminal;
    const shift = num(a.growthShift) || 0;
    if (Array.isArray(a.growth) && a.growth.length) { const out = []; for (let t = 0; t < N; t++) out.push((num(a.growth[Math.min(t, a.growth.length - 1)]) || 0) + shift); return out; }
    const g1 = num(a.g1) === null ? 0.1 : num(a.g1), out = [];
    for (let t = 1; t <= N; t++) {
      if (t <= hy) out.push(g1 + shift);
      else { const k = (t - hy) / Math.max(1, N - hy); out.push(g1 + (gT - g1) * k + shift * (1 - k)); }     // phần dịch chuyển cũng mờ dần để năm cuối khớp tăng trưởng dài hạn
    }
    return out;
  }
  function marginPath(a) {
    const N = Math.max(2, Math.round(a.years || DEFAULTS.years)), m0 = num(a.ebitMargin), mT = num(a.marginTarget) === null ? m0 : num(a.marginTarget), my = Math.max(1, Math.round(a.marginYears || Math.min(N, 5))), shift = num(a.marginShift) || 0;
    const out = [];
    for (let t = 1; t <= N; t++) out.push((t >= my ? mT : m0 + (mT - m0) * (t / my)) + shift);
    return out;
  }

  // a: { baseRevenue, ebitMargin (biên EBIT cơ sở), marginTarget, marginYears, g1, highYears, gTerminal, years, growth[], growthShift, marginShift, taxRate, salesToCapital | capexPct+daPct+nwcPct,
  //      wacc, terminalRoic, exitMultiple, exitWeight (0..1), cash, debt, minorities, associates, shares, price, midYear }
  function value(a) {
    const w = num(a.wacc);
    if (!(num(a.baseRevenue) > 0) || num(a.ebitMargin) === null || w === null) return { ok: false, reason: 'Thiếu doanh thu cơ sở, biên EBIT hoặc WACC.' };
    const gT = a.gTerminal === undefined ? DEFAULTS.gTerminal : a.gTerminal;
    if (!(w > gT)) return { ok: false, reason: 'WACC phải lớn hơn tăng trưởng dài hạn.' };
    const N = Math.max(2, Math.round(a.years || DEFAULTS.years)), tax = num(a.taxRate) === null ? DEFAULTS.taxRate : num(a.taxRate), mid = !!a.midYear;
    const g = growthPath(a), m = marginPath(a), useCapex = num(a.capexPct) !== null;
    const s2c = num(a.salesToCapital) > 0 ? num(a.salesToCapital) : DEFAULTS.salesToCapital;
    const taxT = num(a.taxTarget) === null ? tax : num(a.taxTarget);               // thuế suất hội tụ tuyến tính về mức dài hạn (ưu đãi thuế không kéo dài mãi)
    const rows = []; let rev = a.baseRevenue, pv = 0;
    for (let t = 1; t <= N; t++) {
      const prev = rev; rev = prev * (1 + g[t - 1]);
      const taxT_t = tax + (taxT - tax) * (t / N);
      const ebit = rev * m[t - 1], nopat = ebit > 0 ? ebit * (1 - taxT_t) : ebit;       // lỗ thì không có lá chắn thuế (đơn giản hoá, thận trọng)
      let reinvest, da = null;
      if (useCapex) { da = rev * (num(a.daPct) || 0); reinvest = rev * a.capexPct - da + (rev - prev) * (num(a.nwcPct) || 0); }
      else reinvest = (rev - prev) / s2c;
      const fcff = nopat - reinvest, expo = mid ? t - 0.5 : t, df = 1 / Math.pow(1 + w, expo);
      pv += fcff * df;
      rows.push({ t: t, revenue: rev, growth: g[t - 1], ebitMargin: m[t - 1], ebit: ebit, taxRate: taxT_t, nopat: nopat, reinvest: reinvest, da: da, ebitda: da !== null ? ebit + da : null, fcff: fcff, df: df, pv: fcff * df });
    }
    // giá trị cuối kỳ
    const last = rows[N - 1];
    const roicT = num(a.terminalRoic) === null ? w : num(a.terminalRoic);
    const reinvRate = roicT > 0 ? clamp(gT / roicT, 0, 1) : 1;
    const fcffN1 = last.nopat * (1 + gT) * (1 - reinvRate);
    const tvG = fcffN1 / (w - gT);
    const ebitdaN = last.ebitda !== null ? last.ebitda : (last.ebit > 0 ? last.ebit * 1.2 : null);       // không có D&A: ước EBITDA ≈ EBIT × 1,2 (chỉ để quy đổi bội số, hiển thị rõ)
    const exitM = num(a.exitMultiple), tvX = exitM !== null && ebitdaN > 0 ? ebitdaN * exitM : null;
    const wx = tvX === null ? 0 : clamp(num(a.exitWeight) === null ? DEFAULTS.exitWeight : a.exitWeight, 0, 1);
    const dfN = 1 / Math.pow(1 + w, N), dfG = mid ? 1 / Math.pow(1 + w, N - 0.5) : dfN;
    const pvTv = (1 - wx) * tvG * dfG + wx * (tvX === null ? 0 : tvX * dfN);
    const ev = pv + pvTv;
    const cash = num(a.cash) || 0, debt = num(a.debt) || 0, min = num(a.minorities) || 0, assoc = num(a.associates) || 0;
    // Cổ đông thiểu số: dòng tiền FCFF là của TOÀN BỘ tập đoàn nên phải trừ phần thuộc cổ đông thiểu số. Khi biết tỷ lệ lợi nhuận họ hưởng (minorityShare) thì trừ theo tỷ lệ đó trên giá trị vốn chủ hợp nhất
    // (sát giá trị thị trường hơn giá sổ sách rất nhiều khi công ty con sinh lời cao); không thì trừ theo giá sổ sách.
    const pre = ev + cash + assoc - debt, msh = num(a.minorityShare);
    const minValue = msh !== null && pre > 0 ? pre * clamp(msh, 0, 0.9) : min;
    const equity = pre - minValue, shares = num(a.shares), perShare = shares > 0 ? equity / shares : null;
    const warnings = [];
    if (ev > 0 && pvTv / ev > 0.75) warnings.push('Giá trị cuối kỳ chiếm ' + Math.round(pvTv / ev * 100) + '% EV: kết quả phụ thuộc nhiều vào WACC và tăng trưởng dài hạn.');
    if (gT > 0.06) warnings.push('Tăng trưởng dài hạn ' + (gT * 100).toFixed(1) + '% cao hơn tăng trưởng danh nghĩa dài hạn hợp lý của nền kinh tế (khoảng 5-6%).');
    if (a.rf !== undefined && gT > num(a.rf)) warnings.push('Tăng trưởng dài hạn vượt lãi suất phi rủi ro: giả định doanh nghiệp tăng nhanh hơn nền kinh tế mãi mãi.');
    if (roicT < w - 1e-9) warnings.push('ROIC cuối kỳ thấp hơn WACC: doanh nghiệp bị giả định phá huỷ giá trị khi tăng trưởng.');
    if (equity < 0) warnings.push('Giá trị vốn chủ âm: nợ vượt giá trị doanh nghiệp theo các giả định này.');
    return {
      ok: true, rows: rows, pvFcff: pv, terminal: { fcffN1: fcffN1, reinvestRate: reinvRate, roic: roicT, tvGordon: tvG, tvExit: tvX, exitWeight: wx, pv: pvTv, impliedExitMultiple: ebitdaN > 0 ? tvG / ebitdaN : null, ebitdaN: ebitdaN },
      ev: ev, bridge: { cash: cash, associates: assoc, debt: debt, minorities: minValue }, equity: equity, perShare: perShare, tvSharePct: ev > 0 ? pvTv / ev * 100 : null,
      upsidePct: perShare !== null && num(a.price) > 0 ? (perShare / a.price - 1) * 100 : null, wacc: w, gTerminal: gT, warnings: warnings,
    };
  }

  // Nhạy cảm giá/cổ phiếu theo WACC (hàng) và tăng trưởng dài hạn (cột)
  function sensitivityWaccG(a, waccs, gs) {
    const rows = waccs.map(function (w) { return gs.map(function (g) { const r = value(Object.assign({}, a, { wacc: w, gTerminal: g })); return r.ok ? r.perShare : null; }); });
    return { waccs: waccs, gs: gs, values: rows };
  }
  // Nhạy cảm theo biên EBIT mục tiêu (hàng) và tăng trưởng giai đoạn đầu (cột)
  function sensitivityMarginGrowth(a, margins, growths) {
    const rows = margins.map(function (mg) { return growths.map(function (g1) { const r = value(Object.assign({}, a, { marginTarget: mg, g1: g1, growth: undefined })); return r.ok ? r.perShare : null; }); });
    return { margins: margins, growths: growths, values: rows };
  }
  // Lưới quanh giá trị hiện tại: danh sách k điểm cách nhau `step`
  const around = (c, step, k) => { const out = []; for (let i = -k; i <= k; i++) out.push(Math.round((c + i * step) * 10000) / 10000); return out; };

  // ---- Monte Carlo ----
  function mulberry32(seed) { let t = seed >>> 0; return function () { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
  // Phân phối tam giác (min, mode, max)
  function tri(rng, lo, mode, hi) { const u = rng(), c = (mode - lo) / (hi - lo || 1); return u < c ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode)); }
  function quantile(sorted, p) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
  // opts: { n, seed, growthSpread, marginSpread, waccSpread, gSpread, s2cSpread } -- độ rộng ± quanh giả định cơ sở (tuyệt đối, thập phân; s2c theo tỷ lệ)
  function monteCarlo(a, opts) {
    const o = Object.assign({ n: 2000, seed: 20261006, growthSpread: 0.04, marginSpread: 0.03, waccSpread: 0.015, gSpread: 0.01, s2cSpread: 0.3 }, opts || {});
    const rng = mulberry32(o.seed), vals = [], base = value(a);
    if (!base.ok) return { ok: false, reason: base.reason };
    const s2c0 = num(a.salesToCapital) > 0 ? a.salesToCapital : DEFAULTS.salesToCapital, w0 = a.wacc, gT0 = a.gTerminal === undefined ? DEFAULTS.gTerminal : a.gTerminal;
    for (let i = 0; i < o.n; i++) {
      const w = Math.max(0.05, w0 + tri(rng, -o.waccSpread, 0, o.waccSpread));
      const gT = Math.min(w - 0.02, Math.max(0, gT0 + tri(rng, -o.gSpread, 0, o.gSpread)));
      const draw = Object.assign({}, a, { wacc: w, gTerminal: gT, growthShift: (num(a.growthShift) || 0) + tri(rng, -o.growthSpread, 0, o.growthSpread), marginShift: (num(a.marginShift) || 0) + tri(rng, -o.marginSpread, 0, o.marginSpread),
        salesToCapital: s2c0 * tri(rng, 1 - o.s2cSpread, 1, 1 + o.s2cSpread) });
      const r = value(draw);
      if (r.ok && r.perShare !== null && isFinite(r.perShare)) vals.push(r.perShare);
    }
    vals.sort(function (x, y) { return x - y; });
    if (vals.length < 50) return { ok: false, reason: 'Quá ít kết quả hợp lệ.' };
    const mean = vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
    const price = num(a.price), lo = quantile(vals, 0.02), hi = quantile(vals, 0.98), bins = 20, step = (hi - lo) / bins || 1, hist = new Array(bins).fill(0);
    vals.forEach(function (v) { const k = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / step))); hist[k]++; });
    return { ok: true, n: vals.length, base: base.perShare, mean: mean, p5: quantile(vals, 0.05), p10: quantile(vals, 0.1), p25: quantile(vals, 0.25), median: quantile(vals, 0.5), p75: quantile(vals, 0.75), p90: quantile(vals, 0.9), p95: quantile(vals, 0.95),
      probAbovePrice: price > 0 ? vals.filter(function (v) { return v > price; }).length / vals.length : null, histogram: { lo: lo, step: step, counts: hist }, seed: o.seed,
      note: 'Các biến được rút độc lập theo phân phối tam giác quanh giả định cơ sở (không mô phỏng tương quan giữa tăng trưởng, biên và WACC), nên độ rộng chỉ là ước lượng độ bất định của giả định, không phải xác suất thật.' };
  }

  // ---- DCF ngược: biến nào làm giá trị bằng giá thị trường ----
  function bisect(f, lo, hi, target, tol) {
    let a = lo, b = hi, fa = f(a) - target, fb = f(b) - target;
    if (fa === null || fb === null || isNaN(fa) || isNaN(fb) || fa * fb > 0) return null;
    for (let i = 0; i < 80; i++) { const mid = (a + b) / 2, fm = f(mid) - target; if (Math.abs(fm) <= (tol || 1e-6) * Math.max(1, Math.abs(target))) return mid; if (fa * fm <= 0) { b = mid; fb = fm; } else { a = mid; fa = fm; } }
    return (a + b) / 2;
  }
  function implied(a, price) {
    const p = num(price); if (!(p > 0)) return null;
    const val = (patch) => { const r = value(Object.assign({}, a, patch)); return r.ok ? r.perShare : NaN; };
    const g0 = growthPath(a), avg0 = g0.slice(0, Math.max(1, Math.round(a.highYears === undefined ? DEFAULTS.highYears : a.highYears))).reduce(function (s, v) { return s + v; }, 0) / Math.max(1, Math.round(a.highYears === undefined ? DEFAULTS.highYears : a.highYears));
    const shift = bisect(function (s) { return val({ growthShift: (num(a.growthShift) || 0) + s }); }, -0.3, 0.6, p);
    const w = bisect(function (x) { return val({ wacc: x }); }, (a.gTerminal === undefined ? DEFAULTS.gTerminal : a.gTerminal) + 0.005, 0.35, p);
    const mshift = bisect(function (s) { return val({ marginShift: (num(a.marginShift) || 0) + s }); }, -0.25, 0.4, p);
    return { price: p, growthShift: shift, impliedGrowthStage1: shift === null ? null : avg0 + shift - (num(a.growthShift) || 0), baseGrowthStage1: avg0, impliedWacc: w, impliedMarginShift: mshift };
  }

  // ---- Kịch bản có xác suất ----
  // defs: [{ name, prob, patch }]; patch ghi đè giả định (growthShift, marginShift, wacc, gTerminal, g1, marginTarget...). Trả giá trị từng kịch bản và kỳ vọng có trọng số xác suất.
  function scenarios(a, defs) {
    const list = (defs || []).map(function (d) { const r = value(Object.assign({}, a, d.patch || {})); return { name: d.name, prob: num(d.prob) || 0, perShare: r.ok ? r.perShare : null, ev: r.ok ? r.ev : null, upsidePct: r.ok ? r.upsidePct : null, ok: r.ok }; });
    const okList = list.filter(function (x) { return x.ok && x.perShare !== null; }), tot = okList.reduce(function (s, x) { return s + x.prob; }, 0);
    return { list: list, expected: tot > 0 ? okList.reduce(function (s, x) { return s + x.perShare * x.prob; }, 0) / tot : null, probSum: list.reduce(function (s, x) { return s + x.prob; }, 0) };
  }
  // Ba kịch bản mặc định quanh giả định cơ sở: bi quan 25% / cơ sở 50% / lạc quan 25%
  function defaultScenarios() {
    return [
      { name: 'Bi quan', prob: 0.25, patch: { growthShift: -0.04, marginShift: -0.03, waccAdd: 0.01 } },
      { name: 'Cơ sở', prob: 0.5, patch: {} },
      { name: 'Lạc quan', prob: 0.25, patch: { growthShift: 0.04, marginShift: 0.02, waccAdd: -0.005 } },
    ];
  }
  function runDefaultScenarios(a) {
    const defs = defaultScenarios().map(function (d) { const p = Object.assign({}, d.patch); if (p.waccAdd !== undefined) { p.wacc = a.wacc + p.waccAdd; delete p.waccAdd; } if (p.growthShift !== undefined) p.growthShift = (num(a.growthShift) || 0) + p.growthShift; if (p.marginShift !== undefined) p.marginShift = (num(a.marginShift) || 0) + p.marginShift; return { name: d.name, prob: d.prob, patch: p }; });
    return scenarios(a, defs);
  }

  // ---- Bộ giả định mặc định suy ra từ lịch sử ----
  // ctx: { periods (kỳ năm đã chuẩn hoá, tăng dần), ttm (kỳ TTM hoặc null), price, shares, beta, rf, erp, marketCap, kdPre }
  // Mọi số đều là điểm khởi đầu CÓ THỂ CHỈNH: trả kèm `notes` giải thích nguồn từng giả định để người dùng không tin mù.
  function buildAssumptions(ctx) {
    const P = (ctx.periods || []).filter(function (p) { return p.form === 'NON_FINANCE'; });
    if (!P.length) return null;
    const last = P[P.length - 1], base = ctx.ttm && num(ctx.ttm.revenue) > 0 ? ctx.ttm : last, notes = [];
    const lastN = P.slice(-3);
    const marginOf = (p) => (num(p.ebit) !== null && p.revenue > 0 ? p.ebit / p.revenue : null);
    const ms = lastN.map(marginOf).filter(function (v) { return v !== null; });
    const ebitMargin = ms.length ? ms.reduce(function (s, v) { return s + v; }, 0) / ms.length : null;
    notes.push('Biên EBIT cơ sở = bình quân ' + ms.length + ' năm gần nhất của EBIT hoạt động / doanh thu.');
    // tăng trưởng doanh thu: CAGR 3 năm, kết hợp g bền vững; kẹp 2%..25%
    let cagr = null;
    if (P.length >= 2) { const n = Math.min(3, P.length - 1), a0 = P[P.length - 1 - n].revenue, b0 = last.revenue; if (a0 > 0 && b0 > 0) cagr = Math.pow(b0 / a0, 1 / n) - 1; }
    const sg = P.length >= 2 && last.equity > 0 && last.netIncome > 0 && last.divPaid !== null ? (last.netIncome / (last.equity)) * (1 - Math.min(1, last.divPaid / last.netIncome)) : null;
    let g1 = cagr === null ? 0.08 : cagr;
    if (sg !== null && cagr !== null) g1 = 0.6 * cagr + 0.4 * sg;
    g1 = clamp(g1, 0.02, 0.2);
    notes.push('Tăng trưởng giai đoạn đầu ' + (g1 * 100).toFixed(1) + '% = 60% CAGR doanh thu 3 năm' + (sg !== null ? ' + 40% tăng trưởng bền vững (ROE × giữ lại)' : '') + ', kẹp trong 2%-20%.');
    // thuế
    const taxes = lastN.map(function (p) { return p.effTaxRate; }).filter(function (v) { return v !== null && v !== undefined; });
    const tax = taxes.length ? clamp(taxes.reduce(function (s, v) { return s + v; }, 0) / taxes.length, 0.1, 0.25) : DEFAULTS.taxRate;
    notes.push('Thuế suất ' + (tax * 100).toFixed(1) + '% (bình quân thuế thực tế 3 năm, kẹp 10%-25%), hội tụ dần về ' + (Math.max(tax, 0.2) * 100).toFixed(0) + '% (thuế TNDN phổ thông) vào năm cuối vì ưu đãi thuế không kéo dài mãi.');
    // doanh thu trên vốn đầu tư: Δdoanh thu / Δtài sản hoạt động ròng, bình quân các năm có dữ liệu hợp lệ
    const s2cs = [];
    for (let i = 1; i < P.length; i++) { const a0 = netOA(P[i - 1]), b0 = netOA(P[i]); if (a0 !== null && b0 !== null && b0 - a0 > 0 && P[i].revenue > P[i - 1].revenue) s2cs.push((P[i].revenue - P[i - 1].revenue) / (b0 - a0)); }
    const s2c = s2cs.length ? clamp(s2cs.reduce(function (s, v) { return s + v; }, 0) / s2cs.length, 0.5, 5) : DEFAULTS.salesToCapital;
    const shs = lastN.map(function (p) { return p.netIncomeAll > 0 && p.nci !== null ? Math.max(0, p.nci) / p.netIncomeAll : null; }).filter(function (v) { return v !== null; });
    const minorityShare = shs.length ? clamp(shs.reduce(function (x, v) { return x + v; }, 0) / shs.length, 0, 0.6) : null;
    if (minorityShare !== null && minorityShare > 0.005) notes.push('Cổ đông thiểu số hưởng ' + (minorityShare * 100).toFixed(1) + '% lợi nhuận hợp nhất (bình quân 3 năm): trừ cùng tỷ lệ đó khỏi giá trị vốn chủ thay vì trừ giá sổ sách.');
    notes.push('Doanh thu trên vốn đầu tư ' + s2c.toFixed(2) + ' ' + (s2cs.length ? '(bình quân Δdoanh thu / Δtài sản hoạt động ròng ' + s2cs.length + ' năm, kẹp 0,5-5)' : '(mặc định, thiếu lịch sử)') + '.');
    const rf = num(ctx.rf) === null ? DEFAULTS.rfFallback : ctx.rf, erp = num(ctx.erp) === null ? DEFAULTS.erp : ctx.erp;
    const kdPre = num(ctx.kdPre) !== null ? ctx.kdPre : (last.interest > 0 && last.debt > 0 ? clamp(last.interest / last.debt, 0.04, 0.18) : rf + 0.03);
    const w = wacc({ rf: rf, beta: num(ctx.beta) === null ? 1 : ctx.beta, erp: erp, kdPre: kdPre, taxRate: tax, equityValue: ctx.marketCap, debtValue: last.debt, sizePremium: num(ctx.sizePremium) || 0 });
    notes.push('WACC ' + (w.wacc * 100).toFixed(2) + '% = ' + Math.round(w.we * 100) + '% vốn chủ × Ke ' + (w.ke * 100).toFixed(2) + '% + ' + Math.round(w.wd * 100) + '% nợ × Kd sau thuế ' + (w.kdPost * 100).toFixed(2) + '% (rf ' + (rf * 100).toFixed(2) + '%, beta ' + w.betaUsed.toFixed(2) + ' điều chỉnh Blume, ERP ' + (erp * 100).toFixed(1) + '%).');
    const gTerminal = Math.min(DEFAULTS.gTerminal, rf);
    return {
      baseRevenue: base.revenue, ebitMargin: ebitMargin, marginTarget: ebitMargin, marginYears: 5, g1: g1, highYears: 5, gTerminal: gTerminal, years: 10, taxRate: tax, taxTarget: Math.max(tax, 0.2), minorityShare: minorityShare, salesToCapital: s2c,
      wacc: w.wacc, terminalRoic: Math.max(w.wacc, Math.min(0.2, w.wacc + 0.03)), exitMultiple: null, exitWeight: 0, midYear: false,
      cash: (last.cash || 0) + (last.stInvest || 0), debt: last.debt || 0, minorities: last.nciEquity || 0, associates: last.ltInvest || 0, shares: num(ctx.shares), price: num(ctx.price), rf: rf,
      waccDetail: w, notes: notes, baseDate: base.date, baseIsTtm: base === ctx.ttm,
    };
  }
  // ---------- DCF THEO ĐỘNG LỰC: dự báo từng năm theo từng mảng kinh doanh ----------
  // inp: { years (2..10, mặc định 7), segments: [{ name, baseRevenue, growth (số hoặc mảng theo năm; thiếu năm thì giữ giá trị cuối rồi giảm dần về gTerminal ở năm cuối), margin (biên EBIT: số hoặc mảng) }],
  //   corpCostPct (chi phí chung chưa phân bổ, % doanh thu), daPct, capexPct (số hoặc mảng), nwcPct (vốn lưu động ròng / doanh thu; ΔNWC = nwcPct x Δdoanh thu), taxRate,
  //   wacc, gTerminal, terminalRoic, cash, debt, minorities, minorityShare, associates, shares, price }
  function pathOf(x, N, fallbackEnd) {
    const arr = Array.isArray(x) ? x.map(num).filter(function (v) { return v !== null; }) : (num(x) !== null ? [num(x)] : []);
    if (!arr.length) return null;
    const out = [], n = arr.length;
    for (let t = 0; t < N; t++) {
      if (t < n) out.push(arr[t]);
      else if (fallbackEnd === undefined || fallbackEnd === null) out.push(arr[n - 1]);
      else out.push(arr[n - 1] + (fallbackEnd - arr[n - 1]) * ((t - n + 1) / (N - n)));      // từ năm sau điểm cuối người dùng nhập, giảm tuyến tính về mức dài hạn ở năm cuối
    }
    return out;
  }
  function driverValue(inp) {
    const a = inp || {}, w = num(a.wacc), gT = a.gTerminal === undefined || a.gTerminal === null ? DEFAULTS.gTerminal : num(a.gTerminal);
    const segs = (a.segments || []).filter(function (s) { return s && num(s.baseRevenue) > 0; });
    if (!segs.length) return { ok: false, reason: 'Cần ít nhất một mảng kinh doanh có doanh thu cơ sở dương.' };
    if (w === null || gT === null) return { ok: false, reason: 'Thiếu WACC hoặc tăng trưởng dài hạn.' };
    if (!(w > gT)) return { ok: false, reason: 'WACC phải lớn hơn tăng trưởng dài hạn.' };
    const N = Math.max(2, Math.min(10, Math.round(a.years || 7))), tax = num(a.taxRate) === null ? DEFAULTS.taxRate : clamp(num(a.taxRate), 0, 0.5);
    const sp = segs.map(function (s) {
      const g = pathOf(s.growth, N, gT), m = pathOf(s.margin, N, null);
      return { name: String(s.name || 'Mảng').slice(0, 40), rev0: s.baseRevenue, g: g, m: m };
    });
    if (sp.some(function (s) { return !s.g || !s.m; })) return { ok: false, reason: 'Mỗi mảng cần tăng trưởng và biên EBIT.' };
    const capex = pathOf(a.capexPct, N, null), daPct = num(a.daPct) === null ? 0 : a.daPct, nwc = num(a.nwcPct) === null ? 0 : a.nwcPct, corp = num(a.corpCostPct) === null ? 0 : a.corpCostPct;
    if (!capex) return { ok: false, reason: 'Cần tỷ lệ đầu tư (capex) trên doanh thu.' };
    const rows = []; let prevTotal = sp.reduce(function (s, x) { return s + x.rev0; }, 0), pv = 0; const revs = sp.map(function (x) { return x.rev0; }), total0 = prevTotal;
    for (let t = 1; t <= N; t++) {
      let total = 0, ebitSeg = 0; const segRev = [];
      sp.forEach(function (x, i) { revs[i] = revs[i] * (1 + x.g[t - 1]); segRev.push(revs[i]); total += revs[i]; ebitSeg += revs[i] * x.m[t - 1]; });
      const ebit = ebitSeg - total * corp, nopat = ebit > 0 ? ebit * (1 - tax) : ebit;
      const da = total * daPct, cx = total * capex[t - 1], dNwc = (total - prevTotal) * nwc, fcff = nopat + da - cx - dNwc, df = 1 / Math.pow(1 + w, t);
      pv += fcff * df;
      rows.push({ t: t, segRevenue: segRev, revenue: total, growth: prevTotal > 0 ? total / prevTotal - 1 : null, ebit: ebit, ebitMargin: total > 0 ? ebit / total : null, nopat: nopat, da: da, ebitda: ebit + da, capex: cx, dNwc: dNwc, fcff: fcff, df: df, pv: fcff * df });
      prevTotal = total;
    }
    const last = rows[N - 1], roicT = num(a.terminalRoic) === null ? w : num(a.terminalRoic), reinv = roicT > 0 ? clamp(gT / roicT, 0, 1) : 1;
    const fcffN1 = last.nopat * (1 + gT) * (1 - reinv), tv = fcffN1 / (w - gT), pvTv = tv / Math.pow(1 + w, N), ev = pv + pvTv;
    const cash = num(a.cash) || 0, debt = num(a.debt) || 0, assoc = num(a.associates) || 0, min = num(a.minorities) || 0, msh = num(a.minorityShare);
    const pre = ev + cash + assoc - debt, minValue = msh !== null && pre > 0 ? pre * clamp(msh, 0, 0.9) : min, equity = pre - minValue, shares = num(a.shares), perShare = shares > 0 ? equity / shares : null;
    const warnings = [], cagr = Math.pow(last.revenue / total0, 1 / N) - 1;
    if (ev > 0 && pvTv / ev > 0.75) warnings.push('Giá trị cuối kỳ chiếm ' + Math.round(pvTv / ev * 100) + '% EV: kết quả phụ thuộc nhiều vào WACC và tăng trưởng dài hạn.');
    if (cagr > 0.25) warnings.push('Doanh thu tăng bình quân ' + (cagr * 100).toFixed(1) + '%/năm trong ' + N + ' năm: rất cao, cần luận điểm cụ thể cho từng mảng.');
    if (last.ebitMargin !== null && last.ebitMargin > 0.4) warnings.push('Biên EBIT năm cuối ' + (last.ebitMargin * 100).toFixed(1) + '% rất cao so với đa số doanh nghiệp.');
    if (equity < 0) warnings.push('Giá trị vốn chủ âm theo các giả định này.');
    return { ok: true, rows: rows, segments: sp.map(function (x) { return { name: x.name, rev0: x.rev0 }; }), pvFcff: pv, tv: tv, pvTv: pvTv, ev: ev, bridge: { cash: cash, associates: assoc, debt: debt, minorities: minValue }, equity: equity, perShare: perShare,
      tvSharePct: ev > 0 ? pvTv / ev * 100 : null, upsidePct: perShare !== null && num(a.price) > 0 ? (perShare / a.price - 1) * 100 : null, wacc: w, gTerminal: gT, years: N, revenueCagr: cagr, warnings: warnings,
      impliedEvEbitda1: rows[0].ebitda > 0 ? ev / rows[0].ebitda : null };
  }
  // Mẫu điền sẵn cho động lực từ giả định DCF mặc định và lịch sử: một mảng "Toàn công ty"; người dùng thêm mảng, sửa đường tăng trưởng/biên, capex, vốn lưu động.
  function driverDefaults(a, periods) {
    if (!a) return null;
    const P = (periods || []).filter(function (p) { return p.form === 'NON_FINANCE'; }).slice(-3), N = 7;
    const avg = function (f) { const v = P.map(f).filter(function (x) { return x !== null && isFinite(x); }); return v.length ? v.reduce(function (s, x) { return s + x; }, 0) / v.length : null; };
    const g = growthPath(a).slice(0, N), m = marginPath(a).slice(0, N);
    const capexPct = avg(function (p) { return p.revenue > 0 && num(p.capex) !== null ? p.capex / p.revenue : null; }), daPct = avg(function (p) { return p.revenue > 0 && num(p.da) !== null ? p.da / p.revenue : null; });
    const lastP = P.length ? P[P.length - 1] : null, nwcPct = lastP && lastP.revenue > 0 && num(lastP.workingCapital) !== null ? clamp(lastP.workingCapital / lastP.revenue, -0.5, 0.8) : 0.1;
    const r4 = function (x) { return Math.round(x * 10000) / 10000; };
    return { years: N, segments: [{ name: 'Toàn công ty', baseRevenue: a.baseRevenue, growth: g.map(r4), margin: m.map(r4) }], corpCostPct: 0, daPct: r4(daPct === null ? 0.03 : daPct), capexPct: r4(capexPct === null ? 0.05 : capexPct), nwcPct: r4(nwcPct),
      taxRate: a.taxTarget || a.taxRate, wacc: a.wacc, gTerminal: a.gTerminal, terminalRoic: a.terminalRoic, cash: a.cash, debt: a.debt, minorities: a.minorities, minorityShare: a.minorityShare, associates: a.associates, shares: a.shares, price: a.price };
  }
  function netOA(p) { return num(p.totalAssets) === null || num(p.liabilities) === null ? null : (p.totalAssets - (p.cash || 0) - (p.stInvest || 0) - (p.ltInvest || 0)) - (p.liabilities - (p.debt || 0)); }

  return { DEFAULTS, BLUME, wacc, growthPath, marginPath, value, driverValue, driverDefaults, pathOf, sensitivityWaccG, sensitivityMarginGrowth, around, mulberry32, tri, quantile, monteCarlo, implied, scenarios, defaultScenarios, runDefaultScenarios, buildAssumptions };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBDcf;
