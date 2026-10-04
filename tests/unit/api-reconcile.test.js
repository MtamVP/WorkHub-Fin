// API.asset.reconcile: lấy dữ liệu đầu vào, ghi và đọc nhật ký đối soát, chạy CHÍNH api.js trên Supabase giả.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/limits-calc.js', 'lib/corporate-events.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js'];

const MEMBER = { id: 'u-1', email: 'an@x.vn', nickname: 'An', group_key: 'finance', active: true };
const today = new Date().toISOString().slice(0, 10);

function boot(seed = {}) {
  const base = {
    users: [MEMBER], fin_roles: [],
    finance_assets: [{ user_id: 'u-1', cash: 300e6, debt: 0, nav: 0 }],
    finance_transactions: [{ id: 't0', user_id: 'u-1', type: 'buy', symbol: 'FPT', quantity: 1000, price: 100000, fee: 0, tax: 0, trade_date: '2026-01-02', created_at: '2026-01-02T00:00:00Z', deleted_at: null }],
  };
  const fake = createFakeSupabase(Object.assign(base, seed), { authUser: { email: MEMBER.email } });
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
  vm.runInContext(read('api.js') + '\n;this.API = API; this.callGAS = window.callGAS; this.MUTATING = window.MUTATING_ACTIONS;', sandbox);
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS, MUTATING: sandbox.MUTATING };
}

describe('API.asset.reconcile', () => {
  it('getInputs: sổ lệnh, hành động DN, tiền mặt/nợ, ngày hôm nay', async () => {
    const c = boot({ finance_assets: [{ user_id: 'u-1', cash: 12e6, debt: 3e6, nav: 0 }] });
    const r = await c.API.asset.reconcile.getInputs(MEMBER.email);
    expect(r.txns).toHaveLength(1);
    expect(r).toMatchObject({ cash: 12e6, debt: 3e6, today });
    expect(r.actions).toEqual([]);
  });
  it('save: ghi 1 dòng đầy đủ, gắn người ghi', async () => {
    const c = boot();
    const msg = await c.API.asset.reconcile.save(MEMBER.email, { kind: 'positions', asOf: '2026-09-30', source: 'sao-ke.xlsx', total: 5, matched: 4, mismatched: 1, valueAtStake: 1500000, cashStatement: 5e6, cashApp: 4.9e6, cashOk: false, summary: { items: [] }, note: 'kiểm tra tháng 9' });
    expect(msg).toMatch(/Đã lưu/);
    const row = c.fake.table('finance_reconciliations')[0];
    expect(row).toMatchObject({ user_id: 'u-1', kind: 'positions', as_of: '2026-09-30', source: 'sao-ke.xlsx', total: 5, matched: 4, mismatched: 1, value_at_stake: 1500000, cash_statement: 5e6, cash_app: 4.9e6, cash_ok: false, created_by: 'u-1' });
  });
  it('save: từ chối loại hoặc ngày sai; số âm/rác được chuẩn hoá', async () => {
    const c = boot();
    await expect(c.API.asset.reconcile.save(MEMBER.email, { kind: 'xyz', asOf: '2026-09-30' })).rejects.toThrow(/Loại/);
    await expect(c.API.asset.reconcile.save(MEMBER.email, { kind: 'trades', asOf: '30/09/2026' })).rejects.toThrow(/Ngày/);
    await c.API.asset.reconcile.save(MEMBER.email, { kind: 'trades', asOf: '2026-09-30', total: -4, matched: 'x', valueAtStake: -5 });
    expect(c.fake.table('finance_reconciliations')[0]).toMatchObject({ total: 0, matched: 0, value_at_stake: 0, cash_statement: null, cash_ok: null });
  });
  it('list: của chính người đó, mới nhất trước; listAll: cả nhóm', async () => {
    const c = boot();
    await c.API.asset.reconcile.save(MEMBER.email, { kind: 'positions', asOf: '2026-08-31' });
    await new Promise(r => setTimeout(r, 5));
    await c.API.asset.reconcile.save(MEMBER.email, { kind: 'trades', asOf: '2026-09-30' });
    c.fake.table('finance_reconciliations').push({ id: 'o', user_id: 'u-2', kind: 'positions', as_of: '2026-09-01', created_at: new Date().toISOString() });
    const mine = await c.API.asset.reconcile.list(MEMBER.email);
    expect(mine.map(r => r.as_of)).toEqual(['2026-09-30', '2026-08-31']);
    expect(await c.API.asset.reconcile.listAll(30)).toHaveLength(3);
  });
  it('qua callGAS; saveReconciliation là hành động ghi (đi qua hàng đợi ngoại tuyến)', async () => {
    const c = boot();
    expect((await c.callGAS('saveReconciliation', { email: MEMBER.email, record: { kind: 'positions', asOf: '2026-09-30' } })).status).toBe('success');
    const l = await c.callGAS('listReconciliations', { email: MEMBER.email });
    expect(l.data).toHaveLength(1);
    expect((await c.callGAS('listAllReconciliations', { days: 30 })).data).toHaveLength(1);
    expect((await c.callGAS('getReconcileInputs', { email: MEMBER.email })).status).toBe('success');
    expect(c.MUTATING.has('saveReconciliation')).toBe(true);
  });
});
