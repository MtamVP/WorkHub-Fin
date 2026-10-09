// Bộ lọc toàn thị trường, nâng cấp 09/10/2026: tiêu chí chất lượng/dòng tiền/an toàn/ngân hàng/đỉnh-đáy 52 tuần, điểm sức khoẻ tài chính kiểu Piotroski rút gọn,
// trọng số điểm do người dùng chỉnh và nhóm động lượng. Giá trị mong đợi tính tay (ghi ngay cạnh).
import { describe, it, expect } from 'vitest';
import MS from '../../lib/market-screener.js';

const S = (symbol, icb, m) => ({ symbol, icb2_code: icb, metrics: Object.assign({ marketcap: 5000e9, advValue20: 20e9 }, m) });
// Doanh nghiệp tốt đủ 9 dấu hiệu
const GOOD = { roaa: 0.08, cfoToSales: 0.15, positiveCfo2y: 2, netMargin: 0.1, netProfitGrowthYoY: 0.2, deltaMargin: 0.01, interestCoverage: 8, netCashToEquity: -0.2, currentRatio: 1.6, debtToEquity: 0.5, roic: 0.18, grossMargin: 0.35, roae: 0.2 };
const rowsOf = (snap) => MS.buildRows(snap, {}, {});

describe('giá hiện tại và đỉnh/đáy 52 tuần', () => {
  it('giá = vốn hoá / số cổ phiếu; cách đỉnh và cao hơn đáy tính đúng (FPT 08/10/2026)', () => {
    const [r] = rowsOf([S('FPT', '9500', { marketcap: 112577940585600, shares: 1885727648, high52: 95144, low52: 56546 })]);
    expect(Math.round(r.price)).toBe(59700);
    expect(r.offHigh).toBeCloseTo(1 - 59700.0 / 95144, 3);           // 0,3725
    expect(r.aboveLow).toBeCloseTo(59700.0 / 56546 - 1, 3);           // 0,0558
  });
  it('giá lệch xa khỏi vùng đỉnh/đáy (số cổ phiếu cũ) thì bỏ, không đoán', () => {
    expect(MS.priceOf({ marketcap: 1000e9, shares: 1e6, high52: 50000, low52: 30000 })).toBeNull();       // 1.000.000 đ > đỉnh x 1,15
    expect(MS.priceOf({ marketcap: 1000e9, shares: 1e9, high52: 50000, low52: 30000 })).toBeNull();       // 1.000 đ < đáy x 0,85
    expect(MS.priceOf({ marketcap: 1000e9, shares: 25e6, high52: 50000, low52: 30000 })).toBe(40000);
    expect(MS.priceOf({ marketcap: 1000e9 })).toBeNull();
  });
  it('tiêu chí "Cách đỉnh tối đa 10%" giữ mã gần đỉnh, "Giảm từ đỉnh tối thiểu 30%" giữ mã đã giảm sâu', () => {
    const rows = rowsOf([
      S('NEAR', '2700', { marketcap: 950e9, shares: 10e6, high52: 100000, low52: 60000 }),           // giá 95.000: cách đỉnh 5%
      S('DEEP', '2700', { marketcap: 600e9, shares: 10e6, high52: 100000, low52: 55000 }),           // giá 60.000: cách đỉnh 40%
      S('NOPX', '2700', { marketcap: 600e9 }),
    ]);
    const near = MS.evaluate(rows, { values: { nearHigh: 10 } });
    expect(near.entries.map((e) => e.row.symbol)).toEqual(['NEAR']);
    expect(near.counts.missing.nearHigh).toBe(1);
    expect(MS.evaluate(rows, { values: { offHigh: 30 } }).entries.map((e) => e.row.symbol)).toEqual(['DEEP']);
    expect(MS.evaluate(rows, { values: { offHigh: 30, aboveLow: 10 } }).entries.length).toBe(0);    // DEEP chỉ cao hơn đáy 9,1%
  });
});

describe('điểm sức khoẻ tài chính', () => {
  it('đủ 9 dấu hiệu tốt -> 9/9; từng dấu hiệu xấu trừ một điểm', () => {
    const [g] = rowsOf([S('GOOD', '2700', GOOD)]);
    expect(g.health).toMatchObject({ score: 9, pass: 9, avail: 9 });
    const bad = Object.assign({}, GOOD, { cfoToSales: -0.05, deltaMargin: -0.02, currentRatio: 0.8 });
    // dòng tiền âm làm hỏng 2 dấu hiệu (dòng tiền dương, có tiền đi kèm); biên giảm; thanh toán < 1 -> đạt 5/9
    const [b] = rowsOf([S('BAD', '2700', bad)]);
    expect(b.health.score).toBe(5);
    expect(b.health.items.filter((x) => !x.ok).map((x) => x.label)).toEqual(['Dòng tiền kinh doanh dương', 'Lợi nhuận có tiền đi kèm (biên dòng tiền ≥ biên lợi nhuận ròng)', 'Biên lợi nhuận không giảm', 'Thanh toán hiện hành từ 1']);
  });
  it('không nợ ròng thì đạt dấu hiệu trả lãi dù thiếu hệ số trả lãi; vay nhiều, trả lãi yếu thì không', () => {
    const noDebt = Object.assign({}, GOOD, { interestCoverage: undefined, netCashToEquity: 0.3 });
    expect(rowsOf([S('A', '2700', noDebt)])[0].health.score).toBe(9);
    const weak = Object.assign({}, GOOD, { interestCoverage: 1.2, netCashToEquity: -1 });
    expect(rowsOf([S('B', '2700', weak)])[0].health.score).toBe(8);
  });
  it('thiếu số liệu: dưới 7 dấu hiệu thì không chấm; 8 dấu hiệu thì quy về thang 9 (7/8 -> 8)', () => {
    expect(rowsOf([S('X', '2700', { roaa: 0.1, cfoToSales: 0.1 })])[0].health).toBeNull();
    const eight = Object.assign({}, GOOD, { currentRatio: undefined, deltaMargin: -0.01 });       // 8 dấu hiệu, đạt 7 -> round(7/8*9) = round(7,875) = 8
    expect(rowsOf([S('Y', '2700', eight)])[0].health).toMatchObject({ score: 8, pass: 7, avail: 8 });
  });
  it('ngân hàng dùng 6 dấu hiệu riêng quy về thang 9; bảo hiểm, chứng khoán không chấm', () => {
    const bank = { roae: 0.18, roaa: 0.017, nim: 0.035, badDebtCoverage: 2.1, equityToAsset: 0.09, netProfitGrowthYoY: 0.12 };
    expect(rowsOf([S('VCB', '8300', bank)])[0].health).toMatchObject({ score: 9, avail: 6 });
    const weakBank = Object.assign({}, bank, { nim: 0.02, badDebtCoverage: 0.7 });                // NIM < 2,5%, dự phòng < 80%: đạt 4/6 -> 6/9
    expect(rowsOf([S('WB', '8300', weakBank)])[0].health.score).toBe(6);
    expect(rowsOf([S('BVH', '8500', GOOD)])[0].health).toBeNull();
    expect(rowsOf([S('SSI', '8700', GOOD)])[0].health).toBeNull();
  });
  it('tiêu chí "Điểm sức khoẻ tối thiểu 7" lọc đúng', () => {
    const rows = rowsOf([S('GOOD', '2700', GOOD), S('BAD', '2700', Object.assign({}, GOOD, { cfoToSales: -0.05, deltaMargin: -0.02, currentRatio: 0.8 }))]);
    expect(MS.evaluate(rows, { values: { health: 7 } }).entries.map((e) => e.row.symbol)).toEqual(['GOOD']);
  });
});

describe('tiêu chí mới', () => {
  const rows = rowsOf([
    S('IND', '2700', Object.assign({}, GOOD, { ps: 1.2, payoutTtm: 0.4, freefloat: 0.6, beta: 0.8 })),
    S('VCB', '8300', { roae: 0.18, nim: 0.03, badDebtCoverage: 2.2, equityToAsset: 0.085, pb: 2.2, pb5y: 2.5 }),
    S('SSI', '8700', { roae: 0.14, pb: 1.9 }),
  ]);
  const syms = (f) => MS.evaluate(rows, { values: f }).entries.map((e) => e.row.symbol).sort();
  it('tiêu chí riêng ngân hàng: chỉ ngân hàng có thể đạt', () => {
    expect(syms({ nim: 2.5 })).toEqual(['VCB']);
    expect(syms({ nplCover: 100 })).toEqual(['VCB']);
    expect(syms({ nplCover: 250 })).toEqual([]);
    expect(syms({ eqAsset: 8 })).toEqual(['VCB']);
  });
  it('tiêu chí phi tài chính bỏ qua ngân hàng/chứng khoán (như nợ/vốn), còn doanh nghiệp thường phải đạt', () => {
    expect(syms({ roic: 15 })).toEqual(['IND', 'SSI', 'VCB']);
    expect(syms({ roic: 20 })).toEqual(['SSI', 'VCB']);
    expect(syms({ cfoYears: 2, icr: 3, cr: 1.5, gross: 30, cfo: 10, netCash: -30 })).toEqual(['IND', 'SSI', 'VCB']);
    expect(syms({ cr: 2 })).toEqual(['SSI', 'VCB']);
  });
  it('P/B so với 5 năm, P/S, tỷ lệ chi trả, cổ phiếu tự do, beta', () => {
    expect(syms({ pbHist: 90 })).toEqual(['VCB']);           // 2,2/2,5 = 88%
    expect(syms({ pbHist: 85 })).toEqual([]);
    expect(syms({ ps: 1.5 })).toEqual(['IND']);
    expect(syms({ payout: 50, freefloat: 50, betaMax: 1 })).toEqual(['IND']);
  });
  it('mẫu lọc mới đều chỉ dùng tiêu chí có thật; "Ngân hàng tốt" chỉ ra ngân hàng', () => {
    MS.PRESETS.forEach((p) => Object.keys(p.values).forEach((k) => expect(MS.BY_KEY[k], p.key + ':' + k).toBeTruthy()));
    ['roicq', 'healthy', 'nearhigh', 'bank'].forEach((k) => expect(MS.PRESETS.some((p) => p.key === k)).toBe(true));
    const bankRows = rowsOf([S('VCB', '8300', { roae: 0.2, nim: 0.035, badDebtCoverage: 2, pb: 1.5 }), S('IND', '2700', Object.assign({}, GOOD, { pb: 1, nim: 0.05 }))]);
    expect(MS.evaluate(bankRows, { values: MS.PRESETS.find((p) => p.key === 'bank').values }).entries.map((e) => e.row.symbol)).toEqual(['VCB']);
  });
  it('cờ cảnh báo mới: có lãi mà dòng tiền âm, trả lãi yếu, trả cổ tức quá lợi nhuận', () => {
    const r = rowsOf([S('Z', '2700', { netMargin: 0.1, cfoToSales: -0.1, interestCoverage: 1.1, payoutTtm: 1.5 })])[0];
    const f = MS.flags(r).join(' | ');
    expect(f).toMatch(/dòng tiền kinh doanh âm/); expect(f).toMatch(/1,5 lần lãi vay/); expect(f).toMatch(/nhiều hơn lợi nhuận/);
    expect(MS.flags(rowsOf([S('OK', '2700', GOOD)])[0])).toEqual([]);
  });
});

describe('trọng số điểm do người dùng chỉnh', () => {
  const rows = rowsOf([
    S('CHEAP', '2700', { pe: 6, roae: 0.05, divYield: 0 }),           // định giá 95, chất lượng 9,1, cổ tức 0
    S('QUAL', '2700', { pe: 20, roae: 0.25, divYield: 0 }),           // định giá 25, chất lượng 100, cổ tức 0
  ]);
  it('mặc định giữ đúng cách xếp cũ (động lượng 0)', () => {
    expect(MS.WEIGHTS).toMatchObject({ value: 0.3, quality: 0.3, growth: 0.2, income: 0.1, safety: 0.1, momentum: 0 });
    // CHEAP: (95*0,3 + 9,09*0,3 + 0*0,1) / 0,7 = 44,61; QUAL: (25*0,3 + 100*0,3 + 0) / 0,7 = 53,57
    const r = MS.evaluate(rows, { values: { cap: 1 } });
    expect(r.entries.map((e) => e.row.symbol)).toEqual(['QUAL', 'CHEAP']);
    expect(r.entries[1].score).toBeCloseTo((95 * 0.3 + (2 / 22 * 100) * 0.3) / 0.7, 6);
  });
  it('chỉ đặt trọng số cho một nhóm thì một nhóm có số liệu là đủ để có điểm (trước đây mọi điểm trống)', () => {
    const r = MS.evaluate(rows, { values: { cap: 1 }, weights: { value: 100 } });
    expect(r.entries.map((e) => [e.row.symbol, Math.round(e.score)])).toEqual([['CHEAP', 95], ['QUAL', 25]]);
    expect(MS.score(rows[0], { value: 1, quality: 1 }).total).not.toBeNull();
  });
  it('dồn trọng số vào định giá thì mã rẻ lên đầu; nhóm trọng số 0 không tính', () => {
    const r = MS.evaluate(rows, { values: { cap: 1 }, weights: { value: 80, quality: 20, income: 0 } });
    expect(r.entries.map((e) => e.row.symbol)).toEqual(['CHEAP', 'QUAL']);
    expect(r.entries[0].score).toBeCloseTo((95 * 80 + (2 / 22 * 100) * 20) / 100, 6);
  });
  it('trọng số không hợp lệ hoặc toàn 0 -> dùng mặc định; số âm bị bỏ', () => {
    expect(MS.normalizeWeights({ value: 0, quality: 0 })).toBeNull();
    expect(MS.normalizeWeights({ value: -5, quality: 'x' })).toBeNull();
    expect(MS.normalizeWeights({ value: 50, bogus: 9 })).toEqual({ value: 50 });
    expect(MS.normalizeFilters({ values: {}, weights: { growth: 30 } }).weights).toEqual({ growth: 30 });
    expect(MS.normalizeFilters({ values: {} }).weights).toBeNull();
    expect(MS.weightsOf({ weights: { growth: 30 } })).toEqual({ value: 0, quality: 0, growth: 30, income: 0, safety: 0, momentum: 0 });
  });
  it('động lượng: JdK 110 và đang ở đỉnh -> 100; JdK 90 và cách đỉnh 40% -> 0', () => {
    const [hot, cold] = rowsOf([
      S('HOT', '2700', { jdkRs: 110, marketcap: 1000e9, shares: 10e6, high52: 100000, low52: 50000, pe: 10 }),
      S('COLD', '2700', { jdkRs: 90, marketcap: 600e9, shares: 10e6, high52: 100000, low52: 50000, pe: 10 }),
    ]);
    expect(MS.score(hot).parts.momentum).toBeCloseTo(100, 6);
    expect(MS.score(cold).parts.momentum).toBeCloseTo(0, 6);
    expect(MS.score(hot).total).toBeNull();                              // mặc định động lượng 0 -> chỉ còn 1 nhóm (định giá): chưa đủ 2 nhóm
    expect(MS.score(hot, { value: 1, momentum: 1 }).total).toBeCloseTo((75 + 100) / 2, 6);   // P/E 10 -> lin(15,0,20) = 75
  });
  it('điểm sức khoẻ góp vào nhóm chất lượng', () => {
    const [g] = rowsOf([S('G', '2700', Object.assign({}, GOOD, { netMargin: 0.1, roae: 0.2 }))]);
    // ROE 20% -> lin = (0,2-0,03)/0,22*100 = 77,27; biên 10% -> (0,1-0,02)/0,18*100 = 44,44; sức khoẻ 9/9 -> 100
    expect(MS.score(g).parts.quality).toBeCloseTo((0.17 / 0.22 * 100 + 0.08 / 0.18 * 100 + 100) / 3, 6);
  });
});

describe('ngưỡng từng dấu hiệu và chặn giá (bổ sung sau kiểm thử đột biến)', () => {
  const okOf = (r, label) => r.health.items.find((x) => x.label === label).ok;
  it('giá vượt đỉnh 52 tuần quá 15% (số cổ phiếu cũ) thì bỏ', () => {
    expect(MS.priceOf({ marketcap: 1500e9, shares: 10e6, high52: 100000, low52: 50000 })).toBeNull();     // 150.000 = 1,5 x đỉnh
    expect(MS.priceOf({ marketcap: 1100e9, shares: 10e6, high52: 100000, low52: 50000 })).toBe(110000);   // 1,1 x đỉnh: chấp nhận
  });
  it('dòng tiền dương chỉ 1/2 năm và nợ/vốn 1,5 lần là dấu hiệu xấu', () => {
    const [r] = rowsOf([S('A', '2700', Object.assign({}, GOOD, { positiveCfo2y: 1, debtToEquity: 1.5 }))]);
    expect(okOf(r, 'Dòng tiền kinh doanh dương cả 2 năm')).toBe(false);
    expect(okOf(r, 'Nợ vay / vốn chủ không quá 1')).toBe(false);
    expect(r.health.score).toBe(7);
  });
  it('NIM 3% đạt mốc 2,5%; NIM 2% không đạt', () => {
    const bank = { roae: 0.18, roaa: 0.017, nim: 0.03, badDebtCoverage: 0.9, equityToAsset: 0.09, netProfitGrowthYoY: 0.12 };
    expect(okOf(rowsOf([S('B', '8300', bank)])[0], 'NIM từ 2,5%')).toBe(true);
    expect(okOf(rowsOf([S('B', '8300', Object.assign({}, bank, { nim: 0.02 }))])[0], 'NIM từ 2,5%')).toBe(false);
    expect(okOf(rowsOf([S('B', '8300', bank)])[0], 'Dự phòng từ 80% nợ xấu')).toBe(true);
  });
  it('doanh nghiệp thường chỉ có 6 dấu hiệu có số liệu thì chưa chấm (cần 7)', () => {
    const six = { roaa: 0.08, cfoToSales: 0.15, positiveCfo2y: 2, netMargin: 0.1, netProfitGrowthYoY: 0.2, deltaMargin: 0.01 };      // 6 dấu hiệu (gồm "có tiền đi kèm")
    expect(rowsOf([S('X', '2700', six)])[0].health).toBeNull();
    expect(rowsOf([S('X', '2700', Object.assign({}, six, { currentRatio: 1.5 }))])[0].health.avail).toBe(7);
  });
  it('trọng số âm bị bỏ, trọng số hợp lệ còn lại được giữ', () => {
    expect(MS.normalizeWeights({ value: -5, quality: 10 })).toEqual({ quality: 10 });
  });
});
