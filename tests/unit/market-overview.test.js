// lib/market-overview.js: số kỳ vọng của khối "dữ liệu thật" (tests/fixtures/market-overview-sample.json: 39 mã trích từ bảng giá VNDirect ngày 08/10/2026,
// kèm khối ngoại, nến phút và nến ngày của VN-Index) được tính ĐỘC LẬP bằng Python rồi ghi cứng ở đây.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import MO from '../../lib/market-overview.js';

const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/market-overview-sample.json'), 'utf8'));
const rows = MO.parsePrices(FX.prices, FX.date);
const fr = MO.parseForeign(FX.foreign, FX.date);

describe('chỉ số: nến ngày và nến phút', () => {
  it('parseDaily đổi sang ngày giờ Việt Nam, tăng dần, bỏ nến hỏng', () => {
    const d = MO.parseDaily(FX.daily);
    expect(d[d.length - 1].date).toBe('2026-10-08');
    expect(d[d.length - 1].c).toBe(1738.97);
    for (let i = 1; i < d.length; i++) expect(d[i].date > d[i - 1].date).toBe(true);
    expect(MO.parseDaily({ s: 'no_data' })).toEqual([]);
    expect(MO.parseDaily(null)).toEqual([]);
    const bad = MO.parseDaily({ s: 'ok', t: [1791331200, 1791417600, 1791504000], c: [100, 0, null], o: [99, 1, 1], h: [101, 1, 1], l: [98, 1, 1], v: [5, 5, 5] });
    expect(bad.length).toBe(1);
  });
  it('nến ngày luôn có thấp <= mở, đóng <= cao dù nguồn lệch', () => {
    const d = MO.parseDaily({ s: 'ok', t: [1791331200], c: [105], o: [110], h: [104], l: [106], v: [1] })[0];
    expect(d.h).toBeGreaterThanOrEqual(Math.max(d.o, d.c));
    expect(d.l).toBeLessThanOrEqual(Math.min(d.o, d.c));
  });
  it('quote: thay đổi so với phiên trước và so với trung bình 20 phiên TRƯỚC (không tính phiên đang xét)', () => {
    const q = MO.quote(MO.parseDaily(FX.daily));
    expect(q.date).toBe('2026-10-08');
    expect(q.last).toBe(1738.97);
    expect(q.prev).toBe(1753.39);
    expect(q.change).toBeCloseTo(-14.42, 6);
    expect(q.pct).toBeCloseTo((1738.97 / 1753.39 - 1) * 100, 9);
    expect(q.avgVolume20).toBeCloseTo(522843406.85, 0);
    expect(q.volVsAvgPct).toBeCloseTo((532713885 / 522843406.85 - 1) * 100, 6);
  });
  it('quote: chuỗi ngắn không đoán trung bình; chuỗi rỗng trả null', () => {
    const d = MO.parseDaily({ s: 'ok', t: [1791331200, 1791417600], c: [100, 101], o: [100, 100], h: [101, 102], l: [99, 100], v: [10, 20] });
    const q = MO.quote(d);
    expect(q.avgVolume20).toBe(null);
    expect(q.volVsAvgPct).toBe(null);
    expect(q.change).toBeCloseTo(1, 9);
    expect(MO.quote([])).toBe(null);
    expect(MO.quote(MO.parseDaily({ s: 'ok', t: [1791331200], c: [100], v: [1] })).change).toBe(null);
  });
  it('parseIntraday: giờ phút Việt Nam, tăng theo thời gian', () => {
    const p = MO.parseIntraday(FX.intraday);
    expect(p.length).toBe(48);
    expect(p[0].date).toBe('2026-10-08');
    expect(p[0].min).toBeGreaterThanOrEqual(540);
    expect(p[p.length - 1].min).toBeLessThanOrEqual(910);                 // nến cuối của phiên có thể nằm ngay sau 15:00 (khớp lệnh đóng cửa); trục biểu đồ chặn ở 15:00
    expect(p[p.length - 1].c).toBe(1738.97);
  });
  it('mergeToday: phiên mới hơn nến ngày được thêm; ngoài phiên tin nến ngày; đang phiên cập nhật dòng cuối', () => {
    const daily = MO.parseDaily({ s: 'ok', t: [1791331200, 1791417600], c: [100, 101], o: [100, 100], h: [101, 102], l: [99, 100], v: [10, 20] });   // 07/10 và 08/10
    const mk = (t, c, v) => ({ s: 'ok', t: t, c: c, o: c, h: c, l: c, v: v });
    const nextDay = MO.parseIntraday(mk([1791504000 + 3600 * 3, 1791504000 + 3600 * 3 + 60], [103, 105], [5, 7]));      // 09/10 sáng giờ VN
    const added = MO.mergeToday(daily, nextDay, true);
    expect(added.length).toBe(3);
    expect(added[2].date).toBe('2026-10-09');
    expect(added[2].c).toBe(105);
    expect(added[2].h).toBe(105);
    expect(added[2].v).toBe(12);
    const same = MO.parseIntraday(mk([1791417600 + 3600 * 3, 1791417600 + 3600 * 3 + 60], [101.5, 102.5], [5, 7]));     // 08/10
    expect(MO.mergeToday(daily, same, false)[1].c).toBe(101);
    const live = MO.mergeToday(daily, same, true);
    expect(live.length).toBe(2);
    expect(live[1].c).toBe(102.5);
    expect(live[1].o).toBe(100);                                           // giữ giá mở của nến ngày
    expect(MO.mergeToday(daily, [], true)).toEqual(daily);
    const older = MO.parseIntraday(mk([1791331200 + 3600 * 3], [90], [1]));
    expect(MO.mergeToday(daily, older, true).length).toBe(2);
  });
  it('windowOf lấy số phiên gần nhất, tối thiểu 2', () => {
    const d = MO.parseDaily(FX.daily);
    expect(MO.windowOf(d, 5).length).toBe(5);
    expect(MO.windowOf(d, 0).length).toBe(2);
    expect(MO.windowOf(d, 9999).length).toBe(d.length);
  });
});

describe('bảng giá toàn thị trường', () => {
  it('parsePrices: đổi nghìn đồng sang đồng, bỏ chứng quyền/IFC, lọc theo ngày', () => {
    expect(rows.length).toBe(38);                                   // 39 dòng, trừ 1 dòng loại IFC
    expect(rows.every((r) => r.type === 'STOCK' || r.type === 'ETF')).toBe(true);
    const tcb = rows.find((r) => r.symbol === 'TCB');
    expect(tcb.price).toBeGreaterThan(10000);                       // đồng, không phải nghìn đồng
    expect(tcb.price % 10).toBe(0);
    expect(tcb.value).toBeCloseTo(tcb.nmValue + tcb.ptValue, 0);
    expect(MO.parsePrices(FX.prices, '2020-01-01')).toEqual([]);
    expect(MO.parsePrices({ data: [{ code: 'abc', type: 'STOCK', floor: 'HOSE', basicPrice: 10, close: 11, date: '2026-10-08' }] })[0].symbol).toBe('ABC');
    expect(MO.parsePrices(null)).toEqual([]);
    expect(MO.parsePrices({ data: [{ code: 'X', type: 'STOCK', floor: 'HOSE', basicPrice: 0, close: 11 }, { code: 'Y', type: 'STOCK', floor: 'OTC', basicPrice: 10, close: 11 }] })).toEqual([]);
  });
  it('pct và change tính từ giá tham chiếu', () => {
    const r = MO.parsePrices({ data: [{ code: 'AAA', type: 'STOCK', floor: 'HOSE', basicPrice: 20, close: 21.4, date: '2026-10-08', nmVolume: 100, nmValue: 2e6 }] })[0];
    expect(r.change).toBeCloseTo(1400, 6);
    expect(r.pct).toBeCloseTo(7, 6);
    expect(r.traded).toBe(true);
  });
  it('breadth khớp số tính độc lập (tăng/giảm/đứng, trần/sàn, giá trị)', () => {
    const exp = { ALL: [36, 8, 18, 10, 3, 4, 30, 8890697455450], HOSE: [19, 6, 12, 1, 1, 1, 19, 8884748248650], HNX: [10, 2, 4, 4, 2, 2, 7, 5836437200], UPCOM: [7, 0, 2, 5, 0, 1, 4, 112769600] };
    Object.keys(exp).forEach((ex) => {
      const b = MO.breadth(rows, ex), e = exp[ex];
      expect([b.total, b.up, b.down, b.flat, b.ceil, b.floor, b.traded], ex).toEqual(e.slice(0, 7));
      expect(b.value, ex).toBeCloseTo(e[7], -1);
      expect(b.up + b.down + b.flat).toBe(b.total);
    });
    expect(MO.breadth(rows, 'ALL').nmVolume).toBeCloseTo(270137536, 0);
  });
  it('breadth: mã chưa khớp giữ giá tham chiếu là đứng giá; ETF không vào tăng/giảm nhưng vào giá trị', () => {
    const p = MO.parsePrices({ data: [
      { code: 'AAA', type: 'STOCK', floor: 'HOSE', basicPrice: 10, close: 10, nmVolume: 0, nmValue: 0, date: 'd' },
      { code: 'E1', type: 'ETF', floor: 'HOSE', basicPrice: 10, close: 11, nmVolume: 10, nmValue: 1e8, date: 'd' },
      { code: 'BBB', type: 'STOCK', floor: 'HOSE', basicPrice: 10, close: 10.7, ceilingPrice: 10.7, nmVolume: 10, nmValue: 1e8, date: 'd' },
    ] });
    const b = MO.breadth(p, 'HOSE');
    expect([b.total, b.up, b.flat, b.ceil, b.traded]).toEqual([2, 1, 1, 1, 1]);
    expect(b.value).toBeCloseTo(2e8, 0);
  });
  it('breadth: mã đạt giá trần nhưng bằng tham chiếu (giá thấp) không tính là trần', () => {
    const p = MO.parsePrices({ data: [{ code: 'AAA', type: 'STOCK', floor: 'HOSE', basicPrice: 10, close: 10, ceilingPrice: 10, floorPrice: 10, date: 'd' }] });
    const b = MO.breadth(p, 'ALL');
    expect([b.ceil, b.floor, b.flat]).toEqual([0, 0, 1]);
  });
});

describe('khối ngoại', () => {
  it('foreignFlow khớp số tính độc lập; net = mua - bán', () => {
    const all = MO.foreignFlow(fr, 'ALL'), hose = MO.foreignFlow(fr, 'HOSE');
    expect(all.buy).toBeCloseTo(1086833490000, -1);
    expect(all.sell).toBeCloseTo(1353330570000, -1);
    expect(all.net).toBeCloseTo(-266497080000, -1);
    expect(hose.net).toBeCloseTo(-266511660000, -1);
    expect(all.net).toBeCloseTo(all.buy - all.sell, 0);
  });
  it('bỏ chứng quyền và dòng sai ngày', () => {
    expect(fr.every((r) => r.type === 'STOCK' || r.type === 'ETF')).toBe(true);
    expect(MO.parseForeign(FX.foreign, '2020-01-01')).toEqual([]);
    expect(MO.parseForeign(undefined)).toEqual([]);
  });
});

describe('cổ phiếu nổi bật', () => {
  it('tăng mạnh / giảm mạnh / giá trị đúng thứ tự độc lập', () => {
    expect(MO.movers(rows, fr, 'gain', 'HOSE', { n: 3 }).map((r) => r.symbol)).toEqual(['JVC', 'PLX', 'PVT']);
    expect(MO.movers(rows, fr, 'loss', 'HOSE', { n: 3 }).map((r) => r.symbol)).toEqual(['SHB', 'PNJ', 'VIX']);
    expect(MO.movers(rows, fr, 'value', 'ALL', { n: 3 }).map((r) => r.symbol)).toEqual(['TCB', 'HDB', 'VHM']);
  });
  it('loại mã gần như không giao dịch khỏi tăng/giảm mạnh (mặc định dưới 1 tỷ)', () => {
    const p = MO.parsePrices({ data: [
      { code: 'THIN', type: 'STOCK', floor: 'HOSE', basicPrice: 10, close: 10.7, nmVolume: 100, nmValue: 1e6, date: 'd' },
      { code: 'REAL', type: 'STOCK', floor: 'HOSE', basicPrice: 10, close: 10.2, nmVolume: 1e6, nmValue: 1e10, date: 'd' },
    ] });
    expect(MO.movers(p, [], 'gain', 'ALL').map((r) => r.symbol)).toEqual(['REAL']);
    expect(MO.movers(p, [], 'gain', 'ALL', { minValue: 0 }).map((r) => r.symbol)).toEqual(['THIN', 'REAL']);
  });
  it('NN mua ròng / bán ròng sắp theo giá trị ròng, kèm số ròng của mã', () => {
    const buy = MO.movers(rows, fr, 'fbuy', 'ALL', { n: 3 }), sell = MO.movers(rows, fr, 'fsell', 'ALL', { n: 3 });
    expect(buy.every((r) => r.foreignNet > 0)).toBe(true);
    expect(sell.every((r) => r.foreignNet < 0)).toBe(true);
    for (let i = 1; i < buy.length; i++) expect(buy[i].foreignNet).toBeLessThanOrEqual(buy[i - 1].foreignNet);
    for (let i = 1; i < sell.length; i++) expect(sell[i].foreignNet).toBeGreaterThanOrEqual(sell[i - 1].foreignNet);
  });
  it('lọc theo sàn; ETF chỉ vào khi includeEtf', () => {
    expect(MO.movers(rows, fr, 'value', 'HNX', { n: 50 }).every((r) => r.exchange === 'HNX')).toBe(true);
    const etf = rows.filter((r) => r.type === 'ETF')[0];
    expect(MO.movers(rows, fr, 'value', 'ALL', { n: 100 }).some((r) => r.symbol === etf.symbol)).toBe(false);
    expect(MO.movers(rows, fr, 'value', 'ALL', { n: 100, includeEtf: true }).some((r) => r.symbol === etf.symbol)).toBe(true);
  });
  it('cờ trần/sàn khớp số mã trần/sàn của breadth (dữ liệu thật)', () => {
    const all = MO.movers(rows, fr, 'value', 'ALL', { n: 1000 });
    expect(all.filter((r) => r.atCeil).length).toBe(MO.breadth(rows, 'ALL').ceil);
    expect(all.filter((r) => r.atFloor).length).toBe(MO.breadth(rows, 'ALL').floor);
    expect(all.every((r) => !(r.atCeil && r.atFloor))).toBe(true);
  });
  it('dữ liệu rỗng không ném lỗi', () => {
    MO.MOVER_KINDS.forEach((k) => expect(MO.movers([], [], k.key, 'ALL')).toEqual([]));
    expect(MO.movers(null, null, 'gain')).toEqual([]);
  });
});

describe('ngành trong ngày', () => {
  const mk = (sym, ref, price, value) => ({ data: [{ code: sym, type: 'STOCK', floor: 'HOSE', basicPrice: ref, close: price, nmVolume: 1, nmValue: value, date: 'd' }] }).data[0];
  const p = MO.parsePrices({ data: [mk('A1', 10, 11, 5e9), mk('A2', 10, 9, 1e9), mk('B1', 10, 10, 1e9), mk('B2', 10, 10.5, 1e9), mk('Z', 10, 12, 1e9)] });
  const uni = [
    { symbol: 'A1', icb2_code: '8300', metrics: { marketcap: 300 } }, { symbol: 'A2', icb2_code: '8300', metrics: { marketcap: 100 } },
    { symbol: 'B1', icb2_code: '8600', metrics: { marketcap: 100 } }, { symbol: 'B2', icb2_code: '8600', metrics: { marketcap: 100 } },
    { symbol: 'Z', icb2_code: '9500', metrics: { marketcap: 50 } },                        // ngành chỉ 1 mã: bỏ
    { symbol: 'NOPRICE', icb2_code: '8300', metrics: { marketcap: 100 } },                // thiếu giá: không vào, làm giảm độ phủ
    { symbol: 'NOCAP', icb2_code: '8300', metrics: {} },
  ];
  it('trung bình gia quyền vốn hoá, sắp giảm dần, bỏ ngành dưới 2 mã', () => {
    const r = MO.sectorsToday(p, uni, { '8300': 'Ngân hàng', '8600': 'Bất động sản' });
    expect(r.sectors.map((s) => s.name)).toEqual(['Ngân hàng', 'Bất động sản']);
    expect(r.sectors[0].pct).toBeCloseTo((300 * 10 + 100 * -10) / 400, 9);                 // +5%
    expect(r.sectors[1].pct).toBeCloseTo((100 * 0 + 100 * 5) / 200, 9);                    // +2,5%
    expect(r.sectors[0].up).toBe(1); expect(r.sectors[0].down).toBe(1);
  });
  it('độ phủ là phần vốn hoá có giá hôm nay; market là gia quyền cả thị trường', () => {
    const r = MO.sectorsToday(p, uni, {});
    expect(r.coverage).toBeCloseTo(650 / 750, 9);
    expect(r.market).toBeCloseTo((300 * 10 - 100 * 10 + 0 + 100 * 5 + 50 * 20) / 650, 9);
  });
  it('thiếu dữ liệu: rỗng và độ phủ 0, không ném', () => {
    expect(MO.sectorsToday([], uni, {})).toEqual({ sectors: [], coverage: 0, market: null });
    expect(MO.sectorsToday(p, [], {}).sectors).toEqual([]);
    expect(MO.sectorsToday(null, null, null).coverage).toBe(0);
  });
});

describe('hiệu suất nhiều kỳ và kỹ thuật (dữ liệu thật, số kỳ vọng từ Python)', () => {
  const d = MO.parseDaily(FX.daily);
  const cl = (arr) => arr.map((c, i) => ({ date: '2026-01-' + String(i + 1).padStart(2, '0'), o: c, h: c, l: c, c: c, v: 1 }));
  it('returns: 1 phiên, 1 tuần, 1 tháng khớp; kỳ dài hơn dữ liệu là null (không đoán)', () => {
    const r = MO.returns(d);
    expect(r.d1).toBeCloseTo(-0.8224068803859952, 9);
    expect(r.w1).toBeCloseTo(-0.5905219230549319, 9);
    expect(r.m1).toBeCloseTo(-4.9971591529905375, 9);
    expect(r.m3).toBe(null); expect(r.y1).toBe(null);
  });
  it('returns từ đầu năm lấy đóng cửa phiên cuối năm trước; chưa có phiên năm trước thì null', () => {
    const rows = [{ date: '2025-12-30', c: 100 }, { date: '2025-12-31', c: 110 }, { date: '2026-01-02', c: 121 }, { date: '2026-01-05', c: 132 }].map((x) => Object.assign({ o: x.c, h: x.c, l: x.c, v: 1 }, x));
    expect(MO.returns(rows).ytd).toBeCloseTo(20, 9);
    expect(MO.returns(rows.slice(2)).ytd).toBe(null);
    expect(MO.returns([]).d1).toBe(null);
    expect(MO.returns(null).ytd).toBe(null);
  });
  it('RSI Wilder khớp tính độc lập và các trường hợp biên', () => {
    expect(MO.rsi(d, 14)).toBeCloseTo(34.98088391891139, 9);
    expect(MO.rsi(cl([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 14)).toBe(100);
    expect(MO.rsi(cl(Array(20).fill(5)), 14)).toBe(50);
    expect(MO.rsi(cl([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5]), 14)).toBe(0);
    expect(MO.rsi(cl([1, 2, 3]), 14)).toBe(null);
  });
  it('technical: MA20, vùng 52 tuần, vị trí; thiếu MA200 thì không kết luận', () => {
    const t = MO.technical(d);
    expect(t.ma.ma20.value).toBeCloseTo(1782.013, 6);
    expect(t.ma.ma20.vsPct).toBeCloseTo(-2.415414477896627, 9);
    expect(t.ma.ma200.value).toBe(null);
    expect(t.place).toBe(null);
    expect(t.range52.high).toBe(1874.48); expect(t.range52.low).toBe(1726);
    expect(t.range52.posPct).toBeCloseTo(8.735183189655189, 9);
    expect(t.range52.fromHighPct).toBeCloseTo(-7.229204899492125, 9);
    expect(t.rsiState).toBe('Trung tính');
    expect(MO.technical([])).toBe(null);
  });
  it('technical với đủ 200 phiên: vị trí so với MA50/MA200 và giao cắt', () => {
    const up = MO.technical(cl(Array.from({ length: 220 }, (_, i) => 100 + i)));
    expect(up.place).toBe('Trên cả MA50 và MA200'); expect(up.ma50AboveMa200).toBe(true);
    const dn = MO.technical(cl(Array.from({ length: 220 }, (_, i) => 400 - i)));
    expect(dn.place).toBe('Dưới cả MA50 và MA200'); expect(dn.ma50AboveMa200).toBe(false);
    const mid = MO.technical(cl(Array.from({ length: 220 }, (_, i) => (i < 150 ? 100 + i : 300 - (i - 150) * 3))));
    expect(['Nằm giữa MA50 và MA200', 'Dưới cả MA50 và MA200', 'Trên cả MA50 và MA200']).toContain(mid.place);
    expect(MO.technical(cl(Array.from({ length: 220 }, (_, i) => 100 + i))).rsiState).toBe('Vùng quá mua');
    expect(MO.technical(cl(Array.from({ length: 220 }, (_, i) => 400 - i))).rsiState).toBe('Vùng quá bán');
  });
});

describe('mức tác động lên chỉ số', () => {
  const CAPS = { VIC: 1772387135520000, VHM: 558608032544000, VPB: 234000000000000, TCB: 228885565372200, HPG: 171814327982000, BSR: 158981765030500, HDB: 140648264676300, STB: 125932409828800, MSN: 115428321291200, MWG: 113480875213400, FPT: 112577940585600, SSI: 58975884984300, SHB: 52750801303200, PLX: 45995438907000, NVL: 32988400148800, VIX: 30101625836100 };
  const uni = Object.keys(CAPS).map((s) => ({ symbol: s, metrics: { marketcap: CAPS[s] } }));
  it('khớp số tính độc lập trên bảng giá thật (16 mã HOSE): tổng điểm, mã kéo xuống/lên nhiều nhất', () => {
    const c = MO.contributions(rows, uni, 'HOSE', 1753.39);
    expect(c.n).toBe(16);
    expect(c.sumPoints).toBeCloseTo(-19.61415641563317, 2);          // Python dùng pctChange đã làm tròn 4 số của nguồn; thư viện tính từ giá nên chính xác hơn
    expect(c.down[0].symbol).toBe('VHM'); expect(c.down[0].points).toBeCloseTo(-8.379588381424647, 2);
    expect(c.down[1].symbol).toBe('VIC');
    expect(c.up[0].symbol).toBe('PLX'); expect(c.up[0].points).toBeCloseTo(0.7889044471516269, 2);
    expect(c.up.every((i) => i.points > 0) && c.down.every((i) => i.points < 0)).toBe(true);
  });
  it('trường hợp tính tay: điểm = chỉ số × vốn hoá × % / tổng vốn hoá; mã khác sàn, thiếu vốn hoá hoặc thiếu giá bị bỏ', () => {
    const p = MO.parsePrices({ data: [
      { code: 'A', type: 'STOCK', floor: 'HOSE', basicPrice: 10, close: 11, date: 'd' }, { code: 'B', type: 'STOCK', floor: 'HOSE', basicPrice: 10, close: 9, date: 'd' },
      { code: 'H', type: 'STOCK', floor: 'HNX', basicPrice: 10, close: 12, date: 'd' }, { code: 'N', type: 'STOCK', floor: 'HOSE', basicPrice: 10, close: 12, date: 'd' } ] });
    const u = [{ symbol: 'A', metrics: { marketcap: 300 } }, { symbol: 'B', metrics: { marketcap: 100 } }, { symbol: 'H', metrics: { marketcap: 500 } }, { symbol: 'N', metrics: {} }, { symbol: 'Z', metrics: { marketcap: 50 } }];
    const c = MO.contributions(p, u, 'HOSE', 1000);
    expect(c.n).toBe(2);
    expect(c.items.find((i) => i.symbol === 'A').points).toBeCloseTo(1000 * 300 * 0.10 / 400, 9);       // +75
    expect(c.items.find((i) => i.symbol === 'B').points).toBeCloseTo(1000 * 100 * -0.10 / 400, 9);      // -25
    expect(c.sumPoints).toBeCloseTo(50, 9);
    expect(c.coverage).toBeCloseTo(2 / 3, 9);                  // 2 trên 3 cổ phiếu HOSE có giá được ghép vốn hoá
  });
  it('thiếu dữ liệu trả rỗng, không ném', () => {
    expect(MO.contributions([], uni, 'HOSE', 1700).n).toBe(0);
    expect(MO.contributions(rows, [], 'HOSE', 1700).sumPoints).toBe(null);
    expect(MO.contributions(rows, uni, 'HOSE', null).n).toBe(0);
    expect(MO.contributions(null, null, 'HOSE', 1)).toEqual({ items: [], up: [], down: [], sumPoints: null, coverage: 0, n: 0 });
  });
});

describe('hình học biểu đồ', () => {
  it('đường nằm trọn trong khung, điểm tăng ở trên điểm giảm, tham chiếu nằm giữa khi nằm giữa dữ liệu', () => {
    const g = MO.lineGeometry([{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }], 300, 100, { include: [15] });
    expect(g.coords[1].py).toBeLessThan(g.coords[0].py);
    expect(g.coords[0].px).toBe(8); expect(g.coords[2].px).toBe(292);
    g.coords.forEach((c) => { expect(c.py).toBeGreaterThanOrEqual(10); expect(c.py).toBeLessThanOrEqual(90); });
    expect(g.refY).toBeGreaterThan(g.coords[1].py); expect(g.refY).toBeLessThan(g.coords[0].py);
    expect(g.d.startsWith('M')).toBe(true);
    expect(g.area.endsWith('Z')).toBe(true);
  });
  it('giá phẳng và dữ liệu thiếu không chia cho 0 hay ném', () => {
    const flat = MO.lineGeometry([{ x: 0, y: 5 }, { x: 1, y: 5 }], 200, 80);
    expect(flat.coords.every((c) => isFinite(c.py))).toBe(true);
    expect(MO.lineGeometry([{ x: 0, y: 5 }], 200, 80)).toBe(null);
    expect(MO.lineGeometry([], 200, 80)).toBe(null);
    expect(MO.lineGeometry([{ x: 0, y: 1 }, { x: 1, y: 2 }], 0, 80)).toBe(null);
    expect(MO.lineGeometry([{ x: 3, y: 1 }, { x: 3, y: 2 }], 200, 80).coords.every((c) => isFinite(c.px))).toBe(true);
  });
  it('trục giờ giao dịch rút gọn bỏ giờ nghỉ trưa và ATC đến 15:00', () => {
    expect(MO.sessionX(540)).toBe(0);
    expect(MO.sessionX(690)).toBe(150);
    expect(MO.sessionX(720)).toBe(150);                 // nghỉ trưa không chiếm chỗ
    expect(MO.sessionX(780)).toBe(150);
    expect(MO.sessionX(870)).toBe(240);
    expect(MO.sessionX(900)).toBe(270);
    expect(MO.sessionX(1000)).toBe(270);
    expect(MO.sessionX(100)).toBe(0);
  });
  it('intradayPoints: một điểm mỗi phút, sắp theo giờ', () => {
    const pts = MO.intradayPoints([{ min: 545, c: 1, v: 1 }, { min: 541, c: 2, v: 1 }, { min: 545, c: 3, v: 1 }]);
    expect(pts.map((p) => p.label)).toEqual(['09:01', '09:05']);
    expect(pts[1].y).toBe(3);
  });
  it('dữ liệu thật: nến phút của VN-Index dựng được biểu đồ trong ngày', () => {
    const pts = MO.intradayPoints(MO.parseIntraday(FX.intraday));
    const g = MO.lineGeometry(pts, 600, 200, { xMin: 0, xMax: 270, include: [1753.39] });
    expect(g.coords.length).toBe(pts.length);
    expect(g.refY).toBeGreaterThan(0);
  });
});

describe('hằng số', () => {
  it('chỉ số có mã duy nhất và sàn hợp lệ; thời gian lùi của khoảng xem tăng dần', () => {
    expect(new Set(MO.INDICES.map((i) => i.code)).size).toBe(MO.INDICES.length);
    MO.INDICES.forEach((i) => expect(['HOSE', 'HNX', 'UPCOM']).toContain(i.exchange));
    const s = MO.RANGES.map((r) => r.sessions);
    expect(s).toEqual(s.slice().sort((a, b) => a - b));
  });
});

describe('giờ cập nhật của số liệu: latestTime', () => {
  it('bảng giá thật: giờ mới nhất của phiên 08/10 là 15:10:05 (Python độc lập, đã bỏ quỹ OTC ghi 16:10:20 vì không phải cổ phiếu/ETF); dòng ngày khác bị bỏ', () => {
    expect(MO.latestTime(rows, '2026-10-08')).toBe('15:10:05');
    expect(MO.latestTime(rows, '2026-10-07')).toBeNull();
    expect(MO.latestTime([{ date: '2026-10-08', time: '09:15:00' }, { date: '2026-10-08', time: '14:29:55' }, { date: '2026-10-09', time: '23:00:00' }, { date: '2026-10-08', time: null }, { date: '2026-10-08', time: 'abc' }], '2026-10-08')).toBe('14:29:55');
    expect(MO.latestTime(null, '2026-10-08')).toBeNull();
    expect(MO.latestTime([], null)).toBeNull();
  });
});

describe('giờ cập nhật của số liệu: freshness', () => {
  const at = (date, hm) => { const [y, m, d] = date.split('-').map(Number), [h, mi] = hm.split(':').map(Number); return Date.UTC(y, m - 1, d, h - 7, mi, 30); };   // giờ Việt Nam -> mili giây, lẫn 30 giây để chắc chắn phần giây không làm lệch phút
  const f = (o) => MO.freshness(Object.assign({ session: 'open' }, o));

  it('trong phiên, có giờ: trễ 0-3 phút là ok, 4-10 phút là warn, hơn 10 phút là stale; trễ dưới 1 phút ghi "mới cập nhật"', () => {
    const d = '2026-10-08';
    expect(f({ date: d, time: '10:30', nowMs: at(d, '10:30') })).toEqual({ text: 'lúc 10:30 · mới cập nhật', tone: 'ok', lagMin: 0 });
    expect(f({ date: d, time: '10:30', nowMs: at(d, '10:32') })).toEqual({ text: 'lúc 10:30 · trễ 2 phút', tone: 'ok', lagMin: 2 });
    expect(f({ date: d, time: '10:30', nowMs: at(d, '10:33') }).tone).toBe('ok');
    expect(f({ date: d, time: '10:30', nowMs: at(d, '10:34') })).toMatchObject({ tone: 'warn', lagMin: 4 });
    expect(f({ date: d, time: '10:30', nowMs: at(d, '10:40') })).toMatchObject({ tone: 'warn', lagMin: 10 });
    expect(f({ date: d, time: '10:30', nowMs: at(d, '10:41') })).toMatchObject({ tone: 'stale', lagMin: 11, text: 'lúc 10:30 · trễ 11 phút' });
  });
  it('đồng hồ máy chạy chậm hơn giờ dữ liệu thì tính là 0 phút, không ra số âm', () => {
    expect(f({ date: '2026-10-08', time: '10:30', nowMs: at('2026-10-08', '10:28') })).toMatchObject({ lagMin: 0, tone: 'ok', text: 'lúc 10:30 · mới cập nhật' });
  });
  it('trong phiên mà dữ liệu là của ngày trước: cảnh báo chưa có số liệu hôm nay', () => {
    expect(f({ date: '2026-10-07', time: '15:05', nowMs: at('2026-10-08', '09:20') })).toEqual({ text: 'phiên 07/10 lúc 15:05 · chưa có số liệu của hôm nay', tone: 'warn', lagMin: null });
  });
  it('nghỉ trưa không bị tính là trễ; ngoài phiên chỉ ghi giờ chốt', () => {
    expect(f({ session: 'break', date: '2026-10-08', time: '11:30', nowMs: at('2026-10-08', '12:15') })).toEqual({ text: 'lúc 11:30 · nghỉ trưa', tone: 'ok', lagMin: null });
    expect(f({ session: 'closed', date: '2026-10-08', time: '15:05', nowMs: at('2026-10-08', '18:00') })).toEqual({ text: 'lúc 15:05', tone: 'ok', lagMin: null });
    expect(f({ session: 'pre', date: '2026-10-08', time: '15:05', nowMs: at('2026-10-09', '08:00') })).toEqual({ text: 'phiên 08/10 lúc 15:05', tone: 'ok', lagMin: null });
  });
  it('ngày Việt Nam tính theo múi giờ +7: 23:30 UTC ngày 08 đã là sáng 09 ở Việt Nam', () => {
    const now = Date.UTC(2026, 9, 8, 23, 30);
    expect(MO.freshness({ session: 'closed', date: '2026-10-08', time: '15:05', nowMs: now }).text).toBe('phiên 08/10 lúc 15:05');
    expect(MO.freshness({ session: 'closed', date: '2026-10-09', time: '06:00', nowMs: now }).text).toBe('lúc 06:00');
  });
  it('số liệu quá cũ (mặc định hơn 5 ngày, đổi được bằng staleDays) bị báo cũ; đúng 5 ngày thì chưa', () => {
    const now = at('2026-10-08', '10:00');
    expect(f({ session: 'closed', date: '2026-10-03', time: '15:05', nowMs: now }).tone).toBe('ok');
    expect(f({ session: 'closed', date: '2026-10-02', time: '15:05', nowMs: now })).toMatchObject({ tone: 'stale', text: 'phiên 02/10 lúc 15:05 · số liệu cũ' });
    expect(f({ session: 'closed', date: '2026-08-25', nowMs: now, dateOnly: true, staleDays: 45 }).tone).toBe('ok');
    expect(f({ session: 'closed', date: '2026-08-23', nowMs: now, dateOnly: true, staleDays: 45 })).toMatchObject({ tone: 'stale', text: 'phiên 23/08 · số liệu cũ' });
  });
  it('nguồn không ghi giờ: nói rõ và chỉ cho biết lúc tải; dateOnly bỏ câu đó; trong phiên vẫn ok vì không đo được độ trễ', () => {
    const now = at('2026-10-08', '10:32');
    expect(f({ date: '2026-10-08', time: null, nowMs: now, loadedMs: at('2026-10-08', '10:31') })).toEqual({ text: 'hôm nay · nguồn không ghi giờ, tải lúc 10:31', tone: 'ok', lagMin: null });
    expect(f({ date: '2026-10-08', nowMs: now }).text).toBe('hôm nay · nguồn không ghi giờ');
    expect(f({ date: '2026-10-08', nowMs: now, dateOnly: true }).text).toBe('hôm nay');
  });
  it('untimedNote thay cho câu "nguồn không ghi giờ" khi thiếu giờ vì lý do khác; có giờ thì không dùng', () => {
    const now = at('2026-10-08', '09:05');
    expect(f({ date: '2026-10-08', time: null, nowMs: now, loadedMs: now, untimedNote: 'chưa có nến phút' }).text).toBe('hôm nay · chưa có nến phút');
    expect(f({ date: '2026-10-08', time: '09:04', nowMs: now, untimedNote: 'chưa có nến phút' }).text).toBe('lúc 09:04 · trễ 1 phút');
  });
  it('thiếu hoặc sai ngày thì không có nhãn; giờ sai định dạng coi như không có giờ; chuỗi lạ không lọt vào nhãn', () => {
    expect(MO.freshness(null)).toBeNull();
    expect(MO.freshness({})).toBeNull();
    expect(MO.freshness({ date: 'hôm qua', nowMs: 0 })).toBeNull();
    expect(MO.freshness({ date: '<b>2026-10-08', nowMs: 0 })).toBeNull();
    const r = f({ date: '2026-10-08', time: '<i>x', nowMs: at('2026-10-08', '10:00') });
    expect(r.text).toBe('hôm nay · nguồn không ghi giờ');
  });
});
