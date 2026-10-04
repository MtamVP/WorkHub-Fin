// lib/stress-calc.js: hệ quả của kịch bản căng thẳng (giới hạn, ký quỹ) và kịch bản ngược.
import { describe, it, expect } from 'vitest';
import S from '../../lib/stress-calc.js';
import R from '../../lib/risk-calc.js';
import LC from '../../lib/limits-calc.js';

// VCB 400tr (beta 1), FPT 200tr (beta 1,5), tiền 100tr -> NAV 700tr, tổng giá trị x beta = 700tr
const mk = (o = {}) => Object.assign({ symbols: [{ symbol: 'VCB', sector: 'Ngân hàng', value: 400e6, betaAdj: 1 }, { symbol: 'FPT', sector: 'Công nghệ', value: 200e6, betaAdj: 1.5 }], cash: 100e6, debt: 0, nav: 700e6 }, o);
const lim = (kind, value, extra = {}) => Object.assign({ id: 'l-' + kind, scope: 'member', user_id: null, kind, symbol: null, sector: null, value, mode: 'block', active: true }, extra);

describe('reverse: VN-Index phải giảm bao nhiêu', () => {
  it('NAV mất 10/20/30% và về 0 theo beta danh mục', () => {
    const rev = S.reverse(mk());
    const by = Object.fromEntries(rev.map(x => [x.key, x.indexPct]));
    expect(by.nav10).toBeCloseTo(-10, 9);
    expect(by.nav20).toBeCloseTo(-20, 9);
    expect(by.nav30).toBeCloseTo(-30, 9);
    expect(by.nav0).toBeCloseTo(-100, 9);
    expect(by.margin).toBeUndefined();          // không có nợ -> không có ký quỹ
  });
  it('beta cao thì VN-Index chỉ cần giảm ít hơn; chỉ cú sốc nằm trong [-100, 0]', () => {
    const hi = S.reverse(mk({ symbols: [{ symbol: 'X', sector: 'Khác', value: 600e6, betaAdj: 2 }] }));       // nav 700, vb 1200
    expect(hi.find(x => x.key === 'nav20').indexPct).toBeCloseTo(-100 * 140e6 / 1200e6, 6);
    const low = S.reverse(mk({ symbols: [{ symbol: 'X', sector: 'Khác', value: 600e6, betaAdj: 0.2 }] }));    // vb 120: nav về 0 cần -583% -> không xảy ra
    expect(low.find(x => x.key === 'nav0').indexPct).toBeNull();
  });
  it('có nợ: tính điểm chạm ngưỡng ký quỹ; đã dưới ngưỡng thì 0', () => {
    const r = mk({ debt: 200e6, nav: 500e6 });            // giá trị cổ phiếu 600tr, NAV 500tr (83%)
    const m = S.reverse(r, { maintenancePct: 30 }).find(x => x.key === 'margin');
    expect(m.indexPct).toBeCloseTo(100 * ((0.3 * 600e6 - 500e6) / 0.7) / 700e6, 6);
    // kiểm lại bằng cách áp dụng: NAV / giá trị cổ phiếu đúng 30% tại điểm đó
    const pf = S.betaShocked(r, m.indexPct), st = S.marginState(pf, 30);
    expect(st.equityPct).toBeCloseTo(30, 6);
    const tight = S.reverse(mk({ debt: 450e6, nav: 250e6 }), { maintenancePct: 50 }).find(x => x.key === 'margin');   // 250/600 = 41,7% < 50%
    expect(tight.indexPct).toBe(0);
    expect(tight.note).toMatch(/Đã dưới ngưỡng/);
  });
  it('giới hạn đầu tiên bị vi phạm: trần 60% một mã, FPT beta 2 kéo tỷ trọng VCB vượt 60% khi VN-Index về ~ -25,5%', () => {
    const r = mk({ symbols: [{ symbol: 'VCB', sector: 'Ngân hàng', value: 400e6, betaAdj: 1 }, { symbol: 'FPT', sector: 'Công nghệ', value: 200e6, betaAdj: 2 }] });
    const rev = S.reverse(r, { LC, limits: LC.applicable([lim('max_symbol_pct', 60)], 'u1', 'member') });
    const l = rev.find(x => x.key === 'limit');
    expect(l.indexPct).toBeLessThan(-25);
    expect(l.indexPct).toBeGreaterThanOrEqual(-26);
    expect(l.note).toMatch(/VCB/);
  });
  it('không có giới hạn nào bị vi phạm thêm thì báo null; NAV không dương thì rỗng', () => {
    const rev = S.reverse(mk(), { LC, limits: LC.applicable([lim('max_symbol_pct', 99)], 'u1', 'member') });
    expect(rev.find(x => x.key === 'limit').indexPct).toBeNull();
    expect(S.reverse(mk({ nav: 0 }))).toEqual([]);
  });
});

describe('consequences: sau cú sốc', () => {
  const r = Object.assign(mk({ debt: 200e6, nav: 500e6 }), {});
  const shock = R.customStress(r, { index: -30, sectors: {}, symbols: {} });
  it('NAV, đòn bẩy và tỷ lệ ký quỹ trước/sau; cờ ký quỹ khi NAV/giá trị cổ phiếu dưới ngưỡng', () => {
    const c = S.consequences(r, shock, { maintenancePct: 30 });
    expect(c.navBefore).toBe(500e6);
    expect(c.navAfter).toBeCloseTo(500e6 - 0.3 * 700e6, 3);
    expect(c.margin.after.leverage).toBeGreaterThan(c.margin.before.leverage);
    expect(c.margin.before.breached).toBe(false);
    const harsh = S.consequences(r, R.customStress(r, { index: -66, sectors: {}, symbols: {} }), { maintenancePct: 30 });
    expect(harsh.margin.after.breached).toBe(true);          // giá trị cổ phiếu 138tr, NAV 38tr = 27,5% < 30% (điểm chạm lý thuyết là -65,3%)
    const mild = S.consequences(r, R.customStress(r, { index: -60, sectors: {}, symbols: {} }), { maintenancePct: 30 });
    expect(mild.margin.after.breached).toBe(false);          // NAV 80tr / 180tr = 44%
  });
  it('giới hạn: liệt kê vi phạm mới do cú sốc và vi phạm đã hết', () => {
    const rr = mk({ symbols: [{ symbol: 'VCB', sector: 'Ngân hàng', value: 400e6, betaAdj: 1 }, { symbol: 'FPT', sector: 'Công nghệ', value: 200e6, betaAdj: 2 }] });
    const limits = LC.applicable([lim('max_symbol_pct', 60)], 'u1', 'member');
    const sh = R.customStress(rr, { index: 0, sectors: {}, symbols: { FPT: -50 } });         // FPT mất một nửa -> VCB chiếm 400/600 = 66,7%
    const c = S.consequences(rr, sh, { LC, limits });
    expect(c.limits.before).toEqual([]);
    expect(c.limits.added.map(i => i.subject)).toEqual(['VCB']);
    const none = S.consequences(rr, R.customStress(rr, { index: 0, sectors: {}, symbols: {} }), { LC, limits });
    expect(none.limits.added).toEqual([]);
  });
});
