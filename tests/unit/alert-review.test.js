import { describe, it, expect } from 'vitest';
import AR from '../../lib/alert-review.js';

const A = (kind, sym, price, thr, pct) => ({ symbol: sym, kind, price, threshold: thr, pct });
const rec = (h, a, date, time) => AR.record(h, a, { date: date || '2026-10-05', time: time || '10:15:00' });

describe('record', () => {
  it('ghi cảnh báo theo mã kèm giá lúc báo; cùng ngày + khoá không ghi hai lần', () => {
    let h = rec([], A('target', 'FPT', 130000, 130000));
    h = rec(h, A('target', 'FPT', 131000, 130000));
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ s: 'FPT', kind: 'target', price: 130000, thr: 130000, d1: null, last: null });
    h = rec(h, A('target', 'FPT', 131000, 130000), '2026-10-06');
    expect(h).toHaveLength(2);
  });
  it('bỏ qua loại không có mã/giá (NAV, giới hạn) và dữ liệu thiếu', () => {
    expect(rec([], { symbol: 'Danh mục', kind: 'nav_down', price: 1 })).toEqual([]);
    expect(rec([], A('stop', 'VNM', 0, 50000))).toEqual([]);
    expect(rec([], A('stop', '', 100, 50000))).toEqual([]);
    expect(AR.record([], A('stop', 'VNM', 100, 90), {})).toEqual([]);
  });
  it('giữ tối đa 600 cảnh báo và bỏ cảnh báo quá 180 ngày', () => {
    let h = [];
    for (let i = 0; i < 610; i++) h = rec(h, A('move_up', 'S' + i, 1000, 5, 5.2), '2026-10-05');
    expect(h).toHaveLength(AR.KEEP);
    h = AR.record(h, A('move_up', 'NEW', 1000, 5, 5), { date: '2027-06-01', time: '' });
    expect(h.map((x) => x.s)).toEqual(['NEW']);
  });
});

describe('update', () => {
  const base = rec([], A('stop', 'VNM', 50000, 51000));
  it('chưa sang phiên sau thì không cập nhật', () => {
    const r = AR.update(base, { VNM: { price: 49000, date: '2026-10-05' } }, '2026-10-05');
    expect(r.changed).toBe(false); expect(r.hist[0].d1).toBeNull();
  });
  it('phiên đầu tiên sau ngày báo: d1 theo giá lần cuối của phiên đó; phiên sau nữa chỉ đổi giá gần nhất', () => {
    let r = AR.update(base, { VNM: { price: 49500, date: '2026-10-06' } }, '2026-10-06');
    expect(r.changed).toBe(true); expect(r.hist[0]).toMatchObject({ d1: 49500, d1Date: '2026-10-06', last: 49500 });
    r = AR.update(r.hist, { VNM: { price: 49200, date: '2026-10-06' } }, '2026-10-06');
    expect(r.hist[0]).toMatchObject({ d1: 49200, last: 49200 });                 // cùng phiên: giá cuối phiên thay giá giữa phiên
    r = AR.update(r.hist, { VNM: { price: 52000, date: '2026-10-07' } }, '2026-10-07');
    expect(r.hist[0]).toMatchObject({ d1: 49200, d1Date: '2026-10-06', last: 52000, lastDate: '2026-10-07' });
  });
  it('giá cũ hơn không ghi đè giá mới, giá từ tương lai bị bỏ qua, không đổi thì changed = false', () => {
    let r = AR.update(base, { VNM: { price: 52000, date: '2026-10-08' } }, '2026-10-08');
    r = AR.update(r.hist, { VNM: { price: 48000, date: '2026-10-07' } }, '2026-10-08');
    expect(r.hist[0].last).toBe(52000);
    r = AR.update(r.hist, { VNM: { price: 52000, date: '2026-10-08' } }, '2026-10-08');
    expect(r.changed).toBe(false);
    r = AR.update(base, { VNM: { price: 1, date: '2026-12-01' } }, '2026-10-08');
    expect(r.changed).toBe(false);
  });
  it('mã không có giá hoặc giá không hợp lệ giữ nguyên', () => {
    expect(AR.update(base, {}, '2026-10-06').changed).toBe(false);
    expect(AR.update(base, { VNM: { price: 0, date: '2026-10-06' } }, '2026-10-06').changed).toBe(false);
  });
});

describe('chiều cảnh báo và tổng hợp', () => {
  it('cắt lỗ: giá giảm thêm = đi tiếp (dương); giá hồi = quay đầu (âm)', () => {
    const stop = { kind: 'stop', price: 50000 };
    expect(AR.oriented(stop, 47500)).toBe(5);
    expect(AR.oriented(stop, 52500)).toBe(-5);
  });
  it('mục tiêu: giá lên thêm = đi tiếp; tới giá mua: giá rẻ thêm = đi tiếp', () => {
    expect(AR.oriented({ kind: 'target', price: 100000 }, 103000)).toBe(3);
    expect(AR.oriented({ kind: 'buy', price: 20000 }, 19000)).toBe(5);
    expect(AR.oriented({ kind: 'buy', price: 20000 }, 21000)).toBe(-5);
    expect(AR.oriented({ kind: 'nav_down', price: 1 }, 2)).toBeNull();
  });
  const mk = (kind, sym, p0, p1, n) => Object.assign(rec([], A(kind, sym, p0, p0), '2026-10-0' + (n || 1))[0], { d1: p1, d1Date: '2026-10-09', last: p1, lastDate: '2026-10-09' });
  it('tổng hợp: chưa đủ mẫu thì không rút nhận xét; đủ mẫu thì nêu tỷ lệ', () => {
    const few = [mk('target', 'A', 100, 105), mk('target', 'B', 100, 90), mk('target', 'C', 100, 100.5), Object.assign(rec([], A('target', 'D', 100, 100), '2026-10-02')[0])];
    const s = AR.summarize(few)[0];
    expect(s).toMatchObject({ kind: 'target', total: 4, n: 3, pending: 1, cont: 1, rev: 1, flat: 1, enough: false });
    expect(s.text).toContain('cần từ 10');
    const many = []; for (let i = 0; i < 10; i++) many.push(mk('stop', 'S' + i, 100, i < 6 ? 95 : 106));      // 6 đi tiếp (giảm), 4 hồi
    const t = AR.summarize(many)[0];
    expect(t).toMatchObject({ kind: 'stop', n: 10, cont: 6, rev: 4, enough: true });
    expect(t.text).toContain('60%'); expect(t.text).toContain('40%');
  });
  it('không có cảnh báo nào cho loại thì loại đó không có dòng', () => {
    expect(AR.summarize([])).toEqual([]);
    expect(AR.summarize([mk('buy', 'X', 100, 99)]).map((r) => r.kind)).toEqual(['buy']);
  });
});

describe('rows, quyết định gợi ý và CSV', () => {
  const h = AR.update(rec(rec([], A('stop', 'VNM', 50000, 51000), '2026-10-05', '09:30:00'), A('move_up', 'FPT', 130000, 5, 5.4), '2026-10-06', '10:00:00'), { VNM: { price: 47500, date: '2026-10-06' } }, '2026-10-06').hist;
  it('rows: mới nhất trước, có % theo chiều và kết luận', () => {
    const r = AR.rows(h);
    expect(r.map((x) => x.s)).toEqual(['FPT', 'VNM']);
    expect(r[1]).toMatchObject({ d1Pct: 5, d1Verdict: 'cont', label: 'Chạm ngưỡng cắt lỗ' });
    expect(r[0].d1Verdict).toBeNull();
    expect(AR.rows(h, 1)).toHaveLength(1);
  });
  it('decisionDraft: hành động gợi ý theo loại, lý do ghi sẵn bối cảnh, giá và ngày lấy từ cảnh báo', () => {
    const d = AR.decisionDraft(h.find((x) => x.s === 'VNM'));
    expect(d).toMatchObject({ action: 'sell', symbol: 'VNM', date: '2026-10-05', price: 50000 });
    expect(d.reason).toContain('ngưỡng cắt lỗ 51.000'); expect(d.reason).toContain('05/10/2026'); expect(d.tags).toContain('cảnh báo giá');
    expect(AR.decisionDraft(h.find((x) => x.s === 'FPT')).action).toBe('hold');
    expect(AR.decisionDraft(rec([], A('buy', 'MWG', 60000, 61000))[0]).action).toBe('buy');
    expect(AR.decisionDraft({ kind: 'nav_down' })).toBeNull();
  });
  it('CSV: dòng tiêu đề + từng cảnh báo, ô trống khi chưa có giá phiên sau', () => {
    const c = AR.csvRows(h);
    expect(c[0]).toEqual(AR.HEADER); expect(c).toHaveLength(3);
    expect(c[1][2]).toBe('FPT'); expect(c[1][6]).toBe('');
    expect(c[2][6]).toBe(47500); expect(c[2][8]).toBe(5);
  });
});
