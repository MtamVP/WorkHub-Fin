// Báo cáo đầu tư cuối tháng: CHỈ SỐ LIỆU (không có lý giải/nhận định) để đưa cùng mẫu PowerPoint "Monthly Investment Review" cho AI điền.
// Logic thuần, không đụng DOM/Supabase. Nạp bằng thẻ <script> thường (global MonthlyReport) và module.exports cho Vitest.
// Cần PortfolioCalc (lib/portfolio-calc.js) và DecisionJournal (lib/decision-journal.js) nạp trước.
//
// Định nghĩa (cũng được ghi trong sheet "00_Huong_dan" của file xuất):
//  - Lợi suất danh mục = TWR của tháng: nối lợi suất các lần chụp NAV liên tiếp, BỎ lợi suất của ngày có nạp/rút vốn (cùng cách tab Hiệu Suất).
//  - Benchmark = lợi suất giá đóng cửa VN-Index giữa các mốc (chuyển mọi ngày về mốc gần nhất trước đó khi không có phiên).
//  - Alpha = lợi suất danh mục - lợi suất benchmark (điểm %).
//  - Sụt giảm tối đa (Max drawdown) tính trên chuỗi chỉ số TWR trong tháng (không bị méo bởi nạp/rút vốn).
//  - Đóng góp của 1 quyết định = lãi/lỗ của quyết định trong tháng / NAV đầu tháng.
//      MUA: (giá cuối tháng - giá mua) x KL - phí mua. BÁN: lãi/lỗ đã chốt ròng (đã trừ phí mua phân bổ, phí bán, thuế). GIỮ: (giá cuối - giá đầu tháng) x KL.
const MonthlyReport = (function () {
  // Node/Vitest: require; trình duyệt: biến toàn cục PortfolioCalc (khai báo const ở cấp script KHÔNG phải thuộc tính của window)
  const PC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./portfolio-calc.js') : PortfolioCalc;
  const DJ = (typeof require === 'function' && typeof module !== 'undefined') ? require('./decision-journal.js') : DecisionJournal;
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const round = (v, d) => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  const addDays = (isoDate, n) => iso(new Date(Date.parse(isoDate + 'T00:00:00Z') + n * 86400000));
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

  function monthBounds(month, todayIso) {
    const [y, m] = month.split('-').map(Number);
    const start = iso(new Date(Date.UTC(y, m - 1, 1)));
    const fullEnd = iso(new Date(Date.UTC(y, m, 0)));
    const today = todayIso || iso(new Date());
    const end = today >= start && today < fullEnd ? today : fullEnd;
    return { start, end, fullEnd, isPartial: end < fullEnd, label: 'Tháng ' + m + '/' + y };
  }

  // Giá trị gần nhất tại hoặc trước ngày (carry-forward). series: [[date, value]] đã sắp tăng dần. Không có -> null.
  function valueAtOrBefore(series, date) {
    let lo = 0, hi = series.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid][0] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans < 0 ? null : series[ans][1];
  }
  function indexAtOrBefore(series, date) {
    let lo = 0, hi = series.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid][0] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  // Chuỗi chỉ số TWR (gốc 1) trên các lần chụp NAV: [{date, idx, nav}]. Ngày có nạp/rút vốn (net_contributed đổi) giữ nguyên chỉ số.
  function twrSeries(navHistory) {
    const rows = (navHistory || []).map(h => ({ date: String(h.snapshot_date).slice(0, 10), nav: num(h.nav), contrib: num(h.net_contributed) }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const out = [];
    let idx = 1;
    rows.forEach((r, i) => {
      if (i > 0) {
        const prev = rows[i - 1];
        const flow = Math.abs(r.contrib - prev.contrib) > 1;
        if (!flow && prev.nav > 0) idx *= r.nav / prev.nav;
      }
      out.push({ date: r.date, idx, nav: r.nav, contrib: r.contrib });
    });
    return out;
  }

  function weekBoundaries(b) {
    const ymd = b.start.slice(0, 8);
    const pts = [7, 14, 21, 28].map(d => ymd + pad(d)).filter(d => d <= b.end);
    return pts;
  }

  // Giá đóng cửa theo ngày của 1 mã từ histories; trả [[date, close]] tăng dần
  function seriesOf(histories, symbol) {
    const rows = (histories && histories[symbol]) || [];
    return rows.map(r => [String(r[0]).slice(0, 10), num(r[1])]).filter(r => r[1] > 0).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  function benchmarkSeries(input) {
    const map = new Map();
    (input.benchmark || []).forEach(r => { if (num(r.close_value) > 0) map.set(String(r.price_date).slice(0, 10), num(r.close_value)); });
    seriesOf(input.histories, 'VNINDEX').forEach(([d, v]) => map.set(d, v));
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  function fmtPct(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '';
    const d = digits === undefined ? 1 : digits;
    const abs = Math.abs(v).toFixed(d);
    return (v > 0 ? '+' : (v < 0 ? '−' : '')) + abs + '%';
  }

  // ---------------------------------------------------------------------------------------------
  // Tính báo cáo. input: kết quả API.asset.getMonthlyReportInputs. opts: { todayIso, deepDiveTxnId }
  function compute(input, opts) {
    const o = opts || {};
    const warnings = [];
    const b = monthBounds(input.month, o.todayIso);
    const dayBeforeStart = addDays(b.start, -1);
    const histories = input.histories || {};
    if (input.historyError) warnings.push('Không lấy được giá lịch sử (' + input.historyError + ') — các mục cần giá theo ngày sẽ để trống.');

    // ---- NAV / TWR ----
    const twr = twrSeries(input.navHistory);
    const twrDates = twr.map(r => [r.date, r]);
    const baseRow = valueAtOrBefore(twrDates, dayBeforeStart) || valueAtOrBefore(twrDates, b.start);
    let startRow = baseRow;
    if (!startRow) {
      const first = twr.find(r => r.date >= b.start && r.date <= b.end);
      startRow = first || null;
      if (first) warnings.push('Chưa có ảnh chụp NAV trước đầu tháng — lấy điểm đầu tiên trong tháng (' + first.date + ') làm mốc gốc.');
    } else if (startRow.date >= b.start) {
      warnings.push('Chưa có ảnh chụp NAV trước đầu tháng — lấy điểm đầu tiên trong tháng (' + startRow.date + ') làm mốc gốc.');
    }
    const endRow = valueAtOrBefore(twrDates, b.end);
    const idxAt = (date) => { const r = valueAtOrBefore(twrDates, date); return r && startRow && r.date >= startRow.date ? r.idx / startRow.idx : null; };
    const inMonth = twr.filter(r => startRow && r.date >= startRow.date && r.date <= b.end);
    let peak = 1, maxDd = 0;
    inMonth.forEach(r => { const v = r.idx / startRow.idx; if (v > peak) peak = v; const dd = v / peak - 1; if (dd < maxDd) maxDd = dd; });
    const portfolioReturn = startRow && endRow && endRow.date >= startRow.date && inMonth.length >= 2 ? (idxAt(b.end) - 1) * 100 : null;
    if (portfolioReturn === null) warnings.push('Không đủ ảnh chụp NAV trong tháng để tính lợi suất danh mục.');

    // ---- Benchmark ----
    const bench = benchmarkSeries(input);
    const benchAt = (date) => valueAtOrBefore(bench, date);
    const benchStart = benchAt(dayBeforeStart) || benchAt(b.start);
    const benchEnd = benchAt(b.end);
    const benchReturn = benchStart && benchEnd ? (benchEnd / benchStart - 1) * 100 : null;
    if (benchReturn === null) warnings.push('Thiếu dữ liệu VN-Index cho tháng này — Benchmark và Alpha để trống.');
    const alpha = portfolioReturn !== null && benchReturn !== null ? portfolioReturn - benchReturn : null;

    // ---- Dòng tiền trong tháng, NAV đầu/cuối ----
    const flows = input.cashFlows || [];
    const flowsIn = (type) => flows.filter(f => f.flow_type === type && String(f.flow_date) >= b.start && String(f.flow_date) <= b.end).reduce((s, f) => s + num(f.amount), 0);
    const deposits = flowsIn('deposit'), withdrawals = flowsIn('withdrawal'), dividends = flowsIn('dividend');
    const navStart = startRow ? startRow.nav : null, navEnd = endRow ? endRow.nav : null;
    const pnlMonth = navStart !== null && navEnd !== null ? navEnd - navStart - (deposits - withdrawals) : null;

    // ---- Sổ lệnh: lô FIFO, bán trong tháng (lãi ròng), sổ tại cuối tháng ----
    const txnsAll = input.txns || [];
    const actions = input.actions || [];
    const txnsToEnd = txnsAll.filter(t => String(t.trade_date) <= b.end);
    const ledger = PC.replayLedger(txnsToEnd, actions);
    const saleByTxn = {};
    ledger.sales.forEach(s => { saleByTxn[s.txnId] = s; });
    const tradesInMonth = txnsAll.filter(t => String(t.trade_date) >= b.start && String(t.trade_date) <= b.end)
      .sort((a, c) => (a.trade_date < c.trade_date ? -1 : a.trade_date > c.trade_date ? 1 : (a.created_at < c.created_at ? -1 : 1)));
    const salesInMonth = ledger.sales.filter(s => s.date >= b.start && s.date <= b.end);
    const sumSales = PC.summarizeSales(salesInMonth);

    const priceSeries = {};
    const closeOn = (symbol, date) => {
      if (!(symbol in priceSeries)) priceSeries[symbol] = seriesOf(histories, symbol);
      return valueAtOrBefore(priceSeries[symbol], date);
    };
    const navAt = (date) => { const r = valueAtOrBefore(twrDates, date); return r ? r.nav : navStart; };
    const livePrice = (symbol) => { const h = (input.holdingsNow || []).find(x => x.symbol === symbol); return h && h.marketPrice > 0 ? h.marketPrice : null; };
    const endPrice = (symbol) => closeOn(symbol, b.end) || (!b.isPartial ? null : livePrice(symbol)) || (b.isPartial ? livePrice(symbol) : null);

    // ---- Quyết định trong tháng ----
    const decisions = tradesInMonth.map(t => {
      const qty = num(t.quantity), price = num(t.price), value = qty * price;
      const nav = navAt(t.trade_date);
      const row = {
        txnId: t.id, date: String(t.trade_date), symbol: t.symbol, action: t.type === 'sell' ? 'SELL' : 'BUY',
        quantity: qty, price, value, fee: num(t.fee), tax: num(t.tax),
        sizePctNav: nav > 0 ? value / nav * 100 : null, outcomePct: null, pnl: null, contributionPct: null,
      };
      if (t.type === 'sell') {
        const s = saleByTxn[t.id];
        if (s) {
          const basis = s.costBasis + s.buyFees;
          row.outcomePct = basis > 0 ? s.realizedNet / basis * 100 : null;
          row.pnl = s.realizedNet;
          row.holdingDays = round(s.avgHoldingDays, 0);
        }
      } else {
        const pe = endPrice(t.symbol);
        if (pe) { row.outcomePct = (pe / price - 1) * 100; row.pnl = (pe - price) * qty - num(t.fee); }
      }
      row.contributionPct = row.pnl !== null && navStart > 0 ? row.pnl / navStart * 100 : null;
      return row;
    });

    // GIỮ: mã đang nắm cuối tháng mà không có lệnh trong tháng
    const tradedSymbols = new Set(tradesInMonth.map(t => t.symbol));
    Object.keys(ledger.lotsBySymbol).forEach(symbol => {
      const qty = ledger.lotsBySymbol[symbol].reduce((s, l) => s + l.quantity, 0);
      if (qty <= 1e-9 || tradedSymbols.has(symbol)) return;
      const p0 = closeOn(symbol, dayBeforeStart) || closeOn(symbol, b.start);
      const p1 = endPrice(symbol);
      if (!p0 || !p1) return;
      const pnl = (p1 - p0) * qty;
      decisions.push({
        txnId: null, date: '', symbol, action: 'HOLD', quantity: qty, price: p0, value: qty * p1, fee: 0, tax: 0,
        sizePctNav: navEnd > 0 ? qty * p1 / navEnd * 100 : null, outcomePct: (p1 / p0 - 1) * 100, pnl,
        contributionPct: navStart > 0 ? pnl / navStart * 100 : null,
      });
    });
    // ---- Nhật ký quyết định (lý do + kỳ vọng ghi LÚC ra quyết định) ----
    const benchSeries = seriesOf(histories, 'VNINDEX');
    const journalAll = (input.journal || []).map(DJ.normalize);
    const evalEntry = (e) => DJ.evaluate(e, { series: seriesOf(histories, e.symbol), today: b.end, bench: benchSeries });
    const jInMonth = journalAll.filter(e => e.date >= b.start && e.date <= b.end);
    // Quyết định MUA/GIỮ ra trong 45 ngày trước kỳ (cùng khoảng giá đã tải) mà tới cuối kỳ vẫn đang mở -> liệt kê thêm để theo dõi
    const carriedOpen = journalAll.filter(e => e.date < b.start && e.date >= addDays(b.start, -45) && (e.action === 'buy' || e.action === 'hold') && evalEntry(e).status === 'open');
    const journalEntries = jInMonth.concat(carriedOpen).map(e => {
      const ev = evalEntry(e);
      const plan = DJ.planScore(e);
      return Object.assign({}, e, { eval: ev, plan, carried: e.date < b.start });
    });
    const journalByTxn = {};
    journalEntries.forEach(e => { if (e.txnId) journalByTxn[e.txnId] = e; });
    decisions.forEach(d => {
      const e = d.txnId ? journalByTxn[d.txnId] : null;
      if (!e) return;
      d.journal = { reason: e.reason, expected: e.expected, stop: e.stop, horizonMonths: e.horizonMonths, confidence: e.confidence, planScore: e.plan.score, status: e.eval.status, statusLabel: e.eval.label };
    });
    const monthJournal = journalEntries.filter(e => !e.carried);
    const journalSummary = DJ.summarize(monthJournal, monthJournal.map(e => e.eval));
    const journalCoverage = tradesInMonth.length ? tradesInMonth.filter(t => journalByTxn[t.id]).length / tradesInMonth.length * 100 : null;

    const ranked = decisions.filter(d => d.contributionPct !== null).sort((a, c) => Math.abs(c.contributionPct) - Math.abs(a.contributionPct));
    ranked.forEach((d, i) => { d.rankAbsContribution = i + 1; });
    const top5 = ranked.slice(0, 5);
    const decisionLabel = (d) => d.symbol + ' ' + (d.action === 'BUY' ? 'Mua' : d.action === 'SELL' ? 'Bán' : 'Giữ') + (d.date ? ' ' + d.date.slice(8, 10) + '/' + d.date.slice(5, 7) : '');

    // ---- Đường lũy kế theo tuần (chart 1) ----
    const weeks = weekBoundaries(b);
    const cumulative = [{ label: 'Start', portfolio: 0, benchmark: 0 }].concat(
      weeks.map((d, i) => ({ label: 'W' + (i + 1), date: d, portfolio: round(idxAt(d) === null ? null : (idxAt(d) - 1) * 100, 2), benchmark: benchStart && benchAt(d) ? round((benchAt(d) / benchStart - 1) * 100, 2) : null })),
      [{ label: 'Month-end', date: b.end, portfolio: round(portfolioReturn, 2), benchmark: round(benchReturn, 2) }]);
    if (portfolioReturn === null) cumulative.forEach(c => { c.portfolio = c.label === 'Start' ? 0 : null; });

    // ---- Chỉ số thị trường & rổ mã (chart 2, gốc 100 tại W1 đúng như mẫu) ----
    const universe = Array.from(new Set(Object.keys(ledger.lotsBySymbol).filter(s => ledger.lotsBySymbol[s].reduce((q, l) => q + l.quantity, 0) > 1e-9).concat(Array.from(tradedSymbols))));
    const uniIdx = (date) => {
      const parts = universe.map(s => { const p0 = closeOn(s, dayBeforeStart) || closeOn(s, b.start); const p = closeOn(s, date); return p0 && p ? p / p0 : null; }).filter(v => v !== null);
      return parts.length ? parts.reduce((a, v) => a + v, 0) / parts.length : null;
    };
    const marketPts = weeks.map((d, i) => ({ label: 'W' + (i + 1), date: d })).concat([{ label: 'Month-end', date: b.end }]);
    const marketRaw = marketPts.map(p => ({ label: p.label, date: p.date, market: benchStart && benchAt(p.date) ? benchAt(p.date) / benchStart : null, universe: uniIdx(p.date) }));
    const m0 = marketRaw.length ? marketRaw[0].market : null, u0 = marketRaw.length ? marketRaw[0].universe : null;
    const marketIndex = marketRaw.map(r => ({ label: r.label, date: r.date, market: m0 && r.market ? round(r.market / m0 * 100, 2) : null, universe: u0 && r.universe ? round(r.universe / u0 * 100, 2) : null }));
    const universeReturn = uniIdx(b.end) !== null ? (uniIdx(b.end) - 1) * 100 : null;

    // ---- Phân tích sâu 1 quyết định (slides 7-11) ----
    const tradeDecisions = decisions.filter(d => d.txnId && d.contributionPct !== null);
    const pick = (o.deepDiveTxnId && decisions.find(d => d.txnId === o.deepDiveTxnId)) ||
      tradeDecisions.slice().sort((a, c) => Math.abs(c.contributionPct) - Math.abs(a.contributionPct))[0] || null;
    const deepDive = pick ? deepDiveFor(pick, input, b, closeOn, benchAt, endPrice, saleByTxn, priceSeries, bench, ledger, pick.txnId ? journalByTxn[pick.txnId] : null) : null;

    // ---- Chỉ số quy trình (đo được từ dữ liệu) ----
    const held = (input.holdingsNow || []);
    const withTarget = held.filter(h => h.targetPrice > 0).length, withStop = held.filter(h => h.stopLoss > 0).length;
    const withBoth = held.filter(h => h.targetPrice > 0 && h.stopLoss > 0).length;
    const pct = (a, n) => n > 0 ? round(a / n * 100, 1) : null;
    const process = [
      { label: 'Hit rate', current: sumSales.winRate === null ? null : round(sumSales.winRate, 1), note: 'Tỷ lệ lệnh bán có lãi ròng trong tháng (' + sumSales.wins + '/' + (sumSales.wins + sumSales.losses) + ')' },
      { label: 'Process compliance', current: pct(withBoth, held.length), note: 'Tỷ lệ mã đang giữ có ĐỦ giá mục tiêu và ngưỡng cắt lỗ (' + withBoth + '/' + held.length + ')' },
      { label: 'Checklist adherence', current: pct(withStop, held.length), note: 'Tỷ lệ mã đang giữ có ngưỡng cắt lỗ (' + withStop + '/' + held.length + ')' },
      { label: 'Decision quality', current: journalSummary.planAvg === null ? null : round(journalSummary.planAvg, 1),
        note: journalSummary.total ? 'Chất lượng QUY TRÌNH: điểm kế hoạch trung bình (0–100) của ' + journalSummary.total + ' quyết định ghi trong tháng — lý do, giá mục tiêu, cắt lỗ, thời hạn, định giá. Không phải chấm kết quả.' : 'Chưa ghi nhật ký quyết định nào trong tháng nên chưa đo được' },
      { label: 'Journal coverage', current: journalCoverage === null ? null : round(journalCoverage, 1), note: 'Tỷ lệ lệnh trong tháng có ghi nhật ký quyết định (' + tradesInMonth.filter(t => journalByTxn[t.id]).length + '/' + tradesInMonth.length + ')' },
      { label: 'Full-plan rate', current: journalSummary.fullPlanPct === null ? null : round(journalSummary.fullPlanPct, 1), note: 'Tỷ lệ quyết định có kế hoạch đủ (mua: lý do + giá mục tiêu + cắt lỗ; khác: lý do) — ' + journalSummary.fullPlanCount + '/' + journalSummary.total },
      { label: 'Target-hit rate', current: journalSummary.buyEvaluated ? round(journalSummary.targetHit / journalSummary.buyEvaluated * 100, 1) : null, note: 'Quyết định MUA đã chạm giá mục tiêu / số quyết định mua đã đánh giá (' + journalSummary.targetHit + '/' + journalSummary.buyEvaluated + ')' },
      { label: 'Stop-hit rate', current: journalSummary.buyEvaluated ? round(journalSummary.stopHit / journalSummary.buyEvaluated * 100, 1) : null, note: 'Quyết định MUA đã chạm ngưỡng cắt lỗ / số quyết định mua đã đánh giá (' + journalSummary.stopHit + '/' + journalSummary.buyEvaluated + ')' },
    ];

    const kpi = {
      month: input.month, monthLabel: b.label, periodStart: b.start, periodEnd: b.end, isPartialMonth: b.isPartial,
      portfolioReturnPct: round(portfolioReturn, 2), benchmarkReturnPct: round(benchReturn, 2), alphaPct: round(alpha, 2), maxDrawdownPct: round(maxDd * 100, 2),
      navStart: round(navStart, 0), navEnd: round(navEnd, 0), netContributions: round(deposits - withdrawals, 0), deposits: round(deposits, 0), withdrawals: round(withdrawals, 0),
      pnlMonth: round(pnlMonth, 0), realizedNetPnl: round(sumSales.netPnl, 0), realizedGrossPnl: round(sumSales.grossPnl, 0), dividends: round(dividends, 0),
      feesAndTaxes: round(txnsAll.filter(t => String(t.trade_date) >= b.start && String(t.trade_date) <= b.end).reduce((s, t) => s + num(t.fee) + num(t.tax), 0), 0),
      cashEnd: round(input.cash, 0), debtEnd: round(input.debt, 0), marketValueEnd: round(held.reduce((s, h) => s + num(h.marketValue), 0), 0), holdingsCount: held.length,
      tradesCount: tradesInMonth.length, buysCount: tradesInMonth.filter(t => t.type === 'buy').length, sellsCount: tradesInMonth.filter(t => t.type === 'sell').length,
      hitRatePct: sumSales.winRate === null ? null : round(sumSales.winRate, 1), avgHoldingDaysSold: sumSales.count ? round(sumSales.avgHoldingDays, 1) : null,
      vnindexStart: round(benchStart, 2), vnindexEnd: round(benchEnd, 2), universeReturnPct: round(universeReturn, 2),
      journalCount: journalSummary.total, journalCoveragePct: journalCoverage === null ? null : round(journalCoverage, 1), planAvg: journalSummary.planAvg === null ? null : round(journalSummary.planAvg, 1),
      journalTargetHit: journalSummary.targetHit, journalStopHit: journalSummary.stopHit, journalAvgAlphaPct: journalSummary.avgAlphaPct === null ? null : round(journalSummary.avgAlphaPct, 2),
    };

    const report = { meta: { month: input.month, label: b.label, start: b.start, end: b.end, isPartial: b.isPartial, generatedAt: new Date().toISOString(), email: input.email || '', warnings }, kpi,
      cumulative, marketIndex, decisions: decisions.map(roundDecision), contribution: top5.map(d => ({ label: decisionLabel(d), contributionPct: round(d.contributionPct, 2) })), deepDive, process,
      journal: { entries: journalEntries.map(roundJournal), summary: journalSummary, coveragePct: journalCoverage === null ? null : round(journalCoverage, 1) } };
    report.placeholders = buildPlaceholders(report);
    return report;
  }

  function roundJournal(e) {
    return { date: e.date, symbol: e.symbol, action: e.action, price: e.price, quantity: e.quantity, reason: e.reason, expected: e.expected, stop: e.stop, horizonMonths: e.horizonMonths,
      confidence: e.confidence, tags: e.tags, planScore: e.plan.score, planMissing: e.plan.missing, carried: e.carried, status: e.eval.status, statusLabel: e.eval.label,
      returnPct: round(e.eval.returnPct, 2), alphaPct: round(e.eval.alphaPct, 2), peakPct: round(e.eval.peakPct, 2), troughPct: round(e.eval.troughPct, 2), hitDate: e.eval.hitDate,
      reviewRating: e.review ? e.review.rating : null, reviewNote: e.review ? e.review.note : '', lesson: e.review ? e.review.lesson : '' };
  }

  function roundDecision(d) {
    return Object.assign({}, d, { sizePctNav: round(d.sizePctNav, 2), outcomePct: round(d.outcomePct, 2), contributionPct: round(d.contributionPct, 3), pnl: round(d.pnl, 0), value: round(d.value, 0), price: round(d.price, 2) });
  }

  // Phân tích sâu 1 quyết định: bối cảnh giá quanh ngày quyết định, lựa chọn thay thế, kỳ vọng vs thực tế.
  function deepDiveFor(d, input, b, closeOn, benchAt, endPrice, saleByTxn, priceSeries, bench, ledger, jEntry) {
    const symbol = d.symbol;
    const series = priceSeries[symbol] || [];
    const out = { txnId: d.txnId, symbol, action: d.action, date: d.date, entryPrice: round(d.price, 2), sizePctNav: round(d.sizePctNav, 2), horizonDays: null,
      relativePrice: [], alternatives: [], expectedVsRealized: [], currentTarget: null, currentStop: null, hasPriceHistory: series.length > 0 };
    const h = (input.holdingsNow || []).find(x => x.symbol === symbol);
    const w = (input.watchlist || []).find(x => x.symbol === symbol);
    // Kỳ vọng: ƯU TIÊN mức đã ghi trong nhật ký lúc ra quyết định; không có thì dùng giá mục tiêu / cắt lỗ HIỆN TẠI của mã
    const jTarget = jEntry && jEntry.expected > 0 ? jEntry.expected : 0, jStop = jEntry && jEntry.stop > 0 ? jEntry.stop : 0;
    const target = jTarget || (h && h.targetPrice) || (w && w.targetPrice) || 0;
    const stop = jStop || (h && h.stopLoss) || 0;
    out.currentTarget = target || null; out.currentStop = stop || null;
    out.expectationSource = jTarget || jStop ? 'journal' : 'current';
    out.journalReason = jEntry && jEntry.reason ? jEntry.reason : '';
    // Thời gian nắm giữ: MUA -> tới ngày bán sớm nhất sau đó (hoặc cuối kỳ); BÁN -> số ngày giữ bình quân của lô đã bán
    if (d.action === 'SELL') out.horizonDays = d.holdingDays !== undefined ? d.holdingDays : null;
    else {
      const laterSell = (input.txns || []).filter(t => t.symbol === symbol && t.type === 'sell' && String(t.trade_date) >= d.date && String(t.trade_date) <= b.end).sort((a, c) => (a.trade_date < c.trade_date ? -1 : 1))[0];
      out.horizonDays = daysBetween(d.date, laterSell ? String(laterSell.trade_date) : b.end);
    }
    if (!series.length) return out;

    // T-10 ... T+10 theo NGÀY GIAO DỊCH của chính mã đó (chỉ số trong chuỗi giá), gốc 100 tại T-10 cho cả mã lẫn VN-Index
    let i0 = series.findIndex(r => r[0] >= d.date);
    if (i0 < 0) i0 = series.length - 1;
    const offsets = [[-10, 'T−10'], [-5, 'T−5'], [-2, 'T−2'], [0, 'Decision'], [2, 'T+2'], [5, 'T+5'], [10, 'T+10']];
    const pts = offsets.map(([off, label]) => { const idx = i0 + off; return { label, date: idx >= 0 && idx < series.length ? series[idx][0] : null, close: idx >= 0 && idx < series.length ? series[idx][1] : null }; });
    const base = pts.find(p => p.close);
    const baseDate = base ? base.date : null;
    const benchBase = baseDate ? benchAt(baseDate) : null;
    out.relativePrice = pts.map(p => ({
      label: p.label, date: p.date,
      asset: base && p.close ? round(p.close / base.close * 100, 2) : null,
      benchmark: benchBase && p.date && benchAt(p.date) ? round(benchAt(p.date) / benchBase * 100, 2) : null,
    }));

    // Kỳ vọng vs thực tế (%): kỳ vọng lấy từ nhật ký quyết định (nếu có) hoặc giá mục tiêu / cắt lỗ hiện tại của mã
    const entry = d.price;
    const after = series.filter(r => r[0] >= d.date && r[0] <= b.end);
    let peak = entry, maxDd = 0, maxGain = 0;
    after.forEach(r => { if (r[1] > peak) peak = r[1]; const dd = r[1] / peak - 1; if (dd < maxDd) maxDd = dd; const g = r[1] / entry - 1; if (g > maxGain) maxGain = g; });
    const realizedReturn = d.outcomePct;
    out.expectedVsRealized = [
      { label: 'Return', expected: target > 0 ? round((target / entry - 1) * 100, 2) : null, realized: round(realizedReturn, 2) },
      { label: 'Peak gain', expected: null, realized: after.length ? round(maxGain * 100, 2) : null },
      { label: 'Max drawdown', expected: stop > 0 ? round((stop / entry - 1) * 100, 2) : null, realized: after.length ? round(maxDd * 100, 2) : null },
    ];

    // Lựa chọn thay thế: upside (%) tới giá mục tiêu của các mã khác đang giữ/theo dõi
    const upsideOf = (x) => x.upsidePct !== null && x.upsidePct !== undefined ? x.upsidePct : null;
    const chosenUp = h ? upsideOf(h) : (w ? upsideOf(w) : null);
    const pool = (input.holdingsNow || []).concat(input.watchlist || []).filter(x => x.symbol !== symbol && upsideOf(x) !== null);
    const seen = new Set();
    const alts = pool.filter(x => { if (seen.has(x.symbol)) return false; seen.add(x.symbol); return true; }).sort((a, c) => upsideOf(c) - upsideOf(a)).slice(0, 3);
    out.alternatives = [{ label: 'Chosen asset (' + symbol + ')', upsidePct: chosenUp === null ? null : round(chosenUp, 2) }]
      .concat(alts.map(x => ({ label: x.symbol, upsidePct: round(upsideOf(x), 2) })), [{ label: 'Cash / wait', upsidePct: 0 }]);
    return out;
  }

  // Danh sách "ô văn bản cần thay trong mẫu" -> giá trị, để AI điền nhanh các khung KPI
  function buildPlaceholders(r) {
    const k = r.kpi;
    const P = (slide, field, value, unit) => ({ slide, field, value: value === null || value === undefined ? '' : value, unit: unit || '' });
    const rows = [
      P(1, '[THÁNG / NĂM]', k.monthLabel.replace('Tháng ', 'THÁNG ').toUpperCase().replace('/', ' / '), ''),
      P(3, 'PORTFOLIO RETURN', fmtPct(k.portfolioReturnPct), '%'),
      P(3, 'BENCHMARK', fmtPct(k.benchmarkReturnPct), '%'),
      P(3, 'ALPHA', fmtPct(k.alphaPct), '%'),
      P(3, 'MAX DRAWDOWN', fmtPct(k.maxDrawdownPct), '%'),
    ];
    r.decisions.filter(d => d.action !== 'HOLD').slice(0, 4).forEach((d, i) => {
      rows.push(P(5, 'DECISION LOG dòng ' + (i + 1) + ' — [dd/mm]', d.date ? d.date.slice(8, 10) + '/' + d.date.slice(5, 7) : '', ''));
      rows.push(P(5, 'DECISION LOG dòng ' + (i + 1) + ' — [Asset]', d.symbol, ''));
      rows.push(P(5, 'DECISION LOG dòng ' + (i + 1) + ' — ACTION', d.action, ''));
      rows.push(P(5, 'DECISION LOG dòng ' + (i + 1) + ' — OUTCOME', fmtPct(d.outcomePct), '%'));
    });
    const dd = r.deepDive;
    if (dd) {
      rows.push(P(7, '[ASSET / TICKER]', dd.symbol, ''), P(7, '[BUY / SELL / HOLD / SKIP]', dd.action, ''),
        P(7, 'DATE', dd.date ? dd.date.slice(8, 10) + '/' + dd.date.slice(5, 7) + '/' + dd.date.slice(0, 4) : '', ''),
        P(7, 'ENTRY', dd.entryPrice === null ? '' : Number(dd.entryPrice).toLocaleString('en-US'), 'VND'),
        P(7, 'SIZE', dd.sizePctNav === null ? '' : dd.sizePctNav.toFixed(1) + '% NAV', '%'),
        P(7, 'HORIZON', dd.horizonDays === null ? '' : dd.horizonDays + ' ngày', 'ngày'));
    }
    return rows;
  }

  // ---------------------------------------------------------------------------------------------
  // Dựng các sheet Excel (đưa vào XlsxWriter.build). Mỗi sheet bố cục giống bảng dữ liệu nhúng của biểu đồ trong mẫu PowerPoint:
  // cột A = nhãn (category), các cột sau = từng series.
  function toSheets(r) {
    const H = (v) => ({ v, s: 'header' });
    const pct = (v) => ({ v: v === null || v === undefined ? null : v, s: 'dec' });
    const vnd = (v) => ({ v: v === null || v === undefined ? null : v, s: 'int' });
    const note = (v) => ({ v, s: 'note' });
    const k = r.kpi;
    const sheets = [];

    sheets.push({ name: '00_Huong_dan', columns: [{ width: 34 }, { width: 110 }], rows: [
      [H('Báo cáo đầu tư cuối tháng'), H(r.meta.label + ' · kỳ ' + r.meta.start + ' → ' + r.meta.end + (r.meta.isPartial ? ' (tháng chưa kết thúc)' : ''))],
      ['Tạo lúc', r.meta.generatedAt],
      ['Cách dùng', 'Đưa file này cùng file mẫu PowerPoint cho AI: mỗi sheet có bố cục giống bảng dữ liệu nhúng (Edit Data) của một biểu đồ trong mẫu; sheet 01 điền các khung KPI. Chỉ có SỐ LIỆU — phần lý giải (Why / So what / Reflection) người dùng tự viết.'],
      [],
      [H('Sheet'), H('Dùng cho slide / biểu đồ')],
      ['01_KPI', 'Slide 1, 3 (các khung số), 4 — toàn bộ chỉ số tổng hợp của tháng'],
      ['02_Cumulative', 'Slide 3 — biểu đồ CUMULATIVE RETURN (Portfolio vs Benchmark), cột A = Start, W1..W4, Month-end'],
      ['03_MarketIndex', 'Slide 4 — biểu đồ MARKET INDEX (gốc 100 tại W1): VN-Index và rổ mã trong danh mục'],
      ['04_Decisions', 'Slide 5 — bảng DECISION LOG (BUY/SELL/HOLD) và dữ liệu thô của từng quyết định'],
      ['05_Contribution', 'Slide 5 — biểu đồ CONTRIBUTION TO MONTHLY RETURN (5 quyết định đóng góp lớn nhất)'],
      ['06_DeepDive', 'Slide 7–10 — phân tích sâu 1 quyết định: bối cảnh giá, lựa chọn thay thế, kỳ vọng vs thực tế'],
      ['07_Process', 'Slide 12, 14 — các chỉ số quy trình đo được từ dữ liệu (Current)'],
      ['08_Placeholders', 'Danh sách ô văn bản/số trong mẫu cần thay và giá trị tương ứng'],
      ['09_Journal', 'Nhật ký quyết định đã ghi: lý do, kỳ vọng (mục tiêu/cắt lỗ/thời hạn), điểm kế hoạch và kết quả tới cuối kỳ'],
      [],
      [H('Định nghĩa'), H('')],
      ['Lợi suất danh mục', 'TWR của tháng: nối lợi suất các lần chụp NAV, bỏ lợi suất ngày có nạp/rút vốn (cùng cách tab Hiệu Suất).'],
      ['Benchmark', 'Lợi suất giá đóng cửa VN-Index giữa các mốc (không có phiên thì dùng phiên gần nhất trước đó).'],
      ['Alpha', 'Lợi suất danh mục − Benchmark (điểm %).'],
      ['Max drawdown', 'Sụt giảm lớn nhất của chỉ số TWR trong tháng (không bị méo bởi nạp/rút vốn).'],
      ['Đóng góp của quyết định', 'Lãi/lỗ của quyết định trong tháng / NAV đầu tháng. MUA: (giá cuối tháng − giá mua) × KL − phí mua. BÁN: lãi/lỗ đã chốt ròng (sau phí & thuế). GIỮ: (giá cuối − giá đầu tháng) × KL.'],
      ['Rổ mã (Portfolio Universe)', 'Trung bình chỉ số giá của các mã đang giữ hoặc có giao dịch trong tháng (tỷ trọng bằng nhau, mua-và-giữ từ đầu tháng).'],
      ['Kỳ vọng (slide 10)', 'Lấy từ NHẬT KÝ QUYẾT ĐỊNH (mức ghi lúc ra quyết định) nếu có; quyết định chưa ghi nhật ký thì lấy giá mục tiêu / ngưỡng cắt lỗ HIỆN TẠI của mã.'],
      ['Decision quality', 'Chất lượng QUY TRÌNH, không phải kết quả: điểm kế hoạch trung bình (0–100) của các quyết định ghi trong tháng. Mua: lý do 30, giá mục tiêu 25, cắt lỗ 25, thời hạn 10, định giá/mức tự tin 10. Bán/giữ/bỏ qua: lý do là chính.'],
      ['Trạng thái quyết định', 'MUA/GIỮ: chạm mục tiêu hoặc cắt lỗ (giá đóng cửa, cái nào tới trước), hết hạn, hoặc đang theo dõi. BÁN/BỎ QUA: giá sau đó tăng ≥ 10% = bán sớm/bỏ lỡ, giảm ≥ 10% = bán đúng/né được.'],
    ].concat(r.meta.warnings.length ? [[], [H('Cảnh báo dữ liệu'), H('')]].concat(r.meta.warnings.map(w => ['', w])) : []) });

    const kv = (label, value, unit, fmt) => [label, fmt === 'vnd' ? vnd(value) : (fmt === 'pct' ? pct(value) : value), unit || ''];
    sheets.push({ name: '01_KPI', freezeHeader: true, columns: [{ width: 38 }, { width: 22 }, { width: 14 }], rows: [
      [H('Chỉ tiêu'), H('Giá trị'), H('Đơn vị')],
      kv('Tháng', k.monthLabel), kv('Kỳ bắt đầu', k.periodStart), kv('Kỳ kết thúc', k.periodEnd), kv('Tháng chưa kết thúc?', k.isPartialMonth ? 'Có' : 'Không'),
      kv('PORTFOLIO RETURN (TWR)', k.portfolioReturnPct, '%', 'pct'), kv('BENCHMARK (VN-Index)', k.benchmarkReturnPct, '%', 'pct'),
      kv('ALPHA', k.alphaPct, 'điểm %', 'pct'), kv('MAX DRAWDOWN', k.maxDrawdownPct, '%', 'pct'),
      kv('NAV đầu tháng', k.navStart, 'VND', 'vnd'), kv('NAV cuối tháng', k.navEnd, 'VND', 'vnd'),
      kv('Nạp vốn trong tháng', k.deposits, 'VND', 'vnd'), kv('Rút vốn trong tháng', k.withdrawals, 'VND', 'vnd'), kv('Vốn ròng góp thêm', k.netContributions, 'VND', 'vnd'),
      kv('Lãi/lỗ đầu tư trong tháng (đã loại nạp/rút)', k.pnlMonth, 'VND', 'vnd'),
      kv('Lãi/lỗ đã chốt — gộp', k.realizedGrossPnl, 'VND', 'vnd'), kv('Lãi/lỗ đã chốt — ròng (sau phí, thuế)', k.realizedNetPnl, 'VND', 'vnd'),
      kv('Cổ tức tiền nhận', k.dividends, 'VND', 'vnd'), kv('Phí + thuế giao dịch', k.feesAndTaxes, 'VND', 'vnd'),
      kv('Tiền mặt hiện tại', k.cashEnd, 'VND', 'vnd'), kv('Dư nợ hiện tại', k.debtEnd, 'VND', 'vnd'), kv('Giá trị thị trường hiện tại', k.marketValueEnd, 'VND', 'vnd'), kv('Số mã đang giữ', k.holdingsCount),
      kv('Số lệnh trong tháng', k.tradesCount), kv('— lệnh mua', k.buysCount), kv('— lệnh bán', k.sellsCount),
      kv('Hit rate (lệnh bán có lãi ròng)', k.hitRatePct, '%', 'pct'), kv('Thời gian giữ bình quân (lệnh bán)', k.avgHoldingDaysSold, 'ngày'),
      kv('Số quyết định ghi trong nhật ký', k.journalCount), kv('Tỷ lệ lệnh có nhật ký', k.journalCoveragePct, '%', 'pct'), kv('Điểm kế hoạch trung bình (Decision quality)', k.planAvg, '/100', 'pct'),
      kv('Quyết định mua đã chạm mục tiêu', k.journalTargetHit), kv('Quyết định mua đã chạm cắt lỗ', k.journalStopHit), kv('Alpha trung bình của quyết định mua', k.journalAvgAlphaPct, 'điểm %', 'pct'),
      kv('VN-Index đầu kỳ', k.vnindexStart, 'điểm'), kv('VN-Index cuối kỳ', k.vnindexEnd, 'điểm'), kv('Rổ mã đang giữ — lợi suất', k.universeReturnPct, '%', 'pct'),
    ] });

    sheets.push({ name: '02_Cumulative', freezeHeader: true, columns: [{ width: 16 }, { width: 14 }, { width: 14 }, { width: 14 }], rows:
      [[H(''), H('Portfolio'), H('Benchmark'), H('Ngày mốc')]].concat(r.cumulative.map(c => [c.label, pct(c.portfolio), pct(c.benchmark), c.date || r.meta.start])).concat([[], [note('Đơn vị: % lũy kế từ đầu tháng. Portfolio = TWR; Benchmark = VN-Index.')]]) });

    sheets.push({ name: '03_MarketIndex', freezeHeader: true, columns: [{ width: 16 }, { width: 16 }, { width: 18 }, { width: 14 }], rows:
      [[H(''), H('Market Index'), H('Portfolio Universe'), H('Ngày mốc')]].concat(r.marketIndex.map(c => [c.label, pct(c.market), pct(c.universe), c.date])).concat([[], [note('Gốc = 100 tại W1 (đúng như mẫu). Market Index = VN-Index; Portfolio Universe = rổ mã trong danh mục.')]]) });

    sheets.push({ name: '04_Decisions', freezeHeader: true, columns: [{ width: 12 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 14 }, { width: 18 }, { width: 11 }, { width: 13 }, { width: 18 }, { width: 14 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 44 }, { width: 13 }, { width: 13 }, { width: 11 }, { width: 11 }, { width: 22 }], rows:
      [[H('Ngày'), H('Mã'), H('Action'), H('Khối lượng'), H('Giá'), H('Giá trị'), H('%NAV'), H('Outcome %'), H('Lãi/lỗ (VND)'), H('Đóng góp % NAV'), H('Hạng |ĐG|'), H('Phí'), H('Thuế'), H('Lý do (nhật ký)'), H('Mục tiêu'), H('Cắt lỗ'), H('Thời hạn (tháng)'), H('Điểm kế hoạch'), H('Trạng thái')]]
        .concat(r.decisions.map(d => [d.date ? { v: d.date, s: 'date' } : '', d.symbol, d.action, { v: d.quantity, s: 'int' }, { v: d.price, s: 'int' }, vnd(d.value), pct(d.sizePctNav), pct(d.outcomePct), vnd(d.pnl), { v: d.contributionPct, s: 'dec' }, d.rankAbsContribution || '', vnd(d.fee), vnd(d.tax), d.journal ? d.journal.reason : '', d.journal ? vnd(d.journal.expected) : '', d.journal ? vnd(d.journal.stop) : '', d.journal && d.journal.horizonMonths ? d.journal.horizonMonths : '', d.journal ? { v: d.journal.planScore, s: 'int' } : '', d.journal ? d.journal.statusLabel : '']))
        .concat([[], [note('Outcome %: MUA = lãi/lỗ tới cuối tháng theo giá; BÁN = lãi/lỗ đã chốt ròng / vốn gốc của lô đã bán; GIỮ = biến động giá trong tháng.')]]) });

    sheets.push({ name: '05_Contribution', freezeHeader: true, columns: [{ width: 24 }, { width: 18 }], rows:
      [[H(''), H('Contribution')]].concat(r.contribution.map(c => [c.label, pct(c.contributionPct)])).concat([[], [note('Đơn vị: % NAV đầu tháng. 5 quyết định có |đóng góp| lớn nhất.')]]) });

    const dd = r.deepDive;
    const deep = [[H('Phân tích sâu — Decision #1'), H('')]];
    if (!dd) deep.push(['(không có quyết định nào đủ dữ liệu giá để phân tích)', '']);
    else {
      deep.push(['Mã', dd.symbol], ['Action', dd.action], ['Ngày', dd.date], ['Giá vào (ENTRY)', { v: dd.entryPrice, s: 'int' }], ['Quy mô (% NAV)', pct(dd.sizePctNav)], ['Thời gian (HORIZON, ngày)', dd.horizonDays],
        ['Giá mục tiêu hiện tại', vnd(dd.currentTarget)], ['Ngưỡng cắt lỗ hiện tại', vnd(dd.currentStop)], [],
        [H('RELATIVE PRICE (base = 100)'), H('Asset'), H('Benchmark'), H('Ngày')]);
      dd.relativePrice.forEach(p => deep.push([p.label, pct(p.asset), pct(p.benchmark), p.date || '']));
      deep.push([], [H('EXPECTED UPSIDE (%) BY OPPORTUNITY'), H('Expected upside')]);
      dd.alternatives.forEach(a => deep.push([a.label, pct(a.upsidePct)]));
      deep.push([], [H('EXPECTED vs REALIZED (%)'), H('Expected'), H('Realized')]);
      dd.expectedVsRealized.forEach(e => deep.push([e.label, pct(e.expected), pct(e.realized)]));
      if (dd.journalReason) deep.push([], ['Lý do ghi lúc quyết định', dd.journalReason]);
      deep.push([], [note((dd.expectationSource === 'journal' ? 'Kỳ vọng lấy từ nhật ký quyết định (mức ghi lúc ra quyết định).' : 'Kỳ vọng lấy từ giá mục tiêu/cắt lỗ hiện tại (quyết định này chưa ghi nhật ký).') + ' Peak gain/Max drawdown tính từ ngày quyết định tới cuối kỳ trên giá đóng cửa.')]);
    }
    sheets.push({ name: '06_DeepDive', columns: [{ width: 40 }, { width: 16 }, { width: 16 }, { width: 14 }], rows: deep });

    sheets.push({ name: '07_Process', freezeHeader: true, columns: [{ width: 24 }, { width: 14 }, { width: 14 }, { width: 80 }], rows:
      [[H(''), H('Current'), H('Target'), H('Cách tính')]].concat(r.process.map(p => [p.label, pct(p.current), '', p.note])).concat([[], [note('Cột Target để trống: mục tiêu do người dùng đặt.')]]) });

    sheets.push({ name: '08_Placeholders', freezeHeader: true, columns: [{ width: 8 }, { width: 44 }, { width: 24 }, { width: 10 }], rows:
      [[H('Slide'), H('Ô trong mẫu cần thay'), H('Giá trị'), H('Đơn vị')]].concat(r.placeholders.map(p => [p.slide, p.field, p.value, p.unit])) });
    const J = r.journal;
    const jrows = [[H('Ngày'), H('Mã'), H('Action'), H('Giá'), H('KL'), H('Lý do'), H('Mục tiêu'), H('Cắt lỗ'), H('Thời hạn (tháng)'), H('Tự tin (1-5)'), H('Điểm kế hoạch'), H('Còn thiếu'), H('Trạng thái'), H('Lợi suất %'), H('Alpha % vs VN-Index'), H('Đỉnh %'), H('Đáy %'), H('Ngày chạm'), H('Đánh giá (1-5)'), H('Nhận xét'), H('Bài học'), H('Mở từ trước kỳ?')]];
    J.entries.forEach(e => jrows.push([e.date, e.symbol, e.action.toUpperCase(), vnd(e.price), vnd(e.quantity), e.reason, vnd(e.expected), vnd(e.stop), e.horizonMonths || '', e.confidence || '', { v: e.planScore, s: 'int' }, e.planMissing.join(', '), e.statusLabel, pct(e.returnPct), pct(e.alphaPct), pct(e.peakPct), pct(e.troughPct), e.hitDate || '', e.reviewRating || '', e.reviewNote, e.lesson, e.carried ? 'Có' : '']));
    if (!J.entries.length) jrows.push(['(chưa ghi quyết định nào trong tháng — dùng tab Nhật Ký hoặc phần “Kế hoạch & lý do” khi thêm lệnh)']);
    jrows.push([], [note('Điểm kế hoạch đo QUY TRÌNH (có ghi lý do, mục tiêu, cắt lỗ, thời hạn ngay lúc quyết định), tách khỏi kết quả. Trạng thái/lợi suất tính theo giá đóng cửa từ ngày quyết định tới cuối kỳ.')]);
    sheets.push({ name: '09_Journal', freezeHeader: true, columns: [{ width: 12 }, { width: 9 }, { width: 9 }, { width: 12 }, { width: 10 }, { width: 46 }, { width: 12 }, { width: 12 }, { width: 11 }, { width: 10 }, { width: 11 }, { width: 28 }, { width: 22 }, { width: 11 }, { width: 14 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 11 }, { width: 30 }, { width: 30 }, { width: 12 }], rows: jrows });
    return sheets;
  }

  return { compute, toSheets, monthBounds, twrSeries, valueAtOrBefore, fmtPct };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MonthlyReport;
