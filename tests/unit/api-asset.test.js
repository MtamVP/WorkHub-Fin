// Chạy CHÍNH api.js (API.asset.*) trên Supabase giả trong bộ nhớ: nhập sao kê, hoàn tác, danh sách theo dõi, tỷ trọng mục tiêu,
// báo cáo lãi/lỗ đã chốt, dữ liệu báo cáo tháng. Mục đích: bắt lỗi nối giữa lib thuần và lớp truy cập dữ liệu.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/monthly-report.js'];

const USER = 'u-1', EMAIL = 'toi@example.com';
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

function boot(seed = {}, fakeOpts = {}) {
  const fake = createFakeSupabase(Object.assign({ users: [{ id: USER, email: EMAIL, nickname: 'toi' }], finance_assets: [{ user_id: USER, cash: 50e6, debt: 0, nav: 0 }] }, seed), fakeOpts);
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
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS, sandbox };
}

const T = (id, type, symbol, quantity, price, trade_date, extra = {}) =>
  ({ id, user_id: USER, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z', deleted_at: null, realized_pnl: null, external_ref: null, import_batch: null, ...extra });
const row = (date, symbol, type, quantity, price, extra = {}) => Object.assign({ line: 1, date, symbol, type, quantity, price, fee: 0, tax: 0, ref: null, issues: [] }, extra);

describe('API.asset — lệnh thủ công với thuế bán', () => {
  it('lưu thuế cho lệnh bán, bỏ thuế cho lệnh mua; lãi/lỗ đã chốt vẫn là GỘP (không đổi định nghĩa cũ)', async () => {
    const { API, fake } = boot();
    await API.asset.addTransaction(EMAIL, { type: 'buy', symbol: 'ssi', quantity: 1000, price: 30000, fee: 45000, tax: 999, tradeDate: '2026-01-05' });
    await API.asset.addTransaction(EMAIL, { type: 'sell', symbol: 'SSI', quantity: 500, price: 33000, fee: 24750, tax: 16500, tradeDate: '2026-02-05' });
    const [buy, sell] = fake.table('finance_transactions');
    expect(buy.tax).toBe(0);
    expect(sell.tax).toBe(16500);
    expect(sell.realized_pnl).toBe(1500000);               // (33.000 - 30.000) x 500, chưa trừ phí/thuế
  });
});

describe('API.asset — nhập sao kê', () => {
  let ctx;
  beforeEach(() => {
    ctx = boot({ finance_transactions: [T('e1', 'buy', 'SSI', 1000, 30000, '2026-09-03', { fee: 45000 })] });
  });

  it('previewImport: phân loại mới / trùng / bị chặn (bán vượt hàng)', async () => {
    const { API } = ctx;
    const rows = [
      row('2026-09-03', 'SSI', 'buy', 1000, 30000, { line: 1 }),      // trùng lệnh đã có
      row('2026-09-10', 'VHM', 'buy', 100, 70000, { line: 2 }),       // mới
      row('2026-09-20', 'SSI', 'sell', 400, 33000, { line: 3 }),      // mới, đủ hàng
      row('2026-09-21', 'HPG', 'sell', 100, 25000, { line: 4 }),      // chặn: chưa từng mua HPG
    ];
    const p = await API.asset.previewImport(EMAIL, rows);
    expect(p.duplicates.map(r => r.line)).toEqual([1]);
    expect(p.fresh.map(r => r.line).sort()).toEqual([2, 3]);
    expect(p.blocked.map(r => r.line)).toEqual([4]);
    expect(p.blocked[0].blockReason).toMatch(/thiếu lệnh mua/);
  });

  it('bán trong cùng ngày với lệnh mua nhập cùng lô: mua được xếp trước nên bán không bị chặn', async () => {
    const p = await ctx.API.asset.previewImport(EMAIL, [row('2026-09-15', 'FPT', 'sell', 50, 100000, { line: 1 }), row('2026-09-15', 'FPT', 'buy', 100, 99000, { line: 2 })]);
    expect(p.blocked).toEqual([]);
    expect(p.fresh.map(r => r.type)).toEqual(['buy', 'sell']);
  });

  it('importTransactions: chèn đúng, gắn mã lô, tính lại lãi/lỗ đã chốt; nhập lại cùng file không tạo trùng', async () => {
    const { API, fake } = ctx;
    const rows = [row('2026-09-10', 'VHM', 'buy', 100, 70000, { line: 2, fee: 10500, tax: 0, ref: 'A7' }), row('2026-09-20', 'SSI', 'sell', 400, 33000, { line: 3, fee: 19800, tax: 13200 })];
    const r1 = await API.asset.importTransactions(EMAIL, rows, {});
    expect(r1.imported).toBe(2);
    expect(r1.batchId).toMatch(/^IMP_/);
    const all = fake.table('finance_transactions');
    const sell = all.find(t => t.type === 'sell');
    expect(sell.import_batch).toBe(r1.batchId);
    expect(sell.tax).toBe(13200);
    expect(sell.realized_pnl).toBe(1200000);              // (33.000 - 30.000) x 400
    expect(all.find(t => t.symbol === 'VHM').external_ref).toBe('A7');
    // thứ tự created_at tăng dần theo thứ tự chèn
    const created = all.filter(t => t.import_batch).map(t => Date.parse(t.created_at));
    expect([...created].sort((a, b) => a - b)).toEqual(created);

    const r2 = await API.asset.importTransactions(EMAIL, rows, {});
    expect(r2.imported).toBe(0);
    expect(r2.duplicates).toBe(2);
    expect(fake.table('finance_transactions')).toHaveLength(3);
  });

  it('lệnh bán bị chặn KHÔNG được nhập', async () => {
    const r = await ctx.API.asset.importTransactions(EMAIL, [row('2026-09-21', 'HPG', 'sell', 100, 25000, { line: 4 })], {});
    expect(r.imported).toBe(0);
    expect(r.blocked).toHaveLength(1);
    expect(ctx.fake.table('finance_transactions').some(t => t.symbol === 'HPG')).toBe(false);
  });

  it('cổ tức tiền: ghi vào dòng tiền, bỏ trùng, KHÔNG đổi tiền mặt trừ khi adjustCash', async () => {
    const { API, fake } = ctx;
    const d = [{ date: '2026-09-22', symbol: 'SSI', amount: 500000 }];
    const r1 = await API.asset.importTransactions(EMAIL, [], { dividends: d });
    expect(r1.dividendsAdded).toBe(1);
    expect(fake.table('finance_assets')[0].cash).toBe(50e6);
    const r2 = await API.asset.importTransactions(EMAIL, [], { dividends: d });
    expect(r2.dividendsAdded).toBe(0);
    expect(r2.dividendsSkipped).toBe(1);
    expect(fake.table('finance_cash_flows').filter(f => f.flow_type === 'dividend')).toHaveLength(1);
    await API.asset.importTransactions(EMAIL, [], { dividends: [{ date: '2026-09-23', symbol: 'SSI', amount: 100000 }], adjustCash: true });
    expect(fake.table('finance_assets')[0].cash).toBe(50e6 + 100000);
  });

  it('lỗi giữa chừng: hoàn tác phần đã chèn, không để nửa lô', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => row('2026-09-01', 'OK' + (i % 5), 'buy', 100, 1000 + i, { line: i + 1 })).concat([row('2026-09-02', 'BAD', 'buy', 100, 1000, { line: 999 })]);
    // 151 dòng = lô 1 (100 dòng) chèn xong, lô 2 (có dòng BAD) bị làm hỏng -> phải hoàn tác cả lô 1
    const failing = boot({ finance_transactions: [] }, { failOn: (q) => q.t === 'finance_transactions' && q.op === 'insert' && Array.isArray(q.payload) && q.payload.some(p => p.symbol === 'BAD') });
    await expect(failing.API.asset.importTransactions(EMAIL, rows, {})).rejects.toThrow(/hoàn tác/);
    const live = failing.fake.table('finance_transactions').filter(t => !t.deleted_at);
    expect(live).toHaveLength(0);
  });

  it('undoImportBatch: xoá mềm đúng lô và tính lại lãi/lỗ', async () => {
    const { API, fake } = ctx;
    const r = await API.asset.importTransactions(EMAIL, [row('2026-09-20', 'SSI', 'sell', 400, 33000, { line: 3, fee: 1, tax: 1 })], {});
    expect(fake.table('finance_transactions').find(t => t.type === 'sell').realized_pnl).toBe(1200000);
    const msg = await API.asset.undoImportBatch(EMAIL, r.batchId);
    expect(msg).toMatch(/1 lệnh/);
    expect(fake.table('finance_transactions').filter(t => !t.deleted_at)).toHaveLength(1);  // chỉ còn lệnh mua gốc
  });
});

describe('API.asset — báo cáo lãi/lỗ đã chốt', () => {
  it('ròng = gộp - phí mua phân bổ - phí bán - thuế; gom đúng năm; cộng cổ tức', async () => {
    const { API } = boot({
      finance_transactions: [
        T('b1', 'buy', 'AAA', 1000, 10000, '2025-06-01', { fee: 15000 }),
        T('s1', 'sell', 'AAA', 500, 12000, '2025-12-20', { fee: 9000, tax: 6000 }),
        T('s2', 'sell', 'AAA', 500, 9000, '2026-02-10', { fee: 6750, tax: 4500 }),
      ],
      finance_cash_flows: [{ id: 'c1', user_id: USER, flow_type: 'dividend', amount: 700000, flow_date: '2026-03-01', symbol: 'AAA', deleted_at: null, created_at: '2026-03-01T00:00:00Z' }],
    });
    const r25 = await API.asset.getRealizedReport(EMAIL, 2025);
    expect(r25.totals.netPnl).toBeCloseTo(1000000 - 7500 - 9000 - 6000, 6);
    const r26 = await API.asset.getRealizedReport(EMAIL, 2026);
    expect(r26.totals.netPnl).toBeCloseTo(-500000 - 7500 - 6750 - 4500, 6);
    expect(r26.dividendTotal).toBe(700000);
    expect(r26.years).toEqual([2026, 2025]);
    const dflt = await API.asset.getRealizedReport(EMAIL);
    expect(dflt.year).toBe(2026);
  });
});

describe('API.asset — danh sách theo dõi', () => {
  const quoteFn = async (b) => ({ data: { ok: true, series: { FPT: [['2026-10-01', 99000], ['2026-10-02', 98000]] } }, error: null });

  it('thêm mã: tạo dòng giá, lấy giá hiện tại ngay, ghi giá lúc thêm; trùng mã báo lỗi rõ', async () => {
    const { API, fake } = boot({}, { functions: { 'stock-history': quoteFn } });
    const msg = await API.asset.watchlist.add(EMAIL, { symbol: 'fpt', buyBelow: 100000, targetPrice: 130000, note: 'chờ điều chỉnh' });
    expect(msg).toMatch(/FPT/);
    const w = fake.table('finance_watchlist')[0];
    expect(w).toMatchObject({ symbol: 'FPT', buy_below: 100000, target_price: 130000, added_price: 98000 });
    const hp = fake.table('finance_holdings_price')[0];
    expect(hp).toMatchObject({ symbol: 'FPT', market_price: 98000, price_source: 'vnd-dchart' });
    await expect(API.asset.watchlist.add(EMAIL, { symbol: 'FPT' })).rejects.toThrow(/đã có trong danh sách/);
  });

  it('không lấy được giá ngay vẫn thêm được (cron cập nhật sau); mã sai bị từ chối', async () => {
    const { API, fake } = boot({});
    await API.asset.watchlist.add(EMAIL, { symbol: 'VNM', buyBelow: 60000 });
    expect(fake.table('finance_watchlist')).toHaveLength(1);
    await expect(API.asset.watchlist.add(EMAIL, { symbol: 'a;b' })).rejects.toThrow(/không hợp lệ/);
  });

  it('list: tín hiệu mua khi giá <= giá muốn mua và chưa giữ; giá mục tiêu từ định giá khi không nhập tay', async () => {
    const { API } = boot({
      finance_watchlist: [
        { id: 'w1', user_id: USER, symbol: 'FPT', buy_below: 100000, target_price: null, note: '', added_price: 120000, created_at: '2026-09-01T00:00:00Z' },
        { id: 'w2', user_id: USER, symbol: 'HPG', buy_below: 20000, target_price: 30000, note: '', added_price: 25000, created_at: '2026-09-02T00:00:00Z' },
        { id: 'w3', user_id: USER, symbol: 'SSI', buy_below: 40000, target_price: null, note: '', added_price: null, created_at: '2026-09-03T00:00:00Z' },
      ],
      finance_holdings_price: [
        { user_id: USER, symbol: 'FPT', market_price: 98000, locked: false, price_date: iso(0), price_source: 'vnd-dchart', updated_at: new Date().toISOString() },
        { user_id: USER, symbol: 'HPG', market_price: 25000, locked: false, price_date: iso(0), price_source: 'vnd-dchart', updated_at: new Date().toISOString() },
        { user_id: USER, symbol: 'SSI', market_price: 35000, locked: false, price_date: iso(0), price_source: 'vnd-dchart', updated_at: new Date().toISOString() },
      ],
      finance_stock_valuations: [{ symbol: 'FPT', year: 2026, data: { v1: 1000, v2: 2000, v3: 150, targetPE: 12, targetPB: 1.2 } }],
      finance_transactions: [T('t1', 'buy', 'SSI', 100, 30000, '2026-09-01')],
    });
    const list = await API.asset.watchlist.list(EMAIL);
    const by = Object.fromEntries(list.map(x => [x.symbol, x]));
    expect(by.FPT.signal).toBe('buy');
    expect(by.FPT.targetSource).toBe('valuation');
    expect(by.FPT.targetPrice).toBe(21000);
    expect(by.FPT.sinceAddedPct).toBeCloseTo((98000 / 120000 - 1) * 100, 6);
    expect(by.HPG.signal).toBeNull();                       // 25.000 > 20.000
    expect(by.HPG.targetSource).toBe('manual');
    expect(by.HPG.upsidePct).toBeCloseTo(20, 6);
    expect(by.SSI.held).toBe(true);
    expect(by.SSI.signal).toBe('buy');                      // giá 35.000 <= 40.000; held chỉ để hiển thị, email mới bỏ qua mã đã giữ
  });

  it('update / remove', async () => {
    const { API, fake } = boot({ finance_watchlist: [{ id: 'w1', user_id: USER, symbol: 'FPT', buy_below: 100000, target_price: null, note: '', created_at: '2026-09-01T00:00:00Z' }] });
    await API.asset.watchlist.update(EMAIL, 'w1', { buyBelow: 95000, note: 'đã đổi' });
    expect(fake.table('finance_watchlist')[0]).toMatchObject({ buy_below: 95000, note: 'đã đổi' });
    await API.asset.watchlist.update(EMAIL, 'w1', { buyBelow: 0 });
    expect(fake.table('finance_watchlist')[0].buy_below).toBeNull();
    await API.asset.watchlist.remove(EMAIL, 'w1');
    expect(fake.table('finance_watchlist')).toHaveLength(0);
  });
});

describe('API.asset — tỷ trọng mục tiêu', () => {
  it('lưu thay thế toàn bộ bộ mục tiêu; từ chối tổng > 100%', async () => {
    const { API, fake } = boot({ finance_allocation_targets: [{ user_id: USER, symbol: 'OLD', target_pct: 10 }] });
    await API.asset.allocation.save(EMAIL, { ssi: 40, VHM: 35.5, CASH: 10 });
    expect(await API.asset.allocation.list(EMAIL)).toEqual({ SSI: 40, VHM: 35.5, CASH: 10 });
    expect(fake.table('finance_allocation_targets').some(r => r.symbol === 'OLD')).toBe(false);
    await expect(API.asset.allocation.save(EMAIL, { A: 60, B: 50 })).rejects.toThrow(/vượt 100%/);
    expect(await API.asset.allocation.list(EMAIL)).toEqual({ SSI: 40, VHM: 35.5, CASH: 10 });   // lỗi không làm mất dữ liệu cũ
  });
  it('lưu bộ rỗng = xoá hết', async () => {
    const { API } = boot({ finance_allocation_targets: [{ user_id: USER, symbol: 'SSI', target_pct: 40 }] });
    await API.asset.allocation.save(EMAIL, {});
    expect(await API.asset.allocation.list(EMAIL)).toEqual({});
  });
});

describe('API.asset — dữ liệu báo cáo tháng', () => {
  it('gom đủ dữ liệu thô, gọi stock-history cho mọi mã + VNINDEX, ghi nhận lỗi giá lịch sử thay vì vỡ', async () => {
    const histFn = async (b) => ({ data: { ok: true, series: Object.fromEntries(b.symbols.map(s => [s, [['2026-09-30', 1000]]])) }, error: null });
    const { API, fake } = boot({
      finance_transactions: [T('t1', 'buy', 'SSI', 100, 30000, '2026-09-03')],
      finance_nav_history: [{ user_id: USER, snapshot_date: '2026-09-30', nav: 5e6, net_contributed: 0, cash: 0, debt: 0, market_value: 5e6 }],
      finance_benchmark_prices: [{ index_code: 'VNINDEX', price_date: '2026-09-30', close_value: 1250 }],
    }, { functions: { 'stock-history': histFn } });
    const inputs = await API.asset.getMonthlyReportInputs(EMAIL, '2026-09');
    expect(inputs.month).toBe('2026-09');
    expect(inputs.txns).toHaveLength(1);
    expect(inputs.navHistory).toHaveLength(1);
    expect(Object.keys(inputs.histories).sort()).toEqual(['SSI', 'VNINDEX']);
    expect(inputs.historyError).toBeNull();
    const call = fake.functionCalls[0];
    expect(call.body.symbols).toContain('VNINDEX');
    expect(call.body.from < '2026-09-01' && call.body.to >= '2026-09-30').toBe(true);

    const failing = boot({ finance_transactions: [T('t1', 'buy', 'SSI', 100, 30000, '2026-09-03')] }, { functions: { 'stock-history': async () => ({ data: null, error: { message: 'Failed to send a request' } }) } });
    const bad = await failing.API.asset.getMonthlyReportInputs(EMAIL, '2026-09');
    expect(bad.historyError).toMatch(/Failed to send/);
    expect(bad.histories).toEqual({});
    await expect(failing.API.asset.getMonthlyReportInputs(EMAIL, '2026/09')).rejects.toThrow(/Tháng không hợp lệ/);
  });
});

describe('callGAS — các hành động mới đã được nối', () => {
  it('dispatch + nằm trong danh sách hành động ghi (để hàng đợi ngoại tuyến và đồng bộ biết)', async () => {
    const { callGAS, sandbox } = boot({ finance_transactions: [T('e1', 'buy', 'SSI', 1000, 30000, '2026-09-03')] });
    const res = await callGAS('previewAssetImport', { email: EMAIL, rows: [row('2026-09-10', 'VHM', 'buy', 100, 70000)] });
    expect(res.status).toBe('success');
    expect(res.data.fresh).toHaveLength(1);
    ['importAssetTransactions', 'undoAssetImportBatch', 'addWatchlistItem', 'updateWatchlistItem', 'removeWatchlistItem', 'saveAllocationTargets']
      .forEach(a => expect(sandbox.MUTATING_ACTIONS.has(a)).toBe(true));
    ['previewAssetImport', 'getRealizedReport', 'getWatchlist', 'getAllocationTargets', 'getMonthlyReportInputs']
      .forEach(a => expect(sandbox.MUTATING_ACTIONS.has(a)).toBe(false));
  });
});
