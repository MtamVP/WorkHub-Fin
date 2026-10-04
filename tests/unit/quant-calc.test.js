import { describe, it, expect } from 'vitest';
import Q from '../../lib/quant-calc.js';

describe('vòng quay JdK', () => {
  it('bốn góc phần tư theo RS-Ratio và RS-Momentum so với 100', () => {
    expect(Q.rotation(105, 102).key).toBe('leading');
    expect(Q.rotation(105, 98).key).toBe('weakening');
    expect(Q.rotation(96.7, 98.4).key).toBe('lagging');       // FPT ngày 02/10/2026 (số thật)
    expect(Q.rotation(97, 101).key).toBe('improving');
    expect(Q.rotation(100, 100).key).toBe('leading');         // đúng 100 tính là mạnh
    expect(Q.rotation(null, 100)).toBeNull();
    expect(Q.rotation('x', 100)).toBeNull();
  });
});

describe('biên độ 52 tuần, thoát vị thế, khối ngoại', () => {
  it('vị trí trong biên độ và cách đỉnh/đáy; dữ liệu vô lý trả null', () => {
    const r = Q.range52(62100, 56546, 95144);
    expect(r.positionPct).toBeCloseTo((62100 - 56546) / (95144 - 56546) * 100, 9);
    expect(r.fromHighPct).toBeCloseTo((62100 / 95144 - 1) * 100, 9);
    expect(Q.range52(100000, 56546, 95144).positionPct).toBe(100);       // vượt đỉnh: kẹp 100
    expect(Q.range52(62100, 95144, 56546)).toBeNull();
    expect(Q.range52(0, 1, 2)).toBeNull();
  });
  it('số phiên thoát = giá trị giữ / (giá trị giao dịch TB ngày x 20%); thiếu thanh khoản thì null', () => {
    expect(Q.daysToExit(80e6, 400e9)).toBeCloseTo(80e6 / (400e9 * 0.2), 12);
    expect(Q.daysToExit(8e9, 4e9)).toBeCloseTo(10, 9);
    expect(Q.daysToExit(8e9, 0)).toBeNull();
    expect(Q.daysToExit(8e9, null)).toBeNull();
    expect(Q.daysToExit(8e9, 4e9, 0.1)).toBeCloseTo(20, 9);
  });
  it('áp lực khối ngoại = ròng 5 phiên / (thanh khoản TB ngày x 5)', () => {
    expect(Q.foreignPressure(-5.594e9, 398.69e9)).toBeCloseTo(-5.594e9 / (398.69e9 * 5) * 100, 9);
    expect(Q.foreignPressure(1e9, 0)).toBeNull();
    expect(Q.foreignPressure(null, 1e9)).toBeNull();
  });
});

describe('dashboard', () => {
  // số thật của FPT / VCB (VNDirect 02/10/2026)
  const R = {
    FPT: { updatedAt: '2026-10-03T10:00:00Z', metrics: { pe: 11.711, pb: 2.9385, beta: 0.7358, roae: 0.2409, pe1y: 15.106, pe3y: 20.872, pe5y: 19.96, chg1m: -0.0668, chg3m: -0.0578, chg6m: -0.0729, chg1y: -0.2403, jdkRs: 96.73, jdkMom: 98.37, low52: 56546, high52: 95144, advValue20: 398.69e9, foreignNet5d: -5.594e9, foreignRoomLeftPct: 41.9 } },
    VCB: { updatedAt: '2026-10-03T10:00:00Z', metrics: { pe: 11.456, pb: 1.95, beta: 0.727, roae: 0.182, pe5y: 15.05, jdkRs: 98.5, jdkMom: 100.2, low52: 54000, high52: 75369, advValue20: 262.9e9, foreignNet5d: -93.0e9, foreignRoomLeftPct: 33.5 } },
  };
  const holdings = [{ symbol: 'fpt', value: 120e6 }, { symbol: 'VCB', value: 80e6 }, { symbol: 'XYZ', value: 40e6 }, { symbol: 'ZERO', value: 0 }];
  const d = Q.dashboard(holdings, R, { prices: { FPT: 62100, VCB: 57000 } });
  it('hàng theo giá trị giảm dần, bỏ vị thế 0; mã không có dữ liệu được đánh dấu', () => {
    expect(d.rows.map(r => r.symbol)).toEqual(['FPT', 'VCB', 'XYZ']);
    expect(d.rows[0].weightPct).toBeCloseTo(120 / 240 * 100, 9);
    expect(d.rows[2].hasData).toBe(false);
    expect(d.rows[2].rotation).toBeNull();
  });
  it('chỉ báo từng mã: P/E so với lịch sử, vòng quay, vị trí 52 tuần, áp lực khối ngoại', () => {
    const f = d.rows[0];
    expect(f.peVs5y).toBeCloseTo(11.711 / 19.96, 9);
    expect(f.peVs3y).toBeCloseTo(11.711 / 20.872, 9);
    expect(f.rotation.key).toBe('lagging');
    expect(f.range.positionPct).toBeGreaterThan(10); expect(f.range.positionPct).toBeLessThan(20);
    expect(f.foreignPressurePct).toBeCloseTo(-5.594e9 / (398.69e9 * 5) * 100, 9);
    expect(d.rows[1].rotation.key).toBe('improving');
  });
  it('cờ: tụt hậu mà chiếm >= 10% danh mục; P/E rẻ so với lịch sử 5 năm (thông tin); khối ngoại bán ròng mạnh với VCB', () => {
    const f = d.rows[0].flags.map(x => x.text).join(' | ');
    expect(f).toMatch(/TỤT HẬU/);
    expect(f).toMatch(/P\/E chỉ bằng 59% bình quân 5 năm/);
    expect(d.rows[1].foreignPressurePct).toBeCloseTo(-93.0e9 / (262.9e9 * 5) * 100, 9);        // -7,1% thanh khoản: chưa tới ngưỡng cờ 10%
    expect(d.rows[1].flags.some(x => /Khối ngoại bán ròng/.test(x.text))).toBe(false);
    const heavy = Q.dashboard([{ symbol: 'VCB', value: 80e6 }], { VCB: { metrics: Object.assign({}, R.VCB.metrics, { foreignNet5d: -150e9 }) } }, {});
    expect(heavy.rows[0].flags.some(x => /Khối ngoại bán ròng 5 phiên bằng 11% thanh khoản/.test(x.text))).toBe(true);
  });
  it('tổng hợp: P/E điều hoà có trọng số, ROE và beta bình quân, tỷ trọng theo vòng quay, độ phủ dữ liệu', () => {
    const s = d.summary;
    expect(s.count).toBe(3); expect(s.covered).toBe(2);
    expect(s.coveragePct).toBeCloseTo(200 / 240 * 100, 9);
    expect(s.harmonicPe).toBeCloseTo(200 / (120 / 11.711 + 80 / 11.456), 9);
    expect(s.roe).toBeCloseTo((0.2409 * 120 + 0.182 * 80) / 200, 9);
    expect(s.rotationPct.lagging).toBeCloseTo(60, 9); expect(s.rotationPct.improving).toBeCloseTo(40, 9);
    expect(s.rotationPct.leading).toBe(0);
  });
  it('vị thế lớn trong mã kém thanh khoản: cờ khó thoát; đếm tỷ trọng kém thanh khoản', () => {
    const big = Q.dashboard([{ symbol: 'THIN', value: 8e9 }, { symbol: 'FPT', value: 2e9 }], { THIN: { metrics: { advValue20: 4e9 } }, FPT: R.FPT }, {});
    expect(big.rows[0].daysToExit).toBeCloseTo(10, 9);
    expect(big.rows[0].flags[0]).toMatchObject({ tone: 'bad' });
    expect(big.summary.illiquidPct).toBeCloseTo(80, 9);
    expect(Q.dashboard([], {}, {}).rows).toEqual([]);
  });
});
