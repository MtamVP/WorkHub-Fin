import { describe, it, expect } from 'vitest';
import VH from '../../lib/valuation-history.js';

// 60 tháng: P/E tổng hợp thị trường 10..14 dao động, tháng cuối đặt riêng
const mkRows = (scope, vals, startYear = 2021) => vals.map((v, i) => ({ as_of: `${startYear + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-28`, scope, pe_agg: v, pb_agg: v / 6 }));
const base = Array.from({ length: 60 }, (_, i) => 10 + (i % 5));              // 10..14 lặp
const rowsCheap = mkRows('ALL', base.slice(0, 59).concat([10]));                // cuối = 10 (thấp nhất lặp lại)
const rowsRich = mkRows('ALL', base.slice(0, 59).concat([20]));

describe('seriesOf', () => {
  it('lọc đúng phạm vi và chỉ số, sắp theo ngày, bỏ giá trị không hợp lệ', () => {
    const rows = [{ as_of: '2024-02-28', scope: 'ALL', pe_agg: 12 }, { as_of: '2024-01-31', scope: 'ALL', pe_agg: 10 }, { as_of: '2024-01-31', scope: '8300', pe_agg: 7 }, { as_of: '2024-03-29', scope: 'ALL', pe_agg: null }, { as_of: '2024-04-30', scope: 'ALL', pe_agg: -3 }];
    expect(VH.seriesOf(rows, 'ALL', 'pe_agg')).toEqual([{ d: '2024-01-31', v: 10 }, { d: '2024-02-28', v: 12 }]);
  });
});

describe('summarize', () => {
  it('giá trị thấp nhất lịch sử: phân vị thấp, nhãn rẻ; giá trị cao nhất: nhãn đắt', () => {
    const lo = VH.summarize(VH.seriesOf(rowsCheap, 'ALL', 'pe_agg'), { years: 5 });
    expect(lo.enough).toBe(true); expect(lo.now).toBe(10); expect(lo.pct).toBeLessThan(20); expect(lo.label.key).toBe('cheap');
    const hi = VH.summarize(VH.seriesOf(rowsRich, 'ALL', 'pe_agg'), { years: 5 });
    expect(hi.pct).toBeGreaterThan(95); expect(hi.label.key).toBe('rich'); expect(hi.z).toBeGreaterThan(2);
    expect(hi.max).toBe(20); expect(hi.min).toBe(10);
  });
  it('cửa sổ năm cắt đúng: 1 năm chỉ còn 12-13 điểm, thiếu điểm thì không kết luận', () => {
    const s = VH.seriesOf(rowsRich, 'ALL', 'pe_agg');
    expect(VH.summarize(s, { years: 1 }).n).toBeLessThanOrEqual(13);
    expect(VH.summarize(s.slice(0, 8), { years: 5 }).enough).toBe(false);
    expect(VH.summarize(s.slice(0, 8), { years: 5 }).label).toBeNull();
    expect(VH.summarize([], {})).toBeNull();
  });
  it('trùng giá trị thì lấy giữa (midrank), trung vị và trung bình đúng', () => {
    const flat = VH.seriesOf(mkRows('ALL', Array(24).fill(12)), 'ALL', 'pe_agg');
    const r = VH.summarize(flat, { years: 5 });
    expect(r.pct).toBe(50); expect(r.median).toBe(12); expect(r.mean).toBe(12); expect(r.z).toBe(0);
  });
});

describe('sectorBoard, sparkline, earningsYieldSpread', () => {
  const rows = mkRows('ALL', base).concat(mkRows('8300', base.map((v) => v / 2).slice(0, 59).concat([3])), mkRows('1700', base.map((v) => v * 1.5).slice(0, 59).concat([30])), mkRows('9999', [5, 6, 7]));
  it('xếp ngành rẻ nhất (so với chính nó) trước; bỏ ngành thiếu dữ liệu và ALL', () => {
    const b = VH.sectorBoard(rows, 'pe_agg', 5, (c) => 'Ngành ' + c);
    expect(b.map((x) => x.scope)).toEqual(['8300', '1700']);
    expect(b[0].name).toBe('Ngành 8300'); expect(b[0].summary.pct).toBeLessThan(b[1].summary.pct);
  });
  it('sparkline có đường và điểm cuối trong khung; ít hơn 2 điểm thì rỗng', () => {
    const sp = VH.sparkline(VH.seriesOf(rows, 'ALL', 'pe_agg'), 100, 30);
    expect(sp.d.startsWith('M')).toBe(true); expect(sp.last[0]).toBeLessThanOrEqual(100); expect(sp.last[1]).toBeLessThanOrEqual(30);
    expect(VH.sparkline([{ d: '2024-01-01', v: 1 }], 100, 30).d).toBe('');
  });
  it('lợi suất lợi nhuận trừ lợi suất trái phiếu 10 năm', () => {
    const e = VH.earningsYieldSpread(12.5, 4.59);
    expect(e.earningsYieldPct).toBeCloseTo(8, 9); expect(e.spreadPct).toBeCloseTo(8 - 4.59, 9);
    expect(VH.earningsYieldSpread(12.5, null).spreadPct).toBeNull();
    expect(VH.earningsYieldSpread(-1, 4)).toBeNull();
  });
});
