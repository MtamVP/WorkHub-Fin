// supabase/functions/live-quotes/index.ts THẬT (phần sẽ được triển khai): chạy trong Vitest với Deno.serve giả để bắt hàm xử lý và fetch giả trả bảng VCI thật (tests/fixtures/vci-boards-sample.json).
// Kiểm cả chế độ cũ ({ symbols }) lẫn chế độ mới ({ boards }) để chắc không làm hỏng Danh Mục đang dùng hàm này.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FX = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/vci-boards-sample.json'), 'utf8'));
let handler, calls = [], mode = 'ok';

// bảng VCI "thô": thêm các trường mà hàm phải bỏ khỏi chế độ cả bảng (tên công ty, sổ lệnh mua/bán...) để chắc dòng gọn không rò chúng
const raw = (g) => FX.boards[g].map((r) => ({ ...r, bo: g === 'HOSE' ? 'HSX' : g, orgn: 'Công ty ' + r.s, bp1: r.c, ap1: r.c, bv1: 1, av1: 1, frbv: 5 }));

beforeAll(async () => {
  globalThis.Deno = { serve: (h) => { handler = h; } };
  globalThis.fetch = async (url, init) => {
    const g = JSON.parse(init.body).group;
    calls.push(g);
    if (mode === 'allfail' || (mode === 'hnxfail' && g === 'HNX')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => raw(g) };
  };
  await import('../../supabase/functions/live-quotes/index.ts');
});

const call = async (body) => { const res = await handler(new Request('http://x/', { method: 'POST', body: JSON.stringify(body) })); return { status: res.status, body: await res.json() }; };
// bộ nhớ đệm 3 giây của hàm theo từng sàn: đợi hết hạn giữa các ca để mỗi ca thật sự gọi nguồn
const expire = () => new Promise((r) => setTimeout(r, 3100));

describe('live-quotes index.ts: chế độ cả bảng giá', () => {
  it('selftest báo hỗ trợ cả bảng (để biết bản đã triển khai là bản mới)', async () => {
    const r = await call({ selftest: true });
    expect(r.body).toMatchObject({ ok: true, boards: true, max: 80 });
  });
  it('{ boards: true }: trả cả ba sàn với đúng các trường gọn, kèm asOf và nguồn', async () => {
    calls = []; mode = 'ok';
    const r = await call({ boards: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, source: 'vci', failed: [] });
    expect(Object.keys(r.body.boards).sort()).toEqual(['HNX', 'HOSE', 'UPCOM']);
    expect(r.body.boards.HOSE.length).toBe(FX.boards.HOSE.length);
    expect(r.body.boards.HNX.length).toBe(FX.boards.HNX.length);
    const vnm = r.body.boards.HOSE.filter((x) => x.s === 'VNM')[0];
    expect(vnm).toEqual(FX.boards.HOSE.filter((x) => x.s === 'VNM')[0]);              // đúng như bản gọn: không có orgn, bp1, frbv...
    expect(Number.isFinite(Date.parse(r.body.asOf))).toBe(true);
    expect([...calls].sort()).toEqual(['HNX', 'HOSE', 'UPCOM']);
  });
  it('{ boards: ["HNX"] }: chỉ gọi và trả sàn được xin', async () => {
    await expire(); calls = []; mode = 'ok';
    const r = await call({ boards: ['hnx'] });
    expect(Object.keys(r.body.boards)).toEqual(['HNX']);
    expect(calls).toEqual(['HNX']);
  });
  it('một sàn lỗi nguồn: vẫn trả các sàn còn lại và ghi sàn lỗi vào failed; mọi sàn lỗi thì 502', async () => {
    await expire(); mode = 'hnxfail';
    const a = await call({ boards: true });
    expect(a.status).toBe(200);
    expect(a.body.failed).toEqual(['HNX']);
    expect(Object.keys(a.body.boards).sort()).toEqual(['HOSE', 'UPCOM']);
    await expire(); mode = 'allfail';
    const b = await call({ boards: true });
    expect(b.status).toBe(502);
    expect(b.body.ok).toBe(false);
    expect(b.body.failed.sort()).toEqual(['HNX', 'HOSE', 'UPCOM']);
    mode = 'ok';
  }, 20000);
  it('yêu cầu sai: boards không hợp lệ trả 400 và không gọi nguồn', async () => {
    calls = [];
    const a = await call({ boards: ['XYZ'] });
    expect(a.status).toBe(400);
    expect(a.body.ok).toBe(false);
    const b = await call({ boards: 'HOSE' });
    expect(b.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('live-quotes index.ts: chế độ cũ (Danh Mục) vẫn hoạt động', () => {
  it('{ symbols } trả giá của các mã xin như trước', async () => {
    await expire(); mode = 'ok';
    const r = await call({ symbols: ['VNM', 'fpt'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, source: 'vci' });
    expect(r.body.quotes.VNM).toMatchObject({ price: 58200, ref: 57900, exchange: 'HSX' });
    expect(Object.keys(r.body.quotes).sort()).toEqual(['FPT', 'VNM']);
    expect(r.body.boards).toBeUndefined();
  });
  it('thiếu cả symbols lẫn boards: 400 như cũ', async () => {
    const r = await call({});
    expect(r.status).toBe(400);
  });
});
