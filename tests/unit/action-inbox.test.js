// Hộp việc cần làm: lib/action-inbox.js
import { describe, it, expect } from 'vitest';
import AI from '../../lib/action-inbox.js';

const NOW = Date.parse('2026-10-12T01:30:00Z'), TODAY = '2026-10-12';
const base = { now: NOW, today: TODAY, held: ['FPT', 'HPG'], watch: ['VCB'] };

describe('luận điểm', () => {
  const ideas = [
    { id: 'i1', symbol: 'FPT', title: 'AI', status: 'broken', owner: 'Tôi', conditions: [{ label: 'Giá không thủng cắt lỗ', severity: 'critical', state: 'fail', since: '2026-10-10T00:00:00Z' }, { label: 'ROE >= 15', severity: 'watch', state: 'ok' }] },
    { id: 'i2', symbol: 'HPG', title: 'Thép', status: 'warning', conditions: [{ label: 'P/E <= 12', severity: 'watch', state: 'fail' }] },
    { id: 'i3', symbol: 'VCB', status: 'intact', conditions: [] },
  ];
  it('bị phá vỡ = nghiêm trọng, cần chú ý = cao, còn nguyên thì không có mục', () => {
    const r = AI.thesisItems({ ideas });
    expect(r.map((x) => [x.symbol, x.sev])).toEqual([['FPT', 1], ['HPG', 2]]);
    expect(r[0].detail).toContain('Giá không thủng cắt lỗ'); expect(r[0].detail).toContain('chủ: Tôi'); expect(r[0].detail).not.toContain('ROE');
    expect(r[0].id).toBe('thesis|i1|broken');
  });
});

describe('tin theo mã', () => {
  const ev = (o) => Object.assign({ news_id: 'n', symbol: 'FPT', event_type: 'legal', label: 'Pháp lý nghiêm trọng', severity: 'alert', direction: -1, title: 'Chủ tịch bị khởi tố', link: 'https://x', published_at: '2026-10-11T03:00:00Z' }, o);
  it('tin xấu nghiêm trọng: mã đang nắm = mức 1, mã chỉ theo dõi = mức 2; mã không liên quan bị bỏ', () => {
    const r = AI.eventItems(Object.assign({}, base, { events: [ev({}), ev({ symbol: 'VCB', news_id: 'n2' }), ev({ symbol: 'XYZ', news_id: 'n3' })] }));
    expect(r.map((x) => [x.symbol, x.sev])).toEqual([['FPT', 1], ['VCB', 2]]);
    expect(r[1].title).toContain('đang theo dõi'); expect(r[0].link).toBe('https://x');
  });
  it('tin cấp theo dõi (đổi nhân sự, kết quả kinh doanh) = mức 3 với mã nắm giữ; tin thông tin thì bỏ; tin quá cũ thì bỏ', () => {
    const r = AI.eventItems(Object.assign({}, base, { events: [ev({ event_type: 'mgmt', severity: 'watch', direction: 0, news_id: 'a' }), ev({ event_type: 'dividend', severity: 'info', direction: 1, news_id: 'b' }), ev({ news_id: 'c', published_at: '2026-10-01T00:00:00Z' })] }));
    expect(r.length).toBe(1); expect(r[0].sev).toBe(3);
  });
  it('cùng mã cùng loại chỉ lấy một mục (mức cao hơn, rồi mới hơn)', () => {
    const r = AI.eventItems(Object.assign({}, base, { events: [ev({ news_id: 'old', published_at: '2026-10-10T00:00:00Z' }), ev({ news_id: 'new', published_at: '2026-10-11T00:00:00Z' })] }));
    expect(r.length).toBe(1); expect(r[0].id).toContain('new');
  });
  it('tin tốt nghiêm trọng (hướng dương) không thành cảnh báo', () => {
    expect(AI.eventItems(Object.assign({}, base, { events: [ev({ direction: 1 })] })).length).toBe(0);
  });
});

describe('giao dịch nội bộ', () => {
  it('nhiều người cùng mua (mã nắm giữ hoặc theo dõi) = mức 3; nhiều người cùng bán mã đang nắm = mức 2; bán mã chỉ theo dõi thì bỏ', () => {
    const s = (o) => Object.assign({ from: '2026-07-14', to: '2026-10-12', buyers: 3, sellers: 0, netQty: 500000, cluster: true, last: '2026-10-05' }, o);
    const r = AI.insiderItems(Object.assign({}, base, { insider: [{ symbol: 'FPT', summary: s() }, { symbol: 'VCB', summary: s() }, { symbol: 'HPG', summary: s({ cluster: false, buyers: 0, sellers: 4, netQty: -300000 }) }, { symbol: 'VCB', summary: s({ cluster: false, buyers: 0, sellers: 4, netQty: -300000 }) }, { symbol: 'XYZ', summary: s() }] }));
    expect(r.map((x) => [x.symbol, x.sev])).toEqual([['FPT', 3], ['VCB', 3], ['HPG', 2]]);
    expect(r[2].detail).toContain('không liên quan triển vọng');
  });
});

describe('giới hạn, duyệt lệnh, dòng tiền, hành động doanh nghiệp, dữ liệu, hệ thống', () => {
  it('vượt giới hạn chế độ chặn = 1; vượt cảnh báo = 2; gần chạm = 3', () => {
    const r = AI.limitItems({ compliance: [{ subject: 'FPT > 25% NAV', level: 'breach', mode: 'block', current: '31%', threshold: '25%' }, { subject: 'Ngành NH', level: 'breach', mode: 'warn' }, { subject: 'HPG', level: 'warn', mode: 'warn' }] });
    expect(r.map((x) => x.sev)).toEqual([1, 2, 3]); expect(r[0].detail).toContain('chặn lệnh');
  });
  it('lệnh chờ duyệt quá 24 giờ = 2, mới hơn = 3', () => {
    const r = AI.approvalItems({ now: NOW, approvals: [{ id: 'a', symbol: 'FPT', side: 'buy', requester: 'Minh', created_at: '2026-10-10T00:00:00Z' }, { id: 'b', symbol: 'HPG', side: 'sell', created_at: '2026-10-12T00:00:00Z' }] });
    expect(r.map((x) => x.sev)).toEqual([2, 3]); expect(r[0].title).toContain('mua FPT');
  });
  it('dự kiến thiếu tiền: trong 7 ngày = 2, xa hơn = 3; không thiếu thì không có mục', () => {
    expect(AI.cashItems({ today: TODAY, cash: { firstShortfall: { date: '2026-10-15' }, minBalance: -25000000, minDate: '2026-10-20' } })[0].sev).toBe(2);
    expect(AI.cashItems({ today: TODAY, cash: { firstShortfall: { date: '2026-11-15' }, minBalance: -1 } })[0].sev).toBe(3);
    expect(AI.cashItems({ today: TODAY, cash: { firstShortfall: null } })).toEqual([]);
  });
  it('sắp không hưởng quyền của mã đang nắm: <= 3 ngày = 3, <= 7 ngày = 4; mã không nắm hoặc đã qua thì bỏ', () => {
    const r = AI.corporateItems({ held: ['FPT'], today: TODAY, corporate: [{ symbol: 'FPT', kind: 'cash_dividend', exDate: '2026-10-14', label: 'cổ tức 1.000đ' }, { symbol: 'FPT', kind: 'stock_dividend', exDate: '2026-10-18', label: 'thưởng 15%' }, { symbol: 'HPG', kind: 'cash_dividend', exDate: '2026-10-14' }, { symbol: 'FPT', kind: 'cash_dividend', exDate: '2026-10-01' }] });
    expect(r.map((x) => x.sev)).toEqual([3, 4]);
  });
  it('cảnh báo dữ liệu mức lỗi = 2, cảnh báo = 3, thông tin bỏ', () => {
    const r = AI.healthItems({ health: [{ kind: 'price_jump', severity: 'error', symbol: 'ABC', ref_date: '2026-10-09' }, { kind: 'stale_price', severity: 'warn', symbol: 'DEF', ref_date: '2026-10-09' }, { kind: 'price_level', severity: 'info', symbol: 'GHI' }] });
    expect(r.map((x) => x.sev)).toEqual([2, 3]);
  });
  it('hàm tự chạy lỗi trong 36 giờ = 3; lần cũ hơn hoặc đã thành công thì bỏ; cùng hàm lấy lần mới nhất', () => {
    const r = AI.systemItems({ now: NOW, runs: [{ fn: 'bt-data', mode: 'fill', ok: false, run_at: '2026-10-11T12:30:00Z' }, { fn: 'bt-data', mode: 'fill', ok: false, run_at: '2026-10-11T05:00:00Z' }, { fn: 'insight-sync', mode: 'news', ok: true, run_at: '2026-10-12T00:00:00Z' }, { fn: 'old', ok: false, run_at: '2026-10-01T00:00:00Z' }] });
    expect(r.length).toBe(1); expect(r[0].title).toContain('bt-data');
  });
});

describe('build / summarize / fresh / digest', () => {
  const input = Object.assign({}, base, {
    ideas: [{ id: 'i1', symbol: 'FPT', status: 'broken', conditions: [{ label: 'Giá', severity: 'critical', state: 'fail' }] }],
    events: [{ news_id: 'n1', symbol: 'HPG', event_type: 'delist', label: 'Nguy cơ đình chỉ', severity: 'alert', direction: -1, title: 'HPG bị cảnh báo', published_at: '2026-10-11T08:00:00Z' }],
    approvals: [{ id: 'a1', symbol: 'FPT', side: 'buy', created_at: '2026-10-12T00:00:00Z' }],
    health: [{ kind: 'stale_price', severity: 'warn', symbol: 'ABC', ref_date: '2026-10-09' }],
  });
  const items = AI.build(input);
  it('xếp theo mức khẩn cấp rồi mới nhất; không trùng id', () => {
    expect(items.map((x) => x.sev)).toEqual([...items.map((x) => x.sev)].sort((a, b) => a - b));
    expect(new Set(items.map((x) => x.id)).size).toBe(items.length);
    expect(items[0].sev).toBe(1);
    expect(AI.build({}).length).toBe(0);
  });
  it('summarize: đếm theo mức và loại, dòng tiêu đề', () => {
    const s = AI.summarize(items);
    expect(s.total).toBe(items.length); expect(s.bySev[1]).toBe(2); expect(s.urgent).toBe(2); expect(s.headline).toMatch(/2 việc nghiêm trọng/);
    expect(AI.summarize([]).headline).toBe('Không có việc cần chú ý');
  });
  it('fresh chỉ giữ mục chưa có trong lần gửi trước', () => {
    const f = AI.fresh(items, [items[0].id, 'khong-co']);
    expect(f.length).toBe(items.length - 1); expect(f.some((x) => x.id === items[0].id)).toBe(false);
    expect(AI.fresh(items, null).length).toBe(items.length);
  });
  it('digest: chỉ mức 1-3, đánh dấu mục mới, thoát HTML, có nhắc không phải khuyến nghị', () => {
    const d = AI.digest(items.concat([AI.build({ ideas: [{ id: 'x', symbol: 'A<B>', status: 'broken', title: '"q"', conditions: [] }], held: [] })[0]]), { newIds: [items[0].id] });
    expect(d.subject).toMatch(/việc nghiêm trọng/); expect(d.subject).toMatch(/1 mới/);
    expect(d.text).toContain('mới'); expect(d.text).toMatch(/không phải khuyến nghị/);
    expect(d.html).not.toContain('<B>'); expect(d.html).toContain('A&lt;B&gt;');
    const onlyInfo = AI.digest([{ id: 'z', sev: 4, kind: 'system', title: 't', detail: '' }]);
    expect(onlyInfo.count).toBe(0);
  });
});
