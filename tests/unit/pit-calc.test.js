// Kho dữ liệu theo thời điểm (lib/pit-calc.js): giải mã bản chụp, tra số liệu "như ngày D", hạn công bố bảo thủ, độ phủ và tiến độ.
import { describe, it, expect } from 'vitest';
import P from '../../lib/pit-calc.js';

const COLS = ['icb2', 'price', 'pe', 'roae'];
const row = (asOf, data) => ({ as_of: asOf, n: Object.keys(data).length, cols: COLS, data: data });

describe('decodeDay / decodeDays', () => {
  it('đọc theo tên cột; icb2 là chuỗi, còn lại là số; mã không có -> null', () => {
    const d = P.decodeDay(row('2026-10-09', { FPT: ['9500', 95000, 10.9, 0.24], VNM: [9500, null, 'x', 0.3] }));
    expect(d.asOf).toBe('2026-10-09'); expect(d.n).toBe(2);
    expect(d.get('fpt')).toEqual({ icb2: '9500', price: 95000, pe: 10.9, roae: 0.24 });
    expect(d.get('VNM')).toEqual({ icb2: '9500', price: null, pe: null, roae: 0.3 });
    expect(d.get('ZZZ')).toBeNull(); expect(d.has('FPT')).toBe(true); expect(d.has('ZZZ')).toBe(false);
  });
  it('dòng hỏng bị bỏ; kết quả sắp theo ngày tăng dần', () => {
    expect(P.decodeDay(null)).toBeNull(); expect(P.decodeDay({ as_of: '2026-10-09', cols: 'x', data: {} })).toBeNull();
    const ds = P.decodeDays([row('2026-10-09', { A: ['1', 1, 1, 1] }), { bad: 1 }, row('2026-10-07', { A: ['1', 1, 1, 1] })]);
    expect(ds.map((d) => d.asOf)).toEqual(['2026-10-07', '2026-10-09']);
  });
});

describe('tra số liệu như ngày D (không nhìn trước)', () => {
  const days = P.decodeDays([row('2026-10-05', { A: ['1', 10, 8, 0.1] }), row('2026-10-07', { A: ['1', 12, 9, 0.12] }), row('2026-10-09', { A: ['1', 15, 11, 0.2] })]);
  it('lấy bản mới nhất KHÔNG SAU ngày hỏi', () => {
    expect(P.valueAsOf(days, 'A', 'price', '2026-10-08').value).toBe(12);
    expect(P.valueAsOf(days, 'A', 'price', '2026-10-09').value).toBe(15);
    expect(P.valueAsOf(days, 'A', 'price', '2026-10-06')).toMatchObject({ value: 10, stale: 1, asOf: '2026-10-05' });
  });
  it('trước bản chụp đầu tiên thì không có gì (không dùng số liệu của tương lai)', () => {
    expect(P.valueAsOf(days, 'A', 'price', '2026-10-01')).toBeNull();
  });
  it('bản quá cũ coi như không có; mã/cột thiếu -> null', () => {
    expect(P.valueAsOf(days, 'A', 'price', '2026-11-30')).toBeNull();
    expect(P.valueAsOf(days, 'A', 'price', '2026-11-30', 100).value).toBe(15);
    expect(P.valueAsOf(days, 'B', 'price', '2026-10-09')).toBeNull();
  });
  it('vũ trụ như ngày đó, có thể lọc bằng điều kiện', () => {
    const u = P.universeAsOf(P.decodeDays([row('2026-10-09', { A: ['1', 1, 5, 0.3], B: ['1', 1, 20, 0.05], C: ['2', 1, 7, 0.2] })]), '2026-10-10', (m) => m.pe < 10 && m.roae > 0.15);
    expect(u.asOf).toBe('2026-10-09'); expect(u.rows.map((r) => r.symbol)).toEqual(['A', 'C']);
    expect(P.universeAsOf(days, '2026-01-01').rows).toEqual([]);
  });
});

describe('số liệu báo cáo theo ngày thấy', () => {
  const rows = [
    { symbol: 'FPT', seen_at: '2026-07-20', quarter_key: '2026Q2', data: { v: 'q2' } },
    { symbol: 'FPT', seen_at: '2026-04-18', quarter_key: '2026Q1', data: { v: 'q1' } },
    { symbol: 'VNM', seen_at: '2026-07-01', quarter_key: '2026Q2', data: { v: 'x' } },
  ];
  it('chỉ dùng dòng đã được thấy vào ngày đó', () => {
    expect(P.fundamentalAsOf(rows, 'FPT', '2026-07-19').quarterKey).toBe('2026Q1');
    expect(P.fundamentalAsOf(rows, 'FPT', '2026-07-20').quarterKey).toBe('2026Q2');
    expect(P.fundamentalAsOf(rows, 'FPT', '2026-04-17')).toBeNull();
    expect(P.fundamentalAsOf(rows, 'VNM', '2026-07-01').data.v).toBe('x');
  });
});

describe('hạn công bố bảo thủ', () => {
  it('quý +45 ngày, năm +90 ngày; ngày sai -> null', () => {
    expect(P.knownAt('2026-06-30', 'quarter')).toBe('2026-08-14');
    expect(P.knownAt('2025-12-31', 'annual')).toBe('2026-03-31');
    expect(P.knownAt('abc', 'quarter')).toBeNull();
  });
  it('quý mới nhất chắc chắn đã biết vào ngày D', () => {
    const qs = [{ year: 2026, quarter: 2 }, { year: 2026, quarter: 1 }, { year: 2025, quarter: 4 }];
    expect(P.latestKnownQuarter(qs, '2026-08-13')).toMatchObject({ year: 2026, quarter: 1, knownAt: '2026-05-15' });
    expect(P.latestKnownQuarter(qs, '2026-08-14')).toMatchObject({ year: 2026, quarter: 2 });
    expect(P.latestKnownQuarter(qs, '2026-03-30')).toBeNull();             // Q4/2025 phải chờ hạn năm (+90 ngày) -> 31/3/2026
    expect(P.latestKnownQuarter(qs, '2026-03-31')).toMatchObject({ year: 2025, quarter: 4 });
  });
  it('cuối quý tính đúng cả tháng 2 và tháng 12', () => {
    expect(P.quarterEnd(2026, 1)).toBe('2026-03-31'); expect(P.quarterEnd(2026, 2)).toBe('2026-06-30'); expect(P.quarterEnd(2026, 3)).toBe('2026-09-30'); expect(P.quarterEnd(2026, 4)).toBe('2026-12-31');
  });
});

describe('độ phủ và tiến độ', () => {
  it('kho rỗng', () => { expect(P.coverage([]).days).toBe(0); });
  it('đếm ngày thường bị thiếu, bỏ cuối tuần và ngày lễ', () => {
    // 2026-10-05 (thứ 2) .. 2026-10-12: thiếu thứ 4 (7/10) và thứ 6 (9/10); 8/10 là ngày lễ giả định
    const rows = [row('2026-10-05', { A: ['1', 1, 1, 1] }), row('2026-10-06', { A: ['1', 1, 1, 1] }), row('2026-10-12', { A: ['1', 1, 1, 1], B: ['1', 1, 1, 1] })];
    const c = P.coverage(rows, { isHoliday: (iso) => iso === '2026-10-08', today: '2026-10-14' });
    expect(c.days).toBe(3); expect(c.first).toBe('2026-10-05'); expect(c.last).toBe('2026-10-12');
    expect(c.missingDays).toBe(2); expect(c.gaps).toEqual([{ from: '2026-10-07', to: '2026-10-07', days: 1 }, { from: '2026-10-09', to: '2026-10-09', days: 1 }]);
    expect(c.minSymbols).toBe(1); expect(c.staleDays).toBe(2);
  });
  it('tiến độ tới lúc đủ để backtest', () => {
    expect(P.readiness(1)).toMatchObject({ have: 1, periods: 0, ok: false });
    const r = P.readiness(63 + 21 * 12);
    expect(r.ok).toBe(true); expect(r.pct).toBe(1);
    expect(P.readiness(100).pct).toBeCloseTo(100 / (63 + 252), 6);
  });
});
