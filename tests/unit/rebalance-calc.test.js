// lib/rebalance-calc.js: đề xuất lệnh đưa danh mục về danh mục chuẩn chiến lược.
import { describe, it, expect } from 'vitest';
import R from '../../lib/rebalance-calc.js';
import LimitsCalc from '../../lib/limits-calc.js';
import SizingCalc from '../../lib/sizing-calc.js';

const NH = 'Ngân hàng', CN = 'Công nghệ', TH = 'Thép & vật liệu', BDS = 'Bất động sản';
// NAV 1.000tr: VCB 360tr (36%), FPT 200tr (20%), HPG 150tr (15%), tiền 290tr (29%)
const H = [{ symbol: 'VCB', sector: NH, quantity: 4000, price: 90000 }, { symbol: 'FPT', sector: CN, quantity: 2000, price: 100000 }, { symbol: 'HPG', sector: TH, quantity: 5000, price: 30000 }];
const base = (o = {}) => Object.assign({ holdings: H, cash: 290e6, debt: 0, policy: { [NH]: 30, [CN]: 25, [TH]: 15 } }, o);   // chuẩn: tiền mặt 30%

describe('plan: đầu vào', () => {
  it('không có chuẩn, chuẩn quá 100%, NAV không dương', () => {
    expect(R.plan(base({ policy: {} })).reason).toBe('noPolicy');
    expect(R.plan(base({ policy: { [NH]: 70, [CN]: 40 } })).reason).toBe('badPolicy');
    expect(R.plan({ holdings: [], cash: 0, debt: 0, policy: { [NH]: 50 } }).reason).toBe('noNav');
  });
});

describe('plan: bán ngành thừa, mua ngành thiếu', () => {
  const p = R.plan(base());
  it('chỉ giao dịch ngành lệch quá biên độ 2 điểm: Ngân hàng thừa 6 điểm, Công nghệ thiếu 5 điểm, Thép đúng chuẩn', () => {
    expect(p.ok).toBe(true);
    expect(p.nav).toBe(1000e6);
    const act = Object.fromEntries(p.sectors.map(s => [s.sector, s.action]));
    expect(act).toEqual({ [NH]: 'sell', [CN]: 'buy', [TH]: 'ok' });
    expect(p.trades.map(t => t.symbol + ':' + t.side)).toEqual(['VCB:sell', 'FPT:buy']);
  });
  it('bán đủ để về chuẩn (làm tròn lô 100), trừ phí và thuế', () => {
    const v = p.trades[0];
    expect(v.quantity).toBe(Math.floor(60e6 / 90000 / 100) * 100);       // 666 -> 600
    expect(v.quantity % 100).toBe(0);
    expect(v.fee).toBeCloseTo(v.value * 0.0015, 6);
    expect(v.tax).toBeCloseTo(v.value * 0.001, 6);
    expect(v.net).toBeCloseTo(v.value - v.fee - v.tax, 6);
  });
  it('mua bằng tiền bán được + tiền mặt dư (giữ tiền mặt chuẩn 30%): thiếu 50tr, đủ tiền', () => {
    const f = p.trades[1];
    expect(f.quantity).toBe(Math.floor(50e6 / (100000 * 1.0015) / 100) * 100);   // 499 -> 400
    expect(f.net).toBeCloseTo(-(f.value + f.fee), 6);
    expect(p.summary.cashAfter).toBeCloseTo(290e6 + p.trades[0].net + f.net, 3);
  });
  it('sau cân bằng lệch chuẩn nhỏ hơn trước; chi phí được tính', () => {
    expect(p.summary.driftAfter).toBeLessThan(p.summary.driftBefore);
    expect(p.summary.cost).toBeCloseTo(p.trades.reduce((s, t) => s + t.fee + t.tax, 0), 6);
    expect(p.sectors.find(s => s.sector === NH).afterPct).toBeLessThan(p.sectors.find(s => s.sector === NH).currentPct);
  });
  it('mã trong cùng ngành chia theo tỷ lệ giá trị', () => {
    const q = R.plan(base({ holdings: H.concat([{ symbol: 'ACB', sector: NH, quantity: 4000, price: 25000 }]), cash: 190e6 }));   // Ngân hàng 460tr/1.000tr = 46%
    const sells = q.trades.filter(t => t.side === 'sell');
    expect(sells.map(t => t.symbol)).toEqual(['VCB', 'ACB']);
    const vcb = sells[0], acb = sells[1];
    expect(vcb.value / acb.value).toBeGreaterThan(2.5);        // VCB giữ 360tr, ACB 100tr -> 3,6 lần (trước làm tròn lô)
  });
});

describe('plan: thiếu tiền, khoảng trống ngành, ngoài chuẩn, thanh khoản, giới hạn', () => {
  it('tiền không đủ thì giảm tỷ lệ các lệnh mua và cảnh báo', () => {
    const p = R.plan(base({ cash: 50e6, holdings: [{ symbol: 'VCB', sector: NH, quantity: 4000, price: 90000 }, { symbol: 'FPT', sector: CN, quantity: 1000, price: 100000 }, { symbol: 'HPG', sector: TH, quantity: 5000, price: 30000 }] }));
    // NAV = 360+100+150+50 = 660tr; Ngân hàng 54,5% (thừa), Công nghệ 15,2% (thiếu 9,8), tiền mặt 7,6% < chuẩn 30%
    expect(p.warnings.join(' ')).toMatch(/chỉ đủ \d+% nhu cầu mua/);
    const buys = p.trades.filter(t => t.side === 'buy');
    expect(buys.reduce((s, t) => s + t.value + t.fee, 0)).toBeLessThanOrEqual(p.summary.funds + 1);
  });
  it('ngành thiếu mà chưa có mã: thành khoảng trống (không tự chọn mã)', () => {
    const p = R.plan(base({ policy: { [NH]: 30, [CN]: 25, [TH]: 15, [BDS]: 10 }, cash: 290e6 }));
    expect(p.gaps.map(g => g.sector)).toEqual([BDS]);
    expect(p.warnings.join(' ')).toMatch(/Bất động sản.*chưa có mã/);
    expect(p.trades.every(t => t.sector !== BDS)).toBe(true);
  });
  it('ngành ngoài chuẩn giữ nguyên; includeOffPolicy=true thì bán dần về 0%', () => {
    const hs = H.concat([{ symbol: 'MWG', sector: 'Bán lẻ', quantity: 1000, price: 60000 }]);
    const keep = R.plan(base({ holdings: hs, cash: 230e6 }));
    expect(keep.trades.some(t => t.symbol === 'MWG')).toBe(false);
    expect(keep.warnings.join(' ')).toMatch(/Bán lẻ/);
    const off = R.plan(base({ holdings: hs, cash: 230e6, includeOffPolicy: true }));
    expect(off.trades.find(t => t.symbol === 'MWG')).toMatchObject({ side: 'sell', quantity: 1000 });
  });
  it('lệnh nhỏ hơn giá trị tối thiểu bị bỏ; biên độ rộng thì không giao dịch', () => {
    expect(R.plan(base({ minValue: 1e9 })).trades).toEqual([]);
    expect(R.plan(base({ bandPts: 10 })).trades).toEqual([]);
  });
  it('thanh khoản cắt khối lượng: tối đa 3 phiên x 20% khối lượng TB ngày', () => {
    const p = R.plan(base({ adv: { VCB: 1000 } }));        // cap = floor(1000 x 0,2 x 3 = 600) = 600 cổ; kế hoạch 600 -> vẫn đủ
    expect(p.trades.find(t => t.symbol === 'VCB').quantity).toBe(600);
    const q = R.plan(base({ adv: { VCB: 500 } }));          // cap 300
    const v = q.trades.find(t => t.symbol === 'VCB');
    expect(v.quantity).toBe(300);
    expect(v.capped).toBe('liquidity');
    expect(v.notes.join(' ')).toMatch(/thanh khoản/);
  });
  it('giới hạn đầu tư cắt khối lượng mua: trần 26% một mã', () => {
    const rows = [{ id: 'l1', scope: 'member', user_id: null, kind: 'max_symbol_pct', symbol: null, sector: null, value: 26, mode: 'block', active: true }];
    const limits = { LC: LimitsCalc, SC: SizingCalc, rows: LimitsCalc.applicable(rows, 'u1', 'member') };
    // VCB 252tr (25,2%), FPT 200tr, HPG 150tr, tiền 398tr; chuẩn: Ngân hàng 20, Công nghệ 30, Thép 15 -> muốn mua thêm ~100tr FPT nhưng trần 26% chỉ cho ~60tr
    const hs = [{ symbol: 'VCB', sector: NH, quantity: 2800, price: 90000 }, { symbol: 'FPT', sector: CN, quantity: 2000, price: 100000 }, { symbol: 'HPG', sector: TH, quantity: 5000, price: 30000 }];
    const free = R.plan({ holdings: hs, cash: 398e6, debt: 0, policy: { [NH]: 20, [CN]: 30, [TH]: 15 } });
    const capped = R.plan({ holdings: hs, cash: 398e6, debt: 0, policy: { [NH]: 20, [CN]: 30, [TH]: 15 }, limits });
    const f0 = free.trades.find(t => t.symbol === 'FPT'), f = capped.trades.find(t => t.symbol === 'FPT');
    expect(f0.value).toBeGreaterThanOrEqual(90e6);
    expect(f.capped).toBe('limit');
    expect(f.value).toBeLessThan(f0.value);
    expect((200e6 + f.value) / 1000e6 * 100).toBeLessThanOrEqual(26.05);
    expect(f.notes.join(' ')).toMatch(/giới hạn đầu tư/);
  });
});
