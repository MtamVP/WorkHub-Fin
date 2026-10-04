// API.asset.getRiskInputs: gom danh mục + giá lịch sử + sự kiện cho tab Rủi Ro; lỗi phần phụ không làm hỏng cả báo cáo.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/corporate-events.js', 'lib/risk-calc.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js'];
const USER = 'u-1', EMAIL = 'toi@example.com';

function boot(seed = {}, fakeOpts = {}) {
  const fake = createFakeSupabase(Object.assign({ users: [{ id: USER, email: EMAIL, nickname: 'toi' }] }, seed), fakeOpts);
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

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const txn = (id, type, symbol, quantity, price, trade_date) => ({ id, user_id: USER, type, symbol, quantity, price, fee: 0, tax: 0, trade_date, created_at: trade_date + 'T01:00:00Z', deleted_at: null });
const price = (symbol, p) => ({ user_id: USER, symbol, market_price: p, locked: false, price_date: day(0), price_source: 'vnd-dchart', updated_at: new Date().toISOString() });
const SEED = {
  finance_assets: [{ user_id: USER, cash: 20e6, debt: 5e6, nav: 0 }],
  finance_transactions: [txn('t1', 'buy', 'FPT', 100, 100000, day(-60)), txn('t2', 'buy', 'HPG', 200, 25000, day(-50))],
  finance_holdings_price: [price('FPT', 110000), price('HPG', 27000)],
};
const series = (n, start) => Array.from({ length: n }, (_, i) => [day(-n + i), start + i]);
const okFns = (calls) => ({
  'stock-history': async (b) => { calls.push(b); return { data: { ok: true, series: Object.fromEntries(b.symbols.map(s => [s, series(30, 100)])) }, error: null }; },
  'stock-events': async () => ({ data: { ok: true, events: [{ id: 'e1', symbol: 'FPT', kind: 'bonus', exDate: day(-20), ratio: 10 }], errors: {} }, error: null }),
});

describe('API.asset.getRiskInputs', () => {
  it('trả danh mục + tiền/nợ + giá lịch sử (kèm VN-Index) + sự kiện + NAV đã chụp', async () => {
    const calls = [];
    const { API } = boot(Object.assign({ finance_nav_history: [{ user_id: USER, snapshot_date: day(-1), nav: 1, net_contributed: 0 }] }, SEED), { functions: okFns(calls) });
    const r = await API.asset.getRiskInputs(EMAIL, 365);
    expect(r.holdings.map(h => h.symbol).sort()).toEqual(['FPT', 'HPG']);
    expect(r.holdings.find(h => h.symbol === 'FPT').marketValue).toBe(11e6);
    expect(r.cash).toBe(20e6); expect(r.debt).toBe(5e6);
    expect(calls[0].symbols).toContain('VNINDEX');
    expect(Object.keys(r.histories).sort()).toEqual(['FPT', 'HPG', 'VNINDEX']);
    expect(r.events).toHaveLength(1);
    expect(r.navHistory).toHaveLength(1);
    expect(r.historyError).toBeNull(); expect(r.eventsError).toBeNull();
    expect(r.windowDays).toBe(365);
  });
  it('lỗi giá lịch sử hoặc sự kiện được báo riêng, phần còn lại vẫn trả về', async () => {
    const { API } = boot(SEED, { functions: { 'stock-history': async () => ({ data: null, error: { message: 'giá hỏng' } }), 'stock-events': async () => ({ data: null, error: { message: 'sk hỏng' } }) } });
    const r = await API.asset.getRiskInputs(EMAIL);
    expect(r.historyError).toMatch(/giá hỏng/);
    expect(r.eventsError).toMatch(/sk hỏng/);
    expect(r.holdings).toHaveLength(2);
    expect(r.windowDays).toBe(365);
  });
  it('kẹp cửa sổ trong 90..1100 ngày; chưa có mã nào thì không gọi nguồn', async () => {
    const calls = [];
    const { API, fake } = boot({ finance_assets: [{ user_id: USER, cash: 1, debt: 0, nav: 0 }] }, { functions: okFns(calls) });
    const r = await API.asset.getRiskInputs(EMAIL, 5);
    expect(r.windowDays).toBe(90);
    expect(r.holdings).toEqual([]);
    expect(fake.functionCalls.length).toBe(0);
    expect((await API.asset.getRiskInputs(EMAIL, 99999)).windowDays).toBe(1100);
  });
  it('callGAS getRiskInputs đi đúng nhánh', async () => {
    const { callGAS } = boot(SEED, { functions: okFns([]) });
    const r = await callGAS('getRiskInputs', { email: EMAIL, windowDays: 180 });
    expect(r.status).toBe('success');
    expect(r.data.windowDays).toBe(180);
  });
});
