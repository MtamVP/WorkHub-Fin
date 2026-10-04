// API.asset.limits + chặn/ghi lý do khi ghi lệnh vượt giới hạn (addTransaction), chạy CHÍNH api.js trên Supabase giả.
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
const BOSS = { id: 'u-2', email: 'sep@x.vn', nickname: 'Sếp', group_key: 'finance', active: true };
const today = new Date().toISOString().slice(0, 10);

function boot(seed = {}, actorEmail = MEMBER.email) {
  const base = {
    users: [MEMBER, BOSS], fin_roles: [{ user_id: 'u-2', role: 'asset_manager' }],
    finance_assets: [{ user_id: 'u-1', cash: 300e6, debt: 0, nav: 0 }],
    finance_transactions: [{ id: 't0', user_id: 'u-1', type: 'buy', symbol: 'FPT', quantity: 1000, price: 100000, fee: 0, tax: 0, trade_date: '2026-01-02', created_at: '2026-01-02T00:00:00Z', deleted_at: null }],
    finance_holdings_price: [{ user_id: 'u-1', symbol: 'FPT', market_price: 100000, price_date: today, price_source: 'x', updated_at: new Date().toISOString(), locked: false }],
  };
  const fake = createFakeSupabase(Object.assign(base, seed), { authUser: { email: actorEmail } });
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
  vm.runInContext(read('api.js') + '\n;this.API = API; this.callGAS = window.callGAS;', sandbox);
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS };
}
const LIM = (o) => Object.assign({ id: 'l' + Math.random().toString(36).slice(2, 6), scope: 'member', user_id: null, kind: 'max_symbol_pct', symbol: null, sector: null, value: 25, mode: 'reason', note: null, active: true, created_at: new Date().toISOString() }, o);
// NAV = 100tr FPT... (1000 cp x 100.000 = 100tr) + 300tr tiền = 400tr -> FPT 25% NAV
const BUY = (qty, extra = {}) => Object.assign({ type: 'buy', symbol: 'FPT', quantity: qty, price: 100000, tradeDate: today }, extra);

describe('API.asset.limits.save / list / remove', () => {
  it('quản lý đặt được giới hạn chung; thành viên thường thì không, nhưng tự đặt được giới hạn cá nhân', async () => {
    const boss = boot({}, BOSS.email);
    await boss.API.asset.limits.save(MEMBER.email, { scope: 'member', kind: 'max_symbol_pct', value: 30, mode: 'reason' });
    expect(boss.fake.table('finance_limits')).toHaveLength(1);
    expect(boss.fake.table('finance_limits')[0]).toMatchObject({ scope: 'member', user_id: null, value: 30, created_by: 'u-2' });

    const me = boot({}, MEMBER.email);
    await expect(me.API.asset.limits.save(MEMBER.email, { scope: 'member', kind: 'max_symbol_pct', value: 30 })).rejects.toThrow(/quản lý/);
    await me.API.asset.limits.save(MEMBER.email, { scope: 'user', kind: 'max_symbol_pct', value: 20, mode: 'warn' });
    expect(me.fake.table('finance_limits')[0]).toMatchObject({ scope: 'user', user_id: 'u-1', value: 20 });
    await expect(me.API.asset.limits.save(MEMBER.email, { scope: 'user', userId: 'u-2', kind: 'max_symbol_pct', value: 5 })).rejects.toThrow(/chính mình/);
    await expect(me.API.asset.limits.save(MEMBER.email, { scope: 'user', kind: 'max_symbol_pct', value: 500 })).rejects.toThrow(/0–100/);
  });
  it('sửa theo id, bật/tắt, xoá', async () => {
    const boss = boot({ finance_limits: [LIM({ id: 'x1', value: 30 })] }, BOSS.email);
    await boss.API.asset.limits.save(BOSS.email, { id: 'x1', scope: 'member', kind: 'max_symbol_pct', value: 40, mode: 'block' });
    expect(boss.fake.table('finance_limits')[0]).toMatchObject({ value: 40, mode: 'block' });
    await boss.API.asset.limits.setActive('x1', false);
    expect(boss.fake.table('finance_limits')[0].active).toBe(false);
    await boss.API.asset.limits.remove('x1');
    expect(boss.fake.table('finance_limits')).toHaveLength(0);
    expect(await boss.API.asset.limits.list()).toEqual([]);
  });
});

describe('API.asset.limits.checkTrade', () => {
  it('không có giới hạn nào -> trả nhanh (none) và không tải danh mục', async () => {
    const { API, fake } = boot();
    const r = await API.asset.limits.checkTrade(MEMBER.email, BUY(1000));
    expect(r).toMatchObject({ ok: true, none: true });
    expect(fake.log.filter(l => l.table === 'finance_holdings_price')).toHaveLength(0);
  });
  it('vượt giới hạn: trả vi phạm kèm mức trước/sau; trong giới hạn: ok', async () => {
    const { API } = boot({ finance_limits: [LIM({ value: 25 })] });
    const bad = await API.asset.limits.checkTrade(MEMBER.email, BUY(500));
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]).toMatchObject({ kind: 'max_symbol_pct', subject: 'FPT', mode: 'reason' });
    expect(bad.violations[0].after).toBeGreaterThan(25);
    expect(bad.needsReason).toBe(true);
    const fine = await API.asset.limits.checkTrade(MEMBER.email, { type: 'sell', symbol: 'FPT', quantity: 100, price: 100000 });
    expect(fine.ok).toBe(true);
  });
});

describe('addTransaction với giới hạn', () => {
  it('chế độ "lý do": thiếu lý do bị từ chối; có lý do thì lưu lệnh và ghi ngoại lệ', async () => {
    const { API, fake } = boot({ finance_limits: [LIM({ value: 25, mode: 'reason' })] });
    await expect(API.asset.addTransaction(MEMBER.email, BUY(500))).rejects.toThrow(/LIMIT_REASON_REQUIRED/);
    expect(fake.table('finance_transactions')).toHaveLength(1);
    await expect(API.asset.addTransaction(MEMBER.email, BUY(500, { exception: { reason: '  ' } }))).rejects.toThrow(/LIMIT_REASON_REQUIRED/);
    await API.asset.addTransaction(MEMBER.email, BUY(500, { exception: { reason: 'Cơ hội sau báo cáo quý, đã báo quản lý' } }));
    expect(fake.table('finance_transactions')).toHaveLength(2);
    const ex = fake.table('finance_limit_exceptions');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ user_id: 'u-1', kind: 'max_symbol_pct', symbol: 'FPT', mode: 'reason', override: false });
    expect(ex[0].reason).toMatch(/báo cáo quý/);
    expect(ex[0].metrics.after).toBeGreaterThan(25);
    expect(ex[0].txn_id).toBe(fake.table('finance_transactions')[1].id);
  });
  it('lệnh trong giới hạn không cần lý do, không ghi ngoại lệ', async () => {
    const { API, fake } = boot({ finance_limits: [LIM({ value: 30 })] });      // FPT đang 25% NAV: mua thêm 1 cp vẫn dưới 30%
    await API.asset.addTransaction(MEMBER.email, BUY(1));
    expect(fake.table('finance_limit_exceptions')).toHaveLength(0);
  });
  it('chế độ "chặn": thành viên thường bị chặn dù có lý do; quản lý ghi đè được kèm lý do và đánh dấu override', async () => {
    const seed = { finance_limits: [LIM({ value: 25, mode: 'block' })] };
    const me = boot(seed, MEMBER.email);
    await expect(me.API.asset.addTransaction(MEMBER.email, BUY(500, { exception: { reason: 'xin ngoại lệ' } }))).rejects.toThrow(/LIMIT_BLOCKED/);
    expect(me.fake.table('finance_transactions')).toHaveLength(1);
    const boss = boot(seed, BOSS.email);
    await expect(boss.API.asset.addTransaction(MEMBER.email, BUY(500))).rejects.toThrow(/LIMIT_BLOCKED/);       // quản lý cũng phải có lý do
    await boss.API.asset.addTransaction(MEMBER.email, BUY(500, { exception: { reason: 'Quản lý duyệt ngoại lệ theo biên bản họp' } }));
    expect(boss.fake.table('finance_transactions')).toHaveLength(2);
    expect(boss.fake.table('finance_limit_exceptions')[0]).toMatchObject({ mode: 'block', override: true });
  });
  it('chế độ "cảnh báo": lệnh qua bình thường; skipLimitCheck bỏ qua; bán không bị chặn', async () => {
    const warn = boot({ finance_limits: [LIM({ value: 25, mode: 'warn' })] });
    await warn.API.asset.addTransaction(MEMBER.email, BUY(500));
    expect(warn.fake.table('finance_transactions')).toHaveLength(2);
    expect(warn.fake.table('finance_limit_exceptions')).toHaveLength(0);
    const blocked = boot({ finance_limits: [LIM({ value: 25, mode: 'block' })] });
    await blocked.API.asset.addTransaction(MEMBER.email, BUY(500, { skipLimitCheck: true }));
    expect(blocked.fake.table('finance_transactions')).toHaveLength(2);
    const sell = boot({ finance_limits: [LIM({ value: 5, mode: 'block' })] });
    await sell.API.asset.addTransaction(MEMBER.email, { type: 'sell', symbol: 'FPT', quantity: 100, price: 100000, tradeDate: today });
    expect(sell.fake.table('finance_transactions')).toHaveLength(2);
  });
  it('giới hạn cá nhân tự đặt cũng được áp dụng cho chính mình; của người khác thì không', async () => {
    const mine = boot({ finance_limits: [LIM({ scope: 'user', user_id: 'u-1', value: 25, mode: 'reason' })] });
    await expect(mine.API.asset.addTransaction(MEMBER.email, BUY(500))).rejects.toThrow(/LIMIT_REASON_REQUIRED/);
    const others = boot({ finance_limits: [LIM({ scope: 'user', user_id: 'u-2', value: 5, mode: 'block' })] });
    await others.API.asset.addTransaction(MEMBER.email, BUY(500));
    expect(others.fake.table('finance_transactions')).toHaveLength(2);
  });
});

describe('importTransactions với giới hạn (nhập sao kê hàng loạt)', () => {
  // Nền: 1000 FPT x 100.000 = 100tr + 300tr tiền = NAV 400tr => FPT 25%. Trần 30%: nhập thêm 500 FPT (50tr) => 150tr/450tr = 33% => vượt.
  const row = (symbol, type, quantity, price, date = '2026-02-01', extra = {}) => Object.assign({ line: 1, date, symbol, type, quantity, price, fee: 0, tax: 0, ref: null, issues: [] }, extra);
  const rows = () => [row('FPT', 'buy', 500, 100000, '2026-02-01', { ref: 'IMP-1' })];

  it('previewImport trả limitCheck cho lô làm vượt giới hạn', async () => {
    const c = boot({ finance_limits: [LIM({ value: 30 })] });
    const p = await c.API.asset.previewImport(MEMBER.email, rows());
    expect(p.limitCheck.violations).toHaveLength(1);
    expect(p.limitCheck.needsReason).toBe(true);
    expect(p.fresh).toHaveLength(1);
  });
  it('vượt giới hạn mà không có lý do -> từ chối, không ghi gì', async () => {
    const c = boot({ finance_limits: [LIM({ value: 30 })] });
    await expect(c.API.asset.importTransactions(MEMBER.email, rows(), {})).rejects.toThrow(/LIMIT_REASON_REQUIRED/);
    expect(c.fake.table('finance_transactions')).toHaveLength(1);
  });
  it('có lý do -> nhập được và ghi ngoại lệ gắn mã lô', async () => {
    const c = boot({ finance_limits: [LIM({ value: 30 })] });
    const r = await c.API.asset.importTransactions(MEMBER.email, rows(), { exception: { reason: 'Bổ sung sao kê cũ đã được duyệt' } });
    expect(r.imported).toBe(1);
    expect(r.limitExceptions).toBe(1);
    const ex = c.fake.table('finance_limit_exceptions');
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ user_id: 'u-1', kind: 'max_symbol_pct', symbol: 'FPT', txn_id: null, reason: 'Bổ sung sao kê cũ đã được duyệt', override: false });
    expect(ex[0].metrics).toMatchObject({ source: 'statement-import', importBatch: r.batchId });
  });
  it('chế độ chặn: thành viên thường bị từ chối kể cả có lý do; quản lý ghi đè được và có dấu vết', async () => {
    const seed = () => ({ finance_limits: [LIM({ value: 30, mode: 'block' })], finance_assets: [{ user_id: 'u-1', cash: 300e6, debt: 0, nav: 0 }] });
    const me = boot(seed());
    await expect(me.API.asset.importTransactions(MEMBER.email, rows(), { exception: { reason: 'cho phép đi' } })).rejects.toThrow(/LIMIT_BLOCKED/);
    expect(me.fake.table('finance_transactions')).toHaveLength(1);
    const boss = boot(seed(), BOSS.email);
    const r = await boss.API.asset.importTransactions(MEMBER.email, rows(), { exception: { reason: 'Quản lý đồng ý vì sao kê quá khứ' } });
    expect(r.imported).toBe(1);
    expect(boss.fake.table('finance_limit_exceptions')[0].override).toBe(true);
  });
  it('chế độ cảnh báo, hoặc lô không làm vượt: nhập bình thường, không cần lý do', async () => {
    const warn = boot({ finance_limits: [LIM({ value: 30, mode: 'warn' })] });
    expect((await warn.API.asset.importTransactions(MEMBER.email, rows(), {})).imported).toBe(1);
    expect(warn.fake.table('finance_limit_exceptions')).toHaveLength(0);
    const ok = boot({ finance_limits: [LIM({ value: 60 })] });
    expect((await ok.API.asset.importTransactions(MEMBER.email, rows(), {})).imported).toBe(1);
  });
  it('không có giới hạn nào: nhập như cũ', async () => {
    const c = boot();
    const p = await c.API.asset.previewImport(MEMBER.email, rows());
    expect(p.limitCheck).toMatchObject({ ok: true, none: true });
    expect((await c.API.asset.importTransactions(MEMBER.email, rows(), {})).imported).toBe(1);
  });
});

describe('callGAS: lệnh giới hạn', () => {
  it('đi đúng nhánh; lệnh ghi thuộc danh sách thay đổi dữ liệu', async () => {
    const { callGAS } = boot({ finance_limits: [LIM()] }, BOSS.email);
    expect((await callGAS('listLimits', {})).data).toHaveLength(1);
    expect((await callGAS('listLimitExceptions', { days: 30 })).status).toBe('success');
    expect((await callGAS('getLimitActor', { email: BOSS.email })).data.isManager).toBe(true);
    expect((await callGAS('checkTradeLimits', { email: MEMBER.email, trade: BUY(1) })).status).toBe('success');
    const src = read('api.js');
    ['saveLimit', 'removeLimit', 'setLimitActive'].forEach(a => expect(src).toContain(`'${a}'`));
  });
});
