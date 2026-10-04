// Edge Function stock-events: chuẩn hoá sự kiện từ nguồn VNDirect (dòng thật của FPT/HPG/SSI, trích 04/10/2026).
import { describe, it, expect } from 'vitest';
import { validateRequest, normalizeEvent, buildEvents, MAX_SYMBOLS, EVENT_TYPES } from '../../supabase/functions/stock-events/parse.ts';

const FPT_CASH = { id: '124352.VN', code: 'FPT', type: 'DIVIDEND', note: 'Trả cổ tức đợt 2/2025 (1000 đ/cp)', dividend: 1000, ratio: 10, divPeriod: 2, divYear: 2025, effectiveDate: '2026-05-28', expiredDate: '2026-06-10', actualDate: '2026-06-10', locale: 'VN' };
const FPT_BONUS = { id: '125771.VN', code: 'FPT', type: 'KINDDIV', note: 'Tỷ lệ 100:10', ratio: 10, effectiveDate: '2026-09-21', locale: 'VN' };
const HPG_STOCKDIV = { id: '124074.VN', code: 'HPG', type: 'STOCKDIV', note: 'Trả cổ tức năm 2025, tỷ lệ 100:10', ratio: 10, divYear: 2025, effectiveDate: '2026-05-25', locale: 'VN' };
const SSI_RIGHTS = { id: '122075.VN', code: 'SSI', type: 'ISSUE', note: 'Phát hành 415,182,958 cp cho CĐHH, giá 15000 đ/cp', price: 15000, ratio: 20, effectiveDate: '2025-12-08', registerEndDate: '2026-01-08', locale: 'VN' };

describe('validateRequest', () => {
  it('chuẩn hoá mã, bỏ trùng, có ngày mặc định', () => {
    const v = validateRequest({ symbols: ['fpt', 'FPT', 'hpg'] });
    expect(v.error).toBeNull();
    expect(v.symbols).toEqual(['FPT', 'HPG']);
    expect(v.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('nhận since hợp lệ, chặn lùi quá 8 năm', () => {
    expect(validateRequest({ symbol: 'FPT', since: '2025-01-01' }).since).toBe('2025-01-01');
    const old = validateRequest({ symbol: 'FPT', since: '1999-01-01' }).since;
    expect(Number(old.slice(0, 4))).toBeGreaterThanOrEqual(new Date().getUTCFullYear() - 9);
  });
  it.each([
    [null, /Thiếu dữ liệu/], [{}, /Thiếu mã/], [{ symbol: 'A;B' }, /không hợp lệ/], [{ symbol: 'FPT', since: 'hôm qua' }, /Ngày bắt đầu/],
    [{ symbols: Array.from({ length: MAX_SYMBOLS + 1 }, (_, i) => 'A' + i) }, new RegExp('Tối đa ' + MAX_SYMBOLS)],
  ])('từ chối yêu cầu xấu %#', (body, re) => { expect(validateRequest(body).error).toMatch(re); });
  it('chỉ lấy 4 loại sự kiện cần dùng', () => { expect([...EVENT_TYPES]).toEqual(['DIVIDEND', 'STOCKDIV', 'KINDDIV', 'ISSUE']); });
});

describe('normalizeEvent', () => {
  it('cổ tức tiền: đ/cp, ngày thanh toán', () => {
    expect(normalizeEvent(FPT_CASH)).toMatchObject({ id: '124352.VN', symbol: 'FPT', kind: 'cash_dividend', dps: 1000, ratio: null, exDate: '2026-05-28', payDate: '2026-06-10', divYear: 2025, period: 2 });
  });
  it('thưởng / cổ tức bằng cổ phiếu: ratio là %', () => {
    expect(normalizeEvent(FPT_BONUS)).toMatchObject({ kind: 'bonus', ratio: 10, dps: null, payDate: null });
    expect(normalizeEvent(HPG_STOCKDIV)).toMatchObject({ kind: 'stock_dividend', ratio: 10 });
  });
  it('phát hành thêm cho cổ đông hiện hữu có giá; đợt ESOP/riêng lẻ bị bỏ', () => {
    expect(normalizeEvent(SSI_RIGHTS)).toMatchObject({ kind: 'rights', ratio: 20, price: 15000 });
    expect(normalizeEvent({ ...SSI_RIGHTS, note: 'Phát hành ESOP 1,000,000 cp' })).toBeNull();
    expect(normalizeEvent({ ...SSI_RIGHTS, price: null })).toBeNull();
  });
  it.each([
    ['loại khác', { ...FPT_CASH, type: 'MEETING' }], ['bản tiếng Anh', { ...FPT_CASH, locale: 'EN' }], ['không có tiền', { ...FPT_CASH, dividend: 0 }],
    ['thiếu ngày', { ...FPT_CASH, effectiveDate: null }], ['thiếu id', { ...FPT_CASH, id: '' }], ['thưởng không tỷ lệ', { ...FPT_BONUS, ratio: null }],
  ])('bỏ qua dòng không dùng được: %s', (_n, row) => { expect(normalizeEvent(row)).toBeNull(); });
});

describe('buildEvents', () => {
  it('lọc theo ngày, bỏ trùng id, mới nhất trước', () => {
    const out = buildEvents([FPT_CASH, FPT_BONUS, HPG_STOCKDIV, SSI_RIGHTS, { ...FPT_CASH }, { ...FPT_CASH, type: 'MEETING', id: 'm' }], '2026-01-01');
    expect(out.map(e => e.id)).toEqual(['125771.VN', '124352.VN', '124074.VN']);
  });
});
