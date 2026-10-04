// lib/approval-calc.js: ngưỡng cần duyệt, khớp đề xuất đã duyệt với lệnh, quy tắc hai người, hạn dùng.
import { describe, it, expect } from 'vitest';
import A from '../../lib/approval-calc.js';

const TODAY = '2026-10-04';
const req = (o = {}) => Object.assign({ id: 'r1', user_id: 'u1', symbol: 'FPT', side: 'buy', quantity: 1000, value: 100e6, status: 'approved', valid_until: '2026-10-07', decided_at: '2026-10-04T01:00:00Z', created_at: '2026-10-03T00:00:00Z' }, o);

describe('validatePolicy', () => {
  it('hợp lệ: chỉ %, chỉ số tiền, cả hai', () => {
    expect(A.validatePolicy({ active: true, thresholdPct: 10 }).policy).toEqual({ active: true, thresholdPct: 10, thresholdVnd: null, validDays: 3 });
    expect(A.validatePolicy({ active: true, thresholdVnd: 50e6, validDays: 5 }).policy.thresholdVnd).toBe(50e6);
    expect(A.validatePolicy({ active: true, thresholdPct: 10, thresholdVnd: 50e6 }).ok).toBe(true);
    expect(A.validatePolicy({ active: false }).ok).toBe(true);                       // tắt thì không cần ngưỡng
  });
  it('từ chối: bật mà không có ngưỡng, ngưỡng sai, hạn dùng sai', () => {
    expect(A.validatePolicy({ active: true }).error).toMatch(/ít nhất một ngưỡng/);
    expect(A.validatePolicy({ active: true, thresholdPct: 0 }).ok).toBe(false);
    expect(A.validatePolicy({ active: true, thresholdPct: 150 }).ok).toBe(false);
    expect(A.validatePolicy({ active: true, thresholdVnd: -1 }).ok).toBe(false);
    expect(A.validatePolicy({ active: true, thresholdPct: 10, validDays: 90 }).error).toMatch(/1 đến 30/);
  });
  it('đọc dòng DB (snake_case)', () => {
    expect(A.normalizePolicy({ active: true, threshold_pct: '10', threshold_vnd: null, valid_days: 5 })).toEqual({ active: true, thresholdPct: 10, thresholdVnd: null, validDays: 5 });
  });
});

describe('needsApproval', () => {
  const pol = { active: true, thresholdPct: 10, thresholdVnd: 200e6 };
  it('vượt ngưỡng % NAV', () => {
    const r = A.needsApproval(pol, 500e6, { quantity: 1000, price: 60000 });       // 60tr = 12%
    expect(r).toMatchObject({ needed: true, byPct: true, byVnd: false, value: 60e6 });
    expect(r.pct).toBeCloseTo(12, 9);
  });
  it('đúng bằng ngưỡng thì chưa cần duyệt; vượt số tiền tuyệt đối thì cần dù % nhỏ', () => {
    expect(A.needsApproval(pol, 500e6, { quantity: 500, price: 100000 }).needed).toBe(false);   // đúng 10%
    const big = A.needsApproval(pol, 5e9, { quantity: 3000, price: 80000 });                      // 240tr = 4,8% nhưng > 200tr
    expect(big).toMatchObject({ needed: true, byPct: false, byVnd: true });
  });
  it('tắt, hoặc không biết NAV: theo số tiền; lệnh rỗng không cần', () => {
    expect(A.needsApproval({ active: false, thresholdPct: 1 }, 100e6, { quantity: 1000, price: 100000 }).needed).toBe(false);
    expect(A.needsApproval({ active: true, thresholdPct: 10 }, 0, { quantity: 1000, price: 100000 }).needed).toBe(false);
    expect(A.needsApproval({ active: true, thresholdVnd: 1e6 }, 0, { quantity: 100, price: 100000 }).needed).toBe(true);
    expect(A.needsApproval(pol, 100e6, { quantity: 0, price: 1 }).needed).toBe(false);
  });
});

describe('effectiveStatus / summarize', () => {
  it('đã duyệt quá hạn coi là hết hạn', () => {
    expect(A.effectiveStatus(req({ valid_until: '2026-10-03' }), TODAY)).toBe('expired');
    expect(A.effectiveStatus(req({ valid_until: '2026-10-04' }), TODAY)).toBe('approved');
    expect(A.effectiveStatus(req({ status: 'executed', valid_until: '2026-01-01' }), TODAY)).toBe('executed');
  });
  it('đếm theo trạng thái hiệu lực', () => {
    const s = A.summarize([req(), req({ valid_until: '2026-10-01' }), req({ status: 'pending' }), req({ status: 'rejected' })], TODAY);
    expect(s).toMatchObject({ approved: 1, expired: 1, pending: 1, rejected: 1, total: 4 });
  });
});

describe('matchApproval', () => {
  const trade = (o = {}) => Object.assign({ symbol: 'fpt', type: 'buy', quantity: 1000, price: 100000 }, o);
  it('khớp đúng người, mã, chiều, còn hạn, đủ khối lượng; không phân biệt hoa thường', () => {
    expect(A.matchApproval([req()], 'u1', trade(), TODAY).id).toBe('r1');
    expect(A.matchApproval([req()], 'u1', trade({ quantity: 600, price: 100000 }), TODAY)).toBeTruthy();         // dùng một phần được
  });
  it('không khớp: người khác, mã khác, chiều khác, vượt khối lượng, vượt giá trị > 5%, hết hạn, chưa duyệt, đã dùng', () => {
    expect(A.matchApproval([req()], 'u2', trade(), TODAY)).toBeNull();
    expect(A.matchApproval([req()], 'u1', trade({ symbol: 'VCB' }), TODAY)).toBeNull();
    expect(A.matchApproval([req()], 'u1', trade({ type: 'sell' }), TODAY)).toBeNull();
    expect(A.matchApproval([req()], 'u1', trade({ quantity: 1001, price: 90000 }), TODAY)).toBeNull();
    expect(A.matchApproval([req()], 'u1', trade({ price: 106000 }), TODAY)).toBeNull();                     // +6% giá trị
    expect(A.matchApproval([req()], 'u1', trade({ price: 104900 }), TODAY)).toBeTruthy();                   // +4,9%: trong dung sai
    expect(A.matchApproval([req({ valid_until: '2026-10-01' })], 'u1', trade(), TODAY)).toBeNull();
    expect(A.matchApproval([req({ status: 'pending' }), req({ status: 'executed' }), req({ status: 'rejected' })], 'u1', trade(), TODAY)).toBeNull();
  });
  it('có nhiều đề xuất: dùng cái được duyệt sớm nhất', () => {
    const list = [req({ id: 'late', decided_at: '2026-10-04T05:00:00Z' }), req({ id: 'early', decided_at: '2026-10-04T01:00:00Z' })];
    expect(A.matchApproval(list, 'u1', trade(), TODAY).id).toBe('early');
  });
});

describe('canDecide: nguyên tắc hai người', () => {
  const mgr = { isManager: true, isAdmin: false, actorId: 'm1' };
  const pending = { status: 'pending', user_id: 'u1' };
  it('thành viên thường không duyệt được', () => {
    expect(A.canDecide({ isManager: false, actorId: 'u2' }, pending, 'approved', '').allowed).toBe(false);
  });
  it('quản lý duyệt lệnh của người khác', () => {
    expect(A.canDecide(mgr, pending, 'approved', '')).toMatchObject({ allowed: true, selfApproval: false });
    expect(A.canDecide(mgr, pending, 'rejected', 'Quá lớn').allowed).toBe(true);
  });
  it('từ chối phải có lý do', () => {
    expect(A.canDecide(mgr, pending, 'rejected', ' ').reason).toMatch(/lý do/);
  });
  it('quản lý không tự duyệt lệnh của chính mình', () => {
    const r = A.canDecide(mgr, { status: 'pending', user_id: 'm1' }, 'approved', 'Tôi tự duyệt vì cơ hội tốt');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/hai người/);
  });
  it('admin tự duyệt được nhưng phải ghi lý do đủ dài', () => {
    const admin = { isManager: true, isAdmin: true, actorId: 'a1' };
    const own = { status: 'pending', user_id: 'a1' };
    expect(A.canDecide(admin, own, 'approved', 'ngắn').allowed).toBe(false);
    expect(A.canDecide(admin, own, 'approved', 'Không còn quản lý nào khác trong nhóm').allowed).toBe(true);
    expect(A.canDecide(admin, own, 'approved', 'Không còn quản lý nào khác trong nhóm').selfApproval).toBe(true);
  });
  it('chỉ đề xuất đang chờ mới duyệt được', () => {
    expect(A.canDecide(mgr, { status: 'approved', user_id: 'u1' }, 'approved', '').allowed).toBe(false);
  });
});

describe('buildRequest / validUntil', () => {
  it('dựng bản ghi chuẩn hoá, tính giá trị và % NAV', () => {
    const r = A.buildRequest({ symbol: ' fpt ', side: 'buy', quantity: '1000', price: '100000', reason: 'Định giá thấp hơn giá trị hợp lý 20%' }, { nav: 1e9 });
    expect(r.ok).toBe(true);
    expect(r.row).toMatchObject({ symbol: 'FPT', side: 'buy', quantity: 1000, price_ref: 100000, value: 100e6, nav_at_request: 1e9, status: 'pending' });
    expect(r.row.order_pct).toBeCloseTo(10, 9);
  });
  it.each([
    [{ symbol: '!!', side: 'buy', quantity: 1, price: 1, reason: 'Lý do đủ dài ok' }, /Mã/],
    [{ symbol: 'FPT', side: 'x', quantity: 1, price: 1, reason: 'Lý do đủ dài ok' }, /mua hoặc bán/],
    [{ symbol: 'FPT', side: 'buy', quantity: 0, price: 1, reason: 'Lý do đủ dài ok' }, /lớn hơn 0/],
    [{ symbol: 'FPT', side: 'buy', quantity: 1, price: 1, reason: 'ngắn' }, /lý do/],
  ])('từ chối đầu vào xấu %#', (input, re) => { expect(A.buildRequest(input, { nav: 1 }).error).toMatch(re); });
  it('hạn dùng = hôm nay + số ngày, giới hạn 1-30', () => {
    expect(A.validUntil('2026-10-04', 3)).toBe('2026-10-07');
    expect(A.validUntil('2026-10-30', 3)).toBe('2026-11-02');
    expect(A.validUntil('2026-10-04', 999)).toBe('2026-11-03');
    expect(A.validUntil('2026-10-04', 0)).toBe('2026-10-07');       // 0 -> mặc định 3
  });
});
