import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const REPO = process.cwd().replace(/\\/g, '/');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Chạy pretrade.js THẬT trong vm với DOM giả, hàm VCI giả và các thư viện tính toán thật
function boot(o) {
  const opt = Object.assign({ quote: { price: 60300, ref: 60400, ceil: 64600, floor: 56200 }, fail: false, active: true, liveQuotes: {} }, o);
  const els = {}, calls = { liveQuotes: [] };
  const mk = (id, extra) => { const L = {}; const e = Object.assign({ id, value: '', dataset: {}, open: true, innerHTML: '', textContent: '', checked: false,
    addEventListener(t, f) { (L[t] = L[t] || []).push(f); }, dispatchEvent(ev) { (L[ev.type] || []).forEach((f) => f(ev)); return true; } }, extra || {}); els[id] = e; return e; };
  ['txn-type', 'txn-symbol', 'txn-quantity', 'txn-price', 'txn-plan-stop', 'txn-plan-expected', 'txn-live-hint', 'pt-body', 'txn-pretrade'].forEach((id) => mk(id));
  els['txn-type'].value = 'buy'; els['txn-pretrade'].open = true;
  const seg = mk('seg'), form = mk('form');
  const doc = { _L: {}, getElementById: (id) => els[id] || null, querySelector: (s) => (s === '#txn-form .seg' ? seg : null),
    addEventListener(t, f) { (this._L[t] = this._L[t] || []).push(f); }, fire(t) { (this._L[t] || []).forEach((f) => f()); } };
  const holdings = [{ symbol: 'FPT', marketValue: 10e6, marketPrice: 100000 }, { symbol: 'HPG', marketValue: 5e6, marketPrice: 25000 }];
  const lm = [{ id: 'l1', scope: 'member', kind: 'max_symbol_pct', value: 30, mode: 'warn', active: true }];
  const ctx = vm.createContext({
    document: doc, window: {}, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, Promise, Date, JSON, Math, console, Event: class { constructor(type) { this.type = type; } },
    escapeAssetHtml: (s) => String(s).replace(/</g, '&lt;'), parseMoney: (v) => { const n = Number(String(v || '').replace(/,/g, '')); return isFinite(n) ? n : 0; },
    targetEmail: 'a@b.c', getFeeSettings: () => ({ buyFeeRate: 0.0015, sellFeeRate: 0.0015, sellTaxRate: 0.001 }),
    callGAS: async (a) => (a === 'getHoldingsView' ? { status: 'success', data: holdings } : a === 'getCashDebt' ? { status: 'success', data: { cash: 5e6, debt: 0 } } : { status: 'error', message: 'x' }),
    lmCall: async (a) => (a === 'listLimits' ? lm : a === 'getLimitActor' ? { targetId: 'u1' } : a === 'getApprovalPolicy' ? null : []),
    API: { asset: { market: { liveQuotes: async (s) => { calls.liveQuotes.push(s.slice()); if (opt.fail) throw new Error('VCI lỗi'); return { ok: true, quotes: { [s[0]]: opt.quote }, asOf: '2026-10-07T03:30:12Z' }; } } } },
    LiveUI: { active: () => opt.active },
  });
  ['lib/finance-calc.js', 'lib/portfolio-calc.js', 'lib/limits-calc.js', 'lib/sizing-calc.js', 'lib/approval-calc.js', 'lib/live-quotes.js', 'lib/pretrade-live.js', 'mastersheet/assets/pretrade.js'].forEach((f) => vm.runInContext(fs.readFileSync(REPO + '/' + f, 'utf8'), ctx, { filename: f }));
  const LQ = vm.runInContext('LiveQuotes', ctx);
  LQ.session = () => 'open';
  LQ.state.quotes = opt.liveQuotes;
  doc.fire('DOMContentLoaded');
  return { els, calls, LQ, ctx };
}
const typeSymbol = async (t, sym) => { t.els['txn-symbol'].value = sym; t.els['txn-symbol'].dispatchEvent({ type: 'input' }); await wait(700); };

describe('form nhập lệnh: giá trực tiếp', () => {
  it('nhập mã thì tự điền giá trực tiếp vào ô Giá (ô trống), hiện dòng giá thị trường kèm trần/sàn và giờ', async () => {
    const t = boot();
    await typeSymbol(t, 'fpt');
    expect(t.els['txn-price'].value).toBe(60300); expect(t.els['txn-price'].dataset.auto).toBe('1');
    expect(t.els['txn-live-hint'].textContent).toBe('Giá trực tiếp 60.300 · tham chiếu 60.400 · trần 64.600 · sàn 56.200 (lúc 10:30:12)');
    expect(t.calls.liveQuotes).toEqual([['FPT']]);
  });
  it('đổi sang mã khác thì đổi theo giá tự điền; nhưng giá người dùng đã gõ thì KHÔNG bị ghi đè', async () => {
    const t = boot();
    await typeSymbol(t, 'FPT'); expect(t.els['txn-price'].value).toBe(60300);
    t.els['txn-price'].value = '60000'; t.els['txn-price'].dispatchEvent({ type: 'input' });             // người dùng tự gõ
    expect(t.els['txn-price'].dataset.auto).toBe('0');
    await typeSymbol(t, 'VNM'); expect(t.els['txn-price'].value).toBe('60000');                         // giữ giá của người dùng
    expect(t.els['txn-live-hint'].textContent).toContain('Giá trực tiếp');                                // nhưng vẫn hiện giá thị trường để so
  });
  it('hàm VCI lỗi: dùng giá đang có của Danh Mục nếu có; không có gì thì không điền và không lỗi', async () => {
    const t = boot({ fail: true, liveQuotes: { FPT: { price: 59900, ref: 60400, time: '10:29:50' } } });
    await typeSymbol(t, 'FPT'); expect(t.els['txn-price'].value).toBe(59900); expect(t.els['txn-live-hint'].textContent).toContain('59.900');
    const none = boot({ fail: true }); await typeSymbol(none, 'ZZZ'); expect(none.els['txn-price'].value).toBe(''); expect(none.els['txn-live-hint'].textContent).toBe('');
  });
  it('mã sai định dạng thì xoá dòng giá thị trường', async () => {
    const t = boot(); await typeSymbol(t, 'FPT'); await typeSymbol(t, 'x'); expect(t.els['txn-live-hint'].textContent).toBe('');
  });
});

describe('kiểm tra trước lệnh: theo giá trực tiếp', () => {
  it('NAV và tỷ trọng tính theo giá trực tiếp của các mã đang nắm, ghi rõ nhãn; cảnh báo giá nhập ngoài trần', async () => {
    const t = boot({ liveQuotes: { FPT: { price: 90000, ref: 100000, time: '10:30:00' } } });
    t.els['txn-symbol'].value = 'FPT'; t.els['txn-quantity'].value = '100'; t.els['txn-price'].value = '70000'; t.els['txn-price'].dataset.auto = '0';
    t.els['txn-symbol'].dispatchEvent({ type: 'input' }); await wait(900);
    const html = t.els['pt-body'].innerHTML;
    expect(html).toContain('giá trực tiếp');                                   // nhãn trên dòng NAV
    expect(html).toContain('19.000.000');                                       // NAV: 9 triệu (FPT theo giá 90.000) + 5 triệu (HPG) + 5 triệu tiền mặt
    expect(html).toContain('cao hơn giá trần 64.600');                          // 70.000 vượt trần
    expect(html).toContain('Dùng giá này');
  });
  it('tắt giá trực tiếp ở Danh Mục thì dùng giá lưu và không có nhãn', async () => {
    const t = boot({ active: false, liveQuotes: { FPT: { price: 90000, ref: 100000 } } });
    t.els['txn-symbol'].value = 'FPT'; t.els['txn-quantity'].value = '100'; t.els['txn-price'].value = '60000';
    t.els['txn-symbol'].dispatchEvent({ type: 'input' }); await wait(900);
    const html = t.els['pt-body'].innerHTML;
    expect(html).toContain('20.000.000'); expect(html).not.toContain('>giá trực tiếp<');
  });
});
