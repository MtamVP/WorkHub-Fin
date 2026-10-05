import { describe, it, expect } from 'vitest';
import { buildSnapshot, sectorStats, quantile, snapshotDate, historyRows, monthEnds, MIN_CAP_VND } from '../../supabase/functions/market-data-sync/peers.ts';

const d = (code, date, rows) => rows.map(([c, v, g]) => ({ code: c, reportDate: date, ratioCode: code, value: v, group: g || 'STOCK' }));
const D = '2026-10-02';
const daily = {
  PRICE_TO_EARNINGS: d('PRICE_TO_EARNINGS', D, [['AAA', 10], ['BBB', 20], ['CCC', -5], ['FND', 8, 'FUND']]),
  PRICE_TO_BOOK: d('PRICE_TO_BOOK', D, [['AAA', 1.5], ['BBB', 3]]),
  MARKETCAP: d('MARKETCAP', D, [['AAA', 1000e9], ['BBB', 5000e9], ['CCC', 100e9], ['FND', 9e12, 'FUND']]),
  PRICE_TO_EARNINGS_AVG_CR_5Y: d('PRICE_TO_EARNINGS_AVG_CR_5Y', '2026-09-01', [['AAA', 12]]),     // cũ hơn 5 ngày so với các chỉ số khác: bỏ
};
const quarter = {
  ROAE_TR_AVG5Q: [{ code: 'AAA', reportDate: '2026-03-31', value: 0.1, group: 'STOCK' }, { code: 'AAA', reportDate: '2026-06-30', value: 0.15, group: 'STOCK' }, { code: 'BBB', reportDate: '2026-06-30', value: 0.2, group: 'STOCK' }],
};

describe('buildSnapshot', () => {
  const rows = buildSnapshot(daily, quarter, (s) => (s === 'AAA' ? '8300' : null));
  it('gộp chỉ số theo mã bằng tên ngắn, chỉ cổ phiếu, quý mới nhất của từng mã', () => {
    const a = rows.find((r) => r.symbol === 'AAA');
    expect(a.metrics).toMatchObject({ pe: 10, pb: 1.5, marketcap: 1000e9, roae: 0.15 });
    expect(a.icb2_code).toBe('8300');
    expect(a.daily_date).toBe(D); expect(a.quarter_date).toBe('2026-06-30');
    expect(rows.find((r) => r.symbol === 'FND')).toBeUndefined();
  });
  it('bỏ chỉ số cũ hơn hẳn các chỉ số còn lại để không trộn ngày', () => {
    expect(rows.find((r) => r.symbol === 'AAA').metrics.pe5y).toBeUndefined();
  });
  it('rỗng thì trả mảng rỗng', () => { expect(buildSnapshot({}, {}, () => null)).toEqual([]); });
});

describe('quantile và sectorStats', () => {
  it('phân vị tuyến tính', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([10, 20], 0.25)).toBe(12.5);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([], 0.5)).toBeNaN();
  });
  const mk = (sym, pe, pb, cap, icb) => ({ symbol: sym, icb2_code: icb, daily_date: D, quarter_date: null, metrics: { pe, pb, marketcap: cap } });
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(mk('S' + i, i * 2, i / 2, 1000e9, '8300'));            // P/E 2..20, P/B 0,5..5
  rows.push(mk('NEG', -3, 0.1, 1000e9, '8300'), mk('BIG', 500, 0.1, 1000e9, '8300'), mk('TINY', 1, 1, MIN_CAP_VND - 1, '8300'));
  for (let i = 1; i <= 3; i++) rows.push(mk('F' + i, 10, 1, 1000e9, '1700'));                      // ngành chỉ 3 mã
  const out = sectorStats(rows, D, 'now');
  it('chỉ tính mã đủ vốn hoá và giá trị hợp lý; trung vị và 11 điểm phân vị', () => {
    const s = out.find((x) => x.icb2_code === '8300');
    expect(s.stats.pe.n).toBe(10);
    expect(s.stats.pe.median).toBe(11);
    expect(s.stats.pe.q).toHaveLength(11);
    expect(s.stats.pe.q[0]).toBe(2); expect(s.stats.pe.q[10]).toBe(20);
    expect(s.stats.pb.median).toBe(2.25);
  });
  it('ngành quá ít mã không có thống kê; toàn thị trường (ALL) có', () => {
    expect(out.find((x) => x.icb2_code === '1700')).toBeUndefined();
    expect(out.find((x) => x.icb2_code === 'ALL').n).toBe(15);
  });
  it('ngày dữ liệu chung là ngày phổ biến nhất', () => {
    expect(snapshotDate([{ daily_date: '2026-10-02' }, { daily_date: '2026-10-02' }, { daily_date: '2026-10-01' }])).toBe('2026-10-02');
    expect(snapshotDate([])).toBeNull();
  });
});

describe('historyRows: lịch sử định giá', () => {
  const mk = (sym, icb, pe, pb, cap) => ({ symbol: sym, icb2_code: icb, daily_date: '2026-09-30', quarter_date: null, metrics: { pe, pb, marketcap: cap } });
  const rows = [];
  for (let i = 1; i <= 6; i++) rows.push(mk('A' + i, '8300', i * 2, i / 2, i * 1000e9));       // P/E 2..12; vốn hoá 1..6 nghìn tỷ
  rows.push(mk('LOSS', '8300', -4, 1, 1000e9), mk('TINY', '8300', 1, 1, 100e9), mk('X1', '1700', 10, 1, 500e9), mk('X2', '1700', 12, 1.2, 500e9));
  const out = historyRows(rows, '2026-09-30');
  const bank = out.find((x) => x.scope === '8300'), all = out.find((x) => x.scope === 'ALL');
  it('trung vị và giá trị tổng hợp theo vốn hoá (điều hoà), bỏ mã lỗ và mã nhỏ', () => {
    expect(bank.n_pe).toBe(6);
    expect(bank.pe_median).toBe(7);
    const cap = 21000e9, denom = [1, 2, 3, 4, 5, 6].reduce((s, i) => s + (i * 1000e9) / (i * 2), 0);
    expect(bank.pe_agg).toBeCloseTo(Math.round(cap / denom * 10000) / 10000, 3);
    expect(bank.n).toBe(7);                                   // 6 mã + LOSS (đủ vốn hoá); TINY bị loại
  });
  it('ngành chỉ 2 mã không có dòng; toàn thị trường có và cộng vốn hoá', () => {
    expect(out.find((x) => x.scope === '1700')).toBeUndefined();
    expect(all.mcap_total).toBe(21000e9 + 1000e9 + 1000e9);
    expect(out[0].scope).toBe('8300');
  });
  it('không đủ dữ liệu: rỗng', () => { expect(historyRows([], '2026-09-30')).toEqual([]); });
});

describe('monthEnds', () => {
  it('ngày cuối mỗi tháng, mới nhất trước, qua năm, tháng 2 nhuận', () => {
    expect(monthEnds('2023-11', '2024-03')).toEqual(['2024-03-31', '2024-02-29', '2024-01-31', '2023-12-31', '2023-11-30']);
  });
  it('đầu vào xấu hoặc ngược thứ tự: rỗng', () => {
    expect(monthEnds('2024-13', '2024-03')).toEqual([]);
    expect(monthEnds('2024-05', '2024-03')).toEqual([]);
    expect(monthEnds('abc', '2024-03')).toEqual([]);
  });
});
