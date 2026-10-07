import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import MH from '../../lib/market-history.js';

const REPO = process.cwd().replace(/\\/g, '/');
const STATS = { '2700': { n: 700, as_of: '2026-10-06', stats: { pe: { n: 40, median: 14, q: [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30] } } } };
const SAVED = [{ name: 'ROE cao', filters: { values: { roe: 15 } } }];

// 700 mã; `hot` có ROE 20% (lọt bộ lọc), chg1m: nhóm hot do `hotChg`, còn lại 1%
function snap(hot, hotChg) {
  return Array.from({ length: 700 }, (_, i) => {
    const s = 'S' + String(i).padStart(4, '0'), isHot = hot.includes(s);
    return { symbol: s, icb2_code: '2700', daily_date: '2026-10-06', quarter_date: '2026-06-30', metrics: { marketcap: 3000e9, advValue20: 20e9, pe: 12, roae: isHot ? 0.2 : 0.05, chg1m: isHot ? hotChg : 0.01, chg3m: 0.03, chg6m: 0.06 } };
  });
}
const gz = (s, asOf) => zlib.gzipSync(Buffer.from(JSON.stringify(MH.pack(s, STATS, { asOf, savedAt: asOf + 'T11:00:00Z' }))));
function boot(files, saved) {
  const store = new Map(); if (saved) store.set('wh.fin.marketscreener.saved.v1', JSON.stringify(saved));
  const fsApi = { BaseDirectory: { AppLocalData: 1 }, exists: async () => true, readDir: async () => Object.keys(files).map((name) => ({ name })), readFile: async (p) => { const n = p.split('/').pop(); if (!files[n]) throw new Error('no file ' + n); return new Uint8Array(files[n]); } };
  const win = { __TAURI__: { fs: fsApi, notification: { sendNotification() {} } } };
  const ctx = vm.createContext({ window: win, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }, Blob, Response, DecompressionStream, Promise, JSON, Date, Math, console, Uint8Array, setTimeout });
  ['lib/market-history.js', 'lib/peer-valuation.js', 'lib/market-screener.js', 'lib/filter-watch.js', 'lib/filter-validate.js', 'filter-watch.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  return { api: win.WorkHubFilterWatch, store };
}
const hot = Array.from({ length: 40 }, (_, i) => 'S' + String(i).padStart(4, '0'));
const files = () => ({
  'snapshot-2026-01-05.json.gz': gz(snap(hot, 0.01), '2026-01-05'),
  'snapshot-2026-02-05.json.gz': gz(snap(hot, 0.09), '2026-02-05'),        // đúng mốc 1 tháng: nhóm hot +9%, thị trường +1%
});

describe('WorkHubFilterWatch.validate (kiểm chứng bộ lọc bằng lịch sử trong máy)', () => {
  it('đọc mọi tệp, báo tiến trình, đo chênh lệch so với thị trường và cất kết quả gọn', async () => {
    const t = boot(files(), SAVED), prog = [];
    const r = await t.api.validate((p) => prog.push(p.done + '/' + p.total));
    expect(prog).toEqual(['0/2', '1/2']);
    expect(r).toMatchObject({ state: 'ok', days: 2, skipped: 0, first: '2026-01-05', last: '2026-02-05' });
    const f = r.filters[0];
    expect(f).toMatchObject({ name: 'ROE cao', events: 40, entryDates: 1 });
    expect(f.horizons[0]).toMatchObject({ n: 40, enough: false }); expect(f.horizons[0].medianExcess).toBeCloseTo(0.08, 4); expect(f.horizons[0].beat).toBe(1);
    expect(f.horizons[1].pending).toBe(40);
    expect(t.api.lastValidation()).toMatchObject({ state: 'ok', days: 2 });
    expect(JSON.parse(t.store.get('wh.fin.filtervalid.v1')).filters[0].events).toBe(40);
  });
  it('tệp hỏng được bỏ qua và đếm; không đủ ngày / chưa có bộ lọc / bản web trả trạng thái rõ ràng', async () => {
    const f = files(); f['snapshot-2026-03-05.json.gz'] = new Uint8Array([1, 2, 3]);
    const r = await boot(f, SAVED).api.validate();
    expect(r).toMatchObject({ state: 'ok', days: 2, skipped: 1 });
    expect((await boot({ 'snapshot-2026-01-05.json.gz': f['snapshot-2026-01-05.json.gz'] }, SAVED).api.validate())).toMatchObject({ state: 'nodata' });
    expect((await boot(files(), []).api.validate()).state).toBe('nosaved');
    const web = vm.createContext({ window: {}, localStorage: { getItem: () => null }, document: {} });
    ['lib/market-history.js', 'lib/peer-valuation.js', 'lib/market-screener.js', 'lib/filter-watch.js', 'lib/filter-validate.js', 'filter-watch.js'].forEach((p) => vm.runInContext(fs.readFileSync(REPO + '/' + p, 'utf8'), web, { filename: p }));
    expect((await web.window.WorkHubFilterWatch.validate()).state).toBe('web');
    expect(web.window.WorkHubFilterWatch.lastValidation()).toBeNull();
  });
});
