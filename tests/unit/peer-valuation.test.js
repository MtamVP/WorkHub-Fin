import { describe, it, expect } from 'vitest';
import P from '../../lib/peer-valuation.js';

const Q = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];      // P/E ngành giả: p0=2 ... p100=22 (đều)

describe('percentile', () => {
  it('nội suy tuyến tính trên 11 điểm; kẹp hai đầu', () => {
    expect(P.percentile(12, Q)).toBeCloseTo(50, 9);
    expect(P.percentile(7, Q)).toBeCloseTo(25, 9);
    expect(P.percentile(1, Q)).toBe(0);
    expect(P.percentile(99, Q)).toBe(100);
  });
  it('điểm đầu vào xấu trả null; phân phối phẳng trả giữa', () => {
    expect(P.percentile(null, Q)).toBeNull();
    expect(P.percentile(5, [1, 2])).toBeCloseTo(100, 9);
    expect(P.percentile(5, null)).toBeNull();
    expect(P.percentile(5, [5, 5, 5])).toBe(50);
  });
});

const stats = {
  pe: { n: 40, median: 12, q: Q },
  pb: { n: 40, median: 1.5, q: [0.5, 0.8, 1, 1.2, 1.4, 1.5, 1.7, 2, 2.5, 3, 4] },
  roae: { n: 40, median: 0.12, q: [-0.02, 0.03, 0.06, 0.09, 0.11, 0.12, 0.14, 0.17, 0.2, 0.25, 0.35] },
};

describe('assess', () => {
  it('rẻ so với ngành khi P/E và P/B đều ở phân vị thấp, ROE trên trung bình', () => {
    const a = P.assess({ pe: 5, pb: 0.9, roae: 0.18 }, stats);
    expect(a.items.pe.pct).toBeCloseTo(15, 9);
    expect(a.items.pe.ratio).toBeCloseTo(5 / 12, 9);
    expect(a.valuationPct).toBeLessThan(30);
    expect(a.verdict.key).toBe('cheap');
    expect(a.verdict.text).toMatch(/ROE từ trung bình trở lên/);
  });
  it('rẻ nhưng ROE thuộc nhóm thấp: cảnh báo bẫy giá trị', () => {
    const a = P.assess({ pe: 5, pb: 0.9, roae: 0.02 }, stats);
    expect(a.verdict.key).toBe('cheap-lowq'); expect(a.verdict.tone).toBe('warn');
  });
  it('đắt: có ROE cao thì nêu premium chất lượng, không thì cảnh báo', () => {
    expect(P.assess({ pe: 20, pb: 3.5, roae: 0.3 }, stats).verdict.key).toBe('rich-highq');
    expect(P.assess({ pe: 20, pb: 3.5, roae: 0.1 }, stats).verdict.key).toBe('rich');
  });
  it('quanh trung vị: ngang ngành; thiếu thống kê hoặc quá ít mã: không kết luận', () => {
    expect(P.assess({ pe: 12, pb: 1.5, roae: 0.12 }, stats).verdict.key).toBe('inline');
    expect(P.assess({ pe: 12 }, {}).verdict).toBeNull();
    expect(P.assess({ pe: 12 }, { pe: { n: 3, median: 12, q: Q } }).verdict).toBeNull();
    expect(P.assess(null, null).valuationPct).toBeNull();
  });
  it('chỉ một trong P/E hoặc P/B vẫn đánh giá được (mã lỗ không có P/E hợp lệ)', () => {
    const a = P.assess({ pb: 0.9 }, stats);
    expect(a.items.pe).toBeNull(); expect(a.valuationPct).toBeLessThan(30);
  });
});

describe('peerTable', () => {
  const mk = (s, pe, pb, roe, cap) => ({ symbol: s, metrics: { pe, pb, roae: roe, marketcap: cap } });
  const rows = [mk('AAA', 6, 1, 0.2, 5e12), mk('BBB', 12, 1.5, 0.12, 4e12), mk('CCC', 20, 3, 0.1, 3e12), mk('DDD', 4, 0.6, 0.05, 1e11), mk('XYZ', 9, 1.2, 0.15, 2e11)];
  it('xếp từ rẻ đến đắt, bỏ mã nhỏ (trừ chính mã đang xem), đánh thứ hạng', () => {
    const t = P.peerTable(rows, 'xyz', stats);
    expect(t.rows.map((r) => r.symbol)).toEqual(['AAA', 'XYZ', 'BBB', 'CCC']);
    expect(t.self.symbol).toBe('XYZ'); expect(t.self.rank).toBe(2); expect(t.total).toBe(4);
    expect(t.rows.some((r) => r.symbol === 'DDD')).toBe(false);
  });
  it('giới hạn số dòng nhưng luôn giữ mã đang xem', () => {
    const t = P.peerTable(rows, 'CCC', stats, { limit: 1 });
    expect(t.rows.map((r) => r.symbol)).toEqual(['AAA', 'CCC']);
  });
  it('không có mã đang xem: self null', () => {
    expect(P.peerTable(rows, 'QQQ', stats).self).toBeNull();
  });
});

describe('quality', () => {
  const sector = (n, asOf, q) => ({ n, as_of: asOf, stats: { pe: { n, median: 10, q: q || Q }, pb: { n, median: 1.5, q: [0.5, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.4, 3, 4] } } });
  it('đủ mã, số liệu mới, phân phối vừa phải: tin cậy tốt, không ghi chú', () => {
    const r = P.quality(sector(40, '2026-10-05'), { today: '2026-10-06' });
    expect(r.level).toBe('high'); expect(r.notes).toEqual([]); expect(r.label).toBe('Tin cậy tốt');
  });
  it('ít mã: thấp (dưới 8) hoặc vừa (dưới 20)', () => {
    expect(P.quality(sector(6, '2026-10-05'), { today: '2026-10-05' }).level).toBe('low');
    const m = P.quality(sector(15, '2026-10-05'), { today: '2026-10-05' });
    expect(m.level).toBe('medium'); expect(m.notes.join()).toMatch(/15 mã/);
  });
  it('số liệu cũ: hơn 5 ngày vừa, hơn 10 ngày thấp; không bị hạ nhầm khi hôm nay trùng ngày số liệu', () => {
    expect(P.quality(sector(40, '2026-10-05'), { today: '2026-10-05' }).level).toBe('high');
    expect(P.quality(sector(40, '2026-09-28'), { today: '2026-10-05' }).level).toBe('medium');
    const lo = P.quality(sector(40, '2026-09-20'), { today: '2026-10-05' });
    expect(lo.level).toBe('low'); expect(lo.notes.join()).toMatch(/15 ngày/);
  });
  it('phân phối P/E quá rộng (p80 > 4 lần p20): hạ xuống vừa; không hạ thấp hơn mức đã thấp', () => {
    const wide = [1, 1.2, 2, 3, 4, 6, 8, 10, 12, 20, 40];
    const r = P.quality(sector(40, '2026-10-05', wide), { today: '2026-10-05' });
    expect(r.level).toBe('medium'); expect(r.notes.join()).toMatch(/P\/E.*phân tán/);
    expect(P.quality(sector(5, '2026-10-05', wide), { today: '2026-10-05' }).level).toBe('low');
  });
  it('ngành tài chính thêm ghi chú nhưng không hạ mức; thiếu dữ liệu: thấp, không lỗi', () => {
    const f = P.quality(sector(40, '2026-10-05'), { today: '2026-10-05', financial: true });
    expect(f.level).toBe('high'); expect(f.notes.join()).toMatch(/P\/B/);
    expect(P.quality(null).level).toBe('low');
    expect(P.quality({}).notes.join()).toMatch(/không rõ/);
  });
});
