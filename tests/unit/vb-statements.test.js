import { describe, it, expect } from 'vitest';
import S from '../../lib/vb-statements.js';

// Số thật rút gọn của FPT năm 2024-2025 (tỷ đồng nhân 1e9): kiểm tra tên trường, dấu và các chỉ tiêu suy ra
const B = 1e9;
const row = (code, date, v) => ({ itemCode: code, fiscalDate: date, numericValue: v * B, modelType: code < 20000 ? 1 : (code < 30000 ? 2 : 3) });
function fpt(date, k) {
  const m = {
    2024: { rev: 62848.8, cogs: 39150.4, gp: 23698.3, sell: 6116, adm: 7074, fin: 1935.7, int: 551.6, pt: 11069.7, tax: 1642.2, ni: 7856.8, nci: 1570.7, nia: 9427.4, cash: 9315.4, inv: 21785.2, rec: 11381.5, stock: 1856.8, ca: 45535.9, fa: 14816.1, ta: 72000, liab: 36272.5, cl: 34836.2, sd: 14446.2, ld: 501.1, eq: 35727.5, ncie: 5933.3, cfo: 11703.8, capex: -3275.3, da: 2535.3, div: -3291.9 },
    2025: { rev: 70112.8, cogs: 44224.3, gp: 25888.5, sell: 7562.7, adm: 7337.3, fin: 2977.2, int: 809.8, pt: 13043.6, tax: 1811.3, ni: 9376.1, nci: 1856.2, nia: 11232.3, cash: 10522.1, inv: 29631, rec: 14402, stock: 2193.8, ca: 58137.4, fa: 17288.5, ta: 88142, liab: 44394, cl: 41524.9, sd: 19169.7, ld: 1903.8, eq: 43748, ncie: 7265.1, cfo: 10136, capex: -5097.9, da: 2914.2, div: -4573.8 },
  }[k];
  return [row(21001, date, m.rev), row(22100, date, m.cogs), row(23100, date, m.gp), row(22110, date, m.sell), row(22200, date, m.adm), row(21500, date, m.fin), row(22510, date, m.int), row(23800, date, m.pt), row(22070, date, m.tax),
    row(23000, date, m.ni), row(23500, date, m.nci), row(23003, date, m.nia), row(11100, date, m.cash), row(11200, date, m.inv), row(11300, date, m.rec), row(11400, date, m.stock), row(11000, date, m.ca), row(12200, date, m.fa),
    row(12700, date, m.ta), row(13000, date, m.liab), row(13100, date, m.cl), row(13110, date, m.sd), row(13340, date, m.ld), row(14000, date, m.eq), row(14240, date, m.ncie), row(32000, date, m.cfo), row(32100, date, m.capex), row(22230, date, m.da), row(33600, date, m.div)];
}
const ROWS = fpt('2024-12-31', 2024).concat(fpt('2025-12-31', 2025));

describe('mergeRows và nhận dạng loại doanh nghiệp', () => {
  it('gộp các hàng theo kỳ và bỏ hàng thiếu giá trị hoặc ngày', () => {
    const m = S.mergeRows(ROWS.concat([{ itemCode: 1, fiscalDate: '', numericValue: 5 }, { itemCode: 2, fiscalDate: '2025-12-31', numericValue: null }]));
    expect(Object.keys(m)).toEqual(['2024-12-31', '2025-12-31']);
    expect(m['2025-12-31'][21001]).toBe(70112.8 * B);
    expect(m['2025-12-31'][2]).toBeUndefined();
  });
  it('nhận dạng theo mã mô hình, không theo giả định', () => {
    expect(S.detectFormFromRows([{ modelType: 101 }, { modelType: 102 }, { modelType: 1 }])).toBe('BANK');
    expect(S.detectFormFromRows([{ modelType: 90 }, { modelType: 89 }])).toBe('SECURITIES');
    expect(S.detectFormFromRows([{ modelType: 412 }])).toBe('INSURANCE');
    expect(S.detectFormFromRows([])).toBeNull();
    expect(S.detectForm({ 421701: 1 })).toBe('BANK');
  });
});

describe('normalize (doanh nghiệp thường)', () => {
  const p = S.normalize(S.mergeRows(ROWS), 'NON_FINANCE');
  const y = p[1];
  it('hai kỳ tăng dần theo ngày, tên trường chuẩn', () => {
    expect(p.map((x) => x.year)).toEqual([2024, 2025]);
    expect(y.revenue).toBe(70112.8 * B); expect(y.netIncome).toBe(9376.1 * B); expect(y.equityAll).toBe(43748 * B);
  });
  it('vốn chủ công ty mẹ = vốn chủ tổng − lợi ích cổ đông thiểu số', () => { expect(y.equity).toBeCloseTo((43748 - 7265.1) * B, 0); });
  it('EBIT hoạt động = lợi nhuận gộp − bán hàng − quản lý; EBITDA cộng khấu hao; FCF = CFO − capex (capex dương)', () => {
    expect(y.ebit / B).toBeCloseTo(25888.5 - 7562.7 - 7337.3, 6);
    expect(y.ebitda / B).toBeCloseTo(25888.5 - 7562.7 - 7337.3 + 2914.2, 6);
    expect(y.capex / B).toBeCloseTo(5097.9, 6); expect(y.fcf / B).toBeCloseTo(10136 - 5097.9, 6);
    expect(y.divPaid / B).toBeCloseTo(4573.8, 6);
  });
  it('nợ vay, tiền ròng, thuế suất thực tế', () => {
    expect(y.debt / B).toBeCloseTo(19169.7 + 1903.8, 6);
    expect(y.netCash / B).toBeCloseTo(10522.1 + 29631 - 19169.7 - 1903.8, 6);
    expect(y.effTaxRate).toBeCloseTo(1811.3 / 13043.6, 9);
  });
  it('thiếu khoản mục thì null chứ không bằng 0', () => {
    expect(y.goodwill).toBeNull(); expect(y.shareIssue).toBeNull();
    const t = S.normalize(S.mergeRows([row(21001, '2025-12-31', 100)]), 'NON_FINANCE')[0];
    expect(t.ebit).toBeNull(); expect(t.ebitda).toBeNull(); expect(t.fcf).toBeNull();
  });
});

describe('ttm và cagr', () => {
  const q = (date, rev, ni) => ({ date, revenue: rev, cogs: null, grossProfit: null, selling: null, admin: null, finIncome: null, finExpense: null, interest: null, pretax: null, tax: null, netIncomeAll: ni, nci: null, netIncome: ni, ebit: null, nii: null, toi: null, opex: null, ppop: null, provision: null, netFee: null, cash: 5 });
  it('cộng 4 quý liên tiếp cho chỉ tiêu dòng chảy, giữ số dư của kỳ mới nhất', () => {
    const t = S.ttm([q('2025-06-30', 1, 1), q('2025-09-30', 2, 2), q('2025-12-31', 3, 3), q('2026-03-31', 4, 4), q('2026-06-30', 5, 5)]);
    expect(t.revenue).toBe(2 + 3 + 4 + 5); expect(t.ttm).toBe(true); expect(t.date).toBe('2026-06-30'); expect(t.cash).toBe(5);
  });
  it('thiếu quý, quý không liên tiếp hoặc có quý thiếu số liệu: null', () => {
    expect(S.ttm([q('2025-12-31', 1, 1), q('2026-03-31', 1, 1), q('2026-06-30', 1, 1)])).toBeNull();
    expect(S.ttm([q('2023-12-31', 1, 1), q('2024-12-31', 1, 1), q('2025-12-31', 1, 1), q('2026-12-31', 1, 1)])).toBeNull();
    const bad = [q('2025-09-30', 1, 1), q('2025-12-31', 1, 1), q('2026-03-31', 1, 1), q('2026-06-30', null, 1)];
    expect(S.ttm(bad).revenue).toBeNull();
  });
  it('cagr', () => {
    const p = [100, 110, 121, 133.1].map((v) => ({ revenue: v }));
    expect(S.cagr(p, 'revenue', 3)).toBeCloseTo(0.1, 9);
    expect(S.cagr([{ revenue: -5 }, { revenue: 10 }], 'revenue', 1)).toBeNull();
    expect(S.cagr([{ revenue: 5 }], 'revenue', 1)).toBeNull();
  });
});

describe('ngân hàng', () => {
  it('chuẩn hoá các chỉ số đặc thù từ mã khoản mục thật của VCB', () => {
    const r = (c, v) => ({ itemCode: c, fiscalDate: '2025-12-31', numericValue: v * B });
    const b = S.normalize(S.mergeRows([r(421900, 58771.4), r(421701, 72454.6), r(22200, 25242.8), r(422900, 3192.2), r(23800, 44019.6), r(23000, 35177.7), r(412000, 1648550), r(413300, 1672534.8), r(12700, 2442279.2), r(14000, 224558.7)]), 'BANK')[0];
    expect(b.nonInterestIncome / B).toBeCloseTo(72454.6 - 58771.4, 4);
    expect(b.costIncome).toBeCloseTo(25242.8 / 72454.6, 9); expect(b.ldr).toBeCloseTo(1648550 / 1672534.8, 9); expect(b.creditCostPct).toBeCloseTo(3192.2 / 1648550, 9);
  });
});
