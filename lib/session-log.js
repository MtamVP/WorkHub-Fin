// Logic thuần: NHẬT KÝ PHIÊN cuối ngày. Khi Danh Mục đang mở và sàn đã đóng cửa với giá trực tiếp của hôm nay, app tóm tắt phiên thành một bản ghi nhỏ: lãi/lỗ ngày, % so với VN-Index, mã tăng/giảm mạnh nhất,
// mã đóng góp lãi/lỗ nhiều nhất, cảnh báo đã báo, đường lãi/lỗ trong ngày (cao/thấp/cuối). Lưu TRONG MÁY (không ghi lên Supabase); sau vài tuần có chuỗi phiên để xem hiệu quả từng phiên so với chỉ số.
// Phần trăm của danh mục ở đây tính trên GIÁ TRỊ CỔ PHIẾU (theo giá tham chiếu hôm qua), cùng cách với dòng trạng thái giá trực tiếp; navPct tính trên NAV (có tiền mặt) để tham khảo.
// KHÔNG đụng DOM/mạng/tệp. Nạp bằng thẻ <script> thường (global SessionLog) và module.exports cho Vitest.
const SessionLog = (function () {
  const KEEP = 400;                       // số phiên giữ lại (khoảng 1,6 năm)
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const iso = (v) => String(v || '').slice(0, 10);
  const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);

  // Ghi hay không: 'final' (sàn đã đóng và có giá hôm nay), 'partial' (đang trong phiên: giữ bản tạm để lỡ tắt app), hoặc null (không có giá hôm nay / trước giờ mở cửa).
  function mode(session, hasTodayQuotes) {
    if (!hasTodayQuotes) return null;
    if (session === 'closed') return 'final';
    if (session === 'open' || session === 'break') return 'partial';
    return null;
  }

  // input: { date, mode, holdings: [{ symbol, live, dayPct, dayPnl, marketValue }], totals: { dayPnl, dayPct, liveCount, total }, nav (NAV theo giá trực tiếp, hoặc null),
  //          index: { value, pct } | null, alerts: [{ time, title, level }], series: [[phút, lãi lỗ, %, giá trị]], source }
  function build(input) {
    const i = input || {}, t = i.totals;
    if (!t || !(t.liveCount > 0) || num(t.dayPnl) === null) return null;
    const rows = (i.holdings || []).filter((h) => h && h.live && num(h.dayPct) !== null);
    const byPct = rows.slice().sort((a, b) => b.dayPct - a.dayPct), byPnl = rows.filter((h) => num(h.dayPnl) !== null).sort((a, b) => b.dayPnl - a.dayPnl);
    const pick = (list, f) => list.slice(0, 3).map(f);
    const dayPct = num(t.dayPct), idx = i.index && num(i.index.pct) !== null ? i.index : null;
    const nav = num(i.nav), prevNav = nav !== null ? nav - t.dayPnl : null;
    const pts = i.series || [];
    let hi = null, lo = null;
    pts.forEach((p) => { if (hi === null || p[1] > hi) hi = p[1]; if (lo === null || p[1] < lo) lo = p[1]; });
    return {
      v: 1, date: iso(i.date), final: i.mode === 'final', savedAt: i.savedAt || new Date().toISOString(),
      dayPnl: Math.round(t.dayPnl), dayPct: r2(dayPct), navPct: prevNav > 0 ? r2(t.dayPnl / prevNav * 100) : null, nav: nav === null ? null : Math.round(nav),
      indexValue: idx ? r2(idx.value) : null, indexPct: idx ? r2(idx.pct) : null, rel: idx && dayPct !== null ? r2(dayPct - idx.pct) : null,
      n: t.total, liveCount: t.liveCount, up: rows.filter((h) => h.dayPct > 0).length, down: rows.filter((h) => h.dayPct < 0).length,
      best: pick(byPct, (h) => ({ s: h.symbol, pct: r2(h.dayPct) })), worst: pick(byPct.slice().reverse(), (h) => ({ s: h.symbol, pct: r2(h.dayPct) })),
      gain: pick(byPnl.filter((h) => h.dayPnl > 0), (h) => ({ s: h.symbol, pnl: Math.round(h.dayPnl) })), loss: pick(byPnl.filter((h) => h.dayPnl < 0).reverse(), (h) => ({ s: h.symbol, pnl: Math.round(h.dayPnl) })),
      alerts: (i.alerts || []).slice(-10).map((a) => ({ t: a.time || '', title: a.title || '', level: a.level || 'good' })),
      series: pts.length ? { n: pts.length, hi: hi, lo: lo, last: pts[pts.length - 1][1] } : null, src: i.source || null,
    };
  }

  // Gộp bản ghi vào kho { 'YYYY-MM-DD': bản ghi }: bản cuối phiên thay bản tạm và thay bản cuối phiên cũ (giá đã đóng, cảnh báo có thể nhiều hơn); bản tạm không ghi đè bản cuối phiên.
  function merge(store, rec) {
    const s = Object.assign({}, store || {});
    if (!rec || !rec.date) return s;
    const cur = s[rec.date];
    if (cur && cur.final && !rec.final) return s;
    s[rec.date] = rec;
    const keep = Object.keys(s).sort().slice(-KEEP), out = {};
    keep.forEach((k) => { out[k] = s[k]; });
    return out;
  }

  const sorted = (store) => Object.keys(store || {}).sort().map((k) => store[k]);
  // Phiên gần nhất TRƯỚC ngày today (cho thẻ "Hôm nay"), ưu tiên bản cuối phiên
  function lastBefore(store, today) {
    const list = sorted(store).filter((r) => r.date < iso(today));
    return list.length ? list[list.length - 1] : null;
  }

  // Thống kê chuỗi phiên (chỉ tính bản cuối phiên): số phiên, số phiên hơn chỉ số, trung bình, phiên tốt/xấu nhất, lãi lỗ cộng dồn %, sụt giảm tối đa của chuỗi ghép lãi.
  function stats(store) {
    const days = sorted(store).filter((r) => r.final && num(r.dayPct) !== null);
    const withIdx = days.filter((r) => num(r.rel) !== null);
    if (!days.length) return { n: 0 };
    let cum = 1, peak = 1, mdd = 0, cumIdx = 1;
    days.forEach((r) => { cum *= 1 + r.dayPct / 100; if (cum > peak) peak = cum; mdd = Math.min(mdd, cum / peak - 1); if (num(r.indexPct) !== null) cumIdx *= 1 + r.indexPct / 100; });
    const best = days.reduce((a, b) => (b.dayPct > a.dayPct ? b : a)), worst = days.reduce((a, b) => (b.dayPct < a.dayPct ? b : a));
    const avg = (arr, f) => (arr.length ? arr.reduce((s, r) => s + f(r), 0) / arr.length : null);
    return {
      n: days.length, from: days[0].date, to: days[days.length - 1].date, avgDay: r2(avg(days, (r) => r.dayPct)), winDays: days.filter((r) => r.dayPct > 0).length,
      nIdx: withIdx.length, beat: withIdx.filter((r) => r.rel > 0).length, avgRel: withIdx.length ? r2(avg(withIdx, (r) => r.rel)) : null,
      best: { date: best.date, pct: best.dayPct }, worst: { date: worst.date, pct: worst.dayPct },
      cumPct: r2((cum - 1) * 100), cumIndexPct: withIdx.length === days.length ? r2((cumIdx - 1) * 100) : null, maxDrawdownPct: r2(mdd * 100),
    };
  }

  const HEADER = ['Ngày', 'Cuối phiên', 'Lãi/lỗ ngày (đ)', '% ngày (cổ phiếu)', '% ngày (NAV)', 'VN-Index', '% VN-Index', 'Hơn/kém chỉ số (điểm %)', 'Số mã', 'Mã tăng', 'Mã giảm', 'Mạnh nhất', 'Yếu nhất', 'Số cảnh báo'];
  function csvRows(store) {
    const rows = [HEADER];
    sorted(store).reverse().forEach((r) => rows.push([r.date, r.final ? 'có' : 'tạm', r.dayPnl, r.dayPct, r.navPct, r.indexValue, r.indexPct, r.rel, r.n, r.up, r.down,
      (r.best || []).map((x) => x.s + ' ' + x.pct + '%').join('; '), (r.worst || []).map((x) => x.s + ' ' + x.pct + '%').join('; '), (r.alerts || []).length]));
    return rows;
  }

  return { KEEP, mode, build, merge, lastBefore, stats, csvRows, HEADER };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SessionLog;
