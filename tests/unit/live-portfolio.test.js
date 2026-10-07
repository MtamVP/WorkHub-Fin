import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import LA from '../../lib/live-alerts.js';
import LC from '../../lib/limits-calc.js';

describe('LiveAlerts.evaluatePortfolio (NAV giảm trong ngày)', () => {
  it('báo khi NAV giảm vượt ngưỡng so với NAV theo giá tham chiếu hôm qua; mẫu số gồm cả tiền mặt', () => {
    // NAV hiện tại 19 triệu, hôm nay lỗ 1 triệu -> NAV tham chiếu 20 triệu -> -5%
    const a = LA.evaluatePortfolio({ dayPnl: -1e6, nav: 19e6 }, { navPct: 2 });
    expect(a).toHaveLength(1); expect(a[0]).toMatchObject({ kind: 'nav_down', threshold: 2, key: 'PF:nav_down:2' }); expect(a[0].pct).toBeCloseTo(-5, 10);
    expect(LA.evaluatePortfolio({ dayPnl: -1e6, nav: 19e6 }, { navPct: 5 })).toHaveLength(1);                     // đúng ngưỡng vẫn báo
    expect(LA.evaluatePortfolio({ dayPnl: -1e6, nav: 19e6 }, { navPct: 0 })).toEqual([]);                          // tắt
    expect(LA.evaluatePortfolio({ dayPnl: 1e6, nav: 21e6 }, { navPct: 2 })).toEqual([]);                           // lãi: không báo
    expect(LA.evaluatePortfolio({ dayPnl: -1e5, nav: 19.9e6 }, { navPct: 2 })).toEqual([]);                        // giảm 0,5%
    expect(LA.evaluatePortfolio({ dayPnl: null, nav: 1 }, {})).toEqual([]); expect(LA.evaluatePortfolio(null, {})).toEqual([]); expect(LA.evaluatePortfolio({ dayPnl: -5, nav: 0 }, {})).toEqual([]);
  });
  it('mặc định 2%; mức lạ về mặc định; nội dung thông báo', () => {
    expect(LA.evaluatePortfolio({ dayPnl: -3e5, nav: 9.7e6 })).toHaveLength(1);       // -3%
    expect(LA.normalizeNav(4)).toBe(2); expect(LA.normalizeNav('3')).toBe(3); expect(LA.normalizeNav(0)).toBe(0);
    const m = LA.message({ kind: 'nav_down', pct: -5, amount: -1e6, threshold: 2 });
    expect(m.title).toBe('Danh mục giảm mạnh trong ngày'); expect(m.body).toBe('NAV giảm 5,00% (1.000.000 đ) so với tham chiếu hôm qua; ngưỡng báo 2%.'); expect(LA.levelOf({ kind: 'nav_down' })).toBe('bad');
  });
});

describe('LiveAlerts.evaluateLimits (giới hạn đầu tư theo giá trong phiên)', () => {
  const items = [
    { kind: 'max_symbol_pct', subject: 'FPT', current: 50, threshold: 30, status: 'breach' },
    { kind: 'max_symbol_pct', subject: 'HPG', current: 27, threshold: 30, status: 'warn' },
    { kind: 'max_sector_pct', subject: 'Công nghệ', current: 61.25, threshold: 40, status: 'breach' },
    { kind: 'min_cash_pct', subject: 'Tiền mặt', current: 3, threshold: 5, status: 'breach' },
    { kind: 'max_position_vnd', subject: 'VNM', current: 25e6, threshold: 20e6, status: 'breach' },
    { kind: 'blocked_symbol', subject: 'XXX', current: 1, threshold: 0, status: 'breach' },
    { kind: 'max_leverage', subject: 'Đòn bẩy', current: 1.35, threshold: 1, status: 'breach' },
  ];
  it('chỉ lấy mục vượt (không lấy "gần chạm"), khoá theo loại + đối tượng + ngưỡng, lời nhắc đúng đơn vị', () => {
    const a = LA.evaluateLimits(items, LC.KINDS);
    expect(a.map((x) => x.key)).toEqual(['LIM:max_symbol_pct:FPT:30', 'LIM:max_sector_pct:Công nghệ:40', 'LIM:min_cash_pct:Tiền mặt:5', 'LIM:max_position_vnd:VNM:20000000', 'LIM:blocked_symbol:XXX:0', 'LIM:max_leverage:Đòn bẩy:1']);
    const txt = Object.fromEntries(a.map((x) => [x.limitKind, x.text]));
    expect(txt.max_symbol_pct).toBe('50,0% > 30,0%'); expect(txt.min_cash_pct).toBe('3,0% < tối thiểu 5,0%'); expect(txt.max_position_vnd).toBe('25.000.000 đ > 20.000.000 đ'); expect(txt.blocked_symbol).toBe('đang giữ mã bị cấm'); expect(txt.max_leverage).toBe('1,35× > 1,00×');
    const m = LA.message(a[0]); expect(m.title).toBe('Vượt giới hạn: Một mã tối đa FPT'); expect(m.body).toContain('50,0% > 30,0%'); expect(LA.levelOf(a[0])).toBe('bad');
    expect(LA.evaluateLimits(null)).toEqual([]);
  });
});

// ---- LiveUI: cảnh báo cấp danh mục với giới hạn thật (LimitsCalc) trong vm ----
const REPO = process.cwd().replace(/\\/g, '/');
const day = '2026-10-07', ts = Math.floor(Date.parse(day + 'T10:30:00+07:00') / 1000);
const H = (symbol, price, qty) => ({ symbol, quantity: qty, avgCost: price, marketPrice: price, costValue: price * qty, marketValue: price * qty, unrealizedPnl: 0, priceLocked: false, targetPrice: 0, stopLoss: 0 });
const quote = (price, ref) => ({ price, ref, date: day, time: '10:30:00', ts, source: 'vci' });
function boot(limitRows) {
  const store = new Map(), els = {}, calls = [];
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', hidden: false, clientWidth: 900 });
  const ctx = vm.createContext({ window: {}, document: { getElementById: el, activeElement: null, hidden: false, addEventListener() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    setInterval: () => 1, setTimeout, clearTimeout, Promise, Date, JSON, Math, console, escapeAssetHtml: (s) => String(s), formatVnd: (n) => Math.round(n).toLocaleString('vi-VN'),
    renderHoldingsRows() {}, setKpi() {}, updateHeroDelta() {}, targetEmail: 'a@b.c',
    callGAS: async (a) => { calls.push(a); if (a === 'listLimits') return { status: 'success', data: limitRows }; if (a === 'getLimitActor') return { status: 'success', data: { targetId: 'u1' } }; if (a === 'getCashDebt') return { status: 'success', data: { cash: 5e6, debt: 0 } }; return { status: 'error', message: 'x' }; } });
  ['lib/vn-holidays.js', 'lib/finance-calc.js', 'lib/limits-calc.js', 'lib/live-quotes.js', 'lib/live-alerts.js', 'lib/live-series.js', 'mastersheet/assets/live-ui.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  return { UI: vm.runInContext('LiveUI', ctx), LQ: vm.runInContext('LiveQuotes', ctx), els, store, calls };
}
async function cycle(t) { t.UI.state.busy = false; t.UI.toggle(); await new Promise((r) => setTimeout(r, 5)); t.UI.toggle(); await new Promise((r) => setTimeout(r, 25)); }
const LIMITS = [{ id: 'l1', scope: 'member', kind: 'max_symbol_pct', value: 30, mode: 'warn', active: true }];

describe('LiveUI: cảnh báo cấp danh mục', () => {
  it('NAV giảm vượt ngưỡng và vượt giới hạn tỷ trọng theo giá trong phiên: mỗi loại báo một lần', async () => {
    const t = boot(LIMITS);
    t.UI.afterHoldings([H('FPT', 100000, 100), H('HPG', 50000, 100)]);            // FPT 10 triệu, HPG 5 triệu, tiền mặt 5 triệu -> NAV 20 triệu
    t.UI.afterKpis({ nav: 20e6, marketValue: 15e6 });
    t.LQ.refresh = async () => { t.LQ.state.quotes = { FPT: quote(90000, 100000), HPG: quote(50000, 50000) }; t.LQ.state.fetchedAt = ts * 1000; t.LQ.state.error = null; return t.LQ.state; };
    await cycle(t); await cycle(t);
    const titles = t.UI.state.alertLog.map((a) => a.title);
    expect(titles).toContain('Danh mục giảm mạnh trong ngày');                        // NAV 20 -> 19 triệu = -5%
    expect(titles).toContain('Vượt giới hạn: Một mã tối đa FPT');                       // 9/19 = 47% > 30%
    const n = titles.length; await cycle(t); expect(t.UI.state.alertLog).toHaveLength(n);
    expect(t.calls.filter((c) => c === 'listLimits')).toHaveLength(1);                 // giới hạn chỉ nạp một lần trong 5 phút
  });
  it('đổi ngưỡng NAV: tắt thì không báo; lưu cài đặt; mức lạ về mặc định', async () => {
    const t = boot([]);
    t.UI.afterHoldings([H('FPT', 100000, 100), H('HPG', 50000, 100)]); t.UI.afterKpis({ nav: 20e6, marketValue: 15e6 });
    t.LQ.refresh = async () => { t.LQ.state.quotes = { FPT: quote(90000, 100000), HPG: quote(50000, 50000) }; t.LQ.state.fetchedAt = ts * 1000; t.LQ.state.error = null; return t.LQ.state; };
    t.UI.setNav(0); await cycle(t);
    expect(t.UI.state.alertLog.map((a) => a.title)).not.toContain('Danh mục giảm mạnh trong ngày');
    expect(JSON.parse(t.store.get('wh.fin.live.v1')).navPct).toBe(0);
    t.UI.setNav(3); expect(t.UI.state.navPct).toBe(3); t.UI.setNav(9); expect(t.UI.state.navPct).toBe(2);
    expect(t.els['live-status'].innerHTML).toContain('Báo NAV giảm');
  });
  it('không nạp được giới hạn thì vẫn báo NAV, không ném lỗi', async () => {
    const t = boot(null); t.LQ.state.error = null;
    t.UI.afterHoldings([H('FPT', 100000, 100)]); t.UI.afterKpis({ nav: 15e6, marketValue: 10e6 });
    t.LQ.refresh = async () => { t.LQ.state.quotes = { FPT: quote(80000, 100000) }; t.LQ.state.fetchedAt = ts * 1000; t.LQ.state.error = null; return t.LQ.state; };
    await cycle(t); await cycle(t);
    expect(t.UI.state.alertLog.map((a) => a.title)).toContain('Danh mục giảm mạnh trong ngày');                // 15 -> 13 triệu = -13,3%
  });
});
