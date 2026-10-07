import { describe, it, expect, beforeEach } from 'vitest';
import LQ from '../../lib/live-quotes.js';

const vn = (hh, mm, ss = 0, day = '2026-10-07') => Date.parse(day + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '+07:00');
const row = (code, close, o = {}) => Object.assign({ code, date: '2026-10-07', time: '10:19:59', basicPrice: 60.4, ceilingPrice: 64.6, floorPrice: 56.2, open: 60.4, high: 61.3, low: 60.2, close, nmVolume: 1183000 }, o);
const mkFetch = (handler) => { const calls = []; const f = async (url) => { calls.push(url); const r = handler(url); return r === null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => r }; }; f.calls = calls; return f; };
const vciData = (quotes, asOfMs) => ({ ok: true, quotes, asOf: new Date(asOfMs).toISOString(), source: 'vci' });
const Q = (price, o = {}) => Object.assign({ price, ref: 60400, ceil: 64600, floor: 56200, open: 60400, high: 61300, low: 60200, volume: 1500000, bid: price - 100, ask: price + 100, exchange: 'HSX' }, o);

beforeEach(() => { LQ.state.vciFailures = 0; LQ.state.vciBackoffUntil = 0; LQ.state.vciError = null; LQ.state.quotes = {}; });

describe('parseVci', () => {
  it('giờ hiển thị là giờ máy chủ lấy bảng giá; bỏ giá không hợp lệ và mã sai', () => {
    const q = LQ.parseVci(vciData({ FPT: Q(60400), BAD: { price: 0 }, 'x y': Q(1) }, vn(10, 41, 23)), '2026-10-07', vn(10, 41, 30));
    expect(Object.keys(q)).toEqual(['FPT']); expect(q.FPT).toMatchObject({ price: 60400, ref: 60400, time: '10:41:23', source: 'vci', date: '2026-10-07' });
    expect(LQ.parseVci({ ok: false }, '2026-10-07', 0)).toEqual({}); expect(LQ.parseVci(null, '2026-10-07', 0)).toEqual({});
  });
});

describe('refresh có Edge Function VCI', () => {
  it('giá VCI thắng VNDirect cho cùng mã; mã VCI không có thì lấy VNDirect; gọi song song, nguồn ghi vci+vnd', async () => {
    const f = mkFetch(() => ({ data: [row('FPT', 60.2), row('VNM', 58.2, { basicPrice: 58.2, ceilingPrice: 62.2, floorPrice: 54.2 })] }));
    let asked = null;
    const st = await LQ.refresh(['FPT', 'VNM'], { fetch: f, now: vn(10, 41, 30), invoke: async (s) => { asked = s; return vciData({ FPT: Q(60400) }, vn(10, 41, 23)); } });
    expect(asked).toEqual(['FPT', 'VNM']); expect(st.quotes.FPT).toMatchObject({ price: 60400, source: 'vci' }); expect(st.quotes.VNM).toMatchObject({ price: 58200, source: 'vnd-finfo' });
    expect(st.source).toBe('vci+vnd'); expect(st.error).toBeNull(); expect(st.vciError).toBeNull();
  });
  it('hàm VCI lỗi: dùng VNDirect như trước, ghi lỗi; lỗi 3 lần liền thì bỏ qua hàm 5 phút rồi thử lại', async () => {
    const f = mkFetch(() => ({ data: [row('FPT', 60.2)] }));
    let n = 0; const bad = async () => { n++; throw new Error('502'); };
    for (let i = 0; i < 3; i++) { const st = await LQ.refresh(['FPT'], { fetch: f, now: vn(10, 41, i * 20), invoke: bad }); expect(st.quotes.FPT.source).toBe('vnd-finfo'); expect(st.vciError).toMatch(/502/); }
    expect(n).toBe(3);
    await LQ.refresh(['FPT'], { fetch: f, now: vn(10, 43), invoke: bad }); expect(n).toBe(3);                 // đang nghỉ
    await LQ.refresh(['FPT'], { fetch: f, now: vn(10, 47), invoke: async () => vciData({ FPT: Q(60500) }, vn(10, 47)) });
    expect(LQ.state.quotes.FPT.price).toBe(60500); expect(LQ.state.vciFailures).toBe(0);
  });
  it('chống giá cũ của bảng giá VCI: cuối tuần hoặc ngày VNDirect không có giá hôm nay thì bỏ giá VCI', async () => {
    const empty = mkFetch(() => ({ data: [] }));
    const st = await LQ.refresh(['FPT'], { fetch: empty, now: vn(10, 0, 0, '2026-10-10'), invoke: async () => vciData({ FPT: Q(60400) }, vn(10, 0, 0, '2026-10-10')) });
    expect(st.quotes).toEqual({});                                  // thứ bảy: bảng VCI còn giá phiên thứ sáu, không được coi là hôm nay
    const hol = await LQ.refresh(['FPT'], { fetch: empty, now: vn(10, 0), invoke: async () => vciData({ FPT: Q(60400) }, vn(10, 0)) });
    expect(hol.quotes).toEqual({});                                 // ngày thường nhưng VNDirect không có dòng hôm nay (nghỉ lễ)
  });
  it('VNDirect lỗi hẳn nhưng đang trong phiên ngày thường: vẫn nhận giá VCI; cả hai lỗi: giữ giá cũ và báo lỗi', async () => {
    const dead = mkFetch(() => null);
    const st = await LQ.refresh(['FPT'], { fetch: dead, now: vn(10, 41), invoke: async () => vciData({ FPT: Q(60400) }, vn(10, 41)) });
    expect(st.quotes.FPT).toMatchObject({ price: 60400, source: 'vci' }); expect(st.source).toBe('vci');
    const both = await LQ.refresh(['FPT'], { fetch: dead, now: vn(10, 42), invoke: async () => { throw new Error('x'); } });
    expect(both.error).toMatch(/Không lấy được/); expect(both.quotes.FPT.price).toBe(60400);
  });
  it('không truyền invoke thì hành xử như cũ (chỉ VNDirect)', async () => {
    const st = await LQ.refresh(['FPT'], { fetch: mkFetch(() => ({ data: [row('FPT', 60.2)] })), now: vn(10, 41) });
    expect(st.quotes.FPT.source).toBe('vnd-finfo'); expect(st.source).toBe('vnd-finfo');
  });
});
