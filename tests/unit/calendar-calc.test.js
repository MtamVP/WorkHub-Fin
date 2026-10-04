// lib/calendar-calc.js: lịch sự kiện sắp tới, hạn công bố báo cáo, dự báo cổ tức 12 tháng (đã công bố + ước tính), suất cổ tức.
import { describe, it, expect } from 'vitest';
import C from '../../lib/calendar-calc.js';

const TODAY = '2026-10-04';
const buy = (id, symbol, quantity, price, trade_date) => ({ id, type: 'buy', symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z' });
const cash = (id, symbol, dps, exDate, payDate, extra = {}) => Object.assign({ id, symbol, kind: 'cash_dividend', exDate, payDate, dps, ratio: null, price: null, divYear: 2025, period: null, note: '' }, extra);
const stock = (id, symbol, ratio, exDate) => ({ id, symbol, kind: 'bonus', exDate, payDate: null, dps: null, ratio, price: null, note: '' });
const rights = (id, symbol, ratio, price, exDate, payDate) => ({ id, symbol, kind: 'rights', exDate, payDate, dps: null, ratio, price, note: 'cho CĐHH' });
const ctx = (extra = {}) => Object.assign({ today: TODAY, txns: [buy('a', 'FPT', 1000, 100000, '2025-01-10'), buy('b', 'VNM', 500, 70000, '2025-03-01')], actions: [], cashFlows: [], dismissed: [] }, extra);

describe('quý và hạn công bố báo cáo', () => {
  it('quý kết thúc gần nhất theo ngày', () => {
    expect(C.lastEndedQuarter('2026-10-04')).toMatchObject({ year: 2026, quarter: 3, end: '2026-09-30' });
    expect(C.lastEndedQuarter('2026-01-05')).toMatchObject({ year: 2025, quarter: 4, end: '2025-12-31' });
    expect(C.lastEndedQuarter('2026-03-31')).toMatchObject({ year: 2026, quarter: 1 });
    expect(C.quarterEnd(2026, 2)).toBe('2026-06-30');
  });
  it('mã đã có báo cáo quý vừa kết thúc -> mốc là quý kế tiếp; chưa có -> mốc quý vừa kết thúc', () => {
    const r = C.reportDeadlines(['FPT', 'VNM', 'HPG'], { FPT: '2026Q3', VNM: '2026Q2' }, TODAY);
    const by = Object.fromEntries(r.map(x => [x.symbol, x]));
    expect(by.FPT).toMatchObject({ period: '2026Q4', periodEnd: '2026-12-31', from: '2027-01-20', deadline: '2027-01-30', status: 'upcoming', tracked: true });
    expect(by.VNM).toMatchObject({ period: '2026Q3', from: '2026-10-20', deadline: '2026-10-30', status: 'expected', tracked: true });
    expect(by.HPG).toMatchObject({ period: '2026Q3', tracked: false });
  });
  it('trạng thái theo ngày: tới hạn, quá hạn khi mã đang theo dõi vẫn chưa có số mới', () => {
    expect(C.reportDeadlines(['VNM'], { VNM: '2026Q2' }, '2026-10-25')[0].status).toBe('due');
    expect(C.reportDeadlines(['VNM'], { VNM: '2026Q2' }, '2026-11-05')[0].status).toBe('late');
    expect(C.reportDeadlines(['HPG'], {}, '2026-11-05')[0].status).toBe('unknown');
  });
  it('ghi chú báo cáo soát xét bán niên / kiểm toán năm; sắp theo hạn', () => {
    const q2 = C.reportDeadlines(['A'], { A: '2026Q1' }, '2026-07-10')[0];
    expect(q2.period).toBe('2026Q2'); expect(q2.note).toMatch(/bán niên/);
    const q4 = C.reportDeadlines(['A', 'B'], { A: '2025Q3', B: '2025Q4' }, '2026-01-10');
    expect(q4[0].note || q4[1].note).toMatch(/kiểm toán/);
    const r = C.reportDeadlines(['Z', 'A'], {}, TODAY);
    expect(r.map(x => x.symbol)).toEqual(['A', 'Z']);
  });
});

describe('upcomingEvents', () => {
  it('cổ tức tiền sắp tới: ngày không hưởng quyền và ngày tiền về, đúng số tiền sau thuế', () => {
    const e = [cash('c1', 'FPT', 1000, '2026-10-20', '2026-11-05')];
    const u = C.upcomingEvents(e, ctx(), 90);
    expect(u.map(x => [x.date, x.kind])).toEqual([['2026-10-20', 'ex_date'], ['2026-11-05', 'pay_date']]);
    expect(u[0].amount).toBe(950000); expect(u[0].detail).toMatch(/1\.000 đ\/cp/);
    expect(u[1].detail).toMatch(/950\.000 đ sau thuế/);
  });
  it('đã qua ngày không hưởng quyền nhưng tiền chưa về: chỉ còn mốc tiền về; ngoài tầm nhìn hoặc đã ghi thì bỏ', () => {
    const e = [cash('c1', 'FPT', 1000, '2026-09-25', '2026-10-15'), cash('c2', 'FPT', 500, '2027-06-01', '2027-06-20')];
    expect(C.upcomingEvents(e, ctx(), 30).map(x => x.kind)).toEqual(['pay_date']);
    expect(C.upcomingEvents(e, ctx(), 400).map(x => x.date)).toEqual(['2026-10-15', '2027-06-01', '2027-06-20']);
    const recorded = ctx({ cashFlows: [{ flow_type: 'dividend', symbol: 'FPT', amount: 950000, flow_date: '2026-10-15', note: '#c1' }] });
    expect(C.upcomingEvents([e[0]], recorded, 30)).toEqual([]);
  });
  it('cổ phiếu thưởng và quyền mua có mốc riêng; mã không giữ bị bỏ', () => {
    const e = [stock('s1', 'FPT', 10, '2026-10-12'), rights('r1', 'VNM', 20, 50000, '2026-10-14', '2026-11-20'), cash('x', 'ZZZ', 1000, '2026-10-10', '2026-10-30')];
    const u = C.upcomingEvents(e, ctx(), 90);
    expect(u.map(x => [x.symbol, x.kind])).toEqual([['FPT', 'ex_date'], ['VNM', 'ex_date'], ['VNM', 'rights_deadline']]);
    expect(u[0].detail).toMatch(/thêm 100 cp/);
    expect(u[1].detail).toMatch(/Được mua 100 cp giá 50\.000/);
  });
});

describe('dividendForecast', () => {
  const QTY = { FPT: 1000, VNM: 500 };
  it('khoản đã công bố được tính theo tháng tiền về, kèm ghi chú', () => {
    const f = C.dividendForecast([cash('c1', 'FPT', 1000, '2026-10-20', '2026-11-05')], ctx(), QTY, 12);
    const nov = f.months.find(m => m.month === '2026-11');
    expect(nov.confirmed).toBe(950000); expect(nov.estimated).toBe(0);
    expect(f.confirmedTotal).toBe(950000);
    expect(f.months).toHaveLength(13);
    expect(f.months[0].month).toBe('2026-10');
  });
  it('ước tính: khoản đã trả 12 tháng qua lặp lại vào cùng thời điểm năm sau; không ước tính trùng khoản đã công bố', () => {
    const past = [cash('p1', 'VNM', 2000, '2026-05-10', '2026-05-25'), cash('p2', 'FPT', 1000, '2025-12-01', '2025-12-12')];
    const f = C.dividendForecast(past, ctx(), QTY, 12);
    expect(f.items.map(i => [i.symbol, i.date, i.kind])).toEqual([['FPT', '2026-12-12', 'estimated'], ['VNM', '2027-05-25', 'estimated']]);
    expect(f.estimatedTotal).toBe(1000 * 1000 * 0.95 + 500 * 2000 * 0.95);
    // FPT đã công bố khoản cuối năm -> không ước tính thêm cho tháng đó
    const covered = C.dividendForecast(past.concat([cash('n1', 'FPT', 1100, '2026-11-28', '2026-12-10')]), ctx(), QTY, 12);
    expect(covered.items.filter(i => i.symbol === 'FPT').map(i => i.kind)).toEqual(['confirmed']);
  });
  it('mã không còn giữ hoặc khoản trả quá cũ (> 12 tháng) không được ước tính; khoản ngoài tầm nhìn bỏ', () => {
    const f = C.dividendForecast([cash('o', 'FPT', 1000, '2025-05-01', '2025-05-20'), cash('g', 'GONE', 1000, '2026-03-01', '2026-03-10')], ctx(), QTY, 12);
    expect(f.items).toEqual([]);
    expect(C.dividendForecast([cash('e', 'FPT', 1000, '2025-12-01', '2025-12-12')], ctx(), QTY, 1).items).toEqual([]);   // 1 tháng: chưa tới 12/2026
  });
  it('khoản tới hạn nhưng chưa ghi sổ được tính vào hôm nay và ghi chú rõ', () => {
    const f = C.dividendForecast([cash('c1', 'FPT', 1000, '2026-09-20', '2026-10-01')], ctx(), QTY, 12);
    expect(f.items[0]).toMatchObject({ date: TODAY, kind: 'confirmed' });
    expect(f.items[0].note).toMatch(/chưa ghi/);
  });
  it('đã nhận 12 tháng qua theo Dòng Tiền, tách theo mã', () => {
    const flows = [{ flow_type: 'dividend', symbol: 'FPT', amount: 900000, flow_date: '2026-06-10' }, { flow_type: 'dividend', symbol: 'VNM', amount: 100000, flow_date: '2026-03-01' },
      { flow_type: 'dividend', symbol: 'FPT', amount: 777, flow_date: '2025-01-01' }, { flow_type: 'dividend', symbol: null, amount: 50000, flow_date: '2026-08-01' }, { flow_type: 'deposit', amount: 5, flow_date: '2026-08-01' }];
    const f = C.dividendForecast([], ctx({ cashFlows: flows }), QTY, 12);
    expect(f.receivedTrailing).toBe(1050000);
    expect(f.receivedBySymbol).toEqual({ FPT: 900000, VNM: 100000, '(không gắn mã)': 50000 });
  });
  it('suất cổ tức trên giá trị và giá vốn', () => {
    const f = { forwardTotal: 5e6, receivedTrailing: 4e6 };
    expect(C.yields(f, 200e6, 100e6)).toEqual({ forwardOnValuePct: 2.5, forwardOnCostPct: 5, trailingOnCostPct: 4 });
    expect(C.yields(f, 0, 0)).toEqual({ forwardOnValuePct: null, forwardOnCostPct: null, trailingOnCostPct: null });
  });
});
