// Logic thuần: BẢN TÓM TẮT "HÔM NAY" đầu trang Danh Mục. Gom các phần đã có sẵn trong app thành một bản đọc nhanh buổi sáng: danh mục qua phiên trước, sự kiện doanh nghiệp sắp tới,
// mã Theo Dõi gần giá muốn mua, giới hạn đầu tư đang vượt, ngành mạnh/yếu 1 tháng, bộ lọc đã lưu có mã mới, cảnh báo phiên trước. Mỗi phần tự bỏ qua khi không có dữ liệu (không bịa số, không báo "ổn" khi chưa biết).
// KHÔNG đụng mạng/DOM: bên gọi (mastersheet/assets/today.js) nạp dữ liệu rồi truyền vào. Nạp bằng thẻ <script> thường (global TodayBrief) và module.exports cho Vitest.
// Kết quả: { headline, attention (số mục cần xem), sections: [{ id, title, items: [{ text, tone }] }] }. tone: 'up'/'down' (số tăng/giảm, chỉ để tô màu), 'info', và 'warn'/'bad'/'act' (cần xem: cảnh báo, vượt giới hạn, việc có thể hành động) được đếm vào "việc cần xem".
const TodayBrief = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const iso = (v) => String(v || '').slice(0, 10);
  const dm = (d) => { const p = iso(d).split('-'); return p.length === 3 ? p[2] + '/' + p[1] : ''; };
  const money = (n) => Math.round(Math.abs(n)).toLocaleString('vi-VN');
  const pct = (v, d) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(d === undefined ? 1 : d).replace('.', ',') + '%');
  const daysBetween = (a, b) => Math.round((Date.parse(iso(b) + 'T00:00:00Z') - Date.parse(iso(a) + 'T00:00:00Z')) / 86400000);
  const dayName = (d) => ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'][new Date(iso(d) + 'T00:00:00Z').getUTCDay()];

  // input.nav: [{ snapshot_date, nav }] tăng dần; input.kpi: { nav, unrealizedPnl }; input.holdingsCount
  function portfolio(input, today) {
    const k = input.kpi, items = [];
    if (!k || !(num(k.nav) > 0)) return null;
    const hist = (input.nav || []).filter((r) => iso(r.snapshot_date) < today && num(r.nav) > 0), prev = hist.length ? hist[hist.length - 1] : null;
    if (prev) {
      const d = num(k.nav) - num(prev.nav), p = d / num(prev.nav) * 100;
      items.push({ text: 'NAV ' + money(k.nav) + ' đ, ' + (d >= 0 ? 'tăng ' : 'giảm ') + money(d) + ' đ (' + pct(p, 2) + ') so với ngày ' + dm(prev.snapshot_date), tone: d > 0 ? 'up' : (d < 0 ? 'down' : 'info') });
    } else items.push({ text: 'NAV ' + money(k.nav) + ' đ (chưa có ngày trước để so sánh)', tone: 'info' });
    if (num(k.unrealizedPnl) !== null) items.push({ text: 'Lãi/lỗ chưa thực hiện ' + (k.unrealizedPnl >= 0 ? '+' : '−') + money(k.unrealizedPnl) + ' đ' + (input.holdingsCount ? ' · ' + input.holdingsCount + ' mã đang nắm' : ''), tone: k.unrealizedPnl >= 0 ? 'up' : 'down' });
    return { id: 'portfolio', title: 'Danh mục qua phiên trước', items: items };
  }

  // input.events: kết quả CorporateEvents.suggest().items (status pending | upcoming | info)
  function events(input, today) {
    const items = [];
    (input.events || []).forEach((p) => {
      if (p.status === 'pending') items.push({ text: p.symbol + ': ' + describe(p) + ' — đã tới hạn, CHƯA ghi vào sổ', tone: 'warn', sort: -1 });
      else if (p.status === 'upcoming' && p.due) {
        const n = daysBetween(today, p.due);
        if (n >= 0 && n <= 14) items.push({ text: p.symbol + ': ' + describe(p) + ' — ' + (n === 0 ? 'hôm nay' : 'còn ' + n + ' ngày (' + dm(p.due) + ')'), tone: 'info', sort: n });
      } else if (p.status === 'info' && p.deadline) {
        const n = daysBetween(today, p.deadline);
        if (n >= 0 && n <= 14) items.push({ text: p.symbol + ': quyền mua ' + (p.rightsShares || 0).toLocaleString('vi-VN') + ' cp giá ' + (p.issuePrice || 0).toLocaleString('vi-VN') + ' đ, hạn ' + dm(p.deadline) + ' (còn ' + n + ' ngày)', tone: 'warn', sort: n });
      }
    });
    if (!items.length) return null;
    items.sort((a, b) => a.sort - b.sort);
    return { id: 'events', title: 'Sự kiện doanh nghiệp', items: items.slice(0, 6).map((i) => ({ text: i.text, tone: i.tone })) };
  }
  function describe(p) {
    if (p.kind === 'cash_dividend') return 'cổ tức tiền ' + (p.dps || 0).toLocaleString('vi-VN') + ' đ/cp, thực nhận khoảng ' + money(p.net || 0) + ' đ';
    if (p.kind === 'stock_dividend' || p.kind === 'bonus') return 'cổ phiếu thưởng/cổ tức tỷ lệ 100:' + (p.ratioPct || 0) + ' (+' + (p.bonusShares || 0).toLocaleString('vi-VN') + ' cp)';
    return 'quyền mua';
  }

  // input.watch: kết quả getWatchlist ({ symbol, price, buyBelow, buyGapPct, held })
  function watch(input) {
    const rows = (input.watch || []).filter((w) => !w.held && num(w.buyBelow) > 0 && num(w.price) > 0).map((w) => ({ w: w, gap: (w.price - w.buyBelow) / w.buyBelow * 100 })).filter((x) => x.gap <= 5).sort((a, b) => a.gap - b.gap);
    if (!rows.length) return null;
    return { id: 'watch', title: 'Theo Dõi: gần giá muốn mua', items: rows.slice(0, 6).map((x) => ({ text: x.w.symbol + ': giá ' + money(x.w.price) + ' ' + (x.gap <= 0 ? '≤ mức muốn mua ' + money(x.w.buyBelow) + ' (đã tới giá mua)' : 'chỉ cao hơn mức muốn mua ' + money(x.w.buyBelow) + ' ' + pct(x.gap, 1).replace('+', '')), tone: x.gap <= 0 ? 'act' : 'info' })) };
  }

  // input.limits: { breaches: [{ text, label, symbol }] , warns: số } (từ LiveAlerts.evaluateLimits trên kết quả LimitsCalc.evaluate)
  function limits(input) {
    const L = input.limits;
    if (!L) return null;
    const items = (L.breaches || []).slice(0, 5).map((b) => ({ text: b.label + (b.symbol ? ' ' + b.symbol : '') + ': ' + b.text, tone: 'bad' }));
    if (L.warns > 0) items.push({ text: L.warns + ' mục gần chạm hạn mức (từ 90%)', tone: 'warn' });
    if (!items.length) return null;
    return { id: 'limits', title: 'Giới hạn đầu tư', items: items };
  }

  // input.sectors: SectorHeatmap.build(rows, 'chg1m').  Trả null khi chưa đủ số liệu kỳ này.
  function sectors(input) {
    const S = input.sectors;
    if (!S || S.empty) return null;
    const ok = (S.sectors || []).filter((s) => s.ok).slice().sort((a, b) => b.chg - a.chg);
    if (ok.length < 4) return null;
    const line = (list) => list.map((s) => s.name + ' ' + pct(s.chg * 100, 1)).join(', ');
    const items = [{ text: 'Mạnh nhất 1 tháng: ' + line(ok.slice(0, 3)), tone: 'up' }, { text: 'Yếu nhất 1 tháng: ' + line(ok.slice(-3).reverse()), tone: 'down' }];
    if (S.market && S.market.chg !== null && S.market.chg !== undefined) items.push({ text: 'Toàn thị trường: ' + pct(S.market.chg * 100, 1) + ' (bình quân theo vốn hoá)', tone: 'info' });
    return { id: 'sectors', title: 'Ngành', items: items };
  }

  // input.filterwatch: bản ghi của WorkHubFilterWatch.lastResult() { asOf, items: [{ name, comparable, entered: [mã], left: [mã] }] }
  function filters(input, today) {
    const r = input.filterwatch;
    if (!r || !r.asOf || daysBetween(r.asOf, today) > 4) return null;
    const items = [];
    (r.items || []).forEach((i) => {
      if (!i.comparable || !i.entered || !i.entered.length) return;
      items.push({ text: 'Bộ lọc “' + i.name + '”: ' + i.entered.slice(0, 5).join(', ') + (i.entered.length > 5 ? ' (+' + (i.entered.length - 5) + ' mã khác)' : '') + ' mới lọt vào (số liệu ' + dm(r.asOf) + ')', tone: 'act' });
    });
    if (!items.length) return null;
    return { id: 'filters', title: 'Bộ lọc đã lưu', items: items.slice(0, 4) };
  }

  // input.lastSession: bản ghi nhật ký phiên gần nhất trước hôm nay (lib/session-log.js)
  function session(input, today) {
    const r = input.lastSession;
    if (!r || !r.date || iso(r.date) >= today || num(r.dayPct) === null) return null;
    const idx = num(r.indexPct) !== null ? ', VN-Index ' + pct(r.indexPct, 2) + (num(r.rel) !== null ? ', ' + (r.rel >= 0 ? 'hơn' : 'kém') + ' chỉ số ' + Math.abs(r.rel).toFixed(2).replace('.', ',') + ' điểm %' : '') : '';
    const items = [{ text: 'Phiên ' + dm(r.date) + (r.final ? '' : ' (bản tạm giữa phiên)') + ': danh mục cổ phiếu ' + pct(r.dayPct, 2) + ' (' + (r.dayPnl >= 0 ? '+' : '−') + money(r.dayPnl) + ' đ)' + idx, tone: r.dayPnl > 0 ? 'up' : (r.dayPnl < 0 ? 'down' : 'info') }];
    if (r.best && r.best.length && r.worst && r.worst.length) items.push({ text: 'Mạnh nhất: ' + r.best[0].s + ' ' + pct(r.best[0].pct, 1) + '; yếu nhất: ' + r.worst[0].s + ' ' + pct(r.worst[0].pct, 1), tone: 'info' });
    return { id: 'session', title: 'Phiên gần nhất', items: items };
  }

  // input.alertsPrev: { date, items: [{ title, level }] } của phiên gần nhất trước hôm nay
  function alerts(input, today) {
    const a = input.alertsPrev;
    if (!a || !a.date || iso(a.date) >= today || !a.items || !a.items.length) return null;
    const bad = a.items.filter((x) => x.level === 'bad').length;
    return { id: 'alerts', title: 'Cảnh báo phiên trước', items: [{ text: dm(a.date) + ': ' + a.items.length + ' cảnh báo' + (bad ? ' (' + bad + ' mức xấu)' : '') + ' — ' + a.items.slice(0, 3).map((x) => x.title).join('; ') + (a.items.length > 3 ? '…' : ''), tone: bad ? 'warn' : 'info' }] };
  }

  function build(input, today) {
    const t = iso(today), inp = input || {};
    const sections = [portfolio(inp, t), session(inp, t), events(inp, t), limits(inp), watch(inp), filters(inp, t), sectors(inp), alerts(inp, t)].filter(Boolean);
    const attention = sections.reduce((n, s) => n + s.items.filter((i) => i.tone === 'warn' || i.tone === 'bad' || i.tone === 'act').length, 0);
    const headline = dayName(t) + ' ' + dm(t) + '/' + t.slice(0, 4) + (attention ? ' · ' + attention + ' việc cần xem' : ' · chưa có việc nào cần xử lý gấp');
    return { date: t, headline: headline, attention: attention, sections: sections };
  }

  return { build, portfolio, session, events, watch, limits, sectors, filters, alerts, dayName };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TodayBrief;
