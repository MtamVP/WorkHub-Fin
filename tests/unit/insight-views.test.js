// Giao diện Insight (insight/insight-util.js, insight-views-a/b/c.js): chỉ dựng chuỗi HTML từ kết quả đã tính. Kiểm: định dạng, trạng thái rỗng / lỗi, thoát HTML (mã hoặc tên người dùng nhập không chèn được mã), và các thông điệp cảnh báo quan trọng có mặt.
import { describe, it, expect } from 'vitest';
import U from '../../insight/insight-util.js';
import A from '../../insight/insight-views-a.js';
import B from '../../insight/insight-views-b.js';
import C from '../../insight/insight-views-c.js';
import LQ from '../../lib/liquidity-calc.js';
import CF from '../../lib/cashflow-calc.js';
import SR from '../../lib/sector-rotation.js';
import TC from '../../lib/thesis-calc.js';
import FA from '../../lib/forecast-accuracy.js';
import PC from '../../lib/pit-calc.js';

describe('InsUtil: định dạng kiểu Việt Nam', () => {
  it('thoát HTML, số, tiền rút gọn, phần trăm, ngày', () => {
    expect(U.esc('<img src=x onerror="a">&\'')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    expect(U.int(1234567)).toBe('1.234.567'); expect(U.int(null)).toBe('—'); expect(U.dec(1.25, 1)).toBe('1,3');
    expect(U.money(1.25e9)).toBe('1,25 tỷ'); expect(U.money(340e6)).toBe('340,0 triệu'); expect(U.money(12500)).toBe('12.500 đ'); expect(U.money(-2e9)).toBe('−2,00 tỷ'); expect(U.money(2.5e12)).toBe('2,50 nghìn tỷ'); expect(U.money(undefined)).toBe('—');
    expect(U.pct(0.123)).toBe('12,3%'); expect(U.pct(-0.05, 1, true)).toBe('−5,0%'); expect(U.pct(0.05, 1, true)).toBe('+5,0%'); expect(U.pctN(6.89, 2)).toBe('6,89%');
    expect(U.date('2026-10-09T05:00:00Z')).toBe('09/10/2026'); expect(U.date('x')).toBe('—'); expect(U.dateShort('2026-10-09')).toBe('09/10');
  });
  it('mã cổ phiếu nhập tay: chuẩn hoá, bỏ trùng và mã sai', () => {
    expect(U.parseSymbols('fpt, hpg;FPT  <b> a-b VCB', 5)).toEqual(['FPT', 'HPG', 'VCB']);
  });
  it('mốc thời gian tương đối', () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    expect(U.ago('2026-10-11T11:50:00Z', now)).toBe('10 phút trước'); expect(U.ago('2026-10-11T07:00:00Z', now)).toBe('5 giờ trước'); expect(U.ago('2026-10-09T12:00:00Z', now)).toBe('2 ngày trước'); expect(U.ago('bad', now)).toBe('—');
  });
});

describe('Thanh khoản', () => {
  const vols = (v) => Array.from({ length: 30 }, (_, i) => ['d' + i, v]);
  const res = LQ.analyze([{ symbol: 'THIN', quantity: 450000, price: 15000 }, { symbol: 'FPT', quantity: 3000, price: 58000 }], { THIN: vols(300000), FPT: vols(3500000) }, {}, { rate: 0.2, exitDays: 5, maxDays: 10 });
  const S = (o) => Object.assign({ state: 'ok', subject: 'mine', rate: 0.2, exitDays: 5, res: res, pipe: [], pipeValue: null, holdingsN: 2 }, o || {});
  it('nêu vị thế khó thoát, hệ số quy mô đã vượt và giới hạn của phép đo', () => {
    const h = A.liquidityHtml(S());
    expect(h).toContain('THIN'); expect(h).toContain('Thoát chậm'); expect(h).toContain('ĐÃ vượt'); expect(h).toContain('cận trên lạc quan'); expect(h).toContain('&lt;0,1');
  });
  it('trạng thái tải, lỗi và rỗng; mã lạ bị thoát HTML', () => {
    expect(A.liquidityHtml(S({ state: 'loading' }))).toContain('fa-spinner'); expect(A.liquidityHtml(S({ state: 'error', error: '<b>x</b>' }))).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(A.liquidityHtml(S({ res: LQ.analyze([], {}, {}), holdingsN: 0 }))).toContain('Danh mục đang trống');
    const evil = LQ.analyze([{ symbol: '<img>', quantity: 100, price: 1000 }], { '<img>': vols(1000) }, {});
    expect(A.liquidityHtml(S({ res: evil }))).not.toContain('<img>');
  });
  it('ứng viên: xây được / quá lớn và mã thiếu dữ liệu', () => {
    const pipe = LQ.pipeline([{ symbol: 'AAA', price: 50000, value: 1e9 }, { symbol: 'BBB', price: 50000, value: 5e12 }, { symbol: 'CCC', price: 1, value: 1 }], { AAA: vols(2000000), BBB: vols(2000000) }, {});
    const h = A.liquidityHtml(S({ pipe: pipe, pipeValue: 1e9, pipeDefault: 1e9 }));
    expect(h).toContain('Xây được'); expect(h).toContain('Quá lớn'); expect(h).toContain('Chưa đủ dữ liệu cho: CCC');
  });
});

describe('Dòng tiền', () => {
  const build = (o) => CF.build(Object.assign({ today: '2026-10-12', cash: 1e9, weeks: 4 }, o));
  const S = (r) => ({ state: 'ok', res: r, params: { weeks: 4, buffer: '', debtRate: '' }, debt: 0, KINDS: CF.KINDS });
  it('báo thiếu tiền kèm ngày đầu tiên và vẽ biểu đồ', () => {
    const r = build({ planned: [{ kind: 'buy', date: '2026-10-13', amount: 2e9, symbol: 'HPG' }] });
    const h = A.cashHtml(S(r));
    expect(h).toContain('Dự kiến thiếu tiền từ 2026-10-13'); expect(h).toContain('<svg'); expect(h).toContain('Thiếu tiền'); expect(h).toContain('Mua dự kiến');
  });
  it('không thiếu tiền: nói rõ; có khoản kế hoạch thì cho nút xoá', () => {
    const r = build({ planned: [{ id: 'p1', kind: 'withdraw', date: '2026-10-20', amount: 1e8 }], dividends: [{ date: '2026-10-25', symbol: 'FPT', amount: 5e6, kind: 'estimated' }] });
    const h = A.cashHtml(S(r));
    expect(h).toContain('Không'); expect(h).toContain('chưa chắc'); expect(h).toContain('insCashDel(\'p1\')'); expect(h).toContain('Giả định');
  });
  it('biểu đồ số dư chịu được chuỗi phẳng', () => { expect(A.balanceChart([{ date: '2026-10-12', balance: 5 }, { date: '2026-10-13', balance: 5 }], 0)).toContain('<path'); });
});

describe('Luân chuyển ngành', () => {
  const ds = Array.from({ length: 200 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const mk = (f) => ds.map((d, i) => [d, f(i)]);
  const an = SR.analyze({ VNINDEX: mk((i) => 1000 + i), VNFIN: mk((i) => (1000 + i) * Math.exp(0.002 * i)), VNIT: mk((i) => (1000 + i) * Math.exp(-0.002 * i)) }, 'VNINDEX', { VNFIN: 'Tài chính', VNIT: 'Công nghệ' });
  it('vẽ sơ đồ bốn góc, tên ngành, bảng xếp hạng và lời giải thích có nêu giới hạn', () => {
    const h = A.rotationHtml({ state: 'ok', res: an, lines: SR.narrate(an) });
    expect(h).toContain('DẪN ĐẦU'); expect(h).toContain('TỤT HẬU'); expect(h).toContain('Tài chính'); expect(h).toContain('không phải số liệu JdK'); expect(h).toContain('clip-path'); expect(h).toContain('Bảng xếp hạng');
  });
  it('chưa đủ lịch sử thì nói rõ', () => {
    expect(A.rotationHtml({ state: 'ok', res: SR.analyze({ VNINDEX: mk((i) => i + 1).slice(0, 20) }, 'VNINDEX', {}), lines: [] })).toContain('Chưa đủ lịch sử');
  });
});

describe('Luận điểm', () => {
  const idea = (o) => Object.assign({ id: 'i1', user_id: 'u1', symbol: 'FPT', title: 'AI <script>', direction: 'long', status: 'in_portfolio' }, o || {});
  const ctx = { metrics: { roae: 0.1, debtToEquity: 0.4 }, price: 50000 };
  const items = (conds, i) => [{ idea: idea(i), ev: TC.evaluateIdea(conds, ctx) }];
  const S = (it, o) => Object.assign({ state: 'ok', scope: 'mine', data: { members: { u1: 'Tôi' } }, items: it, logRows: [], formIdea: null, form: null, suggestions: {}, snapshotDate: '2026-10-09', me: { actorId: 'u1', isManager: false }, now: Date.parse('2026-10-11T12:00:00Z') }, o || {});
  it('luận điểm bị phá vỡ khi điều kiện quan trọng sai, kèm giá trị hiện tại và tên có mã lạ được thoát HTML', () => {
    const h = B.thesisHtml(S(items([{ id: 'c1', metric: 'roae', op: '>=', threshold: 15, severity: 'critical' }, { id: 'c2', metric: 'debtToEquity', op: '<=', threshold: 1, severity: 'watch' }])));
    expect(h).toContain('Bị phá vỡ'); expect(h).toContain('ROE ≥ 15%'); expect(h).toContain('10,0'); expect(h).toContain('0,40'); expect(h).not.toContain('<script>'); expect(h).toContain('AI &lt;script&gt;'); expect(h).toContain('50% đúng');
  });
  it('người không có quyền sửa không thấy nút thêm / xoá điều kiện', () => {
    const it = items([{ id: 'c1', metric: 'roae', op: '>=', threshold: 5, severity: 'watch' }], { user_id: 'u2' });
    const h = B.thesisHtml(S(it));
    expect(h).not.toContain('insThesisDel'); expect(h).not.toContain('insThesisForm(');
    expect(B.thesisHtml(S(it, { me: { actorId: 'u1', isManager: true } }))).toContain('insThesisDel(\'c1\')');
  });
  it('điều kiện thủ công có nút xác nhận; chưa có điều kiện thì hướng dẫn', () => {
    const h = B.thesisHtml(S(items([{ id: 'm1', metric: 'manual', severity: 'critical', label: 'Được cấp phép', manualMet: null }])));
    expect(h).toContain('Đã xảy ra'); expect(h).toContain('Chưa rõ'); expect(h).toContain('Chưa có số liệu') ;
    expect(B.thesisHtml(S(items([])))).toContain('Chưa đặt điều kiện');
    expect(B.thesisHtml(S([]))).toContain('chưa có ý tưởng đang mở');
  });
  it('biểu mẫu thêm điều kiện: chỉ tiêu thủ công ẩn phép so và ngưỡng; gợi ý hiện khi mở biểu mẫu', () => {
    const base = items([]);
    const open = B.thesisHtml(S(base, { formIdea: 'i1', form: null, suggestions: { i1: [{ metric: 'roae', op: '>=', threshold: 8, severity: 'watch', label: 'ROE không giảm' }] } }));
    expect(open).toContain('ins-cf-th'); expect(open).toContain('Gợi ý từ số liệu hiện tại'); expect(open).toContain('insThesisSuggest');
    const man = B.thesisHtml(S(base, { formIdea: 'i1', form: { metric: 'manual', op: '>=', threshold: '', severity: 'critical', label: '' } }));
    expect(man).not.toContain('ins-cf-th'); expect(man).toContain('Mô tả sự kiện');
  });
});

describe('Sở hữu', () => {
  const ins = (net) => ({ signal: net > 0 ? 'buy' : (net < 0 ? 'sell' : 'none'), cluster: false, netQty: net, pendingBuy: 0, pendingSell: 0, last: net ? '2026-09-29' : null });
  const S = (o) => Object.assign({ state: 'ok', rows: [], sel: null, detail: null, detailState: 'idle', lookup: '', syncing: false, now: Date.parse('2026-10-11T12:00:00Z'), today: '2026-10-11' }, o || {});
  it('bảng mã: mã chưa đồng bộ nói rõ; room hẹp có nhãn; có nút đồng bộ', () => {
    const rows = [{ symbol: 'FPT', held: true, room: 1.2, band: { key: 'full', label: 'Gần hết room' }, synced: true, syncedAt: '2026-10-09T12:00:00Z', ins: ins(915529) }, { symbol: 'SSI', held: false, room: null, band: { key: 'unknown', label: '—' }, synced: false, syncedAt: null, ins: ins(0) }];
    const h = B.ownershipHtml(S({ rows: rows }));
    expect(h).toContain('Gần hết room'); expect(h).toContain('Mua ròng'); expect(h).toContain('chưa đồng bộ'); expect(h).toContain('insOwnSyncAll'); expect(h).toContain('thông tin CÔNG BỐ');
  });
  it('chi tiết: tập trung cổ đông, mua ròng nội bộ, đăng ký tách khỏi đã thực hiện; chưa đồng bộ thì mời đồng bộ', () => {
    const detail = { symbol: 'FPT', holders: [{ owner_name: 'Ông A', position: 'Chủ tịch', pct: 6.89, quantity: 100, public_date: '2026-06-30' }, { owner_name: 'Cổ đông cũ', pct: 2.4, quantity: 5, public_date: '2011-08-10' }],
      trades: [{ id: 't1', symbol: 'FPT', trader: 'Ông B', position: 'TGĐ', action: 'B', status: 'done', shares_before: 1, shares_after: 2, registered: 1000, acquired: 1000, pct_after: 0.3, end_date: '2026-09-28', public_date: '2026-09-29' }, { id: 't2', symbol: 'FPT', trader: 'Ông C', action: 'B', status: 'registered', registered: 5000, acquired: null, pct_after: null, end_date: '2026-12-31', public_date: '2026-10-05' }],
      sync: { ok: true, synced_at: '2026-10-09T12:00:00Z' }, ratios: { foreignRoomLeftPct: 12 } };
    const h = B.detailHtml(S({ sel: 'FPT', detail: detail, detailState: 'ok' }));
    expect(h).toContain('Chi tiết FPT'); expect(h).toContain('Ông A'); expect(h).toContain('(5.000)'); expect(h).toContain('Đăng ký'); expect(h).toContain('1 dòng số cũ bị bỏ'); expect(h).toContain('Room còn rộng');
    expect(B.detailHtml(S({ sel: 'FPT', detail: Object.assign({}, detail, { sync: null }), detailState: 'ok' }))).toContain('chưa được đồng bộ');
  });
});

describe('Độ chính xác và Kho dữ liệu', () => {
  const emptyOut = { total: 0, summary: FA.summarizeOutcomes([]), calibration: [], firstDue: null };
  const base = (o) => Object.assign({ state: 'ok', hk: 'm6', lastDate: '2026-10-09', pricedSymbols: 0, missingPrices: [], val: { total: 0, scorable: 0, summaries: {}, methods: [], authors: [], firstDue: {} }, ideas: emptyOut, decisions: emptyOut, earn: { rows: [], summary: FA.summarizeEarnings([]) } }, o || {});
  it('chưa có dữ liệu: hướng dẫn cách tạo, không hiện con số giả', () => {
    const h = C.accuracyHtml(base());
    expect(h).toContain('Chưa có định giá nào được lưu'); expect(h).toContain('Chưa có ý tưởng nào'); expect(h).toContain('Chưa có quyết định nào'); expect(h).toContain('không sửa được');
  });
  it('mẫu nhỏ được gắn nhãn và có khoảng tin cậy', () => {
    const v = (gap, ex) => ({ scorable: true, gap: gap, horizons: { m6: { excess: ex, errFair: -0.1, hit: gap * ex > 0, inRange: true, closed: 0.4 } }, methods: [] });
    const sc = [v(0.2, 0.1), v(0.3, -0.05), v(-0.1, -0.1)];
    const s = FA.summarizeValuations(sc, 'm6');
    const h = C.accuracyHtml(base({ val: { total: 3, scorable: 3, summaries: { m6: s, m3: FA.summarizeValuations(sc, 'm3'), m12: FA.summarizeValuations(sc, 'm12') }, methods: [], authors: [], firstDue: {} } }));
    expect(h).toContain('mẫu nhỏ'); expect(h).toContain('(3 &lt; 10)'); expect(h).toContain('fa-solid fa-scale-balanced'); expect(h).toContain('2/3'); expect(h).toContain('Thiên lạc quan');
  });
  it('dự phóng lợi nhuận: sai số, chưa công bố, nút xoá chỉ cho người được phép', () => {
    const rows = [{ id: 'f1', symbol: 'FPT', metric: 'lnst', year: 2026, quarter: 2, madeAt: '2026-07-10', authorName: 'Tôi', forecast: 3.1e12, actual: 3.0e12, err: 0.033, matured: true, canDelete: true }, { id: 'f2', symbol: 'FPT', metric: 'lnst', year: 2026, quarter: 3, madeAt: '2026-10-02', authorName: 'Minh', forecast: 3.4e12, actual: null, err: null, matured: false, canDelete: false }];
    const h = C.accuracyHtml(base({ earn: { rows: rows, summary: FA.summarizeEarnings([{ matured: true, err: 0.033, ape: 0.033, within10: true }]) } }));
    expect(h).toContain('+3,3%'); expect(h).toContain('chưa công bố'); expect(h).toContain('insForecastDel(\'f1\')'); expect(h).not.toContain('insForecastDel(\'f2\')');
  });
  it('kho dữ liệu: tiến độ, khoảng hở, lần chạy, và tra cứu như ngày D', () => {
    const days = [{ as_of: '2026-10-05', n: 1520 }, { as_of: '2026-10-07', n: 1522 }];
    const cov = PC.coverage(days, { today: '2026-10-09' }), st = { days: days, fundamentals: { count: 71, first: '2026-10-11' }, news: { count: 140, first: '2026-10-11' }, runs: [{ fn: 'pit-capture', mode: 'daily', run_at: '2026-10-07T12:05:00Z', ok: true, detail: { as_of: '2026-10-07', symbols: 1522, fundamentals_added: 0 } }, { fn: 'insight-sync', mode: 'thesis', run_at: '2026-10-07T12:35:00Z', ok: false, detail: {} }] };
    const h = C.archiveHtml({ state: 'ok', status: st, cov: cov, ready: PC.readiness(cov.days), lookup: {}, screen: { pe: '15', roe: '15', mcap: '1000' }, screenRes: null, defaultDate: '2026-10-07' });
    expect(h).toContain('Ngày đã chụp'); expect(h).toContain('1 khoảng hở'); expect(h).toContain('không bù ngược được'); expect(h).toContain('1522 mã'); expect(h).toContain('Lỗi'); expect(h).toContain('Xem như ngày đó');
  });
  it('tra cứu trước ngày kho bắt đầu thì báo, không bịa số', () => {
    const cov = PC.coverage([{ as_of: '2026-10-05', n: 1 }], { today: '2026-10-09' });
    const h = C.archiveHtml({ state: 'ok', status: { days: [], fundamentals: { count: 0 }, news: { count: 0 }, runs: [] }, cov: cov, ready: PC.readiness(1), lookup: { state: 'ok', date: '2026-01-01', symbol: 'FPT', day: null }, screen: {}, screenRes: null });
    expect(h).toContain('Không có bản chụp nào vào hoặc trước ngày');
  });
});
