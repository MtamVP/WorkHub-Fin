// lib/butler-ui.js + butler.css: các hàm thuần (mã đang xem từ hash, đường dẫn tham chiếu), và kiểm TĨNH: mọi trang Fin nạp đủ lõi / bản đồ / giao diện / CSS Quản gia, giao diện không dùng innerHTML (không thể chèn mã),
// mọi nút chỉ có biểu tượng có nhãn, và trang chính xử lý đúng các liên kết sâu mà bản đồ tạo ra.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const U = require('../../lib/butler-ui.js');
const L = require('../../lib/links.js');
const M = require('../../lib/butler-map-fin.js');

describe('symFromHash', () => {
  it('lấy mã HOA ở các vị trí hash của từng khu; không nhầm tên tab với mã', () => {
    expect(U.symFromHash('#stock/FPT', L)).toBe('FPT');
    expect(U.symFromHash('#events/HPG', L)).toBe('HPG');
    expect(U.symFromHash('#VCB/2025', L)).toBe('VCB');
    expect(U.symFromHash('#portfolio/MWG', L)).toBe('MWG');
    expect(U.symFromHash('#ownership', L)).toBe('');
    expect(U.symFromHash('#backtest/a1b2', L)).toBe('');
    expect(U.symFromHash('', L)).toBe('');
    expect(U.symFromHash('#stock/%E0%A4%A', L)).toBe('');
  });
});

describe('hrefForRef / featureHref', () => {
  it('chỉ tham chiếu section hợp lệ mới thành đường dẫn', () => {
    expect(U.hrefForRef({ kind: 'section', key: 'mytasks' })).toBe('/#section=mytasks');
    expect(U.hrefForRef({ kind: 'section', key: 'x y' })).toBe('');
    expect(U.hrefForRef({ kind: 'other', key: 'mytasks' })).toBe('');
    expect(U.hrefForRef(null)).toBe('');
  });
  it('featureHref: mã đi vào đường dẫn; mục của trang chính mang section / action; id lạ -> null', () => {
    expect(U.featureHref('insight-ownership', 'FPT', L, M).href).toBe('/insight/#ownership/FPT');
    expect(U.featureHref('tasks-mine', '', L, M)).toMatchObject({ href: '/#section=mytasks', section: 'mytasks', action: '' });
    expect(U.featureHref('backup', '', L, M)).toMatchObject({ href: '/#do=backup', action: 'backup' });
    expect(U.featureHref('khong-co', '', L, M)).toBeNull();
  });
});

function pages(dir, out) {
  for (const n of readdirSync(path.join(ROOT, dir))) {
    if (['node_modules', 'tauri-dist', 'tests', 'supabase', 'docs', 'src-tauri', '.git', 'scripts', 'report', 'graphify-out'].includes(n)) continue;
    const rel = dir ? dir + '/' + n : n, st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) pages(rel, out); else if (/(^|\/)index\.html$/.test(rel)) out.push(rel);
  }
  return out;
}

describe('trang nạp Quản gia', () => {
  const need = ['/lib/links.js', '/lib/butler-core.js', '/lib/butler-map-fin.js', '/lib/butler-ui.js'];
  it('mọi trang nạp lib/links.js đều nạp lõi, bản đồ, giao diện và CSS của Quản gia (thứ tự: links, core, map, ui)', () => {
    const list = pages('', []).filter((f) => /lib\/links\.js/.test(read(f)));
    expect(list.length).toBeGreaterThanOrEqual(10);
    list.forEach((f) => {
      const html = read(f), pos = need.map((s) => html.search(new RegExp('src="\\.?' + s.replace(/[./]/g, (c) => '\\' + c).replace(/^\\\//, '\\/?') + '[?"]')));
      pos.forEach((p, i) => expect(p, f + ' thiếu ' + need[i]).toBeGreaterThan(-1));
      expect(pos[0] < pos[1] && pos[1] < pos[2] && pos[2] < pos[3], f + ' sai thứ tự nạp').toBe(true);
      expect(html, f + ' thiếu butler.css').toMatch(/href="\/?butler\.css[?"]/);
    });
  });
  it('trang chính index.html cũng nạp Quản gia (và links.js)', () => {
    const html = read('index.html');
    need.forEach((s) => expect(html, s).toContain(s.slice(1)));
    expect(html).toMatch(/href="butler\.css/);
  });
});

describe('butler-ui.js an toàn và truy cập', () => {
  const src = read('lib/butler-ui.js');
  it('không dùng innerHTML / insertAdjacentHTML / document.write / eval (mọi chữ qua textContent)', () => {
    expect(src.replace(/\/\/.*$/gm, '')).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  });
  it('nút chỉ có biểu tượng đều có aria-label; hộp thoại có nhãn; vùng hội thoại aria-live', () => {
    const icons = [...src.matchAll(/h\('button', \{([^}]*)\}, icon\(/g)].map((m) => m[1]);
    expect(icons.length).toBeGreaterThanOrEqual(5);
    icons.forEach((a) => expect(a).toMatch(/aria-label/));
    expect(src).toMatch(/role: 'dialog', 'aria-label': 'Quản gia'/);
    expect(src).toMatch(/role: 'log', 'aria-live': 'polite'/);
  });
  it('có phím tắt Alt+J và đóng bằng Esc', () => { expect(src).toMatch(/ev\.altKey/); expect(src).toMatch(/ev\.key === 'Escape'/); });
  it('CSS: có vòng focus, tôn trọng giảm chuyển động, ẩn khi in và khi chưa đăng nhập', () => {
    const css = read('butler.css');
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/body\.app-locked \.bt-root \{ display: none; \}/);
    expect(css).toMatch(/\.bt-panel\[hidden\] \{ display: none; \}/);
  });
});

describe('trang chính xử lý liên kết sâu của bản đồ', () => {
  it('script.js: LAUNCH_ACTIONS + applyLaunchHash sau khi đăng nhập và khi hash đổi', () => {
    const s = read('script.js');
    expect(s).toMatch(/const LAUNCH_ACTIONS = \{/);
    expect(s).toMatch(/await initAuth\(\);\s*applyLaunchHash\(\);/);
    expect(s).toMatch(/addEventListener\('hashchange', applyLaunchHash\)/);
  });
});
