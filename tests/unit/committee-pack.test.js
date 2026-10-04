// lib/committee-pack.js: bộ số liệu cho hội đồng đầu tư (quản trị, căng thẳng, tóm tắt hành trình và khớp lệnh).
import { describe, it, expect } from 'vitest';
import CP from '../../lib/committee-pack.js';
import AC from '../../lib/approval-calc.js';
import RC from '../../lib/risk-calc.js';
import SC from '../../lib/stress-calc.js';
import LC from '../../lib/limits-calc.js';

const D = (d, h = 3) => d + 'T0' + h + ':00:00Z';
const req = (id, o = {}) => Object.assign({ id, user_id: 'u1', created_by: 'u1', status: 'pending', created_at: D('2026-10-01'), decided_at: null, decided_by: null, valid_until: null }, o);

describe('governance', () => {
  const base = { AC, from: '2026-10-01', to: '2026-10-31', today: '2026-10-31', policy: { active: true, thresholdPct: 10, thresholdVnd: null, validDays: 3, selfApprovers: ['u9'] }, nameOf: (id) => 'Tên ' + id };
  it('đếm đề xuất theo trạng thái hiệu lực trong kỳ (đã duyệt quá hạn tính là hết hạn), bỏ đề xuất ngoài kỳ', () => {
    const g = CP.governance(Object.assign({}, base, { requests: [
      req('a', { status: 'executed', decided_at: D('2026-10-01', 5), decided_by: 'm1' }),
      req('b', { status: 'approved', decided_at: D('2026-10-02'), decided_by: 'm1', valid_until: '2026-10-20' }),      // hết hạn
      req('c', { status: 'approved', decided_at: D('2026-10-30'), decided_by: 'm1', valid_until: '2026-11-02', created_at: D('2026-10-29') }),
      req('d', { status: 'rejected', decided_at: D('2026-10-02', 4), decided_by: 'm1' }),
      req('e'),                                                                            // đang chờ
      req('old', { created_at: D('2026-09-01') }),                                       // ngoài kỳ
    ] }));
    expect(g.requests).toMatchObject({ total: 5, pending: 1, approved: 1, executed: 1, rejected: 1, expired: 1 });
    expect(g.requests.approvalRatePct).toBeCloseTo(3 / 4 * 100, 9);                  // 3 duyệt (executed + approved + expired) / 4 đã quyết
    expect(g.requests.pendingNow).toBe(2);                                              // 'e' và 'old' còn chờ lúc này
    expect(g.requests.oldestPendingDays).toBe(60);
  });
  it('thời gian quyết định trung vị theo giờ; đếm tự duyệt (người duyệt là chủ hoặc người nhập hộ), không tính từ chối', () => {
    const g = CP.governance(Object.assign({}, base, { requests: [
      req('a', { status: 'executed', created_at: D('2026-10-01'), decided_at: D('2026-10-01', 5), decided_by: 'm1' }),   // 2 giờ
      req('b', { status: 'executed', created_at: D('2026-10-02'), decided_at: D('2026-10-02', 9), decided_by: 'u1' }),   // 6 giờ, tự duyệt
      req('c', { status: 'rejected', created_at: D('2026-10-03'), decided_at: D('2026-10-03', 4), decided_by: 'u1' }),   // 1 giờ, từ chối không tính tự duyệt
    ] }));
    expect(g.requests.medianDecideHours).toBeCloseTo(2, 9);
    expect(g.requests.selfApproved).toBe(1);
  });
  it('kiểm tra độc lập: đếm theo loại trong kỳ, số đang mở bất kể kỳ; danh sách hạn chế đang bật kèm phạm vi', () => {
    const g = CP.governance(Object.assign({}, base, {
      requests: [],
      audit: [{ kind: 'unapproved', status: 'open', detected_at: D('2026-10-05') }, { kind: 'import', status: 'reviewed', detected_at: D('2026-10-06') }, { kind: 'split', status: 'open', detected_at: D('2026-09-01') }],
      restricted: [{ symbol: 'FPT', user_id: null, reason: 'thông tin nội bộ', active: true, created_at: D('2026-09-20') }, { symbol: 'VCB', user_id: 'u2', reason: 'xung đột', active: true, created_at: D('2026-10-02') }, { symbol: 'HPG', user_id: null, reason: 'x', active: false, created_at: D('2026-10-02') }],
    }));
    expect(g.audit).toMatchObject({ inPeriod: 2, byKind: { unapproved: 1, import: 1 }, openNow: 2, reviewedInPeriod: 1 });
    expect(g.restricted.count).toBe(2);
    expect(g.restricted.items.map((x) => x.scope)).toEqual(['Mọi thành viên', 'Tên u2']);
    expect(g.policy).toMatchObject({ active: true, thresholdPct: 10, selfApprovers: 1 });
  });
  it('không có dữ liệu: các con số rỗng, không lỗi', () => {
    const g = CP.governance({ AC, from: '2026-10-01', to: '2026-10-31' });
    expect(g.requests).toMatchObject({ total: 0, medianDecideHours: null, approvalRatePct: null, oldestPendingDays: null });
    expect(g.restricted.count).toBe(0);
  });
});

describe('stress', () => {
  const risk = { ok: true, nav: 700e6, cash: 100e6, debt: 0, symbols: [{ symbol: 'VCB', sector: 'Ngân hàng', value: 400e6, betaAdj: 1 }, { symbol: 'FPT', sector: 'Công nghệ', value: 200e6, betaAdj: 1.5 }] };
  const libs = { RiskCalc: RC, StressCalc: SC, LC };
  it('2 kịch bản VN-Index và 1 kịch bản ngành lớn nhất, kèm kịch bản ngược', () => {
    const s = CP.stress(Object.assign({ risk }, libs));
    expect(s.scenarios.map((x) => x.label)).toEqual(['VN-Index -10%', 'VN-Index -20%', 'Ngành Ngân hàng -20% (ngành lớn nhất)']);
    expect(s.scenarios[0].portfolioPct).toBeCloseTo(-10, 9);                        // vb 700tr x -10% = -70tr / 700tr
    expect(s.scenarios[1].navLoss).toBeCloseTo(140e6, 3);
    expect(s.scenarios[2].worst.symbol).toBe('VCB');
    expect(s.scenarios[2].portfolioPct).toBeCloseTo(-80e6 / 700e6 * 100, 9);
    expect(s.reverse.find((x) => x.label === 'NAV mất 20%').indexPct).toBeCloseTo(-20, 9);
    expect(s.scenarios[0].hasDebt).toBe(false);
  });
  it('có nợ và giới hạn: báo vi phạm mới và chạm ký quỹ', () => {
    const lim = [{ id: 'l', scope: 'member', user_id: null, kind: 'min_cash_pct', value: 12, mode: 'block', active: true }];
    const r2 = Object.assign({}, risk, { debt: 300e6, nav: 400e6 });                  // giá trị cổ phiếu 600tr, NAV 400tr (67%)
    const s = CP.stress(Object.assign({ risk: r2, limits: lim, maintenancePct: 60 }, libs, { indexShocks: [-20] }));
    expect(s.scenarios[0].marginBreached).toBe(true);                                  // NAV sau -120tr = 280tr = 46,7% < 60%
    expect(s.scenarios[0].hasDebt).toBe(true);
    expect(s.maintenancePct).toBe(60);
  });
  it('thiếu dữ liệu rủi ro: trả null', () => {
    expect(CP.stress(Object.assign({ risk: null }, libs))).toBeNull();
    expect(CP.stress(Object.assign({ risk: { symbols: [], nav: 1 } }, libs))).toBeNull();
    expect(CP.stress({ risk })).toBeNull();
  });
});

describe('journey / execution: chỉ chọn và đặt tên', () => {
  it('journey giữ phễu, thời gian, kết quả theo đường đi và nhận xét; thiếu thì null', () => {
    expect(CP.journey(null)).toBeNull();
    const j = CP.journey({ funnel: { total: 10, decided: 8, approved: 6, executed: 4, rejected: 2, closed: 1, extra: 9 }, timing: { toDecide: 2, toExecute: 5 }, byPath: { executed: { n: 4, avgAlpha: 3.2, alphaN: 4, other: 1 } }, insights: [{ tone: 'good', text: 'x' }], minN: 4 });
    expect(j.funnel).toEqual({ total: 10, decided: 8, approved: 6, executed: 4, rejected: 2, closed: 1 });
    expect(j.timing).toEqual({ toDecide: 2, toRequest: null, toExecute: 5 });
    expect(j.paths.executed).toEqual({ n: 4, avgAlpha: 3.2, alphaN: 4 });
    expect(j.paths.idle).toEqual({ n: 0, avgAlpha: null, alphaN: 0 });
    expect(j.insights).toEqual([{ tone: 'good', text: 'x' }]);
  });
  it('execution gọn các chỉ số; thiếu thì null', () => {
    expect(CP.execution(null)).toBeNull();
    const e = CP.execution({ n: 12, value: 5e8, cost: 7e5, costPct: 0.14, vsCloseBuy: { n: 6, pct: 0.8 }, vsCloseSell: { n: 6, pct: -0.1 }, vsRef: { n: 3, pct: 1.2 }, delay: { days: 1.5 }, forwardBuy: { n: 6, pct: 2 }, forwardSell: { n: 6, pct: -1 }, insights: [] }, 6);
    expect(e).toMatchObject({ months: 6, n: 12, costPct: 0.14, delayDays: 1.5 });
    expect(e.vsCloseBuy).toEqual({ n: 6, pct: 0.8 });
  });
});
