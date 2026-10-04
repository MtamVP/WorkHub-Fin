// Logic thuần: MÔ HÌNH RỦI RO NÂNG CAO cho danh mục cổ phiếu Việt Nam -- bổ sung cho lib/risk-calc.js (biến động mẫu, VaR lịch sử, beta hồi quy):
//   * EWMA (RiskMetrics, lambda 0,94): biến động HIỆN TẠI phản ứng nhanh hơn độ lệch chuẩn mẫu cả năm -- thị trường vừa biến động mạnh thì phương sai mẫu đánh giá thấp rủi ro lúc này.
//   * Beta Dimson (hồi quy trên lợi suất chỉ số hôm qua, hôm nay, ngày mai): cổ phiếu kém thanh khoản giao dịch không đồng bộ với chỉ số nên beta thường gần như hồi quy thông thường bị thấp.
//   * Ma trận hiệp phương sai co (Ledoit-Wolf 2004, co về ma trận đường chéo): ước lượng từ ít quan sát so với số mã thì nhiễu, đóng góp rủi ro nhảy loạn; co về giúp ổn định.
//   * VaR mô phỏng lịch sử có lọc biến động (FHS): lợi suất chuẩn hoá theo EWMA rồi nhân với biến động hiện tại -- vừa dùng phân phối thật (đuôi dày) vừa theo chế độ biến động hiện tại.
//   * KIỂM ĐỊNH NGƯỢC VaR (Kupiec: số lần vượt có đúng tỷ lệ kỳ vọng không; Christoffersen: các lần vượt có dồn cục không): bằng chứng mô hình VaR đáng tin hay không -- việc phần mềm quỹ lớn bắt buộc làm.
//   * Biến động khi tương quan tăng vọt (khủng hoảng): tương quan co về 1 theo hệ số k.
// Các công thức đã đối chiếu với numpy/scipy trên cùng dữ liệu (tests/fixtures/risk-models-golden.json, tạo bằng tests/fixtures/make-risk-golden.py).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global RiskModels) và module.exports cho Vitest.
const RiskModels = (function () {
  const TD = 252;
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const variance = (a) => { if (a.length < 2) return 0; const m = mean(a); return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1); };
  const clean = (a) => a.map((x) => (x === null || x === undefined || !isFinite(x) ? 0 : Number(x)));
  function percentile(values, p) {            // nội suy tuyến tính như numpy.percentile
    if (!values.length) return null;
    const s = values.slice().sort((x, y) => x - y), idx = (s.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }

  // ---- hàm đặc biệt: erfc và p-value của chi bình phương ----
  function erfc(x) {                           // Numerical Recipes (Chebyshev), sai số tương đối < 1,2e-7
    const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  function chi2Sf(x, df) {                     // xác suất vượt (p-value); chỉ cần df = 1 hoặc 2
    if (!(x > 0)) return 1;
    if (df === 1) return erfc(Math.sqrt(x / 2));
    if (df === 2) return Math.exp(-x / 2);
    throw new Error('chi2Sf: chỉ hỗ trợ df 1 hoặc 2');
  }

  // ---- EWMA ----
  // returns: lợi suất ngày. Trả { sigmaNext (độ lệch chuẩn ngày dự báo cho phiên kế tiếp), annNext (%/năm), series (sigma dùng cho từng ngày t, đã biết tới t-1) }.
  function ewma(returns, lambda) {
    const lam = lambda > 0 && lambda < 1 ? lambda : 0.94, r = clean(returns || []);
    if (r.length < 2) return { sigmaNext: null, annNext: null, series: [], lambda: lam };
    const warm = Math.min(20, r.length);
    let v = variance(r.slice(0, warm)) || r[0] * r[0];
    const series = [];
    for (let t = 0; t < r.length; t++) {
      series.push(Math.sqrt(v));               // dự báo cho ngày t từ thông tin tới t-1
      v = lam * v + (1 - lam) * r[t] * r[t];
    }
    return { sigmaNext: Math.sqrt(v), annNext: Math.sqrt(v) * Math.sqrt(TD) * 100, series: series, lambda: lam };
  }

  // ---- OLS đa biến (có hệ số chặn) ----
  function solve(A, b) {                       // Gauss với chọn trụ
    const n = b.length, M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-14) return null;
      const tmp = M[c]; M[c] = M[p]; M[p] = tmp;
      for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k]; x[i] = s / M[i][i]; }
    return x;
  }
  function ols(y, cols) {                      // cols: các cột giải thích (không gồm hệ số chặn); trả [chặn, hệ số...]
    const n = y.length, k = cols.length + 1;
    const X = []; for (let t = 0; t < n; t++) X.push([1].concat(cols.map((c) => c[t])));
    const A = [], b = [];
    for (let i = 0; i < k; i++) { A.push(new Array(k).fill(0)); b.push(0); }
    for (let t = 0; t < n; t++) for (let i = 0; i < k; i++) { b[i] += X[t][i] * y[t]; for (let j = 0; j < k; j++) A[i][j] += X[t][i] * X[t][j]; }
    return solve(A, b);
  }

  // ---- beta Dimson ----
  // stock/bench: lợi suất ngày cùng độ dài, null = thiếu. lags/leads: số ngày trễ/dẫn của chỉ số (mặc định 1 và 1). Trả { beta (tổng các hệ số), simple (beta hồi quy thường), coefs, obs }.
  function dimsonBeta(stock, bench, lags, leads) {
    const L = lags === undefined ? 1 : lags, F = leads === undefined ? 1 : leads, n = Math.min((stock || []).length, (bench || []).length);
    const y = [], cols = []; for (let j = 0; j < L + F + 1; j++) cols.push([]);
    for (let t = L; t < n - F; t++) {
      const row = []; let ok = stock[t] !== null && stock[t] !== undefined;
      for (let s = -L; s <= F; s++) { const m = bench[t + s]; if (m === null || m === undefined || !isFinite(m)) { ok = false; break; } row.push(Number(m)); }
      if (!ok) continue;
      y.push(Number(stock[t])); row.forEach((v, j) => cols[j].push(v));
    }
    if (y.length < 30) return { beta: null, simple: null, coefs: null, obs: y.length };
    const full = ols(y, cols), simple = ols(y, [cols[L]]);
    if (!full || !simple) return { beta: null, simple: null, coefs: null, obs: y.length };
    return { beta: full.slice(1).reduce((s, v) => s + v, 0), simple: simple[1], coefs: full.slice(1), obs: y.length };
  }

  // ---- hiệp phương sai co về đường chéo (Ledoit-Wolf 2004) ----
  // X: ma trận lợi suất T x p (đã điền 0 chỗ thiếu). Trả { cov (p x p), sample, delta (cường độ co 0..1), mu }.
  function shrinkCov(X) {
    const T = X.length, p = T ? X[0].length : 0;
    if (T < 2 || p < 1) return null;
    const mu = []; for (let j = 0; j < p; j++) { let s = 0; for (let t = 0; t < T; t++) s += X[t][j]; mu.push(s / T); }
    const Z = X.map((row) => row.map((v, j) => v - mu[j]));
    const S = []; for (let i = 0; i < p; i++) { S.push(new Array(p).fill(0)); }
    for (let t = 0; t < T; t++) for (let i = 0; i < p; i++) for (let j = i; j < p; j++) S[i][j] += Z[t][i] * Z[t][j] / T;
    for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) S[i][j] = S[j][i];
    let tr = 0; for (let i = 0; i < p; i++) tr += S[i][i];
    const m = tr / p;
    let d2 = 0; for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { const d = S[i][j] - (i === j ? m : 0); d2 += d * d; }
    d2 /= p;
    let b2bar = 0;
    for (let t = 0; t < T; t++) { let s = 0; for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) { const d = Z[t][i] * Z[t][j] - S[i][j]; s += d * d; } b2bar += s; }
    b2bar = b2bar / (T * T) / p;
    const b2 = Math.min(b2bar, d2), delta = d2 > 0 ? b2 / d2 : 1;
    const cov = S.map((row, i) => row.map((v, j) => delta * (i === j ? m : 0) + (1 - delta) * v));
    // đổi về hiệp phương sai mẫu không chệch (chia T-1) cho cùng thang với phần còn lại của app
    const k = T / (T - 1);
    return { cov: cov.map((row) => row.map((v) => v * k)), sample: S.map((row) => row.map((v) => v * k)), delta: delta, mu: m * k };
  }

  // w: tỷ trọng trên NAV (phần còn lại là tiền mặt, không rủi ro). Trả { vol (ngày), annPct, contrib[], sharePct[] }
  function portfolioRisk(w, cov) {
    const p = w.length, Sw = []; for (let i = 0; i < p; i++) { let s = 0; for (let j = 0; j < p; j++) s += cov[i][j] * w[j]; Sw.push(s); }
    let v = 0; for (let i = 0; i < p; i++) v += w[i] * Sw[i];
    const vol = Math.sqrt(Math.max(0, v));
    const contrib = w.map((wi, i) => (vol > 0 ? wi * Sw[i] / vol : 0));
    return { vol: vol, annPct: vol * Math.sqrt(TD) * 100, contrib: contrib, sharePct: contrib.map((c) => (vol > 0 ? c / vol * 100 : 0)) };
  }

  // Tương quan co về 1 theo k (0 = giữ nguyên, 1 = mọi cặp tương quan hoàn hảo); giữ nguyên độ lệch chuẩn từng mã. Trả hiệp phương sai mới.
  function stressCov(cov, k) {
    const p = cov.length, sd = cov.map((row, i) => Math.sqrt(Math.max(0, row[i])));
    return cov.map((row, i) => row.map((v, j) => {
      if (i === j) return v;
      const rho = sd[i] > 0 && sd[j] > 0 ? v / (sd[i] * sd[j]) : 0;
      return (rho + k * (1 - rho)) * sd[i] * sd[j];
    }));
  }

  // ---- VaR mô phỏng lịch sử có lọc biến động ----
  // port: lợi suất ngày của danh mục. level 0,95. Trả { varPct, cvarPct, sigmaNext, quantileZ }.
  function filteredHS(port, opts) {
    const o = opts || {}, level = o.level > 0 && o.level < 1 ? o.level : 0.95, r = clean(port || []);
    if (r.length < 60) return null;
    const e = ewma(r, o.lambda);
    const z = r.map((x, t) => (e.series[t] > 0 ? x / e.series[t] : 0));
    const q = percentile(z, 1 - level), tail = z.filter((x) => x <= q);
    return { varPct: -q * e.sigmaNext * 100, cvarPct: tail.length ? -mean(tail) * e.sigmaNext * 100 : null, sigmaNext: e.sigmaNext, quantileZ: q };
  }

  // ---- kiểm định ngược VaR ----
  const xlogy = (x, y) => (x === 0 ? 0 : x * Math.log(y));
  // returns: lợi suất ngày; window: số ngày lịch sử dùng ước lượng VaR lịch sử cho ngày kế tiếp (mặc định 250). Trả { n, exceptions, expected, rate, kupiec, independence, conditional, verdict }
  function varBacktest(returns, opts) {
    const o = opts || {}, level = o.level > 0 && o.level < 1 ? o.level : 0.95, W = o.window > 20 ? o.window : 250, r = clean(returns || []), p = 1 - level;
    if (r.length < W + 30) return { ok: false, reason: 'short', need: W + 30, have: r.length };
    const hits = [];
    for (let t = W; t < r.length; t++) { const v = percentile(r.slice(t - W, t), p); hits.push(r[t] < v ? 1 : 0); }
    const n = hits.length, x = hits.reduce((s, h) => s + h, 0), pi = x / n;
    const lrPof = -2 * (xlogy(n - x, 1 - p) + xlogy(x, p)) + 2 * (xlogy(n - x, 1 - pi) + xlogy(x, pi));
    let n00 = 0, n01 = 0, n10 = 0, n11 = 0;
    for (let i = 1; i < n; i++) { if (hits[i - 1] === 0 && hits[i] === 0) n00++; else if (hits[i - 1] === 0) n01++; else if (hits[i] === 0) n10++; else n11++; }
    const pi01 = n00 + n01 > 0 ? n01 / (n00 + n01) : 0, pi11 = n10 + n11 > 0 ? n11 / (n10 + n11) : 0, piAll = (n01 + n11) / Math.max(1, n00 + n01 + n10 + n11);
    const lrInd = -2 * (xlogy(n00 + n10, 1 - piAll) + xlogy(n01 + n11, piAll)) + 2 * (xlogy(n00, 1 - pi01) + xlogy(n01, pi01) + xlogy(n10, 1 - pi11) + xlogy(n11, pi11));
    const lrCc = lrPof + Math.max(0, lrInd);
    const kup = { lr: lrPof, p: chi2Sf(lrPof, 1) }, ind = { lr: Math.max(0, lrInd), p: chi2Sf(Math.max(0, lrInd), 1) }, cc = { lr: lrCc, p: chi2Sf(lrCc, 2) };
    const verdict = kup.p < 0.05 ? (pi > p ? 'underestimates' : 'overestimates') : (ind.p < 0.05 ? 'clustered' : 'ok');
    return { ok: true, level: level, window: W, n: n, exceptions: x, expected: n * p, rate: pi, kupiec: kup, independence: ind, conditional: cc, transitions: { n00: n00, n01: n01, n10: n10, n11: n11 }, verdict: verdict };
  }

  // ---- gộp cho giao diện ----
  // model: { port (lợi suất ngày danh mục), bench, rets: { MÃ: [lợi suất ngày, null = thiếu] }, weights: { MÃ: tỷ trọng trên NAV }, nav }
  function summary(model, opts) {
    const m = model || {}, o = opts || {}, port = clean(m.port || []), syms = Object.keys(m.rets || {});
    if (port.length < 60 || !syms.length) return { ok: false, reason: 'short' };
    const out = { ok: true, obs: port.length };
    const sample = Math.sqrt(variance(port)), e = ewma(port, o.lambda);
    out.vol = { sampleAnn: sample * Math.sqrt(TD) * 100, ewmaAnn: e.annNext, ratio: sample > 0 ? e.sigmaNext / sample : null, lambda: e.lambda };
    out.fhs = filteredHS(port, { level: o.level, lambda: o.lambda });
    const hist = percentile(port, 1 - (o.level || 0.95)), tail = port.filter((x) => x <= hist);
    out.hist = { varPct: hist === null ? null : -hist * 100, cvarPct: tail.length ? -mean(tail) * 100 : null };
    out.param = { varPct: (1.645 * sample - mean(port)) * 100 };
    // cửa sổ ước lượng VaR: mặc định 250 phiên nếu đủ lịch sử, còn không thì ~45% số phiên (tối thiểu 60) để vẫn kiểm được -- ít phiên kiểm thì kết luận yếu hơn (UI nêu rõ)
    out.backtest = varBacktest(port, { level: o.level, window: o.window || Math.min(250, Math.max(60, Math.floor(port.length * 0.45))) });
    // beta từng mã
    if (m.bench && m.bench.length) {
      out.beta = syms.map((s) => { const d = dimsonBeta(m.rets[s], m.bench); return { symbol: s, dimson: d.beta, simple: d.simple, obs: d.obs }; });
    }
    // hiệp phương sai co và đóng góp rủi ro
    const used = syms.filter((s) => (m.weights || {})[s] > 0);
    if (used.length >= 2) {
      const T = port.length, X = []; for (let t = 0; t < T; t++) X.push(used.map((s) => { const v = m.rets[s][t]; return v === null || v === undefined || !isFinite(v) ? 0 : v; }));
      const sh = shrinkCov(X);
      if (sh) {
        const w = used.map((s) => m.weights[s]);
        const a = portfolioRisk(w, sh.sample), b = portfolioRisk(w, sh.cov);
        out.shrink = { delta: sh.delta, symbols: used, sampleAnn: a.annPct, shrunkAnn: b.annPct, sampleShare: a.sharePct, shrunkShare: b.sharePct };
        const k = o.stressK > 0 ? o.stressK : 0.5, c = portfolioRisk(w, stressCov(sh.cov, k));
        out.stressCorr = { k: k, annPct: c.annPct, multiplier: b.annPct > 0 ? c.annPct / b.annPct : null };
      }
    }
    return out;
  }

  return { TD, mean, variance, percentile, erfc, chi2Sf, ewma, ols, dimsonBeta, shrinkCov, portfolioRisk, stressCov, filteredHS, varBacktest, summary };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RiskModels;
