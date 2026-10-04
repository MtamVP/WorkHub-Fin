// Danh sách hạn chế mã: API.asset.restricted và việc chặn trong addTransaction, chạy CHÍNH api.js trên Supabase giả.
// (Trigger DB chặn thật đã được kiểm bằng người dùng giả lập trên DB thật, xem finance-restricted-migration.sql.)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/limits-calc.js', 'lib/approval-calc.js', 'lib/corporate-events.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js'];

const MEMBER = { id: 'u-1', email: 'an@x.vn', nickname: 'An', group_key: 'finance', active: true };
const OTHER = { id: 'u-4', email: 'binh@x.vn', nickname: 'Bình', group_key: 'finance', active: true };
const MANAGER = { id: 'u-2', email: 'mgr@x.vn', nickname: 'Quản lý', group_key: 'finance', active: true };

function boot(actor = MEMBER, seed = {}) {
  const base = {
    users: [MEMBER, OTHER, MANAGER], fin_roles: [{ user_id: 'u-2', role: 'asset_manager' }],
    finance_assets: [{ user_id: 'u-1', cash: 300e6, debt: 0, nav: 0 }, { user_id: 'u-4', cash: 300e6, debt: 0, nav: 0 }, { user_id: 'u-2', cash: 300e6, debt: 0, nav: 0 }],
    finance_transactions: [], finance_approval_policy: [{ id: 1, active: false }],
  };
  const fake = createFakeSupabase(Object.assign(base, seed), { authUser: { email: actor.email } });
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
const BUY = (symbol, extra = {}) => Object.assign({ type: 'buy', symbol, quantity: 100, price: 20000, tradeDate: '2026-10-01' }, extra);
const RS = (o = {}) => Object.assign({ id: 'rs1', symbol: 'FPT', user_id: null, reason: 'đang nắm thông tin chưa công bố', active: true, created_at: '2026-10-01T00:00:00Z' }, o);

describe('API.asset.restricted', () => {
  it('chỉ quản lý thêm / gỡ được; thành viên bị từ chối', async () => {
    const m = boot(MEMBER);
    await expect(m.API.asset.restricted.add(MEMBER.email, { symbol: 'FPT', reason: 'lý do dài đủ' })).rejects.toThrow(/Chỉ quản lý/);
    await expect(m.API.asset.restricted.setActive(MEMBER.email, 'x', false)).rejects.toThrow(/Chỉ quản lý/);
  });
  it('quản lý thêm: viết hoa mã, bắt buộc lý do, kiểm mã hợp lệ', async () => {
    const c = boot(MANAGER);
    await expect(c.API.asset.restricted.add(MANAGER.email, { symbol: 'fpt', reason: 'ngắn' })).rejects.toThrow(/lý do/);
    await expect(c.API.asset.restricted.add(MANAGER.email, { symbol: 'F P T', reason: 'lý do đủ dài' })).rejects.toThrow(/Mã không hợp lệ/);
    expect(await c.API.asset.restricted.add(MANAGER.email, { symbol: 'fpt', reason: 'xung đột lợi ích' })).toMatch(/FPT/);
    expect(c.fake.table('finance_restricted_symbols')[0]).toMatchObject({ symbol: 'FPT', user_id: null, active: true, reason: 'xung đột lợi ích' });
  });
  it('find: hạn chế chung áp cho mọi người, hạn chế riêng chỉ cho đúng người, đã gỡ thì không áp', async () => {
    const c = boot(MEMBER, { finance_restricted_symbols: [RS(), RS({ id: 'rs2', symbol: 'HPG', user_id: 'u-4' }), RS({ id: 'rs3', symbol: 'VCB', active: false })] });
    expect((await c.API.asset.restricted.find('u-1', 'fpt')).id).toBe('rs1');
    expect(await c.API.asset.restricted.find('u-1', 'HPG')).toBeNull();
    expect((await c.API.asset.restricted.find('u-4', 'HPG')).id).toBe('rs2');
    expect(await c.API.asset.restricted.find('u-1', 'VCB')).toBeNull();
  });
  it('callGAS: đi đúng nhánh, lệnh ghi thuộc danh sách thay đổi dữ liệu', async () => {
    const c = boot(MANAGER, { finance_restricted_symbols: [RS()] });
    expect((await c.callGAS('listRestricted', {})).data).toHaveLength(1);
    expect((await c.callGAS('addRestricted', { email: MANAGER.email, restricted: { symbol: 'HPG', reason: 'đang nghiên cứu độc quyền' } })).status).toBe('success');
    expect((await c.callGAS('setRestrictedActive', { email: MANAGER.email, id: 'rs1', active: false })).status).toBe('success');
    expect(c.fake.table('finance_restricted_symbols').find(r => r.id === 'rs1').active).toBe(false);
    ['addRestricted', 'setRestrictedActive'].forEach(a => expect(Array.from(c.MUTATING)).toContain(a));
  });
});

describe('addTransaction: mã hạn chế', () => {
  it('mua mã hạn chế bị chặn RESTRICTED, không ghi gì; mã khác ghi bình thường', async () => {
    const c = boot(MEMBER, { finance_restricted_symbols: [RS()] });
    await expect(c.API.asset.addTransaction(MEMBER.email, BUY('FPT'))).rejects.toThrow(/^RESTRICTED/);
    expect(c.fake.table('finance_transactions')).toHaveLength(0);
    await c.API.asset.addTransaction(MEMBER.email, BUY('HPG'));
    expect(c.fake.table('finance_transactions')).toHaveLength(1);
  });
  it('bán mã hạn chế cũng bị chặn; hạn chế riêng của người khác không ảnh hưởng', async () => {
    const hold = [{ id: 't0', user_id: 'u-1', type: 'buy', symbol: 'FPT', quantity: 500, price: 100000, fee: 0, tax: 0, trade_date: '2026-01-02', created_at: '2026-01-02T00:00:00Z', deleted_at: null }];
    const c = boot(MEMBER, { finance_transactions: hold, finance_restricted_symbols: [RS()] });
    await expect(c.API.asset.addTransaction(MEMBER.email, { type: 'sell', symbol: 'FPT', quantity: 100, price: 100000, tradeDate: '2026-10-01' })).rejects.toThrow(/^RESTRICTED/);
    const d = boot(MEMBER, { finance_restricted_symbols: [RS({ user_id: 'u-4' })] });
    await d.API.asset.addTransaction(MEMBER.email, BUY('FPT'));
  });
  it('quản lý cũng không ghi được; gỡ hạn chế thì ghi được; điều chỉnh đối soát bỏ qua', async () => {
    const c = boot(MANAGER, { finance_restricted_symbols: [RS()] });
    await expect(c.API.asset.addTransaction(MANAGER.email, BUY('FPT'))).rejects.toThrow(/^RESTRICTED/);
    await c.API.asset.addTransaction(MANAGER.email, BUY('FPT', { skipRestrictedCheck: true, skipLimitCheck: true, skipApprovalCheck: true }));
    const off = boot(MANAGER, { finance_restricted_symbols: [RS({ active: false })] });
    await off.API.asset.addTransaction(MANAGER.email, BUY('FPT'));
  });
});
