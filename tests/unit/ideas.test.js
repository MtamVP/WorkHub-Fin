// lib/ideas.js: quy trình ý tưởng đầu tư -- kiểm tra dữ liệu, mức đầy đủ hồ sơ, ai chuyển trạng thái nào, kết quả so với VN-Index, thành tích, kiểm phiếu.
import { describe, it, expect } from 'vitest';
import F from '../../lib/ideas.js';

const THESIS = 'Doanh thu xuất khẩu phần mềm tăng đều hai chữ số, biên lợi nhuận mở rộng nhờ AI, định giá thấp hơn trung bình 5 năm.';
const RISKS = 'Tăng trưởng chậm lại nếu nhu cầu công nghệ toàn cầu suy giảm; rủi ro tỷ giá.';
const full = (o = {}) => Object.assign({ id: 'i1', user_id: 'a', symbol: 'FPT', title: 'FPT hưởng lợi từ AI', thesis: THESIS, risks: RISKS, catalysts: 'Báo cáo quý 3 và hợp đồng lớn Nhật Bản', entry_price: 100000, index_at_entry: 1200, target_price: 130000, stop_price: 90000, buy_below: 95000, horizon_months: 12, conviction: 4, status: 'idea', created_at: '2026-01-10T00:00:00Z' }, o);
const AUTHOR = { userId: 'a', isManager: false }, OTHER = { userId: 'b', isManager: false }, BOSS = { userId: 'm', isManager: true }, SELFBOSS = { userId: 'a', isManager: true };

describe('validate', () => {
  it('chấp nhận ý tưởng hợp lệ và chuẩn hoá', () => {
    const r = F.validate(full({ symbol: 'fpt' }));
    expect(r.ok).toBe(true);
    expect(r.idea).toMatchObject({ symbol: 'FPT', direction: 'long', target: 130000, stop: 90000, conviction: 4 });
  });
  it.each([
    [{ symbol: 'A;B' }, /Mã/], [{ title: 'ab' }, /tiêu đề/], [{ entry_price: -1 }, /lớn hơn 0/], [{ target_price: 90000 }, /cao hơn giá ghi nhận/], [{ stop_price: 100000 }, /thấp hơn giá ghi nhận/],
    [{ buy_below: 140000 }, /thấp hơn giá mục tiêu/], [{ horizon_months: 0 }, /Thời hạn/], [{ conviction: 9 }, /tự tin/], [{ target_price: -5 }, /lớn hơn 0/],
  ])('từ chối dữ liệu xấu %#', (o, re) => { expect(F.validate(full(o)).error).toMatch(re); });
  it('ý tưởng "tránh" không bị ràng buộc mục tiêu cao hơn giá', () => {
    expect(F.validate(full({ direction: 'avoid', target_price: 80000, stop_price: null })).ok).toBe(true);
  });
});

describe('readiness', () => {
  it('đủ hồ sơ = 100 và được phép gửi phản biện', () => {
    const r = F.readiness(full({ valuation: { fair: 120000 } }));
    expect(r.score).toBe(100); expect(r.canSubmit).toBe(true); expect(r.missing).toEqual([]);
  });
  it('thiếu phần bắt buộc (luận điểm, mục tiêu, rủi ro) thì không gửi được dù điểm cao', () => {
    const r = F.readiness(full({ thesis: 'ngắn quá', valuation: {} }));
    expect(r.canSubmit).toBe(false);
    expect(r.requiredMissing).toEqual(['luận điểm (≥ 60 ký tự)']);
    expect(F.readiness(full({ target_price: null })).requiredMissing).toContain('giá mục tiêu');
    expect(F.readiness(full({ risks: '' })).requiredMissing).toContain('rủi ro chính (≥ 20 ký tự)');
  });
  it('đủ phần bắt buộc nhưng dưới ngưỡng điểm vẫn không gửi', () => {
    const r = F.readiness(full({ stop_price: null, horizon_months: null, catalysts: '', valuation: null }));
    expect(r.requiredMissing).toEqual([]);
    expect(r.score).toBe(65);
    expect(r.canSubmit).toBe(false);
  });
});

describe('transition: ai được làm gì', () => {
  it('tác giả đưa ý tưởng đi tới nghiên cứu rồi chờ phản biện (đủ hồ sơ)', () => {
    expect(F.transition(full({ status: 'idea' }), 'research', AUTHOR).patch.status).toBe('research');
    const r = F.transition(full({ status: 'research' }), 'review', AUTHOR, { now: '2026-02-01T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.patch).toMatchObject({ status: 'review', submitted_at: '2026-02-01T00:00:00Z' });
  });
  it('thiếu hồ sơ thì không gửi phản biện, nêu rõ còn thiếu gì', () => {
    const r = F.transition(full({ status: 'research', thesis: '' }), 'review', AUTHOR);
    expect(r.ok).toBe(false); expect(r.error).toMatch(/luận điểm/);
  });
  it('người khác không chuyển được ý tưởng của người khác; không có bước tắt', () => {
    expect(F.transition(full({ status: 'idea' }), 'research', OTHER).error).toMatch(/Chỉ tác giả/);
    expect(F.transition(full({ status: 'idea' }), 'approved', AUTHOR).error).toMatch(/Không thể chuyển/);
    expect(F.transition(full({ status: 'closed' }), 'research', BOSS).ok).toBe(false);
  });
  it('chỉ quản lý duyệt/bác; bác phải có lý do; duyệt ghi người quyết và ngày', () => {
    const idea = full({ status: 'review' });
    expect(F.transition(idea, 'approved', AUTHOR).error).toMatch(/quản lý/);
    expect(F.transition(idea, 'approved', OTHER).error).toMatch(/quản lý/);
    const ok = F.transition(idea, 'approved', BOSS, { note: 'Đủ cơ sở', now: '2026-02-05T00:00:00Z' });
    expect(ok.patch).toMatchObject({ status: 'approved', decided_by: 'm', decision_note: 'Đủ cơ sở', decided_at: '2026-02-05T00:00:00Z' });
    expect(F.transition(idea, 'rejected', BOSS, { note: '' }).error).toMatch(/lý do/);
    expect(F.transition(idea, 'rejected', BOSS, { note: 'Định giá chưa hấp dẫn' }).patch.status).toBe('rejected');
  });
  it('quản lý tự duyệt ý tưởng của mình: bắt buộc ghi lý do và bị đánh dấu', () => {
    const idea = full({ status: 'review' });
    expect(F.transition(idea, 'approved', SELFBOSS, {}).error).toMatch(/Tự duyệt/);
    expect(F.transition(idea, 'approved', SELFBOSS, { note: 'Chưa có người phản biện, quản lý duy nhất' }).patch.decision_note).toMatch(/^\[Tự duyệt\]/);
  });
  it('quay lại nghiên cứu xoá kết quả duyệt/bác cũ; đã duyệt -> vào danh mục', () => {
    const r = F.transition(full({ status: 'rejected', decided_at: 'x', decided_by: 'm', decision_note: 'bác' }), 'research', AUTHOR);
    expect(r.patch).toMatchObject({ status: 'research', decided_at: null, decided_by: null, submitted_at: null });
    expect(F.transition(full({ status: 'approved' }), 'in_portfolio', AUTHOR).ok).toBe(true);
    expect(F.transition(full({ status: 'approved' }), 'in_portfolio', BOSS).ok).toBe(true);
    expect(F.transition(full({ status: 'approved' }), 'in_portfolio', OTHER).ok).toBe(false);
  });
  it('đóng ý tưởng: bắt buộc lý do hợp lệ, ghi giá và chỉ số lúc đóng', () => {
    const idea = full({ status: 'in_portfolio' });
    expect(F.transition(idea, 'closed', AUTHOR, {}).error).toMatch(/lý do đóng/);
    expect(F.transition(idea, 'closed', AUTHOR, { reason: 'xxx' }).ok).toBe(false);
    const r = F.transition(idea, 'closed', BOSS, { reason: 'target', closePrice: 131000, indexClose: 1260, note: 'Đạt mục tiêu', now: '2026-09-01T10:00:00Z' });
    expect(r.patch).toMatchObject({ status: 'closed', close_reason: 'target', close_price: 131000, index_at_close: 1260, closed_at: '2026-09-01' });
    expect(F.transition(full({ status: 'idea' }), 'closed', OTHER, { reason: 'other' }).ok).toBe(false);
  });
  it('mọi chuyển trạng thái trong bảng đều có luật rõ ràng', () => {
    Object.keys(F.TRANSITIONS).forEach(from => Object.keys(F.TRANSITIONS[from]).forEach(to => {
      expect(F.STATUSES[to]).toBeTruthy();
      expect(['author', 'manager', 'either']).toContain(F.TRANSITIONS[from][to]);
    }));
  });
});

describe('evaluate', () => {
  const idea = full({ status: 'in_portfolio' });
  it('ý tưởng mua đang mở: lợi suất, so với chỉ số, tiến độ tới mục tiêu, cờ', () => {
    const e = F.evaluate(idea, { nowPrice: 115000, indexNow: 1260, today: '2026-04-10' });
    expect(e.status).toBe('open');
    expect(e.returnPct).toBeCloseTo(15, 9); expect(e.indexPct).toBeCloseTo(5, 9); expect(e.alphaPct).toBeCloseTo(10, 9);
    expect(e.progressPct).toBeCloseTo(50, 9);
    expect(e.aboveTarget).toBe(false); expect(e.belowStop).toBe(false);
    expect(e.days).toBe(90);
    expect(e.win).toBe(true);
  });
  it('chạm mục tiêu / cắt lỗ / quá thời hạn', () => {
    expect(F.evaluate(idea, { nowPrice: 131000, today: '2026-04-10' }).aboveTarget).toBe(true);
    expect(F.evaluate(idea, { nowPrice: 89000, today: '2026-04-10' }).belowStop).toBe(true);
    expect(F.evaluate(idea, { nowPrice: 100000, today: '2027-02-01' }).overdue).toBe(true);
    expect(F.evaluate(idea, { nowPrice: 100000, today: '2026-06-01' }).overdue).toBe(false);
  });
  it('ý tưởng đã đóng dùng giá và chỉ số lúc đóng, không phụ thuộc giá hiện tại', () => {
    const closed = full({ status: 'closed', close_price: 130000, index_at_close: 1224, closed_at: '2026-07-10', close_reason: 'target' });
    const e = F.evaluate(closed, { nowPrice: 50000, indexNow: 999, today: '2026-10-01' });
    expect(e.status).toBe('closed');
    expect(e.returnPct).toBeCloseTo(30, 9); expect(e.indexPct).toBeCloseTo(2, 9); expect(e.alphaPct).toBeCloseTo(28, 9);
    expect(e.days).toBe(181);
  });
  it('ý tưởng "tránh": đúng khi giá giảm hoặc kém chỉ số', () => {
    const avoid = full({ direction: 'avoid', target_price: null, stop_price: null });
    const e = F.evaluate(avoid, { nowPrice: 90000, indexNow: 1212, today: '2026-04-10' });
    expect(e.priceReturnPct).toBeCloseTo(-10, 9);
    expect(e.returnPct).toBeCloseTo(10, 9);                 // né được 10%
    expect(e.alphaPct).toBeCloseTo(11, 9);                  // -(-10 - 1)
    expect(e.win).toBe(true);
  });
  it('thiếu giá vào hoặc giá hiện tại -> nodata; thiếu chỉ số -> chỉ có lợi suất', () => {
    expect(F.evaluate(full({ entry_price: null }), { nowPrice: 1 }).status).toBe('nodata');
    expect(F.evaluate(idea, {}).status).toBe('nodata');
    const e = F.evaluate(full({ index_at_entry: null }), { nowPrice: 110000, today: '2026-04-10' });
    expect(e.alphaPct).toBeNull(); expect(e.returnPct).toBeCloseTo(10, 9);
  });
});

describe('scoreboard / voteTally / openChallenges', () => {
  const mk = (o) => F.normalize(full(o));
  const ideas = [
    mk({ id: '1', user_id: 'a', status: 'closed', decided_at: 'x' }), mk({ id: '2', user_id: 'a', status: 'closed', decided_at: 'x' }), mk({ id: '3', user_id: 'a', status: 'rejected', decided_at: 'x' }),
    mk({ id: '4', user_id: 'a', status: 'in_portfolio', decided_at: 'x' }), mk({ id: '5', user_id: 'b', status: 'research' }),
  ];
  const evals = {
    1: { status: 'closed', returnPct: 20, alphaPct: 10, days: 100, win: true }, 2: { status: 'closed', returnPct: -10, alphaPct: -12, days: 60, win: false },
    3: { status: 'open', returnPct: 30, alphaPct: 25 }, 4: { status: 'open', returnPct: 8, alphaPct: 2 }, 5: { status: 'open', returnPct: -4, alphaPct: -6 },
  };
  it('thành tích theo tác giả: tỷ lệ duyệt, tỷ lệ thắng ý tưởng đã đóng, lợi suất/alpha trung bình, thời gian', () => {
    const s = F.scoreboard(ideas, evals, { a: 'An', b: 'Bình' });
    const a = s.find(x => x.userId === 'a'), b = s.find(x => x.userId === 'b');
    expect(s[0].userId).toBe('a');                                   // nhiều ý tưởng nhất lên đầu
    expect(a).toMatchObject({ name: 'An', total: 4, rejected: 1, closed: 2 });
    expect(a.approvalRatePct).toBeCloseTo(3 / 4 * 100, 9);          // đã quyết 4 (3 được duyệt/đi tiếp + 1 bác)
    expect(a.winRatePct).toBe(50);
    expect(a.avgClosedReturnPct).toBeCloseTo(5, 9); expect(a.avgClosedAlphaPct).toBeCloseTo(-1, 9); expect(a.avgDaysClosed).toBe(80);
    expect(a.avgOpenReturnPct).toBeCloseTo(19, 9);                  // gồm ý tưởng bị bác nhưng vẫn theo dõi (30) và đang giữ (8)
    expect(b).toMatchObject({ total: 1, open: 1, approvalRatePct: null, winRatePct: null });
  });
  it('kiểm phiếu', () => {
    const t = F.voteTally([{ vote: 'for' }, { vote: 'for' }, { vote: 'against' }, { vote: 'abstain' }, { vote: 'xxx' }]);
    expect(t).toMatchObject({ for: 2, against: 1, abstain: 1, total: 4, leaning: 'for' });
    expect(t.supportPct).toBeCloseTo(2 / 3 * 100, 9);
    expect(F.voteTally([]).leaning).toBe('none');
    expect(F.voteTally([{ vote: 'for' }, { vote: 'against' }]).leaning).toBe('split');
  });
  it('phản biện chưa được tác giả trả lời', () => {
    const c = (id, user_id, kind, t) => ({ id, user_id, kind, created_at: '2026-02-0' + t + 'T00:00:00Z' });
    const list = [c(1, 'b', 'challenge', 1), c(2, 'c', 'challenge', 2), c(3, 'a', 'answer', 3), c(4, 'b', 'comment', 4)];
    expect(F.openChallenges(list, 'a').map(x => x.id)).toEqual([2]);        // trả lời xử lý phản biện cũ nhất trước
    expect(F.openChallenges([c(1, 'a', 'answer', 1)], 'a')).toEqual([]);
    expect(F.openChallenges([c(1, 'b', 'challenge', 1), c(2, 'x', 'answer', 2)], 'a').map(x => x.id)).toEqual([1]);   // chỉ tác giả trả lời mới tính
  });
});
