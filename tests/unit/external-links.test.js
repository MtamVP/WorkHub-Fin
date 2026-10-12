// Liên kết ngoài: một cấu hình địa chỉ (lib/external-links.js) và mở liên kết an toàn (openExternalUrl / bộ chặn neo ở api.js).
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '../../', rel), 'utf8');
const EL = require('../../lib/external-links.js');

function fakeStorage() { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m }; }

describe('ExternalLinks: địa chỉ web kế toán', () => {
  beforeEach(() => { globalThis.localStorage = fakeStorage(); });
  it('mặc định là bản đang chạy; page=finlink thêm #finlink, không page thì không hash', () => {
    expect(EL.accountingUrl()).toBe('https://accounting-2de.pages.dev/app');
    expect(EL.accountingUrl('finlink')).toBe('https://accounting-2de.pages.dev/app#finlink');
  });
  it('địa chỉ người dùng đặt được tôn trọng cho cả hai nơi dùng; xoá về mặc định', () => {
    expect(EL.setAccountingUrl('https://ketoan.example.vn/app')).toBe(true);
    expect(EL.accountingUrl()).toBe('https://ketoan.example.vn/app');
    expect(EL.accountingUrl('finlink')).toBe('https://ketoan.example.vn/app#finlink');
    expect(EL.setAccountingUrl('https://ketoan.example.vn/app#finlink')).toBe(true);
    expect(EL.accountingUrl()).toBe('https://ketoan.example.vn/app');       // hash cũ bị thay theo page
    expect(EL.setAccountingUrl('')).toBe(true);
    expect(EL.accountingUrl()).toBe('https://accounting-2de.pages.dev/app');
  });
  it('chỉ nhận http(s): javascript:, file:, chuỗi trống không được lưu; giá trị xấu đã lưu bị bỏ qua', () => {
    expect(EL.setAccountingUrl('javascript:alert(1)')).toBe(false);
    expect(EL.setAccountingUrl('file:///c:/x')).toBe(false);
    expect(EL.setAccountingUrl('ketoan.example.vn')).toBe(false);
    localStorage.setItem(EL.ACCOUNTING_KEY, 'javascript:alert(1)');
    expect(EL.accountingUrl()).toBe('https://accounting-2de.pages.dev/app');
  });
  it('không có localStorage vẫn chạy', () => {
    delete globalThis.localStorage;
    expect(EL.accountingUrl('finlink')).toContain('#finlink');
    expect(EL.setAccountingUrl('https://a.b')).toBe(false);
  });
  it('org và releases có sẵn', () => { expect(EL.org()).toMatch(/^https:\/\//); expect(EL.releases()).toMatch(/github\.com\/MtamVP\/WorkHub-Fin/); });
});

// Chạy đúng đoạn đầu api.js (openExternalUrl + bộ chặn neo) trong sandbox có Tauri hoặc không
function boot(withTauri) {
  const src = read('api.js'), end = src.indexOf('window.escapeHtml = function');
  const opened = [], toasts = [], handlers = {};
  const win = { open: (u, t, f) => opened.push({ via: 'window.open', u, t, f }), showToast: (m, t) => toasts.push({ m, t }) };
  if (withTauri) win.__TAURI__ = { opener: { openUrl: (u) => { opened.push({ via: 'tauri', u }); return Promise.resolve(); } } };
  const ctx = vm.createContext({ window: win, console: { warn() {}, error() {}, log() {} }, document: { addEventListener: (ev, fn) => { handlers[ev] = fn; } }, URL });
  vm.runInContext(src.slice(0, end), ctx);
  const click = (a, extra) => { const e = Object.assign({ defaultPrevented: false, target: { closest: () => a }, preventDefault() { this.defaultPrevented = true; } }, extra || {}); handlers.click(e); return e; };
  const anchor = (href, target) => ({ getAttribute: (k) => (k === 'href' ? href : k === 'target' ? target || null : null) });
  return { win, opened, toasts, click, anchor };
}

describe('openExternalUrl', () => {
  it('http(s) và mailto: mở; trình duyệt dùng noopener,noreferrer', () => {
    const b = boot(false);
    expect(b.win.openExternalUrl('https://vnexpress.net/a?b=1#c')).toBe(true);
    expect(b.win.openExternalUrl('mailto:x@y.vn')).toBe(true);
    expect(b.opened.map((o) => o.u)).toEqual(['https://vnexpress.net/a?b=1#c', 'mailto:x@y.vn']);
    expect(b.opened[0].f).toBe('noopener,noreferrer');
  });
  it('javascript:, data:, file:, đường dẫn tương đối, trống: bị chặn và báo người dùng', () => {
    const b = boot(false);
    ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///c:/Windows/win.ini', '/valuation/', 'google.com', '', null, undefined, '  vbscript:x'].forEach((u) => expect(b.win.openExternalUrl(u)).toBe(false));
    expect(b.opened).toEqual([]); expect(b.toasts.length).toBe(9);
  });
  it('trong app desktop dùng opener của Tauri với địa chỉ đã chuẩn hoá', () => {
    const b = boot(true);
    b.win.openExternalUrl('  https://example.com  ');
    expect(b.opened).toEqual([{ via: 'tauri', u: 'https://example.com/' }]);
  });
});

describe('bộ chặn neo <a href>', () => {
  it('chặn javascript:/data:/file: ở mọi neo', () => {
    const b = boot(false);
    ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'file:///c:/x', 'vbscript:x'].forEach((h) => expect(b.click(b.anchor(h, '_blank')).defaultPrevented).toBe(true));
  });
  it('neo thường và neo nội bộ không bị chặn; neo http(s) target=_blank trong trình duyệt để mặc định', () => {
    const b = boot(false);
    expect(b.click(b.anchor('/valuation/#stock/FPT')).defaultPrevented).toBe(false);
    expect(b.click(b.anchor('https://a.com', '_blank')).defaultPrevented).toBe(false);
    expect(b.opened).toEqual([]);
  });
  it('trong Tauri: neo target=_blank http(s) mở bằng trình duyệt hệ thống đúng một lần; trang đã tự xử lý (defaultPrevented) thì bỏ qua', () => {
    const b = boot(true);
    expect(b.click(b.anchor('https://a.com/x', '_blank')).defaultPrevented).toBe(true);
    expect(b.opened).toEqual([{ via: 'tauri', u: 'https://a.com/x' }]);
    b.opened.length = 0;
    b.click(b.anchor('https://a.com/y', '_blank'), { defaultPrevented: true });
    expect(b.opened).toEqual([]);
    expect(b.click(b.anchor('https://a.com/z')).defaultPrevented).toBe(false);          // không target=_blank: để webview xử lý
  });
  it('không có neo dưới con trỏ: không làm gì', () => {
    const b = boot(true);
    const e = { defaultPrevented: false, target: { closest: () => null }, preventDefault() { this.defaultPrevented = true; } };
    expect(() => b.click(null, e)).not.toThrow();
  });
});

describe('không còn địa chỉ ngoài cứng ở nơi đã gom về cấu hình', () => {
  it('index.html, script.js và accounting-link-ui.js dùng ExternalLinks', () => {
    expect(read('index.html')).not.toMatch(/accounting-2de\.pages\.dev/);
    expect(read('script.js')).not.toMatch(/workhub-org\.pages\.dev/);
    expect(read('mastersheet/assets/accounting-link-ui.js')).not.toMatch(/accounting-2de\.pages\.dev/);
    expect(read('mastersheet/assets/accounting-link-ui.js')).toMatch(/ExternalLinks\./);
  });
  it('trang nạp lib/external-links.js trước nơi dùng', () => {
    const idx = read('index.html'), a = idx.indexOf('lib/external-links.js'), b = idx.indexOf('api.js?v=');
    expect(a).toBeGreaterThan(0); expect(a).toBeLessThan(idx.indexOf('script.js?v='));
    expect(b).toBeGreaterThan(0);
    const as = read('mastersheet/assets/index.html');
    expect(as.indexOf('/lib/external-links.js')).toBeGreaterThan(0);
    expect(as.indexOf('/lib/external-links.js')).toBeLessThan(as.indexOf('accounting-link-ui.js'));
  });
});
