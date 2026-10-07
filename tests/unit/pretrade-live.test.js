import { describe, it, expect } from 'vitest';
import PL from '../../lib/pretrade-live.js';

describe('PretradeLive.overlay', () => {
  const H = [{ symbol: 'FPT', value: 10e6, price: 100000 }, { symbol: 'HPG', value: 5e6, price: 25000 }, { symbol: 'VNM', value: 2e6, price: 50000 }];
  it('tính lại giá trị theo giá trực tiếp (khối lượng = giá trị / giá lưu); mã không có giá giữ nguyên; NAV theo tiền mặt và nợ', () => {
    const r = PL.overlay(H, { FPT: { price: 90000 }, HPG: { price: 26000 } }, 3e6, 1e6);
    expect(r.liveCount).toBe(2);
    expect(r.holdings[0]).toMatchObject({ symbol: 'FPT', price: 90000, live: true }); expect(r.holdings[0].value).toBeCloseTo(9e6, 6);
    expect(r.holdings[1].value).toBeCloseTo(5.2e6, 6); expect(r.holdings[2]).toMatchObject({ value: 2e6, price: 50000, live: false });
    expect(r.navStored).toBeCloseTo(17e6 + 3e6 - 1e6, 6); expect(r.nav).toBeCloseTo(9e6 + 5.2e6 + 2e6 + 2e6, 6); expect(r.navDelta).toBeCloseTo(-0.8e6, 6);
  });
  it('không có báo giá, giá lưu bằng 0 hoặc báo giá hỏng thì không đổi gì', () => {
    const r = PL.overlay(H, {}, 0, 0); expect(r.liveCount).toBe(0); expect(r.nav).toBe(17e6); expect(r.navDelta).toBe(0);
    expect(PL.overlay([{ symbol: 'X', value: 5, price: 0 }], { X: { price: 10 } }, 0, 0).holdings[0]).toMatchObject({ value: 5, live: false });
    expect(PL.overlay(H, { FPT: { price: 0 } }, 0, 0).liveCount).toBe(0); expect(PL.overlay(null, null).holdings).toEqual([]);
  });
});

describe('PretradeLive.describe', () => {
  it('trong phiên: giá trực tiếp kèm tham chiếu, trần/sàn, giờ; ngoài phiên: ghi rõ là giá đóng cửa gần nhất', () => {
    const q = { price: 60300, ref: 60400, ceil: 64600, floor: 56200, time: '10:30:12' };
    expect(PL.describe(q, 'open').text).toBe('Giá trực tiếp 60.300 · tham chiếu 60.400 · trần 64.600 · sàn 56.200 (lúc 10:30:12)');
    expect(PL.describe(q, 'closed')).toMatchObject({ inSession: false }); expect(PL.describe(q, 'holiday').text).toContain('đóng cửa gần nhất (ngoài phiên)');
    expect(PL.describe({ price: 60300 }, 'break').text).toBe('Giá trực tiếp 60.300');
    expect(PL.describe(null, 'open')).toBeNull(); expect(PL.describe({ price: 0 }, 'open')).toBeNull();
  });
});

describe('PretradeLive.priceFlags', () => {
  const q = { price: 60000, ceil: 64200, floor: 55800 };
  it('ngoài biên độ trần/sàn: lỗi (lệnh không khớp), kể cả ngoài phiên', () => {
    expect(PL.priceFlags(65000, q, 'open')[0]).toMatchObject({ tone: 'bad' }); expect(PL.priceFlags(65000, q, 'open')[0].text).toContain('giá trần 64.200');
    expect(PL.priceFlags(55000, q, 'closed')[0].text).toContain('giá sàn 55.800');
    expect(PL.priceFlags(64200, q, 'open').some((f) => f.tone === 'bad')).toBe(false);                      // đúng giá trần vẫn hợp lệ
  });
  it('lệch giá trực tiếp: từ 2% là thông tin, từ 5% là cảnh báo; ngoài phiên không so', () => {
    expect(PL.priceFlags(61300, q, 'open')).toEqual([{ tone: 'info', text: 'Giá nhập lệch +2,2% so với giá trực tiếp 60.000.' }]);
    const w = PL.priceFlags(57000, q, 'open'); expect(w).toEqual([{ tone: 'warn', text: 'Giá nhập lệch −5,0% so với giá trực tiếp 60.000: kiểm tra lại giá hoặc mã.' }]);
    expect(PL.priceFlags(60500, q, 'open')).toEqual([]); expect(PL.priceFlags(57000, q, 'closed')).toEqual([]);
  });
  it('thiếu dữ liệu: không cảnh báo; không có trần/sàn (nguồn VNDirect) thì chỉ so lệch', () => {
    expect(PL.priceFlags(0, q, 'open')).toEqual([]); expect(PL.priceFlags(60000, null, 'open')).toEqual([]);
    expect(PL.priceFlags(99999, { price: 60000 }, 'open').map((f) => f.tone)).toEqual(['warn']);
  });
});

describe('PretradeLive.shouldAutofill', () => {
  it('điền khi ô trống hoặc đang giữ đúng giá tự điền lần trước; không ghi đè giá người dùng đã gõ', () => {
    expect(PL.shouldAutofill('', false, null)).toBe(true); expect(PL.shouldAutofill('  ', false, null)).toBe(true); expect(PL.shouldAutofill(null, false, null)).toBe(true);
    expect(PL.shouldAutofill('60300', true, 60300)).toBe(true);           // giá tự điền, chưa sửa
    expect(PL.shouldAutofill('60500', true, 60300)).toBe(false);          // người dùng đã sửa
    expect(PL.shouldAutofill('60300', false, 60300)).toBe(false);         // trùng số nhưng do người dùng gõ
    expect(PL.shouldAutofill('abc', true, 60300)).toBe(false);
  });
});
