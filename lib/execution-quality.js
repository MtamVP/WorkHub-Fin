// Logic thuần: CHẤT LƯỢNG KHỚP LỆNH (phân tích chi phí giao dịch sau lệnh, "TCA" thu nhỏ) -- giá khớp so với giá tham chiếu, và chi phí thực của việc thực hiện.
// Dữ liệu chỉ có GIÁ ĐÓNG CỬA mỗi ngày (không có giá trong ngày), nên đây là thước đo THÔ, đọc theo xu hướng của nhiều lệnh chứ không phải từng lệnh:
//   1) so với giá đề xuất đã duyệt (finance_order_requests.price_ref) -- chỉ lệnh có đề xuất gắn txn_id: giá dịch chuyển bao nhiêu giữa lúc duyệt và lúc khớp, và mất bao nhiêu ngày.
//   2) so với giá đóng cửa ngày khớp -- mua cao hơn / bán thấp hơn giá đóng cửa là bất lợi; một lệnh có thể may rủi, nhiều lệnh cùng một phía mới nói lên thói quen (mua đuổi, bán vội).
//   3) chi phí hiện hữu = phí + thuế / giá trị lệnh.
//   4) "sau lệnh 5 phiên": giá đóng cửa 5 phiên sau so với giá khớp, theo chiều có lợi cho lệnh (mua rồi giá tăng = dương; bán rồi giá giảm = dương) -- đo chất lượng thời điểm.
// Dấu quy ước: "bất lợi" > 0 nghĩa là khớp xấu hơn tham chiếu (mua giá cao hơn / bán giá thấp hơn). Mọi nhận xét kèm cỡ mẫu và chỉ nêu khi đủ mẫu.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global ExecQuality) và module.exports cho Vitest.
const ExecQuality = (function () {
  const MIN_N = 5;            // dưới ngần này lệnh cùng nhóm thì không rút nhận xét
  const FORWARD_DAYS = 5;     // số phiên nhìn tiếp sau lệnh
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const iso = (v) => String(v || '').slice(0, 10);
  const days = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(iso(b) + 'T00:00:00Z') - Date.parse(iso(a) + 'T00:00:00Z')) / 86400000)) : null);
  const mean = (xs) => { const a = xs.filter((v) => v !== null && v !== undefined && isFinite(v)); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
  const wmean = (pairs) => { let w = 0, s = 0; pairs.forEach((p) => { if (p[0] !== null && p[0] !== undefined && isFinite(p[0]) && p[1] > 0) { w += p[1]; s += p[0] * p[1]; } }); return w > 0 ? s / w : null; };

  // series: { SYMBOL: [[ngày, giá], ...] } đã sắp tăng dần theo ngày. Giá đóng cửa của ngày `date` hoặc phiên gần nhất TRƯỚC đó.
  function closeOn(series, symbol, date) {
    const s = series && series[symbol]; if (!s || !s.length) return null;
    const d = iso(date); let best = null;
    for (let i = 0; i < s.length; i++) { if (iso(s[i][0]) <= d) best = num(s[i][1]); else break; }
    return best > 0 ? best : null;
  }
  // Giá đóng cửa sau `n` phiên giao dịch kể từ phiên của ngày `date` (n >= 1). null nếu chưa đủ phiên.
  function closeAfter(series, symbol, date, n) {
    const s = series && series[symbol]; if (!s || !s.length) return null;
    const d = iso(date); let idx = -1;
    for (let i = 0; i < s.length; i++) { if (iso(s[i][0]) <= d) idx = i; else break; }
    if (idx < 0 || idx + n >= s.length) return null;
    const v = num(s[idx + n][1]); return v > 0 ? v : null;
  }

  // input: { txns (chưa xoá), requests, series, today, from (lọc từ ngày) }
  function build(input) {
    const x = input || {};
    const from = x.from ? iso(x.from) : null;
    const byTxn = {}; (x.requests || []).forEach((r) => { if (r.txn_id) byTxn[String(r.txn_id)] = r; });
    const rows = (x.txns || []).filter((t) => !t.deleted_at && (!from || iso(t.trade_date) >= from) && num(t.quantity) > 0 && num(t.price) > 0).map((t) => {
      const side = t.type === 'sell' ? 'sell' : 'buy', sign = side === 'buy' ? 1 : -1;
      const symbol = String(t.symbol).toUpperCase(), price = num(t.price), value = num(t.quantity) * price;
      const req = byTxn[String(t.id)] || null;
      const refPrice = req ? num(req.price_ref) : 0;
      const close = closeOn(x.series, symbol, t.trade_date);
      const after = closeAfter(x.series, symbol, t.trade_date, FORWARD_DAYS);
      const cost = num(t.fee) + (side === 'sell' ? num(t.tax) : 0);
      return {
        id: t.id, userId: t.user_id, symbol: symbol, side: side, date: iso(t.trade_date), quantity: num(t.quantity), price: price, value: value,
        imported: !!t.import_batch,
        vsRefPct: refPrice > 0 ? sign * (price / refPrice - 1) * 100 : null,
        delayDays: req && req.decided_at ? days(req.decided_at, t.trade_date) : null,
        vsClosePct: close ? sign * (price / close - 1) * 100 : null,
        costPct: value > 0 ? cost / value * 100 : null, cost: cost,
        forwardPct: after ? (side === 'buy' ? (after / price - 1) : (price / after - 1)) * 100 : null,   // mua: giá sau tăng là dương; bán: giá sau giảm là dương
        hasRequest: !!req,
      };
    });
    const summary = summarize(rows);
    const byMember = {};
    rows.forEach((r) => { (byMember[r.userId] = byMember[r.userId] || []).push(r); });
    const members = Object.keys(byMember).map((id) => Object.assign({ userId: id }, stats(byMember[id]))).sort((a, b) => b.value - a.value);
    return { rows: rows, summary: summary, members: members, minN: MIN_N, forwardDays: FORWARD_DAYS };
  }

  function stats(list) {
    const sel = (f) => list.filter((r) => f(r) !== null && f(r) !== undefined);
    const buys = list.filter((r) => r.side === 'buy'), sells = list.filter((r) => r.side === 'sell');
    const close = (l) => l.filter((r) => r.vsClosePct !== null);
    return {
      n: list.length, value: list.reduce((s, r) => s + r.value, 0), cost: list.reduce((s, r) => s + r.cost, 0),
      costPct: wmean(list.map((r) => [r.costPct, r.value])),
      vsClose: { n: close(list).length, pct: wmean(close(list).map((r) => [r.vsClosePct, r.value])) },
      vsCloseBuy: { n: close(buys).length, pct: wmean(close(buys).map((r) => [r.vsClosePct, r.value])) },
      vsCloseSell: { n: close(sells).length, pct: wmean(close(sells).map((r) => [r.vsClosePct, r.value])) },
      vsRef: { n: sel((r) => r.vsRefPct).length, pct: mean(list.map((r) => r.vsRefPct)) },
      delay: { n: sel((r) => r.delayDays).length, days: mean(list.map((r) => r.delayDays)) },
      forwardBuy: { n: sel((r) => r.forwardPct).filter((r) => r.side === 'buy').length, pct: mean(buys.map((r) => r.forwardPct)) },
      forwardSell: { n: sel((r) => r.forwardPct).filter((r) => r.side === 'sell').length, pct: mean(sells.map((r) => r.forwardPct)) },
    };
  }

  function fmt(v, d) { return (Math.round(v * Math.pow(10, d || 1)) / Math.pow(10, d || 1)).toLocaleString('vi-VN'); }

  function summarize(rows) {
    const s = stats(rows), insights = [];
    if (s.vsCloseBuy.n >= MIN_N && s.vsCloseBuy.pct !== null && s.vsCloseBuy.pct > 0.5) insights.push({ tone: 'warn', text: 'Lệnh MUA khớp trung bình cao hơn giá đóng cửa cùng ngày ' + fmt(s.vsCloseBuy.pct, 2) + '% (' + s.vsCloseBuy.n + ' lệnh): có dấu hiệu mua đuổi giá trong phiên. Đây là so với giá đóng cửa chứ không phải giá trong ngày nên chỉ nên xem như xu hướng.' });
    if (s.vsCloseSell.n >= MIN_N && s.vsCloseSell.pct !== null && s.vsCloseSell.pct > 0.5) insights.push({ tone: 'warn', text: 'Lệnh BÁN khớp trung bình thấp hơn giá đóng cửa cùng ngày ' + fmt(s.vsCloseSell.pct, 2) + '% (' + s.vsCloseSell.n + ' lệnh): có dấu hiệu bán vội.' });
    if (s.vsRef.n >= 3 && s.vsRef.pct !== null && s.vsRef.pct > 1) insights.push({ tone: 'warn', text: 'Từ lúc đề xuất tới lúc khớp, giá dịch chuyển bất lợi trung bình ' + fmt(s.vsRef.pct, 2) + '% (' + s.vsRef.n + ' lệnh có đề xuất' + (s.delay.days !== null ? ', trễ trung bình ' + fmt(s.delay.days, 1) + ' ngày' : '') + '): quy trình duyệt hoặc việc chờ thực hiện đang làm mất lợi thế.' });
    if (s.costPct !== null && s.costPct > 0.3 && rows.length >= MIN_N) insights.push({ tone: 'info', text: 'Phí và thuế chiếm trung bình ' + fmt(s.costPct, 2) + '% giá trị lệnh: nếu hay vào ra ngắn hạn, chi phí này ăn vào lợi nhuận đáng kể.' });
    if (s.forwardBuy.n >= MIN_N && s.forwardBuy.pct !== null && s.forwardBuy.pct < -1) insights.push({ tone: 'warn', text: 'Sau lệnh mua ' + FORWARD_DAYS + ' phiên giá thường giảm trung bình ' + fmt(-s.forwardBuy.pct, 2) + '% (' + s.forwardBuy.n + ' lệnh): thời điểm mua có xu hướng kém.' });
    if (s.forwardSell.n >= MIN_N && s.forwardSell.pct !== null && s.forwardSell.pct < -1) insights.push({ tone: 'warn', text: 'Sau lệnh bán ' + FORWARD_DAYS + ' phiên giá thường tăng tiếp trung bình ' + fmt(-s.forwardSell.pct, 2) + '% (' + s.forwardSell.n + ' lệnh): có xu hướng bán sớm.' });
    if (!insights.length && rows.length) insights.push({ tone: 'mute', text: 'Chưa thấy dấu hiệu rõ về chất lượng khớp lệnh' + (rows.length < MIN_N ? ' (mới ' + rows.length + ' lệnh, cần từ ' + MIN_N + ' lệnh cùng phía để nhận xét)' : '') + '.' });
    return Object.assign({ insights: insights }, s);
  }

  return { MIN_N, FORWARD_DAYS, closeOn, closeAfter, build, stats, summarize };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ExecQuality;
