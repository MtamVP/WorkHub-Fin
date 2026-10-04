// Logic thuần: PHÂN NGÀNH CHUẨN ICB cho toàn bộ mã niêm yết. Nhà cung cấp dữ liệu cho mã ICB cấp 2 (supersector, bộ ICB 2008: 8300 = Ngân hàng, 9500 = Công nghệ...), ở đây đổi sang NGÀNH NỘI BỘ
// của app (cùng tên với bảng tự gõ trong FinCalc và với chỉ số ngành của Brinson). Bảng tự gõ trong FinCalc vẫn được ưu tiên vì mịn hơn (VD tách Thép khỏi Hóa chất, Dệt may khỏi Hàng cá nhân);
// mã ngoài bảng tự gõ lấy ngành theo ICB thay vì rơi vào "Chưa phân ngành".
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global SectorMap) và module.exports cho Vitest.
const SectorMap = (function () {
  // mã ICB cấp 2 -> { name: tên ICB, sector: ngành nội bộ }
  const ICB2 = {
    '0500': { name: 'Dầu khí', sector: 'Dầu khí & năng lượng' },
    '1300': { name: 'Hóa chất', sector: 'Hóa chất & phân bón' },
    '1700': { name: 'Tài nguyên cơ bản', sector: 'Thép & vật liệu' },
    '2300': { name: 'Xây dựng & vật liệu', sector: 'Xây dựng & hạ tầng' },
    '2700': { name: 'Hàng & dịch vụ công nghiệp', sector: 'Công nghiệp & dịch vụ' },
    '3300': { name: 'Ô tô & phụ tùng', sector: 'Ô tô & phụ tùng' },
    '3500': { name: 'Thực phẩm & đồ uống', sector: 'Thực phẩm & đồ uống' },
    '3700': { name: 'Hàng cá nhân & gia dụng', sector: 'Hàng cá nhân & gia dụng' },
    '4500': { name: 'Y tế', sector: 'Y tế & dược' },
    '5300': { name: 'Bán lẻ', sector: 'Bán lẻ' },
    '5500': { name: 'Truyền thông', sector: 'Truyền thông' },
    '5700': { name: 'Du lịch & giải trí', sector: 'Du lịch & giải trí' },
    '6500': { name: 'Viễn thông', sector: 'Viễn thông' },
    '7500': { name: 'Điện, nước & xăng dầu khí đốt', sector: 'Điện & tiện ích' },
    '8300': { name: 'Ngân hàng', sector: 'Ngân hàng' },
    '8500': { name: 'Bảo hiểm', sector: 'Bảo hiểm' },
    '8600': { name: 'Bất động sản', sector: 'Bất động sản' },
    '8700': { name: 'Dịch vụ tài chính', sector: 'Chứng khoán' },
    '9500': { name: 'Công nghệ thông tin', sector: 'Công nghệ' },
  };
  const UNKNOWN = 'Chưa phân ngành';

  const code = (c) => String(c === null || c === undefined ? '' : c).trim().padStart(4, '0').slice(0, 4);
  function fromIcb2(c) { const r = ICB2[code(c)]; return r ? { code: code(c), name: r.name, sector: r.sector } : null; }
  function sectorFromIcb2(c) { const r = fromIcb2(c); return r ? r.sector : UNKNOWN; }
  function icbName(c) { const r = fromIcb2(c); return r ? r.name : ''; }

  // rows: finance_stock_meta -> { SYMBOL: ngành nội bộ } (bỏ mã không có hoặc không nhận ra mã ICB)
  function buildMap(rows) {
    const out = {};
    (rows || []).forEach((r) => {
      const sym = String((r && r.symbol) || '').trim().toUpperCase();
      const s = r ? fromIcb2(r.icb2_code) : null;
      if (sym && s) out[sym] = s.sector;
    });
    return out;
  }
  // Độ phủ: bao nhiêu mã trong danh sách có ngành (tự gõ hoặc ICB). sectorOf: hàm tra ngành (FinCalc.sectorOf).
  function coverage(symbols, sectorOf) {
    const list = Array.from(new Set((symbols || []).map((s) => String(s).toUpperCase())));
    const unknown = list.filter((s) => sectorOf(s) === UNKNOWN);
    return { total: list.length, known: list.length - unknown.length, unknown: unknown };
  }

  return { ICB2, UNKNOWN, fromIcb2, sectorFromIcb2, icbName, buildMap, coverage };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SectorMap;
