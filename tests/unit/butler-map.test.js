// lib/butler-map-fin.js: bản đồ tính năng của Quản gia. Mọi đường dẫn phải trỏ tới trang / mục có thật; từ khoá không trùng giữa các mục và mỗi mục nhận ra được chính nó;
// các mục của trang chính ('/#section=...', '/#do=...') phải được script.js xử lý. Sửa giao diện làm lệch bản đồ thì test này đỏ.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const L = require('../../lib/links.js');
const C = require('../../lib/butler-core.js');
const M = require('../../lib/butler-map-fin.js');

const pageFile = (p) => {
  const clean = p.split('#')[0].replace(/^\//, '');
  return clean === '' ? 'index.html' : (clean.endsWith('/') ? clean + 'index.html' : clean);
};

describe('bản đồ tính năng Fin', () => {
  it('có đủ trường; id không trùng; đủ nhiều mục', () => {
    expect(M.features.length).toBeGreaterThanOrEqual(55);
    const ids = M.features.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    M.features.forEach((f) => {
      expect(typeof f.label, f.id).toBe('string');
      expect(f.area, f.id).toBeTruthy();
      expect(f.icon, f.id).toMatch(/^fa-/);
      expect(Array.isArray(f.keys) && f.keys.length >= 2, f.id).toBe(true);
      expect(Array.isArray(f.steps) && f.steps.length >= 1, f.id).toBe(true);
      expect(typeof f.to, f.id).toBe('function');
      if (f.need) expect(['admin', 'minRole', 'groups'].some((k) => k in f.need), f.id).toBe(true);
    });
  });
  it('mọi đường dẫn (có mã và không mã) trỏ tới tệp có thật và bắt đầu bằng "/"', () => {
    M.features.forEach((f) => {
      [M.hrefOf(f, L, ''), M.hrefOf(f, L, 'FPT')].forEach((h) => {
        expect(h, f.id).toMatch(/^\//);
        expect(existsSync(path.join(ROOT, pageFile(h))), f.id + ' -> ' + h).toBe(true);
      });
    });
  });
  it('mục cần mã (sym: true) đưa mã vào đường dẫn; mục không cần mã thì không đổi theo mã', () => {
    M.features.forEach((f) => {
      const a = M.hrefOf(f, L, ''), b = M.hrefOf(f, L, 'FPT');
      if (f.sym) expect(b, f.id).toContain('FPT'); else expect(b, f.id).toBe(a);
    });
  });
  it('mục của trang chính: khoá section có trong SECTION_KEYS và mọi hành động #do= được script.js xử lý', () => {
    const script = read('script.js');
    const keys = [...script.match(/const SECTION_KEYS = \[([^\]]*)\]/)[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]);
    M.features.forEach((f) => {
      const h = M.hrefOf(f, L, '');
      let m;
      if ((m = /^\/#section=([\w-]+)$/.exec(h))) { expect(keys, f.id).toContain(m[1]); expect(f.section, f.id).toBe(m[1]); }
      if ((m = /^\/#do=(\w+)$/.exec(h))) expect(script.includes("'" + m[1] + "'"), f.id).toBe(true);
    });
  });
  it('tab của Toàn Nhóm / Danh Mục / Insight / Kiểm thử / Mô phỏng nằm trong danh sách Links (không dựng tab lạ)', () => {
    M.features.forEach((f) => {
      const h = M.hrefOf(f, L, 'FPT');
      let m;
      if ((m = /^\/mastersheet\/#(\w+)/.exec(h))) expect(L.GROUP_TABS, f.id).toContain(m[1]);
      if ((m = /^\/mastersheet\/assets\/#(\w+)/.exec(h))) expect(L.ASSET_TABS, f.id).toContain(m[1]);
      if ((m = /^\/insight\/#(\w+)/.exec(h))) expect(L.INSIGHT_TABS, f.id).toContain(m[1]);
      if ((m = /^\/lab\/#(\w+)/.exec(h))) expect(L.LAB_TABS, f.id).toContain(m[1]);
    });
  });
  it('từ khoá không trùng nhau giữa hai mục (sau khi bỏ dấu)', () => {
    const seen = new Map();
    M.features.forEach((f) => f.keys.forEach((k) => {
      const kf = C.fold(k);
      expect(seen.has(kf) ? seen.get(kf) + ' và ' + f.id + ' cùng từ khoá "' + k + '"' : '').toBe('');
      seen.set(kf, f.id);
    }));
  });
  it('mỗi từ khoá đầu tiên của mục đưa chính mục đó vào 3 kết quả đầu', () => {
    M.features.forEach((f) => {
      const r = C.understand(f.keys[0], {}, M);
      expect(r.features.slice(0, 3).map((x) => x.id), f.id + ' <- "' + f.keys[0] + '"').toContain(f.id);
    });
  });
  it('mỗi từ khoá của mục đưa chính mục đó vào 5 kết quả đầu (trừ khi bị xếp vào "việc hôm nay")', () => {
    M.features.forEach((f) => f.keys.forEach((k) => {
      const r = C.understand(k, {}, M);
      expect(r.features.map((x) => x.id), f.id + ' <- "' + k + '"').toContain(f.id);
    }));
  });
  it('ví dụ gợi ý đều được hiểu (không rơi vào unknown)', () => {
    M.examples.forEach((q) => expect(C.understand(q, {}, M).intent, q).not.toBe('unknown'));
  });
  it('mục chỉ quản trị: audit-log và fin-roles', () => {
    expect(M.byId('audit-log').need).toEqual({ admin: true });
    expect(M.byId('fin-roles').need).toEqual({ admin: true });
    expect(M.byId('khong-co')).toBeNull();
  });
});
