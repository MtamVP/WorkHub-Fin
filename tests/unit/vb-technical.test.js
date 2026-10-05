import { describe, it, expect } from 'vitest';
import T from '../../lib/vb-technical.js';

// Dữ liệu RSI kinh điển (ví dụ 14 kỳ của StockCharts theo Wilder): kiểm tra cài đặt làm mượt Wilder
const CL = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];
const RSI_EXPECTED = { 14: 70.46, 15: 66.25, 16: 66.48, 17: 69.35, 18: 66.29, 19: 57.91, 20: 62.88, 21: 63.21, 22: 56.01, 23: 62.34, 24: 54.67, 25: 50.39, 26: 40.02, 27: 41.49, 28: 41.90, 29: 45.50, 30: 37.32, 31: 33.09, 32: 37.79 };

// chuỗi nến tổng hợp có xu hướng rõ: sóng sin quanh một đường xu hướng, mở/đóng hợp lý
function series(n, drift, amp, seedShift) {
  const t = [], o = [], h = [], l = [], c = [], v = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin((i + (seedShift || 0)) / 6) * amp;
    const close = Math.max(1, 100 + drift * i + wave * 10);
    const open = px; px = close;
    const hi = Math.max(open, close) + 0.6, lo = Math.min(open, close) - 0.6;
    t.push(new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10));
    o.push(open); h.push(hi); l.push(lo); c.push(close); v.push(1000 + (i % 7) * 100 + (close > open ? 300 : 0));
  }
  return { t: t, o: o, h: h, l: l, c: c, v: v };
}

describe('chỉ báo cơ bản', () => {
  it('RSI khớp bảng số của Wilder/StockCharts', () => {
    const r = T.rsi(CL, 14);
    Object.keys(RSI_EXPECTED).forEach((i) => expect(r[i]).toBeCloseTo(RSI_EXPECTED[i], 1));
    expect(r[13]).toBeNull();
  });
  it('SMA, EMA (hạt giống bằng SMA), WMA-ish: giá trị tính tay', () => {
    expect(T.sma([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5]);
    const e = T.ema([1, 2, 3, 4, 5, 6], 3);
    expect(e[2]).toBe(2); expect(e[3]).toBeCloseTo(3, 12); expect(e[5]).toBeCloseTo(5, 12);
    const e2 = T.ema([10, 10, 10, 20], 3); expect(e2[3]).toBeCloseTo(15, 12);          // k = 0,5: 20×0,5 + 10×0,5
  });
  it('xu hướng tăng đều: RSI 100, ADX 100, MFI 100, OBV tăng, MACD dương = độ trễ trung bình', () => {
    const up = Array.from({ length: 80 }, (_, i) => 100 + i), h = up.map((x) => x + 1), l = up.map((x) => x - 1), v = up.map(() => 1000);
    expect(T.rsi(up, 14)[79]).toBe(100); expect(T.adx(h, l, up, 14).adx[79]).toBeCloseTo(100, 6); expect(T.mfi(h, l, up, v, 14)[79]).toBe(100);
    expect(T.obv(up, v)[79]).toBe(79000); expect(T.macd(up).line[79]).toBeCloseTo(7, 6);       // (26−12)/2
    expect(T.atr(h, l, up, 14)[79]).toBeCloseTo(2, 9);
  });
  it('giá phẳng: Bollinger rộng 0, RSI 50, độ lệch chuẩn 0, biến động 0', () => {
    const flat = Array.from({ length: 60 }, () => 100);
    expect(T.bollinger(flat, 20, 2).width[59]).toBe(0); expect(T.rsi(flat, 14)[59]).toBe(50); expect(T.stdev(flat, 20)[59]).toBe(0); expect(T.histVol(flat, 20)[59]).toBe(0);
  });
  it('Stochastic, Williams %R, CCI ở các biên', () => {
    const h = [10, 11, 12, 13, 14], l = [8, 9, 10, 11, 12], c = [9, 10, 11, 12, 14];
    expect(T.stochastic(h, l, c, 5, 1, 1).fastK[4]).toBeCloseTo((14 - 8) / (14 - 8) * 100, 9);
    expect(T.williamsR(h, l, c, 5)[4]).toBeCloseTo(0, 9);
    const cc = T.cci([1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], 3); expect(cc[3]).toBe(0);
  });
  it('Bollinger: dải đối xứng quanh SMA, %B bằng 0,5 tại đường giữa', () => {
    const c = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 3), b = T.bollinger(c, 20, 2);
    const k = 39; expect(b.upper[k] - b.mid[k]).toBeCloseTo(b.mid[k] - b.lower[k], 9);
    expect(T.bollinger([1, 2, 3, 4, 5], 5, 2).pctB[4]).toBeGreaterThan(0.5);
  });
  it('CMF/AD: đóng cửa ở đỉnh cho +1, ở đáy cho −1', () => {
    const h = [10, 10, 10], l = [0, 0, 0], v = [100, 100, 100];
    expect(T.cmf(h, l, [10, 10, 10], v, 3)[2]).toBeCloseTo(1, 9); expect(T.cmf(h, l, [0, 0, 0], v, 3)[2]).toBeCloseTo(-1, 9); expect(T.adLine(h, l, [10, 10, 10], v)[2]).toBe(300);
  });
  it('Parabolic SAR và Supertrend nhận ra xu hướng tăng/giảm', () => {
    const up = Array.from({ length: 60 }, (_, i) => 100 + i), h = up.map((x) => x + 1), l = up.map((x) => x - 1);
    expect(T.psar(h, l).dir[59]).toBe(1); expect(T.supertrend(h, l, up, 10, 3).dir[59]).toBe(1);
    const dn = up.map((x) => 300 - x), h2 = dn.map((x) => x + 1), l2 = dn.map((x) => x - 1);
    expect(T.psar(h2, l2).dir[59]).toBe(-1); expect(T.supertrend(h2, l2, dn, 10, 3).dir[59]).toBe(-1);
  });
  it('Ichimoku: mây là giá trị cách đây 26 phiên', () => {
    const s = series(120, 0.3, 0.5), ich = T.ichimoku(s.h, s.l, s.c);
    expect(ich.cloudA[100]).toBe(ich.spanA[74]); expect(ich.cloudB[100]).toBe(ich.spanB[74]); expect(ich.cloudA[20]).toBeNull();
  });
  it('Aroon: đỉnh mới nhất cho Aroon Up 100', () => {
    const h = Array.from({ length: 30 }, (_, i) => i), l = h.map((x) => x - 1), a = T.aroon(h, l, 25);
    expect(a.up[29]).toBe(100); expect(a.down[29]).toBeLessThan(100);
  });
  it('drawdown và biến động lịch sử', () => {
    expect(T.drawdown([100, 120, 90, 110])).toEqual([0, 0, -0.25, 110 / 120 - 1]);
    const c = Array.from({ length: 40 }, (_, i) => 100 * Math.pow(1.01, i)); expect(T.histVol(c, 20)[39]).toBeCloseTo(0, 6);    // lợi suất không đổi -> độ lệch 0
  });
});

describe('mức giá', () => {
  it('điểm xoay cổ điển và Fibonacci tính tay', () => {
    const p = T.pivotsOf(110, 90, 100);
    expect(p.classic.p).toBe(100); expect(p.classic.r1).toBe(110); expect(p.classic.s1).toBe(90); expect(p.classic.r2).toBe(120); expect(p.classic.s2).toBe(80);
    expect(p.fibonacci.r1).toBeCloseTo(100 + 0.382 * 20, 9); expect(p.fibonacci.s2).toBeCloseTo(100 - 0.618 * 20, 9);
  });
  it('swing: tìm đỉnh đáy cục bộ', () => {
    const h = [1, 2, 3, 2, 1, 2, 5, 2, 1, 2, 3, 2, 1], l = h.map((x) => x - 0.5), s = T.swings(h, l, 2);
    expect(s.highs.map((x) => x.i)).toEqual([2, 6, 10]); expect(s.lows.map((x) => x.i)).toEqual([4, 8]);
  });
  it('cụm mức giá gộp các điểm gần nhau và đếm lần chạm', () => {
    const lv = T.levelsFrom([{ i: 10, price: 100 }, { i: 50, price: 100.5 }, { i: 90, price: 99.8 }, { i: 70, price: 130 }], 1, 100);
    expect(lv).toHaveLength(2); const big = lv.find((x) => x.touches === 3); expect(big.price).toBeCloseTo((100 + 100.5 + 99.8) / 3, 9);
  });
  it('Fibonacci: hướng, mức thoái lui và mở rộng', () => {
    const h = [], l = [], c = [];
    for (let i = 0; i < 60; i++) { const p = 100 + i; h.push(p + 1); l.push(p - 1); c.push(p); }       // đáy ở đầu, đỉnh ở cuối: sóng tăng
    const f = T.fibonacci(h, l, c, 60);
    expect(f.direction).toBe('up'); expect(f.high).toBe(160); expect(f.low).toBe(99);
    expect(f.retracements.find((r) => r.ratio === 0.5).price).toBeCloseTo(160 - 61 * 0.5, 9); expect(f.extensions.find((r) => r.ratio === 1.618).price).toBeCloseTo(99 + 61 * 1.618, 9);
  });
});

describe('mẫu nến', () => {
  const mk = (rows) => ({ o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]) });
  const base = [[110, 111, 109, 110], [109, 110, 108, 109], [108, 109, 107, 108], [107, 108, 106, 107], [106, 107, 105, 106], [105, 106, 104, 105]];
  it('nến búa sau chuỗi giảm', () => {
    const k = mk(base.concat([[104, 104.5, 100, 104.2]]));
    expect(T.candlePatterns(k.o, k.h, k.l, k.c, 2).map((p) => p.key)).toContain('hammer');
  });
  it('nhấn chìm tăng và doji', () => {
    const k = mk(base.concat([[104, 104.2, 102.8, 103], [102.5, 105.5, 102.3, 105.2]]));
    expect(T.candlePatterns(k.o, k.h, k.l, k.c, 2).map((p) => p.key)).toContain('bull-engulf');
    const d = mk(base.concat([[104, 106, 102, 104.05]])); expect(T.candlePatterns(d.o, d.h, d.l, d.c, 2).map((p) => p.key)).toContain('doji');
  });
  it('ba chàng lính trắng', () => {
    const k = mk(base.concat([[104, 106.5, 103.8, 106.2], [105.5, 108.7, 105.3, 108.4], [107.8, 111, 107.5, 110.7]]));
    expect(T.candlePatterns(k.o, k.h, k.l, k.c, 2).map((p) => p.key)).toContain('three-white');
  });
  it('ít hơn 4 nến: rỗng', () => { expect(T.candlePatterns([1], [1], [1], [1], 1)).toEqual([]); });
});

describe('sức mạnh tương đối', () => {
  it('cổ phiếu tăng gấp đôi tốc độ chỉ số: vượt trội dương và đường RS dốc lên', () => {
    const n = 300, dates = [], c = [], ic = [];
    for (let i = 0; i < n; i++) { dates.push(new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10)); ic.push(1000 * Math.pow(1.001, i)); c.push(50 * Math.pow(1.002, i)); }
    const r = T.relativeStrength(dates, c, dates, ic);
    expect(r.excess3m).toBeGreaterThan(0); expect(r.excess6m).toBeGreaterThan(0); expect(r.slope3m).toBeGreaterThan(0); expect(r.percentile).toBeGreaterThan(90);
  });
  it('thiếu dữ liệu chỉ số hoặc quá ngắn: null', () => { expect(T.relativeStrength(['2024-01-01'], [1], null, null)).toBeNull(); });
});

describe('analyze tổng hợp', () => {
  it('xu hướng tăng bền: điểm cao, đánh giá tăng, mọi nhóm có tín hiệu', () => {
    const a = T.analyze(series(300, 0.4, 0.3, 0));
    expect(a.ok).toBe(true); expect(a.score).toBeGreaterThan(30); expect(['up', 'strong-up']).toContain(a.rating.key);
    ['trend', 'momentum', 'flow', 'position'].forEach((g) => expect(a.groups[g].count).toBeGreaterThan(0));
    expect(a.signals.every((s) => s.score >= -1 && s.score <= 1 && typeof s.detail === 'string')).toBe(true);
  });
  it('xu hướng giảm bền: điểm âm, đánh giá giảm', () => {
    const a = T.analyze(series(300, -0.25, 0.3, 0));
    expect(a.score).toBeLessThan(-30); expect(['down', 'strong-down']).toContain(a.rating.key);
  });
  it('mức hỗ trợ thấp hơn giá và kháng cự cao hơn giá; có vùng vô hiệu và Fibonacci', () => {
    const a = T.analyze(series(300, 0.1, 1.2, 3));
    a.levels.supports.forEach((s) => expect(s.price).toBeLessThan(a.price)); a.levels.resistances.forEach((s) => expect(s.price).toBeGreaterThan(a.price));
    expect(a.levels.fibonacci).toBeTruthy(); expect(a.levels.pivots.daily.classic.p).toBeGreaterThan(0);
  });
  it('quá ít nến: báo lý do thay vì kết quả bậy', () => { const a = T.analyze(series(30, 0.1, 0.2)); expect(a.ok).toBe(false); expect(a.reason).toMatch(/ít nhất/); });
  it('chuỗi trả về cho biểu đồ cùng độ dài với nến', () => {
    const s = series(250, 0.2, 0.5), a = T.analyze(s);
    ['sma20', 'sma50', 'sma200', 'bbUpper', 'rsi', 'macd', 'macdHist', 'stochK', 'adx', 'obv', 'atr', 'supertrend', 'cloudA'].forEach((k) => expect(a.series[k]).toHaveLength(250));
  });
  it('timing: xu hướng tăng nhưng quá mua thì chờ điều chỉnh', () => {
    const s = series(260, 0.4, 0.1, 0);
    // kéo 12 phiên cuối bứt tăng mạnh để RSI quá mua và giá giãn xa SMA200
    for (let i = 248; i < 260; i++) { const p = s.c[i - 1] * 1.03; s.o[i] = s.c[i - 1]; s.c[i] = p; s.h[i] = p + 0.5; s.l[i] = s.o[i] - 0.5; }
    const a = T.analyze(s);
    expect(a.overbought).toBe(true); expect(['wait', 'favorable']).toContain(a.timing.key);
  });
});
