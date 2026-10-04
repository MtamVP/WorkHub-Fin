// lib/limits-calc.js: giới hạn đầu tư của nhóm -- mức sử dụng, hai tầng nhóm/cá nhân, kiểm tra lệnh trước khi ghi, ma trận tuân thủ.
import { describe, it, expect } from 'vitest';
import L from '../../lib/limits-calc.js';

const lim = (o) => Object.assign({ id: 'l' + Math.random().toString(36).slice(2, 7), scope: 'member', user_id: null, kind: 'max_symbol_pct', symbol: null, sector: null, value: 25, mode: 'reason', note: '', active: true }, o);
const pf = (holdings, cash = 0, debt = 0) => ({ holdings: Object.entries(holdings).map(([symbol, value]) => ({ symbol, value })), cash, debt });
const PF = pf({ FPT: 200e6, VCB: 100e6, HPG: 50e6 }, 150e6);             // NAV 500tr: FPT 40%, VCB 20%, HPG 10%, tiền 30%

describe('validate', () => {
  it('chấp nhận giới hạn hợp lệ và chuẩn hoá trường không liên quan', () => {
    const r = L.validate({ kind: 'max_symbol_pct', value: 25, mode: 'block', sector: 'Ngân hàng', symbol: 'fpt' });
    expect(r.ok).toBe(true);
    expect(r.limit).toMatchObject({ symbol: 'FPT', sector: null, value: 25, mode: 'block' });
    expect(L.validate({ kind: 'blocked_symbol', symbol: 'abc' }).limit).toMatchObject({ symbol: 'ABC', value: null });
  });
  it.each([
    [{ kind: 'xxx', value: 1 }, /Loại/], [{ kind: 'max_symbol_pct', value: 0 }, /0–100/], [{ kind: 'max_symbol_pct', value: 150 }, /0–100/], [{ kind: 'max_symbol_pct' }, /ngưỡng/],
    [{ kind: 'blocked_symbol' }, /mã cần cấm/], [{ kind: 'max_leverage', value: 50 }, /Đòn bẩy/], [{ kind: 'max_position_vnd', value: 0 }, /lớn hơn 0/], [{ kind: 'min_cash_pct', value: 120 }, /100%/],
    [{ kind: 'max_symbol_pct', value: 10, scope: 'xxx' }, /Phạm vi/],
  ])('từ chối giới hạn xấu %#', (input, re) => { expect(L.validate(input).error).toMatch(re); });
});

describe('applicable và pick: hai tầng, giới hạn riêng thay thế giới hạn chung của tầng đó', () => {
  const rows = [
    lim({ id: 'g', value: 30 }), lim({ id: 'gf', symbol: 'FPT', value: 45 }), lim({ id: 'u1', scope: 'user', user_id: 'me', value: 25 }), lim({ id: 'u2', scope: 'user', user_id: 'other', value: 5 }),
    lim({ id: 'off', value: 1, active: false }), lim({ id: 'c', scope: 'consolidated', value: 20 }),
  ];
  it('chỉ lấy giới hạn đang bật của nhóm + của chính người đó; tầng gộp tách riêng', () => {
    expect(L.applicable(rows, 'me', 'member').map(l => l.id).sort()).toEqual(['g', 'gf', 'u1']);
    expect(L.applicable(rows, 'me', 'consolidated').map(l => l.id)).toEqual(['c']);
  });
  it('mức áp dụng = chặt hơn giữa tầng nhóm (riêng cho mã nếu có) và tầng cá nhân', () => {
    const a = L.applicable(rows, 'me', 'member');
    expect(L.pick(a, 'max_symbol_pct', 'symbol', 'VCB').id).toBe('u1');      // nhóm chung 30, cá nhân 25 -> 25
    expect(L.pick(a, 'max_symbol_pct', 'symbol', 'FPT').id).toBe('u1');      // nhóm riêng FPT 45 nới hơn, nhưng cá nhân 25 vẫn chặt hơn
    const noUser = L.applicable(rows, 'nobody', 'member');
    expect(L.pick(noUser, 'max_symbol_pct', 'symbol', 'FPT').id).toBe('gf');  // không có tầng cá nhân: dùng mức riêng FPT
    expect(L.pick(noUser, 'max_symbol_pct', 'symbol', 'VCB').id).toBe('g');
    expect(L.pick(a, 'max_leverage', null, null)).toBeNull();
  });
  it('ngang mức thì lấy chế độ nghiêm hơn; min_cash lấy mức cao hơn', () => {
    const a = L.applicable([lim({ id: 'x', value: 25, mode: 'warn' }), lim({ id: 'y', scope: 'user', user_id: 'me', value: 25, mode: 'block' })], 'me', 'member');
    expect(L.pick(a, 'max_symbol_pct', 'symbol', 'FPT').id).toBe('y');
    const c = L.applicable([lim({ id: 'a', kind: 'min_cash_pct', value: 5 }), lim({ id: 'b', scope: 'user', user_id: 'me', kind: 'min_cash_pct', value: 10 })], 'me', 'member');
    expect(L.pick(c, 'min_cash_pct', null, null).id).toBe('b');
  });
});

describe('evaluate', () => {
  it('mã vượt trần: breach; gần trần: warn; còn lại ok; mẫu số là NAV (gồm tiền mặt)', () => {
    const r = L.evaluate(L.applicable([lim({ value: 25 })], 'me', 'member'), PF);
    expect(r.nav).toBe(500e6);
    const by = Object.fromEntries(r.items.map(i => [i.subject, i]));
    expect(by.FPT.current).toBeCloseTo(40, 9); expect(by.FPT.status).toBe('breach');
    expect(by.VCB.status).toBe('ok');                                         // 20/25 = 80% < 90%
  });
  it('ngưỡng 90% trở lên báo gần chạm', () => {
    const r = L.evaluate(L.applicable([lim({ value: 22 })], 'me', 'member'), PF);
    expect(r.items.find(i => i.subject === 'VCB').status).toBe('warn');       // 20/22 = 91%
    expect(r.items.find(i => i.subject === 'HPG').status).toBe('ok');
    expect(r.warns.map(i => i.subject)).toEqual(['VCB']);
  });
  it('ngành: gộp theo ngành, bỏ ngành chưa phân loại trừ khi có giới hạn đích danh', () => {
    const p = pf({ VCB: 100e6, TCB: 100e6, ZZZ: 200e6 }, 100e6);
    const r = L.evaluate(L.applicable([lim({ kind: 'max_sector_pct', value: 30 })], 'me', 'member'), p);
    expect(r.items.map(i => i.subject)).toEqual(['Ngân hàng']);
    expect(r.items[0].current).toBeCloseTo(40, 9); expect(r.items[0].status).toBe('breach');
    const named = L.evaluate(L.applicable([lim({ kind: 'max_sector_pct', sector: 'Chưa phân ngành', value: 30 })], 'me', 'member'), p);
    expect(named.items.map(i => i.subject)).toEqual(['Chưa phân ngành']);
  });
  it('tiền mặt tối thiểu, đòn bẩy, vị thế tối đa, mã bị cấm', () => {
    const limits = L.applicable([lim({ kind: 'min_cash_pct', value: 35 }), lim({ kind: 'max_leverage', value: 0.6 }), lim({ kind: 'max_position_vnd', value: 150e6 }), lim({ kind: 'blocked_symbol', symbol: 'HPG', mode: 'block' }), lim({ kind: 'blocked_symbol', symbol: 'ZZZ' })], 'me', 'member');
    const r = L.evaluate(limits, PF);
    const f = (k, s) => r.items.find(i => i.kind === k && i.subject === s);
    expect(f('min_cash_pct', 'Tiền mặt')).toMatchObject({ current: 30, status: 'breach' });
    expect(f('max_leverage', 'Đòn bẩy').current).toBeCloseTo(350 / 500, 9);
    expect(f('max_leverage', 'Đòn bẩy').status).toBe('breach');
    expect(f('max_position_vnd', 'FPT').status).toBe('breach');
    expect(f('blocked_symbol', 'HPG')).toMatchObject({ status: 'breach', held: true, mode: 'block' });
    expect(f('blocked_symbol', 'ZZZ').status).toBe('ok');
  });
  it('NAV không dương -> không đánh giá', () => { expect(L.evaluate([], pf({ A: 10 }, 0, 100)).items).toEqual([]); });
});

describe('checkTrade', () => {
  const limits = L.applicable([lim({ value: 25, mode: 'reason' }), lim({ kind: 'min_cash_pct', value: 10, mode: 'warn' }), lim({ kind: 'blocked_symbol', symbol: 'BAD', mode: 'block' })], 'me', 'member');
  const base = pf({ FPT: 100e6, VCB: 100e6 }, 300e6);                         // NAV 500tr: mỗi mã 20%
  it('mua làm một mã vượt trần -> vi phạm cần lý do, kèm trước/sau', () => {
    const c = L.checkTrade(limits, base, { type: 'buy', symbol: 'FPT', quantity: 1000, price: 50000 });   // +50tr -> FPT 150tr / 500tr = 30%
    expect(c.ok).toBe(false);
    expect(c.violations).toHaveLength(1);
    expect(c.violations[0]).toMatchObject({ kind: 'max_symbol_pct', subject: 'FPT', mode: 'reason' });
    expect(c.violations[0].before).toBeCloseTo(20, 9); expect(c.violations[0].after).toBeCloseTo(30, 9);
    expect(c.violations[0].text).toMatch(/FPT sẽ chiếm 30% NAV \(trần 25%\)/);
    expect(c.needsReason).toBe(true); expect(c.blocked).toBe(false); expect(c.maxMode).toBe('reason');
  });
  it('lệnh trong giới hạn -> ok; mua mã mới vượt trần ngay lần đầu', () => {
    expect(L.checkTrade(limits, base, { type: 'buy', symbol: 'FPT', quantity: 100, price: 50000 }).ok).toBe(true);
    const c = L.checkTrade(limits, base, { type: 'buy', symbol: 'MWG', quantity: 3000, price: 50000 });   // 150tr = 30% (tiền mặt còn 150tr = 30%)
    expect(c.violations.map(v => v.subject)).toEqual(['MWG']);
  });
  it('bán không bao giờ tạo vi phạm "tối đa"; bán xuống dưới tiền mặt tối thiểu không xảy ra; bán mã bị cấm luôn được', () => {
    const over = pf({ FPT: 200e6, VCB: 100e6, BAD: 50e6 }, 150e6);
    const sellFpt = L.checkTrade(limits, over, { type: 'sell', symbol: 'FPT', quantity: 1000, price: 50000 });   // FPT 40% -> 30%: vẫn vượt nhưng đang GIẢM
    expect(sellFpt.violations).toEqual([]);
    expect(L.checkTrade(limits, over, { type: 'sell', symbol: 'BAD', quantity: 1000, price: 50000 }).violations).toEqual([]);
  });
  it('mua mã bị cấm -> chặn; mua thêm khi đang vượt -> vi phạm vì làm tệ thêm', () => {
    const c = L.checkTrade(limits, base, { type: 'buy', symbol: 'BAD', quantity: 1, price: 1000 });
    expect(c.blocked).toBe(true); expect(c.maxMode).toBe('block');
    const over = pf({ FPT: 200e6, VCB: 100e6 }, 200e6);
    const worse = L.checkTrade(limits, over, { type: 'buy', symbol: 'FPT', quantity: 100, price: 50000 });
    expect(worse.violations.some(v => v.subject === 'FPT')).toBe(true);
  });
  it('mua làm tiền mặt xuống dưới mức tối thiểu -> vi phạm chế độ cảnh báo; sắp xếp theo độ nghiêm', () => {
    const tight = pf({ FPT: 100e6 }, 120e6);                                   // NAV 220tr
    const c = L.checkTrade(limits, tight, { type: 'buy', symbol: 'BAD', quantity: 1000, price: 105000 });    // cấm + hết tiền
    expect(c.violations[0].mode).toBe('block');
    expect(c.violations.some(v => v.kind === 'min_cash_pct')).toBe(true);
    expect(c.violations.map(v => v.mode)).toEqual([...c.violations.map(v => v.mode)].sort((a, b) => L.MODES[b].rank - L.MODES[a].rank));
  });
  it('gần chạm (sau lệnh ≥ 90% hạn mức) được báo ở near, không phải vi phạm', () => {
    const c = L.checkTrade(limits, base, { type: 'buy', symbol: 'FPT', quantity: 500, price: 50000 });      // FPT 125tr = 25% đúng bằng trần -> không vượt
    expect(c.ok).toBe(true);
    expect(c.near.some(n => n.subject === 'FPT')).toBe(true);
  });
  it('không có giới hạn nào -> luôn ok', () => { expect(L.checkTrade([], base, { type: 'buy', symbol: 'FPT', quantity: 1e6, price: 1e6 }).ok).toBe(true); });
});

describe('applyTrade', () => {
  it('mua trừ tiền kèm phí; bán cộng tiền trừ phí và thuế, không để vị thế âm; không sửa bản gốc', () => {
    const base = pf({ FPT: 100e6 }, 50e6);
    const b = L.applyTrade(base, { type: 'buy', symbol: 'VCB', quantity: 100, price: 100000, fee: 15000 });
    expect(b.cash).toBe(50e6 - 10e6 - 15000);
    expect(b.holdings.find(h => h.symbol === 'VCB').value).toBe(10e6);
    const s = L.applyTrade(base, { type: 'sell', symbol: 'FPT', quantity: 5000, price: 100000, fee: 1000, tax: 500 });
    expect(s.holdings[0].value).toBe(0);                                       // bán vượt giá trị -> về 0
    expect(s.cash).toBe(50e6 + 500e6 - 1500);
    expect(base.holdings[0].value).toBe(100e6);
  });
});

describe('complianceMatrix', () => {
  it('đánh giá từng thành viên theo giới hạn của họ và cả nhóm gộp', () => {
    const portfolios = [
      { id: 'u1', name: 'An', cash: 100e6, debt: 0, holdings: [{ symbol: 'FPT', value: 300e6 }, { symbol: 'VCB', value: 100e6 }] },
      { id: 'u2', name: 'Bình', cash: 300e6, debt: 0, holdings: [{ symbol: 'HPG', value: 100e6 }, { symbol: 'FPT', value: 100e6 }] },
    ];
    const group = { symbols: [{ symbol: 'FPT', value: 400e6 }, { symbol: 'VCB', value: 100e6 }, { symbol: 'HPG', value: 100e6 }], cash: 400e6, debt: 0 };
    const rows = [lim({ value: 40 }), lim({ scope: 'user', user_id: 'u2', value: 10 }), lim({ scope: 'consolidated', value: 30 })];
    const m = L.complianceMatrix(rows, portfolios, group);
    expect(m.rows[0].breaches.map(b => b.subject)).toEqual(['FPT']);            // An: FPT 300/500 = 60% > 40%
    expect(m.rows[1].breaches.map(b => b.subject).sort()).toEqual(['FPT', 'HPG']); // Bình: giới hạn cá nhân 10% chặt hơn: 100/500 = 20% mỗi mã
    expect(m.consolidated.breaches.map(b => b.subject)).toEqual(['FPT']);       // 400/1000 = 40% > 30%
    expect(m.totalBreaches).toBe(4);
  });
});

describe('checkImport: lô lệnh nhập từ sao kê', () => {
  // NAV 500tr: FPT 200tr (40%), VCB 100tr, HPG 50tr, tiền 150tr; trần một mã 45%
  const rows = [lim({ value: 45, mode: 'reason' })];
  const t = (o) => Object.assign({ symbol: 'FPT', type: 'buy', quantity: 1000, price: 100000, date: '2026-01-10' }, o);
  it('mua ròng đẩy mã vượt trần -> vi phạm, tính theo giá hiện tại nếu có', () => {
    const r = L.checkImport(rows, PF, [t({ quantity: 500 })], { FPT: 110000 });     // +55tr => 255tr / 555? NAV không đổi cash => tử 255 / (255+100+50+150=555)=45.9%
    expect(r.violations.length).toBe(1);
    expect(r.violations[0].subject).toBe('FPT');
    expect(r.violations[0].after).toBeCloseTo(255 / 555 * 100, 4);
    expect(r.needsReason).toBe(true);
  });
  it('mua rồi bán lại trong cùng lô thì ròng bằng 0: không đổi gì', () => {
    const r = L.checkImport(rows, PF, [t({ quantity: 800 }), t({ type: 'sell', quantity: 800, date: '2026-02-01' })], {});
    expect(r.violations).toEqual([]);
    expect(r.after.nav).toBeCloseTo(r.before.nav, 6);
  });
  it('không đổi tiền mặt dù lô có mua/bán (nhập sao kê không điều chỉnh tiền)', () => {
    const r = L.checkImport(rows, PF, [t({ symbol: 'VCB', quantity: 100 })], { VCB: 100000 });
    expect(r.after.items.find(i => i.subject === 'VCB').current).toBeGreaterThan(r.before.items.find(i => i.subject === 'VCB').current);
    const cashPct = (x) => x.nav;                     // NAV tăng đúng bằng giá trị cổ phiếu thêm vào => tiền mặt giữ nguyên
    expect(cashPct(r.after) - cashPct(r.before)).toBeCloseTo(100 * 100000, 3);
  });
  it('mua mã bị cấm trong lô -> vi phạm; chỉ bán mã bị cấm thì không', () => {
    const ban = [lim({ kind: 'blocked_symbol', symbol: 'ABC', value: null, mode: 'block' })];
    expect(L.checkImport(ban, PF, [t({ symbol: 'ABC' })], {}).blocked).toBe(true);
    expect(L.checkImport(ban, pf({ ABC: 10e6, FPT: 90e6 }, 100e6), [t({ symbol: 'ABC', type: 'sell', quantity: 50, price: 100000 })], { ABC: 100000 }).violations).toEqual([]);
  });
  it('giới hạn đã vượt từ trước mà lô không làm tệ thêm: không tính là vi phạm mới', () => {
    const over = L.checkImport(rows, pf({ FPT: 400e6, VCB: 100e6 }, 100e6), [t({ symbol: 'VCB', quantity: 10 })], { VCB: 100000 });
    expect(over.violations.find(v => v.subject === 'FPT')).toBeUndefined();
  });
  it('lô rỗng hoặc không có giới hạn: không vi phạm', () => {
    expect(L.checkImport(rows, PF, [], {}).ok).toBe(true);
    expect(L.checkImport([], PF, [t()], {}).ok).toBe(true);
  });
});

describe('breachEpisodes: đợt vi phạm từ nhật ký theo ngày', () => {
  const day = (d, user_id, breaches) => ({ log_date: d, user_id, breaches });
  const b = (kind, subject, current, extra = {}) => Object.assign({ kind, subject, current, threshold: 25, mode: 'reason' }, extra);
  it('chuỗi ngày liên tiếp được gộp thành một đợt, ghi đỉnh và giá trị mới nhất', () => {
    const e = L.breachEpisodes([day('2026-10-01', 'u1', [b('max_symbol_pct', 'FPT', 27)]), day('2026-10-02', 'u1', [b('max_symbol_pct', 'FPT', 31)]), day('2026-10-03', 'u1', [b('max_symbol_pct', 'FPT', 29)])]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ userId: 'u1', subject: 'FPT', firstDate: '2026-10-01', lastDate: '2026-10-03', days: 3, calendarDays: 3, ongoing: true, peak: 31, current: 29 });
  });
  it('hết vi phạm rồi lại vượt: hai đợt riêng, đợt cũ đã kết thúc', () => {
    const e = L.breachEpisodes([day('2026-10-01', 'u1', [b('max_symbol_pct', 'FPT', 27)]), day('2026-10-02', 'u1', []), day('2026-10-03', 'u1', [b('max_symbol_pct', 'FPT', 26)])]);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ ongoing: true, firstDate: '2026-10-03', days: 1 });
    expect(e[1]).toMatchObject({ ongoing: false, firstDate: '2026-10-01', days: 1 });
  });
  it('mỗi thành viên và mỗi (loại, đối tượng) tách riêng; cả nhóm (user_id rỗng) cũng được theo dõi', () => {
    const e = L.breachEpisodes([
      day('2026-10-01', 'u1', [b('max_symbol_pct', 'FPT', 27), b('max_sector_pct', 'Ngân hàng', 45)]), day('2026-10-01', 'u2', [b('max_symbol_pct', 'FPT', 28)]), day('2026-10-01', null, [b('max_symbol_pct', 'FPT', 30)]),
      day('2026-10-02', 'u1', [b('max_symbol_pct', 'FPT', 27)]), day('2026-10-02', 'u2', []), day('2026-10-02', null, [b('max_symbol_pct', 'FPT', 31)]),
    ]);
    expect(e).toHaveLength(4);
    expect(e.find(x => x.userId === 'u1' && x.subject === 'Ngân hàng').ongoing).toBe(false);
    expect(e.find(x => x.userId === 'u2').ongoing).toBe(false);
    expect(e.find(x => x.userId === null)).toMatchObject({ days: 2, ongoing: true });
  });
  it('thứ tự: đang diễn ra trước, rồi lâu nhất; dữ liệu vào lộn xộn vẫn đúng', () => {
    const e = L.breachEpisodes([day('2026-10-03', 'u1', [b('max_symbol_pct', 'FPT', 27)]), day('2026-10-01', 'u1', [b('max_symbol_pct', 'FPT', 27), b('min_cash_pct', 'Tiền mặt', 3)]), day('2026-10-02', 'u1', [b('max_symbol_pct', 'FPT', 27)])]);
    expect(e.map(x => x.subject)).toEqual(['FPT', 'Tiền mặt']);
    expect(e[0].days).toBe(3);
    expect(L.breachEpisodes([])).toEqual([]);
    expect(L.breachEpisodes(null)).toEqual([]);
  });
  it('cuối tuần không có nhật ký: vẫn là một đợt liên tục, calendarDays > days', () => {
    const e = L.breachEpisodes([day('2026-10-02', 'u1', [b('max_symbol_pct', 'FPT', 27)]), day('2026-10-05', 'u1', [b('max_symbol_pct', 'FPT', 27)])]);
    expect(e[0]).toMatchObject({ days: 2, calendarDays: 4 });
  });
});
