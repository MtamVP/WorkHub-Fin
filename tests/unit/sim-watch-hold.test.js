// Máy chủ chấm phần "danh mục giữ nguyên" của nhật ký mô phỏng (lib/sim-watch.js: adjustSeries / alignCloses / buildStocks, supabase/functions/sim-watch).
// Mấu chốt: giá các mã điều chỉnh và căn lịch PHẢI giống hệt cách trang làm (RiskCalc), và nguồn giá / sự kiện dùng cùng bộ chuẩn hoá với stock-history / stock-events.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import SM from '../../lib/sim-models.js';
import MS from '../../lib/market-sim.js';
import SS from '../../lib/sim-score.js';
import SW from '../../lib/sim-watch.js';
import RiskCalc from '../../lib/risk-calc.js';
import { parseDchart as histParse } from '../../supabase/functions/stock-history/parse.ts';
import { SIMWATCH_TS } from '../../scripts/sync-edge-libs.mjs';

const root = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

// Chuỗi giá tổng hợp 600 ngày (cuối tuần có mặt như dữ liệu thật: có ngày thiếu)
function series(seed, n, drop) {
  const R = SM.rng(seed), out = []; let p = 30000;
  for (let t = 0; t < n; t++) {
    const d = new Date(Date.UTC(2024, 0, 1) + t * 86400000), day = d.getUTCDay();
    p *= Math.exp(0.012 * R.n());
    if (day === 0 || day === 6) continue;
    if (drop && R.u() < drop) continue;
    out.push([d.toISOString().slice(0, 10), Math.round(p)]);
  }
  return out;
}
const IDX = series(1, 600, 0), EVENTS = [
  { symbol: 'AAA', kind: 'bonus', exDate: '2025-03-10', ratio: 20 },
  { symbol: 'AAA', kind: 'cash_dividend', exDate: '2025-06-02', dps: 1500 },
  { symbol: 'AAA', kind: 'stock_dividend', exDate: '2025-08-20', ratio: 10 },
  { symbol: 'BBB', kind: 'cash_dividend', exDate: '2024-12-02', dps: 800 },
  { symbol: 'AAA', kind: 'rights', exDate: '2025-01-15', ratio: 10 },
];

describe('giá các mã: khớp RiskCalc của trang', () => {
  it('adjustSeries cho cùng kết quả (thưởng, cổ tức cổ phiếu, cổ tức tiền; quyền mua không đổi giá)', () => {
    const s = series(2, 600, 0.05);
    ['AAA', 'BBB', 'CCC'].forEach((sym) => expect(SW.adjustSeries(s, EVENTS, sym)).toEqual(RiskCalc.adjustSeries(s, EVENTS, sym)));
  });
  it('căn theo lịch VN-Index (điền tiếp tối đa 5 ngày) cho cùng kết quả với alignSeries', () => {
    const idx = IDX, s = series(3, 600, 0.12).filter((_, i) => i < 150 || i > 170), adj = RiskCalc.adjustSeries(s, EVENTS, 'AAA');
    const al = RiskCalc.alignSeries({ VNINDEX: idx, AAA: adj }, ['AAA'], { windowDays: 100000, benchKey: 'VNINDEX' });
    const mine = SW.alignCloses(idx.map((p) => p[0]), adj);
    expect(mine).toEqual(al.closes.AAA);
    expect(mine.some((v) => v === null)).toBe(true);       // dữ liệu thử có ngày thiếu quá 5 ngày -> có null như RiskCalc, không phải chuỗi đầy đặn
  });
  it('buildStocks dựng đúng khuôn SimScore.scoreRun cần', () => {
    const b = SW.buildStocks({ dates: IDX.map((p) => p[0]), index: IDX.map((p) => p[1]) }, { AAA: series(4, 600, 0) }, EVENTS);
    expect(Object.keys(b)).toEqual(['dates', 'index', 'stocks']);
    expect(b.stocks.AAA.length).toBe(b.dates.length);
  });
});

describe('nguồn giá / sự kiện: cùng bộ chuẩn hoá với hàm của app', () => {
  it('parseDchart(raw, 1000) của sim-watch = parseDchart của stock-history cho cổ phiếu', () => {
    const t = (d) => Date.parse(d + 'T07:00:00Z') / 1000;
    const raw = { s: 'ok', t: [t('2026-10-01'), t('2026-10-02'), t('2026-10-02'), t('2026-10-05'), t('2026-10-06')], c: [59.7, 60.15, 60.2, 0, 61.333] };
    const mine = SW.parseDchart(raw, 1000), theirs = histParse(raw, 'FPT');
    expect(mine.dates.map((d, i) => [d, mine.index[i]])).toEqual(theirs);
  });
  it('events-parse.ts trong sim-watch là bản sao nguyên văn parse.ts của stock-events (node scripts/sync-edge-libs.mjs nếu lệch)', () => {
    SIMWATCH_TS.forEach((c) => expect(read(c.to)).toBe(read(c.from)));
  });
  it('index.ts nạp bản sao, dùng đúng nguồn VNDirect và không lộ khoá', () => {
    const src = read('supabase/functions/sim-watch/index.ts');
    expect(src).toContain('from "./events-parse.ts"');
    expect(src).toContain('dchart-api.vndirect.com.vn/dchart/history'); expect(src).toContain('api-finfo.vndirect.com.vn/v4/events');
    expect(src).toContain('SimWatch.buildStocks');
    expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|sb_publishable_/);
  });
});

describe('chấm danh mục giữ nguyên ở máy chủ', () => {
  const N = 1700, DATES = [], IX = [1000], R = SM.rng(8);
  for (let t = 0; t < N; t++) DATES.push(new Date(Date.UTC(2019, 0, 1) + t * 86400000).toISOString().slice(0, 10));
  for (let t = 1; t < N; t++) IX.push(IX[t - 1] * Math.exp(0.0004 + 0.01 * R.n()));
  const CUT = 1500, L0 = IX[CUT - 1];
  const past = { dates: DATES.slice(0, CUT), index: IX.slice(0, CUT) };
  const stocks = { AAA: { closes: IX.slice(0, CUT).map((v) => 50000 * v / IX[0]), exchange: 'HOSE', adv: 5e9 }, BBB: { closes: IX.slice(0, CUT).map((v) => 20000 * Math.pow(v / IX[0], 1.3)), exchange: 'HOSE', adv: 5e9 } };
  const ctx = MS.prepare({ dates: past.dates, index: past.index, stocks: stocks }, {});
  const book = { cash: 50e6, debt: 0, positions: [{ symbol: 'AAA', qty: 1000, price: stocks.AAA.closes[CUT - 1] }, { symbol: 'BBB', qty: 2000, price: stocks.BBB.closes[CUT - 1] }] };
  const res = MS.simulate(ctx, book, [MS.PRESETS[0]], { paths: 1500, seed: 2 });
  const snap = SS.snapshot(res, null, { asOf: past.dates[CUT - 1], indexLevel: L0, subject: 'mine', cash: book.cash, debt: 0 });
  // đường thật SAU ngày chạy: AAA đi theo chỉ số nhưng có thưởng cổ phiếu 25% ở phiên thứ 10 (giá thô rơi 20%)
  const exDate = DATES[CUT + 9];
  const rawA = DATES.map((d, i) => [d, Math.round(50000 * IX[i] / IX[0] * (d >= exDate ? 0.8 : 1))]);
  const rawB = DATES.map((d, i) => [d, Math.round(20000 * Math.pow(IX[i] / IX[0], 1.3))]);
  const idx = { dates: DATES, index: IX };

  it('có sự kiện thưởng: giá đã điều chỉnh cho lợi suất đúng; bỏ qua sự kiện thì sai rõ rệt', () => {
    const ev = [{ symbol: 'AAA', kind: 'bonus', exDate, ratio: 25 }];
    const adj = SS.scoreRun(snap, SW.buildStocks(idx, { AAA: rawA, BBB: rawB }, ev)), raw = SS.scoreRun(snap, SW.buildStocks(idx, { AAA: rawA, BBB: rawB }, []));
    const a = adj.horizons[2], b = raw.horizons[2];
    expect(a.due).toBe(true);
    // so với lợi suất đúng tính tay từ chuỗi gốc (không bị thưởng)
    const i0 = CUT - 1, iT = i0 + 63;
    const qty = { A: snap.positions[0].qty, B: snap.positions[1].qty }, p0 = { A: snap.positions[0].price, B: snap.positions[1].price };
    const truth = (qty.A * p0.A * (IX[iT] / IX[i0]) + qty.B * p0.B * Math.pow(IX[iT] / IX[i0], 1.3) + snap.cash) / snap.nav0 - 1;
    expect(Math.abs(a.hold.ret - truth)).toBeLessThan(0.002);
    expect(b.hold.ret).toBeLessThan(a.hold.ret - 0.02);
  });
  it('digest ghi phần danh mục giữ nguyên (ret, pit, in90) cho mốc đã tới', () => {
    const sc = SS.scoreRun(snap, SW.buildStocks(idx, { AAA: rawA, BBB: rawB }, [{ symbol: 'AAA', kind: 'bonus', exDate, ratio: 25 }]));
    const w = SW.digest(snap, {}, sc, null, 'T');
    w.horizons.filter((h) => h.due).forEach((h) => { expect(h.hold).toBeTruthy(); expect(typeof h.hold.ret).toBe('number'); expect(typeof h.hold.in90).toBe('boolean'); expect(h.hold.pit).toBeGreaterThanOrEqual(0); });
    const idxOnly = SW.digest(snap, {}, SS.scoreRun(snap, idx), null, 'T');
    idxOnly.horizons.filter((h) => h.due).forEach((h) => expect(h.hold).toBeUndefined());
    expect(JSON.stringify(w).length).toBeLessThan(4000);
  });
  it('thiếu giá một mã chiếm hơn 25% giá trị thì không chấm (không đoán)', () => {
    const sc = SS.scoreRun(snap, SW.buildStocks(idx, { AAA: rawA }, []));        // BBB (>50% giá trị) không có giá
    sc.horizons.filter((h) => h.due).forEach((h) => expect(h.hold).toBeUndefined());
  });
});
