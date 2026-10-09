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
