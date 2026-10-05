// Edge Function vb-data: kiểm tra đầu vào, lọc khoản mục, phân tích nến và chuỗi bội số; bản sao lib/vb-statements.js phải khớp và chạy được khi nạp kiểu Deno.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRequest, slimRows, candlesFromDchart, ratioValues, yearsAgo, MODELS, FORM_ORDER, summarizeCoverage } from '../../supabase/functions/vb-data/parse.ts';
import { VBDATA_LIBS, expectedCopy } from '../../scripts/sync-edge-libs.mjs';
import VBStatements from '../../lib/vb-statements.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const edge = (f) => readFileSync(path.join(here, '../../supabase/functions/vb-data', f), 'utf8');

describe('bản sao thư viện trong hàm', () => {
  it.each(VBDATA_LIBS)('$file khớp lib/ (chạy node scripts/sync-edge-libs.mjs nếu lệch)', (lib) => { expect(edge(lib.file)).toBe(expectedCopy(lib)); });
  it('nạp kiểu Deno vẫn lộ bảng ánh xạ mã khoản mục giống bản trong lib/', () => {
    const sb = { console }; vm.createContext(sb); vm.runInContext(edge('vb-statements.js'), sb);
    expect(JSON.stringify(sb.VBStatements.MAP)).toBe(JSON.stringify(VBStatements.MAP));
    expect(sb.VBStatements.MODELS.SECURITIES).toEqual([89, 90, 91]);
  });
  it('mã mô hình ở hàm khớp với lib: cùng bộ 3 mã cho mỗi loại', () => {
    FORM_ORDER.forEach((f) => expect(MODELS[f]).toEqual(VBStatements.MODELS[f]));
  });
});

describe('validateRequest', () => {
  it('chuẩn hoá mã, chế độ và các giới hạn năm', () => {
    const v = validateRequest({ symbol: ' fpt ', mode: 'ohlc', years: 99, candleYears: 0 });
    expect(v.error).toBeNull(); expect(v.symbol).toBe('FPT'); expect(v.mode).toBe('ohlc'); expect(v.years).toBe(10); expect(v.candleYears).toBe(5);
    expect(validateRequest({ symbol: 'VCB', years: 1 }).years).toBe(3); expect(validateRequest({ symbol: 'VCB', candleYears: 20 }).candleYears).toBe(7);
    expect(validateRequest({ symbol: 'VCB', mode: 'khong-co' }).mode).toBe('all'); expect(validateRequest({ symbol: 'VCB', index: false }).index).toBe(false);
  });
  it('từ chối thiếu mã, mã lạ, thân rỗng', () => {
    expect(validateRequest(null).error).toMatch(/Thiếu/); expect(validateRequest({}).error).toMatch(/Thiếu/); expect(validateRequest({ symbol: 'A/B' }).error).toMatch(/không hợp lệ/); expect(validateRequest({ symbol: 'X'.repeat(13) }).error).toMatch(/không hợp lệ/);
  });
});

describe('slimRows', () => {
  const rows = [{ itemCode: 21001.0, fiscalDate: '2025-12-31', numericValue: 5, modelType: 2.0, createdDate: 'x' }, { itemCode: 99999, fiscalDate: '2025-12-31', numericValue: 1, modelType: 2 }, { itemCode: 21001, fiscalDate: '2025-12-31', numericValue: 'abc', modelType: 2 }, { itemCode: 21001, numericValue: 1 }];
  it('chỉ giữ mã cần dùng, ép kiểu số, bỏ hàng hỏng và bỏ trường thừa', () => {
    const r = slimRows(rows, new Set([21001]));
    expect(r).toEqual([{ itemCode: 21001, fiscalDate: '2025-12-31', numericValue: 5, modelType: 2 }]);
    expect(slimRows(rows, null)).toHaveLength(2); expect(slimRows(null, null)).toEqual([]);
  });
  it('kết quả đọc được bằng mergeRows và detectFormFromRows của lib', () => {
    const r = slimRows([{ itemCode: 421701, fiscalDate: '2025-12-31', numericValue: 7, modelType: 102 }], null);
    expect(VBStatements.detectFormFromRows(r)).toBe('BANK'); expect(VBStatements.mergeRows(r)['2025-12-31'][421701]).toBe(7);
  });
});

describe('candlesFromDchart', () => {
  const j = { s: 'ok', t: [1790899200, 1790985600, 1790985600, 1791072000], o: [62.7, 62, 62.1, 61], h: [63.2, 63, 63.3, 62], l: [62.1, 61.5, 61.9, 60.5], c: [62.1, 62.5, 62.4, 61.2], v: [1000, 2000, 2500, 3000] };
  it('nhân 1000 với cổ phiếu, giữ nguyên chỉ số; ngày trùng lấy bản sau; sắp tăng dần', () => {
    const c = candlesFromDchart(j, 'FPT');
    expect(c.t).toHaveLength(3); expect(c.c[0]).toBe(62100); expect(c.o[0]).toBe(62700); expect(c.v[1]).toBe(2500); expect(c.t).toEqual([...c.t].sort());
    expect(candlesFromDchart(j, 'VNINDEX').c[0]).toBe(62.1);
  });
  it('bỏ nến hỏng (giá không dương, cao < thấp, thiếu số); phản hồi lỗi hoặc rỗng: null', () => {
    const bad = { s: 'ok', t: [1790899200, 1790985600], o: [1, 1], h: [1, 0.5], l: [1, 1], c: [0, 1], v: [1, 1] };
    expect(candlesFromDchart(bad, 'FPT')).toBeNull();
    expect(candlesFromDchart({ s: 'no_data' }, 'FPT')).toBeNull(); expect(candlesFromDchart(null, 'FPT')).toBeNull(); expect(candlesFromDchart({ s: 'ok', t: [], c: [], o: [], h: [], l: [] }, 'FPT')).toBeNull();
  });
  it('khối lượng thiếu: 0', () => { const x = Object.assign({}, j); delete x.v; expect(candlesFromDchart(x, 'FPT').v.every((v) => v === 0)).toBe(true); });
});

describe('ratioValues và tiện ích', () => {
  it('sắp tăng theo ngày, bỏ giá trị không dương/không phải số, ngày trùng lấy bản sau', () => {
    const r = ratioValues([{ reportDate: '2026-01-03', value: 12 }, { reportDate: '2026-01-02', value: 10 }, { reportDate: '2026-01-04', value: -1 }, { reportDate: '2026-01-05', value: 'x' }, { reportDate: '2026-01-02', value: 11 }]);
    expect(r.dates).toEqual(['2026-01-02', '2026-01-03']); expect(r.values).toEqual([11, 12]);
  });
  it('yearsAgo và độ phủ báo cáo', () => {
    expect(yearsAgo(new Date('2026-10-06T10:00:00Z'), 5)).toBe('2021-10-06');
    const c = summarizeCoverage([{ fiscalDate: '2025-12-31' }, { fiscalDate: '2024-12-31' }, { fiscalDate: '2025-12-31' }], [{ fiscalDate: '2026-06-30' }]);
    expect(c.annualYears).toEqual(['2024-12-31', '2025-12-31']); expect(c.quarters).toEqual(['2026-06-30']);
  });
});
