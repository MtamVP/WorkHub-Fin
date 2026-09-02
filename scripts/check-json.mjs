// Enterprise-readiness mục 4 -- CI "kiểm tra nhanh": JSON.parse mọi .json trong repo.
import fs from 'node:fs';
import path from 'node:path';

const EXCLUDE_DIRS = new Set(['node_modules', 'tauri-dist', 'src-tauri', '.git']);

let failed = false;
let checked = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.json')) continue;

    checked++;
    try {
      JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      console.error(`JSON KHÔNG HỢP LỆ: ${full}`);
      console.error(err.message);
      failed = true;
    }
  }
}

walk('.');
console.log(`check-json: đã kiểm ${checked} file .json${failed ? ', CÓ LỖI.' : ', tất cả hợp lệ.'}`);
process.exit(failed ? 1 : 0);
