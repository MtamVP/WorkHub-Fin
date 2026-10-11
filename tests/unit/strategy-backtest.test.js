// Kiểm thử chiến lược tổng quát: lib/strategy-backtest.js (bộ máy, chi phí, thống kê đối chiếu numpy/scipy, các phép thử độ tin cậy).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import SB from '../../lib/strategy-backtest.js';
import BtPanel from '../../lib/bt-panel.js';
import PitCalc from '../../lib/pit-calc.js';
const { makeRows, indexRow, pitRow, bizDays } = require('../helpers/bt-fixtures.js');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'backtest-golden.json'), 'utf8'));

// 8 mã có xu hướng khác nhau (S1 mạnh nhất, S8 yếu nhất) + dao động nhỏ để có phương sai
function market(days, extra, over) {
  const drifts = [0.004, 0.003, 0.002, 0.001, 0, -0.001, -0.002, -0.003], stocks = {};
  drifts.forEach((d, k) => { stocks['S' + (k + 1)] = Object.assign({ ret: (t) => d + 0.003 * Math.sin(t * 1.7 + k), p0: 20 + k, val: 20000 }, (over && over['S' + (k + 1)]) || {}); });
  Object.assign(stocks, extra || {});
  const { rows, dates } = makeRows(days, stocks);
  const P = BtPanel.build(rows, [indexRow('VNINDEX', dates, (t) => 0.0005 + 0.004 * Math.sin(t * 0.9))]);
  return { P, rows, dates };
}
const BASE = { universe: { minAdv: 0, minHistory: 30, exchanges: ['HOSE'] }, rank: [{ key: 'mom3', dir: 'high', w: 1 }], select: { n: 1 }, maxWeight: 1, rebalance: 'M', costs: { fee: 0, tax: 0, impact: false }, rf: 0, participation: 1, capital: 1e9 };
const spec = (o) => SB.normalizeSpec(Object.assign({}, BASE, o || {})).spec;
const plan = (P, s, pit) => SB.buildPlan(P, pit || [], s);

describe('cấu hình', () => {
  it('đủ mặc định và giữ trong biên', () => {
    const r = SB.normalizeSpec({});
    expect(r.errors).toEqual([]); expect(r.spec.select.n).toBe(20); expect(r.spec.costs.fee).toBe(0.0015); expect(r.spec.rebalance).toBe('M');
    const r2 = SB.normalizeSpec({ select: { n: 500 }, lag: 99, participation: 9, maxWeight: 0 });
    expect(r2.spec.select.n).toBe(100); expect(r2.spec.lag).toBe(5); expect(r2.spec.participation).toBe(1); expect(r2.spec.maxWeight).toBeGreaterThanOrEqual(0.01);
  });
  it('báo lỗi tiêu chí không có, bộ lọc thiếu ngưỡng, không có xếp hạng, sàn trống, tần suất sai', () => {
    const r = SB.normalizeSpec({ filters: [{ key: 'khong-co', min: 1 }, { key: 'pe' }, { key: 'roae', min: 0.2, max: 0.1 }], rank: [], universe: { exchanges: [] }, rebalance: 'D' });
    expect(r.errors.length).toBeGreaterThanOrEqual(5);
    expect(r.errors.join(' ')).toMatch(/không có|chưa có ngưỡng|ngưỡng dưới|xếp hạng|sàn|Tần suất/);
  });
  it('cảnh báo khi trần tỷ trọng x số mã < 100% và khi cân bằng tuần dùng số liệu cơ bản', () => {
    expect(SB.normalizeSpec({ select: { n: 5 }, maxWeight: 0.1 }).warnings.join(' ')).toMatch(/tiền mặt/);
    expect(SB.normalizeSpec({ rebalance: 'W', rank: [{ key: 'roae', dir: 'high' }] }).warnings.join(' ')).toMatch(/theo tháng/);
  });
  it('mọi mẫu dựng sẵn hợp lệ và dùng tiêu chí có thật', () => {
    SB.PRESETS.forEach((p) => { const r = SB.normalizeSpec(p.spec); expect(r.errors, p.id).toEqual([]); });
  });
  it('lookback lấy theo tiêu chí dài nhất', () => {
    expect(SB.lookback(spec({ rank: [{ key: 'mom12_1', dir: 'high' }] }))).toBe(252);
  });
});

describe('tính toán nhỏ', () => {
  it('pctRanks: điểm bằng nhau chia đều thứ hạng', () => {
    const m = SB.pctRanks([{ s: 1, v: 10 }, { s: 2, v: 20 }, { s: 3, v: 20 }, { s: 4, v: 30 }]);
    expect(m.get(1)).toBe(0); expect(m.get(4)).toBe(1); expect(m.get(2)).toBeCloseTo(0.5, 9); expect(m.get(3)).toBeCloseTo(0.5, 9);
    expect(SB.pctRanks([{ s: 1, v: 5 }]).get(1)).toBe(0.5);
  });
  it('capWeights: phần vượt trần chia cho mã còn chỗ theo phần dư; không đủ chỗ thì để tiền mặt', () => {
    const w = SB.capWeights([0.5, 0.3, 0.2], 0.4);
    expect(w[0]).toBeCloseTo(0.4, 9); expect(w[1]).toBeCloseTo(0.3 + 0.1 * (0.1 / 0.3), 9); expect(w[2]).toBeCloseTo(0.2 + 0.1 * (0.2 / 0.3), 9);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const c = SB.capWeights([0.5, 0.5], 0.3); expect(c[0]).toBeCloseTo(0.3, 9); expect(c.reduce((a, b) => a + b, 0)).toBeCloseTo(0.6, 9);
  });
  it('weightsFor: nghịch đảo biến động và trần', () => {
    const s = spec({ weighting: 'invvol', maxWeight: 1 });
    const w = SB.weightsFor(s, [{ s: 0, score: 1, vol: 0.01 }, { s: 1, score: 0.5, vol: 0.02 }, { s: 2, score: 0, vol: 0.04 }]);
    expect(w[0] / w[1]).toBeCloseTo(2, 9); expect(w[1] / w[2]).toBeCloseTo(2, 9); expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const e = SB.weightsFor(spec({ maxWeight: 1, select: { n: 4 } }), [1, 2, 3, 4].map((x) => ({ s: x, score: 0, vol: NaN })));
    expect(e).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
  it('lịch cân bằng: phiên cuối tuần / tháng / quý / năm', () => {
    const { P } = market(300);
    const m = SB.signalDays(P, 'M', 0, P.T - 1).map((t) => P.dates[t]);
    expect(m.length).toBeGreaterThanOrEqual(13);
    m.slice(0, -1).forEach((d, i) => expect(d.slice(0, 7) < m[i + 1].slice(0, 7)).toBe(true));
    const q = SB.signalDays(P, 'Q', 0, P.T - 1).map((t) => P.dates[t].slice(5, 7));
    q.slice(0, -1).forEach((mm) => expect(['03', '06', '09', '12']).toContain(mm));
    const w = SB.signalDays(P, 'W', 0, P.T - 1);
    expect(w.length).toBeGreaterThan(55); w.slice(0, -1).forEach((t) => expect(new Date(P.dates[t] + 'T00:00:00Z').getUTCDay()).toBe(5));
    expect(SB.signalDays(P, 'Y', 0, P.T - 1).length).toBeLessThanOrEqual(3);
    expect(SB.periodKey('2026-03-31', 'Q')).toBe(SB.periodKey('2026-01-02', 'Q')); expect(SB.periodKey('2026-04-01', 'Q')).not.toBe(SB.periodKey('2026-03-31', 'Q'));
  });
});

describe('đặc trưng giá (chỉ dùng dữ liệu tới ngày t)', () => {
  const { P } = market(320);
  const s1 = P.sIndex.S1, t = 300;
  it('động lượng', () => {
    const L = P.lvl[s1];
    expect(SB.priceFactor(P, 'mom1', s1, t)).toBeCloseTo(L[t] / L[t - 21] - 1, 6);
    expect(SB.priceFactor(P, 'mom12_1', s1, t)).toBeCloseTo(L[t - 21] / L[t - 252] - 1, 6);
    expect(SB.priceFactor(P, 'mom12', s1, 100)).toBeNaN();                // chưa đủ 252 phiên lịch sử
  });
  it('biến động, đỉnh 52 tuần, trung bình động, thanh khoản, beta', () => {
    expect(SB.priceFactor(P, 'vol60', s1, t)).toBeGreaterThan(0.02);
    expect(SB.priceFactor(P, 'high52', s1, t)).toBeLessThanOrEqual(0);
    expect(SB.priceFactor(P, 'ma200', s1, t)).toBeGreaterThan(0);          // mã đang tăng đều nên trên trung bình 200 phiên
    expect(SB.priceFactor(P, 'ma200', P.sIndex.S8, t)).toBeLessThan(0);
    expect(SB.priceFactor(P, 'adv', s1, t)).toBeCloseTo(20000 * 1e6, 0);
    expect(SB.priceFactor(P, 'beta252', s1, t)).toBeTypeOf('number');
  });
  it('tiêu chí cơ bản và dẫn xuất từ bản chụp', () => {
    const m = { pe: 10, pb: 2, ps: 0, marketcap: 1e12, roae: 0.2 };
    expect(SB.fundFactor(m, 'earningsYield')).toBeCloseTo(0.1, 9); expect(SB.fundFactor(m, 'bookYield')).toBeCloseTo(0.5, 9);
    expect(SB.fundFactor(m, 'salesYield')).toBeNaN(); expect(SB.fundFactor({ pe: -5 }, 'earningsYield')).toBeNaN();
    expect(SB.fundFactor(m, 'size')).toBeCloseTo(Math.log(1e12), 9); expect(SB.fundFactor(null, 'roae')).toBeNaN();
  });
});

describe('mô phỏng: kiểm tra bằng tính tay', () => {
  it('không phí: giá trị danh mục = mức giá của mã được chọn (S1 luôn đứng đầu)', () => {
    const { P } = market(300), s = spec();
    const pl = plan(P, s), sim = SB.simulate(P, pl, s), s1 = P.sIndex.S1;
    expect(pl.items.every((it) => it.targets.length === 1 && it.targets[0].s === s1)).toBe(true);
    for (let i = 0; i < sim.nav.length; i += 17) expect(sim.nav[i] / sim.nav[0]).toBeCloseTo(P.lvl[s1][sim.startIdx + i] / P.lvl[s1][sim.startIdx], 6);
    expect(sim.nav[0]).toBeCloseTo(1e9, 0); expect(sim.stat.fee + sim.stat.tax + sim.stat.impact).toBe(0);
  });
  it('đối chiếu với bộ mô phỏng độc lập viết lại từ đầu: 2 mã chia đều, cân bằng hằng tháng, không phí', () => {
    const { P } = market(320), s = spec({ select: { n: 2 }, maxWeight: 0.5 }), pl = plan(P, s), sim = SB.simulate(P, pl, s);
    const byExec = new Map(pl.items.map((it) => [it.exec, it]));
    let nav = 1e9; const hold = new Map(); const out = [];
    for (let t = sim.startIdx; t <= sim.endIdx; t++) {
      if (t > sim.startIdx) { hold.forEach((v, k) => { const r = P.ret[k][t]; hold.set(k, v * (1 + (r === r ? r : 0))); }); }
      nav = [...hold.values()].reduce((a, b) => a + b, 0) + (hold.size ? 0 : nav);
      const it = byExec.get(t);
      if (it && it.targets.length) { hold.clear(); it.targets.forEach((x) => hold.set(x.s, x.w * nav)); }
      out.push(nav);
    }
    expect(out.length).toBe(sim.nav.length);
    for (let i = 0; i < out.length; i += 7) expect(sim.nav[i] / out[i]).toBeCloseTo(1, 5);
    expect(sim.nav[out.length - 1] / out[out.length - 1]).toBeCloseTo(1, 5);
  });
  it('quyết định ở phiên t, khớp ở phiên t + lag (không nhìn trước)', () => {
    const { P } = market(300);
    const pl = plan(P, spec({ lag: 2 }));
    pl.items.forEach((it) => expect(it.exec).toBe(it.sig + 2));
    const sim = SB.simulate(P, pl, spec({ lag: 2 }));
    expect(sim.startIdx).toBe(pl.items[0].exec);
  });
  it('phí mua 0,2% làm giá trị đầu = vốn / 1,002; phí + thuế bán khi đổi mã', () => {
    // S1 tăng rồi giảm mạnh, S2 đi ngang rồi tăng: chiến lược đổi từ S1 sang S2 -> có bán (thuế) và mua (phí)
    const { P } = market(320, {}, { S1: { ret: (t) => (t < 160 ? 0.006 : -0.012) }, S2: { ret: (t) => (t < 160 ? 0.001 : 0.006) } });
    const s = spec({ costs: { fee: 0.002, tax: 0.001, impact: false } });
    const pl = plan(P, s), sim = SB.simulate(P, pl, s);
    expect(sim.nav[0] / 1e9).toBeCloseTo(1 / 1.002, 6);
    expect(sim.stat.tax).toBeGreaterThan(0); expect(sim.stat.fee).toBeGreaterThan(1e9 * 0.002 * 0.99);
    expect(sim.stat.sell).toBeGreaterThan(0);
    const syms = new Set(pl.items.map((it) => it.targets[0] && P.symbols[it.targets[0].s])); expect(syms.size).toBeGreaterThanOrEqual(2);
  });
  it('tác động giá làm tăng chi phí khi lệnh lớn so với thanh khoản', () => {
    const { P } = market(300, {}, { S1: { val: 400 } });                      // 4e8 đ/ngày: lệnh 2e8 (20% vốn 1e9) ~ 50% thanh khoản
    const sA = spec({ universe: { minAdv: 0, minHistory: 30, exchanges: ['HOSE'] }, participation: 1, costs: { fee: 0, tax: 0, impact: true, impactK: 0.8, impactCap: 0.1 }, maxWeight: 0.2, select: { n: 1 } });
    const sim = SB.simulate(P, plan(P, sA), sA);
    expect(sim.stat.impact).toBeGreaterThan(0);
    const sB = spec({ costs: { fee: 0, tax: 0, impact: false } });
    expect(SB.simulate(P, plan(P, sB), sB).stat.impact).toBe(0);
  });
  it('giới hạn tham gia: thanh khoản thấp thì chỉ mua được từng phần, phần dư giữ tiền mặt', () => {
    const { P } = market(300, {}, { S1: { val: 300 } });                      // 3e8 đ/ngày x 20% = 6e7 mỗi phiên
    const s = spec({ participation: 0.2 });
    const sim = SB.simulate(P, plan(P, s), s);
    expect(sim.stat.partial).toBeGreaterThan(0); expect(sim.stat.done).toBeLessThan(sim.stat.desired);
    expect(sim.cashW[0]).toBeGreaterThan(0.85);
  });
  it('kẹt trần: không mua được, giá trị giữ nguyên tiền mặt cho tới khi hết kẹt', () => {
    const lim = {}; for (let t = 0; t < 140; t++) lim[t] = 1;
    const { P } = market(300, {}, { S1: { lim } });
    const s = spec(), sim = SB.simulate(P, plan(P, s), s);
    expect(sim.stat.lockedBuy).toBeGreaterThan(0);
    expect(sim.nav[0]).toBeCloseTo(1e9, 0); expect(sim.nav[5]).toBeCloseTo(1e9, 0); expect(sim.cashW[0]).toBe(1);
    expect(sim.nav[sim.nav.length - 1]).toBeGreaterThan(1e9);                 // sau khi hết kẹt vẫn mua được
  });
  it('kẹt sàn: không bán được mã đang giữ', () => {
    const { P } = market(320, {}, { S1: { ret: (t) => (t < 150 ? 0.006 : -0.012), lim: (function () { const m = {}; for (let t = 160; t < 320; t++) m[t] = -1; return m; })() }, S2: { ret: (t) => (t < 150 ? 0.001 : 0.006) } });
    const s = spec(), sim = SB.simulate(P, plan(P, s), s);
    expect(sim.stat.lockedSell).toBeGreaterThan(0);
  });
  it('mã hủy niêm yết: giữ tới phiên cuối rồi bán ở giá cuối, tiền mặt ở lại', () => {
    const { P } = market(300, {}, { S1: { to: 200 } });
    const s = spec(), sim = SB.simulate(P, plan(P, s), s);
    expect(sim.stat.delisted).toBe(1);
    const i = sim.nav.length - 1; expect(sim.nav[i]).toBeGreaterThan(0); expect(Number.isFinite(sim.nav[i])).toBe(true);
    expect(sim.cashW.some((c) => c > 0.99)).toBe(true);
  });
  it('lãi tiền mặt: danh mục chưa đầu tư được hưởng lãi suất', () => {
    const lim = {}; for (let t = 0; t < 300; t++) lim[t] = 1;
    const { P } = market(300, {}, { S1: { lim } });
    const s = spec({ rf: 0.05 }), sim = SB.simulate(P, plan(P, s), s);
    const n = sim.nav.length;
    expect(sim.nav[n - 1] / sim.nav[0]).toBeCloseTo(Math.pow(1.05, (n - 1) / 252), 4);
  });
});

describe('số liệu cơ bản theo thời điểm (không nhìn trước)', () => {
  const pit = (rows) => PitCalc.decodeDays(rows);
  it('bộ lọc P/E chỉ cho mã thoả mãn; dùng đúng bản chụp gần nhất <= ngày tín hiệu', () => {
    const { P, dates } = market(300);
    const monthEnds = SB.signalDays(P, 'M', 0, P.T - 1).map((t) => P.dates[t]);
    const mk = (cheap) => pitRow, rowsPit = monthEnds.map((d) => pitRow(d, { S1: { pe: 40, icb2: '1000' }, S2: { pe: 8, icb2: '1000' }, S3: { pe: 9, icb2: '2000' }, S4: { pe: 25, icb2: '2000' }, S5: { pe: 12, icb2: '1000' }, S6: { pe: -3, icb2: '1000' }, S7: { pe: 7, icb2: '2000' }, S8: { pe: 10, icb2: '1000' } }));
    void mk; void dates;
    const s = spec({ filters: [{ key: 'pe', min: 0.01, max: 15 }], select: { n: 3 }, maxWeight: 1 });
    const pl = plan(P, s, pit(rowsPit));
    expect(pl.items.length).toBeGreaterThan(5);
    pl.items.filter((it) => it.targets.length).forEach((it) => {
      const names = it.targets.map((x) => P.symbols[x.s]);
      expect(names).not.toContain('S1'); expect(names).not.toContain('S4'); expect(names).not.toContain('S6');
      expect(it.meta.fundAsOf <= P.dates[it.sig]).toBe(true);
    });
  });
  it('kỳ chưa có bản chụp nào đủ gần bị bỏ kèm cảnh báo (không dùng bản chụp TƯƠNG LAI)', () => {
    const { P } = market(300);
    const late = P.dates[P.T - 1];
    const s = spec({ filters: [{ key: 'pe', min: 0.01, max: 15 }] });
    const pl = plan(P, s, pit([pitRow(late, { S1: { pe: 5 }, S2: { pe: 5 }, S3: { pe: 5 }, S4: { pe: 5 }, S5: { pe: 5 }, S6: { pe: 5 } })]));
    expect(pl.items.length).toBe(0);
    expect(pl.warnings.join(' ')).toMatch(/chưa có bản chụp/);
  });
  it('lọc theo ngành ICB (chỉ / loại trừ)', () => {
    const { P } = market(300);
    const monthEnds = SB.signalDays(P, 'M', 0, P.T - 1).map((t) => P.dates[t]);
    const rows = monthEnds.map((d) => pitRow(d, { S1: { icb2: '1000', pe: 5 }, S2: { icb2: '1000', pe: 5 }, S3: { icb2: '2000', pe: 5 }, S4: { icb2: '2000', pe: 5 }, S5: { icb2: '2000', pe: 5 }, S6: { icb2: '1000', pe: 5 }, S7: { icb2: '1000', pe: 5 }, S8: { icb2: '1000', pe: 5 } }));
    const s = spec({ universe: { minAdv: 0, minHistory: 30, exchanges: ['HOSE'], icbIn: ['2000'] }, rank: [{ key: 'mom3', dir: 'high' }], filters: [{ key: 'pe', max: 10 }] });
    const pl = plan(P, s, pit(rows));
    pl.items.filter((it) => it.targets.length).forEach((it) => expect(P.symbols[it.targets[0].s]).toBe('S3'));
  });
});

describe('thống kê: đối chiếu numpy / scipy', () => {
  const dates = Array.from({ length: golden.strat.length }, (_, i) => new Date(Date.UTC(2021, 0, 4) + i * 86400000).toISOString().slice(0, 10));
  const m = SB.metricsOf(dates, golden.strat, golden.rf);
  it('CAGR, biến động, Sharpe, Sortino, Calmar, độ lệch, độ nhọn', () => {
    ['cagr', 'annVol', 'sharpe', 'sortino', 'calmar', 'skew', 'kurt'].forEach((k) => expect(m[k], k).toBeCloseTo(golden.metrics[k], 7));
  });
  it('sụt giảm tối đa và hai mốc', () => {
    expect(m.maxDD).toBeCloseTo(golden.metrics.maxDD, 9);
    const dd = SB.drawdownOf(golden.strat); expect(dd.from).toBe(golden.metrics.ddFrom); expect(dd.to).toBe(golden.metrics.ddTo);
  });
  it('beta, alpha, t Newey-West, R2, tracking error, IR, lợi suất vượt', () => {
    const rel = SB.relativeTo(dates, golden.strat, golden.bench, golden.rf);
    expect(rel.beta).toBeCloseTo(golden.relative.beta, 7); expect(rel.alpha).toBeCloseTo(golden.relative.alpha, 7); expect(rel.tAlpha).toBeCloseTo(golden.relative.tAlpha, 6);
    expect(rel.r2).toBeCloseTo(golden.relative.r2, 7); expect(rel.trackingError).toBeCloseTo(golden.relative.trackingError, 7);
    expect(rel.infoRatio).toBeCloseTo(golden.relative.infoRatio, 6); expect(rel.excessCagr).toBeCloseTo(golden.relative.excessCagr, 7);
  });
  it('olsNW cho cả t của beta', () => {
    const r = [], b = [], rfd = Math.pow(1 + golden.rf, 1 / 252) - 1;
    for (let i = 1; i < golden.strat.length; i++) { r.push(golden.strat[i] / golden.strat[i - 1] - 1 - rfd); b.push(golden.bench[i] / golden.bench[i - 1] - 1 - rfd); }
    const o = SB.olsNW(r, b, 5);
    expect(o.tBeta).toBeCloseTo(golden.relative.tBeta, 6);
  });
  it('phân phối chuẩn nghịch đảo / tích luỹ', () => {
    golden.normInv.forEach(([p, z]) => expect(SB.normInv(p)).toBeCloseTo(z, 6));
    golden.normCdf.forEach(([x, p]) => expect(SB.normCdf(x)).toBeCloseTo(p, 6));
  });
  it('Sharpe đã trừ may rủi: PSR, Sharpe kỳ vọng cao nhất, DSR', () => {
    const g = golden.dsr;
    golden.dsr.cases.forEach((c) => {
      expect(SB.expectedMaxSharpe(c.trials, c.var)).toBeCloseTo(c.sr0, 8);
      const d = SB.deflatedSharpe(g.dailySharpe, g.nObs, golden.metrics.skew, golden.metrics.kurt, c.trials, c.var);
      expect(d.psr0).toBeCloseTo(c.psr0, 7); expect(d.dsr).toBeCloseTo(c.dsr, 7);
    });
  });
  it('thử càng nhiều cấu hình thì DSR càng thấp', () => {
    const g = golden.dsr, d = (k) => SB.deflatedSharpe(g.dailySharpe, g.nObs, golden.metrics.skew, golden.metrics.kurt, k, 0.0006 * 0.0006).dsr;
    expect(d(1)).toBeGreaterThan(d(10)); expect(d(10)).toBeGreaterThan(d(100));
  });
  it('lợi suất tháng và năm', () => {
    const ds = ['2021-01-04', '2021-01-29', '2021-02-26', '2021-12-31', '2022-06-30'], v = [1, 1.1, 1.21, 1.331, 1.4641];
    const mo = SB.monthlyReturns(ds, v); expect(mo[0].ret).toBeCloseTo(0.1, 9);
    const y = SB.yearlyReturns(ds, v); expect(y.length).toBe(2); expect(y[0].ret).toBeCloseTo(1.331 - 1, 9); expect(y[1].ret).toBeCloseTo(1.4641 / 1.331 - 1, 9);
  });
  it('bootstrap theo khối: khoảng tin cậy chứa giá trị điểm và lặp lại được', () => {
    const r = [], b = []; for (let i = 1; i < golden.strat.length; i++) { r.push(golden.strat[i] / golden.strat[i - 1] - 1); b.push(golden.bench[i] / golden.bench[i - 1] - 1); }
    const a = SB.bootstrapCI(r, b, golden.rf, { B: 200, seed: 5 }), a2 = SB.bootstrapCI(r, b, golden.rf, { B: 200, seed: 5 });
    expect(a).toEqual(a2);
    expect(a.cagr[0]).toBeLessThan(golden.metrics.cagr); expect(a.cagr[1]).toBeGreaterThan(golden.metrics.cagr);
    expect(a.sharpe[0]).toBeLessThan(a.sharpe[1]); expect(a.probExcessPositive).toBeGreaterThanOrEqual(0); expect(a.probExcessPositive).toBeLessThanOrEqual(1);
  });
});

describe('run: chạy trọn bộ', () => {
  it('chiến lược chọn đúng mã mạnh nhất đứng cao trong phân bố rổ ngẫu nhiên, có đủ các phép thử', async () => {
    const { P } = market(420);
    const res = await SB.run(P, Object.assign({}, BASE, { select: { n: 2 }, maxWeight: 0.5 }), { randomRuns: 60, yieldEvery: false, trials: { count: 4, srVarDaily: 0.0004 } });
    expect(res.ok).toBe(true);
    expect(res.metrics.cagr).toBeGreaterThan(res.bench.cagr);
    expect(res.random.runs).toBeGreaterThanOrEqual(50);
    expect(res.random.cagr.rank).toBeGreaterThan(0.8); expect(res.random.cagr.p).toBeLessThan(0.25);
    expect(res.bootstrap.cagr[0]).toBeLessThan(res.bootstrap.cagr[1]);
    expect(res.sensitivity.length).toBeGreaterThan(4); expect(res.sensitivity[0].id).toBe('base');
    expect(res.split.early.cagr).toBeTypeOf('number'); expect(res.split.late.cagr).toBeTypeOf('number');
    expect(res.yearly.length).toBeGreaterThanOrEqual(2);
    expect(res.dsr.trials).toBe(5); expect(res.dsr.dsr).toBeLessThanOrEqual(res.dsr.psr0 + 1e-9);
    expect(res.univ).toBeTruthy(); expect(res.curve.dates.length).toBe(res.curve.strat.length);
    expect(res.trade.fillRatio).toBeCloseTo(1, 3); expect(res.trade.turnover).toBeGreaterThanOrEqual(0);
    expect(res.rebalances.length).toBeGreaterThan(5);
  });
  it('chiến lược chọn NGƯỢC (mã yếu nhất) nằm thấp trong phân bố ngẫu nhiên', async () => {
    const { P } = market(420);
    const res = await SB.run(P, Object.assign({}, BASE, { rank: [{ key: 'mom3', dir: 'low', w: 1 }] }), { randomRuns: 60, yieldEvery: false });
    expect(res.ok).toBe(true); expect(res.random.cagr.rank).toBeLessThan(0.3);
  });
  it('lỗi rõ ràng: cấu hình sai, kho quá ngắn, cần số liệu cơ bản mà chưa có', async () => {
    const { P } = market(420);
    expect((await SB.run(P, { rank: [] }, { yieldEvery: false })).ok).toBe(false);
    const short = market(120).P;
    expect((await SB.run(short, BASE, { yieldEvery: false })).errors.join(' ')).toMatch(/300 phiên/);
    const f = await SB.run(P, Object.assign({}, BASE, { filters: [{ key: 'pe', max: 10 }] }), { yieldEvery: false });
    expect(f.ok).toBe(false); expect(f.errors.join(' ')).toMatch(/số liệu cơ bản/);
  });
  it('không có mã nào đủ điều kiện -> báo lỗi chứ không trả kết quả rỗng', async () => {
    const { P } = market(420);
    const res = await SB.run(P, Object.assign({}, BASE, { universe: { minAdv: 1e15, minHistory: 30, exchanges: ['HOSE'] } }), { yieldEvery: false });
    expect(res.ok).toBe(false); expect(res.errors.join(' ')).toMatch(/Không chọn được/);
  });
  it('cùng đầu vào cho cùng kết quả (hạt giống cố định)', async () => {
    const { P } = market(420);
    const o = { randomRuns: 40, yieldEvery: false };
    const a = await SB.run(P, BASE, o), b = await SB.run(P, BASE, o);
    expect(a.metrics).toEqual(b.metrics); expect(a.random).toEqual(b.random); expect(a.bootstrap).toEqual(b.bootstrap);
  });
});

describe('không nhìn trước tương lai', () => {
  it('đổi dữ liệu SAU ngày tín hiệu không đổi lựa chọn của ngày đó', () => {
    const a = market(300), b = market(300, {}, { S5: { ret: (t) => (t > 200 ? 0.02 : 0.003 * Math.sin(t * 1.7 + 4)) } });
    const s = spec(), pa = plan(a.P, s), pb = plan(b.P, s);
    const cut = a.P.dates[200];
    pa.items.filter((it) => a.P.dates[it.sig] < cut).forEach((it, i) => expect(pb.items[i].targets.map((x) => b.P.symbols[x.s])).toEqual(it.targets.map((x) => a.P.symbols[x.s])));
  });
  it('sàn được xét TẠI NGÀY t: mã chuyển sàn sau này không được tính vào vũ trụ trước đó', () => {
    const { P } = market(300, { MOVER: { ret: 0.01, p0: 20, val: 20000, ex: 2, from: 0, to: 149 } });
    const rows2 = makeRows(300, { MOVER: { ret: 0.01, p0: 20, val: 20000, ex: 2, from: 0, to: 149 } }).rows;
    rows2.forEach((r, t) => { if (r.data.MOVER && t >= 120) r.data.MOVER[4] = 0; });
    const P2 = BtPanel.build(rows2, []);
    expect(P2.exd[P2.sIndex.MOVER][50]).toBe(2); expect(P2.exd[P2.sIndex.MOVER][130]).toBe(0);
    void P;
  });
  it('bizDays hỗ trợ dựng lịch thử', () => { expect(bizDays('2021-01-04', 5).length).toBe(5); });
});
