import { describe, it, expect } from 'vitest';
import F from '../../lib/vb-fundamental.js';

// Hai năm của một doanh nghiệp giả định, số tròn để tính tay: đơn vị đồng
const prev = { date: '2024-12-31', year: 2024, form: 'NON_FINANCE', revenue: 1000, cogs: 600, grossProfit: 400, selling: 100, admin: 50, ebit: 250, ebitda: 300, da: 50, interest: 20, pretax: 240, tax: 48, netIncomeAll: 192, nci: 12, netIncome: 180, eps: 1800,
  cash: 100, stInvest: 50, receivables: 150, inventory: 120, payables: 80, currentAssets: 500, currentLiab: 300, fixedAssets: 600, totalAssets: 1200, liabilities: 500, stDebt: 150, ltDebt: 50, debt: 200, equityAll: 700, equity: 640, nciEquity: 60, paidIn: 100, retained: 300, cfo: 200, capex: 80, fcf: 120, divPaid: 60, shareIssue: 0, effTaxRate: 0.2, ltInvest: 30 };
const cur = { date: '2025-12-31', year: 2025, form: 'NON_FINANCE', revenue: 1200, cogs: 700, grossProfit: 500, selling: 110, admin: 60, ebit: 330, ebitda: 390, da: 60, interest: 18, pretax: 320, tax: 64, netIncomeAll: 256, nci: 16, netIncome: 240, eps: 2400,
  cash: 160, stInvest: 60, receivables: 170, inventory: 130, payables: 100, currentAssets: 620, currentLiab: 320, fixedAssets: 640, totalAssets: 1400, liabilities: 520, stDebt: 130, ltDebt: 40, debt: 170, equityAll: 880, equity: 810, nciEquity: 70, paidIn: 100, retained: 420, cfo: 300, capex: 90, fcf: 210, divPaid: 80, shareIssue: 0, effTaxRate: 0.2, ltInvest: 30 };

describe('ratios', () => {
  const r = F.ratios(cur, prev);
  it('biên lợi nhuận và sinh lời (vốn chủ bình quân của công ty mẹ)', () => {
    expect(r.grossMargin).toBeCloseTo(500 / 1200, 9); expect(r.ebitMargin).toBeCloseTo(330 / 1200, 9); expect(r.netMargin).toBeCloseTo(0.2, 9);
    expect(r.roe).toBeCloseTo(240 / ((810 + 640) / 2), 9); expect(r.roa).toBeCloseTo(256 / ((1400 + 1200) / 2), 9);
  });
  it('ROIC theo tài sản hoạt động ròng bình quân', () => {
    const noa = (p) => (p.totalAssets - p.cash - p.stInvest - p.ltInvest) - (p.liabilities - p.debt);
    expect(F.netOperatingAssets(cur)).toBe(noa(cur));
    expect(r.roic).toBeCloseTo(330 * 0.8 / ((noa(cur) + noa(prev)) / 2), 9);
  });
  it('vốn lưu động: DSO, DIO, DPO, CCC', () => {
    expect(r.dso).toBeCloseTo((150 + 170) / 2 / 1200 * 365, 6); expect(r.dio).toBeCloseTo((120 + 130) / 2 / 700 * 365, 6); expect(r.dpo).toBeCloseTo((80 + 100) / 2 / 700 * 365, 6);
    expect(r.ccc).toBeCloseTo(r.dso + r.dio - r.dpo, 9);
  });
  it('đòn bẩy, thanh khoản, dòng tiền và tăng trưởng bền vững', () => {
    expect(r.currentRatio).toBeCloseTo(620 / 320, 9); expect(r.quickRatio).toBeCloseTo((620 - 130) / 320, 9); expect(r.debtToEquity).toBeCloseTo(170 / 880, 9);
    expect(r.netDebt).toBe(170 - 160 - 60); expect(r.netDebtToEbitda).toBeCloseTo(-50 / 390, 9); expect(r.interestCover).toBeCloseTo(330 / 18, 9);
    expect(r.cfoToNetIncome).toBeCloseTo(300 / 256, 9); expect(r.payout).toBeCloseTo(80 / 240, 9); expect(r.sustainableGrowth).toBeCloseTo(r.roe * (1 - 80 / 240), 9);
    expect(r.revenueGrowth).toBeCloseTo(0.2, 9); expect(r.netIncomeGrowth).toBeCloseTo(240 / 180 - 1, 9);
  });
  it('thiếu năm trước: không có tăng trưởng, không lỗi', () => { const r0 = F.ratios(cur, null); expect(r0.revenueGrowth).toBeUndefined(); expect(r0.roe).toBeCloseTo(240 / 810, 9); });
});

describe('analyze và CAGR', () => {
  it('chuỗi tỷ số theo năm và tăng trưởng gộp', () => {
    const a = F.analyze([cur, prev]);            // đảo thứ tự: hàm tự sắp xếp
    expect(a.ratios.map((x) => x.year)).toEqual([2024, 2025]); expect(a.latest.year).toBe(2025);
    expect(a.growth.revenue3y).toBeCloseTo(0.2, 9);          // chỉ 1 năm khoảng: lấy tối đa khoảng có
  });
});

describe('dupont', () => {
  it('ROE = biên ròng × vòng quay × đòn bẩy', () => {
    const d = F.dupont(cur, prev);
    expect(d.check).toBeCloseTo(d.roe, 12);
    expect(d.five.ebitMargin).toBeCloseTo(330 / 1200, 9); expect(d.five.taxBurden).toBeCloseTo(256 / 320, 9); expect(d.five.interestBurden).toBeCloseTo(320 / 330, 9);
  });
});

describe('piotroski', () => {
  it('doanh nghiệp cải thiện đều: đủ 9 điểm', () => {
    const p = F.piotroski(Object.assign({}, cur, { shareIssue: 0 }), prev);
    expect(p.available).toBe(9);
    expect(p.score).toBe(9);              // ROA↑, CFO>0, CFO>NI, đòn bẩy ↓, hiện hành ↑(1,667→1,9375), gm ↑(0,4→0,4167), vòng quay ↑ (0,833→0,857)
    expect(p.grade.key).toBe('strong');
  });
  it('chỉ tính phát hành cổ phiếu thu tiền: thưởng cổ phiếu (tăng vốn góp) không bị phạt, ESOP lớn thì có', () => {
    expect(F.piotroski(Object.assign({}, cur, { paidIn: 150, shareIssue: 0 }), prev).tests.find((t) => t.key === 'shares').pass).toBe(true);
    expect(F.piotroski(Object.assign({}, cur, { shareIssue: 100 }), prev).tests.find((t) => t.key === 'shares').pass).toBe(false);
  });
  it('tiêu chí thiếu dữ liệu bị bỏ khỏi mẫu số, không tính là trượt', () => {
    const p = F.piotroski(Object.assign({}, cur, { cfo: null, currentAssets: null }), prev);
    expect(p.available).toBe(6); expect(p.tests.filter((t) => t.pass === null)).toHaveLength(3);
  });
  it('thiếu năm trước: không kết luận', () => { expect(F.piotroski(cur, null).score).toBeNull(); });
});

describe('altman', () => {
  it('Z" = 6,56·X1 + 3,26·X2 + 6,72·X3 + 1,05·X4 (tính tay)', () => {
    const z = F.altman(cur, 3000);
    const x1 = (620 - 320) / 1400, x2 = 420 / 1400, x3 = 330 / 1400, x4 = 880 / 520;
    expect(z.z2).toBeCloseTo(6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4, 9);
    expect(z.zone2.key).toBe('safe');
    expect(z.z).toBeCloseTo(1.2 * x1 + 1.4 * x2 + 3.3 * x3 + 0.6 * (3000 / 520) + 1.0 * (1200 / 1400), 9);
  });
  it('vùng nguy cơ khi lợi nhuận và vốn chủ kém; không áp dụng cho ngân hàng', () => {
    const bad = Object.assign({}, cur, { ebit: -200, retained: -300, equityAll: 50, currentAssets: 200, currentLiab: 700 });
    expect(F.altman(bad, null).zone2.key).toBe('distress');
    expect(F.altman(Object.assign({}, cur, { form: 'BANK' }), 1).z2).toBeNull();
  });
});

describe('beneish', () => {
  it('tính đủ 8 biến và công thức M (tính tay)', () => {
    const b = F.beneish(cur, prev);
    const v = b.vars;
    expect(v.dsri).toBeCloseTo((170 / 1200) / (150 / 1000), 9);
    expect(v.gmi).toBeCloseTo((400 / 1000) / (500 / 1200), 9);
    expect(v.sgi).toBeCloseTo(1.2, 9);
    expect(v.tata).toBeCloseTo((256 - 300) / 1400, 9);
    const m = -4.84 + 0.920 * v.dsri + 0.528 * v.gmi + 0.404 * v.aqi + 0.892 * v.sgi + 0.115 * v.depi - 0.172 * v.sgai + 4.679 * v.tata - 0.327 * v.lvgi;
    expect(b.m).toBeCloseTo(m, 9); expect(b.flag.key).toBe('ok');
  });
  it('doanh thu tăng vọt mà phải thu và dồn tích tăng: vượt ngưỡng', () => {
    const risky = Object.assign({}, cur, { receivables: 600, revenue: 2400, cfo: -100, netIncomeAll: 300 });
    expect(F.beneish(risky, prev).flag.key).toBe('risk');
  });
  it('thiếu biến thì báo thiếu chứ không đoán', () => {
    const b = F.beneish(Object.assign({}, cur, { receivables: null }), prev);
    expect(b.m).toBeNull(); expect(b.missing).toContain('dsri');
  });
});

describe('accruals và ngân hàng', () => {
  it('dồn tích Sloan: lợi nhuận vượt CFO nhiều là cờ', () => {
    expect(F.accruals(cur, prev).flag.tone).toBe('ok');
    expect(F.accruals(Object.assign({}, cur, { netIncomeAll: 600, cfo: 50 }), prev).flag.tone).toBe('warn');
    expect(F.accruals({ netIncomeAll: null, cfo: 1 }, null)).toBeNull();
  });
  it('chỉ số ngân hàng', () => {
    const b0 = { totalAssets: 1000, equity: 100, loansGross: 600, deposits: 700, nii: 30, toi: 40, opex: 14, provision: 4, ppop: 26, netIncome: 12, netIncomeAll: 12, costIncome: 14 / 40, ldr: 600 / 700, nonInterestIncome: 10, equityAll: 100, loanProvision: -9, eps: 1200 };
    const b1 = Object.assign({}, b0, { totalAssets: 1200, equity: 120, loansGross: 720, deposits: 800, nii: 36, netIncome: 15, netIncomeAll: 15, eps: 1250, loanProvision: -12 });
    const r = F.bank(b1, b0);
    expect(r.roe).toBeCloseTo(15 / 110, 9); expect(r.nimApprox).toBeCloseTo(36 / 1100, 9); expect(r.creditCost).toBeCloseTo(4 / 660, 9);
    expect(r.loanGrowth).toBeCloseTo(0.2, 9); expect(r.loanProvisionCoverage).toBeCloseTo(12 / 720, 9);
  });
});
