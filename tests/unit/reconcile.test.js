// lib/reconcile.js: đối soát sổ lệnh với sao kê công ty chứng khoán -- số dư mã (kèm gợi ý nguyên nhân), tiền mặt, và lệnh trong kỳ.
import { describe, it, expect } from 'vitest';
import R from '../../lib/reconcile.js';
import SI from '../../lib/statement-import.js';

const T = (id, type, symbol, quantity, price, trade_date, extra = {}) => ({ id, type, symbol, quantity, price, trade_date, fee: 0, tax: 0, created_at: trade_date + 'T01:00:00Z', deleted_at: null, ...extra });
const csv = (text) => SI.parseCsv(text);

describe('detectKind / detectPositionColumns', () => {
  it('sao kê số dư kiểu công ty chứng khoán: nhận đủ cột, ưu tiên "Tổng KL" hơn "KL khả dụng"', () => {
    const rows = csv('Công ty CK ABC - Sao kê số dư chứng khoán\nNgày: 30/09/2026\n\nMã CK,KL khả dụng,KL chờ về,Tổng KL,Giá vốn,Giá thị trường,Giá trị\nFPT,900,0,1000,"98.000","110.000","110.000.000"\nVCB,500,0,500,"88.000","95.000","47.500.000"');
    const d = R.detectPositionColumns(rows);
    expect(d.headerRow).toBe(2);               // dòng trống bị bỏ khi đọc CSV
    expect(d.mapping).toMatchObject({ symbol: 0, quantity: 3, cost: 4, price: 5, value: 6 });
    expect(R.detectKind(rows)).toBe('positions');
  });
  it('sao kê lệnh được nhận ra là "trades"', () => {
    const rows = csv('Ngày giao dịch,Mã CK,Loại lệnh,Khối lượng,Giá\n15/09/2026,SSI,Mua,1000,33800');
    expect(R.detectKind(rows)).toBe('trades');
  });
  it('không nhận ra -> null', () => {
    expect(R.detectKind(csv('a,b,c\n1,2,3'))).toBeNull();
    expect(R.detectKind([])).toBeNull();
  });
});

describe('normalizePositions', () => {
  const rows = csv('Mã CK,Số lượng,Giá vốn\nfpt,"1,000","98.000"\nVCB,500,88000\nVCB,100,90000\nTổng cộng,1600,\n,,\nABC DEF!,10,5\nHPG,âm,1');
  const d = R.detectPositionColumns(rows);
  const n = R.normalizePositions(rows, { headerRow: d.headerRow, mapping: d.mapping });
  it('chuẩn hoá mã, số; gộp cùng mã (cộng khối lượng, giá vốn bình quân gia quyền)', () => {
    expect(n.rows.map((r) => r.symbol)).toEqual(['FPT', 'VCB']);
    expect(n.rows[0]).toMatchObject({ quantity: 1000, cost: 98000 });
    const v = n.rows[1];
    expect(v.quantity).toBe(600);
    expect(v.merged).toBe(2);
    expect(v.cost).toBeCloseTo((88000 * 500 + 90000 * 100) / 600, 6);
  });
  it('bỏ dòng tổng, dòng trống, mã sai, khối lượng sai và nói lý do', () => {
    expect(n.skipped.map((s) => s.reason).join('|')).toMatch(/tổng/i);
    expect(n.skipped.some((s) => /Mã không hợp lệ/.test(s.reason))).toBe(true);
    expect(n.skipped.some((s) => /Khối lượng/.test(s.reason))).toBe(true);
  });
  it('đọc ngày sao kê nếu file có cột ngày', () => {
    const r2 = csv('Ngày sao kê,Mã,Số lượng\n30/09/2026,FPT,100');
    const d2 = R.detectPositionColumns(r2);
    expect(R.normalizePositions(r2, { headerRow: d2.headerRow, mapping: d2.mapping }).asOf).toBe('2026-09-30');
  });
});

describe('positionsAsOf', () => {
  const txns = [T('1', 'buy', 'FPT', 1000, 100000, '2026-01-05'), T('2', 'sell', 'FPT', 400, 120000, '2026-03-01'), T('3', 'buy', 'VCB', 200, 90000, '2026-05-01'), T('x', 'buy', 'ZZZ', 5, 1, '2026-02-01', { deleted_at: '2026-02-02T00:00:00Z' })];
  const actions = [{ symbol: 'FPT', action_type: 'stock_dividend', ratio: 0.1, ex_date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', deleted_at: null }];
  it('tính tới đúng ngày: trước thưởng, sau thưởng, mã mua sau chưa có', () => {
    expect(R.positionsAsOf(txns, actions, '2026-03-15').FPT.quantity).toBe(600);
    expect(R.positionsAsOf(txns, actions, '2026-03-15').VCB).toBeUndefined();
    const p = R.positionsAsOf(txns, actions, '2026-06-01');
    expect(p.FPT.quantity).toBeCloseTo(660, 6);
    expect(p.VCB.quantity).toBe(200);
    expect(p.ZZZ).toBeUndefined();
  });
  it('mã bán hết không có trong kết quả', () => {
    expect(R.positionsAsOf([T('1', 'buy', 'AAA', 10, 1, '2026-01-01'), T('2', 'sell', 'AAA', 10, 2, '2026-01-02')], [], '2026-02-01')).toEqual({});
  });
});

describe('comparePositions', () => {
  const S = (symbol, quantity, extra = {}) => ({ line: 1, symbol, quantity, cost: null, price: null, value: null, merged: 1, ...extra });
  const A = (q, c = 100000) => ({ quantity: q, avgCost: c });
  it('khớp hoàn toàn', () => {
    const r = R.comparePositions([S('FPT', 100), S('VCB', 50)], { FPT: A(100), VCB: A(50) });
    expect(r).toMatchObject({ total: 2, matched: 2, mismatched: 0, matchedPct: 100, valueAtStake: 0 });
  });
  it('phân loại: thiếu trong sổ, thừa trong sổ, lệch khối lượng', () => {
    const r = R.comparePositions([S('FPT', 100, { cost: 98000 }), S('NEW', 30, { cost: 50000 }), S('VCB', 40)], { FPT: A(100), VCB: A(50), OLD: A(20, 10000) });
    const by = Object.fromEntries(r.items.map((i) => [i.symbol, i]));
    expect(by.FPT.status).toBe('match');
    expect(by.NEW.status).toBe('missing_in_app');
    expect(by.OLD.status).toBe('extra_in_app');
    expect(by.VCB.status).toBe('qty_diff');
    expect(by.VCB.diff).toBe(-10);
    expect(r).toMatchObject({ mismatched: 3, missingInApp: 1, extraInApp: 1, qtyDiff: 1 });
  });
  it('lệnh điều chỉnh gợi ý: mua phần thiếu theo giá vốn sao kê; bán phần thừa', () => {
    const r = R.comparePositions([S('NEW', 30, { cost: 50000 }), S('VCB', 40, { price: 95000 })], { VCB: A(50) });
    expect(r.items.find((i) => i.symbol === 'NEW').fix).toEqual({ type: 'buy', quantity: 30, price: 50000 });
    expect(r.items.find((i) => i.symbol === 'VCB').fix).toEqual({ type: 'sell', quantity: 10, price: 95000 });
  });
  it('gợi ý thiếu thưởng cổ phiếu khi sao kê gấp 1,1 lần sổ', () => {
    const r = R.comparePositions([S('FPT', 1100)], { FPT: A(1000) });
    const i = r.items[0];
    expect(i.status).toBe('qty_diff');
    expect(i.hints.join(' ')).toMatch(/thưởng/);
    expect(i.fixAction).toEqual({ actionType: 'stock_dividend', ratio: 0.1 });
    const s = R.comparePositions([S('FPT', 2000)], { FPT: A(1000) }).items[0];
    expect(s.fixAction).toEqual({ actionType: 'split', ratio: 2 });
  });
  it('gợi ý lệnh bị nhập trùng / nhập nhầm chiều dựa trên sổ lệnh', () => {
    const txns = [T('1', 'buy', 'FPT', 100, 100000, '2026-01-05'), T('2', 'buy', 'FPT', 100, 100000, '2026-01-06'), T('3', 'sell', 'VCB', 70, 1, '2026-02-01')];
    const dup = R.comparePositions([S('FPT', 100)], { FPT: A(200) }, { txns, asOf: '2026-06-01' }).items[0];
    expect(dup.hints.join(' ')).toMatch(/nhập trùng/);
    const wrongSell = R.comparePositions([S('VCB', 70)], {}, { txns, asOf: '2026-06-01' }).items[0];
    expect(wrongSell.status).toBe('missing_in_app');
    const sellOnly = R.comparePositions([S('VCB', 71)], { VCB: A(1) }, { txns, asOf: '2026-06-01' }).items[0];
    expect(sellOnly.hints.join(' ')).toMatch(/lệnh bán này nhập sai/);
  });
  it('ghi chú giá vốn lệch > 2% khi khối lượng khớp', () => {
    const r = R.comparePositions([S('FPT', 100, { cost: 105000 })], { FPT: A(100, 100000) });
    expect(r.items[0].status).toBe('match');
    expect(r.items[0].costNote).toMatch(/Giá vốn sao kê/);
    expect(r.costNotes).toBe(1);
    expect(R.comparePositions([S('FPT', 100, { cost: 101000 })], { FPT: A(100, 100000) }).costNotes).toBe(0);
  });
  it('sao kê liệt kê mã khối lượng 0 và sổ cũng không có: coi là khớp', () => {
    expect(R.comparePositions([S('OLD', 0)], {}).matched).toBe(1);
  });
  it('giá trị đang lệch ước tính theo giá sao kê', () => {
    const r = R.comparePositions([S('VCB', 40, { price: 95000 })], { VCB: A(50) });
    expect(r.valueAtStake).toBe(10 * 95000);
  });
});

describe('compareCash', () => {
  it('khớp trong dung sai, lệch kèm gợi ý theo chiều', () => {
    expect(R.compareCash(1000000, 999500).ok).toBe(true);
    const more = R.compareCash(5000000, 4000000);
    expect(more.ok).toBe(false);
    expect(more.diff).toBe(1000000);
    expect(more.hint).toMatch(/Sao kê có nhiều tiền hơn/);
    expect(R.compareCash(1000000, 3000000).hint).toMatch(/Sổ có nhiều tiền hơn/);
  });
});

describe('compareTrades', () => {
  const S = (date, symbol, type, quantity, price, extra = {}) => ({ line: 1, date, symbol, type, quantity, price, fee: 0, tax: 0, ref: null, issues: [], ...extra });
  const app = [T('1', 'buy', 'FPT', 100, 100000, '2026-09-01'), T('2', 'sell', 'FPT', 50, 110000, '2026-09-10'), T('3', 'buy', 'VCB', 200, 90000, '2026-09-12'), T('4', 'buy', 'HPG', 300, 25000, '2026-09-15', { external_ref: 'R9' }), T('old', 'buy', 'SSI', 1, 1, '2026-01-01')];
  it('khớp đủ, thiếu trong sổ, lệnh thừa trong sổ, lệch khối lượng/giá', () => {
    const stmt = [S('2026-09-01', 'FPT', 'buy', 100, 100000), S('2026-09-10', 'FPT', 'sell', 50, 110500), S('2026-09-20', 'MWG', 'buy', 100, 60000), S('2026-09-15', 'HPG', 'buy', 300, 25000, { ref: 'R9' })];
    const r = R.compareTrades(stmt, app);
    expect(r.from).toBe('2026-09-01');
    expect(r.to).toBe('2026-09-20');
    expect(r.matched.map((m) => m.statement.symbol).sort()).toEqual(['FPT', 'HPG']);
    expect(r.mismatched).toHaveLength(1);
    expect(r.mismatched[0].reasons.join(' ')).toMatch(/giá sao kê 110\.500/);
    expect(r.missingInApp.map((x) => x.symbol)).toEqual(['MWG']);
    expect(r.extraInApp.map((t) => t.symbol)).toEqual(['VCB']);                 // VCB 12/09 có trong sổ nhưng không có trong sao kê
    expect(r.extraInApp.find((t) => t.symbol === 'SSI')).toBeUndefined();        // ngoài kỳ sao kê
    expect(r.ok).toBe(false);
    expect(r.total).toBe(4);
  });
  it('khớp theo mã tham chiếu kể cả khi giá làm tròn khác', () => {
    const r = R.compareTrades([S('2026-09-15', 'HPG', 'buy', 300, 25001, { ref: 'R9' })], app, { from: '2026-09-15', to: '2026-09-15' });
    expect(r.matched).toHaveLength(1);
    expect(r.ok).toBe(true);
  });
  it('lệnh trùng trong sổ: hai lệnh giống hệt chỉ một lệnh trong sao kê -> một lệnh thừa', () => {
    const r = R.compareTrades([S('2026-09-01', 'FPT', 'buy', 100, 100000)], [T('a', 'buy', 'FPT', 100, 100000, '2026-09-01'), T('b', 'buy', 'FPT', 100, 100000, '2026-09-01')]);
    expect(r.matched).toHaveLength(1);
    expect(r.extraInApp).toHaveLength(1);
  });
  it('bỏ dòng lỗi trong sao kê và lệnh đã xoá trong sổ; sao kê rỗng', () => {
    const r = R.compareTrades([S('2026-09-01', 'FPT', 'buy', 100, 100000, { issues: ['x'] })], [T('d', 'buy', 'FPT', 100, 100000, '2026-09-01', { deleted_at: '2026-09-02T00:00:00Z' })]);
    expect(r.total).toBe(0);
    expect(r.matchedPct).toBeNull();
    expect(R.compareTrades([], []).ok).toBe(true);
  });
});

describe('summarize / staleness', () => {
  it('tóm tắt gọn để lưu nhật ký, giới hạn 50 mục lệch', () => {
    const items = Array.from({ length: 70 }, (_, i) => ({ symbol: 'S' + i, status: 'qty_diff', statementQty: 2, appQty: 1, diff: 1 }));
    const s = R.summarize('positions', { matched: 5, mismatched: 70, total: 75, valueAtStake: 1234.6, items }, { asOf: '2026-09-30' });
    expect(s.items).toHaveLength(50);
    expect(s).toMatchObject({ matched: 5, mismatched: 70, valueAtStake: 1235, asOf: '2026-09-30' });
    const t = R.summarize('trades', { matched: [1, 2], mismatched: [1], missingInApp: [1, 2], extraInApp: [], total: 5, from: 'a', to: 'b' });
    expect(t).toMatchObject({ matched: 2, mismatched: 3, differing: 1, missingInApp: 2, extraInApp: 0 });
  });
  it('mức độ cũ của lần đối soát gần nhất', () => {
    expect(R.staleness(null, '2026-10-04').level).toBe('never');
    expect(R.staleness('2026-10-01', '2026-10-04')).toMatchObject({ level: 'ok', days: 3 });
    expect(R.staleness('2026-08-01', '2026-10-04')).toMatchObject({ level: 'stale', days: 64 });
    expect(R.staleness('2026-10-04', '2026-10-04').text).toBe('Hôm nay');
  });
});
