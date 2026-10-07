// Logic: LỊCH NGHỈ LỄ của sàn chứng khoán Việt Nam (ngày thường mà HOSE/HNX không giao dịch). Dùng để Danh Mục biết hôm nay nghỉ lễ và không gọi giá trực tiếp vô ích.
// Số liệu 2025 và 2026 được đối chiếu với dòng giá thật của VNDirect (ngày thường không có dòng giá nào của FPT, VNM, VCB = ngày nghỉ), không chỉ theo thông báo.
// 2027: mới có Tết Dương lịch (cố định 1/1); lịch nghỉ Tết Nguyên đán và các ngày lễ còn lại do Chính phủ công bố cuối năm, CHƯA có: `coverage` báo 'partial' để app nhắc cập nhật.
// Đây chỉ là GỢI Ý: nếu một ngày trong danh sách mà VNDirect vẫn có giá hôm nay thì thư viện giá trực tiếp tin dữ liệu (xem LiveQuotes.refresh). Thêm ngày mới ở đây khi có thông báo.
// Nạp bằng thẻ <script> thường (global VnHolidays) và module.exports cho Vitest.
const VnHolidays = (function () {
  const HOLIDAYS = {
    '2025-01-01': 'Tết Dương lịch',
    '2025-01-27': 'Tết Nguyên đán', '2025-01-28': 'Tết Nguyên đán', '2025-01-29': 'Tết Nguyên đán', '2025-01-30': 'Tết Nguyên đán', '2025-01-31': 'Tết Nguyên đán',
    '2025-04-07': 'Giỗ Tổ Hùng Vương',
    '2025-04-30': 'Giải phóng miền Nam', '2025-05-01': 'Quốc tế Lao động', '2025-05-02': 'Nghỉ lễ 30/4 - 1/5',
    '2025-09-01': 'Quốc khánh', '2025-09-02': 'Quốc khánh',
    '2026-01-01': 'Tết Dương lịch', '2026-01-02': 'Nghỉ Tết Dương lịch',
    '2026-02-16': 'Tết Nguyên đán', '2026-02-17': 'Tết Nguyên đán', '2026-02-18': 'Tết Nguyên đán', '2026-02-19': 'Tết Nguyên đán', '2026-02-20': 'Tết Nguyên đán',
    '2026-04-27': 'Nghỉ bù Giỗ Tổ Hùng Vương',
    '2026-04-30': 'Giải phóng miền Nam', '2026-05-01': 'Quốc tế Lao động',
    '2026-08-31': 'Nghỉ lễ Quốc khánh', '2026-09-01': 'Quốc khánh', '2026-09-02': 'Quốc khánh',
    '2027-01-01': 'Tết Dương lịch',
  };
  // Các năm đã có lịch đầy đủ (mọi ngày lễ trong năm đã công bố và đã đối chiếu). Năm khác = 'partial' (chỉ Tết Dương lịch) hoặc 'none'.
  const COMPLETE_YEARS = [2025, 2026];

  const dateOf = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date((d instanceof Date ? d.getTime() : (d === undefined ? Date.now() : d)) + 7 * 3600000).toISOString().slice(0, 10));
  const isWeekend = (iso) => { const w = new Date(iso + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; };

  // Tên ngày lễ nếu ngày đó (YYYY-MM-DD, hoặc ms/Date theo giờ VN) là ngày thường nghỉ lễ; null nếu không. Cuối tuần luôn trả null (đã nghỉ sẵn).
  function name(d) { const iso = dateOf(d); return !isWeekend(iso) && HOLIDAYS[iso] ? HOLIDAYS[iso] : null; }
  const isHoliday = (d) => name(d) !== null;
  // Lịch có đủ cho năm của ngày này không: 'complete' | 'partial' (có ít nhất một ngày lễ của năm trong danh sách nhưng năm chưa đầy đủ) | 'none'
  function coverage(d) {
    const y = Number(dateOf(d).slice(0, 4));
    if (COMPLETE_YEARS.indexOf(y) >= 0) return 'complete';
    return Object.keys(HOLIDAYS).some((k) => k.slice(0, 4) === String(y)) ? 'partial' : 'none';
  }
  // Ngày giao dịch kế tiếp sau ngày d (bỏ cuối tuần và ngày lễ trong danh sách)
  function nextTradingDay(d) {
    let t = Date.parse(dateOf(d) + 'T00:00:00Z');
    for (let i = 0; i < 20; i++) {
      t += 86400000; const iso = new Date(t).toISOString().slice(0, 10);
      if (!isWeekend(iso) && !HOLIDAYS[iso]) return iso;
    }
    return null;
  }
  return { HOLIDAYS, COMPLETE_YEARS, name, isHoliday, coverage, nextTradingDay, dateOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VnHolidays;
