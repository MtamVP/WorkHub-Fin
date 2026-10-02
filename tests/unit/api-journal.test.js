// Chạy CHÍNH api.js (API.asset.journal.*) trên Supabase giả: ghi / sửa / xoá quyết định, đánh giá lại, lệnh chưa có nhật ký,
// và lưu kế hoạch ngay khi thêm lệnh giao dịch.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js'];

const USER = 'u-1', EMAIL = 'toi@example.com';

function boot(seed = {}, opts = {}, withLib = true) {
  const fake = createFakeSupabase(Object.assign({ users: [{ id: USER, email: EMAIL, nickname: 'toi' }], finance_assets: [{ user_id: USER, cash: 0, debt: 0, nav: 0 }] }, seed), opts);
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
  if (!withLib) vm.runInContext('DecisionJournal = undefined;', sandbox); // mô phỏng trang chưa nạp thư viện nhật ký
  vm.runInContext(read('api.js') + '\n;this.API = API; this.callGAS = window.callGAS;', sandbox);
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS };
}

const D = (o) => Object.assign({ symbol: 'FPT', action: 'buy', date: '2026-09-01', price: 100000, quantity: 100, reason: 'Tăng trưởng đều, định giá hợp lý', expected: 130000, stop: 90000, horizonMonths: 12 }, o || {});

describe('API.asset.journal: ghi / sửa / xoá', () => {
  it('thêm quyết định, danh sách mới trước, mã chữ hoa', async () => {
    const { API, fake } = boot();
    await API.asset.journal.save(EMAIL, D({ symbol: 'fpt', date: '2026-09-01' }));
    await API.asset.journal.save(EMAIL, D({ symbol: 'VCB', date: '2026-09-10', action: 'skip', price: 90000, expected: null, stop: null }));
    expect(fake.table('finance_decisions')).toHaveLength(2);
    const list = await API.asset.journal.list(EMAIL);
    expect(list.map(r => r.symbol)).toEqual(['VCB', 'FPT']);
    expect(list[1]).toMatchObject({ action: 'buy', price_at_decision: 100000, expected_price: 130000, stop_price: 90000, horizon_months: 12, user_id: USER });
  });
  it('dữ liệu xấu bị từ chối với lý do tiếng Việt; không lưu gì', async () => {
    const { API, fake } = boot();
    await expect(API.asset.journal.save(EMAIL, D({ stop: 120000 }))).rejects.toThrow(/cắt lỗ phải thấp hơn/);
    await expect(API.asset.journal.save(EMAIL, D({ symbol: 'a;b' }))).rejects.toThrow(/Mã/);
    await expect(API.asset.journal.save('la@example.com', D())).rejects.toThrow(/không tồn tại/);
    expect(fake.table('finance_decisions')).toHaveLength(0);
  });
  it('sửa theo id; sửa tay không gỡ liên kết với lệnh', async () => {
    const { API, fake } = boot({ finance_transactions: [{ id: 't1', user_id: USER, type: 'buy', symbol: 'FPT', quantity: 100, price: 100000, trade_date: '2026-09-01', created_at: '2026-09-01T01:00:00Z', fee: 0, tax: 0, deleted_at: null }] });
    await API.asset.journal.save(EMAIL, D({ txnId: 't1' }));
    const id = fake.table('finance_decisions')[0].id;
    await API.asset.journal.save(EMAIL, D({ id, reason: 'Lý do đã sửa lại rõ hơn nhiều' }));
    const rows = fake.table('finance_decisions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'Lý do đã sửa lại rõ hơn nhiều', txn_id: 't1' });
  });
  it('mỗi lệnh chỉ 1 quyết định: lưu lại cùng txnId thì cập nhật, không tạo trùng', async () => {
    const { API, fake } = boot();
    await API.asset.journal.save(EMAIL, D({ txnId: 't9' }));
    await API.asset.journal.save(EMAIL, D({ txnId: 't9', expected: 140000 }));
    expect(fake.table('finance_decisions')).toHaveLength(1);
    expect(fake.table('finance_decisions')[0].expected_price).toBe(140000);
  });
  it('xoá là xoá mềm: biến khỏi danh sách nhưng còn trong DB', async () => {
    const { API, fake } = boot();
    await API.asset.journal.save(EMAIL, D());
    await API.asset.journal.remove(EMAIL, fake.table('finance_decisions')[0].id);
    expect(await API.asset.journal.list(EMAIL)).toEqual([]);
    expect(fake.table('finance_decisions')[0].deleted_at).toBeTruthy();
  });
  it('đánh giá lại: điểm 1-5 bắt buộc; lưu nhận xét, bài học và ngày', async () => {
    const { API, fake } = boot();
    await API.asset.journal.save(EMAIL, D());
    const id = fake.table('finance_decisions')[0].id;
    await expect(API.asset.journal.saveReview(EMAIL, id, { rating: 0 })).rejects.toThrow(/1 đến 5/);
    await API.asset.journal.saveReview(EMAIL, id, { rating: 4, note: 'Đúng luận điểm', lesson: 'Kiên nhẫn hơn' });
    expect(fake.table('finance_decisions')[0]).toMatchObject({ review_rating: 4, review_note: 'Đúng luận điểm', lesson: 'Kiên nhẫn hơn' });
    expect(fake.table('finance_decisions')[0].review_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('thiếu thư viện nhật ký thì báo lỗi rõ', async () => {
    const { API } = boot({}, {}, false);
    await expect(API.asset.journal.save(EMAIL, D())).rejects.toThrow(/lib\/decision-journal/);
  });
});

describe('lệnh chưa có nhật ký', () => {
  const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const T = (id, d, extra) => Object.assign({ id, user_id: USER, type: 'buy', symbol: 'FPT', quantity: 100, price: 100000, trade_date: d, created_at: d + 'T01:00:00Z', fee: 0, tax: 0, deleted_at: null }, extra || {});
  it('chỉ lệnh gần đây và chưa gắn quyết định; quyết định đã xoá không tính là đã ghi', async () => {
    const { API, fake } = boot({ finance_transactions: [T('t1', iso(-5)), T('t2', iso(-10), { symbol: 'VCB' }), T('t3', iso(-100), { symbol: 'HPG' }), T('t4', iso(-3), { symbol: 'SSI' })] });
    await API.asset.journal.save(EMAIL, D({ txnId: 't1', date: iso(-5) }));
    await API.asset.journal.save(EMAIL, D({ txnId: 't4', symbol: 'SSI', date: iso(-3) }));
    await API.asset.journal.remove(EMAIL, fake.table('finance_decisions').find(r => r.txn_id === 't4').id);
    const list = await API.asset.journal.unplannedTrades(EMAIL, 45);
    expect(list.map(x => x.id).sort()).toEqual(['t2', 't4']);
    expect(list.find(x => x.id === 't2')).toMatchObject({ symbol: 'VCB', type: 'buy', quantity: 100, price: 100000 });
  });
});

describe('thêm lệnh kèm kế hoạch', () => {
  it('lệnh mua có decision: tạo lệnh rồi tạo quyết định gắn đúng lệnh, lấy mã/giá/ngày từ chính lệnh', async () => {
    const { API, fake } = boot();
    const msg = await API.asset.addTransaction(EMAIL, { type: 'buy', symbol: 'fpt', quantity: 100, price: 100000, tradeDate: '2026-09-01', decision: { reason: 'Tăng trưởng đều, định giá hợp lý', expected: 130000, stop: 90000, horizonMonths: 12, confidence: 4 } });
    expect(msg).toBe('Đã lưu lệnh giao dịch!');
    const txn = fake.table('finance_transactions')[0];
    const dec = fake.table('finance_decisions')[0];
    expect(dec).toMatchObject({ symbol: 'FPT', action: 'buy', decided_at: '2026-09-01', price_at_decision: 100000, quantity: 100, txn_id: txn.id, expected_price: 130000, stop_price: 90000 });
  });
  it('kế hoạch sai (cắt lỗ cao hơn giá) KHÔNG làm hỏng lệnh: lệnh vẫn lưu, thông báo nói rõ', async () => {
    const { API, fake } = boot();
    const msg = await API.asset.addTransaction(EMAIL, { type: 'buy', symbol: 'FPT', quantity: 100, price: 100000, tradeDate: '2026-09-01', decision: { reason: 'Lý do đủ dài', stop: 150000 } });
    expect(msg).toMatch(/chưa lưu được nhật ký.*cắt lỗ/);
    expect(fake.table('finance_transactions')).toHaveLength(1);
    expect(fake.table('finance_decisions')).toHaveLength(0);
  });
  it('không có decision: hành vi cũ không đổi; lệnh bán có decision ghi hành động bán', async () => {
    const { API, fake } = boot();
    expect(await API.asset.addTransaction(EMAIL, { type: 'buy', symbol: 'FPT', quantity: 100, price: 100000, tradeDate: '2026-09-01' })).toBe('Đã lưu lệnh giao dịch!');
    expect(fake.table('finance_decisions')).toHaveLength(0);
    await API.asset.addTransaction(EMAIL, { type: 'sell', symbol: 'FPT', quantity: 50, price: 120000, tradeDate: '2026-09-20', decision: { reason: 'Chốt lời một phần vì gần mục tiêu' } });
    expect(fake.table('finance_decisions')[0]).toMatchObject({ action: 'sell', price_at_decision: 120000, quantity: 50 });
  });
  it('callGAS: các lệnh nhật ký đi đúng nhánh và được đánh dấu là thay đổi dữ liệu', async () => {
    const { callGAS, fake } = boot();
    const s = await callGAS('saveDecision', { email: EMAIL, decision: D() });
    expect(s.status).toBe('success');
    const l = await callGAS('listDecisions', { email: EMAIL });
    expect(l.data).toHaveLength(1);
    await callGAS('deleteDecision', { email: EMAIL, id: fake.table('finance_decisions')[0].id });
    expect((await callGAS('listDecisions', { email: EMAIL })).data).toHaveLength(0);
    const src = read('api.js');
    ['saveDecision', 'saveDecisionReview', 'deleteDecision'].forEach(a => expect(src).toContain(`'${a}'`));
  });
});
