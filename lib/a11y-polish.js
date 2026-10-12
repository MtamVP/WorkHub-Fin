// Hoàn thiện TRUY CẬP cho nội dung vẽ động (bảng, nút biểu tượng, trạng thái rỗng / đang tải), dùng chung cho mọi khu của Investment Workbench.
// Vì sao ở đây mà không sửa từng mẫu HTML: bảng, nút và khối trạng thái được dựng bằng chuỗi ở hàng trăm chỗ trong mã nhiều khu; một bộ quan sát nhỏ bảo đảm mọi chỗ (kể cả chỗ viết sau này) đều có:
//   * <th> trong <thead> có scope="col" (trình đọc màn hình đọc đúng tiêu đề cột);
//   * nút / liên kết CHỈ có biểu tượng mà đã có title thì có aria-label = title (nút thiếu cả hai bị tests/unit/a11y-static.test.js bắt ở mã nguồn);
//   * khối trạng thái rỗng / đang tải / lỗi (.wh-state, .ins-empty, .mk-empty, .tl-empty) có role="status" (lỗi: role="alert"); các dòng trạng thái tiến độ (#lab-status, #lab-prog, .ins-status, .sim-status) có role="status".
// Không đổi giao diện, không đụng nội dung; chạy lại an toàn (chỉ thêm thuộc tính còn thiếu). KHÔNG đụng mạng / lưu trữ. Nạp bằng thẻ <script> thường (global A11yPolish) và module.exports cho Vitest.
const A11yPolish = (function () {
  const STATE_SEL = '.wh-state, .ins-empty, .mk-empty, .tl-empty';
  const LIVE_SEL = '#lab-status, #lab-prog, .ins-status, .sim-status';
  const hasClass = (el, c) => !!(el.classList && el.classList.contains && el.classList.contains(c));

  // Thêm các thuộc tính còn thiếu trong cây gốc root (mặc định: cả trang). Trả số thuộc tính đã thêm.
  function apply(root) {
    const r = root || (typeof document !== 'undefined' ? document : null);
    if (!r || typeof r.querySelectorAll !== 'function') return 0;
    let n = 0;
    r.querySelectorAll('thead th:not([scope])').forEach(function (th) { th.setAttribute('scope', 'col'); n++; });
    r.querySelectorAll('button:not([aria-label]), a.icon-btn:not([aria-label]), summary:not([aria-label])').forEach(function (b) {
      const title = b.getAttribute('title');
      if (title && !String(b.textContent || '').trim()) { b.setAttribute('aria-label', title); n++; }
    });
    r.querySelectorAll(STATE_SEL).forEach(function (e) {
      if (!e.getAttribute('role')) { e.setAttribute('role', hasClass(e, 'error') ? 'alert' : 'status'); n++; }
    });
    r.querySelectorAll(LIVE_SEL).forEach(function (e) {
      if (!e.getAttribute('role') && !e.getAttribute('aria-live')) { e.setAttribute('role', 'status'); n++; }
    });
    return n;
  }

  // Theo dõi thay đổi DOM và áp lại (gộp trong 60 ms để không tốn khi trang vẽ nhiều lần liên tiếp)
  function observe() {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return null;
    let queued = false;
    const run = function () { queued = false; try { apply(document); } catch (_e) { /* không bao giờ làm hỏng trang */ } };
    const schedule = function () { if (queued) return; queued = true; setTimeout(run, 60); };        // setTimeout (không phải requestAnimationFrame): chạy cả khi tab đang ẩn
    const mo = new MutationObserver(schedule);
    const start = function () { run(); mo.observe(document.body, { childList: true, subtree: true }); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
    return mo;
  }

  return { apply, observe, STATE_SEL, LIVE_SEL };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = A11yPolish;
globalThis.A11yPolish = A11yPolish;
if (typeof document !== 'undefined') A11yPolish.observe();
