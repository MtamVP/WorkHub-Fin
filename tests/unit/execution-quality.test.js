import { describe, it, expect } from 'vitest';
import EQ from '../../lib/execution-quality.js';

const S = (arr) => arr.map(([d, p]) => [d, p]);
const series = { FPT: S([['2026-09-28', 100000], ['2026-09-29', 101000], ['2026-09-30', 102000], ['2026-10-01', 100000], ['2026-10-02', 99000], ['2026-10-05', 98000], ['2026-10-06', 97000], ['2026-10-07', 96000], ['2026-10-08', 95000]]) };
const tx = (id, o = {}) => Object.assign({ id, user_id: 'u1', symbol: 'fpt', type: 'buy', quantity: 1000, price: 100000, fee: 150000, tax: 0, trade_date: '2026-10-01', deleted_at: null, import_batch: null }, o);

describe('closeOn / closeAfter', () => {
  it('giá đóng cửa ngày đó hoặc phiên gần nhất trước đó; không có dữ liệu -> null', () => {
    expect(EQ.closeOn(series, 'FPT', '2026-10-01')).toBe(100000);
    expect(EQ.closeOn(series, 'FPT', '2026-10-03')).toBe(99000);     // thứ Bảy -> phiên 02/10
    expect(EQ.closeOn(series, 'FPT', '2026-09-01')).toBeNull();
    expect(EQ.closeOn(series, 'XXX', '2026-10-01')).toBeNull();
  });
  it('giá sau n phiên: đếm theo phiên có dữ liệu, chưa đủ phiên -> null', () => {
    expect(EQ.closeAfter(series, 'FPT', '2026-10-01', 5)).toBe(95000);
    expect(EQ.closeAfter(series, 'FPT', '2026-10-02', 5)).toBeNull();
  });
});

describe('ExecQuality.build', () => {
  it('lệnh mua cao hơn giá đóng cửa là bất lợi (dương); lệnh bán thấp hơn là bất lợi (dương)', () => {
    const o = EQ.build({ txns: [tx('a', { price: 101000 }), tx('b', { type: 'sell', price: 99000 })], requests: [], series });
    expect(o.rows[0].vsClosePct).toBeCloseTo(1, 9);
    expect(o.rows[1].vsClosePct).toBeCloseTo(1, 9);
    expect(tx('c', { price: 99000 }) && EQ.build({ txns: [tx('c', { price: 99000 })], requests: [], series }).rows[0].vsClosePct).toBeCloseTo(-1, 9);
  });
  it('so với giá đề xuất chỉ cho lệnh có đề xuất gắn txn_id; đếm ngày trễ từ lúc duyệt', () => {
    const req = { txn_id: 'a', price_ref: 98000, decided_at: '2026-09-29T08:00:00Z' };
    const o = EQ.build({ txns: [tx('a', { price: 100000 }), tx('b')], requests: [req], series });
    expect(o.rows[0].vsRefPct).toBeCloseTo((100000 / 98000 - 1) * 100, 9);
    expect(o.rows[0].delayDays).toBe(2);
    expect(o.rows[1].vsRefPct).toBeNull();
    expect(o.rows[1].hasRequest).toBe(false);
  });
  it('chi phí: mua chỉ tính phí, bán tính phí + thuế; sau lệnh 5 phiên theo chiều có lợi', () => {
    const o = EQ.build({ txns: [tx('a'), tx('b', { type: 'sell', tax: 100000 })], requests: [], series });
    expect(o.rows[0].costPct).toBeCloseTo(0.15, 9);
    expect(o.rows[1].costPct).toBeCloseTo(0.25, 9);
    expect(o.rows[0].forwardPct).toBeCloseTo(-5, 9);                          // mua 100k, 5 phiên sau 95k: mất 5%
    expect(o.rows[1].forwardPct).toBeCloseTo((100000 / 95000 - 1) * 100, 9);  // bán 100k rồi giá còn 95k: có lợi
  });
  it('bỏ lệnh đã xoá, khối lượng 0; lọc theo ngày bắt đầu; thiếu giá lịch sử thì chỉ thiếu chỉ số đó', () => {
    const o = EQ.build({ txns: [tx('a'), tx('b', { deleted_at: 'x' }), tx('c', { quantity: 0 }), tx('d', { trade_date: '2026-09-01' }), tx('e', { symbol: 'ZZZ' })], requests: [], series, from: '2026-09-15' });
    expect(o.rows.map(r => r.id)).toEqual(['a', 'e']);
    expect(o.rows[1].vsClosePct).toBeNull();
    expect(o.rows[1].costPct).toBeCloseTo(0.15, 9);
  });
  it('gộp theo thành viên, giá trị lớn trước; trung bình có trọng số theo giá trị', () => {
    const o = EQ.build({ txns: [tx('a', { price: 101000, quantity: 3000 }), tx('b', { price: 99000, quantity: 1000 }), tx('c', { user_id: 'u2', quantity: 10 })], requests: [], series });
    expect(o.members.map(m => m.userId)).toEqual(['u1', 'u2']);
    const u1 = o.members[0];
    expect(u1.n).toBe(2);
    expect(u1.vsClose.pct).toBeCloseTo((1 * 303000000 + -1 * 99000000) / (303000000 + 99000000), 9);
  });
});

describe('nhận xét chỉ khi đủ mẫu', () => {
  it('ít lệnh: chỉ nói chưa đủ dữ liệu, không kết luận', () => {
    const o = EQ.build({ txns: [tx('a', { price: 103000 })], requests: [], series });
    expect(o.summary.insights).toHaveLength(1);
    expect(o.summary.insights[0].tone).toBe('mute');
    expect(o.summary.insights[0].text).toMatch(/cần từ 5/);
  });
  it('đủ 5 lệnh mua cao hơn giá đóng cửa >0,5%: cảnh báo mua đuổi', () => {
    const txns = [1, 2, 3, 4, 5].map(i => tx('b' + i, { price: 101000 }));
    const o = EQ.build({ txns, requests: [], series });
    expect(o.summary.insights.some(i => /mua đuổi/.test(i.text))).toBe(true);
  });
  it('giá dịch chuyển bất lợi giữa đề xuất và khớp (>= 3 lệnh có đề xuất) và chi phí cao được nêu', () => {
    const txns = [1, 2, 3].map(i => tx('r' + i, { price: 104000, fee: 600000 }));
    const requests = txns.map(t => ({ txn_id: t.id, price_ref: 100000, decided_at: '2026-09-29T00:00:00Z' }));
    const o = EQ.build({ txns: txns.concat([tx('x1', { fee: 600000 }), tx('x2', { fee: 600000 })]), requests, series });
    const text = o.summary.insights.map(i => i.text).join(' | ');
    expect(text).toMatch(/dịch chuyển bất lợi trung bình 4/);
    expect(text).toMatch(/Phí và thuế chiếm/);
  });
  it('sau lệnh mua giá giảm mạnh (>= 5 lệnh): cảnh báo thời điểm mua', () => {
    const txns = [1, 2, 3, 4, 5].map(i => tx('f' + i));                       // mua 100k ngày 01/10, 5 phiên sau 95k
    expect(EQ.build({ txns, requests: [], series }).summary.insights.some(i => /thời điểm mua/.test(i.text))).toBe(true);
  });
});

describe('so với giá trung bình ngày (VWAP)', () => {
  // VWAP ngày 01/10: 100.500; 02/10: 98.600
  const averages = { FPT: [['2026-10-01', 100500], ['2026-10-02', 98600]] };
  it('khớp trên VWAP là bất lợi cho lệnh mua và bán đều theo dấu quy ước; chỉ lấy đúng ngày giao dịch (không lấy ngày trước đó)', () => {
    const o = EQ.build({ txns: [tx('a', { price: 101505 }), tx('b', { type: 'sell', price: 99495 }), tx('c', { trade_date: '2026-10-03' })], requests: [], series, averages });
    expect(o.rows[0].vsVwapPct).toBeCloseTo(1, 9);                    // mua 101.505 vs 100.500 = +1% bất lợi
    expect(o.rows[1].vsVwapPct).toBeCloseTo(1, 9);                    // bán 99.495 thấp hơn 100.500 = +1% bất lợi
    expect(o.rows[2].vsVwapPct).toBeNull();                           // 03/10 không có VWAP (không dùng ngày trước)
    expect(EQ.valueOn(averages, 'FPT', '2026-10-02')).toBe(98600);
    expect(EQ.valueOn(averages, 'FPT', '2026-10-03')).toBeNull();
    expect(EQ.valueOn({}, 'FPT', '2026-10-02')).toBeNull();
  });
  it('trung bình có trọng số theo giá trị và tách mua / bán', () => {
    const o = EQ.build({ txns: [tx('a', { price: 101505, quantity: 3000 }), tx('b', { price: 99495, quantity: 1000 }), tx('s', { type: 'sell', price: 101505 })], requests: [], series, averages });
    expect(o.summary.vsVwapBuy.n).toBe(2);
    expect(o.summary.vsVwapBuy.pct).toBeCloseTo((1 * 304515000 + -1 * 99495000) / (304515000 + 99495000), 9);
    expect(o.summary.vsVwapSell.n).toBe(1);
    expect(o.summary.vsVwapSell.pct).toBeCloseTo(-1, 9);              // bán cao hơn VWAP 1% là có lợi (âm)
  });
  it('nhận xét VWAP khi đủ 5 lệnh cùng phía: mua đắt hơn VWAP cảnh báo, mua rẻ hơn khen; thiếu mẫu thì im lặng', () => {
    const many = (price) => [1, 2, 3, 4, 5].map(i => tx('m' + i, { price }));
    expect(EQ.build({ txns: many(101505), requests: [], series, averages }).summary.insights.some(i => /VWAP/.test(i.text) && i.tone === 'warn')).toBe(true);
    expect(EQ.build({ txns: many(99495), requests: [], series, averages }).summary.insights.some(i => /thấp hơn VWAP/.test(i.text) && i.tone === 'good')).toBe(true);
    expect(EQ.build({ txns: many(101505).slice(0, 3), requests: [], series, averages }).summary.insights.some(i => /VWAP/.test(i.text))).toBe(false);
  });
  it('không có averages: các chỉ số VWAP rỗng, các chỉ số cũ không đổi', () => {
    const o = EQ.build({ txns: [tx('a', { price: 101000 })], requests: [], series });
    expect(o.rows[0].vsVwapPct).toBeNull();
    expect(o.summary.vsVwap.n).toBe(0);
    expect(o.rows[0].vsClosePct).toBeCloseTo(1, 9);
  });
});
