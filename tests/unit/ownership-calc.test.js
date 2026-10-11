// Dữ liệu sở hữu (lib/ownership-calc.js): đọc phản hồi Vietcap, tóm tắt giao dịch nội bộ, phòng khối ngoại, tập trung sở hữu.
import { describe, it, expect } from 'vitest';
import O from '../../lib/ownership-calc.js';

// Dạng phản hồi thật của iq.vietcap.com.vn (rút gọn, lấy từ FPT ngày 11/10/2026)
const rec = (o) => Object.assign({ id: 'i', ticker: 'FPT', eventCode: 'DDIND', publicDate: '2026-06-29T00:00:00', startDate: '2026-06-24T00:00:00', endDate: '2026-06-24T00:00:00',
  traderNameVi: 'Nguyễn Văn Khoa', traderPositionVi: 'Tổng Giám đốc', relativeNameVi: 'Nguyễn Văn Khoa', actionTypeCode: 'B', tradeStatusEn: 'Done', tradeStatusVi: 'Đã thực hiện xong',
  shareBeforeTrade: 5414610, shareAfterTrade: 5842978, shareRegister: 428368, shareAcquire: 428368, ownershipAfterTrade: 0.0034, sourceUrlVi: 'http://x/1' }, o || {});
const json = (rows) => ({ data: { content: rows } });

describe('parseShareholders', () => {
  it('đổi tỷ lệ thành phần trăm, sắp giảm dần, bỏ dòng không tên', () => {
    const r = O.parseShareholders({ data: [
      { ownerName: 'SCIC', ownerCode: 'SCIC', quantity: 96585637, percentage: 0.0567, ownerType: 'CORPORATE', publicDate: '2026-06-30' },
      { ownerName: 'Trương Gia Bình', ownerCode: '536', positionName: 'Chủ tịch', quantity: 117347966, percentage: 0.0689, ownerType: 'INDIVIDUAL', publicDate: '2026-06-30' },
      { ownerName: '', percentage: 0.5 },
    ] }, 'fpt');
    expect(r.map((x) => x.name)).toEqual(['Trương Gia Bình', 'SCIC']);
    expect(r[0].pct).toBeCloseTo(6.89, 9); expect(r[0].symbol).toBe('FPT'); expect(r[0].position).toBe('Chủ tịch'); expect(r[1].type).toBe('CORPORATE');
  });
  it('phản hồi hỏng -> rỗng, không ném', () => {
    expect(O.parseShareholders(null, 'X')).toEqual([]); expect(O.parseShareholders({ data: null }, 'X')).toEqual([]);
  });
});

describe('parseInsider', () => {
  it('đọc giao dịch thật; phân biệt đã thực hiện và đăng ký', () => {
    const t = O.parseInsider(json([rec({ id: 'a' }), rec({ id: 'b', tradeStatusEn: 'Registration', tradeStatusVi: 'Đăng ký', shareAcquire: null, actionTypeCode: 'S' })]));
    expect(t).toHaveLength(2);
    const a = t.find((x) => x.id === 'a'), b = t.find((x) => x.id === 'b');
    expect(a).toMatchObject({ symbol: 'FPT', trader: 'Nguyễn Văn Khoa', action: 'B', status: 'done', acquired: 428368, publicDate: '2026-06-29', url: 'http://x/1' });
    expect(a.pctAfter).toBeCloseTo(0.34, 9);
    expect(b).toMatchObject({ action: 'S', status: 'registered', acquired: null, registered: 428368 });
  });
  it('bỏ bản ghi thiếu mã/ngày/hướng mua-bán và sắp mới trước', () => {
    const t = O.parseInsider(json([rec({ id: 'old', publicDate: '2026-01-01T00:00:00' }), rec({ id: 'x', ticker: null }), rec({ id: 'y', actionTypeCode: 'Z' }), rec({ id: 'z', publicDate: null }), rec({ id: 'new', publicDate: '2026-09-01T00:00:00' })]));
    expect(t.map((x) => x.id)).toEqual(['new', 'old']);
  });
  it('người liên quan khác người giao dịch được ghi lại', () => {
    const t = O.parseInsider(json([rec({ id: 'r', relativeNameVi: 'Vợ ông Khoa' })]));
    expect(t[0].related).toBe('Vợ ông Khoa');
  });
  it('phản hồi hỏng -> rỗng', () => { expect(O.parseInsider(null)).toEqual([]); expect(O.parseInsider({ data: {} })).toEqual([]); });
});

describe('summarize', () => {
  const T = (o) => O.parseInsider(json([rec(o)]))[0];
  it('khối lượng chỉ tính giao dịch ĐÃ thực hiện; đăng ký tính riêng là dự kiến', () => {
    const trades = [T({ id: '1', shareAcquire: 100000, publicDate: '2026-09-20T00:00:00' }),
      T({ id: '2', actionTypeCode: 'S', shareAcquire: 30000, traderNameVi: 'B', publicDate: '2026-09-10T00:00:00' }),
      T({ id: '3', tradeStatusEn: 'Registration', tradeStatusVi: 'Đăng ký', shareAcquire: null, shareRegister: 500000, endDate: '2026-12-31T00:00:00', publicDate: '2026-09-25T00:00:00', traderNameVi: 'C' })];
    const s = O.summarize(trades.sort((a, b) => (a.publicDate < b.publicDate ? 1 : -1)), '2026-10-01', 90, 50000);
    expect(s.buyQty).toBe(100000); expect(s.sellQty).toBe(30000); expect(s.netQty).toBe(70000); expect(s.netValue).toBe(70000 * 50000);
    expect(s.pendingBuy).toBe(500000); expect(s.pendingSell).toBe(0); expect(s.trades).toBe(3); expect(s.signal).toBe('buy'); expect(s.last).toBe('2026-09-25');
  });
  it('đăng ký đã quá hạn không tính là dự kiến; giao dịch ngoài cửa sổ bị loại', () => {
    const t = [T({ id: '1', tradeStatusEn: 'Registration', tradeStatusVi: 'Đăng ký', shareAcquire: null, shareRegister: 1000, endDate: '2026-07-01T00:00:00', publicDate: '2026-06-20T00:00:00' }),
      T({ id: '2', shareAcquire: 5000, publicDate: '2025-01-01T00:00:00' })];
    const s = O.summarize(t, '2026-10-01', 90);
    expect(s.pendingBuy).toBe(0); expect(s.trades).toBe(0); expect(s.signal).toBe('none');
  });
  it('tín hiệu: lệch >= 60% mới tính; cân bằng là trung tính; chỉ có đăng ký thì trung tính', () => {
    const mk = (b, s) => [T({ id: 'b', shareAcquire: b, publicDate: '2026-09-01T00:00:00' }), T({ id: 's', actionTypeCode: 'S', shareAcquire: s, traderNameVi: 'Z', publicDate: '2026-09-02T00:00:00' })];
    expect(O.summarize(mk(100, 100), '2026-10-01', 90).signal).toBe('neutral');
    expect(O.summarize(mk(100, 40), '2026-10-01', 90).signal).toBe('buy');
    expect(O.summarize(mk(40, 100), '2026-10-01', 90).signal).toBe('sell');
    expect(O.summarize([T({ id: 'r', tradeStatusEn: 'Registration', tradeStatusVi: 'Đăng ký', shareAcquire: null, publicDate: '2026-09-01T00:00:00' })], '2026-10-01', 90).signal).toBe('neutral');
  });
  it('mua đồng loạt: từ 3 người khác nhau cùng mua thật và mua nhiều hơn bán', () => {
    const t = ['A', 'B', 'C'].map((n, i) => T({ id: 'c' + i, traderNameVi: n, shareAcquire: 1000, publicDate: '2026-09-0' + (i + 1) + 'T00:00:00' }));
    expect(O.summarize(t, '2026-10-01', 90).cluster).toBe(true);
    expect(O.summarize(t.slice(0, 2), '2026-10-01', 90).cluster).toBe(false);
    expect(O.summarize([t[0], t[0], t[0]], '2026-10-01', 90).cluster).toBe(false);          // một người mua nhiều lần không phải đồng loạt
  });
  it('thiếu khối lượng mua được thì suy từ số dư trước/sau', () => {
    const t = T({ id: 'd', shareAcquire: null, shareBeforeTrade: 1000, shareAfterTrade: 1700 });
    expect(O.signedQty(t)).toBe(700);
  });
});

describe('phòng khối ngoại và tập trung sở hữu', () => {
  it('phân bậc room', () => {
    expect(O.roomBand(null).key).toBe('unknown'); expect(O.roomBand(1.9).key).toBe('full'); expect(O.roomBand(2).key).toBe('tight');
    expect(O.roomBand(9.99).key).toBe('tight'); expect(O.roomBand(10).key).toBe('ok'); expect(O.roomBand(49).key).toBe('ok');
  });
  it('tập trung sở hữu chỉ tính số liệu còn mới', () => {
    const h = [{ pct: 6.9, publicDate: '2026-06-30' }, { pct: 5.7, publicDate: '2026-06-30' }, { pct: 3.7, publicDate: '2024-12-31' }, { pct: 2.4, publicDate: '2011-08-10' }];
    const c = O.concentration(h, '2026-10-11', 730);
    expect(c.known).toBe(3); expect(c.stale).toBe(1); expect(c.majorCount).toBe(2); expect(c.majorPct).toBeCloseTo(12.6, 9); expect(c.top3Pct).toBeCloseTo(16.3, 9);
  });
});
