// Dự báo dòng tiền mặt (lib/cashflow-calc.js): ngày tiền về T+2 có tính nghỉ lễ, gộp cổ tức / tiền bán chưa về / lệnh dự kiến / lãi vay, tuần thiếu tiền, tiền triển khai được.
import { describe, it, expect } from 'vitest';
import C from '../../lib/cashflow-calc.js';

const TODAY = '2026-10-12';               // thứ hai
const build = (o) => C.build(Object.assign({ today: TODAY, cash: 1e9, weeks: 4 }, o || {}));

describe('settle: ngày tiền về', () => {
  it('T+2 bỏ cuối tuần', () => {
    expect(C.settle('2026-10-14', 2)).toBe('2026-10-16');          // thứ tư -> thứ sáu
    expect(C.settle('2026-10-15', 2)).toBe('2026-10-19');          // thứ năm -> thứ hai
    expect(C.settle('2026-10-16', 2)).toBe('2026-10-20');          // thứ sáu -> thứ ba
  });
  it('T+2 bỏ ngày nghỉ lễ (nghỉ Quốc khánh 31/8-2/9/2026)', () => {
    expect(C.settle('2026-08-28', 2)).toBe('2026-09-04');
  });
  it('cuối tháng', () => { expect(C.monthEnd('2026-02-10')).toBe('2026-02-28'); expect(C.monthEnd('2026-12-31')).toBe('2026-12-31'); });
});

describe('build: gộp các nguồn', () => {
  it('cổ tức, tiền bán chưa về, lệnh mua/bán dự kiến vào đúng ngày; bán dự kiến về sau T+2', () => {
    const r = build({
      dividends: [{ date: '2026-10-20', symbol: 'FPT', amount: 5e7, kind: 'confirmed' }, { date: '2026-11-02', symbol: 'VNM', amount: 2e7, kind: 'estimated' }],
      pendingSells: [{ symbol: 'HPG', amount: 3e8, settleDate: '2026-10-13' }],
      planned: [{ kind: 'buy', date: '2026-10-14', amount: 4e8, symbol: 'MWG' }, { kind: 'sell', date: '2026-10-14', amount: 1e8, symbol: 'VNM' }],
    });
    const at = (d) => r.events.filter((e) => e.date === d).map((e) => e.kind + ':' + e.amount).sort();
    expect(at('2026-10-13')).toEqual(['sell_settle:300000000']);
    expect(at('2026-10-14')).toEqual(['plan_buy:-400000000']);
    expect(at('2026-10-16')).toEqual(['plan_sell:100000000']);
    expect(at('2026-10-20')).toEqual(['dividend:50000000']);
    expect(r.events.find((e) => e.symbol === 'VNM' && e.kind === 'dividend').sure).toBe(false);
  });
  it('số dư chạy đúng từng ngày và cuối kỳ', () => {
    const r = build({ pendingSells: [{ symbol: 'HPG', amount: 3e8, settleDate: '2026-10-13' }], planned: [{ kind: 'buy', date: '2026-10-14', amount: 4e8 }] });
    const bal = (d) => r.days.find((x) => x.date === d).balance;
    expect(bal('2026-10-12')).toBe(1e9); expect(bal('2026-10-13')).toBe(1.3e9); expect(bal('2026-10-14')).toBe(0.9e9); expect(r.summary.endBalance).toBe(0.9e9);
    expect(r.days[0].date).toBe(TODAY); expect(r.days.length).toBe(29);
  });
  it('khoản ngoài tầm nhìn hoặc đã qua bị bỏ; số tiền không dương bị bỏ', () => {
    const r = build({ dividends: [{ date: '2026-10-01', amount: 1e6 }, { date: '2027-06-01', amount: 1e6 }, { date: '2026-10-15', amount: 0 }], planned: [{ kind: 'buy', date: '2026-10-15', amount: -5 }] });
    expect(r.events).toEqual([]);
  });
  it('lệnh đặt từ ngày đã qua tính từ hôm nay', () => {
    const r = build({ planned: [{ kind: 'buy', date: '2026-09-01', amount: 1e8 }] });
    expect(r.events[0].date).toBe(TODAY);
  });
});

describe('build: thiếu tiền, đệm, tiền triển khai được', () => {
  it('phát hiện ngày đầu tiên âm, số dư thấp nhất và tuần có thiếu', () => {
    const r = build({ planned: [{ kind: 'buy', date: '2026-10-13', amount: 2e9, symbol: 'HPG' }], pendingSells: [{ amount: 1.5e9, settleDate: '2026-10-19' }] });
    expect(r.summary.firstShortfall).toBe('2026-10-13'); expect(r.summary.minBalance).toBe(-1e9); expect(r.summary.minDate).toBe('2026-10-13');
    expect(r.weeks[0].short).toBe(true); expect(r.weeks[1].short).toBe(false);
    expect(r.warnings.some((w) => w.key === 'short')).toBe(true); expect(r.summary.deployable).toBe(0);
  });
  it('tiền triển khai được = số dư thấp nhất trừ đệm, không âm', () => {
    const r = build({ buffer: 1e8, planned: [{ kind: 'buy', date: '2026-10-20', amount: 3e8 }] });
    expect(r.summary.minBalance).toBe(7e8); expect(r.summary.deployable).toBe(6e8);
    expect(build({ buffer: 2e9 }).summary.deployable).toBe(0); expect(build({ buffer: 2e9 }).summary.firstBelowBuffer).toBe(TODAY);
  });
  it('số dư thấp nhất nếu chỉ tính khoản chắc chắn: không dựa vào cổ tức ước tính', () => {
    const r = build({ cash: 1e7, planned: [{ kind: 'withdraw', date: '2026-10-20', amount: 5e7 }], dividends: [{ date: '2026-10-19', amount: 6e7, kind: 'estimated' }] });
    expect(r.summary.minBalance).toBe(1e7); expect(r.summary.minBalanceSure).toBe(-4e7);
    expect(r.warnings.some((w) => w.key === 'rely_estimate')).toBe(true);
  });
});

describe('lãi vay và cảnh báo lịch', () => {
  it('lãi trả cuối mỗi tháng trong tầm nhìn; không nhập lãi suất thì cảnh báo, không tự tính', () => {
    const r = C.build({ today: TODAY, cash: 1e9, weeks: 13, debt: 1.2e9, debtRate: 10 });
    const ints = r.events.filter((e) => e.kind === 'interest');
    expect(ints.map((e) => e.date)).toEqual(['2026-10-31', '2026-11-30', '2026-12-31']); expect(ints[0].amount).toBeCloseTo(-1e7, 3);
    const none = C.build({ today: TODAY, cash: 1e9, weeks: 4, debt: 1e9 });
    expect(none.events).toEqual([]); expect(none.warnings.some((w) => w.key === 'no_rate')).toBe(true);
  });
  it('tầm nhìn sang năm chưa có đủ lịch lễ thì báo', () => {
    expect(C.build({ today: TODAY, cash: 1, weeks: 13 }).warnings.some((w) => w.key === 'holidays_partial')).toBe(true);
    expect(C.build({ today: TODAY, cash: 1, weeks: 4 }).warnings.some((w) => w.key === 'holidays_partial')).toBe(false);
  });
});

describe('plannedFromOrders', () => {
  it('chỉ lấy đề xuất đang chờ/đã duyệt, chưa khớp, còn hạn; số tiền lấy từ value hoặc khối lượng x giá', () => {
    const o = C.plannedFromOrders([
      { id: 1, status: 'approved', symbol: 'A', side: 'buy', value: 5e7 },
      { id: 2, status: 'pending', symbol: 'B', side: 'sell', quantity: 1000, price_ref: 20000 },
      { id: 3, status: 'approved', symbol: 'C', side: 'buy', value: 1e7, txn_id: 'x' },
      { id: 4, status: 'rejected', symbol: 'D', side: 'buy', value: 1e7 },
      { id: 5, status: 'approved', symbol: 'E', side: 'buy', value: 1e7, valid_until: '2026-10-01' },
      { id: 6, status: 'approved', symbol: 'F', side: 'buy' },
    ], TODAY);
    expect(o.map((x) => x.symbol + ':' + x.kind + ':' + x.amount)).toEqual(['A:buy:50000000', 'B:sell:20000000']);
  });
});
