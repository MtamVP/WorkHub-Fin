// Logic thuần: NHẬT KÝ MÔ PHỎNG cho Market Simulation -- lưu từng lần mô phỏng, tự chấm điểm khi các mốc đã tới, và "cây sống".
//   * snapshot: rút gọn kết quả MarketSim.simulate thành ảnh chụp nhỏ (~30 KB) để lưu bảng finance_sim_runs: lưới phân vị lợi suất VN-Index ở từng mốc
//     (có bối cảnh và chỉ lịch sử nếu có), lưới của danh mục giữ nguyên, xác suất 3 nhánh mỗi giai đoạn, cây rút gọn (cả cây theo sự kiện), cách xử lý đã chọn.
//   * realized / scoreRun: so ảnh chụp với VN-Index (và giá các mã) THẬT sau ngày chạy: mốc nào đã đủ số phiên thì chấm PIT, có nằm trong khoảng 50% / 90% không,
//     CRPS xấp xỉ từ lưới phân vị, điểm Brier của xác suất nhánh so với tần suất lịch sử trước ngày chạy (chỉ dùng dữ liệu tới ngày chạy, không nhìn trước).
//   * aggregate: gộp nhiều lần chạy theo mốc: độ phủ thật so với danh nghĩa, BSS, và CRPS có bối cảnh so với chỉ lịch sử trên CÙNG các lần chạy có bối cảnh
//     (trả lời câu hỏi "bối cảnh AI có làm dự báo tốt hơn không").
//   * liveTree: cây sống của một lần chạy đã lưu: nhánh thực tế đã đi (theo mốc đã qua) + sự kiện đã đánh dấu xảy ra hay chưa -> nút hiện tại và xác suất CÓ ĐIỀU KIỆN
//     của các nhánh phía trước (đọc từ cây đã lưu, không mô phỏng lại).
//   * validateRun: kiểm tra dữ liệu trước khi ghi DB.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global SimScore) và module.exports cho Vitest.
const SimScore = (function () {
  const VERSION = 1;
  const SUBJECTS = ['mine', 'group', 'index', 'custom', 'outlook'];
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const r6 = (v) => (isNum(v) ? Math.round(v * 1e6) / 1e6 : null);
  const r4 = (v) => (isNum(v) ? Math.round(v * 1e4) / 1e4 : null);
  const str = (v, n) => String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const branchOf = (ret, band) => (ret < -band ? 0 : (ret > band ? 2 : 1));

  // ---------- ảnh chụp ----------
  const slimNode = (n) => ({ id: n.id, p: r4(n.prob), pp: r4(n.parentProb), n: n.n, im: n.index ? r4(n.index.median) : null, hm: n.policies && n.policies[0] ? r4(n.policies[0].median) : null, best: n.best ? n.best.ce : null });
  // res: kết quả simulate (có thể có bối cảnh); base: kết quả simulate VN-Index KHÔNG có sự kiện (cùng hạt giống, để so sánh), tuỳ chọn.
  // meta: { asOf (YYYY-MM-DD ngày dữ liệu cuối), indexLevel, subject, chosen (id chính sách), events (thẻ đang bật, để ghi dấu hiệu theo dõi) }
  function snapshot(res, base, meta) {
    const m = meta || {}, g = res.grid || {};
    const pick = (id) => res.policies.find((p) => p.id === id) || res.policies[0];
    const chosen = pick(m.chosen), hkL = res.byHorizon.length - 1;
    const evCards = Array.isArray(m.events) ? m.events : [];
    const sameH = base && base.grid && base.horizons && base.horizons.join(',') === res.horizons.join(',');
    return {
      v: VERSION, asOf: String(m.asOf || '').slice(0, 10), indexLevel: r6(m.indexLevel), subject: SUBJECTS.indexOf(m.subject) !== -1 ? m.subject : 'custom',
      paths: res.paths, model: res.model, seed: res.seed, drift: res.drift, horizons: res.horizons.slice(), bands: res.bands.slice(), nav0: Math.round(res.nav0),
      levels: (g.levels || []).slice(), grid: { index: (g.index || []).map((a) => a.map(r6)), hold: (g.hold || []).map((a) => a.map(r6)), base: sameH ? base.grid.index.map((a) => a.map(r6)) : null },
      branchProb: (res.branchProb || []).map((a) => a.map(r4)), branchProbBase: sameH && base.branchProb ? base.branchProb.map((a) => a.map(r4)) : null,
      positions: (res.positions || []).filter((p) => p.kind !== 'flat').map((p) => ({ symbol: p.symbol, qty: p.qty, price: p.price })),
      flat: (res.positions || []).filter((p) => p.kind === 'flat').reduce((s, p) => s + p.qty * p.price, 0),
      cash: isNum(m.cash) ? Math.round(m.cash) : null, debt: isNum(m.debt) ? Math.round(m.debt) : null,
      policies: res.policies.map((p) => ({ id: p.id, label: p.label })), chosen: chosen.id,
      outcome: res.byHorizon.map((hh) => { const r = hh.policies.find((x) => x.id === chosen.id) || hh.policies[0], h0 = hh.policies[0]; return { h: hh.h, mean: r4(r.mean), median: r4(r.median), q05: r4(r.q05), q95: r4(r.q95), pLoss10: r4(r.pLoss10), ce: r4(r.ce), holdMedian: r4(h0.median), bestCe: hh.best ? hh.best.ce : null }; }),
      bestFinal: res.byHorizon[hkL].best ? res.byHorizon[hkL].best.ce : null,
      tree: (res.tree || []).map(slimNode),
      eventTrees: (res.eventTrees || []).map((t) => ({ id: t.id, title: str(t.title, 110), p: r4(t.p), sign: t.sign, nodes: t.nodes.map(slimNode) })),
      events: (res.events || []).map((e) => { const c = evCards.find((x) => x.id === e.id) || {}; return { id: e.id, title: str(e.title, 110), p: r4(e.p), win: e.win, sign: e.sign, jM: r4(e.jM), jS: r4(e.jS), sectors: (e.sectors || []).slice(0, 6), signposts: (c.signposts || []).slice(0, 3).map((x) => str(x, 140)), source: c.source === 'ai' ? 'ai' : 'user' }; }),
    };
  }

  // ---------- thực tế sau ngày chạy ----------
  // Vị trí ngày chạy trong chuỗi ngày (ngày cuối <= asOf)
  function originIndex(dates, asOf) {
    let i0 = -1; for (let i = 0; i < dates.length; i++) { if (String(dates[i]).slice(0, 10) <= asOf) i0 = i; else break; }
    return i0;
  }
  // Giá trị nội suy của PIT (xác suất dự báo dưới giá trị thực) từ lưới phân vị: ngoài lưới thì gán một nửa phần đuôi còn lại
  function pitOf(levels, grid, y) {
    const n = grid.length; if (!n) return null;
    if (y <= grid[0]) return levels[0] / 2;
    if (y >= grid[n - 1]) return (1 + levels[n - 1]) / 2;
    for (let i = 1; i < n; i++) if (y <= grid[i]) { const w = grid[i] > grid[i - 1] ? (y - grid[i - 1]) / (grid[i] - grid[i - 1]) : 0.5; return levels[i - 1] + w * (levels[i] - levels[i - 1]); }
    return levels[n - 1];
  }
  // CRPS xấp xỉ = 2 x trung bình hàm tổn thất phân vị trên lưới (mỗi mức nặng như nhau; bỏ phần đuôi ngoài 2,5%..97,5% nên hơi thấp hơn CRPS đúng, như nhau cho mọi dự báo cùng lưới)
  function crpsOf(levels, grid, y) {
    let s = 0; for (let i = 0; i < grid.length; i++) { const u = y - grid[i]; s += u >= 0 ? levels[i] * u : (levels[i] - 1) * u; }
    return 2 * s / Math.max(1, grid.length);
  }
  const at = (levels, grid, lv) => { const i = levels.findIndex((x) => Math.abs(x - lv) < 1e-9); return i === -1 ? null : grid[i]; };
  // Tần suất lịch sử của 3 nhánh cho cửa sổ len phiên, chỉ dùng chuỗi tới ngày chạy (i0), tối đa 1750 phiên gần nhất
  function climatology(index, i0, len, band) {
    const c = [0, 0, 0]; let n = 0;
    for (let i = Math.max(0, i0 - 1750); i + len <= i0; i++) { if (!(index[i] > 0 && index[i + len] > 0)) continue; c[branchOf(Math.log(index[i + len] / index[i]), band)]++; n++; }
    return n ? c.map((v) => v / n) : null;
  }
  const brier = (p, k) => { let s = 0; for (let c = 0; c < 3; c++) { const o = c === k ? 1 : 0; s += (p[c] - o) * (p[c] - o); } return s; };

  // series: { dates, index, stocks?: { MÃ: closes căn theo dates (đã điều chỉnh cổ tức / chia tách) } } -- như đầu vào của MarketSim.prepare.
  // Trả { origin, prefix (chuỗi nhánh thực tế đã đi), horizons: [{ h, due, date, ret, branch, pit, in50, in90, crps, base: {...}, brier, brierBase, brierClim, hold }] }
  function scoreRun(snap, series) {
    const s = snap || {}, d = (series && series.dates) || [], ix = (series && series.index) || [];
    const i0 = originIndex(d, s.asOf), L = s.levels || [];
    const out = { origin: i0 >= 0 ? d[i0] : null, prefix: '', horizons: [] };
    if (i0 < 0 || !(ix[i0] > 0)) return out;
    let prefix = '', broken = false;
    (s.horizons || []).forEach((h, hk) => {
      const iT = i0 + h, due = iT < ix.length && ix[iT] > 0, row = { h: h, due: due, date: due ? d[iT] : null, sessionsLeft: due ? 0 : Math.max(0, iT - (ix.length - 1)) };
      if (due) {
        const y = ix[iT] / ix[i0] - 1, prevT = hk === 0 ? i0 : i0 + s.horizons[hk - 1];
        const br = branchOf(Math.log(ix[iT] / ix[prevT]), s.bands[hk]);
        const gi = (s.grid.index || [])[hk] || [];
        Object.assign(row, { ret: r6(y), branch: br, pit: r4(pitOf(L, gi, y)), in50: y >= at(L, gi, 0.25) && y <= at(L, gi, 0.75), in90: y >= at(L, gi, 0.05) && y <= at(L, gi, 0.95), crps: r6(crpsOf(L, gi, y)) });
        const gb = s.grid.base ? s.grid.base[hk] : null;
        if (gb) row.base = { pit: r4(pitOf(L, gb, y)), in50: y >= at(L, gb, 0.25) && y <= at(L, gb, 0.75), in90: y >= at(L, gb, 0.05) && y <= at(L, gb, 0.95), crps: r6(crpsOf(L, gb, y)) };
        const bp = (s.branchProb || [])[hk];
        if (bp) row.brier = r4(brier(bp, br));
        if (s.branchProbBase && s.branchProbBase[hk]) row.brierBase = r4(brier(s.branchProbBase[hk], br));
        const clim = climatology(ix, i0, h - (hk === 0 ? 0 : s.horizons[hk - 1]), s.bands[hk]);
        if (clim) row.brierClim = r4(brier(clim, br));
        // danh mục giữ nguyên (mua và giữ đúng các mã lúc chạy): giá trị thật so với lưới dự báo của "Giữ nguyên"
        const hold = holdReturn(s, series, i0, iT);
        if (hold !== null && s.grid.hold && s.grid.hold[hk]) { const gh = s.grid.hold[hk]; row.hold = { ret: r6(hold), pit: r4(pitOf(L, gh, hold)), in90: hold >= at(L, gh, 0.05) && hold <= at(L, gh, 0.95) }; }
        if (!broken) prefix += br;
      } else broken = true;
      out.horizons.push(row);
    });
    out.prefix = prefix;
    return out;
  }
  // Lợi nhuận thật của danh mục lúc chạy nếu cứ giữ nguyên (không phí): tài sản theo chỉ số đi theo VN-Index, mã thiếu giá thì giữ nguyên giá trị.
  function holdReturn(s, series, i0, iT) {
    if (!(s.nav0 > 0) || !Array.isArray(s.positions)) return null;
    const ix = series.index, st = series.stocks || {};
    let v = (s.cash || 0) - (s.debt || 0) + (s.flat || 0), missing = 0, mv = 0;
    s.positions.forEach((p) => {
      const val = p.qty * p.price; mv += val;
      if (p.symbol === '__INDEX__') { v += val * ix[iT] / ix[i0]; return; }
      const c = st[p.symbol] ? st[p.symbol].closes || st[p.symbol] : null;
      const a = c && c.length ? c[i0] : null, b = c && c.length ? c[iT] : null;
      if (a > 0 && b > 0) v += val * b / a; else { v += val; missing += val; }
    });
    if (s.cash === null || s.cash === undefined) v += s.nav0 - mv - (s.flat || 0);          // ảnh chụp không có tiền mặt: phần còn lại của NAV coi như tiền
    if (mv > 0 && missing / mv > 0.25) return null;                                       // thiếu giá quá nhiều mã: không chấm
    return v / s.nav0 - 1;
  }

  // ---------- gộp nhiều lần chạy ----------
  // items: [{ snap, score }]. Mỗi mốc: số lần đã tới, độ phủ 50/90%, PIT 10 ô, CRPS TB, Brier / BSS so tần suất lịch sử,
  // và trên các lần chạy CÓ bối cảnh: CRPS có bối cảnh so với chỉ lịch sử (âm = bối cảnh tốt hơn).
  function aggregate(items, horizons) {
    const hz = horizons || [5, 21, 63];
    return hz.map((h) => {
      const rows = []; (items || []).forEach((it) => { const r = it && it.score ? it.score.horizons.find((x) => x.h === h && x.due) : null; if (r) rows.push({ r: r, snap: it.snap }); });
      const n = rows.length, mean = (f) => { const a = rows.map(f).filter(isNum); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
      const pit = new Array(10).fill(0); rows.forEach((x) => { if (isNum(x.r.pit)) pit[Math.min(9, Math.floor(x.r.pit * 10))]++; });
      const ctx = rows.filter((x) => x.r.base && x.snap && x.snap.events && x.snap.events.length);
      const cm = (f) => { const a = ctx.map(f).filter(isNum); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
      const b = mean((x) => x.r.brier), bc = mean((x) => (isNum(x.r.brier) ? x.r.brierClim : null));
      const holds = rows.filter((x) => x.r.hold);
      return {
        h: h, n: n, cover50: n ? rows.filter((x) => x.r.in50).length / n : null, cover90: n ? rows.filter((x) => x.r.in90).length / n : null, pit: pit.map((c) => (n ? c / n : 0)),
        crps: mean((x) => x.r.crps), brier: b, brierClim: bc, bss: isNum(b) && bc > 0 ? 1 - b / bc : null,
        ctx: { n: ctx.length, crps: cm((x) => x.r.crps), crpsBase: cm((x) => x.r.base.crps), brier: cm((x) => x.r.brier), brierBase: cm((x) => (isNum(x.r.brierBase) ? x.r.brierBase : null)), cover90: ctx.length ? ctx.filter((x) => x.r.in90).length / ctx.length : null, cover90Base: ctx.length ? ctx.filter((x) => x.r.base.in90).length / ctx.length : null },
        hold: { n: holds.length, cover90: holds.length ? holds.filter((x) => x.r.hold.in90).length / holds.length : null, pitMean: holds.length ? holds.reduce((s, x) => s + x.r.hold.pit, 0) / holds.length : null },
      };
    });
  }

  // ---------- cây sống ----------
  // prefix: nhánh thực tế đã đi (từ scoreRun); eventId + happened (true/false/null): sự kiện đã đánh dấu. Có đánh dấu thì đọc cây theo sự kiện, gốc Y/N.
  // Trả { root, nodes (cây đang dùng), path (id nút thực tế), current, next: con của nút hiện tại kèm xác suất có điều kiện, ahead: các đường tới mốc cuối kèm xác suất có điều kiện }
  function liveTree(snap, prefix, mark) {
    const s = snap || {}, mk = mark || {};
    let nodes = s.tree || [], root = '', title = null;
    if (mk.eventId && (mk.happened === true || mk.happened === false)) {
      const t = (s.eventTrees || []).find((x) => x.id === mk.eventId);
      if (t) { nodes = t.nodes; root = mk.happened ? 'Y' : 'N'; title = t.title; }
    }
    const byId = {}; nodes.forEach((n) => { byId[n.id] = n; });
    const pre = String(prefix || '').replace(/[^012]/g, '');
    // đi theo nhánh thực tế tới nút sâu nhất còn có trong cây (nút quá ít đường không được tách tiếp)
    let cur = root, depth = 0;
    for (let i = 0; i < pre.length; i++) { const id = root + pre.slice(0, i + 1); if (!byId[id]) break; cur = id; depth = i + 1; }
    const curNode = cur ? byId[cur] || null : null;
    const kids = (id) => [0, 1, 2].map((b) => byId[id + b]).filter(Boolean);
    const next = kids(cur).map((n) => ({ id: n.id, branch: n.branch, cond: n.pp, n: n.n, im: n.im, hm: n.hm, best: n.best }));
    const ahead = [];
    const walk = (id, p) => { const k = kids(id); if (!k.length) { if (id !== cur) ahead.push({ id: id, cond: p, n: byId[id].n, im: byId[id].im, hm: byId[id].hm, best: byId[id].best }); return; } k.forEach((n) => walk(n.id, p * n.pp)); };
    walk(cur, 1);
    ahead.sort((a, b) => b.cond - a.cond);
    return { root: root, eventTitle: title, path: pre.slice(0, depth), stalled: pre.length > depth, current: curNode, depth: depth, next: next, ahead: ahead.slice(0, 9), done: depth >= (s.horizons || []).length };
  }

  // ---------- kiểm tra trước khi ghi ----------
  function validateRun(input) {
    const i = input || {}, snap = i.snapshot;
    if (!snap || typeof snap !== 'object' || snap.v !== VERSION) return { ok: false, error: 'Ảnh chụp mô phỏng không hợp lệ' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snap.asOf || ''))) return { ok: false, error: 'Thiếu ngày dữ liệu của lần chạy' };
    if (!Array.isArray(snap.horizons) || !snap.horizons.length || !snap.grid || !Array.isArray(snap.grid.index) || snap.grid.index.length !== snap.horizons.length) return { ok: false, error: 'Ảnh chụp thiếu lưới dự báo' };
    let size = 0; try { size = JSON.stringify(snap).length; } catch (e) { return { ok: false, error: 'Ảnh chụp không đọc được' }; }
    if (size > 300000) return { ok: false, error: 'Ảnh chụp quá lớn (' + Math.round(size / 1000) + ' KB)' };
    const ids = (snap.policies || []).map((p) => p.id), chosen = ids.indexOf(i.chosen) !== -1 ? i.chosen : snap.chosen;
    return {
      ok: true, error: null,
      row: { as_of: snap.asOf, subject: SUBJECTS.indexOf(i.subject || snap.subject) !== -1 ? i.subject || snap.subject : 'custom', label: str(i.label, 120) || null, chosen_policy: str(chosen, 40) || null, note: str(i.note, 1000) || null, snapshot: Object.assign({}, snap, { chosen: chosen }) },
    };
  }
  // Đánh dấu sự kiện (cây sống): { eventId: true | false } ; giá trị khác bị bỏ
  function cleanMarks(m) {
    const out = {}; if (!m || typeof m !== 'object') return out;
    Object.keys(m).slice(0, 12).forEach((k) => { const id = str(k, 40); if (id && (m[k] === true || m[k] === false)) out[id] = m[k]; });
    return out;
  }

  return { VERSION, SUBJECTS, snapshot, originIndex, pitOf, crpsOf, climatology, scoreRun, holdReturn, aggregate, liveTree, validateRun, cleanMarks, branchOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SimScore;
