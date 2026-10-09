/* --- FILE: /mobile-cards.js ---
   Bảng rộng -> thẻ xếp dọc trên điện thoại. Bảng Danh Mục có 9 cột rộng hơn 1.000 px nhưng khung bọc cắt phần tràn (overflow: hidden), nên trên màn hình hẹp 6 cột cuối
   (Giá TT, Mục tiêu / Cắt lỗ, GT vốn, GTTT, Tỷ trọng, Lãi/lỗ) không thể xem hay sửa. Cách làm: mỗi ô <td> nhận thuộc tính data-label lấy từ tiêu đề cột; CSS (finance-shared.css,
   khối "MOBILE PAGES") biến mỗi dòng thành một thẻ có nhãn trên giá trị khi màn hình <= 768 px. Trên màn hình rộng không có gì đổi. Bảng được vẽ lại liên tục (giá trực tiếp) nên
   dùng MutationObserver để gán nhãn lại sau mỗi lần vẽ. Dòng thông báo trống (ô gộp cột) không gán nhãn.
   Dùng: thêm data-m-cards vào <table>, nạp file này bằng thẻ <script> thường rồi gọi MobileCards.mount(). Không có DOM thì mount không làm gì (an toàn cho Vitest). */
const MobileCards = (function () {
  const clean = (t) => String(t === null || t === undefined ? '' : t).replace(/\s+/g, ' ').trim();
  const each = (list, fn) => Array.prototype.forEach.call(list || [], fn);

  // Nhãn từng cột lấy từ dòng cuối của thead
  function labelsOf(table) {
    const rows = table.querySelectorAll('thead tr');
    if (!rows.length) return [];
    return Array.prototype.map.call(rows[rows.length - 1].children, (th) => clean(th.textContent));
  }
  // Gán data-label cho mọi ô của thân bảng; ô gộp cột thì bỏ nhãn
  function apply(table) {
    const labels = labelsOf(table);
    each(table.querySelectorAll('tbody tr'), (tr) => {
      each(tr.children, (td, i) => {
        if (td.tagName !== 'TD') return;
        if (td.colSpan > 1) { if (td.removeAttribute) td.removeAttribute('data-label'); return; }
        if (labels[i]) td.setAttribute('data-label', labels[i]);
      });
    });
  }
  function mount(selector) {
    if (typeof document === 'undefined') return;
    each(document.querySelectorAll(selector || 'table[data-m-cards]'), (table) => {
      apply(table);
      if (typeof MutationObserver !== 'undefined') new MutationObserver(() => apply(table)).observe(table, { childList: true, subtree: true });
    });
  }
  return { labelsOf, apply, mount };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MobileCards;
