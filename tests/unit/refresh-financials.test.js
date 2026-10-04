// Edge Function refresh-financials: chọn mã làm mới, dấu vân tay số liệu, phân loại thay đổi; và bản sao parse.ts không được lệch bản gốc.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickSymbols, latestKeys, fingerprint, classify, summarize, MAX_PER_RUN, MIN_AGE_HOURS } from '../../supabase/functions/refresh-financials/refresh.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-10-04T00:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

describe('pickSymbols', () => {
  it('mã chưa từng lấy đi trước, rồi mã cũ nhất; bỏ mã mới lấy trong 20 giờ', () => {
    const cache = [{ symbol: 'AAA', fetched_at: hoursAgo(30) }, { symbol: 'BBB', fetched_at: hoursAgo(50) }, { symbol: 'CCC', fetched_at: hoursAgo(5) }];
    expect(pickSymbols(['CCC', 'AAA', 'BBB', 'NEW'], cache, NOW)).toEqual(['NEW', 'BBB', 'AAA']);
  });
  it(`đúng ngưỡng ${MIN_AGE_HOURS} giờ thì được làm mới; trùng mã chỉ tính 1 lần`, () => {
    expect(pickSymbols(['AAA', 'AAA'], [{ symbol: 'AAA', fetched_at: hoursAgo(MIN_AGE_HOURS) }], NOW)).toEqual(['AAA']);
    expect(pickSymbols(['AAA'], [{ symbol: 'AAA', fetched_at: hoursAgo(MIN_AGE_HOURS - 0.1) }], NOW)).toEqual([]);
  });
  it('mốc thời gian hỏng coi như chưa lấy; giới hạn số mã mỗi lần', () => {
    expect(pickSymbols(['AAA'], [{ symbol: 'AAA', fetched_at: 'không phải ngày' }], NOW)).toEqual(['AAA']);
    const many = Array.from({ length: 100 }, (_, i) => 'S' + String(i).padStart(3, '0'));
    expect(pickSymbols(many, [], NOW)).toHaveLength(MAX_PER_RUN);
    expect(pickSymbols(many, [], NOW, 5)).toHaveLength(5);
  });
  it('không có mã nào -> rỗng', () => { expect(pickSymbols([], [], NOW)).toEqual([]); });
});

const FIN = (over = {}) => Object.assign({
  form: 'NON_FINANCE',
  annual: [{ year: 2025, lnst: 100, equity: 500, charter: 200, assets: 900, revenue: 700 }, { year: 2024, lnst: 80, equity: 450, charter: 200, assets: 800, revenue: 600 }],
  quarters: [{ year: 2026, quarter: 2, lnst: 30 }, { year: 2026, quarter: 1, lnst: 28 }, { year: 2025, quarter: 4, lnst: 26 }],
  dividends: { '2025': 2000, '2024': 1500 },
}, over);

describe('latestKeys / fingerprint / classify', () => {
  it('kỳ mới nhất: năm tài chính lớn nhất và quý gần nhất (không phụ thuộc thứ tự mảng)', () => {
    expect(latestKeys(FIN())).toEqual({ annualYear: 2025, quarterKey: '2026Q2' });
    expect(latestKeys(FIN({ quarters: [{ year: 2025, quarter: 4, lnst: 1 }, { year: 2026, quarter: 1, lnst: 2 }] })).quarterKey).toBe('2026Q1');
    expect(latestKeys(FIN({ annual: [], quarters: [] }))).toEqual({ annualYear: null, quarterKey: null });
  });
  it('dấu vân tay đổi khi có quý mới, số liệu kỳ gần nhất bị điều chỉnh hoặc cổ tức mới; ổn định khi không đổi', () => {
    const base = fingerprint(FIN());
    expect(fingerprint(FIN())).toBe(base);
    expect(fingerprint(FIN({ quarters: [{ year: 2026, quarter: 3, lnst: 33 }, ...FIN().quarters] }))).not.toBe(base);
    expect(fingerprint(FIN({ quarters: [{ year: 2026, quarter: 2, lnst: 31 }, ...FIN().quarters.slice(1)] }))).not.toBe(base);
    expect(fingerprint(FIN({ dividends: { '2025': 2000, '2024': 1500, '2026': 1000 } }))).not.toBe(base);
    expect(fingerprint(FIN({ annual: [{ year: 2026, lnst: 10, equity: 1, charter: 1, assets: 1, revenue: 1 }, ...FIN().annual] }))).not.toBe(base);
    // số liệu năm cũ thay đổi không phải "báo cáo mới"
    const older = FIN(); older.annual[1].lnst = 81;
    expect(fingerprint(older)).toBe(base);
  });
  it('classify: mới / đổi / không đổi', () => {
    expect(classify(null, 'x')).toBe('new');
    expect(classify(undefined, 'x')).toBe('new');
    expect(classify('x', 'x')).toBe('same');
    expect(classify('x', 'y')).toBe('changed');
  });
});

describe('summarize', () => {
  it('chỉ chứa số lượng + mã; cắt danh sách dài', () => {
    const s = summarize({ ranAt: 'T', total: 90, tried: 40, refreshed: 38, changed: Array.from({ length: 60 }, (_, i) => 'C' + i), failed: ['X', 'Y'] });
    expect(s).toMatchObject({ ranAt: 'T', symbols: 90, tried: 40, refreshed: 38, changedCount: 60, failed: ['X', 'Y'] });
    expect(s.changed).toHaveLength(50);
  });
});

describe('bản sao parse.ts', () => {
  it('refresh-financials/parse.ts giống hệt stock-financials/parse.ts (sửa một nơi phải sửa cả hai)', () => {
    const a = readFileSync(path.join(here, '../../supabase/functions/stock-financials/parse.ts'), 'utf8').replace(/\r\n/g, '\n');
    const b = readFileSync(path.join(here, '../../supabase/functions/refresh-financials/parse.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(b).toBe(a);
  });
});
