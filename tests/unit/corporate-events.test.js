// lib/corporate-events.js: đối chiếu sự kiện doanh nghiệp với sổ lệnh -> gợi ý "được nhận gì, đã ghi chưa".
import { describe, it, expect } from 'vitest';
import CorporateEvents from '../../lib/corporate-events.js';

const buy = (id, symbol, quantity, price, trade_date) => ({ id, type: 'buy', symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z' });
const sell = (id, symbol, quantity, price, trade_date) => ({ id, type: 'sell', symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z' });
const cash = (id, symbol, dps, exDate, payDate) => ({ id, symbol, kind: 'cash_dividend', exDate, payDate, dps, ratio: null, price: null, note: `Trả cổ tức (${dps} đ/cp)` });
const stock = (id, symbol, ratio, exDate, kind = 'stock_dividend') => ({ id, symbol, kind, exDate, payDate: null, dps: null, ratio, price: null, note: `Tỷ lệ 100:${ratio}` });
const rights = (id, symbol, ratio, price, exDate) => ({ id, symbol, kind: 'rights', exDate, payDate: '2026-02-01', dps: null, ratio, price, note: 'Phát hành cho CĐHH' });

const TODAY = '2026-10-04';
const ctx = (extra = {}) => Object.assign({ today: TODAY, txns: [], actions: [], cashFlows: [], dismissed: [] }, extra);

describe('entitledQuantity', () => {
  const txns = [buy('a', 'FPT', 300, 100000, '2026-01-10'), sell('b', 'FPT', 100, 120000, '2026-05-27'), buy('c', 'FPT', 500, 110000, '2026-05-28')];
  it('tính số đang giữ đến hết NGÀY TRƯỚC ngày giao dịch không hưởng quyền', () => {
    // exDate 28/05: lệnh mua cùng ngày 28/05 KHÔNG được hưởng; lệnh bán 27/05 làm giảm quyền
    expect(CorporateEvents.entitledQuantity('FPT', '2026-05-28', txns, [])).toBe(200);
    expect(CorporateEvents.entitledQuantity('FPT', '2026-05-29', txns, [])).toBe(700);
  });
  it('mã chưa từng giao dịch trước ngày đó -> 0', () => {
    expect(CorporateEvents.entitledQuantity('FPT', '2026-01-10', txns, [])).toBe(0);
    expect(CorporateEvents.entitledQuantity('VNM', '2026-06-01', txns, [])).toBe(0);
  });
  it('tính cả cổ phiếu thưởng đã ghi trước ngày đó', () => {
    const actions = [{ symbol: 'FPT', action_type: 'stock_dividend', ratio: 0.1, ex_date: '2026-03-01', created_at: '2026-03-01T00:00:00Z' }];
    expect(CorporateEvents.entitledQuantity('FPT', '2026-05-28', txns, actions)).toBeCloseTo(230, 6)   // 300 -> 330 sau đợt thưởng 10% (01/03), bán 100 ngày 27/05;
  });
});

describe('cổ tức tiền', () => {
  const t = [buy('a', 'FPT', 300, 100000, '2026-01-10')];
  it('đã tới ngày thanh toán, chưa ghi -> pending; tiền gộp, thuế 5%, thực nhận', () => {
    const p = CorporateEvents.planFor(cash('e1', 'FPT', 1000, '2026-05-28', '2026-06-10'), ctx({ txns: t }));
    expect(p.status).toBe('pending');
    expect(p.quantity).toBe(300);
    expect(p.gross).toBe(300000);
    expect(p.net).toBe(285000);
    expect(p.flowDate).toBe('2026-06-10');
  });
  it('ngày thanh toán ở tương lai -> upcoming (chưa cho ghi)', () => {
    const p = CorporateEvents.planFor(cash('e1', 'FPT', 1000, '2026-10-01', '2026-10-20'), ctx({ txns: t }));
    expect(p.status).toBe('upcoming');
    expect(p.due).toBe('2026-10-20');
  });
  it('không có ngày thanh toán thì dùng ngày giao dịch không hưởng quyền', () => {
    const p = CorporateEvents.planFor(cash('e1', 'FPT', 1000, '2026-05-28', null), ctx({ txns: t }));
    expect(p.flowDate).toBe('2026-05-28');
    expect(p.status).toBe('pending');
  });
  it('nhận ra khoản đã tự ghi (đúng số sau thuế hoặc trước thuế, cùng khoảng ngày)', () => {
    const ev = cash('e1', 'FPT', 1000, '2026-05-28', '2026-06-10');
    const net = [{ id: 'f1', flow_type: 'dividend', symbol: 'FPT', amount: 285000, flow_date: '2026-06-10' }];
    const gross = [{ id: 'f1', flow_type: 'dividend', symbol: 'FPT', amount: 300000, flow_date: '2026-06-12' }];
    expect(CorporateEvents.planFor(ev, ctx({ txns: t, cashFlows: net })).status).toBe('recorded');
    expect(CorporateEvents.planFor(ev, ctx({ txns: t, cashFlows: gross })).status).toBe('recorded');
  });
  it('khoản cổ tức khác số tiền / khác mã / quá xa ngày thì KHÔNG coi là đã ghi', () => {
    const ev = cash('e1', 'FPT', 1000, '2026-05-28', '2026-06-10');
    const other = (o) => ctx({ txns: t, cashFlows: [Object.assign({ id: 'f', flow_type: 'dividend', symbol: 'FPT', amount: 285000, flow_date: '2026-06-10' }, o)] });
    expect(CorporateEvents.planFor(ev, other({ amount: 100000 })).status).toBe('pending');
    expect(CorporateEvents.planFor(ev, other({ symbol: 'VNM' })).status).toBe('pending');
    expect(CorporateEvents.planFor(ev, other({ flow_date: '2025-01-01' })).status).toBe('pending');
    expect(CorporateEvents.planFor(ev, other({ flow_type: 'deposit' })).status).toBe('pending');
    expect(CorporateEvents.planFor(ev, other({ deleted_at: '2026-07-01' })).status).toBe('pending');
  });
  it('nhận ra theo thẻ #id trong ghi chú dù số tiền đã sửa tay', () => {
    const ev = cash('e1', 'FPT', 1000, '2026-05-28', '2026-06-10');
    const c = ctx({ txns: t, cashFlows: [{ id: 'f', flow_type: 'dividend', symbol: 'FPT', amount: 1, flow_date: '2027-01-01', note: 'x #e1 y' }] });
    expect(CorporateEvents.planFor(ev, c).status).toBe('recorded');
  });
  it('mã không nắm vào ngày đó -> not_held; đã ẩn -> dismissed', () => {
    expect(CorporateEvents.planFor(cash('e1', 'VNM', 1000, '2026-05-28', '2026-06-10'), ctx({ txns: t })).status).toBe('not_held');
    expect(CorporateEvents.planFor(cash('e1', 'FPT', 1000, '2026-05-28', '2026-06-10'), ctx({ txns: t, dismissed: ['e1'] })).status).toBe('dismissed');
    expect(CorporateEvents.planFor(cash('e1', 'FPT', 1000, '2026-05-28', '2026-06-10'), ctx({ txns: t, dismissed: new Set(['e1']) })).status).toBe('dismissed');
  });
});

describe('cổ phiếu thưởng / cổ tức bằng cổ phiếu', () => {
  const t = [buy('a', 'HPG', 1000, 25000, '2026-01-10')];
  it('pending: tính số cổ phiếu nhận thêm (làm tròn xuống) và hệ số', () => {
    const p = CorporateEvents.planFor(stock('s1', 'HPG', 10, '2026-05-25'), ctx({ txns: t }));
    expect(p.status).toBe('pending');
    expect(p.bonusShares).toBe(100);
    expect(p.quantityAfter).toBe(1100);
    expect(p.multiplier).toBeCloseTo(1.1, 9);
    const odd = CorporateEvents.planFor(stock('s2', 'HPG', 15, '2026-05-25'), ctx({ txns: [buy('a', 'HPG', 130, 25000, '2026-01-10')] }));
    expect(odd.bonusShares).toBe(19);   // 130 x 15% = 19,5 -> 19
  });
  it('ngày giao dịch không hưởng quyền ở tương lai -> upcoming', () => {
    expect(CorporateEvents.planFor(stock('s1', 'HPG', 10, '2026-10-20'), ctx({ txns: t })).status).toBe('upcoming');
  });
  it('đã có hành động cùng tỷ lệ gần ngày đó (hoặc thẻ #id) -> recorded', () => {
    const act = [{ id: 'x', symbol: 'HPG', action_type: 'stock_dividend', ratio: 0.1, ex_date: '2026-05-26' }];
    expect(CorporateEvents.planFor(stock('s1', 'HPG', 10, '2026-05-25'), ctx({ txns: t, actions: act })).status).toBe('recorded');
    const tag = [{ id: 'x', symbol: 'HPG', action_type: 'stock_dividend', ratio: 0.5, ex_date: '2026-01-01', note: '#s1' }];
    expect(CorporateEvents.planFor(stock('s1', 'HPG', 10, '2026-05-25'), ctx({ txns: t, actions: tag })).status).toBe('recorded');
    const diff = [{ id: 'x', symbol: 'HPG', action_type: 'stock_dividend', ratio: 0.2, ex_date: '2026-05-25' }];
    expect(CorporateEvents.planFor(stock('s1', 'HPG', 10, '2026-05-25'), ctx({ txns: t, actions: diff })).status).toBe('pending');
  });
  it('bonus (KINDDIV) được ghi như stock_dividend', () => {
    const p = CorporateEvents.planFor(stock('s1', 'HPG', 10, '2026-05-25', 'bonus'), ctx({ txns: t }));
    const rec = CorporateEvents.toRecord(p);
    expect(rec.type).toBe('corporateAction');
    expect(rec.action).toMatchObject({ symbol: 'HPG', actionType: 'stock_dividend', exDate: '2026-05-25' });
    expect(rec.action.ratio).toBeCloseTo(0.1, 9);
    expect(rec.action.note).toContain('#s1');
  });
});

describe('quyền mua phát hành thêm', () => {
  it('chỉ là thông tin: số quyền, tiền phải bỏ ra nếu mua hết; không tạo bản ghi', () => {
    const t = [buy('a', 'SSI', 1000, 30000, '2025-01-10')];
    const p = CorporateEvents.planFor(rights('r1', 'SSI', 20, 15000, '2026-01-20'), ctx({ txns: t }));
    expect(p.status).toBe('info');
    expect(p.rightsShares).toBe(200);
    expect(p.cost).toBe(3000000);
    expect(CorporateEvents.toRecord(p)).toBeNull();
  });
});

describe('suggest: quyền tính theo thứ tự thời gian', () => {
  it('cổ tức tiền SAU đợt thưởng chưa ghi được tính trên số cổ phiếu đã tăng', () => {
    const t = [buy('a', 'FPT', 1000, 100000, '2026-01-10')];
    const events = [stock('s1', 'FPT', 10, '2026-03-01'), cash('c1', 'FPT', 1000, '2026-05-28', '2026-06-10')];
    const r = CorporateEvents.suggest(events, ctx({ txns: t }));
    const c = r.items.find(i => i.event.id === 'c1');
    expect(c.quantity).toBeCloseTo(1100, 6);
    expect(c.gross).toBe(1100000);
  });
  it('đợt thưởng đã bị ẩn thì KHÔNG tính vào quyền của sự kiện sau', () => {
    const t = [buy('a', 'FPT', 1000, 100000, '2026-01-10')];
    const events = [stock('s1', 'FPT', 10, '2026-03-01'), cash('c1', 'FPT', 1000, '2026-05-28', '2026-06-10')];
    const r = CorporateEvents.suggest(events, ctx({ txns: t, dismissed: ['s1'] }));
    expect(r.items.find(i => i.event.id === 'c1').quantity).toBe(1000);
  });
  it('sắp xếp: cần xử lý trước, rồi sắp tới, thông tin, đã ghi, đã ẩn; tổng hợp đúng', () => {
    const t = [buy('a', 'FPT', 1000, 100000, '2025-01-10'), buy('b', 'SSI', 1000, 30000, '2025-01-10')];
    const events = [
      cash('old', 'FPT', 500, '2025-06-01', '2025-06-20'),   // đã ghi
      cash('new', 'FPT', 1000, '2026-05-28', '2026-06-10'),  // pending
      cash('soon', 'FPT', 1000, '2026-10-01', '2026-10-30'), // upcoming
      rights('r', 'SSI', 20, 15000, '2026-01-20'),           // info
      cash('hid', 'FPT', 700, '2025-12-01', '2025-12-12'),   // dismissed
      cash('zzz', 'VNM', 700, '2026-03-01', '2026-03-12'),   // không nắm -> bị bỏ
    ];
    const flows = [{ id: 'f', flow_type: 'dividend', symbol: 'FPT', amount: 475000, flow_date: '2025-06-20' }];
    const r = CorporateEvents.suggest(events, ctx({ txns: t, cashFlows: flows, dismissed: ['hid'] }));
    expect(r.items.map(i => i.event.id)).toEqual(['new', 'soon', 'r', 'old', 'hid']);
    expect(r.summary).toMatchObject({ pending: 1, upcoming: 1, info: 1, recorded: 1, dismissed: 1 });
    expect(r.summary.pendingCash).toBe(950000);
  });
});

describe('queryScope / toRecord', () => {
  it('liệt kê mọi mã từng giao dịch và ngày giao dịch đầu tiên', () => {
    const s = CorporateEvents.queryScope([buy('a', 'FPT', 1, 1, '2026-03-01'), sell('b', 'FPT', 1, 1, '2026-04-01'), buy('c', 'AAA', 1, 1, '2025-12-31')]);
    expect(s).toEqual({ symbols: ['AAA', 'FPT'], since: '2025-12-31' });
    expect(CorporateEvents.queryScope([])).toEqual({ symbols: [], since: null });
  });
  it('cổ tức tiền: ghi sau thuế mặc định (kèm ghi chú), hoặc gộp khi chọn', () => {
    const t = [buy('a', 'FPT', 300, 100000, '2026-01-10')];
    const p = CorporateEvents.planFor(cash('e1', 'FPT', 1000, '2026-05-28', '2026-06-10'), ctx({ txns: t }));
    const net = CorporateEvents.toRecord(p);
    expect(net).toMatchObject({ type: 'cashFlow', flow: { flowType: 'dividend', amount: 285000, flowDate: '2026-06-10', symbol: 'FPT' } });
    expect(net.flow.note).toMatch(/#e1.*đã trừ thuế TNCN 5%/);
    expect(CorporateEvents.toRecord(p, { afterTax: false }).flow.amount).toBe(300000);
  });
});
