// lib/perf-calc.js: hiệu quả so với chuẩn (Modified Dietz/TWR, alpha, beta, tracking error, IR, Sharpe, Sortino, capture, tháng thắng chuẩn).
import { describe, it, expect } from 'vitest';
import PerfCalc from '../../lib/perf-calc.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); }
function tradingDates(n, end = '2026-10-02') {
  const out = [];
  let d = new Date(end + 'T00:00:00Z');
  while (out.length < n) { if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10)); d = new Date(d.getTime() - 86400000); }
  return out;
}
const DATES = tradingDates(300);
const r0 = rng(21);
const BENCH_RET = DATES.map(() => 0.0004 + 0.01 * gauss(r0));
const bench = (() => { let p = 1000; return DATES.map((d, i) => { if (i) p *= 1 + BENCH_RET[i]; return [d, p]; }); })();
// NAV từ lợi suất ngày; flows: { index: số tiền nạp }
function navFrom(retFn, flows = {}) {
  let nav = 100e6, net = 100e6;
  return DATES.map((d, i) => {
    if (i) { nav *= 1 + retFn(i); }
    if (flows[i]) { nav += flows[i]; net += flows[i]; }
    return { snapshot_date: d, nav, net_contributed: net };
  });
}

describe('buildPeriods: Modified Dietz', () => {
  const h = (d, nav, net) => ({ snapshot_date: d, nav, net_contributed: net });
  it('không có dòng tiền: lợi suất = NAV cuối / NAV đầu − 1', () => {
    const { periods } = PerfCalc.buildPeriods([h('2026-01-01', 100, 100), h('2026-01-02', 110, 100)], null);
    expect(periods[0].r).toBeCloseTo(0.1, 12);
  });
  it('có nạp vốn: loại phần nạp, tính trên vốn bình quân gia quyền', () => {
    // 100 -> 165 trong đó 50 là vốn nạp thêm: (165 − 100 − 50) / (100 + 25) = 0,12
    const { periods } = PerfCalc.buildPeriods([h('2026-01-01', 100, 100), h('2026-01-02', 165, 150)], null);
    expect(periods[0].r).toBeCloseTo(0.12, 12);
    expect(periods[0].flow).toBe(50);
  });
  it('rút vốn cũng được xử lý (F âm)', () => {
    const { periods } = PerfCalc.buildPeriods([h('2026-01-01', 100, 100), h('2026-01-02', 62, 50)], null);
    // (62 − 100 + 50) / (100 − 25) = 0,16
    expect(periods[0].r).toBeCloseTo(0.16, 12);
  });
  it('bỏ bản ghi NAV ≤ 0; sắp xếp theo ngày; chuẩn lấy giá tại hoặc ngay trước ngày chụp', () => {
    const navs = [h('2026-01-05', 120, 100), h('2026-01-01', 100, 100), h('2026-01-03', 0, 100)];
    const bch = [['2026-01-01', 1000], ['2026-01-04', 1100], ['2026-01-05', 1210]];
    const { periods } = PerfCalc.buildPeriods(navs, bch);
    expect(periods).toHaveLength(1);
    expect(periods[0].from).toBe('2026-01-01'); expect(periods[0].to).toBe('2026-01-05');
    expect(periods[0].rb).toBeCloseTo(0.21, 12);
  });
  it('khoảng thời gian: lấy điểm xuất phát tại hoặc trước mốc from', () => {
    const navs = DATES.slice(-30).map((d, i) => h(d, 100 + i, 100));
    const { periods, firstDate } = PerfCalc.buildPeriods(navs, null, { from: DATES[DATES.length - 11], to: DATES[DATES.length - 1] });
    expect(firstDate).toBe(DATES[DATES.length - 11]);
    expect(periods).toHaveLength(10);
  });
  it('rangeFor: các mốc nhanh', () => {
    expect(PerfCalc.rangeFor('ytd', '2026-10-02')).toEqual({ from: '2025-12-31', to: '2026-10-02' });
    expect(PerfCalc.rangeFor('1y', '2026-10-02').from).toBe('2025-10-02');
    expect(PerfCalc.rangeFor('all', '2026-10-02').from).toBeNull();
  });
});

describe('analyze: danh mục trùng chuẩn', () => {
  const nav = navFrom(i => BENCH_RET[i]);
  const a = PerfCalc.analyze({ navHistory: nav, bench, rf: 0.045 });
  it('beta 1, alpha 0, tracking error 0, up/down capture 100, tương quan 1', () => {
    expect(a.ok).toBe(true);
    expect(a.beta).toBeCloseTo(1, 6);
    expect(a.alphaPct).toBeCloseTo(0, 4);
    expect(a.trackingErrorPct).toBeCloseTo(0, 6);
    expect(a.informationRatio).toBeNull();            // tracking error 0 -> không xác định
    expect(a.upCapturePct).toBeCloseTo(100, 4);
    expect(a.downCapturePct).toBeCloseTo(100, 4);
    expect(a.correlation).toBeCloseTo(1, 6);
    expect(a.cumulativePct).toBeCloseTo(a.benchCumulativePct, 6);
    expect(a.excessCumulativePct).toBeCloseTo(0, 6);
    expect(a.winRateMonthsPct).toBe(0);                // không tháng nào VƯỢT chuẩn (bằng nhau)
  });
  it('quy năm: số kỳ/năm ≈ 252 với dữ liệu mọi phiên; biến động bằng chuẩn', () => {
    expect(a.periodsPerYear).toBeGreaterThan(230);
    expect(a.periodsPerYear).toBeLessThan(270);
    expect(a.volatilityPct).toBeCloseTo(a.benchVolatilityPct, 6);
  });
});

describe('analyze: beta, alpha, capture', () => {
  it('danh mục = 0,5 × chuẩn: beta 0,5; down capture 50; Sharpe/Sortino hữu hạn', () => {
    const a = PerfCalc.analyze({ navHistory: navFrom(i => 0.5 * BENCH_RET[i]), bench });
    expect(a.beta).toBeCloseTo(0.5, 6);
    // capture tính trên lợi suất THÁNG (lãi kép trong tháng nên không đúng tuyệt đối 50)
    expect(Math.abs(a.downCapturePct - 50)).toBeLessThan(1);
    expect(Math.abs(a.upCapturePct - 50)).toBeLessThan(1);
    expect(isFinite(a.sharpe)).toBe(true);
    expect(isFinite(a.sortino)).toBe(true);
    expect(a.volatilityPct).toBeCloseTo(a.benchVolatilityPct * 0.5, 6);
  });
  it('thêm lợi suất vượt cố định mỗi ngày -> alpha dương, IR dương, tháng thắng chuẩn nhiều', () => {
    const jitter = (() => { const r = rng(77); return DATES.map(() => 0.002 * gauss(r)); })();
    const a = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i] + 0.0006 + jitter[i]), bench, rf: 0 });
    expect(a.beta).toBeGreaterThan(0.9); expect(a.beta).toBeLessThan(1.1);
    expect(a.alphaPct).toBeGreaterThan(5);             // 0,06%/ngày ≈ 15%/năm
    expect(a.informationRatio).toBeGreaterThan(0.5);
    expect(a.winRateMonthsPct).toBeGreaterThan(60);
    expect(a.excessCumulativePct).toBeGreaterThan(0);
    // lợi suất vượt HẰNG SỐ (không nhiễu) -> tracking error ≈ 0 nên IR không xác định, không bịa số khổng lồ
    const flat = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i] + 0.0005), bench, rf: 0 });
    expect(flat.informationRatio).toBeNull();
  });
  it('đòn bẩy 2 lần: beta 2, up capture 200, down capture 200', () => {
    const a = PerfCalc.analyze({ navHistory: navFrom(i => 2 * BENCH_RET[i]), bench });
    expect(a.beta).toBeCloseTo(2, 6);
    expect(Math.abs(a.upCapturePct - 200)).toBeLessThan(5);
    expect(Math.abs(a.downCapturePct - 200)).toBeLessThan(5);
  });
  it('lãi phi rủi ro cao hơn làm Sharpe và alpha giảm', () => {
    const nav = navFrom(i => 0.7 * BENCH_RET[i] + 0.0002);
    const lo = PerfCalc.analyze({ navHistory: nav, bench, rf: 0 });
    const hi = PerfCalc.analyze({ navHistory: nav, bench, rf: 0.08 });
    expect(hi.sharpe).toBeLessThan(lo.sharpe);
    expect(hi.sortino).toBeLessThan(lo.sortino);
  });
  it('nạp/rút vốn không làm sai lợi suất: cùng kết quả như không có dòng tiền', () => {
    const plain = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i]), bench });
    const withFlows = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i], { 100: 50e6, 200: -30e6 }), bench });
    expect(withFlows.cumulativePct).toBeCloseTo(plain.cumulativePct, 0);
    expect(withFlows.beta).toBeCloseTo(1, 1);
  });
  it('sụt giảm tối đa có đỉnh/đáy; hiện tại không vượt quá', () => {
    const a = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i]), bench });
    expect(a.maxDD).toBeLessThan(0);
    expect(a.maxDDPeak < a.maxDDTrough).toBe(true);
    expect(a.currentDD).toBeGreaterThanOrEqual(a.maxDD);
    expect(Math.min(...a.ddSeries.map(x => x.dd))).toBeCloseTo(a.maxDD, 6);
  });
  it('quy năm CAGR chỉ khi chuỗi ≥ 1 năm', () => {
    const long = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i]), bench });
    expect(long.annualizedPct).not.toBeNull();
    const short = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i]), bench, range: PerfCalc.rangeFor('3m', '2026-10-02') });
    expect(short.annualizedPct).toBeNull();
  });
});

describe('analyze: thiếu dữ liệu và chuẩn', () => {
  it('quá ít điểm -> reason few-points', () => {
    const a = PerfCalc.analyze({ navHistory: [{ snapshot_date: '2026-01-01', nav: 1, net_contributed: 1 }], bench });
    expect(a.ok).toBe(false); expect(a.reason).toBe('few-points');
  });
  it('chuỗi ngắn (< 20 kỳ): trả số mô tả nhưng không tính alpha/Sharpe và nói rõ', () => {
    const a = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i]).slice(-12), bench });
    expect(a.ok).toBe(true); expect(a.reason).toBe('short');
    expect(a.alphaPct).toBeUndefined(); expect(a.sharpe).toBeUndefined();
    expect(a.cumulativePct).toBeDefined();
    expect(PerfCalc.narrative(a)[0].text).toMatch(/chưa đủ/);
  });
  it('không có chuẩn: vẫn có Sharpe/biến động nhưng không có alpha/beta', () => {
    const a = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i]), bench: null });
    expect(a.hasBench).toBe(false);
    expect(a.sharpe).not.toBeNull();
    expect(a.beta).toBeUndefined();
  });
});

describe('monthly và narrative', () => {
  it('nối các kỳ trong tháng; tính vượt chuẩn từng tháng', () => {
    const a = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i] + 0.001), bench });
    const m = a.monthly;
    expect(m.length).toBeGreaterThan(10);
    m.forEach(x => expect(x.excess).toBeCloseTo(x.r - x.rb, 9));
    expect(new Set(m.map(x => x.month)).size).toBe(m.length);
  });
  it('nhận xét: có dòng về chuẩn, alpha, IR, capture, tháng thắng, Sharpe; alpha chưa đủ bằng chứng thì nói rõ', () => {
    const a = PerfCalc.analyze({ navHistory: navFrom(i => BENCH_RET[i] + 0.0001 * gauss(rng(i + 1))), bench });
    const text = PerfCalc.narrative(a).map(x => x.text).join(' | ');
    expect(text).toMatch(/Alpha/);
    expect(text).toMatch(/Information ratio|Sharpe/);
    expect(text).toMatch(/tháng/);
    expect(PerfCalc.narrative(null)).toEqual([]);
  });
});

describe('đường tích luỹ để vẽ', () => {
  it('gốc 100 tại ngày đầu; điểm cuối khớp lợi suất tích luỹ danh mục và chuẩn', () => {
    const a = PerfCalc.analyze({ navHistory: navFrom(i => 0.8 * BENCH_RET[i]), bench });
    expect(a.curve[0].p).toBe(100); expect(a.curve[0].b).toBe(100);
    const last = a.curve[a.curve.length - 1];
    expect(last.p - 100).toBeCloseTo(a.cumulativePct, 6);
    expect(last.b - 100).toBeCloseTo(a.benchCumulativePct, 6);
    expect(a.curve).toHaveLength(a.periods + 1);
  });
});
