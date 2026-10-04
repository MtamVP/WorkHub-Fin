// Logic thuần: lịch sự kiện và dòng tiền cổ tức của danh mục -- việc sắp tới (ngày giao dịch không hưởng quyền, ngày tiền về, hạn công bố báo cáo tài chính)
// và dự báo cổ tức nhận được 12 tháng tới (đã công bố + ước tính theo lịch sử). KHÔNG đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global CalendarCalc) và module.exports cho Vitest. Cần CorporateEvents (lib/corporate-events.js) và PortfolioCalc nạp trước.
//
// Quy ước:
//  - Sự kiện đã công bố (nguồn thị trường) tính theo SỐ CỔ PHIẾU HƯỞNG QUYỀN đúng như CorporateEvents (số giữ trước ngày không hưởng quyền); với ngày chưa tới thì dùng số đang
//    giữ hôm nay ("nếu bạn giữ đến hết ngày trước ngày không hưởng quyền").
//  - Cổ tức tiền ghi sau thuế TNCN 5% (tiền thực nhận).
//  - Ước tính: mỗi khoản cổ tức tiền đã trả trong 12 tháng qua được giả định lặp lại vào cùng thời điểm năm sau với cùng mức đ/cp, TRỪ khi đã có khoản công bố của cùng mã
//    trong khoảng ±75 ngày quanh thời điểm đó. Đây là giả định, không phải cam kết của doanh nghiệp: doanh nghiệp có thể cắt/tăng/đổi hình thức (chuyển sang cổ phiếu).
//  - Hạn công bố báo cáo tài chính theo quy định hiện hành về công bố thông tin trên thị trường chứng khoán (khoảng): báo cáo quý trong 20 ngày sau khi kết thúc quý
//    (30 ngày nếu có công ty con phải hợp nhất), báo cáo soát xét bán niên 45 ngày, báo cáo kiểm toán năm 90 ngày. Chỉ là mốc tham khảo, hãy đối chiếu thông báo của công ty.
const CalendarCalc = (function () {
  const CE = (typeof require === 'function' && typeof module !== 'undefined') ? require('./corporate-events.js') : CorporateEvents;
  const TAX = CE.CASH_TAX_RATE;
  const REPORT_DAYS = { min: 20, max: 30, reviewedHalf: 45, auditedYear: 90 };

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function iso(v) { return String(v || '').slice(0, 10); }
  function addDays(d, n) { const x = new Date(iso(d) + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  function addYears(d, n) { const x = new Date(iso(d) + 'T00:00:00Z'); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10); }
  function diffDays(a, b) { return Math.round((Date.parse(iso(b) + 'T00:00:00Z') - Date.parse(iso(a) + 'T00:00:00Z')) / 86400000); }
  function monthKey(d) { return iso(d).slice(0, 7); }

  // ---------- Hạn công bố báo cáo ----------
  function quarterEnd(year, q) { return new Date(Date.UTC(year, q * 3, 0)).toISOString().slice(0, 10); }   // Q1 -> 31/03 ...
  // Quý kết thúc gần nhất tại hoặc trước hôm nay
  function lastEndedQuarter(today) {
    const y = Number(iso(today).slice(0, 4));
    const cand = [];
    for (let yr = y - 1; yr <= y; yr++) for (let q = 1; q <= 4; q++) cand.push({ year: yr, quarter: q, end: quarterEnd(yr, q) });
    return cand.filter(function (c) { return c.end <= iso(today); }).pop();
  }
  function nextQuarter(c) { return c.quarter === 4 ? { year: c.year + 1, quarter: 1, end: quarterEnd(c.year + 1, 1) } : { year: c.year, quarter: c.quarter + 1, end: quarterEnd(c.year, c.quarter + 1) }; }

  // symbols: danh sách mã đang giữ. latestQuarter: { SYM: '2026Q2' } từ bảng đệm số liệu (thiếu = chưa theo dõi). Trả danh sách mốc báo cáo cần chú ý.
  function reportDeadlines(symbols, latestQuarter, today) {
    const t = iso(today);
    const lq = lastEndedQuarter(t);
    const out = [];
    (symbols || []).forEach(function (sym) {
      const key = latestQuarter && latestQuarter[sym];
      const tracked = !!key;
      let target = lq;
      if (tracked) {
        const have = Number(key.slice(0, 4)) * 4 + Number(key.slice(5));
        if (have >= lq.year * 4 + lq.quarter) target = nextQuarter(lq);   // đã có báo cáo của quý vừa kết thúc -> mốc kế tiếp
      }
      const min = addDays(target.end, REPORT_DAYS.min), max = addDays(target.end, REPORT_DAYS.max);
      let status = 'upcoming';
      if (target.end > t) status = 'upcoming';
      else if (t > max) status = tracked ? 'late' : 'unknown';        // quá hạn mà mã đang theo dõi vẫn chưa có số mới
      else if (t >= min) status = 'due';
      else status = 'expected';
      const special = target.quarter === 4 ? 'Báo cáo kiểm toán năm: tối đa ' + REPORT_DAYS.auditedYear + ' ngày' : (target.quarter === 2 ? 'Báo cáo soát xét bán niên: tối đa ' + REPORT_DAYS.reviewedHalf + ' ngày' : null);
      out.push({ symbol: sym, period: target.year + 'Q' + target.quarter, label: 'Quý ' + target.quarter + '/' + target.year, periodEnd: target.end, from: min, deadline: max, status: status, tracked: tracked, note: special });
    });
    return out.sort(function (a, b) { return a.deadline < b.deadline ? -1 : (a.deadline > b.deadline ? 1 : (a.symbol < b.symbol ? -1 : 1)); });
  }

  // ---------- Sự kiện sắp tới ----------
  // ctx: { today, txns, actions, cashFlows, dismissed }. Trả danh sách theo ngày: { date, kind, symbol, title, detail, amount?, status }
  function upcomingEvents(events, ctx, horizonDays) {
    const today = iso(ctx.today);
    const end = addDays(today, horizonDays || 90);
    const res = CE.suggest(events, Object.assign({}, ctx, { today: today }));
    const out = [];
    res.items.forEach(function (p) {
      if (p.status === 'recorded' || p.status === 'dismissed') return;
      const ev = p.event;
      if (p.kind === 'cash_dividend') {
        if (ev.exDate > today && ev.exDate <= end) out.push({ date: ev.exDate, kind: 'ex_date', symbol: p.symbol, title: 'Ngày giao dịch không hưởng quyền', detail: 'Cổ tức ' + fmt(p.dps) + ' đ/cp · bạn được ' + fmt(p.gross) + ' đ (thực nhận ≈ ' + fmt(p.net) + ' đ) nếu giữ đến hết ngày trước đó', amount: p.net, status: 'upcoming', eventId: ev.id });
        if (p.flowDate > today && p.flowDate <= end) out.push({ date: p.flowDate, kind: 'pay_date', symbol: p.symbol, title: 'Tiền cổ tức về', detail: fmt(p.dps) + ' đ/cp × ' + fmt(p.quantity) + ' cp ≈ ' + fmt(p.net) + ' đ sau thuế', amount: p.net, status: 'upcoming', eventId: ev.id });
      } else if (p.kind === 'stock_dividend' || p.kind === 'bonus') {
        if (ev.exDate >= today && ev.exDate <= end) out.push({ date: ev.exDate, kind: 'ex_date', symbol: p.symbol, title: p.label + ' · không hưởng quyền', detail: 'Tỷ lệ 100:' + fmt(p.ratioPct) + ' → thêm ' + fmt(p.bonusShares) + ' cp', status: 'upcoming', eventId: ev.id });
      } else if (p.kind === 'rights') {
        if (ev.exDate >= today && ev.exDate <= end) out.push({ date: ev.exDate, kind: 'ex_date', symbol: p.symbol, title: 'Quyền mua phát hành thêm · không hưởng quyền', detail: 'Được mua ' + fmt(p.rightsShares) + ' cp giá ' + fmt(p.issuePrice) + ' đ (cần ' + fmt(p.cost) + ' đ nếu mua hết)', status: 'upcoming', eventId: ev.id });
        if (ev.payDate && ev.payDate >= today && ev.payDate <= end) out.push({ date: ev.payDate, kind: 'rights_deadline', symbol: p.symbol, title: 'Hạn đăng ký mua quyền', detail: 'Hạn cuối nộp tiền mua ' + fmt(p.rightsShares) + ' cp', status: 'upcoming', eventId: ev.id });
      }
    });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : (a.symbol < b.symbol ? -1 : 1)); });
  }

  function fmt(v) { return Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 0 }); }

  // ---------- Dự báo dòng tiền cổ tức ----------
  // qty: { SYM: số cổ phiếu đang giữ }. Trả { months:[{month, confirmed, estimated, items}], confirmedTotal, estimatedTotal, receivedTrailing, ... }
  function dividendForecast(events, ctx, qty, months) {
    const today = iso(ctx.today);
    const horizon = months || 12;
    const horizonEnd = (function () { const d = new Date(today + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + horizon); return d.toISOString().slice(0, 10); })();
    const res = CE.suggest(events, Object.assign({}, ctx, { today: today }));
    const items = [];
    // 1) Đã công bố: cổ tức tiền chưa nhận (chờ ghi hoặc sắp tới) có ngày tiền về trong tầm nhìn
    res.items.forEach(function (p) {
      if (p.kind !== 'cash_dividend' || p.status === 'recorded' || p.status === 'dismissed') return;
      const d = p.flowDate;
      if (d > horizonEnd) return;
      if (p.status === 'pending' && d < addDays(today, -60)) return;   // khoản cũ chưa ghi: xử lý ở hộp Sự kiện doanh nghiệp, không đưa vào dự báo (tránh thổi phồng)
      items.push({ date: d < today ? today : d, symbol: p.symbol, amount: p.net, kind: 'confirmed', dps: p.dps, quantity: p.quantity, note: p.status === 'pending' ? 'Đã tới hạn, chưa ghi vào sổ' : 'Đã công bố' });
    });
    // 2) Ước tính từ khoản đã trả trong 12 tháng qua
    const winStart = addDays(today, -365);
    const confirmedBySym = {};
    items.forEach(function (i) { (confirmedBySym[i.symbol] = confirmedBySym[i.symbol] || []).push(i.date); });
    // cả sự kiện đã công bố trong tương lai (dù đã ghi) cũng che phủ ước tính
    (events || []).forEach(function (e) { if (e.kind === 'cash_dividend') { const d = e.payDate || e.exDate; if (d >= today) (confirmedBySym[e.symbol] = confirmedBySym[e.symbol] || []).push(d); } });
    (events || []).forEach(function (e) {
      if (e.kind !== 'cash_dividend') return;
      const d = e.payDate || e.exDate;
      if (d < winStart || d >= today) return;
      const q = num(qty[e.symbol]);
      if (!(q > 0)) return;
      const next = addYears(d, 1);
      if (next <= today || next > horizonEnd) return;
      const covered = (confirmedBySym[e.symbol] || []).some(function (c) { return Math.abs(diffDays(c, next)) <= 75; });
      if (covered) return;
      items.push({ date: next, symbol: e.symbol, amount: q * num(e.dps) * (1 - TAX), kind: 'estimated', dps: e.dps, quantity: q, note: 'Ước tính theo khoản trả ' + e.divYear + (e.period ? ' (đợt ' + e.period + ')' : '') });
    });
    // Gom theo tháng, đủ `horizon` tháng kể cả tháng trống
    const byMonth = {};
    const first = new Date(today + 'T00:00:00Z');
    for (let k = 0; k < horizon + 1; k++) { const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + k, 1)); byMonth[d.toISOString().slice(0, 7)] = { month: d.toISOString().slice(0, 7), confirmed: 0, estimated: 0, items: [] }; }
    items.forEach(function (i) { const m = byMonth[monthKey(i.date)]; if (!m) return; m[i.kind] += i.amount; m.items.push(i); });
    const monthsOut = Object.keys(byMonth).sort().map(function (k) { return byMonth[k]; });
    // Đã nhận 12 tháng qua (theo Dòng Tiền đã ghi)
    const recv = (ctx.cashFlows || []).filter(function (f) { return f.flow_type === 'dividend' && !f.deleted_at && iso(f.flow_date) > winStart && iso(f.flow_date) <= today; });
    const bySymbolRecv = {};
    recv.forEach(function (f) { const s = f.symbol || '(không gắn mã)'; bySymbolRecv[s] = (bySymbolRecv[s] || 0) + num(f.amount); });
    const sum = function (k) { return items.filter(function (i) { return i.kind === k; }).reduce(function (s, i) { return s + i.amount; }, 0); };
    return {
      months: monthsOut, items: items.sort(function (a, b) { return a.date < b.date ? -1 : 1; }),
      confirmedTotal: sum('confirmed'), estimatedTotal: sum('estimated'), forwardTotal: sum('confirmed') + sum('estimated'),
      receivedTrailing: recv.reduce(function (s, f) { return s + num(f.amount); }, 0), receivedBySymbol: bySymbolRecv,
      from: today, to: horizonEnd,
    };
  }

  // Suất cổ tức: tiền dự kiến 12 tháng tới / giá trị thị trường và / giá vốn; và 12 tháng qua / giá vốn
  function yields(forecast, marketValue, costValue) {
    const mv = num(marketValue), cv = num(costValue);
    return {
      forwardOnValuePct: mv > 0 ? forecast.forwardTotal / mv * 100 : null,
      forwardOnCostPct: cv > 0 ? forecast.forwardTotal / cv * 100 : null,
      trailingOnCostPct: cv > 0 ? forecast.receivedTrailing / cv * 100 : null,
    };
  }

  return { REPORT_DAYS, quarterEnd, lastEndedQuarter, reportDeadlines, upcomingEvents, dividendForecast, yields, addDays };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CalendarCalc;
