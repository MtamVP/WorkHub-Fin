// GIAO DIỆN QUẢN GIA: nút nổi + ngăn trượt bên phải, dùng chung mọi trang của WorkHub Fin (trang chính và các khu Investment / Valuation / Insight / Kiểm thử / Mô phỏng / Thị trường).
// Cách hoạt động: hỏi hàm Edge `butler` bằng phiên đăng nhập của chính người dùng (sbClient.functions.invoke), nên mọi dữ liệu chịu RLS của họ. Trang CHỈ hiển thị kết quả; đường dẫn do trang dựng từ lib/links.js và lib/butler-map-fin.js.
// An toàn dựng giao diện: mọi chữ lấy từ máy chủ / người dùng đều đi qua textContent (hàm h() không bao giờ dùng innerHTML), nên không thể chèn mã.
// Câu trả lời dạng thẻ: { type: 'list' | 'features' | 'guide' | 'blocked' | 'chips' | 'symbol' | 'kpis' } ('guide' = mục hướng dẫn sử dụng, mở ở /guide/#id); ref { kind:'section', key } chỉ tới mục của trang chính (xem script.js: applyLaunchHash / switchSection).
// Nạp bằng thẻ <script> thường (global ButlerUI) và module.exports cho Vitest (các hàm thuần: symFromHash, hrefForRef, featureHref, guideHref). Phần DOM chỉ chạy khi có document.
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
  // Đường dẫn mục hướng dẫn: chỉ nhận đúng dạng /guide/#id (máy chủ trả về nhưng trang vẫn tự kiểm, không tin đường dẫn lạ)
  function guideHref(href) { const m = /^\/guide\/#([\w-]{1,40})$/.exec(String(href || '')); return m ? '/guide/#' + m[1] : ''; }
  // Tham chiếu của một hàng -> { href, section? , action? } hoặc null: mục của trang chính, mã cổ phiếu (mở hồ sơ định giá) hoặc một tính năng của bản đồ
  function refTarget(ref, links, map) {
    if (!ref || typeof ref !== 'object') return null;
    if (ref.kind === 'section') { const href = hrefForRef(ref); return href ? { href, section: ref.key } : null; }
    if (ref.kind === 'symbol' && links && typeof links.valuation === 'function') { const href = links.valuation(ref.sym); return href && href !== '/valuation/' ? { href } : null; }
    if (ref.kind === 'feature' && links && map) { const t = featureHref(ref.id, ref.sym, links, map); return t ? { href: t.href, section: t.section, action: t.action } : null; }
    return null;
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

  // ---------- đề xuất ghi (giai đoạn D): Quản gia chỉ ĐỀ XUẤT, chỉ trang này ghi, sau khi người dùng bấm Xác nhận, bằng API sẵn có với phiên của chính họ ----------
  function loadScriptOnce(src, ready) {
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      try { const sc = document.createElement('script'); sc.src = src; sc.onload = () => resolve(ready()); sc.onerror = () => resolve(false); document.head.appendChild(sc); } catch (e) { resolve(false); }
    });
  }
  async function currentEmail() {
    const sb = typeof sbClient !== 'undefined' ? sbClient : null;
    if (!sb || !sb.auth) return '';
    const r = await sb.auth.getUser();
    return String((r && r.data && r.data.user && r.data.user.email) || '').trim().toLowerCase();
  }
  // fields đã qua ButlerCore.validateProposal. Trả câu thông báo kết quả; lỗi thì ném Error (trang hiện cho người dùng, thẻ giữ nguyên để sửa).
  async function executeProposal(kind, f) {
    const A = typeof API !== 'undefined' ? API : null;
    if (!A) throw new Error('Trang này chưa nạp công cụ ghi dữ liệu; mở trang chính của WorkHub Fin rồi thử lại.');
    if (kind === 'todo') {
      await A.personal.upsert({ type: 'checklist', title: f.title, data: { done: false }, tags: [] });
      return 'Đã thêm việc "' + f.title + '" vào Không Gian Riêng.';
    }
    const email = await currentEmail();
    if (!email) throw new Error('Chưa xác định được tài khoản đang đăng nhập.');
    if (kind === 'decision') {
      if (!(await loadScriptOnce('/lib/decision-journal.js', () => typeof DecisionJournal !== 'undefined'))) throw new Error('Không nạp được thư viện nhật ký quyết định.');
      const msg = await A.asset.journal.save(email, { symbol: f.symbol, action: f.action, date: f.date, price: f.price === '' ? null : Number(f.price), reason: f.reason });
      return (typeof msg === 'string' ? msg : 'Đã ghi quyết định vào nhật ký') + ' (' + f.symbol + ').';
    }
    if (kind === 'idea') {
      if (!(await loadScriptOnce('/lib/ideas.js', () => typeof IdeaFlow !== 'undefined'))) throw new Error('Không nạp được thư viện ý tưởng.');
      const r = await A.ideas.save(email, { symbol: f.symbol, title: f.title, direction: f.direction, thesis: f.thesis });
      return ((r && r.message) || 'Đã ghi nhận ý tưởng') + ' (' + f.symbol + '): xem ở Ý tưởng để bổ sung luận điểm, giá mục tiêu và rủi ro.';
    }
    throw new Error('Loại đề xuất không được hỗ trợ.');
  }
  const PROPOSAL_FIELDS = {
    todo: [{ key: 'title', label: 'Nội dung việc', type: 'text', max: 120 }],
    decision: [
      { key: 'symbol', label: 'Mã', type: 'text', max: 12 },
      { key: 'action', label: 'Hành động', type: 'select', options: [['', '— chọn —'], ['buy', 'Mua'], ['sell', 'Bán'], ['hold', 'Giữ'], ['skip', 'Bỏ qua']] },
      { key: 'date', label: 'Ngày quyết định', type: 'date' },
      { key: 'price', label: 'Giá (tuỳ chọn)', type: 'text', max: 14, mode: 'decimal' },
      { key: 'reason', label: 'Lý do', type: 'textarea', max: 1000 },
    ],
    idea: [
      { key: 'symbol', label: 'Mã', type: 'text', max: 12 },
      { key: 'title', label: 'Tiêu đề ý tưởng', type: 'text', max: 120 },
      { key: 'direction', label: 'Hướng', type: 'select', options: [['long', 'Mua (ý tưởng tăng)'], ['avoid', 'Tránh']] },
      { key: 'thesis', label: 'Luận điểm (tuỳ chọn)', type: 'textarea', max: 2000 },
    ],
  };
  function renderProposal(card, m) {
    const core = CORE();
    const wrap = h('section', { class: 'bt-card bt-proposal' }, h('h4', { class: 'bt-card-title', text: card.title || 'Đề xuất' }));
    if (card.state === 'done') { wrap.appendChild(h('p', { class: 'bt-prop-done' }, icon('fa-circle-check'), ' ', card.result || 'Đã ghi.')); return wrap; }
    if (card.state === 'skipped') { wrap.appendChild(h('p', { class: 'bt-prop-skip', text: 'Đã bỏ qua, không ghi gì.' })); return wrap; }
    const spec = PROPOSAL_FIELDS[card.kind] || [], inputs = {}, uid = 'btp' + Math.random().toString(36).slice(2, 8);
    const err = h('p', { class: 'bt-prop-err', role: 'alert', hidden: true });
    spec.forEach((s) => {
      const id = uid + '-' + s.key, val = (card.fields && card.fields[s.key] !== undefined) ? String(card.fields[s.key]) : '';
      let el;
      if (s.type === 'select') { el = h('select', { id, class: 'bt-prop-in' }, s.options.map((o) => h('option', { value: o[0], text: o[1] }))); el.value = val; }
      else if (s.type === 'textarea') { el = h('textarea', { id, class: 'bt-prop-in', rows: '3', maxlength: String(s.max || 1000) }); el.value = val; }
      else { el = h('input', { id, class: 'bt-prop-in', type: s.type, maxlength: s.max ? String(s.max) : null, inputmode: s.mode || null }); el.value = val; }
      inputs[s.key] = el;
      wrap.appendChild(h('div', { class: 'bt-prop-row' }, h('label', { for: id, class: 'bt-prop-lbl', text: s.label }), el));
    });
    wrap.appendChild(err);
    const ok = h('button', { type: 'button', class: 'bt-prop-ok', 'aria-label': 'Xác nhận ghi' }, icon('fa-check'), ' Xác nhận');
    const skip = h('button', { type: 'button', class: 'bt-prop-skipbtn', text: 'Bỏ qua' });
    const done = (patch) => { Object.assign(card, patch); saveHist(); renderAll(); };
    skip.addEventListener('click', () => done({ state: 'skipped' }));
    ok.addEventListener('click', async () => {
      const vals = {}; Object.keys(inputs).forEach((k) => { vals[k] = inputs[k].value; });
      const v = core ? core.validateProposal(card.kind, vals) : { ok: false, error: 'Thiếu lõi Quản gia.' };
      const show = (t) => { err.textContent = t; err.hidden = !t; };
      if (!v.ok) { show(v.error); return; }
      show(''); ok.disabled = true; skip.disabled = true; ok.lastChild.textContent = ' Đang ghi…';
      try { done({ state: 'done', result: await executeProposal(card.kind, v.fields) }); }
      catch (e) { ok.disabled = false; skip.disabled = false; ok.lastChild.textContent = ' Xác nhận'; show('Chưa ghi được: ' + ((e && e.message) || 'lỗi không rõ') + '. Bạn có thể sửa và thử lại.'); }
    });
    wrap.appendChild(h('div', { class: 'bt-prop-btns' }, ok, skip));
    return wrap;
  }

  // ---------- thẻ câu trả lời ----------
  function renderCard(card, m) {
    if (!card || typeof card !== 'object') return null;
    const links = L(), map = MAP();
    if (card.type === 'proposal') return renderProposal(card, m);
    if (card.type === 'list') {
      const ul = h('ul', { class: 'bt-rows' });
      (card.rows || []).forEach((r) => {
        const tg = refTarget(r.ref, links, map), sevWord = r.tone === 'bad' ? 'Cần xử lý: ' : (r.tone === 'warn' ? 'Cần chú ý: ' : '');        // mức độ không chỉ bằng màu: có chữ cho trình đọc màn hình
        const inner = [h('span', { class: 'bt-dot bt-' + (r.tone || 'info') }, sevWord ? h('span', { class: 'bt-sr', text: sevWord }) : null), h('span', { class: 'bt-row-main' }, h('span', { class: 'bt-row-text', text: r.text || '' }), r.sub ? h('span', { class: 'bt-row-sub', text: r.sub }) : null)];
        ul.appendChild(h('li', null, tg ? link(tg, 'bt-row', inner) : h('div', { class: 'bt-row' }, inner)));
      });
      return h('section', { class: 'bt-card' }, h('h4', { class: 'bt-card-title', text: card.title || '' }), ul);
    }
    if (card.type === 'kpis') {
      return h('dl', { class: 'bt-kpis' }, (card.items || []).map((k) => h('div', { class: 'bt-kpi' + (k.tone ? ' bt-' + k.tone : '') }, h('dt', { text: k.label || '' }), h('dd', { text: k.value || '' }))));
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
    if (card.type === 'guide') {
      const wrap = h('div', { class: 'bt-feats' });
      (card.items || []).forEach((it) => {
        const href = guideHref(it.href); if (!href) return;
        wrap.appendChild(h('div', { class: 'bt-feat bt-guide' },
          h('div', { class: 'bt-feat-head' }, h('span', { class: 'bt-feat-ico' }, icon('fa-book-open')), h('div', { class: 'bt-feat-txt' }, h('div', { class: 'bt-feat-label', text: it.title || '' }), it.chapter ? h('div', { class: 'bt-feat-area', text: it.chapter }) : null)),
          it.summary ? h('p', { class: 'bt-guide-sum', text: it.summary }) : null,
          link({ href }, 'bt-go', [h('span', { text: 'Đọc trong hướng dẫn' }), icon('fa-arrow-right')])));
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
    (m.cards || []).forEach((c) => { const el = renderCard(c, m); if (el) body.appendChild(el); });
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
  // Chỉ mục hướng dẫn (~60 KB) chỉ tải khi cần đến (mất kết nối máy chủ): chèn thẻ script rồi chờ tối đa 3 giây
  function ensureGuide() {
    if (typeof ButlerGuideData !== 'undefined') return Promise.resolve(ButlerGuideData);
    return new Promise((resolve) => {
      const done = () => resolve(typeof ButlerGuideData !== 'undefined' ? ButlerGuideData : null);
      try { const sc = document.createElement('script'); sc.src = '/lib/butler-guide-data.js'; sc.onload = done; sc.onerror = done; document.head.appendChild(sc); setTimeout(done, 3000); } catch (e) { done(); }
    });
  }
  async function localAnswer(q) {
    const core = CORE(), map = MAP();
    if (!core || !map) return null;
    const guide = await ensureGuide();
    const und = core.understand(q, { sym: symFromHash(location.hash, L()) }, map, guide);
    if (und.intent === 'help') return core.composeHelp(map);
    if (und.intent === 'symbol') return core.composeSymbol(und.sym);
    if (und.intent === 'propose') return core.composeProposal(und.proposal);
    if (und.intent === 'guide' && guide) return core.composeGuide(und.guide.slice(0, 3).map((g) => g.id), guide);
    if (und.intent === 'features') {
      const r = core.composeFeatures(und.features.slice(0, 3).map((f) => f.id), map, {}, und.sym);
      const g = guide ? und.guide.filter((x) => x.score >= 5).slice(0, 2) : [];
      if (g.length) r.cards = r.cards.concat(core.composeGuide(g.map((x) => x.id), guide, { extra: true }).cards.filter((c) => c.type === 'guide'));
      return r;
    }
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
      const local = await localAnswer(q);
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

  // ---------- tuỳ chọn: bản tin sáng qua email (giai đoạn C). Đọc / đổi qua hai hàm SQL của chính người dùng; "Gửi thử" gọi hàm butler-brief (mode me: chỉ gửi cho chính họ) ----------
  async function briefRpc(name, args) {
    const sb = typeof sbClient !== 'undefined' ? sbClient : null;
    if (!sb || !sb.rpc) throw new Error('Chưa kết nối máy chủ.');
    const r = await sb.rpc(name, args || {});
    if (r.error || !r.data || r.data.ok === false) throw new Error(r.data && r.data.reason === 'auth' ? 'Bạn cần đăng nhập.' : 'Không đọc / lưu được tuỳ chọn.');
    return r.data;
  }
  async function briefTest() {
    const sb = typeof sbClient !== 'undefined' ? sbClient : null;
    if (!sb || !sb.functions) throw new Error('Chưa kết nối máy chủ.');
    const { data, error } = await sb.functions.invoke('butler-brief', { body: { mode: 'me' } });
    if (error) {
      let j = null;
      try { j = error.context && typeof error.context.json === 'function' ? await error.context.json() : null; } catch (e) { /* không đọc được thân lỗi */ }
      throw new Error((j && j.error) || 'Không gửi thử được.');
    }
    return data;
  }
  function togglePrefs() {
    const e = state.els; if (!e.prefs) return;
    const show = e.prefs.hidden;
    e.prefs.hidden = !show; e.gear.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show && !state.briefLoaded) {
      e.briefBox.disabled = true; e.prefMsg.textContent = 'Đang đọc tuỳ chọn…';
      briefRpc('fn_butler_brief_get').then((d) => { e.briefBox.checked = !!d.brief_email; state.briefLoaded = true; e.prefMsg.textContent = ''; })
        .catch((err) => { e.prefMsg.textContent = err.message; }).finally(() => { e.briefBox.disabled = false; });
    }
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
    const gear = h('button', { type: 'button', class: 'bt-icon-btn', 'aria-label': 'Tuỳ chọn Quản gia', title: 'Tuỳ chọn', 'aria-expanded': 'false', 'aria-controls': 'bt-prefs', onclick: togglePrefs }, icon('fa-gear'));
    const briefBox = h('input', { type: 'checkbox', id: 'bt-brief', class: 'bt-ai-box' });
    const prefMsg = h('span', { class: 'bt-pref-msg', role: 'status', 'aria-live': 'polite' });
    briefBox.addEventListener('change', () => {
      const want = briefBox.checked; briefBox.disabled = true; prefMsg.textContent = 'Đang lưu…';
      briefRpc('fn_butler_brief_set', { p_on: want }).then(() => { prefMsg.textContent = want ? 'Đã bật: bản tin đến lúc 7:45 các ngày làm việc.' : 'Đã tắt bản tin sáng.'; })
        .catch((err) => { briefBox.checked = !want; prefMsg.textContent = err.message; }).finally(() => { briefBox.disabled = false; });
    });
    const testBtn = h('button', { type: 'button', class: 'bt-prop-skipbtn', text: 'Gửi thử cho tôi ngay' });
    testBtn.addEventListener('click', () => {
      testBtn.disabled = true; prefMsg.textContent = 'Đang gửi…';
      briefTest().then((d) => { prefMsg.textContent = d && d.sent ? 'Đã gửi tới email đăng nhập của bạn (' + d.items + ' mục).' : ((d && d.note) || 'Chưa gửi.'); })
        .catch((err) => { prefMsg.textContent = err.message; }).finally(() => { testBtn.disabled = false; });
    });
    const prefs = h('div', { class: 'bt-prefs', id: 'bt-prefs', hidden: true },
      h('label', { class: 'bt-pref', for: 'bt-brief' }, briefBox, h('span', { text: 'Gửi bản tin sáng qua email (7:45 các ngày làm việc)' })),
      h('p', { class: 'bt-pref-note', text: 'Bản tin chỉ gồm việc được giao cho bạn, lịch và mốc dự án bạn được phép xem, gửi tới email đăng nhập; không có việc nào thì không gửi. Mặc định tắt.' }),
      h('div', { class: 'bt-pref-row' }, testBtn, prefMsg));
    const panel = h('aside', { class: 'bt-panel', role: 'dialog', 'aria-label': 'Quản gia', hidden: true },
      h('header', { class: 'bt-head' }, h('div', { class: 'bt-title' }, icon('fa-bell-concierge'), h('div', null, h('div', { class: 'bt-name', text: 'Quản gia' }), h('div', { class: 'bt-sub', text: 'Chỉ đường, hướng dẫn, việc hôm nay' }))), h('div', { class: 'bt-head-btns' }, gear, clear, closeBtn)),
      log, status, prefs,
      h('footer', { class: 'bt-foot' },
        h('div', { class: 'bt-compose' }, input, send),
        h('label', { class: 'bt-ai', for: 'bt-ai', title: 'Khi quy tắc không hiểu câu hỏi, Quản gia nhờ Gemini (gói miễn phí) chọn chức năng phù hợp. Chỉ câu hỏi (đã bỏ email, số điện thoại, đường dẫn) được gửi đi, không gửi dữ liệu của bạn.' }, aiBox, h('span', { text: 'Dùng AI (Gemini miễn phí, bản thử) khi cần hiểu câu hỏi'  }))));
    const launcher = h('button', { type: 'button', class: 'bt-launcher', 'aria-label': 'Mở Quản gia (Alt+J)', title: 'Quản gia (Alt+J)', 'aria-expanded': 'false', onclick: toggle }, icon('fa-bell-concierge'), h('span', { class: 'bt-launcher-txt', text: 'Quản gia' }));
    const root = h('div', { class: 'bt-root' }, launcher, panel);
    document.body.appendChild(root);
    Object.assign(state.els, { root, launcher, panel, input, send, log, status, prefs, gear, briefBox, prefMsg });
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

  return { symFromHash, hrefForRef, refTarget, featureHref, guideHref, mount, open, close, ask };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ButlerUI;
globalThis.ButlerUI = ButlerUI;
if (typeof document !== 'undefined') {
  if (document.body) ButlerUI.mount(); else document.addEventListener('DOMContentLoaded', () => ButlerUI.mount());
}
