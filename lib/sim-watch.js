// Logic thuần: THEO DÕI NHẬT KÝ MÔ PHỎNG phía máy chủ (Market Simulation đợt 4), dùng chung cho Edge Function sim-watch (bản sao nguyên văn) và trang.
//   * parseDchart: chuỗi VN-Index ngày từ VNDirect dchart -> { dates, index } đúng khuôn SimScore.scoreRun cần.
//   * digest: tóm tắt trạng thái một lần chạy (chấm điểm từng mốc + cây sống) để cất vào cột finance_sim_runs.watch; giữ lại danh sách mốc đã báo và gợi ý AI cũ.
//   * newlyDue: mốc đã tới mà chưa báo (nhắc khi tới mốc).
//   * pendingEvents: sự kiện của bối cảnh lúc chạy còn chưa rõ (người dùng chưa đánh dấu, còn trong cửa sổ theo dõi) -> nhờ AI đọc tin xem đã xảy ra chưa.
//   * applyChecks / freshHappened: ghi kết quả AI thành GỢI Ý (hints) -- AI không bao giờ tự sửa marks của người dùng; người dùng bấm xác nhận trên trang.
//   * buildEmail: email nhắc gọn cho chủ lần chạy.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global SimWatch) và module.exports cho Vitest. Cần SimScore (lib/sim-score.js) nạp trước khi gọi digest.
const SimWatch = (function () {
  const VERSION = 1;
  const STATUSES = ['happened', 'not_happened', 'unclear'];
  const MAX_EVENTS = 10;                      // tối đa số sự kiện gửi AI mỗi lượt
  const RECHECK_MS = 20 * 3600000;            // một sự kiện chỉ hỏi lại AI sau ~1 ngày
  const WINDOW_GRACE = 5;                     // còn theo dõi thêm 5 phiên sau cửa sổ của sự kiện
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const str = (v, n) => String(v === null || v === undefined ? '' : v).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const keyOf = (title) => str(title, 110).toLowerCase();
  const scoreLib = () => (typeof SimScore !== 'undefined' ? SimScore : (typeof globalThis !== 'undefined' ? globalThis.SimScore : null));

  // dchart: { s: 'ok', t: [giây UTC], c: [giá đóng cửa] } -> ngày theo giờ Việt Nam
  function parseDchart(raw) {
    const out = { dates: [], index: [] };
    if (!raw || raw.s !== 'ok' || !Array.isArray(raw.t) || !Array.isArray(raw.c)) return out;
    let last = '';
    for (let i = 0; i < raw.t.length; i++) {
      const c = Number(raw.c[i]), t = Number(raw.t[i]);
      if (!(c > 0) || !isFinite(t)) continue;
      const d = new Date(t * 1000 + 7 * 3600000).toISOString().slice(0, 10);
      if (d <= last) continue;
      out.dates.push(d); out.index.push(c); last = d;
    }
    return out;
  }

  // Sự kiện đánh dấu đầu tiên có cây riêng -> cây sống theo sự kiện (giống trang)
  function markFor(snap, marks) {
    const m = marks || {}, id = Object.keys(m).find((k) => ((snap && snap.eventTrees) || []).some((t) => t.id === k));
    return id ? { eventId: id, happened: m[id] } : null;
  }

  function digest(snap, marks, score, prev, nowIso) {
    const p = prev && typeof prev === 'object' ? prev : {}, sc = score || { horizons: [] }, S = scoreLib();
    const live = S ? S.liveTree(snap, sc.prefix, markFor(snap, marks)) : null;
    const r = (v, k) => (isNum(v) ? Math.round(v * k) / k : null);
    return {
      v: VERSION, at: nowIso || new Date().toISOString(), origin: sc.origin || null, prefix: sc.prefix || '', elapsed: isNum(sc.elapsed) ? sc.elapsed : null,
      horizons: (sc.horizons || []).map((h) => (h.due
        ? { h: h.h, due: true, date: h.date, ret: r(h.ret, 1e6), branch: h.branch, in50: !!h.in50, in90: !!h.in90, pit: r(h.pit, 1e4), crps: r(h.crps, 1e6) }
        : { h: h.h, due: false, sessionsLeft: h.sessionsLeft })),
      live: live ? { root: live.root, path: live.path, depth: live.depth, done: live.done, p: live.current ? live.current.p : null, next: live.next.map((n) => ({ id: n.id, cond: n.cond })) } : null,
      notified: Array.isArray(p.notified) ? p.notified.filter(isNum) : [],
      hints: p.hints && typeof p.hints === 'object' ? p.hints : {},
    };
  }

  function newlyDue(watch) {
    const w = watch || {}, done = new Set(w.notified || []);
    return (w.horizons || []).filter((h) => h.due && !done.has(h.h));
  }

  // Sự kiện cần hỏi AI: người dùng chưa đánh dấu, còn trong cửa sổ theo dõi (số phiên đã qua <= cửa sổ + 5), chưa có gợi ý "đã xảy ra"/"không xảy ra" và không vừa hỏi trong ~1 ngày.
  function pendingEvents(snap, marks, watch, nowMs) {
    const m = marks || {}, w = watch || {}, hints = w.hints || {}, el = isNum(w.elapsed) ? w.elapsed : 0, now = isNum(nowMs) ? nowMs : Date.now();
    return ((snap && snap.events) || []).filter((e) => {
      if (!e || !e.id || !e.title || m[e.id] === true || m[e.id] === false) return false;
      if (isNum(e.win) && el > e.win + WINDOW_GRACE) return false;
      const h = hints[e.id];
      if (h && (h.status === 'happened' || h.status === 'not_happened')) return false;
      return !(h && h.at && now - Date.parse(h.at) < RECHECK_MS);
    }).map((e) => ({ id: e.id, key: keyOf(e.title), title: str(e.title, 110), signposts: (e.signposts || []).slice(0, 3).map((x) => str(x, 140)).filter(Boolean), since: snap.asOf }));
  }

  // Gộp sự kiện trùng tiêu đề giữa nhiều lần chạy (một câu hỏi cho AI), giữ ngày chạy sớm nhất; tối đa MAX_EVENTS
  function mergeEvents(list) {
    const by = {};
    (list || []).forEach((e) => {
      const k = e.key || keyOf(e.title);
      if (!by[k]) by[k] = { key: k, title: e.title, signposts: e.signposts.slice(), since: e.since };
      else { e.signposts.forEach((s) => { if (by[k].signposts.length < 3 && by[k].signposts.indexOf(s) === -1) by[k].signposts.push(s); }); if (e.since < by[k].since) by[k].since = e.since; }
    });
    return Object.values(by).sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0)).slice(0, MAX_EVENTS).map((e, i) => Object.assign({ id: 'e' + (i + 1) }, e));
  }

  // checks: [{ id (theo mergeEvents), status, reason, refs:[{title, link, sourceName}] }] -> gợi ý cho từng sự kiện của lần chạy (theo tiêu đề)
  function applyChecks(snap, watch, asked, checks, nowIso, model) {
    const w = Object.assign({}, watch || {}), hints = Object.assign({}, w.hints || {}), byId = {};
    (asked || []).forEach((a) => { byId[a.id] = a; });
    const byKey = {};
    (checks || []).forEach((c) => { const a = c && byId[c.id]; if (a && STATUSES.indexOf(c.status) !== -1) byKey[a.key] = c; });
    ((snap && snap.events) || []).forEach((e) => {
      const c = e && byKey[keyOf(e.title)];
      if (!c) return;
      hints[e.id] = {
        status: c.status, reason: str(c.reason, 300), at: nowIso || new Date().toISOString(), model: str(model, 60) || null,
        refs: (Array.isArray(c.refs) ? c.refs : []).filter((x) => x && /^https:\/\//i.test(String(x.link))).slice(0, 3).map((x) => ({ title: str(x.title, 160), link: String(x.link).slice(0, 400), sourceName: str(x.sourceName, 40) })),
      };
    });
    w.hints = hints;
    return w;
  }

  // Sự kiện vừa được AI gợi ý là đã xảy ra / không xảy ra (trước đó chưa) -- để đưa vào email
  function freshHappened(prevHints, hints) {
    const p = prevHints || {};
    return Object.keys(hints || {}).filter((k) => (hints[k].status === 'happened' || hints[k].status === 'not_happened') && !(p[k] && p[k].status === hints[k].status));
  }

  // Gửi email lỗi: trả gợi ý vừa mới về trạng thái cũ để lượt sau còn coi là mới (hỏi lại AI và báo lại)
  function revertFresh(prevHints, watch) {
    const p = prevHints || {}, w = Object.assign({}, watch || {}), h = Object.assign({}, w.hints || {});
    freshHappened(p, h).forEach((k) => { if (p[k]) h[k] = p[k]; else delete h[k]; });
    w.hints = h;
    return w;
  }

  const pct = (v) => (isNum(v) ? (v >= 0 ? '+' : '') + (v * 100).toFixed(1).replace('.', ',') + '%' : '—');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const HNAME = { 5: '1 tuần', 21: '1 tháng', 63: '3 tháng' };
  const BR = ['giảm', 'đi ngang', 'tăng'];
  // items: [{ label, asOf, due: [mốc từ newlyDue], events: [{ title, status, refs }] }]
  function buildEmail(items) {
    const list = (items || []).filter((x) => (x.due && x.due.length) || (x.events && x.events.length));
    const nDue = list.reduce((s, x) => s + (x.due || []).length, 0), nEv = list.reduce((s, x) => s + (x.events || []).length, 0);
    const subject = 'Nhật ký mô phỏng: ' + [nDue ? nDue + ' mốc đã tới' : '', nEv ? nEv + ' sự kiện có tin mới' : ''].filter(Boolean).join(', ');
    const lines = [], html = [];
    list.forEach((x) => {
      const name = (x.label || 'Lần chạy') + ' (dữ liệu ngày ' + x.asOf + ')';
      lines.push(name); html.push('<h3 style="margin:16px 0 6px;font-size:15px">' + esc(name) + '</h3><ul style="margin:0;padding-left:18px">');
      (x.due || []).forEach((h) => {
        const t = 'Mốc ' + (HNAME[h.h] || h.h + ' phiên') + ' (' + h.date + '): VN-Index ' + pct(h.ret) + ', nhánh ' + (BR[h.branch] || '?') + ', ' + (h.in90 ? 'nằm trong' : 'NGOÀI') + ' khoảng 90% đã dự báo';
        lines.push('  - ' + t); html.push('<li>' + esc(t) + '</li>');
      });
      (x.events || []).forEach((e) => {
        const t = 'AI đọc tin: "' + e.title + '" ' + (e.status === 'happened' ? 'có vẻ ĐÃ xảy ra' : 'có vẻ KHÔNG xảy ra') + ' (cần bạn xác nhận)';
        lines.push('  - ' + t); html.push('<li>' + esc(t) + ((e.refs || []).length ? '<br><span style="color:#5B6773">' + e.refs.map((r) => '<a href="' + esc(r.link) + '">' + esc(r.title) + '</a>').join(' · ') + '</span>' : '') + '</li>');
      });
      html.push('</ul>');
    });
    const foot = 'Mở WorkHub Fin > Market Simulation > Nhật ký để xem chấm điểm, cây sống và xác nhận sự kiện. Đây là email tự động; tắt trong phần cài đặt cảnh báo.';
    return {
      subject, text: lines.join('\n') + '\n\n' + foot,
      html: '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1F2933">' + html.join('') + '<p style="margin-top:18px;color:#5B6773;font-size:12px">' + esc(foot) + '</p></div>',
    };
  }

  // Gợi ý AI cho trang: chỉ những sự kiện người dùng chưa đánh dấu
  function hintsToShow(snap, marks, watch) {
    const m = marks || {}, h = (watch && watch.hints) || {};
    return ((snap && snap.events) || []).filter((e) => h[e.id] && m[e.id] !== true && m[e.id] !== false && h[e.id].status !== 'unclear').map((e) => Object.assign({ id: e.id, title: e.title }, h[e.id]));
  }

  return { VERSION, STATUSES, MAX_EVENTS, RECHECK_MS, parseDchart, markFor, digest, newlyDue, pendingEvents, mergeEvents, applyChecks, freshHappened, revertFresh, buildEmail, hintsToShow, keyOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SimWatch;
