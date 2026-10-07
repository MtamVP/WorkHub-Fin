import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const REPO = process.cwd().replace(/\\/g, '/');
const D1 = '2026-10-07', D2 = '2026-10-08';
const sec = (day, hh, mm) => Math.floor(Date.parse(day + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+07:00') / 1000);
const H = (symbol, price, extra) => Object.assign({ symbol, quantity: 100, avgCost: price, marketPrice: price, costValue: price * 100, marketValue: price * 100, unrealizedPnl: 0, priceLocked: false, targetPrice: 0, stopLoss: 0 }, extra || {});
const q = (price, ref, day, ts) => ({ price, ref, open: ref, high: price, low: ref, volume: 1, date: day, time: '10:30:00', ts, source: 'vci' });

// Chạy live-ui.js + alert-review-ui.js thật trong vm; ngày VN do kịch bản đặt (LiveQuotes.vnParts)
function boot(stored) {
  const store = new Map(Object.entries(stored || {})), els = {}, saved = [], opened = [];
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', hidden: false, clientWidth: 900 });
  const ctx = vm.createContext({
    window: { __TAURI__: { notification: { isPermissionGranted: async () => true, requestPermission: async () => 'granted', sendNotification() {} } } },
    document: { getElementById: el, activeElement: null, hidden: false, addEventListener() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    setInterval: () => 1, setTimeout, clearTimeout, Promise, Date, JSON, Math, console, TextEncoder,
    escapeAssetHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), formatVnd: (n) => Math.round(n).toLocaleString('vi-VN'),
    renderHoldingsRows() {}, setKpi() {}, updateHeroDelta() {}, showToast() {},
    FinCalc: { buildCsv: (rows) => rows.map((r) => r.join(',')).join('\n') }, saveBytesToDisk: async (name, bytes) => { saved.push([name, new TextDecoder().decode(bytes)]); return true; },
    openDecisionModal: (o) => opened.push(o),
  });
  ['lib/vn-holidays.js', 'lib/live-quotes.js', 'lib/live-alerts.js', 'lib/live-series.js', 'lib/alert-review.js', 'mastersheet/assets/alert-review-ui.js', 'mastersheet/assets/live-ui.js']
    .forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  vm.runInContext('globalThis.LiveUI = LiveUI; globalThis.LiveQuotes = LiveQuotes; globalThis.AlertReviewUI = AlertReviewUI;', ctx);
  const LQ = vm.runInContext('LiveQuotes', ctx);
  const setDay = (day) => { LQ.vnParts = () => ({ date: day, minutes: 600, dow: 3 }); };
  return { UI: vm.runInContext('LiveUI', ctx), AR: vm.runInContext('AlertReviewUI', ctx), LQ, els, store, saved, opened, setDay };
}
const fakeRefresh = (LQ, scenario) => { LQ.refresh = async () => { const s = scenario(); LQ.state.quotes = s.quotes; LQ.state.fetchedAt = s.ts * 1000; LQ.state.error = null; LQ.state.source = 'vci'; return LQ.state; }; };
async function cycle(t) { t.UI.state.busy = false; t.UI.toggle(); await new Promise((r) => setTimeout(r, 5)); t.UI.toggle(); await new Promise((r) => setTimeout(r, 15)); }

describe('Ôn lại cảnh báo (alert-review-ui.js) trong Danh Mục', () => {
  it('cảnh báo kêu ngày 1 được ghi kèm giá; ngày 2 cập nhật giá phiên sau; bảng tổng hợp và nút ghi quyết định', async () => {
    const t = boot();
    t.UI.afterHoldings([H('FPT', 100000, { targetPrice: 120000 }), H('SSI', 30000, { stopLoss: 28000 })]);
    t.setDay(D1);
    let at = sec(D1, 10, 0), day = D1, px = { FPT: 121000, SSI: 27500 };
    fakeRefresh(t.LQ, () => ({ ts: at, quotes: { FPT: q(px.FPT, 100000, day, at), SSI: q(px.SSI, 30000, day, at) } }));
    await cycle(t);
    const h1 = t.AR.state.hist;
    expect(h1.map((x) => x.kind + ':' + x.s).sort()).toEqual(['move_down:SSI', 'move_up:FPT', 'stop:SSI', 'target:FPT']);
    expect(h1.find((x) => x.kind === 'target')).toMatchObject({ date: D1, price: 121000, thr: 120000, d1: null });
    expect(JSON.parse(t.store.get('wh.fin.alerthist.v1'))).toHaveLength(4);

    t.setDay(D2); at = sec(D2, 14, 40); day = D2; px = { FPT: 125000, SSI: 26000 };
    await cycle(t);
    const tg = t.AR.state.hist.find((x) => x.kind === 'target'), st = t.AR.state.hist.find((x) => x.kind === 'stop');
    expect(tg).toMatchObject({ d1: 125000, d1Date: D2, last: 125000 });
    expect(st).toMatchObject({ d1: 26000, d1Date: D2 });

    t.AR.render();
    const html = t.els['alert-review'].innerHTML;
    expect(html).toContain('Ôn lại cảnh báo'); expect(html).toContain('Chạm giá mục tiêu'); expect(html).toContain('Chạm ngưỡng cắt lỗ');
    expect(html).toContain('+3,3%');                     // FPT: 121.000 -> 125.000 theo chiều lên
    expect(html).toContain('+5,5%');                     // SSI: 27.500 -> 26.000, giảm tiếp theo chiều cắt lỗ
    expect(html).toContain('Ghi quyết định'); expect(html).toContain('cần từ 10');
  });

  it('Ghi quyết định từ dải cảnh báo và từ bảng ôn lại mở hộp thoại nhật ký với bối cảnh điền sẵn', async () => {
    const t = boot();
    t.UI.afterHoldings([H('FPT', 100000, { targetPrice: 120000 })]);
    t.setDay(D1);
    const at = sec(D1, 10, 0);
    fakeRefresh(t.LQ, () => ({ ts: at, quotes: { FPT: q(121000, 100000, D1, at) } }));
    await cycle(t);
    expect(t.els['live-alerts'].innerHTML).toContain('LiveUI.decide(');
    const i = t.UI.state.alertLog.findIndex((a) => a.kind === 'target');
    t.UI.decide(i);
    expect(t.opened).toHaveLength(1);
    expect(t.opened[0].prefill).toMatchObject({ action: 'sell', symbol: 'FPT', price: 121000, date: D1 });
    expect(t.opened[0].prefill.reason).toContain('mục tiêu 120.000'); expect(t.opened[0].prefill.tags).toContain('cảnh báo giá');
    t.AR.decide(t.AR.state.hist.find((x) => x.kind === 'target').id);
    expect(t.opened).toHaveLength(2); expect(t.opened[1].prefill.symbol).toBe('FPT');
    t.AR.decide('khong-co'); expect(t.opened).toHaveLength(2);
  });

  it('cảnh báo cấp danh mục (NAV, giới hạn) không vào kho ôn lại; kho đọc lại khi khởi động; xuất CSV; kho trống có hướng dẫn', async () => {
    const empty = boot(); empty.AR.render(); expect(empty.els['alert-review'].innerHTML).toContain('Chưa có cảnh báo nào');
    const hist = [{ id: '2026-10-06|VNM|stop|50000', date: '2026-10-06', time: '10:00:00', s: 'VNM', kind: 'stop', thr: 50000, price: 49000, pct: null, d1: 47000, d1Date: '2026-10-07', last: 47000, lastDate: '2026-10-07' }];
    const t = boot({ 'wh.fin.alerthist.v1': JSON.stringify(hist) });
    expect(t.AR.state.hist).toHaveLength(1);
    t.AR.record({ symbol: 'Danh mục', kind: 'nav_down', price: 0, pct: -3 });
    expect(t.AR.state.hist).toHaveLength(1);
    await t.AR.exportCsv();
    expect(t.saved).toHaveLength(1); expect(t.saved[0][0]).toMatch(/^OnLaiCanhBao-\d{8}\.csv$/); expect(t.saved[0][1]).toContain('Giá phiên sau'); expect(t.saved[0][1]).toContain('VNM');
    const bad = boot({ 'wh.fin.alerthist.v1': '{hỏng' }); expect(bad.AR.state.hist).toEqual([]);
  });
});
