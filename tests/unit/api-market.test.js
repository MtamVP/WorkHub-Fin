// API.asset.market: nạp phân ngành ICB vào FinCalc, lợi suất, cảnh báo chất lượng dữ liệu, nhật ký chạy -- chạy CHÍNH api.js trên Supabase giả.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/sector-map.js', 'lib/vn-market.js', 'lib/portfolio-calc.js', 'lib/limits-calc.js', 'lib/approval-calc.js', 'lib/corporate-events.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/decision-journal.js', 'lib/monthly-report.js'];

const MEMBER = { id: 'u-1', email: 'an@x.vn', nickname: 'An', group_key: 'finance', active: true };
const MANAGER = { id: 'u-2', email: 'mgr@x.vn', nickname: 'Quản lý', group_key: 'finance', active: true };

function boot(actor = MEMBER, seed = {}, store = {}, functions = {}) {
  const base = { users: [MEMBER, MANAGER], fin_roles: [{ user_id: 'u-2', role: 'asset_manager' }], finance_assets: [], finance_transactions: [] };
  const fake = createFakeSupabase(Object.assign(base, seed), { authUser: { email: actor.email }, functions });
  const sandbox = {
    Date,
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


describe('giá tham chiếu và T+2', () => {
  afterEach(() => vi.useRealTimers());
  const BARS = { FPT: [['2026-10-01', 63000], ['2026-10-02', 62700], ['2026-10-05', 62900]], VNINDEX: [['2026-09-30', 1900], ['2026-10-01', 1910], ['2026-10-02', 1905], ['2026-10-05', 1915]] };
  const fns = { 'stock-history': async (b) => ({ data: { ok: true, series: Object.fromEntries(b.symbols.map(sym => [sym, (BARS[sym] || []).filter(([d]) => d >= b.from && d <= b.to)])) }, error: null }) };
  const META2 = [{ symbol: 'FPT', icb2_code: '9500', exchange: 'HNX', type: 'STOCK' }];

  it('trước 15:05 giờ VN: tham chiếu là phiên trước hôm nay; sau đó là phiên hôm nay; sàn và trần theo sàn niêm yết', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T03:00:00Z'));                 // 10:00 giờ VN thứ Hai
    const c = boot(MEMBER, { finance_stock_meta: META2 }, {}, fns);
    const r = await c.API.asset.market.reference('fpt');
    expect(r).toMatchObject({ symbol: 'FPT', exchange: 'HNX', listingKnown: true, ref: 62700, refDate: '2026-10-02' });
    expect(r.limits).toMatchObject({ ceiling: 68900, floor: 56500, bandPct: 10, tick: 100 });          // HNX ±10%: 62.700 x 1,1 = 68.970 -> làm tròn xuống bước giá 68.900; x 0,9 = 56.430 -> lên 56.500
    vi.setSystemTime(new Date('2026-10-05T09:00:00Z'));                 // 16:00 giờ VN: đã đóng cửa
    const c2 = boot(MEMBER, { finance_stock_meta: META2 }, {}, fns);
    expect((await c2.API.asset.market.reference('FPT')).ref).toBe(62900);
  });
  it('mã chưa rõ sàn: mặc định HOSE và báo listingKnown=false; mã sai bị từ chối', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T03:00:00Z'));
    const c = boot(MEMBER, {}, {}, fns);
    const r = await c.API.asset.market.reference('FPT');
    expect(r).toMatchObject({ exchange: 'HOSE', listingKnown: false });
    expect(r.limits.ceiling).toBe(67000);
    await expect(c.API.asset.market.reference('bad symbol')).rejects.toThrow(/Mã không hợp lệ/);
  });
  it('settlement: cổ phiếu mua chưa về, tiền bán chưa về, số bán được hôm nay', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T03:00:00Z'));
    const tx = (id, o) => Object.assign({ id, user_id: 'u-1', fee: 0, tax: 0, created_at: '2026-10-01T00:00:00Z', deleted_at: null }, o);
    const c = boot(MEMBER, { finance_transactions: [
      tx('a', { type: 'buy', symbol: 'FPT', quantity: 500, price: 60000, trade_date: '2026-09-25' }),
      tx('b', { type: 'buy', symbol: 'FPT', quantity: 300, price: 62000, trade_date: '2026-10-02' }),     // về 06/10
      tx('c', { type: 'sell', symbol: 'FPT', quantity: 100, price: 63000, trade_date: '2026-10-02', fee: 9450, tax: 6300 }),
    ] }, {}, fns);
    const r = await c.API.asset.market.settlement(MEMBER.email);
    expect(r.held.FPT).toBe(700);
    expect(r.sellable.FPT).toEqual({ sellable: 400, locked: 300, nextSettle: '2026-10-06' });
    expect(r.unsettled.cashPending).toBeCloseTo(100 * 63000 - 9450 - 6300, 6);
    expect(r.sessions).toContain('2026-10-05');
  });
});

describe('getPerfInputs: cổ tức và lợi suất trái phiếu', () => {
  it('trả thêm cổ tức tiền mặt và lợi suất 1 năm để PerfCalc tách lợi suất giá và dùng lãi phi rủi ro theo ngày; thiếu bảng thì vẫn chạy', async () => {
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const nav = [{ user_id: 'u-1', snapshot_date: day(40), nav: 100e6, net_contributed: 100e6 }, { user_id: 'u-1', snapshot_date: day(1), nav: 110e6, net_contributed: 100e6 }];
    const c = boot(MEMBER, {
      finance_nav_history: nav,
      finance_cash_flows: [{ id: 'f1', user_id: 'u-1', flow_type: 'dividend', amount: 2e6, flow_date: day(10), symbol: 'FPT', deleted_at: null }, { id: 'f2', user_id: 'u-1', flow_type: 'deposit', amount: 5e6, flow_date: day(20), deleted_at: null }],
      finance_rates: [{ rate_date: day(5), tenor: '1Y', yield_pct: 3.7 }],
    }, {}, { 'stock-history': async (b) => ({ data: { ok: true, series: { VNINDEX: [[day(41), 1000], [day(1), 1010]] } }, error: null }) });
    const r = await c.API.asset.getPerfInputs(MEMBER.email, 'VNINDEX');
    expect(r.dividends).toEqual([{ date: day(10), amount: 2e6 }]);
    expect(r.rates.map(x => x.yield_pct)).toEqual([3.7]);
    expect(r.navHistory).toHaveLength(2);
  });
});

describe('ratios: chỉ số cơ bản từ cache và làm mới theo yêu cầu', () => {
  const row = (symbol, hoursAgo, metrics = { pe: 11.7 }) => ({ symbol, daily_date: '2026-10-02', quarter_date: '2026-06-30', metrics, updated_at: new Date(Date.now() - hoursAgo * 3600000).toISOString() });
  it('cache còn mới: trả ngay, KHÔNG gọi Edge Function', async () => {
    let calls = 0;
    const c = boot(MEMBER, { finance_stock_ratios: [row('FPT', 2), row('VCB', 5)] }, {}, { 'market-data-sync': async () => { calls++; return { data: { ok: true }, error: null }; } });
    const r = await c.API.asset.market.ratios(['fpt', 'VCB']);
    expect(calls).toBe(0);
    expect(r.FPT.metrics.pe).toBe(11.7); expect(r.FPT.dailyDate).toBe('2026-10-02');
    expect(Object.keys(r).sort()).toEqual(['FPT', 'VCB']);
  });
  it('mã thiếu hoặc cũ quá 20 giờ: gọi Edge Function đúng các mã đó rồi đọc lại', async () => {
    let body = null, c = null;
    const fns = { 'market-data-sync': async (b) => { body = b; c.fake.table('finance_stock_ratios').push({ symbol: 'HPG', daily_date: '2026-10-02', quarter_date: '2026-06-30', metrics: { pe: 9 }, updated_at: new Date().toISOString() }); const old = c.fake.table('finance_stock_ratios').find(x => x.symbol === 'VCB'); old.updated_at = new Date().toISOString(); old.metrics = { pe: 12 }; return { data: { ok: true }, error: null }; } };
    c = boot(MEMBER, { finance_stock_ratios: [row('FPT', 2), row('VCB', 30)] }, {}, fns);
    const r = await c.API.asset.market.ratios(['FPT', 'VCB', 'HPG']);
    expect(body).toEqual({ mode: 'ratios', symbols: ['VCB', 'HPG'] });
    expect(r.HPG.metrics.pe).toBe(9); expect(r.VCB.metrics.pe).toBe(12); expect(r.FPT.metrics.pe).toBe(11.7);
  });
  it('Edge Function lỗi: dùng bản cache cũ nếu có; mã không hợp lệ bị bỏ; không có mã thì trả rỗng; qua callGAS', async () => {
    const c = boot(MEMBER, { finance_stock_ratios: [row('VCB', 30, { pe: 12 })] }, {}, { 'market-data-sync': async () => ({ data: null, error: { message: 'down' } }) });
    const r = await c.API.asset.market.ratios(['VCB', 'bad symbol']);
    expect(r.VCB.metrics.pe).toBe(12);
    expect(await c.API.asset.market.ratios([])).toEqual({});
    expect((await c.callGAS('getStockRatios', { symbols: ['VCB'] })).data.VCB.metrics.pe).toBe(12);
  });
});
