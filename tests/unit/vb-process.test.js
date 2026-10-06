// lib/vb-process.js: quy trình định giá 7 bước (phân loại mô hình, cổng dữ liệu, vai trò -> trọng số, đối chiếu, kiểm tra hợp lý, kết luận).
import { describe, it, expect } from 'vitest';
import P from '../../lib/vb-process.js';
import Y from '../../lib/vb-synthesis.js';
import E from '../../lib/vb-engine.js';

const NOW = new Date('2026-10-05T00:00:00Z');
const per = (year, o) => Object.assign({ date: year + '-12-31', year, form: 'NON_FINANCE', revenue: 1000, netIncome: 100, ebit: 130, totalAssets: 1200, equity: 600, fcf: 80, divPaid: 30, inventory: 100, ltInvest: 50, ebitda: 160 }, o || {});
const years = (n, f) => Array.from({ length: n }, (_, i) => per(2026 - n + 1 + i, f ? f(i, n) : {}));
const res = (o) => Object.assign({ form: 'NON_FINANCE', periods: years(5), ttm: null, multiples: { eps: 5 }, fundamental: { growth: { revenue3y: 0.08 } }, price: 100, shares: 1e6, technical: { ok: true }, bandPE: { n: 1000 }, bandPB: { n: 1000 }, dupont: { roe: 0.15 }, quality: {} }, o || {});

describe('classify (bước 1)', () => {
  it('doanh nghiệp bình thường -> trưởng thành', () => { expect(P.classify(res(), {}).key).toBe('MATURE'); });
  it('mẫu báo cáo tài chính quyết định ngân hàng, chứng khoán, bảo hiểm', () => {
    ['BANK', 'SECURITIES', 'INSURANCE'].forEach((f) => expect(P.classify(res({ form: f }), {}).key).toBe(f));
  });
  it('lợi nhuận không dương -> phục hồi (bất kể ngành)', () => {
    expect(P.classify(res({ multiples: { eps: -2 } }), { sectorCode: '1700' }).key).toBe('TURNAROUND');
    expect(P.classify(res({ periods: years(5, () => ({ netIncome: -10 })) }), {}).key).toBe('TURNAROUND');
  });
  it('tăng trưởng doanh thu từ 15%/năm -> tăng trưởng cao', () => { expect(P.classify(res({ fundamental: { growth: { revenue3y: 0.18 } } }), {}).key).toBe('GROWTH'); });
  it('ngành chu kỳ hoặc lợi nhuận dao động mạnh -> chu kỳ', () => {
    expect(P.classify(res(), { sectorCode: '1700' }).key).toBe('CYCLICAL');
    const wild = years(6, (i) => ({ netIncome: [20, 300, 40, 280, 10, 260][i] }));
    expect(P.classify(res({ periods: wild }), {}).key).toBe('CYCLICAL');
  });
  it('ngành bất động sản hoặc tồn kho lớn -> bất động sản', () => {
    expect(P.classify(res(), { sectorCode: '8600' }).key).toBe('REAL_ESTATE');
    expect(P.classify(res({ periods: years(5, () => ({ inventory: 700 })) }), {}).key).toBe('REAL_ESTATE');
  });
  it('đầu tư dài hạn lớn hoặc có SOTP -> công ty mẹ', () => {
    expect(P.classify(res({ periods: years(5, () => ({ ltInvest: 600 })) }), {}).key).toBe('HOLDING');
    expect(P.classify(res(), { hasSotp: true }).key).toBe('HOLDING');
  });
  it('tiện ích hoặc trả cổ tức cao và ổn định -> cổ tức', () => {
    expect(P.classify(res(), { sectorCode: '7500' }).key).toBe('DIVIDEND');
    expect(P.classify(res({ periods: years(5, () => ({ divPaid: 60 })) }), {}).key).toBe('DIVIDEND');
  });
  it('người dùng chọn lại mô hình thì được ghi nhận và nêu cả mô hình tự nhận', () => {
    const c = P.classify(res(), { override: { archetype: 'CYCLICAL' } });
    expect(c.key).toBe('CYCLICAL'); expect(c.source).toBe('user'); expect(c.auto).toBe('MATURE'); expect(c.why[0]).toContain('Người dùng');
    expect(P.classify(res(), { override: { archetype: 'KHONG-CO' } }).key).toBe('MATURE');
  });
});

describe('gate (bước 2)', () => {
  it('đủ dữ liệu -> ok', () => {
    const g = P.gate(res({ ttm: { date: '2026-06-30' } }), { now: NOW, peerStats: { pe: { n: 20 } } });
    expect(g.status).toBe('ok');
  });
  it('thiếu giá hoặc quá ít năm -> chặn', () => {
    expect(P.gate(res({ price: null }), { now: NOW }).status).toBe('blocked');
    expect(P.gate(res({ periods: years(2) }), { now: NOW }).status).toBe('blocked');
  });
  it('thiếu thống kê ngành, TTM hoặc báo cáo cũ -> có hạn chế', () => {
    const g = P.gate(res({ periods: years(4), ttm: null }), { now: NOW });
    expect(g.status).toBe('limited'); expect(g.items.find((i) => i.key === 'peers').level).toBe('warn'); expect(g.items.find((i) => i.key === 'ttm').level).toBe('warn');
    expect(P.gate(res({ ttm: {} }), { now: new Date('2030-01-01') }).items.find((i) => i.key === 'fresh').level).toBe('warn');
  });
  it('tổ chức tài chính không bị đòi TTM kiểu doanh nghiệp', () => { expect(P.gate(res({ form: 'BANK' }), { now: NOW }).items.some((i) => i.key === 'ttm')).toBe(false); });
});

describe('plan (bước 3): vai trò -> trọng số', () => {
  const m = (key, base, o) => Object.assign({ key, label: key, base, group: key.indexOf('peer') === 0 || key.indexOf('hist') === 0 ? 'relative' : 'intrinsic' }, o || {});
  const methods = [m('dcf', 120), m('peer-pe', 100, { n: 20 }), m('peer-evEbitda', 110, { n: 20 }), m('hist-pe', 90), m('graham', 80), m('peer-pb', 70, { n: 20 })];
  it('mỗi phương pháp có vai trò theo mô hình, trọng số theo vai trò', () => {
    const pl = P.plan(res(), methods, { now: NOW });
    const by = (k) => pl.rows.find((r) => r.key === k);
    expect(by('dcf').role).toBe('core'); expect(by('dcf').weight).toBe(2.5);
    expect(by('hist-pe').role).toBe('support'); expect(by('hist-pe').weight).toBe(1.2);
    expect(by('peer-pb').role).toBe('check'); expect(by('peer-pb').weight).toBe(0.5);
    expect(by('graham').role).toBe('ref'); expect(by('graham').weight).toBe(0);
    expect(pl.weights.dcf).toBe(2.5); expect(pl.coreActive).toBe(3);
  });
  it('phương pháp "hạn chế" bị giảm nửa trọng số và nêu lý do', () => {
    const r = P.plan(res(), [m('dcf', 120), m('peer-pe', 100, { n: 6 })], { now: NOW }).rows.find((x) => x.key === 'peer-pe');
    expect(r.status).toBe('limited'); expect(r.weight).toBeCloseTo(1.25, 9); expect(r.limit).toContain('6 mã');
  });
  it('DCF có giá trị cuối kỳ quá lớn hoặc dòng tiền âm kéo dài bị hạn chế', () => {
    const tv = P.plan(res(), [m('dcf', 120)], { now: NOW }).rows[0];
    expect(tv.status).toBe('ok');
    const r2 = res({ dcf: { ok: true, tvSharePct: 82 } });
    expect(P.plan(r2, [m('dcf', 120)], { now: NOW }).rows[0].status).toBe('limited');
    const r3 = res({ dcf: { ok: true, tvSharePct: 50 }, periods: years(5, () => ({ fcf: -10 })) });
    expect(P.plan(r3, [m('dcf', 120)], { now: NOW }).rows[0].limit).toContain('âm');
  });
  it('phương pháp chính chưa tính được thì thành lỗ hổng kèm lý do và hướng xử lý', () => {
    const pl = P.plan(res(), [m('peer-pb', 70, { n: 20 })], { now: NOW, override: { archetype: 'REAL_ESTATE' } });
    expect(pl.gaps.map((g) => g.key)).toContain('nav');
    expect(pl.gaps.find((g) => g.key === 'nav').reason).toContain('NAV');
    expect(pl.rows.find((r) => r.key === 'nav').computed).toBe(false);
  });
  it('người dùng đổi vai trò: có hiệu lực, đánh dấu user và ghi lý do', () => {
    const pl = P.plan(res(), methods, { now: NOW, override: { roles: { graham: 'core' }, reasons: { graham: 'doanh nghiệp tài sản nặng' } } });
    const g = pl.rows.find((r) => r.key === 'graham');
    expect(g.role).toBe('core'); expect(g.weight).toBe(2.5); expect(g.user).toBe(true); expect(g.why).toContain('tài sản nặng');
    const off = P.plan(res(), methods, { now: NOW, override: { roles: { dcf: 'off' } } }).rows.find((r) => r.key === 'dcf');
    expect(off.weight).toBe(0); expect(off.roleLabel).toBe('Loại');
  });
  it('P/E của doanh nghiệp tăng trưởng không bị coi là lợi nhuận đỉnh; của doanh nghiệp chu kỳ thì có', () => {
    const jump = years(5, (i) => ({ netIncome: [100, 120, 145, 175, 210][i] }));      // tăng đều: hiện tại gấp ~1,55 lần bình quân các năm trước
    const g = P.plan(res({ periods: jump, fundamental: { growth: { revenue3y: 0.2 } } }), [m('peer-pe', 100, { n: 20 })], { now: NOW }).rows.find((x) => x.key === 'peer-pe');
    expect(g.status).toBe('ok');
    const c = P.plan(res({ periods: jump }), [m('peer-pe', 100, { n: 20 })], { now: NOW, sectorCode: '1700' }).rows.find((x) => x.key === 'peer-pe');
    expect(c.status).toBe('limited'); expect(c.limit).toContain('đỉnh');
  });
  it('trọng số của quy trình đi vào tổng hợp; người dùng chỉnh trọng số vẫn thắng', () => {
    const pl = P.plan(res(), methods, { now: NOW });
    const s = Y.synthesize({ price: 100, form: 'NON_FINANCE', methods, weightDefaults: pl.weights });
    expect(s.methods.find((x) => x.key === 'dcf').weight).toBe(2.5); expect(s.methods.find((x) => x.key === 'graham').weight).toBe(0);
    const s2 = Y.synthesize({ price: 100, form: 'NON_FINANCE', methods, weightDefaults: pl.weights, weightOverrides: { dcf: 0.5 } });
    expect(s2.methods.find((x) => x.key === 'dcf').weight).toBe(0.5); expect(s2.methods.find((x) => x.key === 'dcf').defaultWeight).toBe(2.5);
  });
});

describe('review (bước 5-7)', () => {
  const m = (key, base, group) => ({ key, label: key, base, group: group || 'intrinsic' });
  const run = (methods, over, resOver, opts) => {
    const r = res(resOver), o = Object.assign({ now: NOW, override: over }, opts || {}), pl = P.plan(r, methods, o);
    const synth = Y.synthesize({ price: 100, form: 'NON_FINANCE', methods, weightDefaults: pl.weights });
    return { pl, synth, rv: P.review(r, synth, pl, o) };
  };
  it('các phương pháp chính gần nhau -> đồng thuận, hoàn tất nếu không có cảnh báo khác', () => {
    const { rv } = run([m('dcf', 100), m('peer-pe', 105, 'relative'), m('peer-evEbitda', 98, 'relative')], null, { ttm: { date: '2026-06-30' } }, { peerStats: { pe: { n: 20 } } });
    expect(rv.triangulation.verdict.key).toBe('agree'); expect(rv.checks.find((c) => c.key === 'triangulation').level).toBe('pass');
    expect(rv.status).toBe('complete'); expect(rv.needsAck).toBe(false);
  });
  it('các phương pháp chính chênh quá 50% -> bất đồng, trạng thái cần xử lý, bắt buộc ghi lý do', () => {
    const { rv } = run([m('dcf', 160), m('peer-pe', 90, 'relative'), m('peer-evEbitda', 95, 'relative')]);
    expect(rv.triangulation.verdict.key).toBe('disagree'); expect(rv.status).toBe('review'); expect(rv.needsAck).toBe(true); expect(rv.fails).toBeGreaterThan(0);
  });
  it('từ 4 phương pháp chính, phương pháp lệch xa nhất được tách riêng thay vì phá đồng thuận', () => {
    const { rv } = run([m('dcf', 100), m('peer-pe', 104, 'relative'), m('peer-evEbitda', 97, 'relative'), m('hist-pb', 250, 'relative')], { archetype: 'CYCLICAL', roles: { dcf: 'core', 'peer-pe': 'core' } });
    expect(rv.triangulation.dropped.key).toBe('hist-pb'); expect(rv.triangulation.verdict.key).toBe('agree');
  });
  it('so sánh giá trị nội tại với giá trị theo bội số và giải thích chênh lệch', () => {
    const { rv } = run([m('dcf', 160), m('peer-pe', 100, 'relative'), m('peer-evEbitda', 100, 'relative')]);
    expect(rv.triangulation.groupNote).toContain('cao hơn');
  });
  it('kiểm tra DCF: giá trị cuối kỳ, tăng trưởng dài hạn, WACC, biên, tăng trưởng so với lịch sử', () => {
    const dcfRes = { dcf: { ok: true, tvSharePct: 90, ev: 5e9 }, dcfAssumptions: { rf: 0.04, gTerminal: 0.06, wacc: 0.2, g1: 0.35, marginTarget: 0.4 }, fundamental: { growth: { revenue3y: 0.08 } } };
    const { rv } = run([m('dcf', 100), m('peer-pe', 100, 'relative')], null, dcfRes);
    const lv = (k) => rv.checks.find((c) => c.key === k).level;
    expect(lv('dcf-tv')).toBe('fail'); expect(lv('dcf-g')).toBe('warn'); expect(lv('dcf-wacc')).toBe('warn'); expect(lv('dcf-g1')).toBe('warn'); expect(lv('dcf-margin')).toBe('warn');
  });
  it('DCF ngược chỉ cung cấp thông tin, không tính vào pass/warn/fail', () => {
    const { rv } = run([m('dcf', 100), m('peer-pe', 100, 'relative')], null, { dcf: { ok: true, tvSharePct: 50 }, dcfAssumptions: { g1: 0.1, gTerminal: 0.03, wacc: 0.1, rf: 0.04 }, implied: { impliedGrowthStage1: 0.2 } });
    const c = rv.checks.find((x) => x.key === 'reverse-dcf'); expect(c.level).toBe('info'); expect(c.detail).toContain('tính trước');
  });
  it('giá lệch quá xa giá trị đồng thuận bị cảnh báo', () => {
    const { rv } = run([m('dcf', 40), m('peer-pe', 42, 'relative'), m('peer-evEbitda', 41, 'relative')]);
    expect(rv.checks.find((c) => c.key === 'price-gap').level).toBe('warn');
  });
  it('chất lượng báo cáo xấu vào danh mục kiểm tra', () => {
    const q = { altman: { zone2: { key: 'distress', label: 'Nguy cơ' } }, beneish: { flag: { key: 'risk', label: 'Có dấu hiệu' } }, piotroski: { score: 2, available: 9, grade: { key: 'weak', label: 'Yếu' } } };
    const { rv } = run([m('dcf', 100), m('peer-pe', 100, 'relative')], null, { quality: q });
    expect(rv.checks.find((c) => c.key === 'altman').level).toBe('fail'); expect(rv.checks.find((c) => c.key === 'beneish').level).toBe('warn'); expect(rv.checks.find((c) => c.key === 'piotroski').level).toBe('warn');
  });
  it('thiếu dữ liệu then chốt -> chưa đủ để kết luận', () => {
    const r = res({ price: null }), pl = P.plan(r, [m('dcf', 100)], { now: NOW }), rv = P.review(r, { ok: false, reason: 'Thiếu giá hiện tại.' }, pl, { now: NOW });
    expect(rv.status).toBe('blocked'); expect(rv.needsAck).toBe(true);
  });
  it('compact giữ đủ để tái hiện quy trình và không chứa số liệu thô', () => {
    const { pl, rv } = run([m('dcf', 100), m('peer-pe', 100, 'relative')], { ack: 'Chấp nhận vì lý do X' });
    const c = P.compact(Object.assign(pl, rv));
    expect(c.archetype).toBe('MATURE'); expect(c.ack).toBe('Chấp nhận vì lý do X'); expect(c.methods.find((x) => x.key === 'dcf').role).toBe('core'); expect(Array.isArray(c.checks)).toBe(true);
    expect(JSON.stringify(c).length).toBeLessThan(6000);
    expect(P.compact(null)).toBeNull();
  });
});

describe('engine: quy trình chạy xuyên suốt', () => {
  it('không có báo cáo: analyze() không vỡ và không có process', () => {
    const r = E.analyze({ symbol: 'ZZZ', annualRows: [] });
    expect(r.ok).toBe(false); expect(r.process === undefined || r.process === null).toBe(true);
  });
});
