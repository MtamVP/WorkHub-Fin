// Giao diện điện thoại: mobile-cards.js (bảng thành thẻ có nhãn), BenchNav.centerOffset (cuộn thanh dưới đáy đến mục đang mở) và các quy tắc CSS giữ cho thanh điều hướng bám đáy.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import MobileCards from '../../mobile-cards.js';
import BenchNav from '../../bench-nav.js';

const ROOT = path.resolve(__dirname, '../..');
const css = fs.readFileSync(path.join(ROOT, 'finance-shared.css'), 'utf8');

// Bảng giả tối thiểu: chỉ những gì MobileCards dùng (querySelectorAll, children, tagName, colSpan, setAttribute)
const cell = (tag, text, colSpan) => { const attrs = {}; return { tagName: tag, textContent: text, colSpan: colSpan || 1, attrs, setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; } }; };
const row = (cells) => ({ children: cells });
const table = (head, body) => ({ querySelectorAll: (sel) => (sel === 'thead tr' ? (head ? [head] : []) : (sel === 'tbody tr' ? body : [])) });

describe('MobileCards: gán nhãn cột cho từng ô', () => {
  it('lấy nhãn từ tiêu đề (gọn khoảng trắng) và gán cho đúng ô theo vị trí cột', () => {
    const head = row([cell('TH', 'Mã'), cell('TH', '  Khối\n   lượng '), cell('TH', 'Giá vốn BQ')]);
    const r1 = row([cell('TD', 'FPT'), cell('TD', '1,000'), cell('TD', '92,400')]), r2 = row([cell('TD', 'SSI'), cell('TD', '1,550'), cell('TD', '33,834')]);
    const t = table(head, [r1, r2]);
    expect(MobileCards.labelsOf(t)).toEqual(['Mã', 'Khối lượng', 'Giá vốn BQ']);
    MobileCards.apply(t);
    expect(r1.children.map((c) => c.attrs['data-label'])).toEqual(['Mã', 'Khối lượng', 'Giá vốn BQ']);
    expect(r2.children.map((c) => c.attrs['data-label'])).toEqual(['Mã', 'Khối lượng', 'Giá vốn BQ']);
  });
  it('dòng thông báo trống (ô gộp cột) không có nhãn, kể cả khi trước đó từng có', () => {
    const head = row([cell('TH', 'Mã'), cell('TH', 'KL')]);
    const empty = cell('TD', 'Chưa có dữ liệu', 2); empty.attrs['data-label'] = 'cũ';
    const t = table(head, [row([empty])]);
    MobileCards.apply(t);
    expect(empty.attrs['data-label']).toBeUndefined();
  });
  it('bảng nhiều dòng tiêu đề lấy dòng cuối; không có tiêu đề hoặc ô thừa thì không gán bậy; chỉ gán cho td', () => {
    const t0 = { querySelectorAll: (sel) => (sel === 'thead tr' ? [row([cell('TH', 'A')]), row([cell('TH', 'Mã'), cell('TH', 'KL')])] : []) };
    expect(MobileCards.labelsOf(t0)).toEqual(['Mã', 'KL']);
    const extra = cell('TD', 'x'), th = cell('TH', 'tiêu đề lạc'), td = cell('TD', 'y');
    const t = table(row([cell('TH', 'Mã')]), [row([th, td, extra])]);
    MobileCards.apply(t);
    expect(th.attrs['data-label']).toBeUndefined();     // th trong thân bảng không phải ô dữ liệu
    expect(td.attrs['data-label']).toBeUndefined();     // cột thứ hai không có tiêu đề
    expect(MobileCards.labelsOf(table(null, []))).toEqual([]);
    expect(() => MobileCards.apply(table(null, [row([cell('TD', 'a')])]))).not.toThrow();
  });
  it('mount không làm gì khi không có document (Vitest/Node)', () => {
    expect(MobileCards.mount()).toBeUndefined();
  });
});

describe('BenchNav.centerOffset: đưa mục đang mở vào giữa thanh cuộn ngang', () => {
  it('giữa thanh khi đủ chỗ; không âm ở mép trái; không vượt phần cuộn được ở mép phải', () => {
    expect(BenchNav.centerOffset(390, 500, 90, 900)).toBe(500 - (390 - 90) / 2);      // 350
    expect(BenchNav.centerOffset(390, 20, 90, 900)).toBe(0);
    expect(BenchNav.centerOffset(390, 800, 90, 900)).toBe(900 - 390);                 // 510
    expect(BenchNav.centerOffset(390, 100, 90, 300)).toBe(0);                         // nội dung hẹp hơn khung
  });
});

describe('CSS giao diện điện thoại (finance-shared.css)', () => {
  const mobile = css.slice(css.indexOf('MOBILE SHELL'));
  it('thanh điều hướng bám đáy và thanh trên không còn backdrop-filter (nếu còn, phần tử fixed bên trong bị nhốt trong thanh trên)', () => {
    expect(mobile).toMatch(/\.desk-nav \{[^}]*position: fixed;[^}]*bottom: 0;/);
    expect(mobile).toMatch(/\.desk-topbar \{ backdrop-filter: none;/);
    expect(mobile).toMatch(/body\.desk \{ padding-bottom: calc\(76px \+ env\(safe-area-inset-bottom/);
  });
  it('bảng Danh Mục thành thẻ chỉ trong khối <= 768px; khung bảng cuộn ngang thay vì cắt', () => {
    const idx = mobile.indexOf('MOBILE PAGES');
    const pages = mobile.slice(idx);
    expect(pages).toMatch(/@media \(max-width: 768px\)/);
    expect(pages).toMatch(/\.spreadsheet-wrapper \{ overflow-x: auto;/);
    expect(pages).toMatch(/table\[data-m-cards\] td::before \{ content: attr\(data-label\);/);
    expect(css.slice(0, css.indexOf('MOBILE SHELL'))).not.toContain('data-m-cards');   // không rò ra ngoài khối điện thoại
  });
  it('mọi trang dùng thanh điều hướng đều khai báo viewport-fit=cover (để vùng an toàn của điện thoại hoạt động) và nạp đúng phiên bản CSS', () => {
    ['market', 'mastersheet', 'mastersheet/assets', 'stocksheet', 'valuation'].forEach((d) => {
      const h = fs.readFileSync(path.join(ROOT, d, 'index.html'), 'utf8');
      expect(h).toContain('viewport-fit=cover');
    });
    const assets = fs.readFileSync(path.join(ROOT, 'mastersheet/assets/index.html'), 'utf8');
    expect(assets).toContain('data-m-cards');
    expect(assets).toContain('MobileCards.mount()');
    expect(assets.indexOf('/mobile-cards.js')).toBeLessThan(assets.indexOf('MobileCards.mount()'));
  });
});
