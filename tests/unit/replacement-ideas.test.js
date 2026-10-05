import { describe, it, expect } from 'vitest';
import MS from '../../lib/market-screener.js';
import RI from '../../lib/replacement-ideas.js';

const Q = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30];
const QB = [0.5, 0.8, 1, 1.2, 1.5, 1.8, 2.1, 2.5, 3, 4, 6];
const QR = [0, 0.03, 0.06, 0.09, 0.11, 0.13, 0.15, 0.18, 0.21, 0.25, 0.35];
const STATS = { '2700': { stats: { pe: { n: 40, median: 14, q: Q }, pb: { n: 40, median: 1.8, q: QB }, roae: { n: 40, median: 0.13, q: QR } } } };
const S = (symbol, m) => ({ symbol, icb2_code: '2700', metrics: Object.assign({ marketcap: 5000e9, advValue20: 20e9, roae: 0.15, netMargin: 0.1, debtToEquity: 0.8, jdkRs: 102, jdkMom: 101 }, m) });
const rows = MS.buildRows([
  S('HELD', { pe: 26, pb: 4, roae: 0.12 }),                                  // đắt trong ngành
  S('GOOD', { pe: 9, pb: 1.1, roae: 0.18, epsGrowthYoY: 0.15 }),             // rẻ, ROE cao hơn
  S('LOWROE', { pe: 8, pb: 1, roae: 0.05 }),                                 // rẻ nhưng ROE thấp hơn
  S('SMALL', { pe: 8, pb: 1, roae: 0.2, marketcap: 400e9 }),                  // quá nhỏ
  S('THIN', { pe: 8, pb: 1, roae: 0.2, advValue20: 1e9 }),                    // kém thanh khoản
  S('FLAG', { pe: 3.2, pb: 0.8, roae: 0.25 }),                                // P/E < 4: số liệu đẹp bất thường
  S('RESTR', { pe: 8, pb: 1, roae: 0.2 }),                                    // bị hạn chế
  S('HELD2', { pe: 8, pb: 1, roae: 0.2 }),                                    // đã nắm
  S('DEBT', { pe: 8, pb: 1, roae: 0.2, debtToEquity: 3.5 }),                 // nợ quá cao
  S('MID', { pe: 14, pb: 1.8, roae: 0.14 }),                                  // ngang ngành nhưng vẫn rẻ hơn hẳn mã đang nắm
], STATS, { GOOD: { name: 'Công ty tốt' } });

describe('suggest', () => {
  const r = RI.suggest([{ symbol: 'HELD', value: 600 }, { symbol: 'HELD2', value: 400 }], rows, ['restr']);
  it('chỉ gợi ý cho mã đang đắt so với ngành; mã rẻ đang nắm không bị gợi ý đổi', () => {
    expect(r.map((x) => x.symbol)).toEqual(['HELD']);
    expect(r[0].reasons.join('|')).toMatch(/Đắt so với ngành/);
    expect(r[0].weightPct).toBeCloseTo(60, 9);
  });
  it('ứng viên qua mọi bộ lọc: cùng ngành, rẻ hơn rõ, ROE không thấp hơn, đủ lớn/thanh khoản, chưa nắm, không hạn chế, không đẹp bất thường, nợ vừa phải', () => {
    const c = r[0].candidates.map((x) => x.symbol);
    expect(c).toEqual(['GOOD', 'MID']);                  // MID (ngang ngành) vẫn rẻ hơn rõ so với mã đang nắm (đắt nhất ngành), xếp sau GOOD
    ['LOWROE', 'SMALL', 'THIN', 'FLAG', 'RESTR', 'HELD2', 'DEBT'].forEach((s) => expect(c).not.toContain(s));
    expect(r[0].candidates[0].name).toBe('Công ty tốt');
    expect(r[0].candidates[0].why).toMatch(/phân vị định giá \d+ \(so với \d+\), ROE 18%/);
  });
  it('mã đang nắm chỉ hơi đắt thì ứng viên ngang ngành không đủ chênh lệch (cần rẻ hơn ít nhất 20 điểm phân vị)', () => {
    const rs = MS.buildRows([S('HELD', { pe: 16, pb: 2.1, roae: 0.12 }), S('MID', { pe: 14, pb: 1.8, roae: 0.14 })], STATS, {});
    expect(RI.suggest([{ symbol: 'HELD', value: 10 }], rs, [], { expensivePct: 40 })[0].candidates).toEqual([]);
  });
  it('giới hạn số ứng viên và đếm tổng', () => {
    const many = MS.buildRows([S('HELD', { pe: 26, pb: 4, roae: 0.12 })].concat([1, 2, 3, 4, 5].map((i) => S('C' + i, { pe: 8 + i * 0.2, pb: 1, roae: 0.18 }))), STATS, {});
    const x = RI.suggest([{ symbol: 'HELD', value: 100 }], many, [], { k: 2 });
    expect(x[0].candidates).toHaveLength(2); expect(x[0].candidateCount).toBe(5);
  });
});

describe('tụt hậu và các trường hợp biên', () => {
  it('mã chỉ tụt hậu (không đắt): ứng viên cũng phải không tụt hậu và rẻ hơn rõ nếu biết phân vị', () => {
    const rs = MS.buildRows([S('LAG', { pe: 14, pb: 1.8, roae: 0.12, jdkRs: 95, jdkMom: 96 }), S('LEAD', { pe: 8, pb: 1, roae: 0.16, jdkRs: 104, jdkMom: 103 }), S('LAG2', { pe: 8, pb: 1, roae: 0.16, jdkRs: 96, jdkMom: 97 })], STATS, {});
    const x = RI.suggest([{ symbol: 'LAG', value: 100 }], rs, []);
    expect(x[0].reasons.join('|')).toMatch(/Tụt hậu/);
    expect(x[0].candidates.map((c) => c.symbol)).toEqual(['LEAD']);
  });
  it('mã không có trong thị trường, không ngành, danh mục rỗng: kết quả rỗng, không lỗi', () => {
    expect(RI.suggest([{ symbol: 'ZZZ', value: 10 }], rows, [])).toEqual([]);
    expect(RI.suggest([], rows, [])).toEqual([]);
    expect(RI.suggest([{ symbol: 'HELD', value: 0 }], rows, [])).toEqual([]);
  });
  it('mã đắt nhưng không có ứng viên: vẫn trả dòng với danh sách rỗng để người dùng biết', () => {
    const solo = MS.buildRows([S('HELD', { pe: 26, pb: 4, roae: 0.12 })], STATS, {});
    const x = RI.suggest([{ symbol: 'HELD', value: 10 }], solo, []);
    expect(x).toHaveLength(1); expect(x[0].candidates).toEqual([]); expect(x[0].candidateCount).toBe(0);
  });
});
