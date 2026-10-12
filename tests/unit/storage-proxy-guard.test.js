// storage-proxy (tạm tắt ở phía app nhưng vẫn đang chạy trên máy chủ): kiểm khoá đối tượng và bảng nhóm-bucket đã siết 12/10/2026.
// Đọc mã nguồn .ts (không có Deno trên máy), trích validPath + BUCKET_GROUPS để chạy thật.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '../../supabase/functions/storage-proxy/index.ts'), 'utf8');
const fn = /function validPath\(p: string\): boolean \{([\s\S]*?)\n\}/.exec(src);
const validPath = new Function('p', fn[1]);
const groups = JSON.parse(/const BUCKET_GROUPS: Record<string, string\[\]> = (\{[\s\S]*?\});/.exec(src)[1].replace(/,\s*\}/, '}'));

describe('storage-proxy: khoá đối tượng', () => {
  it('nhận đường dẫn bình thường', () => {
    ['a.pdf', 'projects/123/bao-cao.pdf', 'u@x.vn/2026/10/file name (1).xlsx'].forEach((p) => expect(validPath(p), p).toBe(true));
  });
  it('từ chối rỗng, tuyệt đối, ".." / ".", ký tự điều khiển, quá dài', () => {
    ['', '/etc/passwd', '../x', 'a/../b', 'a/./b', 'a\u0000b', 'a\nb', 'x'.repeat(513)].forEach((p) => expect(validPath(p), JSON.stringify(p)).toBe(false));
    expect(validPath('x'.repeat(512))).toBe(true);
  });
});

describe('storage-proxy: nhóm được dùng từng bucket', () => {
  it('Fin chỉ finance + admin; Sci chỉ science + admin; Org mở cho mọi người dùng đang hoạt động', () => {
    expect(groups['wh-fin-files']).toEqual(['finance', 'admin']);
    expect(groups['wh-sci-files']).toEqual(['science', 'admin']);
    expect(groups['wh-org-files']).toEqual([]);
  });
  it('mọi tuyến upload / download / delete phải qua requireUser có bucket', () => {
    expect((src.match(/await requireUser\(req, url, bucket\)/g) || []).length).toBe(3);
    expect(src).not.toMatch(/await requireUser\(req, url\);/);
    expect(src).toMatch(/forbidden:/);
  });
});
