// lib/valuation-models.js: chi phí vốn, P/B hợp lý, thu nhập thặng dư, FCFE nhiều giai đoạn, định giá ngược, nhạy cảm, điểm chất lượng, đối chiếu độc lập.
// Đối chiếu với phép tính Python độc lập (tests/fixtures/valuation-golden.json) và các đồng nhất thức đóng.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import VM from '../../lib/valuation-models.js';

const G = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/valuation-golden.json'), 'utf8'));
const near = (a, b, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)));

describe('chi phí vốn (CAPM)', () => {
  it('Ke = rf + beta Blume x ERP + phần bù khác', () => {
    const k = VM.costOfEquity({ rf: 0.0459, beta: 0.74, erp: 0.08 });
    near(k.betaUsed, 0.67 * 0.74 + 0.33, 1e-12);
    near(k.ke, 0.0459 + (0.67 * 0.74 + 0.33) * 0.08, 1e-12);
    near(VM.costOfEquity({ rf: 0.05, beta: 1.2, erp: 0.07, betaAdjust: false, extra: 0.01 }).ke, 0.05 + 1.2 * 0.07 + 0.01, 1e-12);
    expect(VM.costOfEquity({ rf: 0.05, erp: 0.07 })).toBeNull();
    expect(VM.costOfEquity({ rf: 'x', beta: 1, erp: 0.07 })).toBeNull();
  });
});

describe('P/B hợp lý', () => {
  it('(ROE - g) / (Ke - g), nhân với BVPS; Ke <= g thì không tính', () => {
    const r = VM.justifiedPB({ roe: 0.18, g: 0.05, ke: 0.105, bvps: 29000 });
    near(r.pb, (0.18 - 0.05) / (0.105 - 0.05), 1e-12);
    near(r.fair, r.pb * 29000, 1e-9);
    expect(VM.justifiedPB({ roe: 0.18, g: 0.11, ke: 0.105, bvps: 1 })).toEqual({ ok: false, reason: 'ke<=g' });
    expect(VM.justifiedPB({ roe: 0.18 })).toBeNull();
    expect(VM.justifiedPB({ roe: 0.105, g: 0.05, ke: 0.105, bvps: 100 }).pb).toBeCloseTo(1, 12);          // ROE = Ke -> P/B = 1
  });
});

describe('thu nhập thặng dư', () => {
  it('khớp phép tính Python độc lập trên 3 bộ tham số', () => {
    G.ri.forEach((c) => {
      const r = VM.residualIncome({ bvps: c.in.bvps, roe: c.in.roe, roeTerminal: c.in.roe_t, ke: c.in.ke, g: c.in.g, payout: c.in.payout, years: c.in.N });
      near(r.value, c.value, 1e-9); near(r.pvRi, c.pv, 1e-9); near(r.tvPv, c.tv, 1e-9);
      expect(r.rows).toHaveLength(c.in.N);
    });
  });
  it('ROE luôn bằng Ke (không có lợi nhuận vượt chi phí vốn) thì giá trị đúng bằng giá trị sổ sách', () => {
    const r = VM.residualIncome({ bvps: 20000, roe: 0.11, roeTerminal: 0.11, ke: 0.11, g: 0.04, payout: 0.3 });
    near(r.value, 20000, 1e-9);
    expect(r.terminalSharePct).toBeCloseTo(0, 9);
  });
  it('ROE vượt Ke thì giá trị lớn hơn sổ sách; ROE dưới Ke thì nhỏ hơn; Ke <= g hoặc thiếu dữ liệu: không tính', () => {
    expect(VM.residualIncome({ bvps: 20000, roe: 0.20, ke: 0.11, g: 0.04 }).value).toBeGreaterThan(20000);
    expect(VM.residualIncome({ bvps: 20000, roe: 0.06, roeTerminal: 0.06, ke: 0.11, g: 0.04 }).value).toBeLessThan(20000);
    expect(VM.residualIncome({ bvps: 20000, roe: 0.20, ke: 0.04, g: 0.05 })).toEqual({ ok: false, reason: 'ke<=g' });
    expect(VM.residualIncome({ bvps: 0, roe: 0.2, ke: 0.1 })).toBeNull();
  });
});

describe('FCFE nhiều giai đoạn', () => {
  it('khớp phép tính Python độc lập trên 3 bộ tham số', () => {
    G.fcfe.forEach((c) => {
      const r = VM.fcfe({ eps0: c.in.eps0, roe: c.in.roe, roeTerminal: c.in.roe_t, ke: c.in.ke, g1: c.in.g1, years1: c.in.N1, fadeYears: c.in.N2, gT: c.in.gT });
      near(r.value, c.value, 1e-9); near(r.pvFcfe, c.pv, 1e-9); near(r.tvPv, c.tv, 1e-9);
    });
  });
  it('đồng nhất thức Gordon: tăng trưởng không đổi g mãi mãi thì giá trị = EPS x (1+g) x (1 - g/ROE) / (Ke - g)', () => {
    const p = { eps0: 3000, roe: 0.15, ke: 0.12, g1: 0.05, years1: 0, fadeYears: 0, gT: 0.05 };
    near(VM.fcfe(p).value, 3000 * 1.05 * (1 - 0.05 / 0.15) / (0.12 - 0.05), 1e-9);
    near(VM.fcfe(Object.assign({}, p, { years1: 6, fadeYears: 0 })).value, VM.fcfe(p).value, 1e-9);        // g1 = gT nên số năm giai đoạn 1 không đổi giá trị
  });
  it('tăng trưởng cao hơn thì giá trị cao hơn; Ke cao hơn thì giá trị thấp hơn; Ke <= gT: không tính', () => {
    const base = { eps0: 5000, roe: 0.2, ke: 0.11, g1: 0.10, gT: 0.05 };
    expect(VM.fcfe(Object.assign({}, base, { g1: 0.15 })).value).toBeGreaterThan(VM.fcfe(base).value);
    expect(VM.fcfe(Object.assign({}, base, { ke: 0.13 })).value).toBeLessThan(VM.fcfe(base).value);
    expect(VM.fcfe(Object.assign({}, base, { gT: 0.12 }))).toEqual({ ok: false, reason: 'ke<=g' });
    expect(VM.fcfe({ eps0: -1, roe: 0.2, ke: 0.1, g1: 0.1, gT: 0.04 })).toBeNull();
  });
  it('phần giá trị cuối kỳ được báo để biết mô hình dựa bao nhiêu vào giả định dài hạn', () => {
    const r = VM.fcfe({ eps0: 5000, roe: 0.2, ke: 0.11, g1: 0.10, gT: 0.05 });
    expect(r.terminalSharePct).toBeGreaterThan(30); expect(r.terminalSharePct).toBeLessThan(100);
    near(r.pvFcfe + r.tvPv, r.value, 1e-9);
  });
});

describe('định giá ngược', () => {
  it('g1 tìm được khớp tham chiếu và đưa mô hình thuận về đúng giá', () => {
    const p = { eps0: G.reverse.in.eps0, roe: G.reverse.in.roe, roeTerminal: G.reverse.in.roe_t, ke: G.reverse.in.ke, years1: G.reverse.in.N1, fadeYears: G.reverse.in.N2, gT: G.reverse.in.gT };
    const r = VM.reverseFcfe(G.reverse.price, p);
    expect(r.ok).toBe(true);
    near(r.g1, G.reverse.g1, 1e-8);
    near(VM.fcfe(Object.assign({}, p, { g1: r.g1 })).value, G.reverse.price, 1e-6);
  });
  it('giá ngoài khoảng mô hình giải thích được: báo below/above; giá không hợp lệ: null', () => {
    const p = { eps0: 5000, roe: 0.2, ke: 0.11, gT: 0.05 };
    expect(VM.reverseFcfe(1, p)).toMatchObject({ ok: false, reason: 'below' });
    expect(VM.reverseFcfe(1e12, p)).toMatchObject({ ok: false, reason: 'above' });
    expect(VM.reverseFcfe(0, p)).toBeNull();
  });
});

describe('bảng nhạy cảm', () => {
  it('lưới theo (g, Ke): giá trị giảm khi Ke tăng, tăng khi g tăng; ô Ke <= g là null', () => {
    const model = (ke, g) => { const r = VM.fcfe({ eps0: 5000, roe: 0.2, ke, g1: 0.08, gT: g, years1: 3, fadeYears: 2 }); return r && r.ok ? r.value : null; };
    const s = VM.sensitivity(model, [0.09, 0.10, 0.11, 0.12], [0.03, 0.05]);
    expect(s.grid).toHaveLength(2); expect(s.grid[0]).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect(s.grid[0][i]).toBeLessThan(s.grid[0][i - 1]);
    for (let j = 0; j < 4; j++) expect(s.grid[1][j]).toBeGreaterThan(s.grid[0][j]);
    expect(VM.sensitivity((ke, g) => (ke > g ? 1 : null), [0.04], [0.05]).grid[0][0]).toBeNull();
  });
});

describe('điểm chất lượng', () => {
  const GOOD = { roaa: 0.127, roae: 0.241, roic: 0.16, cfoToSales: 0.115, netMargin: 0.157, positiveCfo2y: 2, deltaMargin: -0.029, interestCoverage: 12, debtToEquity: 0.45, currentRatio: 1.56, epsGrowthYoY: 0.009, salesGrowthYoY: -0.038 };
  it('doanh nghiệp thường: chấm từng tiêu chí kèm số liệu; không đạt khi lợi nhuận không có tiền hoặc biên xấu đi', () => {
    const q = VM.qualityScore(GOOD);
    const by = Object.fromEntries(q.items.map(i => [i.key, i]));
    expect(by.roae).toMatchObject({ pass: true, value: '24.1%' });
    expect(by.cfoToSales.pass).toBe(false);                 // CFO/doanh thu 11,5% < biên ròng 15,7%
    expect(by.deltaMargin.pass).toBe(false);
    expect(by.salesGrowthYoY.pass).toBe(false);
    expect(by.epsGrowthYoY.pass).toBe(true);
    expect(q.scored).toBe(11); expect(q.passed).toBe(8);
    expect(q.score).toBeCloseTo(8 / 11 * 100, 9); expect(q.level).toBe('mid');                // 72,7 < 75
  });
  it('thiếu dữ liệu: bỏ tiêu chí không có; dưới 4 tiêu chí thì không cho điểm', () => {
    const q = VM.qualityScore({ roaa: 0.1, roae: 0.2, debtToEquity: 0.5 });
    expect(q.scored).toBe(3); expect(q.score).toBeNull(); expect(q.level).toBe('unknown');
    expect(q.items.find(i => i.key === 'roic')).toMatchObject({ available: false, pass: null });
  });
  it('ngân hàng dùng bộ tiêu chí riêng (ROE, NIM, bao phủ nợ xấu, vốn chủ/tài sản)', () => {
    const vcb = { roae: 0.182, roaa: 0.017, nim: 0.0230, badDebtCoverage: 2.79, equityToAsset: 0.0935, epsGrowthYoY: 0.20, pretaxGrowthYoY: 0.186 };
    const q = VM.qualityScore(vcb, { financial: true });
    expect(q.financial).toBe(true);
    const by = Object.fromEntries(q.items.map(i => [i.key, i]));
    expect(by.nim.pass).toBe(false);                         // 2,30% < 2,5%
    expect(by.badDebtCoverage.pass).toBe(true);
    expect(q.passed).toBe(6); expect(q.scored).toBe(7);
  });
  it('mức: yếu dưới 50, trung bình 50-75', () => {
    expect(VM.qualityScore({ roaa: -0.01, roae: 0.02, roic: 0.02, cfoToSales: -0.1, netMargin: -0.05, positiveCfo2y: 0, deltaMargin: -0.05, interestCoverage: 0.5, debtToEquity: 3, currentRatio: 0.7, epsGrowthYoY: -0.3, salesGrowthYoY: -0.1 }).level).toBe('weak');
    const mid = VM.qualityScore({ roaa: 0.05, roae: 0.13, roic: 0.05, cfoToSales: 0.05, netMargin: 0.08, positiveCfo2y: 1, deltaMargin: 0.01, interestCoverage: 5, debtToEquity: 0.8, currentRatio: 1.2, epsGrowthYoY: -0.1, salesGrowthYoY: 0.05 });
    expect(mid.level).toBe('mid');
  });
});

describe('đối chiếu độc lập', () => {
  it('beta lệch quá ngưỡng tuyệt đối, bội số lệch quá ngưỡng tương đối bị đánh dấu; thiếu số thì n/a', () => {
    const r = VM.crossCheck([
      { key: 'beta', label: 'Beta', app: 0.95, ref: 0.74, absTol: 0.15 },
      { key: 'pe', label: 'P/E', app: 12, ref: 11.7, tol: 0.1 },
      { key: 'pb', label: 'P/B', app: 4.1, ref: 2.94, tol: 0.25 },
      { key: 'adv', label: 'Thanh khoản', app: null, ref: 1 },
    ]);
    expect(r.map(x => x.status)).toEqual(['differs', 'ok', 'differs', 'na']);
    expect(r[2].relPct).toBeCloseTo((4.1 - 2.94) / 2.94 * 100, 9);
  });
  it('so với bình quân lịch sử của chính mã', () => {
    const v = VM.versusHistory(11.7, { y1: 15.1, y3: 20.9, y5: 20.0, bad: null });
    near(v.y3, 11.7 / 20.9, 1e-12); expect(v.bad).toBeNull();
    expect(VM.versusHistory(0, { y1: 1 })).toBeNull();
  });
});
