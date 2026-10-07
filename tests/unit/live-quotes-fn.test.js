import { describe, it, expect } from 'vitest';
import { validateRequest, toQuote, pick, collect, MAX_SYMBOLS } from '../../supabase/functions/live-quotes/parse.ts';

// dòng thật của bảng giá VCI (FPT, 07/10/2026 lúc sàn mở), rút gọn
const FPT = { s: 'FPT', cei: 64600, flo: 56200, ref: 60400, c: 60300, h: 61300, l: 60200, op: 60400, vo: 1498400, va: 90721.94, bp1: 60300, ap1: 60400, st: 'STOCK', bo: 'HSX' };

describe('validateRequest', () => {
  it('viết hoa, bỏ trùng, bỏ mã sai định dạng; báo lỗi khi thiếu hoặc vượt giới hạn', () => {
    expect(validateRequest({ symbols: ['fpt', 'FPT', ' vnm ', 'bad sym', 'x-y', 7] })).toEqual({ symbols: ['FPT', 'VNM', '7'] });
    expect(validateRequest({})).toHaveProperty('error');
    expect(validateRequest({ symbols: ['a b'] })).toHaveProperty('error');
    expect(validateRequest({ symbols: Array.from({ length: MAX_SYMBOLS + 1 }, (_, i) => 'S' + i) })).toHaveProperty('error');
    expect(validateRequest(null)).toHaveProperty('error');
  });
});

describe('toQuote', () => {
  it('đổi dòng bảng giá thành báo giá (đơn vị đồng), kèm tham chiếu, trần/sàn, giá mua/bán tốt nhất, sàn', () => {
    expect(toQuote(FPT)).toEqual({ price: 60300, ref: 60400, ceil: 64600, floor: 56200, open: 60400, high: 61300, low: 60200, volume: 1498400, bid: 60300, ask: 60400, exchange: 'HSX' });
  });
  it('chưa khớp lệnh (c = 0) hoặc giá ngoài biên trần/sàn thì không có báo giá', () => {
    expect(toQuote(Object.assign({}, FPT, { c: 0 }))).toBeNull();
    expect(toQuote(Object.assign({}, FPT, { c: 70000 }))).toBeNull();
    expect(toQuote(Object.assign({}, FPT, { c: 50000 }))).toBeNull();
    expect(toQuote(Object.assign({}, FPT, { c: 64600 })).price).toBe(64600);       // đúng giá trần vẫn hợp lệ
    expect(toQuote(null)).toBeNull();
    expect(toQuote({ s: 'X', c: 1000 }).ceil).toBeNull();                          // thiếu trần/sàn: không kiểm biên
  });
});

describe('pick / collect', () => {
  const hose = [FPT, { s: 'ABR', c: 0, ref: 10350, cei: 11000, flo: 9700 }, { s: 'VNM', c: 58200, ref: 58200, cei: 62200, flo: 54200, bo: 'HSX' }];
  const hnx = [{ s: 'SHS', c: 15000, ref: 14900, cei: 16400, flo: 13400, bo: 'HNX' }];
  it('pick: mã có dòng nhưng chưa khớp vẫn tính là đã tìm thấy (không đi tìm tiếp ở sàn khác)', () => {
    const p = pick(hose, new Set(['FPT', 'ABR', 'NOPE']));
    expect(Object.keys(p.quotes)).toEqual(['FPT']); expect([...p.found].sort()).toEqual(['ABR', 'FPT']);
  });
  it('collect: dừng khi đủ mã, tìm tiếp ở HNX/UPCOM cho mã còn thiếu, ghi nhận mã không thấy và bảng lỗi', async () => {
    const calls = [];
    const load = async (g) => { calls.push(g); return g === 'HOSE' ? hose : (g === 'HNX' ? hnx : []); };
    const a = await collect(['FPT', 'VNM'], load);
    expect(calls).toEqual(['HOSE']); expect(Object.keys(a.quotes).sort()).toEqual(['FPT', 'VNM']); expect(a.missing).toEqual([]);
    calls.length = 0;
    const b = await collect(['FPT', 'SHS', 'ZZZ'], load);
    expect(calls).toEqual(['HOSE', 'HNX', 'UPCOM']); expect(Object.keys(b.quotes).sort()).toEqual(['FPT', 'SHS']); expect(b.missing).toEqual(['ZZZ']);
    const c = await collect(['SHS'], async (g) => (g === 'HOSE' ? null : hnx));
    expect(c.failed).toEqual(['HOSE']); expect(c.boards).toEqual(['HNX']); expect(c.quotes.SHS.price).toBe(15000);
    const d = await collect(['FPT'], async () => null);
    expect(d.boards).toEqual([]); expect(d.failed).toEqual(['HOSE', 'HNX', 'UPCOM']);
  });
});
