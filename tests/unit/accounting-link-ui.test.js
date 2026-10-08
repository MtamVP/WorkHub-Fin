import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const REPO = process.cwd().replace(/\\/g, '/');
const T = (id, symbol, type, quantity, price, fee, tax, d) => ({ id, symbol, type, quantity, price, fee, tax, trade_date: d, created_at: d + 'T03:00:00Z' });

// Chạy accounting-link-ui.js THẬT cùng portfolio-calc.js + accounting-bridge.js trong vm; callGAS giả trả sổ lệnh theo kịch bản
function boot(data, opts) {
  const o = opts || {};
  const els = {}, store = new Map(), saved = [], opened = [], toasts = [];
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', value: '', options: [], selectedIndex: 0, disabled: false });
  els['rpt-acc-month'] = { id: 'rpt-acc-month', innerHTML: '', value: '2026-08', options: [], selectedIndex: 0 };
  const calls = [];
  const ctx = vm.createContext({
    document: { getElementById: el },
    window: { open() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    console, Date, JSON, Math, Promise, TextEncoder, TextDecoder, setTimeout,
    targetEmail: 'a@b.test',
    callGAS: async (action, params) => {
      calls.push(action);
      if (o.fail === action) return { status: 'error', message: 'Không có quyền đọc' };
      return { status: 'success', data: data[action] || [] };
    },
    escapeAssetHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    showToast: (m, k) => toasts.push([m, k]),
    FinCalc: { buildCsv: (rows) => rows.map((r) => r.join('|')).join('\n') },
    saveBytesToDisk: async (name, bytes) => { saved.push([name, new TextDecoder().decode(bytes)]); return name; },
    openExternalUrl: (u) => opened.push(u),
  });
  ['lib/portfolio-calc.js', 'lib/accounting-bridge.js', 'mastersheet/assets/accounting-link-ui.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  vm.runInContext('globalThis.UI = AccountingLinkUI;', ctx);
  return { UI: vm.runInContext('UI', ctx), els, store, saved, opened, toasts, calls };
}

const DATA = {
  listAssetTransactions: [T('b1', 'FPT', 'buy', 100, 100000, 15000, 0, '2026-07-10'), T('s1', 'FPT', 'sell', 100, 120000, 18000, 12000, '2026-08-12'), T('b2', 'VNM', 'buy', 100, 60000, 9000, 0, '2026-08-20')],
  listCashFlows: [{ id: 'f1', flow_type: 'dividend', amount: 1500000, flow_date: '2026-08-15', symbol: 'FPT' }, { id: 'f2', flow_type: 'deposit', amount: 50000000, flow_date: '2026-08-02' }],
  listCorporateActions: [],
};

describe('thẻ Liên kết kế toán (accounting-link-ui.js) trong tab Báo Cáo', () => {
  it('init điền 18 tháng, địa chỉ mặc định và lời nhắc', () => {
    const t = boot(DATA);
    t.UI.init();
    expect(t.els['rpt-acc-month'].innerHTML.match(/<option/g)).toHaveLength(18);
    expect(t.els['rpt-acc-url'].value).toBe(t.UI.DEFAULT_URL);
    expect(t.els['rpt-acc-result'].innerHTML).toMatch(/Xem bút toán đề xuất/);
  });

  it('run: đọc 3 nguồn, hiện KPI và bảng bút toán đúng số tính tay', async () => {
    const t = boot(DATA);
    await t.UI.run();
    expect(t.calls.sort()).toEqual(['listAssetTransactions', 'listCashFlows', 'listCorporateActions']);
    const html = t.els['rpt-acc-result'].innerHTML;
    expect(html).toContain('+1,955,000');                    // lãi bán ròng: 12.000.000 - (10.000.000 + 15.000) - 18.000 - 12.000
    expect(html).toContain('1,500,000');                     // cổ tức
    expect(html).toContain('50,000,000');                    // nạp
    expect(html).toContain('Nợ 1121 + 635 / Có 121 + 515'); // định khoản lệnh bán
    expect(html).toContain('Mở web kế toán');
    expect(t.UI.state.result.summary.voucherCount).toBe(4);  // nạp, bán, cổ tức, mua VNM (lệnh mua tháng 7 ở ngoài kỳ)
  });

  it('CSV: mỗi dòng định khoản một hàng, có mã chứng từ cố định; lưu qua saveBytesToDisk', async () => {
    const t = boot(DATA);
    await t.UI.run();
    await t.UI.exportCsv();
    expect(t.saved).toHaveLength(1);
    const [name, text] = t.saved[0];
    expect(name).toBe('but-toan-de-xuat-2026-08.csv');
    const lines = text.split('\n');
    expect(lines[0]).toBe('Số chứng từ đề xuất|Ngày|Nghiệp vụ|Diễn giải|Tài khoản|Bên|Số tiền');
    expect(lines.some((l) => /^FIN-BAN-S1\|2026-08-12\|Bán chứng khoán\|.*\|515\|Có\|1985000$/.test(l))).toBe(true);
    expect(t.toasts.pop()[1]).toBe('success');
  });

  it('lỗi đọc dữ liệu hiện thông báo thay vì treo, và nút bấm lại được', async () => {
    const t = boot(DATA, { fail: 'listCashFlows' });
    await t.UI.run();
    expect(t.els['rpt-acc-result'].innerHTML).toMatch(/Lỗi: Không có quyền đọc/);
    expect(t.UI.state.busy).toBe(false);
    expect(t.UI.state.result).toBeNull();
  });

  it('mở web kế toán theo địa chỉ đã lưu; địa chỉ không phải http(s) bị từ chối và dùng mặc định', () => {
    const t = boot(DATA);
    t.UI.openAccounting();
    expect(t.opened).toEqual([t.UI.DEFAULT_URL]);
    t.UI.saveUrl('https://ketoan.example.vn/app#finlink');
    t.UI.openAccounting();
    expect(t.opened[1]).toBe('https://ketoan.example.vn/app#finlink');
    t.UI.saveUrl('javascript:alert(1)');
    expect(t.UI.accountingUrl()).toBe('https://ketoan.example.vn/app#finlink');
    expect(t.toasts.pop()[1]).toBe('error');
  });

  it('thẻ nhúng văn bản từ sổ lệnh đã được escape (không chèn HTML)', async () => {
    const bad = { ...DATA, listCashFlows: [{ id: 'f9', flow_type: 'deposit', amount: 1000, flow_date: '2026-08-03', note: '<img src=x onerror=alert(1)>' }] };
    const t = boot(bad);
    await t.UI.run();
    expect(t.els['rpt-acc-result'].innerHTML).not.toContain('<img');
    expect(t.els['rpt-acc-result'].innerHTML).toContain('&lt;img');
  });
});
