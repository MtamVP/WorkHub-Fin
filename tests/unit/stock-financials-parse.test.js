import { describe, it, expect } from 'vitest';
import {
  validateRequest, detectForm, quarterOf, buildAnnual, buildQuarters, buildDividends, buildFinancials, ITEM, MAX_SYMBOLS
} from '../../supabase/functions/stock-financials/parse.ts';

// Số thật của FPT (đã đối chiếu với nguồn VNDirect 02/10/2026), đơn vị đồng
const R = (modelType, itemCode, fiscalDate, numericValue) => ({ code: 'FPT', modelType, itemCode, fiscalDate, numericValue });
const FPT_ANNUAL = [
  R(1, 12700, '2025-12-31', 88141991634625), R(1, 14000, '2025-12-31', 43748040747539), R(1, 14240, '2025-12-31', 7265096802767),
  R(1, 14110, '2025-12-31', 17035071210000), R(2, 23000, '2025-12-31', 9376127629501), R(2, 21001, '2025-12-31', 70112825100710),
  R(1, 12700, '2024-12-31', 71999995678620), R(1, 14000, '2024-12-31', 35727540104800), R(1, 14240, '2024-12-31', 5933309621004),
  R(1, 14110, '2024-12-31', 14710691830000), R(2, 23000, '2024-12-31', 7856767812178), R(2, 21001, '2024-12-31', 62848794351367),
];
const FPT_Q = [
  R(2, 23000, '2025-03-31', 2174301386525), R(2, 23000, '2025-06-30', 2257462588123), R(2, 23000, '2025-09-30', 2434841434732), R(2, 23000, '2025-12-31', 2509522220120),
  R(2, 21001, '2025-12-31', 20225449892881), R(2, 23000, '2026-03-31', 2487371587099), R(2, 23000, '2026-06-30', 2567587014434),
];

describe('validateRequest', () => {
  it('nhận symbol hoặc symbols, chuẩn hoá chữ hoa, bỏ trùng', () => {
    expect(validateRequest({ symbol: 'fpt' })).toEqual({ error: null, symbols: ['FPT'] });
    expect(validateRequest({ symbols: ['fpt', 'FPT', 'vcb'] }).symbols).toEqual(['FPT', 'VCB']);
  });
  it.each([
    [null, /Thiếu dữ liệu/], [{}, /Thiếu mã/], [{ symbols: [] }, /Thiếu mã/], [{ symbol: 'A;B' }, /không hợp lệ/],
    [{ symbols: Array.from({ length: MAX_SYMBOLS + 1 }, (_, i) => 'A' + i) }, new RegExp('Tối đa ' + MAX_SYMBOLS)],
  ])('từ chối yêu cầu xấu %#', (body, re) => {
    expect(validateRequest(body).error).toMatch(re);
  });
});

describe('detectForm / quarterOf', () => {
  it('nhận loại doanh nghiệp theo mô hình báo cáo', () => {
    expect(detectForm(FPT_ANNUAL)).toBe('NON_FINANCE');
    expect(detectForm([R(101, 12700, '2025-12-31', 1), R(102, 23000, '2025-12-31', 1)])).toBe('BANK');
    expect(detectForm([R(89, 12700, '2025-12-31', 1)])).toBe('SECURITIES');
    expect(detectForm([R(411, 12700, '2025-12-31', 1)])).toBe('INSURANCE');
    expect(detectForm([R(999, 12700, '2025-12-31', 1)])).toBeNull();
    expect(detectForm([])).toBeNull();
  });
  it('quý theo tháng dương lịch của ngày chốt', () => {
    expect(quarterOf('2025-03-31')).toEqual({ year: 2025, quarter: 1 });
    expect(quarterOf('2025-12-31')).toEqual({ year: 2025, quarter: 4 });
    expect(quarterOf('2025-05-15')).toBeNull();
    expect(quarterOf('')).toBeNull();
    expect(quarterOf(null)).toBeNull();
  });
});

describe('buildAnnual', () => {
  it('gom theo năm, vốn chủ của cổ đông công ty mẹ = vốn chủ - lợi ích cổ đông thiểu số, năm mới trước', () => {
    const a = buildAnnual(FPT_ANNUAL, 'NON_FINANCE');
    expect(a.map(x => x.year)).toEqual([2025, 2024]);
    expect(a[0]).toMatchObject({ charter: 17035071210000, equity: 43748040747539, minority: 7265096802767, lnst: 9376127629501, revenue: 70112825100710, assets: 88141991634625 });
    expect(a[0].equityParent).toBe(43748040747539 - 7265096802767);
  });
  it('doanh thu theo loại hình: chứng khoán 21000, ngân hàng 421701, bảo hiểm không có', () => {
    const rows = [R(90, 21000, '2025-12-31', 111), R(90, 23000, '2025-12-31', 5), R(102, 421701, '2025-12-31', 222), R(2, 21001, '2025-12-31', 333), R(1, 14000, '2025-12-31', 9)];
    expect(buildAnnual(rows, 'SECURITIES')[0].revenue).toBe(111);
    expect(buildAnnual(rows, 'BANK')[0].revenue).toBe(222);
    expect(buildAnnual(rows, 'NON_FINANCE')[0].revenue).toBe(333);
    expect(buildAnnual(rows, 'INSURANCE')[0].revenue).toBeNull();
  });
  it('thiếu lợi ích thiểu số coi là 0; bỏ năm không có cả lợi nhuận lẫn vốn chủ; bỏ giá trị rác', () => {
    const rows = [R(1, 14000, '2025-12-31', 100), R(1, 12700, '2024-12-31', 500), R(2, 23000, '2023-12-31', 'abc'), R(2, 23000, '2022-12-31', null)];
    const a = buildAnnual(rows, 'NON_FINANCE');
    expect(a.map(x => x.year)).toEqual([2025]);
    expect(a[0].minority).toBe(0);
    expect(a[0].equityParent).toBe(100);
    expect(a[0].lnst).toBeNull();
  });
});

describe('buildQuarters', () => {
  it('quý riêng lẻ: tổng 4 quý 2025 khớp số cả năm của FPT', () => {
    const q = buildQuarters(FPT_Q, 'NON_FINANCE');
    expect(q.map(x => `${x.year}Q${x.quarter}`)).toEqual(['2026Q2', '2026Q1', '2025Q4', '2025Q3', '2025Q2', '2025Q1']);
    const y2025 = q.filter(x => x.year === 2025).reduce((s, x) => s + x.lnst, 0);
    expect(y2025).toBe(9376127629501 - 1); // chênh làm tròn 1 đồng ở nguồn, không đáng kể
    expect(q.find(x => x.year === 2025 && x.quarter === 4).revenue).toBe(20225449892881);
    expect(q[0].revenue).toBeNull();
  });
  it('bỏ ngày không phải cuối quý và dòng không có lợi nhuận', () => {
    const q = buildQuarters([R(2, 23000, '2025-05-15', 1), R(2, 21001, '2025-06-30', 5)], 'NON_FINANCE');
    expect(q).toEqual([]);
  });
});

describe('buildDividends', () => {
  const E = (type, locale, dividend, divYear) => ({ type, locale, dividend, divYear, effectiveDate: '2025-12-01' });
  it('cộng cổ tức tiền theo năm tài chính được chia, chỉ dòng tiếng Việt', () => {
    const d = buildDividends([E('DIVIDEND', 'VN', 1000, 2025), E('DIVIDEND', 'VN', 1000, 2025), E('DIVIDEND', 'EN_GB', 1000, 2025), E('DIVIDEND', 'VN', 500, 2024)]);
    expect(d).toEqual({ '2025': 2000, '2024': 500 });
  });
  it('bỏ sự kiện khác loại, số tiền không dương, năm lạ', () => {
    expect(buildDividends([E('LISTED', 'VN', 1000, 2025), E('DIVIDEND', 'VN', 0, 2025), E('DIVIDEND', 'VN', null, 2025), E('DIVIDEND', 'VN', 100, 'x'), E('DIVIDEND', 'VN', 100, 1800)])).toEqual({});
    expect(buildDividends([])).toEqual({});
  });
});

describe('buildFinancials', () => {
  it('ghép đủ loại hình, số năm, số quý và cổ tức', () => {
    const f = buildFinancials(FPT_ANNUAL, FPT_Q, [{ type: 'DIVIDEND', locale: 'VN', dividend: 1000, divYear: 2025 }]);
    expect(f.form).toBe('NON_FINANCE');
    expect(f.annual).toHaveLength(2);
    expect(f.quarters).toHaveLength(6);
    expect(f.dividends).toEqual({ '2025': 1000 });
  });
  it('chỉ có số quý vẫn nhận ra loại hình; không có gì -> mảng rỗng', () => {
    expect(buildFinancials([], FPT_Q, []).form).toBe('NON_FINANCE');
    const e = buildFinancials([], [], []);
    expect(e).toEqual({ form: null, annual: [], quarters: [], dividends: {} });
  });
  it('hằng số mã chỉ tiêu khớp nguồn', () => {
    expect(ITEM).toEqual({ assets: 12700, equity: 14000, minority: 14240, charter: 14110, lnst: 23000, revNonFin: 21001, revSecurities: 21000, revBank: 421701 });
  });
});
