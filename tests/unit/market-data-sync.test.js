// Edge Function market-data-sync: phần logic thuần (parse nguồn công khai, gộp thông tin mã, kiểm chất lượng giá). Dữ liệu mẫu có cùng hình dạng với phản hồi thật đã kiểm ngày 04/10/2026.
import { describe, it, expect } from 'vitest';
import { parseVciSymbols, parseVndStocks, mergeMeta, parseTvYield, parseDchartBars, parseVciBars, comparePrices, detectJumps, detectGaps, metaGaps, addDays } from '../../supabase/functions/market-data-sync/logic.ts';

const bar = (date, close) => ({ date, close });
const series = (start, closes) => closes.map((c, i) => bar(addDays(start, i), c));

describe('thông tin mã', () => {
  const vciRaw = [
    { id: 1, sid: 2133, symbol: 'FPT', type: 'STOCK', board: 'HSX', organShortName: 'FPT Corp', organName: 'Công ty Cổ phần FPT', icbCode2: '9500' },
    { symbol: 'VCB', type: 'STOCK', board: 'HSX', organShortName: 'Vietcombank', icbCode2: 8300 },
    { symbol: 'E1VFVN30', type: 'ETF', board: 'HSX', organShortName: 'ETF VN30', icbCode2: '' },
    { symbol: 'CFPT2601', type: 'CW', board: 'HSX', organShortName: 'Chứng quyền' },
    { symbol: 'VN30F2610', type: 'FU', board: 'DER' },
    { symbol: 'ABC', type: 'STOCK', board: 'XXX' },
    { symbol: 'bad symbol', type: 'STOCK', board: 'HNX' },
    { symbol: 'SHB', type: 'STOCK', board: 'HNX', icbCode2: '830' },
  ];
  it('VCI: giữ cổ phiếu / ETF / quỹ trên 3 sàn; sàn HSX -> HOSE; mã ICB đủ 4 ký tự; bỏ chứng quyền, phái sinh, mã hỏng', () => {
    const r = parseVciSymbols(vciRaw);
    expect(r.map(x => x.symbol)).toEqual(['FPT', 'VCB', 'E1VFVN30', 'SHB']);
    expect(r[0]).toMatchObject({ exchange: 'HOSE', type: 'STOCK', icb2_code: '9500', name: 'FPT Corp' });
    expect(r[1].icb2_code).toBe('8300');
    expect(r[2].icb2_code).toBeNull();
    expect(r[3]).toMatchObject({ exchange: 'HNX', icb2_code: '0830' });
    expect(parseVciSymbols(null)).toEqual([]);
  });
  it('VNDirect: sàn, VN30, ngày niêm yết, trạng thái', () => {
    const v = parseVndStocks({ data: [{ code: 'FPT', floor: 'HOSE', indexCode: 'VN30', listedDate: '2006-12-13', status: 'listed', shortName: 'CTCP FPT' }, { code: 'GEL', floor: 'HOSE', listedDate: '2026-02-06', status: 'listed' }, { code: 'x y', floor: 'HOSE' }] });
    expect(Object.keys(v)).toEqual(['FPT', 'GEL']);
    expect(v.FPT).toEqual({ exchange: 'HOSE', vn30: true, listed_date: '2006-12-13', status: 'listed', name: 'CTCP FPT' });
    expect(v.GEL.vn30).toBe(false);
  });
  it('gộp: ICB từ VCI, VN30/ngày niêm yết từ VNDirect; mã chỉ có ở VNDirect vẫn giữ (chưa có ICB)', () => {
    const rows = mergeMeta(parseVciSymbols(vciRaw), parseVndStocks({ data: [{ code: 'FPT', floor: 'HOSE', indexCode: 'VN30', listedDate: '2006-12-13' }, { code: 'GEL', floor: 'HOSE', listedDate: '2026-02-06', shortName: 'GELEX INFRA' }] }), '2026-10-04T00:00:00Z');
    const by = Object.fromEntries(rows.map(r => [r.symbol, r]));
    expect(by.FPT).toMatchObject({ icb2_code: '9500', vn30: true, listed_date: '2006-12-13', source: 'vci+vnd', updated_at: '2026-10-04T00:00:00Z' });
    expect(by.VCB).toMatchObject({ vn30: false, source: 'vci' });
    expect(by.GEL).toMatchObject({ icb2_code: null, exchange: 'HOSE', source: 'vnd', name: 'GELEX INFRA' });
  });
});

describe('lợi suất trái phiếu', () => {
  it('đọc close và ngày theo giờ Việt Nam; từ chối giá trị vô lý', () => {
    expect(parseTvYield({ close: 4.5879, time: 1790888400 })).toEqual({ yield_pct: 4.5879, date: new Date((1790888400 + 7 * 3600) * 1000).toISOString().slice(0, 10) });
    expect(parseTvYield({ close: 'x' })).toBeNull();
    expect(parseTvYield({ close: 4.5 })).toBeNull();            // thiếu thời điểm
    expect(parseTvYield({ close: 250, time: 1790888400 })).toBeNull();
    expect(parseTvYield(null)).toBeNull();
  });
});

describe('chuỗi giá từ hai nguồn', () => {
  it('dchart: cổ phiếu nghìn đồng -> đồng, chỉ số giữ nguyên; bỏ điểm hỏng; sắp tăng dần', () => {
    const j = { s: 'ok', t: [1790899200, 1790812800, 1790985600], c: [62.1, 62.7, null] };
    expect(parseDchartBars(j, false)).toEqual([bar('2026-10-01', 62700), bar('2026-10-02', 62100)]);
    expect(parseDchartBars({ s: 'ok', t: [1790899200], c: [1875.99] }, true)).toEqual([bar('2026-10-02', 1875.99)]);
    expect(parseDchartBars({ s: 'no_data' }, false)).toEqual([]);
  });
  it('VCI gap-chart: chọn đúng mã, giá đồng', () => {
    const j = [{ symbol: 'FPT', c: [62700, 62100], t: ['1790812800', '1790899200'] }];
    expect(parseVciBars(j, 'FPT')).toEqual([bar('2026-10-01', 62700), bar('2026-10-02', 62100)]);
    expect(parseVciBars(j, 'VCB')).toEqual([]);
  });
});

describe('comparePrices', () => {
  const a = series('2026-09-24', [62000, 62500, 62700, 62100, 61800]);
  it('khớp nhau: không cảnh báo', () => {
    expect(comparePrices('FPT', a, a.map(x => ({ ...x })))).toEqual([]);
    expect(comparePrices('FPT', a.slice(0, 2), a.slice(0, 2))).toEqual([]);   // chưa đủ 3 ngày chung
  });
  it('lệch lẻ tẻ: >0,5% cảnh báo, >2% lỗi, ghi đúng ngày và hai giá', () => {
    const b = a.map(x => ({ ...x }));
    b[1].close = 62500 * 1.01; b[3].close = 62100 * 0.95;
    const f = comparePrices('FPT', a, b);
    expect(f.map(x => [x.kind, x.severity, x.ref_date])).toEqual([['price_mismatch', 'warn', '2026-09-25'], ['price_mismatch', 'error', '2026-09-27']]);
    expect(f[1].detail.diffPct).toBeCloseTo((62100 / (62100 * 0.95) - 1) * 100, 1);
    expect(f[0].dedupe_key).toBe('price_mismatch|FPT|2026-09-25');
  });
  it('lệch đều một hệ số (khác cách điều chỉnh giá): chỉ báo mức giá (info), không báo từng ngày', () => {
    const b = a.map(x => ({ date: x.date, close: x.close * 0.98 }));
    const f = comparePrices('FPT', a, b);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'price_level', severity: 'info' });
    expect(f[0].detail.factor).toBeCloseTo(1 / 0.98, 3);
  });
});

describe('detectJumps', () => {
  it('nhảy vượt biên độ sàn (HOSE 7% + dung sai) bị gắn cờ; trong biên độ thì không; HNX rộng hơn', () => {
    const bars = series('2026-09-28', [100000, 106900, 98000, 98000]);          // +6,9% hợp lệ; -8,3% vượt
    const f = detectJumps('X', 'HOSE', bars, null);
    expect(f.map(x => [x.ref_date, x.severity])).toEqual([['2026-09-30', 'warn']]);
    expect(detectJumps('X', 'HNX', bars, null)).toEqual([]);
  });
  it('nhảy gấp đôi biên độ là lỗi; ngày đầu niêm yết được bỏ qua', () => {
    const bars = series('2026-09-28', [100000, 130000]);
    expect(detectJumps('X', 'HOSE', bars, null)[0].severity).toBe('error');
    expect(detectJumps('X', 'HOSE', bars, '2026-09-25')).toEqual([]);
  });
  it('không biết sàn thì dùng biên độ HOSE', () => {
    expect(detectJumps('X', null, series('2026-09-28', [100000, 110000]), null)).toHaveLength(1);
  });
});

describe('detectGaps (phiên theo VN-Index)', () => {
  const idx = series('2026-09-28', [1900, 1910, 1920, 1915, 1925, 1930]);          // 6 phiên liên tiếp (giả lập)
  it('đủ phiên: không cờ', () => { expect(detectGaps('X', idx.map(b => ({ ...b })), idx)).toEqual([]); });
  it('thiếu một phiên giữa chừng: missing_session', () => {
    const bars = idx.filter((_, i) => i !== 3);
    const f = detectGaps('X', bars, idx);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'missing_session', severity: 'warn' });
    expect(f[0].detail.missing).toEqual(['2026-10-01']);
  });
  it('dừng ở phiên cũ quá 1 phiên: stale_price; 3 phiên trở lên là warn', () => {
    expect(detectGaps('X', idx.slice(0, 4), idx)[0]).toMatchObject({ kind: 'stale_price', severity: 'info' });
    expect(detectGaps('X', idx.slice(0, 3), idx)[0]).toMatchObject({ kind: 'stale_price', severity: 'warn' });
    expect(detectGaps('X', idx.slice(0, 5), idx)).toEqual([]);                       // chậm đúng 1 phiên: chấp nhận
  });
  it('thiếu dữ liệu chỉ số hoặc mã: không kết luận', () => {
    expect(detectGaps('X', idx, idx.slice(0, 2))).toEqual([]);
    expect(detectGaps('X', [], idx)).toEqual([]);
  });
});

describe('metaGaps', () => {
  it('gom mã chưa có phân ngành thành một cảnh báo thông tin; đủ ngành thì không báo', () => {
    const f = metaGaps(['FPT', 'ZZZ', 'YYY', 'ZZZ'], (s) => s === 'FPT', '2026-10-04');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'meta_gap', severity: 'info' });
    expect(f[0].detail.symbols).toEqual(['ZZZ', 'YYY']);
    expect(metaGaps(['FPT'], () => true, '2026-10-04')).toEqual([]);
  });
});

import { curateRatios, latestReportDate, DAILY_MAP, QUARTER_MAP } from '../../supabase/functions/market-data-sync/logic.ts';

describe('chỉ số cơ bản từ VNDirect ratios', () => {
  // giá trị lấy từ phản hồi thật của FPT ngày 02/10/2026 và quý 30/06/2026
  const daily = [{ ratioCode: 'PRICE_TO_EARNINGS', value: 11.711 }, { ratioCode: 'PRICE_TO_BOOK', value: 2.9385 }, { ratioCode: 'BETA', value: 0.73586 }, { ratioCode: 'BVPS_CR', value: 21133 }, { ratioCode: 'PRICE_HIGHEST_CR_52W', value: 95144 }, { ratioCode: 'NMVALUE_AVG_CR_20D', value: 3.9869e11 }, { ratioCode: 'UNKNOWN_CODE', value: 1 }, { ratioCode: 'DAILY_JDK_RS_CR', value: 96.73 }];
  const quarterly = [{ ratioCode: 'ROAE_TR_AVG5Q', value: 0.2409 }, { ratioCode: 'EPS_TR', value: 5870 }, { ratioCode: 'EPS_TR_GRYOY', value: 0.009273 }, { ratioCode: 'DEBT_TO_EQUITY_AQ', value: 0.45 }, { ratioCode: 'CURRENT_RATIO_AQ', value: 1.5621 }, { ratioCode: 'INTEREST_COVERAGE_TR', value: 11.96 }, { ratioCode: 'BETA', value: 9 }, { ratioCode: 'NET_MARGIN_TR', value: 'x' }];
  it('chọn đúng tập chỉ số, đổi tên ngắn, bỏ mã lạ và giá trị không phải số; nhóm ngày không lẫn vào nhóm quý', () => {
    const m = curateRatios(daily, quarterly, []);
    expect(m).toMatchObject({ pe: 11.711, pb: 2.9385, beta: 0.73586, bvps: 21133, high52: 95144, advValue20: 3.9869e11, jdkRs: 96.73, roae: 0.2409, epsTtm: 5870, epsGrowthYoY: 0.009273, debtToEquity: 0.45, currentRatio: 1.5621, interestCoverage: 11.96 });
    expect(m.netMargin).toBeUndefined();            // 'x' không phải số
    expect(Object.keys(m)).not.toContain('UNKNOWN_CODE');
    expect(m.beta).toBe(0.73586);                    // BETA của nhóm quý không ghi đè (không nằm trong QUARTER_MAP)
  });
  it('dòng tiền khối ngoại: tổng ròng 5 phiên gần nhất, ngày mới nhất, room còn lại %', () => {
    const f = [{ tradingDate: '2026-10-02', netVal: -2.97e9, totalRoom: 8.4e8, currentRoom: 3.519e8 }, { tradingDate: '2026-10-01', netVal: 3.56e10 }, { tradingDate: '2026-09-30', netVal: 1e9 }, { tradingDate: '2026-09-29', netVal: 0 }, { tradingDate: '2026-09-28', netVal: 1e9 }, { tradingDate: '2026-09-25', netVal: 5e11 }];
    const m = curateRatios([], [], f);
    expect(m.foreignNet5d).toBeCloseTo(-2.97e9 + 3.56e10 + 1e9 + 0 + 1e9, 0);
    expect(m.foreignNetDate).toBe('2026-10-02');
    expect(m.foreignRoomLeftPct).toBeCloseTo(3.519e8 / 8.4e8 * 100, 9);
    expect(curateRatios([], [], [{ tradingDate: '2026-10-02', netVal: 1, totalRoom: 0, currentRoom: 5 }]).foreignRoomLeftPct).toBeNull();
    expect(curateRatios(null, null, null)).toEqual({});
  });
  it('ngày báo cáo mới nhất; phản hồi lỗi -> null; bản đồ không trùng tên trường giữa hai nhóm (trừ freefloat)', () => {
    expect(latestReportDate({ data: [{ reportDate: '2026-06-30', value: 1 }] })).toBe('2026-06-30');
    expect(latestReportDate({ data: [] })).toBeNull();
    expect(latestReportDate(null)).toBeNull();
    const dup = Object.values(DAILY_MAP).filter(v => Object.values(QUARTER_MAP).includes(v));
    expect(dup).toEqual(['freefloat']);
  });
});
