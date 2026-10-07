import { describe, it, expect } from 'vitest';
import LA from '../../lib/live-alerts.js';
import LS from '../../lib/live-series.js';

const H = (o) => Object.assign({ symbol: 'FPT', live: true, priceLocked: false, marketPrice: 60000, targetPrice: 0, stopLoss: 0, dayPct: 0 }, o);

describe('LiveAlerts.evaluate', () => {
  it('chạm giá mục tiêu và cắt lỗ; khoá cùng định dạng với notify-deadlines.js', () => {
    const a = LA.evaluate([H({ marketPrice: 70000, targetPrice: 69000 }), H({ symbol: 'HPG', marketPrice: 25000, stopLoss: 25000 })], { movePct: 0 });
    expect(a.map((x) => x.key)).toEqual(['FPT:target:69000', 'HPG:stop:25000']);
    expect(a[0]).toMatchObject({ kind: 'target', price: 70000, threshold: 69000 });
  });
  it('chưa chạm mức thì không báo; mã không có giá trực tiếp hoặc đã khoá giá bị bỏ qua', () => {
    expect(LA.evaluate([H({ marketPrice: 60000, targetPrice: 69000, stopLoss: 50000 })], { movePct: 0 })).toEqual([]);
    expect(LA.evaluate([H({ live: false, marketPrice: 70000, targetPrice: 69000 })], { movePct: 0 })).toEqual([]);
    expect(LA.evaluate([H({ priceLocked: true, marketPrice: 70000, targetPrice: 69000 })], { movePct: 0 })).toEqual([]);
    expect(LA.evaluate([H({ marketPrice: 0, targetPrice: 69000 })], { movePct: 0 })).toEqual([]);
  });
  it('biến động trong ngày vượt ngưỡng: tăng và giảm; đúng ngưỡng thì báo; 0 là tắt', () => {
    const up = LA.evaluate([H({ dayPct: 5 })], { movePct: 5 }), down = LA.evaluate([H({ dayPct: -6.2 })], { movePct: 5 });
    expect(up[0]).toMatchObject({ kind: 'move_up', key: 'FPT:move_up:5' }); expect(down[0]).toMatchObject({ kind: 'move_down', key: 'FPT:move_down:5' });
    expect(LA.evaluate([H({ dayPct: 4.9 })], { movePct: 5 })).toEqual([]);
    expect(LA.evaluate([H({ dayPct: 9 })], { movePct: 0 })).toEqual([]);
    expect(LA.evaluate([H({ dayPct: undefined })], { movePct: 3 })).toEqual([]);          // chưa có giá tham chiếu
  });
  it('mặc định 5%; mức lạ về mặc định', () => {
    expect(LA.evaluate([H({ dayPct: 5.1 })])).toHaveLength(1);
    expect(LA.normalizeMove(4)).toBe(5); expect(LA.normalizeMove('3')).toBe(3); expect(LA.normalizeMove(0)).toBe(0);
  });
});

describe('LiveAlerts.fresh / message', () => {
  it('bỏ cảnh báo đã báo trong ngày (Set hoặc mảng), kể cả khoá do cron 5 phút đã ghi', () => {
    const al = LA.evaluate([H({ marketPrice: 70000, targetPrice: 69000, dayPct: 6 })], { movePct: 5 });
    expect(al).toHaveLength(2);
    expect(LA.fresh(al, new Set(['FPT:target:69000'])).map((x) => x.kind)).toEqual(['move_up']);
    expect(LA.fresh(al, ['FPT:target:69000', 'FPT:move_up:5'])).toEqual([]);
    expect(LA.fresh(al, null)).toHaveLength(2);
  });
  it('nội dung thông báo và mức độ', () => {
    expect(LA.message({ kind: 'target', symbol: 'FPT', price: 70000, threshold: 69000 }).title).toBe('Chạm giá mục tiêu: FPT');
    expect(LA.message({ kind: 'stop', symbol: 'HPG', price: 24000, threshold: 25000 }).body).toContain('cắt lỗ');
    const m = LA.message({ kind: 'move_down', symbol: 'VNM', price: 55000, threshold: 5, pct: -6.25 });
    expect(m.title).toBe('VNM giảm mạnh trong ngày'); expect(m.body).toContain('6,25%');
    expect(LA.levelOf({ kind: 'stop' })).toBe('bad'); expect(LA.levelOf({ kind: 'move_down' })).toBe('bad'); expect(LA.levelOf({ kind: 'target' })).toBe('good'); expect(LA.levelOf({ kind: 'move_up' })).toBe('good');
  });
});

const vn = (hh, mm, day = '2026-10-07') => Date.parse(day + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+07:00');

describe('LiveSeries', () => {
  it('ghi điểm theo phút (thay điểm cùng phút), sắp theo thời gian, không sửa bộ nhớ cũ', () => {
    const s0 = {};
    const s1 = LS.record(s0, vn(9, 30), { pnl: 1000000, pct: 0.5, mv: 2e8 });
    const s2 = LS.record(s1, vn(9, 30) + 20000, { pnl: 1200000, pct: 0.6, mv: 2e8 });     // cùng phút 9:30
    const s3 = LS.record(s2, vn(9, 10), { pnl: -50000, pct: -0.03, mv: 2e8 });
    expect(s0).toEqual({}); expect(s1['2026-10-07']).toHaveLength(1);
    expect(LS.points(s3, '2026-10-07').map((r) => [r[0], r[1]])).toEqual([[550, -50000], [570, 1200000]]);
  });
  it('bỏ giá trị lỗi và thời điểm ngoài phiên; chỉ giữ vài ngày gần nhất', () => {
    expect(LS.record({}, vn(9, 30), { pnl: NaN, pct: 0 })).toEqual({});
    expect(LS.record({}, vn(20, 0), { pnl: 1, pct: 0, mv: 1 })).toEqual({});
    expect(LS.record({}, vn(7, 0), { pnl: 1, pct: 0, mv: 1 })).toEqual({});
    let s = {}; for (let d = 1; d <= 12; d++) s = LS.record(s, vn(10, 0, '2026-09-' + String(d).padStart(2, '0')), { pnl: d, pct: 0, mv: 1 });
    expect(Object.keys(s)).toHaveLength(LS.KEEP_DAYS); expect(Object.keys(s)[0]).toBe('2026-09-03');
  });
  it('stats và money', () => {
    const pts = [[540, 0, 0, 1], [600, 5e6, 1, 1], [660, -2e6, -0.4, 1], [700, 1e6, 0.2, 1]];
    const st = LS.stats(pts);
    expect(st.high[1]).toBe(5e6); expect(st.low[1]).toBe(-2e6); expect(st.last[1]).toBe(1e6); expect(LS.stats([])).toBeNull();
    expect(LS.money(1234567)).toBe('+1,2 tr'); expect(LS.money(-12345)).toBe('−12 nghìn'); expect(LS.money(2.5e9)).toBe('+2,50 tỷ'); expect(LS.money(0)).toBe('0');
  });
  it('trục giờ nén nghỉ trưa: 11:30 và 13:00 trùng một điểm', () => {
    expect(LS.xOf(540, 260)).toBe(0); expect(LS.xOf(690, 260)).toBe(150); expect(LS.xOf(780, 260)).toBe(150); expect(LS.xOf(890, 260)).toBe(260);
  });
  it('svg: ít hơn 2 điểm thì rỗng; có điểm thì có đường, đường 0, điểm cuối, tooltip và nhãn truy cập', () => {
    expect(LS.svg([[540, 1, 0, 1]])).toBe('');
    const out = LS.svg([[540, 0, 0, 1], [600, 5e6, 1, 1], [660, -2e6, -0.4, 1], [700, 1e6, 0.2, 1]]);
    expect(out).toContain('<svg'); expect(out).toContain('ls-line'); expect(out).toContain('ls-zero'); expect(out).toContain('ls-end'); expect(out).toContain('ls-up');
    expect(out).toContain('role="img"'); expect(out).toContain('<title>10:00 · +5,0 tr (+1,00%)</title>'); expect(out).toContain('cao +5,0 tr'); expect(out).toContain('thấp −2,0 tr');
    expect(LS.svg([[540, -1e6, -1, 1], [600, -2e6, -2, 1]])).toContain('ls-down');
    expect(LS.svg([[540, 0, 0, 1], [600, 0, 0, 1]])).toContain('<svg');                    // toàn số 0 không chia cho 0
    expect(LS.svg([[540, 0, 0, 1], [600, 5, 0, 1]]).indexOf('NaN')).toBe(-1);
  });
});
