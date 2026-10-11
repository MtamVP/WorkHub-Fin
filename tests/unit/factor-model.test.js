// Mô hình yếu tố tự dựng: lib/factor-model.js (hồi quy đối chiếu numpy, dựng yếu tố, hồi tố danh mục, phép đo theo mã đang nắm)
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import FM from '../../lib/factor-model.js';
import SB from '../../lib/strategy-backtest.js';
import BtPanel from '../../lib/bt-panel.js';
import PitCalc from '../../lib/pit-calc.js';
const { makeRows, indexRow, pitRow } = require('../helpers/bt-fixtures.js');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'backtest-golden.json'), 'utf8'));

describe('regress: đối chiếu numpy (OLS + Newey-West ma trận + VIF)', () => {
  const g = golden.regress, fit = FM.regress(g.y, g.X, g.lag);
  it('hệ số, t, R2, R2 điều chỉnh, biến động phần dư', () => {
    expect(fit.alpha).toBeCloseTo(g.alpha, 9);
    g.beta.forEach((b, i) => expect(fit.beta[i]).toBeCloseTo(b, 9));
    expect(fit.tAlpha).toBeCloseTo(g.tAlpha, 6);
    g.t.forEach((t, i) => expect(fit.t[i]).toBeCloseTo(t, 6));
    expect(fit.r2).toBeCloseTo(g.r2, 9); expect(fit.adjR2).toBeCloseTo(g.adjR2, 9); expect(fit.residVol).toBeCloseTo(g.residVol, 8);
  });
  it('VIF từ ma trận tương quan', () => { g.vif.forEach((v, i) => expect(fit.vif[i]).toBeCloseTo(v, 8)); });
  it('mẫu quá ngắn hoặc các cột trùng nhau thì trả null (không bịa)', () => {
    expect(FM.regress([1, 2, 3], [[1, 2, 3]], 2)).toBeNull();
    const x = Array.from({ length: 60 }, (_, i) => Math.sin(i));
    expect(FM.regress(Array.from({ length: 60 }, (_, i) => Math.cos(i)), [x, x.slice()], 2)).toBeNull();
  });
  it('solve giải hệ tuyến tính', () => {
    const s = FM.solve([[2, 1], [1, 3]], [[3], [5]]);
    expect(s[0][0]).toBeCloseTo(0.8, 12); expect(s[1][0]).toBeCloseTo(1.4, 12);
    expect(FM.solve([[1, 2], [2, 4]], [[1], [2]])).toBeNull();
  });
});

// Thị trường tổng hợp có NHIỄU ngẫu nhiên riêng từng mã (hạt giống cố định) + nhiễu thị trường chung, để các yếu tố không suy biến.
function noise(seed, n) { const r = SB.mulberry32(seed), out = []; for (let i = 0; i < n; i++) out.push((r() + r() + r() + r() - 2) * 1.7); return out; }
function market(days, o) {
  const N = (o && o.n) || 40, cfg = Object.assign({ drift: (k) => 0.0030 - k * 0.00014, vol: () => 0.012, cap: (k) => (N - k) * 1e12, pb: (k) => 1 + k * 0.05, roe: (k) => 0.25 - k * 0.003 }, o || {});
  const common = noise(7, days), stocks = {};
  for (let k = 0; k < N; k++) {
    const e = noise(100 + k, days), name = 'S' + String(k + 1).padStart(2, '0'), beta = 0.6 + (k % 5) * 0.2;
    stocks[name] = { ret: (t) => cfg.drift(k) + beta * 0.006 * common[t] + cfg.vol(k) * e[t], p0: 20 + k, val: 30000 };
  }
  const { rows, dates } = makeRows(days, stocks);
  const P = BtPanel.build(rows, [indexRow('VNINDEX', dates, (t) => 0.0004 + 0.006 * common[t])]);
  const months = SB.signalDays(P, 'M', 0, P.T - 1).map((t) => P.dates[t]);
  const pit = PitCalc.decodeDays(months.map((d) => {
    const m = {};
    for (let k = 0; k < N; k++) m['S' + String(k + 1).padStart(2, '0')] = { icb2: '1000', marketcap: cfg.cap(k), pb: cfg.pb(k), roae: cfg.roe(k) };
    return pitRow(d, m);
  }));
  return { P, pit, N };
}
const OPT = { minStocks: 10, minAdv: 1e9, minHistory: 60, warmup: 130 };
const avg = (F, k) => { const a = Array.from(F.series[k]).filter((x) => x === x); return a.reduce((s, x) => s + x, 0) / a.length; };

describe('buildFactorReturns: dấu và cơ chế từng yếu tố', () => {
  const { P, pit } = market(560);
  const F = FM.buildFactorReturns(P, pit, OPT);
  it('dựng đủ sáu yếu tố, đếm số tháng và số mã mỗi rổ (30% vũ trụ)', () => {
    ['MKT', 'SIZE', 'VALUE', 'MOM', 'LVOL', 'QUAL'].forEach((k) => expect(Array.from(F.series[k]).filter((x) => x === x).length, k).toBeGreaterThan(200));
    expect(F.built.MOM).toBeGreaterThan(8); expect(F.legN.MOM).toBe(12);
  });
  it('động lượng dương khi xu hướng kéo dài (mã đang thắng tiếp tục thắng)', () => { expect(avg(F, 'MOM')).toBeGreaterThan(0.0005); });
  it('quy mô: mã nhỏ có xu hướng tốt hơn -> yếu tố dương; mã lớn tốt hơn -> âm', () => {
    const small = market(560, { drift: (k) => 0.0004 + k * 0.00012, cap: (k) => (40 - k) * 1e12 });                  // k lớn = vốn hoá nhỏ = xu hướng tốt
    expect(avg(FM.buildFactorReturns(small.P, small.pit, OPT), 'SIZE')).toBeGreaterThan(0.0005);
    expect(avg(F, 'SIZE')).toBeLessThan(-0.0005);                                                                     // mặc định: mã lớn (k nhỏ) xu hướng tốt hơn
  });
  it('giá trị (P/B thấp) và chất lượng (ROE cao) cùng quy tắc dấu', () => {
    expect(avg(F, 'VALUE')).toBeGreaterThan(0.0005); expect(avg(F, 'QUAL')).toBeGreaterThan(0.0005);                 // mặc định: mã k nhỏ có P/B thấp, ROE cao và xu hướng tốt
    const rev = market(560, { pb: (k) => 5 - k * 0.05, roe: (k) => 0.05 + k * 0.003 });
    const G = FM.buildFactorReturns(rev.P, rev.pit, OPT);
    expect(avg(G, 'VALUE')).toBeLessThan(-0.0005); expect(avg(G, 'QUAL')).toBeLessThan(-0.0005);
  });
  it('biến động thấp: mã ít dao động có xu hướng tốt hơn -> yếu tố dương', () => {
    const m = market(560, { vol: (k) => 0.006 + k * 0.0005, drift: (k) => 0.0030 - k * 0.00010 });
    expect(avg(FM.buildFactorReturns(m.P, m.pit, OPT), 'LVOL')).toBeGreaterThan(0.0003);
  });
  it('yếu tố thị trường = VN-Index trừ lãi suất tiền mặt theo ngày', () => {
    const t = 300, ix = P.index.VNINDEX, rfd = Math.pow(1.03, 1 / 252) - 1;
    expect(F.series.MKT[t]).toBeCloseTo(ix[t] / ix[t - 1] - 1 - rfd, 12);
  });
  it('không nhìn trước: đổi lợi suất SAU ngày 400 không làm đổi yếu tố trước đó', () => {
    const stocks = {}, common = noise(7, 560);
    for (let k = 0; k < 40; k++) {
      const e = noise(100 + k, 560), beta = 0.6 + (k % 5) * 0.2;
      stocks['S' + String(k + 1).padStart(2, '0')] = { ret: (t) => (t > 400 && k === 0 ? 0.05 : 0.0030 - k * 0.00014 + beta * 0.006 * common[t] + 0.012 * e[t]), p0: 20 + k, val: 30000 };
    }
    const { rows, dates } = makeRows(560, stocks);
    const P2 = BtPanel.build(rows, [indexRow('VNINDEX', dates, (t) => 0.0004 + 0.006 * common[t])]);
    const F2 = FM.buildFactorReturns(P2, pit, OPT);
    const lastSig = SB.signalDays(P, 'M', 0, 399).slice(-1)[0];
    let compared = 0;
    for (let d = 0; d <= lastSig; d++) { const a = F.series.MOM[d], b = F2.series.MOM[d]; if (a === a) { expect(b).toBeCloseTo(a, 10); compared++; } }
    expect(compared).toBeGreaterThan(20);
  });
  it('thiếu bản chụp số liệu cơ bản thì các yếu tố cần nó không dựng, yếu tố còn lại vẫn có', () => {
    const G = FM.buildFactorReturns(P, [], OPT);
    expect(Array.from(G.series.SIZE).filter((x) => x === x).length).toBe(0);
    expect(Array.from(G.series.MOM).filter((x) => x === x).length).toBeGreaterThan(200);
  });
});

describe('curves: đường tích luỹ từng yếu tố', () => {
  it('bắt đầu từ 1, lấy mẫu theo bước và luôn gồm phiên cuối', () => {
    const { P, pit } = market(400), F = FM.buildFactorReturns(P, pit, OPT), c = FM.curves(F, P.dates, 5);
    expect(c.dates.length).toBeGreaterThan(40); expect(c.dates[c.dates.length - 1]).toBe(P.dates[P.T - 1]);
    Object.keys(c.series).forEach((key) => expect(c.series[key].length).toBe(c.dates.length));
    expect(c.series.MOM[0]).toBeGreaterThan(0.9); expect(c.series.MOM[0]).toBeLessThan(1.1);
    const prod = Array.from(F.series.MKT).slice(F.first).reduce((a, r) => (r === r ? a * (1 + r) : a), 1);
    expect(c.series.MKT[c.series.MKT.length - 1]).toBeCloseTo(prod, 4);
  });
});

describe('portfolioReturns / perf', () => {
  const { P } = market(300);
  it('lợi suất theo tỷ trọng, phần tiền mặt hưởng lãi suất, mã vắng ngày được bỏ qua', () => {
    const a = P.sIndex.S01, b = P.sIndex.S02, rfd = Math.pow(1.03, 1 / 252) - 1;
    const pr = FM.portfolioReturns(P, { S01: 0.5, S02: 0.3 }, 100, 140, 0.03);
    expect(pr.symbols).toEqual(['S01', 'S02']); expect(pr.wsum).toBeCloseTo(0.8, 12);
    expect(pr.ret[5]).toBeCloseTo(0.5 * P.ret[a][105] + 0.3 * P.ret[b][105] + 0.2 * rfd, 9);
    expect(FM.portfolioReturns(P, { KHONGCO: 1 }, 100, 140, 0.03).symbols).toEqual([]);
  });
  it('perf: lợi suất năm, biến động, sụt giảm', () => {
    const r = new Float64Array(252).fill(0.001); r[100] = -0.1;
    const p = FM.perf(r);
    expect(p.maxDD).toBeLessThan(-0.09); expect(p.annVol).toBeGreaterThan(0.1); expect(p.n).toBe(252);
  });
});

describe('analyze và exposures', () => {
  const { P, pit } = market(620, { cap: (k) => (1 + ((k * 7) % 40)) * 1e12, pb: (k) => 1 + ((k * 11) % 40) * 0.05, roe: (k) => 0.05 + ((k * 13) % 40) * 0.004, vol: (k) => 0.006 + ((k * 17) % 40) * 0.0003 });
  const F = FM.buildFactorReturns(P, pit, OPT);
  const tops = {}; for (let k = 1; k <= 10; k++) tops['S' + String(k).padStart(2, '0')] = 0.1;
  const all = {}; for (let k = 1; k <= 40; k++) all['S' + String(k).padStart(2, '0')] = 1 / 40;
  it('danh mục các mã xu hướng mạnh nhất: hệ số động lượng dương và có ý nghĩa; có diễn giải bằng lời', () => {
    const r = FM.analyze(P, pit, tops, { window: 300, keys: ['MKT', 'MOM'] }, F);
    expect(r.ok).toBe(true);
    const mom = r.contrib.find((c) => c.key === 'MOM'), mk = r.contrib.find((c) => c.key === 'MKT');
    expect(mom.beta).toBeGreaterThan(0); expect(mom.sig).toBe(true); expect(mk.beta).toBeGreaterThan(0);
    expect(r.n).toBeGreaterThan(200); expect(r.r2).toBeGreaterThan(0.3);
    expect(r.contrib[0].contribAnn).toBeCloseTo(r.contrib[0].beta * r.contrib[0].meanFactorAnn, 12);
    const text = FM.narrate(r).join(' ');
    expect(text).toMatch(/Beta thị trường/); expect(text).toMatch(/Động lượng/); expect(text).toMatch(/Alpha/);
  });
  it('rổ đều toàn vũ trụ: beta thị trường quanh 1, hệ số hữu hạn, VIF hữu hạn', () => {
    const r = FM.analyze(P, pit, all, { window: 300 }, F);
    expect(r.ok).toBe(true); expect(r.keys.length).toBe(6);
    const mk = r.contrib.find((c) => c.key === 'MKT'); expect(mk.beta).toBeGreaterThan(0.6); expect(mk.beta).toBeLessThan(1.6);
    r.contrib.forEach((c) => { expect(Number.isFinite(c.beta)).toBe(true); expect(Number.isFinite(c.vif)).toBe(true); });
    expect(r.factorPerf.length).toBe(6);
  });
  it('báo lỗi rõ ràng: không có mã trong kho, hoặc quá ít phiên chung', () => {
    expect(FM.analyze(P, pit, { ABC: 1 }, { window: 300 }, F).ok).toBe(false);
    const few = FM.analyze(P, pit, tops, { window: 60 }, F);
    expect(few.ok).toBe(false); expect(few.reason).toMatch(/ít nhất 100/);
  });
  it('exposures: mã xu hướng mạnh nhất có phân vị động lượng cao; phân vị quy mô theo đúng vốn hoá bản chụp', () => {
    const t = P.T - 1, e = FM.exposures(P, pit, { S01: 0.5, S02: 0.5 }, t, { minHistory: 60 });
    const get = (k) => e.rows.find((r) => r.key === k);
    expect(get('MOM').pct).toBeGreaterThan(0.8); expect(e.universe).toBeGreaterThanOrEqual(30); expect(get('MOM').coverage).toBeCloseTo(1, 9);
    // S01 (k = 0) có vốn hoá nhỏ nhất (1 nghìn tỷ, 0 mã nhỏ hơn), S02 (k = 1) có 8 nghìn tỷ (7 mã nhỏ hơn): phân vị trung bình = (0 + 7/40) / 2 = 0,0875
    // phân vị THÔ theo vốn hoá = 0,0875; yếu tố "quy mô nhỏ" có rổ mua là vốn hoá THẤP nên phân vị được lật: nghiêng mạnh về mã nhỏ = 1 - 0,0875 (cao hơn luôn nghĩa là nghiêng về phía mua)
    expect(get('SIZE').pct).toBeCloseTo(0.9125, 9); expect(get('SIZE').z).toBeGreaterThan(0);
    // biến động thấp cũng có rổ mua là giá trị thấp: mã có xu hướng mạnh (biến động thấp hơn hay cao hơn) phải đi ngược phân vị biến động thô
    expect(get('LVOL').pct).toBeGreaterThanOrEqual(0); expect(get('LVOL').pct).toBeLessThanOrEqual(1);
  });
  it('exposures: thiếu bản chụp cơ bản thì các yếu tố cần nó báo rõ chứ không bịa', () => {
    const e = FM.exposures(P, [], { S01: 1 }, P.T - 1, { minHistory: 60 });
    expect(e.rows.find((r) => r.key === 'SIZE').pct).toBeNull(); expect(e.rows.find((r) => r.key === 'SIZE').note).toMatch(/số liệu cơ bản/);
    expect(e.rows.find((r) => r.key === 'MOM').pct).not.toBeNull();
  });
});
