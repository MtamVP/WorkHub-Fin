// Logic thuần: hiệu quả đầu tư so với chuẩn so sánh ở mức chuyên môn (TWR, alpha/beta, tracking error, information ratio, Sharpe/Sortino, up/down capture,
// tỷ lệ tháng thắng chuẩn, sụt giảm). KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global PerfCalc) và module.exports cho Vitest.
//
// Phương pháp:
//  - Lợi suất mỗi kỳ giữa hai lần chụp NAV liên tiếp theo Modified Dietz: r = (NAV_cuối − NAV_đầu − F) / (NAV_đầu + F/2), F = vốn nạp ròng trong kỳ
//    (nạp − rút, KHÔNG gồm cổ tức). Nhờ vậy ngày có nạp/rút vốn vẫn dùng được thay vì bị bỏ như cách cũ. Nối các kỳ theo lãi kép = TWR.
//  - Chuẩn so sánh lấy theo đúng các ngày chụp NAV (giá đóng cửa tại hoặc ngay trước ngày đó) để hai chuỗi cùng kỳ hạn.
//  - Số kỳ mỗi năm = số kỳ / số năm thực tế của chuỗi (≈252 nếu chụp mọi phiên) -> dùng cho quy năm; chuỗi < MIN_PERIODS kỳ thì chỉ trả số mô tả, không quy năm.
//  - Alpha Jensen = (TB lợi suất vượt lãi phi rủi ro của danh mục − beta × TB lợi suất vượt của chuẩn) × số kỳ/năm. Information ratio = TB(r − rb) × số kỳ/năm / tracking error.
//  - Up/down capture tính trên LỢI SUẤT THÁNG (≥ 6 tháng) -- chuẩn ngành; ít hơn thì tính trên các kỳ.
//  - LÃI PHI RỦI RO THEO NGÀY: truyền rfSeries (lợi suất trái phiếu chính phủ 1 năm, finance_rates) thì mỗi kỳ dùng lãi suất tại ngày đầu kỳ, quy theo số ngày thực của kỳ; ngày trước dữ liệu dùng rf cố định.
//  - LỢI SUẤT GIÁ (loại cổ tức): VN-Index là chỉ số GIÁ, không có cổ tức, còn NAV của danh mục có cổ tức nhận được; so thẳng làm alpha bị thổi phồng đúng bằng phần cổ tức. Truyền dividends
//    ([{date, amount}]) thì có thêm chuỗi lợi suất giá (trừ cổ tức tiền mặt từng kỳ) để so công bằng với chuẩn.
//  - IRR (XIRR, lợi suất có trọng số dòng tiền): khác TWR ở chỗ phản ánh cả THỜI ĐIỂM nạp/rút của chính người đó; cần chuỗi ≥ 180 ngày.
//  - Alpha kèm khoảng tin cậy 95% và số năm dữ liệu cần để alpha có ý nghĩa thống kê (|t| ≥ 2).
// Đây là số đo quá khứ trên ít dữ liệu: chuỗi ngắn thì sai số rất lớn, giao diện phải ghi rõ số kỳ và khoảng thời gian.
const PerfCalc = (function () {
  const MIN_PERIODS = 20;
  const MIN_MONTHS = 6;
  const DEFAULT_RF = 0.045;

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function iso(v) { return String(v || '').slice(0, 10); }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
  function stdev(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }
  function cov(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
    let s = 0;
    for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
    return s / (n - 1);
  }
  function compound(arr) { return arr.reduce(function (p, r) { return p * (1 + r); }, 1) - 1; }

  // Giá chuẩn tại hoặc ngay trước ngày d (series tăng dần) -- tìm nhị phân
  function closeAtOrBefore(series, d) {
    let lo = 0, hi = series.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid][0] <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans === -1 ? null : series[ans][1];
  }

  // Mốc ngày cho các khoảng nhanh
  function rangeFor(key, today) {
    const t = iso(today);
    const y = Number(t.slice(0, 4));
    const back = function (days) { return new Date(new Date(t + 'T00:00:00Z').getTime() - days * 86400000).toISOString().slice(0, 10); };
    switch (key) {
      case '3m': return { from: back(92), to: t };
      case '6m': return { from: back(183), to: t };
      case 'ytd': return { from: (y - 1) + '-12-31', to: t };
      case '1y': return { from: back(365), to: t };
      default: return { from: null, to: t };
    }
  }

  // Các kỳ lợi suất từ lịch sử NAV. navHistory: [{snapshot_date, nav, net_contributed}], bench: [[date, close]] hoặc null.
  function buildPeriods(navHistory, bench, range, dividends) {
    const rows = (navHistory || []).map(function (r) { return { d: iso(r.snapshot_date), nav: num(r.nav), flow: num(r.net_contributed) }; })
      .filter(function (r) { return r.d && r.nav > 0; }).sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
    const from = range && range.from ? range.from : null, to = range && range.to ? range.to : null;
    // Điểm xuất phát: bản ghi gần nhất tại hoặc trước mốc from (để kỳ đầu tiên của khoảng được tính trọn)
    let startIdx = 0;
    if (from) {
      startIdx = -1;
      for (let i = 0; i < rows.length; i++) { if (rows[i].d <= from) startIdx = i; else break; }
      if (startIdx === -1) startIdx = 0;
    }
    const used = rows.slice(startIdx).filter(function (r) { return !to || r.d <= to; });
    const b = (bench || []).map(function (p) { return [iso(p[0]), num(p[1])]; }).filter(function (p) { return p[1] > 0; }).sort(function (x, y) { return x[0] < y[0] ? -1 : 1; });
    const periods = [];
    for (let i = 1; i < used.length; i++) {
      const a = used[i - 1], c = used[i];
      const flow = c.flow - a.flow;
      const denom = a.nav + 0.5 * flow;
      if (!(denom > 0)) continue;
      const r = (c.nav - a.nav - flow) / denom;
      let rb = null;
      if (b.length) {
        const b0 = closeAtOrBefore(b, a.d), b1 = closeAtOrBefore(b, c.d);
        if (b0 > 0 && b1 > 0) rb = b1 / b0 - 1;
      }
      let div = 0;
      (dividends || []).forEach(function (x) { const d = iso(x.date); if (d > a.d && d <= c.d) div += num(x.amount); });
      periods.push({ from: a.d, to: c.d, r: r, rb: rb, flow: flow, nav: c.nav, navStart: a.nav, div: div, rPrice: (c.nav - a.nav - flow - div) / denom });
    }
    return { periods: periods, firstDate: used.length ? used[0].d : null, lastDate: used.length ? used[used.length - 1].d : null, points: used.length };
  }

  // rows: finance_rates [{rate_date, tenor, yield_pct}] -> chuỗi lãi suất NĂM dạng thập phân [[ngày, 0,0369]] của kỳ hạn `tenor` (mặc định 1Y), tăng dần
  function rfFromRates(rows, tenor) {
    const t = tenor || '1Y';
    return (rows || []).filter(function (r) { return r.tenor === t && isFinite(Number(r.yield_pct)); })
      .map(function (r) { return [iso(r.rate_date), Number(r.yield_pct) / 100]; }).sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
  }
  // Lãi suất năm tại hoặc ngay trước ngày d; chưa có dữ liệu thì null
  function rfAt(series, d) { const v = closeAtOrBefore(series || [], d); return v === null || v === undefined ? null : v; }

  // XIRR: flows [{date, amount}] (âm = bỏ tiền vào, dương = nhận về). Trả lãi suất năm (thập phân) hoặc null nếu không có nghiệm.
  function xirr(flows) {
    const f = (flows || []).filter(function (x) { return isFinite(x.amount) && x.amount !== 0; }).map(function (x) { return { t: new Date(iso(x.date) + 'T00:00:00Z').getTime() / 86400000, a: Number(x.amount) }; });
    if (f.length < 2 || !f.some(function (x) { return x.a < 0; }) || !f.some(function (x) { return x.a > 0; })) return null;
    const t0 = Math.min.apply(null, f.map(function (x) { return x.t; }));
    const npv = function (r) { return f.reduce(function (s, x) { return s + x.a / Math.pow(1 + r, (x.t - t0) / 365); }, 0); };
    let lo = -0.9999, hi = 10, flo = npv(lo), fhi = npv(hi);
    if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2, fm = npv(mid);
      if (Math.abs(fm) < 1e-9 || (hi - lo) < 1e-12) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  function monthKey(d) { return d.slice(0, 7); }

  // Gộp theo tháng lịch: lợi suất tháng = nối các kỳ kết thúc trong tháng đó
  function monthly(periods) {
    const map = {}, order = [];
    periods.forEach(function (p) {
      const k = monthKey(p.to);
      if (!map[k]) { map[k] = { month: k, r: [], rb: [], hasBench: true }; order.push(k); }
      map[k].r.push(p.r);
      if (p.rb === null) map[k].hasBench = false; else map[k].rb.push(p.rb);
    });
    return order.map(function (k) {
      const m = map[k];
      const r = compound(m.r), rb = m.hasBench && m.rb.length ? compound(m.rb) : null;
      return { month: k, r: r, rb: rb, excess: rb === null ? null : r - rb };
    });
  }

  function drawdown(returns, dates) {
    let idx = 1, peak = 1, peakDate = dates[0] || null, maxDD = 0, mPeak = null, mTrough = null;
    const series = [];
    for (let i = 0; i < returns.length; i++) {
      idx *= 1 + returns[i];
      if (idx > peak) { peak = idx; peakDate = dates[i]; }
      const dd = idx / peak - 1;
      series.push({ date: dates[i], dd: dd, index: idx });
      if (dd < maxDD) { maxDD = dd; mPeak = peakDate; mTrough = dates[i]; }
    }
    return { maxDD: maxDD, peakDate: mPeak, troughDate: mTrough, current: series.length ? series[series.length - 1].dd : 0, series: series };
  }

  // input: { navHistory, bench, rf (năm, 0.045 = 4,5%; dùng khi không có rfSeries hoặc ngày trước dữ liệu), rfSeries (từ rfFromRates), dividends ([{date, amount}]), range:{from,to} }. Trả { ok, reason, ... }
  function analyze(input) {
    const rf = input.rf === undefined || input.rf === null ? DEFAULT_RF : Number(input.rf);
    const built = buildPeriods(input.navHistory, input.bench, input.range, input.dividends);
    const P = built.periods;
    const out = { ok: false, reason: null, rf: rf, firstDate: built.firstDate, lastDate: built.lastDate, periods: P.length, points: built.points, hasBench: false };
    if (P.length < 2) { out.reason = 'few-points'; return out; }

    const span = daysBetween(P[0].from, P[P.length - 1].to);
    const years = span / 365.25;
    out.days = span;
    const ppy = years > 0 ? P.length / years : null;
    out.periodsPerYear = ppy;
    const r = P.map(function (p) { return p.r; });
    const cum = compound(r);
    out.cumulativePct = cum * 100;
    if (input.dividends && input.dividends.length) {
      const rp = P.map(function (p) { return p.rPrice; });
      out.hasPriceReturn = true;
      out.priceCumulativePct = compound(rp) * 100;
      out.dividendsTotal = P.reduce(function (s, p) { return s + p.div; }, 0);
      out.incomeReturnPct = out.cumulativePct - out.priceCumulativePct;
    }
    // IRR: NAV đầu kỳ là khoản bỏ vào ngày đầu, mỗi kỳ có nạp/rút tính vào giữa kỳ (cùng giả định Modified Dietz), NAV cuối là khoản nhận về ngày cuối
    if (span >= 180) {
      const fl = [{ date: P[0].from, amount: -P[0].navStart }];
      P.forEach(function (p) { if (Math.abs(p.flow) > 0) { const mid = new Date((new Date(p.from + 'T00:00:00Z').getTime() + new Date(p.to + 'T00:00:00Z').getTime()) / 2).toISOString().slice(0, 10); fl.push({ date: mid, amount: -p.flow }); } });
      fl.push({ date: P[P.length - 1].to, amount: P[P.length - 1].nav });
      const irr = xirr(fl);
      out.irrPct = irr === null ? null : irr * 100;
    }
    out.annualizedPct = years >= 1 ? (Math.pow(1 + cum, 1 / years) - 1) * 100 : null;
    const dd = drawdown(r, P.map(function (p) { return p.to; }));
    out.maxDD = dd.maxDD * 100; out.maxDDPeak = dd.peakDate; out.maxDDTrough = dd.troughDate; out.currentDD = dd.current * 100;
    out.ddSeries = dd.series.map(function (x) { return { date: x.date, dd: x.dd * 100, index: x.index * 100 }; });
    out.enough = P.length >= MIN_PERIODS && ppy !== null;
    const withBench = P.filter(function (p) { return p.rb !== null; });
    out.hasBench = withBench.length >= 2;
    out.monthly = monthly(P).map(function (m) { return { month: m.month, r: m.r * 100, rb: m.rb === null ? null : m.rb * 100, excess: m.excess === null ? null : m.excess * 100 }; });

    // Cùng một chuỗi cho mọi chỉ số so sánh: chỉ các kỳ có cả danh mục và chuẩn
    const pr = withBench.map(function (p) { return p.r; }), br = withBench.map(function (p) { return p.rb; });
    if (out.hasBench) {
      out.benchCumulativePct = compound(br) * 100;
      out.excessCumulativePct = out.cumulativePct - out.benchCumulativePct;
      out.benchAnnualizedPct = years >= 1 ? (Math.pow(1 + compound(br), 1 / years) - 1) * 100 : null;
      // Đường tích luỹ gốc 100 (cùng các kỳ có chuẩn) để vẽ so sánh
      let cp = 100, cb = 100;
      out.curve = [{ date: withBench[0].from, p: 100, b: 100 }].concat(withBench.map(function (x) { cp *= 1 + x.r; cb *= 1 + x.rb; return { date: x.to, p: cp, b: cb }; }));
    }
    if (!out.enough) { out.reason = 'short'; out.ok = true; return out; }

    const rfp = Math.pow(1 + rf, 1 / ppy) - 1;    // lãi phi rủi ro mỗi kỳ (khi không có chuỗi theo ngày)
    // Lãi phi rủi ro THEO KỲ: có chuỗi thì dùng lãi suất tại ngày đầu kỳ quy theo số ngày thực của kỳ, ngày chưa có dữ liệu dùng rf cố định
    const series = input.rfSeries && input.rfSeries.length ? input.rfSeries : null;
    let covered = 0;
    const rfpArr = P.map(function (p) {
      if (!series) return rfp;
      const a = rfAt(series, p.from);
      if (a === null) return rfp;
      covered++;
      return Math.pow(1 + a, Math.max(1, daysBetween(p.from, p.to)) / 365.25) - 1;
    });
    out.rfMode = series && covered ? 'series' : 'fixed';
    out.rfSeriesShare = series ? covered / P.length : 0;
    out.rf = out.rfMode === 'series' ? mean(rfpArr) * ppy : rf;                 // lãi phi rủi ro năm hiệu dụng
    const excessAll = r.map(function (x, i) { return x - rfpArr[i]; });
    const vol = stdev(r);
    out.volatilityPct = vol * Math.sqrt(ppy) * 100;
    const evol = stdev(excessAll);
    out.sharpe = evol > 0 ? mean(excessAll) / evol * Math.sqrt(ppy) : null;
    const downside = Math.sqrt(mean(excessAll.map(function (x) { const d = Math.min(0, x); return d * d; })));
    out.sortino = downside > 0 ? mean(excessAll) / downside * Math.sqrt(ppy) : null;
    out.calmar = out.annualizedPct !== null && dd.maxDD < 0 ? out.annualizedPct / Math.abs(dd.maxDD * 100) : null;
    out.bestPeriodPct = Math.max.apply(null, r) * 100; out.worstPeriodPct = Math.min.apply(null, r) * 100;
    out.positivePeriodsPct = r.filter(function (x) { return x > 0; }).length / r.length * 100;

    if (out.hasBench) {
      const bvol = stdev(br), n = pr.length;
      const beta = bvol > 0 ? cov(pr, br) / (bvol * bvol) : null;
      out.beta = beta;
      out.correlation = bvol > 0 && stdev(pr) > 0 ? cov(pr, br) / (bvol * stdev(pr)) : null;
      out.rSquared = out.correlation === null ? null : out.correlation * out.correlation;
      const rfWB = []; P.forEach(function (p, i) { if (p.rb !== null) rfWB.push(rfpArr[i]); });
      const exP = pr.map(function (x, i) { return x - rfWB[i]; }), exB = br.map(function (x, i) { return x - rfWB[i]; });
      const alphaPer = beta === null ? null : mean(exP) - beta * mean(exB);
      out.alphaPct = alphaPer === null ? null : alphaPer * ppy * 100;
      const active = pr.map(function (x, i) { return x - br[i]; });
      const te = stdev(active) * Math.sqrt(ppy);
      out.trackingErrorPct = te * 100;
      out.informationRatio = te > 1e-7 ? mean(active) * ppy / te : null;
      out.benchVolatilityPct = bvol * Math.sqrt(ppy) * 100;
      // Alpha có đáng tin không: t-stat, khoảng tin cậy 95% và số năm dữ liệu cần để |t| >= 2 (chuỗi ngắn gần như luôn không đạt)
      if (beta !== null && n > 2) {
        const resid = exP.map(function (x, i) { return x - beta * exB[i] - alphaPer; });
        const sd = stdev(resid), se = sd / Math.sqrt(n);
        out.alphaTStat = se > 0 ? alphaPer / se : null;
        out.alphaCIPct = se > 0 ? [(alphaPer - 1.96 * se) * ppy * 100, (alphaPer + 1.96 * se) * ppy * 100] : null;
        out.alphaYearsNeeded = Math.abs(alphaPer) > 1e-12 && sd > 0 ? Math.pow(2 * sd / Math.abs(alphaPer), 2) / ppy : null;
      }
      // So sánh công bằng với chỉ số GIÁ: lợi suất giá (đã trừ cổ tức tiền mặt) của cùng các kỳ có chuẩn
      if (out.hasPriceReturn) {
        const prp = P.filter(function (p) { return p.rb !== null; }).map(function (p) { return p.rPrice; });
        out.priceExcessCumulativePct = compound(prp) * 100 - out.benchCumulativePct;
        const bp = bvol > 0 ? cov(prp, br) / (bvol * bvol) : null;
        if (bp !== null) out.priceAlphaPct = (mean(prp.map(function (x, i) { return x - rfWB[i]; })) - bp * mean(exB)) * ppy * 100;
      }
      // Up/down capture
      const mo = out.monthly.filter(function (m) { return m.rb !== null; });
      const useMonthly = mo.length >= MIN_MONTHS;
      const A = useMonthly ? mo.map(function (m) { return m.r / 100; }) : pr;
      const B = useMonthly ? mo.map(function (m) { return m.rb / 100; }) : br;
      const up = [], down = [];
      B.forEach(function (x, i) { if (x > 0) up.push(i); else if (x < 0) down.push(i); });
      out.captureBasis = useMonthly ? 'month' : 'period';
      out.upCapturePct = up.length ? mean(up.map(function (i) { return A[i]; })) / mean(up.map(function (i) { return B[i]; })) * 100 : null;
      out.downCapturePct = down.length ? mean(down.map(function (i) { return A[i]; })) / mean(down.map(function (i) { return B[i]; })) * 100 : null;
      out.upPeriods = up.length; out.downPeriods = down.length;
      out.captureRatio = out.upCapturePct !== null && out.downCapturePct !== null && out.downCapturePct !== 0 ? out.upCapturePct / out.downCapturePct : null;
      // Tháng thắng chuẩn
      out.monthsCompared = mo.length;
      out.monthsBeat = mo.filter(function (m) { return m.excess > 1e-7; }).length;   // ngưỡng nhỏ để nhiễu số học không tính là "thắng"
      out.winRateMonthsPct = mo.length ? out.monthsBeat / mo.length * 100 : null;
      out.bestExcessMonth = mo.length ? mo.reduce(function (a, m) { return m.excess > a.excess ? m : a; }) : null;
      out.worstExcessMonth = mo.length ? mo.reduce(function (a, m) { return m.excess < a.excess ? m : a; }) : null;
    }
    out.ok = true;
    return out;
  }

  // Nhận xét bằng ngôn ngữ thường (mỗi dòng: {level:'good'|'warn'|'info', text})
  function narrative(a) {
    const out = [];
    const f = function (v, d) { return Number(v).toLocaleString('vi-VN', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d }); };
    if (!a || !a.ok) return out;
    if (a.reason === 'short') {
      out.push({ level: 'info', text: 'Mới có ' + a.periods + ' kỳ chụp NAV (' + (a.days || 0) + ' ngày) nên chưa đủ để tính alpha, beta, Sharpe... một cách đáng tin. Cần tối thiểu ' + MIN_PERIODS + ' kỳ; số liệu mô tả bên dưới vẫn đúng.' });
      return out;
    }
    if (a.hasBench) {
      if (a.excessCumulativePct > 0) out.push({ level: 'good', text: 'Cùng kỳ, danh mục ' + (a.excessCumulativePct >= 0 ? 'hơn' : 'kém') + ' chuẩn ' + f(Math.abs(a.excessCumulativePct)) + ' điểm % (' + f(a.cumulativePct) + '% so với ' + f(a.benchCumulativePct) + '%).' });
      else out.push({ level: 'warn', text: 'Cùng kỳ, danh mục kém chuẩn ' + f(Math.abs(a.excessCumulativePct)) + ' điểm % (' + f(a.cumulativePct) + '% so với ' + f(a.benchCumulativePct) + '%).' });
      if (a.alphaPct !== null) {
        const sig = a.alphaTStat !== undefined && a.alphaTStat !== null && Math.abs(a.alphaTStat) >= 2;
        out.push({ level: a.alphaPct > 0 ? (sig ? 'good' : 'info') : 'warn', text: 'Alpha ' + f(a.alphaPct) + '%/năm sau khi loại phần do thị trường (beta ' + f(a.beta, 2) + ')' + (sig ? '.' : ' — chưa đủ bằng chứng thống kê để nói đây là kỹ năng chứ không phải may mắn (cần nhiều dữ liệu hơn).') });
      }
      if (a.alphaPct !== null && a.alphaCIPct && !(a.alphaTStat !== undefined && a.alphaTStat !== null && Math.abs(a.alphaTStat) >= 2)) out.push({ level: 'info', text: 'Khoảng tin cậy 95% của alpha là ' + f(a.alphaCIPct[0]) + '% đến ' + f(a.alphaCIPct[1]) + '%/năm' + (a.alphaYearsNeeded ? ' — với mức dao động hiện tại cần khoảng ' + f(a.alphaYearsNeeded, 1) + ' năm dữ liệu để kết luận (|t| ≥ 2).' : '.') });
      if (a.hasPriceReturn && a.priceExcessCumulativePct !== undefined) out.push({ level: a.priceExcessCumulativePct >= 0 ? 'good' : 'warn', text: 'VN-Index là chỉ số GIÁ (không có cổ tức) nên so công bằng phải loại cổ tức khỏi danh mục: lợi suất giá ' + f(a.priceCumulativePct) + '% (cổ tức đóng góp ' + f(a.incomeReturnPct) + ' điểm %), ' + (a.priceExcessCumulativePct >= 0 ? 'hơn' : 'kém') + ' chuẩn ' + f(Math.abs(a.priceExcessCumulativePct)) + ' điểm %.' });
      if (a.informationRatio !== null) out.push({ level: a.informationRatio >= 0.5 ? 'good' : (a.informationRatio < 0 ? 'warn' : 'info'), text: 'Information ratio ' + f(a.informationRatio, 2) + ': mỗi 1% sai lệch so với chuẩn (tracking error ' + f(a.trackingErrorPct) + '%) đem lại ' + f(a.informationRatio, 2) + '% lợi suất vượt trội/năm. Trên 0,5 thường coi là tốt.' });
      if (a.upCapturePct !== null && a.downCapturePct !== null) {
        const good = a.upCapturePct > a.downCapturePct;
        out.push({ level: good ? 'good' : 'warn', text: 'Khi chuẩn tăng, danh mục ăn ' + f(a.upCapturePct, 0) + '% mức tăng; khi chuẩn giảm, danh mục chịu ' + f(a.downCapturePct, 0) + '% mức giảm' + (good ? ' — bất đối xứng có lợi.' : ' — chịu giảm nhiều hơn hưởng tăng.') });
      }
      if (a.winRateMonthsPct !== null) out.push({ level: a.winRateMonthsPct >= 50 ? 'good' : 'info', text: 'Thắng chuẩn ' + a.monthsBeat + '/' + a.monthsCompared + ' tháng (' + f(a.winRateMonthsPct, 0) + '%).' });
    }
    if (a.irrPct !== undefined && a.irrPct !== null) out.push({ level: 'info', text: 'IRR (lợi suất có trọng số dòng tiền) ' + f(a.irrPct) + '%/năm, so với TWR ' + f(a.annualizedPct === null ? a.cumulativePct : a.annualizedPct) + (a.annualizedPct === null ? '% cả kỳ' : '%/năm') + ': IRR phản ánh cả thời điểm bạn nạp/rút vốn, TWR thì không.' });
    if (a.sharpe !== null && a.sharpe !== undefined) out.push({ level: a.sharpe >= 1 ? 'good' : (a.sharpe < 0 ? 'warn' : 'info'), text: 'Sharpe ' + f(a.sharpe, 2) + ' (lãi phi rủi ro ' + f(a.rf * 100) + '%/năm)' + (a.sortino !== null ? ', Sortino ' + f(a.sortino, 2) + ' (chỉ phạt biến động theo chiều giảm)' : '') + '.' });
    return out;
  }

  return { MIN_PERIODS, MIN_MONTHS, DEFAULT_RF, rangeFor, buildPeriods, monthly, drawdown, analyze, narrative, rfFromRates, rfAt, xirr, mean, stdev, cov, compound };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PerfCalc;
