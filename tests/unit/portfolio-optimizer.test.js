// lib/portfolio-optimizer.js: đối chiếu với lời giải độc lập scipy.optimize SLSQP (tests/fixtures/optimizer-golden.json) và các tính chất cần có.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PO from '../../lib/portfolio-optimizer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(readFileSync(path.join(here, '../fixtures/optimizer-golden.json'), 'utf8'));
const sum = (a) => a.reduce((s, x) => s + x, 0);
const fill = (n, v) => new Array(n).fill(v);

describe('chiếu lên đơn hình có chặn', () => {
  it('tổng = 1, trong cận; điểm đã khả thi thì giữ nguyên', () => {
    const w = PO.project([0.9, 0.5, -0.3, 0.1], fill(4, 0), fill(4, 0.5));
    expect(sum(w)).toBeCloseTo(1, 12); w.forEach((x) => { expect(x).toBeGreaterThanOrEqual(-1e-12); expect(x).toBeLessThanOrEqual(0.5 + 1e-12); });
    PO.project([0.25, 0.25, 0.25, 0.25], fill(4, 0), fill(4, 1)).forEach((x) => expect(x).toBeCloseTo(0.25, 12));
  });
  it('không khả thi (tổng cận trên < 1 hoặc tổng cận dưới > 1) -> null', () => {
    expect(PO.project([1, 1, 1], fill(3, 0), fill(3, 0.3))).toBeNull();
    expect(PO.project([1, 1, 1], fill(3, 0.4), fill(3, 1))).toBeNull();
  });
});

describe('khớp scipy SLSQP', () => {
  G.cases.forEach((c) => {
    const lo = fill(c.n, c.lo), hi = fill(c.n, c.hi);
    it(`${c.n} mã, cận [${c.lo}; ${c.hi}]: phương sai nhỏ nhất`, () => {
      const w = PO.minVariance(c.C, lo, hi);
      expect(sum(w)).toBeCloseTo(1, 10);
      const vol = PO.stats(w, c.C).vol;
      expect(vol).toBeLessThanOrEqual(c.minvar.vol + 1e-7);                     // không tệ hơn scipy
      expect(vol).toBeCloseTo(c.minvar.vol, 6);
      w.forEach((x, i) => expect(x).toBeCloseTo(c.minvar.w[i], 3));
    });
    it(`${c.n} mã, cận [${c.lo}; ${c.hi}]: Sharpe tối đa`, () => {
      const r = PO.maxSharpe(c.mu, c.C, c.rf, lo, hi);
      expect(r.sharpe).toBeGreaterThanOrEqual(c.maxsharpe.sharpe - 1e-5);
      expect(r.sharpe).toBeCloseTo(c.maxsharpe.sharpe, 4);
      r.w.forEach((x, i) => { expect(x).toBeGreaterThanOrEqual(c.lo - 1e-9); expect(x).toBeLessThanOrEqual(c.hi + 1e-9); });
    });
    it(`${c.n} mã: cân bằng rủi ro không chặn khớp scipy và mọi mã đóng góp rủi ro bằng nhau`, () => {
      const r = PO.riskParity(c.C, fill(c.n, 0), fill(c.n, 1));
      expect(r.capped).toBe(false);
      r.w.forEach((x, i) => expect(x).toBeCloseTo(c.erc.w[i], 4));
      PO.stats(r.w, c.C).riskShare.forEach((s) => expect(s).toBeCloseTo(1 / c.n, 8));
    });
  });
});

describe('tính chất', () => {
  const C = [[0.09, 0.01, 0.0], [0.01, 0.04, 0.0], [0.0, 0.0, 0.01]];        // biến động 30%, 20%, 10%; hai mã đầu tương quan nhẹ
  it('hai mã độc lập không chặn: phương sai nhỏ nhất tỷ trọng tỷ lệ nghịch phương sai', () => {
    const w = PO.minVariance([[0.04, 0], [0, 0.01]], [0, 0], [1, 1]);
    expect(w[0]).toBeCloseTo(0.2, 9); expect(w[1]).toBeCloseTo(0.8, 9);        // (1/0,04) / (1/0,04 + 1/0,01)
  });
  it('cận trên chặn được mã ít biến động nhất', () => {
    const w = PO.minVariance(C, fill(3, 0), fill(3, 0.5));
    expect(w[2]).toBeCloseTo(0.5, 9); expect(sum(w)).toBeCloseTo(1, 12);
  });
  it('cân bằng rủi ro bị chặn thì báo capped và vẫn trong cận', () => {
    const r = PO.riskParity(C, fill(3, 0), fill(3, 0.4));
    expect(r.capped).toBe(true); r.w.forEach((x) => expect(x).toBeLessThanOrEqual(0.4 + 1e-9)); expect(sum(r.w)).toBeCloseTo(1, 10);
  });
  it('Sharpe tối đa: mọi lợi nhuận kỳ vọng không vượt lãi phi rủi ro -> null; mã kỳ vọng cao hơn được tỷ trọng cao hơn khi rủi ro như nhau', () => {
    expect(PO.maxSharpe([0.01, 0.02, 0.03], C, 0.03, fill(3, 0), fill(3, 1))).toBeNull();
    const eq = [[0.04, 0, 0], [0, 0.04, 0], [0, 0, 0.04]];
    const r = PO.maxSharpe([0.08, 0.12, 0.16], eq, 0.03, fill(3, 0), fill(3, 1));
    expect(r.w[2]).toBeGreaterThan(r.w[1]); expect(r.w[1]).toBeGreaterThan(r.w[0]);
    // nghiệm giải tích không chặn: w ∝ C⁻¹(μ−rf) = (0,05; 0,09; 0,13)/0,27
    expect(r.w[0]).toBeCloseTo(0.05 / 0.27, 4); expect(r.w[2]).toBeCloseTo(0.13 / 0.27, 4);
  });
  it('lợi nhuận kỳ vọng từ giá trị hợp lý: đóng dần trong 2 năm, co một nửa về 9%, chặn [-30%; 40%]', () => {
    expect(PO.expectedFromFair(100, 121, 2, 0.09, 0.5)).toBeCloseTo(0.5 * 0.1 + 0.5 * 0.09, 12);    // √1,21 − 1 = 10%
    expect(PO.expectedFromFair(100, 400, 2, 0.09, 0.5)).toBe(0.4);
    expect(PO.expectedFromFair(100, 10, 2, 0.09, 1)).toBe(-0.3);
    expect(PO.expectedFromFair(0, 100)).toBeNull(); expect(PO.expectedFromFair(100, null)).toBeNull();
  });
});

describe('optimize + orders', () => {
  // 3 mã, 120 phiên lợi suất giả có cấu trúc: A biến động mạnh, C ít biến động
  const rnd = (seed) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; }; };
  const ra = rnd(7), rb = rnd(11), rc = rnd(13);
  const rets = { AAA: [], BBB: [], CCC: [] };
  for (let t = 0; t < 120; t++) { const m = ra() * 0.01; rets.AAA.push(m + ra() * 0.06); rets.BBB.push(m + rb() * 0.03); rets.CCC.push(rc() * 0.012); }
  const values = { AAA: 600e6, BBB: 300e6, CCC: 100e6 };
  it('phương sai nhỏ nhất giảm biến động so với hiện tại, tôn trọng cận trên, tính tỷ lệ quay vòng', () => {
    const r = PO.optimize({ symbols: ['AAA', 'BBB', 'CCC'], rets, values, maxPct: 0.6, method: 'minvar' });
    expect(r.ok).toBe(true);
    expect(r.current.map((x) => +x.toFixed(2))).toEqual([0.6, 0.3, 0.1]);
    expect(r.next.vol).toBeLessThan(r.now.vol);
    r.weights.forEach((x) => expect(x).toBeLessThanOrEqual(0.6 + 1e-9));
    expect(r.turnover).toBeCloseTo(r.weights.reduce((s, x, i) => s + Math.abs(x - r.current[i]), 0) / 2, 12);
    expect(r.obs).toBe(120);
  });
  it('báo lỗi rõ: ít mã, thiếu lịch sử, cận không khả thi, Sharpe thiếu lợi nhuận kỳ vọng', () => {
    expect(PO.optimize({ symbols: ['AAA'], rets, values }).reason).toBe('few');
    expect(PO.optimize({ symbols: ['AAA', 'BBB'], rets: { AAA: rets.AAA.slice(0, 30), BBB: rets.BBB.slice(0, 30) }, values }).reason).toBe('short');
    expect(PO.optimize({ symbols: ['AAA', 'BBB', 'CCC'], rets, values, maxPct: 0.3 }).reason).toBe('infeasible');      // 3 x 30% < 100%
    expect(PO.optimize({ symbols: ['AAA', 'BBB', 'CCC'], rets, values, method: 'maxsharpe', mu: { AAA: 0.1, BBB: 0.12 } }).reason).toBe('no-mu');
    expect(PO.optimize({ symbols: ['AAA', 'BBB', 'CCC'], rets, values, method: 'maxsharpe', mu: { AAA: 0.01, BBB: 0.01, CCC: 0.01 }, rf: 0.03 }).reason).toBe('mu-below-rf');
  });
  it('lệnh: giữ tổng giá trị cổ phiếu, khối lượng làm tròn lô 100, đúng chiều mua/bán', () => {
    const r = PO.optimize({ symbols: ['AAA', 'BBB', 'CCC'], rets, values, maxPct: 0.6, method: 'riskparity' });
    const od = PO.orders(r, [{ symbol: 'AAA', value: 600e6, quantity: 20000 }, { symbol: 'BBB', value: 300e6, quantity: 10000 }, { symbol: 'CCC', value: 100e6, quantity: 5000 }]);
    expect(sum(od.map((x) => x.target))).toBeCloseTo(1000e6, 0);
    expect(sum(od.map((x) => x.delta))).toBeCloseTo(0, 0);
    od.forEach((x) => { expect(x.shares % 100 === 0).toBe(true); if (x.shares) expect(x.side).toBe(x.shares > 0 ? 'buy' : 'sell'); });
    const a = od.find((x) => x.symbol === 'AAA');
    expect(a.price).toBe(30000);
    expect(a.shares).toBe(Math.round(a.delta / 30000 / 100) * 100);
    expect(a.side).toBe('sell');                                               // mã biến động mạnh nhất, đang 60% -> giảm
  });
});

describe('optimize dùng hiệp phương sai CO (Ledoit-Wolf), không phải mẫu', () => {
  it('biến động đề xuất khớp tính lại độc lập bằng RiskModels.shrinkCov x 252', async () => {
    const RM = (await import('../../lib/risk-models.js')).default;
    const rnd = (seed) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; }; };
    const a = rnd(3), b = rnd(5), c = rnd(9), rets = { A: [], B: [], C: [] };
    for (let t = 0; t < 70; t++) { const m = a() * 0.02; rets.A.push(m + a() * 0.04); rets.B.push(m + b() * 0.02); rets.C.push(c() * 0.03); }      // ít phiên: co mạnh
    const r = PO.optimize({ symbols: ['A', 'B', 'C'], rets, values: { A: 1, B: 1, C: 1 }, method: 'minvar' });
    const X = []; for (let t = 0; t < 70; t++) X.push([rets.A[t], rets.B[t], rets.C[t]]);
    const sh = RM.shrinkCov(X), C = sh.cov.map((row) => row.map((v) => v * 252)), S = sh.sample.map((row) => row.map((v) => v * 252));
    expect(sh.delta).toBeGreaterThan(0.05);
    expect(r.next.vol).toBeCloseTo(PO.stats(r.weights, C).vol, 10);
    expect(Math.abs(PO.stats(r.weights, S).vol - r.next.vol)).toBeGreaterThan(1e-6);
    expect(r.shrink).toBeCloseTo(sh.delta, 12);
  });
});
