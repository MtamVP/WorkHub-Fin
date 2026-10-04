// stocksheet/valuation-advanced.js: compute() là hàm thuần ghép các mô hình; html() dựng chuỗi (đã escape).
import { describe, it, expect } from 'vitest';
import VA from '../../stocksheet/valuation-advanced.js';

// FPT: số liệu thật từ VNDirect (02/10/2026) và hồ sơ giả định
const FPT = { pe: 11.711, pb: 2.9385, beta: 0.7358, bvps: 21133, roae: 0.2409, epsTtm: 5870, payoutTtm: 0.341, roaa: 0.1268, roic: 0.1606, cfoToSales: 0.1147, netMargin: 0.157, positiveCfo2y: 2, deltaMargin: -0.0287, interestCoverage: 11.96, debtToEquity: 0.45, currentRatio: 1.56, epsGrowthYoY: 0.0093, salesGrowthYoY: -0.0377, pe1y: 15.1, pe3y: 20.9, pe5y: 20.0, pb1y: 3.85, pb3y: 5.35, pb5y: 5.08 };
const VCB = { pe: 11.46, pb: 1.95, beta: 0.727, bvps: 29279, roae: 0.182, roaa: 0.017, epsTtm: 4984, payoutTtm: 0.09, nim: 0.023, badDebtCoverage: 2.79, equityToAsset: 0.0935, epsGrowthYoY: 0.2016, pretaxGrowthYoY: 0.186 };
const RATES = [{ rate_date: '2026-09-30', tenor: '10Y', yield_pct: 4.5 }, { rate_date: '2026-10-02', tenor: '10Y', yield_pct: 4.5879 }, { rate_date: '2026-10-02', tenor: '1Y', yield_pct: 3.69 }];
const A = (pe, pb, eps, bvps, roe, payout) => ({ m: { pe, pb, eps, bvps, roe, payout } });

describe('compute: doanh nghiệp thường (FPT)', () => {
  const r = VA.compute({ symbol: 'FPT', price: 62100, sector: 'Công nghệ', metrics: FPT, rates: RATES, a: A(10.6, 2.9, 5870, 21400, 24, 34) });
  it('Ke dùng trái phiếu 10 năm MỚI NHẤT, beta VNDirect điều chỉnh Blume, phần bù mặc định 8%', () => {
    expect(r.coe.rfSource).toBe('bond10y'); expect(r.coe.rfDate).toBe('2026-10-02');
    expect(r.coe.rf).toBeCloseTo(0.045879, 9);
    expect(r.coe.betaSource).toBe('vndirect');
    expect(r.coe.ke).toBeCloseTo(0.045879 + (0.67 * 0.7358 + 0.33) * 0.08, 9);
  });
  it('mô hình chính là FCFE; tăng trưởng tự tính = ROE x (1 - chi trả), kẹp 3-25%; giá hợp lý và định giá ngược có mặt', () => {
    expect(r.financial).toBe(false);
    expect(r.rows.map(x => x.key)).toEqual(['jpb', 'ri', 'fcfe']);                 // P/B hợp lý và thặng dư chỉ để tham khảo, mô hình chính là FCFE
    expect(r.rows.filter(x => x.primary).map(x => x.key)).toEqual(['fcfe']);
    expect(r.rows.find(x => x.key === 'fcfe').primary).toBe(true);
    expect(r.inputs.g1).toBeCloseTo(0.2409 * (1 - 0.341), 9);
    expect(r.inputs.g1Manual).toBe(false);
    expect(r.fair).toBeGreaterThan(0);
    expect(r.reverse.ok).toBe(true);
    expect(r.reverse.g1).toBeLessThan(r.inputs.g1);        // thị trường đang kỳ vọng thấp hơn tăng trưởng bền vững của ROE cao
  });
  it('bảng nhạy cảm có ô cơ sở trùng giá trị mô hình; điểm chất lượng và đối chiếu có mặt', () => {
    const base = r.sens.grid[2][2];                          // g cuối kỳ cơ sở, Ke cơ sở
    expect(Math.abs(base - r.rows.find(x => x.key === 'fcfe').value)).toBeLessThan(1e-6 * base);
    expect(r.quality.scored).toBe(11);
    const by = Object.fromEntries(r.cross.map(x => [x.key, x]));
    expect(by.pe.status).toBe('ok'); expect(by.roe.status).toBe('ok');
    expect(by.bvps.status).toBe('ok');
    expect(r.history.pe.y3).toBeCloseTo(11.711 / 20.9, 9);
  });
  it('đối chiếu bắt được hồ sơ lệch: P/E trong hồ sơ cao gấp đôi VNDirect', () => {
    const bad = VA.compute({ symbol: 'FPT', price: 62100, sector: 'Công nghệ', metrics: FPT, rates: RATES, a: A(24, 2.9, 5870, 21400, 24, 34), ownBeta: 1.1 });
    const by = Object.fromEntries(bad.cross.map(x => [x.key, x]));
    expect(by.pe.status).toBe('differs');
    expect(by.beta.status).toBe('differs');
  });
});

describe('compute: ngân hàng (VCB)', () => {
  const r = VA.compute({ symbol: 'VCB', price: 57000, sector: 'Ngân hàng', metrics: VCB, rates: RATES, a: A(11.4, 1.95, 4984, 29200, 18, 9) });
  it('dùng P/B hợp lý và thu nhập thặng dư làm mô hình chính; bộ tiêu chí chất lượng của tổ chức tài chính', () => {
    expect(r.financial).toBe(true);
    expect(r.rows.filter(x => x.primary).map(x => x.key).sort()).toEqual(['jpb', 'ri']);
    expect(r.sens.primary).toBe('jpb');
    expect(r.quality.financial).toBe(true);
    expect(r.quality.items.map(i => i.key)).toContain('nim');
  });
  it('P/B hợp lý khớp công thức (ROE - g)/(Ke - g) x BVPS', () => {
    const jp = r.rows.find(x => x.key === 'jpb');
    const ke = r.coe.ke, expected = (0.182 - 0.05) / (ke - 0.05) * 29279;
    expect(Math.abs(jp.value - expected)).toBeLessThan(1e-6 * expected);
  });
});

describe('compute: thiếu dữ liệu và tham số tay', () => {
  it('không có chỉ số VNDirect: vẫn trả kết quả rỗng có chú thích, không lỗi; thiếu trái phiếu thì dùng mức cài tay', () => {
    const r = VA.compute({ symbol: 'ZZZ', price: 10000, sector: 'Khác', metrics: {}, rates: [], a: A(null, null, null, null, null, null) });
    expect(r.hasMetrics).toBe(false); expect(r.rows).toEqual([]); expect(r.fair).toBeNull();
    expect(r.coe.rfSource).toBe('fallback'); expect(r.coe.rf).toBe(0.045);
    expect(r.coe.betaSource).toBe('default');
    expect(VA.html(r, {})).toContain('Chưa có chỉ số cơ bản');
  });
  it('tham số tay ghi đè: phần bù rủi ro, g1, g cuối kỳ, rf, beta; g cuối kỳ >= Ke thì báo mô hình không xác định', () => {
    const p = { erp: 0.06, g1: 0.10, gT: 0.04, rf: 0.05, beta: 1 };
    const r = VA.compute({ symbol: 'FPT', price: 62100, sector: 'Công nghệ', metrics: FPT, rates: RATES, a: A(10.6, 2.9, 5870, 21400, 24, 34), params: p });
    expect(r.coe.ke).toBeCloseTo(0.05 + (0.67 + 0.33) * 0.06, 9);
    expect(r.coe.rfSource).toBe('manual'); expect(r.coe.betaSource).toBe('manual');
    expect(r.inputs.g1).toBe(0.10); expect(r.inputs.g1Manual).toBe(true);
    const bad = VA.compute({ symbol: 'FPT', price: 62100, sector: 'Công nghệ', metrics: FPT, rates: RATES, a: A(10.6, 2.9, 5870, 21400, 24, 34), params: { gT: 0.2 } });
    expect(bad.notes.some(n => /Ke ≤ tăng trưởng/.test(n))).toBe(true);
  });
});

describe('html: escape và các khối', () => {
  it('chứa Ke, mô hình, định giá ngược, độ nhạy, chất lượng, đối chiếu; escape ký tự đặc biệt; trạng thái đang tải', () => {
    const r = VA.compute({ symbol: 'FPT', price: 62100, sector: 'Công nghệ', metrics: FPT, rates: RATES, a: A(10.6, 2.9, 5870, 21400, 24, 34) });
    r.notes.push('<img src=x onerror=1>');
    const h = VA.html(r, {});
    ['Chi phí vốn chủ Ke', 'FCFE nhiều giai đoạn', 'Định giá ngược', 'Độ nhạy', 'Điểm chất lượng', 'Đối chiếu độc lập'].forEach(t => expect(h).toContain(t));
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img');
    expect(VA.html(null, { loading: true })).toContain('Đang lấy chỉ số');
    expect(VA.html(null, {})).toBe('');
  });
});

describe('ô nhập số', () => {
  it('giá trị đặt vào <input type=number> dùng dấu chấm thập phân (dấu phẩy làm ô trống)', () => {
    const r = VA.compute({ symbol: 'FPT', price: 62100, sector: 'Công nghệ', metrics: FPT, rates: RATES, a: A(10.6, 2.9, 5870, 21400, 24, 34) });
    const h = VA.html(r, {});
    expect(h).toMatch(/id="va-g1"[^>]*value="15\.9"/);
    expect(h).toMatch(/id="va-erp"[^>]*value="8"/);
    expect(h).not.toMatch(/id="va-g1"[^>]*value="15,9"/);
  });
});
