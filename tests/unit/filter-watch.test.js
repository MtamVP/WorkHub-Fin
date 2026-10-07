import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import FW from '../../lib/filter-watch.js';
import MS from '../../lib/market-screener.js';
import MH from '../../lib/market-history.js';

// ---- dữ liệu giả: 700 mã, mã cần theo dõi có ROE và tăng trưởng đổi giữa hai ngày ----
const STATS = { '2700': { n: 700, as_of: '2026-10-06', stats: { pe: { n: 40, median: 14, q: [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30] } } } };
const base = (i, o) => ({ symbol: 'S' + String(i).padStart(4, '0'), icb2_code: '2700', daily_date: '2026-10-06', quarter_date: '2026-06-30', metrics: Object.assign({ marketcap: 3000e9, advValue20: 20e9, pe: 12, pb: 1.5, roae: 0.10, netProfitGrowthYoY: 0.05, chgYtd: 0.02, shares: 50e6, beta: 1 }, o || {}) });
function day(over, withNew) { return Array.from({ length: 700 }, (_, i) => { const o = over[i] || {}; const r = base(i, o); if (withNew === false) { delete r.metrics.chgYtd; delete r.metrics.netProfitGrowthYoY; } return r; }); }
const rows = (snap) => MS.buildRows(snap, STATS, {});
const SAVED = [{ name: 'ROE cao', filters: { values: { roe: 15 } } }, { name: 'Tăng trưởng', filters: { values: { netG: 20 } } }, { name: 'Trống', filters: { values: {} } }];

describe('FilterWatch.compare', () => {
  const prev = rows(day({ 1: { roae: 0.20 }, 2: { roae: 0.18 }, 3: { roae: 0.16 } }));
  const curr = rows(day({ 2: { roae: 0.19 }, 3: { roae: 0.10 }, 4: { roae: 0.25 }, 5: { roae: 0.30 } }));
  it('mã mới lọt vào, mã rớt ra kèm lý do, mã giữ nguyên; điểm và số lượng đúng', () => {
    const r = FW.compare(SAVED.slice(0, 1), prev, curr)[0];
    expect(r.comparable).toBe(true); expect(r.nowCount).toBe(3); expect(r.beforeCount).toBe(3); expect(r.stayed).toBe(1);
    expect(r.entered.map((x) => x.symbol).sort()).toEqual(['S0004', 'S0005']);
    expect(r.left.map((x) => x.symbol).sort()).toEqual(['S0001', 'S0003']);
    expect(r.left.find((x) => x.symbol === 'S0003').reason).toContain('ROE tối thiểu');
  });
  it('mã không còn trong ảnh chụp mới được ghi là không còn niêm yết/ảnh chụp', () => {
    const cur2 = curr.filter((r) => r.symbol !== 'S0001');
    expect(FW.compare(SAVED.slice(0, 1), prev, cur2)[0].left.find((x) => x.symbol === 'S0001').reason).toBe('không còn trong ảnh chụp thị trường');
  });
  it('bị cắt bởi giới hạn số mã thì nói đúng lý do, không nói thiếu số liệu', () => {
    const cap = [{ name: 'Top 1', filters: { values: { roe: 15 }, topN: 1 } }];
    const a = rows(day({ 1: { roae: 0.30 }, 2: { roae: 0.20 } })), b = rows(day({ 1: { roae: 0.20 }, 2: { roae: 0.30 } }));
    const r = FW.compare(cap, a, b)[0];
    expect(r.entered.map((x) => x.symbol)).toEqual(['S0002']); expect(r.left.map((x) => x.symbol)).toEqual(['S0001']); expect(r.left[0].reason).toMatch(/giới hạn số mã/);
  });
  it('ngày cũ chưa có số liệu của tiêu chí (ảnh chụp trước khi có trường mới): không so sánh, nói rõ thay vì báo mọi mã là mới', () => {
    const oldDay = rows(day({}, false)), newDay = rows(day({ 7: { netProfitGrowthYoY: 0.5 } }));
    const r = FW.compare(SAVED.slice(1, 2), oldDay, newDay)[0];
    expect(r.comparable).toBe(false); expect(r.why).toContain('Tăng trưởng lợi nhuận ròng 12 tháng'); expect(r.entered).toBeUndefined();
    expect(FW.compare(SAVED.slice(0, 1), oldDay, newDay)[0].comparable).toBe(true);        // ROE có ở cả hai ngày
    const none = FW.compare([{ name: 'Giá từ 1/1', filters: { values: { ytd: 5 } } }], rows(day({}, false)), rows(day({}, false)))[0];
    expect(none.comparable).toBe(false); expect(none.why).toContain('Biến động giá từ 1/1');          // cả hai ngày đều chưa có: không được báo "không đổi"
  });
  it('bộ lọc trống không so sánh được', () => { expect(FW.compare([SAVED[2]], prev, curr)[0]).toMatchObject({ comparable: false, why: 'Bộ lọc trống.' }); });
  it('summaryLine và totals', () => {
    const items = FW.compare(SAVED.slice(0, 1), prev, curr);
    expect(FW.summaryLine(items[0], 1)).toBe('ROE cao: +S0004 (+1 mã khác); −S0001 (+1 mã khác)');
    expect(FW.totals(items)).toEqual({ entered: 2, left: 2 });
    expect(FW.summaryLine({ comparable: true, name: 'X', entered: [], left: [] })).toBe(''); expect(FW.summaryLine({ comparable: false, name: 'X' })).toBe('');
  });
});

// ---- filter-watch.js thật trong vm: đọc tệp .gz thật, so hai ngày, cất kết quả, thông báo một lần ----
const REPO = process.cwd().replace(/\\/g, '/');
const gz = (snap, asOf) => zlib.gzipSync(Buffer.from(JSON.stringify(MH.pack(snap, STATS, { asOf, savedAt: asOf + 'T11:00:00Z' }))));
function boot(files, saved) {
  const store = new Map(); if (saved) store.set('wh.fin.marketscreener.saved.v1', JSON.stringify(saved));
  const notes = [], reads = [];
  const fsApi = { BaseDirectory: { AppLocalData: 1 }, exists: async () => true, readDir: async () => Object.keys(files).map((name) => ({ name })), readFile: async (p) => { reads.push(p); const n = p.split('/').pop(); if (!files[n]) throw new Error('no file ' + n); return new Uint8Array(files[n]); } };
  const win = { __TAURI__: { fs: fsApi, notification: { sendNotification: (n) => notes.push(n) } } };
  const ctx = vm.createContext({ window: win, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }, Blob, Response, DecompressionStream, Promise, JSON, Date, Math, console, Uint8Array });
  ['lib/market-history.js', 'lib/peer-valuation.js', 'lib/market-screener.js', 'lib/filter-watch.js', 'filter-watch.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  return { api: win.WorkHubFilterWatch, notes, store, reads };
}
const D1 = '2026-10-06', D2 = '2026-10-07';
const snapPrev = day({ 1: { roae: 0.20 }, 2: { roae: 0.18 } }), snapCurr = day({ 2: { roae: 0.19 }, 4: { roae: 0.25 } });

describe('WorkHubFilterWatch (trang gốc / Valuation Bench)', () => {
  it('compute: không phải desktop; chưa có bộ lọc; chưa đủ 2 ngày', async () => {
    const t = boot({}, SAVED); delete t.api; // placeholder
    const web = vm.createContext({ window: {}, localStorage: { getItem: () => null }, document: {} });
    ['lib/market-history.js', 'lib/peer-valuation.js', 'lib/market-screener.js', 'lib/filter-watch.js', 'filter-watch.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), web, { filename: f }));
    expect((await web.window.WorkHubFilterWatch.compute()).state).toBe('web');
    expect((await boot({ ['snapshot-' + D1 + '.json.gz']: gz(snapPrev, D1) }, []).api.compute()).state).toBe('nosaved');
    expect((await boot({}, SAVED).api.compute()).state).toBe('nodata');
    const one = await boot({ ['snapshot-' + D1 + '.json.gz']: gz(snapPrev, D1) }, SAVED).api.compute();
    expect(one.state).toBe('nodata'); expect(one.message).toContain('một ngày');
  });
  it('compute đọc hai tệp gzip gần nhất và so sánh; dùng dữ liệu đang có trên màn hình làm ngày mới nếu truyền vào', async () => {
    const files = { ['snapshot-' + D1 + '.json.gz']: gz(snapPrev, D1), ['snapshot-2026-10-05.json.gz']: gz(day({}), '2026-10-05'), ['snapshot-' + D2 + '.json.gz']: gz(snapCurr, D2) };
    const t = boot(files, SAVED.slice(0, 1));
    const r = await t.api.compute();
    expect(r).toMatchObject({ state: 'ok', asOf: D2, prevAsOf: D1 });
    expect(r.items[0].entered.map((x) => x.symbol)).toEqual(['S0004']); expect(r.items[0].left.map((x) => x.symbol)).toEqual(['S0001']);
    expect(t.reads.map((p) => p.split('/').pop())).toEqual(['snapshot-2026-10-07.json.gz', 'snapshot-2026-10-06.json.gz']);   // chỉ đọc 2 tệp cần thiết
    // ngày mới hơn đang hiện trên màn hình (chưa lưu): so với tệp mới nhất trong máy
    const live = await t.api.compute({ currentRows: rows(day({ 2: { roae: 0.19 }, 9: { roae: 0.4 } })), currentAsOf: '2026-10-08' });
    expect(live).toMatchObject({ asOf: '2026-10-08', prevAsOf: D2 }); expect(live.items[0].entered.map((x) => x.symbol)).toEqual(['S0009']);
  });
  it('afterArchive: cất kết quả gọn và gửi đúng MỘT thông báo cho mỗi ngày dữ liệu; không báo khi không có mã mới', async () => {
    const files = { ['snapshot-' + D1 + '.json.gz']: gz(snapPrev, D1), ['snapshot-' + D2 + '.json.gz']: gz(snapCurr, D2) };
    const t = boot(files, SAVED.slice(0, 1));
    const pack = MH.pack(snapCurr, STATS, { asOf: D2 });
    await t.api.afterArchive(pack);
    expect(t.notes).toHaveLength(1); expect(t.notes[0].title).toBe('Bộ lọc đã lưu có mã mới lọt vào'); expect(t.notes[0].body).toBe('ROE cao: +S0004; −S0001');
    const rec = t.api.lastResult(); expect(rec).toMatchObject({ asOf: D2, prevAsOf: D1, notified: true }); expect(rec.items[0]).toEqual({ name: 'ROE cao', comparable: true, entered: ['S0004'], left: ['S0001'] });
    await t.api.afterArchive(pack); expect(t.notes).toHaveLength(1);                                      // chạy lại cùng ngày: không báo lại
    const quiet = boot(files, SAVED.slice(0, 1)); await quiet.api.afterArchive(MH.pack(snapPrev, STATS, { asOf: D2 }));
    expect(quiet.notes).toHaveLength(0);                                                                   // hai ngày giống nhau: không có mã mới
  });
  it('afterArchive không ném lỗi khi thiếu tệp hoặc không có bộ lọc đã lưu', async () => {
    const pack = MH.pack(snapCurr, STATS, { asOf: D2 });
    expect(await boot({}, SAVED).api.afterArchive(pack)).toMatchObject({ state: 'nodata' });
    expect(await boot({}, []).api.afterArchive(pack)).toBeNull(); expect(await boot({}, SAVED).api.afterArchive(null)).toBeNull();
  });
});
