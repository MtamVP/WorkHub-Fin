// Logic thuần: phân tích rủi ro danh mục (tập trung theo mã/ngành, biến động, beta, VaR, sụt giảm, tương quan, kịch bản giảm điểm).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global RiskCalc) và module.exports cho Vitest. Cần FinCalc (lib/finance-calc.js) nạp trước.
//
// Phương pháp (hồi tố với TỶ TRỌNG HIỆN TẠI -- cách làm chuẩn cho nhà đầu tư cá nhân, không phụ thuộc số ngày đã chụp NAV):
//  - Chuỗi giá đóng cửa từng mã trong cửa sổ (mặc định 1 năm) được căn theo lịch giao dịch của VN-Index (điền tiếp giá ngày thiếu <= 5 ngày).
//  - Giá TRƯỚC ngày giao dịch không hưởng quyền được điều chỉnh theo cổ phiếu thưởng/cổ tức CP và cổ tức tiền (nếu có sự kiện), để các đợt
//    chia cổ phiếu không bị tính nhầm thành "giảm giá".
//  - Lợi suất danh mục mỗi ngày = tổng(tỷ trọng trên NAV x lợi suất mã); tiền mặt lợi suất 0; nợ vay làm đòn bẩy (không tính lãi vay).
//  - Biến động = độ lệch chuẩn ngày x căn(252). VaR lịch sử = phân vị 5% của lợi suất ngày. Beta = hồi quy với VN-Index.
//  - Đóng góp rủi ro của mã i = w_i x (hiệp phương sai mã i với danh mục) / phương sai danh mục (cộng lại = 100%).
//  - Kịch bản giảm điểm dùng beta điều chỉnh kiểu Blume (0,67 x beta + 0,33) vì beta quá khứ có xu hướng về 1.
// Đây là ước lượng từ quá khứ, KHÔNG phải dự báo: không bắt được rủi ro thanh khoản, tin xấu riêng của doanh nghiệp hay giá chạm sàn liên tiếp.
const RiskCalc = (function () {
  const FC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./finance-calc.js') : FinCalc;
  const TRADING_DAYS = 252;
  const MIN_OBS = 40;                    // số lợi suất ngày tối thiểu để các chỉ số thống kê có nghĩa
  const MAX_FILL_DAYS = 5;
  const DEFAULTS = { windowDays: 365, singleLimit: 25, sectorLimit: 40, corrThreshold: 0.7, corrWarn: 0.8, varLevel: 0.95, benchKey: 'VNINDEX' };

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function iso(v) { return String(v || '').slice(0, 10); }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }

  // ---------- thống kê cơ bản ----------
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
  function stdev(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }
  function covariance(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let s = 0;
    for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
    return s / (n - 1);
  }
  function correlation(a, b) {
    const sa = stdev(a), sb = stdev(b);
    return sa > 0 && sb > 0 ? covariance(a, b) / (sa * sb) : null;
  }
  // Phân vị p (0..1), nội suy tuyến tính
  function percentile(values, p) {
    if (!values.length) return null;
    const s = values.slice().sort(function (x, y) { return x - y; });
    const idx = (s.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }

  // ---------- điều chỉnh giá theo sự kiện ----------
  // series: [[YYYY-MM-DD, close]] tăng dần. events: [{symbol, kind, exDate, ratio(%), dps}]. Trả chuỗi mới (không sửa bản gốc).
  function adjustSeries(series, events, symbol) {
    const out = (series || []).map(function (p) { return [iso(p[0]), num(p[1])]; }).filter(function (p) { return p[1] > 0; });
    const evs = (events || []).filter(function (e) { return e.symbol === symbol && e.exDate; }).sort(function (a, b) { return a.exDate < b.exDate ? 1 : -1; });
    // Từ sự kiện mới nhất về cũ: mỗi sự kiện nhân hệ số cho MỌI giá trước exDate (hệ số cộng dồn đúng theo thứ tự)
    evs.forEach(function (e) {
      let factor = 1;
      if (e.kind === 'stock_dividend' || e.kind === 'bonus') {
        factor = 1 / (1 + num(e.ratio) / 100);
      } else if (e.kind === 'cash_dividend' && num(e.dps) > 0) {
        // Giá đóng cửa ngay trước ngày không hưởng quyền
        let prev = null;
        for (let i = out.length - 1; i >= 0; i--) { if (out[i][0] < e.exDate) { prev = out[i][1]; break; } }
        if (prev && num(e.dps) < prev) factor = 1 - num(e.dps) / prev;
      }
      if (factor === 1 || !isFinite(factor) || factor <= 0) return;
      for (let i = 0; i < out.length; i++) { if (out[i][0] < e.exDate) out[i][1] *= factor; }
    });
    return out;
  }

  // ---------- căn chuỗi giá theo lịch VN-Index ----------
  // histories: { SYM: [[date, close]] }. Trả { dates, closes: {SYM: [..|null]}, bench: [...] } cắt theo cửa sổ [from, to].
  function alignSeries(histories, symbols, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const bench = (histories[o.benchKey] || []).map(function (p) { return [iso(p[0]), num(p[1])]; }).filter(function (p) { return p[1] > 0; });
    if (bench.length < 2) return { dates: [], closes: {}, bench: [] };
    const last = bench[bench.length - 1][0];
    const from = new Date(new Date(last + 'T00:00:00Z').getTime() - o.windowDays * 86400000).toISOString().slice(0, 10);
    const dates = bench.map(function (p) { return p[0]; }).filter(function (d) { return d >= from; });
    const benchMap = {}; bench.forEach(function (p) { benchMap[p[0]] = p[1]; });
    const closes = {};
    symbols.forEach(function (sym) {
      const s = (histories[sym] || []);
      const m = {}; s.forEach(function (p) { m[iso(p[0])] = num(p[1]); });
      const sortedDates = Object.keys(m).sort();
      let k = 0, lastDate = null, lastClose = null;
      closes[sym] = dates.map(function (d) {
        while (k < sortedDates.length && sortedDates[k] <= d) { lastDate = sortedDates[k]; lastClose = m[lastDate]; k++; }
        return lastClose !== null && daysBetween(lastDate, d) <= MAX_FILL_DAYS && lastClose > 0 ? lastClose : null;
      });
    });
    return { dates: dates, closes: closes, bench: dates.map(function (d) { return benchMap[d]; }) };
  }

  // Lợi suất ngày; null khi thiếu giá ở một trong hai ngày
  function returnsOf(closes) {
    const r = [];
    for (let i = 1; i < closes.length; i++) {
      const a = closes[i - 1], b = closes[i];
      r.push(a > 0 && b > 0 ? b / a - 1 : null);
    }
    return r;
  }

  // ---------- sụt giảm ----------
  // values: chuỗi chỉ số (giá trị tích luỹ); dates cùng độ dài. Trả { maxDD (âm, vd -0.18), peakDate, troughDate, recoveredDate, current, series }
  function drawdownOf(values, dates) {
    let peak = -Infinity, peakIdx = 0, maxDD = 0, mPeak = 0, mTrough = 0;
    const series = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i] > peak) { peak = values[i]; peakIdx = i; }
      const dd = peak > 0 ? values[i] / peak - 1 : 0;
      series.push(dd);
      if (dd < maxDD) { maxDD = dd; mPeak = peakIdx; mTrough = i; }
    }
    let recovered = null;
    if (maxDD < 0) {
      for (let i = mTrough + 1; i < values.length; i++) { if (values[i] >= values[mPeak]) { recovered = dates[i]; break; } }
    }
    return {
      maxDD: maxDD, peakDate: maxDD < 0 ? dates[mPeak] : null, troughDate: maxDD < 0 ? dates[mTrough] : null, recoveredDate: recovered,
      current: series.length ? series[series.length - 1] : 0, series: series,
      daysToTrough: maxDD < 0 ? daysBetween(dates[mPeak], dates[mTrough]) : 0,
    };
  }

  // Chỉ số tích luỹ (gốc 1) từ chuỗi lợi suất (null = đứng yên)
  function cumulate(returns) {
    const out = [1];
    returns.forEach(function (r) { out.push(out[out.length - 1] * (1 + (r === null ? 0 : r))); });
    return out;
  }

  // Sụt giảm THỰC TẾ từ NAV đã chụp: nối lợi suất ngày "sạch" (bỏ ngày có nạp/rút vốn) như getPerformanceMetrics
  function actualDrawdown(navHistory) {
    const h = (navHistory || []).filter(function (x) { return num(x.nav) > 0; });
    if (h.length < 20) return null;
    const rets = [], dates = [h[0].snapshot_date];
    for (let i = 1; i < h.length; i++) {
      const flow = Math.abs(num(h[i].net_contributed) - num(h[i - 1].net_contributed)) > 1;
      rets.push(flow ? 0 : num(h[i].nav) / num(h[i - 1].nav) - 1);
      dates.push(h[i].snapshot_date);
    }
    const dd = drawdownOf(cumulate(rets), dates);
    return { maxDD: dd.maxDD, peakDate: dd.peakDate, troughDate: dd.troughDate, recoveredDate: dd.recoveredDate, current: dd.current, points: h.length, from: dates[0], to: dates[dates.length - 1] };
  }

  // ---------- phân tích chính ----------
  // input: { holdings:[{symbol, quantity, marketValue}], cash, debt, histories, events, navHistory }
  function analyze(input, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const holdings = (input.holdings || []).filter(function (h) { return num(h.marketValue) > 0; });
    const cash = num(input.cash), debt = num(input.debt);
    const mv = holdings.reduce(function (s, h) { return s + num(h.marketValue); }, 0);
    const nav = mv + cash - debt;
    const result = { ok: false, reason: null, nav: nav, marketValue: mv, cash: cash, debt: debt, options: o };
    if (!holdings.length || mv <= 0) { result.reason = 'empty'; return result; }

    const symbols = holdings.map(function (h) { return h.symbol; });
    result.leverage = nav > 0 ? mv / nav : null;
    result.cashPct = nav > 0 ? cash / nav * 100 : null;

    // --- tập trung (không cần lịch sử giá) ---
    const bySymbol = holdings.map(function (h) {
      return { symbol: h.symbol, sector: FC.sectorOf(h.symbol), value: num(h.marketValue), weightPct: num(h.marketValue) / mv * 100 };
    }).sort(function (a, b) { return b.value - a.value; });
    const hhi = bySymbol.reduce(function (s, x) { const w = x.weightPct / 100; return s + w * w; }, 0);
    result.concentration = {
      count: bySymbol.length, hhi: hhi, effectiveN: hhi > 0 ? 1 / hhi : null,
      top1Pct: bySymbol[0].weightPct, top3Pct: bySymbol.slice(0, 3).reduce(function (s, x) { return s + x.weightPct; }, 0),
    };
    const sectorMap = {};
    bySymbol.forEach(function (x) {
      const r = sectorMap[x.sector] || (sectorMap[x.sector] = { sector: x.sector, value: 0, symbols: [] });
      r.value += x.value; r.symbols.push(x.symbol);
    });
    const sectors = Object.keys(sectorMap).map(function (k) { const r = sectorMap[k]; r.weightPct = r.value / mv * 100; return r; })
      .sort(function (a, b) { return b.value - a.value; });
    result.symbols = bySymbol;
    result.sectors = sectors;

    // --- thống kê từ lịch sử giá ---
    const al = alignSeries(Object.assign({}, (function () {
      const adj = {};
      symbols.forEach(function (s) { adj[s] = adjustSeries((input.histories || {})[s], input.events, s); });
      adj[o.benchKey] = (input.histories || {})[o.benchKey];
      return adj;
    })()), symbols, o);
    const rets = {};
    const used = [], missing = [];
    symbols.forEach(function (s) {
      const r = returnsOf(al.closes[s] || []);
      const have = r.filter(function (x) { return x !== null; }).length;
      if (have >= MIN_OBS) { rets[s] = r; used.push(s); } else missing.push(s);
    });
    const benchRets = returnsOf(al.bench);
    result.coverage = { used: used, missing: missing, from: al.dates[0] || null, to: al.dates[al.dates.length - 1] || null, days: al.dates.length, adjusted: !!(input.events && input.events.length) };
    result.actual = actualDrawdown(input.navHistory);

    if (benchRets.length < MIN_OBS || !used.length || nav <= 0) {
      result.reason = nav <= 0 ? 'nonpositive-nav' : 'no-history';
      result.warnings = buildWarnings(result, o);
      return result;
    }

    // Lợi suất danh mục mỗi ngày (mã thiếu giá hôm đó coi như 0); w = giá trị / NAV
    const w = {}; bySymbol.forEach(function (x) { w[x.symbol] = x.value / nav; });
    const n = benchRets.length;
    const port = [];
    for (let t = 0; t < n; t++) {
      let r = 0;
      used.forEach(function (s) { const x = rets[s][t]; if (x !== null) r += w[s] * x; });
      port.push(r);
    }
    // Chỉ giữ ngày có lợi suất VN-Index (mọi ngày trong lịch) để so cặp
    const bench = benchRets.map(function (x) { return x === null ? 0 : x; });

    const volD = stdev(port), benchVol = stdev(bench);
    const beta = stdev(bench) > 0 ? covariance(port, bench) / (benchVol * benchVol) : null;
    const varQ = percentile(port, 1 - o.varLevel);
    const tail = port.filter(function (x) { return x <= varQ; });
    const dd = drawdownOf(cumulate(port), al.dates);
    const benchDd = drawdownOf(cumulate(bench), al.dates);
    result.portfolio = {
      obs: n, annVol: volD * Math.sqrt(TRADING_DAYS) * 100, benchAnnVol: benchVol * Math.sqrt(TRADING_DAYS) * 100,
      beta: beta, correlation: correlation(port, bench),
      varPct: varQ === null ? null : -varQ * 100, varVnd: varQ === null ? null : -varQ * nav,
      cvarPct: tail.length ? -mean(tail) * 100 : null,
      parametricVarPct: (1.645 * volD - mean(port)) * 100,
      worstDayPct: Math.min.apply(null, port) * 100, bestDayPct: Math.max.apply(null, port) * 100,
      totalReturnPct: (cumulate(port)[n] - 1) * 100, benchReturnPct: (cumulate(bench)[n] - 1) * 100,
      maxDD: dd.maxDD * 100, maxDDPeak: dd.peakDate, maxDDTrough: dd.troughDate, maxDDRecovered: dd.recoveredDate, maxDDDays: dd.daysToTrough,
      curDD: dd.current * 100, benchMaxDD: benchDd.maxDD * 100, benchCurDD: benchDd.current * 100,
      ddSeries: al.dates.map(function (d, i) { return { date: d, portfolio: dd.series[i] * 100, bench: benchDd.series[i] * 100 }; }),
    };

    // --- từng mã: biến động, beta, sụt giảm, đóng góp rủi ro ---
    const varP = volD * volD;
    const rows = {};
    used.forEach(function (s) {
      const r = rets[s].map(function (x) { return x === null ? 0 : x; });
      const cl = al.closes[s].filter(function (x) { return x !== null; });
      const idx = cumulate(r);
      const sdd = drawdownOf(idx, al.dates.slice(0, idx.length));
      const high = Math.max.apply(null, cl), lastC = cl[cl.length - 1];
      const rc = varP > 0 ? w[s] * covariance(r, port) / varP * 100 : null;
      const b = benchVol > 0 ? covariance(r, bench) / (benchVol * benchVol) : null;
      rows[s] = { annVol: stdev(r) * Math.sqrt(TRADING_DAYS) * 100, beta: b, betaAdj: b === null ? null : 0.67 * b + 0.33, maxDD: sdd.maxDD * 100, curDD: sdd.current * 100, fromHighPct: (lastC / high - 1) * 100, riskSharePct: rc, obs: rets[s].filter(function (x) { return x !== null; }).length };
    });
    result.symbols = bySymbol.map(function (x) { return Object.assign({}, x, rows[x.symbol] || { missing: true }); });
    // Đóng góp rủi ro theo ngành
    sectors.forEach(function (sec) {
      sec.riskSharePct = sec.symbols.reduce(function (s, sym) { return s + ((rows[sym] && rows[sym].riskSharePct) || 0); }, 0);
    });

    // --- ma trận tương quan ---
    const cm = used.map(function (a) {
      return used.map(function (b) {
        if (a === b) return 1;
        const ra = [], rb = [];
        for (let t = 0; t < n; t++) { const x = rets[a][t], y = rets[b][t]; if (x !== null && y !== null) { ra.push(x); rb.push(y); } }
        return ra.length >= MIN_OBS ? correlation(ra, rb) : null;
      });
    });
    const pctOf = {}; bySymbol.forEach(function (x) { pctOf[x.symbol] = x.weightPct; });   // tỷ trọng trên giá trị cổ phiếu (cùng cơ sở với từng mã)
    const pairs = [];
    for (let i = 0; i < used.length; i++) for (let j = i + 1; j < used.length; j++) {
      if (cm[i][j] !== null) pairs.push({ a: used[i], b: used[j], corr: cm[i][j], weightPct: pctOf[used[i]] + pctOf[used[j]] });
    }
    pairs.sort(function (x, y) { return y.corr - x.corr; });
    result.correlation = { symbols: used, matrix: cm, pairs: pairs, avg: pairs.length ? mean(pairs.map(function (p) { return p.corr; })) : null };

    // --- kịch bản giảm điểm VN-Index ---
    const betaAdjPort = used.reduce(function (s, sym) { return s + w[sym] * rows[sym].betaAdj; }, 0);
    result.stress = [-5, -10, -15, -20].map(function (m) {
      const bySym = used.map(function (sym) { return { symbol: sym, pct: rows[sym].betaAdj * m, vnd: w[sym] * nav * rows[sym].betaAdj * m / 100 }; });
      const vnd = bySym.reduce(function (s, x) { return s + x.vnd; }, 0);
      return { indexMovePct: m, portfolioPct: nav > 0 ? vnd / nav * 100 : null, vnd: vnd, bySymbol: bySym };
    });
    result.portfolio.betaAdj = betaAdjPort;

    result.ok = true;
    result.warnings = buildWarnings(result, o);
    return result;
  }

  // ---------- cảnh báo bằng ngôn ngữ thường ----------
  function pct(v, d) { return Number(v).toLocaleString('vi-VN', { maximumFractionDigits: d === undefined ? 0 : d, minimumFractionDigits: 0 }) + '%'; }
  function dec(v, d) { return Number(v).toLocaleString('vi-VN', { maximumFractionDigits: d === undefined ? 2 : d, minimumFractionDigits: d === undefined ? 2 : d }); }
  const LEVEL_ORDER = { high: 0, med: 1, low: 2 };

  function buildWarnings(r, o) {
    const out = [];
    const add = function (level, code, text) { out.push({ level: level, code: code, text: text }); };
    const syms = r.symbols || [];
    const c = r.concentration;
    if (c && c.count < 3) add('med', 'few-holdings', 'Chỉ có ' + c.count + ' mã đang giữ — chưa đa dạng hoá, một tin xấu riêng của doanh nghiệp có thể ảnh hưởng lớn tới cả danh mục.');
    if (c && c.count >= 2) {
      syms.forEach(function (x) {
        if (x.weightPct >= o.singleLimit) add(x.weightPct >= o.singleLimit + 15 ? 'high' : 'med', 'single:' + x.symbol, x.symbol + ' chiếm ' + pct(x.weightPct) + ' giá trị cổ phiếu (ngưỡng bạn đặt ' + pct(o.singleLimit) + ').');
      });
      (r.sectors || []).forEach(function (s) {
        if (s.sector !== FC.UNKNOWN_SECTOR && s.symbols.length >= 2 && s.weightPct >= o.sectorLimit) {
          add(s.weightPct >= o.sectorLimit + 15 ? 'high' : 'med', 'sector:' + s.sector, 'Ngành ' + s.sector + ' chiếm ' + pct(s.weightPct) + ' (' + s.symbols.join(', ') + ') — ngưỡng ' + pct(o.sectorLimit) + '.');
        }
      });
      if (c.count >= 4 && c.top3Pct >= 75) add('low', 'top3', '3 mã lớn nhất chiếm ' + pct(c.top3Pct) + ' danh mục.');
      if (c.count >= 3 && c.effectiveN !== null && c.effectiveN < c.count * 0.6) add('low', 'effective-n', 'Danh mục có ' + c.count + ' mã nhưng mức tập trung tương đương chỉ khoảng ' + dec(c.effectiveN, 1) + ' mã đều nhau.');
    }
    if (r.leverage !== null && r.leverage !== undefined && r.leverage > 1.001) {
      add(r.leverage >= 1.5 ? 'high' : 'med', 'leverage', 'Đang dùng đòn bẩy (margin): giá trị cổ phiếu bằng ' + dec(r.leverage, 2) + ' lần NAV — thị trường giảm 10% thì NAV giảm khoảng ' + pct(10 * r.leverage) + '.');
    }
    if (r.cashPct !== null && r.cashPct !== undefined && r.cashPct >= 50 && c && c.count) add('low', 'high-cash', 'Tiền mặt chiếm ' + pct(r.cashPct) + ' NAV — an toàn nhưng đang bỏ lỡ lợi suất nếu đây không phải chủ ý.');
    const p = r.portfolio;
    if (p) {
      if (p.beta !== null && p.beta >= 1.25) add('med', 'beta', 'Danh mục nhạy hơn thị trường: beta ' + dec(p.beta, 2) + ' (VN-Index giảm 10% thì danh mục thường giảm ~' + pct(p.beta * 10) + ').');
      if (p.curDD <= -10) add(p.curDD <= -20 ? 'high' : 'med', 'drawdown', 'Danh mục hiện thấp hơn đỉnh gần nhất ' + pct(Math.abs(p.curDD), 1) + ' (tính với tỷ trọng hiện tại).');
      if (p.annVol >= 35) add('med', 'vol', 'Biến động của danh mục khoảng ' + pct(p.annVol) + '/năm' + (p.benchAnnVol ? ', VN-Index ' + pct(p.benchAnnVol) : '') + '.');
    }
    syms.forEach(function (x) {
      if (x.riskSharePct !== undefined && x.riskSharePct !== null && x.riskSharePct >= 25 && x.riskSharePct >= x.weightPct * 1.5) {
        add('med', 'risk-share:' + x.symbol, x.symbol + ' chiếm ' + pct(x.weightPct) + ' vốn nhưng tạo ra ' + pct(x.riskSharePct) + ' rủi ro biến động của danh mục.');
      }
    });
    const cr = r.correlation;
    if (cr) {
      cr.pairs.filter(function (q) { return q.corr >= o.corrWarn && q.weightPct >= 30; }).slice(0, 3).forEach(function (q) {
        add('med', 'corr:' + q.a + ':' + q.b, q.a + ' và ' + q.b + ' di chuyển rất giống nhau (tương quan ' + dec(q.corr, 2) + ') nhưng cùng chiếm ' + pct(q.weightPct) + ' — đa dạng hoá thấp hơn vẻ ngoài.');
      });
    }
    if (r.coverage && r.coverage.missing.length) {
      add('low', 'coverage', 'Chưa đủ dữ liệu giá để phân tích: ' + r.coverage.missing.join(', ') + ' — các mã này chưa được tính vào chỉ số biến động/VaR.');
    }
    return out.sort(function (a, b) { return LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]; });
  }

  // ---------- Thanh khoản: bán hết các vị thế mất bao lâu ----------
  // holdings: [{symbol, quantity, value}]; volumes: { SYM: [[date, khối lượng cổ phiếu]] }. opts: { rate (tỷ lệ tối đa của khối lượng giao dịch ngày mà bạn dám chiếm, mặc định 20%), window (số phiên tính trung bình, 20) }.
  // Ngày bán hết = số cổ phiếu / (rate x khối lượng giao dịch bình quân ngày). Bỏ qua phiên khối lượng 0 (nghỉ giao dịch). Không tính tác động giá khi bán lượng lớn.
  const LIQ_DAYS = [1, 2, 3, 5, 10, 20];
  function liquidity(holdings, volumes, opts) {
    const o = Object.assign({ rate: 0.2, window: 20 }, opts || {});
    const rows = [];
    const missing = [];
    let known = 0, total = 0;
    (holdings || []).filter(function (h) { return num(h.quantity) > 0 && num(h.value) > 0; }).forEach(function (h) {
      total += num(h.value);
      const v = (volumes && volumes[h.symbol] || []).map(function (p) { return num(p[1]); }).filter(function (x) { return x > 0; });
      if (v.length < 5) { missing.push(h.symbol); return; }
      const recent = v.slice(-o.window), long = v.slice(-60);
      const adv = mean(recent), advMedian = percentile(long, 0.5);
      const perDay = o.rate * adv;
      const days = perDay > 0 ? num(h.quantity) / perDay : null;
      known += num(h.value);
      rows.push({ symbol: h.symbol, quantity: num(h.quantity), value: num(h.value), adv: adv, advMedian: advMedian, perDay: perDay, days: days, shareOfAdvPct: adv > 0 ? num(h.quantity) / adv * 100 : null, level: days === null ? 'unknown' : (days > 10 ? 'high' : (days > 3 ? 'med' : 'ok')) });
    });
    rows.sort(function (a, b) { return (b.days || 0) - (a.days || 0); });
    // Tỷ lệ giá trị (trong phần có dữ liệu) có thể bán xong sau d phiên, bán đồng thời mọi vị thế
    const cover = LIQ_DAYS.map(function (d) {
      const sold = rows.reduce(function (s, r) { return s + Math.min(r.quantity, r.perDay * d) * (r.value / r.quantity); }, 0);
      return { days: d, pct: known > 0 ? sold / known * 100 : null };
    });
    return { rate: o.rate, rows: rows, missing: missing, cover: cover, knownValue: known, totalValue: total, coveragePct: total > 0 ? known / total * 100 : null,
      worst: rows.length ? rows[0] : null, daysToExitAll: rows.length ? Math.max.apply(null, rows.map(function (r) { return r.days || 0; })) : null };
  }

  // ---------- Kịch bản lịch sử: nếu chuỗi phiên tệ nhất của VN-Index lặp lại thì danh mục hiện tại ra sao ----------
  // input: { holdings:[{symbol, value}], nav, histories, events }. Dùng giá THỰC của từng mã trong đúng khoảng ngày đó (không dùng beta); mã chưa có giá lúc đó coi như đi cùng chỉ số.
  function historicalScenarios(input, options) {
    const o = Object.assign({}, DEFAULTS, { lengths: [1, 5, 20, 60] }, options || {});
    const holdings = (input.holdings || []).filter(function (h) { return num(h.value) > 0; });
    const nav = num(input.nav);
    if (!holdings.length || !(nav > 0)) return [];
    const adj = {};
    holdings.forEach(function (h) { adj[h.symbol] = adjustSeries((input.histories || {})[h.symbol], input.events, h.symbol); });
    adj[o.benchKey] = (input.histories || {})[o.benchKey];
    const al = alignSeries(adj, holdings.map(function (h) { return h.symbol; }), o);
    const n = al.dates.length;
    const out = [];
    o.lengths.forEach(function (L) {
      if (n <= L) return;
      let worst = null;
      for (let i = L; i < n; i++) {
        const r = al.bench[i] / al.bench[i - L] - 1;
        if (worst === null || r < worst.r) worst = { r: r, i0: i - L, i1: i };
      }
      if (!worst || !(worst.r < 0)) return;
      const bySymbol = holdings.map(function (h) {
        const c = al.closes[h.symbol] || [];
        const a = c[worst.i0], b = c[worst.i1];
        const estimated = !(a > 0 && b > 0);
        const pct = estimated ? worst.r * 100 : (b / a - 1) * 100;
        return { symbol: h.symbol, pct: pct, vnd: num(h.value) * pct / 100, estimated: estimated };
      });
      const vnd = bySymbol.reduce(function (s, x) { return s + x.vnd; }, 0);
      out.push({ windowDays: L, from: al.dates[worst.i0], to: al.dates[worst.i1], benchPct: worst.r * 100, portfolioPct: vnd / nav * 100, vnd: vnd,
        bySymbol: bySymbol.sort(function (a, b) { return a.vnd - b.vnd; }), estimatedCount: bySymbol.filter(function (x) { return x.estimated; }).length });
    });
    return out;
  }

  // ---------- Kịch bản tự đặt: cú sốc chung + cú sốc theo ngành + cú sốc theo mã ----------
  // r: kết quả analyze (cần r.symbols[{symbol, sector, value, betaAdj?}] và r.nav). shocks: { index: -10, sectors: { 'Ngân hàng': -15 }, symbols: { FPT: -25 } } (đơn vị %).
  // Mã không có cú sốc riêng/ngành thì chịu beta điều chỉnh (hoặc 1 nếu chưa tính được) x cú sốc chung. Ưu tiên: mã > ngành > beta x chung.
  function customStress(r, shocks) {
    const s = shocks || {};
    const idx = num(s.index);
    const has = function (obj, k) { return obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '' && isFinite(Number(obj[k])); };
    const rows = (r.symbols || []).map(function (x) {
      const beta = x.betaAdj !== undefined && x.betaAdj !== null ? x.betaAdj : 1;
      let pct = beta * idx, src = 'beta';
      if (has(s.sectors, x.sector)) { pct = Number(s.sectors[x.sector]); src = 'sector'; }
      if (has(s.symbols, x.symbol)) { pct = Number(s.symbols[x.symbol]); src = 'symbol'; }
      return { symbol: x.symbol, sector: x.sector, value: x.value, pct: pct, vnd: x.value * pct / 100, source: src, defaultBeta: x.betaAdj === undefined || x.betaAdj === null };
    }).sort(function (a, b) { return a.vnd - b.vnd; });
    const vnd = rows.reduce(function (acc, x) { return acc + x.vnd; }, 0);
    const nav = num(r.nav);
    return { rows: rows, totalVnd: vnd, portfolioPct: nav > 0 ? vnd / nav * 100 : null, navAfter: nav + vnd, worst: rows.length ? rows[0] : null,
      negativeNav: nav + vnd < 0 };
  }

  return { DEFAULTS, MIN_OBS, LIQ_DAYS, liquidity, historicalScenarios, customStress, analyze, adjustSeries, alignSeries, returnsOf, drawdownOf, actualDrawdown, cumulate, mean, stdev, covariance, correlation, percentile };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RiskCalc;
