// Chạy CHÍNH api.js (API.stock.*) trên Supabase giả trong bộ nhớ: lưu hồ sơ định giá, dữ liệu quý, giá hiện tại, bảng so sánh,
// áp dụng giá mục tiêu / giá muốn mua vào danh mục. Mục đích: bắt lỗi nối giữa lớp truy cập dữ liệu và trang Định Giá / Tổng Hợp CP.
import { describe, it, expect } from 'vitest';
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

const price = (symbol, p, extra = {}) => Object.assign({ user_id: USER, symbol, market_price: p, locked: false, price_date: iso(0), price_source: 'vnd-dchart', updated_at: new Date().toISOString() }, extra);
const val = (symbol, year, data) => ({ symbol, year, data: Object.assign({ symbol, year }, data), updated_at: '2026-09-01T00:00:00Z', updated_by: EMAIL });

describe('API.stock.saveStockValuation', () => {
  it('lưu theo (mã, năm), ghi đè đúng bản ghi cũ và KHÔNG lưu email vào hồ sơ', async () => {
    const { API, fake } = boot();
    await API.stock.saveStockValuation({ symbol: 'fpt', year: 2026, v1: 1000, fair_value: 21000, email: EMAIL }, EMAIL);
    await API.stock.saveStockValuation({ symbol: 'FPT', year: 2026, v1: 1000, fair_value: 25000, email: EMAIL }, EMAIL);
    await API.stock.saveStockValuation({ symbol: 'FPT', year: 2025, v1: 900 }, EMAIL);
    const rows = fake.table('finance_stock_valuations');
    expect(rows).toHaveLength(2);
    const r26 = rows.find(r => r.year === 2026);
    expect(r26.data.fair_value).toBe(25000);
    expect('email' in r26.data).toBe(false);
    expect(r26.updated_by).toBe(EMAIL);
    await expect(API.stock.saveStockValuation({ symbol: '  ', year: 2026 }, EMAIL)).rejects.toThrow(/Thiếu mã/);
  });
});

describe('API.stock.deleteValuation', () => {
  it('chỉ xoá đúng (mã, năm), mã/năm thiếu bị từ chối', async () => {
    const { API, fake } = boot({ finance_stock_valuations: [val('FPT', 2026, {}), val('FPT', 2025, {}), val('VNM', 2026, {})] });
    await API.stock.deleteValuation('fpt', 2026);
    expect(fake.table('finance_stock_valuations').map(r => r.symbol + r.year).sort()).toEqual(['FPT2025', 'VNM2026']);
    await expect(API.stock.deleteValuation('', 2026)).rejects.toThrow(/Thiếu/);
    await expect(API.stock.deleteValuation('FPT', 0)).rejects.toThrow(/Thiếu/);
  });
});

describe('API.stock — dữ liệu quý', () => {
  it('lưu / sửa / xoá quý; kiểm tra đầu vào', async () => {
    const { API, fake } = boot();
    await API.stock.saveQuarter({ symbol: 'fpt', year: 2026, quarter: 1, lnst: 30, revenue: '' }, EMAIL);
    await API.stock.saveQuarter({ symbol: 'FPT', year: 2026, quarter: 1, lnst: 35, revenue: 400 }, EMAIL);
    await API.stock.saveQuarter({ symbol: 'FPT', year: 2025, quarter: 4, lnst: 28 }, EMAIL);
    expect(fake.table('finance_stock_quarters')).toHaveLength(2);
    expect(fake.table('finance_stock_quarters').find(q => q.year === 2026)).toMatchObject({ lnst: 35, revenue: 400, symbol: 'FPT' });
    expect(fake.table('finance_stock_quarters').find(q => q.year === 2025).revenue).toBeNull();
    const list = await API.stock.getQuarters('fpt');
    expect(list.map(q => q.year * 10 + q.quarter)).toEqual([20261, 20254]); // mới trước
    await API.stock.deleteQuarter('FPT', 2026, 1);
    expect(fake.table('finance_stock_quarters')).toHaveLength(1);
    await expect(API.stock.saveQuarter({ symbol: 'FPT', year: 2026, quarter: 5, lnst: 1 })).rejects.toThrow(/Quý/);
    await expect(API.stock.saveQuarter({ symbol: 'FPT', year: 1999, quarter: 1, lnst: 1 })).rejects.toThrow(/Năm/);
    await expect(API.stock.saveQuarter({ symbol: 'FPT', year: 2026, quarter: 1, lnst: '' })).rejects.toThrow(/lợi nhuận/);
    await expect(API.stock.saveQuarter({ symbol: 'FPT', year: 2026, quarter: 1, lnst: 1, revenue: 'abc' })).rejects.toThrow(/Doanh thu/);
  });
});

describe('API.stock.getLivePrices', () => {
  const series = { VNM: [['2026-10-01', 60000], ['2026-10-02', 61000]], HPG: [['2026-10-02', 27000]] };
  it('ưu tiên giá còn mới trong Bàn Tài Sản; giá cũ hoặc thiếu thì lấy giá đóng cửa từ máy chủ', async () => {
    const { API, fake } = boot({
      finance_holdings_price: [price('FPT', 98000), price('HPG', 20000, { price_date: iso(-10) })],
    }, { functions: { 'stock-history': async () => ({ data: { ok: true, series }, error: null }) } });
    const out = await API.stock.getLivePrices(['fpt', 'HPG', 'VNM', 'bad;sym', 'FPT'], EMAIL);
    expect(out.FPT).toMatchObject({ price: 98000, source: 'portfolio' });
    expect(out.HPG).toMatchObject({ price: 27000, source: 'market', date: '2026-10-02' });
    expect(out.VNM).toMatchObject({ price: 61000, source: 'market' });
    expect(Object.keys(out).sort()).toEqual(['FPT', 'HPG', 'VNM']);
    const call = fake.functionCalls.find(c => c.name === 'stock-history');
    expect(call.body.symbols.sort()).toEqual(['HPG', 'VNM']); // FPT đã có giá, không hỏi lại
  });
  it('máy chủ lỗi -> bỏ qua mã đó, không văng lỗi', async () => {
    const { API } = boot({ finance_holdings_price: [price('FPT', 98000)] });
    const out = await API.stock.getLivePrices(['FPT', 'VNM'], EMAIL);
    expect(Object.keys(out)).toEqual(['FPT']);
    expect(await API.stock.getLivePrices([], EMAIL)).toEqual({});
  });
});

describe('API.stock.getOverview', () => {
  it('mỗi mã 1 dòng (năm mới nhất), kèm năm liền trước, dữ liệu quý, giá và nhãn đang nắm / theo dõi', async () => {
    const { API } = boot({
      finance_stock_valuations: [
        val('FPT', 2026, { v1: 1000, v3: 150 }), val('FPT', 2025, { v1: 1000, v3: 120 }), val('FPT', 2022, { v1: 800, v3: 90 }),
        val('VNM', 2024, { v1: 500, v3: 40 }), val('VNM', 2022, { v1: 500, v3: 30 }),
        val('HPG', 2026, { v1: 700, v3: 60 }),
      ],
      finance_stock_quarters: [{ symbol: 'FPT', year: 2026, quarter: 1, lnst: 30, revenue: null }],
      finance_holdings_price: [price('FPT', 98000)],
      finance_transactions: [{ id: 't1', user_id: USER, type: 'buy', symbol: 'FPT', quantity: 100, price: 90000, trade_date: '2026-09-01', created_at: '2026-09-01T01:00:00Z', fee: 0, tax: 0, deleted_at: null }],
      finance_watchlist: [{ id: 'w1', user_id: USER, symbol: 'HPG', buy_below: 20000, created_at: '2026-09-02T00:00:00Z' }],
    }, { functions: { 'stock-history': async () => ({ data: { ok: true, series: { VNM: [['2026-10-02', 61000]] } }, error: null }) } });
    const items = await API.stock.getOverview(EMAIL);
    const by = Object.fromEntries(items.map(x => [x.symbol, x]));
    expect(Object.keys(by).sort()).toEqual(['FPT', 'HPG', 'VNM']);
    expect(by.FPT).toMatchObject({ year: 2026, price: 98000, priceSource: 'portfolio', held: true, watched: false });
    expect(by.FPT.prev.v3).toBe(120);                 // 2025 liền trước -> có tăng trưởng
    expect(by.FPT.quarters).toHaveLength(1);
    expect(by.VNM.prev).toBeNull();                   // 2022 không liền kề 2024 -> không so tăng trưởng
    expect(by.VNM).toMatchObject({ year: 2024, price: 61000, priceSource: 'market' });
    expect(by.HPG).toMatchObject({ watched: true, held: false, price: 0, priceSource: null });
  });
  it('chưa có hồ sơ nào -> mảng rỗng', async () => {
    const { API } = boot();
    expect(await API.stock.getOverview(EMAIL)).toEqual([]);
  });
});

describe('API.stock.pushToPortfolio', () => {
  const heldBuy = { id: 't1', user_id: USER, type: 'buy', symbol: 'FPT', quantity: 100, price: 90000, trade_date: '2026-09-01', created_at: '2026-09-01T01:00:00Z', fee: 0, tax: 0, deleted_at: null };

  it('mã đang nắm: giá mục tiêu ghi vào ngưỡng mục tiêu của mã, không tự thêm vào Theo Dõi', async () => {
    const { API, fake } = boot({ finance_transactions: [heldBuy], finance_holdings_price: [price('FPT', 98000)] });
    const msg = await API.stock.pushToPortfolio(EMAIL, 'fpt', { targetPrice: 130000 });
    expect(msg).toMatch(/FPT.*giá mục tiêu/);
    expect(fake.table('finance_holdings_price')[0].target_price).toBe(130000);
    expect(fake.table('finance_watchlist')).toHaveLength(0);
  });
  it('mã chưa nắm, chưa theo dõi: thêm vào Theo Dõi với giá muốn mua và giá mục tiêu', async () => {
    const { API, fake } = boot();
    await API.stock.pushToPortfolio(EMAIL, 'VNM', { targetPrice: 80000, buyBelow: 60000 });
    expect(fake.table('finance_watchlist')[0]).toMatchObject({ symbol: 'VNM', buy_below: 60000, target_price: 80000, note: 'Từ Định Giá CP' });
  });
  it('mã đã trong Theo Dõi: cập nhật mục đó, không tạo trùng', async () => {
    const { API, fake } = boot({ finance_watchlist: [{ id: 'w1', user_id: USER, symbol: 'VNM', buy_below: 50000, target_price: null, created_at: '2026-09-02T00:00:00Z' }] });
    await API.stock.pushToPortfolio(EMAIL, 'VNM', { buyBelow: 62000 });
    expect(fake.table('finance_watchlist')).toHaveLength(1);
    expect(fake.table('finance_watchlist')[0]).toMatchObject({ buy_below: 62000, target_price: null });
  });
  it('mã đang nắm + muốn mua thêm: vừa đặt mục tiêu cho mã vừa thêm giá muốn mua vào Theo Dõi', async () => {
    const { API, fake } = boot({ finance_transactions: [heldBuy], finance_holdings_price: [price('FPT', 98000)] });
    await API.stock.pushToPortfolio(EMAIL, 'FPT', { targetPrice: 130000, buyBelow: 85000 });
    expect(fake.table('finance_holdings_price')[0].target_price).toBe(130000);
    expect(fake.table('finance_watchlist')[0]).toMatchObject({ symbol: 'FPT', buy_below: 85000 });
  });
  it('từ chối khi không có mức giá, mã sai hoặc người dùng lạ', async () => {
    const { API } = boot();
    await expect(API.stock.pushToPortfolio(EMAIL, 'FPT', {})).rejects.toThrow(/mức giá/);
    await expect(API.stock.pushToPortfolio(EMAIL, 'a;b', { buyBelow: 1 })).rejects.toThrow(/không hợp lệ/);
    await expect(API.stock.pushToPortfolio('la@example.com', 'FPT', { buyBelow: 1 })).rejects.toThrow(/không tồn tại/);
  });
});

describe('callGAS: các lệnh định giá mới', () => {
  it('đi đúng nhánh và lệnh ghi được đánh dấu là thay đổi dữ liệu (hàng đợi ngoại tuyến)', async () => {
    const { callGAS, fake } = boot({ finance_holdings_price: [price('FPT', 98000)] });
    const live = await callGAS('getStockLivePrices', { symbols: ['FPT'], email: EMAIL });
    expect(live.data.FPT.price).toBe(98000);
    const saved = await callGAS('saveStockQuarter', { symbol: 'FPT', year: 2026, quarter: 2, lnst: 10, email: EMAIL });
    expect(saved.status).toBe('success');
    expect(fake.table('finance_stock_quarters')).toHaveLength(1);
    const src = read('api.js');
    ['saveStockQuarter', 'deleteStockQuarter', 'pushStockToPortfolio'].forEach(a => expect(src).toContain(`'${a}'`));
  });
});
