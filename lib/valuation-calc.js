// Logic thuần của Định Giá / Tổng Hợp Cổ Phiếu (không đụng DOM/Supabase): chỉ số cơ bản, chất lượng & tăng trưởng, TTM theo quý,
// định giá 3 kịch bản (P/E, P/B, DDM) theo mẫu ngành, dải P/E-P/B lịch sử, so sánh cùng ngành, kết luận Rẻ/Hợp lý/Đắt.
// Nạp bằng thẻ <script> thường (global ValuationCalc) và module.exports cho Vitest -- cùng kiểu lib/portfolio-calc.js.
//
// Quy ước dữ liệu (jsonb finance_stock_valuations.data): giữ NGUYÊN các khoá cũ của máy tính định giá (v1 vốn điều lệ, v2 vốn chủ sở hữu,
// v3 LNST, v6 giá, targetPE, targetPB) để api.js/_valuationTarget và Edge Function send-price-alerts không phải đổi; thêm khoá mới (sector,
// unit, shares, revenue, assets, dps, growth*, kịch bản, ke/gDiv, thesis, targetLog) và các khoá TÍNH SẴN dạng snake_case (eps, pe, pb,
// book_value, fair_value...). Hàng cũ (chỉ có snake_case từ thời Google Sheet) vẫn đọc được qua normalize().
const ValuationCalc = (function () {
  const UNITS = { dong: 1, million: 1e6, billion: 1e9 };
  const UNIT_LABELS = { dong: 'đồng', million: 'triệu đồng', billion: 'tỷ đồng' };
  const PAR = 10000; // mệnh giá mặc định của cổ phiếu Việt Nam: số CP = vốn điều lệ / 10.000

  // weights: trọng số khi gộp các phương pháp thành "giá hợp lý" (chỉ tính phương pháp có kết quả, tự chuẩn hoá về 100%).
  // Mẫu "general" 50/50 P/E-P/B trùng đúng công thức cũ (trung bình P/E và P/B) nên giá mục tiêu đã lưu không đổi nghĩa.
  const SECTORS = {
    general:    { label: 'Chung', weights: { pe: 0.5, pb: 0.5 }, hint: 'Doanh nghiệp thông thường: P/E và P/B ngang nhau.' },
    bank:       { label: 'Ngân hàng', weights: { pb: 0.7, pe: 0.3 }, hint: 'Ngân hàng: P/B là chính, đối chiếu với ROE; P/E phụ.' },
    securities: { label: 'Chứng khoán', weights: { pb: 0.6, pe: 0.4 }, hint: 'Chứng khoán: lợi nhuận biến động mạnh theo chu kỳ nên P/B nặng hơn.' },
    realestate: { label: 'Bất động sản', weights: { pb: 0.6, pe: 0.4 }, hint: 'Bất động sản: lợi nhuận ghi nhận theo dự án, giá trị sổ sách là điểm neo.' },
    utility:    { label: 'Tiện ích / cổ tức cao', weights: { pe: 0.4, pb: 0.2, ddm: 0.4 }, hint: 'Doanh nghiệp trả cổ tức đều: thêm mô hình chiết khấu cổ tức (DDM).' },
  };

  const DEFAULT_MULTIPLE_SPREAD = 0.2;  // kịch bản xấu/tốt mặc định = bội số cơ sở x (1 -/+ 20%)
  const DEFAULT_GROWTH_SPREAD = 10;     // ... và tăng trưởng EPS cơ sở -/+ 10 điểm %
  const SHARE_CHANGE_TOLERANCE = 0.03; // số cổ phiếu đổi quá 3% (phát hành, chia thưởng) thì EPS/BVPS hai năm không so sánh trực tiếp được
  const CHEAP_RATIO = 0.8;              // giá <= 80% giá hợp lý (biên an toàn >= 20%) -> Rẻ
  const EXPENSIVE_RATIO = 1.1;          // giá > 110% giá hợp lý -> Đắt

  // Số hoặc null (ô trống / không phải số -> null; 0 là số hợp lệ).
  function opt(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  function num(v) { const n = opt(v); return n === null ? 0 : n; }
  function first() {
    for (let i = 0; i < arguments.length; i++) { const n = opt(arguments[i]); if (n !== null) return n; }
    return null;
  }
  function round(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return null;
    const f = Math.pow(10, digits === undefined ? 2 : digits);
    return Math.round(v * f) / f;
  }

  // Đưa mọi hình dạng dữ liệu (hàng mới v1/v2/..., hàng cũ snake_case) về 1 dạng chuẩn. Không tính toán gì ở đây.
  function normalize(data) {
    const d = data || {};
    const targetPE = first(d.targetPE, d.target_pe);
    const targetPB = first(d.targetPB, d.target_pb);
    const baseGrowth = first(d.growthBase, d.growth);
    const sector = SECTORS[d.sector] ? d.sector : 'general';
    const unit = UNITS[d.unit] ? d.unit : 'billion';
    const scen = (key, pe, pb, growth) => ({ key, pe, pb, growth });
    return {
      symbol: d.symbol ? String(d.symbol).toUpperCase() : '',
      year: opt(d.year),
      sector, unit,
      charter: first(d.v1, d.charter_capital),
      equity: first(d.v2, d.equity),
      lnst: first(d.v3, d.lnst),
      price: first(d.v6, d.price),
      shares: first(d.shares),
      revenue: first(d.revenue),
      assets: first(d.assets),
      dps: first(d.dps),
      ke: first(d.ke),
      gDiv: first(d.gDiv),
      scenarios: {
        base: scen('base', targetPE, targetPB, baseGrowth),
        bear: scen('bear', first(d.targetPEBear), first(d.targetPBBear), first(d.growthBear)),
        bull: scen('bull', first(d.targetPEBull), first(d.targetPBBull), first(d.growthBull)),
      },
      thesis: d.thesis ? String(d.thesis) : '',
      targetLog: Array.isArray(d.targetLog) ? d.targetLog.slice() : [],
      meta: { financialsSource: d.financialsSource || null, financialsAt: d.financialsAt || null, carriedFrom: opt(d.carriedFrom) },
      legacy: d.v1 === undefined && d.charter_capital !== undefined,
    };
  }

  // Bội số / tăng trưởng của kịch bản xấu-tốt: người dùng nhập thì dùng, để trống thì suy ra từ cơ sở và đánh dấu auto.
  function resolveScenarios(n) {
    const base = n.scenarios.base;
    const derive = (sc, side) => {
      const sign = side === 'bear' ? -1 : 1;
      const pe = sc.pe !== null ? sc.pe : (base.pe > 0 ? base.pe * (1 + sign * DEFAULT_MULTIPLE_SPREAD) : null);
      const pb = sc.pb !== null ? sc.pb : (base.pb > 0 ? base.pb * (1 + sign * DEFAULT_MULTIPLE_SPREAD) : null);
      const growth = sc.growth !== null ? sc.growth : (base.growth !== null ? base.growth + sign * DEFAULT_GROWTH_SPREAD : null);
      return { key: sc.key, pe, pb, growth, auto: { pe: sc.pe === null && pe !== null, pb: sc.pb === null && pb !== null, growth: sc.growth === null && growth !== null } };
    };
    return {
      bear: derive(n.scenarios.bear, 'bear'),
      base: { key: 'base', pe: base.pe, pb: base.pb, growth: base.growth, auto: { pe: false, pb: false, growth: false } },
      bull: derive(n.scenarios.bull, 'bull'),
    };
  }

  // EPS / BVPS / doanh thu mỗi cổ phiếu. Có số cổ phiếu thực -> dùng (cần đơn vị để đổi ra đồng); không thì suy từ vốn điều lệ (mệnh giá 10.000).
  function perShare(n) {
    const k = UNITS[n.unit] || UNITS.million;
    const lnst = num(n.lnst), equity = num(n.equity);
    if (n.shares > 0) {
      return { eps: lnst * k / n.shares, bvps: equity * k / n.shares, rps: n.revenue !== null ? n.revenue * k / n.shares : null, basis: 'shares', shares: n.shares };
    }
    if (n.charter > 0) {
      return { eps: lnst / n.charter * PAR, bvps: equity / n.charter * PAR, rps: n.revenue !== null ? n.revenue / n.charter * PAR : null, basis: 'charter', shares: n.charter * k / PAR };
    }
    return null;
  }

  // Quý liên tiếp gần nhất -> LNST 4 quý (TTM). quarters: [{year, quarter, lnst, revenue}]. Cần ĐỦ 4 quý liền nhau, nếu không trả null.
  function ttmFrom(quarters, n) {
    const rows = (quarters || [])
      .map(q => ({ year: num(q.year), quarter: num(q.quarter), lnst: opt(q.lnst), revenue: opt(q.revenue) }))
      .filter(q => q.year > 0 && q.quarter >= 1 && q.quarter <= 4 && q.lnst !== null);
    const seen = new Set();
    const uniq = rows.filter(q => { const key = q.year * 4 + q.quarter; if (seen.has(key)) return false; seen.add(key); return true; });
    uniq.sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter));
    if (uniq.length < 4) return null;
    const last4 = uniq.slice(0, 4);
    for (let i = 1; i < 4; i++) if ((last4[i - 1].year * 4 + last4[i - 1].quarter) - (last4[i].year * 4 + last4[i].quarter) !== 1) return null;
    const lnst = last4.reduce((s, q) => s + q.lnst, 0);
    const revenue = last4.every(q => q.revenue !== null) ? last4.reduce((s, q) => s + q.revenue, 0) : null;
    const ps = perShare(Object.assign({}, n, { lnst, revenue: revenue !== null ? revenue : n.revenue }));
    const eps = ps ? ps.eps : null;
    return {
      lnst, revenue, eps,
      pe: eps > 0 && n.price > 0 ? n.price / eps : null,
      from: `Q${last4[3].quarter}/${last4[3].year}`, to: `Q${last4[0].quarter}/${last4[0].year}`,
    };
  }

  // Chỉ số cơ bản + chất lượng + tăng trưởng. ctx: { prev: dữ liệu năm trước (đã normalize) hoặc null, quarters: [...] }
  function metrics(n, ctx) {
    const c = ctx || {};
    const prev = c.prev || null;
    const ps = perShare(n);
    const out = {
      eps: ps ? ps.eps : null, bvps: ps ? ps.bvps : null, rps: ps ? ps.rps : null, basis: ps ? ps.basis : null, shares: ps ? ps.shares : null,
      pe: null, pb: null, ps: null, roe: null, roeBasis: null, roa: null, netMargin: null, equityMultiplier: null,
      lnstGrowth: null, epsGrowth: null, bvpsGrowth: null, peg: null, dps: n.dps, divYield: null, payout: null,
      lossMaking: !!ps && ps.eps <= 0, ttm: null, shareChange: null,
    };
    if (!ps) return out;
    if (n.price > 0 && ps.eps > 0) out.pe = n.price / ps.eps;
    if (n.price > 0 && ps.bvps > 0) out.pb = n.price / ps.bvps;
    if (n.price > 0 && ps.rps > 0) out.ps = n.price / ps.rps;

    const eq = num(n.equity);
    if (eq > 0 && n.lnst !== null) {
      const prevEq = prev ? num(prev.equity) : 0;
      if (prevEq > 0) { out.roe = n.lnst / ((eq + prevEq) / 2) * 100; out.roeBasis = 'avg'; }
      else { out.roe = n.lnst / eq * 100; out.roeBasis = 'end'; }
    }
    if (n.assets > 0 && n.lnst !== null) {
      const prevAs = prev ? num(prev.assets) : 0;
      out.roa = prevAs > 0 ? n.lnst / ((n.assets + prevAs) / 2) * 100 : n.lnst / n.assets * 100;
    }
    if (n.revenue > 0 && n.lnst !== null) out.netMargin = n.lnst / n.revenue * 100;
    if (n.assets > 0 && eq > 0) out.equityMultiplier = n.assets / eq;

    if (prev) {
      const prevPs = perShare(prev);
      if (num(prev.lnst) > 0 && n.lnst !== null) out.lnstGrowth = (n.lnst - prev.lnst) / prev.lnst * 100;
      out.shareChange = prevPs && prevPs.shares > 0 && ps.shares > 0 ? Math.abs(ps.shares / prevPs.shares - 1) : 0;
      // Cổ phiếu thưởng/phát hành thêm làm EPS, BVPS năm trước và năm sau khác cơ sở -> không so sánh (tránh "tăng trưởng âm" giả)
      if (out.shareChange <= SHARE_CHANGE_TOLERANCE) {
        if (prevPs && prevPs.eps > 0) out.epsGrowth = (ps.eps - prevPs.eps) / prevPs.eps * 100;
        if (prevPs && prevPs.bvps > 0) out.bvpsGrowth = (ps.bvps - prevPs.bvps) / prevPs.bvps * 100;
      }
    }
    if (out.pe > 0 && out.epsGrowth > 0) out.peg = out.pe / out.epsGrowth;
    if (n.dps !== null && n.dps >= 0) {
      if (n.price > 0) out.divYield = n.dps / n.price * 100;
      if (ps.eps > 0) out.payout = n.dps / ps.eps * 100;
    }
    out.ttm = ttmFrom(c.quarters, n);
    return out;
  }

  // Giá trị 1 phương pháp tại 1 kịch bản. growth === null -> định giá trên EPS/BVPS hiện tại (đúng công thức cũ);
  // có growth -> EPS dự phóng = EPS x (1 + g), BVPS dự phóng = BVPS + EPS dự phóng - cổ tức/CP (lợi nhuận giữ lại trong 1 năm).
  function methodValue(key, n, m, sc) {
    if (key === 'pe') {
      if (!(m.eps > 0) || !(sc.pe > 0)) return null;
      const epsF = sc.growth === null ? m.eps : m.eps * (1 + sc.growth / 100);
      return epsF > 0 ? epsF * sc.pe : null;
    }
    if (key === 'pb') {
      if (!(m.bvps > 0) || !(sc.pb > 0)) return null;
      if (sc.growth === null) return m.bvps * sc.pb;
      const epsF = m.eps * (1 + sc.growth / 100);
      const bvpsF = m.bvps + epsF - (n.dps > 0 ? n.dps : 0);
      return bvpsF > 0 ? bvpsF * sc.pb : null;
    }
    return null;
  }

  // Gordon: giá trị = DPS x (1 + g) / (ke - g). Bear/bull = g -/+ 2 điểm (bull bị chặn để ke - g >= 0,5 điểm).
  function ddmValues(n) {
    if (!(n.dps > 0) || n.ke === null || n.gDiv === null || !(n.ke > n.gDiv) || n.gDiv < -5) return null;
    const val = (g) => (n.ke - g) > 0 ? n.dps * (1 + g / 100) / ((n.ke - g) / 100) : null;
    const base = val(n.gDiv);
    const bear = val(n.gDiv - 2);
    const bull = val(Math.min(n.gDiv + 2, n.ke - 0.5));
    return base > 0 ? { bear: bear > 0 ? bear : base, base, bull: bull > 0 ? bull : base } : null;
  }

  // Tất cả phương pháp + giá hợp lý (bình quân gia quyền các phương pháp có kết quả).
  function valuations(n, m) {
    const sc = resolveScenarios(n);
    const weights = (SECTORS[n.sector] || SECTORS.general).weights;
    const methods = [];
    const addMethod = (key, label, bear, base, bull, note) => {
      if (!(base > 0)) return;
      methods.push({ key, label, bear: bear > 0 ? bear : base, base, bull: bull > 0 ? bull : base, weight: weights[key] || 0, note: note || '' });
    };
    const forward = sc.base.growth !== null;
    addMethod('pe', 'P/E', methodValue('pe', n, m, sc.bear), methodValue('pe', n, m, sc.base), methodValue('pe', n, m, sc.bull), forward ? 'EPS dự phóng' : 'EPS hiện tại');
    addMethod('pb', 'P/B', methodValue('pb', n, m, sc.bear), methodValue('pb', n, m, sc.base), methodValue('pb', n, m, sc.bull), forward ? 'BVPS dự phóng' : 'BVPS hiện tại');
    const ddm = ddmValues(n);
    if (ddm) addMethod('ddm', 'DDM (cổ tức)', ddm.bear, ddm.base, ddm.bull, 'ke ' + n.ke + '%, g ' + n.gDiv + '%');

    // Mẫu ngành không dùng phương pháp nào có kết quả (VD ngành "Chung" nhưng chỉ nhập P/B) -> chia đều các phương pháp còn lại.
    let total = methods.reduce((s, x) => s + x.weight, 0);
    if (methods.length && !(total > 0)) { methods.forEach(x => { x.weight = 1; }); total = methods.length; }
    methods.forEach(x => { x.share = total > 0 ? x.weight / total : 0; });
    const mix = (field) => methods.length ? methods.reduce((s, x) => s + x[field] * x.share, 0) : null;
    return { methods, fair: mix('base'), fairBear: mix('bear'), fairBull: mix('bull'), scenarios: sc };
  }

  function verdict(price, fair, fairBear, fairBull) {
    if (!(price > 0) || !(fair > 0)) return { key: 'none', label: 'Chưa đủ dữ liệu', ratio: null, upsidePct: null, marginOfSafetyPct: null, zone: null };
    const ratio = price / fair;
    const key = ratio <= CHEAP_RATIO ? 'cheap' : (ratio <= EXPENSIVE_RATIO ? 'fair' : 'expensive');
    const zone = fairBear > 0 && price < fairBear ? 'below-bear' : (fairBull > 0 && price > fairBull ? 'above-bull' : 'in-range');
    return {
      key, label: key === 'cheap' ? 'Rẻ' : (key === 'fair' ? 'Hợp lý' : 'Đắt'), ratio, zone,
      upsidePct: (fair - price) / price * 100, marginOfSafetyPct: (fair - price) / fair * 100,
    };
  }

  // ---- Lịch sử: P/E, P/B cuối mỗi năm tính lại bằng giá đóng cửa thật (nhất quán, không phụ thuộc giá lúc nhập) ----
  function priceAtOrBefore(series, date) {
    if (!series || !series.length) return null;
    let lo = 0, hi = series.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid][0] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? num(series[ans][1]) : null;
  }

  function stats(values) {
    const v = values.filter(x => isFinite(x));
    if (!v.length) return null;
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) * (x - mean), 0) / v.length);
    return { n: v.length, mean, sd, min: Math.min.apply(null, v), max: Math.max.apply(null, v) };
  }

  // rows: [{year, data}] các năm đã lưu của 1 mã (bất kỳ thứ tự). series: [[YYYY-MM-DD, giá]] tăng dần.
  // Trả về chuỗi theo năm + dải thống kê. Cần >= 3 năm có giá và EPS/BVPS dương mới coi là "ok".
  function historicalMultiples(rows, series) {
    const sorted = (rows || []).slice().sort((a, b) => a.year - b.year);
    const byYear = [];
    sorted.forEach((r, i) => {
      const n = normalize(Object.assign({}, r.data, { year: r.year }));
      const ps = perShare(n);
      if (!ps) return;
      const date = r.year + '-12-31';
      const px = priceAtOrBefore(series, date);
      byYear.push({
        year: r.year, price: px, eps: ps.eps, bvps: ps.bvps,
        pe: px > 0 && ps.eps > 0 ? px / ps.eps : null,
        pb: px > 0 && ps.bvps > 0 ? px / ps.bvps : null,
      });
    });
    const peStats = stats(byYear.map(x => x.pe).filter(x => x !== null));
    const pbStats = stats(byYear.map(x => x.pb).filter(x => x !== null));
    return { byYear, pe: peStats, pb: pbStats, ok: !!(peStats && peStats.n >= 3) || !!(pbStats && pbStats.n >= 3) };
  }

  // Vị trí của bội số hiện tại trong lịch sử: phân vị (0-100, % số năm có bội số <= hiện tại) + độ lệch chuẩn so với trung bình.
  function positionInBand(st, current) {
    if (!st || st.n < 3 || !(current > 0)) return null;
    return { percentile: null, z: st.sd > 0 ? (current - st.mean) / st.sd : 0, mean: st.mean, sd: st.sd, n: st.n };
  }
  function percentileOf(values, current) {
    const v = values.filter(x => x !== null && isFinite(x));
    if (v.length < 3 || !(current > 0)) return null;
    return v.filter(x => x <= current).length / v.length * 100;
  }
  function bandPosition(hist, kind, current) {
    const st = hist && hist[kind];
    const pos = positionInBand(st, current);
    if (!pos) return null;
    pos.percentile = percentileOf(hist.byYear.map(x => x[kind]), current);
    pos.min = st.min; pos.max = st.max;
    pos.label = pos.z <= -0.5 ? 'thấp hơn lịch sử' : (pos.z >= 0.5 ? 'cao hơn lịch sử' : 'quanh mức lịch sử');
    return pos;
  }

  // Giá ngụ ý từ dải bội số lịch sử (trung bình +/- 1 độ lệch chuẩn) nhân EPS/BVPS hiện tại.
  function impliedFromBand(st, perShareValue) {
    if (!st || st.n < 3 || !(perShareValue > 0)) return null;
    const lo = Math.max(0, st.mean - st.sd), hi = st.mean + st.sd;
    if (!(hi > 0) || !(lo > 0)) return null;
    return { low: lo * perShareValue, base: st.mean * perShareValue, high: hi * perShareValue };
  }

  // Dữ liệu cho biểu đồ "football field": mỗi dòng 1 khoảng giá, thêm vạch giá hiện tại. Toạ độ theo % chiều ngang.
  function football(rows, price) {
    const valid = (rows || []).filter(r => r && r.low > 0 && r.high > 0 && r.low <= r.high);
    if (!valid.length) return null;
    const lows = valid.map(r => r.low).concat(price > 0 ? [price] : []);
    const highs = valid.map(r => r.high).concat(price > 0 ? [price] : []);
    const min = Math.min.apply(null, lows) * 0.92;
    const max = Math.max.apply(null, highs) * 1.06;
    const span = max - min || 1;
    const pct = (x) => Math.max(0, Math.min(100, (x - min) / span * 100));
    return {
      min, max, pricePct: price > 0 ? pct(price) : null,
      rows: valid.map(r => ({
        label: r.label, kind: r.kind || 'method', note: r.note || '', low: r.low, base: r.base > 0 ? r.base : null, high: r.high,
        leftPct: pct(r.low), widthPct: Math.max(1.2, pct(r.high) - pct(r.low)), basePct: r.base > 0 ? pct(r.base) : null,
      })),
    };
  }

  function median(values) {
    const v = values.filter(x => x !== null && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  // items: [{symbol, sector, pe, pb, roe, divYield}] (mỗi mã 1 dòng, năm mới nhất). Trả null nếu < 2 mã cùng ngành khác mã đang xem.
  function peerStats(items, sector, excludeSymbol) {
    const peers = (items || []).filter(x => x.sector === sector && x.symbol !== excludeSymbol);
    if (peers.length < 2) return null;
    return { n: peers.length, symbols: peers.map(x => x.symbol), pe: median(peers.map(x => x.pe)), pb: median(peers.map(x => x.pb)), roe: median(peers.map(x => x.roe)), divYield: median(peers.map(x => x.divYield)) };
  }

  // Nhật ký đổi mục tiêu: chỉ thêm dòng khi giá hợp lý đổi > 0,5% so với dòng gần nhất (tránh ghi trùng mỗi lần bấm Lưu). Giữ 20 dòng.
  function appendTargetLog(log, entry) {
    const list = Array.isArray(log) ? log.slice() : [];
    const last = list.length ? list[list.length - 1] : null;
    const fair = num(entry && entry.fair);
    if (!(fair > 0)) return list;
    if (last && num(last.fair) > 0 && Math.abs(fair - last.fair) / last.fair <= 0.005) return list;
    list.push({
      at: entry.at, by: entry.by || null, fair: Math.round(fair), price: entry.price > 0 ? Math.round(entry.price) : null,
      pe: entry.pe !== undefined ? entry.pe : null, pb: entry.pb !== undefined ? entry.pb : null,
    });
    return list.slice(-20);
  }

  // Phân tích đầy đủ 1 hồ sơ định giá: chuẩn hoá -> chỉ số -> định giá -> kết luận. Dùng chung cho trang Định Giá, Tổng Hợp và bảng so sánh.
  function analyze(data, ctx) {
    const n = normalize(data);
    const m = metrics(n, ctx);
    const v = valuations(n, m);
    const price = ctx && opt(ctx.price) !== null && opt(ctx.price) > 0 ? opt(ctx.price) : n.price;
    const nPriced = price !== n.price ? Object.assign({}, n, { price }) : n;
    const mPriced = price !== n.price ? metrics(nPriced, ctx) : m;
    const vPriced = price !== n.price ? valuations(nPriced, mPriced) : v;
    return { n: nPriced, m: mPriced, v: vPriced, price, verdict: verdict(price, vPriced.fair, vPriced.fairBear, vPriced.fairBull) };
  }

  // Dựng bản ghi lưu DB từ ô nhập của form (inputs: khoá giống normalize). Giữ khoá cũ + khoá mới + khoá tính sẵn snake_case.
  function buildRecord(inputs, ctx) {
    const a = analyze(inputs, ctx);
    const n = a.n, m = a.m, v = a.v;
    const rec = {};
    const put = (k, val) => { if (val !== null && val !== undefined && val !== '' && !(typeof val === 'number' && !isFinite(val))) rec[k] = val; };
    put('symbol', n.symbol); put('year', n.year);
    put('v1', n.charter); put('v2', n.equity); put('v3', n.lnst); put('v6', n.price);
    put('targetPE', n.scenarios.base.pe); put('targetPB', n.scenarios.base.pb);
    put('sector', n.sector); put('unit', n.unit);
    put('shares', n.shares); put('revenue', n.revenue); put('assets', n.assets); put('dps', n.dps);
    put('ke', n.ke); put('gDiv', n.gDiv);
    put('growthBase', n.scenarios.base.growth); put('growthBear', n.scenarios.bear.growth); put('growthBull', n.scenarios.bull.growth);
    put('targetPEBear', n.scenarios.bear.pe); put('targetPEBull', n.scenarios.bull.pe);
    put('targetPBBear', n.scenarios.bear.pb); put('targetPBBull', n.scenarios.bull.pb);
    if (n.thesis) rec.thesis = n.thesis.slice(0, 2000);
    put('financialsSource', n.meta.financialsSource); put('financialsAt', n.meta.financialsAt); put('carriedFrom', n.meta.carriedFrom);
    if (n.targetLog.length) rec.targetLog = n.targetLog;
    // khoá tính sẵn (tương thích hàng cũ / các nơi chỉ đọc 1 giá trị)
    put('charter_capital', n.charter); put('equity', n.equity); put('lnst', n.lnst); put('price', n.price);
    put('book_value', round(m.bvps)); put('eps', round(m.eps)); put('pe', round(m.pe)); put('pb', round(m.pb));
    put('target_pe', n.scenarios.base.pe); put('target_pb', n.scenarios.base.pb);
    const pe = v.methods.find(x => x.key === 'pe'), pb = v.methods.find(x => x.key === 'pb');
    put('price_per_pe', pe ? round(pe.base) : null); put('price_per_pb', pb ? round(pb.base) : null);
    put('fair_value', round(v.fair, 0)); put('fair_bear', round(v.fairBear, 0)); put('fair_bull', round(v.fairBull, 0));
    if (a.verdict.key !== 'none') rec.verdict = a.verdict.key;
    return rec;
  }

  // ---- Đồng bộ số liệu tài chính từ nguồn thị trường ----
  // Loại doanh nghiệp -> mẫu ngành mặc định cho hồ sơ MỚI (bảo hiểm và doanh nghiệp thường dùng mẫu "Chung").
  const FORM_SECTOR = { BANK: 'bank', SECURITIES: 'securities' };
  // Các khoá GIẢ ĐỊNH của người dùng — hồ sơ năm mới nhất vừa phát sinh được kế thừa từ năm gần nhất, không phải nhập lại.
  const ASSUMPTION_KEYS = ['targetPE', 'targetPB', 'growthBase', 'growthBear', 'growthBull', 'targetPEBear', 'targetPEBull',
    'targetPBBear', 'targetPBBull', 'ke', 'gDiv'];

  // Làm tròn số quy đổi theo đơn vị (tỷ đồng: 2 số lẻ = 10 triệu đồng; triệu đồng: 1 số lẻ; đồng: nguyên) cho ô nhập gọn mà không ảnh hưởng EPS.
  function roundForUnit(vnd, unit) {
    const k = UNITS[unit] || UNITS.billion;
    return round(vnd / k, unit === 'billion' ? 2 : (unit === 'million' ? 1 : 0));
  }
  function scaled(v, unit) { return v === null || v === undefined || !isFinite(v) ? null : roundForUnit(v, unit); }

  // Dòng dữ liệu quý để lưu bảng finance_stock_quarters, quy đổi về đơn vị của hồ sơ (cùng đơn vị với số liệu năm để TTM đúng).
  function quarterRowsFrom(fin, symbol, unit, maxQuarters) {
    return ((fin && fin.quarters) || []).slice(0, maxQuarters || 12).map(q => ({
      symbol, year: q.year, quarter: q.quarter, lnst: scaled(q.lnst, unit), revenue: scaled(q.revenue, unit),
    })).filter(q => q.lnst !== null);
  }

  // Ghép số liệu nguồn với hồ sơ đã lưu -> danh sách bản ghi sẵn sàng lưu (đã tính lại fair_value, P/E... bằng buildRecord).
  // - Hồ sơ có sẵn: chỉ ghi đè số liệu tài chính (v1 vốn điều lệ, v2 vốn chủ cổ đông công ty mẹ, v3 LNST công ty mẹ, doanh thu, tổng tài sản,
  //   cổ tức khi nguồn có); giả định, luận điểm, giá, ngành... GIỮ NGUYÊN.
  // - Năm MỚI hơn mọi năm đã lưu (vừa có báo cáo): kế thừa giả định từ năm gần nhất, đánh dấu carriedFrom để người dùng soát lại.
  // - Năm lịch sử chưa có: tạo hồ sơ chỉ có số liệu (đủ cho tăng trưởng và dải P/E lịch sử), không có giả định.
  function syncRecords(existingRows, fin, opts) {
    const o = opts || {};
    const symbol = String(o.symbol || '').toUpperCase();
    const at = o.at || new Date().toISOString();
    const rows = (existingRows || []).map(r => ({ year: Number(r.year), data: r.data || {} })).sort((a, b) => a.year - b.year);
    const byYear = new Map(rows.map(r => [r.year, r.data]));
    const latest = rows.length ? rows[rows.length - 1] : null;
    const latestN = latest ? normalize(latest.data) : null;
    const defaultUnit = latestN ? latestN.unit : 'billion';
    const baseSector = FORM_SECTOR[fin && fin.form] || (latestN ? latestN.sector : 'general');
    const annual = ((fin && fin.annual) || []).filter(a => a.year >= 1990).slice().sort((a, b) => b.year - a.year).slice(0, o.maxYears || 6).sort((a, b) => a.year - b.year);
    const newestYear = annual.length ? annual[annual.length - 1].year : null;
    const carry = latest && newestYear !== null && newestYear > latest.year ? latest : null;
    const dividends = (fin && fin.dividends) || {};

    const records = [];
    let prevN = null;
    annual.forEach(a => {
      const existing = byYear.get(a.year);
      const unit = existing ? normalize(existing).unit : defaultUnit;
      let data;
      if (existing) data = Object.assign({}, existing);
      else {
        data = { sector: baseSector };
        if (carry && a.year === newestYear) {
          ASSUMPTION_KEYS.forEach(key => { if (carry.data[key] !== undefined && carry.data[key] !== null && carry.data[key] !== '') data[key] = carry.data[key]; });
          if (!ASSUMPTION_KEYS.some(key => data[key] !== undefined)) { /* năm trước chưa có giả định nào -> không có gì để kế thừa */ } else data.carriedFrom = carry.year;
        }
        if (o.livePrice > 0 && a.year === newestYear) data.v6 = o.livePrice;
      }
      Object.assign(data, { symbol, year: a.year, unit });
      const set = (key, val) => { if (val !== null && val !== undefined) data[key] = val; };
      set('v1', scaled(a.charter, unit));
      set('v2', scaled(a.equityParent !== null && a.equityParent !== undefined ? a.equityParent : a.equity, unit));
      set('v3', scaled(a.lnst, unit));
      set('revenue', scaled(a.revenue, unit));
      set('assets', scaled(a.assets, unit));
      if (dividends[String(a.year)] > 0) data.dps = round(dividends[String(a.year)], 2);
      data.financialsSource = 'vndirect';
      data.financialsAt = at;
      if (!prevN) { const pr = byYear.get(a.year - 1); prevN = pr ? normalize(Object.assign({}, pr, { year: a.year - 1 })) : null; }
      const record = buildRecord(data, { prev: prevN && prevN.year === a.year - 1 ? prevN : null });
      records.push({ symbol, year: a.year, record, isNew: !existing, carried: record.carriedFrom !== undefined && !existing });
      prevN = normalize(record);
    });
    return {
      records, unit: defaultUnit,
      quarters: quarterRowsFrom(fin, symbol, defaultUnit, o.maxQuarters),
      summary: { created: records.filter(r => r.isNew).length, updated: records.filter(r => !r.isNew).length, carried: records.some(r => r.carried), years: records.map(r => r.year) },
    };
  }

  return {
    SHARE_CHANGE_TOLERANCE, roundForUnit, FORM_SECTOR, ASSUMPTION_KEYS, syncRecords, quarterRowsFrom,
    UNITS, UNIT_LABELS, SECTORS, PAR, CHEAP_RATIO, EXPENSIVE_RATIO, DEFAULT_MULTIPLE_SPREAD, DEFAULT_GROWTH_SPREAD,
    opt, normalize, resolveScenarios, perShare, metrics, ttmFrom, methodValue, ddmValues, valuations, verdict,
    priceAtOrBefore, stats, historicalMultiples, bandPosition, impliedFromBand, football, median, peerStats,
    appendTargetLog, analyze, buildRecord,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ValuationCalc;
