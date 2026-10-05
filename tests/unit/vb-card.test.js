// stocksheet/vb-card.js: thẻ + huy hiệu "Định giá chuyên môn" ở Investment Workbench (chỉ đọc bản đã lưu, so với giá hiện tại).
import { describe, it, expect } from 'vitest';
import VBCard from '../../stocksheet/vb-card.js';

const NOW = new Date('2026-10-05T03:00:00Z');
const REC = {
  symbol: 'FPT', as_of: '2026-09-20', price: 70500, form: 'NON_FINANCE', fair_low: 62000, fair_base: 88000, fair_high: 115000, grade: 'Rẻ so với giá trị ước tính',
  stance: 'Rẻ nhưng giá chưa xác nhận', confidence: 'Vừa', tech_score: -35, tech_rating: 'Xu hướng giảm', timing: 'Bối cảnh giá bất lợi', market_score: 8, composite: 21,
  accumulate_low: 56000, accumulate_high: 70400, invalidation: 54000, author: 'Bình', note: '<b>ghi chú</b>',
  summary: { reasons: ['Dòng tiền tốt'], flags: ['Nợ tăng'] },
};

describe('marginNow / zoneNow', () => {
  it('biên an toàn tính theo giá HIỆN TẠI, không phải giá lúc lưu', () => {
    expect(VBCard.marginNow(REC, 66000)).toBeCloseTo((88000 - 66000) / 88000, 9);
    expect(VBCard.marginNow(REC, null)).toBeCloseTo((88000 - 70500) / 88000, 9);
    expect(VBCard.marginNow({ fair_base: 0, price: 1 }, 5)).toBeNull();
    expect(VBCard.marginNow(null, 5)).toBeNull();
  });
  it('xếp giá hiện tại vào đúng vùng', () => {
    expect(VBCard.zoneNow(REC, 57000).key).toBe('accumulate');
    expect(VBCard.zoneNow(REC, 57000).cls).toBe('ok');
    expect(VBCard.zoneNow(REC, 57999).key).toBe('accumulate');
    expect(VBCard.zoneNow(REC, 53000).key).toBe('below-invalidation');
    expect(VBCard.zoneNow(REC, 80000).key).toBe('fair');
    expect(VBCard.zoneNow(REC, 130000).key).toBe('above');
    expect(VBCard.zoneNow(null, 80000)).toBeNull();
  });
});

describe('view: độ cũ', () => {
  it('quá 45 ngày thì đánh dấu cũ', () => {
    expect(VBCard.view(REC, 70000, NOW).age).toBe(15);
    expect(VBCard.view(REC, 70000, NOW).stale).toBe(false);
    const old = Object.assign({}, REC, { as_of: '2026-07-01' });
    expect(VBCard.view(old, 70000, NOW).stale).toBe(true);
  });
  it('không có bản ghi -> null', () => { expect(VBCard.view(null, 1, NOW)).toBeNull(); });
});

describe('badge', () => {
  it('trống khi chưa có bản định giá', () => { expect(VBCard.badge(null, 1, NOW)).toBe(''); });
  it('có giá hợp lý, biên an toàn và liên kết sang Valuation Bench', () => {
    const h = VBCard.badge(REC, 60000, NOW);
    expect(h).toContain('88.000'); expect(h).toContain('+31,8%'); expect(h).toContain('href="/valuation/#stock/FPT"'); expect(h).toContain('vbc-ok');
  });
  it('giá trên giá trị hợp lý -> tông cảnh báo, biên âm', () => {
    const h = VBCard.badge(REC, 100000, NOW);
    expect(h).toContain('vbc-warn'); expect(h).toContain('−13,6%');
  });
  it('bản cũ có lớp stale', () => { expect(VBCard.badge(Object.assign({}, REC, { as_of: '2026-01-01' }), 70000, NOW)).toContain('stale'); });
  it('escape ký tự đặc biệt trong mã và nhận định', () => {
    const h = VBCard.badge(Object.assign({}, REC, { symbol: 'A"B', stance: '<img onerror=x>' }), 70000, NOW);
    expect(h).not.toContain('<img'); expect(h).toContain('A%22B');
  });
});

describe('html', () => {
  it('trạng thái đang tải và lỗi', () => {
    expect(VBCard.html(null, 1, NOW, { loading: true })).toContain('fa-spin');
    const e = VBCard.html(null, 1, NOW, { error: '<x>' });
    expect(e).toContain('Không đọc được'); expect(e).not.toContain('<x>');
  });
  it('chưa có bản ghi: mời mở Valuation Bench', () => {
    const h = VBCard.html(null, 1, NOW, { symbol: 'VNM' });
    expect(h).toContain('Chưa có định giá chuyên môn'); expect(h).toContain('/valuation/#stock/VNM');
  });
  it('thẻ đầy đủ: giá hợp lý, khoảng, vùng, nhận định, lý do, cờ, người lập, ghi chú đã escape', () => {
    const h = VBCard.html(REC, 66000, NOW, {});
    expect(h).toContain('88.000'); expect(h).toContain('62.000 – 115.000'); expect(h).toContain('56.000 – 70.400'); expect(h).toContain('54.000');
    expect(h).toContain('Trong vùng tích luỹ'); expect(h).toContain('Rẻ nhưng giá chưa xác nhận'); expect(h).toContain('Dòng tiền tốt'); expect(h).toContain('Nợ tăng');
    expect(h).toContain('Bình'); expect(h).toContain('+25%'); expect(h).toContain('vbc-up');
    expect(h).toContain('&lt;b&gt;ghi chú'); expect(h).not.toContain('<b>ghi chú');
    expect(h).not.toContain('đã cũ');
  });
  it('bản cũ: có cảnh báo làm mới', () => {
    const h = VBCard.html(Object.assign({}, REC, { as_of: '2026-06-01' }), 66000, NOW, {});
    expect(h).toContain('đã cũ'); expect(h).toContain('định giá lại');
  });
  it('thiếu trường không làm vỡ thẻ', () => {
    const h = VBCard.html({ symbol: 'X', fair_base: 100 }, null, NOW, {});
    expect(h).toContain('vbc-card'); expect(h).toContain('—');
  });
});
