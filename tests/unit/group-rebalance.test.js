// lib/group-rebalance.js: cân bằng về chuẩn chiến lược ở cấp nhóm (chạy RebalanceCalc cho từng thành viên rồi gộp).
import { describe, it, expect } from 'vitest';
import GR from '../../lib/group-rebalance.js';
import RC from '../../lib/rebalance-calc.js';
import LimitsCalc from '../../lib/limits-calc.js';
import SizingCalc from '../../lib/sizing-calc.js';

const NH = 'Ngân hàng', CN = 'Công nghệ', TH = 'Thép & vật liệu';
const SECTOR = { VCB: NH, FPT: CN, HPG: TH };
const sectorOf = (s) => SECTOR[s] || 'Khác';
const policy = { [NH]: 30, [CN]: 25, [TH]: 15 };
// An: NAV 1.000tr, thừa Ngân hàng, thiếu Công nghệ; Bình: giống hệt (cũng mua FPT); Chi: đúng chuẩn
const P = (id, name, holdings, cash) => ({ id, name, cash, debt: 0, holdings });
const AN = P('a', 'An', [{ symbol: 'VCB', quantity: 4000, price: 90000 }, { symbol: 'FPT', quantity: 2000, price: 100000 }, { symbol: 'HPG', quantity: 5000, price: 30000 }], 290e6);
const BINH = P('b', 'Bình', [{ symbol: 'VCB', quantity: 4000, price: 90000 }, { symbol: 'FPT', quantity: 2000, price: 100000 }, { symbol: 'HPG', quantity: 5000, price: 30000 }], 290e6);
const CHI = P('c', 'Chi', [{ symbol: 'VCB', quantity: 3333, price: 90000 }, { symbol: 'FPT', quantity: 2500, price: 100000 }, { symbol: 'HPG', quantity: 5000, price: 30000 }], 300.03e6);
const run = (o = {}) => GR.build(Object.assign({ portfolios: [AN, BINH, CHI], policy, sectorOf, RC }, o));

describe('GroupRebalance.build', () => {
  it('thiếu thư viện / không có chuẩn: trả lý do rõ ràng', () => {
    expect(GR.build({ portfolios: [AN] }).reason).toBe('noLib');
    expect(run({ policy: {} }).reason).toBe('noPolicy');
    expect(run({ policy: { [NH]: 70, [CN]: 40 } }).reason).toBe('badPolicy');
  });
  it('mỗi thành viên có kế hoạch riêng; người đã đúng chuẩn không có lệnh; tổng gộp đúng', () => {
    const o = run();
    expect(o.ok).toBe(true);
    const by = Object.fromEntries(o.members.map(m => [m.id, m]));
    expect(by.a.plan.trades.map(t => t.symbol + ':' + t.side)).toEqual(['VCB:sell', 'FPT:buy']);
    expect(by.c.plan.trades).toEqual([]);
    expect(o.totals.count).toBe(4);
    expect(o.totals.needAction).toBe(2);
    expect(o.totals.turnover).toBeCloseTo(by.a.plan.summary.turnover + by.b.plan.summary.turnover, 6);
    expect(o.totals.cost).toBeCloseTo(by.a.plan.summary.cost + by.b.plan.summary.cost, 6);
    expect(o.totals.driftAfter).toBeLessThan(o.totals.driftBefore);
  });
  it('gộp theo mã: cộng khối lượng mua/bán và liệt kê ai mua/bán; không tự ghép chéo giữa thành viên', () => {
    const o = run();
    const fpt = o.symbols.find(s => s.symbol === 'FPT'), vcb = o.symbols.find(s => s.symbol === 'VCB');
    expect(fpt.buyQty).toBe(800); expect(fpt.sellQty).toBe(0); expect(fpt.buyers).toEqual(['An', 'Bình']);
    expect(vcb.sellQty).toBe(1200); expect(vcb.sellers).toEqual(['An', 'Bình']);
    expect(o.symbols[0].buyValue + o.symbols[0].sellValue).toBeGreaterThanOrEqual(o.symbols[1].buyValue + o.symbols[1].sellValue);
  });
  it('thanh khoản cấp nhóm: tổng cả nhóm trong trần thì không cảnh báo', () => {
    // TB 5.000 cổ/ngày, trần 3 phiên × 20% = 3.000 cổ; cả nhóm mua 800 FPT, bán 1.200 VCB -> trong trần
    const o = run({ adv: { FPT: 5000, VCB: 5000 } });
    expect(o.warnings).toEqual([]);
    expect(o.symbols.find(s => s.symbol === 'FPT').advPctBuy).toBeCloseTo(16, 9);
  });
  it('trần thanh khoản gộp: 4 thành viên cùng mua một mã nhỏ thì cảnh báo dù mỗi người trong trần của mình', () => {
    const mk = (id) => P(id, 'M' + id, [{ symbol: 'VCB', quantity: 4000, price: 90000 }, { symbol: 'FPT', quantity: 2000, price: 100000 }, { symbol: 'HPG', quantity: 5000, price: 30000 }], 290e6);
    const o = run({ portfolios: [mk('1'), mk('2'), mk('3'), mk('4')], adv: { FPT: 2200 } });     // trần mỗi người 3×20%×2200 = 1.320 -> mua 400 mỗi người; cả nhóm 1.600 > 1.320
    const fpt = o.symbols.find(s => s.symbol === 'FPT');
    expect(fpt.buyQty).toBe(1600);
    expect(fpt.cap).toBeCloseTo(1320, 6);
    expect(fpt.overCap).toBe(true);
    expect(o.warnings.some(w => /Cả nhóm cùng MUA FPT/.test(w))).toBe(true);
  });
  it('giới hạn đầu tư của từng người được áp dụng riêng', () => {
    const limitFor = (id) => (id === 'a' ? [{ id: 'l1', scope: 'member', kind: 'max_symbol_pct', symbol: 'FPT', value: 20.5, mode: 'block', active: true }] : []);
    const o = run({ LC: LimitsCalc, SC: SizingCalc, limitsFor: limitFor });
    const a = o.members.find(m => m.id === 'a').plan, b = o.members.find(m => m.id === 'b').plan;
    const fa = a.trades.find(t => t.symbol === 'FPT'), fb = b.trades.find(t => t.symbol === 'FPT');
    expect(fb.quantity).toBe(400);
    expect(!fa || fa.quantity < fb.quantity).toBe(true);
  });
  it('khoảng trống ngành chưa có mã được gộp: cộng số tiền và liệt kê ai thiếu', () => {
    const o = run({ policy: { [NH]: 30, [CN]: 25, [TH]: 15, 'Bất động sản': 10 } });
    const g = o.gaps.find(x => x.sector === 'Bất động sản');
    expect(g).toBeTruthy();
    expect(g.members).toContain('An');
    expect(g.amount).toBeGreaterThan(0);
    expect(o.gaps.every(x => x.amount > 0)).toBe(true);      // ngành không còn tiền để mua thì không hiện thành khoảng trống
  });
  it('thành viên không có NAV được đánh dấu riêng, không làm hỏng các người khác', () => {
    const o = run({ portfolios: [AN, P('z', 'Zé', [], 0)] });
    expect(o.ok).toBe(true);
    expect(o.members.find(m => m.id === 'z')).toMatchObject({ ok: false, reason: 'noNav' });
    expect(o.totals.count).toBe(2);
  });
});
