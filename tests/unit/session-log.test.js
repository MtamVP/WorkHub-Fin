import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import SL from '../../lib/session-log.js';
import TB from '../../lib/today-brief.js';

const H = (symbol, dayPct, dayPnl, extra) => Object.assign({ symbol, live: true, dayPct, dayPnl, marketValue: 1e7 }, extra || {});
const BASE = (o) => Object.assign({
  date: '2026-10-07', mode: 'final', savedAt: '2026-10-07T08:00:00Z',
  holdings: [H('FPT', 2.5, 250000), H('HPG', -1.2, -60000), H('VNM', 0.4, 20000), H('SSI', -3.1, -310000), H('MWG', 1.1, 80000), H('VCB', 0, 0), H('XXX', 9, 9, { live: false })],
  totals: { dayPnl: -20000, dayPct: -0.18, liveCount: 6, total: 7 }, nav: 120e6, index: { value: 1746.77, pct: -0.7 },
  alerts: [{ time: '10:30:00', title: 'SSI giảm mạnh trong ngày', level: 'bad' }], series: [[570, 1e5, 0.1, 1], [600, -2e5, -0.2, 1], [690, -2e4, -0.02, 1]], source: 'vci',
}, o || {});

describe('SessionLog.mode', () => {
  it('chỉ ghi khi có giá của hôm nay: đang phiên là bản tạm, đóng cửa là bản cuối', () => {
    expect(SL.mode('open', true)).toBe('partial'); expect(SL.mode('break', true)).toBe('partial'); expect(SL.mode('closed', true)).toBe('final');
    expect(SL.mode('closed', false)).toBeNull(); expect(SL.mode('open', false)).toBeNull(); expect(SL.mode('pre', true)).toBeNull(); expect(SL.mode('holiday', true)).toBeNull();
  });
});

describe('SessionLog.build', () => {
  it('tóm tắt phiên: lãi/lỗ, % ngày, % NAV, so với chỉ số, mã mạnh/yếu, đóng góp, số mã tăng/giảm, đường lãi/lỗ', () => {
    const r = SL.build(BASE());
    expect(r).toMatchObject({ v: 1, date: '2026-10-07', final: true, dayPnl: -20000, dayPct: -0.18, nav: 120000000, indexValue: 1746.77, indexPct: -0.7, rel: 0.52, n: 7, liveCount: 6, up: 3, down: 2, src: 'vci' });
    expect(r.navPct).toBeCloseTo(-20000 / (120e6 + 20000) * 100, 1);
    expect(r.best).toEqual([{ s: 'FPT', pct: 2.5 }, { s: 'MWG', pct: 1.1 }, { s: 'VNM', pct: 0.4 }]);
    expect(r.worst).toEqual([{ s: 'SSI', pct: -3.1 }, { s: 'HPG', pct: -1.2 }, { s: 'VCB', pct: 0 }]);
    expect(r.gain.map((x) => x.s)).toEqual(['FPT', 'MWG', 'VNM']); expect(r.loss).toEqual([{ s: 'SSI', pnl: -310000 }, { s: 'HPG', pnl: -60000 }]);
    expect(r.alerts).toEqual([{ t: '10:30:00', title: 'SSI giảm mạnh trong ngày', level: 'bad' }]); expect(r.series).toEqual({ n: 3, hi: 1e5, lo: -2e5, last: -2e4 });
  });
  it('mã không có giá trực tiếp bị bỏ khỏi xếp hạng; thiếu chỉ số thì không có so sánh; không có giá hôm nay thì không ghi', () => {
    const r = SL.build(BASE({ index: null, series: [], nav: null }));
    expect(r.rel).toBeNull(); expect(r.indexPct).toBeNull(); expect(r.navPct).toBeNull(); expect(r.series).toBeNull(); expect(JSON.stringify(r)).not.toContain('XXX');
    expect(SL.build(BASE({ totals: { dayPnl: null, dayPct: null, liveCount: 0, total: 7 } }))).toBeNull(); expect(SL.build(null)).toBeNull();
    expect(SL.build(BASE({ mode: 'partial' })).final).toBe(false);
  });
});

describe('SessionLog.merge', () => {
  const rec = (date, o) => Object.assign(SL.build(BASE({ date })), o || {});
  it('bản cuối phiên thay bản tạm; bản tạm không ghi đè bản cuối; bản cuối mới thay bản cuối cũ', () => {
    let s = SL.merge({}, SL.build(BASE({ mode: 'partial' }))); expect(s['2026-10-07'].final).toBe(false);
    s = SL.merge(s, SL.build(BASE({ mode: 'final', totals: { dayPnl: -50000, dayPct: -0.4, liveCount: 6, total: 7 } }))); expect(s['2026-10-07']).toMatchObject({ final: true, dayPnl: -50000 });
    s = SL.merge(s, SL.build(BASE({ mode: 'partial', totals: { dayPnl: 1, dayPct: 0, liveCount: 6, total: 7 } }))); expect(s['2026-10-07'].dayPnl).toBe(-50000);
    s = SL.merge(s, SL.build(BASE({ mode: 'final', totals: { dayPnl: -60000, dayPct: -0.5, liveCount: 6, total: 7 } }))); expect(s['2026-10-07'].dayPnl).toBe(-60000);
    expect(SL.merge(s, null)).toEqual(s); expect(s).not.toBe(SL.merge(s, rec('2026-10-08')));
  });
  it('giữ tối đa KEEP phiên mới nhất', () => {
    let s = {}; const base = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < SL.KEEP + 5; i++) s = SL.merge(s, rec(new Date(base + i * 86400000).toISOString().slice(0, 10)));
    expect(Object.keys(s)).toHaveLength(SL.KEEP); expect(Object.keys(s).sort()[0]).toBe(new Date(base + 5 * 86400000).toISOString().slice(0, 10));
  });
});

describe('SessionLog.stats / lastBefore / csvRows', () => {
  const mk = (date, dayPct, indexPct, final) => SL.build(BASE({ date, mode: final === false ? 'partial' : 'final', totals: { dayPnl: dayPct * 1e5, dayPct, liveCount: 6, total: 7 }, index: indexPct === null ? null : { value: 1700, pct: indexPct } }));
  const store = [mk('2026-10-01', 1, 0.5), mk('2026-10-02', -2, -1), mk('2026-10-05', 3, 1), mk('2026-10-06', 0.5, 0.9, false), mk('2026-10-07', -1, null)].reduce((s, r) => SL.merge(s, r), {});
  it('thống kê chỉ tính bản cuối phiên: số phiên, phiên hơn chỉ số, trung bình, tốt/xấu nhất, cộng dồn và sụt giảm', () => {
    const st = SL.stats(store);
    expect(st).toMatchObject({ n: 4, from: '2026-10-01', to: '2026-10-07', winDays: 2, nIdx: 3, beat: 2, best: { date: '2026-10-05', pct: 3 }, worst: { date: '2026-10-02', pct: -2 } });
    expect(st.avgRel).toBeCloseTo(((1 - 0.5) + (-2 + 1) + (3 - 1)) / 3, 1);
    expect(st.cumPct).toBeCloseTo((1.01 * 0.98 * 1.03 * 0.99 - 1) * 100, 1); expect(st.cumIndexPct).toBeNull();            // có phiên thiếu chỉ số: không báo chỉ số cộng dồn
    expect(st.maxDrawdownPct).toBeLessThan(0); expect(SL.stats({})).toEqual({ n: 0 });
  });
  it('lastBefore lấy phiên gần nhất trước hôm nay; csvRows có tiêu đề và mới nhất trước', () => {
    expect(SL.lastBefore(store, '2026-10-07').date).toBe('2026-10-06'); expect(SL.lastBefore(store, '2026-10-01')).toBeNull(); expect(SL.lastBefore({}, '2026-10-07')).toBeNull();
    const rows = SL.csvRows(store); expect(rows[0]).toEqual(SL.HEADER); expect(rows[1][0]).toBe('2026-10-07'); expect(rows[2][1]).toBe('tạm'); expect(rows).toHaveLength(6);
  });
});

describe('thẻ "Hôm nay": phiên gần nhất', () => {
  it('nêu lãi/lỗ phiên trước, so với chỉ số, mã mạnh/yếu; bản tạm có ghi chú; bỏ nếu là hôm nay hoặc không có', () => {
    const r = SL.build(BASE({ date: '2026-10-06' }));
    const s = TB.session({ lastSession: r }, '2026-10-07');
    expect(s.items[0].text).toBe('Phiên 06/10: danh mục cổ phiếu −0,18% (−20.000 đ), VN-Index −0,70%, hơn chỉ số 0,52 điểm %'); expect(s.items[0].tone).toBe('down');
    expect(s.items[1].text).toBe('Mạnh nhất: FPT +2,5%; yếu nhất: SSI −3,1%');
    expect(TB.session({ lastSession: SL.build(BASE({ date: '2026-10-06', mode: 'partial' })) }, '2026-10-07').items[0].text).toContain('(bản tạm giữa phiên)');
    expect(TB.session({ lastSession: r }, '2026-10-06')).toBeNull(); expect(TB.session({}, '2026-10-07')).toBeNull();
    expect(TB.build({ lastSession: r, nav: [], kpi: { nav: 1e8, unrealizedPnl: 0 } }, '2026-10-07').sections.map((x) => x.id)).toEqual(['portfolio', 'session']);
  });
});

// ---- session-ui.js thật trong vm: ghi, thay bản tạm, chống ghi dồn, lưu bộ nhớ, bản sao tệp, vẽ bảng, xuất CSV ----
const REPO = process.cwd().replace(/\\/g, '/');
function boot(stored, tauri) {
  const store = new Map(); if (stored) store.set('wh.fin.sessionlog.v1', JSON.stringify(stored));
  const els = { 'session-log': { innerHTML: '' } }, files = {}, saved = [], dirs = [];
  const fsApi = { BaseDirectory: { AppLocalData: 1 }, exists: async (p) => dirs.includes(p), mkdir: async (p) => { dirs.push(p); }, writeTextFile: async (p, t) => { files[p] = t; } };
  const ctx = vm.createContext({ document: { getElementById: (id) => els[id] || null }, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    window: tauri ? { __TAURI__: { fs: fsApi, path: { appLocalDataDir: async () => 'C:\\Users\\x\\AppData\\Local\\app\\' } } } : {}, Promise, Date, JSON, Math, console, TextEncoder,
    escapeAssetHtml: (s) => String(s).replace(/</g, '&lt;'), saveBytesToDisk: async (n, b) => { saved.push([n, Buffer.from(b).toString('utf8')]); return n; }, showToast() {} });
  ['lib/finance-calc.js', 'lib/session-log.js', 'mastersheet/assets/session-ui.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  return { UI: vm.runInContext('SessionUI', ctx), store, els, files, saved, dirs };
}
const CTX = (o) => ({ session: 'closed', hasToday: true, date: '2026-10-07', holdings: BASE().holdings, totals: BASE().totals, nav: 120e6, index: { value: 1746.77, pct: -0.7 }, alerts: BASE().alerts, series: BASE().series, source: 'vci', ...(o || {}) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('SessionUI (session-ui.js)', () => {
  it('sau đóng cửa ghi bản cuối phiên, lưu bộ nhớ trình duyệt và bản sao tệp trong thư mục dữ liệu; vẽ bảng với số liệu', async () => {
    const t = boot(null, true);
    t.UI.record(CTX()); await wait(30);
    const saved = JSON.parse(t.store.get('wh.fin.sessionlog.v1'));
    expect(saved['2026-10-07']).toMatchObject({ final: true, dayPnl: -20000, rel: 0.52 });
    expect(t.dirs).toEqual(['session-log']); expect(JSON.parse(t.files['session-log/session-log.json']).sessions['2026-10-07'].final).toBe(true);
    const html = t.els['session-log'].innerHTML;
    expect(html).toContain('Nhật ký phiên'); expect(html).toContain('07/10/2026'); expect(html).toContain('FPT +2,5%'); expect(html).toContain('session-log.json'); expect(html).toContain('lưu trong máy này');
  });
  it('trong phiên ghi bản tạm và chỉ ghi lại sau 5 phút; sau đóng cửa bản cuối thay bản tạm; chạy lại không đổi thì không ghi dồn', async () => {
    const t = boot(null, false);
    t.UI.record(CTX({ session: 'open' })); expect(t.UI.state.store['2026-10-07'].final).toBe(false);
    const w1 = t.UI.state.lastWrite; t.UI.record(CTX({ session: 'open', totals: Object.assign({}, BASE().totals, { dayPnl: -99 }) })); expect(t.UI.state.store['2026-10-07'].dayPnl).toBe(-20000);   // trong 5 phút: bỏ qua
    t.UI.record(CTX()); expect(t.UI.state.store['2026-10-07'].final).toBe(true);
    const w2 = t.UI.state.lastWrite; t.UI.record(CTX()); expect(t.UI.state.lastWrite).toBe(w2); expect(w2).toBeGreaterThanOrEqual(w1);
    t.UI.record(CTX({ alerts: BASE().alerts.concat([{ time: '14:40:00', title: 'x', level: 'good' }]) })); expect(t.UI.state.store['2026-10-07'].alerts).toHaveLength(2);    // có cảnh báo mới: ghi lại
  });
  it('không có giá hôm nay hoặc ngoài giờ thì không ghi gì; đọc lại kho đã lưu khi khởi động; xuất CSV', async () => {
    const t = boot(null, false);
    t.UI.record(CTX({ hasToday: false })); t.UI.record(CTX({ session: 'pre' })); t.UI.record(CTX({ session: 'holiday' })); expect(Object.keys(t.UI.state.store)).toEqual([]);
    const old = SL.merge({}, SL.build(BASE({ date: '2026-10-06' })));
    const t2 = boot(old, false); expect(Object.keys(t2.UI.state.store)).toEqual(['2026-10-06']); t2.UI.render(); expect(t2.els['session-log'].innerHTML).toContain('06/10/2026');
    await t2.UI.exportCsv(); expect(t2.saved).toHaveLength(1); expect(t2.saved[0][0]).toMatch(/^NhatKyPhien-\d{8}\.csv$/); expect(t2.saved[0][1]).toContain('Lãi/lỗ ngày (đ)'); expect(t2.saved[0][1]).toContain('2026-10-06');
    const empty = boot(null, false); empty.UI.render(); expect(empty.els['session-log'].innerHTML).toContain('Chưa có phiên nào');
  });
  it('bản web (không Tauri) vẫn ghi bộ nhớ trình duyệt và không lỗi khi ghi tệp', async () => {
    const t = boot(null, false); t.UI.record(CTX()); await wait(20); expect(t.UI.state.store['2026-10-07']).toBeTruthy(); expect(t.UI.state.mirror).toBe('');
  });
});
