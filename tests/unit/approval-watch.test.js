// Edge Function approval-watch: kiểm tra độc lập lệnh lớn không qua duyệt + email; bản sao approval-calc.js phải khớp lib/ và chạy được khi nạp kiểu Deno.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnapproved, buildPendingEmail, buildAuditEmail, selfTest } from '../../supabase/functions/approval-watch/audit.ts';
import { WATCH_LIBS, expectedCopy } from '../../scripts/sync-edge-libs.mjs';
import ApprovalCalc from '../../lib/approval-calc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const edge = (f) => readFileSync(path.join(here, '../../supabase/functions/approval-watch', f), 'utf8');

describe('bản sao thư viện trong hàm', () => {
  it.each(WATCH_LIBS)('$file khớp lib/ (chạy node scripts/sync-edge-libs.mjs nếu lệch)', (lib) => {
    expect(edge(lib.file)).toBe(expectedCopy(lib));
  });
  it('nạp kiểu Deno (không có require/module) cho cùng kết quả bài tự kiểm với bản trong lib/', () => {
    const sandbox = { console };
    vm.createContext(sandbox);
    WATCH_LIBS.forEach((lib) => vm.runInContext(edge(lib.file), sandbox));
    expect(selfTest({ ApprovalCalc: sandbox.ApprovalCalc })).toEqual(selfTest({ ApprovalCalc }));
  });
});

const L = { ApprovalCalc };
const POLICY = { active: true, threshold_pct: 10, threshold_vnd: null, valid_days: 3, active_since: '2026-09-01T00:00:00Z' };
const tx = (id, o = {}) => Object.assign({ id, user_id: 'u1', type: 'buy', symbol: 'fpt', quantity: 1000, price: 100000, trade_date: '2026-10-01', created_at: '2026-10-01T03:00:00Z', deleted_at: null, import_batch: null, note: null }, o);
const NAV = [{ user_id: 'u1', snapshot_date: '2026-09-30', nav: 500e6 }, { user_id: 'u1', snapshot_date: '2026-10-05', nav: 100e6 }];
const run = (over = {}) => findUnapproved(L, Object.assign({ policy: POLICY, txns: [tx('t1')], requests: [], navRows: NAV, now: new Date('2026-10-03T00:00:00Z') }, over));

describe('findUnapproved', () => {
  it('lệnh vượt ngưỡng % NAV (NAV lấy theo ngày giao dịch, không dùng bản chụp tương lai) mà không có đề xuất -> bị gắn cờ', () => {
    const f = run();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ txn_id: 't1', symbol: 'FPT', side: 'buy', value: 100e6, nav_ref: 500e6, reasons: ['pct'], kind: 'unapproved' });
    expect(f[0].pct).toBeCloseTo(20, 9);
  });
  it('đã có đề xuất gắn lệnh (txn_id) thì không cờ', () => {
    expect(run({ requests: [{ txn_id: 't1' }] })).toEqual([]);
  });
  it('dưới ngưỡng, lệnh nhập sao kê, lệnh đã xoá, lệnh ghi trước khi bật quy định, quy định tắt: không cờ', () => {
    expect(run({ txns: [tx('t1', { quantity: 100 })] })).toEqual([]);
    expect(run({ txns: [tx('t1', { import_batch: 'b1' })] })).toEqual([]);
    expect(run({ txns: [tx('t1', { deleted_at: '2026-10-02T00:00:00Z' })] })).toEqual([]);
    expect(run({ txns: [tx('t1', { created_at: '2026-08-15T03:00:00Z' })] })).toEqual([]);
    expect(run({ policy: Object.assign({}, POLICY, { active: false }) })).toEqual([]);
    expect(run({ policy: Object.assign({}, POLICY, { active_since: null }) })).toEqual([]);
  });
  it('quá khoảng soát lại (mặc định 5 ngày) thì bỏ qua', () => {
    expect(run({ txns: [tx('t1', { created_at: '2026-09-20T03:00:00Z' })] })).toEqual([]);
    expect(run({ txns: [tx('t1', { created_at: '2026-09-20T03:00:00Z' })], lookbackDays: 30 })).toHaveLength(1);
  });
  it('ngưỡng số tiền hoạt động cả khi không có NAV tham chiếu; lệnh điều chỉnh đối soát được gắn nhãn riêng', () => {
    const f = run({ policy: { active: true, threshold_pct: null, threshold_vnd: 50e6, valid_days: 3, active_since: '2026-09-01T00:00:00Z' }, navRows: [], txns: [tx('t1', { note: 'Đối soát 30/09: điều chỉnh theo sao kê' })] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ reasons: ['vnd'], nav_ref: null, pct: null, kind: 'reconcile' });
  });
  it('chỉ so NAV với đúng người; người không có bản chụp NAV thì chỉ xét ngưỡng số tiền', () => {
    expect(run({ txns: [tx('t1', { user_id: 'u2' })] })).toEqual([]);
  });
});

describe('email', () => {
  it('đề xuất chờ duyệt: tiêu đề theo số lượng, thoát HTML trong lý do', () => {
    const one = buildPendingEmail([{ name: 'An', side: 'buy', symbol: 'FPT', quantity: 1000, price_ref: 100000, value: 100e6, order_pct: 20, reason: 'Lý do <b>x</b>' }]);
    expect(one.subject).toMatch(/mua FPT chờ bạn duyệt/);
    expect(one.html).not.toContain('<b>x</b>');
    expect(one.html).toContain('&lt;b&gt;');
    expect(one.text).toContain('An: mua FPT');
    const two = buildPendingEmail([{ name: 'An', side: 'buy', symbol: 'FPT', quantity: 1, price_ref: 1, value: 1, order_pct: null, reason: 'r' }, { name: 'Bình', side: 'sell', symbol: 'VCB', quantity: 1, price_ref: 1, value: 1, order_pct: null, reason: 'r' }]);
    expect(two.subject).toMatch(/2 đề xuất/);
  });
  it('báo lệnh không qua duyệt', () => {
    const m = buildAuditEmail([{ name: 'An', side: 'buy', symbol: 'FPT', value: 100e6, pct: 20, trade_date: '2026-10-01', kind: 'unapproved' }]);
    expect(m.subject).toMatch(/1 lệnh lớn đã ghi mà không qua duyệt/);
    expect(m.text).toContain('20% NAV');
  });
});
