// lib/vb-backtest.js: bảng điểm độ chính xác -- chỉ dùng dữ liệu có sẵn tại thời điểm T, thống kê IC (Spearman) có khoảng tin cậy theo ngày, phân nhóm, từng phương pháp.
import { describe, it, expect } from 'vitest';
import B from '../../lib/vb-backtest.js';

describe('thống kê cơ bản', () => {
  it('Spearman xử lý hạng bằng nhau; tương quan hoàn hảo và nghịch', () => {
    expect(B.spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 9);
    expect(B.spearman([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBeCloseTo(-1, 9);
    expect(B.spearman([1, 2, 2, 3], [1, 2, 2, 3])).toBeCloseTo(1, 9);
    expect(B.spearman([1, 2], [1, 2])).toBeNull(); expect(B.spearman([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull();
  });
  it('phân vị tuyến tính và trung vị', () => { expect(B.quantile([1, 2, 3, 4, 5], 0.5)).toBe(3); expect(B.median([5, 1, 3])).toBe(3); expect(B.quantile([], 0.5)).toBeNull(); });
  it('bộ sinh số ngẫu nhiên có hạt giống: lặp lại được', () => { const a = B.mulberry32(5), b = B.mulberry32(5); expect([a(), a(), a()]).toEqual([b(), b(), b()]); });
});

describe('dữ liệu tại thời điểm T (không nhìn trước)', () => {
  const rows = [{ fiscalDate: '2021-12-31', v: 1 }, { fiscalDate: '2022-12-31', v: 2 }, { fiscalDate: '2023-12-31', v: 3 }];
  it('báo cáo năm chỉ có sau độ trễ công bố', () => {
    expect(B.pitRows(rows, '2023-03-31', 'annual').map((r) => r.v)).toEqual([1]);      // FY2022 chưa công bố (cần 95 ngày: tới 06/04)
    expect(B.pitRows(rows, '2023-04-10', 'annual').map((r) => r.v)).toEqual([1, 2]);
    expect(B.pitRows(rows, '2024-01-15', 'annual').map((r) => r.v)).toEqual([1, 2]);   // FY2023 cần tới 05/04/2024
  });
  it('báo cáo quý có độ trễ ngắn hơn', () => { expect(B.pitRows([{ fiscalDate: '2023-06-30' }], '2023-08-20', 'quarter')).toHaveLength(1); expect(B.pitRows([{ fiscalDate: '2023-06-30' }], '2023-08-10', 'quarter')).toHaveLength(0); });
  it('chuỗi bội số cắt đúng đến ngày T', () => { expect(B.pitSeries([1, 2, 3, 4], ['2023-01-01', '2023-01-02', '2023-01-03', '2023-01-04'], '2023-01-03')).toEqual([1, 2, 3]); expect(B.pitSeries(null, null, 'x')).toBeNull(); });
});

describe('runSymbol với bộ máy giả', () => {
  const dates = Array.from({ length: 700 }, (_, i) => new Date(Date.UTC(2022, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const closes = dates.map((_, i) => 100 + i * 0.1);
  const data = { symbol: 'TST', form: 'NON_FINANCE', candles: { t: dates, c: closes }, annualRows: [{ fiscalDate: '2021-12-31', itemCode: 1 }, { fiscalDate: '2022-12-31', itemCode: 1 }], quarterRows: [], ratioSeries: { pe: closes.map(() => 10) }, ratioDates: { pe: dates } };
  const idx = { t: dates, c: dates.map((_, i) => 1000 + i) };
  const seen = [];
  const engine = { analyze: (ctx) => { seen.push(ctx); return { ok: true, shares: 1e6, form: 'NON_FINANCE', periods: [1, 2, 3], process: { archetype: { key: 'MATURE' } }, synthesis: { ok: true, fair: { base: ctx.price * 1.2 }, methods: [{ key: 'dcf', base: ctx.price * 1.3 }, { key: 'x', base: 0 }] } }; } };
  const obs = B.runSymbol(data, engine, idx, { warmup: 100, step: 100, shares: 1e6 });
  it('mỗi thời điểm: giá tại T, chỉ báo cáo đã công bố, chuỗi bội số đến T', () => {
    const c = seen[0], T = dates[100];
    expect(c.price).toBe(closes[100]); expect(c.shares).toBe(1e6); expect(c.now).toBe(T);
    expect(c.annualRows.every((r) => Date.parse(r.fiscalDate) + 95 * 86400000 <= Date.parse(T))).toBe(true);
    expect(c.ratioSeries.pe).toHaveLength(101);
  });
  it('lợi suất 6 và 12 tháng sau, vượt chỉ số; thiếu kỳ hạn thì null', () => {
    const o = obs[0];
    expect(o.r6).toBeCloseTo(closes[226] / closes[100] - 1, 9); expect(o.r12).toBeCloseTo(closes[352] / closes[100] - 1, 9);
    expect(o.xr6).toBeCloseTo(o.r6 - (idx.c[226] / idx.c[100] - 1), 9);
    const last = obs[obs.length - 1]; expect(last.r12).toBeNull();
  });
  it('ghi giá trị hợp lý, phương pháp (bỏ giá trị không dương) và mô hình kinh doanh', () => {
    const o = obs[0]; expect(o.fair).toBeCloseTo(closes[100] * 1.2, 9); expect(Object.keys(o.methods)).toEqual(['dcf']); expect(o.archetype).toBe('MATURE'); expect(o.symbol).toBe('TST');
  });
  it('engine lỗi hoặc không có giá trị thì bỏ qua quan sát, không vỡ', () => {
    expect(B.runSymbol(data, { analyze: () => { throw new Error('x'); } }, idx, { warmup: 100, step: 100, shares: 1e6 })).toEqual([]);
    expect(B.runSymbol(data, { analyze: () => ({ ok: false }) }, idx, { warmup: 100, step: 100, shares: 1e6 })).toEqual([]);
    expect(B.runSymbol(data, { analyze: () => ({ ok: false }) }, idx, { warmup: 100, step: 100 })).toEqual([]);      // không xác định được số cổ phiếu
  });
});

describe('chấm điểm', () => {
  // tín hiệu thật sự dự báo lợi suất vượt: giá trị hợp lý càng cao hơn giá thì lợi suất vượt càng lớn (cộng nhiễu có hạt giống)
  const rnd = B.mulberry32(99), obs = [];
  for (let d = 0; d < 40; d++) for (let s = 0; s < 12; s++) {
    const sig = (rnd() - 0.5) * 0.8, price = 100, x = sig * 0.5 + (rnd() - 0.5) * 0.2;
    obs.push({ symbol: 'S' + s, date: '2023-' + String(1 + Math.floor(d / 4)).padStart(2, '0') + '-' + String(1 + (d % 4) * 7).padStart(2, '0'), price: price, fair: price * Math.exp(sig), r6: x + 0.02, xr6: x, fr6: price * (1 + x + 0.02), r12: null, xr12: null, fr12: null, methods: { dcf: price * Math.exp(sig), noise: price * Math.exp((rnd() - 0.5) * 0.8) }, archetype: s % 2 ? 'GROWTH' : 'MATURE' });
  }
  const h = B.scoreHorizon(obs, 'r6', { boot: 120 });
  it('tín hiệu có dự báo: IC dương, khoảng tin cậy loại trừ 0, nhóm rẻ nhất vượt nhóm đắt nhất', () => {
    expect(h.n).toBe(480); expect(h.overall.ic).toBeGreaterThan(0.5); expect(h.overall.lo).toBeGreaterThan(0.3); expect(h.overall.hi).toBeLessThanOrEqual(1);
    expect(h.buckets).toHaveLength(5); expect(h.buckets[4].avgExcess).toBeGreaterThan(h.buckets[0].avgExcess); expect(h.buckets[0].sHigh).toBeLessThanOrEqual(h.buckets[1].sLow + 1e-9);
    expect(h.calibration.slope).toBeGreaterThan(0.2);
  });
  it('từng phương pháp: phương pháp thật có IC cao, nhiễu không có ý nghĩa', () => {
    const dcf = h.methods.find((m) => m.key === 'dcf'), nz = h.methods.find((m) => m.key === 'noise');
    expect(dcf.ic).toBeGreaterThan(0.5); expect(Math.abs(nz.ic)).toBeLessThan(0.2); expect(nz.icLo).toBeLessThan(0.1);
    expect(dcf.medianAbsLogErr).toBeGreaterThan(0);
  });
  it('theo mô hình kinh doanh có số quan sát và IC', () => { expect(h.archetypes.map((a) => a.key).sort()).toEqual(['GROWTH', 'MATURE']); h.archetypes.forEach((a) => { expect(a.n).toBe(240); expect(a.ic).toBeGreaterThan(0.4); }); });
  it('kỳ hạn chưa có kết quả hoặc quá ít mẫu: báo thiếu dữ liệu, không bịa số', () => {
    expect(B.scoreHorizon(obs, 'r12', {}).insufficient).toBe(true); expect(B.scoreHorizon(obs.slice(0, 10), 'r6', {}).insufficient).toBe(true);
  });
  it('scorecard tổng hợp: số mã, số ngày, khoảng thời gian và các giới hạn bắt buộc', () => {
    const sc = B.scorecard(obs, { generatedAt: '2026-10-06', universe: ['A'] }, { boot: 30 });
    expect(sc.nSymbols).toBe(12); expect(sc.nObs).toBe(480); expect(sc.range.from <= sc.range.to).toBe(true); expect(sc.horizons.r6.n).toBe(480); expect(sc.horizons.r12.insufficient).toBe(true);
    expect(sc.limits.length).toBeGreaterThanOrEqual(5); expect(sc.limits.join(' ')).toMatch(/người sống sót/);
  });
  it('chia hai nửa thời gian: nửa đầu và nửa sau đều có IC (phép thử ngoài mẫu)', () => {
    const sc = B.scorecard(obs, {}, { boot: 30, splitDate: '2023-05-31' });
    expect(sc.splits.splitDate).toBe('2023-05-31'); expect(sc.splits.train.r6.n + sc.splits.test.r6.n).toBe(480);
    expect(sc.splits.train.r6.ic).toBeGreaterThan(0.3); expect(sc.splits.test.r6.ic).toBeGreaterThan(0.3); expect(sc.splits.train.r12.insufficient).toBe(true);
  });
  it('ma trận mô hình x phương pháp có IC cho từng cặp đủ mẫu', () => {
    expect(h.matrix.GROWTH.dcf.n).toBe(240); expect(h.matrix.MATURE.dcf.ic).toBeGreaterThan(0.4); expect(h.matrix.MATURE.noise).toBeDefined();
  });
  it('bootstrap có hạt giống: cùng đầu vào cho cùng khoảng tin cậy', () => {
    const p = obs.slice(0, 200).map((x) => ({ date: x.date, s: Math.log(x.fair / x.price), y: x.xr6 }));
    expect(B.icWithCI(p, 100, 5)).toEqual(B.icWithCI(p, 100, 5));
  });
});
