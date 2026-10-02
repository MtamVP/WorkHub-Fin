// lib/monthly-report.js: báo cáo cuối tháng (chỉ số liệu) tính từ dữ liệu thô, và các sheet Excel xuất ra.
import { describe, it, expect } from 'vitest';
import MonthlyReport from '../../lib/monthly-report.js';
import XlsxWriter from '../../lib/xlsx-writer.js';
import vm from 'node:vm';
import fs from 'node:fs';
import StatementImport from '../../lib/statement-import.js';

const nav = (d, v, c) => ({ snapshot_date: d, nav: v, net_contributed: c });
const txn = (id, type, symbol, quantity, price, trade_date, extra = {}) => ({ id, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z', ...extra });

// Tháng 9/2026. Có nạp thêm 100tr ngày 15/9 (lợi suất ngày đó phải bị loại khỏi TWR).
function sample(overrides = {}) {
  return Object.assign({
    month: '2026-09', email: 'a@b.c', cash: 50e6, debt: 0,
    navHistory: [
      nav('2026-08-31', 1000e6, 1000e6), nav('2026-09-05', 1010e6, 1000e6), nav('2026-09-12', 1020.1e6, 1000e6),
      nav('2026-09-15', 1130e6, 1100e6),                      // nạp 100tr
      nav('2026-09-19', 1140e6, 1100e6), nav('2026-09-26', 1120e6, 1100e6), nav('2026-09-30', 1150e6, 1100e6),
    ],
    benchmark: [],
    histories: {
      VNINDEX: [['2026-08-31', 1200], ['2026-09-07', 1212], ['2026-09-14', 1230], ['2026-09-21', 1224], ['2026-09-28', 1260], ['2026-09-30', 1250]],
      SSI: [['2026-08-31', 29000], ['2026-09-01', 29500], ['2026-09-03', 30000], ['2026-09-10', 31000], ['2026-09-18', 32500], ['2026-09-20', 33000], ['2026-09-24', 34000], ['2026-09-30', 33500]],
      VHM: [['2026-08-31', 70000], ['2026-09-10', 70000], ['2026-09-20', 69000], ['2026-09-30', 68000]],
      FPT: [['2026-08-31', 100000], ['2026-09-30', 105000]],
    },
    txns: [
      txn('t0', 'buy', 'FPT', 100, 100000, '2026-08-20'),
      txn('t1', 'buy', 'SSI', 1000, 30000, '2026-09-03', { fee: 45000 }),
      txn('t2', 'buy', 'VHM', 100, 70000, '2026-09-10', { fee: 10500 }),
      txn('t3', 'sell', 'SSI', 500, 33000, '2026-09-20', { fee: 24750, tax: 16500 }),
    ],
    actions: [], cashFlows: [{ flow_type: 'deposit', amount: 100e6, flow_date: '2026-09-15' }, { flow_type: 'dividend', amount: 500000, flow_date: '2026-09-22', symbol: 'FPT' }],
    holdingsNow: [
      { symbol: 'FPT', quantity: 100, marketPrice: 105000, marketValue: 10.5e6, targetPrice: 120000, stopLoss: 90000, upsidePct: 14.3 },
      { symbol: 'SSI', quantity: 500, marketPrice: 33500, marketValue: 16.75e6, targetPrice: 40000, stopLoss: 0, upsidePct: 19.4 },
      { symbol: 'VHM', quantity: 100, marketPrice: 68000, marketValue: 6.8e6, targetPrice: 0, stopLoss: 0, upsidePct: null },
    ],
    watchlist: [{ symbol: 'HPG', targetPrice: 30000, upsidePct: 25, price: 24000 }],
  }, overrides);
}

describe('monthBounds', () => {
  it('tháng đã kết thúc: kỳ đủ tháng; tháng đang chạy: kết thúc ở hôm nay', () => {
    expect(MonthlyReport.monthBounds('2026-09', '2026-10-02')).toMatchObject({ start: '2026-09-01', end: '2026-09-30', isPartial: false, label: 'Tháng 9/2026' });
    expect(MonthlyReport.monthBounds('2026-10', '2026-10-02')).toMatchObject({ start: '2026-10-01', end: '2026-10-02', fullEnd: '2026-10-31', isPartial: true });
  });
  it('năm nhuận tháng 2', () => {
    expect(MonthlyReport.monthBounds('2028-02', '2028-03-05').end).toBe('2028-02-29');
  });
});

describe('twrSeries: bỏ lợi suất ngày có nạp/rút vốn', () => {
  it('ngày nạp vốn giữ nguyên chỉ số', () => {
    const s = MonthlyReport.twrSeries(sample().navHistory);
    const idx = Object.fromEntries(s.map(r => [r.date, r.idx]));
    expect(idx['2026-09-15']).toBeCloseTo(idx['2026-09-12'], 10);     // KHÔNG tính bước nhảy 1020,1 -> 1130 (do nạp 100tr)
    expect(idx['2026-09-19']).toBeCloseTo(idx['2026-09-12'] * (1140 / 1130), 10);
  });
});

describe('compute — KPI tháng', () => {
  const r = MonthlyReport.compute(sample(), { todayIso: '2026-10-02' });
  const twr = 1.01 * (1020.1 / 1010) * (1140 / 1130) * (1120 / 1140) * (1150 / 1120);

  it('lợi suất danh mục = TWR nối, benchmark = lợi suất VN-Index, alpha = hiệu hai số', () => {
    expect(r.kpi.portfolioReturnPct).toBeCloseTo((twr - 1) * 100, 1);
    expect(r.kpi.benchmarkReturnPct).toBeCloseTo((1250 / 1200 - 1) * 100, 1);
    expect(r.kpi.alphaPct).toBeCloseTo(r.kpi.portfolioReturnPct - r.kpi.benchmarkReturnPct, 1);
  });

  it('max drawdown âm, lấy từ đoạn sụt 19/9 -> 26/9 trên chỉ số TWR', () => {
    expect(r.kpi.maxDrawdownPct).toBeCloseTo((1120 / 1140 - 1) * 100, 1);
  });

  it('NAV đầu/cuối, dòng tiền và lãi/lỗ đã loại phần nạp thêm', () => {
    expect(r.kpi.navStart).toBe(1000e6);
    expect(r.kpi.navEnd).toBe(1150e6);
    expect(r.kpi.netContributions).toBe(100e6);
    expect(r.kpi.pnlMonth).toBe(50e6);                               // 1150 - 1000 - 100
    expect(r.kpi.dividends).toBe(500000);
  });

  it('lãi/lỗ đã chốt gộp và ròng của lệnh bán SSI trong tháng', () => {
    // bán 500 @ 33.000, vốn 500 @ 30.000 => gộp 1.500.000; ròng = gộp - phí mua phân bổ (22.500) - phí bán 24.750 - thuế 16.500
    expect(r.kpi.realizedGrossPnl).toBe(1500000);
    expect(r.kpi.realizedNetPnl).toBeCloseTo(1500000 - 22500 - 24750 - 16500, 0);
    expect(r.kpi.hitRatePct).toBe(100);
    expect(r.kpi.tradesCount).toBe(3);
    expect(r.kpi.buysCount).toBe(2);
    expect(r.kpi.feesAndTaxes).toBe(45000 + 10500 + 24750 + 16500);
  });
});

describe('compute — đường lũy kế & chỉ số thị trường', () => {
  const r = MonthlyReport.compute(sample(), { todayIso: '2026-10-02' });

  it('Start = 0, W1..W4 rồi Month-end; mốc cuối khớp lợi suất tháng', () => {
    expect(r.cumulative.map(c => c.label)).toEqual(['Start', 'W1', 'W2', 'W3', 'W4', 'Month-end']);
    expect(r.cumulative[0]).toMatchObject({ portfolio: 0, benchmark: 0 });
    expect(r.cumulative[5].portfolio).toBeCloseTo(r.kpi.portfolioReturnPct, 2);
    expect(r.cumulative[5].benchmark).toBeCloseTo(r.kpi.benchmarkReturnPct, 2);
    // W1 = 7/9: VN-Index 1212 so với 1200 = +1%
    expect(r.cumulative[1].benchmark).toBeCloseTo(1, 1);
  });

  it('Market Index gốc 100 tại W1 đúng như mẫu', () => {
    expect(r.marketIndex.map(c => c.label)).toEqual(['W1', 'W2', 'W3', 'W4', 'Month-end']);
    expect(r.marketIndex[0].market).toBe(100);
    expect(r.marketIndex[4].market).toBeCloseTo(1250 / 1212 * 100, 1);
    expect(r.marketIndex[0].universe).toBe(100);
  });
});

describe('compute — quyết định, đóng góp, phân tích sâu', () => {
  const r = MonthlyReport.compute(sample(), { todayIso: '2026-10-02' });

  it('liệt kê MUA/BÁN trong tháng và GIỮ cho mã không giao dịch', () => {
    const actions = r.decisions.map(d => d.symbol + ':' + d.action).sort();
    expect(actions).toEqual(['FPT:HOLD', 'SSI:BUY', 'SSI:SELL', 'VHM:BUY']);
  });

  it('MUA tính theo giá cuối tháng, BÁN theo lãi ròng, GIỮ theo biến động giá', () => {
    const by = Object.fromEntries(r.decisions.map(d => [d.symbol + ':' + d.action, d]));
    expect(by['SSI:BUY'].outcomePct).toBeCloseTo((33500 / 30000 - 1) * 100, 2);
    expect(by['SSI:BUY'].pnl).toBeCloseTo((33500 - 30000) * 1000 - 45000, 0);
    expect(by['VHM:BUY'].outcomePct).toBeCloseTo((68000 / 70000 - 1) * 100, 2);
    expect(by['SSI:SELL'].pnl).toBeCloseTo(1500000 - 22500 - 24750 - 16500, 0);
    expect(by['FPT:HOLD'].outcomePct).toBeCloseTo(5, 6);
    expect(by['SSI:BUY'].contributionPct).toBeCloseTo(by['SSI:BUY'].pnl / 1000e6 * 100, 2);
    expect(by['SSI:BUY'].sizePctNav).toBeGreaterThan(0);
  });

  it('top đóng góp xếp theo trị tuyệt đối, tối đa 5', () => {
    expect(r.contribution.length).toBeLessThanOrEqual(5);
    const vals = r.contribution.map(c => Math.abs(c.contributionPct));
    expect([...vals].sort((a, b) => b - a)).toEqual(vals);
    expect(r.contribution[0].label).toMatch(/SSI Mua/);
  });

  it('phân tích sâu mặc định chọn quyết định đóng góp lớn nhất; giá tương đối gốc 100 tại T-10', () => {
    const dd = r.deepDive;
    expect(dd.symbol).toBe('SSI');
    expect(dd.action).toBe('BUY');
    expect(dd.entryPrice).toBe(30000);
    expect(dd.horizonDays).toBe(17);                                 // 3/9 -> bán 20/9
    expect(dd.relativePrice).toHaveLength(7);
    expect(dd.relativePrice.find(p => p.label === 'Decision').date).toBe('2026-09-03');
    const firstWithData = dd.relativePrice.find(p => p.asset !== null);
    expect(firstWithData.asset).toBe(100);
  });

  it('kỳ vọng vs thực tế: kỳ vọng từ giá mục tiêu hiện tại, peak gain & drawdown từ giá thật', () => {
    const e = Object.fromEntries(r.deepDive.expectedVsRealized.map(x => [x.label, x]));
    expect(e['Return'].expected).toBeCloseTo((40000 / 30000 - 1) * 100, 2);
    expect(e['Peak gain'].realized).toBeCloseTo((34000 / 30000 - 1) * 100, 2);
    expect(e['Max drawdown'].realized).toBeCloseTo((33500 / 34000 - 1) * 100, 2);
    expect(e['Max drawdown'].expected).toBeNull();                   // SSI chưa đặt cắt lỗ
  });

  it('lựa chọn thay thế: mã khác có upside cao nhất (đang giữ + theo dõi) + tiền mặt = 0', () => {
    const alts = r.deepDive.alternatives;
    expect(alts[0].label).toMatch(/SSI/);
    expect(alts[1].label).toBe('HPG');                               // 25% là cao nhất trong số mã khác
    expect(alts[alts.length - 1]).toEqual({ label: 'Cash / wait', upsidePct: 0 });
  });

  it('chọn tay lệnh để phân tích sâu', () => {
    const r2 = MonthlyReport.compute(sample(), { todayIso: '2026-10-02', deepDiveTxnId: 't2' });
    expect(r2.deepDive.symbol).toBe('VHM');
  });
});

describe('compute — thiếu dữ liệu thì để trống kèm cảnh báo, không bịa số', () => {
  it('không có giá lịch sử: KPI từ NAV vẫn có, mục cần giá theo ngày để trống', () => {
    const r = MonthlyReport.compute(sample({ histories: {}, historyError: 'Failed to fetch' }), { todayIso: '2026-10-02' });
    expect(r.kpi.portfolioReturnPct).not.toBeNull();
    expect(r.kpi.benchmarkReturnPct).toBeNull();
    expect(r.kpi.alphaPct).toBeNull();
    expect(r.meta.warnings.some(w => /Failed to fetch/.test(w))).toBe(true);
    expect(r.deepDive === null || r.deepDive.hasPriceHistory === false).toBe(true);
  });

  it('chưa có NAV nào: lợi suất để trống', () => {
    const r = MonthlyReport.compute(sample({ navHistory: [] }), { todayIso: '2026-10-02' });
    expect(r.kpi.portfolioReturnPct).toBeNull();
    expect(r.meta.warnings.some(w => /NAV/.test(w))).toBe(true);
    expect(r.cumulative[1].portfolio).toBeNull();
  });

  it('tháng không có giao dịch: bảng quyết định chỉ còn các mã đang giữ', () => {
    const r = MonthlyReport.compute(sample({ month: '2026-08', txns: [txn('t0', 'buy', 'FPT', 100, 100000, '2026-07-20')], navHistory: [nav('2026-07-31', 100e6, 100e6), nav('2026-08-31', 101e6, 100e6)], histories: { FPT: [['2026-07-31', 98000], ['2026-08-31', 100000]], VNINDEX: [['2026-07-31', 1000], ['2026-08-31', 1010]] } }), { todayIso: '2026-10-02' });
    expect(r.kpi.tradesCount).toBe(0);
    expect(r.decisions.every(d => d.action === 'BUY' || d.action === 'HOLD')).toBe(true);
  });
});

describe('toSheets + Excel', () => {
  const r = MonthlyReport.compute(sample(), { todayIso: '2026-10-02' });

  it('đủ 9 sheet đặt tên theo slide, mỗi bảng biểu đồ có cột A là nhãn', () => {
    const sheets = MonthlyReport.toSheets(r);
    expect(sheets.map(s => s.name)).toEqual(['00_Huong_dan', '01_KPI', '02_Cumulative', '03_MarketIndex', '04_Decisions', '05_Contribution', '06_DeepDive', '07_Process', '08_Placeholders', '09_Journal']);
    const cum = sheets.find(s => s.name === '02_Cumulative');
    expect(cum.rows.slice(1, 7).map(row => row[0])).toEqual(['Start', 'W1', 'W2', 'W3', 'W4', 'Month-end']);
  });

  it('ghi ra .xlsx rồi đọc lại đúng số liệu quan trọng', async () => {
    const bytes = XlsxWriter.build(MonthlyReport.toSheets(r));
    const sheets = await StatementImport.readXlsx(bytes);
    expect(sheets.map(s => s.name)).toHaveLength(10);
    const kpi = sheets.find(s => s.name === '01_KPI').rows;
    const row = (label) => kpi.find(x => x[0] === label);
    expect(row('PORTFOLIO RETURN (TWR)')[1]).toBeCloseTo(r.kpi.portfolioReturnPct, 2);
    expect(row('BENCHMARK (VN-Index)')[1]).toBeCloseTo(r.kpi.benchmarkReturnPct, 2);
    expect(row('NAV cuối tháng')[1]).toBe(1150e6);
    const ph = sheets.find(s => s.name === '08_Placeholders').rows;
    expect(ph.find(x => x[1] === 'PORTFOLIO RETURN')[2]).toMatch(/^\+\d/);
    expect(ph.find(x => x[1] === 'MAX DRAWDOWN')[2]).toMatch(/^−\d/);
  });

  it('JSON hoá được (dùng cho nút xuất JSON)', () => {
    const json = JSON.parse(JSON.stringify(r));
    expect(json.kpi.monthLabel).toBe('Tháng 9/2026');
    expect(json.placeholders.length).toBeGreaterThan(5);
  });
});

describe('chạy như trong trình duyệt (script thường, không có require/module)', () => {
  it('monthly-report.js tìm thấy PortfolioCalc dù const ở cấp script KHÔNG phải thuộc tính của window', () => {
    const sandbox = { console };
    sandbox.window = sandbox;                       // window.PortfolioCalc sẽ là undefined, giống trình duyệt thật
    vm.createContext(sandbox);
    ['lib/portfolio-calc.js', 'lib/decision-journal.js', 'lib/monthly-report.js'].forEach(f => vm.runInContext(fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8'), sandbox));
    const report = vm.runInContext('MonthlyReport.compute(' + JSON.stringify(sample()) + ', { todayIso: "2026-10-02" })', sandbox);
    expect(report.kpi.tradesCount).toBe(3);
    expect(report.decisions.length).toBe(4);
  });
});

describe('compute — nhật ký quyết định', () => {
  // t1 = mua SSI 3/9 (giá 30.000); t2 = mua VHM 10/9; t3 = bán SSI 20/9. Nhật ký: ghi đủ cho t1, thiếu cắt lỗ cho t2, t3 chưa ghi.
  const jr = (o) => Object.assign({ id: 'j', symbol: 'SSI', action: 'buy', decided_at: '2026-09-03', price_at_decision: 30000, quantity: 1000, reason: 'Lợi nhuận phục hồi, định giá hợp lý', expected_price: 34000, stop_price: 27000, horizon_months: 6, confidence: 4, tags: [], valuation: null, txn_id: 't1', review_date: null, review_rating: null, review_note: null, lesson: null }, o || {});
  const journal = [
    jr(),
    jr({ id: 'j2', symbol: 'VHM', decided_at: '2026-09-10', price_at_decision: 70000, quantity: 100, expected_price: 80000, stop_price: null, txn_id: 't2', confidence: null }),
    jr({ id: 'j3', symbol: 'MWG', action: 'skip', decided_at: '2026-09-12', price_at_decision: null, txn_id: null, reason: 'Định giá đang quá đắt so với lịch sử', expected_price: null, stop_price: null }),
    jr({ id: 'jold', symbol: 'FPT', decided_at: '2026-08-20', price_at_decision: 100000, quantity: 100, expected_price: 120000, stop_price: 90000, txn_id: 't0' }),   // ra từ tháng trước, vẫn mở
  ];
  const r = MonthlyReport.compute(sample({ journal }), { todayIso: '2026-10-02' });

  it('gắn lý do + kỳ vọng vào từng dòng DECISION LOG theo lệnh; lệnh chưa ghi thì không có', () => {
    const byTxn = Object.fromEntries(r.decisions.filter(d => d.txnId).map(d => [d.txnId, d]));
    expect(byTxn.t1.journal).toMatchObject({ reason: 'Lợi nhuận phục hồi, định giá hợp lý', expected: 34000, stop: 27000, horizonMonths: 6 });
    expect(byTxn.t1.journal.planScore).toBe(100);
    expect(byTxn.t2.journal.planScore).toBe(65);                      // lý do 30 + mục tiêu 25 + thời hạn 10
    expect(byTxn.t3.journal).toBeUndefined();
  });
  it('trạng thái quyết định theo giá đóng cửa trong tháng: SSI chạm mục tiêu 34.000 ngày 24/9', () => {
    const e = r.journal.entries.find(x => x.symbol === 'SSI');
    expect(e.status).toBe('target_hit');
    expect(e.hitDate).toBe('2026-09-24');
    expect(e.returnPct).toBeCloseTo((33500 / 30000 - 1) * 100, 2);
    expect(e.alphaPct).toBeCloseTo(e.returnPct - (1250 / 1200 - 1) * 100, 1);
  });
  it('quyết định tháng trước còn mở được liệt kê kèm cờ "mở từ trước kỳ" và KHÔNG tính vào tổng hợp tháng', () => {
    const old = r.journal.entries.find(x => x.symbol === 'FPT');
    expect(old.carried).toBe(true);
    expect(old.status).toBe('open');
    expect(r.journal.summary.total).toBe(3);
  });
  it('chỉ số quy trình đo được từ nhật ký (thay cho "chấm tay")', () => {
    const p = Object.fromEntries(r.process.map(x => [x.label, x]));
    expect(p['Decision quality'].current).toBeCloseTo((100 + 65 + 85) / 3, 1);       // mua SSI 100 + mua VHM 65 (thiếu cắt lỗ, tự tin) + bỏ qua MWG 85
    expect(p['Decision quality'].note).toMatch(/QUY TRÌNH/);
    expect(p['Journal coverage'].current).toBeCloseTo(2 / 3 * 100, 1);          // 2 trên 3 lệnh trong tháng
    expect(p['Full-plan rate'].current).toBeCloseTo(2 / 3 * 100, 1);            // j2 mua nhưng thiếu cắt lỗ -> chưa đủ; j và j3 đủ
    expect(p['Target-hit rate'].current).toBe(50);                               // 1 trong 2 lệnh mua đã đánh giá
    expect(r.kpi).toMatchObject({ journalCount: 3, journalTargetHit: 1, journalStopHit: 0 });
  });
  it('phân tích sâu dùng kỳ vọng ghi lúc quyết định thay vì giá mục tiêu hiện tại', () => {
    expect(r.deepDive.expectationSource).toBe('journal');
    expect(r.deepDive.journalReason).toMatch(/phục hồi/);
    const e = Object.fromEntries(r.deepDive.expectedVsRealized.map(x => [x.label, x]));
    expect(e['Return'].expected).toBeCloseTo((34000 / 30000 - 1) * 100, 2);       // mục tiêu nhật ký 34.000, không phải 40.000 hiện tại
    expect(e['Max drawdown'].expected).toBeCloseTo((27000 / 30000 - 1) * 100, 2); // cắt lỗ nhật ký 27.000
  });
  it('không có nhật ký: hành vi cũ — Decision quality để trống, kỳ vọng từ giá hiện tại', () => {
    const none = MonthlyReport.compute(sample(), { todayIso: '2026-10-02' });
    const p = Object.fromEntries(none.process.map(x => [x.label, x]));
    expect(p['Decision quality'].current).toBeNull();
    expect(p['Decision quality'].note).toMatch(/Chưa ghi nhật ký/);
    expect(p['Journal coverage'].current).toBe(0);
    expect(none.deepDive.expectationSource).toBe('current');
    expect(none.journal.entries).toEqual([]);
  });
  it('sheet 09_Journal có đủ dòng + cột kết quả; 04_Decisions có cột lý do/kỳ vọng', async () => {
    const sheets = MonthlyReport.toSheets(r);
    const jr9 = sheets.find(s => s.name === '09_Journal').rows;
    expect(jr9[0].map(c => c.v)).toEqual(expect.arrayContaining(['Lý do', 'Mục tiêu', 'Cắt lỗ', 'Điểm kế hoạch', 'Trạng thái', 'Alpha % vs VN-Index']));
    const ssi = jr9.find(row => row[1] === 'SSI');
    expect(ssi[2]).toBe('BUY');
    expect(ssi[12]).toBe('Đã chạm mục tiêu');
    expect(jr9.some(row => row[1] === 'FPT' && row[21] === 'Có')).toBe(true);
    const dec = sheets.find(s => s.name === '04_Decisions').rows;
    expect(dec[0].map(c => c.v)).toEqual(expect.arrayContaining(['Lý do (nhật ký)', 'Mục tiêu', 'Điểm kế hoạch']));
    const bytes = XlsxWriter.build(sheets);
    const back = await StatementImport.readXlsx(bytes);
    expect(back.map(s => s.name)).toContain('09_Journal');
  });
  it('tháng không có nhật ký vẫn xuất 09_Journal kèm hướng dẫn', () => {
    const none = MonthlyReport.compute(sample(), { todayIso: '2026-10-02' });
    const rows = MonthlyReport.toSheets(none).find(s => s.name === '09_Journal').rows;
    expect(JSON.stringify(rows)).toMatch(/chưa ghi quyết định nào/);
  });
});
