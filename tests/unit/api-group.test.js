// API.asset.getGroupData / _fetchAll / getMarketInputs: dữ liệu cấp nhóm.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/corporate-events.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js'];

function boot(seed = {}, fakeOpts = {}) {
  const fake = createFakeSupabase(seed, fakeOpts);
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

const USERS = [
  { id: 'u1', email: 'an@x.vn', nickname: 'An', group_key: 'finance', active: true },
  { id: 'u2', email: 'binh@x.vn', nickname: null, group_key: 'admin', active: true },
  { id: 'u3', email: 'cuu@x.vn', nickname: 'Cựu', group_key: 'finance', active: false },    // đã vô hiệu hoá
  { id: 'u4', email: 'khoa@x.vn', nickname: 'Khoa', group_key: 'science', active: true },    // nhóm khác
];
const tx = (i, user_id) => ({ id: 't' + i, user_id, type: 'buy', symbol: 'FPT', quantity: 1, price: 1, fee: 0, tax: 0, trade_date: '2026-01-01', created_at: '2026-01-01T00:00:00Z', deleted_at: null });

describe('API.asset.getGroupData', () => {
  it('chỉ lấy thành viên finance/admin đang hoạt động; dữ liệu của người khác không lẫn vào', async () => {
    const { API } = boot({
      users: USERS,
      finance_transactions: [tx(1, 'u1'), tx(2, 'u2'), tx(3, 'u3'), tx(4, 'u4')],
      finance_assets: USERS.map(u => ({ user_id: u.id, cash: 1, debt: 0, nav: 1 })),
      finance_holdings_price: [{ user_id: 'u1', symbol: 'FPT', market_price: 1, price_date: '2026-10-01', updated_at: 'x' }],
      finance_nav_history: [{ user_id: 'u1', snapshot_date: '2026-10-01', nav: 5, net_contributed: 5, cash: 1, market_value: 4 }],
    });
    const g = await API.asset.getGroupData();
    expect(g.members.map(m => m.email)).toEqual(['an@x.vn', 'binh@x.vn']);
    expect(g.txns.map(t => t.user_id).sort()).toEqual(['u1', 'u2']);
    expect(g.assets).toHaveLength(2);
    expect(g.prices).toHaveLength(1);
    expect(g.navHistory).toHaveLength(1);
    expect(g.fetchedAt).toBeTruthy();
  });
  it('đọc hết bảng lớn qua nhiều trang (> 1.000 dòng)', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => tx(i, i % 2 ? 'u1' : 'u2'));
    const { API } = boot({ users: USERS, finance_transactions: rows });
    const g = await API.asset.getGroupData();
    expect(g.txns).toHaveLength(2500);
    expect(new Set(g.txns.map(t => t.id)).size).toBe(2500);
  });
  it('không có thành viên nào: trả rỗng, không lỗi', async () => {
    const { API } = boot({ users: [USERS[3]] });
    const g = await API.asset.getGroupData();
    expect(g.members).toEqual([]);
    expect(g.txns).toEqual([]);
  });
  it('lỗi từ máy chủ được ném ra', async () => {
    const { API } = boot({ users: USERS }, { failOn: (q) => q.t === 'finance_cash_flows' });
    await expect(API.asset.getGroupData()).rejects.toThrow();
  });
});

describe('API.asset.getMarketInputs', () => {
  const series = (n) => Array.from({ length: n }, (_, i) => ['2026-09-' + String(i + 1).padStart(2, '0'), 100 + i]);
  it('giá + sự kiện cho nhóm mã; chuẩn hoá và bỏ trùng mã; có VN-Index', async () => {
    const calls = [];
    const { API } = boot({}, { functions: {
      'stock-history': async (b) => { calls.push(b); return { data: { ok: true, series: Object.fromEntries(b.symbols.map(s => [s, series(20)])) }, error: null }; },
      'stock-events': async () => ({ data: { ok: true, events: [{ id: 'e', symbol: 'FPT', kind: 'bonus', exDate: '2026-09-10', ratio: 10 }], errors: {} }, error: null }),
    } });
    const r = await API.asset.getMarketInputs(['fpt', 'FPT', 'hpg'], 200);
    expect(calls[0].symbols).toEqual(['FPT', 'HPG', 'VNINDEX']);
    expect(Object.keys(r.histories).sort()).toEqual(['FPT', 'HPG', 'VNINDEX']);
    expect(r.events).toHaveLength(1);
    expect(r.windowDays).toBe(200);
  });
  it('lỗi từng phần được báo riêng; danh sách rỗng không gọi nguồn', async () => {
    const { API, fake } = boot({}, { functions: { 'stock-history': async () => ({ data: null, error: { message: 'giá lỗi' } }), 'stock-events': async () => ({ data: null, error: { message: 'sk lỗi' } }) } });
    const r = await API.asset.getMarketInputs(['FPT']);
    expect(r.historyError).toMatch(/giá lỗi/); expect(r.eventsError).toMatch(/sk lỗi/);
    const n = await API.asset.getMarketInputs([]);
    expect(n.histories).toEqual({});
    expect(fake.functionCalls.length).toBe(2);
  });
});

describe('API.asset.getBenchSeries', () => {
  it('lấy chuẩn hợp lệ (VN30/VNINDEX), chuẩn lạ quay về VN-Index; phủ từ trước ngày bắt đầu 20 ngày', async () => {
    const calls = [];
    const { API } = boot({}, { functions: { 'stock-history': async (b) => { calls.push(b); return { data: { ok: true, series: Object.fromEntries(b.symbols.map(s => [s, [['2026-09-01', 1000]]])) }, error: null }; } } });
    expect(await API.asset.getBenchSeries('VN30', '2026-08-01')).toEqual([['2026-09-01', 1000]]);
    expect(calls[0].symbols).toEqual(['VN30']);
    expect(calls[0].from).toBe('2026-07-12');
    await API.asset.getBenchSeries('HACK', '2026-08-01');
    expect(calls[1].symbols).toEqual(['VNINDEX']);
  });
  it('thiếu chuỗi -> mảng rỗng; ngày bắt đầu hỏng -> dùng mốc xa nhất cho phép', async () => {
    const calls = [];
    const { API } = boot({}, { functions: { 'stock-history': async (b) => { calls.push(b); return { data: { ok: true, series: {} }, error: null }; } } });
    expect(await API.asset.getBenchSeries('VNINDEX', 'không phải ngày')).toEqual([]);
    expect(calls[0].from).toBe(new Date(Date.now() - 2590 * 86400000).toISOString().slice(0, 10));   // mốc xa nhất Edge Function cho phép
  });
});
