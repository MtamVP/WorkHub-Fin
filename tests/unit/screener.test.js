// lib/screener.js: bộ lọc tìm mã trên bảng định giá đã có (tiêu chí, thiếu dữ liệu, trung vị ngành, điểm xếp hạng, gần đạt, rổ mã).
import { describe, it, expect } from 'vitest';
const VC = require('../../lib/valuation-calc.js');
const S = require('../../lib/screener.js');

// Mỗi hồ sơ: vốn điều lệ 1.000 (=> 100 triệu cổ phiếu theo mệnh giá 10.000), nên EPS = LNST/100*... xem công thức perShare: eps = lnst / charter * 10000
// Ví dụ lnst 150, charter 1000 => EPS 1.500. Giá 15.000 => P/E 10.
function item(symbol, o = {}) {
  const data = Object.assign({ symbol, year: 2026, v1: 1000, v2: 2000, v3: 150, v6: 15000, targetPE: 12, targetPB: 1.2, sector: 'general' }, o.data || {});
  const prev = o.prev ? VC.normalize(Object.assign({ symbol, year: 2025, v1: 1000, v2: 1800, v3: 120 }, o.prev)) : null;
  const a = VC.analyze(data, { prev, price: o.price });
  return { symbol, year: 2026, held: !!o.held, watched: !!o.watched, data, a };
}

const ITEMS = [
  item('AAA', { data: { v3: 200, v6: 12000 }, prev: { v3: 150 }, held: true }),                      // P/E 6, ROE cao, rẻ
  item('BBB', { data: { v3: 150, v6: 30000 } }),                                                      // P/E 20 đắt hơn
  item('CCC', { data: { v3: 60, v6: 9000 } }),                                                        // ROE thấp
  item('DDD', { data: { v3: -30, v6: 8000 } }),                                                       // đang lỗ
  item('EEE', { data: { v3: 150, v6: 15000, targetPE: '', targetPB: '' } }),                          // chưa đặt mục tiêu -> không có tiềm năng
  item('FFF', { data: { v3: 180, v6: 14000, dps: 1200 }, watched: true }),                            // cổ tức
];
const ROWS = S.rowsFrom(ITEMS);
const row = (s) => ROWS.find(r => r.symbol === s);
const ids = (res) => res.passed.map(e => e.row.symbol);

describe('rowsFrom', () => {
  it('lấy đúng chỉ số từ phân tích; thiếu dữ liệu là null (không phải 0)', () => {
    const a = row('AAA');
    expect(a.pe).toBeCloseTo(6, 6);
    expect(a.roe).toBeGreaterThan(5);
    expect(a.held).toBe(true);
    expect(a.sectorLabel).toBe('Chung');
    expect(row('DDD').pe).toBeNull();
    expect(row('DDD').lossMaking).toBe(true);
    expect(row('EEE').upside).toBeNull();           // chưa đặt P/E, P/B mục tiêu -> chưa có giá hợp lý
    expect(row('EEE').verdict).toBe('none');
  });
  it('P/E so với trung vị cùng ngành (cần ≥ 3 mã có P/E)', () => {
    // P/E 5 mã: AAA 6, FFF ~7,8, EEE 10, CCC 15, BBB 20 -> trung vị 10
    expect(row('AAA').peerPe).toBeCloseTo(10, 6);
    expect(row('AAA').peDiscount).toBeCloseTo(40, 6);
    expect(row('BBB').peDiscount).toBeCloseTo(-100, 6);   // đắt gấp đôi trung vị ngành
    // chỉ có 2 mã cùng ngành -> không so sánh
    const two = S.rowsFrom([item('X1', { data: { sector: 'bank' } }), item('X2', { data: { sector: 'bank' } })]);
    expect(two.every(r => r.peDiscount === null)).toBe(true);
  });
});

describe('evaluate: tiêu chí', () => {
  it('không bật tiêu chí nào: mọi mã (trừ mã đang lỗ do mặc định loại lỗ) đều đạt', () => {
    const r = S.evaluate(ROWS, {});
    expect(ids(r).sort()).toEqual(['AAA', 'BBB', 'CCC', 'EEE', 'FFF']);
    expect(r.stats.active).toBe(0);
  });
  it('P/E tối đa và ROE tối thiểu: bắt cả hai điều kiện', () => {
    const r = S.evaluate(ROWS, { values: { pe: 12, roe: 5 } });
    // AAA (P/E 6), FFF (7,8), EEE (10) đều có P/E <= 12 và ROE >= 5; BBB (P/E 20) và CCC (P/E 15) bị loại
    expect(ids(r).sort()).toEqual(['AAA', 'EEE', 'FFF']);
    const tight = S.evaluate(ROWS, { values: { pe: 12, roe: 10 } });
    expect(ids(tight)).toEqual(['AAA']);               // ROE: AAA 10,5% · FFF 9% · EEE 7,5%
  });
  it('chấp nhận chuỗi số từ ô nhập, bỏ tiêu chí rỗng/không hợp lệ/lạ', () => {
    const f = S.normalizeFilters({ values: { pe: '12', roe: '', pb: 'abc', zzz: 5, upside: 0 } });
    expect(f.values).toEqual({ pe: 12, upside: 0 });
  });
  it('mã thiếu số liệu cho tiêu chí đã bật KHÔNG đạt, nhưng được đếm riêng', () => {
    const r = S.evaluate(ROWS, { values: { upside: 10 } });
    expect(ids(r)).not.toContain('EEE');
    expect(r.stats.missingOnly).toBeGreaterThanOrEqual(1);   // EEE
  });
  it('P/E, P/B, PEG âm hoặc bằng 0 vô nghĩa nên không đạt "tối đa"', () => {
    const r = S.evaluate(ROWS, { values: { pe: 100 }, excludeLoss: false });
    expect(ids(r)).not.toContain('DDD');             // lỗ: P/E null => thiếu
  });
  it('mặc định loại mã đang lỗ; tắt thì giữ', () => {
    const on = S.evaluate(ROWS, { values: { pb: 5 } });
    const off = S.evaluate(ROWS, { values: { pb: 5 }, excludeLoss: false });
    expect(ids(on)).not.toContain('DDD');
    expect(ids(off)).toContain('DDD');
  });
  it('lọc theo kết luận, ngành và phạm vi (đang nắm / theo dõi / chưa nắm)', () => {
    const cheap = S.evaluate(ROWS, { verdicts: ['cheap'] });
    expect(cheap.passed.every(e => e.row.verdict === 'cheap')).toBe(true);
    expect(ids(cheap)).toContain('AAA');
    expect(ids(S.evaluate(ROWS, { scope: 'held' }))).toEqual(['AAA']);
    expect(ids(S.evaluate(ROWS, { scope: 'watched' }))).toEqual(['FFF']);
    expect(ids(S.evaluate(ROWS, { scope: 'notheld' }))).not.toContain('AAA');
    expect(S.evaluate(ROWS, { sector: 'bank' }).passed).toEqual([]);
  });
  it('cổ tức: tỷ suất tối thiểu, mã không có cổ tức bị loại vì thiếu', () => {
    const r = S.evaluate(ROWS, { values: { divYield: 5 } });
    expect(ids(r)).toEqual(['FFF']);                 // 1200/14000 = 8,6%
  });
});

describe('evaluate: gần đạt và xếp hạng', () => {
  it('mã trượt đúng 1 tiêu chí (có đủ dữ liệu) vào danh sách "gần đạt", kèm tiêu chí trượt', () => {
    const r = S.evaluate(ROWS, { values: { pe: 8, roe: 10 } });
    const near = r.near.map(e => e.row.symbol);
    expect(near.length).toBeGreaterThan(0);
    r.near.forEach(e => expect(e.failed).toHaveLength(1));
  });
  it('xếp theo điểm giảm dần, mã không đủ dữ liệu để chấm xuống cuối', () => {
    const r = S.evaluate(ROWS, {});
    const sc = r.passed.map(e => e.score === null ? -1 : e.score);
    expect(sc).toEqual([...sc].sort((a, b) => b - a));
  });
});

describe('score', () => {
  const base = { upside: null, peDiscount: null, roe: null, netMargin: null, epsGrowth: null, peg: null, divYield: null, payout: null, lossMaking: false, pe: null };
  it('ghép các nhóm có dữ liệu; cần ít nhất 2 nhóm ngoài "an toàn"', () => {
    expect(S.score(base).total).toBeNull();
    expect(S.score(Object.assign({}, base, { roe: 25 })).total).toBeNull();
    const s = S.score(Object.assign({}, base, { roe: 25, upside: 50 }));
    expect(s.total).toBeCloseTo(100, 6);
  });
  it('lỗ và chi cổ tức vượt lợi nhuận bị trừ điểm an toàn', () => {
    const good = S.score(Object.assign({}, base, { roe: 20, upside: 30 }));
    const bad = S.score(Object.assign({}, base, { roe: 20, upside: 30, lossMaking: true, payout: 150 }));
    expect(bad.parts.safety).toBeLessThan(good.parts.safety);
    expect(bad.total).toBeLessThan(good.total);
  });
  it('PEG quá cao làm giảm điểm tăng trưởng; dùng chênh lệch so với ngành khi chưa có giá hợp lý', () => {
    expect(S.score(Object.assign({}, base, { epsGrowth: 20, peg: 3, roe: 15 })).parts.growth).toBeLessThan(S.score(Object.assign({}, base, { epsGrowth: 20, peg: 1, roe: 15 })).parts.growth);
    expect(S.score(Object.assign({}, base, { peDiscount: 40, roe: 15 })).parts.value).toBeCloseTo(100, 6);
  });
});

describe('mẫu có sẵn và rổ mã', () => {
  it('mọi mẫu chỉ dùng tiêu chí hợp lệ và chạy được', () => {
    S.PRESETS.forEach(p => {
      Object.keys(p.filters.values || {}).forEach(k => expect(S.CRITERIA_BY_KEY[k]).toBeTruthy());
      expect(() => S.evaluate(ROWS, p.filters)).not.toThrow();
      expect(p.desc.length).toBeGreaterThan(10);
    });
    expect(new Set(S.PRESETS.map(p => p.key)).size).toBe(S.PRESETS.length);
  });
  it('rổ mã hợp lệ, không trùng; chỉ liệt kê mã còn thiếu', () => {
    S.UNIVERSES.forEach(u => {
      expect(new Set(u.symbols).size).toBe(u.symbols.length);
      u.symbols.forEach(s => expect(s).toMatch(/^[A-Z0-9]{1,12}$/));
    });
    expect(S.UNIVERSES.find(u => u.key === 'vn30').symbols).toHaveLength(30);
    expect(S.missingFromUniverse('securities', ['ssi', 'VND'])).not.toContain('SSI');
    expect(S.missingFromUniverse('securities', ['ssi', 'VND'])).not.toContain('VND');
    expect(S.missingFromUniverse('securities', [])).toHaveLength(10);
    expect(S.missingFromUniverse('khong-co', [])).toEqual([]);
  });
  it('describe mô tả tiêu chí dễ đọc', () => {
    expect(S.describe('roe', 15)).toBe('ROE ≥ 15%');
    expect(S.describe('pe', 12)).toBe('P/E ≤ 12x');
    expect(S.describe('peDiscount', 15)).toMatch(/≥ 15%/);
  });
});
