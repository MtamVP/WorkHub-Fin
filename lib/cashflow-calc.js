// Logic thuần: DỰ BÁO DÒNG TIỀN MẶT ngắn hạn của danh mục -- biết trước tuần nào thiếu hay thừa tiền.
// Gộp các nguồn đã có sẵn trong ứng dụng, KHÔNG tự bịa số mới:
//   * cổ tức tiền: CalendarCalc.dividendForecast (đã công bố / ước tính theo lịch sử, đã trừ thuế 5%)
//   * tiền bán chưa về: VnMarket.unsettled -> về vào ngày thanh toán T+2 (bỏ cuối tuần và ngày lễ theo lib/vn-holidays.js)
//   * lệnh dự kiến: đề xuất lệnh đã/đang chờ duyệt + khoản người dùng tự nhập (mua / bán / nạp / rút / khác)
//   * lãi vay: dư nợ x lãi suất năm / 12, trả vào cuối mỗi tháng (lãi suất do người dùng nhập; không nhập thì không tính)
// Giả định (nói rõ trên trang): số dư tiền mặt hiện tại ĐÃ trừ các lệnh mua đã ghi và CHƯA cộng tiền bán chưa về; lệnh mua dự kiến trừ tiền vào ngày đặt (thận trọng -- tuỳ cách thanh toán của công ty chứng khoán),
// lệnh bán dự kiến cộng tiền ở T+2. Cổ tức ước tính có thể không xảy ra (doanh nghiệp cắt/đổi hình thức). Đây là KẾ HOẠCH tiền mặt, không phải dự báo thị trường.
// KHÔNG đụng DOM/mạng. Nạp bằng thẻ <script> thường (global CashflowCalc) và module.exports cho Vitest. Cần VnHolidays nạp trước.
const CashflowCalc = (function () {
  const VH = (typeof require === 'function' && typeof module !== 'undefined') ? require('./vn-holidays.js') : (typeof VnHolidays !== 'undefined' ? VnHolidays : null);
  const KINDS = {
    dividend: { label: 'Cổ tức tiền', sign: 1 }, sell_settle: { label: 'Tiền bán về (T+2)', sign: 1 }, plan_sell: { label: 'Bán dự kiến', sign: 1 },
    plan_buy: { label: 'Mua dự kiến', sign: -1 }, deposit: { label: 'Nạp tiền', sign: 1 }, withdraw: { label: 'Rút tiền', sign: -1 },
    interest: { label: 'Lãi vay', sign: -1 }, other_in: { label: 'Khoản thu khác', sign: 1 }, other_out: { label: 'Khoản chi khác', sign: -1 },
  };
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const iso = (v) => String(v || '').slice(0, 10);
  const addDays = (d, n) => new Date(Date.parse(iso(d) + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const diffDays = (a, b) => Math.round((Date.parse(iso(b) + 'T00:00:00Z') - Date.parse(iso(a) + 'T00:00:00Z')) / 86400000);
  const isOff = (d) => { const w = new Date(iso(d) + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6 || (VH && VH.isHoliday(d)); };

  // Ngày tiền về sau n phiên giao dịch kể từ date (date là ngày giao dịch; nếu date là ngày nghỉ thì tính từ phiên kế tiếp)
  function settle(date, n) {
    let d = iso(date);
    for (let k = 0; k < (n === undefined ? 2 : n); k++) { d = VH ? VH.nextTradingDay(d) : addDays(d, 1); if (!d) return null; }
    return d;
  }
  // Ngày cuối tháng của tháng chứa d
  const monthEnd = (d) => { const x = new Date(iso(d) + 'T00:00:00Z'); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };

  // input: { today, cash, debt, debtRate (%/năm), buffer (đồng), weeks, dividends: [{date, symbol, amount, kind}], pendingSells: [{symbol, amount, settleDate}],
  //          planned: [{id, date, kind: 'buy'|'sell'|'deposit'|'withdraw'|'in'|'out', symbol, amount, note, source}] }
  // Trả { events, days, weeks, summary, warnings }
  function build(input) {
    const x = input || {};
    const today = iso(x.today), horizon = Math.max(1, Math.min(52, Math.round(num(x.weeks) || 13))) * 7, end = addDays(today, horizon);
    const cash0 = num(x.cash) || 0, buffer = Math.max(0, num(x.buffer) || 0);
    const events = [], warnings = [];
    const push = (e) => { if (e.date >= today && e.date <= end && e.amount) events.push(e); };

    (x.dividends || []).forEach((d) => { const a = num(d.amount); if (a > 0) push({ date: iso(d.date), kind: 'dividend', amount: a, symbol: d.symbol || null, note: d.kind === 'estimated' ? 'Ước tính theo khoản đã trả' : 'Đã công bố', sure: d.kind !== 'estimated', source: 'dividend' }); });
    (x.pendingSells || []).forEach((s) => { const a = num(s.amount); if (a > 0) push({ date: iso(s.settleDate) < today ? today : iso(s.settleDate), kind: 'sell_settle', amount: a, symbol: s.symbol || null, note: 'Tiền bán đã khớp, chưa về tài khoản', sure: true, source: 'settle' }); });

    (x.planned || []).forEach((p) => {
      const a = num(p.amount), when = iso(p.date);
      if (!(a > 0) || !when) return;
      const sym = p.symbol || null, base = { symbol: sym, note: p.note || '', sure: false, source: p.source || 'plan', id: p.id || null };
      if (p.kind === 'buy') push(Object.assign({ date: when < today ? today : when, kind: 'plan_buy', amount: -a }, base));
      else if (p.kind === 'sell') { const s = settle(when < today ? today : when, 2); if (s) push(Object.assign({ date: s, kind: 'plan_sell', amount: a }, base, { note: (p.note ? p.note + ' · ' : '') + 'bán ngày ' + (when < today ? today : when) + ', tiền về T+2' })); }
      else if (p.kind === 'deposit') push(Object.assign({ date: when < today ? today : when, kind: 'deposit', amount: a }, base));
      else if (p.kind === 'withdraw') push(Object.assign({ date: when < today ? today : when, kind: 'withdraw', amount: -a }, base));
      else if (p.kind === 'in') push(Object.assign({ date: when < today ? today : when, kind: 'other_in', amount: a }, base));
      else if (p.kind === 'out') push(Object.assign({ date: when < today ? today : when, kind: 'other_out', amount: -a }, base));
    });

    // Lãi vay: trả cuối mỗi tháng có trong tầm nhìn
    const debt = num(x.debt) || 0, rate = num(x.debtRate) || 0;
    if (debt > 0 && rate > 0) {
      let m = monthEnd(today);
      while (m <= end) { push({ date: m, kind: 'interest', amount: -(debt * rate / 100 / 12), symbol: null, note: 'Lãi vay ước tính ' + rate + '%/năm trên dư nợ hiện tại', sure: false, source: 'interest' }); m = monthEnd(addDays(m, 1)); }
    } else if (debt > 0) warnings.push({ key: 'no_rate', text: 'Đang có dư nợ nhưng chưa nhập lãi suất vay: chưa tính lãi vào dòng tiền.' });

    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (b.amount > 0) - (a.amount > 0)));

    // Số dư từng ngày (ngày nghỉ giữ nguyên số dư của ngày trước)
    const days = []; let bal = cash0, ei = 0;
    for (let k = 0; k <= horizon; k++) {
      const d = addDays(today, k); const items = [];
      while (ei < events.length && events[ei].date === d) { bal += events[ei].amount; items.push(events[ei]); ei++; }
      days.push({ date: d, balance: bal, net: items.reduce((s, e) => s + e.amount, 0), items: items, off: isOff(d) });
    }
    // Gom theo tuần: tuần 0 = hôm nay..+7 ngày, các tuần sau 7 ngày liền kề
    const weeks = [];
    for (let w = 0; w * 7 < horizon; w++) {
      const from = w === 0 ? today : addDays(today, w * 7 + 1), to = addDays(today, Math.min(horizon, w * 7 + 7));
      const segment = days.filter((d) => d.date >= from && d.date <= to);
      if (!segment.length) continue;
      const inflow = segment.reduce((s, d) => s + d.items.filter((e) => e.amount > 0).reduce((q, e) => q + e.amount, 0), 0), outflow = segment.reduce((s, d) => s + d.items.filter((e) => e.amount < 0).reduce((q, e) => q + e.amount, 0), 0);
      weeks.push({ index: w, from: from, to: segment[segment.length - 1].date, inflow: inflow, outflow: outflow, net: inflow + outflow, end: segment[segment.length - 1].balance, min: Math.min.apply(null, segment.map((d) => d.balance)),
        short: segment.some((d) => d.balance < 0), low: segment.some((d) => d.balance < buffer) });
    }

    let minDay = days[0];
    days.forEach((d) => { if (d.balance < minDay.balance) minDay = d; });
    const firstShort = days.find((d) => d.balance < 0) || null, firstLow = buffer > 0 ? (days.find((d) => d.balance < buffer) || null) : null;
    const total = (pred) => events.filter(pred).reduce((s, e) => s + e.amount, 0);
    const summary = {
      today: today, to: end, cash0: cash0, buffer: buffer, endBalance: days[days.length - 1].balance,
      minBalance: minDay.balance, minDate: minDay.date, firstShortfall: firstShort ? firstShort.date : null, firstBelowBuffer: firstLow ? firstLow.date : null,
      inflow: total((e) => e.amount > 0), outflow: total((e) => e.amount < 0), sureInflow: total((e) => e.amount > 0 && e.sure), unsureInflow: total((e) => e.amount > 0 && !e.sure),
      // Tiền có thể triển khai ngay mà không phá vỡ ngưỡng đệm ở bất kỳ ngày nào trong tầm nhìn (chỉ tính khoản chắc chắn nếu onlySure) -- không âm
      deployable: Math.max(0, minDay.balance - buffer), byKind: {},
    };
    events.forEach((e) => { summary.byKind[e.kind] = (summary.byKind[e.kind] || 0) + e.amount; });
    // Số dư thấp nhất nếu CHỈ tính khoản chắc chắn (không tính cổ tức ước tính / lãi ước tính / kế hoạch): cho biết mức cổ tức ước tính đang "gánh" bao nhiêu
    let b2 = cash0, minSure = cash0;
    const sureEvents = events.filter((e) => e.sure || e.amount < 0);
    let si = 0;
    for (let k = 0; k <= horizon; k++) { const d = addDays(today, k); while (si < sureEvents.length && sureEvents[si].date === d) { b2 += sureEvents[si].amount; si++; } if (b2 < minSure) minSure = b2; }
    summary.minBalanceSure = minSure;
    if (firstShort) warnings.push({ key: 'short', text: 'Dự kiến thiếu tiền từ ' + firstShort.date + ' (số dư thấp nhất ' + Math.round(minDay.balance) + ' đ vào ' + minDay.date + ').' });
    else if (firstLow) warnings.push({ key: 'low', text: 'Số dư xuống dưới mức đệm từ ' + firstLow.date + '.' });
    if (minSure < 0 && !firstShort) warnings.push({ key: 'rely_estimate', text: 'Nếu cổ tức ước tính và các khoản chưa chắc không xảy ra, số dư sẽ âm.' });
    if (!VH) warnings.push({ key: 'no_holidays', text: 'Thiếu lịch nghỉ lễ: ngày tiền về chỉ bỏ cuối tuần.' });
    else if (VH.coverage(today) !== 'complete' || VH.coverage(end) !== 'complete') warnings.push({ key: 'holidays_partial', text: 'Lịch nghỉ lễ của năm ' + end.slice(0, 4) + ' chưa đầy đủ: ngày tiền về có thể lệch nếu có ngày lễ chưa được ghi.' });
    return { events: events, days: days, weeks: weeks, summary: summary, warnings: warnings };
  }

  // Chuyển đề xuất lệnh (finance_order_requests: status pending|approved, chưa khớp) thành khoản dự kiến. date = ngày hết hạn hoặc hôm nay.
  function plannedFromOrders(orders, today) {
    const t = iso(today);
    return (orders || []).filter((o) => o && (o.status === 'approved' || o.status === 'pending') && !o.txn_id && !o.executed_at && (!o.valid_until || iso(o.valid_until) >= t)).map((o) => {
      const amount = num(o.value) > 0 ? num(o.value) : (num(o.quantity) > 0 && num(o.price_ref) > 0 ? num(o.quantity) * num(o.price_ref) : null);
      return amount > 0 ? { id: 'ord-' + o.id, date: t, kind: o.side === 'sell' ? 'sell' : 'buy', symbol: o.symbol, amount: amount, note: (o.status === 'approved' ? 'Đề xuất đã duyệt' : 'Đề xuất chờ duyệt'), source: 'order' } : null;
    }).filter(Boolean);
  }

  return { KINDS, settle, monthEnd, build, plannedFromOrders };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CashflowCalc;
