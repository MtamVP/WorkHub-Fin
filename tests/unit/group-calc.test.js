// lib/group-calc.js: gộp danh mục các thành viên, mức trùng lặp, NAV chung, bảng so sánh thành viên.
import { describe, it, expect } from 'vitest';
import GroupCalc from '../../lib/group-calc.js';

const M = [{ id: 'u1', email: 'an@x.vn', nickname: 'An' }, { id: 'u2', email: 'binh@x.vn', nickname: null }, { id: 'u3', email: 'chi@x.vn', nickname: 'Chi' }];
const tx = (id, user_id, type, symbol, quantity, price, trade_date, extra = {}) => ({ id, user_id, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z', deleted_at: null, ...extra });
const TXNS = [
  tx('1', 'u1', 'buy', 'FPT', 100, 100000, '2026-01-10'), tx('2', 'u1', 'buy', 'VCB', 100, 90000, '2026-01-10'),
  tx('3', 'u2', 'buy', 'FPT', 50, 90000, '2026-02-01'), tx('4', 'u2', 'buy', 'HPG', 400, 25000, '2026-02-01'), tx('5', 'u2', 'sell', 'HPG', 100, 27000, '2026-03-01'),
  tx('6', 'u3', 'buy', 'SSI', 200, 30000, '2026-02-01'),
  tx('x', 'u3', 'buy', 'ZZZ', 10, 1, '2026-02-01', { deleted_at: '2026-02-02T00:00:00Z' }),   // đã xoá: không tính
];
const PRICES = [
  { user_id: 'u1', symbol: 'FPT', market_price: 110000, price_date: '2026-10-02', updated_at: '2026-10-02T08:00:00Z' },
  { user_id: 'u2', symbol: 'FPT', market_price: 111000, price_date: '2026-10-02', updated_at: '2026-10-02T09:00:00Z' },   // mới hơn
  { user_id: 'u1', symbol: 'VCB', market_price: 100000, price_date: '2026-10-02', updated_at: '2026-10-02T08:00:00Z' },
  { user_id: 'u2', symbol: 'HPG', market_price: 30000, price_date: '2026-10-02', updated_at: '2026-10-02T08:00:00Z' },
  { user_id: 'u3', symbol: 'SSI', market_price: 33000, price_date: '2026-10-02', updated_at: '2026-10-02T08:00:00Z' },
  { user_id: 'u3', symbol: 'BAD', market_price: 0, price_date: '2026-10-02', updated_at: '2026-10-02T08:00:00Z' },
];
const ASSETS = [{ user_id: 'u1', cash: 5e6, debt: 0 }, { user_id: 'u2', cash: 10e6, debt: 2e6 }, { user_id: 'u3', cash: 0, debt: 0 }];
const P = GroupCalc.memberPortfolios({ members: M, txns: TXNS, actions: [], prices: PRICES, assets: ASSETS });

describe('priceMap / memberPortfolios', () => {
  it('giá: lấy bản ghi mới nhất giữa các thành viên, bỏ giá 0', () => {
    const m = GroupCalc.priceMap(PRICES);
    expect(m.FPT).toBe(111000);
    expect(m.BAD).toBeUndefined();
  });
  it('số cổ phiếu từng người theo sổ lệnh (đã trừ bán), bỏ lệnh đã xoá, tên hiển thị', () => {
    expect(P.map(p => p.name)).toEqual(['An', 'binh', 'Chi']);
    const u2 = P[1];
    expect(u2.holdings.find(h => h.symbol === 'HPG').quantity).toBe(300);
    expect(P[2].holdings.map(h => h.symbol)).toEqual(['SSI']);           // ZZZ đã xoá
  });
  it('NAV = giá trị cổ phiếu + tiền − nợ; tỷ trọng cộng 100%; lãi chưa chốt', () => {
    const u1 = P[0];
    expect(u1.marketValue).toBe(100 * 111000 + 100 * 100000);
    expect(u1.nav).toBe(u1.marketValue + 5e6);
    expect(u1.holdings.reduce((s, h) => s + h.weightPct, 0)).toBeCloseTo(100, 6);
    expect(u1.holdings[0].symbol).toBe('FPT');
    expect(u1.holdings[0].unrealizedPct).toBeCloseTo((111000 / 100000 - 1) * 100, 6);
    expect(P[1].nav).toBe(50 * 111000 + 300 * 30000 + 10e6 - 2e6);
  });
  it('mã chưa có giá: noPrice, giá trị 0', () => {
    const q = GroupCalc.memberPortfolios({ members: M, txns: [tx('1', 'u1', 'buy', 'NEW', 10, 100, '2026-01-01')], actions: [], prices: [], assets: [] });
    expect(q[0].holdings[0].noPrice).toBe(true);
    expect(q[0].holdings[0].value).toBe(0);
  });
});

describe('consolidate', () => {
  const G = GroupCalc.consolidate(P);
  it('gộp theo mã; FPT do 2 người giữ', () => {
    const fpt = G.symbols.find(s => s.symbol === 'FPT');
    expect(fpt.quantity).toBe(150);
    expect(fpt.holderCount).toBe(2);
    expect(fpt.value).toBe(150 * 111000);
    expect(fpt.holders.map(h => h.name)).toEqual(['An', 'binh']);
    expect(fpt.topHolderSharePct).toBeCloseTo(100 / 150 * 100, 6);
    expect(fpt.sector).toBe('Công nghệ');
  });
  it('tổng: giá trị cổ phiếu, tiền, nợ, NAV; tỷ trọng cộng 100%; mã chung', () => {
    expect(G.marketValue).toBe(P.reduce((s, p) => s + p.marketValue, 0));
    expect(G.cash).toBe(15e6); expect(G.debt).toBe(2e6);
    expect(G.nav).toBe(G.marketValue + 13e6);
    expect(G.symbols.reduce((s, x) => s + x.weightPct, 0)).toBeCloseTo(100, 6);
    expect(G.sharedCount).toBe(1);
    expect(G.sharedValuePct).toBeCloseTo(G.symbols.find(s => s.symbol === 'FPT').weightPct, 6);
    expect(G.symbols[0].value).toBeGreaterThanOrEqual(G.symbols[1].value);
  });
});

describe('overlap / overlapWithGroup', () => {
  it('trùng danh mục giữa từng cặp = tổng min tỷ trọng; ma trận đối xứng, chéo 100', () => {
    const o = GroupCalc.overlap(P);
    expect(o.names).toEqual(['An', 'binh', 'Chi']);
    o.matrix.forEach((row, i) => { expect(row[i]).toBe(100); row.forEach((v, j) => expect(v).toBeCloseTo(o.matrix[j][i], 6)); });
    const ab = o.pairs.find(p => (p.a === 'An' && p.b === 'binh'));
    expect(ab.common).toEqual(['FPT']);
    // An: FPT 52,6% / VCB 47,4%; binh: FPT 15,6%/ HPG 84,4% -> min FPT = 15,6%
    const wBinhFpt = 50 * 111000 / (50 * 111000 + 300 * 30000) * 100;
    expect(ab.overlapPct).toBeCloseTo(wBinhFpt, 6);
    expect(o.pairs.find(p => p.a === 'An' && p.b === 'Chi').overlapPct).toBe(0);
    expect(o.avgPct).toBeGreaterThan(0);
  });
  it('phần danh mục của mỗi người trùng với mã người khác cũng giữ', () => {
    const G = GroupCalc.consolidate(P);
    expect(GroupCalc.overlapWithGroup(P[2], G)).toBe(0);
    expect(GroupCalc.overlapWithGroup(P[0], G)).toBeCloseTo(100 * 111000 / P[0].marketValue * 100, 6);
  });
});

describe('groupNavHistory', () => {
  const nav = (user_id, d, n, net) => ({ user_id, snapshot_date: d, nav: n, net_contributed: net, cash: 0, market_value: n });
  it('cộng NAV các thành viên theo ngày, giữ giá trị gần nhất khi thiếu ngày; thành viên chưa bắt đầu = 0', () => {
    const rows = [nav('u1', '2026-01-01', 100, 100), nav('u1', '2026-01-02', 110, 100), nav('u1', '2026-01-03', 120, 100),
                  nav('u2', '2026-01-02', 50, 50), nav('u2', '2026-01-04', 60, 50)];
    const g = GroupCalc.groupNavHistory(rows);
    expect(g.map(x => [x.snapshot_date, x.nav, x.net_contributed, x.members])).toEqual([
      ['2026-01-01', 100, 100, 1], ['2026-01-02', 160, 150, 2], ['2026-01-03', 170, 150, 2], ['2026-01-04', 180, 150, 2],
    ]);
  });
  it('rỗng -> rỗng; bỏ dòng thiếu user hoặc ngày', () => {
    expect(GroupCalc.groupNavHistory([])).toEqual([]);
    expect(GroupCalc.groupNavHistory([{ snapshot_date: '2026-01-01', nav: 1 }])).toEqual([]);
  });
});

describe('memberTable', () => {
  it('dòng từng thành viên: tỷ trọng NAV, mã lớn nhất, tiền mặt, đòn bẩy; hiệu quả khi có phân tích', () => {
    const G = GroupCalc.consolidate(P);
    const perf = { u1: { ok: true, enough: true, hasBench: true, cumulativePct: 10, excessCumulativePct: 3, alphaPct: 4, beta: 1.1, sharpe: 1.2, maxDD: -8, volatilityPct: 15, informationRatio: 0.6, periods: 200 } };
    const rows = GroupCalc.memberTable(P, perf, G);
    expect(rows.map(r => r.name)).toEqual(['An', 'binh', 'Chi']);
    expect(rows.reduce((s, r) => s + r.sharePct, 0)).toBeCloseTo(100, 6);
    const an = rows[0];
    expect(an.topSymbol).toBe('FPT');
    expect(an.cashPct).toBeCloseTo(5e6 / P[0].nav * 100, 6);
    expect(an).toMatchObject({ returnPct: 10, excessPct: 3, alphaPct: 4, beta: 1.1, enough: true });
    expect(an.contributionPct).toBeCloseTo(an.sharePct / 100 * 10, 6);
    expect(rows[1].leverage).toBeCloseTo(P[1].marketValue / P[1].nav, 6);   // chỉ tính khi có nợ vay (binh nợ 2tr)
    expect(rows[0].leverage).toBeNull();
    expect(rows[1].returnPct).toBeNull();                          // chưa có phân tích hiệu quả
    expect(rows[2].overlapWithGroupPct).toBe(0);
  });
});
