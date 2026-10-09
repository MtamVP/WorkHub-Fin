// lib/sim-models.js: số ngẫu nhiên có hạt giống, Nelder-Mead, GJR-GARCH, HMM Gauss (Baum-Welch), mô hình nhân tố.
// Kiểm bằng lời giải độc lập: log-likelihood HMM so với phép cộng vét cạn mọi chuỗi trạng thái; tham số ước lượng lại từ dữ liệu sinh với tham số biết trước.
import { describe, it, expect } from 'vitest';
import SM from '../../lib/sim-models.js';

function garchData(n, a, g, b, v, mu, seed) {
  const R = SM.rng(seed), om = v * (1 - a - g / 2 - b), r = []; let s2 = v;
  for (let t = 0; t < n; t++) { const e = Math.sqrt(s2) * R.n(); r.push(mu + e); s2 = om + (a + (e < 0 ? g : 0)) * e * e + b * s2; }
  return r;
}
function hmmData(n, mu, sg, P, seed) {
  const R = SM.rng(seed), x = [], st = []; let s = 0;
  for (let t = 0; t < n; t++) { if (t) { const u = R.u(); let c = 0, ns = P.length - 1; for (let k = 0; k < P.length; k++) { c += P[s][k]; if (u < c) { ns = k; break; } } s = ns; } st.push(s); x.push(mu[s] + sg[s] * R.n()); }
  return { x, st };
}

describe('rng', () => {
  it('cùng hạt giống -> cùng chuỗi; khác hạt giống -> khác', () => {
    const a = SM.rng(42), b = SM.rng(42), c = SM.rng(43);
    const xa = [a.u(), a.u(), a.n()], xb = [b.u(), b.u(), b.n()], xc = [c.u(), c.u(), c.n()];
    expect(xa).toEqual(xb); expect(xa).not.toEqual(xc);
  });
  it('u() trong (0,1), n() có trung bình 0 phương sai 1, int(k) trong 0..k-1', () => {
    const R = SM.rng(7), z = []; let lo = 1, hi = 0;
    for (let i = 0; i < 200000; i++) { const u = R.u(); lo = Math.min(lo, u); hi = Math.max(hi, u); z.push(R.n()); }
    expect(lo).toBeGreaterThan(0); expect(hi).toBeLessThan(1);
    expect(Math.abs(SM.mean(z))).toBeLessThan(0.01); expect(Math.abs(SM.variance(z) - 1)).toBeLessThan(0.015);
    const counts = [0, 0, 0]; for (let i = 0; i < 30000; i++) counts[R.int(3)]++;
    counts.forEach((c) => expect(Math.abs(c / 30000 - 1 / 3)).toBeLessThan(0.015));
  });
});

describe('nelderMead / quantile', () => {
  it('tìm cực tiểu hàm Rosenbrock', () => {
    const r = SM.nelderMead((p) => 100 * (p[1] - p[0] * p[0]) ** 2 + (1 - p[0]) ** 2, [-1.2, 1], { maxIter: 4000, tol: 1e-14 });
    expect(r.x[0]).toBeCloseTo(1, 3); expect(r.x[1]).toBeCloseTo(1, 3);
  });
  it('quantileSorted nội suy như numpy.percentile', () => {
    expect(SM.quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(SM.quantileSorted([10, 20, 30, 40, 50], 0.1)).toBeCloseTo(14, 10);
  });
});

describe('GJR-GARCH', () => {
  const a = 0.05, g = 0.1, b = 0.85, v = 0.00016, r = garchData(6000, a, g, b, v, 0.0004, 11);
  const m = SM.fitGarch(r);
  it('ước lượng lại tham số gần giá trị thật (6.000 phiên)', () => {
    expect(m.alpha).toBeGreaterThan(0.02); expect(m.alpha).toBeLessThan(0.09);
    expect(m.gamma).toBeGreaterThan(0.04); expect(m.gamma).toBeLessThan(0.18);
    expect(m.beta).toBeGreaterThan(0.79); expect(m.beta).toBeLessThan(0.91);
    expect(m.persistence).toBeLessThan(1);
  });
  it('nghiệm là cực tiểu: lệch tham số làm hàm mục tiêu tệ hơn', () => {
    const e = r.map((x) => x - m.mu), V = SM.variance(r);
    const nll = (aa, gg, bb) => { const s2 = SM.garchFilter(e, V, aa, gg, bb); let L = 0; for (let t = 0; t < e.length; t++) L += Math.log(s2[t]) + e[t] * e[t] / s2[t]; return 0.5 * L; };
    const base = nll(m.alpha, m.gamma, m.beta);
    expect(base).toBeCloseTo(m.nll, 6);
    [[0.01, 0, 0], [-0.01, 0, 0], [0, 0.02, 0], [0, -0.02, 0], [0, 0, 0.01], [0, 0, -0.01]].forEach((d) => expect(nll(m.alpha + d[0], m.gamma + d[1], m.beta + d[2])).toBeGreaterThan(base));
  });
  it('phần dư chuẩn hoá có trung bình 0, phương sai 1; omega khớp phương sai dài hạn', () => {
    expect(Math.abs(SM.mean(m.z))).toBeLessThan(1e-10); expect(SM.variance(m.z)).toBeCloseTo(1, 8);
    expect(m.omega / (1 - m.persistence)).toBeCloseTo(m.uncondVar, 12);
  });
  it('ít hơn 250 phiên: null; lọc lại với tham số cố định cho cùng sigma2Next', () => {
    expect(SM.fitGarch(r.slice(0, 200))).toBeNull();
    expect(SM.garchRefilter(m, r).sigma2Next).toBeCloseTo(m.sigma2Next, 14);
  });
});

describe('HMM Gauss', () => {
  it('lượt tiến khớp phép cộng vét cạn mọi chuỗi trạng thái (T = 7, K = 2)', () => {
    const x = [0.01, -0.02, 0.003, 0.04, -0.035, 0.0, 0.012], mu = [0.001, -0.004], sg = [0.01, 0.03], P = [[0.9, 0.1], [0.2, 0.8]], init = [0.6, 0.4];
    let total = 0;
    for (let mask = 0; mask < 1 << x.length; mask++) {
      let p = 1; for (let t = 0; t < x.length; t++) { const s = (mask >> t) & 1, prev = t ? (mask >> (t - 1)) & 1 : null; p *= (t ? P[prev][s] : init[s]) * SM.npdf(x[t], mu[s], sg[s]); }
      total += p;
    }
    expect(SM.hmmForward(x, mu, sg, P, init).ll).toBeCloseTo(Math.log(total), 10);
  });
  it('Baum-Welch ước lượng lại hai chế độ từ dữ liệu sinh', () => {
    const d = hmmData(4000, [0.0008, -0.002], [0.008, 0.022], [[0.98, 0.02], [0.06, 0.94]], 5);
    const m = SM.fitHmm(d.x, 2);
    expect(m.sigma[0]).toBeCloseTo(0.008, 3); expect(m.sigma[1]).toBeCloseTo(0.022, 2);
    expect(m.P[0][0]).toBeGreaterThan(0.96); expect(m.P[1][1]).toBeGreaterThan(0.9);
    const hit = d.st.filter((s, t) => s === m.state[t]).length / d.st.length;
    expect(hit).toBeGreaterThan(0.9);
    m.smoothed.slice(0, 50).forEach((g) => expect(g.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10));
    expect(m.stationary.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
  it('BIC chọn 2 trạng thái khi dữ liệu thật sự có 2', () => {
    const d = hmmData(3000, [0.001, -0.002], [0.007, 0.02], [[0.98, 0.02], [0.05, 0.95]], 9);
    expect(SM.fitHmmBest(d.x, [2, 3]).K).toBe(2);
  });
  it('trạng thái sắp theo biến động tăng dần; phân phối dừng là nghiệm của pi P = pi', () => {
    const d = hmmData(2500, [0.0, 0.0, -0.003], [0.005, 0.012, 0.03], [[0.97, 0.025, 0.005], [0.03, 0.95, 0.02], [0.02, 0.08, 0.9]], 3);
    const m = SM.fitHmm(d.x, 3);
    expect(m.sigma[0]).toBeLessThan(m.sigma[1]); expect(m.sigma[1]).toBeLessThan(m.sigma[2]);
    const pi = m.stationary; for (let j = 0; j < 3; j++) { let s = 0; for (let i = 0; i < 3; i++) s += pi[i] * m.P[i][j]; expect(s).toBeCloseTo(pi[j], 10); }
  });
});

describe('mô hình nhân tố', () => {
  it('ước lượng lại beta và phần dư; beta theo chế độ co về beta chung', () => {
    const R = SM.rng(2), T = 1500, mkt = [], a = [], b = [], state = [];
    for (let t = 0; t < T; t++) { const s = t % 10 < 8 ? 0 : 1; state.push(s); const m = (s ? 0.02 : 0.008) * R.n(); mkt.push(m); a.push(1.3 * m + 0.01 * R.n()); b.push(t < 100 ? null : (s ? 1.6 : 0.6) * m + 0.012 * R.n()); }
    const f = SM.fitFactors(mkt, { AAA: a, BBB: b }, state, 2);
    // sai số chuẩn của beta chế độ êm ~0,036 (nhiễu 0,01 / (0,008 x căn 1200)): cho phép 3 sai số chuẩn
    expect(Math.abs(f.beta[0] - 1.3)).toBeLessThan(0.06); expect(Math.abs(f.betaK[0][0] - 1.3)).toBeLessThan(0.11); expect(Math.abs(f.betaK[0][1] - 1.3)).toBeLessThan(0.11);
    expect(f.betaK[1][1]).toBeGreaterThan(f.betaK[1][0] + 0.6);
    expect(Number.isNaN(f.resid[5 * 2 + 1])).toBe(true);            // BBB chưa giao dịch: phần dư trống
    expect(f.resid[500 * 2 + 0]).toBeCloseTo(a[500] - f.alpha[0] - f.betaK[0][state[500]] * mkt[500], 12);
    expect(f.idioAnn[0]).toBeCloseTo(0.01 * Math.sqrt(252), 1);
  });
});
