import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import MH from '../../lib/market-history.js';

const snap = (n, date) => Array.from({ length: n }, (_, i) => ({ symbol: 'S' + String(i).padStart(4, '0'), icb2_code: i % 2 ? '2700' : '8300', daily_date: date, quarter_date: '2026-06-30', metrics: { pe: 10 + i % 7, marketcap: 1e12, chgYtd: 0.1 } }));
const STATS = { '2700': { n: 700, as_of: '2026-10-06', stats: { pe: { n: 40, median: 14, q: [1, 2] } } } };

describe('lib/market-history: đóng gói / mở gói / tên tệp', () => {
  it('pack giữ đủ mã và chỉ số, ngày lấy theo ngày phổ biến nhất; unpack trả đúng đầu vào của bộ lọc', () => {
    const rows = snap(600, '2026-10-06'); rows[0].daily_date = '2026-10-05';
    const p = MH.pack(rows, STATS, { savedAt: '2026-10-07T00:00:00Z' });
    expect(p.v).toBe(1); expect(p.asOf).toBe('2026-10-06'); expect(p.rows).toHaveLength(600); expect(p.rows[1]).toMatchObject({ s: 'S0001', i: '2700', q: '2026-06-30', m: { chgYtd: 0.1 } });
    const u = MH.unpack(JSON.parse(JSON.stringify(p)));
    expect(u.snapshot[1]).toEqual(rows[1]); expect(u.stats).toEqual(STATS); expect(u.asOf).toBe('2026-10-06');
    const MS = require('../../lib/market-screener.js');
    expect(MS.buildRows(u.snapshot, u.stats, {})).toHaveLength(600);
  });
  it('quá ít mã (nguồn hỏng một phần) hoặc không rõ ngày thì không lưu; thiếu ngày chỉ số thì dùng ngày thống kê ngành', () => {
    expect(MH.pack(snap(100, '2026-10-06'), STATS)).toBeNull();
    expect(MH.pack(snap(600, null), {})).toBeNull();
    expect(MH.pack(snap(600, null), STATS).asOf).toBe('2026-10-06');
    expect(MH.unpack({ v: 2, rows: [] })).toBeNull();
  });
  it('tên tệp, nhận ngày từ tên tệp, quyết định có cần lưu không', () => {
    expect(MH.fileName('2026-10-06')).toBe('snapshot-2026-10-06.json.gz');
    expect(MH.dateOfFile('snapshot-2026-10-06.json.gz')).toBe('2026-10-06'); expect(MH.dateOfFile('backup-1.json')).toBeNull();
    expect(MH.shouldArchive('2026-10-06', ['snapshot-2026-10-05.json.gz'])).toBe(true);
    expect(MH.shouldArchive('2026-10-06', ['snapshot-2026-10-06.json.gz'])).toBe(false);
    expect(MH.shouldArchive('xx', [])).toBe(false);
  });
  it('summarize đếm ngày, mốc đầu/cuối và ngày làm việc bị thiếu (bỏ cuối tuần)', () => {
    expect(MH.summarize([])).toEqual({ count: 0, first: null, last: null, gaps: 0 });
    // 02/10 (T6) -> 07/10 (T4): thiếu 05/10 (T2), 06/10 (T3)
    expect(MH.summarize(['snapshot-2026-10-07.json.gz', 'snapshot-2026-10-02.json.gz', 'x.txt'])).toEqual({ count: 2, first: '2026-10-02', last: '2026-10-07', gaps: 2 });
  });
});

// Chạy market-history.js thật trong vm với Tauri/Supabase giả
function boot({ session = true, serverDate = '2026-10-06', rows = snap(600, '2026-10-06'), existing = [], network = null } = {}) {
  const files = new Map(existing.map((n) => [n, Buffer.from('old')])), writes = [], invokes = [];
  const q = (data, error = null) => { const o = { data, error, select: () => o, order: () => o, limit: () => o, range: (a, b) => Promise.resolve({ data: Array.isArray(data) ? data.slice(a, b + 1) : data, error }), then: (f) => Promise.resolve({ data, error }).then(f) }; return o; };
  const sb = { auth: { getSession: async () => ({ data: { session: session ? {} : null } }) }, from: (t) => (t === 'finance_market_snapshot' ? q(rows) : q(t === 'finance_sector_stats' ? (serverDate ? [{ icb2_code: '2700', n: 700, as_of: serverDate, stats: {} }] : []) : [])) };
  const tfs = { BaseDirectory: { AppLocalData: 1 }, exists: async (p) => (p === 'market-history' ? true : files.has(p)), mkdir: async () => {}, readDir: async () => [...files.keys()].map((name) => ({ name })), writeFile: async (p, bytes) => { writes.push(p); files.set(p.split('/').pop(), Buffer.from(bytes)); } };
  const win = { __TAURI__: { fs: tfs, core: { invoke: async (c, a) => { invokes.push([c, a]); } }, path: { appLocalDataDir: async () => 'C:\\Users\\x\\AppData\\Local\\com.workhub.fin\\' } }, supabaseClient: sb };
  const ctx = vm.createContext({ window: win, document: { readyState: 'complete', addEventListener() {} }, localStorage: { getItem: (k) => (k === 'wh_backup_network_path' ? network : null) }, setTimeout: () => 0, setInterval: () => 0, console, Blob, Response, CompressionStream, Uint8Array, btoa, String, JSON, Date, Promise, Error, MarketHistory: MH });
  vm.runInContext(fs.readFileSync('market-history.js', 'utf8'), ctx);
  return { api: win.WorkHubMarketHistory, files, writes, invokes };
}

describe('market-history.js: ghi tệp trong máy', () => {
  it('ngày mới -> ghi một tệp gzip đọc lại được, đúng tên theo ngày dữ liệu, không gọi ghi nào lên Supabase', async () => {
    const t = boot();
    const st = await t.api.runNow();
    expect(st.state).toBe('saved'); expect(t.writes).toEqual(['market-history/snapshot-2026-10-06.json.gz']);
    const back = JSON.parse(zlib.gunzipSync(t.files.get('snapshot-2026-10-06.json.gz')).toString('utf8'));
    expect(back.asOf).toBe('2026-10-06'); expect(back.rows).toHaveLength(600);
    expect(st.summary).toMatchObject({ count: 1, last: '2026-10-06' }); expect(st.dir).toContain('market-history');
  });
  it('đã có tệp của ngày đó thì không lưu lại (và không tải ảnh chụp); runForce thì ghi đè', async () => {
    const t = boot({ existing: ['snapshot-2026-10-06.json.gz'] });
    expect((await t.api.runNow()).state).toBe('ok'); expect(t.writes).toHaveLength(0);
    expect((await t.api.runForce()).state).toBe('saved'); expect(t.writes).toHaveLength(1);
  });
  it('chưa đăng nhập: bỏ qua; ảnh chụp quá ít mã: không lưu và báo lý do; có thư mục mạng thì ghi thêm một bản qua sync_write_file', async () => {
    expect((await boot({ session: false }).api.runNow()).state).toBe('idle');
    const few = boot({ rows: snap(50, '2026-10-06') }); const s2 = await few.api.runNow();
    expect(s2.state).toBe('skipped'); expect(s2.error).toMatch(/quá ít/); expect(few.writes).toHaveLength(0);
    const net = boot({ network: 'Z:\\nas' }); await net.api.runNow(); await new Promise((r) => setTimeout(r, 10));
    expect(net.invokes[0][0]).toBe('sync_write_file'); expect(net.invokes[0][1]).toMatchObject({ root: 'Z:\\nas', relativePath: 'market-history/snapshot-2026-10-06.json.gz' });
  });
});
