// lib/attribution-calc.js: lãi/lỗ theo mã & ngành, phần do thị trường chung vs do chọn mã, đóng góp %, đối chiếu NAV, kết quả theo quyết định.
import { describe, it, expect } from 'vitest';
import AttributionCalc from '../../lib/attribution-calc.js';

const D = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07'];   // D[0] = trước kỳ
const series = (vals) => D.map((d, i) => [d, vals[i]]);
const BENCH = series([1000, 1000, 1010, 1010, 1020.1, 1020.1]);        // lợi suất: 0, +1%, 0, +1%, 0 (ngày D[1..5])
const AAA = series([100, 100, 110, 110, 121, 121]);                      // +10% ngày D[2] và D[4]
const txn = (id, type, symbol, quantity, price, trade_date, extra = {}) => ({ id, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z', deleted_at: null, ...extra });
const PERIOD = { from: '2026-08-31', to: '2026-09-07' };

describe('analyze: lãi/lỗ một mã', () => {
  it('mua 100 @100 ngày 1/9, cuối kỳ giá 121: lãi 2.100; phần "nếu vào chỉ số" tính theo vốn từng phiên', () => {
    const r = AttributionCalc.analyze({ txns: [txn('t1', 'buy', 'AAA', 100, 100, '2026-09-01')], histories: { AAA, VNINDEX: BENCH }, ...PERIOD });
    const a = r.rows[0];
    expect(a.pnl).toBeCloseTo(2100, 6);
    // vốn 10.000 (cuối 1/9) × 1% ngày 2/9 + vốn 11.000 (cuối 3/9) × 1% ngày 4/9... theo chuỗi chuẩn: ngày D[2] +1%, D[4] +1%
    expect(a.benchPnl).toBeCloseTo(100 * 100 * 0.01 + 100 * 110 * 0.01, 6);
    expect(a.activePnl).toBeCloseTo(2100 - 210, 6);
    expect(a.held).toBe(true);
    expect(a.qtyEnd).toBe(100);
  });
  it('bán một phần: tiền thu bán trừ phí và thuế; lãi tổng không đổi nếu không phí', () => {
    const base = [txn('t1', 'buy', 'AAA', 100, 100, '2026-09-01'), txn('t2', 'sell', 'AAA', 50, 121, '2026-09-07')];
    const plain = AttributionCalc.analyze({ txns: base, histories: { AAA, VNINDEX: BENCH }, ...PERIOD });
    expect(plain.rows[0].pnl).toBeCloseTo(2100, 6);
    const costly = [txn('t1', 'buy', 'AAA', 100, 100, '2026-09-01', { fee: 20 }), txn('t2', 'sell', 'AAA', 50, 121, '2026-09-07', { fee: 10, tax: 6 })];
    const c = AttributionCalc.analyze({ txns: costly, histories: { AAA, VNINDEX: BENCH }, ...PERIOD });
    expect(c.rows[0].pnl).toBeCloseTo(2100 - 20 - 10 - 6, 6);
    expect(c.rows[0].fees).toBe(36);
    expect(c.totals.fees).toBe(36);
  });
  it('cổ tức tiền gắn mã được cộng vào lãi; cổ tức không gắn mã đếm riêng', () => {
    const r = AttributionCalc.analyze({
      txns: [txn('t1', 'buy', 'AAA', 100, 100, '2026-09-01')], histories: { AAA, VNINDEX: BENCH }, ...PERIOD,
      cashFlows: [{ flow_type: 'dividend', symbol: 'AAA', amount: 500, flow_date: '2026-09-03' }, { flow_type: 'dividend', symbol: null, amount: 70, flow_date: '2026-09-03' }, { flow_type: 'dividend', symbol: 'AAA', amount: 999, flow_date: '2025-01-01' }],
    });
    expect(r.rows[0].pnl).toBeCloseTo(2600, 6);
    expect(r.rows[0].dividends).toBe(500);
    expect(r.totals.unassignedDividends).toBe(70);
    expect(r.totals.dividends).toBe(570);
  });
  it('cổ phiếu thưởng: số cổ phiếu tăng, giá ex giảm tương ứng -> lãi chỉ đến từ biến động giá thật', () => {
    const adj = series([100, 100, 110, 110, 100, 100]);              // ngày 4/9 giá về 100 vì chia thưởng 10%
    const r = AttributionCalc.analyze({
      txns: [txn('t1', 'buy', 'AAA', 100, 100, '2026-09-01')], actions: [{ symbol: 'AAA', action_type: 'stock_dividend', ratio: 0.1, ex_date: '2026-09-04', created_at: '2026-09-04T00:00:00Z' }],
      histories: { AAA: adj, VNINDEX: BENCH }, ...PERIOD,
    });
    expect(r.rows[0].qtyEnd).toBeCloseTo(110, 9);
    expect(r.rows[0].pnl).toBeCloseTo(110 * 100 - 100 * 100, 6);      // = 1.000: chỉ phần tăng 10% ngày 2/9
  });
  it('mã đã giữ từ trước kỳ: tính từ giá đầu kỳ; mã đã bán hết trong kỳ vẫn có lãi/lỗ và cờ closed', () => {
    const before = [txn('t0', 'buy', 'AAA', 100, 90, '2026-08-01')];
    const r1 = AttributionCalc.analyze({ txns: before, histories: { AAA, VNINDEX: BENCH }, ...PERIOD });
    expect(r1.rows[0].pnl).toBeCloseTo(100 * 121 - 100 * 100, 6);      // giá đầu kỳ là 100 (cuối 31/8), không phải giá mua 90
    const closed = AttributionCalc.analyze({ txns: [...before, txn('t1', 'sell', 'AAA', 100, 110, '2026-09-03')], histories: { AAA, VNINDEX: BENCH }, ...PERIOD });
    expect(closed.rows[0].held).toBe(false);
    expect(closed.rows[0].closed).toBe(true);
    expect(closed.rows[0].pnl).toBeCloseTo(100 * 110 - 100 * 100, 6);
  });
  it('mã không có giá lịch sử: không bịa số, đưa vào danh sách thiếu', () => {
    const r = AttributionCalc.analyze({ txns: [txn('t1', 'buy', 'BBB', 10, 50, '2026-08-01')], histories: { VNINDEX: BENCH }, ...PERIOD });
    expect(r.rows[0].priceMissing).toBe(true);
    expect(r.rows[0].pnl).toBeNull();
    expect(r.missing).toEqual(['BBB']);
    expect(r.totals.pnl).toBe(0);
  });
  it('không có chuẩn: vẫn có lãi/lỗ, không có phần do thị trường', () => {
    const r = AttributionCalc.analyze({ txns: [txn('t1', 'buy', 'AAA', 100, 100, '2026-09-01')], histories: { AAA }, ...PERIOD });
    expect(r.hasBench).toBe(false);
    expect(r.rows[0].pnl).toBeCloseTo(2100, 6);
    expect(r.rows[0].benchPnl).toBeNull();
    expect(r.totals.activePnl).toBeNull();
  });
});

describe('analyze: tổng hợp, ngành, đối chiếu NAV', () => {
  const FPT = series([100, 100, 100, 100, 100, 110]);          // +10%
  const VCB = series([200, 200, 200, 200, 200, 180]);          // −10%
  const HPG = series([50, 50, 50, 50, 50, 60]);                // +20%
  const txns = [txn('a', 'buy', 'FPT', 100, 100, '2026-09-01'), txn('b', 'buy', 'VCB', 50, 200, '2026-09-01'), txn('c', 'buy', 'HPG', 100, 50, '2026-09-01')];
  const nav = [
    { snapshot_date: '2026-08-31', nav: 100000, net_contributed: 100000, cash: 100000 },
    { snapshot_date: '2026-09-07', nav: 100000 + 1000 - 500 + 1000, net_contributed: 100000, cash: 100000 - 25000 },
  ];
  const r = AttributionCalc.analyze({ txns, histories: { FPT, VCB, HPG, VNINDEX: BENCH }, navHistory: nav, ...PERIOD });
  it('lãi/lỗ từng mã, xếp theo độ lớn; người thắng/thua', () => {
    expect(r.rows.map(x => x.symbol)).toEqual(['FPT', 'HPG', 'VCB']);   // cùng |1.000| -> xếp theo mã
    expect(r.rows.find(x => x.symbol === 'FPT').pnl).toBeCloseTo(1000, 6);
    expect(r.rows.find(x => x.symbol === 'VCB').pnl).toBeCloseTo(-1000, 6);
    expect(r.rows.find(x => x.symbol === 'HPG').pnl).toBeCloseTo(1000, 6);
    expect(r.totals.pnl).toBeCloseTo(1000, 6);
    expect(r.breadth).toMatchObject({ winners: 2, losers: 1 });
    expect(r.breadth.profitFactor).toBeCloseTo(2, 6);
    expect(r.best.map(x => x.symbol).sort()).toEqual(['FPT', 'HPG']);
    expect(r.worst.map(x => x.symbol)).toEqual(['VCB']);
  });
  it('đóng góp % theo mẫu số NAV đầu kỳ + ½ vốn nạp ròng; cộng lại = lợi suất kỳ', () => {
    expect(r.baseKind).toBe('nav');
    expect(r.base).toBe(100000);
    expect(r.totals.contributionPct).toBeCloseTo(1, 6);
    expect(r.rows.find(x => x.symbol === 'FPT').contributionPct).toBeCloseTo(1, 6);
    expect(r.rows.reduce((s, x) => s + x.contributionPct, 0)).toBeCloseTo(r.totals.contributionPct, 6);
  });
  it('gộp theo ngành: Công nghệ, Ngân hàng, Thép', () => {
    const by = Object.fromEntries(r.sectors.map(s => [s.sector, s.pnl]));
    expect(by['Công nghệ']).toBeCloseTo(1000, 6);
    expect(by['Ngân hàng']).toBeCloseTo(-1000, 6);
    expect(by['Thép & vật liệu']).toBeCloseTo(1000, 6);
    expect(r.sectors.reduce((s, x) => s + x.pnl, 0)).toBeCloseTo(r.totals.pnl, 6);
  });
  it('đối chiếu NAV thực tế: lệnh ghi đủ thì chênh lệch chưa giải thích ≈ 0; thiếu thì lộ ra', () => {
    expect(r.totals.actualPnl).toBeCloseTo(1500, 6);        // 101.500 − 100.000 − 0 vốn nạp
    expect(r.totals.unexplained).toBeCloseTo(500, 6);       // NAV tăng nhiều hơn sổ lệnh giải thích được
    const exact = AttributionCalc.analyze({ txns, histories: { FPT, VCB, HPG, VNINDEX: BENCH }, navHistory: [nav[0], { ...nav[1], nav: 101000 }], ...PERIOD });
    expect(exact.totals.unexplained).toBeCloseTo(0, 6);
  });
  it('chi phí cơ hội của tiền mặt khi thị trường tăng', () => {
    // chuẩn tăng 2,01% cả kỳ (D[0]→D[5]), tiền mặt đầu kỳ 100.000 -> chi phí cơ hội ≈ −2.010
    expect(r.totals.cashBenchPnl).toBeCloseTo(100000 * (1020.1 / 1000 - 1), 6);
    expect(r.totals.cashActivePnl).toBeCloseTo(-r.totals.cashBenchPnl, 6);
  });
  it('thiếu lịch sử NAV: mẫu số quay về vốn bình quân đã đầu tư', () => {
    const x = AttributionCalc.analyze({ txns, histories: { FPT, VCB, HPG, VNINDEX: BENCH }, ...PERIOD });
    expect(x.baseKind).toBe('invested');
    expect(x.base).toBeGreaterThan(0);
    expect(x.totals.actualPnl).toBeNull();
  });
});

describe('periodFor', () => {
  it('các mốc nhanh tính từ cuối kỳ trước; không lùi quá ngày giao dịch đầu', () => {
    expect(AttributionCalc.periodFor('mtd', '2026-10-04')).toEqual({ from: '2026-09-30', to: '2026-10-04' });
    expect(AttributionCalc.periodFor('qtd', '2026-10-04')).toEqual({ from: '2026-09-30', to: '2026-10-04' });
    expect(AttributionCalc.periodFor('qtd', '2026-08-15').from).toBe('2026-06-30');
    expect(AttributionCalc.periodFor('ytd', '2026-10-04').from).toBe('2025-12-31');
    expect(AttributionCalc.periodFor('1y', '2026-10-04', '2026-06-10').from).toBe('2026-06-09');
    expect(AttributionCalc.periodFor('all', '2026-10-04', '2026-06-10').from).toBe('2026-06-09');
  });
});

describe('byDecision', () => {
  const dec = (id, action, extra = {}) => ({ id, symbol: 'AAA', action, confidence: null, tags: [], valuation: null, ...extra });
  const ev = (returnPct, alphaPct, status = 'open') => ({ status, returnPct, alphaPct });
  const plan = (complete) => () => ({ complete });
  it('nhóm theo kế hoạch đầy đủ/thiếu, mức tự tin, định giá lúc quyết định, thẻ', () => {
    const list = [
      dec('1', 'buy', { confidence: 5, tags: ['dài hạn'], valuation: { verdict: 'cheap' } }), dec('2', 'buy', { confidence: 5, tags: ['dài hạn', 'công nghệ'], valuation: { verdict: 'cheap' } }),
      dec('3', 'buy', { confidence: 4, tags: ['công nghệ'], valuation: { verdict: 'fair' } }), dec('4', 'buy', { confidence: 2, valuation: { verdict: 'expensive' } }),
      dec('5', 'buy', { confidence: 1 }), dec('6', 'buy', { confidence: 2 }),
    ];
    const evals = { 1: ev(30, 10), 2: ev(20, 8), 3: ev(10, 2), 4: ev(-10, -12), 5: ev(-5, -6), 6: ev(5, -1) };
    const planOf = (d) => ({ complete: ['1', '2', '3'].includes(d.id) });
    const r = AttributionCalc.byDecision(list, evals, planOf);
    expect(r.buys).toBe(6);
    expect(r.overall.winRatePct).toBeCloseTo(4 / 6 * 100, 6);
    const complete = r.byPlan.find(g => g.key === 'complete'), partial = r.byPlan.find(g => g.key === 'partial');
    expect(complete.n).toBe(3); expect(complete.avgAlphaPct).toBeCloseTo((10 + 8 + 2) / 3, 6);
    expect(partial.avgAlphaPct).toBeLessThan(0);
    expect(r.byConfidence.map(g => g.key)).toEqual(['1', '2', '4', '5']);
    expect(r.byVerdict.find(g => g.key === 'cheap').n).toBe(2);
    expect(r.byTag.map(g => g.key).sort()).toEqual(['công nghệ', 'dài hạn']);
    expect(r.byTag.find(g => g.key === 'dài hạn').avgReturnPct).toBeCloseTo(25, 6);
    expect(r.calibration).toMatchObject({ highN: 3, lowN: 3, ok: true, calibrated: true });
  });
  it('quyết định bán/bỏ qua đánh giá bằng giá sau đó; không lẫn vào lợi suất mua', () => {
    const list = [dec('1', 'buy'), dec('2', 'sell'), dec('3', 'sell'), dec('4', 'skip'), dec('5', 'sell')];
    const evals = { 1: ev(10, 5), 2: { status: 'sold_well', afterPct: -15 }, 3: { status: 'sold_early', afterPct: 20 }, 4: { status: 'avoided', afterPct: -12 }, 5: { status: 'neutral', afterPct: 1 } };
    const r = AttributionCalc.byDecision(list, evals, plan(true));
    expect(r.sells).toBe(4);
    expect(r.sellQuality).toMatchObject({ total: 4, good: 2, bad: 1, neutral: 1 });
    expect(r.sellQuality.goodPct).toBe(50);
    expect(r.overall.n).toBe(1);
  });
  it('bỏ quyết định chưa có dữ liệu đánh giá; danh sách rỗng không lỗi', () => {
    const r = AttributionCalc.byDecision([dec('1', 'buy'), dec('2', 'buy')], { 1: { status: 'nodata' } }, plan(true));
    expect(r.total).toBe(0);
    expect(AttributionCalc.byDecision([], {}, plan(true)).overall.n).toBe(0);
    expect(AttributionCalc.byDecision(null, null).total).toBe(0);
  });
});
