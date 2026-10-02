// Logic thuần của Edge Function send-price-alerts (email cảnh báo giá khi app tắt).
import { describe, it, expect } from 'vitest';
import {
  heldQuantities, valuationTarget, isStalePrice, evaluateAlerts, buildEmail, escapeHtml, vnDate
} from '../../supabase/functions/send-price-alerts/logic.ts';

const NOW = new Date('2026-10-01T07:00:00Z'); // 14:00 giờ VN, ngày 2026-10-01
const tx = (user_id, symbol, type, quantity, trade_date, created_at = trade_date + 'T01:00:00Z') => ({ user_id, symbol, type, quantity, trade_date, created_at });

describe('vnDate', () => {
  it('đổi sang ngày giờ Việt Nam (UTC+7)', () => {
    expect(vnDate(new Date('2026-09-30T18:00:00Z'))).toBe('2026-10-01'); // 01:00 sáng VN
    expect(vnDate(new Date('2026-09-30T16:59:00Z'))).toBe('2026-09-30');
  });
});

describe('heldQuantities', () => {
  it('mua trừ bán, không âm, tách theo user', () => {
    const h = heldQuantities([tx('u1', 'AAA', 'buy', 100, '2026-01-01'), tx('u1', 'AAA', 'sell', 30, '2026-02-01'), tx('u2', 'AAA', 'buy', 5, '2026-01-01'), tx('u1', 'BBB', 'buy', 10, '2026-01-01'), tx('u1', 'BBB', 'sell', 50, '2026-02-01')], []);
    expect(h.get('u1').get('AAA')).toBe(70);
    expect(h.get('u2').get('AAA')).toBe(5);
    expect(h.get('u1').get('BBB')).toBe(0);
  });
  it('tách/gộp và cổ tức cổ phiếu nhân khối lượng theo đúng thứ tự thời gian', () => {
    const h = heldQuantities(
      [tx('u1', 'AAA', 'buy', 100, '2026-01-01'), tx('u1', 'AAA', 'sell', 100, '2026-03-01')],
      [{ user_id: 'u1', symbol: 'AAA', action_type: 'stock_dividend', ratio: 0.1, ex_date: '2026-02-01', created_at: '2026-02-01T00:00:00Z' }]
    );
    expect(h.get('u1').get('AAA')).toBeCloseTo(10, 9); // 110 sau thưởng, bán 100 -> còn 10 cổ phiếu thưởng
  });
  it('hành động doanh nghiệp trước khi có cổ phiếu thì bỏ qua', () => {
    const h = heldQuantities([tx('u1', 'AAA', 'buy', 100, '2026-03-01')], [{ user_id: 'u1', symbol: 'AAA', action_type: 'split', ratio: 2, ex_date: '2026-01-01', created_at: '2026-01-01T00:00:00Z' }]);
    expect(h.get('u1').get('AAA')).toBe(100);
  });
});

describe('valuationTarget', () => {
  it('trung bình giá P/E và P/B; khớp công thức phía app', () => {
    expect(valuationTarget({ v1: 1000, v2: 2000, v3: 150, targetPE: 12, targetPB: 1.2 })).toBe(21000);
    expect(valuationTarget({ v1: 1000, v2: 2000, v3: 150, targetPE: 12 })).toBe(18000);
    expect(valuationTarget({})).toBeNull();
    expect(valuationTarget(null)).toBeNull();
  });
  it('ưu tiên fair_value của hồ sơ mới; đọc được hồ sơ cũ chỉ có snake_case', () => {
    expect(valuationTarget({ fair_value: 33000, v1: 1000, v2: 2000, v3: 150, targetPE: 12, targetPB: 1.2 })).toBe(33000);
    expect(valuationTarget({ charter_capital: 1000, equity: 2000, lnst: 150, target_pe: 12, target_pb: 1.2 })).toBe(21000);
    expect(valuationTarget({ fair_value: 0, v1: 1000, v2: 2000, v3: 150, targetPE: 12 })).toBe(18000);
  });
});

describe('isStalePrice', () => {
  it('giá tự động: cũ khi quá 4 ngày', () => {
    expect(isStalePrice({ price_date: '2026-09-28', updated_at: null, locked: false }, NOW)).toBe(false); // 3 ngày
    expect(isStalePrice({ price_date: '2026-09-26', updated_at: null, locked: false }, NOW)).toBe(true);  // 5 ngày
  });
  it('giá nhập tay: cũ khi quá 7 ngày và chưa khóa; khóa thì không', () => {
    expect(isStalePrice({ price_date: null, updated_at: '2026-09-20T00:00:00Z', locked: false }, NOW)).toBe(true);
    expect(isStalePrice({ price_date: null, updated_at: '2026-09-20T00:00:00Z', locked: true }, NOW)).toBe(false);
    expect(isStalePrice({ price_date: null, updated_at: '2026-09-28T00:00:00Z', locked: false }, NOW)).toBe(false);
  });
});

describe('evaluateAlerts', () => {
  const row = (o) => ({ user_id: 'u1', symbol: 'AAA', market_price: 100, locked: false, target_price: null, stop_loss: null, price_date: '2026-10-01', updated_at: null, ...o });
  const held = new Map([['AAA', 10], ['BBB', 10], ['CCC', 0]]);
  it('chạm mục tiêu thủ công và cắt lỗ', () => {
    expect(evaluateAlerts([row({ target_price: 100 })], held, new Map(), NOW)).toEqual([{ symbol: 'AAA', kind: 'target', threshold: 100, price: 100 }]);
    expect(evaluateAlerts([row({ stop_loss: 105 })], held, new Map(), NOW)).toEqual([{ symbol: 'AAA', kind: 'stop', threshold: 105, price: 100 }]);
    expect(evaluateAlerts([row({ target_price: 150, stop_loss: 90 })], held, new Map(), NOW)).toEqual([]);
  });
  it('dùng giá mục tiêu từ định giá khi không nhập tay; nhập tay thắng', () => {
    expect(evaluateAlerts([row({})], held, new Map([['AAA', 99.6]]), NOW)).toEqual([{ symbol: 'AAA', kind: 'target', threshold: 100, price: 100 }]);
    expect(evaluateAlerts([row({ target_price: 200 })], held, new Map([['AAA', 50]]), NOW)).toEqual([]);
  });
  it('bỏ qua mã không còn giữ, chưa có giá, hoặc giá đã cũ', () => {
    expect(evaluateAlerts([row({ symbol: 'CCC', target_price: 1 })], held, new Map(), NOW)).toEqual([]);
    expect(evaluateAlerts([row({ symbol: 'ZZZ', target_price: 1 })], held, new Map(), NOW)).toEqual([]);
    expect(evaluateAlerts([row({ market_price: 0, target_price: 1 })], held, new Map(), NOW)).toEqual([]);
    expect(evaluateAlerts([row({ target_price: 1, price_date: '2026-09-20' })], held, new Map(), NOW)).toEqual([]);
  });
});

describe('buildEmail', () => {
  it('chủ đề 1 cảnh báo vs nhiều cảnh báo; escape HTML', () => {
    const one = buildEmail([{ symbol: 'FPT', kind: 'target', threshold: 150000, price: 151000 }], 'Phúc');
    expect(one.subject).toBe('WorkHub: FPT chạm giá mục tiêu');
    expect(one.text).toContain('Chào Phúc,');
    expect(one.text).toContain('151.000');
    const many = buildEmail([{ symbol: 'FPT', kind: 'target', threshold: 1, price: 2 }, { symbol: 'HPG', kind: 'stop', threshold: 3, price: 2 }], null);
    expect(many.subject).toContain('2 cảnh báo giá');
    expect(many.subject).toContain('HPG chạm ngưỡng cắt lỗ');
    const xss = buildEmail([{ symbol: '<b>X</b>', kind: 'stop', threshold: 1, price: 1 }], '<script>');
    expect(xss.html).not.toContain('<script>');
    expect(xss.html).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(escapeHtml('a&"\'')).toBe('a&amp;&quot;&#39;');
  });
});
