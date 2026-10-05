// Edge Function valuation-watch: cảnh báo định giá hằng ngày + email; bản sao thư viện trong thư mục hàm phải khớp lib/ và chạy được khi nạp kiểu Deno.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sectorWeights, currentAlerts, planNotify, buildEmail, selfTest, vnDate, COOLDOWN_DAYS } from '../../supabase/functions/valuation-watch/watch.ts';
import { VALUATION_LIBS, expectedCopy } from '../../scripts/sync-edge-libs.mjs';
import GroupCalc from '../../lib/group-calc.js';
import SectorMap from '../../lib/sector-map.js';
import ValuationAlerts from '../../lib/valuation-alerts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const edge = (f) => readFileSync(path.join(here, '../../supabase/functions/valuation-watch', f), 'utf8');

describe('bản sao thư viện trong hàm', () => {
  it.each(VALUATION_LIBS)('$file khớp lib/ (chạy node scripts/sync-edge-libs.mjs nếu lệch)', (lib) => {
    expect(edge(lib.file)).toBe(expectedCopy(lib));
  });
  it('nạp kiểu Deno (không có require/module) vẫn chạy và cho cùng kết quả với bản trong lib/', () => {
    const sandbox = { console };
    vm.createContext(sandbox);
    VALUATION_LIBS.forEach((lib) => vm.runInContext(edge(lib.file), sandbox));
    ['GroupCalc', 'SectorMap', 'ValuationHistory', 'ValuationAlerts'].forEach((n) => expect(sandbox[n]).toBeTruthy());
    const viaEdge = selfTest({ GroupCalc: sandbox.GroupCalc, ValuationAlerts: sandbox.ValuationAlerts, SectorMap: sandbox.SectorMap });
    const viaLib = selfTest({ GroupCalc, ValuationAlerts, SectorMap });
    expect(viaEdge).toEqual(viaLib);
  });
});

const LIBS = { GroupCalc, ValuationAlerts, SectorMap };

describe('tính cảnh báo', () => {
  it('bài tự kiểm: ngành nhóm đang nắm đúng tỷ trọng (FPT 100tr / HPG 50tr) và cảnh báo đúng chiều', () => {
    const r = selfTest(LIBS);
    expect(r.sectors).toEqual([{ code: '9500', weightPct: 66.7 }, { code: '1700', weightPct: 33.3 }]);
    expect(r.alerts).toContain('market-rich-P/E');                    // thị trường tăng đều lên đỉnh
    expect(r.alerts).toContain('sector-cheap-9500-P/E');                   // công nghệ (66,7% danh mục) giảm về đáy
    expect(r.alerts.some((k) => /1700/.test(k))).toBe(false);          // thép đi ngang quanh trung bình
  });
  it('không có vị thế hoặc mã chưa có ngành: tỷ trọng rỗng, không lỗi', () => {
    expect(sectorWeights(LIBS, { members: [{ id: 'u1' }], txns: [], actions: [], prices: [], assets: [] }, {})).toEqual([]);
    const tx = { id: '1', user_id: 'u1', type: 'buy', symbol: 'ZZZ', quantity: 10, price: 100, trade_date: '2026-01-02', fee: 0, tax: 0, created_at: '2026-01-02T01:00:00Z', deleted_at: null };
    expect(sectorWeights(LIBS, { members: [{ id: 'u1' }], txns: [tx], actions: [], prices: [{ user_id: 'u1', symbol: 'ZZZ', market_price: 100, price_date: '2026-10-02', updated_at: 'a' }], assets: [{ user_id: 'u1', cash: 0, debt: 0 }] }, {})).toEqual([]);
  });
  it('quá ít lịch sử: enough = false', () => {
    expect(currentAlerts(LIBS, [], [], null).enough).toBe(false);
  });
});

describe('planNotify: chỉ báo cảnh báo mới, không báo lặp', () => {
  const A = (key, level = 'warn') => ({ key, level, scope: 'Thị trường', title: 'T ' + key, detail: 'D ' + key });
  const NOW = new Date('2026-10-06T11:40:00Z'), TODAY = '2026-10-06';
  const st = (key, o = {}) => Object.assign({ alert_key: key, level: 'warn', scope: 'x', title: 't', detail: 'd', active: true, first_seen: '2026-09-01', last_seen: '2026-10-05', last_notified_at: '2026-09-01T11:40:00Z' }, o);
  it('lần đầu (bảng nhớ rỗng): mọi cảnh báo đều mới', () => {
    const p = planNotify([A('a'), A('b', 'info')], [], TODAY, NOW);
    expect(p.notify.map((x) => x.key)).toEqual(['a', 'b']);
    expect(p.upserts.every((r) => r.first_seen === TODAY && r.last_notified_at === null && r.active)).toBe(true);
    expect(p.deactivate).toEqual([]);
  });
  it('cảnh báo vẫn đang có hiệu lực từ trước: không báo lại, giữ ngày thấy đầu tiên', () => {
    const p = planNotify([A('a')], [st('a')], TODAY, NOW);
    expect(p.notify).toEqual([]);
    expect(p.upserts[0].first_seen).toBe('2026-09-01'); expect(p.upserts[0].last_seen).toBe(TODAY);
    expect(p.upserts[0].last_notified_at).toBe('2026-09-01T11:40:00Z');
  });
  it('hết hiệu lực thì đánh dấu không còn hoạt động; xuất hiện lại sau thời gian chờ thì báo lại', () => {
    const p1 = planNotify([], [st('a'), st('b', { active: false })], TODAY, NOW);
    expect(p1.deactivate).toEqual(['a']);
    const p2 = planNotify([A('b')], [st('b', { active: false, last_notified_at: '2026-09-20T00:00:00Z' })], TODAY, NOW);
    expect(p2.notify.map((x) => x.key)).toEqual(['b']);
  });
  it(`nhấp nháy quanh ngưỡng: xuất hiện lại trong ${COOLDOWN_DAYS} ngày kể từ lần gửi thì không gửi lại`, () => {
    const p = planNotify([A('b')], [st('b', { active: false, last_notified_at: '2026-10-03T11:40:00Z' })], TODAY, NOW);
    expect(p.notify).toEqual([]);
    expect(p.upserts[0].active).toBe(true); expect(p.upserts[0].first_seen).toBe(TODAY);
  });
  it('cảnh báo chưa từng gửi được (last_notified_at null) mà đang không hoạt động: báo', () => {
    expect(planNotify([A('c')], [st('c', { active: false, last_notified_at: null })], TODAY, NOW).notify).toHaveLength(1);
  });
});

describe('buildEmail', () => {
  it('có cảnh báo cần xem: tiêu đề nêu số lượng; nội dung thoát ký tự HTML và có lời nhắc không phải lệnh mua bán', () => {
    const m = buildEmail([{ key: 'a', level: 'warn', scope: 's', title: 'Ngành <A> & B đắt', detail: 'P/E "x"' }, { key: 'b', level: 'info', scope: 's', title: 'Rẻ', detail: 'd' }], 5, '2026-10-05');
    expect(m.subject).toBe('Cảnh báo định giá: 1 tín hiệu cần xem và 1 thông tin');
    expect(m.html).toContain('Ngành &lt;A&gt; &amp; B đắt'); expect(m.html).toContain('P/E &quot;x&quot;'); expect(m.html).not.toContain('<A>');
    expect(m.html).toContain('05/10/2026'); expect(m.text).toContain('không phải lệnh mua bán');
  });
  it('chỉ có thông tin: tiêu đề khác', () => {
    expect(buildEmail([{ key: 'b', level: 'info', scope: 's', title: 'Rẻ', detail: 'd' }], 1, null).subject).toBe('Thông tin định giá: 1 tín hiệu mới');
  });
});

describe('vnDate', () => {
  it('đổi sang ngày giờ Việt Nam', () => { expect(vnDate(new Date('2026-10-05T18:00:00Z'))).toBe('2026-10-06'); });
});
