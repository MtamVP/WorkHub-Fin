// lib/idea-journey.js: hành trình ý tưởng -> duyệt -> đề xuất lệnh -> ghi lệnh -> kết quả; tổng hợp quy trình của nhóm.
import { describe, it, expect } from 'vitest';
import J from '../../lib/idea-journey.js';
import IdeaFlow from '../../lib/ideas.js';

const TODAY = '2026-10-04';
const idea = (id, o = {}) => IdeaFlow.normalize(Object.assign({ id, user_id: 'u1', symbol: 'FPT', title: 'Ý tưởng ' + id, direction: 'long', status: 'in_portfolio', created_at: '2026-08-01T01:00:00Z', submitted_at: '2026-08-02T01:00:00Z', decided_at: '2026-08-05T01:00:00Z', decided_by: 'm1', entry_price: 100000, index_at_entry: 1200 }, o));
const tx = (id, o = {}) => Object.assign({ id, user_id: 'u1', type: 'buy', symbol: 'FPT', quantity: 1000, price: 100000, trade_date: '2026-08-08', deleted_at: null }, o);
const req = (id, o = {}) => Object.assign({ id, user_id: 'u1', idea_id: 'i1', symbol: 'FPT', side: 'buy', value: 100e6, status: 'executed', txn_id: 't1', created_at: '2026-08-06T01:00:00Z' }, o);
const ev = (alpha, ret = alpha) => ({ status: 'open', returnPct: ret, alphaPct: alpha, indexPct: ret - alpha, win: ret > 0, days: 60 });

describe('build: một ý tưởng', () => {
  const out = J.build({ ideas: [idea('i1')], requests: [req('r1')], txns: [tx('t1')], evals: { i1: ev(5, 10) }, today: TODAY });
  const r = out.rows[0];
  it('dựng các mốc và số ngày giữa các bước', () => {
    expect(r.path).toBe('executed');
    expect(r.inferred).toBe(false);
    expect(r.days).toMatchObject({ toDecide: 3, toRequest: 1, toExecute: 3 });
    expect(r.stages.firstExecAt).toBe('2026-08-08');
    expect(r.exec).toMatchObject({ count: 1, buyers: 1, value: 100e6 });
    expect(r.result).toMatchObject({ returnPct: 10, alphaPct: 5, win: true });
    expect(r.flags).toEqual([]);
  });
});

describe('build: các đường đi', () => {
  const ideas = [
    idea('i1'),                                                               // thực hiện qua đề xuất
    idea('i2', { symbol: 'VCB', status: 'approved', decided_at: '2026-08-10T01:00:00Z' }),  // duyệt, treo
    idea('i3', { symbol: 'HPG', status: 'rejected', decided_at: '2026-08-12T01:00:00Z' }),  // bị bác
    idea('i4', { symbol: 'SSI', status: 'review', decided_at: null, decided_by: null }),    // chưa quyết định
    idea('i5', { symbol: 'MWG', status: 'in_portfolio', decided_at: '2026-09-01T01:00:00Z' }),   // thực hiện nhưng không qua đề xuất (suy đoán)
    idea('i6', { symbol: 'VHM', direction: 'avoid', status: 'approved', decided_at: '2026-09-01T01:00:00Z' }),   // ý tưởng "tránh": không có lệnh mua
  ];
  const out = J.build({ ideas, requests: [req('r1')], txns: [tx('t1'), tx('t5', { user_id: 'u2', symbol: 'MWG', trade_date: '2026-09-05' }), tx('t0', { user_id: 'u2', symbol: 'MWG', trade_date: '2026-08-20' })], evals: {}, today: TODAY });
  const by = Object.fromEntries(out.rows.map(r => [r.id, r]));
  it('phân loại đường đi', () => {
    expect(Object.fromEntries(out.rows.map(r => [r.id, r.path]))).toEqual({ i1: 'executed', i2: 'idle', i3: 'rejected', i4: 'pending', i5: 'executed', i6: 'idle' });
  });
  it('lệnh suy đoán: chỉ lệnh mua cùng mã SAU ngày duyệt và chưa gắn đề xuất; gắn nhãn inferred', () => {
    expect(by.i5.inferred).toBe(true);
    expect(by.i5.exec.count).toBe(1);                 // t0 (20/08) trước ngày duyệt 01/09 không tính
    expect(by.i5.days.toExecute).toBe(4);
    expect(by.i1.inferred).toBe(false);
  });
  it('cờ: duyệt quá 14 ngày chưa có lệnh là treo; ý tưởng "tránh" không cần lệnh; in_portfolio mà không thấy lệnh', () => {
    expect(by.i2.flags).toContain('idle');
    expect(by.i6.flags).not.toContain('no_trade_found');
    const stuck = J.build({ ideas: [idea('i1', { status: 'approved' })], requests: [req('r9', { status: 'pending', txn_id: null, created_at: '2026-09-25T01:00:00Z' })], txns: [], evals: {}, today: TODAY }).rows[0];
    expect(stuck.flags).toContain('stuck');
    const nt = J.build({ ideas: [idea('i1')], requests: [], txns: [], evals: {}, today: TODAY }).rows[0];
    expect(nt.flags).toContain('no_trade_found');
  });
  it('lệnh đã xoá không được tính', () => {
    const o = J.build({ ideas: [idea('i1')], requests: [req('r1')], txns: [tx('t1', { deleted_at: '2026-08-09T00:00:00Z' })], evals: {}, today: TODAY }).rows[0];
    expect(o.path).toBe('idle');
  });
  it('phễu', () => {
    expect(out.summary.funnel).toMatchObject({ total: 6, approved: 4, executed: 2, rejected: 1 });
  });
});

describe('summarize: kết luận chỉ khi đủ mẫu', () => {
  const many = (prefix, n, o, alpha) => Array.from({ length: n }, (_, k) => ({ idea: idea(prefix + k, o), alpha }));
  const run = (groups) => {
    const all = groups.flat();
    const ideas = all.map(g => g.idea), evals = Object.fromEntries(all.map(g => [g.idea.id, ev(g.alpha)]));
    const executedIdeas = all.filter(g => g.exec).map(g => g.idea.id);
    const requests = executedIdeas.map((id, k) => req('rq' + k, { idea_id: id, txn_id: 'tx' + k }));
    const txns = executedIdeas.map((id, k) => tx('tx' + k));
    return J.build({ ideas, requests, txns, evals, today: TODAY }).summary;
  };
  it('ý tưởng duyệt mà để đó hơn hẳn ý tưởng đã thực hiện -> cảnh báo bỏ lỡ cơ hội', () => {
    const exec = many('e', 5, {}, 2).map(g => Object.assign(g, { exec: true }));
    const idle = many('d', 5, { status: 'approved', symbol: 'VCB' }, 9);
    const s = run([exec, idle]);
    expect(s.insights.map(i => i.text).join(' ')).toMatch(/CHƯA ai thực hiện.*bỏ lỡ/);
    expect(s.byPath.idle.avgAlpha).toBeCloseTo(9, 9);
  });
  it('người duyệt gác cổng tốt: được duyệt hơn hẳn bị bác', () => {
    const exec = many('e', 5, {}, 8).map(g => Object.assign(g, { exec: true }));
    const rej = many('r', 5, { status: 'rejected', symbol: 'HPG' }, -6);
    const s = run([exec, rej]);
    expect(s.insights.map(i => i.text).join(' ')).toMatch(/gác cổng tốt/);
  });
  it('thiếu mẫu thì không kết luận so sánh', () => {
    const exec = many('e', 2, {}, 8).map(g => Object.assign(g, { exec: true }));
    const rej = many('r', 2, { status: 'rejected', symbol: 'HPG' }, -6);
    const s = run([exec, rej]);
    expect(s.insights.map(i => i.text).join(' ')).toMatch(/Chưa đủ dữ liệu/);
    expect(s.insights.map(i => i.text).join(' ')).not.toMatch(/gác cổng/);
  });
  it('trung vị thời gian duyệt -> thực hiện; dài thì nhắc', () => {
    const exec = many('e', 3, { decided_at: '2026-07-01T01:00:00Z' }, 2).map(g => Object.assign(g, { exec: true }));   // duyệt 01/07, lệnh 08/08 -> 38 ngày
    expect(run([exec]).timing.toExecute).toBe(38);
    expect(run([exec]).insights.map(i => i.text).join(' ')).toMatch(/trung vị 38 ngày/);
  });
});
