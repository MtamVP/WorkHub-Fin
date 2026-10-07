import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import LQ from '../../lib/live-quotes.js';
import LA from '../../lib/live-alerts.js';

const REPO = process.cwd().replace(/\\/g, '/');
const T = (day, hh, mm) => Math.floor(Date.parse(day + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+07:00') / 1000);
const vn = (hh, mm, day = '2026-10-07') => T(day, hh, mm) * 1000;
const W = (o) => Object.assign({ id: 'w1', symbol: 'MWG', price: 60000, buyBelow: 58000, targetPrice: 70000, addedPrice: 55000, held: false, signal: null }, o);

describe('LiveQuotes.parseIndex', () => {
  const today = '2026-10-07';
  const candles = { s: 'ok', t: [T('2026-10-06', 14, 44), T('2026-10-06', 14, 45), T(today, 9, 0), T(today, 10, 30)], c: [1740, 1742.5, 1745, 1751.25] };
  it('lấy nến cuối hôm nay làm giá trị và nến cuối phiên trước làm tham chiếu', () => {
    const x = LQ.parseIndex(candles, today);
    expect(x).toMatchObject({ symbol: 'VNINDEX', value: 1751.25, ref: 1742.5, date: today, time: '10:30:00' });
    expect(x.pct).toBeCloseTo((1751.25 - 1742.5) / 1742.5 * 100, 10);
  });
  it('chưa có nến hôm nay (ngày lễ, cuối tuần, trước giờ mở cửa), không có phiên trước hoặc dữ liệu lỗi thì null', () => {
    expect(LQ.parseIndex(candles, '2026-10-08')).toBeNull();
    expect(LQ.parseIndex({ s: 'ok', t: [T(today, 9, 0)], c: [1745] }, today)).toBeNull();
    expect(LQ.parseIndex({ s: 'no_data' }, today)).toBeNull(); expect(LQ.parseIndex(null, today)).toBeNull();
    expect(LQ.parseIndex({ s: 'ok', t: [T('2026-10-06', 14, 45), T(today, 9, 0)], c: [1742, 0] }, today)).toBeNull();
  });
});

describe('LiveQuotes.refresh có VN-Index', () => {
  beforeEach(() => { LQ.state.index = null; LQ.state.quotes = {}; LQ.state.vciFailures = 0; LQ.state.vciBackoffUntil = 0; });
  const row = { code: 'FPT', date: '2026-10-07', time: '10:19:59', basicPrice: 60.4, ceilingPrice: 64.6, floorPrice: 56.2, open: 60.4, high: 61.3, low: 60.2, close: 60.2, nmVolume: 1e6 };
  const mk = (idx) => { const calls = []; const f = async (url) => { calls.push(url); return url.includes('dchart') && url.includes('VNINDEX') ? { ok: true, json: async () => idx } : { ok: true, json: async () => ({ data: [row] }) }; }; f.calls = calls; return f; };
  const idx = { s: 'ok', t: [T('2026-10-06', 14, 45), T('2026-10-07', 10, 30)], c: [1742.5, 1751.25] };
  it('chỉ lấy chỉ số khi bên gọi bật index; không bật thì không gọi thêm', async () => {
    const f1 = mk(idx); await LQ.refresh(['FPT'], { fetch: f1, now: vn(10, 31) }); expect(f1.calls).toHaveLength(1); expect(LQ.state.index).toBeNull();
    const f2 = mk(idx); await LQ.refresh(['FPT'], { fetch: f2, now: vn(10, 31), index: true });
    expect(f2.calls).toHaveLength(2); expect(f2.calls.some((u) => u.includes('symbol=VNINDEX'))).toBe(true); expect(LQ.state.index.value).toBe(1751.25);
  });
  it('chỉ số lỗi không làm hỏng giá cổ phiếu; chỉ số của ngày cũ bị bỏ', async () => {
    await LQ.refresh(['FPT'], { fetch: mk(idx), now: vn(10, 31), index: true });
    const st = await LQ.refresh(['FPT'], { fetch: mk({ s: 'error' }), now: vn(10, 32), index: true });
    expect(st.quotes.FPT.price).toBe(60200); expect(st.index.value).toBe(1751.25);       // lần lỗi giữ chỉ số hôm nay
    const next = await LQ.refresh(['FPT'], { fetch: mk({ s: 'error' }), now: vn(9, 5, '2026-10-08'), index: true });
    expect(next.index).toBeNull();                                                     // sang ngày khác: bỏ chỉ số cũ
  });
});

describe('LiveQuotes.applyToWatchlist / LiveAlerts.evaluateWatch', () => {
  const q = { MWG: { price: 57500, ref: 59000, date: '2026-10-07', time: '10:30:00', source: 'vci' } };
  it('tính lại giá, khoảng cách tới giá muốn mua / mục tiêu / lúc thêm, tín hiệu mua và biến động trong ngày; mã không có giá giữ nguyên', () => {
    const [a, b] = LQ.applyToWatchlist([W(), W({ id: 'w2', symbol: 'ZZZ' })], q);
    expect(a).toMatchObject({ live: true, price: 57500, storedPrice: 60000, signal: 'buy' });
    expect(a.buyGapPct).toBeCloseTo((57500 - 58000) / 58000 * 100, 10); expect(a.upsidePct).toBeCloseTo((70000 - 57500) / 57500 * 100, 10); expect(a.sinceAddedPct).toBeCloseTo((57500 - 55000) / 55000 * 100, 10);
    expect(a.dayPct).toBeCloseTo((57500 - 59000) / 59000 * 100, 10); expect(a.priceMeta.kind).toBe('live');
    expect(b).toMatchObject({ live: false, price: 60000 }); expect(b.dayPct).toBeUndefined();
  });
  it('giá trên mức muốn mua thì không có tín hiệu; không đặt giá muốn mua thì khoảng cách là null', () => {
    const a = LQ.applyToWatchlist([W({ buyBelow: 50000 }), W({ buyBelow: 0, targetPrice: 0 })], q);
    expect(a[0].signal).toBeNull(); expect(a[1].signal).toBeNull(); expect(a[1].buyGapPct).toBeNull(); expect(a[1].upsidePct).toBeNull();
  });
  it('cảnh báo "tới giá mua": chỉ mã chưa giữ, đang có giá trực tiếp và có tín hiệu; khoá cùng định dạng với notify-deadlines.js', () => {
    const list = LQ.applyToWatchlist([W(), W({ id: 'w2', symbol: 'HPG', held: true }), W({ id: 'w3', symbol: 'ZZZ' })], Object.assign({ HPG: q.MWG }, q));
    const a = LA.evaluateWatch(list);
    expect(a).toHaveLength(1); expect(a[0]).toMatchObject({ symbol: 'MWG', kind: 'buy', price: 57500, threshold: 58000, key: 'MWG:buy:58000' });
    expect(LA.message(a[0])).toEqual({ title: 'Tới giá muốn mua: MWG', body: 'Giá 57.500 ≤ mức muốn mua 58.000 — mã trong danh sách theo dõi.' }); expect(LA.levelOf(a[0])).toBe('good');
    expect(LA.evaluateWatch(null)).toEqual([]);
  });
});

// ---- LiveUI: Theo Dõi + chỉ số, chạy live-ui.js thật trong vm ----
function boot() {
  const store = new Map(), els = {}, calls = { watchRender: 0, symbols: [] };
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', hidden: false, clientWidth: 900 });
  const ctx = vm.createContext({ window: {}, document: { getElementById: el, activeElement: null, hidden: false, addEventListener() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    setInterval: () => 1, setTimeout, clearTimeout, Promise, Date, JSON, Math, console, escapeAssetHtml: (s) => String(s), formatVnd: (n) => Math.round(n).toLocaleString('vi-VN'),
    renderHoldingsRows() {}, setKpi() {}, updateHeroDelta() {}, renderWatchlist() { calls.watchRender++; } });
  ['lib/vn-holidays.js', 'lib/live-quotes.js', 'lib/live-alerts.js', 'lib/live-series.js', 'mastersheet/assets/live-ui.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  return { UI: vm.runInContext('LiveUI', ctx), LQ: vm.runInContext('LiveQuotes', ctx), els, store, calls };
}
const day = '2026-10-07';
const H = (symbol, price) => ({ symbol, quantity: 100, avgCost: price, marketPrice: price, costValue: price * 100, marketValue: price * 100, unrealizedPnl: 0, priceLocked: false, targetPrice: 0, stopLoss: 0 });
const quote = (price, ref, ts) => ({ price, ref, date: day, time: '10:30:00', ts, source: 'vci' });
async function cycle(t) { t.UI.state.busy = false; t.UI.toggle(); await new Promise((r) => setTimeout(r, 5)); t.UI.toggle(); await new Promise((r) => setTimeout(r, 15)); }

describe('LiveUI: Theo Dõi và VN-Index', () => {
  it('mã chờ mua được lấy giá cùng lượt với danh mục, báo "tới giá mua" một lần, vẽ lại bảng Theo Dõi', async () => {
    const t = boot(), ts = T(day, 10, 30);
    t.UI.afterHoldings([H('FPT', 100000)]);
    const asked = [];
    t.LQ.refresh = async (syms) => { asked.push(syms.slice()); t.LQ.state.quotes = { FPT: quote(100500, 100000, ts), MWG: quote(57500, 59000, ts) }; t.LQ.state.fetchedAt = ts * 1000; t.LQ.state.error = null; return t.LQ.state; };
    t.UI.afterWatchlist([W()]);
    await new Promise((r) => setTimeout(r, 30));
    await cycle(t);
    expect(asked.every((s) => s.includes('FPT') && s.includes('MWG'))).toBe(true);
    expect(t.UI.state.alertLog.map((a) => a.title)).toContain('Tới giá muốn mua: MWG');
    expect(t.calls.watchRender).toBeGreaterThan(0);
    const n = t.UI.state.alertLog.length; await cycle(t); expect(t.UI.state.alertLog).toHaveLength(n);       // không báo lại
    expect(t.UI.watchView([W()])[0]).toMatchObject({ live: true, price: 57500, signal: 'buy' });
    t.UI.toggle(); expect(t.UI.watchView([W()])[0].price).toBe(60000);                                          // tắt giá trực tiếp: giá lưu
  });
  it('dòng trạng thái hiện VN-Index và danh mục hơn/kém chỉ số bao nhiêu điểm phần trăm', async () => {
    const t = boot(), ts = T(day, 10, 30);
    t.UI.afterHoldings([H('FPT', 100000)]);
    t.LQ.refresh = async () => { t.LQ.state.quotes = { FPT: quote(101000, 100000, ts) }; t.LQ.state.fetchedAt = ts * 1000; t.LQ.state.error = null;
      t.LQ.state.index = { symbol: 'VNINDEX', value: 1751.25, ref: 1742.5, pct: 0.5022, ts, time: '10:30:00', date: t.LQ.vnParts().date }; return t.LQ.state; };   // chỉ số chỉ hiện khi là của hôm nay: lấy ngày VN thật của lúc chạy test
    t.LQ.session = () => 'open';
    await cycle(t);
    const html = t.els['live-status'].innerHTML;
    expect(html).toContain('VN-Index'); expect(html).toContain('1.751,25'); expect(html).toContain('+0.50%'); expect(html).toContain('hơn chỉ số'); expect(html).toContain('0.50 điểm %');
  });
});
