import { describe, it, expect } from 'vitest';
import MS from '../../lib/market-screener.js';
import FV from '../../lib/filter-validate.js';

const SAVED = [{ name: 'Rẻ', filters: { values: { pe: 10 } } }];
const NAMES = Array.from({ length: 150 }, (_, i) => 'S' + String(i).padStart(3, '0'));

// Ảnh chụp tổng hợp: mã nằm trong `cheap` có P/E 8 (lọt bộ lọc), còn lại 20; chg: hàm (mã) -> [chg1m, chg3m, chg6m]
function day(date, cheap, chg) {
  const snap = NAMES.map((s) => { const c = chg(s) || [null, null, null]; return { symbol: s, icb2_code: '2700', metrics: { marketcap: 1e12, pe: cheap.includes(s) ? 8 : 20, chg1m: c[0], chg3m: c[1], chg6m: c[2] } }; });
  return Object.assign({ date }, FV.extractDay(MS.buildRows(snap, {}, {}), SAVED));
}
const cheap1 = NAMES.slice(0, 40);

describe('extractDay', () => {
  it('trả danh sách mã đạt từng bộ lọc, tỷ lệ phủ số liệu của tiêu chí và lợi suất 1/3/6 tháng', () => {
    const d = day('2026-01-05', cheap1, () => [0.01, 0.03, 0.06]);
    expect(d.matches['Rẻ']).toHaveLength(40);
    expect(d.cover['Rẻ'].pe).toBe(1);
    expect(d.ret.S000).toEqual([0.01, 0.03, 0.06]);
  });
  it('bỏ bộ lọc trống; mã không có chỉ số biến động nào thì không vào ret', () => {
    const snap = [{ symbol: 'AAA', icb2_code: '2700', metrics: { marketcap: 1e12, pe: 5 } }];
    const d = FV.extractDay(MS.buildRows(snap, {}, {}), [{ name: 'Trống', filters: { values: {} } }, SAVED[0]]);
    expect(Object.keys(d.matches)).toEqual(['Rẻ']); expect(d.ret.AAA).toBeUndefined();
  });
});

describe('analyze: lợi suất sau khi lọt vào so với trung vị thị trường', () => {
  // 40 mã rẻ ở ngày đầu; thị trường chung +2%/tháng; nhóm rẻ +10% sau 1 tháng, +9% sau 3 tháng (thị trường +6%), -2% sau 6 tháng (thị trường +12%)
  const chg = (cheap) => (s) => (cheap.includes(s) ? [0.10, 0.09, -0.02] : [0.02, 0.06, 0.12]);
  const days = [
    day('2026-01-05', cheap1, () => null),
    day('2026-02-05', cheap1, chg(cheap1)),
    day('2026-04-05', cheap1, chg(cheap1)),
    day('2026-07-06', cheap1, chg(cheap1)),
  ];
  it('mọi mã đạt ở ngày đầu là sự kiện khởi đầu; đo đúng chênh lệch theo từng kỳ', () => {
    const r = FV.analyze(days, SAVED), f = r.filters[0];
    expect(f.events).toBe(40); expect(f.entryDates).toBe(1); expect(f.usableDays).toBe(4);
    const [m1, m3, m6] = f.horizons;
    expect(m1.n).toBe(40); expect(m1.medianExcess).toBeCloseTo(0.08, 4); expect(m1.beat).toBe(1);
    expect(m3.medianExcess).toBeCloseTo(0.03, 4);
    expect(m6.medianExcess).toBeCloseTo(-0.14, 4); expect(m6.beat).toBe(0);
    expect(m1.enough).toBe(false);                                   // 40 sự kiện nhưng chỉ 1 ngày lọt vào
    expect(FV.line(m1)).toContain('chưa rút kết luận'); expect(FV.line(m1)).toContain('+8,0 điểm %');
  });
  it('chỉ mã MỚI lọt vào ở các ngày sau mới thành sự kiện; mã ở lại không đếm lại; rớt rồi vào lại trong 30 ngày không đếm', () => {
    const a = NAMES.slice(0, 5), b = NAMES.slice(5, 8);
    const ds = [
      day('2026-01-05', a, () => null),
      day('2026-01-12', a.concat(b), () => null),                            // b mới lọt vào
      day('2026-01-19', b, () => null),                                      // a rớt
      day('2026-01-26', a.concat(b), () => null),                            // a vào lại sau 14 ngày: không đếm
      day('2026-03-30', a.concat(b), () => null),
    ];
    const f = FV.analyze(ds, SAVED, { minBench: 1 }).filters[0];
    expect(f.events).toBe(8); expect(f.entryDates).toBe(2);
  });
  it('rớt rồi vào lại sau hơn 30 ngày thì tính là sự kiện mới', () => {
    const a = NAMES.slice(0, 3);
    const ds = [day('2026-01-05', a, () => null), day('2026-01-12', [], () => null), day('2026-03-02', a, () => null)];
    expect(FV.analyze(ds, SAVED, { minBench: 1 }).filters[0].events).toBe(6);
  });
  it('chưa tới mốc thì tính là đang chờ; có ngày nhưng thiếu số liệu của mã thì tính là thiếu', () => {
    const ds = [day('2026-01-05', cheap1, () => null), day('2026-02-05', cheap1, (s) => (s === 'S000' ? null : [0.1, null, null]))];
    const h = FV.analyze(ds, SAVED).filters[0].horizons;
    expect(h[0].n).toBe(39); expect(h[0].noData).toBe(1);
    expect(h[1].n).toBe(0); expect(h[1].pending).toBe(40);
    expect(FV.line(h[1])).toContain('Chưa đủ thời gian');
  });
  it('đủ mẫu (30 sự kiện, 5 ngày lọt vào) thì không còn lời cảnh báo mẫu nhỏ', () => {
    const ds = [], pad = (n) => String(n).padStart(2, '0'), all = NAMES.slice(0, 35), up = (s) => (all.includes(s) ? [0.05, null, null] : [0.01, null, null]);
    for (let i = 0; i <= 5; i++) ds.push(day('2026-01-' + pad(5 + i * 3), NAMES.slice(0, 10 + i * 5), () => null));          // 10 mã ngày đầu, mỗi ngày sau thêm 5 mã
    for (let i = 0; i <= 5; i++) ds.push(day('2026-02-' + pad(5 + i * 3), all, up));                                        // đúng mốc 1 tháng của từng ngày lọt vào
    const f = FV.analyze(ds, SAVED).filters[0], h = f.horizons[0];
    expect(f.events).toBe(35); expect(f.entryDates).toBe(6);
    expect(h.n).toBe(35); expect(h.dates).toBe(6); expect(h.medianExcess).toBeCloseTo(0.04, 4); expect(h.enough).toBe(true);
    expect(FV.line(h)).not.toContain('Mẫu còn nhỏ'); expect(FV.line(h)).toContain('100% số mã hơn thị trường');
  });
  it('ngày chưa có số liệu cho tiêu chí (ảnh chụp cũ) không dùng để so sánh; không có ngày nào dùng được thì nêu lý do', () => {
    const weak = { date: '2026-01-05', matches: { 'Rẻ': ['S000'] }, cover: { 'Rẻ': { pe: 0 } }, ret: {} };
    const r = FV.analyze([weak], SAVED).filters[0];
    expect(r.usableDays).toBe(0); expect(r.note).toContain('Chưa có ngày nào');
    const thin = { date: '2026-01-06', matches: { 'Rẻ': NAMES.slice(0, 40) }, cover: { 'Rẻ': { pe: 0.1 } }, ret: {} };       // phủ 10% < 30% so với ngày đầy đủ
    const full = day('2026-01-07', cheap1, () => null);
    const r2 = FV.analyze([thin, full], SAVED).filters[0];
    expect(r2.usableDays).toBe(1);
  });
  it('bộ lọc trống và không có dữ liệu không gây lỗi', () => {
    expect(FV.analyze([], SAVED).filters[0].usableDays).toBe(0);
    expect(FV.analyze([day('2026-01-05', cheap1, () => null)], [{ name: 'Trống', filters: { values: {} } }]).filters[0].note).toBe('Bộ lọc trống.');
    expect(FV.analyze(null, null)).toEqual({ dates: [], latest: null, filters: [] });
  });
  it('tìm ngày đích trong khoảng -2 đến +7 ngày quanh mốc', () => {
    const dates = ['2026-01-05', '2026-02-02', '2026-02-12', '2026-03-01'];
    expect(FV.findTarget(dates, '2026-01-05', 1).index).toBe(2);        // mốc 05/02: 02/02 lệch -3 (ngoài khoảng), 12/02 lệch +7 (trong khoảng)
    expect(FV.findTarget(dates, '2026-01-05', 3).index).toBeNull();
  });
});
