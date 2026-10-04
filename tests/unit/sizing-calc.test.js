// lib/sizing-calc.js: tính khối lượng theo ngân sách rủi ro, các trần (tiền mặt / giới hạn / thanh khoản), phân tích trước lệnh.
import { describe, it, expect } from 'vitest';
import S from '../../lib/sizing-calc.js';
import L from '../../lib/limits-calc.js';

const RATES = { buyFeeRate: 0.0015, sellFeeRate: 0.0015, sellTaxRate: 0.001 };
const lim = (o) => Object.assign({ id: 'l' + Math.random().toString(36).slice(2, 7), scope: 'member', user_id: null, kind: 'max_symbol_pct', symbol: null, sector: null, value: 25, mode: 'reason', note: '', active: true }, o);
const pf = (holdings, cash = 0, debt = 0) => ({ holdings: Object.entries(holdings).map(([symbol, value]) => ({ symbol, value })), cash, debt });

describe('riskPerShare', () => {
  it('lỗ mỗi cổ phiếu tới điểm cắt lỗ gồm cả phí mua, phí bán và thuế', () => {
    // mua 100.000, cắt lỗ 90.000: lỗ giá 10.000 + phí mua 150 + (phí bán 0,15% + thuế 0,1%) × 90.000 = 225
    expect(S.riskPerShare(100000, 90000, RATES)).toBeCloseTo(10000 + 150 + 225, 6);
    expect(S.riskPerShare(100000, 90000)).toBe(10000);
  });
  it('stop không hợp lệ -> null', () => {
    expect(S.riskPerShare(100000, 0)).toBeNull();
    expect(S.riskPerShare(100000, 100000)).toBeNull();
    expect(S.riskPerShare(100000, 120000)).toBeNull();
    expect(S.riskPerShare(0, 90)).toBeNull();
  });
});

describe('floorLot', () => {
  it('làm tròn xuống bội của lô', () => {
    expect(S.floorLot(1234)).toBe(1200);
    expect(S.floorLot(99)).toBe(0);
    expect(S.floorLot(-5)).toBe(0);
    expect(S.floorLot(250, 50)).toBe(250);
  });
});

describe('size: khối lượng theo ngân sách rủi ro', () => {
  const base = { nav: 1e9, cash: 1e9, price: 100000, stop: 90000, riskPct: 1, rates: RATES };
  it('= ngân sách rủi ro / lỗ mỗi cổ phiếu, làm tròn xuống lô, yếu tố chặn là rủi ro', () => {
    const r = S.size(base);
    // ngân sách 10tr / 10.375 = 963 -> 900
    expect(r.riskBudget).toBe(1e7);
    expect(r.caps.risk).toBe(900);
    expect(r.qty).toBe(900);
    expect(r.binding).toBe('risk');
  });
  it('mất đúng ngân sách rủi ro khi chạm stop (không vượt)', () => {
    const r = S.size(base);
    const a = S.assess(Object.assign({}, base, { qty: r.qty }));
    expect(a.maxLoss).toBeLessThanOrEqual(1e7);
    expect(a.maxLossPctNav).toBeLessThanOrEqual(1);
    expect(a.flags.find(f => f.key === 'overrisk')).toBeUndefined();
  });
  it('tiền mặt chặn khi ít hơn mức rủi ro cho phép', () => {
    const r = S.size(Object.assign({}, base, { cash: 30e6 }));
    expect(r.binding).toBe('cash');
    expect(r.qty).toBe(200);        // 30tr / 100.150 = 299 -> 200
    expect(r.qty * 100000 * 1.0015).toBeLessThanOrEqual(30e6);
  });
  it('thanh khoản chặn: không quá 3 phiên × 20% khối lượng trung bình ngày', () => {
    const r = S.size(Object.assign({}, base, { adv: 1000 }));
    expect(r.caps.liquidity).toBe(600);
    expect(r.qty).toBe(600);
    expect(r.binding).toBe('liquidity');
  });
  it('không có stop -> không đề xuất (tránh dồn hết tiền mặt) nhưng vẫn hiện các trần khác', () => {
    const r = S.size(Object.assign({}, base, { stop: 0, adv: 1e6 }));
    expect(r.qty).toBe(0);
    expect(r.binding).toBe('nostop');
    expect(r.caps.cash).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toMatch(/cắt lỗ/);
  });
  it('stop >= giá thì cảnh báo và không tính', () => {
    const r = S.size(Object.assign({}, base, { stop: 110000 }));
    expect(r.qty).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/thấp hơn giá mua/);
  });
  it('thiếu giá hoặc NAV không dương -> 0 kèm lời nhắc', () => {
    expect(S.size(Object.assign({}, base, { price: 0 })).qty).toBe(0);
    expect(S.size(Object.assign({}, base, { nav: 0 })).warnings.length).toBe(1);
  });
});

describe('size + giới hạn đầu tư', () => {
  // NAV 1 tỷ: FPT đã 150tr (15%), tiền 850tr. Trần một mã 20% => còn mua thêm tối đa 50tr ≈ 400 cổ ở giá 120.000 (cộng 40 cổ... tính theo lô)
  const PF = pf({ FPT: 150e6 }, 850e6);
  const rows = [lim({ value: 20, mode: 'block' })];
  it('giới hạn là yếu tố chặn và khối lượng không làm vi phạm', () => {
    const r = S.size({ nav: 1e9, cash: 850e6, price: 100000, stop: 90000, riskPct: 5, rates: RATES, limits: { LC: L, rows, pf: PF, symbol: 'FPT' } });
    expect(r.binding).toBe('limit');
    expect(r.limitBlocker).toBeTruthy();
    expect(r.qty).toBe(500);        // (20% × 1 tỷ − 150tr) / 100.000 = 500 cổ
    const chk = L.checkTrade(rows, PF, { type: 'buy', symbol: 'FPT', quantity: r.qty, price: 100000 });
    expect(chk.violations).toEqual([]);
    const over = L.checkTrade(rows, PF, { type: 'buy', symbol: 'FPT', quantity: r.qty + 100, price: 100000 });
    expect(over.violations.length).toBe(1);
  });
  it('mã đã vượt trần: không mua thêm được', () => {
    const r = S.size({ nav: 1e9, cash: 700e6, price: 100000, stop: 90000, riskPct: 5, rates: RATES, limits: { LC: L, rows, pf: pf({ FPT: 300e6 }, 700e6), symbol: 'FPT' } });
    expect(r.qty).toBe(0);
    expect(r.binding).toBe('limit');
    expect(r.warnings.join(' ')).toMatch(/Giới hạn/);
  });
  it('giới hạn ở chế độ cảnh báo không chặn khối lượng', () => {
    const warnRows = [lim({ value: 20, mode: 'warn' })];
    const r = S.size({ nav: 1e9, cash: 850e6, price: 100000, stop: 90000, riskPct: 1, rates: RATES, limits: { LC: L, rows: warnRows, pf: PF, symbol: 'FPT' } });
    expect(r.binding).toBe('risk');
    expect(r.qty).toBe(900);
  });
  it('mã bị cấm (chế độ chặn) -> 0', () => {
    const r = S.size({ nav: 1e9, cash: 850e6, price: 100000, stop: 90000, riskPct: 1, rates: RATES, limits: { LC: L, rows: [lim({ kind: 'blocked_symbol', symbol: 'ABC', mode: 'block', value: null })], pf: PF, symbol: 'ABC' } });
    expect(r.qty).toBe(0);
    expect(r.binding).toBe('limit');
  });
});

describe('maxQtyWithinLimits', () => {
  it('không có giới hạn: trả đúng mức trần truyền vào, làm tròn lô', () => {
    expect(S.maxQtyWithinLimits(L, [], pf({}, 1e9), { symbol: 'FPT', price: 1e5 }, 1234).qty).toBe(1200);
  });
  it('tiền mặt tối thiểu cũng được tôn trọng', () => {
    // NAV 1 tỷ, tiền 300tr, tối thiểu 25% => dùng tối đa 50tr nữa
    const r = S.maxQtyWithinLimits(L, [lim({ kind: 'min_cash_pct', value: 25, mode: 'block' })], pf({ VCB: 700e6 }, 300e6), { symbol: 'FPT', price: 100000 }, 10000);
    expect(r.qty).toBe(500);
    expect(r.binding.kind).toBe('min_cash_pct');
  });
});

describe('assess: phân tích trước lệnh', () => {
  const x = { nav: 1e9, cash: 500e6, price: 100000, stop: 90000, target: 130000, qty: 1000, currentValue: 50e6, adv: 20000, riskPct: 1, rates: RATES };
  it('tỷ trọng, lỗ tối đa, lời/lỗ kỳ vọng', () => {
    const a = S.assess(x);
    expect(a.value).toBe(100e6);
    expect(a.weightBefore).toBeCloseTo(5, 6);
    expect(a.weightAfter).toBeCloseTo(15, 6);
    expect(a.cashAfter).toBeCloseTo(500e6 - 100e6 - 150000, 3);
    expect(a.maxLoss).toBeCloseTo(1000 * 10375, 3);
    expect(a.maxLossPctNav).toBeCloseTo(1.0375, 4);
    expect(a.rewardRisk).toBeCloseTo((130000 * (1 - 0.0025) - 100150) / 10375, 4);
    expect(a.rewardRisk).toBeGreaterThan(2);
    expect(a.expectedGain).toBeCloseTo(1000 * (130000 * 0.9975 - 100150), 2);
  });
  it('thanh khoản: 1000 cổ / (20% × 20.000) = 0,25 phiên -> không cảnh báo', () => {
    const a = S.assess(x);
    expect(a.participationPct).toBeCloseTo(5, 6);
    expect(a.daysToTrade).toBeCloseTo(0.25, 6);
    expect(a.flags.find(f => f.key === 'liq')).toBeUndefined();
  });
  it('cảnh báo thanh khoản mỏng theo số phiên cần', () => {
    const warn = S.assess(Object.assign({}, x, { qty: 20000, adv: 20000 }));      // 5 phiên
    expect(warn.flags.find(f => f.key === 'liq').tone).toBe('warn');
    const bad = S.assess(Object.assign({}, x, { qty: 100000, adv: 20000 }));      // 25 phiên
    expect(bad.flags.find(f => f.key === 'liq').tone).toBe('bad');
  });
  it('cờ: thiếu stop, stop sai, vượt ngân sách rủi ro, lời/lỗ thấp, thiếu tiền, lô lẻ', () => {
    expect(S.assess(Object.assign({}, x, { stop: 0 })).flags.map(f => f.key)).toContain('nostop');
    expect(S.assess(Object.assign({}, x, { stop: 105000 })).flags.map(f => f.key)).toContain('badstop');
    expect(S.assess(Object.assign({}, x, { qty: 3000 })).flags.map(f => f.key)).toContain('overrisk');
    expect(S.assess(Object.assign({}, x, { target: 105000 })).flags.find(f => f.key === 'rr').tone).toBe('bad');
    expect(S.assess(Object.assign({}, x, { target: 118000 })).flags.find(f => f.key === 'rr').tone).toBe('warn');
    expect(S.assess(Object.assign({}, x, { cash: 10e6 })).flags.map(f => f.key)).toContain('cash');
    expect(S.assess(Object.assign({}, x, { qty: 1050 })).flags.map(f => f.key)).toContain('lot');
  });
  it('thiếu khối lượng hoặc giá: kết quả rỗng, không lỗi', () => {
    expect(S.assess({}).flags).toEqual([]);
    expect(S.assess({ price: 1e5 }).maxLoss).toBeNull();
  });
  it('không có dữ liệu khối lượng thì không có chỉ số thanh khoản', () => {
    const a = S.assess(Object.assign({}, x, { adv: 0 }));
    expect(a.participationPct).toBeNull();
    expect(a.daysToTrade).toBeNull();
  });
});
