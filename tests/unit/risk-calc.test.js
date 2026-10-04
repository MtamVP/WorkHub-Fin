// lib/risk-calc.js: rủi ro danh mục (tập trung, biến động, beta, VaR, sụt giảm, tương quan, kịch bản) trên chuỗi giá tổng hợp có kiểm soát.
import { describe, it, expect } from 'vitest';
import RiskCalc from '../../lib/risk-calc.js';

// Bộ sinh số giả ngẫu nhiên có hạt giống để test lặp lại được
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); }

// 300 ngày giao dịch (bỏ thứ 7/CN), kết thúc 2026-10-02
function tradingDates(n) {
  const out = [];
  let d = new Date('2026-10-02T00:00:00Z');
  while (out.length < n) { if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10)); d = new Date(d.getTime() - 86400000); }
  return out;
}
const DATES = tradingDates(300);
function walk(seed, retFn, start = 100) {
  const r = rng(seed); const out = []; let p = start;
  DATES.forEach((d, i) => { if (i > 0) p *= 1 + retFn(i, r); out.push([d, p]); });
  return out;
}

// Chỉ số: biến động ~1%/ngày. A = chỉ số (beta 1). B ≈ A (tương quan rất cao). C độc lập.
const idxRet = (() => { const r = rng(7); return DATES.map(() => 0.0003 + 0.01 * gauss(r)); })();
const noise = (seed, k) => { const r = rng(seed); return DATES.map(() => k * gauss(r)); };
const nA = noise(11, 0.0), nB = noise(12, 0.002), nC = noise(13, 0.012);
const seriesFrom = (f) => { let p = 100; return DATES.map((d, i) => { if (i > 0) p *= 1 + f(i); return [d, p]; }); };
const HIST = {
  VNINDEX: seriesFrom(i => idxRet[i]),
  FPT: seriesFrom(i => idxRet[i] + nA[i]),          // = chỉ số
  VCB: seriesFrom(i => idxRet[i] + nB[i]),          // rất giống FPT
  HPG: seriesFrom(i => nC[i]),                      // độc lập chỉ số
};
const hold = (symbol, marketValue) => ({ symbol, quantity: 100, marketValue });

describe('thống kê cơ bản', () => {
  it('stdev / covariance / correlation / percentile', () => {
    expect(RiskCalc.mean([1, 2, 3])).toBe(2);
    expect(RiskCalc.stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(RiskCalc.stdev([5])).toBe(0);
    expect(RiskCalc.correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 9);
    expect(RiskCalc.correlation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 9);
    expect(RiskCalc.correlation([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(RiskCalc.percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(RiskCalc.percentile([0, 10], 0.25)).toBeCloseTo(2.5, 9);
    expect(RiskCalc.percentile([], 0.5)).toBeNull();
  });
});

describe('drawdownOf / cumulate', () => {
  it('tìm đỉnh, đáy, ngày phục hồi và mức hiện tại', () => {
    const dd = RiskCalc.drawdownOf([100, 120, 90, 100, 130], ['a', 'b', 'c', 'd', 'e']);
    expect(dd.maxDD).toBeCloseTo(-0.25, 9);
    expect(dd.peakDate).toBe('b'); expect(dd.troughDate).toBe('c'); expect(dd.recoveredDate).toBe('e');
    expect(dd.current).toBe(0);
  });
  it('chưa phục hồi -> recoveredDate null, current âm', () => {
    const dd = RiskCalc.drawdownOf([100, 120, 90, 100], ['a', 'b', 'c', 'd']);
    expect(dd.recoveredDate).toBeNull();
    expect(dd.current).toBeCloseTo(100 / 120 - 1, 9);
  });
  it('chuỗi chỉ tăng -> không có sụt giảm', () => {
    const dd = RiskCalc.drawdownOf([1, 2, 3], ['a', 'b', 'c']);
    expect(dd.maxDD).toBe(0); expect(dd.peakDate).toBeNull();
  });
  it('cumulate nối lợi suất, null đứng yên', () => {
    expect(RiskCalc.cumulate([0.1, null, -0.1])).toEqual([1, 1.1, 1.1, 1.1 * 0.9].map(x => expect.closeTo(x, 9)));
  });
});

describe('adjustSeries', () => {
  const s = [['2026-05-20', 110], ['2026-05-21', 110], ['2026-05-22', 100], ['2026-05-25', 101]];
  it('cổ phiếu thưởng 10%: giá trước ngày không hưởng quyền chia 1,1 -> không còn cú rơi giả', () => {
    const adj = RiskCalc.adjustSeries(s, [{ symbol: 'HPG', kind: 'stock_dividend', exDate: '2026-05-22', ratio: 10 }], 'HPG');
    expect(adj[0][1]).toBeCloseTo(100, 9); expect(adj[1][1]).toBeCloseTo(100, 9);
    expect(adj[2][1]).toBe(100); expect(adj[3][1]).toBe(101);
    expect(s[0][1]).toBe(110);   // không sửa bản gốc
  });
  it('cổ tức tiền: điều chỉnh theo tổng lợi suất (giá liền trước x (1 - dps/giá))', () => {
    const adj = RiskCalc.adjustSeries(s, [{ symbol: 'HPG', kind: 'cash_dividend', exDate: '2026-05-22', dps: 10 }], 'HPG');
    expect(adj[1][1]).toBeCloseTo(110 * (1 - 10 / 110), 9);   // = 100
    expect(adj[2][1]).toBe(100);
  });
  it('sự kiện của mã khác hoặc ngoài chuỗi không ảnh hưởng; nhiều sự kiện nhân cộng dồn', () => {
    expect(RiskCalc.adjustSeries(s, [{ symbol: 'ABC', kind: 'bonus', exDate: '2026-05-22', ratio: 10 }], 'HPG')[0][1]).toBe(110);
    const two = RiskCalc.adjustSeries(s, [{ symbol: 'HPG', kind: 'bonus', exDate: '2026-05-22', ratio: 10 }, { symbol: 'HPG', kind: 'bonus', exDate: '2026-05-21', ratio: 10 }], 'HPG');
    expect(two[0][1]).toBeCloseTo(110 / 1.21, 9);
    expect(two[1][1]).toBeCloseTo(110 / 1.1, 9);
  });
});

describe('alignSeries', () => {
  it('căn theo lịch VN-Index, điền tiếp tối đa 5 ngày rồi để trống', () => {
    const h = { VNINDEX: DATES.slice(-30).map((d, i) => [d, 1000 + i]), AAA: [[DATES[DATES.length - 30], 50], [DATES[DATES.length - 29], 51]] };
    const al = RiskCalc.alignSeries(h, ['AAA'], { windowDays: 400 });
    expect(al.dates.length).toBe(30);
    expect(al.closes.AAA[0]).toBe(50);
    expect(al.closes.AAA[2]).toBe(51);          // điền tiếp
    expect(al.closes.AAA[29]).toBeNull();        // đã quá 5 ngày không có giá
  });
  it('thiếu VN-Index -> rỗng', () => {
    expect(RiskCalc.alignSeries({}, ['A'], {}).dates).toEqual([]);
  });
});

describe('actualDrawdown (từ NAV đã chụp)', () => {
  const nav = (i, v, c) => ({ snapshot_date: `2026-08-${String(i + 1).padStart(2, '0')}`, nav: v, net_contributed: c });
  it('bỏ ngày nạp vốn: nạp thêm không bị coi là lãi, tụt giá vẫn thấy', () => {
    const h = [];
    for (let i = 0; i < 12; i++) h.push(nav(i, 100e6 + i * 1e6, 100e6));
    h.push(nav(12, 200e6, 200e6));                         // nạp 100tr: NAV nhảy nhưng không phải lãi
    for (let i = 13; i < 25; i++) h.push(nav(i, 200e6 - (i - 12) * 4e6, 200e6));   // rồi giảm đều
    const a = RiskCalc.actualDrawdown(h);
    expect(a.maxDD).toBeLessThan(-0.15);
    expect(a.current).toBeLessThan(0);
    expect(a.points).toBe(25);
  });
  it('quá ít điểm -> null', () => { expect(RiskCalc.actualDrawdown([nav(0, 1, 1), nav(1, 2, 1)])).toBeNull(); });
});

describe('analyze: tập trung (không cần lịch sử giá)', () => {
  const base = { holdings: [hold('FPT', 600e6), hold('VCB', 300e6), hold('HPG', 100e6)], cash: 0, debt: 0, histories: {} };
  it('tỷ trọng, HHI, mã hiệu dụng, top 3, ngành; lý do no-history', () => {
    const r = RiskCalc.analyze(base);
    expect(r.ok).toBe(false); expect(r.reason).toBe('no-history');
    expect(r.symbols.map(s => s.symbol)).toEqual(['FPT', 'VCB', 'HPG']);
    expect(r.symbols[0].weightPct).toBeCloseTo(60, 9);
    expect(r.concentration.hhi).toBeCloseTo(0.36 + 0.09 + 0.01, 9);
    expect(r.concentration.effectiveN).toBeCloseTo(1 / 0.46, 9);
    expect(r.concentration.top3Pct).toBeCloseTo(100, 9);
    expect(r.sectors.map(s => s.sector)).toEqual(['Công nghệ', 'Ngân hàng', 'Thép & vật liệu']);
  });
  it('cảnh báo vượt ngưỡng mã và ngành, mức độ theo độ vượt', () => {
    const r = RiskCalc.analyze(base);
    const w = r.warnings.find(x => x.code === 'single:FPT');
    expect(w.level).toBe('high');            // 60% >= 25 + 15
    expect(w.text).toContain('FPT chiếm 60%');
    const r2 = RiskCalc.analyze({ holdings: [hold('VCB', 300e6), hold('TCB', 300e6), hold('FPT', 400e6)], cash: 0, debt: 0, histories: {} }, { singleLimit: 45, sectorLimit: 40 });
    expect(r2.warnings.some(x => x.code === 'sector:Ngân hàng')).toBe(true);
    expect(r2.warnings.some(x => x.code.startsWith('single:'))).toBe(false);
  });
  it('danh mục rỗng / ít mã / đòn bẩy / tiền mặt cao', () => {
    expect(RiskCalc.analyze({ holdings: [], cash: 5, debt: 0, histories: {} }).reason).toBe('empty');
    const few = RiskCalc.analyze({ holdings: [hold('FPT', 100e6), hold('VCB', 100e6)], cash: 0, debt: 0, histories: {} });
    expect(few.warnings.some(x => x.code === 'few-holdings')).toBe(true);
    const lev = RiskCalc.analyze({ holdings: [hold('FPT', 100e6), hold('VCB', 100e6), hold('HPG', 100e6)], cash: 0, debt: 100e6, histories: {} });
    expect(lev.leverage).toBeCloseTo(1.5, 9);
    expect(lev.warnings.find(x => x.code === 'leverage').level).toBe('high');
    const cashy = RiskCalc.analyze({ holdings: [hold('FPT', 100e6), hold('VCB', 100e6), hold('HPG', 100e6)], cash: 400e6, debt: 0, histories: {} });
    expect(cashy.warnings.some(x => x.code === 'high-cash')).toBe(true);
  });
  it('sắp xếp cảnh báo: nghiêm trọng trước', () => {
    const r = RiskCalc.analyze({ holdings: [hold('FPT', 700e6), hold('VCB', 200e6), hold('HPG', 100e6)], cash: 600e6, debt: 0, histories: {} });
    const order = r.warnings.map(x => x.level);
    expect(order).toEqual([...order].sort((a, b) => ({ high: 0, med: 1, low: 2 })[a] - ({ high: 0, med: 1, low: 2 })[b]));
  });
});

describe('analyze: thống kê trên lịch sử giá', () => {
  it('danh mục 1 mã trùng chỉ số: beta 1, tương quan 1, đóng góp rủi ro 100%, biến động bằng chỉ số', () => {
    const r = RiskCalc.analyze({ holdings: [hold('FPT', 100e6)], cash: 0, debt: 0, histories: { VNINDEX: HIST.VNINDEX, FPT: HIST.FPT } });
    expect(r.ok).toBe(true);
    expect(r.portfolio.beta).toBeCloseTo(1, 6);
    expect(r.portfolio.correlation).toBeCloseTo(1, 6);
    expect(r.symbols[0].riskSharePct).toBeCloseTo(100, 6);
    expect(r.portfolio.annVol).toBeCloseTo(r.portfolio.benchAnnVol, 6);
    expect(r.portfolio.obs).toBeGreaterThan(200);
    // cổ phiếu độc nhất: VaR >= 1 lần độ lệch chuẩn ngày (đuôi 5%) và CVaR >= VaR
    expect(r.portfolio.varPct).toBeGreaterThan(r.portfolio.annVol / Math.sqrt(252));
    expect(r.portfolio.cvarPct).toBeGreaterThanOrEqual(r.portfolio.varPct);
    expect(r.portfolio.varVnd).toBeCloseTo(r.portfolio.varPct / 100 * r.nav, 3);
  });
  it('đa dạng hoá làm giảm biến động: gộp mã độc lập thấp hơn mã riêng lẻ; đóng góp rủi ro cộng đủ 100%', () => {
    const r = RiskCalc.analyze({ holdings: [hold('FPT', 50e6), hold('HPG', 50e6)], cash: 0, debt: 0, histories: HIST });
    const fpt = r.symbols.find(s => s.symbol === 'FPT'), hpg = r.symbols.find(s => s.symbol === 'HPG');
    expect(r.portfolio.annVol).toBeLessThan(Math.max(fpt.annVol, hpg.annVol));
    expect(fpt.riskSharePct + hpg.riskSharePct).toBeCloseTo(100, 6);
    expect(r.portfolio.beta).toBeCloseTo(0.5 * fpt.beta + 0.5 * hpg.beta, 6);
  });
  it('tiền mặt làm giảm biến động theo tỷ lệ và beta', () => {
    const full = RiskCalc.analyze({ holdings: [hold('FPT', 100e6)], cash: 0, debt: 0, histories: HIST });
    const half = RiskCalc.analyze({ holdings: [hold('FPT', 100e6)], cash: 100e6, debt: 0, histories: HIST });
    expect(half.portfolio.annVol).toBeCloseTo(full.portfolio.annVol / 2, 6);
    expect(half.portfolio.beta).toBeCloseTo(0.5, 6);
    expect(half.cashPct).toBeCloseTo(50, 9);
  });
  it('đòn bẩy nhân đôi biến động', () => {
    const lev = RiskCalc.analyze({ holdings: [hold('FPT', 200e6)], cash: 0, debt: 100e6, histories: HIST });
    const one = RiskCalc.analyze({ holdings: [hold('FPT', 100e6)], cash: 0, debt: 0, histories: HIST });
    expect(lev.portfolio.annVol).toBeCloseTo(one.portfolio.annVol * 2, 6);
  });
  it('phát hiện cặp tương quan cao; ma trận đối xứng, đường chéo = 1', () => {
    const r = RiskCalc.analyze({ holdings: [hold('FPT', 400e6), hold('VCB', 400e6), hold('HPG', 200e6)], cash: 0, debt: 0, histories: HIST });
    const c = r.correlation;
    expect(c.symbols).toEqual(['FPT', 'VCB', 'HPG']);
    c.matrix.forEach((row, i) => { expect(row[i]).toBe(1); row.forEach((v, j) => expect(v).toBeCloseTo(c.matrix[j][i], 9)); });
    expect(c.pairs[0]).toMatchObject({ a: 'FPT', b: 'VCB' });
    expect(c.pairs[0].corr).toBeGreaterThan(0.9);
    expect(c.pairs[0].weightPct).toBeCloseTo(80, 9);
    expect(r.warnings.some(w => w.code === 'corr:FPT:VCB')).toBe(true);
  });
  it('kịch bản VN-Index -10%: danh mục beta 1 không tiền mặt giảm khoảng 10%, có tiền mặt thì ít hơn', () => {
    const r = RiskCalc.analyze({ holdings: [hold('FPT', 100e6)], cash: 100e6, debt: 0, histories: HIST });
    const s10 = r.stress.find(x => x.indexMovePct === -10);
    expect(s10.portfolioPct).toBeCloseTo(-5, 1);
    expect(s10.vnd).toBeCloseTo(-10e6, -3);
    expect(r.stress.map(x => x.indexMovePct)).toEqual([-5, -10, -15, -20]);
  });
  it('sụt giảm giả định: có đáy, đỉnh, chuỗi underwater cùng độ dài với ngày', () => {
    const r = RiskCalc.analyze({ holdings: [hold('HPG', 100e6)], cash: 0, debt: 0, histories: HIST });
    expect(r.portfolio.maxDD).toBeLessThan(0);
    expect(r.portfolio.maxDDPeak < r.portfolio.maxDDTrough).toBe(true);
    expect(r.portfolio.ddSeries.length).toBe(r.coverage.days);
    expect(Math.min(...r.portfolio.ddSeries.map(x => x.portfolio))).toBeCloseTo(r.portfolio.maxDD, 6);
  });
  it('mã thiếu lịch sử bị loại khỏi thống kê và được báo; phần còn lại vẫn tính', () => {
    const r = RiskCalc.analyze({ holdings: [hold('FPT', 100e6), hold('XXX', 100e6)], cash: 0, debt: 0, histories: { VNINDEX: HIST.VNINDEX, FPT: HIST.FPT } });
    expect(r.ok).toBe(true);
    expect(r.coverage.missing).toEqual(['XXX']);
    expect(r.symbols.find(s => s.symbol === 'XXX').missing).toBe(true);
    expect(r.warnings.some(w => w.code === 'coverage')).toBe(true);
  });
  it('điều chỉnh theo cổ phiếu thưởng loại bỏ cú rơi giả khỏi biến động', () => {
    // HPG: có cú rơi -9,09% đúng ngày 2026-08-03 do chia thưởng 10%
    const raw = HIST.HPG.map(p => p.slice());
    const cut = raw.findIndex(p => p[0] >= '2026-08-03');
    for (let i = 0; i < cut; i++) raw[i][1] *= 1.1;
    const hist = { VNINDEX: HIST.VNINDEX, HPG: raw };
    const noAdj = RiskCalc.analyze({ holdings: [hold('HPG', 100e6)], cash: 0, debt: 0, histories: hist });
    const adj = RiskCalc.analyze({ holdings: [hold('HPG', 100e6)], cash: 0, debt: 0, histories: hist, events: [{ symbol: 'HPG', kind: 'bonus', exDate: raw[cut][0], ratio: 10 }] });
    expect(noAdj.portfolio.worstDayPct).toBeLessThan(adj.portfolio.worstDayPct - 3);
    expect(adj.coverage.adjusted).toBe(true);
    expect(adj.portfolio.annVol).toBeLessThan(noAdj.portfolio.annVol);
  });
  it('lịch sử quá ngắn -> không tính thống kê nhưng vẫn có tập trung', () => {
    const short = { VNINDEX: HIST.VNINDEX.slice(-20), FPT: HIST.FPT.slice(-20) };
    const r = RiskCalc.analyze({ holdings: [hold('FPT', 100e6), hold('VCB', 100e6)], cash: 0, debt: 0, histories: short });
    expect(r.ok).toBe(false); expect(r.reason).toBe('no-history');
    expect(r.concentration.count).toBe(2);
  });
  it('cửa sổ: 180 ngày cho ít quan sát hơn 365 ngày', () => {
    const a = RiskCalc.analyze({ holdings: [hold('FPT', 100e6)], cash: 0, debt: 0, histories: HIST }, { windowDays: 180 });
    const b = RiskCalc.analyze({ holdings: [hold('FPT', 100e6)], cash: 0, debt: 0, histories: HIST }, { windowDays: 365 });
    expect(a.portfolio.obs).toBeLessThan(b.portfolio.obs);
    expect(a.portfolio.obs).toBeGreaterThan(100);
  });
});

describe('liquidity: bán hết mất bao lâu', () => {
  const vol = (n, v) => Array.from({ length: n }, (_, i) => ['2026-08-' + String(i + 1).padStart(2, '0'), v]);
  const H = [{ symbol: 'FPT', quantity: 1000000, value: 100e9 }, { symbol: 'ILL', quantity: 500000, value: 5e9 }, { symbol: 'NEW', quantity: 100, value: 1e6 }];
  const V = { FPT: vol(60, 2000000), ILL: vol(60, 10000), NEW: vol(3, 100) };
  it('ngày bán hết = số cổ phiếu / (tỷ lệ × khối lượng bình quân); xếp từ khó bán nhất; thiếu dữ liệu được báo', () => {
    const r = RiskCalc.liquidity(H, V, { rate: 0.2 });
    expect(r.rows.map(x => x.symbol)).toEqual(['ILL', 'FPT']);
    const fpt = r.rows.find(x => x.symbol === 'FPT'), ill = r.rows.find(x => x.symbol === 'ILL');
    expect(fpt.days).toBeCloseTo(1000000 / (0.2 * 2000000), 9);            // 2,5 phiên
    expect(ill.days).toBeCloseTo(500000 / (0.2 * 10000), 9);               // 250 phiên
    expect(fpt.level).toBe('ok'); expect(ill.level).toBe('high');
    expect(fpt.shareOfAdvPct).toBeCloseTo(50, 9);
    expect(r.missing).toEqual(['NEW']);
    expect(r.worst.symbol).toBe('ILL'); expect(r.daysToExitAll).toBeCloseTo(250, 9);
    expect(r.coveragePct).toBeLessThan(100);
  });
  it('tỷ lệ giá trị bán xong sau d phiên (bán đồng thời); đơn điệu tăng', () => {
    const r = RiskCalc.liquidity(H, V, { rate: 0.2 });
    const pct = Object.fromEntries(r.cover.map(c => [c.days, c.pct]));
    // sau 1 phiên: FPT bán 400k/1M = 40% = 40 tỷ; ILL bán 2k/500k = 0,4% = 0,02 tỷ  -> (40 + 0,02) / 105
    expect(pct[1]).toBeCloseTo((40e9 + 0.02e9) / 105e9 * 100, 6);
    expect(pct[3]).toBeGreaterThan(pct[2]); expect(pct[2]).toBeGreaterThan(pct[1]);
    expect(pct[3]).toBeCloseTo((100e9 + 0.06e9) / 105e9 * 100, 6);          // FPT bán hết sau 2,5 phiên
  });
  it('tỷ lệ tham gia thấp hơn làm ngày bán dài hơn; bỏ phiên khối lượng 0; danh sách rỗng', () => {
    const slow = RiskCalc.liquidity(H, V, { rate: 0.1 });
    expect(slow.rows.find(x => x.symbol === 'FPT').days).toBeCloseTo(5, 9);
    const withZero = RiskCalc.liquidity([H[0]], { FPT: vol(30, 2000000).concat(vol(10, 0)) }, { rate: 0.2 });
    expect(withZero.rows[0].adv).toBe(2000000);
    expect(RiskCalc.liquidity([], {}).rows).toEqual([]);
  });
});

describe('historicalScenarios: chuỗi phiên tệ nhất của VN-Index lặp lại', () => {
  const dates = tradingDates(120, '2026-10-02');
  const mk = (f) => { let p = 100; return dates.map((d, i) => { if (i) p *= 1 + f(i); return [d, p]; }); };
  // chỉ số: bình thường +0,1%/ngày, riêng ngày 60 giảm 6%, các ngày 80-84 giảm 2%/ngày
  const idx = mk(i => i === 60 ? -0.06 : (i >= 80 && i <= 84 ? -0.02 : 0.001));
  const A = mk(i => i === 60 ? -0.09 : (i >= 80 && i <= 84 ? -0.03 : 0.001));      // nhạy gấp 1,5 lần
  const B = mk(i => i === 60 ? -0.03 : 0.001);                                       // phòng thủ
  it('tìm đúng cửa sổ tệ nhất theo chỉ số và dùng lợi suất THẬT của từng mã trong cửa sổ đó', () => {
    const r = RiskCalc.historicalScenarios({ holdings: [{ symbol: 'AAA', value: 60e6 }, { symbol: 'BBB', value: 40e6 }], nav: 100e6, histories: { VNINDEX: idx, AAA: A, BBB: B } }, { windowDays: 400 });
    const day = r.find(x => x.windowDays === 1);
    expect(day.to).toBe(dates[60]);
    expect(day.benchPct).toBeCloseTo(-6, 6);
    expect(day.bySymbol.find(x => x.symbol === 'AAA').pct).toBeCloseTo(-9, 6);
    expect(day.portfolioPct).toBeCloseTo(0.6 * -9 + 0.4 * -3, 6);
    expect(day.vnd).toBeCloseTo(100e6 * day.portfolioPct / 100, 3);
    const week = r.find(x => x.windowDays === 5);
    expect(week.bySymbol[0].symbol).toBe('AAA');                                   // thua nhiều nhất xếp đầu
    expect(week.portfolioPct).toBeLessThan(0);
  });
  it('có tiền mặt thì mẫu số là NAV nên tổn thất % nhỏ hơn; mã thiếu giá lúc đó coi như đi cùng chỉ số và được đánh dấu', () => {
    const r = RiskCalc.historicalScenarios({ holdings: [{ symbol: 'AAA', value: 50e6 }, { symbol: 'NEW', value: 50e6 }], nav: 200e6, histories: { VNINDEX: idx, AAA: A, NEW: A.slice(-5) } }, { windowDays: 400 });
    const day = r.find(x => x.windowDays === 1);
    expect(day.estimatedCount).toBe(1);
    expect(day.bySymbol.find(x => x.symbol === 'NEW')).toMatchObject({ estimated: true });
    expect(day.bySymbol.find(x => x.symbol === 'NEW').pct).toBeCloseTo(-6, 6);
    expect(day.portfolioPct).toBeCloseTo((50e6 * -0.09 + 50e6 * -0.06) / 200e6 * 100, 6);
  });
  it('chuỗi chỉ tăng hoặc thiếu dữ liệu -> không có kịch bản', () => {
    const up = mk(() => 0.001);
    expect(RiskCalc.historicalScenarios({ holdings: [{ symbol: 'AAA', value: 1e6 }], nav: 1e6, histories: { VNINDEX: up, AAA: up } })).toEqual([]);
    expect(RiskCalc.historicalScenarios({ holdings: [], nav: 1, histories: {} })).toEqual([]);
  });
});

describe('customStress: kịch bản tự đặt', () => {
  const r = { nav: 500e6, symbols: [
    { symbol: 'VCB', sector: 'Ngân hàng', value: 100e6, betaAdj: 1.0 }, { symbol: 'TCB', sector: 'Ngân hàng', value: 100e6, betaAdj: 1.2 },
    { symbol: 'FPT', sector: 'Công nghệ', value: 200e6, betaAdj: 0.8 }, { symbol: 'XXX', sector: 'Chưa phân ngành', value: 50e6 },
  ] };
  it('cú sốc chung dùng beta điều chỉnh; mã chưa có beta dùng 1 và được đánh dấu', () => {
    const s = RiskCalc.customStress(r, { index: -10 });
    const by = Object.fromEntries(s.rows.map(x => [x.symbol, x]));
    expect(by.TCB.pct).toBeCloseTo(-12, 9); expect(by.FPT.pct).toBeCloseTo(-8, 9);
    expect(by.XXX).toMatchObject({ pct: -10, defaultBeta: true, source: 'beta' });
    expect(s.totalVnd).toBeCloseTo(-10e6 - 12e6 - 16e6 - 5e6, 3);
    expect(s.portfolioPct).toBeCloseTo(-43 / 500 * 100, 9);
    expect(s.navAfter).toBeCloseTo(500e6 - 43e6, 3);
  });
  it('ưu tiên: cú sốc theo mã > theo ngành > beta × chung', () => {
    const s = RiskCalc.customStress(r, { index: -10, sectors: { 'Ngân hàng': -20 }, symbols: { TCB: -35 } });
    const by = Object.fromEntries(s.rows.map(x => [x.symbol, x]));
    expect(by.VCB).toMatchObject({ pct: -20, source: 'sector' });
    expect(by.TCB).toMatchObject({ pct: -35, source: 'symbol' });
    expect(by.FPT.source).toBe('beta');
    expect(s.worst.symbol).toBe('TCB');                                            // −35tr: lớn nhất tính theo VND
  });
  it('bỏ qua giá trị rỗng/không phải số; NAV âm sau cú sốc được cảnh báo', () => {
    expect(RiskCalc.customStress(r, { index: '', sectors: { 'Ngân hàng': '' }, symbols: { FPT: 'abc' } }).totalVnd).toBe(0);
    expect(RiskCalc.customStress({ nav: 10e6, cash: 0, symbols: [{ symbol: 'A', sector: 'x', value: 100e6, betaAdj: 1 }] }, { index: -50 }).negativeNav).toBe(true);
  });
});
