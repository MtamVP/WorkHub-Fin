// Bảng giá cho kiểm thử chiến lược: lib/bt-panel.js
import { describe, it, expect } from 'vitest';
import BtPanel from '../../lib/bt-panel.js';
const { makeRows, indexRow } = require('../helpers/bt-fixtures.js');

describe('BtPanel.build', () => {
  it('lợi suất lấy thẳng từ cột lợi suất của kho; mức giá tích luỹ từ 100', () => {
    const { rows, dates } = makeRows(30, { AAA: { ret: 0.01, p0: 10 }, BBB: { ret: -0.005, p0: 30 } });
    const P = BtPanel.build(rows, [indexRow('VNINDEX', dates, 0.001)]);
    expect(P.T).toBe(30); expect(P.symbols).toEqual(['AAA', 'BBB']);
    expect(P.ret[0][5]).toBeCloseTo(0.01, 3);
    expect(P.lvl[0][0]).toBeCloseTo(101, 1);
    expect(P.lvl[0][10]).toBeCloseTo(100 * Math.pow(1.01, 11), 0);
    expect(P.first[0]).toBe(0); expect(P.last[0]).toBe(29);
  });
  it('ngày không hưởng quyền: giá thô rơi 9% nhưng lợi suất tổng (đã gồm cổ tức/thưởng) chỉ +1% nên không có cú rơi giả', () => {
    const { rows } = makeRows(30, { AAA: { ret: (t) => (t === 10 ? -0.09 : 0), p0: 20, retOverride: { 10: 0.01 } } });
    const P = BtPanel.build(rows, []);
    expect(P.close[0][9] - P.close[0][10]).toBeGreaterThan(1.5);          // giá thô giảm mạnh
    expect(P.ret[0][10]).toBeCloseTo(0.01, 6);                            // lợi suất tổng dương
    expect(P.lvl[0][10] / P.lvl[0][9] - 1).toBeCloseTo(0.01, 5);
  });
  it('giữ lại mã có ít phiên hơn minRows ra ngoài; mã hủy niêm yết còn tới phiên cuối của nó', () => {
    const { rows } = makeRows(60, { OLD: { ret: 0.001, to: 39 }, NEW: { ret: 0.001, from: 50 }, FULL: { ret: 0 } });
    const P = BtPanel.build(rows, [], { minRows: 20 });
    expect(P.symbols).toEqual(['FULL', 'OLD']);
    const old = P.sIndex.OLD;
    expect(P.last[old]).toBe(39);
    expect(P.lvl[old][39]).toBeGreaterThan(0); expect(P.lvl[old][40]).toBeNaN();
    expect(BtPanel.summary(P).ended).toBe(1);
  });
  it('bỏ lợi suất vô lý (> 300%) và ghi nhận', () => {
    const { rows } = makeRows(40, { AAA: { ret: (t) => (t === 20 ? 5 : 0.001), p0: 10 } });
    const P = BtPanel.build(rows, []);
    expect(P.ret[0][20]).toBeNaN(); expect(P.badReturns).toBe(1);
  });
  it('chỉ số căn theo lịch, điền tiếp ngày thiếu và báo ngày VN-Index có mà kho chưa có', () => {
    const { rows, dates } = makeRows(40, { AAA: { ret: 0 } });
    const idx = indexRow('VNINDEX', dates, 0.001);
    const removed = rows.splice(15, 1)[0].day;                     // kho thiếu một phiên
    const P = BtPanel.build(rows, [idx]);
    expect(P.T).toBe(40); expect(P.missingDays).toEqual([removed]);
    expect(P.index.VNINDEX.length).toBe(40); expect(P.index.VNINDEX[0]).toBeGreaterThan(1000);
    expect(P.indexCoverage.VNINDEX).toBe(1);
  });
  it('tìm vị trí theo ngày', () => {
    const { rows, dates } = makeRows(40, { AAA: { ret: 0 } });
    const P = BtPanel.build(rows, []);
    expect(BtPanel.indexOnOrAfter(P, dates[10])).toBe(10);
    expect(BtPanel.indexOnOrAfter(P, '2019-01-01')).toBe(0);
    expect(BtPanel.indexOnOrAfter(P, '2030-01-01')).toBe(40);
    expect(BtPanel.indexOnOrBefore(P, dates[10])).toBe(10);
    expect(BtPanel.indexOnOrBefore(P, '2019-01-01')).toBe(-1);
    expect(BtPanel.indexOnOrBefore(P, '2030-01-01')).toBe(39);
  });
  it('dựng dần từng ngày (create/add/finish) cho cùng kết quả với build một lần; ngày ngoài lịch bị bỏ qua', () => {
    const { rows, dates } = makeRows(60, { AAA: { ret: 0.002, p0: 10 }, BBB: { ret: -0.001, p0: 20, ex: 1 } });
    const once = BtPanel.build(rows, [indexRow('VNINDEX', dates, 0.001)]);
    const b = BtPanel.create(dates);
    rows.slice().reverse().forEach((r) => b.add(r));                               // thứ tự thêm không quan trọng
    expect(b.add({ day: '1999-01-01', data: { AAA: [1, 1, 1, 0, 0] } })).toBe(false);
    const inc = b.finish([indexRow('VNINDEX', dates, 0.001)]);
    expect(inc.ignoredRows).toBe(1); expect(inc.T).toBe(once.T); expect(inc.symbols).toEqual(once.symbols);
    expect(Array.from(inc.lvl[0])).toEqual(Array.from(once.lvl[0])); expect(Array.from(inc.ret[1])).toEqual(Array.from(once.ret[1]));
    expect(inc.exd[1][5]).toBe(1); expect(inc.missingDays).toEqual([]);
  });
  it('đầu vào rỗng không làm sập', () => {
    const P = BtPanel.build([], []);
    expect(P.T).toBe(0); expect(BtPanel.summary(P).days).toBe(0);
  });
});
