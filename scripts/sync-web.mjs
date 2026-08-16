// Copies the site's static web assets into tauri-dist/ so Tauri's frontendDist
// never has to point at the repo root (which contains src-tauri/ and
// node_modules/ -- Tauri refuses to bundle a frontendDist that includes those).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'tauri-dist');
const EXCLUDE_TOP_LEVEL = new Set([
  'src-tauri', 'node_modules', 'tauri-dist', '.git', '.wrangler', '.claude',
  'package.json', 'package-lock.json', '.gitignore', 'wrangler.toml', 'scripts',
]);

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

function copyDir(src, dst, isRoot) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isRoot && EXCLUDE_TOP_LEVEL.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d, false);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

copyDir(root, dest, true);
console.log(`[sync-web] copied web assets into ${dest}`);
