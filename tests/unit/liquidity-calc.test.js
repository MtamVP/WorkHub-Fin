// Thanh khoản và sức chứa (lib/liquidity-calc.js): số ngày thoát, chi phí tác động giá (cùng công thức Market Simulation), sức chứa từng mã, hệ số quy mô, ứng viên.
import { describe, it, expect } from 'vitest';
import L from '../../lib/liquidity-calc.js';

const vols = (n, v) => Array.from({ length: n }, (_, i) => ['2026-09-' + String((i % 28) + 1).padStart(2, '0'), v]);
const flat = (n, p) => Array.from({ length: n }, (_, i) => ['d' + i, p]);

describe('đầu vào: biến động và khối lượng', () => {
  it('độ lệch chuẩn lợi suất ngày; chuỗi ngắn -> null', () => {
    const px = [100]; for (let i = 0; i < 40; i++) px.push(px[i] * Math.exp(i % 2 ? -0.01 : 0.01));
    const s = L.dailySigma(px.map((p, i) => ['d' + i, p]));
    expect(s).toBeCloseTo(0.01 * Math.sqrt(40 / 39) * Math.sqrt(1 - 0 / 1), 3);
    expect(L.dailySigma(flat(5, 100))).toBeNull();
    expect(L.dailySigma(flat(30, 100))).toBe(0);
  });
  it('khối lượng bình quân bỏ phiên 0, chỉ lấy cửa sổ gần nhất; ít hơn 5 phiên -> null', () => {
    const v = [['a', 1000], ['b', 0], ['c', 2000], ['d', 3000], ['e', 4000], ['f', 5000]];
    expect(L.averageVolume(v, 3)).toBeCloseTo(4000, 9);
    expect(L.averageVolume(v.slice(0, 4), 20)).toBeNull();
  });
});

describe('analyze: một vị thế tính tay', () => {
  // 100.000 cp, giá 50.000, ADV 200.000 cp/ngày -> mỗi ngày bán được 40.000 (20%): 2,5 phiên, làm tròn 3 phiên
  const h = [{ symbol: 'AAA', quantity: 100000, price: 50000 }];
  const r = L.analyze(h, { AAA: vols(30, 200000) }, {}, {});
  const row = r.rows[0];
  it('số ngày, tỷ lệ so với ADV, giá trị giao dịch', () => {
    expect(row.days).toBeCloseTo(2.5, 9); expect(row.pctOfAdv).toBeCloseTo(50, 9); expect(row.advValue).toBe(1e10); expect(row.perDay).toBe(40000);
    expect(row.level).toBe('ok'); expect(row.over).toBe(false);
  });
  it('chi phí tác động: 3 phiên, mỗi phiên 5e9/3, k=0,8, biến động mặc định 2% (không có chuỗi giá)', () => {
    expect(row.exitSessions).toBe(3); expect(row.sigmaKnown).toBe(false);
    const f = 0.8 * 0.02 * Math.sqrt((5e9 / 3) / 1e10);
    expect(row.exitCostPct).toBeCloseTo(f * 100, 9); expect(row.exitCostValue).toBeCloseTo(f * 5e9, 3);
  });
  it('sức chứa: thoát trong 5 phiên tối đa 200.000 cp; còn mua thêm 100.000 cp; có thể nhân quy mô 2 lần', () => {
    expect(row.capacityQty).toBe(200000); expect(row.headroomQty).toBe(100000); expect(row.headroomValue).toBe(5e9); expect(row.scaleMax).toBeCloseTo(2, 9);
    expect(r.scale).toMatchObject({ symbol: 'AAA', canGrow: true }); expect(r.scale.k).toBeCloseTo(2, 9);
  });
});

describe('analyze: nhiều vị thế, thiếu dữ liệu, ngưỡng', () => {
  const h = [
    { symbol: 'BIG', quantity: 1000000, price: 10000 },     // ADV 100.000: mỗi ngày 20.000 -> 50 phiên
    { symbol: 'OK', quantity: 20000, price: 100000 },       // ADV 500.000: mỗi ngày 100.000 -> 0,2 phiên
    { symbol: 'NODATA', quantity: 500, price: 100000 },
    { symbol: 'ZERO', quantity: 0, price: 100 },
  ];
  const r = L.analyze(h, { BIG: vols(30, 100000), OK: vols(30, 500000) }, {}, {});
  it('xếp mã khó thoát nhất lên đầu; mã không có khối lượng được nêu riêng; vị thế 0 bị bỏ', () => {
    expect(r.rows.map((x) => x.symbol)).toEqual(['BIG', 'OK']); expect(r.missing).toEqual(['NODATA']);
    expect(r.rows[0].days).toBeCloseTo(50, 9); expect(r.rows[0].level).toBe('high'); expect(r.rows[0].over).toBe(true); expect(r.rows[0].overLimit).toBe(true);
  });
  it('độ phủ, số ngày bình quân theo giá trị, tỷ lệ giá trị thoát chậm', () => {
    const v1 = 1e10, v2 = 2e9;
    expect(r.totals.knownValue).toBe(v1 + v2); expect(r.totals.coveragePct).toBeCloseTo((v1 + v2) / (v1 + v2 + 5e7) * 100, 9);
    expect(r.totals.weightedDays).toBeCloseTo((50 * v1 + 0.2 * v2) / (v1 + v2), 9); expect(r.totals.slowPct).toBeCloseTo(v1 / (v1 + v2) * 100, 9);
  });
  it('mã chặn quy mô là mã vượt ngưỡng trước (hệ số < 1 nghĩa là ĐÃ vượt)', () => {
    expect(r.scale.symbol).toBe('BIG'); expect(r.scale.k).toBeCloseTo(100000 / 1000000, 9); expect(r.scale.canGrow).toBe(false);
  });
  it('biến động từ chuỗi giá thật được dùng thay mặc định; chi phí tăng theo biến động', () => {
    const calm = flat(40, 10000).map((r, i) => [r[0], 10000 * (1 + (i % 2 ? 0.002 : -0.002))]);
    const wild = flat(40, 10000).map((r, i) => [r[0], 10000 * (1 + (i % 2 ? 0.04 : -0.04))]);
    const a = L.analyze([h[0]], { BIG: vols(30, 100000) }, { BIG: calm }, {}).rows[0], b = L.analyze([h[0]], { BIG: vols(30, 100000) }, { BIG: wild }, {}).rows[0];
    expect(a.sigmaKnown).toBe(true); expect(b.exitCostPct).toBeGreaterThan(a.exitCostPct);
  });
  it('tác động bị chặn ở 10%', () => {
    const crazy = flat(40, 10000).map((r, i) => [r[0], 10000 * (i % 2 ? 1.3 : 0.7)]);        // biến động ngày khoảng 30%: công thức vượt trần
    const r2 = L.analyze([{ symbol: 'X', quantity: 1e9, price: 10000 }], { X: vols(30, 1000) }, { X: crazy }, {}).rows[0];
    expect(r2.exitCostPct).toBeCloseTo(10, 9);
  });
  it('danh mục rỗng hoặc toàn thiếu dữ liệu không ném', () => {
    expect(L.analyze([], {}, {}).rows).toEqual([]); expect(L.analyze(null, null, null).scale).toBeNull();
    const only = L.analyze([{ symbol: 'Q', quantity: 10, price: 10 }], {}, {});
    expect(only.rows).toEqual([]); expect(only.missing).toEqual(['Q']); expect(only.totals.weightedDays).toBeNull();
  });
});

describe('pipeline: ý định so với sức chứa', () => {
  const v = { AAA: vols(30, 200000) };
  it('xây được hay không trong 5 phiên; thiếu bao nhiêu', () => {
    const [a, b] = L.pipeline([{ symbol: 'AAA', value: 5e9, price: 50000 }, { symbol: 'AAA', value: 2e10, price: 50000 }], v, {}, {});
    expect(a.ok).toBe(true); expect(a.buildDays).toBeCloseTo(2.5, 9);
    expect(b.ok).toBe(false); expect(b.buildDays).toBeCloseTo(10, 9); expect(b.maxValue).toBe(1e10); expect(b.shortfall).toBe(1e10);
  });
  it('thiếu giá hoặc khối lượng -> unknown', () => {
    expect(L.pipeline([{ symbol: 'ZZ', value: 1e9, price: 100 }], v, {})[0].unknown).toBe(true);
    expect(L.pipeline([{ symbol: 'AAA', value: 1e9 }], v, {})[0].unknown).toBe(true);
  });
});
