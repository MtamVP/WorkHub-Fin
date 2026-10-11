// Học độ lớn cú sốc theo loại sự kiện từ các lần chạy đã chấm (lib/sim-score.js learnShocks / multFor) và cách bộ máy dùng hệ số (lib/market-sim.js eventFromCard).
import { describe, it, expect } from 'vitest';
import SM from '../../lib/sim-models.js';
import MS from '../../lib/market-sim.js';
import SS from '../../lib/sim-score.js';

const SC = { small: 0.02, medium: 0.05, large: 0.1 };
const card = (o) => Object.assign({ id: 'a', title: 'T', prob: 0.4, window: '1m', direction: 'down', magnitude: 'medium', scope: 'market', sectors: [], category: 'Chính sách' }, o || {});

describe('eventFromCard: hệ số đã học', () => {
  it('nhân vào độ lớn cả thị trường lấy từ thang; giữ độ lớn gốc để học tiếp; trả loại sự kiện', () => {
    const a = MS.eventFromCard(card(), SC), b = MS.eventFromCard(card(), SC, 1.3);
    expect(a.jM).toBeCloseTo(Math.log(1.05), 9); expect(a.k).toBe(1);
    expect(b.jM).toBeCloseTo(Math.log(1 + 0.05 * 1.3), 9); expect(b.k).toBe(1.3);
    expect(b.jM0).toBeCloseTo(Math.log(1.05), 9);
    expect(b.cat).toBe('Chính sách'); expect(b.man).toBe(false);
  });
  it('không nhân vào độ lớn người dùng tự nhập, và không nhân vào sự kiện theo ngành', () => {
    const man = MS.eventFromCard(card({ marketMove: 0.04 }), SC, 1.5);
    expect(man.jM).toBeCloseTo(Math.log(1.04), 9); expect(man.man).toBe(true); expect(man.k).toBe(1);
    const sec = MS.eventFromCard(card({ scope: 'sector', sectors: ['Ngân hàng'] }), SC, 1.5), sec1 = MS.eventFromCard(card({ scope: 'sector', sectors: ['Ngân hàng'] }), SC);
    expect(sec.jM).toBe(sec1.jM); expect(sec.jS).toBe(sec1.jS); expect(sec.k).toBe(1);
  });
  it('hệ số bị chặn trong [0,4; 2]; hệ số vô nghĩa bị bỏ', () => {
    expect(MS.eventFromCard(card(), SC, 9).k).toBe(2); expect(MS.eventFromCard(card(), SC, 0.01).k).toBe(0.4);
    expect(MS.eventFromCard(card(), SC, 'x').k).toBe(1); expect(MS.eventFromCard(card(), SC, -1).k).toBe(1);
  });
  it('bộ máy mang loại sự kiện và độ lớn gốc ra kết quả để lưu', () => {
    const N = 900, R = SM.rng(2), dates = [], idx = [1000];
    for (let t = 0; t < N; t++) dates.push(new Date(Date.UTC(2020, 0, 1) + t * 86400000).toISOString().slice(0, 10));
    for (let t = 1; t < N; t++) idx.push(idx[t - 1] * Math.exp(0.0004 + 0.01 * R.n()));
    const ctx = MS.prepare({ dates, index: idx, stocks: {} }, {}), ev = MS.eventFromCard(card(), MS.eventScale(ctx.rm), 1.2);
    const r = MS.simulate(ctx, { cash: 0, debt: 0, positions: [{ symbol: MS.INDEX, qty: 1, price: 1e8 }] }, [MS.PRESETS[0]], { paths: 300, seed: 1, events: [ev] });
    expect(r.events[0]).toMatchObject({ cat: 'Chính sách', man: false, k: 1.2 });
    expect(r.events[0].jM0).toBeCloseTo(ev.jM0, 12);
    const snap = SS.snapshot(r, null, { asOf: '2026-01-01', indexLevel: 1000, subject: 'outlook', events: [] });
    expect(snap.events[0]).toMatchObject({ cat: 'Chính sách', man: false, k: 1.2 });
  });
});

// ---- học ----
const LEVELS = Array.from({ length: 39 }, (v, i) => Math.round((i + 1) * 25) / 1000);
const HZ = [5, 21, 63];
// lưới phân vị chuẩn có độ lệch chuẩn sd (đủ để windowSd đọc ra sd)
const zOf = (p) => { let lo = -6, hi = 6; for (let k = 0; k < 80; k++) { const m = (lo + hi) / 2, c = 0.5 * (1 + erf(m / Math.SQRT2)); if (c < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function erf(x) { const s = x < 0 ? -1 : 1, t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
const GRID = (sd) => LEVELS.map((q) => zOf(q) * sd);
function snapOf(asOf, events) {
  return { v: 1, asOf: asOf, horizons: HZ, bands: [0.02, 0.04, 0.06], drift: 0.09, levels: LEVELS, grid: { index: [GRID(0.025), GRID(0.05), GRID(0.09)], base: [GRID(0.025), GRID(0.05), GRID(0.09)], hold: [] }, events: events };
}
const ev = (o) => Object.assign({ id: 'e1', title: 'NHNN tăng lãi suất', p: 0.4, win: 21, sign: -1, jM: 0.05, jM0: 0.05, jS: 0, sectors: [], cat: 'Chính sách', man: false, k: 1 }, o || {});
const scoreWith = (hk, ret) => ({ origin: 'x', prefix: '', elapsed: 63, horizons: HZ.map((h, i) => (i === hk ? { h: h, due: true, ret: ret } : { h: h, due: true, ret: 0 })) });
const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 30 * 86400000).toISOString().slice(0, 10);
// n lần chạy ở các ngày khác nhau, mỗi lần có một sự kiện đã xảy ra; lợi suất thật = -beta * jM0 + độ dời + nhiễu
function simulateItems(n, beta, noise, seed, evOver) {
  const R = SM.rng(seed || 1), out = [];
  for (let i = 0; i < n; i++) {
    const e = ev(Object.assign({ id: 'e' + i }, evOver || {})), x = (-beta * e.jM0) + 0.09 * 21 / 252 + noise * R.n();
    out.push({ snap: snapOf(day(i), [e]), score: scoreWith(1, Math.exp(x) - 1), marks: { ['e' + i]: true } });
  }
  return out;
}

describe('learnShocks', () => {
  it('cú sốc thật gấp đôi dự kiến: hệ số học được > 1 và đủ mốc thì dùng', () => {
    const L = SS.learnShocks(simulateItems(30, 2, 0.02, 7));
    expect(L.global.n).toBe(30); expect(L.global.ready).toBe(true);
    expect(L.global.beta).toBeGreaterThan(1.4); expect(L.global.beta).toBeLessThan(2.4);
    expect(L.cats['Chính sách'].ready).toBe(true); expect(L.cats['Chính sách'].mult).toBeGreaterThan(1.3);
    expect(SS.multFor(L, 'Chính sách')).toMatchObject({ source: 'cat' });
    expect(SS.multFor(L, 'Chính sách').mult).toBeGreaterThan(1.3);
  });
  it('cú sốc đúng như dự kiến: hệ số quanh 1; không có cú sốc nào: hệ số bị kéo xuống nhưng không dưới 0,5', () => {
    const ok = SS.learnShocks(simulateItems(40, 1, 0.02, 3));
    expect(Math.abs(ok.cats['Chính sách'].mult - 1)).toBeLessThan(0.25);
    const none = SS.learnShocks(simulateItems(40, 0, 0.02, 4));
    expect(none.cats['Chính sách'].mult).toBeLessThan(0.8); expect(none.cats['Chính sách'].mult).toBeGreaterThanOrEqual(0.5);
  });
  it('ít quan sát: chưa đủ mốc thì hệ số = 1 (không học từ vài lần)', () => {
    const L = SS.learnShocks(simulateItems(4, 3, 0.01, 5));
    expect(L.cats['Chính sách'].n).toBe(4); expect(L.cats['Chính sách'].ready).toBe(false); expect(L.global.ready).toBe(false);
    expect(SS.multFor(L, 'Chính sách')).toEqual({ mult: 1, n: 4, source: 'prior' });
    expect(SS.multFor(null, 'X')).toEqual({ mult: 1, n: 0, source: 'prior' });
  });
  it('mẫu nhỏ thì còn bất định nhiều và hệ số còn gần 1; dữ liệu đòi quá lớn thì bị chặn ở 1,6', () => {
    const small = SS.learnShocks(simulateItems(8, 1, 0.05, 6)).cats['Chính sách'];
    expect(small.ready).toBe(true); expect(small.sd).toBeGreaterThan(0.2); expect(Math.abs(small.mult - 1)).toBeLessThan(0.5);
    const big = SS.learnShocks(simulateItems(9, 3, 0.02, 6)).cats['Chính sách'];
    expect(big.beta).toBeGreaterThan(1.6); expect(big.mult).toBe(1.6);
  });
  it('loại không đủ mốc dùng hệ số chung khi toàn cục đủ', () => {
    const a = simulateItems(20, 2, 0.02, 8), b = simulateItems(3, 2, 0.02, 9, { cat: 'Quốc tế' }).map((it, i) => Object.assign(it, { snap: snapOf(day(100 + i), it.snap.events) }));
    const L = SS.learnShocks(a.concat(b));
    expect(L.cats['Quốc tế'].ready).toBe(false);
    expect(SS.multFor(L, 'Quốc tế')).toMatchObject({ source: 'global' }); expect(SS.multFor(L, 'Quốc tế').mult).toBeGreaterThan(1.2);
    expect(SS.multFor(L, 'Loại chưa từng thấy')).toMatchObject({ source: 'global' });
  });
  it('nhiều lần lưu cùng ngày dữ liệu và cùng kỳ hạn chỉ tính một mốc', () => {
    const base = simulateItems(10, 2, 0.02, 11), dup = base.map((it) => ({ snap: it.snap, score: it.score, marks: it.marks }));
    expect(SS.learnShocks(base.concat(dup)).global.n).toBe(10);
  });
  it('bỏ sự kiện độ lớn nhập tay, sự kiện theo ngành, chưa rõ chiều, chưa đánh dấu hoặc chưa tới kỳ', () => {
    const items = [].concat(
      simulateItems(10, 2, 0.02, 12, { man: true }), simulateItems(10, 2, 0.02, 13, { sectors: ['Ngân hàng'] }).map((it, i) => Object.assign(it, { snap: snapOf(day(200 + i), it.snap.events) })),
      simulateItems(10, 2, 0.02, 14, { sign: 0 }).map((it, i) => Object.assign(it, { snap: snapOf(day(300 + i), it.snap.events) })),
      simulateItems(10, 2, 0.02, 15).map((it, i) => Object.assign(it, { snap: snapOf(day(400 + i), it.snap.events), marks: {} })),
      simulateItems(10, 2, 0.02, 16).map((it, i) => Object.assign(it, { snap: snapOf(day(500 + i), it.snap.events), score: { horizons: HZ.map((h) => ({ h: h, due: false, sessionsLeft: 5 })) } })));
    const L = SS.learnShocks(items);
    expect(L.global.n).toBe(0); expect(L.global.mult).toBeCloseTo(1, 9);
  });
  it('mốc có hai sự kiện cùng đã xảy ra: tính cho hệ số chung nhưng không gán cho loại nào', () => {
    const it = simulateItems(12, 1.5, 0.02, 17).map((x, i) => {
      const e2 = ev({ id: 'z' + i, title: 'Sự kiện khác', cat: 'Quốc tế' });
      return { snap: snapOf(x.snap.asOf, x.snap.events.concat([e2])), score: x.score, marks: Object.assign({}, x.marks, { ['z' + i]: true }) };
    });
    const L = SS.learnShocks(it);
    expect(L.global.n).toBe(12); expect(Object.keys(L.cats)).toEqual([]);
  });
  it('tần suất xảy ra thật so với xác suất đã đặt, theo loại', () => {
    const items = []; for (let i = 0; i < 10; i++) items.push({ snap: snapOf(day(i), [ev({ id: 'e' + i, title: 'Sự kiện ' + i, p: 0.5 })]), score: scoreWith(1, 0), marks: { ['e' + i]: i < 3 } });
    const L = SS.learnShocks(items);
    expect(L.prob.n).toBe(10); expect(L.prob.meanP).toBeCloseTo(0.5, 9); expect(L.prob.freq).toBeCloseTo(0.3, 9);
    expect(L.prob.byCat['Chính sách']).toEqual({ n: 10, meanP: 0.5, freq: 0.3 });
  });
});
