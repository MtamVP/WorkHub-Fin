// Kho giá cho kiểm thử chiến lược: supabase/functions/bt-data (bt-logic.ts + bản sao peers.ts / logic.ts của market-data-sync).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BTDATA_TS } from '../../scripts/sync-edge-libs.mjs';
import { parseDay, parseIndex, missingDays, monthEndTradingDays, lagOf, knownByDate, filterQuarterPit, quarterWindow, packPit, pitRound, buildPitDay, PIT_COLS, MIN_STOCKS_PER_DAY } from '../../supabase/functions/bt-data/bt-logic.ts';

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('bản sao dùng chung với market-data-sync', () => {
  it.each(BTDATA_TS)('$to khớp $from (node scripts/sync-edge-libs.mjs nếu lệch)', (c) => {
    expect(read(c.to)).toBe(read(c.from));
  });
});

describe('parseDay: một ngày của finfo stock_prices', () => {
  const row = (code, o) => Object.assign({ code, type: 'STOCK', floor: 'HOSE', close: 10, basicPrice: 10, ceilingPrice: 10.7, floorPrice: 9.3, nmValue: 5e9 }, o || {});
  it('giữ đóng cửa thô, tham chiếu, giá trị (triệu đồng), cờ trần/sàn và sàn', () => {
    const p = parseDay({ data: [row('AAA', { close: 10.7, nmValue: 12.34e9 }), row('BBB', { close: 9.3, floor: 'HNX' }), row('CCC', { floor: 'HOSE' })] });
    expect(p.data.AAA[0]).toBe(10.7); expect(p.data.AAA.slice(2)).toEqual([12340, 1, 0]);
    expect(p.data.BBB[0]).toBe(9.3); expect(p.data.BBB.slice(2)).toEqual([5000, -1, 1]);
    expect(p.data.CCC[3]).toBe(0);
  });
  it('bỏ ETF/chỉ số, mã sai định dạng, giá không dương; GIỮ MỌI mã có giá kể cả UPCoM không giao dịch (chuỗi lợi suất phải liền mạch)', () => {
    const p = parseDay({ data: [row('ETF1', { type: 'ETF' }), row('bad code'), row('ZERO', { close: 0 }), row('NOREF', { basicPrice: 0 }), row('UPNONE', { floor: 'UPCOM', nmValue: 0 }), row('UPOK', { floor: 'UPCOM', nmValue: 9e9 }), row('HNXLOW', { floor: 'HNX', nmValue: 0 })] });
    expect(Object.keys(p.data).sort()).toEqual(['HNXLOW', 'UPNONE', 'UPOK']);
    expect(p.stocks).toBe(3); expect(p.kept).toBe(3);
    expect(p.data.UPNONE).toEqual([10, 0, 0, 0, 2]);
  });
  it('không có ngày trước: lợi suất dự phòng = đóng cửa / tham chiếu - 1 (DPM 03/08/2026: 22,2 / 22,05)', () => {
    const p = parseDay({ data: [row('DPM', { close: 22.2, basicPrice: 22.05 })] });
    expect(p.data.DPM[1]).toBeCloseTo(0.0068, 4);
  });
  it('có ngày trước trong cùng phản hồi: lợi suất = adClose(D) / adClose(D-1) - 1, đã gồm cổ tức (DPM trả 1.500đ ngày 03/08/2026: adClose 22,05 -> 22,2 = +0,68%)', () => {
    const json = { data: [
      { code: 'DPM', date: '2026-07-31', type: 'STOCK', floor: 'HOSE', close: 23.55, basicPrice: 23.45, adClose: 22.05, ceilingPrice: 25, floorPrice: 21 },
      { code: 'DPM', date: '2026-08-03', type: 'STOCK', floor: 'HOSE', close: 22.2, basicPrice: 22.05, adClose: 22.2, ceilingPrice: 23.5, floorPrice: 20.5 },
    ] };
    const p = parseDay(json, '2026-08-03', '2026-07-31');
    expect(Object.keys(p.data)).toEqual(['DPM']); expect(p.data.DPM[0]).toBe(22.2); expect(p.data.DPM[1]).toBeCloseTo(22.2 / 22.05 - 1, 5);
    expect(22.2 / 23.55 - 1).toBeLessThan(-0.05);                          // giá thô giảm 5,7% nhưng lợi suất tổng chỉ +0,68%
  });
  it('HNX / UPCoM: tham chiếu là giá BÌNH QUÂN hôm trước nên close/tham chiếu sai; dùng adClose hai ngày (không sinh nhịp tăng giả)', () => {
    const json = { data: [
      { code: 'PNX', date: '2026-10-08', type: 'STOCK', floor: 'UPCOM', close: 0.4, basicPrice: 0.4, adClose: 0.4 },
      { code: 'PNX', date: '2026-10-09', type: 'STOCK', floor: 'UPCOM', close: 0.4, basicPrice: 0.3, adClose: 0.4 },
    ] };
    expect(parseDay(json, '2026-10-09', '2026-10-08').data.PNX[1]).toBe(0);                 // chuỗi đúng: 0,4 -> 0,4 = 0%
    expect(parseDay(json, '2026-10-09').data.PNX[1]).toBeCloseTo(0.4 / 0.3 - 1, 4);        // cách sai cũ cho +33%
  });
  it('mã mới (không có giá ngày trước) rơi về cách dự phòng', () => {
    const json = { data: [{ code: 'NEW', date: '2026-10-09', type: 'STOCK', floor: 'HOSE', close: 11, basicPrice: 10, adClose: 11 }, { code: 'OLD', date: '2026-10-08', type: 'STOCK', floor: 'HOSE', close: 5, basicPrice: 5, adClose: 5 }] };
    expect(parseDay(json, '2026-10-09', '2026-10-08').data.NEW[1]).toBeCloseTo(0.1, 6);
  });
  it('đầu vào hỏng không làm sập', () => {
    expect(parseDay(null)).toEqual({ stocks: 0, kept: 0, data: {} });
    expect(parseDay({ data: 'x' }).kept).toBe(0);
    expect(MIN_STOCKS_PER_DAY).toBeGreaterThan(300);
  });
});

describe('chuỗi chỉ số và lịch giao dịch', () => {
  const t = (d) => Date.parse(d + 'T00:00:00Z') / 1000;
  it('parseIndex sắp theo ngày, bỏ trùng và giá không dương', () => {
    const r = parseIndex({ s: 'ok', t: [t('2026-10-02'), t('2026-10-05'), t('2026-10-05'), t('2026-10-06'), t('2026-10-07')], c: [1700.123, 1711, 1712, 0, 1720] });
    expect(r.d).toEqual(['2026-10-02', '2026-10-05', '2026-10-07']);
    expect(r.c).toEqual([1700.12, 1711, 1720]);
    expect(parseIndex({ s: 'no_data' })).toEqual({ d: [], c: [] });
  });
  it('missingDays: mới nhất trước, tối đa limit, không trước ngày đầu kho', () => {
    const all = ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07', '2020-01-08'];
    expect(missingDays(all, new Set(['2020-01-07']), 2)).toEqual(['2020-01-08', '2020-01-06']);
    expect(missingDays(all, new Set(), 10, '2020-01-06')).toEqual(['2020-01-08', '2020-01-07', '2020-01-06']);
    expect(missingDays(all, new Set(all), 5)).toEqual([]);
  });
  it('monthEndTradingDays lấy phiên cuối tháng có thật (không phải ngày dương lịch cuối tháng)', () => {
    const days = ['2026-08-28', '2026-08-31', '2026-09-01', '2026-09-29', '2026-09-30', '2026-10-01'];
    expect(monthEndTradingDays(days, '2026-08-01', '2026-10-31')).toEqual(['2026-08-31', '2026-09-30', '2026-10-01']);
    expect(monthEndTradingDays(['2021-01-28', '2021-01-29', '2021-02-26'], '2021-01-01', '2021-02-28')).toEqual(['2021-01-29', '2021-02-26']);
  });
});

describe('số liệu quý chỉ dùng khi đã có thể biết (không nhìn trước tương lai)', () => {
  it('hạn công bố: quý 1-3 sau 45 ngày, quý 4 sau 90 ngày', () => {
    expect(lagOf('2026-03-31')).toBe(45); expect(lagOf('2026-12-31')).toBe(90);
    expect(knownByDate('2026-03-31', '2026-05-15')).toBe(true);
    expect(knownByDate('2026-03-31', '2026-05-14')).toBe(false);
    expect(knownByDate('2025-12-31', '2026-03-31')).toBe(true);
    expect(knownByDate('2025-12-31', '2026-03-30')).toBe(false);
    expect(knownByDate('khong-phai-ngay', '2026-05-15')).toBe(false);
  });
  it('filterQuarterPit loại quý chưa công bố; quarterWindow lùi 200 ngày tới 45 ngày trước', () => {
    const rows = [{ reportDate: '2026-03-31' }, { reportDate: '2026-06-30' }, { reportDate: '2025-12-31' }];
    expect(filterQuarterPit(rows, '2026-07-31').map((r) => r.reportDate)).toEqual(['2026-03-31', '2025-12-31']);
    expect(filterQuarterPit(rows, '2026-08-14').map((r) => r.reportDate)).toEqual(['2026-03-31', '2026-06-30', '2025-12-31']);
    expect(quarterWindow('2026-07-31')).toEqual({ from: '2026-01-12', to: '2026-06-16' });
  });
});

describe('dựng ngược bảng số liệu theo thời điểm', () => {
  it('pitRound giống fn_pit_r: từ 1000 lấy nguyên, còn lại 5 chữ số; không phải số -> null', () => {
    expect(pitRound(12345.678)).toBe(12346); expect(pitRound(0.123456789)).toBe(0.12346); expect(pitRound(-1234.5)).toBe(-1234); expect(pitRound('x')).toBeNull(); expect(pitRound(NaN)).toBeNull();
  });
  it('cột giống hệt fn_pit_capture (đọc thẳng từ tệp SQL)', () => {
    const sql = read('finance-pit-migration.sql');
    const m = /cols text\[\] := array\[([^\]]+)\]/.exec(sql);
    expect(m).toBeTruthy();
    expect(m[1].split(',').map((x) => x.trim().replace(/'/g, ''))).toEqual(PIT_COLS);
  });
  it('packPit: giá và số cổ phần để trống ở ngày dựng ngược, ICB giữ nguyên', () => {
    const p = packPit([{ symbol: 'FPT', icb2_code: '1000', daily_date: '2026-07-31', quarter_date: '2026-03-31', metrics: { pe: 12.123456, marketcap: 1.5e14, roae: 0.25, shares: 1.8e9, price: 99 } }]);
    expect(p.n).toBe(1); expect(p.cols).toEqual(PIT_COLS);
    const a = p.data.FPT, at = (c) => a[PIT_COLS.indexOf(c)];
    expect(at('icb2')).toBe('1000'); expect(at('pe')).toBe(12.12346); expect(at('marketcap')).toBe(1.5e14); expect(at('roae')).toBe(0.25);
    expect(at('price')).toBeNull(); expect(at('shares')).toBeNull(); expect(at('beta')).toBeNull();
  });
  it('buildPitDay: ROE lấy quý đã công bố tại ngày đó (không lấy quý 2/2026 khi ngày là 31/07/2026)', () => {
    const daily = { PRICE_TO_EARNINGS: [{ code: 'AAA', reportDate: '2026-07-31', value: 10, group: 'STOCK' }], MARKETCAP: [{ code: 'AAA', reportDate: '2026-07-31', value: 5e12, group: 'STOCK' }] };
    const quarter = { ROAE_TR_AVG5Q: [{ code: 'AAA', reportDate: '2026-03-31', value: 0.2, group: 'STOCK' }, { code: 'AAA', reportDate: '2026-06-30', value: 0.9, group: 'STOCK' }] };
    const p = buildPitDay('2026-07-31', daily, quarter, () => '3000');
    expect(p.data.AAA[PIT_COLS.indexOf('roae')]).toBe(0.2);
    expect(p.data.AAA[PIT_COLS.indexOf('pe')]).toBe(10);
    const later = buildPitDay('2026-08-20', daily, quarter, () => '3000');      // sau 14/08 quý 2 đã công bố
    expect(later.data.AAA[PIT_COLS.indexOf('roae')]).toBe(0.9);
  });
});

describe('index.ts', () => {
  const src = read('supabase/functions/bt-data/index.ts');
  it('dùng đúng nguồn, chỉ gửi User-Agent (dchart trả 406 nếu có Accept json), không lộ khoá', () => {
    expect(src).toContain('api-finfo.vndirect.com.vn/v4'); expect(src).toContain('dchart-api.vndirect.com.vn/dchart/history');
    expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|sb_publishable_/);
    expect(src).not.toMatch(/Accept["']?\s*:\s*["']application\/json/);
  });
  it('không ghi đè bảng số liệu sống bằng bản dựng ngược (ignoreDuplicates)', () => {
    expect(src).toContain('ignoreDuplicates: true'); expect(src).toContain('source: "backfill"');
  });
  it('nạp đủ các tệp phụ thuộc', () => {
    ['bt-logic.ts', 'peers.ts', 'logic.ts'].forEach((f) => expect(fs.existsSync(path.join(root, 'supabase/functions/bt-data', f))).toBe(true));
    expect(src).toContain('from "./bt-logic.ts"');
  });
});
