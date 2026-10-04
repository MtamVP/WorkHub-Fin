// API.asset.events: tải sự kiện doanh nghiệp, ghi theo xác nhận, ẩn/hiện lại -- chạy CHÍNH api.js trên Supabase giả.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/corporate-events.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js'];
const USER = 'u-1', EMAIL = 'toi@example.com';

function boot(seed = {}, fakeOpts = {}) {
  const fake = createFakeSupabase(Object.assign({ users: [{ id: USER, email: EMAIL, nickname: 'toi' }], finance_assets: [{ user_id: USER, cash: 0, debt: 0, nav: 0 }] }, seed), fakeOpts);
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

const txn = (id, type, symbol, quantity, price, trade_date) => ({ id, user_id: USER, type, symbol, quantity, price, fee: 0, tax: 0, trade_date, created_at: trade_date + 'T01:00:00Z', deleted_at: null });
const ev = (o) => Object.assign({ payDate: null, dps: null, ratio: null, price: null, divYear: 2025, period: null, note: '' }, o);
const CASH = ev({ id: 'c1', symbol: 'FPT', kind: 'cash_dividend', exDate: '2026-05-28', payDate: '2026-06-10', dps: 1000, note: 'Cổ tức đợt 2/2025' });
const BONUS = ev({ id: 's1', symbol: 'FPT', kind: 'bonus', exDate: '2026-03-01', ratio: 10, note: 'Tỷ lệ 100:10' });
const SEED = { finance_transactions: [txn('t1', 'buy', 'FPT', 1000, 100000, '2026-01-10')] };
const fnOf = (events, errors = {}) => ({ 'stock-events': async () => ({ data: { ok: true, events, errors }, error: null }) });

describe('API.asset.events.load', () => {
  it('gọi Edge Function với mọi mã từng giao dịch + ngày đầu tiên, rồi đối chiếu sổ lệnh', async () => {
    const { API, fake } = boot(SEED, { functions: fnOf([CASH, BONUS]) });
    const r = await API.asset.events.load(EMAIL);
    const call = fake.functionCalls.find(c => c.name === 'stock-events');
    expect(call.body).toEqual({ symbols: ['FPT'], since: '2026-01-10' });
    expect(r.summary.pending).toBe(2);
    expect(r.items.find(i => i.event.id === 'c1').quantity).toBeCloseTo(1100, 6);   // đã tính đợt thưởng trước đó
  });
  it('chưa có giao dịch nào -> không gọi nguồn, trả danh sách rỗng', async () => {
    const { API, fake } = boot({}, { functions: fnOf([]) });
    const r = await API.asset.events.load(EMAIL);
    expect(r.items).toEqual([]);
    expect(r.empty).toBe(true);
    expect(fake.functionCalls.length).toBe(0);
  });
  it('hàm lỗi hẳn -> ném lỗi với lý do', async () => {
    const { API } = boot(SEED, { functions: { 'stock-events': async () => ({ data: null, error: { message: 'down' } }) } });
    await expect(API.asset.events.load(EMAIL)).rejects.toThrow(/down/);
  });
});

describe('API.asset.events.apply', () => {
  it('ghi cổ phiếu thưởng vào hành động DN và cổ tức tiền vào Dòng Tiền (sau thuế), cộng tiền mặt', async () => {
    const { API, fake } = boot(SEED, { functions: fnOf([CASH, BONUS]) });
    const { events } = await API.asset.events.load(EMAIL);
    const out = await API.asset.events.apply(EMAIL, events, ['c1', 's1']);
    expect(out).toMatchObject({ cash: 1, stock: 1, skipped: 0 });
    const act = fake.table('finance_corporate_actions');
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ symbol: 'FPT', action_type: 'stock_dividend', ex_date: '2026-03-01' });
    expect(Number(act[0].ratio)).toBeCloseTo(0.1, 9);
    const flows = fake.table('finance_cash_flows');
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ flow_type: 'dividend', symbol: 'FPT', flow_date: '2026-06-10' });
    expect(Number(flows[0].amount)).toBe(1045000);      // 1.100 cp x 1.000đ x 95%
    expect(flows[0].note).toContain('#c1');
    expect(Number(fake.table('finance_assets')[0].cash)).toBe(1045000);
  });
  it('bấm lần 2 không ghi trùng (sự kiện đã ghi bị bỏ qua)', async () => {
    const { API, fake } = boot(SEED, { functions: fnOf([CASH, BONUS]) });
    const { events } = await API.asset.events.load(EMAIL);
    await API.asset.events.apply(EMAIL, events, ['c1', 's1']);
    const again = await API.asset.events.apply(EMAIL, events, ['c1', 's1']);
    expect(again).toMatchObject({ cash: 0, stock: 0, skipped: 2 });
    expect(fake.table('finance_cash_flows')).toHaveLength(1);
    expect(fake.table('finance_corporate_actions')).toHaveLength(1);
  });
  it('chỉ ghi sự kiện được chọn; afterTax=false ghi số gộp', async () => {
    const { API, fake } = boot(SEED, { functions: fnOf([CASH, BONUS]) });
    const { events } = await API.asset.events.load(EMAIL);
    await API.asset.events.apply(EMAIL, events, ['c1'], { afterTax: false });
    expect(fake.table('finance_corporate_actions')).toHaveLength(0);
    expect(Number(fake.table('finance_cash_flows')[0].amount)).toBe(1100000);
  });
  it('sự kiện chưa tới hạn hoặc quyền mua không bao giờ được ghi', async () => {
    const future = ev({ id: 'f1', symbol: 'FPT', kind: 'cash_dividend', exDate: '2999-01-01', payDate: '2999-02-01', dps: 1000 });
    const rights = ev({ id: 'r1', symbol: 'FPT', kind: 'rights', exDate: '2026-02-01', ratio: 20, price: 15000, note: 'cho CĐHH' });
    const { API, fake } = boot(SEED, { functions: fnOf([future, rights]) });
    const { events } = await API.asset.events.load(EMAIL);
    const out = await API.asset.events.apply(EMAIL, events, ['f1', 'r1']);
    expect(out).toMatchObject({ cash: 0, stock: 0, skipped: 2 });
    expect(fake.table('finance_cash_flows')).toHaveLength(0);
  });
});

describe('API.asset.events.dismiss / restore', () => {
  it('ẩn rồi hiện lại; ẩn 2 lần không lỗi; sự kiện ẩn không còn ở trạng thái cần xử lý', async () => {
    const { API, fake } = boot(SEED, { functions: fnOf([CASH]) });
    const first = await API.asset.events.load(EMAIL);
    await API.asset.events.dismiss(EMAIL, first.events[0]);
    await API.asset.events.dismiss(EMAIL, first.events[0]);
    expect(fake.table('finance_event_dismissals')).toHaveLength(1);
    expect((await API.asset.events.load(EMAIL)).summary).toMatchObject({ pending: 0, dismissed: 1 });
    await API.asset.events.restore(EMAIL, 'c1');
    expect((await API.asset.events.load(EMAIL)).summary.pending).toBe(1);
  });
});

describe('callGAS: lệnh sự kiện doanh nghiệp', () => {
  it('đi đúng nhánh; lệnh ghi nằm trong danh sách thay đổi dữ liệu', async () => {
    const { callGAS } = boot(SEED, { functions: fnOf([CASH]) });
    const r = await callGAS('loadCorporateEvents', { email: EMAIL });
    expect(r.status).toBe('success');
    expect(r.data.summary.pending).toBe(1);
    const src = read('api.js');
    ['applyCorporateEvents', 'dismissCorporateEvent', 'restoreCorporateEvent'].forEach(a => expect(src).toContain(`'${a}'`));
  });
});
