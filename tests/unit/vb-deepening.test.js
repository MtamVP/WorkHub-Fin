// Làm sâu định giá: điều chỉnh khoản bất thường (vb-normalize), bộ mã so sánh tự chọn (vb-multiples.statsFromRows), DCF theo động lực (vb-dcf.driverValue) và đường đi qua engine/quy trình.
import { describe, it, expect } from 'vitest';
import NZ from '../../lib/vb-normalize.js';
import M from '../../lib/vb-multiples.js';
import D from '../../lib/vb-dcf.js';

describe('VBNormalize.apply', () => {
  const basis = { revenue: 1000, ebit: 150, ebitda: 200, pretax: 160, netIncome: 128, netIncomeAll: 130 };
  it('khoản trong EBIT đổi EBIT, EBITDA, trước thuế và sau thuế (qua thuế suất)', () => {
    const r = NZ.apply(basis, [{ label: 'Hoàn nhập dự phòng', type: 'operating', amount: -30 }], 0.2);
    expect(r.basis.ebit).toBe(120); expect(r.basis.ebitda).toBe(170); expect(r.basis.pretax).toBe(130); expect(r.basis.netIncome).toBeCloseTo(128 - 24, 9); expect(r.basis.normalized).toBe(true);
    expect(r.marginShift).toBeCloseTo(-0.03, 9); expect(basis.ebit).toBe(150);      // không đổi bản gốc
  });
  it('khoản dưới EBIT chỉ đổi lợi nhuận, không đổi EBIT/EBITDA', () => {
    const r = NZ.apply(basis, [{ label: 'Lãi bán đầu tư', type: 'nonoperating', amount: -50 }], 0.2);
    expect(r.basis.ebit).toBe(150); expect(r.basis.ebitda).toBe(200); expect(r.basis.pretax).toBe(110); expect(r.basis.netIncome).toBeCloseTo(88, 9); expect(r.marginShift).toBe(0);
  });
  it('khoản đã là sau thuế thì không nhân thuế lần nữa', () => {
    const r = NZ.apply(basis, [{ label: 'x', type: 'nonoperating', amount: -40, afterTax: true }], 0.2);
    expect(r.basis.netIncome).toBe(88); expect(r.basis.pretax).toBeCloseTo(160 - 50, 9);
  });
  it('bỏ qua khoản rỗng/không hợp lệ; không có điều chỉnh thì giữ nguyên', () => {
    expect(NZ.clean([{ amount: 0 }, { amount: 'abc' }, null, { amount: 5, label: 'ok' }])).toHaveLength(1);
    const r = NZ.apply(basis, [], 0.2); expect(r.basis.netIncome).toBe(128); expect(r.basis.normalized).toBeUndefined();
  });
});

describe('VBNormalize.suggest', () => {
  const P = (year, fin, ni) => ({ form: 'NON_FINANCE', year, date: year + '-12-31', revenue: 1000, finIncome: fin, pretax: 100, netIncome: ni, effTaxRate: 0.2 });
  it('gợi ý loại phần thu nhập tài chính vượt xa mức thường lệ (có số tiền và căn cứ)', () => {
    const periods = [P(2022, 5, 80), P(2023, 6, 80), P(2024, 5, 80), P(2025, 60, 80)];
    const s = NZ.suggest(periods, null);
    expect(s.suggestions).toHaveLength(1); expect(s.suggestions[0].type).toBe('nonoperating'); expect(s.suggestions[0].amount).toBeLessThan(0); expect(s.suggestions[0].why).toContain('Thu nhập tài chính');
  });
  it('không gợi ý khi thu nhập tài chính ổn định; thiếu dữ liệu thì rỗng', () => {
    expect(NZ.suggest([P(2022, 5, 80), P(2023, 6, 80), P(2024, 5, 80), P(2025, 6, 80)], null).suggestions).toHaveLength(0);
    expect(NZ.suggest([P(2025, 6, 80)], null)).toEqual({ suggestions: [], flags: [] });
  });
  it('cảnh báo (không có số tiền) khi lợi nhuận đổi mạnh nhưng doanh thu đứng yên, hoặc thuế suất bất thường', () => {
    const periods = [P(2022, 5, 50), P(2023, 5, 50), P(2024, 5, 50), Object.assign(P(2025, 5, 120), { effTaxRate: 0.02 })];
    const s = NZ.suggest(periods, null); expect(s.flags.length).toBe(2); expect(s.suggestions).toHaveLength(0);
  });
});

describe('VBMultiples.statsFromRows (bộ so sánh tự chọn)', () => {
  const rows = [{ symbol: 'A', metrics: { pe: 10, pb: 1, evEbitda: 6 } }, { symbol: 'B', metrics: { pe: 12, pb: 2, evEbitda: 8 } }, { symbol: 'C', metrics: { pe: 14, pb: 3, evEbitda: 10 } }, { symbol: 'D', metrics: { pe: -5, pb: 40, evEbitda: 200 } }];
  it('tính n, trung vị và 11 điểm phân vị, loại giá trị vô lý', () => {
    const st = M.statsFromRows(rows);
    expect(st.pe.n).toBe(3); expect(st.pe.median).toBe(12); expect(st.pe.q).toHaveLength(11); expect(st.pe.q[0]).toBe(10); expect(st.pe.q[10]).toBe(14);
    expect(st.pb.n).toBe(3); expect(st.evEbitda.n).toBe(3); expect(st.ps).toBeUndefined();
  });
  it('cần tối thiểu minN mã hợp lệ cho mỗi bội số', () => {
    expect(M.statsFromRows(rows, 4)).toEqual({}); expect(M.statsFromRows(rows.slice(0, 2), 3)).toEqual({});
  });
  it('peerImplied nhận minN: bộ 3 mã tạo giá ngầm định, mặc định cần 5', () => {
    const st = M.statsFromRows(rows), c = M.compute({ price: 100, shares: 10, period: { netIncome: 100, equity: 500 } });
    expect(M.peerImplied(c, {}, st, false).find((x) => x.key === 'pe')).toBeUndefined();
    const r = M.peerImplied(c, {}, st, false, 3).find((x) => x.key === 'pe');
    expect(r.base).toBeCloseTo(12 * 10, 6);      // EPS 10 x P/E trung vị 12
  });
});

describe('VBDcf.driverValue (DCF theo động lực)', () => {
  const base = { years: 5, segments: [{ name: 'A', baseRevenue: 1000, growth: [0.2, 0.15, 0.1], margin: 0.2 }, { name: 'B', baseRevenue: 500, growth: 0.05, margin: [0.1, 0.12] }], corpCostPct: 0.01, daPct: 0.03, capexPct: 0.05, nwcPct: 0.1, taxRate: 0.2, wacc: 0.11, gTerminal: 0.04, cash: 100, debt: 200, shares: 10, price: 100 };
  const r = D.driverValue(base);
  it('doanh thu từng năm là tổng các mảng; năm 1 đúng theo tăng trưởng từng mảng', () => {
    expect(r.ok).toBe(true); expect(r.rows).toHaveLength(5);
    expect(r.rows[0].revenue).toBeCloseTo(1000 * 1.2 + 500 * 1.05, 6); expect(r.rows[0].segRevenue[0]).toBeCloseTo(1200, 6);
    r.rows.forEach((x) => expect(x.revenue).toBeCloseTo(x.segRevenue.reduce((s, v) => s + v, 0), 6));
  });
  it('FCFF = NOPAT + khấu hao − capex − Δvốn lưu động; EBIT trừ chi phí chung', () => {
    const x = r.rows[0];
    expect(x.ebit).toBeCloseTo(1200 * 0.2 + 525 * 0.1 - 1725 * 0.01, 6);
    expect(x.fcff).toBeCloseTo(x.nopat + x.da - x.capex - x.dNwc, 6); expect(x.dNwc).toBeCloseTo((1725 - 1500) * 0.1, 6);
  });
  it('giá trị cuối kỳ và cầu nối: EV = PV(FCFF) + PV(TV); vốn chủ = EV + tiền − nợ', () => {
    expect(r.ev).toBeCloseTo(r.pvFcff + r.pvTv, 6); expect(r.equity).toBeCloseTo(r.ev + 100 - 200, 6); expect(r.perShare).toBeCloseTo(r.equity / 10, 6);
    expect(r.tvSharePct).toBeGreaterThan(0); expect(r.tvSharePct).toBeLessThan(100);
  });
  it('nhạy cảm đúng hướng: WACC cao hơn giảm giá trị; biên cao hơn tăng giá trị; capex cao hơn giảm giá trị', () => {
    expect(D.driverValue(Object.assign({}, base, { wacc: 0.13 })).perShare).toBeLessThan(r.perShare);
    expect(D.driverValue(Object.assign({}, base, { segments: [{ name: 'A', baseRevenue: 1000, growth: [0.2, 0.15, 0.1], margin: 0.3 }, base.segments[1]] })).perShare).toBeGreaterThan(r.perShare);
    expect(D.driverValue(Object.assign({}, base, { capexPct: 0.09 })).perShare).toBeLessThan(r.perShare);
  });
  it('đường tăng trưởng thiếu năm: giữ giá trị cuối rồi giảm dần về mức dài hạn ở năm cuối', () => {
    const p = D.pathOf([0.2, 0.1], 6, 0.04);
    expect(p[0]).toBe(0.2); expect(p[1]).toBe(0.1); expect(p[5]).toBeCloseTo(0.04, 9); expect(p[3]).toBeLessThan(p[2]);
    expect(D.pathOf(0.15, 4, null)).toEqual([0.15, 0.15, 0.15, 0.15]); expect(D.pathOf([], 3, null)).toBeNull();
  });
  it('đầu vào sai trả lỗi rõ ràng thay vì số vô nghĩa', () => {
    expect(D.driverValue(Object.assign({}, base, { segments: [] })).reason).toMatch(/mảng/);
    expect(D.driverValue(Object.assign({}, base, { wacc: 0.03 })).reason).toMatch(/WACC/);
    expect(D.driverValue(Object.assign({}, base, { capexPct: null })).reason).toMatch(/capex/);
    expect(D.driverValue(Object.assign({}, base, { segments: [{ name: 'A', baseRevenue: 100, growth: 0.1 }] })).ok).toBe(false);
  });
  it('cảnh báo khi tăng trưởng hoặc biên quá cao', () => {
    const w = D.driverValue(Object.assign({}, base, { segments: [{ name: 'A', baseRevenue: 1000, growth: 0.4, margin: 0.5 }] }));
    expect(w.warnings.join(' ')).toMatch(/rất cao/);
  });
  it('driverDefaults dựng mẫu một mảng từ giả định DCF và lịch sử', () => {
    const a = { baseRevenue: 1000, ebitMargin: 0.15, marginTarget: 0.15, g1: 0.1, gTerminal: 0.04, wacc: 0.11, years: 10, highYears: 5, marginYears: 5, taxRate: 0.2, taxTarget: 0.2, shares: 10, price: 100, cash: 50, debt: 20 };
    const periods = [1, 2, 3].map((i) => ({ form: 'NON_FINANCE', revenue: 800 + i * 50, capex: 40, da: 25, workingCapital: 100 }));
    const d = D.driverDefaults(a, periods);
    expect(d.segments).toHaveLength(1); expect(d.segments[0].growth).toHaveLength(7); expect(d.capexPct).toBeGreaterThan(0.03); expect(d.daPct).toBeGreaterThan(0.02); expect(d.wacc).toBe(0.11);
    expect(D.driverValue(d).ok).toBe(true);
    expect(D.driverDefaults(null, periods)).toBeNull();
  });
});
