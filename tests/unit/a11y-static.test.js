// Truy cập và nhất quán giao diện (Phase 4, 12/10/2026): nút chỉ có biểu tượng phải có nhãn, bộ hoàn thiện truy cập động (lib/a11y-polish.js), và token màu / bảng / trạng thái dùng chung.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const Polish = (await import('../../lib/a11y-polish.js')).default || globalThis.A11yPolish;

const SKIP = new Set(['node_modules', 'tauri-dist', 'src-tauri', 'tests', 'supabase', 'docs', '.git', 'graphify-out', 'self', 'scripts']);
function sources() {
  const out = [];
  (function walk(d) {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.isDirectory()) { if (!SKIP.has(n.name)) walk(path.join(d, n.name)); }
      else if (/\.(js|html)$/.test(n.name)) out.push(path.join(d, n.name));
    }
  })(ROOT);
  return out;
}

describe('nút chỉ có biểu tượng', () => {
  it('mọi <button> chỉ chứa biểu tượng đều có aria-label hoặc title', () => {
    const bad = [];
    for (const f of sources()) {
      const src = readFileSync(f, 'utf8');
      const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (/aria-label\s*=|title\s*=/.test(m[1])) continue;
        const text = m[2].replace(/<[^>]*>/g, '').replace(/\$\{[^}]*\}/g, 'X').replace(/&[a-z#0-9]+;/gi, '').trim();
        if (/<i\b|<svg\b/.test(m[2]) && !text) bad.push(path.relative(ROOT, f) + ':' + src.slice(0, m.index).split('\n').length);
      }
    }
    expect(bad).toEqual([]);
  });
});

// DOM giả tối thiểu cho A11yPolish.apply (không có jsdom): chỉ những gì bộ hoàn thiện dùng
function el(text, attrs, classes) {
  const a = Object.assign({}, attrs || {});
  return { textContent: text || '', getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); }, classList: { contains: (c) => (classes || []).indexOf(c) !== -1 }, attrs: a };
}
function rootOf(map) { return { querySelectorAll: (sel) => (map[sel] || []) }; }

describe('A11yPolish.apply', () => {
  it('thêm scope="col" cho th trong thead', () => {
    const th = el('Mã');
    expect(Polish.apply(rootOf({ 'thead th:not([scope])': [th] }))).toBe(1);
    expect(th.attrs.scope).toBe('col');
  });
  it('nút chỉ có biểu tượng + title -> aria-label = title; nút có chữ hoặc không có title thì giữ nguyên', () => {
    const SEL = 'button:not([aria-label]), a.icon-btn:not([aria-label]), summary:not([aria-label])';
    const icon = el('', { title: 'Xoá dòng' }), withText = el('Lưu', { title: 'Lưu thay đổi' }), noTitle = el('', {});
    const n = Polish.apply(rootOf({ [SEL]: [icon, withText, noTitle] }));
    expect(n).toBe(1);
    expect(icon.attrs['aria-label']).toBe('Xoá dòng');
    expect(withText.attrs['aria-label']).toBeUndefined();
    expect(noTitle.attrs['aria-label']).toBeUndefined();
  });
  it('trạng thái rỗng -> role=status, trạng thái lỗi -> role=alert, không ghi đè role đã có', () => {
    const empty = el('Chưa có dữ liệu', {}, ['ins-empty']), err = el('Lỗi', {}, ['wh-state', 'error']), keep = el('x', { role: 'note' }, ['mk-empty']);
    Polish.apply(rootOf({ [Polish.STATE_SEL]: [empty, err, keep] }));
    expect(empty.attrs.role).toBe('status');
    expect(err.attrs.role).toBe('alert');
    expect(keep.attrs.role).toBe('note');
  });
  it('dòng tiến độ có role=status trừ khi đã có aria-live', () => {
    const a = el('Đang chạy', {}), b = el('x', { 'aria-live': 'polite' });
    Polish.apply(rootOf({ [Polish.LIVE_SEL]: [a, b] }));
    expect(a.attrs.role).toBe('status');
    expect(b.attrs.role).toBeUndefined();
  });
  it('chạy lại không thêm gì nữa; gốc không hợp lệ trả 0', () => {
    expect(Polish.apply(null)).toBe(0);
    expect(Polish.apply({})).toBe(0);
  });
});

describe('token và thành phần dùng chung', () => {
  const shared = read('finance-shared.css');
  it('finance-shared.css định nghĩa token ngữ nghĩa chung, bảng chung và trạng thái chung', () => {
    expect(shared).toMatch(/body \{ --wh-up: var\(--success-color\); --wh-down: var\(--danger-color\); --wh-warn: var\(--warning-color\);/);
    expect(shared).toMatch(/\.wh-table, \.ins-table, \.sim-table \{/);
    expect(shared).toMatch(/\.wh-state, \.ins-empty, \.mk-empty, \.tl-empty \{/);
    expect(shared).toMatch(/--font-prose: 'Lora', Georgia, serif;/);
  });
  it.each(['insight/insight.css', 'lab/lab.css', 'simulation/sim.css', 'valuation/vb.css'])('%s: màu lên / xuống lấy từ token chung, không khai báo lại màu cứng', (f) => {
    const css = read(f);
    const decl = css.match(/--(?:ins|sim|vb)-(?:up|down)\s*:[^;]+;/g) || [];
    expect(decl.length).toBeGreaterThan(0);
    decl.forEach((d) => expect(d, f + ' ' + d).toMatch(/var\(--wh-(up|down)\)/));
  });
  it('sim.css không còn gõ cứng font Lora (dùng --font-prose)', () => {
    expect(read('simulation/sim.css')).not.toMatch(/'Lora'/);
  });
  it('bảng và trạng thái rỗng dùng nền chung: bench CSS không khai báo lại', () => {
    expect(read('insight/insight.css')).not.toMatch(/^\.ins-table \{/m);
    expect(read('simulation/sim.css')).not.toMatch(/^\.sim-table \{/m);
    expect(read('market/market.css')).not.toMatch(/^\.mk-empty \{/m);
    expect(read('mastersheet/assets/tools.css')).not.toMatch(/^\.tl-empty \{/m);
  });
  it('bảng do insight-util dựng có scope="col"', () => {
    expect(read('insight/insight-util.js')).toMatch(/'<th scope="col"'/);
  });
  it('mọi trang nạp lib/links.js cũng nạp lib/a11y-polish.js', () => {
    const pages = sources().filter((f) => f.endsWith('.html') && /\/lib\/links\.js/.test(readFileSync(f, 'utf8')));
    expect(pages.length).toBeGreaterThanOrEqual(9);
    const missing = pages.filter((f) => !/\/lib\/a11y-polish\.js/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
    expect(missing).toEqual([]);
  });
});
