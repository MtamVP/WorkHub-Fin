// Logic thuần mới của các Edge Function: stock-history (parse.ts), ghi NAV hằng ngày (nav.ts), cảnh báo "chạm giá muốn mua" (logic.ts).
import { describe, it, expect } from 'vitest';
import { validateRequest, parseDchart, parseFinfo, vnDate as vnDateSec, MAX_SYMBOLS, MAX_RANGE_DAYS } from '../../supabase/functions/stock-history/parse.ts';
import { buildNavRows, heldQuantities as navHeld, isWeekday } from '../../supabase/functions/fetch-stock-prices/nav.ts';
import { heldQuantities as alertsHeld, evaluateWatchAlerts, buildEmail } from '../../supabase/functions/send-price-alerts/logic.ts';

describe('stock-history: validateRequest', () => {
  const ok = { symbols: ['ssi', 'VNINDEX', 'ssi'], from: '2026-08-01', to: '2026-09-30' };
  it('chuẩn hoá mã (hoa, bỏ trùng) và chấp nhận yêu cầu hợp lệ', () => {
    const v = validateRequest(ok);
    expect(v.error).toBeNull();
    expect(v.symbols).toEqual(['SSI', 'VNINDEX']);
  });
  it.each([
    [{}, /danh sách mã/], [{ symbols: [], from: '2026-01-01', to: '2026-01-02' }, /danh sách mã/],
    [{ symbols: ['A;DROP'], from: '2026-01-01', to: '2026-01-02' }, /không hợp lệ/],
    [{ symbols: ['SSI'], from: '01/01/2026', to: '2026-01-02' }, /Ngày/],
    [{ symbols: ['SSI'], from: '2026-02-01', to: '2026-01-01' }, /Khoảng ngày/],
    [{ symbols: ['SSI'], from: '2015-01-01', to: '2026-01-01' }, new RegExp('tối đa ' + MAX_RANGE_DAYS)],
    [{ symbols: Array.from({ length: MAX_SYMBOLS + 1 }, (_, i) => 'A' + i), from: '2026-01-01', to: '2026-01-02' }, new RegExp('Tối đa ' + MAX_SYMBOLS)],
  ])('từ chối yêu cầu xấu %#', (body, re) => {
    expect(validateRequest(body).error).toMatch(re);
  });
});

describe('stock-history: parseDchart / parseFinfo', () => {
  const t = (iso) => Math.floor(Date.parse(iso + 'T03:00:00Z') / 1000); // 10:00 giờ VN
  it('cổ phiếu: giá nghìn đồng nhân 1000; chỉ số giữ nguyên điểm', () => {
    const json = { s: 'ok', t: [t('2026-09-01'), t('2026-09-02')], c: [29.5, 30.1] };
    expect(parseDchart(json, 'SSI')).toEqual([['2026-09-01', 29500], ['2026-09-02', 30100]]);
    expect(parseDchart({ s: 'ok', t: [t('2026-09-01')], c: [1234.56] }, 'VNINDEX')).toEqual([['2026-09-01', 1234.56]]);
  });
  it('bỏ điểm hỏng và trùng ngày; phản hồi lỗi trả chuỗi rỗng', () => {
    expect(parseDchart({ s: 'ok', t: [t('2026-09-01'), t('2026-09-01'), t('2026-09-02')], c: [10, 11, 'x'] }, 'AAA')).toEqual([['2026-09-01', 11000]]);
    expect(parseDchart({ s: 'no_data' }, 'AAA')).toEqual([]);
    expect(parseDchart(null, 'AAA')).toEqual([]);
  });
  it('phiên cuối ngày giờ UTC vẫn đúng ngày Việt Nam', () => {
    expect(vnDateSec(Math.floor(Date.parse('2026-09-01T18:30:00Z') / 1000))).toBe('2026-09-02');
  });
  it('finfo (dự phòng)', () => {
    expect(parseFinfo({ data: [{ date: '2026-09-02', close: 30.1 }, { date: '2026-09-01', close: 29.5 }, { date: '2026-09-03', close: 0 }] }))
      .toEqual([['2026-09-01', 29500], ['2026-09-02', 30100]]);
    expect(parseFinfo(null)).toEqual([]);
  });
});

describe('nav snapshot', () => {
  const tx = (user_id, symbol, type, quantity, trade_date) => ({ user_id, symbol, type, quantity, trade_date, created_at: trade_date + 'T01:00:00Z' });

  it('heldQuantities của nav.ts khớp bản trong send-price-alerts (cùng đầu vào, cùng kết quả)', () => {
    const txns = [tx('u1', 'A', 'buy', 100, '2026-01-01'), tx('u1', 'A', 'sell', 30, '2026-02-01'), tx('u2', 'B', 'buy', 5, '2026-01-01')];
    const actions = [{ user_id: 'u1', symbol: 'A', action_type: 'split', ratio: 2, ex_date: '2026-01-15', created_at: '2026-01-15T00:00:00Z' }];
    const a = navHeld(txns, actions), b = alertsHeld(txns, actions);
    for (const [u, per] of a) for (const [s, q] of per) expect(b.get(u).get(s)).toBeCloseTo(q, 9);
  });

  it('NAV = giá trị thị trường + tiền mặt - nợ, kèm vốn ròng đã nạp', () => {
    const held = navHeld([tx('u1', 'A', 'buy', 100, '2026-01-01'), tx('u1', 'B', 'buy', 50, '2026-01-01'), tx('u1', 'B', 'sell', 50, '2026-02-01')], []);
    const prices = new Map([['u1', new Map([['A', 10000], ['B', 20000]])]]);
    const rows = buildNavRows('2026-10-02', held, prices, new Map([['u1', { cash: 5e6, debt: 1e6 }]]), new Map([['u1', 90e6]]));
    expect(rows).toEqual([{ user_id: 'u1', snapshot_date: '2026-10-02', nav: 1e6 + 5e6 - 1e6, cash: 5e6, debt: 1e6, market_value: 1e6, net_contributed: 90e6 }]);
  });

  it('mã chưa có giá tính 0 (không làm NAV thành NaN); user chưa có tiền mặt thì cash/debt = 0', () => {
    const held = navHeld([tx('u1', 'A', 'buy', 100, '2026-01-01')], []);
    const rows = buildNavRows('2026-10-02', held, new Map(), new Map(), new Map());
    expect(rows[0]).toMatchObject({ nav: 0, market_value: 0, cash: 0, debt: 0, net_contributed: 0 });
  });

  it('isWeekday', () => {
    expect(isWeekday('2026-10-02')).toBe(true);   // Thứ Sáu
    expect(isWeekday('2026-10-03')).toBe(false);  // Thứ Bảy
    expect(isWeekday('2026-10-04')).toBe(false);  // Chủ nhật
  });
});

describe('evaluateWatchAlerts + email "muốn mua"', () => {
  const NOW = new Date('2026-10-01T07:00:00Z');
  const price = (symbol, p, date = '2026-10-01') => ({ user_id: 'u1', symbol, market_price: p, locked: false, target_price: null, stop_loss: null, price_date: date, updated_at: null });

  it('báo khi giá <= giá muốn mua và CHƯA nắm giữ mã', () => {
    const a = evaluateWatchAlerts([{ user_id: 'u1', symbol: 'FPT', buy_below: 100000 }], [price('FPT', 99000)], new Map(), NOW);
    expect(a).toEqual([{ symbol: 'FPT', kind: 'buy', threshold: 100000, price: 99000 }]);
  });
  it('không báo khi giá còn cao hơn, đã nắm giữ, không đặt giá muốn mua, hoặc giá đã cũ', () => {
    const w = [{ user_id: 'u1', symbol: 'FPT', buy_below: 100000 }];
    expect(evaluateWatchAlerts(w, [price('FPT', 101000)], new Map(), NOW)).toEqual([]);
    expect(evaluateWatchAlerts(w, [price('FPT', 90000)], new Map([['FPT', 100]]), NOW)).toEqual([]);
    expect(evaluateWatchAlerts([{ user_id: 'u1', symbol: 'FPT', buy_below: null }], [price('FPT', 90000)], new Map(), NOW)).toEqual([]);
    expect(evaluateWatchAlerts(w, [price('FPT', 90000, '2026-09-20')], new Map(), NOW)).toEqual([]);
    expect(evaluateWatchAlerts(w, [price('FPT', 0)], new Map(), NOW)).toEqual([]);
  });
  it('email có nhãn riêng cho cảnh báo mua', () => {
    const mail = buildEmail([{ symbol: 'FPT', kind: 'buy', threshold: 100000, price: 99000 }], 'Tâm');
    expect(mail.subject).toMatch(/FPT chạm giá muốn mua/);
    expect(mail.text).toMatch(/giá muốn mua 100\.000/);
    expect(mail.html).toMatch(/Chạm giá muốn mua/);
  });
});
