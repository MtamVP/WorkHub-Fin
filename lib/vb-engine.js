// Logic thuần của VALUATION BENCH: BỘ ĐIỀU PHỐI -- nhận dữ liệu thô của một cổ phiếu (báo cáo tài chính VNDirect, nến ngày, chuỗi bội số lịch sử, thống kê ngành, lãi suất, lịch sử định giá thị trường) và dựng TOÀN BỘ phân tích:
// cơ bản (tỷ số, DuPont, điểm chất lượng), định giá (DCF + nhạy cảm + Monte Carlo + DCF ngược + kịch bản, bội số ngang hàng và lịch sử, các phương pháp thu nhập/tài sản; ngân hàng/tài chính dùng thu nhập thặng dư, P/B hợp lý, FCFE),
// kỹ thuật, bối cảnh thị trường, và tổng hợp. Giao diện chỉ việc gọi analyze() với giả định người dùng đã chỉnh và hiển thị kết quả; mọi phép tính nằm trong các thư viện có kiểm thử.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VBEngine) và module.exports cho Vitest. Cần nạp trước: vb-statements, vb-fundamental, vb-dcf, vb-asset, vb-multiples, vb-technical, vb-market, vb-synthesis,
// valuation-models, valuation-history (và tuỳ chọn peer-valuation).
const VBEngine = (function () {
  const isNode = typeof require === 'function' && typeof module !== 'undefined';
  const need = (path, g) => (isNode ? require(path) : g);
  const S = need('./vb-statements.js', typeof VBStatements !== 'undefined' ? VBStatements : null);
  const F = need('./vb-fundamental.js', typeof VBFundamental !== 'undefined' ? VBFundamental : null);
  const D = need('./vb-dcf.js', typeof VBDcf !== 'undefined' ? VBDcf : null);
  const A = need('./vb-asset.js', typeof VBAsset !== 'undefined' ? VBAsset : null);
  const M = need('./vb-multiples.js', typeof VBMultiples !== 'undefined' ? VBMultiples : null);
  const T = need('./vb-technical.js', typeof VBTechnical !== 'undefined' ? VBTechnical : null);
  const K = need('./vb-market.js', typeof VBMarket !== 'undefined' ? VBMarket : null);
  const Y = need('./vb-synthesis.js', typeof VBSynthesis !== 'undefined' ? VBSynthesis : null);
  const VM = need('./valuation-models.js', typeof ValuationModels !== 'undefined' ? ValuationModels : null);
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const FINANCIAL = ['BANK', 'SECURITIES', 'INSURANCE'];

  // ctx: {
  //   symbol, form (tuỳ chọn; tự nhận từ hàng báo cáo), annualRows, quarterRows (hàng API /financial_statements), candles {t,o,h,l,c,v} (giá VND), indexCandles {t,c},
  //   ratioSeries { pe: [giá trị theo ngày], pb: [...] }, metrics (finance_market_snapshot.metrics của mã: shares, beta, divYield, foreign..., advValue20, jdk...), peerStats (stats ngành), sectorCode, sectorName, sectorStats,
  //   histRows (finance_valuation_history), bond10yPct, erp, sizePremium, price (ghi đè), shares (ghi đè),
  //   dcf (ghi đè giả định DCF), weights (ghi đè trọng số phương pháp), marginOfSafety, bankInputs ({ roe, g, payout, ke, years })
  // }
  function analyze(ctx) {
    const c = ctx || {}, out = { symbol: c.symbol || null, warnings: [], notes: [] };
    const rows = (c.annualRows || []).concat(c.quarterRows || []);
    const form = c.form || S.detectFormFromRows(c.annualRows && c.annualRows.length ? c.annualRows : rows) || 'NON_FINANCE';
    out.form = form; out.formLabel = S.FORM_LABEL[form];
    const periods = S.normalize(S.mergeRows(c.annualRows), form), quarters = c.quarterRows && c.quarterRows.length ? S.normalize(S.mergeRows(c.quarterRows), form) : [];
    out.periods = periods; out.quarters = quarters;
    if (!periods.length) { out.ok = false; out.reason = 'Chưa có báo cáo tài chính năm của mã này.'; return out; }
    const last = periods[periods.length - 1], prev = periods.length > 1 ? periods[periods.length - 2] : null;
    // TTM: cộng 4 quý (chỉ chỉ tiêu kết quả kinh doanh); EBITDA TTM dùng khấu hao năm gần nhất
    let ttm = quarters.length >= 4 ? S.ttm(quarters) : null;
    if (ttm && form === 'NON_FINANCE') { ttm.da = last.da; ttm.ebitda = ttm.ebit !== null && last.da !== null ? ttm.ebit + last.da : null; ttm.cfo = null; ttm.fcf = null; ttm.capex = null; ttm.divPaid = last.divPaid; ttm.shareIssue = null; ttm.effTaxRate = ttm.pretax > 0 && ttm.tax !== null ? clamp(ttm.tax / ttm.pretax, 0, 0.5) : last.effTaxRate; }
    out.ttm = ttm;
    // giá và số cổ phiếu
    const candles = c.candles && c.candles.c && c.candles.c.length ? c.candles : null;
    const price = num(c.price) !== null ? num(c.price) : (candles ? candles.c[candles.c.length - 1] : null);
    const shares = num(c.shares) !== null ? num(c.shares) : (num(c.metrics && c.metrics.shares) > 0 ? c.metrics.shares : (last.paidIn > 0 ? last.paidIn / 10000 : null));
    out.price = price; out.shares = shares; out.marketCap = price > 0 && shares > 0 ? price * shares : null;
    if (!(price > 0)) out.warnings.push('Chưa có giá thị trường: các phương pháp so với giá không tính được.');
    if (!(shares > 0)) out.warnings.push('Không xác định được số cổ phiếu lưu hành: giá trị mỗi cổ phiếu không tính được.');
    const metrics = c.metrics || {}, rf = num(c.bond10yPct) !== null ? c.bond10yPct / 100 : D.DEFAULTS.rfFallback;
    const erp = num(c.erp) !== null ? c.erp : D.DEFAULTS.erp, beta = num(metrics.beta) !== null ? metrics.beta : 1;

    // ---- cơ bản ----
    const analysis = form === 'NON_FINANCE' ? F.analyze(periods) : null;
    out.fundamental = analysis;
    out.dupont = form === 'NON_FINANCE' || form === 'BANK' ? F.dupont(last, prev) : null;
    out.bank = form === 'BANK' ? { latest: F.bank(last, prev), series: periods.map(function (p, i) { return Object.assign({ date: p.date, year: p.year }, F.bank(p, i ? periods[i - 1] : null)); }) } : null;
    out.quality = form === 'NON_FINANCE' ? { piotroski: F.piotroski(last, prev), altman: F.altman(last, out.marketCap), beneish: F.beneish(last, prev), accruals: F.accruals(last, prev) } : {};
    const basis = ttm && form === 'NON_FINANCE' ? ttm : last;      // số liệu cho bội số: ưu tiên TTM
    out.basis = { date: basis.date, ttm: !!(ttm && form === 'NON_FINANCE') };

    // ---- bội số ----
    const mult = price > 0 && shares > 0 ? M.compute({ price: price, shares: shares, period: Object.assign({}, basis, { form: form }) , growthPct: analysis && analysis.growth.eps3y !== null ? analysis.growth.eps3y * 100 : null }) : null;
    out.multiples = mult;
    const isFin = FINANCIAL.indexOf(form) !== -1;
    const methods = [];
    if (mult) {
      const peer = M.peerImplied(mult, basis, c.peerStats, isFin);
      peer.forEach(function (p) { methods.push(Object.assign({ group: 'relative' }, p, { key: 'peer-' + p.key })); });
      const hist = [];
      if (c.ratioSeries) {
        ['pe', 'pb'].forEach(function (k) {
          const band = M.historyBand(c.ratioSeries[k], mult[k]); if (!band) return;
          out['band' + k.toUpperCase()] = band;
          const hi = M.historyImplied(k, band, mult, basis); if (hi) hist.push(hi);
        });
      }
      hist.forEach(function (h) { methods.push(Object.assign({ group: 'relative' }, h, { key: h.key })); });
    }

    // ---- DCF cho doanh nghiệp phi tài chính ----
    if (form === 'NON_FINANCE' && price > 0 && shares > 0) {
      const base = D.buildAssumptions({ periods: periods, ttm: ttm, price: price, shares: shares, beta: beta, rf: rf, erp: erp, marketCap: out.marketCap, sizePremium: num(c.sizePremium) || 0 });
      if (base) {
        const a = Object.assign({}, base, c.dcf || {});
        out.dcfBase = base; out.dcfAssumptions = a;
        const val = D.value(a);
        out.dcf = val;
        if (val.ok) {
          const sc = D.runDefaultScenarios(a); out.scenarios = sc;
          const waccs = D.around(a.wacc, 0.01, 2), gs = D.around(a.gTerminal === undefined ? 0.05 : a.gTerminal, 0.005, 2);
          out.sensitivity = D.sensitivityWaccG(a, waccs, gs);
          out.sensitivity2 = D.sensitivityMarginGrowth(a, D.around(a.marginTarget === null ? a.ebitMargin : a.marginTarget, 0.02, 2), D.around(a.g1, 0.03, 2));
          out.monteCarlo = D.monteCarlo(a, c.mc);
          out.implied = D.implied(a, price); if (out.implied) out.implied.baseWacc = a.wacc;
          const bear = sc.list.find(function (x) { return x.name === 'Bi quan'; }), bull = sc.list.find(function (x) { return x.name === 'Lạc quan'; });
          methods.push({ key: 'dcf', group: 'intrinsic', label: 'DCF dòng tiền doanh nghiệp (FCFF)', low: bear ? bear.perShare : null, base: val.perShare, high: bull ? bull.perShare : null,
            note: 'WACC ' + (a.wacc * 100).toFixed(1) + '%, tăng trưởng giai đoạn đầu ' + (a.g1 * 100).toFixed(1) + '%, tăng trưởng dài hạn ' + (a.gTerminal * 100).toFixed(1) + '%; giá trị cuối kỳ chiếm ' + Math.round(val.tvSharePct) + '% EV. Dải thấp/cao là kịch bản bi quan/lạc quan.' });
        }
        out.waccDetail = base.waccDetail;
      }
    }

    // ---- các phương pháp thu nhập và tài sản ----
    const eps = mult ? mult.eps : null, bvps = mult ? mult.bvps : null, growthEps = analysis ? (analysis.growth.eps3y !== null ? analysis.growth.eps3y : analysis.growth.netIncome3y) : null;
    const g = A.graham(eps, bvps); if (g) methods.push({ key: 'graham', group: 'asset', label: 'Số Graham', base: g.value, note: g.note });
    if (eps > 0 && growthEps !== null) {
      const gg = A.grahamGrowth(eps, growthEps * 100, rf * 100); if (gg) methods.push({ key: 'grahamGrowth', group: 'intrinsic', label: 'Công thức tăng trưởng của Graham', base: gg.value, note: gg.note + ' g dùng ' + gg.growthUsed.toFixed(1) + '%/năm (CAGR EPS 3 năm).' });
      const ly = A.lynch(eps, growthEps * 100, num(metrics.divYield) === null ? 0 : metrics.divYield * 100); if (ly) methods.push({ key: 'lynch', group: 'relative', label: 'PEG của Lynch (P/E = g + cổ tức)', base: ly.value, note: ly.note + ' P/E hợp lý ' + ly.fairPe.toFixed(1) + 'x.' });
    }
    if (form === 'NON_FINANCE' && out.dcfAssumptions) {
      const a = out.dcfAssumptions, ms = periods.slice(-3).map(function (p) { return p.revenue > 0 && p.ebit !== null ? p.ebit / p.revenue : null; }).filter(function (v) { return v !== null; });
      if (ms.length) {
        const nEbit = (ms.reduce(function (s, v) { return s + v; }, 0) / ms.length) * basis.revenue;
        const e = A.epv({ normalizedEbit: nEbit, taxRate: Math.max(a.taxRate, a.taxTarget || 0), wacc: a.wacc, cash: a.cash, associates: a.associates, debt: a.debt, minorities: a.minorityShare !== null && a.minorityShare !== undefined ? 0 : a.minorities, shares: shares });
        if (e) { const hiW = A.epv({ normalizedEbit: nEbit, taxRate: Math.max(a.taxRate, a.taxTarget || 0), wacc: a.wacc - 0.01, cash: a.cash, associates: a.associates, debt: a.debt, minorities: 0, shares: shares }), loW = A.epv({ normalizedEbit: nEbit, taxRate: Math.max(a.taxRate, a.taxTarget || 0), wacc: a.wacc + 0.015, cash: a.cash, associates: a.associates, debt: a.debt, minorities: 0, shares: shares });
          const share = a.minorityShare !== null && a.minorityShare !== undefined ? 1 - a.minorityShare : 1;
          methods.push({ key: 'epv', group: 'asset', label: 'Giá trị sức sinh lời (EPV, không tăng trưởng)', base: e.value * share, low: loW ? loW.value * share : null, high: hiW ? hiW.value * share : null, note: e.note }); }
      }
      const nc = A.ncav(last, shares); if (nc) out.ncav = nc;
      const nv = A.nav(last, shares, c.navAdjustments); if (nv) { out.nav = nv; if (c.navAdjustments && c.navAdjustments.length) methods.push({ key: 'nav', group: 'asset', label: 'Giá trị tài sản ròng điều chỉnh (NAV)', base: nv.value, note: nv.note }); }
      const tq = A.tobinQ(out.marketCap, last); if (tq) out.tobinQ = tq;
    }
    const dps = num(metrics.divYield) > 0 && price > 0 ? metrics.divYield * price : null;
    if (dps > 0) {
      const ke = D.wacc({ rf: rf, beta: beta, erp: erp, equityValue: out.marketCap, debtValue: 0, sizePremium: num(c.sizePremium) || 0 }).ke;
      const gD = clamp(growthEps === null ? 0.04 : growthEps * 0.6, 0.0, Math.min(0.08, ke - 0.03));
      const gd = A.gordon(dps, gD, ke); if (gd) methods.push({ key: 'ddm', group: 'income', label: 'Mô hình cổ tức Gordon', base: gd.value, note: gd.note + ' Cổ tức ' + Math.round(dps).toLocaleString('vi-VN') + ' đ/cp, g ' + (gD * 100).toFixed(1) + '%, Ke ' + (ke * 100).toFixed(1) + '%.' });
    }

    // ---- ngân hàng / chứng khoán / bảo hiểm ----
    if (isFin && price > 0 && shares > 0 && VM) {
      const roes = periods.slice(-3).map(function (p, i, arr) { const pp = i ? arr[i - 1] : (periods.length > 3 ? periods[periods.length - 4] : null); const eq = pp && pp.equity !== null ? (p.equity + pp.equity) / 2 : p.equity; return eq > 0 && p.netIncome !== null ? p.netIncome / eq : null; }).filter(function (v) { return v !== null; });
      const bi = Object.assign({ roe: roes.length ? roes[roes.length - 1] : null, g: 0.08, payout: num(metrics.payoutTtm) === null ? 0.2 : metrics.payoutTtm, years: 5 }, c.bankInputs || {});
      const coe = VM.costOfEquity({ rf: rf, beta: beta, erp: erp, extra: num(c.sizePremium) || 0 }), ke = bi.ke !== undefined ? bi.ke : (coe ? coe.ke : null);
      out.bankInputs = Object.assign({}, bi, { ke: ke });
      if (ke !== null && bvps > 0 && bi.roe !== null) {
        const jp = VM.justifiedPB({ roe: bi.roe, g: bi.g, ke: ke, bvps: bvps }); if (jp && jp.ok && jp.fair) methods.push({ key: 'justified-pb', group: 'intrinsic', label: 'P/B hợp lý = (ROE − g) / (Ke − g)', base: jp.fair, note: 'P/B hợp lý ' + jp.pb.toFixed(2) + 'x với ROE ' + (bi.roe * 100).toFixed(1) + '%, g ' + (bi.g * 100).toFixed(1) + '%, Ke ' + (ke * 100).toFixed(1) + '%.' });
        const ri = VM.residualIncome({ bvps: bvps, roe: bi.roe, ke: ke, g: bi.g, payout: bi.payout, years: bi.years, roeTerminal: bi.roeTerminal }); if (ri && ri.ok) methods.push({ key: 'ri', group: 'intrinsic', label: 'Thu nhập thặng dư (Residual Income)', base: ri.value, note: 'BVPS ' + Math.round(bvps).toLocaleString('vi-VN') + ' đ + hiện giá phần ROE vượt chi phí vốn; ROE trôi dần về Ke trong ' + bi.years + ' năm.' });
        const eps0 = eps > 0 ? eps : null;
        if (eps0) { const fc = VM.fcfe({ eps0: eps0, roe: bi.roe, ke: ke, g1: bi.g, years1: bi.years, fadeYears: 5, gT: Math.min(0.05, rf) }); if (fc && fc.ok) methods.push({ key: 'fcfe', group: 'intrinsic', label: 'FCFE nhiều giai đoạn', base: fc.value, note: 'EPS ' + Math.round(eps0).toLocaleString('vi-VN') + ' đ tăng ' + (bi.g * 100).toFixed(1) + '% trong ' + bi.years + ' năm rồi giảm dần.' }); }
      }
    }

    // ---- kỹ thuật và thị trường ----
    const idx = c.indexCandles && c.indexCandles.c && c.indexCandles.c.length ? { t: c.indexCandles.t, c: c.indexCandles.c } : null;
    const tech = candles ? T.analyze(candles, { index: idx }) : null;
    out.technical = tech;
    const idxTech = c.indexCandles && c.indexCandles.h ? T.analyze(c.indexCandles, {}) : null;
    out.indexTech = idxTech;
    out.market = K.context({ indexTech: idxTech, histRows: c.histRows, bond10yPct: c.bond10yPct, sectorCode: c.sectorCode, sectorName: c.sectorName, sectorStats: c.sectorStats, stock: { relativeStrength: tech && tech.ok ? tech.relativeStrength : null, metrics: metrics } });

    out.methods = methods;
    out.synthesis = Y.synthesize({ price: price, form: form, methods: methods, weightOverrides: c.weights, quality: out.quality, technical: tech, market: out.market, settings: { marginOfSafety: c.marginOfSafety }, implied: out.implied, cagr3: analysis ? analysis.growth.revenue3y : null });
    out.ok = true;
    return out;
  }

  // Kết quả analyze() -> bản ghi lưu vào finance_vb_valuations (và hiển thị lại ở Investment Workbench). null nếu chưa có giá trị hợp lý.
  function toRecord(r, opts) {
    const o = opts || {}, s = r && r.ok ? r.synthesis : null;
    if (!s || !s.ok) return null;
    const asOf = (r.technical && r.technical.ok && r.technical.asOf) || (o.asOf) || new Date().toISOString().slice(0, 10);
    const a = r.dcfAssumptions ? Object.assign({}, r.dcfAssumptions) : null;
    if (a) delete a.waccDetail;
    const q = r.quality || {};
    return {
      symbol: r.symbol, as_of: asOf, price: r.price, form: r.form,
      fair_low: s.fair.low, fair_base: s.fair.base, fair_high: s.fair.high, margin_of_safety: s.marginOfSafety,
      grade: s.grade.label, stance: s.stance.label, confidence: s.confidence.label, confidence_score: s.confidenceScore,
      tech_score: s.technicalScore, tech_rating: r.technical && r.technical.ok ? r.technical.rating.label : null, timing: r.technical && r.technical.ok && r.technical.timing ? r.technical.timing.label : null,
      market_score: s.marketScore, composite: s.composite,
      accumulate_low: s.zones.accumulate.low, accumulate_high: s.zones.accumulate.high, invalidation: s.zones.invalidation.price,
      methods: s.methods.map(function (m) { return { key: m.key, label: m.label, group: m.group, low: m.low, base: m.base, high: m.high, weight: m.weight, defaultWeight: m.defaultWeight, note: m.note }; }),
      assumptions: { dcf: a, bank: r.bankInputs || null, weights: o.weights || null, marginOfSafety: o.marginOfSafety === undefined ? null : o.marginOfSafety },
      summary: {
        stance: s.stance.text, reasons: s.reasons, flags: s.flags.map(function (f) { return f.text; }), mustBeTrue: s.mustBeTrue, confidenceWhy: s.confidenceWhy, zones: { accumulate: s.zones.accumulate.note, fair: s.zones.fair.note, trim: s.zones.trim.note, invalidation: s.zones.invalidation.note, position: s.zones.position },
        quality: { piotroski: q.piotroski ? { score: q.piotroski.score, available: q.piotroski.available } : null, altman: q.altman && q.altman.z2 !== null && q.altman.z2 !== undefined ? { z2: q.altman.z2, zone: q.altman.zone2 && q.altman.zone2.label } : null, beneish: q.beneish && q.beneish.m !== null && q.beneish.m !== undefined ? { m: q.beneish.m, flag: q.beneish.flag && q.beneish.flag.label } : null },
        market: r.market && r.market.regime ? { regime: r.market.regime.label, score: r.market.score } : null,
        technical: r.technical && r.technical.ok ? { score: r.technical.score, rsi: r.technical.latest.rsi, adx: r.technical.latest.adx, supports: r.technical.levels.supports.slice(0, 3).map(function (x) { return x.price; }), resistances: r.technical.levels.resistances.slice(0, 3).map(function (x) { return x.price; }) } : null,
        dcf: r.dcf && r.dcf.ok ? { perShare: r.dcf.perShare, wacc: r.dcf.wacc, tvSharePct: r.dcf.tvSharePct } : null,
      },
      note: o.note || null,
    };
  }

  return { FINANCIAL, analyze, toRecord };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBEngine;
