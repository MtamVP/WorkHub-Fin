import { describe, it, expect } from 'vitest';
import K from '../../lib/vb-market.js';
import Y from '../../lib/vb-synthesis.js';
import E from '../../lib/vb-engine.js';

// ---------- bối cảnh thị trường ----------
function hist(scope, key, vals) {
  return vals.map((v, i) => ({ as_of: new Date(Date.UTC(2026, 8, 30) - (vals.length - 1 - i) * 30.4 * 86400000).toISOString().slice(0, 10), scope: scope, [key]: v }));
}
const up = (n, a, b) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));

describe('VBMarket', () => {
  it('vòng quay JdK', () => {
    expect(K.rotation(105, 102).key).toBe('leading'); expect(K.rotation(105, 98).key).toBe('weakening'); expect(K.rotation(95, 102).key).toBe('improving'); expect(K.rotation(95, 98).key).toBe('lagging'); expect(K.rotation(null, 1)).toBeNull();
  });
  it('thị trường rẻ và ngành dẫn đầu cho gió thuận; thị trường đắt và ngành tụt hậu cho gió ngược', () => {
    const cheap = K.context({ histRows: hist('ALL', 'pe_agg', up(60, 18, 9)), bond10yPct: 3, sectorCode: '9500', sectorStats: { jdkRs: { median: 104 }, jdkMom: { median: 102 } }, indexTech: { ok: true, score: 60, rating: { label: 'Xu hướng tăng mạnh' }, price: 110, latest: { rsi: 60, sma200: 100 } } });
    expect(cheap.regime.key).toBe('tailwind'); expect(cheap.score).toBeGreaterThan(30);
    const dear = K.context({ histRows: hist('ALL', 'pe_agg', up(60, 9, 18)).concat(hist('9500', 'pe_agg', up(60, 8, 20))), bond10yPct: 9, sectorCode: '9500', sectorStats: { jdkRs: { median: 95 }, jdkMom: { median: 97 } }, indexTech: { ok: true, score: -60, rating: { label: 'Xu hướng giảm mạnh' }, price: 90, latest: { rsi: 30, sma200: 100 } } });
    expect(dear.regime.key).toBe('headwind'); expect(dear.score).toBeLessThan(-30);
  });
  it('thiếu dữ liệu thì bỏ yếu tố, không đoán; trống hoàn toàn: điểm null', () => {
    expect(K.context({}).score).toBeNull(); expect(K.context({}).count).toBe(0);
    const only = K.context({ histRows: hist('ALL', 'pe_agg', up(60, 10, 10.1)) });
    expect(only.factors.map((f) => f.key)).toEqual(['market-val']);
  });
  it('cờ thanh khoản thấp, beta cao, room ngoại hẹp', () => {
    const r = K.context({ stock: { metrics: { advValue20: 5e8, beta: 1.8, foreignRoomLeftPct: 1 } } });
    expect(r.flags.map((f) => f.text).join('|')).toMatch(/Thanh khoản thấp.*Beta 1,8.*Room ngoại/s);
  });
  it('dòng tiền khối ngoại chuẩn hoá theo giá trị giao dịch', () => {
    const r = K.context({ stock: { metrics: { foreignNet5d: 5e9, advValue20: 10e9 } } });
    expect(r.factors.find((f) => f.key === 'foreign').score).toBeCloseTo(0.1 / 0.1 > 1 ? 1 : 0.1 / 0.1, 6);
  });
});

// ---------- tổng hợp ----------
const M = (key, group, low, base, high) => ({ key: key, group: group, label: key, low: low, base: base, high: high });
describe('VBSynthesis', () => {
  it('trung vị có trọng số bền với giá trị lệch xa', () => {
    expect(Y.weightedMedian([{ v: 10, w: 1 }, { v: 12, w: 1 }, { v: 1000, w: 1 }])).toBe(12);
    expect(Y.weightedMedian([{ v: 10, w: 5 }, { v: 12, w: 1 }, { v: 1000, w: 1 }])).toBe(10);
    expect(Y.weightedMedian([{ v: 10, w: 1 }, { v: 20, w: 1 }])).toBe(15);
    expect(Y.weightedMedian([])).toBeNull();
  });
  it('trọng số mặc định theo loại doanh nghiệp, người dùng ghi đè được, phương pháp trọng số 0 hiển thị nhưng không tính', () => {
    const p = Y.prepare([M('dcf', 'intrinsic', 80, 100, 120), M('peer-pe', 'relative', 70, 90, 110), M('ncav', 'asset', 1, 2, 3), M('x', 'asset', 0, 0, 0)], 'NON_FINANCE', { 'peer-pe': 5 });
    expect(p).toHaveLength(3); expect(p[0].weight).toBe(3); expect(p[1].weight).toBe(5); expect(p[2].weight).toBe(0);
    expect(Y.prepare([M('ri', 'intrinsic', 1, 2, 3)], 'BANK')[0].weight).toBe(3);
  });
  it('giá trị đồng thuận nằm giữa các phương pháp; low ≤ base ≤ high; thiếu low/high thì ±15%', () => {
    const s = Y.synthesize({ price: 100, form: 'NON_FINANCE', methods: [M('dcf', 'intrinsic', null, 120, null), M('peer-pe', 'relative', 80, 100, 130), M('hist-pe', 'relative', 90, 110, 140)] });
    expect(s.ok).toBe(true); expect(s.fair.base).toBe(115); expect(s.fair.low).toBeLessThanOrEqual(s.fair.base); expect(s.fair.high).toBeGreaterThanOrEqual(s.fair.base);
    expect(s.methods[0].low).toBeCloseTo(102, 9); expect(s.methods[0].high).toBeCloseTo(138, 9);
  });
  it('xếp hạng giá so với giá trị: rẻ rõ rệt → đắt', () => {
    const f = (price) => Y.synthesize({ price: price, form: 'NON_FINANCE', methods: [M('dcf', 'intrinsic', 90, 100, 110), M('peer-pe', 'relative', 90, 100, 110)] }).grade.key;
    expect(f(60)).toBe('deep'); expect(f(85)).toBe('cheap'); expect(f(100)).toBe('fair'); expect(f(120)).toBe('rich'); expect(f(150)).toBe('expensive');
  });
  const base = [M('dcf', 'intrinsic', 90, 100, 110), M('peer-pe', 'relative', 90, 100, 110), M('hist-pe', 'relative', 90, 100, 110)];
  const tech = (score) => ({ ok: true, score: score, rating: { label: score > 0 ? 'Xu hướng tăng' : 'Xu hướng giảm' }, latest: { atr: 2 }, levels: { supports: [{ price: 70, strength: 3 }], resistances: [{ price: 110 }], low52: 60 } });
  it('ma trận kết luận kết hợp', () => {
    const run = (price, ts, ms) => Y.synthesize({ price: price, form: 'NON_FINANCE', methods: base, technical: tech(ts), market: { score: ms, regime: { label: 'x' } } }).stance.key;
    expect(run(75, 50, 40)).toBe('converge-pos'); expect(run(75, -50, 0)).toBe('value-trap-risk'); expect(run(75, 0, 0)).toBe('cheap-neutral');
    expect(run(130, 50, 0)).toBe('momentum-expensive'); expect(run(130, -50, 0)).toBe('converge-neg'); expect(run(130, 0, 0)).toBe('expensive-neutral'); expect(run(100, 0, 0)).toBe('fair');
  });
  it('điểm tổng hợp trọng số 50/30/20 và bỏ phần thiếu', () => {
    const s = Y.synthesize({ price: 60, form: 'NON_FINANCE', methods: base, technical: tech(40), market: { score: -10, regime: { label: 'x' } } });
    expect(s.composite).toBeCloseTo(0.5 * 100 + 0.3 * 40 + 0.2 * -10, 6);
    expect(Y.synthesize({ price: 60, form: 'NON_FINANCE', methods: base }).composite).toBeCloseTo(100, 6);
  });
  it('vùng giá tham khảo: tích lũy thấp hơn giá trị theo biên an toàn, có hỗ trợ trong vùng; vị trí giá hiện tại', () => {
    const s = Y.synthesize({ price: 95, form: 'NON_FINANCE', methods: base, technical: tech(10), settings: { marginOfSafety: 0.25 } });
    expect(s.zones.accumulate.high).toBeCloseTo(75, 9); expect(s.zones.accumulate.low).toBeLessThan(75); expect(s.zones.position).toBe('fair');
    expect(s.zones.invalidation.price).toBeCloseTo(70 - 2, 9);
    expect(Y.synthesize({ price: 60, form: 'NON_FINANCE', methods: base }).zones.position).toBe('below');
    expect(Y.synthesize({ price: 150, form: 'NON_FINANCE', methods: base }).zones.position).toBe('trim');
  });
  it('độ tin cậy giảm khi ít phương pháp, bất đồng, hoặc chất lượng báo động', () => {
    const few = Y.synthesize({ price: 100, form: 'NON_FINANCE', methods: [M('dcf', 'intrinsic', 90, 100, 110)] });
    const many = Y.synthesize({ price: 100, form: 'NON_FINANCE', methods: [M('dcf', 'intrinsic', 90, 100, 110), M('peer-pe', 'relative', 90, 101, 110), M('hist-pe', 'relative', 90, 99, 110), M('epv', 'asset', 90, 100, 110), M('peer-evEbitda', 'relative', 90, 100, 110)] });
    expect(few.confidenceScore).toBeLessThan(many.confidenceScore);
    const split = Y.synthesize({ price: 100, form: 'NON_FINANCE', methods: [M('dcf', 'intrinsic', 40, 50, 60), M('peer-pe', 'relative', 140, 150, 160), M('hist-pe', 'relative', 90, 100, 110), M('epv', 'asset', 180, 200, 220), M('peer-evEbitda', 'relative', 20, 30, 40)] });
    expect(split.confidence.key).not.toBe('high'); expect(split.cv).toBeGreaterThan(0.4);
    const bad = Y.synthesize({ price: 100, form: 'NON_FINANCE', methods: many.methods, quality: { altman: { zone2: { key: 'distress' } }, beneish: { flag: { key: 'risk' }, m: -1 } } });
    expect(bad.confidenceScore).toBeLessThan(many.confidenceScore - 25); expect(bad.flags.length).toBeGreaterThanOrEqual(2);
  });
  it('phương pháp lệch xa được cờ', () => {
    const s = Y.synthesize({ price: 100, form: 'NON_FINANCE', methods: [M('dcf', 'intrinsic', 90, 100, 110), M('peer-pe', 'relative', 90, 100, 110), M('hist-pe', 'relative', 90, 100, 110), M('graham', 'asset', 10, 20, 30)] });
    expect(s.flags.map((f) => f.text).join('|')).toMatch(/lệch xa/); expect(s.methods.find((m) => m.key === 'graham').outlier).toBe(true);
  });
  it('"điều gì phải đúng" từ DCF ngược; không có phương pháp hoặc không có giá: ok = false', () => {
    const s = Y.synthesize({ price: 100, form: 'NON_FINANCE', methods: base, implied: { impliedGrowthStage1: 0.03, baseGrowthStage1: 0.1, impliedWacc: 0.12, baseWacc: 0.09 }, cagr3: 0.08 });
    expect(s.mustBeTrue.join(' ')).toMatch(/3,0%.*10,0%.*8,0%/); expect(s.mustBeTrue.join(' ')).toMatch(/12,0%/);
    expect(Y.synthesize({ price: 100, methods: [] }).ok).toBe(false); expect(Y.synthesize({ price: null, methods: base }).ok).toBe(false);
  });
});

// ---------- bộ điều phối với dữ liệu giả lập hoàn chỉnh ----------
const B = 1e9;
const R = (code, date, v, model) => ({ itemCode: code, fiscalDate: date, numericValue: v * B, modelType: model });
function company(date, k) {          // doanh nghiệp tăng trưởng đều ~12%/năm
  const s = Math.pow(1.12, k), y = 2021 + k;
  const m = (c, v, mt) => R(c, date, v * s, mt);
  return [m(21001, 1000, 2), m(22100, 600, 2), m(23100, 400, 2), m(22110, 80, 2), m(22200, 60, 2), m(21500, 20, 2), m(22510, 15, 2), m(23800, 270, 2), m(22070, 54, 2), m(23000, 200, 2), m(23500, 16, 2), m(23003, 216, 2),
    m(11100, 150, 1), m(11200, 100, 1), m(11300, 120, 1), m(11400, 90, 1), m(11000, 520, 1), m(12200, 500, 1), m(12700, 1300, 1), m(13000, 450, 1), m(13100, 300, 1), m(13110, 120, 1), m(13340, 60, 1), m(14000, 850, 1), m(14240, 40, 1), m(14110, 100, 1), m(14200, 300, 1),
    m(32000, 230, 3), m(32100, -90, 3), m(22230, 50, 3), m(33600, -60, 3)].map((r) => Object.assign(r, { fy: y }));
}
const ANNUAL = [0, 1, 2, 3, 4].reduce((acc, k) => acc.concat(company((2021 + k) + '-12-31', k)), []);
function candles(n, drift) {
  const t = [], o = [], h = [], l = [], c = [], v = []; let px = 40000;
  for (let i = 0; i < n; i++) { const close = 40000 + drift * i + Math.sin(i / 7) * 2000; o.push(px); px = close; c.push(close); h.push(Math.max(o[i], close) + 300); l.push(Math.min(o[i], close) - 300); v.push(500000 + (i % 9) * 40000); t.push(new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10)); }
  return { t: t, o: o, h: h, l: l, c: c, v: v };
}
const Q = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30];
const PEERS = { pe: { n: 40, median: 14, q: Q }, pb: { n: 40, median: 1.8, q: [0.5, 0.8, 1, 1.2, 1.5, 1.8, 2.1, 2.5, 3, 4, 6] }, ps: { n: 40, median: 1.5, q: [0.3, 0.5, 0.7, 0.9, 1.2, 1.5, 1.9, 2.4, 3, 4, 6] } };
const PE_SERIES = Array.from({ length: 300 }, (_, i) => 12 + (i % 30) * 0.2);

describe('VBEngine (doanh nghiệp phi tài chính)', () => {
  const ctx = { symbol: 'TEST', annualRows: ANNUAL.map((r) => Object.assign({}, r)), candles: candles(400, 15), indexCandles: Object.assign(candles(400, 0.5), { c: candles(400, 0).c.map((x, i) => 1000 + i * 0.5 + Math.sin(i / 9) * 20) }), ratioSeries: { pe: PE_SERIES }, metrics: { shares: 50e6, beta: 1, divYield: 0.025, advValue20: 20e9 }, peerStats: PEERS, histRows: hist('ALL', 'pe_agg', up(60, 10, 14)), bond10yPct: 4, price: 50000 };
  const r = E.analyze(ctx);
  it('chạy trọn vẹn và nhận dạng đúng loại doanh nghiệp', () => {
    expect(r.ok).toBe(true); expect(r.form).toBe('NON_FINANCE'); expect(r.periods).toHaveLength(5); expect(r.shares).toBe(50e6); expect(r.marketCap).toBe(50000 * 50e6);
  });
  it('có DCF, nhạy cảm, Monte Carlo, DCF ngược và kịch bản', () => {
    expect(r.dcf.ok).toBe(true); expect(r.sensitivity.values).toHaveLength(5); expect(r.monteCarlo.ok).toBe(true); expect(r.implied.impliedWacc).toBeGreaterThan(0); expect(r.scenarios.list).toHaveLength(3);
    expect(r.dcfAssumptions.notes.length).toBeGreaterThan(4);
  });
  it('người dùng ghi đè giả định DCF thì kết quả đổi theo hướng đúng', () => {
    const hi = E.analyze(Object.assign({}, ctx, { dcf: { wacc: r.dcfAssumptions.wacc - 0.02 } })), lo = E.analyze(Object.assign({}, ctx, { dcf: { wacc: r.dcfAssumptions.wacc + 0.02 } }));
    expect(hi.dcf.perShare).toBeGreaterThan(r.dcf.perShare); expect(lo.dcf.perShare).toBeLessThan(r.dcf.perShare);
  });
  it('các phương pháp có khoá chuẩn, gồm DCF, ngang hàng, lịch sử, EPV, Graham', () => {
    const keys = r.methods.map((m) => m.key);
    ['dcf', 'peer-pe', 'peer-pb', 'peer-ps', 'hist-pe', 'epv', 'graham'].forEach((k) => expect(keys).toContain(k));
    r.methods.forEach((m) => { expect(m.base).toBeGreaterThan(0); expect(typeof m.note).toBe('string'); });
  });
  it('điểm chất lượng và dupont có mặt; tổng hợp nhất quán', () => {
    expect(r.quality.piotroski.available).toBeGreaterThan(5); expect(r.quality.altman.z2).not.toBeNull(); expect(r.dupont.check).toBeCloseTo(r.dupont.roe, 9);
    const s = r.synthesis; expect(s.ok).toBe(true); expect(s.fair.low).toBeLessThanOrEqual(s.fair.base); expect(s.fair.base).toBeLessThanOrEqual(s.fair.high);
    expect(s.technicalScore).not.toBeNull(); expect(s.marketScore).not.toBeNull(); expect(s.stance.text.length).toBeGreaterThan(20);
  });
  it('trọng số người dùng thay đổi giá trị đồng thuận', () => {
    const only = E.analyze(Object.assign({}, ctx, { weights: { 'peer-pe': 0, 'peer-pb': 0, 'peer-ps': 0, 'hist-pe': 0, epv: 0, graham: 0, lynch: 0, grahamGrowth: 0, ddm: 0, dcf: 5 } }));
    expect(only.synthesis.fair.base).toBeCloseTo(r.dcf.perShare, 6);
  });
  it('thiếu giá và số cổ phiếu: báo cảnh báo, không lỗi', () => {
    const x = E.analyze(Object.assign({}, ctx, { price: null, candles: null, metrics: {}, shares: null }));
    expect(x.ok).toBe(true); expect(x.warnings.length).toBeGreaterThan(0);
  });
  it('không có báo cáo: ok = false kèm lý do', () => { const x = E.analyze({ annualRows: [] }); expect(x.ok).toBe(false); expect(x.reason).toMatch(/báo cáo/); });
});

describe('VBEngine (ngân hàng)', () => {
  const bank = (date, k) => { const s = Math.pow(1.15, k), m = (c, v, mt) => R(c, date, v * s, mt); return [m(421900, 60, 102), m(421701, 80, 102), m(22200, 28, 102), m(422900, 6, 102), m(23800, 40, 102), m(23003, 32, 102), m(23000, 31.5, 102), m(23001, 3000, 102),
    m(12700, 1500, 101), m(13000, 1350, 101), m(14000, 150, 101), m(14110, 50, 101), m(412000, 900, 101), m(412200, -12, 101), m(413300, 1000, 101), m(14200, 60, 101)]; };
  const rows = [0, 1, 2, 3].reduce((a, k) => a.concat(bank((2022 + k) + '-12-31', k)), []);
  const ctx = { annualRows: rows, price: 30000, shares: 1e9, metrics: { beta: 1, payoutTtm: 0.2 }, peerStats: { pe: { n: 20, q: Q }, pb: { n: 20, q: [0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.4, 3, 4] }, ps: { n: 20, q: Q } }, ratioSeries: { pb: Array.from({ length: 200 }, (_, i) => 1.2 + (i % 20) * 0.05) }, bond10yPct: 4 };
  const r = E.analyze(ctx);
  it('nhận dạng ngân hàng, dùng P/B hợp lý, thu nhập thặng dư, FCFE và bội số ngang hàng P/E-P/B (không P/S, không DCF)', () => {
    expect(r.form).toBe('BANK'); const keys = r.methods.map((m) => m.key);
    ['justified-pb', 'ri', 'peer-pe', 'peer-pb'].forEach((k) => expect(keys).toContain(k)); expect(keys).not.toContain('peer-ps'); expect(keys).not.toContain('dcf');
    expect(r.bank.latest.roe).toBeGreaterThan(0); expect(r.synthesis.ok).toBe(true);
  });
  it('trọng số mặc định ngân hàng ưu tiên P/B và thu nhập thặng dư', () => {
    const w = (k) => r.synthesis.methods.find((m) => m.key === k).weight;
    expect(w('ri')).toBeGreaterThan(w('peer-pe')); expect(w('peer-pb')).toBeGreaterThanOrEqual(w('peer-pe'));
  });
});
