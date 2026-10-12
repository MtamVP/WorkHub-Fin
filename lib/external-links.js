// Địa chỉ ngoài DÙNG CHUNG của WorkHub Finance (web kế toán, WorkHub Org, trang phát hành), một chỗ định nghĩa thay vì rải rác theo trang.
// Web kế toán cho phép người dùng đặt lại địa chỉ (lưu trong máy, chỉ nhận http/https); mặc định là bản đang chạy. Logic thuần, không đụng mạng.
// Nạp bằng thẻ <script> thường (global ExternalLinks, có globalThis.ExternalLinks) và module.exports cho Vitest.
const ExternalLinks = (function () {
  const DEFAULTS = {
    accounting: 'https://accounting-2de.pages.dev',        // web kế toán OnyxLine Accounting (Cloudflare Pages)
    org: 'https://workhub-org.pages.dev/',                  // WorkHub Org (nơi "Về trang chủ" khi chưa đăng nhập)
    releases: 'https://github.com/MtamVP/WorkHub-Fin/releases',
  };
  const ACCOUNTING_KEY = 'wh.fin.accounting.url.v1';

  // http(s) tuyệt đối, hoặc '' nếu không hợp lệ
  function httpUrl(u) {
    try { const p = new URL(String(u === null || u === undefined ? '' : u).trim()); return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : ''; } catch (e) { return ''; }
  }
  function store() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }
  function override() { const s = store(); if (!s) return ''; try { return httpUrl(s.getItem(ACCOUNTING_KEY)); } catch (e) { return ''; } }

  // page: 'finlink' -> màn "Đầu tư (WorkHub Fin)" (#finlink); '' -> trang ứng dụng. Địa chỉ người dùng đã đặt được tôn trọng (đổi phần hash theo page).
  function accountingUrl(page) {
    const base = override() || (DEFAULTS.accounting + '/app');
    try { const u = new URL(base); u.hash = page ? '#' + page : ''; return u.href; } catch (e) { return DEFAULTS.accounting + '/app' + (page ? '#' + page : ''); }
  }
  // true nếu lưu được; chuỗi rỗng = quay về mặc định
  function setAccountingUrl(v) {
    const s = store(), raw = String(v === null || v === undefined ? '' : v).trim();
    if (!s) return false;
    try {
      if (!raw) { s.removeItem(ACCOUNTING_KEY); return true; }
      const ok = httpUrl(raw);
      if (!ok) return false;
      s.setItem(ACCOUNTING_KEY, ok); return true;
    } catch (e) { return false; }
  }
  const org = () => DEFAULTS.org;
  const releases = () => DEFAULTS.releases;

  return { DEFAULTS, ACCOUNTING_KEY, httpUrl, accountingUrl, setAccountingUrl, org, releases };
})();

if (typeof globalThis !== 'undefined') globalThis.ExternalLinks = ExternalLinks;
if (typeof module !== 'undefined' && module.exports) module.exports = ExternalLinks;
