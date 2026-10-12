// Liên kết DÙNG CHUNG giữa các block của WorkHub Finance (Investment, Insight, Kiểm thử, Market Simulation, Valuation, Nghiên cứu).
// Trước đây mỗi trang tự ghép chuỗi "/valuation/#stock/FPT", "/stocksheet/#FPT", "#runs/<id>"; nay một chỗ định nghĩa và mỗi trang đích khai báo cùng ngữ pháp hash:
//   Valuation   #stock/SYM[/tab]            Stocksheet  #SYM[/năm]            Insight  #tab[/SYM]            Kiểm thử  #tab[/runId]
//   Simulation  #view[/khoá]  (#runs/<id>, #portfolio/SYM)                    Toàn nhóm #tab                  Danh Mục  #tab
// Đường dẫn tuyệt đối từ gốc: chạy giống nhau ở bản web và bản Tauri (scripts/sync-web.mjs chép nguyên cây thư mục).
// Nạp bằng thẻ <script> thường (global Links, có globalThis.Links) và module.exports cho Vitest. Phần DOM (menu mã) chỉ chạy khi có document.
const Links = (function () {
  const INSIGHT_TABS = ['inbox', 'events', 'thesis', 'liquidity', 'cash', 'ownership', 'rotation', 'accuracy', 'archive'];
  const LAB_TABS = ['backtest', 'factors'];
  const SIM_VIEWS = ['outlook', 'context', 'portfolio', 'tree', 'runs', 'validate', 'method'];
  const GROUP_TABS = ['portfolio', 'activity', 'limits', 'approvals', 'strategy', 'journey', 'execution', 'data', 'quant', 'report', 'members'];
  const ASSET_TABS = ['holdings', 'watchlist', 'ledger', 'journal', 'performance', 'mirror', 'risk', 'calendar', 'reports'];
  const VB_TABS = ['summary', 'process', 'fundamental', 'valuation', 'technical', 'market', 'saved'];

  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SYM_RE = /^[A-Z0-9][A-Z0-9._-]{0,11}$/;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  // Mã hợp lệ viết hoa, hoặc '' nếu không hợp lệ (không bao giờ đưa chuỗi lạ vào đường dẫn)
  const sym = (s) => { const x = String(s === null || s === undefined ? '' : s).trim().toUpperCase(); return SYM_RE.test(x) ? x : ''; };
  const id = (s) => { const x = String(s === null || s === undefined ? '' : s).trim(); return ID_RE.test(x) ? x : ''; };
  const pick = (list, v, dflt) => (list.indexOf(v) !== -1 ? v : dflt);

  const valuation = (s, tab) => { const x = sym(s); return x ? '/valuation/#stock/' + x + (VB_TABS.indexOf(tab) > 0 ? '/' + tab : '') : '/valuation/'; };
  const stock = (s, year) => { const x = sym(s), y = /^\d{4}$/.test(String(year || '')) ? '/' + year : ''; return x ? '/stocksheet/#' + x + y : '/stocksheet/'; };
  const autosheet = (s, year) => { const x = sym(s), y = /^\d{4}$/.test(String(year || '')) ? '/' + year : ''; return x ? '/stocksheet/autosheet/#' + x + y : '/stocksheet/autosheet/'; };
  const insight = (tab, s) => { const t = pick(INSIGHT_TABS, tab, 'inbox'), x = sym(s); return '/insight/#' + t + (x ? '/' + x : ''); };
  const lab = (tab, runId) => { const t = pick(LAB_TABS, tab, 'backtest'), r = id(runId); return '/lab/#' + t + (r ? '/' + r : ''); };
  const simulation = (view, key) => { const v = pick(SIM_VIEWS, view, 'outlook'), k = id(key); return v === 'outlook' && !k ? '/simulation/' : '/simulation/#' + v + (k ? '/' + k : ''); };
  const simRun = (runId) => simulation('runs', runId);
  const simSymbol = (s) => { const x = sym(s); return x ? '/simulation/#portfolio/' + x : '/simulation/#portfolio'; };
  const group = (tab) => '/mastersheet/#' + pick(GROUP_TABS, tab, 'portfolio');
  const assets = (tab) => '/mastersheet/assets/#' + pick(ASSET_TABS, tab, 'holdings');
  const journal = () => assets('journal');
  const market = () => '/market/';

  // Phân tích hash dạng "#a/b" -> { a, b } (cho trang đích dùng; luôn trả chuỗi, không ném lỗi)
  function parseHash(h) {
    const p = String(h || '').replace(/^#/, '').split('/');
    let a = '', b = '';
    try { a = decodeURIComponent(p[0] || ''); b = decodeURIComponent(p[1] || ''); } catch (e) { a = p[0] || ''; b = p[1] || ''; }
    return { a: a, b: b, c: p[2] || '' };
  }

  // Menu các nơi xem một mã. from: block đang đứng ('insight' | 'valuation' | ...) để không tự liên kết về chính mình
  function symMenu(s, from) {
    const x = sym(s); if (!x) return [];
    return [
      { key: 'valuation', label: 'Hồ sơ định giá', icon: 'fa-scale-balanced', href: valuation(x) },
      { key: 'stock', label: 'Nghiên cứu', icon: 'fa-chart-column', href: stock(x) },
      { key: 'thesis', label: 'Luận điểm', icon: 'fa-list-check', href: insight('thesis', x) },
      { key: 'events', label: 'Sự kiện', icon: 'fa-newspaper', href: insight('events', x) },
      { key: 'ownership', label: 'Sở hữu', icon: 'fa-user-tie', href: insight('ownership', x) },
      { key: 'liquidity', label: 'Thanh khoản', icon: 'fa-droplet', href: insight('liquidity', x) },
      { key: 'simulation', label: 'Mô phỏng', icon: 'fa-code-branch', href: simSymbol(x) },
    ].filter((m) => m.key !== from);
  }
  // Mã bấm được: bản thân mã mở hồ sơ định giá (hoặc Nghiên cứu nếu đang ở Valuation), nút nhỏ bên cạnh mở menu các nơi khác. Mã lạ -> chữ thường đã escape.
  // opts: { from, plain (không menu), cls }
  function symHtml(s, opts) {
    const o = opts || {}, x = sym(s);
    if (!x) return '<b>' + esc(s) + '</b>';
    const primary = o.from === 'valuation' ? stock(x) : valuation(x);
    const link = '<a class="wh-sym" href="' + esc(primary) + '" title="' + (o.from === 'valuation' ? 'Mở ' + x + ' ở Nghiên cứu' : 'Mở hồ sơ định giá ' + x) + '"><b>' + esc(x) + '</b></a>';
    if (o.plain) return link;
    const items = symMenu(x, o.from).filter((m) => m.href !== primary);
    return link + '<details class="wh-symmore"><summary aria-label="Xem ' + esc(x) + ' ở công cụ khác" title="Xem ' + esc(x) + ' ở công cụ khác"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></summary>' +
      '<div class="wh-symmenu" role="menu">' + items.map((m) => '<a role="menuitem" href="' + esc(m.href) + '"><i class="fa-solid ' + esc(m.icon) + '" aria-hidden="true"></i> ' + esc(m.label) + '</a>').join('') + '</div></details>';
  }

  // Đóng menu mã khi bấm ra ngoài hoặc mở menu khác (một lần cho cả trang)
  if (typeof document !== 'undefined' && document.addEventListener && !(typeof window !== 'undefined' && window.__whSymMenuBound)) {
    if (typeof window !== 'undefined') window.__whSymMenuBound = true;
    document.addEventListener('click', function (e) {
      const keep = e.target && e.target.closest ? e.target.closest('details.wh-symmore') : null;
      document.querySelectorAll('details.wh-symmore[open]').forEach(function (d) { if (d !== keep) d.removeAttribute('open'); });
    });
    // Menu vẽ cố định theo cửa sổ để không bị cắt bởi bảng cuộn / thẻ có overflow; đặt vị trí khi mở, lật lên trên nếu hết chỗ phía dưới
    document.addEventListener('toggle', function (e) {
      const d = e.target;
      if (!d || !d.classList || !d.classList.contains('wh-symmore') || !d.open) return;
      const menu = d.querySelector('.wh-symmenu'), sum = d.querySelector('summary');
      if (!menu || !sum) return;
      const r = sum.getBoundingClientRect(), mh = menu.offsetHeight, mw = menu.offsetWidth;
      const top = r.bottom + 2 + mh > window.innerHeight && r.top - mh - 2 > 0 ? r.top - mh - 2 : r.bottom + 2;
      menu.style.top = Math.round(top) + 'px'; menu.style.left = Math.round(Math.max(4, Math.min(r.left, window.innerWidth - mw - 4))) + 'px';
    }, true);
    document.addEventListener('scroll', function () { document.querySelectorAll('details.wh-symmore[open]').forEach(function (d) { d.removeAttribute('open'); }); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') document.querySelectorAll('details.wh-symmore[open]').forEach(function (d) { d.removeAttribute('open'); }); });
  }

  return { INSIGHT_TABS, LAB_TABS, SIM_VIEWS, GROUP_TABS, ASSET_TABS, VB_TABS, sym, id, valuation, stock, autosheet, insight, lab, simulation, simRun, simSymbol, group, assets, journal, market, parseHash, symMenu, symHtml };
})();

if (typeof globalThis !== 'undefined') globalThis.Links = Links;
if (typeof module !== 'undefined' && module.exports) module.exports = Links;
