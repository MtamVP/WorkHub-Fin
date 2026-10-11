// Chạy CHÍNH api.js + insight/insight-api.js (API.insight.*) trên Supabase giả: kho dữ liệu theo thời điểm, sở hữu, luận điểm, nhật ký dự phóng, đầu vào chấm dự phóng.
// Chính sách RLS ở cơ sở dữ liệu (ai được ghi) KHÔNG được mô phỏng ở đây; phần đó kiểm bằng khối DO ở phiên triển khai và ghi trong RUNBOOK.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from '../helpers/fake-supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const LIBS = ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/thesis-calc.js'];
const USER = 'u-1', EMAIL = 'toi@example.com';

function boot(seed = {}, fns = {}) {
  const fake = createFakeSupabase(Object.assign({ users: [{ id: USER, email: EMAIL, nickname: 'Tôi', group_key: 'finance' }, { id: 'u-2', email: 'minh@example.com', nickname: null, group_key: 'finance' }] }, seed), { authUser: { id: USER, email: EMAIL }, functions: fns });
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
  LIBS.forEach((lib) => vm.runInContext(read(lib).replace(/^const (\w+) = \(function/m, 'var $1 = (function'), sandbox));
  vm.runInContext(read('api.js') + '\n' + read('insight/insight-api.js') + '\n;this.API = API; this.callGAS = window.callGAS;', sandbox);
  return { fake, API: sandbox.API, callGAS: sandbox.callGAS };
}
const cond = (o) => Object.assign({ ideaId: 'i1', metric: 'roae', op: '>=', threshold: '15', severity: 'critical', label: 'ROE không sụt', manualMet: null }, o || {});

describe('Kho dữ liệu theo thời điểm', () => {
  const seed = {
    finance_pit_market_daily: [{ as_of: '2026-10-07', n: 1522, captured_at: 'x', cols: ['icb2'], data: {} }, { as_of: '2026-10-05', n: 1520 }, { as_of: '2026-10-09', n: 1522 }],
    finance_pit_fundamentals: [{ symbol: 'FPT', seen_at: '2026-10-11', quarter_key: '2026Q2' }, { symbol: 'FPT', seen_at: '2026-07-20', quarter_key: '2026Q1' }, { symbol: 'VNM', seen_at: '2026-10-11' }],
    finance_pit_news: [{ id: 'a', first_seen: '2026-10-11T01:00:00Z' }, { id: 'b', first_seen: '2026-10-11T04:00:00Z' }],
    finance_function_runs: [{ fn: 'pit-capture', mode: 'daily', run_at: '2026-10-09T12:05:00Z', ok: true, detail: {} }, { fn: 'market-data-sync', mode: 'x', run_at: '2026-10-09T11:00:00Z', ok: true, detail: {} }, { fn: 'insight-sync', mode: 'news', run_at: '2026-10-09T09:10:00Z', ok: true, detail: {} }],
  };
  it('trạng thái: ngày chụp tăng dần, số báo cáo / tin và ngày đầu, chỉ lấy lần chạy của hai hàm này', async () => {
    const { API } = boot(seed);
    const s = await API.insight.pitStatus();
    expect(s.days.map((d) => d.as_of)).toEqual(['2026-10-05', '2026-10-07', '2026-10-09']);
    expect(s.fundamentals).toMatchObject({ count: 3, first: '2026-07-20' }); expect(s.news).toMatchObject({ count: 2, first: '2026-10-11T01:00:00Z' });
    expect(s.runs.map((r) => r.fn)).toEqual(['pit-capture', 'insight-sync']);
  });
  it('bản chụp như ngày D: mới nhất không sau D; trước bản đầu tiên thì null; ngày sai bị từ chối', async () => {
    const { API } = boot(seed);
    expect((await API.insight.pitDay('2026-10-08')).as_of).toBe('2026-10-07');
    expect((await API.insight.pitDay('2026-10-09')).as_of).toBe('2026-10-09');
    expect(await API.insight.pitDay('2026-01-01')).toBeNull();
    await expect(API.insight.pitDay('hôm qua')).rejects.toThrow('Ngày không hợp lệ');
  });
  it('báo cáo của một mã theo thứ tự thời gian; mã sai bị từ chối', async () => {
    const { API } = boot(seed);
    expect((await API.insight.pitFundamentals('fpt')).map((r) => r.quarter_key)).toEqual(['2026Q1', '2026Q2']);
    await expect(API.insight.pitFundamentals('<x>')).rejects.toThrow('Mã không hợp lệ');
  });
});

describe('Sở hữu', () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const seed = {
    finance_shareholders: [{ symbol: 'FPT', owner_key: 'a', owner_name: 'A', pct: 5.7 }, { symbol: 'FPT', owner_key: 'b', owner_name: 'B', pct: 6.9 }, { symbol: 'VNM', owner_key: 'c', owner_name: 'C', pct: 9 }],
    finance_insider_trades: [{ id: 't1', symbol: 'FPT', public_date: day(10) }, { id: 't2', symbol: 'FPT', public_date: day(200) }, { id: 't3', symbol: 'FPT', public_date: day(500) }, { id: 't4', symbol: 'VNM', public_date: day(5) }],
    finance_ownership_sync: [{ symbol: 'FPT', ok: true, synced_at: 'x' }],
    finance_stock_ratios: [{ symbol: 'FPT', metrics: { foreignRoomLeftPct: 12.5 }, updated_at: 'x' }],
  };
  it('một mã: cổ đông theo tỷ lệ giảm dần, giao dịch trong 400 ngày, tình trạng đồng bộ, phòng khối ngoại', async () => {
    const { API } = boot(seed);
    const o = await API.insight.ownership('fpt');
    expect(o.holders.map((h) => h.owner_name)).toEqual(['B', 'A']); expect(o.trades.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(o.sync.ok).toBe(true); expect(o.ratios.foreignRoomLeftPct).toBe(12.5);
  });
  it('tổng quan: chỉ giao dịch 100 ngày, mã không hợp lệ bị bỏ, ratios theo mã', async () => {
    const { API } = boot(seed);
    const o = await API.insight.ownershipOverview(['FPT', 'VNM', 'x y', 'fpt']);
    expect(o.symbols).toEqual(['FPT', 'VNM']); expect(o.trades.map((t) => t.id).sort()).toEqual(['t1', 't4']); expect(o.ratios.FPT.foreignRoomLeftPct).toBe(12.5);
    expect((await API.insight.ownershipOverview([])).symbols).toEqual([]);
  });
  it('đồng bộ: gửi chế độ và mã đã chuẩn hoá (tối đa 10), lỗi của hàm nổi lên, rỗng bị từ chối', async () => {
    const calls = [];
    const { API } = boot({}, { 'insight-sync': async (b) => { calls.push(b); return b.symbols.includes('BAD') ? { data: null, error: { message: 'lỗi nguồn' } } : { data: { ok: true, synced: b.symbols.length }, error: null }; } });
    const r = await API.insight.syncOwnership(['fpt', 'VNM', 'fpt', 'a'.repeat(30), ...'ABCDEFGHIJKLMNOP'.split('').map((c) => c + '1')]);
    expect(calls[0]).toMatchObject({ mode: 'ownership' }); expect(calls[0].symbols).toHaveLength(10); expect(calls[0].symbols.slice(0, 2)).toEqual(['FPT', 'VNM']); expect(r.ok).toBe(true);
    await expect(API.insight.syncOwnership(['BAD'])).rejects.toThrow('lỗi nguồn');
    await expect(API.insight.syncOwnership([])).rejects.toThrow('Chưa có mã nào');
  });
});

describe('Luận điểm', () => {
  const seed = () => ({
    finance_ideas: [{ id: 'i1', user_id: USER, symbol: 'FPT', title: 'T1', status: 'approved', updated_at: '2026-10-02' }, { id: 'i2', user_id: 'u-2', symbol: 'HPG', title: 'T2', status: 'closed', updated_at: '2026-10-03' }, { id: 'i3', user_id: USER, symbol: 'VCB', title: 'T3', status: 'research', updated_at: '2026-10-04' }],
    finance_thesis_conditions: [{ id: 'c1', idea_id: 'i1', metric: 'roae' }],
    finance_thesis_log: [{ id: 1, condition_id: 'c1', idea_id: 'i1', at: '2026-10-01T00:00:00Z' }, { id: 2, condition_id: 'c1', idea_id: 'i1', at: '2026-10-02T00:00:00Z' }],
    finance_market_snapshot: [{ symbol: 'FPT', metrics: { roae: 0.2 }, daily_date: '2026-10-09' }, { symbol: 'HPG', metrics: {}, daily_date: '2026-10-08' }],
    finance_stock_ratios: [{ symbol: 'FPT', metrics: { foreignRoomLeftPct: 12 } }],
    finance_ownership_sync: [{ symbol: 'FPT', ok: true }, { symbol: 'HPG', ok: false }],
    finance_insider_trades: [{ id: 't', symbol: 'FPT', public_date: new Date().toISOString().slice(0, 10) }],
  });
  it('danh sách: chỉ ý tưởng đang mở, mới cập nhật trước; tên thành viên rút gọn từ email khi không có biệt danh', async () => {
    const { API } = boot(seed());
    const l = await API.insight.thesisList();
    expect(l.ideas.map((i) => i.id)).toEqual(['i3', 'i1']); expect(l.log.map((x) => x.id)).toEqual([2, 1]); expect(l.members).toEqual({ 'u-1': 'Tôi', 'u-2': 'minh' });
  });
  it('số liệu hiện tại: ảnh chụp, phòng khối ngoại, giao dịch nội bộ, mã đã đồng bộ thành công, ngày mới nhất', async () => {
    const { API } = boot(seed());
    const c = await API.insight.thesisContext(['FPT', 'HPG']);
    expect(c.snapshots.FPT.roae).toBe(0.2); expect(c.ratios.FPT.foreignRoomLeftPct).toBe(12); expect(c.insider.FPT).toHaveLength(1); expect(c.synced).toEqual(['FPT']); expect(c.snapshotDate).toBe('2026-10-09');
    expect((await API.insight.thesisContext([])).snapshots).toEqual({});
  });
  it('thêm điều kiện: kiểm form trước khi ghi, gắn người dùng, tối đa 12 điều kiện mỗi ý tưởng', async () => {
    const { API, fake } = boot(seed());
    await expect(API.insight.saveThesisCondition(EMAIL, cond({ threshold: 'abc' }))).rejects.toThrow('ngưỡng');
    await expect(API.insight.saveThesisCondition(EMAIL, cond({ metric: 'khong-co' }))).rejects.toThrow('chỉ tiêu');
    await expect(API.insight.saveThesisCondition(EMAIL, cond({ ideaId: null }))).rejects.toThrow('Thiếu ý tưởng');
    expect(await API.insight.saveThesisCondition(EMAIL, cond())).toBe('Đã thêm điều kiện');
    const row = fake.table('finance_thesis_conditions').find((r) => r.metric === 'roae' && r.user_id);
    expect(row).toMatchObject({ idea_id: 'i1', user_id: USER, op: '>=', threshold: 15, severity: 'critical', label: 'ROE không sụt', manual_met: null });
    for (let k = 0; k < 10; k++) await API.insight.saveThesisCondition(EMAIL, cond({ threshold: String(10 + k) }));
    await expect(API.insight.saveThesisCondition(EMAIL, cond({ threshold: '99' }))).rejects.toThrow('tối đa 12');
  });
  it('sửa, đặt tay điều kiện thủ công và xoá', async () => {
    const { API, fake } = boot(seed());
    await API.insight.saveThesisCondition(EMAIL, cond({ metric: 'manual', label: 'Có giấy phép', op: '>=', threshold: '' }));
    const m = fake.table('finance_thesis_conditions').find((r) => r.metric === 'manual');
    expect(m).toMatchObject({ label: 'Có giấy phép', manual_met: null, severity: 'critical' });
    await API.insight.setThesisManual(EMAIL, m.id, true); expect(fake.table('finance_thesis_conditions').find((r) => r.id === m.id).manual_met).toBe(true);
    await API.insight.setThesisManual(EMAIL, m.id, 'khác'); expect(fake.table('finance_thesis_conditions').find((r) => r.id === m.id).manual_met).toBeNull();
    await API.insight.saveThesisCondition(EMAIL, cond({ id: 'c1', threshold: '18' })); expect(fake.table('finance_thesis_conditions').find((r) => r.id === 'c1').threshold).toBe(18);
    await API.insight.deleteThesisCondition(EMAIL, 'c1'); expect(fake.table('finance_thesis_conditions').some((r) => r.id === 'c1')).toBe(false);
  });
  it('callGAS chuyển action Insight xuống đúng hàm và việc ghi nằm trong danh sách thao tác ghi', async () => {
    const { callGAS } = boot(seed());
    const r = await callGAS('listThesis', {});
    expect(r.status).toBe('success'); expect(r.data.ideas).toHaveLength(2);
  });
});

describe('Độ chính xác dự phóng', () => {
  it('đầu vào: bản định giá, ý tưởng, quyết định chưa xoá, dự phóng, thành viên', async () => {
    const { API } = boot({
      finance_vb_valuations: [{ id: 'v1', symbol: 'FPT', created_at: '2026-01-01' }], finance_ideas: [{ id: 'i1' }],
      finance_decisions: [{ id: 'd1', deleted_at: null }, { id: 'd2', deleted_at: '2026-01-01' }], finance_forecasts: [{ id: 'f1', made_at: '2026-01-01' }, { id: 'f2', made_at: '2026-06-01' }],
    });
    const r = await API.insight.accuracyInputs();
    expect(r.valuations).toHaveLength(1); expect(r.decisions.map((d) => d.id)).toEqual(['d1']); expect(r.forecasts.map((f) => f.id)).toEqual(['f2', 'f1']); expect(r.members['u-1']).toBe('Tôi');
  });
  it('giá và sự kiện: gửi mã đã chuẩn hoá kèm VNINDEX, lỗi phần phụ không làm hỏng cả kết quả', async () => {
    const seen = [];
    const { API } = boot({}, {
      'stock-history': async (b) => { seen.push(b); return { data: { ok: true, series: { FPT: [['2026-01-02', 100]], VNINDEX: [['2026-01-02', 1000]] } }, error: null }; },
      'stock-events': async () => ({ data: null, error: { message: 'nguồn sự kiện lỗi' } }),
    });
    const r = await API.insight.forwardInputs(['fpt', 'x y', 'FPT'], '2026-01-01');
    expect(seen[0].symbols).toEqual(['FPT', 'VNINDEX']); expect(r.histories.FPT).toHaveLength(1); expect(r.events).toEqual([]); expect(r.eventsError).toContain('nguồn sự kiện lỗi'); expect(r.from).toBe('2026-01-01');
  });
  it('số liệu thực tế: dùng bảng đệm trước, mã thiếu mới hỏi stock-financials; lỗi gom vào errors', async () => {
    const asked = [];
    const { API } = boot({ finance_financials_cache: [{ symbol: 'FPT', payload: { quarters: [{ year: 2026, quarter: 2, lnst: 3e12 }] } }] }, { 'stock-financials': async (b) => { asked.push(b.symbols); return { data: { ok: true, results: { HPG: { annual: [{ year: 2025, lnst: 1 }] } }, errors: { ZZZ: 'không có' } }, error: null }; } });
    const r = await API.insight.forecastActuals(['FPT', 'HPG', 'ZZZ']);
    expect(asked).toEqual([['HPG', 'ZZZ']]); expect(Object.keys(r.results).sort()).toEqual(['FPT', 'HPG']); expect(r.errors.ZZZ).toBe('không có');
  });
  it('ghi dự phóng: kiểm mã, chỉ tiêu, năm, quý, số; ghi đúng cột; xoá được', async () => {
    const { API, fake } = boot();
    const ok = { symbol: 'fpt', metric: 'lnst', year: 2026, quarter: 2, value: 3.1e12, note: 'ghi chú' };
    await expect(API.insight.saveForecast(EMAIL, Object.assign({}, ok, { symbol: '' }))).rejects.toThrow('Mã không hợp lệ');
    await expect(API.insight.saveForecast(EMAIL, Object.assign({}, ok, { metric: 'eps' }))).rejects.toThrow('Chọn chỉ tiêu');
    await expect(API.insight.saveForecast(EMAIL, Object.assign({}, ok, { year: 1999 }))).rejects.toThrow('Năm không hợp lệ');
    await expect(API.insight.saveForecast(EMAIL, Object.assign({}, ok, { quarter: 5 }))).rejects.toThrow('Quý');
    await expect(API.insight.saveForecast(EMAIL, Object.assign({}, ok, { value: 'abc' }))).rejects.toThrow('phải là số');
    expect(await API.insight.saveForecast(EMAIL, ok)).toContain('không sửa được');
    expect(fake.table('finance_forecasts')[0]).toMatchObject({ user_id: USER, symbol: 'FPT', metric: 'lnst', year: 2026, quarter: 2, value: 3.1e12, note: 'ghi chú' });
    await API.insight.saveForecast(EMAIL, Object.assign({}, ok, { quarter: '' })); expect(fake.table('finance_forecasts')[1].quarter).toBeNull();
    await API.insight.deleteForecast(EMAIL, fake.table('finance_forecasts')[0].id); expect(fake.table('finance_forecasts')).toHaveLength(1);
  });
});

describe('Sự kiện theo mã và đầu vào hộp việc', () => {
  const iso = (h) => new Date(Date.now() - h * 3600000).toISOString();
  it('newsEvents: chỉ lấy trong cửa sổ, mới nhất trước, kèm lần chạy tin gần nhất; số ngày bị chặn 1-120', async () => {
    const { API, callGAS } = boot({
      finance_news_events: [{ id: 'a|FPT|legal', symbol: 'FPT', event_type: 'legal', published_at: iso(5) }, { id: 'b|HPG|earnings', symbol: 'HPG', event_type: 'earnings', published_at: iso(24 * 20) }, { id: 'c|VCB|mgmt', symbol: 'VCB', event_type: 'mgmt', published_at: iso(1) }],
      finance_function_runs: [{ fn: 'insight-sync', mode: 'news', run_at: iso(10), ok: true }, { fn: 'insight-sync', mode: 'news', run_at: iso(2), ok: false }, { fn: 'insight-sync', mode: 'thesis', run_at: iso(1), ok: true }],
    });
    const r = await API.insight.newsEvents(7);
    expect(r.events.map((x) => x.symbol)).toEqual(['VCB', 'FPT']); expect(r.days).toBe(7); expect(r.lastRun.ok).toBe(false);
    expect((await API.insight.newsEvents(30)).events).toHaveLength(3);
    expect((await API.insight.newsEvents(9999)).days).toBe(120); expect((await API.insight.newsEvents('x')).days).toBe(30);
    const viaGas = await callGAS('getNewsEvents', { days: 7 });
    expect(viaGas.status).toBe('success'); expect(viaGas.data.events).toHaveLength(2);
  });
  it('inboxInputs: giới hạn 2 ngày, lệnh chờ duyệt, cảnh báo dữ liệu chưa xử lý, hàm lỗi 36 giờ, tên thành viên', async () => {
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const { API, callGAS } = boot({
      finance_compliance_log: [{ log_date: day(0), user_id: USER, breaches: [{ kind: 'single' }], warns: [] }, { log_date: day(9), user_id: USER, breaches: [{ kind: 'old' }], warns: [] }],
      finance_order_requests: [{ id: 'o1', symbol: 'FPT', side: 'buy', created_by: USER, created_at: iso(30), status: 'pending' }, { id: 'o2', symbol: 'HPG', side: 'sell', created_by: USER, created_at: iso(2), status: 'approved' }],
      finance_data_health: [{ kind: 'stale_price', severity: 'warn', symbol: 'ABC', ref_date: day(1), dedupe_key: 'k1', resolved: false, detected_at: iso(5) }, { kind: 'x', severity: 'info', resolved: false, detected_at: iso(5) }, { kind: 'y', severity: 'error', resolved: true, detected_at: iso(5) }],
      finance_function_runs: [{ fn: 'bt-data', mode: 'fill', ok: false, run_at: iso(3) }, { fn: 'bt-data', mode: 'fill', ok: true, run_at: iso(2) }, { fn: 'old', mode: 'x', ok: false, run_at: iso(24 * 5) }],
    });
    const r = await API.insight.inboxInputs();
    expect(r.compliance.map((x) => x.breaches[0].kind)).toEqual(['single']); expect(r.approvals.map((x) => x.id)).toEqual(['o1']);
    expect(r.health.map((x) => x.kind)).toEqual(['stale_price']); expect(r.runs.map((x) => x.fn)).toEqual(['bt-data']);
    expect(r.members[USER]).toBe('Tôi'); expect(r.notes).toEqual([]);
    expect((await callGAS('getInboxInputs', {})).status).toBe('success');
  });
});
