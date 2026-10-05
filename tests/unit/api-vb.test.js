// API.asset.vb (Valuation Bench): lấy dữ liệu qua Edge Function + thống kê ngành, lưu bản ghi bất biến, đọc bản mới nhất / lịch sử -- chạy CHÍNH api.js trên Supabase giả.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/sector-map.js', 'lib/vn-market.js', 'lib/portfolio-calc.js', 'lib/limits-calc.js', 'lib/approval-calc.js', 'lib/corporate-events.js', 'lib/statement-import.js', 'lib/xlsx-writer.js', 'lib/reconcile.js', 'lib/valuation-calc.js', 'lib/decision-journal.js', 'lib/monthly-report.js', 'lib/ideas.js'];

const MEMBER = { id: 'u-1', email: 'an@x.vn', nickname: 'An', group_key: 'finance', active: true };
const OTHER = { id: 'u-3', email: 'binh@x.vn', nickname: 'Bình', group_key: 'finance', active: true };

function boot(actor = MEMBER, seed = {}, functions = {}) {
  const fake = createFakeSupabase(Object.assign({ users: [MEMBER, OTHER], fin_roles: [] }, seed), { authUser: { email: actor.email }, functions });
  const sandbox = {
    Date, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval: () => 0, Blob, Buffer, URL, TextEncoder, TextDecoder, atob, btoa,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: {}, document: { addEventListener() {}, getElementById: () => null, readyState: 'complete' },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  };
  sandbox.window = sandbox;
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sandbox.window.supabase = { createClient: () => fake.client };
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  LIBS.forEach((lib) => { try { vm.runInContext(read(lib).replace(/^const (\w+) = \(function/m, 'var $1 = (function'), sandbox); } catch (e) { /* thư viện không cần cho bài kiểm này */ } });
  vm.runInContext(read('api.js') + '\n;this.API = API; this.callGAS = window.callGAS;', sandbox);
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS };
}

const REC = (over) => Object.assign({ symbol: 'fpt', as_of: '2026-10-02', price: 62100, form: 'NON_FINANCE', fair_low: 55000, fair_base: 80000, fair_high: 105000, margin_of_safety: 0.22, grade: 'Rẻ so với giá trị ước tính', stance: 'Rẻ nhưng giá chưa xác nhận', confidence: 'Vừa', confidence_score: 60,
  tech_score: -40, tech_rating: 'Xu hướng giảm', timing: 'x', market_score: 5, composite: 10, accumulate_low: 50000, accumulate_high: 64000, invalidation: 54000, methods: [{ key: 'dcf', base: 90000 }], assumptions: { dcf: { wacc: 0.09 } }, summary: { reasons: { pos: [], neg: [] } }, note: 'thử' }, over || {});

describe('lưu định giá', () => {
  it('chuẩn hoá mã, gắn người lưu, giữ các trường số và JSON', async () => {
    const c = boot();
    const r = await c.API.asset.vb.save('an@x.vn', REC());
    expect(r.id).toBeTruthy();
    const row = c.fake.table('finance_vb_valuations')[0];
    expect(row).toMatchObject({ user_id: 'u-1', symbol: 'FPT', as_of: '2026-10-02', price: 62100, fair_base: 80000, tech_score: -40, note: 'thử' });
    expect(row.methods).toEqual([{ key: 'dcf', base: 90000 }]); expect(row.assumptions.dcf.wacc).toBe(0.09);
  });
  it('mỗi lần lưu là một bản ghi mới (lịch sử bất biến)', async () => {
    const c = boot();
    await c.API.asset.vb.save('an@x.vn', REC()); await c.API.asset.vb.save('an@x.vn', REC({ fair_base: 85000 }));
    expect(c.fake.table('finance_vb_valuations')).toHaveLength(2);
  });
  it('từ chối mã sai, thiếu ngày, thiếu giá trị hợp lý và dữ liệu quá lớn', async () => {
    const c = boot();
    await expect(c.API.asset.vb.save('an@x.vn', REC({ symbol: 'a/b' }))).rejects.toThrow(/Mã không hợp lệ/);
    await expect(c.API.asset.vb.save('an@x.vn', REC({ as_of: '' }))).rejects.toThrow(/ngày/);
    await expect(c.API.asset.vb.save('an@x.vn', REC({ fair_base: null }))).rejects.toThrow(/giá trị hợp lý/);
    await expect(c.API.asset.vb.save('an@x.vn', REC({ summary: { x: 'a'.repeat(50000) } }))).rejects.toThrow(/quá lớn/);
    expect(c.fake.table('finance_vb_valuations')).toHaveLength(0);
  });
  it('giá không dương lưu null; số không hợp lệ lưu null; danh sách phương pháp bị giới hạn 40', async () => {
    const c = boot();
    await c.API.asset.vb.save('an@x.vn', REC({ price: -5, tech_score: 'abc', methods: Array.from({ length: 60 }, (_, i) => ({ key: 'm' + i })) }));
    const row = c.fake.table('finance_vb_valuations')[0];
    expect(row.price).toBeNull(); expect(row.tech_score).toBeNull(); expect(row.methods).toHaveLength(40);
  });
});

describe('đọc bản đã lưu', () => {
  const seed = () => ({ finance_vb_valuations: [
    { id: 'a', user_id: 'u-1', symbol: 'FPT', as_of: '2026-09-01', fair_base: 70000, created_at: '2026-09-01T10:00:00Z' },
    { id: 'b', user_id: 'u-3', symbol: 'FPT', as_of: '2026-10-02', fair_base: 80000, created_at: '2026-10-02T10:00:00Z' },
    { id: 'c', user_id: 'u-1', symbol: 'VCB', as_of: '2026-10-01', fair_base: 100000, created_at: '2026-10-01T10:00:00Z' },
  ] });
  it('latest trả bản mới nhất kèm tên tác giả; mã chưa có trả null', async () => {
    const c = boot(MEMBER, seed());
    const r = await c.API.asset.vb.latest('fpt');
    expect(r.id).toBe('b'); expect(r.author).toBe('Bình'); expect(await c.API.asset.vb.latest('HPG')).toBeNull();
  });
  it('latestMany: mỗi mã một bản mới nhất; bỏ mã sai; rỗng không gọi DB', async () => {
    const c = boot(MEMBER, seed());
    const m = await c.API.asset.vb.latestMany(['FPT', 'vcb', 'x y', 'HPG']);
    expect(Object.keys(m).sort()).toEqual(['FPT', 'VCB']); expect(m.FPT.id).toBe('b');
    expect(await c.API.asset.vb.latestMany([])).toEqual({});
  });
  it('history: mới trước, kèm tác giả; listLatest: mỗi mã một dòng', async () => {
    const c = boot(MEMBER, seed());
    const h = await c.API.asset.vb.history('FPT'); expect(h.map((x) => x.id)).toEqual(['b', 'a']); expect(h[1].author).toBe('An');
    const l = await c.API.asset.vb.listLatest(); expect(l.map((x) => x.symbol).sort()).toEqual(['FPT', 'VCB']);
  });
  it('callGAS định tuyến các hành động mới', async () => {
    const c = boot(MEMBER, seed());
    const r = await c.callGAS('getVbLatest', { symbol: 'VCB', email: 'an@x.vn' });
    expect(r.status).toBe('success'); expect(r.data.id).toBe('c');
    const s = await c.callGAS('saveVbValuation', { record: REC(), email: 'an@x.vn' });
    expect(s.status).toBe('success');
  });
});

describe('xoá', () => {
  it('gọi xoá qua DB; không xoá được thì báo lỗi rõ', async () => {
    const c = boot(MEMBER, { finance_vb_valuations: [{ id: 'a', user_id: 'u-1', symbol: 'FPT', as_of: '2026-09-01', fair_base: 1, created_at: '2026-09-01T00:00:00Z' }] });
    expect(await c.API.asset.vb.remove('an@x.vn', 'a')).toMatch(/Đã xoá/);
    await expect(c.API.asset.vb.remove('an@x.vn', 'khong-co')).rejects.toThrow(/Không xoá được/);
  });
});

describe('lấy dữ liệu một mã', () => {
  const edge = { 'vb-data': () => ({ data: { ok: true, symbol: 'FPT', form: 'NON_FINANCE', annualRows: [], quarterRows: [], candles: null, indexCandles: null, ratioSeries: { pe: [] }, errors: { ohlc: 'x' } }, error: null }) };
  it('ghép dữ liệu Edge với thống kê ngành và lịch sử định giá; lỗi nguồn phụ được trả riêng, không làm hỏng cả lần tải', async () => {
    const c = boot(MEMBER, {}, edge);
    const r = await c.API.asset.vb.data('fpt');
    expect(r.symbol).toBe('FPT'); expect(r.vb.form).toBe('NON_FINANCE'); expect(r.history).toBeTruthy(); expect(r.errors.ohlc).toBe('x');
  });
  it('mã sai bị từ chối; Edge báo lỗi thì ném lỗi', async () => {
    const c = boot(MEMBER, {}, edge);
    await expect(c.API.asset.vb.data('a b')).rejects.toThrow(/không hợp lệ/);
    const bad = boot(MEMBER, {}, { 'vb-data': () => ({ data: { ok: false, error: 'Cần đăng nhập.' }, error: null }) });
    await expect(bad.API.asset.vb.data('FPT')).rejects.toThrow(/Cần đăng nhập/);
  });
});
