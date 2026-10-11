// Chạy CHÍNH api.js + lab/lab-api.js (API.lab.*) trên Supabase giả: tải kho giá và dựng bảng, số liệu cơ bản theo thời điểm, lưu / mở / xoá lần kiểm thử, đếm số cấu hình đã thử.
// Chính sách RLS (ai được ghi) KHÔNG được mô phỏng ở đây; phần đó kiểm bằng khối DO ở phiên triển khai và ghi trong RUNBOOK.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';
const { makeRows, indexRow, pitRow } = require('../helpers/bt-fixtures.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/pit-calc.js', 'lib/bt-panel.js'];
const USER = 'u-1', EMAIL = 'toi@example.com';

function boot(seed = {}, store = {}) {
  const fake = createFakeSupabase(Object.assign({ users: [{ id: USER, email: EMAIL, nickname: 'Tôi', group_key: 'finance' }] }, seed), { authUser: { id: USER, email: EMAIL }, functions: {} });
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, Blob, Buffer, URL, TextEncoder, TextDecoder, atob, btoa,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: {}, document: { addEventListener() {}, getElementById: () => null, readyState: 'complete' },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  };
  sandbox.window = sandbox;
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sandbox.window.supabase = { createClient: () => fake.client };
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  LIBS.forEach((lib) => vm.runInContext(read(lib).replace(/^const (\w+) = \(function/m, 'var $1 = (function'), sandbox));
  vm.runInContext(read('api.js') + '\n' + read('lab/lab-api.js') + '\n;this.API = API; this.callGAS = window.callGAS;', sandbox);
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS, store };
}
const okResult = (over) => Object.assign({ ok: true, spec: { name: 'Mẫu', rebalance: 'M' }, dataThrough: '2026-10-09', period: { from: '2021-02-01', to: '2026-10-09' }, metrics: { cagr: 0.1, sharpe: 0.8, maxDD: -0.3 }, bench: { cagr: 0.08 }, random: { cagr: { rank: 0.7 } }, dsr: { dsr: 0.6 }, rebalances: Array.from({ length: 80 }, (_v, i) => ({ t: i })) }, over || {});

describe('Kho giá và số liệu cơ bản', () => {
  const days = 320, { rows, dates } = makeRows(days, { AAA: { ret: 0.001, p0: 20 }, BBB: { ret: -0.0005, p0: 30, ex: 1 } });
  const idx = [{ symbol: 'VNINDEX', data: indexRow('VNINDEX', dates, 0.0004).data }];
  it('loadPanel: dựng bảng từ chuỗi chỉ số và các ngày trên máy chủ, báo số ngày tải', async () => {
    const { API } = boot({ finance_bt_index: idx, finance_price_days: rows });
    const prog = []; const r = await API.lab.loadPanel((p) => prog.push(p));
    expect(r.serverDays).toBe(days); expect(r.downloaded).toBe(days); expect(r.fromCache).toBe(0);
    expect(r.panel.T).toBe(days); expect(Object.keys(r.panel.sIndex).sort()).toEqual(['AAA', 'BBB']); expect(prog.length).toBeGreaterThan(2);
  });
  it('loadPanel: thiếu chuỗi VN-Index hoặc quá ít ngày thì báo lỗi rõ ràng (không dựng bảng sai)', async () => {
    await expect(boot({ finance_bt_index: [], finance_price_days: rows }).API.lab.loadPanel()).rejects.toThrow('Kho giá chưa được dựng');
    await expect(boot({ finance_bt_index: idx, finance_price_days: rows.slice(0, 100) }).API.lab.loadPanel()).rejects.toThrow('cần ít nhất 300');
  });
  it('loadPit: giải mã các ngày chụp, đếm ngày dựng ngược; chưa có thì trả rỗng', async () => {
    const empty = await boot({ finance_pit_market_daily: [] }).API.lab.loadPit();
    expect(empty).toMatchObject({ days: [], n: 0, first: null });
    const mk = (d, src) => Object.assign(pitRow(d, { AAA: { pe: 10, roae: 0.2, marketcap: 5e12 } }), { source: src });
    const r = await boot({ finance_pit_market_daily: [mk('2021-01-29', 'backfill'), mk('2021-02-26', 'backfill'), mk('2021-03-31', 'live')] }).API.lab.loadPit();
    expect(r.n).toBe(3); expect(r.first).toBe('2021-01-29'); expect(r.last).toBe('2021-03-31'); expect(r.backfill).toBe(2);
  });
});

describe('Các lần kiểm thử đã lưu', () => {
  it('lưu: cắt còn 60 kỳ cân bằng cuối, kèm tóm tắt; mở lại và xoá mềm', async () => {
    const { API, fake } = boot({ finance_bt_runs: [] });
    const saved = await API.lab.saveRun(EMAIL, { name: '  Động lượng thử  ', note: 'ghi chú', result: okResult() });
    expect(saved.message).toContain('Đã lưu');
    const row = fake.table('finance_bt_runs')[0];
    expect(row).toMatchObject({ user_id: USER, name: 'Động lượng thử', data_through: '2026-10-09', note: 'ghi chú' });
    expect(row.summary.rebalances).toHaveLength(60); expect(row.summary.brief).toMatchObject({ cagr: 0.1, sharpe: 0.8, excess: expect.closeTo(0.02, 9), randomRank: 0.7, dsr: 0.6 });
    expect((await API.lab.getRun(saved.id)).summary.brief.hash).toBe(row.summary.brief.hash);
    await expect(API.lab.getRun('khong-co')).rejects.toThrow('Không tìm thấy');
    await API.lab.deleteRun(EMAIL, saved.id);
    expect(fake.table('finance_bt_runs')[0].deleted_at).toBeTruthy(); expect(await API.lab.listRuns()).toHaveLength(0);
  });
  it('không lưu được khi chưa có kết quả hoặc kết quả lỗi; tên rỗng lấy tên cấu hình', async () => {
    const { API, fake } = boot({ finance_bt_runs: [] });
    await expect(API.lab.saveRun(EMAIL, { result: null })).rejects.toThrow('Chưa có kết quả');
    await expect(API.lab.saveRun(EMAIL, { result: { ok: false, errors: ['x'] } })).rejects.toThrow('Chưa có kết quả');
    await API.lab.saveRun(EMAIL, { name: '', result: okResult() }); expect(fake.table('finance_bt_runs')[0].name).toBe('Mẫu');
  });
  it('qua callGAS: danh sách, lưu, xoá đều đi đúng đường', async () => {
    const { callGAS } = boot({ finance_bt_runs: [] });
    const s = await callGAS('labSaveRun', { email: EMAIL, result: okResult() }); expect(s.status).toBe('success');
    expect((await callGAS('labListRuns', {})).data).toHaveLength(1);
    expect((await callGAS('labDeleteRun', { email: EMAIL, id: s.data.id })).status).toBe('success');
  });
});

describe('Số cấu hình đã thử (trừ may rủi cho Sharpe)', () => {
  it('băm cấu hình bỏ qua tên; cùng cấu hình thì cùng băm', async () => {
    const { API } = boot();
    expect(API.lab._hash({ a: 1, name: 'x' })).toBe(API.lab._hash({ a: 1, name: 'y' })); expect(API.lab._hash({ a: 1 })).not.toBe(API.lab._hash({ a: 2 }));
  });
  it('gộp bản lưu và bản trên máy; chạy lại đúng cấu hình đang xem không tính là lần thử mới; cần >= 3 cấu hình mới có phương sai', async () => {
    const store = { 'lab-trials': JSON.stringify({ h1: { sr: 0.01, at: 1 }, h2: { sr: 0.03, at: 2 } }) };
    const { API } = boot({}, store);
    expect(API.lab.trials([], null)).toEqual({ count: 2, srVarDaily: null });
    const t = API.lab.trials([{ brief: { hash: 'h3', srDaily: 0.05 } }, { brief: { hash: 'h1', srDaily: 0.01 } }], null);
    expect(t.count).toBe(3); expect(t.srVarDaily).toBeCloseTo(0.0004, 8);
    expect(API.lab.trials([{ brief: { hash: 'h3', srDaily: 0.05 } }], 'h3').count).toBe(2);
  });
  it('noteTrial ghi băm và Sharpe ngày của lần chạy vào máy', async () => {
    const store = {}; const { API } = boot({}, store);
    API.lab.noteTrial(okResult()); const loc = JSON.parse(store['lab-trials']); const b = API.lab.brief(okResult());
    expect(Object.keys(loc)).toEqual([b.hash]); expect(loc[b.hash].sr).toBeCloseTo(0.8 / Math.sqrt(252), 9);
    expect(API.lab.brief({ ok: false })).toBeNull();
  });
});
