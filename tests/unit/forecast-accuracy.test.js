// Độ chính xác dự phóng (lib/forecast-accuracy.js): chấm giá trị hợp lý, ý tưởng, quyết định, dự phóng lợi nhuận với kết quả thực tế; thống kê trung thực với mẫu nhỏ.
import { describe, it, expect } from 'vitest';
import F from '../../lib/forecast-accuracy.js';

const day = (n) => new Date(Date.UTC(2025, 0, 1) + n * 86400000).toISOString().slice(0, 10);
const mk = (n, f) => Array.from({ length: n }, (_, i) => [day(i), f(i)]);
const UP = mk(430, (i) => 100 + 0.1 * i);            // tăng đều, kéo tới 2026-03-06
const DOWN = mk(430, (i) => 100 - 0.2 * i);
const FLAT = mk(430, () => 1000);

describe('tiện ích: tháng, điểm giá, Wilson, Spearman', () => {
  it('cộng tháng giữ cuối tháng hợp lệ', () => {
    expect(F.addMonths('2025-01-31', 1)).toBe('2025-02-28'); expect(F.addMonths('2025-08-31', 6)).toBe('2026-02-28'); expect(F.addMonths('2025-01-01', 12)).toBe('2026-01-01');
  });
  it('điểm giá: phiên đầu tiên từ ngày hỏi trở đi; ngoài chuỗi -> null', () => {
    const s = [['2025-01-02', 10], ['2025-01-06', 12]];
    expect(F.pointOn(s, '2025-01-03')).toMatchObject({ date: '2025-01-06', price: 12 }); expect(F.pointOn(s, '2025-01-07')).toBeNull(); expect(F.pointOn(s, '2024-12-01').date).toBe('2025-01-02');
  });
  it('Wilson 8/10 khoảng 49%-94%, 0/0 không ném, mẫu nhỏ được gắn nhãn', () => {
    const w = F.wilson(8, 10);
    expect(w.p).toBe(0.8); expect(w.lo).toBeCloseTo(0.49, 2); expect(w.hi).toBeCloseTo(0.943, 2); expect(w.small).toBe(false);
    expect(F.wilson(4, 5).small).toBe(true); expect(F.wilson(0, 0).p).toBeNull(); expect(F.wilson(10, 10).hi).toBe(1);
  });
  it('Spearman: đồng biến 1, nghịch biến -1, hạng đồng hạng, quá ít cặp -> null', () => {
    expect(F.spearman([1, 2, 3, 4], [10, 20, 30, 50])).toBeCloseTo(1, 9); expect(F.spearman([1, 2, 3, 4], [9, 7, 5, 1])).toBeCloseTo(-1, 9);
    expect(F.spearman([1, 1, 2, 2], [1, 2, 1, 2])).toBeCloseTo(0, 9); expect(F.spearman([1, 2], [1, 2])).toBeNull(); expect(F.spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

describe('scoreValuation', () => {
  const v = { id: 'v', symbol: 'AAA', asOf: '2025-01-01', price: 100, fairLow: 110, fairBase: 130, fairHigh: 150, methods: [{ key: 'dcf', name: 'DCF', base: 140 }, { key: 'pe', name: 'P/E', base: 120 }] };
  it('kỳ 6 tháng tính tay: lợi suất, vượt trội, sai số so với giá trị hợp lý, trong dải, phần chênh đã thu hẹp', () => {
    const s = F.scoreValuation(v, UP, FLAT, '2026-03-01');
    const h = s.horizons.m6;                     // 2025-07-01 = ngày thứ 181 -> 118,1
    expect(h.ret).toBeCloseTo(0.181, 9); expect(h.benchRet).toBe(0); expect(h.excess).toBeCloseTo(0.181, 9);
    expect(h.priceEq).toBeCloseTo(118.1, 9); expect(h.errFair).toBeCloseTo(118.1 / 130 - 1, 9); expect(h.inRange).toBe(true);
    expect(h.closed).toBeCloseTo(18.1 / 30, 9); expect(h.hit).toBe(true); expect(s.gap).toBeCloseTo(0.3, 9);
  });
  it('chưa đủ kỳ thì null (không đoán): chuỗi dừng trước 12 tháng', () => {
    const s = F.scoreValuation(v, UP.slice(0, 200), FLAT.slice(0, 200), '2026-03-01');
    expect(s.horizons.m3).not.toBeNull(); expect(s.horizons.m6).not.toBeNull(); expect(s.horizons.m12).toBeNull();
    expect(F.scoreValuation(v, UP, FLAT, '2025-05-01').horizons.m6).toBeNull();            // chưa tới ngày
  });
  it('giá điều chỉnh sau thưởng/chia: so sánh theo tỷ lệ, không theo giá thô', () => {
    const adj = UP.map(([d, p]) => [d, p / 2]);        // chuỗi đã điều chỉnh có giá bằng nửa giá thô
    const s = F.scoreValuation(v, adj, FLAT, '2026-03-01');
    expect(s.horizons.m6.priceEq).toBeCloseTo(118.1, 9); expect(s.horizons.m6.ret).toBeCloseTo(0.181, 9);
  });
  it('hướng: gap dương mà giá kém thị trường là sai; gap quá nhỏ bỏ qua', () => {
    expect(F.scoreValuation(v, DOWN, FLAT, '2026-03-01').horizons.m6.hit).toBe(false);
    expect(F.scoreValuation(Object.assign({}, v, { fairBase: 101 }), UP, FLAT, '2026-03-01').horizons.m6.hit).toBeNull();
    expect(F.scoreValuation(Object.assign({}, v, { fairBase: 80 }), DOWN, FLAT, '2026-03-01').horizons.m6.hit).toBe(true);        // gap âm, giá kém thị trường -> đúng
  });
  it('từng phương pháp: lệch giữa giá kỳ vọng và giá trị cơ sở của phương pháp đó (kỳ dài nhất đã đủ)', () => {
    const s = F.scoreValuation(v, UP, FLAT, '2026-03-01');       // m12 = 2026-01-01 -> ngày 365 -> 136,5
    expect(s.methods.map((m) => m.key + ':' + m.horizon)).toEqual(['dcf:m12', 'pe:m12']);
    expect(s.methods[0].errFair).toBeCloseTo(136.5 / 140 - 1, 9); expect(s.methods[1].errFair).toBeCloseTo(136.5 / 120 - 1, 9);
  });
  it('thiếu giá lúc lưu hoặc giá trị hợp lý -> không chấm được', () => {
    expect(F.scoreValuation(Object.assign({}, v, { price: null }), UP, FLAT).scorable).toBe(false); expect(F.scoreValuation(Object.assign({}, v, { fairBase: null }), UP, FLAT).scorable).toBe(false);
    expect(F.scoreValuation(v, [], FLAT).scorable).toBe(false);
  });
});

describe('scoreIdea', () => {
  const idea = { id: 'i', symbol: 'AAA', direction: 'long', status: 'approved', entry: 100, target: 115, stop: 90, horizonMonths: 6, conviction: 4, startDate: '2025-01-01' };
  it('chạm mục tiêu trước: ngày tới mục tiêu, thành công vì vượt trội thị trường', () => {
    const s = F.scoreIdea(idea, UP, FLAT, '2026-03-01');
    expect(s.matured).toBe(true); expect(s.hitTarget).toBe(true); expect(s.hitStop).toBe(false); expect(s.first).toBe('target'); expect(s.daysToTarget).toBe(150);
    expect(s.ret).toBeCloseTo(0.181, 9); expect(s.success).toBe(true); expect(s.expectedRet).toBeCloseTo(0.15, 9);
  });
  it('cắt lỗ trước: thất bại; ý tưởng "tránh" thì giá giảm là thành công', () => {
    const s = F.scoreIdea(idea, DOWN, FLAT, '2026-03-01');
    expect(s.first).toBe('stop'); expect(s.hitTarget).toBe(false); expect(s.hitStop).toBe(true); expect(s.success).toBe(false);
    const a = F.scoreIdea(Object.assign({}, idea, { direction: 'avoid' }), DOWN, FLAT, '2026-03-01');
    expect(a.success).toBe(true); expect(a.hitTarget).toBeNull();
  });
  it('chưa đủ kỳ và chưa đóng -> đang chờ; đã đóng thì chấm theo giá đóng', () => {
    const open = F.scoreIdea(Object.assign({}, idea, { horizonMonths: 12 }), UP.slice(0, 220), FLAT.slice(0, 220), '2025-08-10');
    expect(open.matured).toBe(false); expect(open.pendingUntil).toBe('2026-01-01'); expect(open.scorable).toBe(true);
    const closed = F.scoreIdea(Object.assign({}, idea, { status: 'closed', closedAt: '2025-03-01', closePrice: 108, closeReason: 'time' }), UP, FLAT, '2026-03-01');
    expect(closed.matured).toBe(true); expect(closed.ret).toBeCloseTo(0.08, 9); expect(closed.end).toBe('2025-03-01');
  });
  it('lấy giá đầu từ chuỗi nếu không có giá vào lệnh', () => {
    const s = F.scoreIdea(Object.assign({}, idea, { entry: null, target: null, stop: null }), UP, FLAT, '2026-03-01');
    expect(s.entry).toBe(100); expect(s.hitTarget).toBeNull(); expect(s.hitStop).toBeNull(); expect(s.expectedRet).toBeNull();
  });
});

describe('scoreDecision', () => {
  const d = { id: 'd', symbol: 'AAA', action: 'buy', decidedAt: '2025-01-01', priceAtDecision: 100, expected: 112, horizonMonths: 3, confidence: 4 };
  it('mua đúng khi vượt trội thị trường; chạm giá kỳ vọng chỉ khi có phiên đóng cửa >= kỳ vọng', () => {
    const s = F.scoreDecision(d, UP, FLAT, '2026-03-01');
    expect(s.matured).toBe(true); expect(s.ret).toBeCloseTo(0.09, 9); expect(s.success).toBe(true); expect(s.hitTarget).toBe(false);
    expect(F.scoreDecision(Object.assign({}, d, { expected: 105 }), UP, FLAT, '2026-03-01').hitTarget).toBe(true);
  });
  it('bán hoặc bỏ qua đúng khi giá sau đó kém thị trường; sai khi giá tăng', () => {
    expect(F.scoreDecision(Object.assign({}, d, { action: 'sell' }), UP, FLAT, '2026-03-01').success).toBe(false);
    expect(F.scoreDecision(Object.assign({}, d, { action: 'skip' }), DOWN, FLAT, '2026-03-01').success).toBe(true);
  });
  it('mặc định kỳ 6 tháng; chưa đủ kỳ -> đang chờ', () => {
    const s = F.scoreDecision(Object.assign({}, d, { horizonMonths: null }), UP, FLAT, '2025-05-01');
    expect(s.matured).toBe(false); expect(s.pendingUntil).toBe('2025-07-01');
  });
});

describe('scoreEarnings', () => {
  const fin = { annual: [{ year: 2025, lnst: 400, revenue: 4000 }], quarters: [{ year: 2026, quarter: 2, lnst: 100, revenue: 1000 }, { year: 2026, quarter: 1, lnst: -50, revenue: 900 }] };
  const f = (o) => Object.assign({ id: 'e', symbol: 'AAA', metric: 'lnst', year: 2026, quarter: 2, value: 110 }, o || {});
  it('sai số có dấu và tuyệt đối; trong ±10%', () => {
    const s = F.scoreEarnings(f(), fin);
    expect(s.matured).toBe(true); expect(s.err).toBeCloseTo(0.1, 9); expect(s.ape).toBeCloseTo(0.1, 9); expect(s.within10).toBe(true); expect(s.signRight).toBe(true);
    expect(F.scoreEarnings(f({ value: 80 }), fin).err).toBeCloseTo(-0.2, 9);
  });
  it('dự phóng cả năm; doanh thu; kỳ chưa có số thực tế -> đang chờ', () => {
    expect(F.scoreEarnings(f({ quarter: null, year: 2025, value: 360 }), fin).err).toBeCloseTo(-0.1, 9);
    expect(F.scoreEarnings(f({ metric: 'revenue', value: 1200 }), fin).err).toBeCloseTo(0.2, 9);
    expect(F.scoreEarnings(f({ quarter: 3 }), fin).matured).toBe(false); expect(F.scoreEarnings(f(), null).matured).toBe(false);
  });
  it('thực tế âm: sai số theo |thực tế|, đúng dấu hay không', () => {
    const s = F.scoreEarnings(f({ quarter: 1, value: -40 }), fin);
    expect(s.err).toBeCloseTo(0.2, 9); expect(s.signRight).toBe(true);
    expect(F.scoreEarnings(f({ quarter: 1, value: 20 }), fin).signRight).toBe(false);
  });
});

describe('tổng hợp', () => {
  const val = (gap, excess, err, hit, inRange, key) => ({ scorable: true, gap: gap, horizons: { m6: { excess: excess, errFair: err, hit: hit, inRange: inRange, closed: 0.5 } }, methods: key ? [{ key: key, name: key, errFair: err, horizon: 'm6' }] : [] });
  it('giá trị hợp lý: tỷ lệ hướng đúng, sai số trung vị, thiên lệch lạc quan, tương quan hạng', () => {
    const rows = [val(0.3, 0.2, -0.2, true, true, 'dcf'), val(0.2, 0.1, -0.15, true, false, 'dcf'), val(0.1, -0.05, -0.1, false, true, 'pe'), val(-0.1, -0.1, 0.0, true, true, 'pe')];
    const s = F.summarizeValuations(rows, 'm6');
    expect(s.n).toBe(4); expect(s.direction.k).toBe(3); expect(s.direction.n).toBe(4); expect(s.errMedian).toBeCloseTo(-0.125, 9); expect(s.bias).toBe('optimistic'); expect(s.small).toBe(true);
    expect(s.rho).toBeCloseTo(1, 9); expect(s.inRange.k).toBe(3);
    const m = F.summarizeMethods(rows);
    expect(m.map((x) => x.key)).toEqual(['pe', 'dcf']);            // pe lệch ít hơn
    expect(m.find((x) => x.key === 'dcf').errMedian).toBeCloseTo(-0.175, 9);
  });
  it('kết quả ý tưởng/quyết định: thành công, vượt trội trung vị, chạm mục tiêu, và nhãn mẫu nhỏ', () => {
    const mk2 = (success, excess, hitT) => ({ scorable: true, matured: true, success: success, excess: excess, ret: excess, hitTarget: hitT, hitStop: !hitT });
    const s = F.summarizeOutcomes([mk2(true, 0.2, true), mk2(true, 0.1, true), mk2(false, -0.1, false), { scorable: true, matured: false }]);
    expect(s.n).toBe(3); expect(s.pending).toBe(1); expect(s.success.k).toBe(2); expect(s.excessMedian).toBeCloseTo(0.1, 9); expect(s.hitTarget.k).toBe(2); expect(s.hitStop.k).toBe(1); expect(s.small).toBe(true);
  });
  it('hiệu chỉnh theo mức tự tin: thành công theo từng mức, sắp theo mức', () => {
    const r = (c, ok) => ({ matured: true, confidence: c, success: ok });
    const cal = F.calibration([r(5, false), r(5, false), r(3, true), r(3, false), r(1, true)], 'confidence');
    expect(cal.map((x) => x.level)).toEqual([1, 3, 5]); expect(cal.map((x) => x.p)).toEqual([1, 0.5, 0]); expect(cal[2].n).toBe(2);
  });
  it('tổng hợp dự phóng lợi nhuận: sai số trung vị, thiên lệch, trong ±10%', () => {
    const e = (err) => ({ matured: true, err: err, ape: Math.abs(err), within10: Math.abs(err) <= 0.1 });
    const s = F.summarizeEarnings([e(0.2), e(0.1), e(0.3), { matured: false }]);
    expect(s.n).toBe(3); expect(s.pending).toBe(1); expect(s.errMedian).toBeCloseTo(0.2, 9); expect(s.bias).toBe('optimistic'); expect(s.within10.k).toBe(1);
  });
  it('đầu vào rỗng không ném', () => {
    expect(F.summarizeValuations([], 'm6').n).toBe(0); expect(F.summarizeOutcomes(null).n).toBe(0); expect(F.summarizeMethods(undefined)).toEqual([]); expect(F.calibration(null, 'confidence')).toEqual([]);
  });
});
