import { describe, it, expect } from 'vitest';
import MS from '../../lib/market-screener.js';

const Q = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30];      // P/E ngành giả
const QB = [0.5, 0.8, 1, 1.2, 1.5, 1.8, 2.1, 2.5, 3, 4, 6];
const QR = [0, 0.03, 0.06, 0.09, 0.11, 0.13, 0.15, 0.18, 0.21, 0.25, 0.35];
const STATS = { '2700': { stats: { pe: { n: 40, median: 14, q: Q }, pb: { n: 40, median: 1.8, q: QB }, roae: { n: 40, median: 0.13, q: QR } } }, '8300': { stats: { pe: { n: 20, median: 8, q: Q.map((x) => x / 2) }, pb: { n: 20, median: 1.2, q: QB }, roae: { n: 20, median: 0.15, q: QR } } } };
const S = (symbol, icb, m) => ({ symbol, icb2_code: icb, metrics: Object.assign({ marketcap: 5000e9, advValue20: 20e9 }, m) });
const SNAP = [
  S('AAA', '2700', { pe: 7, pb: 1, roae: 0.2, netMargin: 0.1, epsGrowthYoY: 0.2, salesGrowthYoY: 0.1, divYield: 0.06, debtToEquity: 0.8, pe5y: 12, chg1y: -0.3 }),
  S('BBB', '2700', { pe: 22, pb: 3.5, roae: 0.08, debtToEquity: 2.5, divYield: 0.01, chg1y: 0.4 }),
  S('CCC', '2700', { pe: 9, pb: 1.1, roae: 0.18, marketcap: 400e9, advValue20: 1e9 }),                       // nhỏ, kém thanh khoản
  S('DDD', '2700', { pe: 10 }),                                                                              // thiếu ROE
  S('BNK', '8300', { pe: 6, pb: 1, roae: 0.19, divYield: 0.0, debtToEquity: 11 }),                          // ngân hàng: nợ/vốn vô nghĩa
  S('LOSS', '2700', { pe: -5, pb: 1, roae: -0.05 }),
];
const rows = MS.buildRows(SNAP, STATS, { AAA: { name: 'Công ty A', exchange: 'HOSE' } });
const by = (r) => r.entries.map((e) => e.row.symbol);

describe('buildRows', () => {
  it('gắn phân vị định giá trong ngành, nhận diện ngành tài chính, thêm tên/sàn từ meta', () => {
    const a = rows.find((r) => r.symbol === 'AAA');
    expect(a.valuationPct).toBeLessThan(25); expect(a.financial).toBe(false); expect(a.name).toBe('Công ty A'); expect(a.exchange).toBe('HOSE');
    expect(rows.find((r) => r.symbol === 'BNK').financial).toBe(true);
    expect(rows.find((r) => r.symbol === 'BBB').valuationPct).toBeGreaterThan(70);
  });
  it('ngành không có thống kê thì phân vị là null', () => {
    const r = MS.buildRows([S('XXX', '9999', { pe: 10 })], STATS, {});
    expect(r[0].valuationPct).toBeNull();
  });
});

describe('evaluate: lọc', () => {
  it('không bật tiêu chí nào: mọi mã đều đạt', () => {
    const r = MS.evaluate(rows, { values: {} });
    expect(r.counts.passed).toBe(6); expect(r.counts.active).toBe(0);
  });
  it('rẻ và chất lượng: AAA đạt, BBB (đắt) rớt, CCC rớt vì nhỏ, DDD bị loại vì thiếu ROE và được đếm riêng', () => {
    const r = MS.evaluate(rows, { values: { valPct: 40, roe: 15, cap: 1000, adv: 5 } });
    expect(by(r)).toEqual(expect.arrayContaining(['AAA']));
    expect(by(r)).not.toContain('BBB'); expect(by(r)).not.toContain('CCC'); expect(by(r)).not.toContain('DDD');
    expect(r.counts.missing.roe).toBeGreaterThanOrEqual(1);
    expect(r.counts.failedBy.cap).toBe(1);
  });
  it('đơn vị: % gõ vào so với tỷ lệ thập phân, tỷ đồng so với đồng', () => {
    expect(by(MS.evaluate(rows, { values: { roe: 19 } }))).toEqual(expect.arrayContaining(['AAA', 'BNK']));
    expect(by(MS.evaluate(rows, { values: { roe: 19 } }))).not.toContain('CCC');
    expect(by(MS.evaluate(rows, { values: { cap: 1000 } }))).not.toContain('CCC');
  });
  it('P/E, P/B âm không đạt tiêu chí "tối đa"; mã lỗ bị loại', () => {
    expect(by(MS.evaluate(rows, { values: { pe: 30 } }))).not.toContain('LOSS');
  });
  it('nợ/vốn chủ không áp dụng cho ngân hàng: không bị loại vì D/E 11 lần', () => {
    const r = MS.evaluate(rows, { values: { de: 1.5, roe: 15 } });
    expect(by(r)).toContain('BNK'); expect(by(r)).toContain('AAA'); expect(by(r)).not.toContain('BBB');
  });
  it('P/E so với lịch sử và giảm sâu: dùng số âm cho chg1y', () => {
    expect(by(MS.evaluate(rows, { values: { peHist: 70 } }))).toEqual(['AAA']);                  // 7/12 = 58%
    expect(by(MS.evaluate(rows, { values: { chg1y: -25 } }))).toEqual(['AAA']);
  });
  it('lọc theo ngành ICB và bỏ giá trị không phải số', () => {
    expect(MS.evaluate(rows, { values: {}, icb: '8300' }).counts.universe).toBe(1);
    expect(MS.normalizeFilters({ values: { roe: 'abc', pe: '12' } }).values).toEqual({ pe: 12 });
  });
});

describe('xếp hạng', () => {
  it('mã rẻ, chất lượng, tăng trưởng, cổ tức cao xếp trên mã đắt và yếu; điểm trong 0-100', () => {
    const r = MS.evaluate(rows, { values: { cap: 1000 } });
    const ia = by(r).indexOf('AAA'), ib = by(r).indexOf('BBB');
    expect(ia).toBeLessThan(ib);
    r.entries.forEach((e) => { if (e.score !== null) { expect(e.score).toBeGreaterThanOrEqual(0); expect(e.score).toBeLessThanOrEqual(100); } });
  });
  it('mã chỉ có một nhóm dữ liệu thì không có điểm (không đoán)', () => {
    const lone = MS.buildRows([{ symbol: 'ONE', icb2_code: null, metrics: { divYield: 0.04, marketcap: 2000e9 } }], {}, {});
    expect(MS.score(lone[0]).total).toBeNull();
  });
  it('mẫu lọc có sẵn đều dùng tiêu chí hợp lệ và mô tả được', () => {
    MS.PRESETS.forEach((p) => { Object.keys(p.values).forEach((k) => { expect(MS.BY_KEY[k], p.key + ':' + k).toBeTruthy(); expect(MS.describe(k, p.values[k])).toMatch(/[≥≤]/); }); });
  });
});

describe('flags: cảnh báo coi chừng', () => {
  it('P/E rất thấp, EPS tăng gấp đôi, ROE bất thường (không tính ngân hàng), thanh khoản mỏng, ngành ít mã', () => {
    const mk = (m, extra) => Object.assign({ m: Object.assign({}, m), financial: false, sectorN: 30 }, extra || {});
    expect(MS.flags(mk({ pe: 3.5 })).join('|')).toMatch(/P\/E dưới 4x/);
    expect(MS.flags(mk({ pe: 8, epsGrowthYoY: 1.4 })).join('|')).toMatch(/gấp đôi/);
    expect(MS.flags(mk({ roae: 0.45 })).join('|')).toMatch(/ROE trên 40%/);
    expect(MS.flags(mk({ roae: 0.45 }, { financial: true }))).toEqual([]);
    expect(MS.flags(mk({ advValue20: 5e8 })).join('|')).toMatch(/dưới 1 tỷ/);
    expect(MS.flags(mk({ pe: 10 }, { sectorN: 6 })).join('|')).toMatch(/chỉ có 6 mã/);
    expect(MS.flags(mk({ pe: 12, roae: 0.15, epsGrowthYoY: 0.1, advValue20: 20e9 }))).toEqual([]);
  });
  it('mỗi mã đạt kèm danh sách cảnh báo', () => {
    const r = MS.evaluate(rows, { values: { cap: 1000 } });
    r.entries.forEach((e) => expect(Array.isArray(e.flags)).toBe(true));
  });
});

describe('động lượng: chg3m và JdK', () => {
  const snap = [S('LEAD', '2700', { pe: 10, pb: 1.2, roae: 0.15, chg3m: 0.12, jdkRs: 104, jdkMom: 101 }), S('LAG', '2700', { pe: 10, pb: 1.2, roae: 0.15, chg3m: -0.1, jdkRs: 96, jdkMom: 98 }), S('NODATA', '2700', { pe: 10, pb: 1.2, roae: 0.15 })];
  const rr = MS.buildRows(snap, STATS, {});
  it('lọc mã dẫn đầu (RS và Momentum từ 100); mã thiếu JdK bị loại và đếm riêng', () => {
    const r = MS.evaluate(rr, { values: { jdkRs: 100, jdkMom: 100 } });
    expect(r.entries.map((e) => e.row.symbol)).toEqual(['LEAD']);
    expect(r.counts.missing.jdkRs).toBe(1);
    expect(r.counts.failedBy.jdkRs).toBe(1);
  });
  it('động lượng 3 tháng tính theo % gõ vào', () => {
    expect(MS.evaluate(rr, { values: { chg3m: 10 } }).entries.map((e) => e.row.symbol)).toEqual(['LEAD']);
  });
  it('có mẫu "Dẫn đầu và có nền tảng"', () => { expect(MS.PRESETS.some((p) => p.key === 'momentum')).toBe(true); });
});
