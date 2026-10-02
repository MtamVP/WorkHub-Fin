import { describe, it, expect } from 'vitest';
const V = require('../../lib/valuation-calc.js');

// Hồ sơ mẫu: vốn điều lệ 1.000 (triệu), VCSH 2.000, LNST 150, giá 15.000 -> EPS 1.500, BVPS 20.000, P/E 10, P/B 0,75
const base = { symbol: 'abc', year: 2026, v1: 1000, v2: 2000, v3: 150, v6: 15000, targetPE: 12, targetPB: 1.2 };

describe('normalize', () => {
  it('đọc hàng mới (v1/v2/v3/v6) và đổi mã sang chữ hoa', () => {
    const n = V.normalize(base);
    expect(n.symbol).toBe('ABC');
    expect([n.charter, n.equity, n.lnst, n.price]).toEqual([1000, 2000, 150, 15000]);
    expect(n.scenarios.base.pe).toBe(12);
    expect(n.sector).toBe('general');
    expect(n.legacy).toBe(false);
  });
  it('đọc hàng cũ chỉ có snake_case', () => {
    const n = V.normalize({ symbol: 'SHS', year: 2027, charter_capital: 235555, equity: 244334, lnst: 324234, price: 543343, target_pe: 3245, target_pb: 324 });
    expect([n.charter, n.equity, n.lnst, n.price]).toEqual([235555, 244334, 324234, 543343]);
    expect(n.scenarios.base.pb).toBe(324);
    expect(n.legacy).toBe(true);
  });
  it('ô trống là null, số 0 là 0; khoá lạ/sector sai về mặc định', () => {
    const n = V.normalize({ v1: 1000, v3: 0, shares: '', sector: 'xxx', unit: 'yyy', dps: 0 });
    expect(n.lnst).toBe(0);
    expect(n.shares).toBeNull();
    expect(n.dps).toBe(0);
    expect(n.sector).toBe('general');
    expect(n.unit).toBe('billion');
    expect(V.normalize(null).symbol).toBe('');
  });
});

describe('metrics: chỉ số cơ bản', () => {
  it('EPS/BVPS theo vốn điều lệ (mệnh giá 10.000), P/E, P/B khớp công thức cũ', () => {
    const m = V.metrics(V.normalize(base));
    expect(m.eps).toBeCloseTo(1500, 6);
    expect(m.bvps).toBeCloseTo(20000, 6);
    expect(m.pe).toBeCloseTo(10, 6);
    expect(m.pb).toBeCloseTo(0.75, 6);
    expect(m.basis).toBe('charter');
  });
  it('dùng số cổ phiếu thực khi có (đổi đơn vị triệu -> đồng)', () => {
    // LNST 150 triệu = 150.000.000đ chia 100.000 cổ phiếu = 1.500đ; VCSH 2.000 triệu / 100.000 = 20.000đ
    const m = V.metrics(V.normalize(Object.assign({}, base, { shares: 100000, unit: 'million' })));
    expect(m.eps).toBeCloseTo(1500, 6);
    expect(m.bvps).toBeCloseTo(20000, 6);
    expect(m.basis).toBe('shares');
    // số cổ phiếu ít hơn (có cổ phiếu quỹ) -> EPS cao hơn
    const m2 = V.metrics(V.normalize(Object.assign({}, base, { shares: 90000, unit: 'million' })));
    expect(m2.eps).toBeGreaterThan(1500);
  });
  it('lỗ: P/E null và cờ lossMaking; vốn chủ âm: P/B null', () => {
    const m = V.metrics(V.normalize(Object.assign({}, base, { v3: -50 })));
    expect(m.pe).toBeNull();
    expect(m.lossMaking).toBe(true);
    const m2 = V.metrics(V.normalize(Object.assign({}, base, { v2: -10 })));
    expect(m2.pb).toBeNull();
  });
  it('thiếu vốn điều lệ và số cổ phiếu -> chưa tính được', () => {
    const m = V.metrics(V.normalize({ v3: 10, v6: 100 }));
    expect(m.eps).toBeNull();
    expect(m.pe).toBeNull();
  });
  it('ROE dùng vốn chủ bình quân khi có năm trước, ROA/biên LN/đòn bẩy khi có dữ liệu', () => {
    const prev = V.normalize({ v1: 1000, v2: 1800, v3: 120, assets: 9000, revenue: 900 });
    const n = V.normalize(Object.assign({}, base, { assets: 10000, revenue: 1000 }));
    const m = V.metrics(n, { prev });
    expect(m.roe).toBeCloseTo(150 / 1900 * 100, 6);
    expect(m.roeBasis).toBe('avg');
    expect(m.roa).toBeCloseTo(150 / 9500 * 100, 6);
    expect(m.netMargin).toBeCloseTo(15, 6);
    expect(m.equityMultiplier).toBeCloseTo(5, 6);
    expect(m.ps).toBeCloseTo(15000 / (1000 / 1000 * 10000), 6);
    expect(V.metrics(n).roeBasis).toBe('end');
  });
  it('tăng trưởng LNST/EPS/BVPS so với năm trước và PEG', () => {
    const prev = V.normalize({ v1: 1000, v2: 1800, v3: 100 });
    const m = V.metrics(V.normalize(base), { prev });
    expect(m.lnstGrowth).toBeCloseTo(50, 6);
    expect(m.epsGrowth).toBeCloseTo(50, 6);
    expect(m.bvpsGrowth).toBeCloseTo((20000 - 18000) / 18000 * 100, 6);
    expect(m.peg).toBeCloseTo(10 / 50, 6);
  });
  it('năm trước lỗ -> không tính tăng trưởng (tránh số vô nghĩa)', () => {
    const prev = V.normalize({ v1: 1000, v2: 1800, v3: -20 });
    const m = V.metrics(V.normalize(base), { prev });
    expect(m.lnstGrowth).toBeNull();
    expect(m.epsGrowth).toBeNull();
    expect(m.peg).toBeNull();
  });
  it('cổ tức: tỷ suất và tỷ lệ chi trả', () => {
    const m = V.metrics(V.normalize(Object.assign({}, base, { dps: 750 })));
    expect(m.divYield).toBeCloseTo(5, 6);
    expect(m.payout).toBeCloseTo(50, 6);
  });
});

describe('TTM theo quý', () => {
  const q = (year, quarter, lnst, revenue) => ({ year, quarter, lnst, revenue });
  it('cộng 4 quý liền nhau gần nhất, tính EPS/P/E TTM', () => {
    const quarters = [q(2025, 4, 40), q(2026, 1, 30), q(2026, 2, 35), q(2026, 3, 45), q(2025, 3, 10)];
    const t = V.metrics(V.normalize(base), { quarters }).ttm;
    expect(t.lnst).toBe(150);
    expect(t.from).toBe('Q4/2025');
    expect(t.to).toBe('Q3/2026');
    expect(t.eps).toBeCloseTo(1500, 6);
    expect(t.pe).toBeCloseTo(10, 6);
    expect(t.revenue).toBeNull();
  });
  it('null khi chưa đủ 4 quý hoặc thiếu 1 quý ở giữa; bỏ qua dòng trùng', () => {
    expect(V.ttmFrom([q(2026, 1, 1), q(2026, 2, 1), q(2026, 3, 1)], V.normalize(base))).toBeNull();
    expect(V.ttmFrom([q(2026, 4, 1), q(2026, 3, 1), q(2026, 1, 1), q(2025, 4, 1)], V.normalize(base))).toBeNull();
    expect(V.ttmFrom([q(2026, 1, 1), q(2026, 1, 1), q(2026, 2, 1), q(2026, 3, 1)], V.normalize(base))).toBeNull();
  });
  it('doanh thu TTM chỉ có khi đủ doanh thu cả 4 quý', () => {
    const quarters = [q(2026, 1, 10, 100), q(2026, 2, 10, 100), q(2026, 3, 10, 100), q(2026, 4, 10, 100)];
    expect(V.ttmFrom(quarters, V.normalize(base)).revenue).toBe(400);
  });
});

describe('valuations: 3 kịch bản và giá hợp lý', () => {
  const run = (data, ctx) => { const n = V.normalize(data); const m = V.metrics(n, ctx); return V.valuations(n, m); };

  it('không nhập tăng trưởng: giá cơ sở = bội số x EPS/BVPS hiện tại, fair = trung bình P/E và P/B (đúng công thức cũ)', () => {
    const v = run(base);
    const pe = v.methods.find(x => x.key === 'pe'), pb = v.methods.find(x => x.key === 'pb');
    expect(pe.base).toBeCloseTo(18000, 6); // 12 x 1.500
    expect(pb.base).toBeCloseTo(24000, 6); // 1,2 x 20.000
    expect(v.fair).toBeCloseTo(21000, 6);
  });
  it('kịch bản xấu/tốt để trống -> suy ra +/-20% bội số', () => {
    const v = run(base);
    const pe = v.methods.find(x => x.key === 'pe');
    expect(pe.bear).toBeCloseTo(9.6 * 1500, 6);
    expect(pe.bull).toBeCloseTo(14.4 * 1500, 6);
    expect(v.scenarios.bear.auto.pe).toBe(true);
    expect(v.fairBear).toBeLessThan(v.fair);
    expect(v.fairBull).toBeGreaterThan(v.fair);
  });
  it('kịch bản nhập tay thắng mặc định', () => {
    const v = run(Object.assign({}, base, { targetPEBear: 8, targetPEBull: 15 }));
    const pe = v.methods.find(x => x.key === 'pe');
    expect(pe.bear).toBeCloseTo(12000, 6);
    expect(pe.bull).toBeCloseTo(22500, 6);
    expect(v.scenarios.bear.auto.pe).toBe(false);
  });
  it('có tăng trưởng: EPS dự phóng và BVPS dự phóng (giữ lại lợi nhuận trừ cổ tức)', () => {
    const v = run(Object.assign({}, base, { growthBase: 20, dps: 500 }));
    const pe = v.methods.find(x => x.key === 'pe'), pb = v.methods.find(x => x.key === 'pb');
    expect(pe.base).toBeCloseTo(12 * 1500 * 1.2, 6);
    expect(pb.base).toBeCloseTo(1.2 * (20000 + 1800 - 500), 6);
    // bear = tăng trưởng 20 - 10 = 10%
    expect(pe.bear).toBeCloseTo(9.6 * 1500 * 1.1, 6);
  });
  it('mẫu ngân hàng: P/B nặng 70%', () => {
    const v = run(Object.assign({}, base, { sector: 'bank' }));
    expect(v.fair).toBeCloseTo(24000 * 0.7 + 18000 * 0.3, 6);
  });
  it('chỉ có P/B (thiếu P/E vì lỗ) -> fair = giá theo P/B', () => {
    const v = run(Object.assign({}, base, { v3: -10 }));
    expect(v.methods.map(x => x.key)).toEqual(['pb']);
    expect(v.fair).toBeCloseTo(24000, 6);
  });
  it('DDM chỉ xuất hiện khi có cổ tức, ke > g; mẫu tiện ích tính trọng số DDM', () => {
    const data = Object.assign({}, base, { sector: 'utility', dps: 1000, ke: 12, gDiv: 4 });
    const v = run(data);
    const ddm = v.methods.find(x => x.key === 'ddm');
    expect(ddm.base).toBeCloseTo(1000 * 1.04 / 0.08, 6);
    expect(ddm.bear).toBeLessThan(ddm.base);
    expect(ddm.bull).toBeGreaterThan(ddm.base);
    expect(v.methods.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 9);
    expect(run(Object.assign({}, data, { ke: 4 })).methods.find(x => x.key === 'ddm')).toBeUndefined();
    expect(run(Object.assign({}, data, { dps: 0 })).methods.find(x => x.key === 'ddm')).toBeUndefined();
  });
  it('DDM bull bị chặn khi g + 2 chạm ke', () => {
    const d = V.normalize({ dps: 100, ke: 10, gDiv: 9.5 });
    const r = V.ddmValues(d);
    expect(isFinite(r.bull)).toBe(true);
    expect(r.bull).toBeGreaterThanOrEqual(r.base); // g + 2 bị chặn ở ke - 0,5 = đúng g cơ sở, không vượt
    const wide = V.ddmValues(V.normalize({ dps: 100, ke: 10, gDiv: 4 }));
    expect(wide.bull).toBeGreaterThan(wide.base);
  });
  it('mẫu ngành có trọng số nhưng không phương pháp nào khớp -> chia đều', () => {
    const v = run({ v1: 1000, v2: 2000, v3: 150, v6: 15000, targetPB: 1.2, sector: 'utility' });
    expect(v.methods.length).toBe(1);
    expect(v.methods[0].share).toBeCloseTo(1, 9);
  });
  it('thiếu mục tiêu -> không có phương pháp, fair null', () => {
    const v = run({ v1: 1000, v2: 2000, v3: 150, v6: 15000 });
    expect(v.methods).toEqual([]);
    expect(v.fair).toBeNull();
  });
});

describe('verdict', () => {
  it('Rẻ khi giá <= 80% giá hợp lý, Hợp lý tới 110%, Đắt sau đó', () => {
    expect(V.verdict(80, 100, 70, 130).key).toBe('cheap');
    expect(V.verdict(81, 100, 70, 130).key).toBe('fair');
    expect(V.verdict(110, 100, 70, 130).key).toBe('fair');
    expect(V.verdict(111, 100, 70, 130).key).toBe('expensive');
  });
  it('upside, biên an toàn và vùng so với kịch bản xấu/tốt', () => {
    const v = V.verdict(60, 100, 70, 130);
    expect(v.upsidePct).toBeCloseTo(66.6667, 3);
    expect(v.marginOfSafetyPct).toBeCloseTo(40, 6);
    expect(v.zone).toBe('below-bear');
    expect(V.verdict(150, 100, 70, 130).zone).toBe('above-bull');
    expect(V.verdict(100, 100, 70, 130).zone).toBe('in-range');
  });
  it('thiếu giá hoặc giá hợp lý -> none', () => {
    expect(V.verdict(0, 100).key).toBe('none');
    expect(V.verdict(100, null).key).toBe('none');
  });
});

describe('lịch sử P/E, P/B', () => {
  // EPS 1.000 / 1.250 / 1.500 / 2.000 ; giá cuối năm 10.000 / 15.000 / 15.000 / 40.000 -> P/E 10, 12, 10, 20
  const row = (year, lnst) => ({ year, data: { v1: 1000, v2: 2000, v3: lnst } });
  const rows = [row(2023, 100), row(2024, 125), row(2025, 150), row(2026, 200)];
  const series = [['2023-12-29', 10000], ['2024-12-31', 15000], ['2025-12-31', 15000], ['2026-10-02', 40000]];

  it('tính P/E cuối mỗi năm bằng giá đóng cửa gần nhất trước ngày 31/12', () => {
    const h = V.historicalMultiples(rows, series);
    expect(h.byYear.map(x => Math.round(x.pe * 100) / 100)).toEqual([10, 12, 10, 20]);
    expect(h.pe.n).toBe(4);
    expect(h.pe.mean).toBeCloseTo(13, 6);
    expect(h.ok).toBe(true);
  });
  it('bỏ qua năm không có giá (chuỗi bắt đầu sau năm đó); chưa đủ 3 năm -> ok=false', () => {
    const h = V.historicalMultiples(rows, [['2025-06-01', 15000], ['2026-10-02', 40000]]);
    expect(h.byYear.filter(x => x.pe !== null).length).toBe(2);
    expect(h.ok).toBe(false);
    expect(V.historicalMultiples([], series).ok).toBe(false);
  });
  it('vị trí trong dải: phân vị và nhãn', () => {
    const h = V.historicalMultiples(rows, series);
    const pos = V.bandPosition(h, 'pe', 20);
    expect(pos.percentile).toBe(100);
    expect(pos.label).toBe('cao hơn lịch sử');
    const low = V.bandPosition(h, 'pe', 9);
    expect(low.percentile).toBe(0);
    expect(low.label).toBe('thấp hơn lịch sử');
    expect(V.bandPosition({ pe: { n: 2, mean: 1, sd: 0, min: 1, max: 1 }, byYear: [] }, 'pe', 5)).toBeNull();
  });
  it('giá ngụ ý từ dải trung bình +/- 1 độ lệch chuẩn', () => {
    const h = V.historicalMultiples(rows, series);
    const im = V.impliedFromBand(h.pe, 1500);
    expect(im.base).toBeCloseTo(13 * 1500, 6);
    expect(im.low).toBeLessThan(im.base);
    expect(im.high).toBeGreaterThan(im.base);
    expect(V.impliedFromBand(null, 1500)).toBeNull();
    expect(V.impliedFromBand(h.pe, 0)).toBeNull();
  });
  it('priceAtOrBefore: tìm nhị phân đúng biên', () => {
    expect(V.priceAtOrBefore(series, '2024-12-31')).toBe(15000);
    expect(V.priceAtOrBefore(series, '2024-12-30')).toBe(10000);
    expect(V.priceAtOrBefore(series, '2020-01-01')).toBeNull();
    expect(V.priceAtOrBefore([], '2024-01-01')).toBeNull();
  });
});

describe('football field', () => {
  it('quy khoảng giá và giá hiện tại về % chiều ngang trong [0,100]', () => {
    const f = V.football([
      { label: 'P/E', low: 100, base: 150, high: 200 },
      { label: 'P/B', low: 120, base: 140, high: 160 },
      { label: 'rác', low: 0, high: 10 },
      { label: 'đảo', low: 50, high: 20 },
    ], 130);
    expect(f.rows.length).toBe(2);
    f.rows.forEach(r => { expect(r.leftPct).toBeGreaterThanOrEqual(0); expect(r.leftPct + r.widthPct).toBeLessThanOrEqual(100.0001); });
    expect(f.pricePct).toBeGreaterThan(f.rows[0].leftPct);
    expect(f.pricePct).toBeLessThan(f.rows[0].leftPct + f.rows[0].widthPct);
    expect(f.rows[0].basePct).toBeGreaterThan(f.rows[0].leftPct);
  });
  it('giá nằm ngoài mọi khoảng vẫn nằm trong khung', () => {
    const f = V.football([{ label: 'P/E', low: 100, high: 120 }], 500);
    expect(f.pricePct).toBeLessThanOrEqual(100);
    expect(f.rows[0].widthPct).toBeGreaterThan(0);
  });
  it('không có khoảng hợp lệ -> null', () => {
    expect(V.football([], 10)).toBeNull();
    expect(V.football(null, 10)).toBeNull();
  });
});

describe('so sánh cùng ngành', () => {
  const items = [
    { symbol: 'A', sector: 'bank', pe: 8, pb: 1.0, roe: 15 },
    { symbol: 'B', sector: 'bank', pe: 10, pb: 1.4, roe: 18 },
    { symbol: 'C', sector: 'bank', pe: 12, pb: 2.0, roe: 20 },
    { symbol: 'D', sector: 'general', pe: 30, pb: 5, roe: 8 },
  ];
  it('trung vị các mã cùng ngành, loại chính mã đang xem', () => {
    const p = V.peerStats(items, 'bank', 'A');
    expect(p.n).toBe(2);
    expect(p.pe).toBeCloseTo(11, 6);
    expect(p.symbols).toEqual(['B', 'C']);
  });
  it('dưới 2 mã cùng ngành -> null; bỏ qua giá trị thiếu khi lấy trung vị', () => {
    expect(V.peerStats(items, 'general', 'D')).toBeNull();
    expect(V.median([1, null, 3, undefined, 5])).toBe(3);
    expect(V.median([])).toBeNull();
  });
});

describe('nhật ký đổi mục tiêu', () => {
  it('chỉ thêm khi giá hợp lý đổi > 0,5%, giữ tối đa 20 dòng', () => {
    let log = V.appendTargetLog([], { at: 't1', by: 'a@x', fair: 20000, price: 15000, pe: 12, pb: 1.2 });
    expect(log.length).toBe(1);
    log = V.appendTargetLog(log, { at: 't2', fair: 20050 });
    expect(log.length).toBe(1);
    log = V.appendTargetLog(log, { at: 't3', fair: 21000 });
    expect(log.length).toBe(2);
    let big = [];
    for (let i = 1; i <= 25; i++) big = V.appendTargetLog(big, { at: 't' + i, fair: 1000 * i });
    expect(big.length).toBe(20);
    expect(big[0].fair).toBe(6000);
  });
  it('bỏ qua mục không có giá hợp lý và không sửa mảng gốc', () => {
    const orig = [{ at: 'x', fair: 100 }];
    expect(V.appendTargetLog(orig, { at: 'y', fair: 0 })).toEqual(orig);
    V.appendTargetLog(orig, { at: 'y', fair: 500 });
    expect(orig.length).toBe(1);
  });
});

describe('analyze và buildRecord', () => {
  it('giá hiện tại (ctx.price) thay giá đã lưu và đổi kết luận', () => {
    const stored = V.analyze(base);
    expect(stored.price).toBe(15000);
    expect(stored.verdict.key).toBe('cheap'); // 15.000 / 21.000 = 71%
    const live = V.analyze(base, { price: 30000 });
    expect(live.price).toBe(30000);
    expect(live.m.pe).toBeCloseTo(20, 6);
    expect(live.verdict.key).toBe('expensive');
  });
  it('buildRecord giữ khoá cũ + khoá tính sẵn và đọc lại được qua normalize', () => {
    const rec = V.buildRecord(Object.assign({}, base, { sector: 'bank', dps: 500, thesis: 'Luận điểm' }));
    expect(rec).toMatchObject({ symbol: 'ABC', year: 2026, v1: 1000, v2: 2000, v3: 150, v6: 15000, targetPE: 12, targetPB: 1.2, sector: 'bank' });
    expect(rec.charter_capital).toBe(1000);
    expect(rec.eps).toBe(1500);
    expect(rec.book_value).toBe(20000);
    expect(rec.pe).toBe(10);
    expect(rec.price_per_pe).toBe(18000);
    expect(rec.price_per_pb).toBe(24000);
    expect(rec.fair_value).toBe(Math.round(24000 * 0.7 + 18000 * 0.3));
    expect(rec.verdict).toBe('cheap');
    expect(rec.thesis).toBe('Luận điểm');
    const n = V.normalize(rec);
    expect([n.charter, n.equity, n.lnst, n.price]).toEqual([1000, 2000, 150, 15000]);
    expect(n.scenarios.base.pe).toBe(12);
  });
  it('buildRecord bỏ qua ô trống và không ghi NaN/Infinity', () => {
    const rec = V.buildRecord({ symbol: 'x', year: 2026, v1: 1000, v2: '', v3: 150, v6: 0 });
    expect('v2' in rec).toBe(false);
    Object.values(rec).forEach(v => { if (typeof v === 'number') expect(isFinite(v)).toBe(true); });
    expect(rec.verdict).toBeUndefined();
  });
  it('trọng số mẫu "general" giữ nguyên nghĩa giá mục tiêu cũ (trung bình P/E và P/B)', () => {
    // khớp test _valuationTarget cũ: 12x1500=18000, 1,2x20000=24000 -> 21000
    expect(V.buildRecord(base).fair_value).toBe(21000);
  });
});

describe('cổ phiếu thưởng / phát hành thêm làm đổi cơ sở EPS', () => {
  it('số cổ phiếu đổi > 3%: không tính tăng trưởng EPS, BVPS, PEG nhưng vẫn tính tăng trưởng LNST', () => {
    const prev = V.normalize({ v1: 1000, v2: 1800, v3: 100 });
    const n = V.normalize({ v1: 1500, v2: 3000, v3: 160, v6: 15000 });   // chia thưởng 50%
    const m = V.metrics(n, { prev });
    expect(m.shareChange).toBeCloseTo(0.5, 6);
    expect(m.lnstGrowth).toBeCloseTo(60, 6);
    expect(m.epsGrowth).toBeNull();
    expect(m.bvpsGrowth).toBeNull();
    expect(m.peg).toBeNull();
  });
  it('đổi nhẹ trong ngưỡng 3% vẫn so sánh được', () => {
    const prev = V.normalize({ v1: 1000, v2: 1800, v3: 100 });
    const m = V.metrics(V.normalize({ v1: 1020, v2: 2000, v3: 120, v6: 15000 }), { prev });
    expect(m.shareChange).toBeCloseTo(0.02, 6);
    expect(m.epsGrowth).not.toBeNull();
  });
});

describe('syncRecords: ghép số liệu nguồn với hồ sơ đã lưu', () => {
  const T = 1e9; // nguồn trả đồng; đơn vị hồ sơ mặc định tỷ đồng
  const A = (year, o) => Object.assign({ year, fiscalDate: year + '-12-31', charter: 1000 * T, equity: 2200 * T, minority: 200 * T, equityParent: 2000 * T, lnst: 150 * T, revenue: 1500 * T, assets: 5000 * T }, o || {});
  const fin = (annual, extra) => Object.assign({ form: 'NON_FINANCE', annual, quarters: [], dividends: {} }, extra || {});
  const existing = [{ year: 2024, data: { symbol: 'ABC', year: 2024, v1: 1000, v2: 1800, v3: 120, v6: 14000, targetPE: 12, targetPB: 1.2, growthBase: 8, thesis: 'giữ nguyên', sector: 'general', unit: 'billion', fair_value: 1 } }];

  it('hồ sơ có sẵn: ghi đè số liệu tài chính, giữ nguyên giả định/luận điểm/giá, tính lại giá hợp lý', () => {
    const r = V.syncRecords(existing, fin([A(2024, { lnst: 130 * T })]), { symbol: 'abc', at: 'T0' });
    expect(r.records).toHaveLength(1);
    const rec = r.records[0].record;
    expect(r.records[0].isNew).toBe(false);
    expect(rec).toMatchObject({ symbol: 'ABC', year: 2024, v1: 1000, v2: 2000, v3: 130, v6: 14000, targetPE: 12, targetPB: 1.2, growthBase: 8, thesis: 'giữ nguyên', revenue: 1500, assets: 5000, financialsSource: 'vndirect', financialsAt: 'T0' });
    expect(rec.fair_value).not.toBe(1);                       // đã tính lại từ số liệu mới
    expect(rec.eps).toBe(1300);
  });
  it('năm mới nhất vừa có báo cáo: kế thừa giả định từ năm gần nhất và đánh dấu carriedFrom; giá lấy giá hiện tại', () => {
    const r = V.syncRecords(existing, fin([A(2024), A(2025, { lnst: 180 * T })]), { symbol: 'ABC', livePrice: 21000 });
    const y25 = r.records.find(x => x.year === 2025);
    expect(y25.isNew).toBe(true);
    expect(y25.carried).toBe(true);
    expect(y25.record).toMatchObject({ targetPE: 12, targetPB: 1.2, growthBase: 8, carriedFrom: 2024, v6: 21000, v3: 180 });
    expect(y25.record.thesis).toBeUndefined();               // luận điểm không kế thừa
    expect(r.summary).toMatchObject({ created: 1, updated: 1, carried: true, years: [2024, 2025] });
    expect(y25.record.roe).toBeUndefined();
  });
  it('năm lịch sử chưa có: chỉ có số liệu, không giả định, không giá; ngành theo loại hình', () => {
    const r = V.syncRecords([], fin([A(2022), A(2023), A(2024)], { form: 'BANK' }), { symbol: 'VCB', livePrice: 90000 });
    expect(r.records.map(x => x.year)).toEqual([2022, 2023, 2024]);
    r.records.forEach(x => expect(x.record.sector).toBe('bank'));
    const y22 = r.records[0].record;
    expect('targetPE' in y22).toBe(false);
    expect('v6' in y22).toBe(false);
    expect('carriedFrom' in y22).toBe(false);
    expect(r.records[2].record.v6).toBe(90000);              // chỉ năm mới nhất nhận giá hiện tại
    expect(r.unit).toBe('billion');
  });
  it('cổ tức: ghi khi nguồn có, giữ số cũ khi nguồn không có; quy đổi theo đơn vị của hồ sơ (triệu đồng)', () => {
    const ex = [{ year: 2024, data: { v1: 1000000, v2: 1, v3: 1, unit: 'million', dps: 700 } }];
    const r1 = V.syncRecords(ex, fin([A(2024)]), { symbol: 'ABC' });
    expect(r1.records[0].record.dps).toBe(700);               // nguồn không có cổ tức năm này -> giữ
    expect(r1.records[0].record.v1).toBe(1000000);            // 1.000 tỷ = 1.000.000 triệu
    const r2 = V.syncRecords(ex, fin([A(2024)], { dividends: { '2024': 1000 } }), { symbol: 'ABC' });
    expect(r2.records[0].record.dps).toBe(1000);
  });
  it('vốn chủ dùng phần của cổ đông công ty mẹ; thiếu thì dùng vốn chủ gộp; nguồn thiếu số thì giữ số cũ', () => {
    const r = V.syncRecords([], fin([A(2024, { equityParent: null, equity: 2200 * T, revenue: null })]), { symbol: 'ABC' });
    expect(r.records[0].record.v2).toBe(2200);
    expect('revenue' in r.records[0].record).toBe(false);
    const keep = V.syncRecords([{ year: 2024, data: { v1: 1000, v2: 1, v3: 1, revenue: 777 } }], fin([A(2024, { revenue: null })]), { symbol: 'ABC' });
    expect(keep.records[0].record.revenue).toBe(777);
  });
  it('ROE bình quân và tăng trưởng dùng năm liền trước ngay trong lượt đồng bộ; chia thưởng không tạo tăng trưởng EPS giả', () => {
    const r = V.syncRecords([], fin([A(2023, { charter: 1000 * T, lnst: 100 * T }), A(2024, { charter: 1500 * T, lnst: 130 * T })]), { symbol: 'ABC' });
    const y24 = V.normalize(r.records[1].record);
    const m = V.metrics(y24, { prev: V.normalize(r.records[0].record) });
    expect(m.lnstGrowth).toBeCloseTo(30, 6);
    expect(m.epsGrowth).toBeNull();
    expect(m.roeBasis).toBe('avg');
  });
  it('giới hạn số năm; nguồn rỗng -> không có bản ghi', () => {
    const many = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].map(y => A(y));
    expect(V.syncRecords([], fin(many), { symbol: 'ABC', maxYears: 6 }).records.map(x => x.year)).toEqual([2020, 2021, 2022, 2023, 2024, 2025].slice(0, 6));
    expect(V.syncRecords([], fin([]), { symbol: 'ABC' }).records).toEqual([]);
    expect(V.syncRecords([], null, { symbol: 'ABC' }).records).toEqual([]);
  });
  it('dòng quý quy đổi về đơn vị hồ sơ, bỏ quý không có lợi nhuận, giới hạn số quý', () => {
    const q = [{ year: 2026, quarter: 2, lnst: 2.5 * T, revenue: 13 * T }, { year: 2026, quarter: 1, lnst: null, revenue: 1 }, { year: 2025, quarter: 4, lnst: 2.4 * T, revenue: null }];
    const rows = V.quarterRowsFrom({ quarters: q }, 'FPT', 'billion', 12);
    expect(rows).toEqual([{ symbol: 'FPT', year: 2026, quarter: 2, lnst: 2.5, revenue: 13 }, { symbol: 'FPT', year: 2025, quarter: 4, lnst: 2.4, revenue: null }]);
    expect(V.quarterRowsFrom({ quarters: q }, 'FPT', 'million', 1)[0].lnst).toBe(2500);
    expect(V.quarterRowsFrom(null, 'FPT', 'billion')).toEqual([]);
  });
});

describe('làm tròn số quy đổi theo đơn vị', () => {
  it('tỷ đồng 2 số lẻ, triệu đồng 1 số lẻ, đồng nguyên', () => {
    expect(V.roundForUnit(14710691830000, 'billion')).toBe(14710.69);
    expect(V.roundForUnit(14710691830000, 'million')).toBe(14710691.8);
    expect(V.roundForUnit(14710691830000, 'dong')).toBe(14710691830000);
    expect(V.roundForUnit(1234567, 'unknown')).toBe(0); // đơn vị lạ rơi về tỷ đồng
  });
  it('syncRecords ghi số tròn theo đơn vị hồ sơ', () => {
    const r = V.syncRecords([], { form: 'NON_FINANCE', annual: [{ year: 2025, charter: 17035071210000, equityParent: 36482943940772, lnst: 9376127629501, revenue: null, assets: null }], quarters: [], dividends: {} }, { symbol: 'FPT' });
    expect(r.records[0].record).toMatchObject({ v1: 17035.07, v2: 36482.94, v3: 9376.13 });
  });
});
