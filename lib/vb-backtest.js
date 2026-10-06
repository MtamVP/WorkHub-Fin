// Logic thuần của VALUATION BENCH: BẢNG ĐIỂM ĐỘ CHÍNH XÁC (backtest đi tới từng thời điểm, walk-forward) -- tại mỗi thời điểm T trong quá khứ chỉ dùng dữ liệu CÓ SẴN lúc đó
// (báo cáo đã công bố sau độ trễ, chuỗi bội số đến T, giá tại T) để chạy chính bộ máy VBEngine, rồi so giá trị hợp lý với giá và lợi suất 6 / 12 tháng sau.
// Không tính được ở quá khứ (nên bị bỏ ra khỏi phép thử, ghi rõ): thống kê ngành lịch sử (các phương pháp so với ngành), bối cảnh thị trường và kỹ thuật tại T. Vì vậy bảng điểm chỉ đo
// phần NỘI TẠI + LỊCH SỬ CỦA CHÍNH CỔ PHIẾU của bộ máy (DCF, EPV, Graham, Lynch, bội số lịch sử, thu nhập thặng dư, P/B hợp lý...).
// Chỉ số chính: IC (hệ số tương quan hạng Spearman) giữa ln(giá trị hợp lý / giá) và lợi suất vượt VN-Index sau 6/12 tháng; khoảng tin cậy bằng bootstrap THEO NGÀY (các mã cùng ngày
// chịu chung biến động thị trường nên không được coi là độc lập). Mẫu chồng lấn nhau (cửa sổ 6/12 tháng) nên số quan sát độc lập thực sự thấp hơn nhiều so với n: luôn đọc kèm khoảng tin cậy.
// Thiên lệch đã biết: tập mã là VN30 HIỆN TẠI (thiên lệch người sống sót và nhìn trước); giá là giá đã điều chỉnh cổ tức/chia tách; số cổ phiếu dùng mức hiện tại cho mọi thời điểm để cùng cơ sở với giá điều chỉnh.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VBBacktest) và module.exports cho Vitest.
const VBBacktest = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const LAG = { annual: 95, quarter: 50 };       // độ trễ công bố báo cáo (ngày) sau ngày kết thúc kỳ
  const HORIZONS = { r6: 126, r12: 252 };        // số phiên giao dịch

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const dayMs = 86400000, dateMs = (d) => Date.parse(String(d).slice(0, 10) + 'T00:00:00Z');

  // Chỉ giữ các hàng báo cáo đã được công bố tại thời điểm T (ngày kết thúc kỳ + độ trễ <= T)
  function pitRows(rows, T, kind) {
    const lag = LAG[kind] || 95, t = dateMs(T);
    return (rows || []).filter(function (r) { return dateMs(r.fiscalDate) + lag * dayMs <= t; });
  }
  // Chuỗi bội số đến hết ngày T (dates song song với values)
  function pitSeries(values, dates, T) {
    if (!values || !dates) return null;
    const out = [], t = dateMs(T);
    for (let i = 0; i < values.length; i++) if (dateMs(dates[i]) <= t) out.push(values[i]);
    return out;
  }
  function asOfIndices(n, warmup, step, maxH) {
    const out = [];
    for (let i = warmup; i < n - 1; i += step) out.push(i);
    void maxH;      // thời điểm gần cuối vẫn có giá trị hợp lý nhưng chưa đủ kỳ hạn 12 tháng: giữ lại, từng kỳ hạn tự loại quan sát chưa có kết quả
    return out;
  }

  // data: dữ liệu thô của một mã { form, annualRows, quarterRows, candles: { t: [YYYY-MM-DD], c: [...] }, ratioSeries: { pe, pb }, ratioDates: { pe, pb } }
  // idx: { t: [...], c: [...] } nến VN-Index. engine: VBEngine. opts: { warmup, step, shares, sectorCode, mc }
  function runSymbol(data, engine, idx, opts) {
    const o = opts || {}, T = data.candles.t, C = data.candles.c, obs = [];
    const indexPos = {}; if (idx && idx.t) idx.t.forEach(function (d, i) { indexPos[d] = i; });
    let shares = num(o.shares);
    if (shares === null) { const full = engine.analyze({ symbol: data.symbol, form: data.form, annualRows: data.annualRows, quarterRows: data.quarterRows, price: C[C.length - 1], mc: { n: 1 } }); shares = full && full.shares > 0 ? full.shares : null; }
    if (!(shares > 0)) return obs;
    const idxs = asOfIndices(T.length, o.warmup === undefined ? 120 : o.warmup, o.step || 21, HORIZONS.r12);
    idxs.forEach(function (i) {
      const date = T[i], price = C[i]; if (!(price > 0)) return;
      const ann = pitRows(data.annualRows, date, 'annual'), qtr = pitRows(data.quarterRows, date, 'quarter');
      const ratioSeries = {};
      ['pe', 'pb'].forEach(function (k) { const s = pitSeries(data.ratioSeries && data.ratioSeries[k], data.ratioDates && data.ratioDates[k], date); if (s && s.length) ratioSeries[k] = s; });
      let r;
      try { r = engine.analyze({ symbol: data.symbol, form: data.form, annualRows: ann, quarterRows: qtr, price: price, shares: shares, ratioSeries: ratioSeries, sectorCode: o.sectorCode || null, now: date, mc: { n: o.mc || 1 } }); } catch (e) { return; }
      if (!r || !r.ok || !r.synthesis || !r.synthesis.ok) return;
      const methods = {}; r.synthesis.methods.forEach(function (m) { if (m.base > 0) methods[m.key] = m.base; });
      const row = { symbol: data.symbol, date: date, price: price, fair: r.synthesis.fair.base, form: r.form, archetype: r.process ? r.process.archetype.key : null, methods: methods, periods: (r.periods || []).length };
      Object.keys(HORIZONS).forEach(function (k) {
        const j = i + HORIZONS[k]; if (j >= T.length) { row[k] = null; row['f' + k] = null; row['x' + k] = null; return; }
        row[k] = C[j] / price - 1; row['f' + k] = C[j];
        const a = idx && indexPos[date] !== undefined ? indexPos[date] : null, b = idx && indexPos[T[j]] !== undefined ? indexPos[T[j]] : null;
        row['x' + k] = a !== null && b !== null ? row[k] - (idx.c[b] / idx.c[a] - 1) : null;
      });
      obs.push(row);
    });
    return obs;
  }

  // ---------- thống kê ----------
  function ranks(a) {
    const idx = a.map(function (v, i) { return [v, i]; }).sort(function (x, y) { return x[0] - y[0]; }), r = new Array(a.length);
    for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const rk = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = rk; i = j + 1; }
    return r;
  }
  function pearson(x, y) {
    const n = x.length; if (n < 3) return null;
    const mx = x.reduce(function (s, v) { return s + v; }, 0) / n, my = y.reduce(function (s, v) { return s + v; }, 0) / n;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) * (x[i] - mx); syy += (y[i] - my) * (y[i] - my); }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
  }
  const spearman = (x, y) => (x.length === y.length && x.length >= 3 ? pearson(ranks(x), ranks(y)) : null);
  function quantile(sorted, p) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
  const median = (a) => { const s = a.slice().sort(function (x, y) { return x - y; }); return quantile(s, 0.5); };
  const mean = (a) => (a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null);

  // IC + khoảng tin cậy bootstrap theo ngày. pairs: [{ date, s (tín hiệu), y (kết quả) }]
  function icWithCI(pairs, B, seed) {
    const ic = spearman(pairs.map(function (p) { return p.s; }), pairs.map(function (p) { return p.y; }));
    const byDate = {}; pairs.forEach(function (p) { (byDate[p.date] = byDate[p.date] || []).push(p); });
    const dates = Object.keys(byDate), out = { ic: ic, n: pairs.length, nDates: dates.length, lo: null, hi: null };
    if (dates.length < 8 || ic === null) return out;
    const rnd = mulberry32(seed || 12345), vals = [];
    for (let b = 0; b < (B || 300); b++) {
      const sample = []; for (let k = 0; k < dates.length; k++) { const d = dates[Math.floor(rnd() * dates.length)]; byDate[d].forEach(function (p) { sample.push(p); }); }
      const v = spearman(sample.map(function (p) { return p.s; }), sample.map(function (p) { return p.y; })); if (v !== null) vals.push(v);
    }
    vals.sort(function (x, y) { return x - y; }); out.lo = quantile(vals, 0.025); out.hi = quantile(vals, 0.975);
    return out;
  }

  // Phân nhóm theo tín hiệu (ln giá trị hợp lý / giá): nhóm 1 = đắt nhất so với giá trị hợp lý, nhóm k = rẻ nhất
  function buckets(pairs, k) {
    if (pairs.length < k * 5) return [];
    const sorted = pairs.slice().sort(function (a, b) { return a.s - b.s; }), out = [];
    for (let g = 0; g < k; g++) {
      const part = sorted.slice(Math.floor(g * sorted.length / k), Math.floor((g + 1) * sorted.length / k));
      out.push({ group: g + 1, n: part.length, sLow: part[0].s, sHigh: part[part.length - 1].s, avgRet: mean(part.map(function (p) { return p.ret; })), avgExcess: mean(part.map(function (p) { return p.y; })), hit: part.filter(function (p) { return p.y > 0; }).length / part.length });
    }
    return out;
  }
  function slope(pairs) {
    const n = pairs.length; if (n < 10) return null;
    const mx = mean(pairs.map(function (p) { return p.s; })), my = mean(pairs.map(function (p) { return p.y; }));
    let sxy = 0, sxx = 0; pairs.forEach(function (p) { sxy += (p.s - mx) * (p.y - my); sxx += (p.s - mx) * (p.s - mx); });
    return sxx > 0 ? { slope: sxy / sxx, intercept: my - sxy / sxx * mx } : null;
  }

  // Bảng điểm cho một kỳ hạn h ('r6' | 'r12') từ danh sách quan sát
  function scoreHorizon(obs, h, opts) {
    const o = opts || {}, pairsOf = function (get) {
      return obs.map(function (x) { const v = get(x); return v !== null && x['x' + h] !== null && x['x' + h] !== undefined && x[h] !== null ? { date: x.date, s: Math.log(v / x.price), y: x['x' + h], ret: x[h], fut: x['f' + h], v: v } : null; }).filter(function (p) { return p && isFinite(p.s); });
    };
    const all = pairsOf(function (x) { return x.fair > 0 ? x.fair : null; });
    const out = { horizon: h, sessions: HORIZONS[h], n: all.length };
    if (all.length < 30) { out.insufficient = true; return out; }
    out.overall = icWithCI(all, o.boot, 1);
    out.buckets = buckets(all, 5); out.calibration = slope(all);
    out.bias = { medianLogFairOverPrice: median(all.map(function (p) { return p.s; })), medianLogFairOverFuture: median(all.map(function (p) { return Math.log(p.v / p.fut); })), medianAbsLogErr: median(all.map(function (p) { return Math.abs(Math.log(p.v / p.fut)); })), within20: all.filter(function (p) { return Math.abs(Math.log(p.v / p.fut)) <= Math.log(1.2); }).length / all.length };
    // từng phương pháp
    const keys = {}; obs.forEach(function (x) { Object.keys(x.methods || {}).forEach(function (k) { keys[k] = true; }); });
    out.methods = Object.keys(keys).map(function (k) {
      const p = pairsOf(function (x) { return x.methods && x.methods[k] > 0 ? x.methods[k] : null; });
      if (p.length < 30) return { key: k, n: p.length, insufficient: true };
      const ci = icWithCI(p, o.boot, 7), bk = buckets(p, 3);
      return { key: k, n: p.length, nDates: ci.nDates, ic: ci.ic, icLo: ci.lo, icHi: ci.hi, medianLogFairOverPrice: median(p.map(function (q) { return q.s; })), medianAbsLogErr: median(p.map(function (q) { return Math.abs(Math.log(q.v / q.fut)); })), medianLogFairOverFuture: median(p.map(function (q) { return Math.log(q.v / q.fut); })), spread: bk.length === 3 ? bk[2].avgExcess - bk[0].avgExcess : null };
    }).sort(function (a, b) { return (b.n || 0) - (a.n || 0); });
    // theo mô hình kinh doanh
    const arch = {}; obs.forEach(function (x) { if (x.archetype) (arch[x.archetype] = arch[x.archetype] || []).push(x); });
    out.archetypes = Object.keys(arch).map(function (k) {
      const sub = obs.filter(function (x) { return x.archetype === k; }), pp = sub.map(function (x) { return x['x' + h] !== null && x['x' + h] !== undefined && x[h] !== null && x.fair > 0 ? { date: x.date, s: Math.log(x.fair / x.price), y: x['x' + h], ret: x[h] } : null; }).filter(function (q) { return q; });
      if (pp.length < 30) return { key: k, n: pp.length, symbols: new Set(sub.map(function (x) { return x.symbol; })).size, insufficient: true };
      const ci = icWithCI(pp, o.boot, 3), bk = buckets(pp, 3);
      return { key: k, n: pp.length, symbols: new Set(sub.map(function (x) { return x.symbol; })).size, ic: ci.ic, icLo: ci.lo, icHi: ci.hi, spread: bk.length === 3 ? bk[2].avgExcess - bk[0].avgExcess : null };
    }).sort(function (a, b) { return b.n - a.n; });
    // ma trận mô hình kinh doanh x phương pháp: IC của từng phương pháp BÊN TRONG từng mô hình (để quy trình hiện bằng chứng cho đúng vai trò)
    out.matrix = {};
    Object.keys(arch).forEach(function (a) {
      const sub = arch[a], ks = {}; sub.forEach(function (x) { Object.keys(x.methods || {}).forEach(function (k) { ks[k] = true; }); });
      Object.keys(ks).forEach(function (k) {
        const p = sub.map(function (x) { const v = x.methods && x.methods[k] > 0 ? x.methods[k] : null; return v !== null && x['x' + h] !== null && x['x' + h] !== undefined ? { date: x.date, s: Math.log(v / x.price), y: x['x' + h] } : null; }).filter(function (q) { return q && isFinite(q.s); });
        if (p.length < 60) return;
        const ci = icWithCI(p, Math.min(o.boot || 300, 150), 11);
        (out.matrix[a] = out.matrix[a] || {})[k] = { n: p.length, ic: ci.ic, lo: ci.lo, hi: ci.hi };
      });
    });
    return out;
  }

  // IC của giá trị đồng thuận theo hai nửa thời gian (T <= splitDate và sau đó): nửa sau là phép thử ngoài mẫu cho mọi hiệu chỉnh làm ở nửa đầu
  function splitScores(obs, splitDate, opts) {
    const out = { splitDate: splitDate };
    [['train', function (x) { return x.date <= splitDate; }], ['test', function (x) { return x.date > splitDate; }]].forEach(function (part) {
      const sub = obs.filter(part[1]); out[part[0]] = {};
      ['r6', 'r12'].forEach(function (h) {
        const p = sub.filter(function (x) { return x['x' + h] !== null && x['x' + h] !== undefined; }).map(function (x) { return { date: x.date, s: Math.log(x.fair / x.price), y: x['x' + h] }; }).filter(function (q) { return isFinite(q.s); });
        const ci = p.length >= 30 ? icWithCI(p, (opts && opts.boot) || 300, 21) : null;
        out[part[0]][h] = ci ? { n: p.length, nDates: ci.nDates, ic: ci.ic, lo: ci.lo, hi: ci.hi } : { n: p.length, insufficient: true };
      });
    });
    return out;
  }

  function scorecard(obs, meta, opts) {
    const clean = (obs || []).filter(function (x) { return x && x.fair > 0 && x.price > 0; });
    return Object.assign({ generatedAt: (meta && meta.generatedAt) || null, universe: meta && meta.universe ? meta.universe : null, nObs: clean.length, nSymbols: new Set(clean.map(function (x) { return x.symbol; })).size,
      nDates: new Set(clean.map(function (x) { return x.date; })).size, range: clean.length ? { from: clean.reduce(function (m, x) { return x.date < m ? x.date : m; }, clean[0].date), to: clean.reduce(function (m, x) { return x.date > m ? x.date : m; }, clean[0].date) } : null,
      horizons: { r6: scoreHorizon(clean, 'r6', opts), r12: scoreHorizon(clean, 'r12', opts) }, splits: splitScores(clean, (opts && opts.splitDate) || '2023-12-31', opts), limits: LIMITS }, {});
  }
  const LIMITS = [
    'Chỉ đo phần nội tại và lịch sử của chính cổ phiếu: thống kê ngành, bối cảnh thị trường và kỹ thuật không có dữ liệu tại các thời điểm trong quá khứ.',
    'Tập mã là VN30 hiện tại cộng một số mã thanh khoản lớn: thiên lệch người sống sót và nhìn trước (mã được chọn vì đã thành công).',
    'Giá là giá đã điều chỉnh cổ tức và chia tách; số cổ phiếu dùng mức hiện tại cho mọi thời điểm.',
    'Các quan sát chồng lấn (kỳ hạn 6 và 12 tháng, bước 1 tháng) và các mã cùng ngày cùng chịu biến động thị trường: số quan sát độc lập thực sự thấp hơn n nhiều; khoảng tin cậy bootstrap theo ngày đã tính tới điều này nhưng vẫn là ước lượng thô.',
    'Chỉ 4-5 năm dữ liệu (một chu kỳ thị trường): kết quả có thể không lặp lại ở giai đoạn khác.',
    'Quá khứ không bảo đảm tương lai; bảng điểm để hiệu chỉnh mức tin cậy, không phải bằng chứng phương pháp luôn đúng.',
  ];

  return { LAG, HORIZONS, LIMITS, pitRows, pitSeries, asOfIndices, runSymbol, ranks, spearman, pearson, quantile, median, mean, icWithCI, buckets, slope, scoreHorizon, scorecard, mulberry32 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBBacktest;
