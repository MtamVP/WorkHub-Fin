import { describe, it, expect, beforeEach } from 'vitest';
import VnHolidays from '../../lib/vn-holidays.js';
import LQ from '../../lib/live-quotes.js';

const vn = (day, hh, mm, ss = 0) => Date.parse(day + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '+07:00');

describe('VnHolidays', () => {
  it('ngày thường nghỉ lễ có tên; ngày giao dịch và cuối tuần thì không', () => {
    expect(VnHolidays.name('2026-09-02')).toBe('Quốc khánh');
    expect(VnHolidays.name('2026-08-31')).toBeTruthy();              // đối chiếu dữ liệu thật: HOSE nghỉ 31/8/2026
    expect(VnHolidays.name('2026-01-02')).toBeTruthy();
    expect(VnHolidays.isHoliday('2026-10-07')).toBe(false);           // ngày giao dịch thật
    expect(VnHolidays.isHoliday('2026-02-14')).toBe(false);           // thứ bảy trong kỳ Tết: đã nghỉ sẵn, không tính là ngày lễ thường
    expect(VnHolidays.isHoliday('2026-02-16')).toBe(true);
  });
  it('nhận ms và Date theo giờ Việt Nam', () => {
    expect(VnHolidays.isHoliday(vn('2026-09-02', 10, 0))).toBe(true);
    expect(VnHolidays.isHoliday(new Date(vn('2026-09-02', 23, 30)))).toBe(true);
    expect(VnHolidays.isHoliday(Date.parse('2026-09-02T18:00:00Z'))).toBe(false);   // 01:00 ngày 3/9 giờ VN
  });
  it('coverage: 2025-2026 đầy đủ, 2027 mới có Tết Dương lịch, năm lạ là none', () => {
    expect(VnHolidays.coverage('2026-10-07')).toBe('complete');
    expect(VnHolidays.coverage('2027-03-01')).toBe('partial');
    expect(VnHolidays.coverage('2030-01-01')).toBe('none');
  });
  it('nextTradingDay bỏ cuối tuần và ngày lễ', () => {
    expect(VnHolidays.nextTradingDay('2026-08-28')).toBe('2026-09-03');      // thứ sáu 28/8 -> bỏ T7 CN và 31/8, 1/9, 2/9
    expect(VnHolidays.nextTradingDay('2026-10-07')).toBe('2026-10-08');
    expect(VnHolidays.nextTradingDay('2026-12-31')).toBe('2027-01-04');      // 1/1/2027 (thứ sáu) nghỉ, rồi cuối tuần
  });
});

describe('LiveQuotes.session với ngày lễ', () => {
  beforeEach(() => { globalThis.VnHolidays = VnHolidays; LQ.state.holidayLiveDate = null; LQ.state.vciFailures = 0; LQ.state.vciBackoffUntil = 0; LQ.state.quotes = {}; });
  it('ngày lễ trong giờ giao dịch báo holiday; ngày thường vẫn open', () => {
    expect(LQ.session(vn('2026-09-02', 10, 0))).toBe('holiday');
    expect(LQ.session(vn('2026-09-03', 10, 0))).toBe('open');
  });
  it('lịch sai: VNDirect có giá hôm nay của ngày trong danh sách thì tin dữ liệu và tính phiên theo giờ', async () => {
    const day = '2026-09-02', row = { code: 'FPT', date: day, time: '10:19:59', basicPrice: 60.4, ceilingPrice: 64.6, floorPrice: 56.2, open: 60.4, high: 61.3, low: 60.2, close: 60.2, nmVolume: 1e6 };
    const f = async () => ({ ok: true, json: async () => ({ data: [row] }) });
    const st = await LQ.refresh(['FPT'], { fetch: f, now: vn(day, 10, 20) });
    expect(st.quotes.FPT.price).toBe(60200); expect(st.session).toBe('open'); expect(LQ.state.holidayLiveDate).toBe(day);
    expect(LQ.session(vn(day, 10, 30))).toBe('open');
  });
  it('ngày lễ thật: không có dòng giá hôm nay thì không có giá trực tiếp và không gọi hàm VCI', async () => {
    let called = 0;
    const f = async () => ({ ok: true, json: async () => ({ data: [] }) });
    const st = await LQ.refresh(['FPT'], { fetch: f, now: vn('2026-09-01', 10, 0), invoke: async () => { called++; return { ok: true, quotes: { FPT: { price: 60400 } }, asOf: new Date().toISOString() }; } });
    expect(st.session).toBe('holiday'); expect(st.quotes).toEqual({}); expect(called).toBe(0);
  });
  it('không nạp VnHolidays thì hành xử như cũ', () => {
    delete globalThis.VnHolidays;
    expect(LQ.session(vn('2026-09-02', 10, 0))).toBe('open');
  });
});
