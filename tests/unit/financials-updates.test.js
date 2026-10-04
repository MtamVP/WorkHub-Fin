// Số liệu máy chủ làm mới hằng ngày: API.stock.getFinancialsUpdates / getFinancialsCache và FinancialsSync.syncMany({ useCache }).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/corporate-events.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js', 'lib/valuation-calc.js'];
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
  vm.runInContext(read('stocksheet/financials-sync.js').replace(/^const (\w+) = \(function/m, 'var $1 = (function'), sandbox);
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS, FinancialsSync: sandbox.FinancialsSync };
}

const val = (symbol, year, financialsAt) => ({ symbol, year, data: { symbol, year, financialsAt }, updated_at: '2026-09-01T00:00:00Z', updated_by: EMAIL });
const cacheRow = (symbol, changed_at, extra = {}) => Object.assign({ symbol, annual_year: 2025, quarter_key: '2026Q2', changed_at, fetched_at: changed_at, payload: { form: 'NON_FINANCE', annual: [], quarters: [], dividends: {} } }, extra);

describe('API.stock.getFinancialsUpdates', () => {
  it('chỉ báo mã có số liệu MỚI HƠN lần đồng bộ gần nhất của hồ sơ', async () => {
    const { API } = boot({
      finance_stock_valuations: [val('FPT', 2026, '2026-10-01T00:00:00Z'), val('FPT', 2025, '2026-09-01T00:00:00Z'), val('VCB', 2026, '2026-10-03T12:00:00Z'), val('HPG', 2026, '2026-09-01T00:00:00Z')],
      finance_financials_cache: [cacheRow('FPT', '2026-10-02T00:00:00Z'), cacheRow('VCB', '2026-10-03T00:00:00Z'), cacheRow('HPG', '1970-01-01T00:00:00Z')],
    });
    const r = await API.stock.getFinancialsUpdates();
    expect(r.updates.map(u => u.symbol)).toEqual(['FPT']);       // VCB đã đồng bộ SAU thay đổi; HPG chưa có thay đổi thật (mốc 1970)
    expect(r.updates[0]).toMatchObject({ quarterKey: '2026Q2', annualYear: 2025, lastSyncAt: '2026-10-01T00:00:00Z' });
  });
  it('mã chưa từng đồng bộ tự động (số liệu nhập tay) không bị báo', async () => {
    const { API } = boot({ finance_stock_valuations: [val('MWG', 2026, undefined)], finance_financials_cache: [cacheRow('MWG', '2026-10-03T00:00:00Z')] });
    expect((await API.stock.getFinancialsUpdates()).updates).toEqual([]);
  });
  it('đọc trạng thái lần chạy gần nhất; trạng thái hỏng thì bỏ qua', async () => {
    const ok = boot({ app_settings: [{ key: 'financials_refresh_status', value: JSON.stringify({ ranAt: '2026-10-04T00:15:00Z', symbols: 3, tried: 3, refreshed: 3, changed: ['FPT'], changedCount: 1, failed: [] }) }] });
    expect((await ok.API.stock.getFinancialsUpdates()).status).toMatchObject({ symbols: 3, changedCount: 1 });
    const bad = boot({ app_settings: [{ key: 'financials_refresh_status', value: '{hỏng' }] });
    expect((await bad.API.stock.getFinancialsUpdates()).status).toBeNull();
    expect((await boot().API.stock.getFinancialsUpdates())).toEqual({ updates: [], status: null });
  });
});

describe('API.stock.getFinancialsCache', () => {
  it('trả số liệu đã đệm theo mã (chuẩn hoá mã, bỏ mã lạ)', async () => {
    const { API, callGAS } = boot({ finance_financials_cache: [cacheRow('FPT', '2026-10-02T00:00:00Z'), cacheRow('VCB', '2026-10-02T00:00:00Z')] });
    const r = await API.stock.getFinancialsCache(['fpt', 'xxx', 'a;b']);
    expect(Object.keys(r)).toEqual(['FPT']);
    expect(await API.stock.getFinancialsCache([])).toEqual({});
    expect((await callGAS('getFinancialsCache', { symbols: ['VCB'] })).data.VCB.form).toBe('NON_FINANCE');
    expect((await callGAS('getFinancialsUpdates', {})).status).toBe('success');
  });
});

describe('FinancialsSync.syncMany với useCache', () => {
  const FIN = { form: 'NON_FINANCE', annual: [{ year: 2025, fiscalDate: '2025-12-31', charter: 17e12, equity: 43e12, minority: 7e12, equityParent: 36e12, lnst: 9e12, revenue: 70e12, assets: 88e12 }], quarters: [], dividends: { '2025': 2000 } };
  const FNS = (calls) => ({ 'stock-financials': async (b) => { calls.push(b.symbols); return { data: { ok: true, results: Object.fromEntries(b.symbols.map(s => [s, FIN])), errors: {} }, error: null }; } });

  it('dùng đệm cho mã có sẵn, chỉ gọi nguồn cho mã còn thiếu', async () => {
    const calls = [];
    const { FinancialsSync, fake } = boot({ finance_financials_cache: [cacheRow('FPT', '2026-10-02T00:00:00Z', { payload: FIN })] }, { functions: FNS(calls) });
    const res = await FinancialsSync.syncMany(['FPT', 'VCB'], null, { useCache: true });
    expect(res.map(r => [r.symbol, r.ok])).toEqual([['FPT', true], ['VCB', true]]);
    expect(calls).toEqual([['VCB']]);                                   // FPT không phải gọi nguồn
    const saved = fake.table('finance_stock_valuations');
    expect(saved.map(r => r.symbol).sort()).toContain('FPT');
    expect(saved.find(r => r.symbol === 'FPT').data.financialsAt).toBeTruthy();   // dấu mốc đồng bộ -> báo "có số liệu mới" tự tắt
  });
  it('không bật useCache thì luôn gọi nguồn cho mọi mã (hành vi cũ)', async () => {
    const calls = [];
    const { FinancialsSync } = boot({ finance_financials_cache: [cacheRow('FPT', '2026-10-02T00:00:00Z', { payload: FIN })] }, { functions: FNS(calls) });
    await FinancialsSync.syncMany(['FPT'], null);
    expect(calls).toEqual([['FPT']]);
  });
  it('đệm lỗi/đọc không được thì vẫn quay về gọi nguồn; mã nguồn không có -> báo lỗi riêng', async () => {
    const calls = [];
    const fns = { 'stock-financials': async (b) => { calls.push(b.symbols); return { data: { ok: true, results: {}, errors: { ZZZ: 'chưa có báo cáo' } }, error: null }; } };
    const { FinancialsSync } = boot({}, { functions: fns });
    const res = await FinancialsSync.syncMany(['ZZZ'], null, { useCache: true });
    expect(calls).toEqual([['ZZZ']]);
    expect(res[0]).toMatchObject({ symbol: 'ZZZ', ok: false });
    expect(res[0].error).toMatch(/chưa có báo cáo/);
  });
});
