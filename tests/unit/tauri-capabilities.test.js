// Quyền Tauri: cửa sổ ghi nhanh (quick-capture) chỉ cần cửa sổ / sự kiện / mở liên kết, không được dùng chung quyền ghi tệp, SQL, hộp thoại... của cửa sổ chính.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '../../src-tauri/capabilities');
const caps = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
const permName = (p) => (typeof p === 'string' ? p : p.identifier);

describe('quyền Tauri theo cửa sổ', () => {
  const forWindow = (w) => caps.filter((c) => (c.windows || []).includes(w));
  it('cửa sổ ghi nhanh chỉ có quyền tối thiểu', () => {
    const perms = forWindow('quick-capture').flatMap((c) => c.permissions.map(permName));
    expect(perms.length).toBeGreaterThan(0);
    perms.forEach((p) => expect(p, p).toMatch(/^(core:|opener:)/));
    expect(perms.some((p) => /^(fs|sql|dialog|notification|global-shortcut|updater|process):/.test(p))).toBe(false);
  });
  it('quyền ghi tệp / SQL chỉ thuộc cửa sổ chính', () => {
    const risky = caps.filter((c) => c.permissions.map(permName).some((p) => /^(fs|sql):/.test(p)));
    expect(risky.length).toBeGreaterThan(0);
    risky.forEach((c) => expect(c.windows, c.identifier).toEqual(['main']));
  });
  it('mọi cửa sổ khai trong cấu hình đều có ít nhất một khai báo quyền', () => {
    const conf = JSON.parse(readFileSync(path.join(here, '../../src-tauri/tauri.conf.json'), 'utf8'));
    (conf.app && conf.app.windows ? conf.app.windows : []).forEach((w) => expect(forWindow(w.label || 'main').length, w.label || 'main').toBeGreaterThan(0));
  });
});
