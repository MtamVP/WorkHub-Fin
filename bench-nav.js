/* --- FILE: /bench-nav.js ---
   Thanh điều hướng DÙNG CHUNG cho hai khu vực của WorkHub Finance:
     * Investment Workbench (quản lý đầu tư): Toàn Nhóm · Tổng Quan TT · Danh Mục · Nghiên Cứu, kèm lối sang Valuation Bench
     * Valuation Bench (định giá chuyên môn): Tổng quan · Hồ sơ cổ phiếu · Bộ lọc · Thị trường · Bản đồ · Định Giá CP · Phương pháp
   Mỗi trang gọi BenchNav.mount({ bench, active }) để dựng wordmark + thanh điều hướng (một nguồn duy nhất, trang chỉ khai báo mình thuộc khu nào và mục nào đang mở).
   Nạp bằng thẻ <script> thường (global BenchNav) và module.exports cho Vitest. Phần DOM chỉ chạy khi có document. */
const BenchNav = (function () {
  const NAV = {
    investment: {
      brand: 'Investment Workbench',
      items: [
        { key: 'group', href: '/mastersheet/', icon: 'fa-users', label: 'Toàn Nhóm' },
        { key: 'market', href: '/market/', icon: 'fa-earth-asia', label: 'Tổng Quan TT', title: 'Tổng quan thị trường: chỉ số, độ rộng, thanh khoản, khối ngoại, xu hướng, cổ phiếu nổi bật' },
        { key: 'assets', href: '/mastersheet/assets/', icon: 'fa-sack-dollar', label: 'Danh Mục' },
        { key: 'research', href: '/stocksheet/', icon: 'fa-chart-column', label: 'Nghiên Cứu' },
        { key: 'vb', href: '/valuation/', icon: 'fa-scale-balanced', label: 'Valuation Bench', title: 'Khu định giá chuyên môn: phương pháp định giá, phân tích cơ bản và kỹ thuật' },
        { key: 'sim', href: '/simulation/', icon: 'fa-code-branch', label: 'Market Simulation', title: 'Mô phỏng xác suất thị trường và danh mục, cây kịch bản, so sánh các cách xử lý' },
      ],
    },
    simulation: {
      brand: 'Market Simulation',
      items: [
        { key: 'outlook', href: '/simulation/', icon: 'fa-chart-area', label: 'Triển vọng', title: 'Quạt xác suất VN-Index, chế độ thị trường hiện tại' },
        { key: 'context', href: '/simulation/#context', icon: 'fa-wand-magic-sparkles', label: 'Bối cảnh', title: 'Bối cảnh tin tức bằng AI: thẻ sự kiện đưa vào mô phỏng' },
        { key: 'portfolio', href: '/simulation/#portfolio', icon: 'fa-flask', label: 'Mô phỏng', title: 'Mô phỏng danh mục và so sánh các cách xử lý' },
        { key: 'tree', href: '/simulation/#tree', icon: 'fa-code-branch', label: 'Cây kịch bản' },
        { key: 'validate', href: '/simulation/#validate', icon: 'fa-bullseye', label: 'Kiểm chứng', title: 'Mô hình đã dự báo đúng đến đâu trong quá khứ' },
        { key: 'method', href: '/simulation/#method', icon: 'fa-book-open', label: 'Phương pháp' },
        { key: 'back', href: '/mastersheet/', icon: 'fa-arrow-left', label: 'Investment', title: 'Về Investment Workbench (quản lý đầu tư)' },
      ],
    },
    valuation: {
      brand: 'Valuation Bench',
      items: [
        { key: 'overview', href: '/valuation/', icon: 'fa-gauge-high', label: 'Tổng quan' },
        { key: 'stock', href: '/valuation/#stock', icon: 'fa-magnifying-glass-chart', label: 'Hồ sơ cổ phiếu' },
        { key: 'screener', href: '/stocksheet/?bench=valuation&view=screener', icon: 'fa-filter', label: 'Bộ lọc', view: 'screener' },
        { key: 'market', href: '/stocksheet/?bench=valuation&view=market', icon: 'fa-earth-asia', label: 'Thị trường', view: 'market' },
        { key: 'map', href: '/stocksheet/?bench=valuation&view=map', icon: 'fa-map', label: 'Bản đồ', view: 'map' },
        { key: 'manual', href: '/stocksheet/autosheet/?bench=valuation', icon: 'fa-calculator', label: 'Định Giá CP' },
        { key: 'methods', href: '/valuation/#methods', icon: 'fa-book-open', label: 'Phương pháp' },
        { key: 'accuracy', href: '/valuation/#accuracy', icon: 'fa-chart-column', label: 'Độ chính xác', title: 'Bảng điểm backtest: bộ máy định giá đã dự báo đúng đến đâu trong quá khứ' },
        { key: 'back', href: '/mastersheet/', icon: 'fa-arrow-left', label: 'Investment', title: 'Về Investment Workbench (quản lý đầu tư)' },
      ],
    },
  };
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cfg = (bench) => NAV[bench] || NAV.investment;

  function navHtml(bench, active) {
    return cfg(bench).items.map(function (it) {
      return '<a href="' + esc(it.href) + '"' + (it.key === active ? ' class="active" aria-current="page"' : '') + (it.view ? ' data-view="' + esc(it.view) + '"' : '') + (it.title ? ' title="' + esc(it.title) + '"' : '') +
        '><i class="fa-solid ' + esc(it.icon) + '"></i> ' + esc(it.label) + '</a>';
    }).join('\n');
  }

  // Khu vực của trang stocksheet theo tham số ?bench=; mặc định là Investment (trừ khi xem các chế độ định giá đã chuyển sang Valuation Bench)
  const VALUATION_VIEWS = ['screener', 'market', 'map'];
  function benchFromSearch(search) {
    const p = new URLSearchParams(search || '');
    if (p.get('bench') === 'valuation') return 'valuation';
    if (p.get('bench') === 'investment') return 'investment';
    return VALUATION_VIEWS.indexOf(p.get('view')) !== -1 ? 'valuation' : 'investment';     // đường dẫn cũ /stocksheet/?view=market vẫn hoạt động, nay thuộc Valuation Bench
  }

  // Vị trí cuộn để mục đang mở nằm giữa thanh điều hướng cuộn ngang (thanh ở đáy màn hình trên điện thoại); không âm và không vượt quá phần cuộn được
  function centerOffset(viewWidth, itemLeft, itemWidth, scrollWidth) {
    const x = itemLeft - (viewWidth - itemWidth) / 2;
    return Math.max(0, Math.min(x, Math.max(0, scrollWidth - viewWidth)));
  }
  function centerActive(nav) {
    const a = nav && nav.querySelector ? nav.querySelector('a.active') : null;
    if (!a || !(nav.scrollWidth > nav.clientWidth)) return;
    nav.scrollLeft = centerOffset(nav.clientWidth, a.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft, a.offsetWidth, nav.scrollWidth);
  }

  // opts: { bench, active, onView(view) -> true nếu trang tự xử lý đổi chế độ xem mà không tải lại }
  function mount(opts) {
    if (typeof document === 'undefined') return;
    const o = opts || {}, bench = NAV[o.bench] ? o.bench : 'investment';
    const nav = document.querySelector('.desk-nav'), sub = document.querySelector('.desk-wordmark .sub');
    if (sub) sub.textContent = '· ' + cfg(bench).brand;
    if (nav) {
      nav.innerHTML = navHtml(bench, o.active);
      centerActive(nav);
      if (typeof o.onView === 'function') nav.addEventListener('click', function (e) {
        const a = e.target.closest ? e.target.closest('a[data-view]') : null;
        if (!a) return;
        if (o.onView(a.getAttribute('data-view'))) { e.preventDefault(); nav.querySelectorAll('a').forEach(function (x) { x.classList.toggle('active', x === a); }); }
      });
    }
    if (document.body) document.body.setAttribute('data-bench', bench);
    return bench;
  }
  // Đổi mục đang mở (khi trang đổi chế độ xem mà không tải lại)
  function setActive(active) {
    if (typeof document === 'undefined') return;
    const nav = document.querySelector('.desk-nav');
    if (!nav) return;
    const keys = {}; Object.keys(NAV).forEach(function (b) { NAV[b].items.forEach(function (it) { keys[it.href] = it.key; }); });
    nav.querySelectorAll('a').forEach(function (a) {
      const it = cfg(document.body && document.body.getAttribute('data-bench')).items.find(function (x) { return x.href === a.getAttribute('href'); });
      const on = it && it.key === active; a.classList.toggle('active', !!on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  return { NAV, VALUATION_VIEWS, navHtml, benchFromSearch, mount, setActive, centerOffset };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BenchNav;
