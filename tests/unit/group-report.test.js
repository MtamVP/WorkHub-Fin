// lib/group-report.js: mô hình báo cáo định kỳ của nhóm, HTML (escape) và sheet Excel. Số liệu lấy từ GroupCalc/LimitsCalc nên chỉ kiểm định dạng, tóm tắt và an toàn HTML.
import { describe, it, expect } from 'vitest';
import GroupReport from '../../lib/group-report.js';
import GroupCalc from '../../lib/group-calc.js';
import LimitsCalc from '../../lib/limits-calc.js';
import XlsxWriter from '../../lib/xlsx-writer.js';

const M = [{ id: 'u1', email: 'an@x.vn', nickname: 'An' }, { id: 'u2', email: 'binh@x.vn', nickname: '<b>Bình</b>' }];
const tx = (id, user_id, type, symbol, quantity, price, trade_date, extra = {}) => ({ id, user_id, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z', deleted_at: null, ...extra });
const TXNS = [tx('1', 'u1', 'buy', 'FPT', 1000, 100000, '2026-09-10'), tx('2', 'u1', 'buy', 'VCB', 500, 90000, '2026-09-11'), tx('3', 'u2', 'buy', 'FPT', 500, 105000, '2026-09-12'), tx('4', 'u2', 'sell', 'HPG', 100, 27000, '2026-09-13')];
const PRICES = [{ user_id: 'u1', symbol: 'FPT', market_price: 110000, price_date: '2026-10-02', updated_at: 'x' }, { user_id: 'u1', symbol: 'VCB', market_price: 95000, price_date: '2026-10-02', updated_at: 'x' }];
const P = GroupCalc.memberPortfolios({ members: M, txns: TXNS.slice(0, 3), actions: [], prices: PRICES, assets: [{ user_id: 'u1', cash: 50e6, debt: 0 }, { user_id: 'u2', cash: 20e6, debt: 0 }] });
const G = GroupCalc.consolidate(P);
const trades = GroupCalc.blotter({ members: M, txns: TXNS }, { from: '2026-09-01', to: '2026-09-30' });
const FLOW = GroupCalc.flow(trades, P);
const LIMITS = [{ id: 'l1', scope: 'member', user_id: null, kind: 'max_symbol_pct', symbol: null, sector: null, value: 30, mode: 'reason', active: true }];
const COMP = LimitsCalc.complianceMatrix(LIMITS, P, null);
const GP = { ok: true, cumulativePct: 4.2, annualizedPct: 18.5, hasBench: true, excessCumulativePct: 1.3, enough: true, alphaPct: 2.1, beta: 0.9, maxDD: -6.5, periods: 120 };
const input = (o = {}) => Object.assign({ asOf: '2026-10-02', period: { from: '2026-09-01', to: '2026-09-30', label: 'Tháng 9/2026' }, benchLabel: 'VN-Index', group: G, portfolios: P, groupPerf: GP,
  memberRows: GroupCalc.memberTable(P, {}, G), risk: { ok: true, portfolio: { varPct: 2.1 } }, compliance: COMP, exceptions: [{ created_at: '2026-09-12T03:00:00Z', user_id: 'u2', kind: 'max_symbol_pct', symbol: 'FPT', mode: 'reason', override: false, reason: 'Cơ hội <script>x</script>' }], flow: FLOW, trades, generatedAt: '2026-10-02T00:00:00Z' }, o);

describe('build', () => {
  const r = GroupReport.build(input());
  it('KPI lấy đúng từ danh mục gộp và hiệu quả nhóm', () => {
    const k = Object.fromEntries(r.kpis.map(x => [x.key, x]));
    expect(k.nav.value).toBe(G.nav);
    expect(k.return.text).toBe('+4,2%');
    expect(k.excess.text).toBe('+1,3%');
    expect(k.alpha.text).toMatch(/\+2,1% \/ 0,9/);
    expect(k.maxDD.sub).toMatch(/VaR 95%\/ngày 2,1%/);
    expect(k.shared.value).toBe(G.sharedCount);
  });
  it('danh mục, ngành, thành viên', () => {
    expect(r.holdings[0].symbol).toBe('FPT');
    expect(r.holdings[0].holders).toEqual(expect.arrayContaining(['An']));
    expect(r.sectors.reduce((s, x) => s + x.weightPct, 0)).toBeCloseTo(100, 6);
    expect(r.members).toHaveLength(2);
  });
  it('tuân thủ: liệt kê giới hạn đang vượt theo thành viên', () => {
    expect(r.compliance.limitsCount).toBe(2);
    const b = r.compliance.breaches;
    expect(b.length).toBeGreaterThan(0);
    expect(b[0]).toMatchObject({ kind: 'max_symbol_pct', modeLabel: 'Phải ghi lý do' });
  });
  it('ngoại lệ có tên người và nguồn', () => {
    expect(r.exceptions[0]).toMatchObject({ name: '<b>Bình</b>', kindLabel: 'Một mã tối đa', source: 'Lệnh', date: '2026-09-12' });
  });
  it('nhận xét tự động nêu điều đo được', () => {
    const t = r.notes.join('\n');
    expect(t).toMatch(/tăng 4,2%/);
    expect(t).toMatch(/vượt VN-Index 1,3%/);
    expect(t).toMatch(/giới hạn đầu tư đang bị vượt/);
    expect(t).toMatch(/ngoại lệ giới hạn/);
    expect(t).toMatch(/cùng mua/);
  });
  it('thiếu dữ liệu: vẫn dựng được, không ném lỗi, nói rõ chưa đủ', () => {
    const e = GroupReport.build({});
    expect(e.meta.title).toBe('Báo cáo định kỳ của nhóm');
    expect(e.notes.join(' ')).toMatch(/Chưa đủ lịch sử NAV/);
    expect(e.notes.join(' ')).toMatch(/chưa đặt giới hạn/);
    expect(() => GroupReport.toHtml(e)).not.toThrow();
    expect(() => XlsxWriter.build(GroupReport.toSheets(e))).not.toThrow();
  });
});

describe('toHtml', () => {
  const html = GroupReport.toHtml(GroupReport.build(input()));
  it('escape mọi nội dung người dùng (tên, lý do)', () => {
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Bình</b>');
    expect(html).toContain('&lt;b&gt;Bình&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
  it('có các mục chính', () => {
    ['Tóm tắt', 'Chỉ số chính', 'Danh mục chung', 'Thành viên', 'Tuân thủ giới hạn đầu tư', 'Hoạt động giao dịch'].forEach(s => expect(html).toContain(s));
    expect(html).toContain('Tháng 9/2026');
    expect(html).toContain('01/09/2026');
  });
});

describe('toSheets', () => {
  const sheets = GroupReport.toSheets(GroupReport.build(input()));
  it('6 sheet, tên hợp lệ cho Excel và build thành file xlsx', () => {
    expect(sheets.map(s => s.name)).toEqual(['01_Tong_quan', '02_Danh_muc_chung', '03_Thanh_vien', '04_Tuan_thu', '05_Ngoai_le', '06_So_lenh']);
    sheets.forEach(s => expect(s.name.length).toBeLessThanOrEqual(31));
    const bytes = XlsxWriter.build(sheets);
    expect(bytes.length).toBeGreaterThan(500);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('PK');
  });
  it('sổ lệnh có đủ lệnh trong kỳ và cột ngoại lệ', () => {
    const s = sheets[5];
    expect(s.rows.length).toBe(1 + trades.length);
    expect(s.rows[0][0].v).toBe('Ngày');
  });
  it('số tiền xuất dạng số nguyên, không phải chuỗi', () => {
    const nav = sheets[0].rows.find(r => r[0] === 'NAV cả nhóm');
    expect(nav[1]).toMatchObject({ s: 'int', v: Math.round(G.nav) });
  });
});

describe('periodFor', () => {
  const p = (k, t) => GroupReport.periodFor(k, t);
  it('tháng trước / tháng này', () => {
    expect(p('last-month', '2026-10-04')).toMatchObject({ from: '2026-08-31', start: '2026-09-01', to: '2026-09-30', label: 'Tháng 9/2026' });
    expect(p('this-month', '2026-10-04')).toMatchObject({ from: '2026-09-30', start: '2026-10-01', to: '2026-10-04' });
  });
  it('tháng 1: tháng trước là tháng 12 năm trước; tháng 2 nhuận', () => {
    expect(p('last-month', '2026-01-15')).toMatchObject({ from: '2025-11-30', start: '2025-12-01', to: '2025-12-31' });
    expect(p('last-month', '2024-03-02')).toMatchObject({ start: '2024-02-01', to: '2024-02-29' });
  });
  it('quý: trước / này (không quá hôm nay); quý 1 thì quý trước là quý 4 năm trước', () => {
    expect(p('last-quarter', '2026-10-04')).toMatchObject({ from: '2026-06-30', start: '2026-07-01', to: '2026-09-30', label: 'Quý 3/2026' });
    expect(p('this-quarter', '2026-10-04')).toMatchObject({ start: '2026-10-01', to: '2026-10-04' });
    expect(p('this-quarter', '2026-05-20').to).toBe('2026-05-20');
    expect(p('last-quarter', '2026-02-10')).toMatchObject({ start: '2025-10-01', to: '2025-12-31', label: 'Quý 4/2025' });
  });
  it('từ đầu năm và 12 tháng', () => {
    expect(p('ytd', '2026-10-04')).toMatchObject({ from: '2025-12-31', start: '2026-01-01', to: '2026-10-04' });
    const y = p('12m', '2026-10-04');
    expect(y.to).toBe('2026-10-04');
    expect((Date.parse(y.to) - Date.parse(y.start)) / 86400000).toBe(364);
  });
});
