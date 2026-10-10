// Chạy CHÍNH api.js (API.asset.simRuns.*) trên Supabase giả: lưu / đọc / sửa ghi chú + đánh dấu / xoá lần mô phỏng,
// và quyết định trong Nhật Ký Quyết Định nối với lần mô phỏng (sim_run_id) mà sửa tay không gỡ liên kết.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js', 'lib/sim-score.js'];
const USER = 'u-1', EMAIL = 'toi@example.com';

function boot(seed = {}, withLib = true) {
  const fake = createFakeSupabase(Object.assign({ users: [{ id: USER, email: EMAIL, nickname: 'toi' }], finance_assets: [{ user_id: USER, cash: 0, debt: 0, nav: 0 }] }, seed), {});
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, Blob, Buffer, URL, TextEncoder, TextDecoder, atob, btoa,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {}, document: { addEventListener() {}, getElementById: () => null, readyState: 'complete' },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  };
  sandbox.window = sandbox;
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sandbox.window.supabase = { createClient: () => fake.client };
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  LIBS.forEach(lib => vm.runInContext(read(lib).replace(/^const (\w+) = \(function/m, 'var $1 = (function'), sandbox));
  if (!withLib) vm.runInContext('SimScore = undefined;', sandbox);
  vm.runInContext(read('api.js') + '\n;this.API = API; this.callGAS = window.callGAS;', sandbox);
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS };
}
const SNAP = { v: 1, asOf: '2026-10-09', indexLevel: 1650, subject: 'custom', horizons: [5, 21, 63], bands: [0.02, 0.04, 0.06], levels: [0.05, 0.5, 0.95],
  grid: { index: [[-0.03, 0, 0.03], [-0.06, 0.01, 0.07], [-0.12, 0.02, 0.15]], hold: [[-0.03, 0, 0.03], [-0.06, 0.01, 0.07], [-0.12, 0.02, 0.15]], base: null },
  policies: [{ id: 'hold', label: 'Giữ nguyên' }, { id: 'stop8', label: 'Cắt lỗ cố định 8%' }], chosen: 'hold', events: [], tree: [], eventTrees: [], positions: [], outcome: [] };

describe('API.asset.simRuns', () => {
  it('lưu -> trả id; đọc lại mới nhất trước; cột đúng tên', async () => {
    const { API, fake } = boot();
    const r = await API.asset.simRuns.save(EMAIL, { snapshot: SNAP, subject: 'custom', chosen: 'stop8', label: 'Mô phỏng thử', note: 'giữ nếu tuần đầu không giảm' });
    expect(r.id).toBeTruthy();
    const row = fake.table('finance_sim_runs')[0];
    expect(row).toMatchObject({ user_id: USER, as_of: '2026-10-09', subject: 'custom', chosen_policy: 'stop8', label: 'Mô phỏng thử', note: 'giữ nếu tuần đầu không giảm' });
    expect(row.snapshot.chosen).toBe('stop8');
    const list = await API.asset.simRuns.list(EMAIL);
    expect(list).toHaveLength(1);
  });
  it('ảnh chụp xấu bị từ chối, không ghi gì; thiếu thư viện báo rõ', async () => {
    const { API, fake } = boot();
    await expect(API.asset.simRuns.save(EMAIL, { snapshot: Object.assign({}, SNAP, { v: 0 }) })).rejects.toThrow(/không hợp lệ/);
    await expect(API.asset.simRuns.save('la@example.com', { snapshot: SNAP })).rejects.toThrow(/không tồn tại/);
    expect(fake.table('finance_sim_runs')).toHaveLength(0);
    const b = boot({}, false);
    await expect(b.API.asset.simRuns.save(EMAIL, { snapshot: SNAP })).rejects.toThrow(/sim-score/);
  });
  it('sửa ghi chú + đánh dấu sự kiện (lọc giá trị lạ); không đụng ảnh chụp; xoá mềm', async () => {
    const { API, fake } = boot();
    const { id } = await API.asset.simRuns.save(EMAIL, { snapshot: SNAP });
    await API.asset.simRuns.update(EMAIL, id, { note: '  đổi ý nếu lãi suất tăng ', marks: { e1: true, e2: 'x' }, snapshot: { v: 9 } });
    const row = fake.table('finance_sim_runs')[0];
    expect(row.note).toBe('đổi ý nếu lãi suất tăng'); expect(row.marks).toEqual({ e1: true }); expect(row.snapshot.v).toBe(1);
    await API.asset.simRuns.remove(EMAIL, id);
    expect(fake.table('finance_sim_runs')[0].deleted_at).toBeTruthy();
    expect(await API.asset.simRuns.list(EMAIL)).toHaveLength(0);
  });
  it('qua callGAS (các thao tác ghi nằm trong MUTATING_ACTIONS)', async () => {
    const { callGAS, fake } = boot();
    const r = await callGAS('saveSimRun', { email: EMAIL, run: { snapshot: SNAP } });
    expect(r.status).toBe('success');
    expect((await callGAS('listSimRuns', { email: EMAIL })).data).toHaveLength(1);
    expect((await callGAS('deleteSimRun', { email: EMAIL, id: fake.table('finance_sim_runs')[0].id })).status).toBe('success');
    const src = read('api.js');
    ['saveSimRun', 'updateSimRun', 'deleteSimRun'].forEach((a) => expect(src).toMatch(new RegExp("MUTATING_ACTIONS = new Set\\(\\[[\\s\\S]*'" + a + "'")));
  });
});

describe('Nhật Ký Quyết Định nối với lần mô phỏng', () => {
  const D = (o) => Object.assign({ symbol: 'FPT', action: 'hold', date: '2026-10-09', price: 100000, reason: 'Theo mô phỏng: giữ' }, o || {});
  it('ghi kèm simRunId -> cột sim_run_id; sửa tay sau đó không gỡ liên kết; không có simRunId thì không gửi cột', async () => {
    const { API, fake } = boot();
    const { id: runId } = await API.asset.simRuns.save(EMAIL, { snapshot: SNAP });
    await API.asset.journal.save(EMAIL, D({ simRunId: runId }));
    const dec = fake.table('finance_decisions')[0];
    expect(dec.sim_run_id).toBe(runId);
    await API.asset.journal.save(EMAIL, D({ id: dec.id, reason: 'Sửa lý do' }));
    expect(fake.table('finance_decisions')[0]).toMatchObject({ sim_run_id: runId, reason: 'Sửa lý do' });
    await API.asset.journal.save(EMAIL, D({ symbol: 'VCB' }));
    expect('sim_run_id' in fake.table('finance_decisions')[1]).toBe(false);
    const list = await API.asset.journal.list(EMAIL);
    expect(list.find((r) => r.symbol === 'FPT').sim_run_id).toBe(runId);
  });
  it('mã lần mô phỏng sai dạng bị từ chối', async () => {
    const { API } = boot();
    await expect(API.asset.journal.save(EMAIL, D({ simRunId: "1'; drop" }))).rejects.toThrow(/mô phỏng/);
  });
});
