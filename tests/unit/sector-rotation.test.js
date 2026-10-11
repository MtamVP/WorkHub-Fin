// Luân chuyển ngành (lib/sector-rotation.js): căn chuỗi, RS-Ratio/RS-Mom, bốn góc, hiệu suất tương đối, thứ hạng, tóm tắt.
import { describe, it, expect } from 'vitest';
import SR from '../../lib/sector-rotation.js';

// N phiên liên tiếp (bỏ thứ bảy, chủ nhật) kết thúc 2026-10-09
function dates(n) {
  const out = []; let t = Date.parse('2026-10-09T00:00:00Z');
  while (out.length < n) { const d = new Date(t); const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); t -= 86400000; }
  return out.reverse();
}
const mk = (ds, f) => ds.map((d, i) => [d, f(i)]);
const N = 260, DS = dates(N);
const BENCH = mk(DS, (i) => 1000 * Math.exp(0.0004 * i));
// RS mong muốn -> chuỗi ngành = chuẩn x RS(i)
const sector = (rsf) => mk(DS, (i) => BENCH[i][1] * rsf(i));

describe('align / sma', () => {
  it('chỉ giữ ngày chung, bỏ trùng và giá không dương', () => {
    const a = [['2026-10-02', 1], ['2026-10-05', 2], ['2026-10-05', 9], ['2026-10-06', 0], ['2026-10-07', 4]];
    const b = [['2026-10-05', 10], ['2026-10-06', 10], ['2026-10-07', 20], ['2026-10-08', 30]];
    expect(SR.align(a, b)).toEqual({ dates: ['2026-10-05', '2026-10-07'], a: [2, 4], b: [10, 20] });
  });
  it('trung bình trượt: đầu chuỗi thiếu cửa sổ là null', () => {
    expect(SR.sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });
});

describe('bốn góc của vòng luân chuyển', () => {
  const quad = (rsf) => SR.analyze({ BENCH: BENCH, X: sector(rsf) }, 'BENCH', { X: 'Ngành X' }).sectors[0];
  it('bằng chuẩn -> RS-Ratio và RS-Mom đều bằng 100', () => {
    const x = quad(() => 1);
    expect(x.ratio).toBeCloseTo(100, 9); expect(x.mom).toBeCloseTo(100, 9);
  });
  it('sức mạnh tương đối tăng đều -> Dẫn đầu', () => {
    const x = quad((i) => Math.exp(0.002 * i));
    expect(x.ratio).toBeGreaterThan(100); expect(x.mom).toBeGreaterThan(100); expect(x.quadrant.key).toBe('leading');
  });
  it('tăng rồi đi ngang -> Suy yếu (còn trên 100 nhưng đà giảm)', () => {
    const x = quad((i) => (i < 225 ? Math.exp(0.003 * i) : Math.exp(0.003 * 225)));        // đi ngang sau khi đã tăng: ratio còn trên 100 nhưng đang co về 100
    expect(x.ratio).toBeGreaterThan(100); expect(x.mom).toBeLessThan(100); expect(x.quadrant.key).toBe('weakening');
  });
  it('yếu dần đều -> Tụt hậu', () => {
    const x = quad((i) => Math.exp(-0.002 * i));
    expect(x.ratio).toBeLessThan(100); expect(x.mom).toBeLessThan(100); expect(x.quadrant.key).toBe('lagging');
  });
  it('yếu lâu rồi ngừng yếu -> Cải thiện (dưới 100 nhưng đà tăng)', () => {
    const x = quad((i) => (i < 220 ? Math.exp(-0.004 * i) : Math.exp(-0.004 * 220)));        // ngừng yếu đi sau giai đoạn dài tụt: ratio còn dưới 100 nhưng đang nhích lên
    expect(x.ratio).toBeLessThan(100); expect(x.mom).toBeGreaterThan(100); expect(x.quadrant.key).toBe('improving');
  });
  it('quadrantOf đúng ở biên 100', () => {
    expect(SR.quadrantOf(100, 100).key).toBe('leading'); expect(SR.quadrantOf(100, 99.9).key).toBe('weakening');
    expect(SR.quadrantOf(99.9, 99.9).key).toBe('lagging'); expect(SR.quadrantOf(99.9, 100).key).toBe('improving');
  });
});

describe('analyze', () => {
  const series = { BENCH: BENCH, A: sector((i) => Math.exp(0.002 * i)), B: sector((i) => Math.exp(-0.002 * i)), SHORT: mk(DS.slice(-30), (i) => 100 + i) };
  const an = SR.analyze(series, 'BENCH', { A: 'Ngành A', B: 'Ngành B' });
  it('xếp theo RS-Ratio giảm dần, đánh số hạng, bỏ chuỗi quá ngắn nhưng nói rõ', () => {
    expect(an.sectors.map((s) => s.code)).toEqual(['A', 'B']); expect(an.sectors.map((s) => s.rank)).toEqual([1, 2]);
    expect(an.skipped).toEqual(['SHORT']); expect(an.asOf).toBe('2026-10-09'); expect(an.sectors[0].name).toBe('Ngành A');
  });
  it('lợi suất và chênh lệch so với chuẩn đúng theo công thức', () => {
    const a = an.sectors[0];
    const px = series.A.map((r) => r[1]), bx = BENCH.map((r) => r[1]);
    const exp = (px[N - 1] / px[N - 1 - 64] - 1) * 100 - (bx[N - 1] / bx[N - 1 - 64] - 1) * 100;
    expect(a.rel.m3).toBeCloseTo(exp, 9);
    expect(a.ret.m1).toBeCloseTo((px[N - 1] / px[N - 1 - 22] - 1) * 100, 9);
  });
  it('vệt di chuyển cách nhau theo bước, mới nhất ở cuối', () => {
    const t = an.sectors[0].trail;
    expect(t).toHaveLength(6); expect(t[5].date).toBe('2026-10-09'); expect(t[4].date).toBe(DS[N - 1 - 5]);
  });
  it('đổi hạng sau 1 tháng: ngành vừa vượt lên có rankChange dương', () => {
    // C yếu rồi bật mạnh trong 22 phiên cuối; D mạnh đều
    const s2 = { BENCH: BENCH, C: sector((i) => (i < N - 22 ? Math.exp(-0.003 * i) : Math.exp(-0.003 * (N - 22)) * Math.exp(0.02 * (i - (N - 22))))), D: sector((i) => Math.exp(0.0005 * i)), E: sector((i) => Math.exp(0.001 * i)) };
    const r = SR.analyze(s2, 'BENCH', {});
    const c = r.sectors.find((x) => x.code === 'C');
    expect(c.rank1m).toBe(3); expect(c.rank).toBeLessThan(3); expect(c.rankChange).toBeGreaterThan(0);
  });
  it('thiếu chuẩn hoặc rỗng -> không ném', () => {
    expect(SR.analyze({}, 'BENCH', {}).sectors).toEqual([]);
    expect(SR.analyze({ A: series.A }, 'BENCH', {}).sectors).toEqual([]);
  });
  it('tóm tắt bằng lời nêu đúng nhóm', () => {
    const l = SR.narrate(an);
    expect(l[0]).toBe('Dẫn đầu: Ngành A.'); expect(l.some((x) => x.startsWith('Tụt hậu: Ngành B'))).toBe(true);
  });
});

describe('leaders (cổ phiếu mạnh trong ảnh chụp)', () => {
  const rows = [
    { symbol: 'A', m: { jdkRs: 90, jdkMom: 80, advValue20: 2e10, chg1m: 0.05 } },
    { symbol: 'B', m: { jdkRs: 95, jdkMom: 97, advValue20: 1e8 } },          // kém thanh khoản: loại
    { symbol: 'C', m: { jdkRs: 70, jdkMom: 99, advValue20: 3e10 } },
    { symbol: 'D', m: { jdkRs: null, jdkMom: 50, advValue20: 3e10 } },        // thiếu số liệu: loại
  ];
  it('xếp theo điểm trung bình RS và đà, chỉ mã đủ thanh khoản và đủ số liệu', () => {
    const r = SR.leaders(rows, 5);
    expect(r.map((x) => x.symbol)).toEqual(['A', 'C']); expect(r[0].score).toBe(85);
    expect(SR.leaders(rows, 1)).toHaveLength(1); expect(SR.leaders(rows, 5, 0).map((x) => x.symbol)).toEqual(['B', 'A', 'C']);
  });
});
