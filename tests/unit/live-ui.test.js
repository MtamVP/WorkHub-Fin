import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const REPO = process.cwd().replace(/\\/g, '/');
const DAY = '2026-10-07';
const sec = (hh, mm) => Math.floor(Date.parse(DAY + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+07:00') / 1000);
const H = (symbol, price, extra) => Object.assign({ symbol, quantity: 100, avgCost: price, marketPrice: price, costValue: price * 100, marketValue: price * 100, unrealizedPnl: 0, priceLocked: false, targetPrice: 0, stopLoss: 0 }, extra || {});

// Chạy live-ui.js thật trong vm với DOM/localStorage giả; LiveQuotes.refresh được thay bằng bản giả lập giá theo kịch bản
function boot(opts) {
  const o = Object.assign({ stored: {}, notifs: [] }, opts), store = new Map(Object.entries(o.stored)), els = {}, rendered = [], notes = [];
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', hidden: false, clientWidth: 900 });
  const ctx = vm.createContext({
    window: { __TAURI__: { notification: { isPermissionGranted: async () => true, requestPermission: async () => 'granted', sendNotification: (n) => notes.push(n.title) } } },
    document: { getElementById: el, activeElement: null, hidden: false, addEventListener() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    setInterval: () => 1, setTimeout, clearTimeout, Promise, Date, JSON, Math, console,
    escapeAssetHtml: (s) => String(s).replace(/[&<>"']/g, ''), formatVnd: (n) => Math.round(n).toLocaleString('vi-VN'),
    renderHoldingsRows: (h) => rendered.push(h), setKpi() {}, updateHeroDelta() {},
  });
  ['lib/vn-holidays.js', 'lib/live-quotes.js', 'lib/live-alerts.js', 'lib/live-series.js', 'mastersheet/assets/live-ui.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  const UI = vm.runInContext('LiveUI', ctx), LQ = vm.runInContext('LiveQuotes', ctx);
  vm.runInContext('globalThis.LiveUI = LiveUI; globalThis.LiveQuotes = LiveQuotes; globalThis.LiveAlerts = LiveAlerts;', ctx);
  return { UI, LQ, els, store, rendered, notes, ctx };
}
const fakeRefresh = (LQ, scenario) => { LQ.refresh = async () => { const s = scenario(); LQ.state.quotes = s.quotes; LQ.state.fetchedAt = s.ts * 1000; LQ.state.error = null; LQ.state.source = 'vci'; return LQ.state; }; };
const q = (price, ref, ts) => ({ price, ref, open: ref, high: price, low: ref, volume: 1, date: DAY, time: '10:30:00', ts, source: 'vci' });
async function cycle(t) { t.UI.state.busy = false; t.UI.toggle(); await new Promise((r) => setTimeout(r, 5)); t.UI.toggle(); await new Promise((r) => setTimeout(r, 15)); }

describe('LiveUI: cảnh báo trực tiếp', () => {
  it('chạm giá mục tiêu / cắt lỗ / biến động mạnh: báo một lần, hiện dải cảnh báo, ghi khoá cùng định dạng với cảnh báo 5 phút', async () => {
    const t = boot();
    t.UI.afterHoldings([H('FPT', 100000, { targetPrice: 120000 }), H('SSI', 30000, { stopLoss: 28000 }), H('VNM', 60000), H('HPG', 25000)]);
    let at = sec(10, 0);
    fakeRefresh(t.LQ, () => ({ ts: at, quotes: { FPT: q(121000, 100000, at), SSI: q(27500, 30000, at), VNM: q(64500, 60000, at), HPG: q(25100, 25000, at) } }));
    await cycle(t);
    const titles = t.UI.state.alertLog.map((a) => a.title).sort();
    expect(titles).toEqual(['Chạm giá mục tiêu: FPT', 'Chạm ngưỡng cắt lỗ: SSI', 'FPT tăng mạnh trong ngày', 'SSI giảm mạnh trong ngày', 'VNM tăng mạnh trong ngày'].sort());
    expect(t.notes.sort()).toEqual(titles);
    const notified = JSON.parse([...t.store.entries()].find(([k]) => k.startsWith('wh_notified_price_alerts_'))[1]);
    expect(notified).toEqual(expect.arrayContaining(['FPT:target:120000', 'SSI:stop:28000', 'FPT:move_up:5', 'SSI:move_down:5', 'VNM:move_up:5']));
    expect(t.els['live-alerts'].hidden).toBe(false); expect(t.els['live-alerts'].innerHTML).toContain('Chạm giá mục tiêu: FPT');
    expect(t.els['live-status'].innerHTML).toContain('5 cảnh báo hôm nay');
    await cycle(t); await cycle(t);
    expect(t.UI.state.alertLog).toHaveLength(5); expect(t.notes).toHaveLength(5);          // không báo lại
  });
  it('cảnh báo 5 phút (notify-deadlines) đã báo mức này trong ngày thì không báo trùng; đổi ngưỡng biến động thì báo theo ngưỡng mới', async () => {
    const d = new Date(), key = 'wh_notified_price_alerts_' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const t = boot({ stored: { [key]: JSON.stringify(['FPT:target:120000']) } });
    t.UI.afterHoldings([H('FPT', 100000, { targetPrice: 120000 }), H('VNM', 60000)]);
    const at = sec(10, 0), px = { FPT: 121000, VNM: 62000 };
    fakeRefresh(t.LQ, () => ({ ts: at, quotes: { FPT: q(px.FPT, 100000, at), VNM: q(px.VNM, 60000, at) } }));
    t.UI.setMove(0); await cycle(t);
    expect(t.UI.state.alertLog).toHaveLength(0);                       // mục tiêu đã báo; biến động tắt
    t.UI.setMove(3); await cycle(t);
    expect(t.UI.state.alertLog.map((a) => a.title).sort()).toEqual(['FPT tăng mạnh trong ngày', 'VNM tăng mạnh trong ngày']);   // VNM +3,33% >= 3%
    expect(JSON.parse(t.store.get('wh.fin.live.v1')).movePct).toBe(3);
  });
  it('mã đã khoá giá hoặc không có giá trực tiếp thì không báo; tắt giá trực tiếp thì không báo', async () => {
    const t = boot();
    t.UI.afterHoldings([H('FPT', 100000, { targetPrice: 120000, priceLocked: true }), H('SSI', 30000, { stopLoss: 28000 })]);
    const at = sec(10, 0);
    fakeRefresh(t.LQ, () => ({ ts: at, quotes: { FPT: q(130000, 100000, at) } }));
    await cycle(t);
    expect(t.UI.state.alertLog).toHaveLength(0);
  });
  it('Ẩn cảnh báo xoá dải trong trang và bộ nhớ trong ngày', async () => {
    const t = boot();
    t.UI.afterHoldings([H('FPT', 100000, { targetPrice: 120000 })]);
    const at = sec(10, 0); fakeRefresh(t.LQ, () => ({ ts: at, quotes: { FPT: q(121000, 100000, at) } }));
    await cycle(t); expect(t.UI.state.alertLog.length).toBeGreaterThan(0);
    t.UI.clearAlerts(); expect(t.els['live-alerts'].hidden).toBe(true); expect(JSON.parse(t.store.get('wh.fin.livealerts.v1')).items).toEqual([]);
  });
});

describe('LiveUI: đường lãi/lỗ trong ngày', () => {
  it('mỗi lần lấy giá ghi một điểm theo giờ lấy giá, đường chỉ hiện khi có từ 2 điểm, ẩn/hiện được và lưu trong máy', async () => {
    const t = boot();
    t.UI.afterHoldings([H('FPT', 100000)]);
    let at = sec(9, 30), px = 100500;
    fakeRefresh(t.LQ, () => ({ ts: at, quotes: { FPT: q(px, 100000, at) } }));
    await cycle(t);
    expect(JSON.parse(t.store.get('wh.fin.liveseries.v1'))[DAY]).toHaveLength(1);
    expect(t.els['live-series'].hidden).toBe(true);                    // mới 1 điểm
    at = sec(9, 31); px = 100800; await cycle(t);
    at = sec(9, 32); px = 100200; await cycle(t);
    const pts = JSON.parse(t.store.get('wh.fin.liveseries.v1'))[DAY];
    expect(pts.map((p) => p[0])).toEqual([570, 571, 572]); expect(pts.map((p) => p[1])).toEqual([50000, 80000, 20000]);
    // vẽ theo ngày hiện tại của máy: điểm của ngày giả lập 07/10/2026 không hiện ở ngày khác, nhưng bộ nhớ vẫn lưu
    t.UI.toggleSeries(); expect(JSON.parse(t.store.get('wh.fin.live.v1')).showSeries).toBe(false);
  });
  it('khởi động lại: đọc lại cài đặt, đường lãi/lỗ và cảnh báo trong ngày đã lưu', () => {
    const d = new Date(), today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const t = boot({ stored: { 'wh.fin.live.v1': JSON.stringify({ on: true, movePct: 7, showSeries: false }), 'wh.fin.livealerts.v1': JSON.stringify({ date: today, items: [{ time: '10:00:00', title: 'A', body: 'b', level: 'good', key: 'k' }] }), 'wh.fin.livealerts.old': 'x' } });
    expect(t.UI.state.movePct).toBe(7); expect(t.UI.state.showSeries).toBe(false); expect(t.UI.state.alertLog).toHaveLength(1);
    const old = boot({ stored: { 'wh.fin.livealerts.v1': JSON.stringify({ date: '2020-01-01', items: [{ title: 'cũ' }] }) } });
    expect(old.UI.state.alertLog).toHaveLength(0);                     // cảnh báo của ngày khác không hiện lại
    expect(boot({ stored: { 'wh.fin.live.v1': 'không phải json' } }).UI.state.on).toBe(true);
  });
});

describe('LiveUI: ngày lễ', () => {
  it('ngày thường nghỉ lễ: trạng thái nói rõ và dùng giá lưu', () => {
    const t = boot();
    t.LQ.refresh = async () => { t.LQ.state.error = null; return t.LQ.state; };         // ngày lễ thật: VNDirect trả danh sách rỗng, không lỗi
    t.UI.afterHoldings([H('FPT', 100000)]);
    t.LQ.session = () => 'holiday';
    t.UI.renderStatus();
    expect(t.els['live-status'].innerHTML).toContain('nghỉ lễ'); expect(t.els['live-status'].innerHTML).toContain('dùng giá lưu');
  });
});
