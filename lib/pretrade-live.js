// Logic thuần: GIÁ TRỰC TIẾP trong form nhập lệnh (Sổ Lệnh > Thêm lệnh giao dịch). Ba việc:
//  1) overlay: tính lại giá trị các vị thế đang nắm (và NAV) theo giá trực tiếp để phần "kiểm tra trước lệnh" (tỷ trọng, giới hạn đầu tư, NAV sau lệnh) không dùng giá lưu 5 phút;
//  2) describe: mô tả báo giá của mã đang nhập (giá, trần/sàn, giờ, trong phiên hay ngoài giờ);
//  3) priceFlags: cảnh báo khi giá người dùng nhập lệch giá trực tiếp hoặc nằm ngoài biên độ trần/sàn (lệnh sẽ không khớp).
// CHỈ GỢI Ý: không đổi giá nào trong sổ, không chặn lưu lệnh. Giá nguồn công khai trễ vài giây đến 2 phút; trần/sàn chỉ có khi giá đến từ bảng giá VCI.
// KHÔNG đụng DOM/mạng. Nạp bằng thẻ <script> thường (global PretradeLive) và module.exports cho Vitest.
const PretradeLive = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('vi-VN');

  // holdings: [{ symbol, value, price }] (giá lưu; khối lượng = value / price); quotes: { SYM: { price, ... } }; cash, debt: số dư.
  // Trả { holdings: [{ symbol, value, price, live }], liveCount, nav, navStored, navDelta }
  function overlay(holdings, quotes, cash, debt) {
    const q = quotes || {};
    let live = 0, stored = 0, now = 0;
    const out = (holdings || []).map((h) => {
      const v = num(h.value) || 0, p = num(h.price) || 0, x = q[h.symbol];
      stored += v;
      if (x && num(x.price) > 0 && p > 0) { const nv = v / p * x.price; live++; now += nv; return { symbol: h.symbol, value: nv, price: x.price, live: true }; }
      now += v; return { symbol: h.symbol, value: v, price: p, live: false };
    });
    const navStored = stored + (num(cash) || 0) - (num(debt) || 0), nav = now + (num(cash) || 0) - (num(debt) || 0);
    return { holdings: out, liveCount: live, nav: nav, navStored: navStored, navDelta: nav - navStored };
  }

  // quote: { price, ref, ceil, floor, ts?, time?, source? }; session: 'open' | 'break' | 'closed' | 'pre' | 'holiday' (LiveQuotes.session)
  function describe(quote, session) {
    if (!quote || !(num(quote.price) > 0)) return null;
    const inSession = session === 'open' || session === 'break';
    const bits = ['Giá ' + (inSession ? 'trực tiếp' : 'đóng cửa gần nhất (ngoài phiên)') + ' ' + fmt(quote.price)];
    if (num(quote.ref) > 0) bits.push('tham chiếu ' + fmt(quote.ref));
    if (num(quote.ceil) > 0 && num(quote.floor) > 0) bits.push('trần ' + fmt(quote.ceil) + ' · sàn ' + fmt(quote.floor));
    return { price: Math.round(quote.price), ref: num(quote.ref), ceil: num(quote.ceil), floor: num(quote.floor), time: quote.time || null, inSession: inSession, text: bits.join(' · ') + (quote.time ? ' (lúc ' + quote.time + ')' : '') };
  }

  // Cảnh báo cho giá nhập (p) so với báo giá q; mỗi cảnh báo { tone: 'bad'|'warn'|'info', text }. Chỉ so khi đang trong phiên (ngoài phiên giá cũ có thể khác nhiều mà không có gì sai).
  function priceFlags(p, quote, session) {
    const price = num(p), out = [];
    if (!(price > 0) || !quote || !(num(quote.price) > 0)) return out;
    const ceil = num(quote.ceil), floor = num(quote.floor), inSession = session === 'open' || session === 'break';
    if (ceil > 0 && price > ceil + 1e-9) out.push({ tone: 'bad', text: 'Giá nhập ' + fmt(price) + ' cao hơn giá trần ' + fmt(ceil) + ': lệnh sẽ không khớp trong phiên này.' });
    else if (floor > 0 && price < floor - 1e-9) out.push({ tone: 'bad', text: 'Giá nhập ' + fmt(price) + ' thấp hơn giá sàn ' + fmt(floor) + ': lệnh sẽ không khớp trong phiên này.' });
    if (inSession) {
      const dev = (price - quote.price) / quote.price * 100, a = Math.abs(dev), s = (dev > 0 ? '+' : '−') + a.toFixed(1).replace('.', ',') + '%';
      if (a >= 5) out.push({ tone: 'warn', text: 'Giá nhập lệch ' + s + ' so với giá trực tiếp ' + fmt(quote.price) + ': kiểm tra lại giá hoặc mã.' });
      else if (a >= 2) out.push({ tone: 'info', text: 'Giá nhập lệch ' + s + ' so với giá trực tiếp ' + fmt(quote.price) + '.' });
    }
    return out;
  }

  // Có nên tự điền giá trực tiếp vào ô giá không: khi ô trống, hoặc ô đang giữ đúng giá do app tự điền lần trước (người dùng chưa sửa).
  function shouldAutofill(currentValue, wasAuto, lastAuto) {
    const cur = String(currentValue === null || currentValue === undefined ? '' : currentValue).trim();
    if (cur === '') return true;
    return !!wasAuto && num(cur) !== null && num(cur) === num(lastAuto);
  }

  return { overlay, describe, priceFlags, shouldAutofill };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PretradeLive;
