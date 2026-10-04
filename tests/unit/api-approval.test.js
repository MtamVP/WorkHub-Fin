// Duyệt lệnh lớn: API.asset.approvalPolicy / orders và việc ép trong addTransaction, chạy CHÍNH api.js trên Supabase giả.
// (Trigger DB chặn tự duyệt đã được kiểm bằng người dùng giả lập trên DB thật, xem finance-approval-migration.sql; ở đây kiểm phía ứng dụng.)
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
const MANAGER = { id: 'u-2', email: 'mgr@x.vn', nickname: 'Quản lý', group_key: 'finance', active: true };
const ADMIN = { id: 'u-3', email: 'adm@x.vn', nickname: 'Admin', group_key: 'admin', active: true };
const today = new Date().toISOString().slice(0, 10);
const plus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// Danh mục: 1.000 FPT x 100.000 = 100tr + 300tr tiền mặt -> NAV 400tr
function boot(actor = MEMBER, seed = {}) {
  const base = {
    users: [MEMBER, MANAGER, ADMIN], fin_roles: [{ user_id: 'u-2', role: 'asset_manager' }],
    finance_assets: [{ user_id: 'u-1', cash: 300e6, debt: 0, nav: 0 }],
    finance_transactions: [{ id: 't0', user_id: 'u-1', type: 'buy', symbol: 'FPT', quantity: 1000, price: 100000, fee: 0, tax: 0, trade_date: '2026-01-02', created_at: '2026-01-02T00:00:00Z', deleted_at: null }],
    finance_holdings_price: [{ user_id: 'u-1', symbol: 'FPT', market_price: 100000 }],
    finance_approval_policy: [{ id: 1, active: true, threshold_pct: 10, threshold_vnd: null, valid_days: 3 }],
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
const BUY = (qty, price = 100000, extra = {}) => Object.assign({ type: 'buy', symbol: 'HPG', quantity: qty, price, tradeDate: '2026-10-01' }, extra);
const approved = (o = {}) => Object.assign({ id: 'r1', user_id: 'u-1', symbol: 'HPG', side: 'buy', quantity: 500, price_ref: 100000, value: 50e6, status: 'approved', valid_until: plus(2), decided_at: new Date().toISOString(), created_at: new Date().toISOString() }, o);

describe('quy định duyệt lệnh', () => {
  it('đọc quy định; chưa có dòng nào thì mặc định tắt', async () => {
    expect(await boot().API.asset.approvalPolicy.get()).toMatchObject({ active: true, thresholdPct: 10, validDays: 3 });
    expect(await boot(MEMBER, { finance_approval_policy: [] }).API.asset.approvalPolicy.get()).toMatchObject({ active: false });
  });
  it('chỉ quản lý lưu được; thành viên bị từ chối; sai dữ liệu bị từ chối', async () => {
    await expect(boot(MEMBER).API.asset.approvalPolicy.save(MEMBER.email, { active: true, thresholdPct: 5 })).rejects.toThrow(/Chỉ quản lý/);
    const m = boot(MANAGER);
    await expect(m.API.asset.approvalPolicy.save(MANAGER.email, { active: true })).rejects.toThrow(/ít nhất một ngưỡng/);
    expect(await m.API.asset.approvalPolicy.save(MANAGER.email, { active: true, thresholdPct: 5, thresholdVnd: 80e6, validDays: 5 })).toMatch(/bật/);
    expect(m.fake.table('finance_approval_policy')[0]).toMatchObject({ id: 1, active: true, threshold_pct: 5, threshold_vnd: 80e6, valid_days: 5, updated_by: 'u-2' });
  });
});

describe('addTransaction: ép đề xuất đã duyệt', () => {
  it('lệnh nhỏ (dưới ngưỡng) ghi bình thường', async () => {
    const c = boot();
    await c.API.asset.addTransaction(MEMBER.email, BUY(300));                    // 30tr = 7,5% NAV
    expect(c.fake.table('finance_transactions')).toHaveLength(2);
  });
  it('lệnh lớn không có đề xuất: bị chặn APPROVAL_REQUIRED, không ghi gì', async () => {
    const c = boot();
    await expect(c.API.asset.addTransaction(MEMBER.email, BUY(500))).rejects.toThrow(/^APPROVAL_REQUIRED/);   // 50tr = 12,5% NAV
    expect(c.fake.table('finance_transactions')).toHaveLength(1);
  });
  it('có đề xuất đã duyệt khớp: ghi được và đề xuất chuyển sang đã thực hiện, gắn mã lệnh', async () => {
    const c = boot(MEMBER, { finance_order_requests: [approved()] });
    await c.API.asset.addTransaction(MEMBER.email, BUY(500));
    const txn = c.fake.table('finance_transactions').find(t => t.symbol === 'HPG');
    expect(txn).toBeTruthy();
    expect(c.fake.table('finance_order_requests')[0]).toMatchObject({ status: 'executed', txn_id: txn.id });
    // dùng lại đề xuất đã thực hiện thì không được
    await expect(c.API.asset.addTransaction(MEMBER.email, BUY(500))).rejects.toThrow(/^APPROVAL_REQUIRED/);
  });
  it('đề xuất không khớp (mã khác, hết hạn, chưa duyệt, vượt khối lượng) không mở được lệnh', async () => {
    for (const r of [approved({ symbol: 'VCB' }), approved({ valid_until: plus(-1) }), approved({ status: 'pending' }), approved({ quantity: 400, value: 40e6 })]) {
      const c = boot(MEMBER, { finance_order_requests: [r] });
      await expect(c.API.asset.addTransaction(MEMBER.email, BUY(500))).rejects.toThrow(/^APPROVAL_REQUIRED/);
    }
  });
  it('quy định tắt hoặc skipApprovalCheck: không kiểm', async () => {
    const off = boot(MEMBER, { finance_approval_policy: [{ id: 1, active: false, threshold_pct: 10, valid_days: 3 }] });
    await off.API.asset.addTransaction(MEMBER.email, BUY(500));
    const c = boot();
    await c.API.asset.addTransaction(MEMBER.email, BUY(500, 100000, { skipApprovalCheck: true }));
    expect(c.fake.table('finance_transactions')).toHaveLength(2);
  });
  it('lệnh bán lớn cũng cần duyệt; ngưỡng số tiền tuyệt đối', async () => {
    const c = boot(MEMBER, { finance_approval_policy: [{ id: 1, active: true, threshold_pct: null, threshold_vnd: 40e6, valid_days: 3 }] });
    await expect(c.API.asset.addTransaction(MEMBER.email, { type: 'sell', symbol: 'FPT', quantity: 500, price: 100000, tradeDate: '2026-10-01' })).rejects.toThrow(/^APPROVAL_REQUIRED/);
    await c.API.asset.addTransaction(MEMBER.email, { type: 'sell', symbol: 'FPT', quantity: 300, price: 100000, tradeDate: '2026-10-01' });   // 30tr
  });
});

describe('orders: đề xuất, duyệt, huỷ', () => {
  it('thành viên tạo đề xuất kèm NAV và % NAV; thiếu lý do bị từ chối', async () => {
    const c = boot();
    await expect(c.API.asset.orders.create(MEMBER.email, { symbol: 'HPG', side: 'buy', quantity: 500, price: 100000, reason: 'ngắn' })).rejects.toThrow(/lý do/);
    await c.API.asset.orders.create(MEMBER.email, { symbol: 'hpg', side: 'buy', quantity: 500, price: 100000, reason: 'Định giá thấp, thanh khoản tốt' });
    const row = c.fake.table('finance_order_requests')[0];
    expect(row).toMatchObject({ user_id: 'u-1', symbol: 'HPG', status: 'pending', value: 50e6, nav_at_request: 400e6 });
    expect(row.order_pct).toBeCloseTo(12.5, 6);
    expect((await c.API.asset.orders.list(MEMBER.email))).toHaveLength(1);
  });
  it('đề xuất gắn ý tưởng (ideaId hợp lệ mới được lưu)', async () => {
    const c = boot();
    const id = '11111111-2222-4333-8444-555555555555';
    await c.API.asset.orders.create(MEMBER.email, { symbol: 'HPG', side: 'buy', quantity: 500, price: 100000, reason: 'Theo ý tưởng đã duyệt của nhóm', ideaId: id });
    await c.API.asset.orders.create(MEMBER.email, { symbol: 'HPG', side: 'buy', quantity: 500, price: 100000, reason: 'Không gắn ý tưởng nào hết', ideaId: 'not-a-uuid' });
    const rows = c.fake.table('finance_order_requests');
    expect(rows[0].idea_id).toBe(id);
    expect(rows[1].idea_id).toBeUndefined();
  });
  it('quản lý duyệt: có hạn dùng theo quy định; từ chối cần lý do', async () => {
    const c = boot(MANAGER, { finance_order_requests: [{ id: 'r1', user_id: 'u-1', symbol: 'HPG', side: 'buy', quantity: 500, price_ref: 100000, value: 50e6, status: 'pending', created_at: new Date().toISOString() }] });
    await expect(c.API.asset.orders.decide(MANAGER.email, 'r1', 'rejected', '')).rejects.toThrow(/lý do/);
    expect(await c.API.asset.orders.decide(MANAGER.email, 'r1', 'approved', 'OK')).toMatch(/Đã duyệt/);
    expect(c.fake.table('finance_order_requests')[0]).toMatchObject({ status: 'approved', valid_until: plus(3), decision_note: 'OK' });
    await expect(c.API.asset.orders.decide(MANAGER.email, 'r1', 'approved', '')).rejects.toThrow(/không còn ở trạng thái chờ/);
  });
  it('nguyên tắc hai người: quản lý/thành viên không tự duyệt; admin tự duyệt phải có lý do dài', async () => {
    const own = (uid) => [{ id: 'r1', user_id: uid, symbol: 'HPG', side: 'buy', quantity: 1, price_ref: 1, value: 1, status: 'pending', created_at: new Date().toISOString() }];
    await expect(boot(MEMBER, { finance_order_requests: own('u-1') }).API.asset.orders.decide(MEMBER.email, 'r1', 'approved', 'tôi duyệt')).rejects.toThrow(/Chỉ quản lý/);
    await expect(boot(MANAGER, { finance_order_requests: own('u-2') }).API.asset.orders.decide(MANAGER.email, 'r1', 'approved', 'tự duyệt cho nhanh')).rejects.toThrow(/hai người/);
    const adm = boot(ADMIN, { finance_order_requests: own('u-3') });
    await expect(adm.API.asset.orders.decide(ADMIN.email, 'r1', 'approved', 'ngắn')).rejects.toThrow(/lý do/);
    await adm.API.asset.orders.decide(ADMIN.email, 'r1', 'approved', 'Không còn quản lý nào khác trực');
    expect(adm.fake.table('finance_order_requests')[0].status).toBe('approved');
  });
  it('người trong danh sách miễn (do admin đặt) tự duyệt được với lý do; admin mới đặt được danh sách', async () => {
    const own = [{ id: 'r1', user_id: 'u-2', symbol: 'HPG', side: 'buy', quantity: 1, price_ref: 1, value: 1, status: 'pending', created_at: new Date().toISOString() }];
    const pol = [{ id: 1, active: true, threshold_pct: 10, valid_days: 3, self_approvers: ['u-2'] }];
    const c = boot(MANAGER, { finance_order_requests: own, finance_approval_policy: pol });
    await expect(c.API.asset.orders.decide(MANAGER.email, 'r1', 'approved', 'ngắn')).rejects.toThrow(/lý do/);
    await c.API.asset.orders.decide(MANAGER.email, 'r1', 'approved', 'Chủ dự án uỷ quyền tự duyệt');
    expect(c.fake.table('finance_order_requests')[0].status).toBe('approved');
    await expect(c.API.asset.approvalPolicy.setSelfApprovers(MANAGER.email, ['u-1'])).rejects.toThrow(/Chỉ admin/);
    const adm = boot(ADMIN, { finance_approval_policy: pol });
    expect(await adm.API.asset.approvalPolicy.setSelfApprovers(ADMIN.email, ['u-2', 'u-2', 'u-1'])).toMatch(/2/);
    expect(adm.fake.table('finance_approval_policy')[0].self_approvers).toEqual(['u-2', 'u-1']);
    expect((await adm.API.asset.approvalPolicy.get()).selfApprovers).toEqual(['u-2', 'u-1']);
  });
  it('kiểm tra độc lập: liệt kê bản ghi; chỉ quản lý đánh dấu đã xem xét và phải ghi chú', async () => {
    const rows = [{ id: 'a1', user_id: 'u-1', symbol: 'FPT', side: 'buy', value: 100e6, status: 'open', detected_at: new Date().toISOString() }, { id: 'a0', user_id: 'u-1', symbol: 'VCB', side: 'buy', value: 90e6, status: 'open', detected_at: '2024-01-01T00:00:00Z' }];
    const m = boot(MEMBER, { finance_approval_audit: rows });
    expect((await m.API.asset.approvalAudit.list(30)).map(r => r.id)).toEqual(['a1']);
    await expect(m.API.asset.approvalAudit.review(MEMBER.email, 'a1', 'đã xem')).rejects.toThrow(/Chỉ quản lý/);
    const c = boot(MANAGER, { finance_approval_audit: rows });
    await expect(c.API.asset.approvalAudit.review(MANAGER.email, 'a1', 'x')).rejects.toThrow(/ít nhất 3/);
    expect(await c.API.asset.approvalAudit.review(MANAGER.email, 'a1', 'Đã nhắc nhở, lần sau gửi đề xuất')).toMatch(/Đã đánh dấu/);
    expect(c.fake.table('finance_approval_audit').find(r => r.id === 'a1')).toMatchObject({ status: 'reviewed', review_note: 'Đã nhắc nhở, lần sau gửi đề xuất' });
    await expect(c.API.asset.approvalAudit.review(MANAGER.email, 'a1', 'lần hai ok')).rejects.toThrow(/đã được xem xét/);
  });
  it('huỷ đề xuất đang chờ; không huỷ được đề xuất đã thực hiện', async () => {
    const c = boot(MEMBER, { finance_order_requests: [approved({ id: 'a', status: 'pending' }), approved({ id: 'b', status: 'executed' })] });
    expect(await c.API.asset.orders.cancel('a')).toMatch(/huỷ/);
    await expect(c.API.asset.orders.cancel('b')).rejects.toThrow(/không còn huỷ/);
  });
  it('listAll: gồm đề xuất đang chờ dù cũ và đề xuất gần đây, không trùng', async () => {
    const old = '2025-01-01T00:00:00Z';
    const c = boot(MANAGER, { finance_order_requests: [approved({ id: 'old-pending', status: 'pending', created_at: old }), approved({ id: 'old-done', status: 'executed', created_at: old }), approved({ id: 'new' })] });
    const all = await c.API.asset.orders.listAll(30);
    expect(all.map(r => r.id).sort()).toEqual(['new', 'old-pending']);
  });
  it('callGAS có các hành động mới và đánh dấu là thay đổi dữ liệu', async () => {
    const c = boot(MANAGER);
    for (const a of ['saveApprovalPolicy', 'createOrderRequest', 'decideOrderRequest', 'cancelOrderRequest']) expect(c.MUTATING.has(a)).toBe(true);
    const r = await c.callGAS('getApprovalPolicy', {});
    expect(r.status).toBe('success');
    expect(r.data.active).toBe(true);
  });
});
