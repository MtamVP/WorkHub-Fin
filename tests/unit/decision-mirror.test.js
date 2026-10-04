// lib/decision-mirror.js: Gương Quyết Định -- thiên kiến hành vi, điểm vào/ra, hiệu chỉnh mức tự tin, bán xong giá đi đâu. Mỗi ca dựng chuỗi giá tất định rồi so với số tính tay.
import { describe, it, expect } from 'vitest';
import M from '../../lib/decision-mirror.js';

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// Chuỗi giá mỗi ngày lịch từ start, f(i) = giá ngày thứ i
const series = (start, days, f) => Array.from({ length: days }, (_, i) => [addDays(start, i), f(i)]);
const flat = (v) => () => v;
const TODAY = '2026-12-31';
const T = (id, type, symbol, quantity, price, trade_date, extra = {}) => ({ id, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z', deleted_at: null, ...extra });
const BENCH = series('2025-10-01', 500, (i) => 1000 + i);      // chỉ số tăng đều 1 điểm/ngày

describe('thống kê nhỏ', () => {
  it('normCdf', () => {
    expect(M.normCdf(0)).toBeCloseTo(0.5, 6);
    expect(M.normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(M.normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it('kiểm định hai tỷ lệ', () => {
    const r = M.twoProportionTest(90, 100, 10, 100);
    expect(r.z).toBeGreaterThan(10);
    expect(r.p).toBeLessThan(1e-6);
    expect(M.twoProportionTest(10, 20, 10, 20).p).toBeCloseTo(1, 6);
    expect(M.twoProportionTest(0, 0, 1, 2).z).toBeNull();
  });
  it('spearman: đồng biến, nghịch biến, hạng đồng hạng, không đủ dữ liệu', () => {
    expect(M.spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 9);
    expect(M.spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1, 9);
    expect(M.spearman([1, 1, 2, 2], [1, 2, 3, 4])).toBeGreaterThan(0.8);
    expect(M.spearman([1, 2], [1, 2])).toBeNull();
    expect(M.spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

describe('điểm vào lệnh (timing)', () => {
  // mua ngày 2026-03-01 giá 100; 30 ngày sau 110 (+10%); chỉ số tăng 30 điểm
  const input = { txns: [T('1', 'buy', 'AAA', 100, 100, '2026-03-01')], histories: { AAA: series('2026-01-01', 365, (i) => (i < 65 ? 100 : 110)) }, bench: BENCH, decisions: [], today: TODAY };
  it('lợi suất 30 ngày sau mua và phần vượt chỉ số', () => {
    const r = M.analyze(input);
    const b = r.timing.buys[30];
    expect(b.n).toBe(1);
    expect(b.avgReturn).toBeCloseTo(10, 6);
    const idx0 = 1000 + Math.round((Date.parse('2026-03-01') - Date.parse('2025-10-01')) / 86400000);
    const benchRet = ((idx0 + 30) / idx0 - 1) * 100;
    expect(b.avgExcess).toBeCloseTo(10 - benchRet, 4);
    expect(b.hitPct).toBe(100);
  });
  it('lệnh chưa đủ 30 ngày thì không tính', () => {
    const r = M.analyze({ ...input, txns: [T('1', 'buy', 'AAA', 100, 100, '2026-12-20')] });
    expect(r.timing.buys[30].n).toBe(0);
    expect(r.timing.buys[30].avgExcess).toBeNull();
  });
  it('điều chỉnh tách cổ phiếu: giá giảm một nửa do chia 2 thì lợi suất ~ 0', () => {
    const r = M.analyze({ ...input, histories: { AAA: series('2026-01-01', 365, (i) => (i < 70 ? 100 : 50)) },
      actions: [{ symbol: 'AAA', action_type: 'split', ratio: 2, ex_date: '2026-03-15', created_at: '2026-03-15T00:00:00Z', deleted_at: null }] });
    expect(r.timing.buys[30].avgReturn).toBeCloseTo(0, 6);
  });
  it('thiếu lịch sử giá của mã: ghi nhận mã thiếu, không lỗi', () => {
    const r = M.analyze({ ...input, histories: {} });
    expect(r.missingSymbols).toEqual(['AAA']);
    expect(r.timing.buys[30].n).toBe(0);
  });
});

describe('bán xong giá đi đâu (sellImpact)', () => {
  it('bán 100 @100, nay giá 120: giữ lại có thêm 2.000 -> tác động bán = -2.000', () => {
    const r = M.analyze({ txns: [T('1', 'buy', 'AAA', 100, 80, '2026-01-05'), T('2', 'sell', 'AAA', 100, 100, '2026-06-01', { fee: 150, tax: 100 })],
      histories: { AAA: series('2026-01-01', 365, (i) => (i < 150 ? 100 : 120)) }, bench: BENCH, today: TODAY });
    expect(r.holding.sellImpact).toMatchObject({ n: 1, valueVnd: -2000, rightPct: 0 });
    expect(r.holding.sellCosts).toBe(250);
  });
  it('thưởng cổ phiếu sau khi bán: số cổ phiếu giữ lại tăng theo hệ số', () => {
    const r = M.analyze({ txns: [T('1', 'buy', 'AAA', 100, 80, '2026-01-05'), T('2', 'sell', 'AAA', 100, 100, '2026-06-01')],
      histories: { AAA: series('2026-01-01', 365, flat(100)) }, bench: BENCH, today: TODAY,
      actions: [{ symbol: 'AAA', action_type: 'stock_dividend', ratio: 0.1, ex_date: '2026-08-01', created_at: '2026-08-01T00:00:00Z', deleted_at: null }] });
    expect(r.holding.sellImpact.valueVnd).toBeCloseTo(100 * 100 - 110 * 100, 6);     // giữ lại: 110 cp x 100
  });
});

describe('mua đuổi và bán hoảng loạn', () => {
  it('lệnh mua sau khi tăng 20% trong 4 tuần thuộc nhóm "mua đuổi"; sau nhịp giảm thì nhóm "dip"', () => {
    // 2026-03-01 là ngày thứ 59. UP: đi ngang 100 tới ngày 31 rồi tăng đều lên 120 ở ngày 59. DN: giảm đều 100 -> 90 trong 59 ngày.
    const histories = {
      UP: series('2026-01-01', 365, (i) => (i <= 31 ? 100 : (i >= 59 ? 120 : 100 + (i - 31) * (20 / 28)))),
      DN: series('2026-01-01', 365, (i) => (i >= 59 ? 90 : 100 - (i / 59) * 10)),
    };
    const r = M.analyze({ txns: [T('1', 'buy', 'UP', 100, 120, '2026-03-01'), T('2', 'buy', 'DN', 100, 90, '2026-03-01')], histories, bench: BENCH, today: TODAY });
    const c = r.behavior.chase;
    expect(c.n).toBe(2);
    expect(c.runup.n).toBe(1);
    expect(c.runup.avgPrior).toBeCloseTo(20, 4);
    expect(c.dip.n + c.flat.n).toBe(1);
    expect(c.runupSharePct).toBeCloseTo(50, 6);
  });
  it('bán sau khi giảm >= 8% trong 2 tuần, rồi giá hồi sau 30 ngày', () => {
    // 100 tới ngày 73, tụt đều về 88 ở ngày 87 (= 2026-03-29), đi ngang 88 tới ngày 116, rồi 95
    const f = (i) => (i <= 73 ? 100 : (i < 87 ? 100 - (i - 73) * (12 / 14) : (i < 117 ? 88 : 95)));
    const r = M.analyze({ txns: [T('1', 'buy', 'AAA', 100, 100, '2026-01-10'), T('2', 'sell', 'AAA', 100, 88, '2026-03-29')], histories: { AAA: series('2026-01-01', 365, f) }, bench: BENCH, today: TODAY });
    const p = r.behavior.panic;
    expect(p.n).toBe(1);
    expect(p.nAfter).toBe(1);
    expect(p.avgAfter).toBeCloseTo((95 / 88 - 1) * 100, 4);
    expect(p.reboundPct).toBe(100);
  });
  it('bán sau giảm nhẹ (< 8%) không tính là hoảng loạn', () => {
    const r = M.analyze({ txns: [T('1', 'buy', 'AAA', 100, 100, '2026-01-10'), T('2', 'sell', 'AAA', 100, 97, '2026-03-29')], histories: { AAA: series('2026-01-01', 365, (i) => (i < 85 ? 100 : 97)) }, bench: BENCH, today: TODAY });
    expect(r.behavior.panic.n).toBe(0);
  });
});

describe('disposition effect (Odean)', () => {
  // 6 cặp (thắng, thua): mỗi cặp mua cả hai @100; ngày bán, mã thắng giá 120 và được bán hết (RG), mã thua giá 80 vẫn giữ (PL)
  const pairs = ['A', 'B', 'C', 'D', 'E', 'F'];
  const mk = (kind) => {
    const txns = [], histories = {};
    pairs.forEach((p, i) => {
      const w = 'W' + p, l = 'L' + p, buyD = addDays('2026-01-05', i * 20), sellD = addDays(buyD, 10);
      txns.push(T('b' + w, 'buy', w, 100, 100, buyD), T('b' + l, 'buy', l, 100, 100, buyD));
      if (kind === 'disp') txns.push(T('s' + w, 'sell', w, 100, 120, sellD));
      else txns.push(T('s' + l, 'sell', l, 100, 80, sellD));               // ngược lại: cắt lỗ, giữ lời
      histories[w] = series('2025-12-01', 400, (d) => (d >= 35 ? 120 : 100)); histories[l] = series('2025-12-01', 400, (d) => (d >= 35 ? 80 : 100));
    });
    return { txns, histories, bench: BENCH, today: TODAY };
  };
  it('chỉ bán mã lãi, giữ mã lỗ: PGR cao, PLR thấp, có ý nghĩa thống kê và có nhận xét cảnh báo', () => {
    const r = M.analyze(mk('disp'));
    expect(r.disposition).toMatchObject({ RG: 6, RL: 0 });
    expect(r.disposition.PL).toBeGreaterThanOrEqual(6);
    expect(r.disposition.pgr).toBe(1);
    expect(r.disposition.plr).toBe(0);
    expect(r.disposition.diff).toBe(1);
    expect(r.disposition.p).toBeLessThan(0.05);
    expect(r.findings.map(f => f.key)).toContain('disposition');
    expect(r.findings.find(f => f.key === 'disposition').tone).toBe('warn');
  });
  it('cắt lỗ giữ lời (ngược lại): nhận xét tích cực', () => {
    const r = M.analyze(mk('rev'));
    expect(r.disposition.diff).toBe(-1);
    expect(r.findings.find(f => f.key === 'disposition-rev').tone).toBe('good');
  });
  it('ít lần bán thì không kết luận gì', () => {
    const r = M.analyze({ txns: [T('1', 'buy', 'AAA', 100, 100, '2026-01-05'), T('2', 'sell', 'AAA', 50, 120, '2026-02-05')], histories: { AAA: series('2025-12-01', 400, flat(120)) }, bench: BENCH, today: TODAY });
    expect(r.findings.find(f => f.key.startsWith('disposition'))).toBeUndefined();
  });
  it('thưởng cổ phiếu không làm sai giá vốn trung bình (giá vốn chia theo hệ số)', () => {
    // AAA: mua 100 @100; thưởng 10% => 110 cp, giá vốn TB 90,9; sau thưởng giá 95 là LÃI so với giá vốn điều chỉnh dù thấp hơn 100
    const r = M.analyze({ txns: [T('1', 'buy', 'AAA', 100, 100, '2026-01-05'), T('2', 'buy', 'BBB', 100, 100, '2026-01-05'), T('3', 'sell', 'BBB', 100, 120, '2026-03-01')],
      histories: { AAA: series('2025-12-01', 400, (d) => (d >= 60 ? 95 : 100)), BBB: series('2025-12-01', 400, flat(120)) },
      actions: [{ symbol: 'AAA', action_type: 'stock_dividend', ratio: 0.1, ex_date: '2026-02-01', created_at: '2026-02-01T00:00:00Z', deleted_at: null }], bench: BENCH, today: TODAY });
    expect(r.disposition).toMatchObject({ RG: 1, PG: 1, PL: 0 });
  });
});

describe('thời gian giữ lệnh lời / lỗ', () => {
  it('lệnh lỗ giữ lâu hơn lệnh lời -> tỷ lệ > 1 (dùng FIFO thật)', () => {
    const txns = [];
    for (let i = 0; i < 5; i++) {
      const buy = addDays('2026-01-01', i * 3);
      txns.push(T('w' + i, 'buy', 'W' + i, 10, 100, buy), T('ws' + i, 'sell', 'W' + i, 10, 110, addDays(buy, 20)));      // lời, giữ 20 ngày
      txns.push(T('l' + i, 'buy', 'L' + i, 10, 100, buy), T('ls' + i, 'sell', 'L' + i, 10, 90, addDays(buy, 60)));       // lỗ, giữ 60 ngày
    }
    const r = M.analyze({ txns, histories: {}, bench: BENCH, today: TODAY });
    expect(r.holding.winners).toMatchObject({ n: 5, avgDays: 20 });
    expect(r.holding.losers).toMatchObject({ n: 5, avgDays: 60 });
    expect(r.holding.lossHoldRatio).toBe(3);
    expect(r.findings.map(f => f.key)).toContain('hold-loss');
  });
});

describe('hiệu chỉnh mức tự tin và quy trình', () => {
  const dec = (i, conf, finalPrice, extra = {}) => ({ id: 'd' + i, symbol: 'S' + i, action: 'buy', decided_at: '2026-02-01', price_at_decision: 100, confidence: conf, expected_price: 130, stop_price: 90, reason: 'Lý do đủ dài để tính là có lý do', horizon_months: 3, tags: [], ...extra, _final: finalPrice });
  const build = (rows) => {
    const histories = {};
    rows.forEach((d) => { histories[d.symbol] = series('2026-01-01', 365, (i) => (i < 31 ? 100 : d._final)); });
    return { txns: [T('x', 'buy', 'S0', 1, 100, '2026-02-01')], histories, bench: BENCH, decisions: rows, today: TODAY };
  };
  it('mức tự tin cao ứng với kết quả tốt: tương quan dương, nhận xét tích cực', () => {
    const rows = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5].map((c, i) => dec(i, c, 80 + c * 10 + (i % 2)));
    const r = M.analyze(build(rows));
    expect(r.decisions.nWithConfidence).toBe(10);
    expect(r.decisions.confidenceCorr).toBeGreaterThan(0.9);
    expect(r.decisions.calibration[4].avgAlpha).toBeGreaterThan(r.decisions.calibration[0].avgAlpha);
    expect(r.findings.find(f => f.key === 'confidence-good')).toBeTruthy();
  });
  it('mức tự tin cao ứng với kết quả tệ: cảnh báo', () => {
    const rows = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5].map((c, i) => dec(i, c, 140 - c * 10 - (i % 2)));
    const r = M.analyze(build(rows));
    expect(r.decisions.confidenceCorr).toBeLessThan(-0.9);
    expect(r.findings.find(f => f.key === 'confidence').tone).toBe('warn');
  });
  it('ma trận quy trình vs kết quả; quyết định chưa đủ 30 ngày bị bỏ', () => {
    const rows = [dec(0, 3, 130), dec(1, 3, 80, { stop_price: null }), dec(2, 3, 130, { reason: '' }), dec(3, 3, 80), dec(4, 3, 150, { decided_at: '2026-12-20' })];
    const r = M.analyze(build(rows));
    expect(r.decisions.rows).toHaveLength(4);             // quyết định ngày 2026-12-20 chưa đủ 30 ngày
    expect(r.decisions.process).toEqual({ goodGood: 1, goodBad: 1, badGood: 1, badBad: 1 });
  });
  it('quyết định bán/giữ không vào bảng hiệu chỉnh', () => {
    const rows = [dec(0, 3, 130, { action: 'sell' }), dec(1, 3, 130, { action: 'hold' })];
    expect(M.analyze(build(rows)).decisions.rows).toEqual([]);
  });
});

describe('analyze: biên', () => {
  it('chưa có lệnh nào', () => {
    const r = M.analyze({ txns: [], histories: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty');
    expect(M.analyze().ok).toBe(false);
  });
  it('bỏ lệnh đã xoá và đánh dấu mẫu nhỏ', () => {
    const r = M.analyze({ txns: [T('1', 'buy', 'AAA', 100, 100, '2026-01-05'), T('2', 'buy', 'AAA', 100, 100, '2026-01-06', { deleted_at: '2026-01-07T00:00:00Z' })], histories: {}, bench: BENCH, today: TODAY });
    expect(r.nTrades).toBe(1);
    expect(r.smallSample).toBe(true);
  });
  it('không có chuẩn VN-Index: vẫn tính phần lợi suất, phần vượt chuẩn rỗng', () => {
    const r = M.analyze({ txns: [T('1', 'buy', 'AAA', 100, 100, '2026-03-01')], histories: { AAA: series('2026-01-01', 365, (i) => (i < 65 ? 100 : 110)) }, today: TODAY });
    expect(r.hasBench).toBe(false);
    expect(r.timing.buys[30].avgReturn).toBeCloseTo(10, 6);
    expect(r.timing.buys[30].avgExcess).toBeNull();
  });
});
