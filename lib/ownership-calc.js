// Logic thuần: DỮ LIỆU SỞ HỮU -- cổ đông lớn, giao dịch nội bộ (lãnh đạo, người liên quan, cổ đông lớn) và phòng khối ngoại còn lại.
// Nguồn: Vietcap iq-insight-service (công khai, KHÔNG cam kết dịch vụ) cho cổ đông và giao dịch nội bộ; phòng khối ngoại lấy từ VNDirect /v4/foreigns (đã có trong finance_stock_ratios.foreignRoomLeftPct).
// Giao dịch nội bộ là thông tin CÔNG BỐ: người ra thông báo "đăng ký" mua/bán rồi mới thực hiện; kết quả thực hiện được công bố sau (có thể không mua/bán đủ). Vì vậy tách rõ hai trạng thái:
//   * thực hiện xong (status Done): khối lượng thật = acquired; * đăng ký (Registration): ý định, chưa chắc xảy ra.
// Tín hiệu ở đây MÔ TẢ, không phải khuyến nghị: lãnh đạo mua có thể là tín hiệu tích cực nhưng bán thường xảy ra vì nhiều lý do không liên quan đến triển vọng (thuế, trả nợ, chia tài sản).
// KHÔNG đụng DOM/mạng. Nạp bằng thẻ <script> thường (global OwnershipCalc) và module.exports cho Vitest.
const OwnershipCalc = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const day = (v) => { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
  const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

  // Phản hồi /company/{mã}/shareholder -> [{ symbol, key, name, type, position, qty, pct, publicDate }] theo tỷ lệ giảm dần. pct là PHẦN TRĂM (6,89 nghĩa là 6,89%).
  function parseShareholders(json, symbol) {
    const rows = json && Array.isArray(json.data) ? json.data : [];
    const sym = String(symbol || '').toUpperCase(), out = [];
    rows.forEach((r) => {
      const name = String((r && (r.ownerName || r.ownerNameEn)) || '').trim();
      if (!name) return;
      const frac = num(r.percentage);
      out.push({ symbol: sym, key: String(r.ownerCode || name).slice(0, 80), name: name, type: String(r.ownerType || '').toUpperCase() || null, position: (r.positionName || '').trim() || null,
        qty: num(r.quantity), pct: frac === null ? null : frac * 100, publicDate: day(r.publicDate) });
    });
    return out.sort((a, b) => (b.pct || 0) - (a.pct || 0));
  }

  // Phản hồi /company/{mã}/insider-transaction -> giao dịch đã chuẩn hoá (mới trước). Bản ghi thiếu mã/ngày/người giao dịch bị bỏ.
  function parseInsider(json) {
    const c = json && json.data && Array.isArray(json.data.content) ? json.data.content : [];
    const out = [];
    c.forEach((r) => {
      if (!r || !r.id || !r.ticker) return;
      const action = String(r.actionTypeCode || '').toUpperCase();
      if (action !== 'B' && action !== 'S') return;
      const pub = day(r.publicDate); if (!pub) return;
      const status = /done|đã thực hiện/i.test(String(r.tradeStatusEn || '') + ' ' + String(r.tradeStatusVi || '')) ? 'done' : (/regist|đăng ký|đăng kí/i.test(String(r.tradeStatusEn || '') + ' ' + String(r.tradeStatusVi || '')) ? 'registered' : 'other');
      const own = num(r.ownershipAfterTrade);
      out.push({
        id: String(r.id), symbol: String(r.ticker).toUpperCase(), trader: String(r.traderNameVi || r.traderNameEn || '').trim() || null,
        position: String(r.traderPositionVi || '').trim() || null, related: (r.relativeNameVi && r.relativeNameVi !== r.traderNameVi ? String(r.relativeNameVi).trim() : null),
        action: action, code: String(r.eventCode || ''), status: status,
        before: num(r.shareBeforeTrade), after: num(r.shareAfterTrade), registered: num(r.shareRegister), acquired: num(r.shareAcquire),
        pctAfter: own === null ? null : own * 100,
        startDate: day(r.startDate), endDate: day(r.endDate), publicDate: pub, url: String(r.sourceUrlVi || r.sourceUrlEn || '') || null,
      });
    });
    return out.sort((a, b) => (a.publicDate < b.publicDate ? 1 : a.publicDate > b.publicDate ? -1 : 0));
  }

  // Khối lượng thực tế của một giao dịch (cổ phiếu, mang dấu: mua +, bán -). Chỉ giao dịch đã thực hiện xong mới có khối lượng; đăng ký thì 0.
  function signedQty(t) {
    if (!t || t.status !== 'done') return 0;
    const q = t.acquired !== null && t.acquired !== undefined ? t.acquired : (t.after !== null && t.before !== null ? Math.abs(t.after - t.before) : 0);
    return (t.action === 'B' ? 1 : -1) * Math.abs(q || 0);
  }

  // Tóm tắt giao dịch nội bộ trong `days` ngày kết thúc ở asOf. price (đồng/cổ phiếu) tuỳ chọn để ước giá trị.
  // Trả { buyQty, sellQty, netQty, netValue, buyers, sellers, trades, pendingBuy, pendingSell, last, signal, cluster }
  //   signal: 'buy' | 'sell' | 'neutral' | 'none'. cluster = mua đồng loạt (>= 3 người khác nhau cùng mua thực tế trong cửa sổ) -- dấu hiệu mạnh hơn một lần mua đơn lẻ.
  function summarize(trades, asOf, days, price) {
    const end = day(asOf) || new Date().toISOString().slice(0, 10), start = addDays(end, -(Number(days) || 90));
    const inWin = (trades || []).filter((t) => t.publicDate >= start && t.publicDate <= end);
    let buyQty = 0, sellQty = 0, pendingBuy = 0, pendingSell = 0;
    const buyers = new Set(), sellers = new Set();
    inWin.forEach((t) => {
      const q = signedQty(t);
      if (q > 0) { buyQty += q; buyers.add(t.trader || t.id); }
      else if (q < 0) { sellQty += -q; sellers.add(t.trader || t.id); }
      else if (t.status === 'registered') {
        const intent = Math.abs(t.registered || 0);
        // đăng ký còn hiệu lực: chưa quá ngày kết thúc dự kiến
        if (!t.endDate || t.endDate >= end) { if (t.action === 'B') pendingBuy += intent; else pendingSell += intent; }
      }
    });
    const netQty = buyQty - sellQty;
    const p = num(price);
    const total = buyQty + sellQty;
    // tín hiệu: lệch rõ về một phía (>= 60% khối lượng) VÀ có ít nhất một giao dịch thật; hoà -> trung tính
    let signal = 'none';
    if (total > 0) signal = buyQty >= 0.6 * total ? 'buy' : (sellQty >= 0.6 * total ? 'sell' : 'neutral');
    else if (inWin.length) signal = 'neutral';
    return {
      from: start, to: end, trades: inWin.length, buyQty: buyQty, sellQty: sellQty, netQty: netQty, netValue: p > 0 ? netQty * p : null,
      buyers: buyers.size, sellers: sellers.size, pendingBuy: pendingBuy, pendingSell: pendingSell,
      last: inWin.length ? inWin[0].publicDate : null, signal: signal, cluster: buyers.size >= 3 && buyQty > sellQty,
    };
  }

  // Phòng khối ngoại còn lại (%): phân bậc để cảnh báo thanh khoản của khối ngoại.
  //   'full' (< 2%): gần như hết room, khối ngoại khó mua thêm; 'tight' (< 10%); 'ok'; 'unknown'.
  function roomBand(leftPct) {
    const v = num(leftPct);
    if (v === null) return { key: 'unknown', label: 'Chưa có số liệu' };
    if (v < 2) return { key: 'full', label: 'Gần hết room' };
    if (v < 10) return { key: 'tight', label: 'Room hẹp' };
    return { key: 'ok', label: 'Room còn rộng' };
  }

  // Cổ đông lớn (>= 5%) và tập trung sở hữu từ danh sách cổ đông đã biết: tổng tỷ lệ của nhóm nắm giữ lớn nhất; chỉ tính các dòng đã công bố trong vòng `maxAgeDays` để không tính số cũ.
  function concentration(holders, asOf, maxAgeDays) {
    const end = day(asOf) || new Date().toISOString().slice(0, 10), start = addDays(end, -(Number(maxAgeDays) || 730));
    const fresh = (holders || []).filter((h) => h.pct !== null && h.pct !== undefined && (!h.publicDate || h.publicDate >= start));
    const major = fresh.filter((h) => h.pct >= 5);
    const top3 = fresh.slice().sort((a, b) => b.pct - a.pct).slice(0, 3).reduce((s, h) => s + h.pct, 0);
    return { known: fresh.length, majorCount: major.length, majorPct: major.reduce((s, h) => s + h.pct, 0), top3Pct: top3, stale: (holders || []).length - fresh.length };
  }

  return { parseShareholders, parseInsider, signedQty, summarize, roomBand, concentration };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OwnershipCalc;
