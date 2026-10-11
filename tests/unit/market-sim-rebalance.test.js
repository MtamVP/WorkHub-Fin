// lib/market-sim.js: chính sách "cân bằng lại về tỷ trọng tối ưu" (lib/portfolio-optimizer.js nối vào Mô phỏng): bán phần vượt, mua phần thiếu bằng tiền vừa bán,
// giữ nguyên tiền mặt có sẵn, bỏ chính sách không lập được kèm lý do, và hiệu quả đúng hướng trên cùng bộ đường giá.
import { describe, it, expect } from 'vitest';
import SM from '../../lib/sim-models.js';
import MS from '../../lib/market-sim.js';

// Ba mã: AAA ít biến động, BBB biến động mạnh, CCC vừa; chung một yếu tố thị trường
function synth(seed, n) {
  const R = SM.rng(seed || 1), N = n || 1600, dates = [], idx = [1000], st = [];
  let s = 0;
  for (let t = 0; t < N; t++) dates.push(new Date(Date.UTC(2019, 0, 1) + t * 86400000).toISOString().slice(0, 10));
  for (let t = 1; t < N; t++) { if (R.u() > (s ? 0.94 : 0.98)) s = 1 - s; st.push(s); idx.push(idx[t - 1] * Math.exp((s ? -0.0015 : 0.0008) + (s ? 0.022 : 0.008) * R.n())); }
  const stocks = {};
  [['AAA', 0.8, 0.006, 'HOSE'], ['BBB', 1.5, 0.03, 'HOSE'], ['CCC', 1.1, 0.014, 'HOSE']].forEach(([k, b, sd, ex]) => {
    const c = [50000]; for (let t = 1; t < N; t++) c.push(c[t - 1] * Math.exp(b * Math.log(idx[t] / idx[t - 1]) + sd * R.n()));
    stocks[k] = { closes: c, exchange: ex, adv: 5e9 };
  });
  return { dates, index: idx, stocks };
}
const DATA = synth(11);
const CTX = MS.prepare(DATA, {});
const last = (k) => DATA.stocks[k].closes[DATA.stocks[k].closes.length - 1];
// BBB (biến động mạnh nhất) chiếm gần hết danh mục
const BOOK = { cash: 100e6, debt: 0, positions: [{ symbol: 'AAA', qty: 1000, price: last('AAA') }, { symbol: 'BBB', qty: 6000, price: last('BBB') }, { symbol: 'CCC', qty: 1000, price: last('CCC') }] };
const POLS = [MS.PRESETS[0], MS.PRESETS.find((p) => p.id === 'rb-minvar'), MS.PRESETS.find((p) => p.id === 'rb-rp')];

describe('validatePolicy: cân bằng lại', () => {
  it('giữ cách tối ưu hợp lệ; cách lạ bị bỏ; giới hạn ngoài khoảng bị bỏ chứ không bị chặn', () => {
    expect(MS.validatePolicy({ id: 'a', rebalance: { method: 'minvar' } }).rebalance).toEqual({ method: 'minvar', maxPct: null, minPct: null });
    expect(MS.validatePolicy({ id: 'a', rebalance: { method: 'riskparity', maxPct: 35, minPct: 5 } }).rebalance).toEqual({ method: 'riskparity', maxPct: 35, minPct: 5 });
    expect(MS.validatePolicy({ id: 'a', rebalance: { method: 'magic' } }).rebalance).toBeUndefined();
    expect(MS.validatePolicy({ id: 'a', rebalance: { method: 'minvar', maxPct: 3, minPct: 80 } }).rebalance).toEqual({ method: 'minvar', maxPct: null, minPct: null });
  });
  it('ba mẫu cân bằng lại có trong danh sách mẫu', () => {
    expect(['rb-minvar', 'rb-rp', 'rb-sharpe'].every((id) => MS.PRESETS.some((p) => p.id === id && p.rebalance))).toBe(true);
  });
});

describe('runPolicy: cân bằng lại trên đường giá phẳng', () => {
  // Hai mã giá không đổi: 3.000 cp x 10.000 (30 triệu) và 1.000 cp x 20.000 (20 triệu); mục tiêu 50/50; có sẵn 7 triệu tiền mặt
  function run(cash) {
    const px = [0, 1, 2, 3, 4, 5, 6], M = 2, H = 6;
    const pos = [{ symbol: 'X', kind: 'stock', qty: 3000, price: 10000, band: 0.07, adv: null, sigD: 0.02 }, { symbol: 'Y', kind: 'stock', qty: 1000, price: 20000, band: 0.07, adv: null, sigD: 0.02 }];
    const buf = { px: new Float64Array((H + 1) * M), lk: new Uint8Array((H + 1) * M), ix: new Float64Array(H + 1).fill(1) };
    for (let t = 0; t <= H; t++) { buf.px[t * M] = 10000; buf.px[t * M + 1] = 20000; }
    const pol = MS.validatePolicy({ id: 'r', rebalance: { method: 'minvar' } });
    pol.rb = { w: Float64Array.from([0.5, 0.5]), inS: Uint8Array.from([1, 1]) };
    const scratch = { qty: new Float64Array(M), avail: new Float64Array(M), sellQ: new Float64Array(M), buyV: new Float64Array(M), peak: new Float64Array(M), done: new Uint8Array(M), w0: Float64Array.from([0.6, 0.4]) };
    const nav = new Float64Array(H + 1), o = { horizons: [2, 4, 6], bands: [0.02, 0.04, 0.06], fee: 0.0015, tax: 0.001, impactK: 0.8, participation: 0.2 };
    MS.runPolicy(pol, null, { cash: cash, debt: 0 }, pos, H, buf, o, nav, scratch);
    return { qty: Array.from(scratch.qty), nav: Array.from(nav) };
  }
  it('bán phần vượt (X: 3.000 -> 2.500) và mua phần thiếu (Y) bằng tiền vừa bán', () => {
    const r = run(7e6);
    expect(r.qty[0]).toBe(2500);
    expect(r.qty[1]).toBeGreaterThanOrEqual(1100); expect(r.qty[1]).toBeLessThanOrEqual(1250);
  });
  it('tiền mặt sẵn có không bị dùng để mua: chỉ tiêu tiền thu về từ lệnh bán', () => {
    const rich = run(500e6), poor = run(0);
    expect(rich.qty).toEqual(poor.qty);
  });
  it('chi phí chỉ là phí và thuế của phần giao dịch: giá trị ròng sau 6 phiên mất dưới 0,5%', () => {
    const r = run(7e6), nav0 = 7e6 + 3000 * 10000 + 1000 * 20000;
    expect(r.nav[6]).toBeLessThan(nav0); expect(r.nav[6]).toBeGreaterThan(nav0 * 0.995);
  });
});

describe('simulate: cân bằng lại theo tối ưu hoá', () => {
  const RES = MS.simulate(CTX, BOOK, POLS, { paths: 4000, seed: 5 });
  it('báo tỷ trọng hiện tại và đề xuất: tổng bằng 100%, mã biến động mạnh nhất (BBB) bị giảm', () => {
    expect(RES.droppedPolicies).toEqual([]);
    const mv = RES.rebalance.find((x) => x.id === 'rb-minvar'), i = mv.symbols.indexOf('BBB');
    expect(mv.target.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(mv.current.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(mv.target[i]).toBeLessThan(mv.current[i]);
    expect(mv.vol.next).toBeLessThan(mv.vol.now);
    expect(mv.turnover).toBeGreaterThan(0.1);
  });
  it('ít biến động hơn Giữ nguyên trên cùng bộ đường giá (khoảng 90% và CVaR hẹp hơn), kết quả công bằng giữa các chính sách', () => {
    const h = RES.byHorizon[2].policies, hold = h.find((p) => p.id === 'hold'), mv = h.find((p) => p.id === 'rb-minvar');
    expect(mv.q95 - mv.q05).toBeLessThan((hold.q95 - hold.q05) * 0.8);
    expect(mv.cvar95).toBeLessThan(hold.cvar95);
    expect(mv.dd95).toBeGreaterThan(hold.dd95);            // sụt giảm 5% xấu nhẹ hơn (ít âm hơn)
  });
  it('Giữ nguyên không đổi khi thêm chính sách cân bằng lại; cùng hạt giống cho cùng kết quả', () => {
    const one = MS.simulate(CTX, BOOK, [MS.PRESETS[0]], { paths: 4000, seed: 5 });
    expect(RES.byHorizon[2].policies[0].mean).toBe(one.byHorizon[2].policies[0].mean);
    const again = MS.simulate(CTX, BOOK, POLS, { paths: 4000, seed: 5 });
    expect(again.byHorizon[2].policies[1].mean).toBe(RES.byHorizon[2].policies[1].mean);
  });
  it('đầu ra không mang mảng nội bộ của bộ máy (gửi qua luồng nền gọn)', () => {
    RES.policies.forEach((p) => expect(p.rb).toBeUndefined());
  });
});

describe('simulate: chính sách không lập được thì bị bỏ kèm lý do', () => {
  it('một mã: cần ít nhất 2 mã', () => {
    const r = MS.simulate(CTX, { cash: 0, debt: 0, positions: [{ symbol: 'AAA', qty: 1000, price: last('AAA') }] }, POLS, { paths: 300, seed: 1 });
    expect(r.policies.map((p) => p.id)).toEqual(['hold']);
    expect(r.droppedPolicies.map((d) => d.id)).toEqual(['rb-minvar', 'rb-rp']);
    expect(r.droppedPolicies[0].reason).toMatch(/2 mã/);
  });
  it('tài sản theo VN-Index không nằm trong rổ tối ưu', () => {
    const r = MS.simulate(CTX, { cash: 0, debt: 0, positions: [{ symbol: MS.INDEX, qty: 1, price: 1e8 }, { symbol: 'AAA', qty: 1000, price: last('AAA') }] }, POLS, { paths: 300, seed: 1 });
    expect(r.droppedPolicies.length).toBe(2);
  });
  it('Sharpe tối đa cần giá trị hợp lý: không có thì bỏ, có thì chạy', () => {
    const sh = [MS.PRESETS[0], MS.PRESETS.find((p) => p.id === 'rb-sharpe')];
    const a = MS.simulate(CTX, BOOK, sh, { paths: 300, seed: 1 });
    expect(a.droppedPolicies.map((d) => d.reason).join('')).toMatch(/giá trị hợp lý/);
    const b = MS.simulate(CTX, BOOK, sh, { paths: 300, seed: 1, expected: { AAA: 0.1, BBB: 0.2, CCC: 0.0 } });
    expect(b.droppedPolicies).toEqual([]); expect(b.policies.map((p) => p.id)).toContain('rb-sharpe');
    const t = b.rebalance[0]; expect(t.target.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
  });
  it('mọi chính sách đều bị bỏ thì vẫn còn Giữ nguyên để so sánh', () => {
    const r = MS.simulate(CTX, { cash: 1e6, debt: 0, positions: [{ symbol: 'AAA', qty: 1000, price: last('AAA') }] }, [POLS[1]], { paths: 300, seed: 1 });
    expect(r.policies.map((p) => p.id)).toEqual(['hold']);
  });
});

describe('simulate: kỳ vọng riêng cho tối ưu hoá', () => {
  it('optExpected chỉ dùng để chọn tỷ trọng Sharpe tối đa, không làm lệch đường giá của các chính sách khác', () => {
    const sh = [MS.PRESETS[0], MS.PRESETS.find((p) => p.id === 'rb-sharpe')];
    const plain = MS.simulate(CTX, BOOK, sh, { paths: 1500, seed: 4, optExpected: { AAA: 0.1, BBB: 0.0, CCC: 0.2 } });
    const none = MS.simulate(CTX, BOOK, [MS.PRESETS[0]], { paths: 1500, seed: 4 });
    expect(plain.droppedPolicies).toEqual([]);
    expect(plain.byHorizon[2].policies[0].mean).toBe(none.byHorizon[2].policies[0].mean);
    const t = plain.rebalance[0], w = (s) => t.target[t.symbols.indexOf(s)];
    expect(w('CCC')).toBeGreaterThan(w('BBB'));              // kỳ vọng cao hơn và ít biến động hơn thì được nhiều hơn
  });
  it('kỳ vọng kéo độ dời (expected) vẫn làm đổi đường giá còn optExpected thì không', () => {
    const base = MS.simulate(CTX, BOOK, [MS.PRESETS[0]], { paths: 1500, seed: 4 });
    const drift = MS.simulate(CTX, BOOK, [MS.PRESETS[0]], { paths: 1500, seed: 4, expected: { AAA: 0.3, BBB: 0.3, CCC: 0.3 } });
    expect(drift.byHorizon[2].policies[0].mean).not.toBe(base.byHorizon[2].policies[0].mean);
  });
});
