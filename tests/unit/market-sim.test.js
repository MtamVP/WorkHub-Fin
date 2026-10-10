// lib/market-sim.js: luật chơi Việt Nam (biên độ, nằm sàn không bán được, T+2, lô, phí/thuế, giới hạn thanh khoản), chính sách và kế hoạch có điều kiện,
// so sánh trên cùng bộ đường giá, cây kịch bản, hiệu chỉnh độ dời, kiểm chứng ngược, dựng đầu vào từ dữ liệu API.
import { describe, it, expect } from 'vitest';
import SM from '../../lib/sim-models.js';
import MS from '../../lib/market-sim.js';
import RiskCalc from '../../lib/risk-calc.js';

// Dữ liệu tổng hợp: VN-Index theo mô hình hai chế độ, hai mã có beta 1 và 1,4
function synth(seed, n) {
  const R = SM.rng(seed || 1), N = n || 1600, dates = [], idx = [1000], st = [];
  let s = 0;
  for (let t = 0; t < N; t++) { const d = new Date(Date.UTC(2019, 0, 1) + t * 86400000); dates.push(d.toISOString().slice(0, 10)); }
  for (let t = 1; t < N; t++) { if (R.u() > (s ? 0.94 : 0.98)) s = 1 - s; st.push(s); idx.push(idx[t - 1] * Math.exp((s ? -0.0015 : 0.0008) + (s ? 0.022 : 0.008) * R.n())); }
  const stocks = {};
  [['AAA', 1, 'HOSE'], ['BBB', 1.4, 'HNX']].forEach(([k, b, ex]) => { const c = [50000]; for (let t = 1; t < N; t++) c.push(c[t - 1] * Math.exp(b * Math.log(idx[t] / idx[t - 1]) + 0.012 * R.n())); stocks[k] = { closes: c, exchange: ex, adv: 20e9 }; });
  return { dates, index: idx, stocks };
}
const DATA = synth(3);
const CTX = MS.prepare(DATA, {});
const last = (k) => DATA.stocks[k].closes[DATA.stocks[k].closes.length - 1];
const BOOK = { cash: 200e6, debt: 0, positions: [{ symbol: 'AAA', qty: 4000, price: last('AAA') }, { symbol: 'BBB', qty: 3000, price: last('BBB') }] };

// Chạy một chính sách trên một đường dựng tay
function runOn(pol, px, opts) {
  const o = Object.assign({ horizons: [2, 4, 6], bands: [0.02, 0.04, 0.06], fee: 0.0015, tax: 0.001, impactK: 0.8, participation: 0.2 }, opts || {});
  const H = px.length - 1, pos = [Object.assign({ symbol: 'X', kind: 'stock', qty: 1000, price: px[0], band: 0.07, adv: null, sigD: 0.02 }, o.pos || {})];
  const buf = { px: Float64Array.from(px), lk: Uint8Array.from(o.lk || px.map(() => 0)), ix: Float64Array.from(o.ix || px.map((v) => v / px[0])) };
  const scratch = { qty: new Float64Array(1), avail: new Float64Array(1), sellQ: new Float64Array(1), buyV: new Float64Array(1), peak: new Float64Array(1), done: new Uint8Array(1), w0: Float64Array.from([1]) };
  const nav = new Float64Array(H + 1);
  const stuck = MS.runPolicy(MS.validatePolicy(pol), null, { cash: o.cash || 0, debt: 0 }, pos, H, buf, o, nav, scratch);
  return { nav, qty: scratch.qty[0], stuck, cash: nav[H] - scratch.qty[0] * px[H] };
}

describe('chính sách trên đường dựng tay', () => {
  it('bán hết ngay: tiền thu = KL x giá x (1 - phí - thuế), khớp ở giá hôm nay', () => {
    const r = runOn({ id: 'c', now: { sellPct: 100 } }, [10000, 9000, 8000]);
    expect(r.qty).toBe(0);
    expect(r.nav[0]).toBeCloseTo(1000 * 10000 * (1 - 0.0015 - 0.001), 6);
    expect(r.nav[2]).toBeCloseTo(r.nav[0], 6);
  });
  it('cắt lỗ: quyết định theo giá đóng cửa, khớp phiên sau; nằm sàn thì KHÔNG bán được', () => {
    // giá chạm ngưỡng -8% ở phiên 2, phiên 3 và 4 nằm sàn, phiên 5 mới bán được
    const px = [10000, 9500, 9100, 8470, 7880, 8000, 8200], lk = [0, 0, 0, 1, 1, 0, 0];
    const r = runOn({ id: 's', stop: { pct: 8 } }, px, { lk });
    expect(r.qty).toBe(0);
    expect(r.stuck).toBe(2);
    expect(r.cash).toBeCloseTo(1000 * 8000 * (1 - 0.0025), 6);
    expect(r.nav[4]).toBeCloseTo(1000 * 7880, 6);                    // vẫn cầm cổ phiếu khi nằm sàn
  });
  it('cắt lỗ động bám theo đỉnh', () => {
    const r = runOn({ id: 't', stop: { pct: 10, trailing: true } }, [10000, 12000, 11500, 10700, 10000, 9000]);
    expect(r.qty).toBe(0);
    expect(r.cash).toBeCloseTo(1000 * 10000 * (1 - 0.0025), 6);        // đỉnh 12.000 -> ngưỡng 10.800; đóng cửa 10.700 -> bán phiên sau giá 10.000
  });
  it('T+2: cổ phiếu mua thêm chỉ bán được sau 2 phiên', () => {
    // VN-Index giảm 8% ở phiên 1 -> mua bằng toàn bộ tiền ở phiên 2; cắt lỗ động kích hoạt ở phiên 2 -> phiên 3 chỉ bán được phần cũ, phần mới bán ở phiên 4
    const px = [10000, 9200, 8000, 7900, 7800, 7700], ix = [1, 0.92, 0.85, 0.84, 0.83, 0.82];
    const pol = { id: 'd', dip: { drop: 7, deployPct: 100 }, stop: { pct: 15, trailing: false } };
    const a = runOn(pol, px.slice(0, 4), { ix: ix.slice(0, 4), cash: 8e6 });
    const b = runOn(pol, px.slice(0, 5), { ix: ix.slice(0, 5), cash: 8e6 });
    expect(a.qty).toBeGreaterThan(0);                                  // phiên 3: còn phần mới mua chưa về
    expect(a.qty % 100).toBe(0);
    expect(b.qty).toBe(0);                                             // phiên 4: đã về, bán hết
  });
  it('giới hạn tham gia thanh khoản chia lệnh lớn ra nhiều phiên, có chi phí tác động giá', () => {
    // thanh khoản 10 triệu đồng/phiên, tối đa 20% = 2 triệu = 200 cp ở giá 10.000
    const r = runOn({ id: 'c', now: { sellPct: 100 } }, [10000, 10000, 10000], { pos: { adv: 10e6 } });
    expect(r.qty).toBe(1000 - 3 * 200);
    const imp = 0.8 * 0.02 * Math.sqrt(2e6 / 10e6);
    expect(r.cash).toBeCloseTo(3 * 200 * 10000 * (1 - 0.0025 - imp), 4);
  });
  it('kế hoạch có điều kiện theo chuỗi nhánh: chỉ kích hoạt khi đi đúng cả hai giai đoạn', () => {
    // giai đoạn 1 (phiên 0-2): -5% -> giảm; giai đoạn 2 (phiên 2-4): +0,5% -> đi ngang
    const ix = [1, 0.97, 0.95, 0.952, 0.955, 0.955, 0.955], px = ix.map((v) => 10000 * v);
    const hit = runOn({ id: 'p', rules: [{ stage: 2, when: 'flat', act: 'sell', pct: 50, path: '01' }] }, px, { ix });
    const miss = runOn({ id: 'q', rules: [{ stage: 2, when: 'flat', act: 'sell', pct: 50, path: '21' }] }, px, { ix });
    expect(hit.qty).toBe(500); expect(miss.qty).toBe(1000);
  });
  it('validatePolicy chặn giá trị vô lý và bỏ quy tắc sai', () => {
    const p = MS.validatePolicy({ id: 'x', now: { sellPct: 250 }, stop: { pct: -5 }, rules: [{ stage: 3, when: 'down', act: 'sell', pct: 10 }, { stage: 1, when: 'up', act: 'buy', pct: 40 }] });
    expect(p.now.sellPct).toBe(100); expect(p.stop).toBeUndefined(); expect(p.rules).toEqual([{ stage: 1, when: 'up', act: 'buy', pct: 40 }]);
  });
});

describe('prepare / genPath', () => {
  it('ước lượng đủ mô hình; beta hai mã gần 1 và 1,4', () => {
    expect(CTX.ok).toBe(true);
    const d = MS.describe(CTX);
    expect(d.stocks.find((s) => s.symbol === 'AAA').beta).toBeCloseTo(1, 1);
    expect(d.stocks.find((s) => s.symbol === 'BBB').beta).toBeCloseTo(1.4, 1);
    expect(d.hmm.current.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(d.stressHist.index[d.stressHist.index.length - 1]).toBeCloseTo(DATA.index[DATA.index.length - 1], 6);
  });
  it('giá mô phỏng luôn nằm trong biên độ của sàn; khi chạm biên thì có cờ khoá', () => {
    const pos = [{ symbol: 'AAA', kind: 'stock', fi: CTX.fIndex.AAA, qty: 1, price: 50000, band: 0.07 }, { symbol: 'BBB', kind: 'stock', fi: CTX.fIndex.BBB, qty: 1, price: 30000, band: 0.1 }];
    const H = 63, buf = { ix: new Float64Array(H + 1), st: new Int8Array(H + 1), px: new Float64Array((H + 1) * 2), lk: new Uint8Array((H + 1) * 2), lat: new Float64Array(2) };
    const R = SM.rng(5); let locks = 0;
    for (let p = 0; p < 300; p++) {
      MS.genPath(CTX, pos, H, p % 2 ? 'hmm' : 'garch', R, buf, null);
      for (let t = 1; t <= H; t++) for (let j = 0; j < 2; j++) {
        const ch = buf.px[t * 2 + j] / buf.px[(t - 1) * 2 + j] - 1;
        expect(Math.abs(ch)).toBeLessThanOrEqual(pos[j].band + 1e-9);
        if (buf.lk[t * 2 + j]) { locks++; expect(Math.abs(Math.abs(ch) - pos[j].band)).toBeLessThan(1e-9); }
      }
    }
    expect(locks).toBeGreaterThan(0);
  });
  it('đường mô phỏng của từng mã giữ đúng beta với thị trường (1 và 1,4)', () => {
    const pos = [{ symbol: 'AAA', kind: 'stock', fi: CTX.fIndex.AAA, qty: 1, price: 50000, band: 1 }, { symbol: 'BBB', kind: 'stock', fi: CTX.fIndex.BBB, qty: 1, price: 30000, band: 1 }];
    const H = 21, buf = { ix: new Float64Array(H + 1), st: new Int8Array(H + 1), px: new Float64Array((H + 1) * 2), lk: new Uint8Array((H + 1) * 2), lat: new Float64Array(2) };
    const R = SM.rng(8), x = [], a = [], b = [];
    for (let p = 0; p < 1500; p++) {
      MS.genPath(CTX, pos, H, p % 2 ? 'hmm' : 'garch', R, buf, null);
      x.push(Math.log(buf.ix[H])); a.push(Math.log(buf.px[H * 2] / 50000)); b.push(Math.log(buf.px[H * 2 + 1] / 30000));
    }
    const beta = (y) => { const mx = SM.mean(x), my = SM.mean(y); let c = 0, v = 0; for (let i = 0; i < x.length; i++) { c += (x[i] - mx) * (y[i] - my); v += (x[i] - mx) ** 2; } return c / v; };
    expect(beta(a)).toBeCloseTo(1, 1); expect(beta(b)).toBeCloseTo(1.4, 1);
  });
  it('hiệu chỉnh độ dời sửa được độ lệch của công thức khi chế độ kéo dài (trung bình theo chế độ tự tương quan)', () => {
    // hai chế độ rất bền với trung bình khác xa nhau: công thức log chuẩn đánh giá thấp lợi suất đơn kỳ vọng
    const rm = new Float64Array(200), R = SM.rng(4);
    for (let i = 0; i < 200; i++) rm[i] = (i < 100 ? 0.002 : -0.003) + 0.006 * R.n();
    const hmm = { K: 2, mu: [0.002, -0.003], sigma: [0.006, 0.006], P: [[0.996, 0.004], [0.008, 0.992]], stationary: [2 / 3, 1 / 3], current: [2 / 3, 1 / 3] };
    const pools = [Int32Array.from({ length: 100 }, (v, i) => i), Int32Array.from({ length: 100 }, (v, i) => 100 + i)];
    const mk = () => ({ garch: CTX.garch, hmm: hmm, rm: rm, pools: pools, drift: MS.anchorDrift({ drift: 0.09 }, CTX.garch, hmm) });
    const meanYear = (lite) => { const l = MS.simIndexOnly(lite, 'hmm', 252, 20000, SM.rng(77), { uncond: true, lastOnly: true }); let s = 0; for (let i = 0; i < l.length; i++) s += Math.exp(l[i]); return s / l.length; };
    const raw = mk(), cal = mk(); MS.calibrateDrift(cal, 0.09);
    expect(Math.abs(meanYear(cal) - 1.09)).toBeLessThan(0.01);
    expect(Math.abs(meanYear(raw) - 1.09)).toBeGreaterThan(0.03);
  });
  it('độ dời neo đúng giả định: lợi suất năm trung bình từ trạng thái dừng = 9%', () => {
    const lite = { garch: CTX.garch, hmm: CTX.hmm, rm: CTX.rm, pools: CTX.pools, drift: CTX.drift };
    ['garch', 'hmm'].forEach((m) => {
      const last2 = MS.simIndexOnly(lite, m, 252, 20000, SM.rng(1234), { uncond: true, lastOnly: true });
      let s = 0; for (let i = 0; i < last2.length; i++) s += Math.exp(last2[i]);
      expect(Math.abs(s / last2.length - 1.09)).toBeLessThan(0.012);
    });
  });
});

describe('simulate', () => {
  const RES = MS.simulate(CTX, BOOK, MS.PRESETS, { paths: 3000 });
  it('cùng hạt giống -> cùng kết quả', () => {
    const b = MS.simulate(CTX, BOOK, MS.PRESETS.slice(0, 2), { paths: 500, seed: 9 }), c = MS.simulate(CTX, BOOK, MS.PRESETS.slice(0, 2), { paths: 500, seed: 9 });
    expect(b.byHorizon[2].policies[0].mean).toBe(c.byHorizon[2].policies[0].mean);
  });
  it('cùng bộ đường giá: kết quả Giữ nguyên không đổi khi thêm chính sách khác', () => {
    const one = MS.simulate(CTX, BOOK, [MS.PRESETS[0]], { paths: 800, seed: 3 }), many = MS.simulate(CTX, BOOK, MS.PRESETS, { paths: 800, seed: 3 });
    expect(many.byHorizon[2].policies[0].mean).toBe(one.byHorizon[2].policies[0].mean);
    expect(many.byHorizon[2].policies[0].q05).toBe(one.byHorizon[2].policies[0].q05);
  });
  it('hối tiếc không âm; xác suất tốt nhất cộng lại = 1; CVaR >= VaR', () => {
    RES.byHorizon.forEach((h) => {
      let sb = 0; h.policies.forEach((p) => { expect(p.regretMean).toBeGreaterThanOrEqual(0); expect(p.cvar95).toBeGreaterThanOrEqual(p.var95 - 1e-12); sb += p.pBest; });
      expect(sb).toBeCloseTo(1, 9);
    });
  });
  it('bán hết giữ tiền: gần như không rủi ro, chỉ mất phí và thuế', () => {
    const c = RES.byHorizon[2].policies.find((p) => p.id === 'cash');
    expect(c.q95 - c.q05).toBeLessThan(1e-9); expect(c.mean).toBeLessThan(0); expect(c.mean).toBeGreaterThan(-0.004);
  });
  it('cắt lỗ thu hẹp đuôi xấu so với giữ nguyên', () => {
    const h = RES.byHorizon[2].policies, hold = h.find((p) => p.id === 'hold'), stop = h.find((p) => p.id === 'stop8');
    expect(stop.cvar95).toBeLessThan(hold.cvar95);
  });
  it('cây kịch bản: xác suất ba nhánh đầu cộng lại = 1, nhánh con cộng lại bằng nhánh cha', () => {
    const l1 = RES.tree.filter((n) => n.depth === 1);
    expect(l1.reduce((s, n) => s + n.prob, 0)).toBeCloseTo(1, 12);
    l1.forEach((n) => { const kids = RES.tree.filter((k) => k.depth === 2 && k.id.startsWith(n.id)); if (kids.length) expect(kids.reduce((s, k) => s + k.n, 0)).toBe(n.n); });
  });
  it('đóng góp lỗ ở 5% đường xấu nhất cộng lại bằng lỗ trung bình của danh mục (không phí)', () => {
    const d = RES.drivers[2].worst, sum = d.contrib.reduce((s, c) => s + c.pctNav, 0);
    expect(sum).toBeCloseTo(d.portMean, 9);
  });
  it('tài sản theo chỉ số: lợi nhuận danh mục = thay đổi VN-Index', () => {
    const r = MS.simulate(CTX, { cash: 0, debt: 0, positions: [{ symbol: MS.INDEX, qty: 1, price: 1e8 }] }, [MS.PRESETS[0]], { paths: 400 });
    expect(r.byHorizon[1].policies[0].mean).toBeCloseTo(r.byHorizon[1].index.mean, 12);
  });
  it('mã thiếu lịch sử giữ nguyên giá trị và được ghi chú; NAV không dương thì báo lỗi', () => {
    const r = MS.simulate(CTX, { cash: 0, debt: 0, positions: [{ symbol: 'ZZZ', qty: 100, price: 10000 }, { symbol: 'AAA', qty: 100, price: last('AAA') }] }, [MS.PRESETS[0]], { paths: 200 });
    expect(r.skipped).toEqual(['ZZZ']);
    expect(MS.simulate(CTX, { cash: 0, debt: 1e9, positions: [{ symbol: 'AAA', qty: 100, price: 10000 }] }, null, { paths: 200 }).ok).toBe(false);
  });
});

describe('sự kiện của bối cảnh', () => {
  const SC = MS.eventScale(CTX.rm);
  const sectorBook = { cash: 0, debt: 0, positions: [{ symbol: 'AAA', qty: 4000, price: last('AAA'), sector: 'Ngân hàng' }, { symbol: 'BBB', qty: 3000, price: last('BBB'), sector: 'Công nghệ' }] };
  it('thang độ lớn = phân vị của |lợi suất 5 phiên| (nhỏ < vừa < lớn)', () => {
    const r = Array.from(CTX.rm), a = []; for (let i = 0; i + 5 <= r.length; i++) a.push(Math.abs(r[i] + r[i + 1] + r[i + 2] + r[i + 3] + r[i + 4]));
    a.sort((x, y) => x - y);
    expect(SC.medium).toBeCloseTo(SM.quantileSorted(a, 0.85), 12);
    expect(SC.small).toBeLessThan(SC.medium); expect(SC.medium).toBeLessThan(SC.large);
  });
  it('eventFromCard: khả năng thô -> xác suất, mức -> độ lớn, ngành nhân 1,5, thị trường lan 25%, ghi đè được, tắt -> null', () => {
    const m = MS.eventFromCard({ id: 'm', likelihood: 'high', window: '1w', direction: 'down', magnitude: 'large', scope: 'market' }, SC);
    expect(m).toMatchObject({ p: 0.6, win: 5, sign: -1, jS: 0 }); expect(m.jM).toBeCloseTo(Math.log(1 + SC.large), 12);
    const s = MS.eventFromCard({ id: 's', likelihood: 'low', window: '3m', direction: 'up', magnitude: 'medium', scope: 'sector', sectors: ['Ngân hàng'] }, SC);
    expect(s.p).toBe(0.15); expect(s.jM).toBeCloseTo(Math.log(1 + 0.25 * SC.medium), 12); expect(s.jS).toBeCloseTo(Math.log(1 + 1.5 * SC.medium), 12);
    const o = MS.eventFromCard({ id: 'o', prob: 0.9, direction: 'mixed', magnitude: 'small', scope: 'market', marketMove: 0.08 }, SC);
    expect(o.p).toBe(0.9); expect(o.sign).toBe(0); expect(o.jM).toBeCloseTo(Math.log(1.08), 12);
    expect(MS.eventFromCard({ on: false, magnitude: 'large' }, SC)).toBeNull();
    expect(MS.eventFromCard({ prob: 0, magnitude: 'large' }, SC)).toBeNull();
    expect(MS.eventFromCard({ marketMove: 5, prob: 1 }, SC).jM).toBeCloseTo(Math.log(1.6), 12);    // chặn 60%
  });
  it('sự kiện xác suất 0 cho kết quả GIỐNG HỆT không có sự kiện (phần lịch sử không bị xáo trộn)', () => {
    const ev = MS.eventFromCard({ id: 'z', prob: 1, magnitude: 'large', direction: 'down' }, SC); ev.p = 0;
    const a = MS.simulate(CTX, sectorBook, [MS.PRESETS[0]], { paths: 600, seed: 4 }), b = MS.simulate(CTX, sectorBook, [MS.PRESETS[0]], { paths: 600, seed: 4, events: [ev] });
    expect(b.byHorizon[2].policies[0].mean).toBe(a.byHorizon[2].policies[0].mean);
  });
  it('sự kiện chắc chắn giảm 10% kéo VN-Index xuống đúng mức đó (cùng bộ đường)', () => {
    const ev = MS.eventFromCard({ id: 'd', prob: 1, window: '1w', direction: 'down', scope: 'market', marketMove: 0.1 }, SC);
    const idx = { cash: 0, debt: 0, positions: [{ symbol: MS.INDEX, qty: 1, price: 1e8 }] };
    const a = MS.simulate(CTX, idx, [MS.PRESETS[0]], { paths: 800, seed: 5, model: 'hmm' }), b = MS.simulate(CTX, idx, [MS.PRESETS[0]], { paths: 800, seed: 5, model: 'hmm', events: [ev] });
    // với mô hình chế độ, cú sốc chỉ cộng vào lợi suất: tỷ lệ 1+R mới / 1+R cũ = 1/1,1 trên MỌI đường
    expect((1 + b.byHorizon[2].index.median) / (1 + a.byHorizon[2].index.median)).toBeCloseTo(1 / 1.1, 6);
    expect(b.events[0].byHorizon[0].share).toBe(1);
  });
  it('sự kiện ngành chỉ đánh riêng vào mã thuộc ngành; tỷ lệ đường xảy ra gần xác suất', () => {
    const ev = MS.eventFromCard({ id: 'b', prob: 0.4, window: '1m', direction: 'down', magnitude: 'large', scope: 'sector', sectors: ['Ngân hàng'], marketMove: 0 }, SC);
    expect(ev.jM).toBe(0);
    const r = MS.simulate(CTX, sectorBook, [MS.PRESETS[0]], { paths: 3000, seed: 6, events: [ev] });
    const e = r.events[0]; expect(e.exposed).toEqual(['AAA']);
    expect(Math.abs(e.byHorizon[2].share - 0.4)).toBeLessThan(0.03);
    expect(e.byHorizon[2].yes.port.mean).toBeLessThan(e.byHorizon[2].no.port.mean);
    expect(e.byHorizon[2].yes.index.median).toBeCloseTo(e.byHorizon[2].no.index.median, 1);   // thị trường chung gần như không đổi
    expect(e.byHorizon[0].share).toBeLessThan(e.byHorizon[1].share + 1e-12);                   // trước mốc 1 tuần xảy ra ít hơn trước mốc 1 tháng
  });
});

describe('cây theo sự kiện, xác suất nhánh, lưới phân vị (đợt 3)', () => {
  const SC = MS.eventScale(CTX.rm);
  const idx = { cash: 0, debt: 0, positions: [{ symbol: MS.INDEX, qty: 1, price: 1e8 }] };
  it('gốc Y/N tách đúng các đường có sự kiện; con của mỗi gốc cộng lại bằng gốc; giảm chắc chắn làm gốc Y thấp hơn N', () => {
    const ev = MS.eventFromCard({ id: 'x', prob: 0.5, window: '1m', direction: 'down', scope: 'market', marketMove: 0.08 }, SC);
    const r = MS.simulate(CTX, BOOK, [MS.PRESETS[0], MS.PRESETS[1]], { paths: 2000, seed: 8, events: [ev] });
    expect(r.eventTrees).toHaveLength(1);
    const t = r.eventTrees[0], by = {}; t.nodes.forEach((n) => { by[n.id] = n; });
    expect(by.Y.n + by.N.n).toBe(2000);
    expect(by.Y.prob).toBeCloseTo(r.events[0].byHorizon[2].share, 12);
    ['Y', 'N'].forEach((root) => {
      expect([0, 1, 2].reduce((s, b) => s + (by[root + b] ? by[root + b].n : 0), 0)).toBe(by[root].n);
      expect(by[root + '0'].parentProb).toBeCloseTo(by[root + '0'].n / by[root].n, 12);
      expect(by[root].policies).toHaveLength(2);
    });
    expect(by.Y.index.median).toBeLessThan(by.N.index.median);
    expect(by.Y0.prob).toBeGreaterThan(by.N0.prob * by.Y.prob / by.N.prob);                  // trong gốc Y, nhánh giảm tuần đầu / tháng đầu dày hơn
  });
  it('không có sự kiện thì không có cây sự kiện; tối đa 3 cây', () => {
    expect(MS.simulate(CTX, idx, [MS.PRESETS[0]], { paths: 300, seed: 1 }).eventTrees).toEqual([]);
    const evs = [1, 2, 3, 4].map((i) => MS.eventFromCard({ id: 'e' + i, prob: 0.3, magnitude: 'small' }, SC));
    expect(MS.simulate(CTX, idx, [MS.PRESETS[0]], { paths: 300, seed: 1, events: evs }).eventTrees).toHaveLength(3);
  });
  it('xác suất nhánh mỗi giai đoạn cộng bằng 1 và khớp cây ở giai đoạn 1; lưới phân vị tăng dần, khớp phân vị trong thống kê', () => {
    const r = MS.simulate(CTX, idx, [MS.PRESETS[0]], { paths: 3000, seed: 2 });
    r.branchProb.forEach((p) => expect(p[0] + p[1] + p[2]).toBeCloseTo(1, 12));
    r.tree.filter((n) => n.depth === 1).forEach((n) => expect(r.branchProb[0][n.branch]).toBeCloseTo(n.prob, 12));
    expect(r.grid.levels).toHaveLength(39);
    r.grid.index.forEach((g, hk) => {
      for (let i = 1; i < g.length; i++) expect(g[i]).toBeGreaterThanOrEqual(g[i - 1]);
      expect(g[r.grid.levels.indexOf(0.5)]).toBeCloseTo(r.byHorizon[hk].index.median, 12);
      expect(g[r.grid.levels.indexOf(0.05)]).toBeCloseTo(r.byHorizon[hk].index.q05, 12);
      expect(r.grid.hold[hk][r.grid.levels.indexOf(0.5)]).toBeCloseTo(r.byHorizon[hk].policies[0].median, 9);   // tài sản theo chỉ số: Giữ nguyên = VN-Index
    });
  });
});

describe('backtest', () => {
  it('dữ liệu sinh từ đúng mô hình -> độ phủ khoảng 90% gần danh nghĩa', () => {
    const r = MS.logRets(DATA.index);
    const bt = MS.backtest(r, { paths: 300, step: 25, refitEvery: 200, models: ['blend', 'hist'], horizons: [5, 21] });
    expect(bt.ok).toBe(true);
    ['blend', 'hist'].forEach((m) => bt.results[m].forEach((x) => { expect(x.cover90).toBeGreaterThan(0.75); expect(x.pit.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9); }));
  });
  it('quá ít dữ liệu thì báo short', () => { expect(MS.backtest([0.01, 0.02], {}).ok).toBe(false); });
  it('CRPS từ mẫu khớp công thức E|X-y| - E|X-X\'|/2', () => {
    const s = [-1, 0, 2, 5], y = 1; let a = 0, b = 0;
    s.forEach((x) => { a += Math.abs(x - y); s.forEach((x2) => { b += Math.abs(x - x2); }); });
    expect(MS.crpsSorted(s, y)).toBeCloseTo(a / 4 - b / 32, 12);
  });
});

describe('fromHistories', () => {
  it('điều chỉnh cổ tức tiền, căn theo lịch VN-Index, thanh khoản = trung vị giá trị 20 phiên', () => {
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12'];
    const raw = {
      histories: { VNINDEX: dates.map((d, i) => [d, 1200 + i]), AAA: dates.filter((d) => d !== '2026-01-08').map((d, i) => [d, 10000 + 100 * i]) },
      events: [{ symbol: 'AAA', exDate: '2026-01-09', kind: 'cash_dividend', dps: 1000 }],
      volumes: { AAA: dates.map((d) => [d, 1000]) }, listings: { AAA: { exchange: 'HNX' } },
    };
    const inp = MS.fromHistories(raw, RiskCalc);
    expect(inp.dates).toEqual(dates); expect(inp.index[0]).toBe(1200);
    expect(inp.stocks.AAA.exchange).toBe('HNX');
    expect(inp.stocks.AAA.closes[3]).toBeCloseTo(inp.stocks.AAA.closes[2], 9);   // ngày 08 thiếu: điền giá ngày trước
    expect(inp.stocks.AAA.closes[0]).toBeCloseTo(10000 * (1 - 1000 / 10200), 6);   // trước ngày không hưởng quyền: nhân hệ số điều chỉnh
    expect(inp.stocks.AAA.adv).toBeCloseTo(1000 * 10200, 6);
  });
});
