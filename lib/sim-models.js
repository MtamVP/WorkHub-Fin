// Logic thuần: CÁC MÔ HÌNH THỐNG KÊ cho Market Simulation (lib/market-sim.js dùng):
//   * Bộ sinh số ngẫu nhiên có hạt giống (xoshiro128**): cùng hạt giống -> cùng kết quả, để kiểm thử được và để so sánh các cách xử lý trên CÙNG một bộ đường giá.
//   * GJR-GARCH(1,1) ước lượng hợp lý cực đại (giả chuẩn, cố định phương sai dài hạn = phương sai mẫu): biến động thay đổi theo thời gian, cú giảm làm biến động tăng mạnh hơn cú tăng
//     (hiệu ứng đòn bẩy). Kết hợp lấy mẫu lại phần dư chuẩn hoá (FHS) thì giữ được đuôi dày thật của thị trường Việt Nam.
//   * Mô hình chuyển chế độ Markov (HMM Gauss K trạng thái, thuật toán Baum-Welch có chuẩn hoá): thị trường đổi "tính khí" (êm / bình thường / căng thẳng); chọn K bằng BIC.
//   * Mô hình nhân tố cho từng mã: lợi suất = beta (theo chế độ) x thị trường + phần riêng; phần riêng được lấy mẫu lại THEO NGÀY (cả hàng cùng ngày) để giữ tương quan chéo
//     giữa các mã cùng ngành mà không cần ước lượng ma trận lớn.
// Các công thức đối chiếu với lời giải độc lập trong tests/unit/sim-models.test.js (dữ liệu sinh từ chính mô hình với tham số biết trước phải ước lượng lại được).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường hoặc importScripts trong Web Worker (global SimModels) và module.exports cho Vitest.
const SimModels = (function () {
  const TD = 252;

  // ---------- số ngẫu nhiên ----------
  const rotl = (x, k) => (x << k) | (x >>> (32 - k));
  function splitmix32(seed) {
    let a = seed | 0;
    return function () { a = (a + 0x9e3779b9) | 0; let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad); t ^= t >>> 15; t = Math.imul(t, 0x735a2d97); return (t ^ (t >>> 15)) >>> 0; };
  }
  // Trả { u() đều trên (0,1), n() chuẩn tắc, int(k) số nguyên 0..k-1 }
  function rng(seed) {
    const sm = splitmix32((Number(seed) >>> 0) || 1);
    let a = sm(), b = sm(), c = sm(), d = sm();
    if (!(a | b | c | d)) a = 1;
    function next() {
      const r = Math.imul(rotl(Math.imul(b, 5), 7), 9), t = b << 9;
      c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11);
      return r >>> 0;
    }
    const u = () => (next() + 0.5) / 4294967296;
    let spare = null;
    function n() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let x, y, s;
      do { x = 2 * u() - 1; y = 2 * u() - 1; s = x * x + y * y; } while (s >= 1 || s === 0);
      const m = Math.sqrt(-2 * Math.log(s) / s); spare = y * m; return x * m;
    }
    return { u: u, n: n, int: (k) => Math.floor(u() * k) % k };
  }

  // ---------- thống kê cơ bản ----------
  const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; };
  function variance(a) { if (a.length < 2) return 0; const m = mean(a); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return s / (a.length - 1); }
  function quantileSorted(s, p) {          // nội suy tuyến tính như numpy.percentile; s đã sắp xếp tăng
    if (!s.length) return null;
    const idx = (s.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }
  const isNum = (v) => v !== null && v !== undefined && typeof v === 'number' && isFinite(v);

  // ---------- Nelder-Mead (tối ưu không cần đạo hàm, cho hàm ít biến) ----------
  function nelderMead(f, x0, opts) {
    const o = opts || {}, n = x0.length, maxIt = o.maxIter || 800, tol = o.tol || 1e-10, step = o.step || 0.1;
    let S = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] = x[i] !== 0 ? x[i] * (1 + step) : step * 0.25; S.push(x); }
    let F = S.map(f), it = 0;
    for (; it < maxIt; it++) {
      const ord = F.map((v, i) => i).sort((i, j) => F[i] - F[j]); S = ord.map((i) => S[i]); F = ord.map((i) => F[i]);
      if (Math.abs(F[n] - F[0]) <= tol * (Math.abs(F[0]) + 1e-12)) break;
      const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
      const pt = (t) => c.map((v, j) => v + t * (S[n][j] - v));
      const xr = pt(-1), fr = f(xr);
      if (fr < F[0]) { const xe = pt(-2), fe = f(xe); if (fe < fr) { S[n] = xe; F[n] = fe; } else { S[n] = xr; F[n] = fr; } continue; }
      if (fr < F[n - 1]) { S[n] = xr; F[n] = fr; continue; }
      const xc = fr < F[n] ? pt(-0.5) : pt(0.5), fc = f(xc);
      if (fc < Math.min(fr, F[n])) { S[n] = xc; F[n] = fc; continue; }
      for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); F[i] = f(S[i]); }
    }
    let b = 0; for (let i = 1; i <= n; i++) if (F[i] < F[b]) b = i;
    return { x: S[b], f: F[b], iterations: it };
  }

  // ---------- GJR-GARCH(1,1) ----------
  // r: lợi suất log ngày. sigma2_t = omega + (alpha + gamma * 1[e_{t-1} < 0]) * e_{t-1}^2 + beta * sigma2_{t-1}, omega cố định để phương sai dài hạn = phương sai mẫu.
  function garchFilter(e, v, a, g, b) {
    const omega = v * (1 - a - g / 2 - b), T = e.length, s2 = new Float64Array(T + 1);
    s2[0] = v;
    for (let t = 0; t < T; t++) s2[t + 1] = omega + (a + (e[t] < 0 ? g : 0)) * e[t] * e[t] + b * s2[t];
    return s2;
  }
  function fitGarch(r) {
    const x = Array.from(r || []).filter(isNum);
    if (x.length < 250) return null;
    const mu = mean(x), e = x.map((v) => v - mu), v = variance(x), T = e.length;
    const nll = (p) => {
      const a = p[0], g = p[1], b = p[2];
      if (!(a >= 0 && b >= 0 && a + g >= 0 && g > -a && a + g / 2 + b < 0.9995 && b < 0.9995)) return 1e12;
      const s2 = garchFilter(e, v, a, g, b);
      let L = 0; for (let t = 0; t < T; t++) { const s = Math.max(s2[t], 1e-12); L += Math.log(s) + e[t] * e[t] / s; }
      return 0.5 * L;
    };
    let best = null;
    [[0.05, 0.05, 0.88], [0.1, 0.05, 0.8], [0.03, 0.1, 0.9]].forEach((x0) => { const r0 = nelderMead(nll, x0, { maxIter: 900 }); if (!best || r0.f < best.f) best = r0; });
    const a = best.x[0], g = best.x[1], b = best.x[2], s2 = garchFilter(e, v, a, g, b);
    const z = new Float64Array(T); for (let t = 0; t < T; t++) z[t] = e[t] / Math.sqrt(Math.max(s2[t], 1e-12));
    // chuẩn hoá lại đúng trung bình 0, phương sai 1 để lấy mẫu lại không làm lệch phương sai mô hình
    const zm = mean(z), zs = Math.sqrt(variance(z)) || 1; for (let t = 0; t < T; t++) z[t] = (z[t] - zm) / zs;
    const persistence = a + g / 2 + b;
    return {
      kind: 'garch', mu: mu, omega: v * (1 - persistence), alpha: a, gamma: g, beta: b, persistence: persistence, uncondVar: v,
      sigma2Next: s2[T], volNextAnn: Math.sqrt(s2[T] * TD), volLongAnn: Math.sqrt(v * TD), halfLife: persistence > 0 && persistence < 1 ? Math.log(0.5) / Math.log(persistence) : null,
      z: z, s2: s2, nll: best.f, obs: T,
    };
  }
  // Lọc với tham số cố định trên chuỗi mới (dùng khi kiểm chứng: tham số ước lượng thưa, phương sai luôn lọc tới ngày gốc)
  function garchRefilter(model, r) {
    const x = Array.from(r || []).filter(isNum), e = x.map((v) => v - model.mu);
    const s2 = garchFilter(e, model.uncondVar, model.alpha, model.gamma, model.beta);
    return Object.assign({}, model, { sigma2Next: s2[e.length], volNextAnn: Math.sqrt(s2[e.length] * TD) });
  }

  // ---------- Mô hình chuyển chế độ Markov (HMM Gauss) ----------
  const SQ2PI = Math.sqrt(2 * Math.PI);
  const npdf = (x, m, s) => Math.exp(-0.5 * ((x - m) / s) * ((x - m) / s)) / (s * SQ2PI);
  function stationary(P) {
    const K = P.length; let pi = new Array(K).fill(1 / K);
    for (let it = 0; it < 2000; it++) {
      const nx = new Array(K).fill(0); for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) nx[j] += pi[i] * P[i][j];
      let d = 0; for (let j = 0; j < K; j++) d += Math.abs(nx[j] - pi[j]); pi = nx; if (d < 1e-13) break;
    }
    return pi;
  }
  // Lượt tiến có chuẩn hoá: trả { alpha (xác suất lọc T x K), c (hệ số chuẩn hoá), ll }
  function hmmForward(x, mu, sg, P, init) {
    const T = x.length, K = mu.length, alpha = new Array(T), c = new Float64Array(T);
    let prev = null, ll = 0;
    for (let t = 0; t < T; t++) {
      const a = new Array(K);
      for (let j = 0; j < K; j++) {
        let p = 0;
        if (t === 0) p = init[j]; else for (let i = 0; i < K; i++) p += prev[i] * P[i][j];
        a[j] = p * Math.max(npdf(x[t], mu[j], sg[j]), 1e-300);
      }
      let s = 0; for (let j = 0; j < K; j++) s += a[j];
      if (!(s > 0)) { for (let j = 0; j < K; j++) a[j] = 1 / K; s = 1e-300; } else for (let j = 0; j < K; j++) a[j] /= s;
      c[t] = s; ll += Math.log(s); alpha[t] = a; prev = a;
    }
    return { alpha: alpha, c: c, ll: ll };
  }
  function fitHmm(r, K, opts) {
    const o = opts || {}, x = Array.from(r || []).filter(isNum), T = x.length;
    if (T < 250 || !(K >= 2)) return null;
    // khởi tạo: chia ngày theo biến động 20 phiên quanh ngày đó (bậc phân vị)
    const vol = x.map((v, t) => { let s = 0, n = 0; for (let k = Math.max(0, t - 10); k < Math.min(T, t + 10); k++) { s += x[k] * x[k]; n++; } return Math.sqrt(s / n); });
    const sorted = vol.slice().sort((a, b) => a - b), cuts = []; for (let k = 1; k < K; k++) cuts.push(quantileSorted(sorted, k / K));
    const lab = vol.map((v) => { let k = 0; while (k < K - 1 && v > cuts[k]) k++; return k; });
    let mu = [], sg = [];
    for (let k = 0; k < K; k++) { const g = x.filter((v, t) => lab[t] === k); mu.push(mean(g)); sg.push(Math.max(Math.sqrt(variance(g)), 1e-4)); }
    let P = []; for (let i = 0; i < K; i++) { P.push(new Array(K).fill(0.03 / (K - 1))); P[i][i] = 0.97; }
    let init = new Array(K).fill(1 / K), llPrev = -Infinity, fw = null, gamma = null, it = 0;
    const maxIt = o.maxIter || 300;
    for (; it < maxIt; it++) {
      fw = hmmForward(x, mu, sg, P, init);
      // lượt lùi có chuẩn hoá
      const beta = new Array(T); beta[T - 1] = new Array(K).fill(1);
      for (let t = T - 2; t >= 0; t--) {
        const b = new Array(K).fill(0), e = new Array(K);
        for (let j = 0; j < K; j++) e[j] = Math.max(npdf(x[t + 1], mu[j], sg[j]), 1e-300) * beta[t + 1][j];
        for (let i = 0; i < K; i++) { let s = 0; for (let j = 0; j < K; j++) s += P[i][j] * e[j]; b[i] = s / fw.c[t + 1]; }
        beta[t] = b;
      }
      gamma = new Array(T); const xi = []; for (let i = 0; i < K; i++) xi.push(new Array(K).fill(0));
      for (let t = 0; t < T; t++) {
        const g = new Array(K); let s = 0; for (let k = 0; k < K; k++) { g[k] = fw.alpha[t][k] * beta[t][k]; s += g[k]; }
        for (let k = 0; k < K; k++) g[k] = s > 0 ? g[k] / s : 1 / K; gamma[t] = g;
        if (t < T - 1) for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) xi[i][j] += fw.alpha[t][i] * P[i][j] * Math.max(npdf(x[t + 1], mu[j], sg[j]), 1e-300) * beta[t + 1][j] / fw.c[t + 1];
      }
      // cập nhật
      for (let k = 0; k < K; k++) {
        let w = 0, m = 0; for (let t = 0; t < T; t++) { w += gamma[t][k]; m += gamma[t][k] * x[t]; }
        m = w > 0 ? m / w : 0;
        let v = 0; for (let t = 0; t < T; t++) v += gamma[t][k] * (x[t] - m) * (x[t] - m);
        mu[k] = m; sg[k] = Math.max(Math.sqrt(w > 0 ? v / w : 0), 1e-4);
      }
      for (let i = 0; i < K; i++) { let s = 0; for (let j = 0; j < K; j++) s += xi[i][j]; for (let j = 0; j < K; j++) P[i][j] = s > 0 ? Math.max(xi[i][j] / s, 1e-6) : 1 / K; const s2 = P[i].reduce((a, b) => a + b, 0); P[i] = P[i].map((v) => v / s2); }
      init = gamma[0].slice();
      if (Math.abs(fw.ll - llPrev) < 1e-8 * T) break;
      llPrev = fw.ll;
    }
    fw = hmmForward(x, mu, sg, P, init);
    // sắp trạng thái theo biến động tăng dần: 0 = êm nhất
    const ord = mu.map((v, k) => k).sort((a, b) => sg[a] - sg[b]);
    const re = (arr) => ord.map((k) => arr[k]);
    const P2 = ord.map((i) => ord.map((j) => P[i][j]));
    const gam = gamma.map((g) => re(g)), filt = fw.alpha.map((a) => re(a));
    const nPar = K * 2 + K * (K - 1) + (K - 1);
    const muR = re(mu), sgR = re(sg);
    return {
      kind: 'hmm', K: K, mu: muR, sigma: sgR, P: P2, stationary: stationary(P2), ll: fw.ll, bic: -2 * fw.ll + nPar * Math.log(T), obs: T, iterations: it,
      smoothed: gam, filtered: filt, current: filt[T - 1].slice(),
      state: gam.map((g) => { let b = 0; for (let k = 1; k < K; k++) if (g[k] > g[b]) b = k; return b; }),
      durations: P2.map((row, k) => (row[k] < 1 ? 1 / (1 - row[k]) : null)),
    };
  }
  // Chọn K trong danh sách theo BIC nhỏ nhất (mặc định thử 2 và 3)
  function fitHmmBest(r, Ks) {
    let best = null; const tried = [];
    (Ks || [2, 3]).forEach((K) => { const m = fitHmm(r, K); if (m) { tried.push({ K: K, bic: m.bic, ll: m.ll }); if (!best || m.bic < best.bic) best = m; } });
    if (best) best.tried = tried;
    return best;
  }
  // Lọc xác suất trạng thái tới cuối chuỗi mới với tham số cố định
  function hmmRefilter(model, r) {
    const x = Array.from(r || []).filter(isNum), fw = hmmForward(x, model.mu, model.sigma, model.P, model.stationary);
    return Object.assign({}, model, { current: fw.alpha[x.length - 1].slice() });
  }

  // ---------- mô hình nhân tố cho từng mã ----------
  // mkt: lợi suất log thị trường (độ dài T); stocks: { MÃ: lợi suất log độ dài T, null = thiếu }; state: trạng thái cứng từng ngày (0..K-1) hoặc null (một trạng thái).
  // Trả { syms, beta[i], betaK[i][k], alpha[i], resid (Float64Array T*N, NaN = thiếu), scale (Float64Array T*N: độ lệch riêng EWMA lúc đó), sNow[i], obs[i], idioAnn[i] }
  function fitFactors(mkt, stocks, state, K, opts) {
    const o = opts || {}, syms = Object.keys(stocks || {}), N = syms.length, T = mkt.length, KK = K || 1, prior = o.betaPrior === undefined ? 120 : o.betaPrior;
    const resid = new Float64Array(T * N).fill(NaN), scale = new Float64Array(T * N).fill(NaN);
    const beta = [], betaK = [], alpha = [], sNow = [], obs = [], idioAnn = [];
    syms.forEach((s, i) => {
      const y = stocks[s];
      const ols = (filter) => {
        let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let t = 0; t < T; t++) { const v = y[t], m = mkt[t]; if (!isNum(v) || !isNum(m) || !filter(t)) continue; n++; sx += m; sy += v; sxx += m * m; sxy += m * v; }
        if (n < 3) return { n: n, a: 0, b: null };
        const d = n * sxx - sx * sx; const b = d > 0 ? (n * sxy - sx * sy) / d : null; return { n: n, a: b === null ? sy / n : (sy - b * sx) / n, b: b };
      };
      const all = ols(() => true);
      // beta toàn kỳ co về 1 (ít quan sát thì tin 1 hơn); beta từng chế độ co về beta toàn kỳ
      const bAll = all.b === null || all.n < 60 ? 1 : (all.n * all.b + 60 * 1) / (all.n + 60);
      const bk = [];
      for (let k = 0; k < KK; k++) {
        const r = state ? ols((t) => state[t] === k) : all;
        bk.push(r.b === null ? bAll : (r.n * r.b + prior * bAll) / (r.n + prior));
      }
      beta.push(bAll); betaK.push(bk); alpha.push(all.a); obs.push(all.n);
      // phần dư và độ lệch EWMA của phần dư
      let v = null; const lam = 0.94, list = [];
      for (let t = 0; t < T; t++) {
        const yy = y[t], m = mkt[t];
        if (!isNum(yy) || !isNum(m)) continue;
        const k = state ? state[t] : 0, e = yy - all.a - bk[k] * m;
        if (v === null) v = e * e || 1e-4;
        resid[t * N + i] = e; scale[t * N + i] = Math.sqrt(v); list.push(e);
        v = lam * v + (1 - lam) * e * e;
      }
      sNow.push(v === null ? null : Math.sqrt(v)); idioAnn.push(list.length > 1 ? Math.sqrt(variance(list) * TD) : null);
    });
    return { syms: syms, N: N, T: T, K: KK, beta: beta, betaK: betaK, alpha: alpha, resid: resid, scale: scale, sNow: sNow, obs: obs, idioAnn: idioAnn };
  }

  return { TD, rng, mean, variance, quantileSorted, nelderMead, garchFilter, fitGarch, garchRefilter, npdf, stationary, hmmForward, fitHmm, fitHmmBest, hmmRefilter, fitFactors };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SimModels;
