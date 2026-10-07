import { describe, it, expect } from 'vitest';
import MB from '../../lib/market-batch.js';
import MS from '../../lib/market-screener.js';
import E from '../../lib/vb-engine.js';

// ---- dữ liệu giả lập hoàn chỉnh (cùng cách dựng với vb-synthesis-engine.test.js) ----
const B = 1e9;
const R = (code, date, v, model) => ({ itemCode: code, fiscalDate: date, numericValue: v * B, modelType: model });
function company(date, k) {
  const s = Math.pow(1.12, k), y = 2021 + k;
  const m = (c, v, mt) => R(c, date, v * s, mt);
  return [m(21001, 1000, 2), m(22100, 600, 2), m(23100, 400, 2), m(22110, 80, 2), m(22200, 60, 2), m(21500, 20, 2), m(22510, 15, 2), m(23800, 270, 2), m(22070, 54, 2), m(23000, 200, 2), m(23500, 16, 2), m(23003, 216, 2),
    m(11100, 150, 1), m(11200, 100, 1), m(11300, 120, 1), m(11400, 90, 1), m(11000, 520, 1), m(12200, 500, 1), m(12700, 1300, 1), m(13000, 450, 1), m(13100, 300, 1), m(13110, 120, 1), m(13340, 60, 1), m(14000, 850, 1), m(14240, 40, 1), m(14110, 100, 1), m(14200, 300, 1),
    m(32000, 230, 3), m(32100, -90, 3), m(22230, 50, 3), m(33600, -60, 3)].map((r) => Object.assign(r, { fy: y }));
}
const ANNUAL = [0, 1, 2, 3, 4].reduce((acc, k) => acc.concat(company((2021 + k) + '-12-31', k)), []);
function candles(n) {
  const t = [], o = [], h = [], l = [], c = [], v = []; let px = 40000;
  for (let i = 0; i < n; i++) { const close = 40000 + 15 * i + Math.sin(i / 7) * 2000; o.push(px); px = close; c.push(close); h.push(Math.max(o[i], close) + 300); l.push(Math.min(o[i], close) - 300); v.push(500000 + (i % 9) * 40000); t.push(new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10)); }
  return { t, o, h, l, c, v };
}
const VB = () => ({ form: undefined, annualRows: ANNUAL.map((r) => Object.assign({}, r)), quarterRows: [], candles: candles(400), indexCandles: Object.assign(candles(400), { c: candles(400).c.map((x, i) => 1000 + i * 0.5) }), ratioSeries: { pe: Array.from({ length: 300 }, (_, i) => 12 + (i % 30) * 0.2) } });
const Q = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30];
const STATS = { '2700': { n: 40, as_of: '2026-10-06', stats: { pe: { n: 40, median: 14, q: Q }, pb: { n: 40, median: 1.8, q: [0.5, 0.8, 1, 1.2, 1.5, 1.8, 2.1, 2.5, 3, 4, 6] }, ps: { n: 40, median: 1.5, q: [0.3, 0.5, 0.7, 0.9, 1.2, 1.5, 1.9, 2.4, 3, 4, 6] } } } };
const SNAP = ['AAA', 'BBB', 'CCC'].map((s, i) => ({ symbol: s, icb2_code: '2700', metrics: { marketcap: 3000e9, advValue20: 20e9, pe: 8 + i, pb: 1 + i * 0.2, roae: 0.18, shares: 50e6, beta: 1, netProfitGrowthYoY: 0.2 } }));
const rows = MS.buildRows(SNAP, STATS, { AAA: { name: 'Công ty A', exchange: 'HOSE' } });
const HIST = { rows: [], bond10y: 4 };

describe('buildCtx', () => {
  it('lấy thống kê ngành theo ICB của mã, chép chỉ số của mã, mang theo lịch sử định giá và bảng điểm', () => {
    const c = MB.buildCtx(VB(), rows[0], { stats: STATS }, HIST, { scorecard: { x: 1 }, sectorName: 'Công nghệ' });
    expect(c.peerStats).toBe(STATS['2700'].stats); expect(c.sectorCode).toBe('2700'); expect(c.sectorName).toBe('Công nghệ');
    expect(c.metrics).toMatchObject({ shares: 50e6, pe: 8 }); expect(c.metrics).not.toBe(rows[0].m);
    expect(c.bond10yPct).toBe(4); expect(c.scorecard).toEqual({ x: 1 }); expect(c.mc.n).toBe(300);
    expect(MB.buildCtx(VB(), { symbol: 'Z', icb2_code: '9999', m: {} }, { stats: STATS }, null).peerStats).toBeNull();
  });
});

describe('summarize với bộ máy thật', () => {
  it('doanh nghiệp đủ dữ liệu -> giá trị hợp lý, biên an toàn theo giá hiện tại, xếp loại, mô hình kinh doanh', () => {
    const res = E.analyze(MB.buildCtx(VB(), rows[0], { stats: STATS }, HIST));
    const s = MB.summarize(res, E);
    expect(s.ok).toBe(true); expect(s.fairBase).toBeGreaterThan(0); expect(s.price).toBeGreaterThan(0);
    expect(s.mos).toBeCloseTo((s.fairBase - s.price) / s.fairBase, 10);
    expect(typeof s.grade).toBe('string'); expect(typeof s.archetype).toBe('string'); expect(s.fairLow).toBeLessThanOrEqual(s.fairHigh);
  });
  it('không có báo cáo -> ok = false kèm lý do; không có kết quả -> lý do mặc định', () => {
    const s = MB.summarize(E.analyze({ symbol: 'NOPE', annualRows: [] }), E);
    expect(s.ok).toBe(false); expect(s.reason).toMatch(/báo cáo/); expect(s.symbol).toBe('NOPE');
    expect(MB.summarize(null, E).ok).toBe(false);
  });
});

describe('run: điều phối hàng loạt', () => {
  const fns = (load) => ({ load, analyze: (vb, row) => E.analyze(MB.buildCtx(vb, row, { stats: STATS }, HIST)), finish: (r) => MB.summarize(r, E) });
  it('định giá mọi mã, báo tiến độ từng mã, không vượt số mã chạy đồng thời', async () => {
    let live = 0, peak = 0; const prog = [];
    const out = await MB.run(rows, fns(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return VB(); }), { concurrency: 2, onProgress: (p) => prog.push([p.done, p.total, p.symbol]) });
    expect(Object.keys(out.results).sort()).toEqual(['AAA', 'BBB', 'CCC']); expect(Object.values(out.results).every((x) => x.ok)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2); expect(out.done).toBe(3); expect(out.cancelled).toBe(false);
    expect(prog.map((x) => x[0]).sort()).toEqual([1, 2, 3]); expect(prog[0][1]).toBe(3);
  });
  it('lỗi nạp: thử lại một lần rồi mới báo lỗi; một mã lỗi không làm hỏng mã khác', async () => {
    const calls = {};
    const out = await MB.run(rows, fns(async (sym) => { calls[sym] = (calls[sym] || 0) + 1; if (sym === 'AAA' && calls[sym] === 1) throw new Error('mạng chập chờn'); if (sym === 'BBB') throw new Error('nguồn từ chối'); return VB(); }), { concurrency: 3, retries: 1 });
    expect(out.results.AAA.ok).toBe(true); expect(calls.AAA).toBe(2);
    expect(out.results.BBB.ok).toBe(false); expect(out.results.BBB.reason).toMatch(/Không nạp được dữ liệu: nguồn từ chối/); expect(calls.BBB).toBe(2);
    expect(out.results.CCC.ok).toBe(true);
  });
  it('lỗi khi tính được bắt lại theo từng mã; dừng giữa chừng thì không nhận mã mới', async () => {
    const bad = await MB.run(rows.slice(0, 1), { load: async () => ({}), analyze: () => { throw new Error('hỏng'); }, finish: (r) => r }, {});
    expect(bad.results.AAA).toMatchObject({ ok: false }); expect(bad.results.AAA.reason).toMatch(/Lỗi khi tính: hỏng/);
    let stop = false; const out = await MB.run(rows, fns(async () => VB()), { concurrency: 1, shouldCancel: () => stop, onProgress: (p) => { if (p.done === 1) stop = true; } });
    expect(out.cancelled).toBe(true); expect(out.done).toBe(1); expect(Object.keys(out.results)).toEqual(['AAA']);
  });
});

describe('xếp hạng và xuất bảng', () => {
  const entries = MS.evaluate(rows, { values: { cap: 1000 } }).entries;
  const vals = { AAA: { ok: true, mos: 0.1, fairBase: 50000, price: 45000, grade: 'Hợp lý', confidence: 'Cao', archetype: 'Doanh nghiệp trưởng thành' }, BBB: { ok: true, mos: 0.35, fairBase: 60000, price: 39000, grade: 'Rẻ', confidence: 'Vừa', archetype: 'Tăng trưởng' }, CCC: { ok: false, reason: 'x' } };
  it('xếp theo biên an toàn giảm dần, mã chưa định giá xuống cuối', () => {
    expect(MB.rankByMos(entries, vals).map((e) => e.row.symbol)).toEqual(['BBB', 'AAA', 'CCC']);
    expect(MB.rankByMos(entries, {}).map((e) => e.row.symbol)).toEqual(entries.map((e) => e.row.symbol));
  });
  it('csvRows: dòng tiêu đề + mỗi mã một dòng, mọi dòng cùng số cột, phần trăm không kèm ký hiệu, mã chưa định giá để trống cột định giá', () => {
    const t = MB.csvRows(MB.rankByMos(entries, vals), vals, (c) => 'Ngành ' + c);
    expect(t).toHaveLength(4); expect(new Set(t.map((r) => r.length)).size).toBe(1); expect(t[0].length).toBe(MB.HEADER.length);
    const iMos = MB.HEADER.indexOf('Biên an toàn %'), iFair = MB.HEADER.indexOf('Giá trị hợp lý (đ)'), iRoe = MB.HEADER.indexOf('ROE %'), iNet = MB.HEADER.indexOf('Tăng trưởng LN ròng 12 tháng %');
    expect(t[1][0]).toBe('BBB'); expect(t[1][iMos]).toBe('35.0'); expect(t[1][iFair]).toBe(60000); expect(t[1][iRoe]).toBe('18.0'); expect(t[1][iNet]).toBe('20.0');
    expect(t[1][2]).toBe('Ngành 2700'); expect(t[3][0]).toBe('CCC'); expect(t[3][iMos]).toBe(''); expect(t[3][iFair]).toBe('');
    const FinCalc = require('../../lib/finance-calc.js');
    expect(FinCalc.buildCsv(t).startsWith('﻿"Mã"')).toBe(true);
  });
});
