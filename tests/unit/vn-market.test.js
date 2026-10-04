// lib/vn-market.js: biên độ giá, bước giá, trần/sàn, lô chẵn, T+2, kẹt sàn. Số liệu trần/sàn lấy từ dữ liệu thật của VNDirect (stock_prices, FPT, 01-02/10/2026).
import { describe, it, expect } from 'vitest';
import V from '../../lib/vn-market.js';

describe('bước giá', () => {
  it('HOSE: <10.000đ 10đ; 10.000-49.950đ 50đ; từ 50.000đ 100đ. HNX/UPCoM 100đ. ETF/quỹ: không kiểm', () => {
    expect(V.tickSize(9990, 'HOSE')).toBe(10);
    expect(V.tickSize(10000, 'HOSE')).toBe(50);
    expect(V.tickSize(49950, 'HOSE')).toBe(50);
    expect(V.tickSize(50000, 'HOSE')).toBe(100);
    expect(V.tickSize(9000, 'HNX')).toBe(100);
    expect(V.tickSize(9000, 'UPCOM')).toBe(100);
    expect(V.tickSize(25000, 'HSX')).toBe(50);                      // HSX = HOSE
    expect(V.tickSize(25000, 'HOSE', 'ETF')).toBeNull();
    expect(V.tickSize(25000, 'KHÁC')).toBe(50);                     // sàn lạ: mặc định HOSE
  });
  it('làm tròn theo bước giá: xuống / lên / gần nhất', () => {
    expect(V.roundToTick(67089, 'HOSE', 'down')).toBe(67000);
    expect(V.roundToTick(58311, 'HOSE', 'up')).toBe(58400);
    expect(V.roundToTick(25024, 'HOSE', 'nearest')).toBe(25000);
    expect(V.roundToTick(25026, 'HOSE', 'nearest')).toBe(25050);
    expect(V.roundToTick(25026, 'HOSE', 'down', 'ETF')).toBe(25026);   // không có bước giá: giữ nguyên
  });
});

describe('giá trần / sàn', () => {
  it('khớp đúng số liệu thật của sàn: FPT tham chiếu 62.700 -> trần 67.000, sàn 58.400; tham chiếu 63.000 -> 67.400 / 58.600', () => {
    expect(V.limits(62700, 'HOSE')).toMatchObject({ ceiling: 67000, floor: 58400, bandPct: 7, tick: 100 });
    expect(V.limits(63000, 'HOSE')).toMatchObject({ ceiling: 67400, floor: 58600 });
  });
  it('HNX ±10%, UPCoM ±15% (UPCoM đánh dấu xấp xỉ vì giá tham chiếu là bình quân gia quyền)', () => {
    expect(V.limits(20000, 'HNX')).toMatchObject({ ceiling: 22000, floor: 18000, bandPct: 10, approx: false });
    expect(V.limits(20000, 'UPCOM')).toMatchObject({ ceiling: 23000, floor: 17000, bandPct: 15, approx: true });
  });
  it('giá rất thấp: trần/sàn không được trùng giá tham chiếu (lệch một bước giá)', () => {
    const L = V.limits(1000, 'HOSE');                                   // 1000 x 1,07 = 1070 -> bước 10: 1070 hợp lệ
    expect(L.ceiling).toBe(1070);
    const L2 = V.limits(100, 'HOSE');                                   // 107 -> làm tròn xuống 100 = tham chiếu -> +1 bước
    expect(L2.ceiling).toBe(110);
    expect(L2.floor).toBeLessThan(100);
    expect(V.limits(0, 'HOSE')).toBeNull();
  });
});

describe('checkPrice / lotCheck', () => {
  it('trong biên độ và đúng bước giá', () => {
    expect(V.checkPrice(63000, 62700, 'HOSE')).toMatchObject({ ok: true, inBand: true, onTick: true, reasons: [] });
  });
  it('vượt trần, thủng sàn, lệch bước giá', () => {
    expect(V.checkPrice(67100, 62700, 'HOSE').reasons).toEqual(['above_ceiling']);
    expect(V.checkPrice(58300, 62700, 'HOSE').reasons).toContain('below_floor');
    expect(V.checkPrice(63050, 62700, 'HOSE').reasons).toEqual(['off_tick']);
    expect(V.checkPrice(25030, 25000, 'HOSE').reasons).toEqual(['off_tick']);    // bước 50
    expect(V.checkPrice(25050, 25000, 'HOSE').ok).toBe(true);
  });
  it('thiếu giá tham chiếu hoặc giá: bỏ qua, không báo lỗi', () => {
    expect(V.checkPrice(25000, 0, 'HOSE')).toMatchObject({ ok: true, skipped: true });
    expect(V.checkPrice(0, 25000, 'HOSE').skipped).toBe(true);
  });
  it('lô chẵn 100: lẻ lô được nhận biết', () => {
    expect(V.lotCheck(500)).toMatchObject({ ok: true, oddLot: false });
    expect(V.lotCheck(550)).toMatchObject({ ok: false, oddLot: true });
    expect(V.lotCheck(0).ok).toBe(false);
  });
});

describe('thanh toán T+2', () => {
  // Thứ Hai 2026-09-28 ... thứ Sáu 2026-10-02, thứ Hai 2026-10-05
  const sessions = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05'];
  it('ngày về = phiên thứ 2 sau ngày giao dịch; qua cuối tuần; phiên đã biết ưu tiên hơn lịch tuần', () => {
    expect(V.settleDate('2026-09-28', sessions)).toBe('2026-09-30');
    expect(V.settleDate('2026-10-01', sessions)).toBe('2026-10-05');       // T+1 = 02/10, T+2 = 05/10 (qua cuối tuần)
    expect(V.settleDate('2026-10-02', sessions)).toBe('2026-10-06');       // 05/10 đã biết, 06/10 đếm theo ngày trong tuần
    expect(V.settleDate('2026-10-02', [])).toBe('2026-10-06');             // không có danh sách phiên: bỏ cuối tuần
    expect(V.settleDate('2026-09-30', ['2026-09-30', '2026-10-02', '2026-10-05'])).toBe('2026-10-05');   // 01/10 nghỉ (lễ giả định) nên T+1 = 02/10
  });
  const txns = [
    { id: 1, type: 'buy', symbol: 'fpt', quantity: 300, price: 60000, trade_date: '2026-10-01' },        // về 05/10
    { id: 2, type: 'buy', symbol: 'FPT', quantity: 200, price: 60000, trade_date: '2026-09-28' },        // về 30/09: đã về
    { id: 3, type: 'sell', symbol: 'VCB', quantity: 100, price: 90000, fee: 13500, tax: 9000, trade_date: '2026-10-02' },   // tiền về 06/10
    { id: 4, type: 'buy', symbol: 'HPG', quantity: 100, price: 27000, trade_date: '2026-10-02', deleted_at: 'x' },
  ];
  it('cổ phiếu mua chưa về và tiền bán chưa về tại một ngày', () => {
    const un = V.unsettled(txns, '2026-10-02', sessions);
    expect(Object.keys(un.buys)).toEqual(['FPT']);
    expect(un.buys.FPT.quantity).toBe(300);
    expect(un.sellCash).toHaveLength(1);
    expect(un.cashPending).toBeCloseTo(100 * 90000 - 13500 - 9000, 6);
    expect(un.sellCash[0].settleDate).toBe('2026-10-06');
  });
  it('sang ngày về thì hết chờ', () => {
    const un = V.unsettled(txns, '2026-10-05', sessions);
    expect(un.buys.FPT).toBeUndefined();
    expect(un.cashPending).toBeGreaterThan(0);                              // tiền bán còn chờ tới 06/10
    expect(V.unsettled(txns, '2026-10-06', sessions).cashPending).toBe(0);
  });
  it('số cổ phiếu bán được = đang giữ - mua chưa về, không âm; ngày về sớm nhất', () => {
    const un = V.unsettled(txns, '2026-10-02', sessions);
    expect(V.sellable('FPT', 500, un)).toEqual({ sellable: 200, locked: 300, nextSettle: '2026-10-05' });
    expect(V.sellable('FPT', 200, un)).toEqual({ sellable: 0, locked: 200, nextSettle: '2026-10-05' });
    expect(V.sellable('VCB', 100, un)).toEqual({ sellable: 100, locked: 0, nextSettle: null });
  });
});

describe('kẹt sàn', () => {
  it('mất 1-(1-biên độ)^n phiên liên tiếp', () => {
    expect(V.lockedLossPct('HOSE', 1)).toBeCloseTo(7, 9);
    expect(V.lockedLossPct('HOSE', 3)).toBeCloseTo((1 - 0.93 ** 3) * 100, 9);
    expect(V.lockedLossPct('HNX', 2)).toBeCloseTo(19, 9);
    expect(V.lockedLossPct('UPCOM', 0)).toBe(0);
  });
});
