// GIAO DIỆN QUẢN GIA: nút nổi + ngăn trượt bên phải, dùng chung mọi trang của WorkHub Fin (trang chính và các khu Investment / Valuation / Insight / Kiểm thử / Mô phỏng / Thị trường).
// Cách hoạt động: hỏi hàm Edge `butler` bằng phiên đăng nhập của chính người dùng (sbClient.functions.invoke), nên mọi dữ liệu chịu RLS của họ. Trang CHỈ hiển thị kết quả; đường dẫn do trang dựng từ lib/links.js và lib/butler-map-fin.js.
// An toàn dựng giao diện: mọi chữ lấy từ máy chủ / người dùng đều đi qua textContent (hàm h() không bao giờ dùng innerHTML), nên không thể chèn mã.
// Câu trả lời dạng thẻ: { type: 'list' | 'features' | 'blocked' | 'chips' | 'symbol' }; ref { kind:'section', key } chỉ tới mục của trang chính (xem script.js: applyLaunchHash / switchSection).
// Nạp bằng thẻ <script> thường (global ButlerUI) và module.exports cho Vitest (các hàm thuần: symFromHash, hrefForRef, featureHref). Phần DOM chỉ chạy khi có document.
const ButlerUI = (function () {
  const KEY_AI = 'butler.ai', KEY_HIST = 'butler.hist.v1', MAX_HIST = 24;
  const L = () => (typeof Links !== 'undefined' ? Links : null);
  const MAP = () => (typeof ButlerMapFin !== 'undefined' ? ButlerMapFin : null);
  const CORE = () => (typeof ButlerCore !== 'undefined' ? ButlerCore : null);

  // ---------- hàm thuần (kiểm thử bằng Vitest) ----------
  // Mã cổ phiếu đang xem lấy từ hash của trang: Valuation "#stock/FPT", Insight "#events/FPT", Nghiên cứu "#FPT/2025", Simulation "#portfolio/FPT"
  function symFromHash(hash, links) {
    const p = String(hash || '').replace(/^#/, '').split('/').map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
    const sym = links && typeof links.sym === 'function' ? links.sym : (s) => (/^[A-Z][A-Z0-9]{1,4}$/.test(String(s).toUpperCase()) ? String(s).toUpperCase() : '');
    for (let i = 0; i < Math.min(p.length, 3); i++) {
      const s = sym(p[i]);
      if (s && /^[A-Z][A-Z0-9]{1,4}$/.test(s) && p[i] === p[i].toUpperCase()) return s;        // Links dựng hash mã luôn viết HOA; tên tab (chữ thường) không bị nhầm là mã
    }
    return '';
  }
  // Đường dẫn của một tham chiếu mục trang chính
  function hrefForRef(ref) {
    if (ref && ref.kind === 'section' && /^[\w-]+$/.test(String(ref.key || ''))) return '/#section=' + ref.key;
    return '';
  }
  // Mục tính năng -> { href, section?, action? } (section / action: mở ngay trong trang chính không cần tải lại)
  function featureHref(id, sym, links, map) {
    const f = map && map.byId ? map.byId(id) : null;
    if (!f) return null;
    const href = map.hrefOf(f, links, sym || '');
    const act = /^\/#do=(\w+)$/.exec(href);
    return { id, href, label: f.label, area: f.area, icon: f.icon, steps: f.steps || [], section: f.section || '', action: act ? act[1] : '' };
  }

  // ---------- DOM ----------
  const hasDom = typeof document !== 'undefined';
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); };
    for (let i = 2; i < arguments.length; i++) add(arguments[i]);
    return el;
  }
  const icon = (cls) => h('i', { class: 'fa-solid ' + (cls || 'fa-circle'), 'aria-hidden': 'true' });

  const state = { open: false, busy: false, ai: true, hist: [], els: {} };
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } },
    sget(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } },
    sset(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } },
  };
  function loadState() {
    state.ai = store.get(KEY_AI) !== '0';
    try { const a = JSON.parse(store.sget(KEY_HIST) || '[]'); state.hist = Array.isArray(a) ? a.slice(-MAX_HIST) : []; } catch (e) { state.hist = []; }
  }
  function saveHist() { store.sset(KEY_HIST, JSON.stringify(state.hist.slice(-MAX_HIST))); }

  // Mở một đích: trên trang chính thì đổi mục / mở hộp thoại tại chỗ; nơi khác thì chuyển trang
  function go(t, ev) {
    if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button === 1)) return;
    const onMain = typeof switchSection === 'function' && (location.pathname === '/' || /\/index\.html$/.test(location.pathname)) && !/\/(insight|lab|market|mastersheet|simulation|stocksheet|valuation)\//.test(location.pathname);
    if (onMain && t.section) { ev && ev.preventDefault(); try { switchSection(t.section); close(); } catch (e) { location.href = t.href; } return; }
    if (onMain && t.action && typeof LAUNCH_ACTIONS !== 'undefined' && LAUNCH_ACTIONS[t.action]) { ev && ev.preventDefault(); close(); try { LAUNCH_ACTIONS[t.action](); } catch (e) { location.href = t.href; } return; }
  }
  const link = (t, cls, children) => {
    const a = h('a', { class: cls, href: t.href }, children);
    a.addEventListener('click', (ev) => go(t, ev));
    return a;
  };

  // ---------- thẻ câu trả lời ----------
  function renderCard(card) {
    if (!card || typeof card !== 'object') return null;
    const links = L(), map = MAP();
    if (card.type === 'list') {
      const ul = h('ul', { class: 'bt-rows' });
      (card.rows || []).forEach((r) => {
        const href = hrefForRef(r.ref), sevWord = r.tone === 'bad' ? 'Quá hạn: ' : (r.tone === 'warn' ? 'Cần chú ý: ' : '');        // mức độ không chỉ bằng màu: có chữ cho trình đọc màn hình
        const inner = [h('span', { class: 'bt-dot bt-' + (r.tone || 'info') }, sevWord ? h('span', { class: 'bt-sr', text: sevWord }) : null), h('span', { class: 'bt-row-main' }, h('span', { class: 'bt-row-text', text: r.text || '' }), r.sub ? h('span', { class: 'bt-row-sub', text: r.sub }) : null)];
        ul.appendChild(h('li', null, href ? link({ href, section: r.ref.key }, 'bt-row', inner) : h('div', { class: 'bt-row' }, inner)));
      });
      return h('section', { class: 'bt-card' }, h('h4', { class: 'bt-card-title', text: card.title || '' }), ul);
    }
    if (card.type === 'features') {
      const wrap = h('div', { class: 'bt-feats' });
      (card.items || []).forEach((it) => {
        const t = links && map ? featureHref(it.id, it.sym, links, map) : null;
        if (!t) return;
        const steps = t.steps.length ? h('details', { class: 'bt-steps' }, h('summary', { text: 'Cách làm' }), h('ol', null, t.steps.map((s) => h('li', { text: s })))) : null;
        wrap.appendChild(h('div', { class: 'bt-feat' },
          h('div', { class: 'bt-feat-head' }, h('span', { class: 'bt-feat-ico' }, icon(t.icon)), h('div', { class: 'bt-feat-txt' }, h('div', { class: 'bt-feat-label', text: t.label }), h('div', { class: 'bt-feat-area', text: t.area + (it.sym ? ' · ' + it.sym : '') }))),
          steps, link(t, 'bt-go', [h('span', { text: 'Mở' }), icon('fa-arrow-right')])));
      });
      return wrap.childNodes.length ? wrap : null;
    }
    if (card.type === 'blocked') {
      return h('div', { class: 'bt-blocked' }, (card.items || []).map((b) => h('p', { text: b.why || '' })));
    }
    if (card.type === 'chips') {
      return h('div', { class: 'bt-chips', role: 'group', 'aria-label': 'Gợi ý câu hỏi' }, (card.items || []).map((q) => h('button', { type: 'button', class: 'bt-chip', text: String(q), onclick: () => ask(String(q)) })));
    }
    if (card.type === 'symbol' && links && typeof links.symMenu === 'function') {
      const items = links.symMenu(card.sym, '');
      return h('div', { class: 'bt-feats' }, items.map((m) => h('a', { class: 'bt-go bt-go-inline', href: m.href }, [icon(m.icon.replace(/^fa-solid /, '')), h('span', { text: m.label })])));
    }
    return null;
  }

  function renderMessage(m) {
    if (m.role === 'user') return h('div', { class: 'bt-msg bt-user' }, h('div', { class: 'bt-bubble', text: m.text }));
    const body = h('div', { class: 'bt-bubble' }, h('p', { class: 'bt-text', text: m.text || '' }));
    (m.notices || []).forEach((n) => body.appendChild(h('p', { class: 'bt-notice', role: 'note' }, icon('fa-circle-info'), ' ', n)));
    (m.cards || []).forEach((c) => { const el = renderCard(c); if (el) body.appendChild(el); });
    const meta = h('div', { class: 'bt-meta' });
    if (m.mode === 'ai') meta.appendChild(h('span', { class: 'bt-tag', title: 'Câu hỏi được Gemini giúp hiểu (đã bỏ email, số điện thoại)', text: 'AI' }));
    if (m.logId) {
      meta.appendChild(h('button', { type: 'button', class: 'bt-fb', 'aria-label': 'Câu trả lời hữu ích', title: 'Hữu ích', onclick: (ev) => feedback(m, 1, ev.currentTarget) }, icon('fa-thumbs-up')));
      meta.appendChild(h('button', { type: 'button', class: 'bt-fb', 'aria-label': 'Câu trả lời chưa đúng', title: 'Chưa đúng', onclick: (ev) => feedback(m, -1, ev.currentTarget) }, icon('fa-thumbs-down')));
    }
    if (meta.childNodes.length) body.appendChild(meta);
    return h('div', { class: 'bt-msg bt-bot' }, body);
  }

  function renderAll() {
    const log = state.els.log; if (!log) return;
    log.textContent = '';
    if (!state.hist.length) {
      const map = MAP(), core = CORE();
      const hello = core && map ? core.composeHelp(map) : { text: 'Mình là Quản gia.', cards: [] };
      log.appendChild(renderMessage({ role: 'bot', text: hello.text, cards: hello.cards }));
    } else state.hist.forEach((m) => log.appendChild(renderMessage(m)));
    log.scrollTop = log.scrollHeight;
  }

  // ---------- hỏi máy chủ ----------
  async function callServer(q) {
    const sb = typeof sbClient !== 'undefined' ? sbClient : null;
    if (!sb || !sb.functions) { const e = new Error('offline'); e.code = 'offline'; throw e; }
    const { data, error } = await sb.functions.invoke('butler', { body: { q, ai: state.ai, ctx: { page: location.pathname, sym: symFromHash(location.hash, L()) } } });
    if (error) {
      let j = null;
      try { j = error.context && typeof error.context.json === 'function' ? await error.context.json() : null; } catch (e) { /* không đọc được thân lỗi */ }
      const err = new Error((j && j.error) || 'Không kết nối được Quản gia.'); err.code = (j && j.code) || 'network'; throw err;
    }
    return data;
  }
  // Mất mạng / chưa triển khai hàm: dùng quy tắc ngay trên máy (không cần quyền đặc biệt, không có việc hôm nay)
  function localAnswer(q) {
    const core = CORE(), map = MAP();
    if (!core || !map) return null;
    const und = core.understand(q, { sym: symFromHash(location.hash, L()) }, map);
    if (und.intent === 'help') return core.composeHelp(map);
    if (und.intent === 'symbol') return core.composeSymbol(und.sym);
    if (und.intent === 'features') return core.composeFeatures(und.features.slice(0, 3).map((f) => f.id), map, {}, und.sym);
    return null;
  }

  async function ask(q) {
    q = String(q || '').trim();
    if (!q || state.busy) return;
    state.busy = true;
    state.hist.push({ role: 'user', text: q });
    setBusy(true); renderAll();
    let msg;
    try {
      const d = await callServer(q);
      msg = { role: 'bot', text: d.text, cards: d.cards, notices: d.notices, mode: d.mode, logId: d.logId };
    } catch (e) {
      const local = localAnswer(q);
      const why = e.code === 'auth' ? 'Bạn cần đăng nhập để Quản gia xem việc và dữ liệu của bạn.' : 'Chưa kết nối được máy chủ Quản gia (' + (e.message || 'lỗi') + ').';
      msg = local ? { role: 'bot', text: local.text, cards: local.cards, notices: [why + ' Dưới đây là gợi ý ngay trên máy.'] } : { role: 'bot', text: why, cards: [] };
    }
    state.hist.push(msg); saveHist();
    state.busy = false; setBusy(false); renderAll();
    if (state.els.input) state.els.input.focus();
  }

  async function feedback(m, rating, btn) {
    if (!m.logId || m.rated) return;
    m.rated = rating; saveHist();
    if (btn && btn.parentNode) btn.parentNode.querySelectorAll('.bt-fb').forEach((b) => { b.disabled = true; b.classList.toggle('on', b === btn); });
    try { const sb = typeof sbClient !== 'undefined' ? sbClient : null; if (sb) await sb.functions.invoke('butler', { body: { feedback: { id: m.logId, rating } } }); } catch (e) { /* phản hồi là tuỳ chọn */ }
  }

  function setBusy(b) {
    const e = state.els; if (!e.panel) return;
    e.panel.setAttribute('aria-busy', b ? 'true' : 'false');
    if (e.send) e.send.disabled = b;
    if (e.status) e.status.textContent = b ? 'Quản gia đang tìm…' : '';
  }

  // ---------- mở / đóng ----------
  function open() { if (!hasDom) return; build(); state.open = true; state.els.panel.hidden = false; state.els.launcher.setAttribute('aria-expanded', 'true'); renderAll(); setTimeout(() => state.els.input && state.els.input.focus(), 30); }
  function close() { if (!hasDom || !state.els.panel) return; state.open = false; state.els.panel.hidden = true; state.els.launcher.setAttribute('aria-expanded', 'false'); state.els.launcher.focus(); }
  function toggle() { if (state.open) close(); else open(); }

  function build() {
    if (state.els.panel) return;
    loadState();
    const input = h('textarea', { class: 'bt-input', rows: '1', 'aria-label': 'Hỏi Quản gia', placeholder: 'Hỏi: "hôm nay có việc gì?", "nhập sao kê ở đâu?"…', maxlength: '300' });
    const send = h('button', { type: 'button', class: 'bt-send', 'aria-label': 'Gửi câu hỏi', title: 'Gửi (Enter)' }, icon('fa-paper-plane'));
    const log = h('div', { class: 'bt-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Hội thoại với Quản gia' });
    const status = h('div', { class: 'bt-sr', role: 'status' });
    const aiBox = h('input', { type: 'checkbox', id: 'bt-ai', class: 'bt-ai-box' });
    aiBox.checked = state.ai;
    aiBox.addEventListener('change', () => { state.ai = aiBox.checked; store.set(KEY_AI, state.ai ? '1' : '0'); });
    const clear = h('button', { type: 'button', class: 'bt-icon-btn', 'aria-label': 'Xoá hội thoại', title: 'Xoá hội thoại', onclick: () => { state.hist = []; saveHist(); renderAll(); } }, icon('fa-eraser'));
    const closeBtn = h('button', { type: 'button', class: 'bt-icon-btn', 'aria-label': 'Đóng Quản gia', title: 'Đóng (Esc)', onclick: close }, icon('fa-xmark'));
    const panel = h('aside', { class: 'bt-panel', role: 'dialog', 'aria-label': 'Quản gia', hidden: true },
      h('header', { class: 'bt-head' }, h('div', { class: 'bt-title' }, icon('fa-bell-concierge'), h('div', null, h('div', { class: 'bt-name', text: 'Quản gia' }), h('div', { class: 'bt-sub', text: 'Chỉ đường, việc hôm nay, trong quyền của bạn' }))), h('div', { class: 'bt-head-btns' }, clear, closeBtn)),
      log, status,
      h('footer', { class: 'bt-foot' },
        h('div', { class: 'bt-compose' }, input, send),
        h('label', { class: 'bt-ai', for: 'bt-ai', title: 'Khi quy tắc không hiểu câu hỏi, Quản gia nhờ Gemini (gói miễn phí) chọn chức năng phù hợp. Chỉ câu hỏi (đã bỏ email, số điện thoại, đường dẫn) được gửi đi, không gửi dữ liệu của bạn.' }, aiBox, h('span', { text: 'Dùng AI (Gemini miễn phí, bản thử) khi cần hiểu câu hỏi'  }))));
    const launcher = h('button', { type: 'button', class: 'bt-launcher', 'aria-label': 'Mở Quản gia (Alt+J)', title: 'Quản gia (Alt+J)', 'aria-expanded': 'false', onclick: toggle }, icon('fa-bell-concierge'), h('span', { class: 'bt-launcher-txt', text: 'Quản gia' }));
    const root = h('div', { class: 'bt-root' }, launcher, panel);
    document.body.appendChild(root);
    Object.assign(state.els, { root, launcher, panel, input, send, log, status });
    const submit = () => { const v = input.value; input.value = ''; autosize(); ask(v); };
    send.addEventListener('click', submit);
    const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 96) + 'px'; };
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); } });
    panel.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });
  }

  function mount() {
    if (!hasDom || (document.querySelector && document.querySelector('.bt-root'))) return;
    build();
    document.addEventListener('keydown', (ev) => { if (ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === 'j' || ev.key === 'J')) { ev.preventDefault(); toggle(); } });
  }

  return { symFromHash, hrefForRef, featureHref, mount, open, close, ask };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ButlerUI;
globalThis.ButlerUI = ButlerUI;
if (typeof document !== 'undefined') {
  if (document.body) ButlerUI.mount(); else document.addEventListener('DOMContentLoaded', () => ButlerUI.mount());
}
