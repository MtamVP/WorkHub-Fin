import { describe, it, expect } from 'vitest';
const J = require('../../lib/decision-journal.js');

// Đường giá mẫu: mỗi ngày 1 điểm từ 2026-01-02, giá cho trước
const mk = (start, prices) => prices.map((p, i) => [new Date(Date.parse(start + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10), p]);
const buy = (o) => J.normalize(Object.assign({ symbol: 'FPT', action: 'buy', decided_at: '2026-01-02', price_at_decision: 100, expected_price: 120, stop_price: 90, horizon_months: 6, reason: 'Tăng trưởng đều, định giá hợp lý' }, o || {}));

describe('normalize', () => {
  it('đọc dòng DB và dạng đã chuẩn hoá như nhau; mã chữ hoa; hành động lạ về "mua"', () => {
    const n = J.normalize({ id: 'x', symbol: 'fpt', action: 'zzz', decided_at: '2026-01-02T00:00:00Z', price_at_decision: '100', expected_price: 120, tags: ['a'], txn_id: 't1', review_rating: 4, lesson: 'chờ thêm' });
    expect(n).toMatchObject({ symbol: 'FPT', action: 'buy', date: '2026-01-02', price: 100, expected: 120, tags: ['a'], txnId: 't1' });
    expect(n.review).toMatchObject({ rating: 4, lesson: 'chờ thêm' });
    expect(J.normalize({}).review).toBeNull();
    expect(J.normalize(null).symbol).toBe('');
  });
});

describe('planScore: điểm kế hoạch', () => {
  it('lệnh mua đủ lý do, mục tiêu, cắt lỗ, thời hạn = 90 điểm; thêm định giá/tự tin = 100', () => {
    expect(J.planScore(buy()).score).toBe(90);
    expect(J.planScore(buy({ confidence: 4 })).score).toBe(100);
    expect(J.planScore(buy({ valuation: { fair: 120 } })).score).toBe(100);
    expect(J.planScore(buy()).complete).toBe(true);
    expect(J.planScore(buy()).missing).toEqual(['định giá hoặc mức tự tin']);
  });
  it('thiếu phần bắt buộc thì chưa "đủ"; lý do quá ngắn không tính', () => {
    const p = J.planScore(buy({ stop_price: null, reason: 'ngon' }));
    expect(p.complete).toBe(false);
    expect(p.score).toBe(25 + 10);                       // chỉ còn mục tiêu + thời hạn
    expect(p.missing).toEqual(['lý do', 'ngưỡng cắt lỗ', 'định giá hoặc mức tự tin']);
    expect(J.planScore({}).score).toBe(0);
  });
  it('bán / giữ / bỏ qua chỉ bắt buộc lý do', () => {
    const sell = J.planScore(J.normalize({ symbol: 'A', action: 'sell', reason: 'Chốt lời vì đã gần giá mục tiêu' }));
    expect(sell).toMatchObject({ score: 60, complete: true });
    expect(J.planScore(J.normalize({ symbol: 'A', action: 'skip', reason: 'Định giá đang đắt', expected_price: 50, confidence: 3 })).score).toBe(100);
    expect(J.planScore(J.normalize({ symbol: 'A', action: 'hold' })).complete).toBe(false);
  });
});

describe('evaluate: lệnh mua', () => {
  it('chạm mục tiêu: ngày đầu tiên giá đóng cửa >= mục tiêu, kèm lợi suất, đỉnh, đáy', () => {
    const e = J.evaluate(buy(), { series: mk('2026-01-02', [100, 105, 98, 121, 118]), today: '2026-01-06' });
    expect(e.status).toBe('target_hit');
    expect(e.hitDate).toBe('2026-01-05');
    expect(e.hitDays).toBe(3);
    expect(e.returnPct).toBeCloseTo(18, 6);
    expect(e.peakPct).toBeCloseTo(21, 6);
    expect(e.troughPct).toBeCloseTo(-2, 6);
    expect(e.tone).toBe('good');
  });
  it('chạm cắt lỗ trước thì là cắt lỗ; cả hai thì cái tới trước thắng', () => {
    const a = J.evaluate(buy(), { series: mk('2026-01-02', [100, 95, 89, 125]), today: '2026-01-05' });
    expect(a.status).toBe('stop_hit');
    expect(a.hitDate).toBe('2026-01-04');
    expect(a.tone).toBe('bad');
    const b = J.evaluate(buy(), { series: mk('2026-01-02', [100, 125, 85]), today: '2026-01-04' });
    expect(b.status).toBe('target_hit');
  });
  it('chưa chạm gì: đang theo dõi, có tiến độ tới mục tiêu; quá thời hạn thì hết hạn', () => {
    const open = J.evaluate(buy(), { series: mk('2026-01-02', [100, 105, 110]), today: '2026-01-04' });
    expect(open.status).toBe('open');
    expect(open.progressPct).toBeCloseTo(50, 6);
    expect(open.horizonEnd).toBe('2026-07-02');
    const late = J.evaluate(buy(), { series: mk('2026-01-02', [100, 105]).concat([['2026-08-01', 108]]), today: '2026-08-01' });
    expect(late.status).toBe('expired');
    expect(late.tone).toBe('warn');
  });
  it('không có kỳ hạn thì không bao giờ hết hạn; giá vào lấy giá đóng cửa gần ngày quyết định khi không nhập giá', () => {
    const e = J.evaluate(buy({ horizon_months: null, price_at_decision: null }), { series: mk('2026-01-02', [100, 105]).concat([['2027-06-01', 110]]), today: '2027-06-01' });
    expect(e.status).toBe('open');
    expect(e.entry).toBe(100);
  });
  it('so với VN-Index: alpha = lợi suất mã - lợi suất chỉ số cùng kỳ', () => {
    const e = J.evaluate(buy(), { series: mk('2026-01-02', [100, 110]), today: '2026-01-03', bench: mk('2026-01-02', [1000, 1050]) });
    expect(e.returnPct).toBeCloseTo(10, 6);
    expect(e.benchPct).toBeCloseTo(5, 6);
    expect(e.alphaPct).toBeCloseTo(5, 6);
  });
  it('giá hiện tại truyền riêng thay giá cuối chuỗi; thiếu giá -> nodata', () => {
    const e = J.evaluate(buy(), { series: mk('2026-01-02', [100, 105]), today: '2026-01-03', nowPrice: 130 });
    expect(e.now).toBe(130);
    expect(e.returnPct).toBeCloseTo(30, 6);
    expect(J.evaluate(buy(), { series: [], today: '2026-01-03' }).status).toBe('nodata');
    expect(J.evaluate(buy({ price_at_decision: null }), { series: mk('2026-03-01', [100]), today: '2026-03-01' }).entry).toBe(100);
    expect(J.evaluate(buy(), null).status).toBe('nodata');
  });
});

describe('evaluate: bán / bỏ qua', () => {
  const sell = J.normalize({ symbol: 'FPT', action: 'sell', decided_at: '2026-01-02', price_at_decision: 100, reason: 'Chốt lời vì đã gần mục tiêu' });
  it('bán xong giá tăng >= 10% là bán sớm; giảm >= 10% là bán đúng; còn lại trung tính', () => {
    expect(J.evaluate(sell, { series: mk('2026-01-02', [100, 115]), today: '2026-01-03' }).status).toBe('sold_early');
    expect(J.evaluate(sell, { series: mk('2026-01-02', [100, 88]), today: '2026-01-03' }).status).toBe('sold_well');
    expect(J.evaluate(sell, { series: mk('2026-01-02', [100, 104]), today: '2026-01-03' }).status).toBe('neutral');
    expect(J.evaluate(sell, { series: mk('2026-01-02', [100, 115]), today: '2026-01-03' }).afterPct).toBeCloseTo(15, 6);
  });
  it('bỏ qua: giá tăng = bỏ lỡ, giảm = né được', () => {
    const skip = J.normalize({ symbol: 'FPT', action: 'skip', decided_at: '2026-01-02', price_at_decision: 100, reason: 'Định giá đang quá đắt' });
    expect(J.evaluate(skip, { series: mk('2026-01-02', [100, 120]), today: '2026-01-03' }).status).toBe('missed');
    expect(J.evaluate(skip, { series: mk('2026-01-02', [100, 80]), today: '2026-01-03' }).status).toBe('avoided');
  });
});

describe('summarize', () => {
  it('đếm theo hành động, điểm kế hoạch trung bình, tỷ lệ đủ kế hoạch, kết quả và alpha trung bình', () => {
    const list = [buy(), buy({ stop_price: null }), J.normalize({ symbol: 'A', action: 'sell', reason: 'Chốt lời vì đã gần mục tiêu' })];
    const evals = [
      J.evaluate(list[0], { series: mk('2026-01-02', [100, 121]), today: '2026-01-03', bench: mk('2026-01-02', [1000, 1010]) }),
      J.evaluate(list[1], { series: mk('2026-01-02', [100, 80]), today: '2026-01-03' }),
      null,
    ];
    const s = J.summarize(list, evals);
    expect(s.total).toBe(3);
    expect(s.byAction).toMatchObject({ buy: 2, sell: 1 });
    expect(s.fullPlanCount).toBe(2);                              // lệnh mua thiếu cắt lỗ chưa đủ
    expect(s.fullPlanPct).toBeCloseTo(66.67, 1);
    expect(s.planAvg).toBeCloseTo((90 + 65 + 60) / 3, 6);
    expect(s.evaluated).toBe(2);
    expect(s.targetHit).toBe(1);
    expect(s.buyEvaluated).toBe(2);
    expect(s.winRatePct).toBe(50);
    expect(s.avgReturnPct).toBeCloseTo((21 - 20) / 2, 6);
    expect(s.avgAlphaPct).toBeCloseTo(20, 6);                    // chỉ lệnh có VN-Index
  });
  it('danh sách rỗng không chia cho 0; điểm đánh giá lại trung bình', () => {
    const s = J.summarize([], []);
    expect(s).toMatchObject({ total: 0, planAvg: null, fullPlanPct: null, winRatePct: null, avgReturnPct: null, avgAlphaPct: null, avgRating: null });
    const r = J.summarize([buy({ review_rating: 4, review_date: '2026-02-01' }), buy({ review_rating: 2, review_date: '2026-02-01' }), buy()], []);
    expect(r.reviewed).toBe(2);
    expect(r.avgRating).toBe(3);
  });
});

describe('gợi ý kế hoạch từ định giá', () => {
  const snap = { fair: 130, bear: 100, bull: 160 };
  it('mua: mục tiêu = giá hợp lý nếu cao hơn giá >= 3%, cắt lỗ 10% dưới giá, thời hạn 12 tháng', () => {
    expect(J.suggestPlan('buy', 100, snap)).toEqual({ expected: 130, stop: 90, horizonMonths: 12 });
  });
  it('giá đã ngang/vượt giá hợp lý: dùng kịch bản tốt; vượt cả kịch bản tốt: vẫn trả giá hợp lý', () => {
    expect(J.suggestPlan('buy', 128, snap).expected).toBe(160);
    expect(J.suggestPlan('buy', 200, snap).expected).toBe(130);
  });
  it('không có định giá: chỉ gợi ý cắt lỗ và thời hạn cho lệnh mua; bán/bỏ qua dùng giá hợp lý', () => {
    expect(J.suggestPlan('buy', 100, null)).toEqual({ expected: null, stop: 90, horizonMonths: 12 });
    expect(J.suggestPlan('sell', 100, null)).toEqual({ expected: null, stop: null, horizonMonths: null });
    expect(J.suggestPlan('skip', 100, snap)).toEqual({ expected: 130, stop: null, horizonMonths: null });
  });
  it('snapshotFrom: ảnh chụp từ kết quả định giá, null khi chưa có giá hợp lý', () => {
    const a = { v: { fair: 130.4, fairBear: 100.2, fairBull: 160.7 }, verdict: { key: 'cheap' }, m: { pe: 10.123, pb: 1.5, roe: 20.55 }, price: 100.4 };
    expect(J.snapshotFrom(a, 2025)).toEqual({ year: 2025, fair: 130, bear: 100, bull: 161, verdict: 'cheap', pe: 10.12, pb: 1.5, roe: 20.6, price: 100 });
    expect(J.snapshotFrom({ v: { fair: null } }, 2025)).toBeNull();
    expect(J.snapshotFrom(null)).toBeNull();
  });
});

describe('validate', () => {
  const ok = { symbol: 'fpt', action: 'buy', date: '2026-01-02', price: 100, quantity: 10, reason: ' Lý do dài đủ dùng ', expected: 120, stop: 90, horizonMonths: 12, confidence: 4, tags: 'Ngân hàng, dài hạn, ngân hàng' };
  it('chuẩn hoá thành dòng DB: mã chữ hoa, cắt khoảng trắng, thẻ chữ thường không trùng', () => {
    const v = J.validate(ok);
    expect(v.ok).toBe(true);
    expect(v.row).toMatchObject({ symbol: 'FPT', action: 'buy', decided_at: '2026-01-02', price_at_decision: 100, reason: 'Lý do dài đủ dùng', expected_price: 120, stop_price: 90, horizon_months: 12, confidence: 4, tags: ['ngân hàng', 'dài hạn'] });
  });
  it('trường tuỳ chọn để trống -> null', () => {
    const v = J.validate({ symbol: 'FPT', action: 'skip', date: '2026-01-02' });
    expect(v.ok).toBe(true);
    expect(v.row).toMatchObject({ price_at_decision: null, expected_price: null, stop_price: null, reason: null, horizon_months: null, tags: [] });
  });
  it.each([
    [{ symbol: 'a;b' }, /Mã/], [{ action: 'xxx' }, /hành động/], [{ date: '02/01/2026' }, /Ngày/], [{ price: -5 }, /Giá phải/],
    [{ horizonMonths: 0 }, /Thời hạn/], [{ confidence: 9 }, /tự tin/], [{ stop: 100 }, /cắt lỗ phải thấp hơn/], [{ expected: 100 }, /mục tiêu phải cao hơn/],
  ])('từ chối dữ liệu xấu %#', (patch, re) => {
    const v = J.validate(Object.assign({}, ok, patch));
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(re);
  });
  it('quy tắc mục tiêu/cắt lỗ chỉ áp dụng cho lệnh mua', () => {
    expect(J.validate({ symbol: 'FPT', action: 'sell', date: '2026-01-02', price: 100, expected: 80, stop: 120 }).ok).toBe(true);
  });
});

describe('ngày', () => {
  it('cộng tháng và đếm ngày', () => {
    expect(J.addMonths('2026-01-31', 1)).toBe('2026-03-03');   // JS tràn tháng, chấp nhận (thời hạn chỉ cần xấp xỉ)
    expect(J.addMonths('2026-01-02', 12)).toBe('2027-01-02');
    expect(J.dateDiffDays('2026-01-01', '2026-03-01')).toBe(59);
  });
});
