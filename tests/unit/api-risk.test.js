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

describe('API.asset.getPerfInputs', () => {
  const nav = (d, v) => ({ user_id: USER, snapshot_date: day(d), nav: v, net_contributed: 100e6, cash: 0, debt: 0, market_value: v });
  it('trả lịch sử NAV + giá chuẩn (VN-Index mặc định), chuẩn lạ quay về VN-Index, VN30 được nhận', async () => {
    const calls = [];
    const fns = { 'stock-history': async (b) => { calls.push(b); return { data: { ok: true, series: Object.fromEntries(b.symbols.map(s => [s, series(30, 100)])) }, error: null }; } };
    const { API } = boot({ finance_nav_history: [nav(-10, 100e6), nav(-5, 101e6), nav(-1, 103e6)] }, { functions: fns });
    const r = await API.asset.getPerfInputs(EMAIL);
    expect(r.navHistory).toHaveLength(3);
    expect(r.benchKey).toBe('VNINDEX');
    expect(r.bench).toHaveLength(30);
    expect(calls[0].symbols).toEqual(['VNINDEX']);
    expect(calls[0].from < day(-10)).toBe(true);        // phủ từ trước ngày chụp NAV đầu tiên
    expect((await API.asset.getPerfInputs(EMAIL, 'VN30')).benchKey).toBe('VN30');
    expect((await API.asset.getPerfInputs(EMAIL, 'HACK')).benchKey).toBe('VNINDEX');
  });
  it('chưa đủ NAV thì không gọi nguồn; lỗi giá chuẩn được báo riêng', async () => {
    const calls = [];
    const none = boot({}, { functions: { 'stock-history': async () => { calls.push(1); return { data: { ok: true, series: {} }, error: null }; } } });
    expect((await none.API.asset.getPerfInputs(EMAIL)).bench).toBeNull();
    expect(calls).toHaveLength(0);
    const bad = boot({ finance_nav_history: [nav(-3, 1), nav(-1, 2)] }, { functions: { 'stock-history': async () => ({ data: null, error: { message: 'giá hỏng' } }) } });
    const r = await bad.API.asset.getPerfInputs(EMAIL);
    expect(r.benchError).toMatch(/giá hỏng/);
    expect(r.navHistory).toHaveLength(2);
  });
});

describe('API.asset.getAttributionInputs', () => {
  const t = (id, symbol, d) => ({ id, user_id: USER, type: 'buy', symbol, quantity: 100, price: 10000, fee: 0, tax: 0, trade_date: d, created_at: d + 'T01:00:00Z', deleted_at: null });
  it('gom sổ lệnh, dòng tiền, NAV, hành động DN và giá lịch sử của mọi mã từng giao dịch (kèm VN-Index)', async () => {
    const calls = [];
    const fns = { 'stock-history': async (b) => { calls.push(b); return { data: { ok: true, series: Object.fromEntries(b.symbols.map(s => [s, series(30, 100)])) }, error: null }; } };
    const { API } = boot({ finance_transactions: [t('a', 'FPT', day(-60)), t('b', 'HPG', day(-20))], finance_cash_flows: [{ id: 'f', user_id: USER, flow_type: 'dividend', symbol: 'FPT', amount: 5, flow_date: day(-10), created_at: day(-10) + 'T00:00:00Z', deleted_at: null }] }, { functions: fns });
    const r = await API.asset.getAttributionInputs(EMAIL);
    expect(r.txns).toHaveLength(2);
    expect(r.cashFlows).toHaveLength(1);
    expect(Object.keys(r.histories).sort()).toEqual(['FPT', 'HPG', 'VNINDEX']);
    expect(r.firstTxnDate).toBe(day(-60));
    expect(calls[0].from < day(-60)).toBe(true);
    expect(r.historyError).toBeNull();
  });
  it('lỗi giá được báo riêng; chưa có lệnh thì không gọi nguồn', async () => {
    const bad = boot({ finance_transactions: [t('a', 'FPT', day(-5))] }, { functions: { 'stock-history': async () => ({ data: null, error: { message: 'hỏng' } }) } });
    const r = await bad.API.asset.getAttributionInputs(EMAIL);
    expect(r.historyError).toMatch(/hỏng/);
    expect(r.txns).toHaveLength(1);
    const none = boot({}, { functions: { 'stock-history': async () => { throw new Error('không được gọi'); } } });
    expect((await none.API.asset.getAttributionInputs(EMAIL)).txns).toEqual([]);
  });
});

describe('API.asset.getVolumeHistory', () => {
  it('gọi stock-history với volumes:true theo lô, chuẩn hoá mã, trả khối lượng từng mã', async () => {
    const calls = [];
    const fns = { 'stock-history': async (b) => { calls.push(b); return { data: { ok: true, series: {}, volumes: Object.fromEntries(b.symbols.map(s => [s, [[day(-1), 1000]]])) }, error: null }; } };
    const { API } = boot({}, { functions: fns });
    const r = await API.asset.getVolumeHistory(['fpt', 'FPT', 'hpg', 'A;B'], 90);
    expect(Object.keys(r).sort()).toEqual(['FPT', 'HPG']);
    expect(calls[0]).toMatchObject({ symbols: ['FPT', 'HPG'], volumes: true });
    expect(calls[0].from < calls[0].to).toBe(true);
    const many = Array.from({ length: 45 }, (_, i) => 'S' + i);
    await API.asset.getVolumeHistory(many);
    expect(calls.length).toBe(1 + 3);                              // 45 mã -> 3 lô 20
  });
  it('rỗng không gọi nguồn; lỗi được ném ra với lý do', async () => {
    const calls = [];
    const ok = boot({}, { functions: { 'stock-history': async () => { calls.push(1); return { data: { ok: true, volumes: {} }, error: null }; } } });
    expect(await ok.API.asset.getVolumeHistory([])).toEqual({});
    expect(calls).toHaveLength(0);
    const bad = boot({}, { functions: { 'stock-history': async () => ({ data: null, error: { message: 'nguồn lỗi' } }) } });
    await expect(bad.API.asset.getVolumeHistory(['FPT'])).rejects.toThrow(/nguồn lỗi/);
  });
});
