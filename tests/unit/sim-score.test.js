// lib/sim-score.js: ảnh chụp lần mô phỏng, chấm điểm với thực tế (chỉ dữ liệu sau ngày chạy), gộp nhiều lần chạy, cây sống, kiểm tra trước khi ghi.
import { describe, it, expect } from 'vitest';
import SM from '../../lib/sim-models.js';
import MS from '../../lib/market-sim.js';
import SS from '../../lib/sim-score.js';

function synth(seed, n) {
  const R = SM.rng(seed), dates = [], idx = [1000], st = [];
  let s = 0;
  for (let t = 0; t < n; t++) dates.push(new Date(Date.UTC(2019, 0, 1) + t * 86400000).toISOString().slice(0, 10));
  for (let t = 1; t < n; t++) { if (R.u() > (s ? 0.94 : 0.98)) s = 1 - s; st.push(s); idx.push(idx[t - 1] * Math.exp((s ? -0.0015 : 0.0008) + (s ? 0.022 : 0.008) * R.n())); }
  const c = [50000]; for (let t = 1; t < n; t++) c.push(c[t - 1] * Math.exp(1.2 * Math.log(idx[t] / idx[t - 1]) + 0.01 * R.n()));
  return { dates, index: idx, stocks: { AAA: { closes: c, exchange: 'HOSE', adv: 20e9 } } };
}
const FULL = synth(11, 1500), CUT = 1400;
const PAST = { dates: FULL.dates.slice(0, CUT), index: FULL.index.slice(0, CUT), stocks: { AAA: { closes: FULL.stocks.AAA.closes.slice(0, CUT), exchange: 'HOSE', adv: 20e9 } } };
const CTX = MS.prepare(PAST, {});
const L0 = PAST.index[CUT - 1], P0 = PAST.stocks.AAA.closes[CUT - 1];
const BOOK = { cash: 50e6, debt: 0, positions: [{ symbol: 'AAA', qty: 2000, price: P0 }] };
const SC = MS.eventScale(CTX.rm);
const EV = MS.eventFromCard({ id: 'e1', prob: 0.5, window: '1m', direction: 'down', marketMove: 0.06 }, SC);
const RES = MS.simulate(CTX, BOOK, [MS.PRESETS[0], MS.PRESETS[3]], { paths: 2000, seed: 3, events: [EV] });
const BASE = MS.simulate(CTX, { cash: 0, debt: 0, positions: [{ symbol: MS.INDEX, qty: 1, price: L0 }] }, [MS.PRESETS[0]], { paths: 2000, seed: 3 });
const META = { asOf: PAST.dates[CUT - 1], indexLevel: L0, subject: 'custom', chosen: 'trail12', cash: 50e6, debt: 0, events: [{ id: 'e1', source: 'ai', signposts: ['Lãi suất liên ngân hàng vượt 6%'] }] };
const SNAP = SS.snapshot(RES, BASE, META);

describe('snapshot', () => {
  it('giữ lưới, xác suất nhánh, cây, cây sự kiện, cách đã chọn; gọn (< 60 KB)', () => {
    expect(SNAP).toMatchObject({ v: 1, asOf: META.asOf, subject: 'custom', chosen: 'trail12', horizons: [5, 21, 63] });
    expect(SNAP.grid.index).toHaveLength(3); expect(SNAP.grid.base).toHaveLength(3); expect(SNAP.grid.hold[0]).toHaveLength(39);
    expect(SNAP.branchProbBase).toHaveLength(3);
    expect(SNAP.tree.length).toBe(RES.tree.length);
    expect(SNAP.eventTrees[0].nodes.find((n) => n.id === 'Y').p).toBeCloseTo(RES.eventTrees[0].nodes.find((n) => n.id === 'Y').prob, 3);
    expect(SNAP.events[0]).toMatchObject({ id: 'e1', source: 'ai', signposts: ['Lãi suất liên ngân hàng vượt 6%'] });
    expect(SNAP.outcome[2].median).toBeCloseTo(RES.byHorizon[2].policies[1].median, 3);
    expect(SNAP.positions).toEqual([{ symbol: 'AAA', qty: 2000, price: P0 }]);
    expect(JSON.stringify(SNAP).length).toBeLessThan(60000);
  });
  it('cách chọn không có trong danh sách thì về chính sách gốc; không có base khác mốc thì bỏ', () => {
    const s = SS.snapshot(RES, Object.assign({}, BASE, { horizons: [5, 21] }), Object.assign({}, META, { chosen: 'zzz' }));
    expect(s.chosen).toBe('hold'); expect(s.grid.base).toBeNull(); expect(s.branchProbBase).toBeNull();
  });
});

describe('pitOf / crpsOf', () => {
  const lv = [0.25, 0.5, 0.75], g = [-0.1, 0, 0.1];
  it('nội suy PIT giữa các phân vị, ngoài lưới thì nửa phần đuôi', () => {
    expect(SS.pitOf(lv, g, 0)).toBeCloseTo(0.5, 12);
    expect(SS.pitOf(lv, g, 0.05)).toBeCloseTo(0.625, 12);
    expect(SS.pitOf(lv, g, -1)).toBeCloseTo(0.125, 12);
    expect(SS.pitOf(lv, g, 1)).toBeCloseTo(0.875, 12);
  });
  it('CRPS xấp xỉ = 2 x trung bình tổn thất phân vị; nhỏ nhất quanh trung vị', () => {
    // y = 0: mức 25% (q = -0,1): 0,25 x 0,1; mức 50%: 0; mức 75% (q = 0,1): (0,75 - 1) x (-0,1) -> 2 x 0,05 / 3
    expect(SS.crpsOf(lv, g, 0)).toBeCloseTo(2 * (0.25 * 0.1 + 0 + 0.25 * 0.1) / 3, 12);
    expect(SS.crpsOf(lv, g, 0)).toBeLessThan(SS.crpsOf(lv, g, 0.2));
  });
});

describe('scoreRun: chỉ dùng dữ liệu SAU ngày chạy', () => {
  const sc = SS.scoreRun(SNAP, FULL);
  it('đủ 100 phiên sau -> cả 3 mốc đã tới; lợi suất và nhánh đúng theo chuỗi thật', () => {
    expect(sc.origin).toBe(META.asOf);
    sc.horizons.forEach((h, k) => {
      expect(h.due).toBe(true);
      const H = SNAP.horizons[k], prev = k ? SNAP.horizons[k - 1] : 0;
      expect(h.ret).toBeCloseTo(FULL.index[CUT - 1 + H] / L0 - 1, 6);
      expect(h.date).toBe(FULL.dates[CUT - 1 + H]);
      expect(h.branch).toBe(SS.branchOf(Math.log(FULL.index[CUT - 1 + H] / FULL.index[CUT - 1 + prev]), SNAP.bands[k]));
      expect(h.pit).toBeGreaterThan(0); expect(h.pit).toBeLessThan(1);
      expect(h.in90 || !h.in50).toBe(true);                                  // trong 50% thì chắc chắn trong 90%
      expect(h.base).toBeTruthy(); expect(h.brierClim).toBeGreaterThanOrEqual(0); expect(h.brier).toBeLessThanOrEqual(2);
    });
    expect(sc.prefix).toBe(sc.horizons.map((h) => h.branch).join(''));
  });
  it('danh mục giữ nguyên: lợi suất thật = (tiền + KL x giá x tỷ lệ giá điều chỉnh) / NAV - 1', () => {
    const k = 2, iT = CUT - 1 + 63, r = FULL.stocks.AAA.closes[iT] / P0;
    const want = (50e6 + 2000 * P0 * r) / (50e6 + 2000 * P0) - 1;
    expect(sc.horizons[k].hold.ret).toBeCloseTo(want, 6);
  });
  it('chưa đủ phiên: mốc chưa tới có số phiên còn lại, tiền tố dừng ở mốc đã qua', () => {
    const part = { dates: FULL.dates.slice(0, CUT + 10), index: FULL.index.slice(0, CUT + 10), stocks: {} };
    const s2 = SS.scoreRun(SNAP, part);
    expect(s2.horizons.map((h) => h.due)).toEqual([true, false, false]);
    expect(s2.horizons[1].sessionsLeft).toBe(21 - 10);
    expect(s2.prefix).toHaveLength(1);
    expect(s2.horizons[0].hold).toBeUndefined();                             // không có giá AAA: không chấm danh mục
  });
  it('tần suất lịch sử chỉ dùng dữ liệu tới ngày chạy: thêm dữ liệu tương lai khác hẳn không đổi brierClim', () => {
    const fake = { dates: FULL.dates, index: FULL.index.map((v, i) => (i > CUT + 63 ? v * 3 : v)) };
    expect(SS.scoreRun(SNAP, fake).horizons[2].brierClim).toBe(sc.horizons[2].brierClim);
  });
  it('ngày chạy không có trong chuỗi -> không chấm', () => {
    expect(SS.scoreRun(Object.assign({}, SNAP, { asOf: '2000-01-01' }), FULL).horizons).toEqual([]);
  });
});

describe('aggregate', () => {
  const mk = (h, inner, ctx) => ({ snap: { events: ctx ? [{ id: 'e' }] : [] }, score: { horizons: [Object.assign({ h: 5, due: true, pit: inner ? 0.5 : 0.99, in50: inner, in90: inner, crps: inner ? 0.01 : 0.05, brier: 0.4, brierClim: 0.6, hold: { ret: 0, pit: 0.5, in90: true } }, ctx ? { base: { crps: 0.02, in90: true }, brierBase: 0.5 } : {}, h || {})] } });
  it('độ phủ, PIT, BSS, so sánh bối cảnh chỉ trên lần có bối cảnh', () => {
    const a = SS.aggregate([mk(null, true, true), mk(null, true, false), mk(null, false, true), { snap: {}, score: { horizons: [{ h: 5, due: false }] } }], [5, 21]);
    expect(a[0].n).toBe(3); expect(a[0].cover90).toBeCloseTo(2 / 3, 12); expect(a[0].pit[5]).toBeCloseTo(2 / 3, 12); expect(a[0].pit[9]).toBeCloseTo(1 / 3, 12);
    expect(a[0].bss).toBeCloseTo(1 - 0.4 / 0.6, 12);
    expect(a[0].ctx).toMatchObject({ n: 2, crpsBase: 0.02 }); expect(a[0].ctx.crps).toBeCloseTo(0.03, 12); expect(a[0].ctx.brierBase).toBeCloseTo(0.5, 12);
    expect(a[0].hold).toMatchObject({ n: 3, cover90: 1 });
    expect(a[1]).toMatchObject({ n: 0, cover90: null, bss: null });
  });
});

describe('liveTree', () => {
  const snap = { horizons: [5, 21, 63], tree: [
    { id: '0', p: 0.3, pp: 0.3, n: 300 }, { id: '1', p: 0.4, pp: 0.4, n: 400 }, { id: '2', p: 0.3, pp: 0.3, n: 300 },
    { id: '00', p: 0.15, pp: 0.5, n: 150 }, { id: '01', p: 0.09, pp: 0.3, n: 90 }, { id: '02', p: 0.06, pp: 0.2, n: 60 },
    { id: '000', p: 0.075, pp: 0.5, n: 75 }, { id: '001', p: 0.075, pp: 0.5, n: 75 },
  ], eventTrees: [{ id: 'e1', title: 'Sự kiện', nodes: [{ id: 'Y', p: 0.4, pp: 0.4, n: 400 }, { id: 'N', p: 0.6, pp: 0.6, n: 600 }, { id: 'Y0', p: 0.2, pp: 0.5, n: 200 }, { id: 'Y1', p: 0.2, pp: 0.5, n: 200 }] }] };
  it('chưa qua mốc: con của gốc với xác suất ban đầu', () => {
    const t = SS.liveTree(snap, '', null);
    expect(t.current).toBeNull(); expect(t.next.map((x) => x.cond)).toEqual([0.3, 0.4, 0.3]); expect(t.done).toBe(false);
  });
  it('đã đi nhánh giảm: xác suất có điều kiện phía trước nhân dọc đường, sắp giảm dần', () => {
    const t = SS.liveTree(snap, '0', null);
    expect(t.current.id).toBe('0'); expect(t.next.map((x) => x.cond)).toEqual([0.5, 0.3, 0.2]);
    expect(t.ahead[0].cond).toBeCloseTo(0.3, 12);                             // '01' là lá (không tách tiếp): 0,3
    expect(t.ahead.find((x) => x.id === '000').cond).toBeCloseTo(0.25, 12);
    expect(t.ahead.reduce((s, x) => s + x.cond, 0)).toBeCloseTo(1, 12);
  });
  it('nhánh thực tế không còn trong cây (quá ít đường) -> dừng ở nút gần nhất, báo stalled', () => {
    const t = SS.liveTree(snap, '021', null);
    expect(t.current.id).toBe('02'); expect(t.stalled).toBe(true); expect(t.path).toBe('02');
  });
  it('đánh dấu sự kiện đã xảy ra -> dùng cây sự kiện, gốc Y', () => {
    const t = SS.liveTree(snap, '1', { eventId: 'e1', happened: true });
    expect(t.root).toBe('Y'); expect(t.current.id).toBe('Y1'); expect(t.eventTitle).toBe('Sự kiện');
    expect(SS.liveTree(snap, '', { eventId: 'e1', happened: true }).next.map((x) => x.id)).toEqual(['Y0', 'Y1']);
    expect(SS.liveTree(snap, '', { eventId: 'khac', happened: true }).root).toBe('');
  });
  it('đi hết 3 mốc -> done', () => {
    expect(SS.liveTree(snap, '000', null).done).toBe(true);
  });
});

describe('validateRun / cleanMarks', () => {
  it('nhận ảnh chụp hợp lệ, cắt ghi chú, chọn cách xử lý có trong danh sách', () => {
    const v = SS.validateRun({ snapshot: SNAP, subject: 'custom', chosen: 'hold', note: 'x'.repeat(2000), label: 'Thử' });
    expect(v.ok).toBe(true);
    expect(v.row).toMatchObject({ as_of: META.asOf, subject: 'custom', chosen_policy: 'hold', label: 'Thử' });
    expect(v.row.note).toHaveLength(1000); expect(v.row.snapshot.chosen).toBe('hold');
    expect(SS.validateRun({ snapshot: SNAP, chosen: 'khong-co' }).row.chosen_policy).toBe('trail12');
  });
  it('từ chối ảnh chụp thiếu / sai phiên bản / thiếu lưới / quá lớn', () => {
    expect(SS.validateRun({}).ok).toBe(false);
    expect(SS.validateRun({ snapshot: Object.assign({}, SNAP, { v: 9 }) }).ok).toBe(false);
    expect(SS.validateRun({ snapshot: Object.assign({}, SNAP, { asOf: 'hôm nay' }) }).error).toMatch(/ngày/);
    expect(SS.validateRun({ snapshot: Object.assign({}, SNAP, { grid: { index: [] } }) }).error).toMatch(/lưới/);
    expect(SS.validateRun({ snapshot: Object.assign({}, SNAP, { pad: 'x'.repeat(310000) }) }).error).toMatch(/quá lớn/);
  });
  it('đánh dấu chỉ nhận true/false', () => {
    expect(SS.cleanMarks({ a: true, b: false, c: 'yes', d: null })).toEqual({ a: true, b: false });
    expect(SS.cleanMarks(null)).toEqual({});
  });
});
