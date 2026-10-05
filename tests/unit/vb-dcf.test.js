import { describe, it, expect } from 'vitest';
import D from '../../lib/vb-dcf.js';

describe('wacc', () => {
  it('CAPM với Blume, nợ sau thuế và trọng số theo vốn hoá / nợ vay (tính tay)', () => {
    const w = D.wacc({ rf: 0.04, beta: 1.2, erp: 0.08, kdPre: 0.09, taxRate: 0.2, equityValue: 800, debtValue: 200 });
    const bu = 0.67 * 1.2 + 0.33, ke = 0.04 + bu * 0.08;
    expect(w.betaUsed).toBeCloseTo(bu, 12); expect(w.ke).toBeCloseTo(ke, 12); expect(w.we).toBeCloseTo(0.8, 12);
    expect(w.wacc).toBeCloseTo(0.8 * ke + 0.2 * 0.09 * 0.8, 12);
  });
  it('không nợ thì WACC = Ke; thiếu rf/beta thì null; có thể tắt Blume và cộng phần bù quy mô', () => {
    const w = D.wacc({ rf: 0.04, beta: 1, erp: 0.08, equityValue: 100, sizePremium: 0.02, betaAdjust: false });
    expect(w.wacc).toBeCloseTo(0.04 + 0.08 + 0.02, 12);
    expect(D.wacc({ beta: 1 })).toBeNull();
  });
});

describe('growthPath và marginPath', () => {
  it('giai đoạn cao giữ g1 rồi giảm tuyến tính về tăng trưởng dài hạn ở năm cuối', () => {
    const g = D.growthPath({ years: 10, highYears: 5, g1: 0.2, gTerminal: 0.05 });
    expect(g).toHaveLength(10); expect(g[0]).toBe(0.2); expect(g[4]).toBe(0.2); expect(g[9]).toBeCloseTo(0.05, 12); expect(g[6]).toBeCloseTo(0.2 + (0.05 - 0.2) * 2 / 5, 12);
  });
  it('dịch chuyển tăng trưởng mờ dần để năm cuối vẫn khớp dài hạn; mảng tự nhập được giữ nguyên', () => {
    const g = D.growthPath({ years: 10, highYears: 5, g1: 0.1, gTerminal: 0.05, growthShift: 0.04 });
    expect(g[0]).toBeCloseTo(0.14, 12); expect(g[9]).toBeCloseTo(0.05, 12);
    expect(D.growthPath({ years: 3, growth: [0.1, 0.2] })).toEqual([0.1, 0.2, 0.2]);
  });
  it('biên EBIT tiến tuyến tính tới mục tiêu', () => {
    const m = D.marginPath({ years: 10, ebitMargin: 0.1, marginTarget: 0.2, marginYears: 5 });
    expect(m[0]).toBeCloseTo(0.12, 12); expect(m[4]).toBeCloseTo(0.2, 12); expect(m[9]).toBeCloseTo(0.2, 12);
  });
});

describe('value', () => {
  const flat = { baseRevenue: 1000, ebitMargin: 0.2, g1: 0, highYears: 5, gTerminal: 0, years: 10, taxRate: 0.2, salesToCapital: 2, wacc: 0.1, shares: 100, cash: 0, debt: 0, minorities: 0 };
  it('không tăng trưởng, không tái đầu tư: EV = NOPAT / WACC (công thức đóng của perpetuity)', () => {
    const r = D.value(flat);
    expect(r.ok).toBe(true);
    expect(r.ev).toBeCloseTo(1000 * 0.2 * 0.8 / 0.1, 6);       // 1.600
    expect(r.perShare).toBeCloseTo(16, 9);
  });
  it('cầu nối EV → vốn chủ: cộng tiền và liên kết, trừ nợ và thiểu số', () => {
    const r = D.value(Object.assign({}, flat, { cash: 100, associates: 20, debt: 300, minorities: 50 }));
    expect(r.equity).toBeCloseTo(1600 + 100 + 20 - 300 - 50, 6);
  });
  it('thiểu số theo tỷ lệ lợi nhuận thay cho giá sổ sách', () => {
    const r = D.value(Object.assign({}, flat, { cash: 100, minorities: 1, minorityShare: 0.1 }));
    expect(r.equity).toBeCloseTo((1600 + 100) * 0.9, 6); expect(r.bridge.minorities).toBeCloseTo(170, 6);
  });
  it('tái đầu tư theo doanh thu trên vốn đầu tư; tăng trưởng làm FCFF nhỏ hơn NOPAT', () => {
    const r = D.value(Object.assign({}, flat, { g1: 0.1, gTerminal: 0.04, highYears: 10 }));
    expect(r.rows[0].reinvest).toBeCloseTo(1000 * 0.1 / 2, 9); expect(r.rows[0].fcff).toBeCloseTo(r.rows[0].nopat - r.rows[0].reinvest, 9);
  });
  it('giá trị cuối kỳ Gordon có ràng buộc ROIC: ROIC bằng WACC thì tăng trưởng cuối kỳ không tạo giá trị', () => {
    const a = Object.assign({}, flat, { g1: 0.05, gTerminal: 0.03, highYears: 10, terminalRoic: 0.1 });
    const lo = D.value(a), hi = D.value(Object.assign({}, a, { terminalRoic: 0.3 }));
    expect(hi.ev).toBeGreaterThan(lo.ev);                      // ROIC cao: ít tái đầu tư hơn cho cùng tăng trưởng
    const last = lo.rows[9], reinv = 0.03 / 0.1;
    expect(lo.terminal.reinvestRate).toBeCloseTo(reinv, 12); expect(lo.terminal.fcffN1).toBeCloseTo(last.nopat * 1.03 * (1 - reinv), 6);
  });
  it('bội số thoát: trộn theo trọng số với Gordon', () => {
    const a = Object.assign({}, flat, { g1: 0.05, gTerminal: 0.03, highYears: 10, capexPct: 0.06, daPct: 0.05, nwcPct: 0.1, exitMultiple: 8, exitWeight: 1 });
    const r = D.value(a);
    expect(r.terminal.tvExit).toBeCloseTo(r.terminal.ebitdaN * 8, 6);
    expect(r.terminal.pv).toBeCloseTo(r.terminal.tvExit / Math.pow(1.1, 10), 6);
    expect(D.value(Object.assign({}, a, { exitWeight: 0 })).terminal.pv).toBeCloseTo(r.terminal.tvGordon / Math.pow(1.1, 10), 6);
  });
  it('quy ước giữa năm làm giá trị cao hơn', () => {
    const a = Object.assign({}, flat, { g1: 0.05, gTerminal: 0.03, highYears: 10 });
    expect(D.value(Object.assign({}, a, { midYear: true })).ev).toBeGreaterThan(D.value(a).ev);
  });
  it('từ chối đầu vào sai và cảnh báo các giả định thiếu thực tế', () => {
    expect(D.value({ baseRevenue: 0, ebitMargin: 0.1, wacc: 0.1 }).ok).toBe(false);
    expect(D.value(Object.assign({}, flat, { wacc: 0.03, gTerminal: 0.05 })).ok).toBe(false);
    const w = D.value(Object.assign({}, flat, { g1: 0.1, gTerminal: 0.08, wacc: 0.09, highYears: 5, rf: 0.04 }));
    expect(w.warnings.join(' ')).toMatch(/tăng trưởng danh nghĩa|lãi suất phi rủi ro/);
  });
  it('lỗ vận hành: NOPAT âm, vốn chủ có thể âm và được cảnh báo', () => {
    const r = D.value(Object.assign({}, flat, { ebitMargin: -0.1, marginTarget: -0.1, debt: 5000 }));
    expect(r.equity).toBeLessThan(0); expect(r.warnings.join(' ')).toMatch(/vốn chủ âm/);
  });
  it('thuế hội tụ tuyến tính về mức dài hạn', () => {
    const r = D.value(Object.assign({}, flat, { taxRate: 0.1, taxTarget: 0.2 }));
    expect(r.rows[0].taxRate).toBeCloseTo(0.11, 12); expect(r.rows[9].taxRate).toBeCloseTo(0.2, 12);
  });
});

describe('nhạy cảm', () => {
  const a = { baseRevenue: 1000, ebitMargin: 0.2, g1: 0.08, highYears: 5, gTerminal: 0.04, years: 10, taxRate: 0.2, salesToCapital: 2, wacc: 0.1, shares: 100, cash: 0, debt: 0 };
  it('giá trị giảm khi WACC tăng và tăng khi tăng trưởng dài hạn tăng (đơn điệu)', () => {
    const s = D.sensitivityWaccG(a, [0.08, 0.1, 0.12], [0.03, 0.04, 0.05]);
    for (let j = 0; j < 3; j++) { expect(s.values[0][j]).toBeGreaterThan(s.values[1][j]); expect(s.values[1][j]).toBeGreaterThan(s.values[2][j]); }
    for (let i = 0; i < 3; i++) { expect(s.values[i][2]).toBeGreaterThan(s.values[i][0]); }
    expect(s.values[1][1]).toBeCloseTo(D.value(a).perShare, 9);
  });
  it('ô WACC ≤ g trả null thay vì số vô nghĩa; lưới biên-tăng trưởng đơn điệu theo biên', () => {
    expect(D.sensitivityWaccG(a, [0.03], [0.04]).values[0][0]).toBeNull();
    const m = D.sensitivityMarginGrowth(a, [0.1, 0.2, 0.3], [0.05, 0.1]);
    expect(m.values[2][0]).toBeGreaterThan(m.values[0][0]);
  });
  it('around tạo lưới đối xứng', () => { expect(D.around(0.1, 0.01, 2)).toEqual([0.08, 0.09, 0.1, 0.11, 0.12]); });
});

describe('Monte Carlo', () => {
  const a = { baseRevenue: 1000, ebitMargin: 0.2, g1: 0.08, highYears: 5, gTerminal: 0.04, years: 10, taxRate: 0.2, salesToCapital: 2, wacc: 0.1, shares: 100, cash: 0, debt: 0, price: 20 };
  it('tái lập được với cùng hạt giống và khác khi đổi hạt giống', () => {
    const x = D.monteCarlo(a, { n: 400, seed: 7 }), y = D.monteCarlo(a, { n: 400, seed: 7 }), z = D.monteCarlo(a, { n: 400, seed: 8 });
    expect(x.median).toBe(y.median); expect(x.p5).toBe(y.p5); expect(z.median).not.toBe(x.median);
  });
  it('phân vị sắp theo thứ tự, xác suất trong [0,1], histogram tổng bằng số mẫu', () => {
    const r = D.monteCarlo(a, { n: 600 });
    expect(r.p5).toBeLessThan(r.p25); expect(r.p25).toBeLessThan(r.median); expect(r.median).toBeLessThan(r.p75); expect(r.p75).toBeLessThan(r.p95);
    expect(r.probAbovePrice).toBeGreaterThanOrEqual(0); expect(r.probAbovePrice).toBeLessThanOrEqual(1);
    expect(r.histogram.counts.reduce((s, v) => s + v, 0)).toBe(r.n);
    expect(Math.abs(r.median / r.base - 1)).toBeLessThan(0.15);       // trung vị gần giá trị cơ sở
  });
  it('độ rộng tăng khi mở rộng các độ bất định', () => {
    const narrow = D.monteCarlo(a, { n: 500, growthSpread: 0.01, marginSpread: 0.01, waccSpread: 0.005, gSpread: 0.003, s2cSpread: 0.05 });
    const wide = D.monteCarlo(a, { n: 500, growthSpread: 0.06, marginSpread: 0.05, waccSpread: 0.02, gSpread: 0.015, s2cSpread: 0.4 });
    expect(wide.p95 - wide.p5).toBeGreaterThan(narrow.p95 - narrow.p5);
  });
  it('đầu vào sai: không lỗi', () => { expect(D.monteCarlo({ baseRevenue: 0 }).ok).toBe(false); });
});

describe('DCF ngược và kịch bản', () => {
  const a = { baseRevenue: 1000, ebitMargin: 0.2, g1: 0.08, highYears: 5, gTerminal: 0.04, years: 10, taxRate: 0.2, salesToCapital: 2, wacc: 0.1, shares: 100, cash: 0, debt: 0 };
  it('tìm lại đúng độ dịch chuyển tăng trưởng đã dùng để sinh ra giá', () => {
    const price = D.value(Object.assign({}, a, { growthShift: 0.03 })).perShare;
    const im = D.implied(a, price);
    expect(im.growthShift).toBeCloseTo(0.03, 4); expect(im.impliedGrowthStage1).toBeCloseTo(0.11, 4);
  });
  it('tìm lại WACC và biên ngầm định', () => {
    const p1 = D.value(Object.assign({}, a, { wacc: 0.12 })).perShare, p2 = D.value(Object.assign({}, a, { marginShift: -0.04 })).perShare;
    expect(D.implied(a, p1).impliedWacc).toBeCloseTo(0.12, 4); expect(D.implied(a, p2).impliedMarginShift).toBeCloseTo(-0.04, 4);
  });
  it('giá ngoài khoảng giải được: null chứ không bịa', () => { expect(D.implied(a, 1e9).growthShift).toBeNull(); expect(D.implied(a, -5)).toBeNull(); });
  it('kịch bản: bi quan < cơ sở < lạc quan; kỳ vọng là trung bình có trọng số xác suất', () => {
    const s = D.runDefaultScenarios(a), v = Object.fromEntries(s.list.map((x) => [x.name, x.perShare]));
    expect(v['Bi quan']).toBeLessThan(v['Cơ sở']); expect(v['Cơ sở']).toBeLessThan(v['Lạc quan']);
    expect(s.expected).toBeCloseTo(0.25 * v['Bi quan'] + 0.5 * v['Cơ sở'] + 0.25 * v['Lạc quan'], 9); expect(s.probSum).toBeCloseTo(1, 12);
  });
});

describe('buildAssumptions', () => {
  const p = (y, rev, ebit, ni, nci) => ({ form: 'NON_FINANCE', date: y + '-12-31', year: y, revenue: rev, ebit: ebit, netIncome: ni, netIncomeAll: ni + nci, nci: nci, equity: 5000, divPaid: ni * 0.3, effTaxRate: 0.15, debt: 1000, interest: 80, cash: 500, stInvest: 200, nciEquity: 400, ltInvest: 100, totalAssets: 9000 + y - 2020 + rev * 0.2, liabilities: 3000 });
  const periods = [p(2022, 8000, 1200, 900, 100), p(2023, 9000, 1400, 1000, 100), p(2024, 10500, 1700, 1250, 150), p(2025, 12000, 2000, 1500, 200)];
  const a = D.buildAssumptions({ periods: periods, price: 50000, shares: 100, beta: 1, rf: 0.04, erp: 0.08, marketCap: 5000 });
  it('suy ra giả định hợp lý và kèm ghi chú nguồn', () => {
    expect(a.baseRevenue).toBe(12000); expect(a.ebitMargin).toBeCloseTo(((1400 / 9000) + (1700 / 10500) + (2000 / 12000)) / 3, 9);
    expect(a.g1).toBeGreaterThanOrEqual(0.02); expect(a.g1).toBeLessThanOrEqual(0.2);
    expect(a.taxTarget).toBe(0.2); expect(a.minorityShare).toBeCloseTo((100 / 1100 + 150 / 1400 + 200 / 1700) / 3, 6);
    expect(a.notes.length).toBeGreaterThanOrEqual(5); expect(D.value(a).ok).toBe(true);
  });
  it('dùng TTM làm doanh thu cơ sở khi có; thiếu dữ liệu: null', () => {
    const t = D.buildAssumptions({ periods: periods, ttm: { revenue: 13000, date: '2026-06-30' }, price: 1, shares: 1, rf: 0.04, marketCap: 1 });
    expect(t.baseRevenue).toBe(13000); expect(t.baseIsTtm).toBe(true);
    expect(D.buildAssumptions({ periods: [] })).toBeNull();
  });
  it('tăng trưởng dài hạn không vượt lãi suất phi rủi ro', () => { expect(D.buildAssumptions({ periods: periods, rf: 0.03, price: 1, shares: 1, marketCap: 1 }).gTerminal).toBe(0.03); });
});
