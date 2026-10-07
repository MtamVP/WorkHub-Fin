import { describe, it, expect } from 'vitest';
import LQ from '../../lib/live-quotes.js';

// 07/10/2026 (thứ tư) theo giờ VN
const vn = (hh, mm, ss = 0, day = '2026-10-07') => Date.parse(day + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '+07:00');
const row = (code, close, o = {}) => Object.assign({ code, date: '2026-10-07', time: '10:19:59', basicPrice: 60.4, ceilingPrice: 64.6, floorPrice: 56.2, open: 60.4, high: 61.3, low: 60.2, close, nmVolume: 1183000 }, o);

describe('phiên giao dịch', () => {
  it('mở 9:00-11:30 và 13:00-14:50, nghỉ trưa, trước giờ, sau giờ và cuối tuần', () => {
    expect(LQ.session(vn(8, 59))).toBe('pre'); expect(LQ.session(vn(9, 0))).toBe('open'); expect(LQ.session(vn(11, 29))).toBe('open');
    expect(LQ.session(vn(11, 30))).toBe('break'); expect(LQ.session(vn(12, 59))).toBe('break'); expect(LQ.session(vn(13, 0))).toBe('open');
    expect(LQ.session(vn(14, 49))).toBe('open'); expect(LQ.session(vn(14, 50))).toBe('closed'); expect(LQ.session(vn(20, 0))).toBe('closed');
    expect(LQ.session(vn(10, 0, 0, '2026-10-10'))).toBe('closed'); expect(LQ.session(vn(10, 0, 0, '2026-10-11'))).toBe('closed');
  });
  it('đổi giờ UTC sang ngày giờ Việt Nam (23h UTC đã là ngày hôm sau ở VN)', () => {
    expect(LQ.vnParts(Date.parse('2026-10-06T23:30:00Z')).date).toBe('2026-10-07');
    expect(LQ.hhmmss(Math.floor(vn(10, 22, 13) / 1000))).toBe('10:22:13');
  });
});

describe('parseFinfo', () => {
  it('đổi nghìn đồng ra đồng, lấy giờ khớp, giá tham chiếu; chỉ nhận dòng của hôm nay', () => {
    const p = LQ.parseFinfo({ data: [row('FPT', 60.2), row('OLD', 10, { date: '2026-10-06' })] }, '2026-10-07');
    expect(p.quotes.FPT).toMatchObject({ price: 60200, ref: 60400, high: 61300, volume: 1183000, time: '10:19:59', source: 'vnd-finfo' });
    expect(p.quotes.FPT.ts).toBe(Math.floor(vn(10, 19, 59) / 1000)); expect(p.quotes.OLD).toBeUndefined();
  });
  it('bỏ mã chưa khớp lệnh (giá 0) và giá ngoài biên trần/sàn; mã sai định dạng', () => {
    const p = LQ.parseFinfo({ data: [row('AAA', 0), row('BBB', 70), row('CCC', 50), row('DDD', 64.6), row('e e', 60)] }, '2026-10-07');
    expect(Object.keys(p.quotes)).toEqual(['DDD']); expect(p.rejected.sort()).toEqual(['BBB', 'CCC']);
    expect(LQ.parseFinfo(null, '2026-10-07').quotes).toEqual({});
  });
});

describe('parseDchart', () => {
  it('lấy nến cuối của hôm nay; nến của ngày cũ hoặc phản hồi lỗi thì bỏ', () => {
    const t = Math.floor(vn(10, 21) / 1000);
    expect(LQ.parseDchart({ s: 'ok', t: [t - 60, t], c: [60.1, 60.2] }, 'FPT', '2026-10-07')).toMatchObject({ price: 60200, time: '10:21:00', source: 'vnd-dchart' });
    expect(LQ.parseDchart({ s: 'ok', t: [t - 86400], c: [60] }, 'FPT', '2026-10-07')).toBeNull();
    expect(LQ.parseDchart({ s: 'no_data' }, 'FPT', '2026-10-07')).toBeNull();
  });
});

// fetch giả: ghi lại URL, trả theo hàm
const mkFetch = (handler) => { const calls = []; const f = async (url) => { calls.push(url); const r = handler(url); return r === null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => r }; }; f.calls = calls; return f; };

describe('refresh', () => {
  it('một lượt gọi cho cả danh mục (mã viết hoa, bỏ trùng và mã sai), kèm ngày hôm nay giờ VN', async () => {
    const f = mkFetch(() => ({ data: [row('FPT', 60.2), row('VNM', 58.2, { basicPrice: 58.2, ceilingPrice: 62.2, floorPrice: 54.2 })] }));
    const st = await LQ.refresh(['fpt', 'VNM', 'FPT', 'bad sym'], { fetch: f, now: vn(10, 22) });
    expect(f.calls).toHaveLength(1); expect(f.calls[0]).toContain('code:FPT,VNM~date:2026-10-07'); expect(Object.keys(st.quotes).sort()).toEqual(['FPT', 'VNM']);
    expect(st.source).toBe('vnd-finfo'); expect(st.error).toBeNull(); expect(st.session).toBe('open'); expect(st.fetchedAt).toBe(vn(10, 22));
  });
  it('ngoài ngày giao dịch finfo không có dòng hôm nay: không có giá trực tiếp nhưng không phải lỗi', async () => {
    const st = await LQ.refresh(['FPT'], { fetch: mkFetch(() => ({ data: [] })), now: vn(10, 0, 0, '2026-10-10') });
    expect(st.quotes).toEqual({}); expect(st.error).toBeNull();
  });
  it('chia lô 60 mã mỗi lượt', async () => {
    const syms = Array.from({ length: 130 }, (_, i) => 'S' + String(i).padStart(3, '0'));
    const f = mkFetch(() => ({ data: [] }));
    await LQ.refresh(syms, { fetch: f, now: vn(10, 0) });
    expect(f.calls).toHaveLength(3);
  });
  it('finfo lỗi: dự phòng nến 1 phút của dchart; cả hai lỗi: giữ giá cũ và báo lỗi', async () => {
    const t = Math.floor(vn(10, 21) / 1000);
    const f = mkFetch((url) => (url.includes('stock_prices') ? null : { s: 'ok', t: [t], c: [60.2] }));
    const st = await LQ.refresh(['FPT'], { fetch: f, now: vn(10, 22) });
    expect(st.quotes.FPT).toMatchObject({ price: 60200, source: 'vnd-dchart' }); expect(st.source).toBe('vnd-dchart'); expect(st.error).toBeNull();
    const bad = await LQ.refresh(['FPT'], { fetch: mkFetch(() => null), now: vn(10, 23) });
    expect(bad.error).toMatch(/Không lấy được/); expect(bad.quotes.FPT.price).toBe(60200);
  });
});

describe('applyToHoldings / totals', () => {
  const H = (o) => Object.assign({ symbol: 'FPT', quantity: 1000, avgCost: 50000, costValue: 50e6, marketPrice: 58000, marketValue: 58e6, unrealizedPnl: 8e6, unrealizedPct: 16, targetPrice: 70000, stopLoss: 55000, priceLocked: false, priceMeta: { kind: 'auto' } }, o);
  const Q = { FPT: { price: 60200, ref: 60400, date: '2026-10-07', time: '10:22:00', source: 'vnd-finfo' } };
  it('tính lại giá trị, lãi lỗ, khoảng cách mục tiêu/cắt lỗ và lãi lỗ trong ngày; giữ giá lưu trong storedPrice; không sửa mảng gốc', () => {
    const src = [H()], out = LQ.applyToHoldings(src, Q)[0];
    expect(out).toMatchObject({ live: true, marketPrice: 60200, storedPrice: 58000, marketValue: 60.2e6, unrealizedPnl: 10.2e6 });
    expect(out.unrealizedPct).toBeCloseTo(20.4, 6); expect(out.upsidePct).toBeCloseTo((70000 - 60200) / 60200 * 100, 6); expect(out.stopDistancePct).toBeCloseTo((55000 - 60200) / 60200 * 100, 6);
    expect(out.dayPnl).toBeCloseTo(1000 * (60200 - 60400), 6); expect(out.dayPct).toBeCloseTo(-200 / 60400 * 100, 6);
    expect(out.priceMeta).toMatchObject({ kind: 'live', time: '10:22:00' }); expect(src[0].marketPrice).toBe(58000);
  });
  it('giá đã khoá hoặc mã không có giá trực tiếp thì giữ nguyên giá lưu', () => {
    const out = LQ.applyToHoldings([H({ priceLocked: true }), H({ symbol: 'VNM' })], Q);
    expect(out.map((x) => x.live)).toEqual([false, false]); expect(out[0].marketPrice).toBe(58000);
  });
  it('totals cộng giá trị, lãi lỗ chưa thực hiện, lãi lỗ hôm nay trên các mã có giá tham chiếu', () => {
    const out = LQ.applyToHoldings([H(), H({ symbol: 'VNM', quantity: 100, costValue: 5e6, marketValue: 5.5e6, unrealizedPnl: 0.5e6 })], Q);
    const t = LQ.totals(out);
    expect(t.marketValue).toBeCloseTo(60.2e6 + 5.5e6, 3); expect(t.liveCount).toBe(1); expect(t.total).toBe(2); expect(t.dayPnl).toBeCloseTo(-200000, 3);
    expect(LQ.totals([H()]).dayPnl).toBeNull();
  });
});
