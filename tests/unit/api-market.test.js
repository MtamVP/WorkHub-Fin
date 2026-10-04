// API.asset.market: nạp phân ngành ICB vào FinCalc, lợi suất, cảnh báo chất lượng dữ liệu, nhật ký chạy -- chạy CHÍNH api.js trên Supabase giả.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/sector-map.js', 'lib/portfolio-calc.js', 'lib/limits-calc.js', 'lib/approval-calc.js', 'lib/corporate-events.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js'];

const MEMBER = { id: 'u-1', email: 'an@x.vn', nickname: 'An', group_key: 'finance', active: true };
const MANAGER = { id: 'u-2', email: 'mgr@x.vn', nickname: 'Quản lý', group_key: 'finance', active: true };

function boot(actor = MEMBER, seed = {}, store = {}) {
  const base = { users: [MEMBER, MANAGER], fin_roles: [{ user_id: 'u-2', role: 'asset_manager' }], finance_assets: [], finance_transactions: [] };
  const fake = createFakeSupabase(Object.assign(base, seed), { authUser: { email: actor.email } });
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, Blob, Buffer, URL, TextEncoder, TextDecoder, atob, btoa,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: {}, document: { addEventListener() {}, getElementById: () => null, readyState: 'complete' },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  };
  sandbox.window = sandbox;
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sandbox.window.supabase = { createClient: () => fake.client };
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  LIBS.forEach(lib => vm.runInContext(read(lib).replace(/^const (\w+) = \(function/m, 'var $1 = (function'), sandbox));
  vm.runInContext(read('api.js') + '\n;this.API = API; this.callGAS = window.callGAS; this.MUTATING = window.MUTATING_ACTIONS; this.FC = FinCalc;', sandbox);
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS, MUTATING: sandbox.MUTATING, FC: sandbox.FC, store };
}
const META = [{ symbol: 'ZZZ', icb2_code: '6500' }, { symbol: 'FPT', icb2_code: '9500' }, { symbol: 'QQQ', icb2_code: '5700' }, { symbol: 'BAD', icb2_code: '1234' }];

describe('ensureMeta: phân ngành ICB', () => {
  it('nạp từ finance_stock_meta, đăng ký vào FinCalc; mã ngoài bảng tự gõ có ngành, bảng tự gõ vẫn thắng; ghi cache', async () => {
    const c = boot(MEMBER, { finance_stock_meta: META });
    expect(c.FC.sectorOf('ZZZ')).toBe('Chưa phân ngành');
    expect(await c.API.asset.market.ensureMeta()).toBe(3);                 // BAD không nhận ra ICB
    expect(c.FC.sectorOf('ZZZ')).toBe('Viễn thông');
    expect(c.FC.sectorOf('QQQ')).toBe('Du lịch & giải trí');
    expect(c.FC.sectorOf('BAD')).toBe('Chưa phân ngành');
    expect(JSON.parse(c.store.wh_sector_meta_v1).map.ZZZ).toBe('Viễn thông');
  });
  it('cache còn mới thì không gọi DB; hết hạn hoặc force thì nạp lại; lỗi đọc thì dùng cache cũ', async () => {
    const fresh = { ts: Date.now(), map: { ZZZ: 'Bán lẻ' } };
    const c1 = boot(MEMBER, { finance_stock_meta: META }, { wh_sector_meta_v1: JSON.stringify(fresh) });
    await c1.API.asset.market.ensureMeta();
    expect(c1.FC.sectorOf('ZZZ')).toBe('Bán lẻ');                          // lấy từ cache, không đọc DB
    const c2 = boot(MEMBER, { finance_stock_meta: META }, { wh_sector_meta_v1: JSON.stringify(fresh) });
    await c2.API.asset.market.ensureMeta(true);
    expect(c2.FC.sectorOf('ZZZ')).toBe('Viễn thông');                      // force: đọc lại DB
    const stale = { ts: Date.now() - 3 * 86400000, map: { ZZZ: 'Bảo hiểm' } };
    const c3 = boot(MEMBER, { finance_stock_meta: [] }, { wh_sector_meta_v1: JSON.stringify(stale) });
    await c3.API.asset.market.ensureMeta();
    expect(c3.FC.sectorOf('ZZZ')).toBe('Bảo hiểm');                        // DB rỗng/lỗi: dùng cache cũ
  });
  it('getHoldingsView nạp phân ngành trước khi trả danh mục', async () => {
    const c = boot(MEMBER, { finance_stock_meta: META, finance_holdings_price: [] });
    await c.API.asset.getHoldingsView(MEMBER.email);
    expect(c.FC.sectorOf('ZZZ')).toBe('Viễn thông');
  });
});

describe('cảnh báo chất lượng dữ liệu và nhật ký chạy', () => {
  const H = (id, o = {}) => Object.assign({ id, detected_at: new Date(Date.now() - 86400000).toISOString(), kind: 'price_mismatch', symbol: 'FPT', severity: 'warn', resolved: false, detail: {} }, o);
  it('healthList: gồm mọi cảnh báo chưa xử lý (dù cũ) và cảnh báo đã xử lý gần đây; mới trước', async () => {
    const old = new Date(Date.now() - 200 * 86400000).toISOString();
    const c = boot(MEMBER, { finance_data_health: [H('a'), H('b', { detected_at: old }), H('c', { resolved: true }), H('d', { resolved: true, detected_at: old })] });
    const r = await c.API.asset.market.healthList(30);
    expect(r.map(x => x.id).sort()).toEqual(['a', 'b', 'c']);
    expect(r[0].detected_at >= r[1].detected_at).toBe(true);
  });
  it('chỉ quản lý đánh dấu đã xử lý, cần ghi chú; không xử lý hai lần', async () => {
    const seed = { finance_data_health: [H('a')] };
    await expect(boot(MEMBER, seed).API.asset.market.healthResolve(MEMBER.email, 'a', 'đã kiểm')).rejects.toThrow(/Chỉ quản lý/);
    const m = boot(MANAGER, seed);
    await expect(m.API.asset.market.healthResolve(MANAGER.email, 'a', 'x')).rejects.toThrow(/ghi chú/i);
    expect(await m.API.asset.market.healthResolve(MANAGER.email, 'a', 'Đã đối chiếu thủ công với sao kê')).toMatch(/đã xử lý/);
    expect(m.fake.table('finance_data_health')[0]).toMatchObject({ resolved: true, resolve_note: 'Đã đối chiếu thủ công với sao kê' });
    await expect(m.API.asset.market.healthResolve(MANAGER.email, 'a', 'lần hai')).rejects.toThrow(/đã được xử lý/);
  });
  it('runs và rates: lọc theo khoảng ngày; callGAS đúng nhánh; resolve thuộc danh sách thay đổi dữ liệu', async () => {
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const iso = (n) => day(n).slice(0, 10);
    const c = boot(MANAGER, {
      finance_function_runs: [{ id: 1, fn: 'market-data-sync', mode: 'rates', run_at: day(1), ok: true }, { id: 2, fn: 'market-data-sync', mode: 'rates', run_at: day(40), ok: true }],
      finance_rates: [{ rate_date: iso(2), tenor: '1Y', yield_pct: 3.7 }, { rate_date: iso(900), tenor: '1Y', yield_pct: 5 }, { rate_date: iso(1), tenor: '10Y', yield_pct: 4.6 }],
      finance_data_health: [H('a')],
    });
    expect((await c.API.asset.market.runs(14)).map(r => r.id)).toEqual([1]);
    expect((await c.API.asset.market.rates(400)).map(r => r.yield_pct)).toEqual([3.7, 4.6]);
    expect((await c.callGAS('listFunctionRuns', { days: 14 })).data).toHaveLength(1);
    expect((await c.callGAS('getMarketRates', { days: 400 })).status).toBe('success');
    expect((await c.callGAS('listDataHealth', {})).data).toHaveLength(1);
    expect((await c.callGAS('resolveDataHealth', { email: MANAGER.email, id: 'a', note: 'Đã xử lý xong' })).status).toBe('success');
    expect(Array.from(c.MUTATING)).toContain('resolveDataHealth');
  });
});
