// Theo dõi luận điểm (lib/thesis-calc.js): giá trị theo đơn vị hiển thị, đánh giá điều kiện, trạng thái luận điểm, chuyển trạng thái, gợi ý và kiểm tra form.
import { describe, it, expect } from 'vitest';
import T from '../../lib/thesis-calc.js';

const ctx = { price: 50000, targetPrice: 65000, foreignRoomLeftPct: 12.5, insiderNet90d: 300000,
  metrics: { roae: 0.24, pe: 10.9, debtToEquity: 0.45, netProfitGrowthYoY: 0.16, advValue20: 3.8e11, chg1m: -0.12 } };
const c = (o) => Object.assign({ id: 'x', metric: 'roae', op: '>=', threshold: 15, severity: 'watch' }, o || {});

describe('valueOf: đơn vị hiển thị', () => {
  it('tỷ lệ phân số đổi sang %, giá trị giao dịch sang tỷ đồng, giá giữ nguyên', () => {
    expect(T.valueOf('roae', ctx)).toBeCloseTo(24, 9); expect(T.valueOf('chg1m', ctx)).toBeCloseTo(-12, 9);
    expect(T.valueOf('advValue20', ctx)).toBeCloseTo(380, 9); expect(T.valueOf('price', ctx)).toBe(50000); expect(T.valueOf('pe', ctx)).toBeCloseTo(10.9, 9);
  });
  it('chỉ tiêu tính thêm: còn bao nhiêu % tới mục tiêu, phòng khối ngoại, nội bộ mua ròng', () => {
    expect(T.valueOf('upsideToTarget', ctx)).toBeCloseTo(30, 9); expect(T.valueOf('foreignRoomLeftPct', ctx)).toBe(12.5); expect(T.valueOf('insiderNet90d', ctx)).toBe(300000);
  });
  it('thiếu số liệu hoặc chỉ tiêu lạ -> null', () => {
    expect(T.valueOf('roae', { metrics: {} })).toBeNull(); expect(T.valueOf('upsideToTarget', { price: 100 })).toBeNull(); expect(T.valueOf('khong-co', ctx)).toBeNull(); expect(T.valueOf('roae', null)).toBeNull();
  });
});

describe('evaluate', () => {
  it('đúng / sai theo phép so sánh, kể cả biên', () => {
    expect(T.evaluate(c({ threshold: 15 }), ctx).state).toBe('ok');
    expect(T.evaluate(c({ threshold: 30 }), ctx).state).toBe('fail');
    expect(T.evaluate(c({ op: '<=', threshold: 24 }), ctx).state).toBe('ok');
    expect(T.evaluate(c({ op: '<', threshold: 24 }), ctx).state).toBe('fail');
    expect(T.evaluate(c({ op: '>', threshold: 24 }), ctx).state).toBe('fail');
  });
  it('thiếu số liệu là unknown (không bị coi là đúng hay sai); điều kiện chưa đủ cũng vậy', () => {
    expect(T.evaluate(c({ metric: 'pb' }), ctx)).toMatchObject({ state: 'unknown', value: null });
    expect(T.evaluate(c({ threshold: null }), ctx).state).toBe('unknown'); expect(T.evaluate(c({ op: '=' }), ctx).state).toBe('unknown');
  });
  it('điều kiện thủ công theo người dùng xác nhận', () => {
    const m = { metric: 'manual', severity: 'critical' };
    expect(T.evaluate(Object.assign({ manualMet: true }, m), ctx).state).toBe('ok'); expect(T.evaluate(Object.assign({ manualMet: false }, m), ctx).state).toBe('fail'); expect(T.evaluate(Object.assign({ manualMet: null }, m), ctx).state).toBe('unknown');
  });
});

describe('evaluateIdea: trạng thái luận điểm', () => {
  const ok1 = c({ id: 'a', threshold: 15 }), ok2 = c({ id: 'b', metric: 'debtToEquity', op: '<=', threshold: 1, severity: 'critical' });
  const watchFail = c({ id: 'w', metric: 'netProfitGrowthYoY', threshold: 30, severity: 'watch' }), critFail = c({ id: 'k', metric: 'price', op: '>=', threshold: 55000, severity: 'critical' });
  const unk = c({ id: 'u', metric: 'pb', threshold: 3 });
  it('còn nguyên khi mọi điều kiện đã biết đều đúng (điều kiện chưa có số liệu không làm hỏng)', () => {
    const r = T.evaluateIdea([ok1, ok2, unk], ctx);
    expect(r.status).toBe('intact'); expect(r.counts).toMatchObject({ ok: 2, fail: 0, unknown: 1 }); expect(r.score).toBe(1);
  });
  it('cảnh báo khi chỉ điều kiện watch sai; phá vỡ khi điều kiện critical sai (ưu tiên hơn)', () => {
    expect(T.evaluateIdea([ok1, watchFail], ctx).status).toBe('warning');
    const b = T.evaluateIdea([ok1, watchFail, critFail], ctx);
    expect(b.status).toBe('broken'); expect(b.counts).toMatchObject({ criticalFail: 1, watchFail: 1 }); expect(b.score).toBeCloseTo(1 / 3, 9);
  });
  it('không điều kiện nào có số liệu -> unknown; không có điều kiện -> none', () => {
    expect(T.evaluateIdea([unk], ctx).status).toBe('unknown'); expect(T.evaluateIdea([], ctx).status).toBe('none'); expect(T.evaluateIdea(null, ctx).score).toBeNull();
  });
  it('giữ nguyên các trường của điều kiện và thêm state, value', () => {
    const r = T.evaluateIdea([ok1], ctx).conditions[0];
    expect(r).toMatchObject({ id: 'a', metric: 'roae', state: 'ok' }); expect(r.value).toBeCloseTo(24, 9);
  });
});

describe('transitions', () => {
  it('chỉ báo khi đổi giữa đúng và sai; unknown không tính; lần đầu có kết quả tính là chuyển từ unknown', () => {
    const next = [{ id: 'a', state: 'fail' }, { id: 'b', state: 'ok' }, { id: 'c', state: 'unknown' }, { id: 'd', state: 'ok' }];
    const t = T.transitions({ a: 'ok', b: 'ok', c: 'ok' }, next);
    expect(t.map((x) => x.id + ':' + x.from + '>' + x.to)).toEqual(['a:ok>fail', 'd:unknown>ok']);
    expect(T.transitions([{ id: 'a', state: 'fail' }], [{ id: 'a', state: 'fail' }])).toEqual([]);
  });
});

describe('describe / suggest / validate', () => {
  it('mô tả điều kiện bằng chữ có đơn vị', () => {
    expect(T.describe(c({ threshold: 15 }))).toBe('ROE ≥ 15%'); expect(T.describe(c({ metric: 'debtToEquity', op: '<=', threshold: 1.5 }))).toBe('Nợ / vốn chủ ≤ 1,5x');
    expect(T.describe(c({ metric: 'price', threshold: 50000, label: 'Giá cắt lỗ' }))).toBe('Giá cắt lỗ (Giá ≥ 50.000 đ)'); expect(T.describe({ metric: 'manual', label: 'Được cấp phép dự án X' })).toBe('Được cấp phép dự án X');
  });
  it('gợi ý có giá cắt lỗ là điều kiện critical, ngưỡng quanh số liệu hiện tại; không có số liệu thì không gợi ý chỉ tiêu đó', () => {
    const s = T.suggest({ stop: 45000, target: 65000 }, ctx);
    expect(s.find((x) => x.metric === 'price')).toMatchObject({ op: '>=', threshold: 45000, severity: 'critical' });
    expect(s.find((x) => x.metric === 'roae').threshold).toBeCloseTo(19.2, 9); expect(s.find((x) => x.metric === 'debtToEquity')).toMatchObject({ op: '<=', severity: 'critical' });
    expect(T.suggest({}, { metrics: {} })).toEqual([]);
    expect(T.suggest({ stop: 45000 }, { metrics: {} }).map((x) => x.metric)).toEqual(['price']);
  });
  it('mọi gợi ý đều vượt qua kiểm tra form', () => {
    T.suggest({ stop: 45000, target: 65000 }, ctx).forEach((s) => expect(T.validate(s).ok).toBe(true));
  });
  it('kiểm tra form: ngưỡng phải là số, phải chọn chỉ tiêu và phép so sánh, thủ công cần mô tả', () => {
    expect(T.validate({ metric: 'roae', op: '>=', threshold: '15' })).toMatchObject({ ok: true, cond: { threshold: 15, severity: 'watch' } });
    expect(T.validate({ metric: 'roae', op: '>=', threshold: 'abc' }).ok).toBe(false); expect(T.validate({ metric: 'zzz' }).ok).toBe(false); expect(T.validate({ metric: 'roae', op: '=', threshold: 1 }).ok).toBe(false);
    expect(T.validate({ metric: 'manual', label: 'ab' }).ok).toBe(false); expect(T.validate({ metric: 'manual', label: 'Có giấy phép', severity: 'critical', manualMet: true }).cond).toMatchObject({ severity: 'critical', manualMet: true });
  });
});
