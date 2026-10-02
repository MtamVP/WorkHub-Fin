import { describe, it, expect, beforeAll } from 'vitest';

let VC, VU;
beforeAll(() => {
  VC = require('../../lib/valuation-calc.js');
  globalThis.ValuationCalc = VC; // valuation-ui.js dùng ValuationCalc như biến toàn cục (như trong trình duyệt)
  VU = require('../../stocksheet/valuation-ui.js');
});

const base = { symbol: 'FPT', year: 2026, v1: 1000, v2: 2000, v3: 150, v6: 15000, targetPE: 12, targetPB: 1.2 };

describe('định dạng số', () => {
  it('kiểu Việt Nam: chấm ngàn, phẩy thập phân; thiếu dữ liệu là gạch ngang', () => {
    expect(VU.vnd(1234567.4)).toBe('1.234.567');
    expect(VU.dec(12.345, 2)).toBe('12,35');
    expect(VU.dec(12, 2)).toBe('12');
    expect(VU.mult(12.34)).toBe('12,3x');
    expect(VU.pct(5, 1, true)).toBe('+5%');
    expect(VU.pct(-3.25, 1, true)).toBe('-3,3%');
    ['vnd', 'dec', 'mult', 'pct'].forEach(fn => expect(VU[fn](null)).toBe('—'));
    expect(VU.vnd('abc')).toBe('—');
    expect(VU.vnd(0)).toBe('0');
  });
  it('lớp màu theo dấu', () => {
    expect(VU.signedClass(1)).toBe('pnl-up');
    expect(VU.signedClass(-1)).toBe('pnl-down');
    expect(VU.signedClass(0)).toBe('pnl-flat');
    expect(VU.signedClass(null)).toBe('pnl-flat');
  });
});

describe('escape HTML', () => {
  it('chặn chèn thẻ/thuộc tính qua mã, ghi chú, luận điểm', () => {
    expect(VU.esc('<img src=x onerror="a()">&\'')).toBe('&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
    expect(VU.esc(null)).toBe('');
    const a = VC.analyze(base);
    const html = VU.heroHtml({ symbol: '<script>alert(1)</script>', meta: ['<b>x</b>'], priceNote: '"><i>', a });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('kết luận', () => {
  it('nhãn có biểu tượng + chữ, không chỉ màu', () => {
    const cheap = VU.verdictPill(VC.verdict(70, 100, 60, 130));
    expect(cheap).toContain('vl-pill-cheap');
    expect(cheap).toContain('Rẻ');
    expect(cheap).toContain('fa-tag');
    expect(VU.verdictPill(null)).toContain('Chưa đủ dữ liệu');
  });
  it('câu kết luận nói rõ hướng, độ lệch và vùng kịch bản', () => {
    const below = VU.verdictSentence(VC.verdict(60, 100, 70, 130), 100, 60);
    expect(below).toContain('thấp hơn giá hợp lý khoảng 40%');
    expect(below).toContain('+67%');
    expect(below).toContain('thấp hơn cả kịch bản xấu');
    const above = VU.verdictSentence(VC.verdict(150, 100, 70, 130), 100, 150);
    expect(above).toContain('cao hơn giá hợp lý khoảng 50%');
    expect(above).toContain('cao hơn cả kịch bản tốt');
    expect(VU.verdictSentence(VC.verdict(0, 0), 0, 0)).toContain('Cần giá hiện tại');
  });
});

describe('khối dựng HTML', () => {
  it('hero: giá hợp lý, nhãn kết luận, thanh khoảng khi có giá hợp lý', () => {
    const a = VC.analyze(base);
    const html = VU.heroHtml({ symbol: 'FPT', meta: ['Năm 2026', ''], priceNote: 'Giá lưu', a });
    expect(html).toContain('21.000');
    expect(html).toContain('vl-pill-cheap');
    expect(html).toContain('vl-range');
    expect(html).toContain('Năm 2026');
    const none = VU.heroHtml({ symbol: 'X', a: VC.analyze({ v1: 1000, v2: 2000, v3: 150, v6: 15000 }) });
    expect(none).not.toContain('vl-range');
    expect(none).toContain('Chưa đủ dữ liệu');
  });
  it('football: không có khoảng -> thông báo; có khoảng -> thanh, vạch cơ sở, vạch giá và chú thích', () => {
    expect(VU.footballHtml(null, 100)).toContain('vl-empty');
    const a = VC.analyze(base);
    const ff = VC.football(a.v.methods.map(x => ({ label: x.label, low: x.bear, base: x.base, high: x.bull, kind: 'method', note: x.note })), a.price);
    const html = VU.footballHtml(ff, a.price);
    expect(html).toContain('vl-ff-bar-method');
    expect(html).toContain('vl-ff-base');
    expect(html).toContain('vl-ff-price');
    expect(html).toContain('Giá 15.000');
    expect(html).toContain('P/E');
    expect(html).toContain('P/B');
  });
  it('bảng kịch bản: % so với giá, dòng gộp và tỷ trọng', () => {
    const a = VC.analyze(base);
    const html = VU.scenarioTableHtml(a.v, a.price);
    expect(html).toContain('50%');
    expect(html).toContain('Giá hợp lý (gộp)');
    expect(html).toContain('+40%');           // (21.000 - 15.000) / 15.000
    expect(VU.scenarioTableHtml({ methods: [] }, 100)).toContain('vl-empty');
    expect(VU.scenarioTableHtml(null, 100)).toContain('vl-empty');
  });
  it('dòng chỉ số + nhãn tăng trưởng', () => {
    expect(VU.metricRow('ROE', '26%', 'sub', 'gợi ý')).toContain('title="gợi ý"');
    expect(VU.metricRow('ROE', '26%')).not.toContain('vl-metric-sub');
    expect(VU.growthTag(12.3, 'so năm trước')).toContain('pnl-up');
    expect(VU.growthTag(-1)).toContain('fa-arrow-down');
    expect(VU.growthTag(null)).toBe('');
  });
  it('ghi chú dữ liệu: nói rõ cách tính EPS/ROE và hồ sơ cũ', () => {
    const n = VC.normalize({ charter_capital: 1000, equity: 2000, lnst: -10, price: 10 });
    const notes = VU.dataNotes(n, VC.metrics(n)).join(' ');
    expect(notes).toContain('vốn điều lệ');
    expect(notes).toContain('đang lỗ');
    expect(notes).toContain('ROE tính trên vốn chủ cuối kỳ');
    expect(notes).toContain('phiên bản cũ');
  });
  it('danh sách ngành đủ mẫu', () => {
    const opts = VU.SECTOR_OPTIONS();
    expect(opts.map(o => o.value)).toEqual(Object.keys(VC.SECTORS));
    expect(opts.every(o => o.label)).toBe(true);
  });
});
