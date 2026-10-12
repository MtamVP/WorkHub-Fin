// lib/links.js: liên kết dùng chung giữa các block. Kiểm hàm dựng đường dẫn (kể cả chuỗi lạ), và đối chiếu TĨNH với trang đích:
// mỗi hash do Links tạo ra phải được trang đích khai báo, mọi trang gọi Links phải nạp lib/links.js, và không còn literal ghép tay.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const L = require('../../lib/links.js');

describe('Links: dựng đường dẫn', () => {
  it('mã được chuẩn hoá hoa và kiểm; chuỗi lạ không đi vào đường dẫn', () => {
    expect(L.valuation('fpt')).toBe('/valuation/#stock/FPT');
    expect(L.valuation('FPT', 'technical')).toBe('/valuation/#stock/FPT/technical');
    expect(L.valuation('FPT', 'summary')).toBe('/valuation/#stock/FPT');
    expect(L.valuation('A"B')).toBe('/valuation/');
    expect(L.valuation('../../x')).toBe('/valuation/');
    expect(L.valuation('')).toBe('/valuation/');
    expect(L.stock('hpg', 2025)).toBe('/stocksheet/#HPG/2025');
    expect(L.stock('hpg', 'abc')).toBe('/stocksheet/#HPG');
    expect(L.autosheet('vcb', 2024)).toBe('/stocksheet/autosheet/#VCB/2024');
    expect(L.sym('<script>')).toBe('');
  });
  it('Insight / Kiểm thử / Mô phỏng / Toàn nhóm / Danh Mục', () => {
    expect(L.insight('events', 'fpt')).toBe('/insight/#events/FPT');
    expect(L.insight('khong-co')).toBe('/insight/#inbox');
    expect(L.lab('backtest', 'a1b2-c3')).toBe('/lab/#backtest/a1b2-c3');
    expect(L.lab('factors', '<x>')).toBe('/lab/#factors');
    expect(L.simRun('0b6f-1')).toBe('/simulation/#runs/0b6f-1');
    expect(L.simSymbol('fpt')).toBe('/simulation/#portfolio/FPT');
    expect(L.simulation('outlook')).toBe('/simulation/');
    expect(L.group('limits')).toBe('/mastersheet/#limits');
    expect(L.group('xxx')).toBe('/mastersheet/#portfolio');
    expect(L.assets('journal')).toBe('/mastersheet/assets/#journal');
    expect(L.journal()).toBe('/mastersheet/assets/#journal');
  });
  it('parseHash: không ném lỗi với mã hoá hỏng', () => {
    expect(L.parseHash('#events/FPT')).toMatchObject({ a: 'events', b: 'FPT' });
    expect(L.parseHash('')).toMatchObject({ a: '', b: '' });
    expect(() => L.parseHash('#%E0%A4%A')).not.toThrow();
  });
  it('symHtml: mã hợp lệ bấm được kèm menu, không tự liên kết về chính mình; mã lạ chỉ là chữ đã escape', () => {
    const h = L.symHtml('fpt', { from: 'insight' });
    expect(h).toContain('href="/valuation/#stock/FPT"');
    expect(h).toContain('/insight/#events/FPT');
    const v = L.symHtml('FPT', { from: 'valuation' });
    expect(v).toContain('href="/stocksheet/#FPT"');                 // từ Valuation, mã mở Nghiên cứu
    expect(v).not.toContain('/valuation/#stock/FPT');
    expect(L.symHtml('FPT', { plain: true })).not.toContain('wh-symmore');
    const bad = L.symHtml('<img src=x onerror=1>');
    expect(bad).not.toContain('<img'); expect(bad).toContain('&lt;img');
  });
});

// ---------- đối chiếu với trang đích ----------
const setOf = (a) => [...new Set(a)].sort();
describe('Links khớp trang đích', () => {
  it('Insight: các tab', () => {
    const src = read('insight/insight-app.js');
    const m = /const TABS = \{([^}]*)\}/.exec(src);
    expect(setOf([...m[1].matchAll(/(\w+):/g)].map((x) => x[1]))).toEqual(setOf(L.INSIGHT_TABS));
  });
  it('Kiểm thử: các tab', () => {
    const m = /const TABS = \{([^}]*)\}/.exec(read('lab/lab-app.js'));
    expect(setOf([...m[1].matchAll(/(\w+):/g)].map((x) => x[1]))).toEqual(setOf(L.LAB_TABS));
  });
  it('Mô phỏng: các view', () => {
    const m = /const SIM_VIEWS = \[([^\]]*)\]/.exec(read('simulation/sim-app.js'));
    expect(setOf([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]))).toEqual(setOf(L.SIM_VIEWS));
  });
  it('Toàn nhóm: các tab có nút chuyển trong trang', () => {
    const html = read('mastersheet/index.html');
    const tabs = [...html.matchAll(/switchGroupTab\('([a-z-]+)'\)/g)].map((x) => x[1]);
    expect(setOf(tabs)).toEqual(setOf(L.GROUP_TABS));
  });
  it('Danh Mục: các tab', () => {
    const src = read('mastersheet/assets/script.js');
    const m = /function switchAssetTab\(tab\) \{[\s\S]*?\[([^\]]*)\]\.forEach/.exec(src);
    expect(setOf([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]))).toEqual(setOf(L.ASSET_TABS));
  });
  it('Valuation: các tab của hồ sơ', () => {
    const m = /const tab = \[([^\]]*)\]\.indexOf\(parts\[2\]\)/.exec(read('valuation/vb-app.js'));
    expect(setOf([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]))).toEqual(setOf(L.VB_TABS));
  });
});

// danh sách tệp nguồn của app (bỏ thư viện ngoài, bản dựng, kiểm thử, hàm máy chủ)
function walk(dir, out) {
  for (const n of readdirSync(path.join(ROOT, dir))) {
    if (['node_modules', 'tauri-dist', 'tests', 'supabase', 'docs', 'src-tauri', '.git', 'scripts', 'report', 'graphify-out'].includes(n)) continue;
    const rel = dir ? dir + '/' + n : n, st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out); else if (/\.(js|html)$/.test(n)) out.push(rel);
  }
  return out;
}
const FILES = walk('', []);

describe('Liên kết trong mã nguồn', () => {
  it('trang nào có script gọi Links.* đều nạp lib/links.js', () => {
    const pages = FILES.filter((f) => /(^|\/)index\.html$/.test(f));
    const bad = [];
    for (const page of pages) {
      const html = read(page), dir = path.posix.dirname(page);
      const scripts = [...html.matchAll(/<script[^>]+src="([^"?#]+)/g)].map((x) => x[1]).filter((s) => !/^https?:/.test(s));
      const files = scripts.map((s) => (s.startsWith('/') ? s.slice(1) : path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, s))));
      const uses = files.filter((f) => f !== 'lib/links.js' && existsSync(path.join(ROOT, f)) && /\bLinks\./.test(read(f)));
      const inline = /\bLinks\./.test(html.replace(/<script[^>]+src=[^>]*><\/script>/g, ''));
      if ((uses.length || inline) && !files.includes('lib/links.js')) bad.push(page + ' dùng Links trong ' + uses.concat(inline ? ['(inline)'] : []).join(', '));
    }
    expect(bad).toEqual([]);
  });
  it('không còn literal ghép tay tới hồ sơ định giá / chi tiết Nghiên cứu', () => {
    const offenders = FILES.filter((f) => f !== 'lib/links.js' && f !== 'bench-nav.js' && /['"`]\/valuation\/#stock\//.test(read(f)));
    expect(offenders).toEqual([]);
  });
  it('mọi liên kết tĩnh /insight/#x, /lab/#x, /mastersheet/#x, /mastersheet/assets/#x, /simulation/#x trỏ tới tab có thật', () => {
    const valid = { '/insight/': L.INSIGHT_TABS, '/lab/': L.LAB_TABS, '/mastersheet/': L.GROUP_TABS, '/mastersheet/assets/': L.ASSET_TABS, '/simulation/': L.SIM_VIEWS };
    const bad = [];
    for (const f of FILES.concat(['lib/action-inbox.js'])) {
      if (f === 'lib/links.js') continue;
      const s = read(f);
      for (const m of s.matchAll(/(\/insight\/|\/lab\/|\/mastersheet\/assets\/|\/mastersheet\/|\/simulation\/)#([a-z]+)/g)) {
        if (valid[m[1]].indexOf(m[2]) === -1) bad.push(f + ': ' + m[0]);
      }
    }
    expect(bad).toEqual([]);
  });
  it('tab mặc định của Insight là Việc cần làm (mục đầu thanh điều hướng)', () => {
    expect(read('insight/insight-app.js')).toMatch(/TABS\[hp\.a\] \? hp\.a : 'inbox'/);
    expect(read('insight/insight-app.js')).toMatch(/BenchNav\.mount\(\{ bench: 'insight', active: 'inbox' \}\)/);
  });
});
