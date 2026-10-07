// lib/portfolio-calc.js: FIFO có phí/thuế, báo cáo lãi/lỗ đã chốt theo năm, gợi ý cân bằng danh mục.
import { describe, it, expect } from 'vitest';
import PortfolioCalc from '../../lib/portfolio-calc.js';

let seq = 0;
const tx = (type, symbol, quantity, price, trade_date, extra = {}) => ({
  id: 't' + (++seq), type, symbol, quantity, price, trade_date, fee: 0, tax: 0,
  created_at: '2026-01-01T00:00:' + String(seq).padStart(2, '0') + 'Z', ...extra,
});

// Bản sao nguyên văn thuật toán FIFO CŨ trong api.js (_replayFifo, chưa có phí) -- để chứng minh bản mới cho cùng lãi/lỗ gộp và cùng lô.
function legacyReplay(txns, actions) {
  const events = [
    ...txns.map(t => ({ ...t, _kind: 'txn', _date: t.trade_date, _ts: t.created_at })),
    ...actions.map(a => ({ ...a, _kind: 'action', _date: a.ex_date, _ts: a.created_at })),
  ].sort((a, b) => (new Date(a._date) - new Date(b._date)) || (new Date(a._ts) - new Date(b._ts)));
  const lotsBySymbol = {}; const realizedPnlByTxnId = {};
  events.forEach(ev => {
    if (ev._kind === 'action') {
      const lots = lotsBySymbol[ev.symbol];
      if (!lots || !lots.length) return;
      const multiplier = ev.action_type === 'split' ? Number(ev.ratio) : (1 + Number(ev.ratio));
      if (multiplier > 0) lots.forEach(lot => { lot.quantity *= multiplier; lot.cost /= multiplier; });
      return;
    }
    if (!lotsBySymbol[ev.symbol]) lotsBySymbol[ev.symbol] = [];
    const lots = lotsBySymbol[ev.symbol];
    const qty = Number(ev.quantity) || 0;
    if (ev.type === 'buy') { lots.push({ quantity: qty, cost: Number(ev.price) || 0 }); return; }
    let remaining = qty, realized = 0; const price = Number(ev.price) || 0;
    while (remaining > 1e-9 && lots.length) {
      const lot = lots[0]; const consumed = Math.min(lot.quantity, remaining);
      realized += (price - lot.cost) * consumed; lot.quantity -= consumed; remaining -= consumed;
      if (lot.quantity <= 1e-9) lots.shift();
    }
    realizedPnlByTxnId[ev.id] = realized;
  });
  return { lotsBySymbol, realizedPnlByTxnId };
}

describe('replayLedger — tương thích FIFO cũ', () => {
  it('lãi/lỗ gộp và lô còn lại giống hệt thuật toán cũ (kể cả tách/gộp, cổ tức CP, bán nhiều lô)', () => {
    const txns = [
      tx('buy', 'SSI', 1000, 30000, '2026-01-05'), tx('buy', 'SSI', 500, 32000, '2026-02-01'),
      tx('buy', 'VHM', 400, 74110, '2026-02-02'), tx('sell', 'SSI', 1200, 35000, '2026-03-01'),
      tx('buy', 'SSI', 300, 33000, '2026-03-05'), tx('sell', 'VHM', 400, 70000, '2026-04-01'), tx('sell', 'SSI', 600, 36000, '2026-04-02'),
    ];
    const actions = [
      { symbol: 'SSI', action_type: 'split', ratio: 2, ex_date: '2026-02-15', created_at: '2026-01-01T00:00:00Z' },
      { symbol: 'SSI', action_type: 'stock_dividend', ratio: 0.1, ex_date: '2026-03-10', created_at: '2026-01-01T00:00:01Z' },
    ];
    const next = PortfolioCalc.replayLedger(txns.map(t => ({ ...t, fee: 12345, tax: 777 })), actions);
    const old = legacyReplay(txns, actions);
    Object.keys(old.realizedPnlByTxnId).forEach(id => {
      expect(next.realizedGrossByTxnId[id]).toBeCloseTo(old.realizedPnlByTxnId[id], 6);
    });
    Object.keys(old.lotsBySymbol).forEach(sym => {
      const a = old.lotsBySymbol[sym], b = next.lotsBySymbol[sym];
      expect(b.length).toBe(a.length);
      a.forEach((lot, i) => { expect(b[i].quantity).toBeCloseTo(lot.quantity, 6); expect(b[i].cost).toBeCloseTo(lot.cost, 6); });
    });
  });
});

describe('replayLedger — phí & thuế', () => {
  it('lãi/lỗ ròng = gộp - phí mua của lô đã bán - phí bán - thuế bán', () => {
    const { sales } = PortfolioCalc.replayLedger([
      tx('buy', 'HPG', 1000, 20000, '2026-01-10', { fee: 30000 }),         // phí mua 30.000
      tx('sell', 'HPG', 1000, 25000, '2026-03-10', { fee: 37500, tax: 25000 }),
    ], []);
    const s = sales[0];
    expect(s.proceeds).toBe(25000000);
    expect(s.costBasis).toBe(20000000);
    expect(s.realizedGross).toBe(5000000);
    expect(s.buyFees).toBeCloseTo(30000, 6);
    expect(s.realizedNet).toBeCloseTo(5000000 - 30000 - 37500 - 25000, 6);
    expect(s.avgHoldingDays).toBe(59);
  });

  it('bán 1 phần: chỉ tính phần phí mua tương ứng của lô bị tiêu thụ', () => {
    const { sales } = PortfolioCalc.replayLedger([
      tx('buy', 'A', 1000, 10000, '2026-01-01', { fee: 15000 }),
      tx('sell', 'A', 400, 12000, '2026-02-01', { fee: 7200, tax: 4800 }),
    ], []);
    expect(sales[0].buyFees).toBeCloseTo(6000, 6);       // 400/1000 của 15.000
    expect(sales[0].realizedNet).toBeCloseTo(800000 - 6000 - 7200 - 4800, 6);
  });

  it('tách cổ phiếu không làm đổi tổng phí mua đã phân bổ', () => {
    const { sales } = PortfolioCalc.replayLedger([
      tx('buy', 'A', 1000, 10000, '2026-01-01', { fee: 15000 }),
      tx('sell', 'A', 2000, 6000, '2026-03-01', { fee: 18000, tax: 12000 }),
    ], [{ symbol: 'A', action_type: 'split', ratio: 2, ex_date: '2026-02-01', created_at: '2026-01-01T00:00:00Z' }]);
    expect(sales[0].buyFees).toBeCloseTo(15000, 6);
    expect(sales[0].costBasis).toBeCloseTo(10000000, 6);
  });

  it('bán vượt khối lượng đang có: báo shortfall, không tạo lãi ảo cho phần không có giá vốn', () => {
    const { sales } = PortfolioCalc.replayLedger([
      tx('buy', 'A', 100, 10000, '2026-01-01'), tx('sell', 'A', 150, 12000, '2026-02-01', { fee: 1500, tax: 1000 }),
    ], []);
    expect(sales[0].shortfall).toBe(50);
    expect(sales[0].realizedGross).toBe(200000);
    expect(sales[0].realizedNet).toBeCloseTo(200000 - (1500 + 1000) * (100 / 150), 6);
  });

  it('dữ liệu cũ không có cột fee/tax (null/undefined) vẫn chạy', () => {
    const { sales } = PortfolioCalc.replayLedger([
      tx('buy', 'A', 100, 10, '2026-01-01', { fee: null, tax: undefined }), tx('sell', 'A', 100, 12, '2026-02-01', { fee: null, tax: null }),
    ], []);
    expect(sales[0].realizedNet).toBe(200);
  });
});

describe('realizedReport', () => {
  const build = () => PortfolioCalc.replayLedger([
    tx('buy', 'AAA', 1000, 10000, '2025-06-01', { fee: 15000 }),
    tx('sell', 'AAA', 500, 12000, '2025-12-20', { fee: 9000, tax: 6000 }),   // lãi, năm 2025
    tx('sell', 'AAA', 500, 9000, '2026-02-10', { fee: 6750, tax: 4500 }),    // lỗ, năm 2026
    tx('buy', 'BBB', 100, 50000, '2026-01-05', { fee: 7500 }),
    tx('sell', 'BBB', 100, 60000, '2026-03-05', { fee: 9000, tax: 6000 }),   // lãi, năm 2026
  ], []).sales;

  it('gom đúng theo năm, có danh sách năm mới nhất trước', () => {
    const r26 = PortfolioCalc.realizedReport(build(), [], 2026);
    expect(r26.years).toEqual([2026, 2025]);
    expect(r26.totals.count).toBe(2);
    expect(r26.bySymbol.map(s => s.symbol).sort()).toEqual(['AAA', 'BBB']);
    const r25 = PortfolioCalc.realizedReport(build(), [], 2025);
    expect(r25.totals.count).toBe(1);
    expect(r25.totals.netPnl).toBeCloseTo(1000000 - 7500 - 9000 - 6000, 6);
  });

  it('tổng hợp thắng/thua, tỷ lệ thắng, phí và thuế', () => {
    const r = PortfolioCalc.realizedReport(build(), [], 2026);
    expect(r.totals.wins).toBe(1);
    expect(r.totals.losses).toBe(1);
    expect(r.totals.winRate).toBe(50);
    expect(r.totals.taxes).toBe(10500);
    expect(r.totals.sellFees).toBe(15750);
    expect(r.totals.best.symbol).toBe('BBB');
    expect(r.totals.worst.symbol).toBe('AAA');
  });

  it('cộng cổ tức tiền của năm vào thu nhập (tách riêng khỏi lãi vốn)', () => {
    const r = PortfolioCalc.realizedReport(build(), [{ flow_date: '2026-05-01', symbol: 'AAA', amount: 500000 }, { flow_date: '2025-05-01', symbol: 'AAA', amount: 999 }], 2026);
    expect(r.dividendTotal).toBe(500000);
    expect(r.netIncludingDividends).toBeCloseTo(r.totals.netPnl + 500000, 6);
  });

  it('năm không có giao dịch: báo cáo rỗng, không vỡ', () => {
    const r = PortfolioCalc.realizedReport(build(), [], 2030);
    expect(r.totals.count).toBe(0);
    expect(r.totals.winRate).toBeNull();
    expect(r.sales).toEqual([]);
  });
});

describe('feesFor', () => {
  it('mặc định 0,15% phí mua/bán + 0,1% thuế bán, làm tròn đồng', () => {
    expect(PortfolioCalc.feesFor('buy', 1000, 25000)).toEqual({ fee: 37500, tax: 0 });
    expect(PortfolioCalc.feesFor('sell', 1000, 25000)).toEqual({ fee: 37500, tax: 25000 });
  });
  it('biểu phí tuỳ chỉnh', () => {
    expect(PortfolioCalc.feesFor('sell', 100, 10000, { sellFeeRate: 0.003, sellTaxRate: 0.001 })).toEqual({ fee: 3000, tax: 1000 });
  });
});

describe('rebalancePlan', () => {
  const holdings = [
    { symbol: 'VHM', quantity: 1000, marketPrice: 70000 },   // 70tr
    { symbol: 'SSI', quantity: 2000, marketPrice: 30000 },   // 60tr
    { symbol: 'PDR', quantity: 1000, marketPrice: 10000 },   // 10tr
  ];

  it('mua/bán về đúng tỷ trọng mục tiêu, làm tròn xuống theo lô 100', () => {
    // NAV = 140tr (không tính tiền mặt). Mục tiêu: VHM 40% (56tr), SSI 40% (56tr), PDR 20% (28tr)
    const p = PortfolioCalc.rebalancePlan(holdings, 0, { VHM: 40, SSI: 40, PDR: 20 }, {}, { includeCash: false });
    const by = Object.fromEntries(p.rows.map(r => [r.symbol, r]));
    expect(by.VHM.action).toBe('sell');
    expect(by.VHM.shares).toBe(200);                         // 14tr / 70.000 = 200
    expect(by.SSI.action).toBe('sell');
    expect(by.SSI.shares).toBe(100);                         // 4tr / 30.000 = 133 -> 100
    expect(by.PDR.action).toBe('buy');
    expect(by.PDR.shares).toBe(1800);                        // 18tr / 10.000
    expect(p.totalTax).toBeGreaterThan(0);
  });

  it('trong ngưỡng dung sai thì giữ nguyên', () => {
    const p = PortfolioCalc.rebalancePlan(holdings, 0, { VHM: 50, SSI: 42.5, PDR: 7.5 }, {}, { includeCash: false, tolerancePct: 1 });
    expect(p.rows.every(r => r.action === 'hold')).toBe(true);
  });

  it('mục tiêu 0% = bán hết kể cả phần lẻ; không bao giờ bán vượt khối lượng đang có', () => {
    const p = PortfolioCalc.rebalancePlan([{ symbol: 'A', quantity: 250, marketPrice: 10000 }, { symbol: 'B', quantity: 100, marketPrice: 10000 }], 0, { A: 0, B: 100 }, {}, { includeCash: false });
    const a = p.rows.find(r => r.symbol === 'A');
    expect(a.action).toBe('sell');
    expect(a.shares).toBe(250);
  });

  it('mã chưa nắm dùng giá từ danh sách theo dõi; không có giá thì báo thiếu giá', () => {
    const p = PortfolioCalc.rebalancePlan([{ symbol: 'VHM', quantity: 1000, marketPrice: 70000 }], 30000000, { VHM: 50, FPT: 30, HPG: 20 }, { FPT: 100000 }, { includeCash: true });
    const fpt = p.rows.find(r => r.symbol === 'FPT');
    expect(fpt.action).toBe('buy');
    expect(fpt.shares).toBe(300);                            // 30% x 100tr = 30tr / 100.000
    expect(p.rows.find(r => r.symbol === 'HPG').action).toBe('noPrice');
  });

  it('cảnh báo khi không đủ tiền mặt cho các lệnh mua', () => {
    const p = PortfolioCalc.rebalancePlan([{ symbol: 'A', quantity: 1000, marketPrice: 10000 }], 0, { A: 100, B: 100 }, { B: 10000 }, { includeCash: true });
    expect(p.warnings.some(w => /vượt 100%/.test(w))).toBe(true);
  });

  it('tiền mặt dư được tính vào NAV khi includeCash', () => {
    const p = PortfolioCalc.rebalancePlan([{ symbol: 'A', quantity: 1000, marketPrice: 10000 }], 10000000, { A: 100 }, {}, { includeCash: true });
    expect(p.base).toBe(20000000);
    const a = p.rows[0];
    expect(a.action).toBe('buy');
    expect(a.shares).toBe(1000);
    expect(p.cashAfter).toBeLessThan(0.0001 + 0);              // dùng hết tiền mặt (còn trừ phí)
  });
});

describe('LỖI CŨ: sự kiện doanh nghiệp và lệnh cùng ngày không hưởng quyền', () => {
  const buy = { id: 'b', symbol: 'FPT', type: 'buy', quantity: 1000, price: 100000, fee: 0, trade_date: '2026-03-02', created_at: '2026-03-02T03:00:00Z' };
  const split = { symbol: 'FPT', action_type: 'split', ratio: 2, ex_date: '2026-05-10', created_at: '2026-05-12T09:00:00Z' };   // ghi SAU lệnh bán
  it('chia 2:1 rồi bán 2.000 cp đúng ngày: giá vốn 50.000/cp, lãi gộp +4 triệu (bản cũ: lỗ -48 triệu)', () => {
    const r = PortfolioCalc.replayLedger([buy, { id: 's', symbol: 'FPT', type: 'sell', quantity: 2000, price: 52000, fee: 0, trade_date: '2026-05-10', created_at: '2026-05-10T03:00:00Z' }], [split]);
    expect(r.sales[0].costBasis).toBe(100000000);
    expect(r.realizedGrossByTxnId.s).toBe(4000000);
    expect(r.lotsBySymbol.FPT).toHaveLength(0);
  });
  it('mua đúng ngày không hưởng quyền thì lô mới không bị nhân đôi', () => {
    const r = PortfolioCalc.replayLedger([buy, { id: 'b2', symbol: 'FPT', type: 'buy', quantity: 500, price: 51000, fee: 0, trade_date: '2026-05-10', created_at: '2026-05-10T03:00:00Z' }], [split]);
    expect(r.lotsBySymbol.FPT.map((l) => [l.quantity, l.cost])).toEqual([[2000, 50000], [500, 51000]]);
  });
});
