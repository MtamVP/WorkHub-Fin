import { describe, it, expect } from 'vitest';
import SE from '../../lib/style-exposure.js';

const Q = (lo, hi) => Array.from({ length: 11 }, (_, i) => lo + (hi - lo) * i / 10);
const MARKET = { pe: { q: Q(4, 24) }, pb: { q: Q(0.5, 4.5) }, roae: { q: Q(0, 0.3) }, marketcap: { q: Q(300e9, 30000e9) }, chg1y: { q: Q(-0.5, 1) }, beta: { q: Q(0.3, 1.8) }, divYield: { q: Q(0, 0.08) } };
const M = (o) => Object.assign({ pe: 14, pb: 2.5, roae: 0.15, marketcap: 15000e9, chg1y: 0.25, beta: 1.05, divYield: 0.04 }, o);   // mọi thứ ~ giữa thị trường

describe('compute: phân vị có trọng số theo nhân tố', () => {
  it('danh mục trung lập: mọi nhân tố quanh 50, không có nghiêng', () => {
    const r = SE.compute([{ symbol: 'A', value: 100 }], { A: { metrics: M() } }, MARKET);
    r.factors.forEach((f) => { expect(f.pct).toBeGreaterThan(40); expect(f.pct).toBeLessThan(60); });
    expect(r.tilts).toEqual([]);
  });
  it('rẻ, nhỏ, ROE thấp, cổ tức cao: nghiêng đúng chiều và nêu lý do bằng lời', () => {
    const cheap = M({ pe: 5, pb: 0.7, roae: 0.02, marketcap: 400e9, divYield: 0.07 });
    const r = SE.compute([{ symbol: 'A', value: 100 }], { A: { metrics: cheap } }, MARKET);
    const by = (k) => r.factors.find((f) => f.key === k);
    expect(by('value').pct).toBeGreaterThan(80); expect(by('quality').pct).toBeLessThan(15); expect(by('size').pct).toBeLessThan(10); expect(by('income').pct).toBeGreaterThan(80);
    const t = r.tilts.map((x) => x.text).join(' | ');
    expect(t).toMatch(/Giá trị \(rẻ\)/); expect(t).toMatch(/Quy mô lớn.*thanh khoản mỏng/); expect(r.tilts.find((x) => x.key === 'quality').side).toBe('low');
  });
  it('beta cao thì nhân tố ít biến động thấp (đảo chiều)', () => {
    const r = SE.compute([{ symbol: 'A', value: 100 }], { A: { metrics: M({ beta: 1.7 }) } }, MARKET);
    expect(r.factors.find((f) => f.key === 'lowvol').pct).toBeLessThan(15);
  });
  it('trọng số theo giá trị vị thế: mã lớn quyết định', () => {
    const r = SE.compute([{ symbol: 'BIG', value: 900 }, { symbol: 'SMALL', value: 100 }], { BIG: { metrics: M({ roae: 0.3 }) }, SMALL: { metrics: M({ roae: 0 }) } }, MARKET);
    expect(r.factors.find((f) => f.key === 'quality').pct).toBeCloseTo(90, 5);
    expect(r.factors.find((f) => f.key === 'quality').positions[0].symbol).toBe('BIG');
  });
  it('thiếu số liệu: nhân tố dưới 50% giá trị có dữ liệu thì không báo; độ phủ được tính', () => {
    const r = SE.compute([{ symbol: 'A', value: 30 }, { symbol: 'B', value: 70 }], { A: { metrics: M() } }, MARKET);
    expect(r.coverage).toBeCloseTo(0.3, 9);
    r.factors.forEach((f) => expect(f.pct).toBeNull());
  });
  it('vị thế 0, danh mục rỗng, không có thống kê thị trường: kết quả rỗng, không lỗi', () => {
    expect(SE.compute([], {}, MARKET).factors).toEqual([]);
    expect(SE.compute([{ symbol: 'A', value: 0 }], { A: { metrics: M() } }, MARKET).factors).toEqual([]);
    expect(SE.compute([{ symbol: 'A', value: 5 }], { A: { metrics: M() } }, {}).factors).toEqual([]);
  });
});
