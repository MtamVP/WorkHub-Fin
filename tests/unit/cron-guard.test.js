// Chốt chặn cron của 11 Edge Function dùng service role: bản sao khớp bản gốc, mỗi hàm gọi đúng, và logic quyết định (bí mật cron / người dùng đăng nhập / chế độ theo dõi / chế độ bắt buộc).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const { CRON_GUARD_FUNCTIONS } = await import('../../scripts/sync-edge-libs.mjs');
// hàm nào cho người dùng đăng nhập (JWT thật) gọi từ app: send-price-alerts (gửi thử, luôn true), insight-sync (chỉ mode ownership kèm symbols) và market-data-sync (chỉ mode ratios kèm symbols) -- hai hàm này tính allowUser theo body. Còn lại CHỈ lịch hệ thống.
const ALLOW_USER = { 'insight-sync': 'ownership', 'market-data-sync': 'ratios', 'send-price-alerts': true };

describe('cron-guard: phân phối', () => {
  const source = read('supabase/functions/_shared/cron-guard.ts');
  it.each(CRON_GUARD_FUNCTIONS)('%s: bản sao khớp bản gốc (chạy node scripts/sync-edge-libs.mjs nếu lệch)', (fn) => {
    expect(read('supabase/functions/' + fn + '/cron-guard.ts')).toBe(source);
  });
  it.each(CRON_GUARD_FUNCTIONS)('%s: index.ts nhập và gọi chốt chặn đúng tên hàm, chỉ cho người dùng khi cần', (fn) => {
    const src = read('supabase/functions/' + fn + '/index.ts');
    expect(src).toContain('import { cronGuard } from "./cron-guard.ts";');
    const m = /cronGuard\(req, \{ fn: "([^"]+)", allowUser: (true|false|!!\(body && body\.mode === "([a-z]+)" && Array\.isArray\(body\.symbols\)\)) \}\)/.exec(src);
    expect(m, fn).toBeTruthy();
    expect(m[1]).toBe(fn);
    const want = ALLOW_USER[fn];
    if (typeof want === 'string') expect(m[3], fn + ' chỉ cho người dùng ở mode ' + want).toBe(want);
    else expect(m[2] === 'true', fn + ' allowUser').toBe(!!want);
  });
  it('selftest vẫn chạy trước chốt chặn (không cần bí mật) ở hàm có selftest', () => {
    CRON_GUARD_FUNCTIONS.forEach((fn) => {
      const src = read('supabase/functions/' + fn + '/index.ts');
      const st = src.indexOf('body.selftest === true'), g = src.indexOf('cronGuard(req');
      if (st >= 0) expect(st, fn).toBeLessThan(g);
    });
  });
  it('OPTIONS (kiểm tra CORS của trình duyệt) không bị chốt chặn chặn', () => {
    CRON_GUARD_FUNCTIONS.forEach((fn) => {
      const src = read('supabase/functions/' + fn + '/index.ts');
      const o = src.indexOf('req.method === "OPTIONS"'), g = src.indexOf('cronGuard(req');
      if (o >= 0) expect(o, fn).toBeLessThan(g);
    });
  });
  it('migration định nghĩa fn_cron_gate chỉ cho service_role, bí mật nằm trong Vault, mặc định chưa bắt buộc', () => {
    const sql = read('finance-cron-secret-migration.sql');
    expect(sql).toMatch(/revoke all on function public\.fn_cron_gate\(text\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.fn_cron_gate\(text\) to service_role/);
    expect(sql).toMatch(/vault\.create_secret/); expect(sql).toMatch(/enforce boolean not null default false/);
    expect(sql).not.toMatch(/[0-9a-f]{64}/);          // không có giá trị bí mật nào trong git
  });
});

describe('cron-guard: quyết định', () => {
  let guard, state;
  beforeAll(async () => {
    // chép bản gốc, thay dòng nhập esm.sh bằng client giả, rồi nạp qua bộ biên dịch TypeScript của Vitest
    const dir = path.join(ROOT, 'tests', '.tmp-cron-guard');
    mkdirSync(dir, { recursive: true });
    const src = read('supabase/functions/_shared/cron-guard.ts').replace(/^import \{ createClient \} from "https:\/\/esm\.sh\/@supabase\/supabase-js@2";$/m, 'const createClient = (...a: any[]) => (globalThis as any).__fakeClient(...a);');
    writeFileSync(path.join(dir, 'cron-guard.gen.ts'), src);
    globalThis.Deno = { env: { get: () => 'x' } };
    globalThis.__fakeClient = () => ({
      rpc: async () => state.rpc(),
      auth: { getUser: async (t) => state.user(t) },
    });
    guard = (await import(pathToFileURL(path.join(dir, 'cron-guard.gen.ts')).href)).cronGuard;
    rmSync(dir, { recursive: true, force: true });
  });
  const req = (h) => new Request('https://x.supabase.co/functions/v1/f', { method: 'POST', headers: h || {} });
  const JWT = 'aaa.bbb.ccc';
  it('bí mật cron đúng -> cho qua (kể cả khi đang bắt buộc)', async () => {
    state = { rpc: () => ({ data: 'ok', error: null }), user: () => ({ data: { user: null }, error: {} }) };
    expect(await guard(req({ 'x-cron-secret': 'S'.repeat(64) }), { fn: 'f' })).toBeNull();
  });
  it('chế độ theo dõi (chưa bắt buộc): thiếu bí mật vẫn cho qua', async () => {
    state = { rpc: () => ({ data: 'monitor', error: null }), user: () => ({ data: { user: null }, error: {} }) };
    expect(await guard(req({ authorization: 'Bearer sb_publishable_abc' }), { fn: 'f' })).toBeNull();
  });
  it('chế độ bắt buộc: khoá publishable một mình bị 401; người dùng thật qua được nếu allowUser', async () => {
    state = { rpc: () => ({ data: 'deny', error: null }), user: (t) => (t === JWT ? { data: { user: { id: 'u' } }, error: null } : { data: { user: null }, error: { message: 'bad' } }) };
    const r = await guard(req({ authorization: 'Bearer sb_publishable_abc' }), { fn: 'f', allowUser: true });
    expect(r.status).toBe(401); expect((await r.json()).ok).toBe(false);
    expect(await guard(req({ authorization: 'Bearer ' + JWT }), { fn: 'f', allowUser: true })).toBeNull();
    expect((await guard(req({ authorization: 'Bearer ' + JWT }), { fn: 'f', allowUser: false })).status).toBe(401);       // hàm chỉ dành cho cron
    expect((await guard(req({ authorization: 'Bearer a.b.c' }), { fn: 'f', allowUser: true })).status).toBe(401);          // JWT giả bị getUser từ chối
    expect((await guard(req(), { fn: 'f', allowUser: true })).status).toBe(401);
  });
  it('RPC lỗi: không tin được -> từ chối (không mở cửa), trừ người dùng thật', async () => {
    state = { rpc: () => ({ data: null, error: { message: 'down' } }), user: (t) => (t === JWT ? { data: { user: { id: 'u' } }, error: null } : { data: { user: null }, error: {} }) };
    expect((await guard(req({ 'x-cron-secret': 'S'.repeat(64) }), { fn: 'f' })).status).toBe(401);
    expect(await guard(req({ authorization: 'Bearer ' + JWT }), { fn: 'f', allowUser: true })).toBeNull();
    state.rpc = () => { throw new Error('mạng'); };
    expect((await guard(req(), { fn: 'f' })).status).toBe(401);
  });
});
