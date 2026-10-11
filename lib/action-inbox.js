// Logic thuần: HỘP VIỆC CẦN LÀM. Mỗi công cụ (luận điểm, tin theo mã, giao dịch nội bộ, giới hạn đầu tư, duyệt lệnh, dòng tiền, hành động doanh nghiệp, sức khoẻ dữ liệu, các hàm tự chạy) có tín hiệu riêng nằm ở một tab khác nhau;
// nguy cơ của một bộ công cụ nhiều tab là bạn không mở hết. Ở đây gom mọi tín hiệu ĐÃ CÓ thành một danh sách xếp theo mức khẩn cấp, và dựng email tóm tắt buổi sáng từ chính danh sách đó (cùng một bản mã cho trang và máy chủ).
// Mức khẩn cấp (sev): 1 = nghiêm trọng, nên xem ngay; 2 = cao, xem trong ngày; 3 = vừa, xem trong tuần; 4 = thông tin. Quy tắc xếp mức nằm ở đây và hiện ra trong giao diện để người dùng biết vì sao một mục ở mức đó.
// Nguyên tắc: không bịa tín hiệu từ số liệu thiếu; mỗi mục có mã ổn định (id) để máy chủ chỉ báo những mục MỚI; không trộn tin xấu của mã bạn không nắm giữ / theo dõi vào danh sách của bạn.
// KHÔNG đụng DOM/mạng/tệp. Nạp bằng thẻ <script> thường (global ActionInbox) và module.exports cho Vitest; bản sao chạy ở Edge Function insight-sync (chế độ digest).
const ActionInbox = (function () {
  const VERSION = 1;
  const SEV = {
    1: { label: 'Nghiêm trọng', tone: 'bad', icon: 'circle-exclamation' },
    2: { label: 'Cao', tone: 'warn', icon: 'triangle-exclamation' },
    3: { label: 'Vừa', tone: 'info', icon: 'circle-info' },
    4: { label: 'Thông tin', tone: 'muted', icon: 'circle' },
  };
  const KINDS = {
    thesis: { label: 'Luận điểm', icon: 'list-check', href: '/insight/#thesis' },
    event: { label: 'Tin theo mã', icon: 'newspaper', href: '/insight/#events' },
    insider: { label: 'Giao dịch nội bộ', icon: 'user-tie', href: '/insight/#ownership' },
    limit: { label: 'Giới hạn đầu tư', icon: 'gauge-high', href: '/mastersheet/#limits' },
    approval: { label: 'Duyệt lệnh', icon: 'stamp', href: '/mastersheet/' },
    cash: { label: 'Dòng tiền', icon: 'wallet', href: '/insight/#cash' },
    corporate: { label: 'Hành động doanh nghiệp', icon: 'calendar-day', href: '/mastersheet/assets/' },
    health: { label: 'Chất lượng dữ liệu', icon: 'database', href: '/mastersheet/' },
    system: { label: 'Hệ thống', icon: 'gears', href: '/insight/#archive' },
  };
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const iso = (v) => String(v || '').slice(0, 10);
  const symSet = (a) => new Set((a || []).map((s) => String(s || '').toUpperCase()).filter(Boolean));
  const daysBetween = (a, b) => Math.round((Date.parse(iso(b) + 'T00:00:00Z') - Date.parse(iso(a) + 'T00:00:00Z')) / 86400000);
  const fmtDate = (d) => { const s = iso(d); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(8) + '/' + s.slice(5, 7) : ''; };
  const money = (n) => Math.round(Math.abs(n)).toLocaleString('vi-VN');
  const item = (o) => Object.assign({ sev: 3, kind: 'system', title: '', detail: '', symbol: null, at: null, link: null, ref: null }, o, { link: o.link || (KINDS[o.kind] || {}).href || null });

  // ---------- từng nguồn ----------
  function thesisItems(input) {
    const out = [];
    (input.ideas || []).forEach((i) => {
      if (i.status !== 'broken' && i.status !== 'warning') return;
      const fails = (i.conditions || []).filter((c) => c.state === 'fail' && (i.status === 'broken' ? c.severity === 'critical' : true));
      const names = fails.slice(0, 3).map((c) => c.label || c.metric).join('; ');
      out.push(item({ id: 'thesis|' + i.id + '|' + i.status, kind: 'thesis', sev: i.status === 'broken' ? 1 : 2, symbol: i.symbol, title: (i.symbol || '?') + ': luận điểm ' + (i.status === 'broken' ? 'bị phá vỡ' : 'cần chú ý'), detail: (i.title ? i.title + ' · ' : '') + (names || (fails.length + ' điều kiện sai')) + (i.owner ? ' (chủ: ' + i.owner + ')' : ''), at: (fails[0] && fails[0].since) || null }));
    });
    return out;
  }
  function eventItems(input) {
    const held = symSet(input.held), watch = symSet(input.watch), now = input.now || Date.now(), maxAge = (input.eventDays || 3) * 86400000;
    const best = new Map();
    (input.events || []).forEach((e) => {
      const sym = String(e.symbol || '').toUpperCase();
      const mine = held.has(sym), watched = watch.has(sym);
      if (!mine && !watched) return;
      const t = e.published_at ? Date.parse(e.published_at) : NaN;
      if (isFinite(t) && now - t > maxAge) return;
      let sev = null;
      if (e.severity === 'alert' && e.direction <= 0) sev = mine ? 1 : 2;
      else if (e.severity === 'watch') sev = mine ? 3 : 4;
      else if (e.event_type === 'insider_sell' && mine) sev = 3;
      if (!sev) return;
      const key = sym + '|' + e.event_type;
      const cur = best.get(key);
      if (!cur || sev < cur.sev || (sev === cur.sev && (t || 0) > (cur.t || 0))) best.set(key, { e, sev, t, mine });
    });
    return [...best.values()].map((b) => item({ id: 'event|' + b.e.news_id + '|' + b.e.symbol + '|' + b.e.event_type, kind: 'event', sev: b.sev, symbol: b.e.symbol, title: b.e.symbol + ': ' + (b.e.label || b.e.event_type) + (b.mine ? '' : ' (mã đang theo dõi)'), detail: String(b.e.title || '').slice(0, 160), at: b.e.published_at || null, link: b.e.link || null, ref: b.e.link || null }));
  }
  function insiderItems(input) {
    const held = symSet(input.held), watch = symSet(input.watch), out = [];
    (input.insider || []).forEach((x) => {
      const sym = String(x.symbol || '').toUpperCase(), s = x.summary || {}, mine = held.has(sym);
      if (!mine && !watch.has(sym)) return;
      if (s.cluster) out.push(item({ id: 'insider|' + sym + '|cluster-buy|' + iso(s.to).slice(0, 7), kind: 'insider', sev: 3, symbol: sym, title: sym + ': nhiều người trong cuộc cùng mua', detail: s.buyers + ' người mua, ròng ' + Math.round(s.netQty).toLocaleString('vi-VN') + ' cp trong ' + (s.from ? daysBetween(s.from, s.to) : 90) + ' ngày' + (mine ? '' : ' (mã đang theo dõi)'), at: s.last || null }));
      else if (mine && s.sellers >= 3 && s.netQty < 0) out.push(item({ id: 'insider|' + sym + '|cluster-sell|' + iso(s.to).slice(0, 7), kind: 'insider', sev: 2, symbol: sym, title: sym + ': nhiều người trong cuộc cùng bán', detail: s.sellers + ' người bán, ròng ' + Math.round(s.netQty).toLocaleString('vi-VN') + ' cp (người nội bộ bán có thể vì lý do không liên quan triển vọng)', at: s.last || null }));
    });
    return out;
  }
  function limitItems(input) {
    const out = [];
    (input.compliance || []).forEach((b) => {
      const breach = b.level === 'breach', blocking = b.mode === 'block';
      out.push(item({ id: 'limit|' + (b.subject || b.kind) + '|' + b.level + '|' + (b.scope || ''), kind: 'limit', sev: breach ? (blocking ? 1 : 2) : 3, symbol: b.symbol || null, title: (breach ? 'Vượt giới hạn: ' : 'Gần chạm giới hạn: ') + (b.subject || b.kind), detail: (b.current !== undefined && b.current !== null ? 'hiện ' + b.current + (b.threshold !== undefined && b.threshold !== null ? ' / ngưỡng ' + b.threshold : '') : '') + (b.since ? ' · từ ' + fmtDate(b.since) : '') + (blocking ? ' · chế độ chặn lệnh' : ''), at: b.since || null }));
    });
    return out;
  }
  function approvalItems(input) {
    const now = input.now || Date.now(), out = [];
    (input.approvals || []).forEach((a) => {
      const t = a.created_at ? Date.parse(a.created_at) : NaN, old = isFinite(t) && now - t > 24 * 3600000;
      out.push(item({ id: 'approval|' + a.id, kind: 'approval', sev: old ? 2 : 3, symbol: a.symbol || null, title: 'Lệnh chờ duyệt' + (a.symbol ? ': ' + (a.side === 'sell' ? 'bán ' : 'mua ') + a.symbol : ''), detail: (a.requester ? 'người đề xuất ' + a.requester : '') + (isFinite(t) ? ' · ' + Math.max(1, Math.round((now - t) / 3600000)) + ' giờ trước' : ''), at: a.created_at || null }));
    });
    return out;
  }
  function cashItems(input) {
    const c = input.cash, today = input.today;
    if (!c || !c.firstShortfall) return [];
    const d = c.firstShortfall.date, n = today ? daysBetween(today, d) : null;
    return [item({ id: 'cash|shortfall|' + iso(d), kind: 'cash', sev: n !== null && n <= 7 ? 2 : 3, title: 'Dòng tiền: dự kiến thiếu tiền ' + (n !== null && n >= 0 ? (n === 0 ? 'hôm nay' : 'sau ' + n + ' ngày') : 'ngày ' + fmtDate(d)), detail: 'số dư thấp nhất ' + (num(c.minBalance) !== null ? (c.minBalance < 0 ? '−' : '') + money(c.minBalance) + ' đ' : '?') + (c.minDate ? ' ngày ' + fmtDate(c.minDate) : ''), at: d }) ];
  }
  function corporateItems(input) {
    const held = symSet(input.held), today = input.today, out = [];
    (input.corporate || []).forEach((e) => {
      const sym = String(e.symbol || '').toUpperCase();
      if (!held.has(sym) || !e.exDate || !today) return;
      const n = daysBetween(today, e.exDate);
      if (n < 0 || n > 7) return;
      out.push(item({ id: 'corp|' + sym + '|' + e.kind + '|' + iso(e.exDate), kind: 'corporate', sev: n <= 3 ? 3 : 4, symbol: sym, title: sym + ': ' + (e.label || e.kind) + ' — ' + (n === 0 ? 'hôm nay là ngày không hưởng quyền' : 'còn ' + n + ' ngày tới ngày không hưởng quyền (' + fmtDate(e.exDate) + ')'), detail: e.detail || '', at: e.exDate }));
    });
    return out;
  }
  // Tên dễ đọc của các loại cảnh báo chất lượng dữ liệu (cùng tên với email cảnh báo dữ liệu của market-data-sync)
  const HEALTH_LABEL = { price_mismatch: 'Hai nguồn giá lệch nhau', price_jump: 'Giá nhảy vượt biên độ sàn', stale_price: 'Giá cũ / mã dừng giao dịch', missing_session: 'Thiếu phiên giá', source_down: 'Nguồn dữ liệu lỗi', price_level: 'Khác cách điều chỉnh giá', meta_gap: 'Mã chưa có phân ngành' };
  function healthItems(input) {
    const out = [];
    (input.health || []).forEach((h) => {
      if (h.severity !== 'error' && h.severity !== 'warn') return;
      const name = HEALTH_LABEL[h.kind] || (h.label && h.label !== h.kind ? h.label : h.kind);
      out.push(item({ id: 'health|' + (h.dedupe_key || h.kind + '|' + (h.symbol || '') + '|' + iso(h.ref_date)), kind: 'health', sev: h.severity === 'error' ? 2 : 3, symbol: h.symbol || null, title: 'Dữ liệu: ' + name + (h.symbol ? ' (' + h.symbol + ')' : ''), detail: h.text || (h.ref_date ? 'ngày dữ liệu ' + fmtDate(h.ref_date) : ''), at: h.ref_date || null }));
    });
    return out;
  }
  function systemItems(input) {
    const now = input.now || Date.now(), failed = new Map();
    (input.runs || []).forEach((r) => {
      const t = Date.parse(r.run_at);
      if (r.ok !== false || (isFinite(t) && now - t > 36 * 3600000)) return;
      const k = r.fn + '|' + (r.mode || '');
      if (!failed.has(k) || t > failed.get(k).t) failed.set(k, { r, t });
    });
    return [...failed.values()].map((f) => item({ id: 'system|' + f.r.fn + '|' + (f.r.mode || '') + '|' + iso(f.r.run_at), kind: 'system', sev: 3, title: 'Hàm tự chạy lỗi: ' + f.r.fn + (f.r.mode ? ' (' + f.r.mode + ')' : ''), detail: 'lần chạy cuối bị lỗi lúc ' + String(f.r.run_at).slice(11, 16) + ' ngày ' + fmtDate(f.r.run_at), at: f.r.run_at }));
  }

  // Gom, bỏ trùng theo id, sắp theo mức rồi mới nhất. input: xem đầu tệp; trả [item].
  function build(input) {
    const inp = input || {};
    const all = [].concat(thesisItems(inp), eventItems(inp), insiderItems(inp), limitItems(inp), approvalItems(inp), cashItems(inp), corporateItems(inp), healthItems(inp), systemItems(inp));
    const seen = new Set(), out = [];
    all.forEach((x) => { if (!seen.has(x.id)) { seen.add(x.id); out.push(x); } });
    return out.sort((a, b) => (a.sev - b.sev) || ((Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)) || (a.id < b.id ? -1 : 1));
  }
  function summarize(items) {
    const bySev = { 1: 0, 2: 0, 3: 0, 4: 0 }, byKind = {};
    (items || []).forEach((x) => { bySev[x.sev]++; byKind[x.kind] = (byKind[x.kind] || 0) + 1; });
    const urgent = bySev[1] + bySev[2];
    return { total: (items || []).length, bySev, byKind, urgent, headline: !items || !items.length ? 'Không có việc cần chú ý' : (bySev[1] ? bySev[1] + ' việc nghiêm trọng' + (bySev[2] ? ', ' + bySev[2] + ' việc mức cao' : '') : (bySev[2] ? bySev[2] + ' việc mức cao' : items.length + ' việc cần xem')) };
  }
  // Mục MỚI so với lần gửi trước (prevIds: mảng id đã báo)
  function fresh(items, prevIds) { const p = new Set(prevIds || []); return (items || []).filter((x) => !p.has(x.id)); }

  // Email tóm tắt: chỉ các mục mức 1-3; nhấn mạnh mục mới. base = địa chỉ trang (tuỳ chọn).
  function digest(items, opts) {
    const o = Object.assign({ newIds: null, base: '', maxItems: 30, title: 'Việc cần làm hôm nay' }, opts || {});
    const list = (items || []).filter((x) => x.sev <= 3), news = o.newIds ? new Set(o.newIds) : null, S = summarize(list);
    const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const subject = 'WorkHub: ' + (S.bySev[1] ? S.bySev[1] + ' việc nghiêm trọng' : (S.bySev[2] ? S.bySev[2] + ' việc mức cao' : S.total + ' việc cần xem')) + (news && news.size ? ' (' + [...news].filter((id) => list.some((x) => x.id === id)).length + ' mới)' : '');
    const line = (x) => '[' + SEV[x.sev].label + (news && news.has(x.id) ? ', mới' : '') + '] ' + x.title + (x.detail ? ' — ' + x.detail : '');
    const shown = list.slice(0, o.maxItems);
    const text = shown.map(line).join('\n') + (list.length > shown.length ? '\n… và ' + (list.length - shown.length) + ' việc khác.' : '') + '\n\nMở WorkHub Finance > Insight > Việc cần làm để xem chi tiết. Đây là tín hiệu tự động theo quy tắc đã đặt, không phải khuyến nghị đầu tư.';
    const color = { 1: '#C23B3B', 2: '#B7791F', 3: '#3a6ea5' };
    const html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;margin:auto;color:#1c1c1e"><h2 style="margin:0 0 6px">' + esc(o.title) + '</h2><p style="margin:0 0 12px;color:#4a4a4f">' + esc(S.headline) + '.</p>' +
      shown.map((x) => '<div style="border:1px solid #e3e3e6;border-left:4px solid ' + color[x.sev] + ';border-radius:8px;padding:8px 12px;margin:0 0 8px"><b style="color:' + color[x.sev] + '">' + esc(SEV[x.sev].label) + (news && news.has(x.id) ? ' · mới' : '') + '</b> · ' + esc((KINDS[x.kind] || {}).label || x.kind) + '<div style="margin-top:2px">' + esc(x.title) + '</div>' + (x.detail ? '<div style="color:#4a4a4f;font-size:13px;margin-top:2px">' + esc(x.detail) + '</div>' : '') + '</div>').join('') +
      (list.length > shown.length ? '<p>… và ' + (list.length - shown.length) + ' việc khác.</p>' : '') + '<p style="color:#6b6b70;font-size:12px;margin-top:14px">Mở WorkHub Finance &gt; Insight &gt; Việc cần làm để xem chi tiết. Đây là tín hiệu tự động theo quy tắc đã đặt, không phải khuyến nghị đầu tư.</p></div>';
    return { subject, text, html, count: list.length };
  }

  return { VERSION, SEV, KINDS, build, summarize, fresh, digest, thesisItems, eventItems, insiderItems, limitItems, approvalItems, cashItems, corporateItems, healthItems, systemItems };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ActionInbox;
