// bench-nav.js (điều hướng dùng chung của hai khu vực) và valuation/vb-methods.js (thư viện phương pháp: mỗi mục phải đủ trường).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import BenchNav from '../../bench-nav.js';
import VBMethods from '../../valuation/vb-methods.js';

const ROOT = path.resolve(__dirname, '../..');

describe('BenchNav', () => {
  it('Investment giữ nguyên Toàn Nhóm / Danh Mục / Nghiên Cứu và thêm lối sang Valuation Bench', () => {
    const keys = BenchNav.NAV.investment.items.map((i) => i.key);
    expect(keys).toEqual(['group', 'assets', 'research', 'vb']);
  });
  it('Valuation Bench có lối quay về Investment và giữ Định Giá CP thủ công', () => {
    const items = BenchNav.NAV.valuation.items;
    expect(items.find((i) => i.key === 'back').href).toBe('/mastersheet/');
    expect(items.find((i) => i.key === 'manual').href).toContain('/stocksheet/autosheet/');
  });
  it('mọi liên kết nội bộ trỏ tới trang có thật trong repo', () => {
    Object.keys(BenchNav.NAV).forEach((b) => BenchNav.NAV[b].items.forEach((it) => {
      const p = it.href.split('#')[0].split('?')[0];
      expect(fs.existsSync(path.join(ROOT, p, 'index.html')), it.href).toBe(true);
    }));
  });
  it('navHtml đánh dấu mục đang mở', () => {
    const h = BenchNav.navHtml('investment', 'assets');
    expect(h.match(/aria-current="page"/g).length).toBe(1);
    expect(h).toContain('Danh Mục');
  });
  it('benchFromSearch: ?bench= quyết định; đường dẫn cũ ?view=market thuộc Valuation Bench', () => {
    expect(BenchNav.benchFromSearch('?bench=valuation')).toBe('valuation');
    expect(BenchNav.benchFromSearch('?bench=investment&view=market')).toBe('investment');
    expect(BenchNav.benchFromSearch('?view=market')).toBe('valuation');
    expect(BenchNav.benchFromSearch('?view=detail')).toBe('investment');
    expect(BenchNav.benchFromSearch('')).toBe('investment');
  });
});

describe('trang Finance chính', () => {
  it('thanh bên có lối vào RIÊNG cho Investment Workbench và Valuation Bench (ngang hàng)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(html).toContain("location.href='/mastersheet/'");
    expect(html).toContain("location.href='/valuation/'");
    expect(html.indexOf("location.href='/valuation/'")).toBeGreaterThan(html.indexOf("location.href='/mastersheet/'"));
  });
});

describe('thư viện phương pháp', () => {
  const L = VBMethods.LIST;
  it('đủ rộng: ≥ 45 mục, mọi nhóm đều có mục', () => {
    expect(L.length).toBeGreaterThanOrEqual(45);
    Object.keys(VBMethods.GROUPS).forEach((g) => expect(L.some((m) => m.group === g), g).toBe(true));
  });
  it('mỗi mục đủ id, nhóm hợp lệ, tên, định nghĩa, công thức, khi dùng, hạn chế, cách đọc', () => {
    L.forEach((m) => {
      expect(typeof m.id === 'string' && m.id.length > 0, 'id').toBe(true);
      expect(VBMethods.GROUPS[m.group], m.id + ' group').toBeTruthy();
      ['name', 'what', 'formula', 'use', 'limit', 'read'].forEach((k) => expect(String(m[k] || '').trim().length > 2, m.id + '.' + k).toBe(true));
    });
  });
  it('id không trùng', () => { expect(new Set(L.map((m) => m.id)).size).toBe(L.length); });
  it('có các phương pháp cốt lõi', () => {
    const ids = L.map((m) => m.id).join(' ');
    ['dcf', 'rsi', 'macd', 'piotroski', 'altman'].forEach((k) => expect(ids, k).toContain(k));
  });
});
