// Edge Function insight-sync (supabase/functions/insight-sync): bản sao thư viện khớp lib/, gắn mã vào tin, đánh giá luận điểm, cảnh báo, email, danh sách mã cần đồng bộ sở hữu.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { INSIGHT_LIBS, INSIGHT_TS, expectedCopy } from '../../scripts/sync-edge-libs.mjs';
import * as L from '../../supabase/functions/insight-sync/logic.ts';
import { parseRss, FEEDS } from '../../supabase/functions/insight-sync/news-parse.ts';

const require = createRequire(import.meta.url);
const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

globalThis.ThesisCalc = require('../../lib/thesis-calc.js');
globalThis.OwnershipCalc = require('../../lib/ownership-calc.js');
globalThis.NewsEvents = require('../../lib/news-events.js');
globalThis.ActionInbox = require('../../lib/action-inbox.js');

describe('bản sao trong thư mục hàm', () => {
  it.each(INSIGHT_LIBS)('$file khớp lib/ (chạy node scripts/sync-edge-libs.mjs nếu lệch)', (lib) => {
    expect(read('supabase/functions/insight-sync/' + lib.file)).toBe(expectedCopy(lib).replace(/\r\n/g, '\n'));
  });
  it('news-parse.ts là bản sao nguyên văn parse.ts của market-news (cùng nguồn RSS)', () => {
    INSIGHT_TS.forEach((c) => expect(read(c.to)).toBe(read(c.from)));
    expect(FEEDS.length).toBeGreaterThan(0);
  });
});

describe('tagSymbols / newsRows', () => {
  const SYMS = new Set(['FPT', 'HPG', 'VCB', 'GDP', 'SSI', 'A32']);
  it('gắn mã viết hoa nguyên từ có trong danh sách niêm yết; bỏ trùng; không gắn từ viết tắt kinh tế', () => {
    expect(L.tagSymbols('FPT và HPG tăng mạnh, FPT lập đỉnh mới', SYMS)).toEqual(['FPT', 'HPG']);
    expect(L.tagSymbols('GDP quý III tăng 7%', SYMS)).toEqual([]);
  });
  it('không gắn khi là một phần của từ khác, hoặc khi cả tiêu đề viết hoa', () => {
    expect(L.tagSymbols('Fptsoft mở rộng; VCBS báo cáo; SSIA', SYMS)).toEqual([]);
    expect(L.tagSymbols('FPT TĂNG MẠNH SAU BÁO CÁO LỢI NHUẬN QUÝ', SYMS)).toEqual([]);
    expect(L.tagSymbols('Mã A32 chia cổ tức', SYMS)).toEqual(['A32']);
  });
  it('ký tự tiếng Việt liền kề không làm sai ranh giới', () => {
    expect(L.tagSymbols('Cổ phiếu(VCB), (SSI) và "HPG"', SYMS)).toEqual(['VCB', 'SSI', 'HPG']);
  });
  it('newsRows: giữ id/liên kết, đổi giờ sang ISO, tin không rõ giờ thì published_at null', () => {
    const rows = L.newsRows([{ id: 'https://x/1', title: 'FPT báo lãi', link: 'https://x/1', source: 'cafef', sourceName: 'CafeF', ts: Date.UTC(2026, 9, 9, 3), summary: 's' }, { id: 'https://x/2', title: 'Thị trường chung', link: 'https://x/2', source: 'vnexpress', sourceName: 'V', ts: null, summary: '' }, { id: '', title: 'x' }], SYMS);
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ id: 'https://x/1', published_at: '2026-10-09T03:00:00.000Z', symbols: ['FPT'], summary: 's' }); expect(rows[1]).toMatchObject({ published_at: null, symbols: [], summary: null });
  });
  it('đọc được tin từ RSS thật rồi gắn mã', () => {
    const xml = '<rss><channel><item><title>HPG công bố kết quả kinh doanh</title><link>https://cafef.vn/a.chn</link><pubDate>Fri, 09 Oct 2026 03:00:00 +0000</pubDate><description>Mô tả</description></item></channel></rss>';
    const items = parseRss(xml, FEEDS.find((f) => f.id === 'cafef'), Date.UTC(2026, 9, 10));
    expect(L.newsRows(items, SYMS)[0].symbols).toEqual(['HPG']);
  });
});

describe('evaluateAll: kiểm luận điểm', () => {
  const NOW = '2026-10-11T12:35:00.000Z';
  const ideas = [{ id: 'i1', user_id: 'u1', symbol: 'AAA', title: 'Ý tưởng A', target_price: 130000 }, { id: 'i3', user_id: 'u1', symbol: 'CCC', title: 'Không điều kiện' }];
  const cond = (o) => Object.assign({ id: 'x', idea_id: 'i1', metric: 'roae', op: '>=', threshold: 15, severity: 'watch', label: null, manual_met: null, last_state: null, state_since: null, notified_state: null }, o || {});
  const conds = [
    cond({ id: 'c1', severity: 'critical', last_state: 'ok', state_since: '2026-09-01T00:00:00Z' }),                           // ROE 10 < 15 -> sai, vừa đổi từ đúng
    cond({ id: 'c2', metric: 'pe', op: '<=', threshold: 12 }),                                                                 // đúng, lần đầu
    cond({ id: 'c3', metric: 'manual', severity: 'critical' }),                                                                // chưa xác nhận
    cond({ id: 'c4', metric: 'insiderNet90d', op: '>=', threshold: 1 }),                                                       // nội bộ mua ròng 5.000
    cond({ id: 'c5', metric: 'price', op: '>=', threshold: 110000, severity: 'critical', last_state: 'fail', state_since: '2026-10-01T00:00:00Z', notified_state: 'fail' }),   // giá 100.000 < 110.000: sai, đã báo từ trước
    cond({ id: 'c6', metric: 'upsideToTarget', op: '>=', threshold: 20, last_state: 'ok', state_since: '2026-09-15T00:00:00Z' }),  // 130.000/100.000-1 = 30% -> đúng, không đổi
  ];
  const snaps = { AAA: { roae: 0.1, pe: 10.9, marketcap: 1e12, shares: 1e7 } };
  const trades = { AAA: [{ id: 't1', symbol: 'AAA', trader: 'X', action: 'B', status: 'done', acquired: 5000, shares_before: 1, shares_after: 5001, registered: 5000, start_date: '2026-09-20', end_date: '2026-09-20', public_date: '2026-09-25' }] };
  const r = L.evaluateAll(ideas, conds, snaps, {}, trades, new Set(['AAA']), '2026-10-11', NOW);
  const patch = (id) => r.updates.find((u) => u.id === id).patch;
  it('cập nhật trạng thái, giá trị, lúc kiểm; giữ state_since khi không đổi và đặt lại khi đổi', () => {
    expect(r.updates).toHaveLength(6);
    expect(patch('c1')).toMatchObject({ last_state: 'fail', state_since: NOW, last_checked: NOW }); expect(patch('c1').last_value).toBeCloseTo(10, 9);
    expect(patch('c2')).toMatchObject({ last_state: 'ok', state_since: NOW }); expect(patch('c2').notified_state).toBeNull();
    expect(patch('c5')).toMatchObject({ last_state: 'fail', state_since: '2026-10-01T00:00:00Z' });          // vẫn sai: giữ mốc cũ
    expect(patch('c6')).toMatchObject({ last_state: 'ok', state_since: '2026-09-15T00:00:00Z' });
    expect(patch('c4').last_state).toBe('ok'); expect(patch('c4').last_value).toBe(5000);                     // nội bộ mua ròng 90 ngày
    expect(patch('c3')).toMatchObject({ last_state: 'unknown' });
  });
  it('nhật ký chỉ ghi lần đổi trạng thái đúng/sai (lần đầu có kết quả ghi from null)', () => {
    expect(r.logs.map((l) => l.condition_id + ':' + l.from_state + '>' + l.to_state).sort()).toEqual(['c1:ok>fail', 'c2:null>ok', 'c4:null>ok']);
  });
  it('cảnh báo chỉ cho điều kiện CRITICAL đang sai mà chưa báo', () => {
    expect(r.alerts.map((a) => a.condId)).toEqual(['c1']);
    expect(r.alerts[0]).toMatchObject({ userId: 'u1', ideaId: 'i1', symbol: 'AAA', title: 'Ý tưởng A' }); expect(r.alerts[0].label).toContain('ROE');
  });
  it('trạng thái từng ý tưởng; ý tưởng không có điều kiện bị bỏ', () => {
    expect(r.ideas).toEqual([{ id: 'i1', status: 'broken' }]);
  });
  it('chưa đồng bộ sở hữu thì chỉ tiêu nội bộ là "chưa có số liệu", không phải 0', () => {
    const r2 = L.evaluateAll(ideas, [cond({ id: 'z', metric: 'insiderNet90d', op: '>=', threshold: 0 })], snaps, {}, {}, new Set(), '2026-10-11', NOW);
    expect(r2.updates[0].patch.last_state).toBe('unknown');
    const r3 = L.evaluateAll(ideas, [cond({ id: 'z', metric: 'insiderNet90d', op: '>=', threshold: 0 })], snaps, {}, {}, new Set(['AAA']), '2026-10-11', NOW);
    expect(r3.updates[0].patch.last_state).toBe('ok');                       // đã đồng bộ, không có giao dịch: ròng 0 >= 0
  });
  it('điều kiện hết sai thì xoá dấu đã báo để lần sau sai lại sẽ báo lại', () => {
    const r4 = L.evaluateAll(ideas, [cond({ id: 'k', metric: 'price', op: '>=', threshold: 50000, severity: 'critical', last_state: 'fail', notified_state: 'fail' })], snaps, {}, {}, new Set(), '2026-10-11', NOW);
    expect(r4.updates[0].patch).toMatchObject({ last_state: 'ok', notified_state: null }); expect(r4.alerts).toEqual([]);
  });
  it('phòng khối ngoại lấy từ finance_stock_ratios', () => {
    const r5 = L.evaluateAll(ideas, [cond({ id: 'f', metric: 'foreignRoomLeftPct', op: '>=', threshold: 5 })], snaps, { AAA: { foreignRoomLeftPct: 3.2 } }, {}, new Set(), '2026-10-11', NOW);
    expect(r5.updates[0].patch).toMatchObject({ last_state: 'fail', last_value: 3.2 });
  });
});

describe('thesisEmail / trackedSymbols / snapshotPrice', () => {
  it('email một luận điểm và nhiều luận điểm; thoát HTML', () => {
    const one = L.thesisEmail([{ symbol: 'FPT', title: 'A & B', label: 'ROE ≥ 15%', value: 10 }]);
    expect(one.subject).toBe('Luận điểm FPT có điều kiện quan trọng bị phá vỡ'); expect(one.html).toContain('A &amp; B'); expect(one.text).toContain('ROE ≥ 15%'); expect(one.text).toContain('không phải khuyến nghị đầu tư');
    expect(L.thesisEmail([{ symbol: 'A', title: '', label: 'x', value: null }, { symbol: 'B', title: '', label: 'y', value: 1 }]).subject).toBe('2 luận điểm có điều kiện quan trọng bị phá vỡ');
  });
  it('danh sách mã cần đồng bộ: chuẩn hoá chữ hoa, bỏ trùng và mã sai, giới hạn số lượng', () => {
    expect(L.trackedSymbols([['fpt', 'HPG', null], ['FPT', 'a b', 'VCB', '']], 10)).toEqual(['FPT', 'HPG', 'VCB']);
    expect(L.trackedSymbols([['A1', 'B1', 'C1', 'D1']], 2)).toEqual(['A1', 'B1']);
  });
  it('giá từ ảnh chụp = vốn hoá / số cổ phiếu', () => {
    expect(L.snapshotPrice({ marketcap: 109183630819200, shares: 1885727648 })).toBe(57900); expect(L.snapshotPrice({ marketcap: 1 })).toBeNull(); expect(L.snapshotPrice(null)).toBeNull();
  });
});

describe('dòng ghi vào cơ sở dữ liệu', () => {
  it('cổ đông: updated_at đặt tường minh (phép xoá người không còn trong danh sách dựa vào nó); pct giữ dạng phần trăm', () => {
    const rows = L.shareholderRows(globalThis.OwnershipCalc.parseShareholders({ data: [{ ownerName: 'SCIC', ownerCode: 'SCIC', quantity: 1, percentage: 0.0567, ownerType: 'CORPORATE', publicDate: '2026-06-30' }] }, 'fpt'), '2026-10-11T12:15:00.000Z');
    expect(rows).toEqual([{ symbol: 'FPT', owner_key: 'SCIC', owner_name: 'SCIC', owner_type: 'CORPORATE', position: null, quantity: 1, pct: 5.67, public_date: '2026-06-30', updated_at: '2026-10-11T12:15:00.000Z' }]);
  });
  it('giao dịch nội bộ: ánh xạ đủ cột và khứ hồi qua insiderFromDb cho tóm tắt 90 ngày', () => {
    const t = globalThis.OwnershipCalc.parseInsider({ data: { content: [{ id: 'a', ticker: 'FPT', actionTypeCode: 'S', publicDate: '2026-09-20T00:00:00', startDate: '2026-09-18T00:00:00', endDate: '2026-09-19T00:00:00', tradeStatusEn: 'Done', shareAcquire: 4000, shareBeforeTrade: 10000, shareAfterTrade: 6000, shareRegister: 5000, ownershipAfterTrade: 0.001, traderNameVi: 'B', eventCode: 'DDIND', sourceUrlVi: 'http://u' }] } });
    const rows = L.insiderRows(t);
    expect(rows[0]).toMatchObject({ id: 'a', symbol: 'FPT', action: 'S', status: 'done', shares_before: 10000, shares_after: 6000, registered: 5000, acquired: 4000, start_date: '2026-09-18', end_date: '2026-09-19', public_date: '2026-09-20', url: 'http://u' });
    expect(rows[0].pct_after).toBeCloseTo(0.1, 9);
    expect(globalThis.OwnershipCalc.summarize([L.insiderFromDb(rows[0])], '2026-10-11', 90).netQty).toBe(-4000);
  });
});

describe('sự kiện từ tin', () => {
  const news = [
    { id: 'n1', title: 'FLC: Chủ tịch bị khởi tố, bắt tạm giam', summary: null, symbols: ['FLC'], published_at: '2026-10-09T03:00:00.000Z', link: 'https://x/1', source: 'cafef' },
    { id: 'n2', title: 'Thị trường đi ngang', summary: null, symbols: [], published_at: '2026-10-09T03:00:00.000Z', link: 'https://x/2', source: 'cafef' },
    { id: 'n3', title: 'Thị trường hôm nay', summary: null, symbols: ['AAA'], published_at: '2026-10-09T03:00:00.000Z', link: null, source: null },
  ];
  it('eventRows: chỉ tin có mã và có sự kiện; khớp cột finance_news_events; id ổn định', () => {
    const rows = L.eventRows(news);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const r = rows.find((x) => x.event_type === 'legal');
    expect(r).toMatchObject({ id: 'n1|FLC|legal', news_id: 'n1', symbol: 'FLC', direction: -1, severity: 'alert', multi: false, link: 'https://x/1', source: 'cafef' });
    expect(Object.keys(r).sort()).toEqual(['confidence', 'direction', 'event_type', 'id', 'link', 'matched', 'multi', 'news_id', 'published_at', 'severity', 'source', 'symbol', 'title']);
    expect(L.eventRows(news)).toEqual(rows);
    expect(L.eventRows([])).toEqual([]);
  });
  const NOW = '2026-10-11T12:35:00.000Z';
  const cond = (o) => Object.assign({ id: 'x', idea_id: 'i1', metric: 'evtAlert30d', op: '<=', threshold: 0, severity: 'critical', label: null, manual_met: null, last_state: null, state_since: null, notified_state: null }, o || {});
  const ideas = [{ id: 'i1', user_id: 'u1', symbol: 'AAA', title: 'A' }];
  const ev = (type, sev, dir, d) => ({ symbol: 'AAA', event_type: type, severity: sev, direction: dir, published_at: d });
  it('chỉ tiêu tin tức: đếm tin xấu nghiêm trọng trong cửa sổ; có tin xấu thì điều kiện critical sai và có cảnh báo', () => {
    const events = { ready: true, bySymbol: { AAA: [ev('legal', 'alert', -1, '2026-10-05T00:00:00Z'), ev('mgmt', 'watch', 0, '2026-09-01T00:00:00Z'), ev('delist', 'alert', -1, '2026-07-20T00:00:00Z')] } };
    const r = L.evaluateAll(ideas, [cond({ id: 'a30' }), cond({ id: 'a90', metric: 'evtAlert90d', threshold: 1 }), cond({ id: 'm90', metric: 'evtMgmt90d', op: '<=', threshold: 0, severity: 'watch' })], { AAA: { marketcap: 1e12, shares: 1e7 } }, {}, {}, new Set(), '2026-10-11', NOW, events);
    const p = (id) => r.updates.find((u) => u.id === id).patch;
    expect(p('a30')).toMatchObject({ last_state: 'fail', last_value: 1 });        // 1 tin xấu nghiêm trọng trong 30 ngày (pháp lý); đình chỉ cách 83 ngày không tính
    expect(p('a90')).toMatchObject({ last_state: 'fail', last_value: 2 });        // 2 trong 90 ngày > ngưỡng 1
    expect(p('m90')).toMatchObject({ last_state: 'fail', last_value: 1 });
    expect(r.alerts.map((a) => a.condId).sort()).toEqual(['a30', 'a90']);
  });
  it('không có tin xấu thì đúng; kho tin chưa chạy thì "chưa có số liệu", KHÔNG phải 0', () => {
    const ok = L.evaluateAll(ideas, [cond()], { AAA: {} }, {}, {}, new Set(), '2026-10-11', NOW, { ready: true, bySymbol: {} });
    expect(ok.updates[0].patch).toMatchObject({ last_state: 'ok', last_value: 0 });
    const notReady = L.evaluateAll(ideas, [cond()], { AAA: {} }, {}, {}, new Set(), '2026-10-11', NOW, { ready: false, bySymbol: {} });
    expect(notReady.updates[0].patch.last_state).toBe('unknown');
    expect(L.evaluateAll(ideas, [cond()], { AAA: {} }, {}, {}, new Set(), '2026-10-11', NOW).updates[0].patch.last_state).toBe('unknown');
  });
  it('index.ts có chế độ events, dùng bản sao news-events.js và không lộ khoá', () => {
    const src = read('supabase/functions/insight-sync/index.ts');
    expect(src).toContain('import "./news-events.js"'); expect(src).toContain('"events"'); expect(src).toContain('finance_news_events');
    expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|sb_publishable_/);
  });
});

describe('email việc cần làm (digest)', () => {
  const NOW = '2026-10-12T01:30:00.000Z';
  it('heldByUser: chỉ mã có tổng mua > tổng bán, tách theo người', () => {
    const m = L.heldByUser([{ user_id: 'u1', symbol: 'fpt', type: 'buy', quantity: 100 }, { user_id: 'u1', symbol: 'FPT', type: 'sell', quantity: 40 }, { user_id: 'u1', symbol: 'HPG', type: 'buy', quantity: 50 }, { user_id: 'u1', symbol: 'HPG', type: 'sell', quantity: 50 }, { user_id: 'u2', symbol: 'VCB', type: 'buy', quantity: '10' }]);
    expect([...m.get('u1')]).toEqual(['FPT']); expect([...m.get('u2')]).toEqual(['VCB']);
  });
  it('ideaStatusFromConditions: sai điều kiện critical = bị phá vỡ; chỉ sai điều kiện watch = cần chú ý; còn lại ok', () => {
    const c = (o) => Object.assign({ last_state: 'ok', severity: 'watch', metric: 'roae', op: '>=', threshold: 15, label: null, state_since: null }, o);
    expect(L.ideaStatusFromConditions([c({ last_state: 'fail', severity: 'critical' }), c({})]).status).toBe('broken');
    expect(L.ideaStatusFromConditions([c({ last_state: 'fail' }), c({})]).status).toBe('warning');
    expect(L.ideaStatusFromConditions([c({}), c({ last_state: 'unknown' })]).status).toBe('ok');
    expect(L.ideaStatusFromConditions([c({ last_state: 'fail' })]).conditions[0].label).toContain('ROE');
  });
  const data = (extra) => Object.assign({
    heldByUser: new Map([['u1', new Set(['FPT', 'HPG'])]]), watchByUser: new Map([['u1', new Set(['VCB'])]]),
    ideas: [{ id: 'i1', user_id: 'u1', symbol: 'FPT', title: 'AI' }, { id: 'i9', user_id: 'u2', symbol: 'ZZZ', title: 'khác' }],
    conds: [{ idea_id: 'i1', metric: 'price', op: '>=', threshold: 52000, severity: 'critical', label: 'Giá không thủng cắt lỗ', last_state: 'fail', state_since: '2026-10-10T00:00:00Z' }, { idea_id: 'i9', metric: 'price', op: '>=', threshold: 1, severity: 'critical', last_state: 'fail' }],
    events: [{ news_id: 'n1', symbol: 'HPG', event_type: 'delist', direction: -1, severity: 'alert', published_at: '2026-10-11T08:00:00Z', title: 'HPG bị cảnh báo', link: 'https://x' }, { news_id: 'n2', symbol: 'XYZ', event_type: 'legal', direction: -1, severity: 'alert', published_at: '2026-10-11T08:00:00Z', title: 'khác' }],
    insiderBySymbol: new Map([['VCB', [1, 2, 3].map((k) => ({ id: 't' + k, symbol: 'VCB', trader: 'N' + k, action: 'B', status: 'done', acquired: 10000, shares_before: 1, shares_after: 10001, registered: 10000, start_date: '2026-09-20', end_date: '2026-09-20', public_date: '2026-09-25' }))]]),
    compliance: [{ user_id: 'u1', log_date: '2026-10-11', breaches: [{ kind: 'single', subject: 'FPT > 25% NAV', mode: 'block', current: '31%', threshold: '25%' }], warns: [] }, { user_id: null, log_date: '2026-10-11', breaches: [{ kind: 'sector', subject: 'Ngành NH', mode: 'warn' }], warns: [] }],
    approvals: [{ id: 'a1', symbol: 'FPT', side: 'buy', requester: 'Minh', created_at: '2026-10-10T00:00:00Z' }], health: [{ kind: 'stale_price', severity: 'warn', symbol: 'ABC', ref_date: '2026-10-09', dedupe_key: 'k1' }], runs: [{ fn: 'bt-data', mode: 'fill', ok: false, run_at: '2026-10-11T12:30:00Z' }],
  }, extra || {});
  it('inboxForUser: người thường chỉ thấy việc của chính mình (luận điểm, tin mã mình có, nội bộ mã theo dõi, giới hạn của mình)', () => {
    const items = L.inboxForUser(data(), { id: 'u1', nickname: 'Tôi', manager: false }, NOW);
    const kinds = items.map((x) => x.kind + ':' + (x.symbol || ''));
    expect(kinds).toContain('thesis:FPT'); expect(kinds).toContain('event:HPG'); expect(kinds).toContain('insider:VCB'); expect(kinds.some((k) => k.startsWith('limit'))).toBe(true);
    expect(kinds).not.toContain('event:XYZ'); expect(items.some((x) => x.kind === 'approval' || x.kind === 'health' || x.kind === 'system')).toBe(false);
    expect(items.filter((x) => x.kind === 'limit').length).toBe(1);               // bản tuân thủ của nhóm chỉ dành cho quản lý
    expect(items[0].sev).toBe(1);
  });
  it('inboxForUser: quản lý thêm bản tuân thủ nhóm, lệnh chờ duyệt, cảnh báo dữ liệu và hàm lỗi', () => {
    const items = L.inboxForUser(data(), { id: 'u1', nickname: 'Tôi', manager: true }, NOW);
    expect(items.filter((x) => x.kind === 'limit').length).toBe(2);
    ['approval', 'health', 'system'].forEach((k) => expect(items.some((x) => x.kind === k), k).toBe(true));
  });
  it('thư viện hộp việc có bản sao nguyên văn trong hàm và mode digest được đăng ký, không lộ khoá', () => {
    const src = read('supabase/functions/insight-sync/index.ts');
    expect(src).toContain('import "./action-inbox.js"'); expect(src).toContain('"digest"'); expect(src).toContain('finance_digest_state');
    expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|sb_publishable_/);
  });
});
