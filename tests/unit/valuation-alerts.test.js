import { describe, it, expect } from 'vitest';
import VA from '../../lib/valuation-alerts.js';

// 60 điểm tháng liên tiếp kết thúc 2026-09-30; vals(i) trả giá trị điểm thứ i (0 = cũ nhất)
function rows(scope, key, vals, extra) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const d = new Date(Date.UTC(2026, 8, 30) - (vals.length - 1 - i) * 30.4 * 86400000).toISOString().slice(0, 10);
    out.push(Object.assign({ as_of: d, scope: scope }, extra || {}, { [key]: vals[i] }));
  }
  return out;
}
const up = (n, lo, hi) => Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1));
const flat = (n, v) => Array.from({ length: n }, () => v);
const get = (r, k) => r.alerts.find((a) => a.key === k);

describe('thị trường', () => {
  it('P/E ở đỉnh lịch sử 5 năm -> cảnh báo đắt; không có cảnh báo rẻ', () => {
    const r = VA.build(rows('ALL', 'pe_agg', up(60, 8, 18)), []);
    expect(r.enough).toBe(true);
    const a = get(r, 'market-rich-P/E');
    expect(a.level).toBe('warn'); expect(a.detail).toMatch(/phân vị 9\d|phân vị 100/);
    expect(r.alerts.some((x) => /market-cheap/.test(x.key))).toBe(false);
  });
  it('P/E ở đáy -> thông tin rẻ (kèm nhắc kiểm tra lợi nhuận), xếp sau cảnh báo', () => {
    const r = VA.build(rows('ALL', 'pe_agg', up(60, 18, 8)), []);
    const a = get(r, 'market-cheap-P/E');
    expect(a.level).toBe('info'); expect(a.detail).toMatch(/lợi nhuận/);
  });
  it('quanh trung bình: không cảnh báo mức; dịch chuyển nhanh thì báo riêng', () => {
    const mid = VA.build(rows('ALL', 'pe_agg', flat(60, 12)), []);
    expect(mid.alerts).toEqual([]);
    const v = Array.from({ length: 60 }, (_, i) => 8 + ((i * 7) % 11));                     // 8..18 phân bố đều
    v[56] = 9; v[57] = v[58] = v[59] = 17;                                                  // 3 tháng cuối nhảy từ vùng thấp lên vùng cao
    const s = VA.build(rows('ALL', 'pe_agg', v), []);
    expect(get(s, 'market-shift-P/E')).toBeTruthy();
  });
  it('quá ít dữ liệu (dưới 12 điểm): không kết luận', () => {
    const r = VA.build(rows('ALL', 'pe_agg', up(8, 8, 18)), []);
    expect(r.enough).toBe(false); expect(r.alerts).toEqual([]);
  });
  it('đắt ở nhóm vốn hoá lớn nhưng mã trung vị bình thường -> nhận xét độ rộng', () => {
    const h = rows('ALL', 'pe_agg', up(60, 8, 18)).map((x, i) => Object.assign(x, { pe_median: 10 + (i % 2 ? 0.2 : -0.2) + (i === 59 ? -2 : 0) }));
    const r = VA.build(h, []);
    const b = get(r, 'breadth');
    expect(b).toBeTruthy(); expect(b.title).toMatch(/nhóm vốn hoá lớn/);
  });
  it('lợi suất lợi nhuận thấp hơn trái phiếu 10 năm -> cảnh báo; cao hơn thì không', () => {
    const h = rows('ALL', 'pe_agg', flat(60, 20));              // 1/20 = 5%
    expect(get(VA.build(h, [], { bond10yPct: 6.5 }), 'spread').level).toBe('warn');
    expect(get(VA.build(h, [], { bond10yPct: 3.5 }), 'spread')).toBeUndefined();
    expect(get(VA.build(h, []), 'spread')).toBeUndefined();     // không có lãi suất: không đoán
  });
});

describe('ngành đang nắm', () => {
  const h = rows('ALL', 'pe_agg', flat(60, 12)).concat(rows('2700', 'pe_agg', up(60, 8, 18)), rows('8300', 'pe_agg', up(60, 18, 8)), rows('2700', 'pb_agg', up(60, 1, 3)));
  it('chỉ báo ngành có tỷ trọng đủ lớn; ngành nhỏ không báo riêng nhưng cộng vào mức tập trung', () => {
    const r = VA.build(h, [{ code: '2700', name: 'Hàng công nghiệp', weightPct: 35 }, { code: '8300', name: 'Ngân hàng', weightPct: 6 }]);
    expect(get(r, 'sector-rich-2700').level).toBe('warn');                 // P/E và P/B cùng đắt: gộp một dòng
    expect(get(r, 'sector-rich-2700').title).toMatch(/P\/E và P\/B/);
    expect(r.alerts.filter((x) => /2700/.test(x.key))).toHaveLength(1);
    expect(r.alerts.some((x) => /8300/.test(x.key))).toBe(false);         // 6% < 10%
    expect(get(r, 'concentration-rich').detail).toMatch(/^35%/);
  });
  it('ngành đang rẻ và đủ lớn -> thông tin, cộng vào mức tập trung rẻ khi từ 20%', () => {
    const r = VA.build(h, [{ code: '8300', name: 'Ngân hàng', weightPct: 25 }]);
    expect(get(r, 'sector-cheap-8300-P/E').level).toBe('info');
    expect(get(r, 'concentration-cheap')).toBeTruthy();
    expect(get(r, 'concentration-rich')).toBeUndefined();
  });
  it('sắp xếp: cảnh báo trước thông tin; đếm đúng; ngành không có lịch sử bị bỏ qua', () => {
    const r = VA.build(h, [{ code: '2700', name: 'A', weightPct: 30 }, { code: '8300', name: 'B', weightPct: 30 }, { code: '9999', name: 'Không dữ liệu', weightPct: 10 }]);
    const lv = r.alerts.map((a) => a.level), firstInfo = lv.indexOf('info');
    expect(lv.slice(firstInfo).every((x) => x === 'info')).toBe(true);
    expect(r.warn + r.info).toBe(r.alerts.length);
    expect(r.alerts.some((a) => /9999/.test(a.key))).toBe(false);
  });
  it('đầu vào rỗng hoặc sai kiểu: không lỗi', () => {
    expect(VA.build([], []).alerts).toEqual([]);
    expect(VA.build(null, null).alerts).toEqual([]);
    expect(VA.build(h, [{ code: '2700', weightPct: 'x' }, { code: '2700', weightPct: 0 }]).alerts.some((a) => /sector/.test(a.key))).toBe(false);
  });
});
