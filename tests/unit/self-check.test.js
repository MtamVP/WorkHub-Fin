import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import SC from '../../lib/self-check.js';

describe('lib/self-check: bộ chạy', () => {
  it('chạy lần lượt, ném lỗi thành "lỗi" kèm lý do, giới hạn thời gian, báo tiến độ', async () => {
    const seen = [];
    const defs = [
      { id: 'a', label: 'A', run: async () => ({ status: 'ok', detail: 'tốt' }) },
      { id: 'b', label: 'B', run: async () => { throw new Error('mất   kết nối\nlần 2'); } },
      { id: 'c', label: 'C', timeoutMs: 20, run: () => new Promise(() => {}) },
      { id: 'd', label: 'D', run: async () => ({ status: 'skip', detail: 'bản web' }) },
      { id: 'e', label: 'E', run: async () => ({ status: 'lạ', detail: 'x' }) },
    ];
    const out = await SC.runAll(defs, {}, { onProgress: (p) => seen.push(p.status + ':' + p.id) });
    expect(out.map((r) => r.status)).toEqual(['ok', 'fail', 'fail', 'skip', 'ok']);
    expect(out[1].detail).toBe('mất kết nối lần 2'); expect(out[2].detail).toMatch(/Quá 0 giây|Quá \d+ giây/);
    expect(seen.slice(0, 4)).toEqual(['running:a', 'ok:a', 'running:b', 'fail:b']);
  });
  it('summarize: lỗi > chú ý > đạt; báo cáo xếp lỗi lên đầu và không chứa chuỗi nhạy cảm', () => {
    const rs = [{ id: 'a', label: 'A', status: 'ok', detail: 'tốt', ms: 5 }, { id: 'b', label: 'B', status: 'warn', detail: 'chậm', ms: 9 }, { id: 'c', label: 'C', status: 'fail', detail: 'hỏng', ms: 1 }, { id: 'd', label: 'D', status: 'skip', detail: '', ms: 0 }];
    const s = SC.summarize(rs);
    expect(s).toMatchObject({ verdict: 'fail', ok: 1, warn: 1, fail: 1, skip: 1, total: 4 });
    expect(SC.summarize(rs.slice(0, 2)).verdict).toBe('warn'); expect(SC.summarize(rs.slice(0, 1)).verdict).toBe('ok'); expect(SC.summarize([]).verdict).toBe('ok');
    const txt = SC.toText(rs, { version: '0.1.12', when: '07/10/2026', platform: 'Desktop' });
    expect(txt.split('\n')[0]).toBe('WorkHub Fin: kiểm tra hệ thống (phiên bản 0.1.12) lúc 07/10/2026 · Desktop');
    expect(txt.split('\n').filter((l) => l.startsWith('['))[0]).toContain('[LỖI] C');
  });
  it('daysBetween', () => { expect(SC.daysBetween('2026-10-01', '2026-10-07')).toBe(6); });
});

// ---------- self-check.js thật trong vm với môi trường giả ----------
const B = 1e9;
const R = (code, date, v, model) => ({ itemCode: code, fiscalDate: date, numericValue: v * B, modelType: model });
function company(date, k) {
  const s = Math.pow(1.12, k), y = 2021 + k;
  const m = (c, v, mt) => R(c, date, v * s, mt);
  return [m(21001, 1000, 2), m(22100, 600, 2), m(23100, 400, 2), m(22110, 80, 2), m(22200, 60, 2), m(21500, 20, 2), m(22510, 15, 2), m(23800, 270, 2), m(22070, 54, 2), m(23000, 200, 2), m(23500, 16, 2), m(23003, 216, 2),
    m(11100, 150, 1), m(11200, 100, 1), m(11300, 120, 1), m(11400, 90, 1), m(11000, 520, 1), m(12200, 500, 1), m(12700, 1300, 1), m(13000, 450, 1), m(13100, 300, 1), m(13110, 120, 1), m(13340, 60, 1), m(14000, 850, 1), m(14240, 40, 1), m(14110, 100, 1), m(14200, 300, 1),
    m(32000, 230, 3), m(32100, -90, 3), m(22230, 50, 3), m(33600, -60, 3)].map((r) => Object.assign(r, { fy: y }));
}
const ANNUAL = [0, 1, 2, 3, 4].reduce((acc, k) => acc.concat(company((2021 + k) + '-12-31', k)), []);
function candles(n) {
  const t = [], o = [], h = [], l = [], c = [], v = []; let px = 40000;
  for (let i = 0; i < n; i++) { const close = 40000 + 15 * i + Math.sin(i / 7) * 2000; o.push(px); px = close; c.push(close); h.push(Math.max(o[i], close) + 300); l.push(Math.min(o[i], close) - 300); v.push(500000 + (i % 9) * 40000); t.push(new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10)); }
  return { t, o, h, l, c, v };
}
const VB = () => ({ form: undefined, annualRows: ANNUAL.map((r) => Object.assign({}, r)), quarterRows: [], candles: candles(400), indexCandles: Object.assign(candles(400), { c: candles(400).c.map((x, i) => 1000 + i * 0.5) }), ratioSeries: { pe: Array.from({ length: 300 }, (_, i) => 12 + (i % 30) * 0.2) } });
const Q = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30];
const STATS = { '2700': { n: 40, as_of: '2026-10-06', stats: { pe: { n: 40, median: 14, q: Q }, pb: { n: 40, median: 1.8, q: [0.5, 0.8, 1, 1.2, 1.5, 1.8, 2.1, 2.5, 3, 4, 6] }, ps: { n: 40, median: 1.5, q: [0.3, 0.5, 0.7, 0.9, 1.2, 1.5, 1.9, 2.4, 3, 4, 6] } } } };
const snapRows = (n, withNew) => Array.from({ length: n }, (_, i) => ({ symbol: i === 0 ? 'FPT' : 'S' + String(i).padStart(4, '0'), icb2_code: '2700', metrics: Object.assign({ marketcap: 3000e9, advValue20: 20e9, pe: 8, pb: 1.2, roae: 0.18, shares: 50e6, beta: 1 }, withNew ? { chgYtd: 0.1, netProfitGrowthYoY: 0.2 } : {}) }));
const todayVn = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const REPO = process.cwd().replace(/\\/g, '/');

function boot(o = {}) {
  const opt = Object.assign({ session: true, tauri: true, fsFail: null, liveFn: 'ok', vnd: 'ok', snapN: 1500, snapNew: true, asOf: todayVn(), history: { count: 3, first: '2026-10-02', last: todayVn(), gaps: 0 }, notifGranted: true }, o);
  const files = new Map(), events = [];
  const fsApi = { BaseDirectory: { AppLocalData: 1 }, exists: async () => true, mkdir: async () => {},
    writeFile: async (p, b) => { if (opt.fsFail) throw new Error(opt.fsFail); files.set(p, Buffer.from(b).toString('utf8')); events.push('write'); },
    readTextFile: async (p) => files.get(p), remove: async (p) => { files.delete(p); events.push('remove'); } };
  const win = { __TAURI__: opt.tauri ? { fs: fsApi, app: { getVersion: async () => '0.1.12' }, notification: { isPermissionGranted: async () => opt.notifGranted, requestPermission: async () => 'granted', sendNotification: (n) => events.push('notify:' + n.title) } } : undefined,
    supabaseClient: { auth: { getSession: async () => ({ data: { session: opt.session ? { expires_at: Math.floor(Date.now() / 1000) + 1800 } : null } }) } },
    WorkHubMarketHistory: { refreshStatus: async () => ({ summary: opt.history, error: null }) } };
  const U = { snapshot: snapRows(opt.snapN, opt.snapNew), stats: STATS, meta: { FPT: { name: 'FPT', exchange: 'HOSE' } }, asOf: opt.asOf };
  const API = { asset: { market: {
    liveQuotes: async (s) => { if (opt.liveFn === 'fail') throw new Error('Edge Function returned a non-2xx status code'); await new Promise((r) => setTimeout(r, 5)); return { ok: true, quotes: { FPT: { price: 60300 }, VNM: { price: 58200 } }, missing: [], asOf: new Date().toISOString() }; },
    marketUniverse: async () => U, valuationHistory: async () => ({ rows: [], bond10y: 4 }) },
    vb: { data: async () => ({ symbol: 'FPT', vb: VB() }) } } };
  const fetchFake = async () => (opt.vnd === 'ok' ? { ok: true, json: async () => ({ data: [{ code: 'FPT', date: todayVn(), time: '10:19:59', close: 60.3 }] }) } : { ok: false, status: 503, json: async () => ({}) });
  const store = new Map();
  const head = { appendChild: (s) => { const rel = s.src.split('?')[0]; setTimeout(() => { try { vm.runInContext(fs.readFileSync(REPO + '/' + rel, 'utf8'), ctx, { filename: rel }); s.onload(); } catch (e) { s.onerror(e); } }, 0); } };
  const ctx = vm.createContext({ window: win, API, fetch: fetchFake, AbortController, TextEncoder, setTimeout, clearTimeout, Promise, Date, JSON, Math, console, process,
    document: { createElement: () => ({}), head }, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    Notification: undefined });
  ['lib/self-check.js', 'lib/vn-holidays.js', 'lib/live-quotes.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  vm.runInContext(fs.readFileSync(REPO + '/self-check.js', 'utf8'), ctx, { filename: 'self-check.js' });
  return { api: win.WorkHubSelfCheck, win, events, files };
}
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));

describe('self-check.js: môi trường khoẻ', () => {
  it('mọi phép kiểm đạt, kể cả đường định giá hàng loạt bằng bộ máy thật; tệp thử được xoá; báo cáo không có email/token', async () => {
    const t = boot();
    const rs = await t.api.run(), r = byId(rs);
    // lịch nghỉ lễ có thể 'warn' nếu năm hiện tại chưa đủ lịch; bỏ qua phép này khi đánh giá "tất cả đạt"
    const bad = rs.filter((x) => x.id !== 'holidays' && x.status !== 'ok');
    expect(bad.map((x) => x.id + ':' + x.status + ':' + x.detail)).toEqual([]);
    expect(r.version.detail).toBe('0.1.12'); expect(r['live-fn'].detail).toContain('FPT 60.300'); expect(r.vnd.detail).toContain('FPT 60.300');
    expect(r.batch.detail).toMatch(/FPT: giá trị hợp lý [\d.]+/); expect(r['vb-data'].detail).toMatch(/5 năm báo cáo/);
    expect(t.events).toEqual(['write', 'remove']); expect(t.files.size).toBe(0);
    const rep = await t.api.report();
    expect(rep).toContain('WorkHub Fin: kiểm tra hệ thống (phiên bản 0.1.12)'); expect(rep).not.toMatch(/@|eyJ|Bearer/);
  }, 30000);
});

describe('self-check.js: các sự cố điển hình', () => {
  it('hàm VCI hỏng: lỗi kèm lý do; VNDirect hỏng: lỗi; chưa đăng nhập: lỗi', async () => {
    const r = byId(await boot({ liveFn: 'fail', vnd: 'down', session: false }).api.run());
    expect(r['live-fn'].status).toBe('fail'); expect(r['live-fn'].detail).toContain('non-2xx'); expect(r.vnd.status).toBe('fail'); expect(r.vnd.detail).toContain('503'); expect(r.session.status).toBe('fail');
  }, 30000);
  it('thiếu quyền ghi tệp: lỗi có hướng dẫn cài bản mới', async () => {
    const r = byId(await boot({ fsFail: 'fs.write_file not allowed. Permissions associated with this command: fs:allow-write-file' }).api.run());
    expect(r['fs-write'].status).toBe('fail'); expect(r['fs-write'].detail).toContain('bản cài mới');
  }, 30000);
  it('ảnh chụp chưa có số liệu mới: chú ý; ảnh chụp cũ: chú ý; ít mã: chú ý', async () => {
    expect(byId(await boot({ snapNew: false }).api.run()).snapshot.detail).toContain('18:20');
    expect(byId(await boot({ asOf: '2026-09-01' }).api.run()).snapshot.status).toBe('warn');
    expect(byId(await boot({ snapN: 300 }).api.run()).snapshot.status).toBe('warn');
  }, 60000);
  it('chưa có lịch sử trong máy: chú ý; chưa cấp quyền thông báo: chú ý', async () => {
    const r = byId(await boot({ history: { count: 0, first: null, last: null, gaps: 0 }, notifGranted: false }).api.run());
    expect(r.history.status).toBe('warn'); expect(r.notify.status).toBe('warn');
  }, 30000);
  it('bản web (không Tauri): các phép chỉ có trên desktop được bỏ qua, không lỗi', async () => {
    const r = byId(await boot({ tauri: false }).api.run());
    expect(r.version.status).toBe('skip'); expect(r['fs-write'].status).toBe('skip'); expect(r.notify.status).toBe('skip');
  }, 30000);
  it('gửi thông báo thử', async () => {
    const t = boot(); const out = await t.api.testNotification();
    expect(out.ok).toBe(true); expect(t.events).toContain('notify:WorkHub: thông báo thử');
    const t2 = boot({ tauri: false }); expect((await t2.api.testNotification()).ok).toBe(false);
  });
});
