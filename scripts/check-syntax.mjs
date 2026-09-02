// Enterprise-readiness mục 4 -- CI "kiểm tra nhanh": node --check trên mọi .js trong repo.
// package.json khai "type":"commonjs" nên node --check mặc định phân tích kiểu CommonJS --
// nhưng 2 vùng trong repo dùng cú pháp ESM thật (import/export) và phải kiểm bằng
// --input-type=module, nếu không sẽ báo lỗi cú pháp giả:
//   - functions/ (Cloudflare Pages Functions)
//   - tests/ (Vitest tự transform test file qua ESM bất kể "type" trong package.json --
//     xem comment đầu tests/unit/pure-helpers.test.js)
// .mjs (vitest.config.mjs, scripts/*.mjs) vốn luôn là ESM, cũng kiểm theo --input-type=module.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXCLUDE_DIRS = new Set(['node_modules', 'tauri-dist', 'src-tauri', '.git']);
const ESM_DIR_MARKERS = ['functions', 'tests'];

let failed = false;
let checked = 0;

function isEsmPath(fullPath) {
  const parts = fullPath.split(path.sep);
  if (fullPath.endsWith('.mjs')) return true;
  return parts.some(p => ESM_DIR_MARKERS.includes(p));
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;

    checked++;
    try {
      if (isEsmPath(full)) {
        execFileSync('node', ['--input-type=module', '--check'], { input: fs.readFileSync(full) });
      } else {
        execFileSync('node', ['--check', full]);
      }
    } catch (err) {
      console.error(`SYNTAX ERROR: ${full}`);
      console.error((err.stderr || err.message || '').toString());
      failed = true;
    }
  }
}

walk('.');
console.log(`check-syntax: đã kiểm ${checked} file .js/.mjs${failed ? ', CÓ LỖI.' : ', tất cả hợp lệ.'}`);
process.exit(failed ? 1 : 0);
