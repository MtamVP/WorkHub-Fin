// Edge Function butler: bản sao thư viện khớp với lib/ và ai.ts khớp với market-news-ai; hàm KHÔNG dùng service role, KHÔNG ghi bảng nào ngoài nhật ký của chính người dùng, và mọi tool đều chỉ đọc.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUTLER_LIBS, BUTLER_TS, expectedCopy } from '../../scripts/sync-edge-libs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'supabase/functions/butler';

describe('butler: bản sao và cấu trúc', () => {
  it('bản sao thư viện khớp lib/ (chạy node scripts/sync-edge-libs.mjs nếu đỏ)', () => {
    BUTLER_LIBS.forEach((lib) => expect(read(DIR + '/' + lib.file), lib.file).toBe(expectedCopy(lib)));
  });
  it('ai.ts khớp market-news-ai/ai.ts', () => {
    BUTLER_TS.forEach((c) => expect(read(c.to)).toBe(read(c.from)));
  });
  it('không dùng service role ở bất cứ tệp nào của hàm', () => {
    readdirSync(path.join(ROOT, DIR)).forEach((f) => {
      const src = read(DIR + '/' + f);
      expect(src, f).not.toMatch(/SERVICE_ROLE|service_role|createClient\([^)]*SERVICE/i);
    });
  });
  it('không import cron-guard (hàm chạy bằng JWT người dùng, không phải bằng bí mật cron)', () => {
    expect(read(DIR + '/index.ts')).not.toMatch(/cron-guard|cronGuard/);
  });
  it('client dựng từ khoá công khai + tiêu đề Authorization của người gọi', () => {
    const src = read(DIR + '/index.ts');
    expect(src).toMatch(/SUPABASE_ANON_KEY/);
    expect(src).toMatch(/Authorization: req\.headers\.get\("authorization"\)/);
  });
  it('chỉ ghi bảng butler_log (nhật ký của chính người dùng) và gọi RPC fn_butler_take / current_user_role; tools.ts không ghi gì', () => {
    const idx = read(DIR + '/index.ts'), tools = read(DIR + '/tools.ts');
    const writes = [...idx.matchAll(/\.from\("(\w+)"\)\s*\.(insert|update|delete|upsert)/g)].map((m) => m[1] + '.' + m[2]);
    expect(writes.sort()).toEqual(['butler_log.insert', 'butler_log.update']);
    expect([...idx.matchAll(/\.rpc\("(\w+)"/g)].map((m) => m[1]).sort()).toEqual(['current_user_role', 'fn_butler_take']);
    expect(tools).not.toMatch(/\.(insert|update|delete|upsert)\(|\.rpc\(/);
  });
  it('selftest không cần đăng nhập và không lộ khoá; mọi nhánh khác kiểm đăng nhập trước', () => {
    const src = read(DIR + '/index.ts');
    expect(src.indexOf('selftest')).toBeLessThan(src.indexOf('whoAmI(sb, req)'));
    expect(src).not.toMatch(/key: *pick\.key[^,)]*\bjson\(/);
    expect(src).toMatch(/hasKey: cfg\.hasKey/);
  });
  it('mọi công cụ khai báo trong ButlerCore.TOOLS có hàm tương ứng trong index.ts', () => {
    const C = require('../../lib/butler-core.js'), src = read(DIR + '/index.ts');
    Object.keys(C.TOOLS).filter((k) => C.TOOLS[k].enabled && !C.TOOLS[k].data).forEach((k) => expect(src, k).toMatch(new RegExp('tools\\.push\\("' + k + '"\\)')));
    expect(src).toMatch(/tools\.push\(tool\)/);                     // công cụ dữ liệu đi qua doData -> butler-data (kiểm ở butler-data.test.js)
  });
});
