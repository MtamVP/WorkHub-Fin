import { describe, it, expect } from 'vitest';
import A from '../../lib/vb-asset.js';
import M from '../../lib/vb-multiples.js';

describe('Graham', () => {
  it('số Graham = √(22,5 × EPS × BVPS)', () => {
    expect(A.graham(3000, 20000).value).toBeCloseTo(Math.sqrt(22.5 * 3000 * 20000), 9);
    expect(A.graham(-1, 20000)).toBeNull(); expect(A.graham(3000, 0)).toBeNull(); expect(A.graham(null, 5)).toBeNull();
  });
  it('công thức tăng trưởng: V = EPS × (8,5 + 2g) × 4,4 / Y và g bị kẹp 0-15', () => {
    expect(A.grahamGrowth(2000, 10, 4.4).value).toBeCloseTo(2000 * 28.5, 6);
    const g = A.grahamGrowth(2000, 40, 4.4); expect(g.growthUsed).toBe(15); expect(g.value).toBeCloseTo(2000 * 38.5, 6);
    expect(A.grahamGrowth(2000, 5, 0)).toBeNull();
  });
});

describe('Lynch, PEG, EPV', () => {
  it('P/E hợp lý = g + cổ tức', () => { const r = A.lynch(1000, 12, 3); expect(r.value).toBe(15000); expect(r.fairPe).toBe(15); expect(A.lynch(1000, 80, 0).growthUsed).toBe(30); expect(A.lynch(0, 10)).toBeNull(); });
  it('PEG', () => { expect(A.peg(15, 10)).toBeCloseTo(1.5, 9); expect(A.peg(15, 0)).toBeNull(); expect(A.peg(-5, 10)).toBeNull(); });
  it('EPV = NOPAT / WACC rồi qua cầu nối vốn chủ', () => {
    const r = A.epv({ normalizedEbit: 1000, taxRate: 0.2, wacc: 0.1, cash: 200, associates: 50, debt: 300, minorities: 100, shares: 100 });
    expect(r.nopat).toBeCloseTo(800, 9); expect(r.ev).toBeCloseTo(8000, 9); expect(r.equity).toBeCloseTo(8000 + 200 + 50 - 300 - 100, 9); expect(r.value).toBeCloseTo(78.5, 9);
    expect(A.epv({ normalizedEbit: 1, wacc: 0, shares: 1 })).toBeNull();
  });
});

describe('tài sản', () => {
  const p = { currentAssets: 700, liabilities: 500, equity: 800, goodwill: 50, totalAssets: 1600 };
  it('NCAV và ngưỡng 2/3', () => { const r = A.ncav(p, 100); expect(r.value).toBeCloseTo(2, 9); expect(r.threshold).toBeCloseTo(4 / 3, 9); expect(A.ncav({ liabilities: 1 }, 100)).toBeNull(); });
  it('NAV điều chỉnh: sổ sách + đánh giá lại; giá trị hữu hình trừ lợi thế thương mại', () => {
    const r = A.nav(p, 100, [{ label: 'Đánh giá lại đất', amount: 200 }, { label: 'Trừ tài sản vô hình', amount: -30 }]);
    expect(r.book).toBe(8); expect(r.value).toBeCloseTo(9.7, 9); expect(r.tangible).toBeCloseTo(7.5, 9);
  });
  it("Tobin's Q", () => { expect(A.tobinQ(1000, p).q).toBeCloseTo(1500 / 1600, 9); expect(A.tobinQ(0, p)).toBeNull(); });
});

describe('cổ tức', () => {
  it('Gordon D1/(k−g); từ chối k ≤ g', () => { expect(A.gordon(1000, 0.05, 0.1).value).toBeCloseTo(1000 * 1.05 / 0.05, 6); expect(A.gordon(1000, 0.1, 0.1)).toBeNull(); });
  it('hai giai đoạn khớp tính tay với n = 1', () => {
    const r = A.ddmTwoStage(100, 0.2, 1, 0.05, 0.1), d1 = 120;
    expect(r.value).toBeCloseTo(d1 / 1.1 + (d1 * 1.05 / 0.05) / 1.1, 9);
  });
  it('H-model: gS = gL cho ra Gordon', () => { expect(A.hModel(100, 0.05, 0.05, 5, 0.1).value).toBeCloseTo(A.gordon(100, 0.05, 0.1).value, 9); });
  it('theo tỷ suất mục tiêu và lợi suất lợi nhuận', () => { expect(A.yieldValue(2000, 0.05).value).toBe(40000); expect(A.earningsYieldValue(5000, 0.08).impliedPe).toBeCloseTo(12.5, 9); expect(A.yieldValue(0, 0.05)).toBeNull(); });
});

describe('SOTP', () => {
  it('cộng EV các mảng, trừ nợ và chiết khấu tập đoàn', () => {
    const r = A.sotp([{ name: 'A', metric: 100, multiple: 10 }, { name: 'B', metric: 50, multiple: 6 }, { name: 'bỏ', metric: null, multiple: 5 }], { cash: 100, debt: 300, shares: 10, holdingDiscountPct: 10 });
    expect(r.ev).toBe(1300); expect(r.rows).toHaveLength(2); expect(r.equity).toBeCloseTo(1300 + 100 - 300 - 130, 9); expect(r.value).toBeCloseTo(97, 9);
    expect(A.sotp([], {})).toBeNull();
  });
});

describe('bội số: compute', () => {
  const period = { form: 'NON_FINANCE', netIncome: 100, equity: 800, revenue: 1000, ebitda: 200, ebit: 150, cfo: 120, fcf: 70, divPaid: 30, debt: 300, cash: 100, stInvest: 50, nciEquity: 20, ltInvest: 10 };
  const c = M.compute({ price: 20, shares: 10, period: period, growthPct: 10 });
  it('vốn hoá, EV và các bội số', () => {
    expect(c.marketCap).toBe(200); expect(c.ev).toBeCloseTo(200 + 300 + 20 - 150 - 10, 9);
    expect(c.eps).toBe(10); expect(c.pe).toBeCloseTo(2, 9); expect(c.pb).toBeCloseTo(20 / 80, 9); expect(c.ps).toBeCloseTo(20 / 100, 9); expect(c.evEbitda).toBeCloseTo(360 / 200, 9); expect(c.evSales).toBeCloseTo(0.36, 9);
    expect(c.fcfYield).toBeCloseTo(70 / 200, 9); expect(c.dividendYield).toBeCloseTo(30 / 200, 9); expect(c.peg).toBeCloseTo(0.2, 9);
  });
  it('mẫu số không dương -> null', () => {
    const l = M.compute({ price: 20, shares: 10, period: Object.assign({}, period, { netIncome: -5, ebitda: -1 }) });
    expect(l.pe).toBeNull(); expect(l.evEbitda).toBeNull(); expect(l.eps).toBe(-0.5);
    expect(M.compute({ price: 0, shares: 10, period: period })).toBeNull();
  });
  it('ngân hàng: không có EV', () => { const b = M.compute({ price: 20, shares: 10, period: { form: 'BANK', netIncome: 100, equity: 800 } }); expect(b.ev).toBeNull(); expect(b.evEbitda).toBeNull(); expect(b.pe).toBeCloseTo(2, 9); });
});

describe('bội số: ngang hàng và lịch sử', () => {
  const period = { form: 'NON_FINANCE', netIncome: 100, equity: 800, revenue: 1000, ebitda: 200, debt: 300, cash: 100, stInvest: 50, nciEquity: 20, ltInvest: 10 };
  const c = M.compute({ price: 20, shares: 10, period: period });
  const Q = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30];
  it('at: nội suy phân vị trên 11 điểm', () => { expect(M.at(Q, 50)).toBe(14); expect(M.at(Q, 20)).toBe(8); expect(M.at(Q, 25)).toBe(9); expect(M.at(null, 50)).toBeNull(); });
  it('giá ngầm định từ P/E và từ EV/EBITDA (qua cầu nối)', () => {
    const r = M.peerImplied(c, period, { pe: { n: 30, q: Q }, evEbitda: { n: 30, q: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } }, false);
    const pe = r.find((x) => x.key === 'pe'), ev = r.find((x) => x.key === 'evEbitda');
    expect(pe.low).toBeCloseTo(8 * 10, 9); expect(pe.base).toBeCloseTo(14 * 10, 9); expect(pe.high).toBeCloseTo(20 * 10, 9);
    expect(ev.base).toBeCloseTo((7 * 200 - 300 - 20 + 150 + 10) / 10, 9);
  });
  it('bỏ nhóm ít hơn 5 mã; tài chính chỉ P/E và P/B', () => {
    expect(M.peerImplied(c, period, { pe: { n: 4, q: Q } }, false)).toEqual([]);
    const f = M.peerImplied(c, period, { pe: { n: 30, q: Q }, ps: { n: 30, q: Q }, evEbitda: { n: 30, q: Q } }, true);
    expect(f.map((x) => x.key)).toEqual(['pe']);
  });
  it('dải lịch sử: trung bình, phân vị, vị trí hiện tại và giá ngầm định', () => {
    const series = Array.from({ length: 200 }, (_, i) => 10 + (i % 20) * 0.5);       // 10..19,5 đều
    const band = M.historyBand(series, 12);
    expect(band.n).toBe(200); expect(band.mean).toBeCloseTo(14.75, 9); expect(band.p50).toBeCloseTo(14.75, 1); expect(band.percentile).toBeCloseTo(((4 * 10 + 5 * 10) / 2 * 0 + (series.filter((v) => v < 12).length + series.filter((v) => v === 12).length / 2)) / 200 * 100, 6);
    const h = M.historyImplied('pe', band, c, period);
    expect(h.key).toBe('hist-pe'); expect(h.base).toBeCloseTo(band.p50 * 10, 9);
    expect(M.historyBand([1, 2, 3], 1)).toBeNull();
  });
});
