// Logic thuần: phân tích nguồn gốc lợi nhuận (attribution) -- lãi/lỗ đến từ mã nào, ngành nào, bao nhiêu là do thị trường chung và bao nhiêu
// là do chọn mã/thời điểm; và kết quả theo từng loại quyết định trong nhật ký. KHÔNG đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global AttributionCalc) và module.exports cho Vitest. Cần FinCalc (lib/finance-calc.js) nạp trước.
//
// Phương pháp (theo từng mã, trong khoảng (từ, đến]):
//   Lãi/lỗ = giá trị cuối − giá trị đầu − (tiền bỏ ra mua + phí) + (tiền thu bán − phí − thuế) + cổ tức nhận được.
//   Giá trị = số cổ phiếu tại ngày đó (đã tính thưởng/tách) × giá đóng cửa tại hoặc ngay trước ngày đó. Gồm cả phần đã chốt và chưa chốt.
//   "Nếu bỏ cùng số vốn đó vào chỉ số" = tổng(giá trị cuối phiên trước × lợi suất chỉ số phiên đó): phần do THỊ TRƯỜNG CHUNG mang lại cho đúng
//   đường vốn của mã này. Vượt/thua chỉ số = lãi/lỗ − phần trên: phần do chọn mã và thời điểm mua bán.
//   Tiền mặt: coi như không sinh lời, nên "chi phí cơ hội" = −(tiền mặt × lợi suất chỉ số) -- giữ tiền mặt khi thị trường tăng là một quyết định.
//   Đóng góp % = lãi/lỗ ÷ (NAV đầu kỳ + ½ vốn nạp ròng) (cùng mẫu số Modified Dietz với hiệu quả TWR) nên cộng lại ≈ lợi suất cả kỳ.
// Đây là kế toán lãi/lỗ theo sổ lệnh đã nhập; lệnh nhập thiếu/sai thể hiện ở dòng "chênh lệch chưa giải thích" so với biến động NAV thực tế.
const AttributionCalc = (function () {
  const FC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./finance-calc.js') : FinCalc;
  const EPS = 1e-9;

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function iso(v) { return String(v || '').slice(0, 10); }

  // Điểm cuối kỳ gần nhất tại hoặc trước ngày d (series tăng dần [[date, v]]) -> giá hoặc null
  function valueAtOrBefore(series, d) {
    let lo = 0, hi = series.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid][0] <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans === -1 ? null : series[ans][1];
  }

  // Khoảng thời gian: 'mtd' | 'qtd' | 'ytd' | '1y' | 'all'. Điểm "từ" là cuối ngày liền trước kỳ (lãi/lỗ tính cho các ngày SAU mốc đó).
  function periodFor(key, today, firstDate) {
    const t = iso(today), y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
    const lastDayOfPrevMonth = function (yy, mm) { return new Date(Date.UTC(yy, mm - 1, 0)).toISOString().slice(0, 10); };
    let from = null;
    if (key === 'mtd') from = lastDayOfPrevMonth(y, m);
    else if (key === 'qtd') from = lastDayOfPrevMonth(y, Math.floor((m - 1) / 3) * 3 + 1);
    else if (key === 'ytd') from = (y - 1) + '-12-31';
    else if (key === '1y') from = new Date(new Date(t + 'T00:00:00Z').getTime() - 365 * 86400000).toISOString().slice(0, 10);
    else from = firstDate ? new Date(new Date(iso(firstDate) + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10) : t;
    if (firstDate && from < new Date(new Date(iso(firstDate) + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10)) {
      from = new Date(new Date(iso(firstDate) + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);   // không đi lùi quá ngày giao dịch đầu tiên
    }
    return { from: from, to: t };
  }

  // Số cổ phiếu theo thời gian của từng mã (cùng thứ tự xử lý với PortfolioCalc.replayLedger: ngày, rồi thời điểm tạo)
  function buildTimeline(txns, actions) {
    const events = [].concat(
      (txns || []).map(function (t) { return { kind: 'txn', d: iso(t.trade_date), ts: t.created_at || '', t: t }; }),
      (actions || []).filter(function (a) { return !a.deleted_at; }).map(function (a) { return { kind: 'action', d: iso(a.ex_date), ts: a.created_at || '', a: a }; })
    ).sort(function (x, y) { return x.d < y.d ? -1 : (x.d > y.d ? 1 : (x.ts < y.ts ? -1 : (x.ts > y.ts ? 1 : 0))); });
    const qty = {}, line = {};
    events.forEach(function (e) {
      const sym = e.kind === 'txn' ? e.t.symbol : e.a.symbol;
      if (!sym) return;
      let q = qty[sym] || 0;
      if (e.kind === 'txn') q += (e.t.type === 'sell' ? -1 : 1) * num(e.t.quantity);
      else if (q > 0) {
        const m = e.a.action_type === 'split' ? num(e.a.ratio) : 1 + num(e.a.ratio);
        if (m > 0) q *= m;
      }
      if (Math.abs(q) < EPS) q = 0;
      qty[sym] = q;
      const l = line[sym] || (line[sym] = []);
      if (l.length && l[l.length - 1][0] === e.d) l[l.length - 1][1] = q; else l.push([e.d, q]);
    });
    return line;
  }
  function qtyOn(timeline, sym, d) { const l = timeline[sym]; return l ? (valueAtOrBefore(l, d) || 0) : 0; }

  // input: { txns, actions, cashFlows, histories:{SYM:[[d,close]], VNINDEX:[..]}, navHistory, from, to, benchKey }
  function analyze(input) {
    const o = input || {};
    const from = iso(o.from), to = iso(o.to);
    const benchKey = o.benchKey || 'VNINDEX';
    const txns = (o.txns || []).filter(function (t) { return !t.deleted_at; });
    const timeline = buildTimeline(txns, o.actions);
    const hist = o.histories || {};
    const bench = (hist[benchKey] || []).map(function (p) { return [iso(p[0]), num(p[1])]; }).filter(function (p) { return p[1] > 0; });
    const priceSeries = {};
    Object.keys(hist).forEach(function (s) { priceSeries[s] = (hist[s] || []).map(function (p) { return [iso(p[0]), num(p[1])]; }).filter(function (p) { return p[1] > 0; }); });

    const symbols = {};
    txns.forEach(function (t) { if (t.symbol) symbols[t.symbol] = true; });
    Object.keys(timeline).forEach(function (s) { symbols[s] = true; });

    // Lịch phiên trong khoảng (theo chuẩn); nếu không có chuẩn thì không tính được phần "do thị trường"
    const days = bench.map(function (p) { return p[0]; }).filter(function (d) { return d > from && d <= to; });
    const benchRet = {};
    for (let i = 1; i < bench.length; i++) benchRet[bench[i][0]] = bench[i][1] / bench[i - 1][1] - 1;
    const prevDay = {};
    for (let i = 1; i < bench.length; i++) prevDay[bench[i][0]] = bench[i - 1][0];
    const hasBench = days.length >= 2;

    const rows = [];
    const missing = [];
    Object.keys(symbols).forEach(function (sym) {
      const q0 = qtyOn(timeline, sym, from), q1 = qtyOn(timeline, sym, to);
      const inRange = txns.filter(function (t) { return t.symbol === sym && iso(t.trade_date) > from && iso(t.trade_date) <= to; });
      const divs = (o.cashFlows || []).filter(function (f) { return f.flow_type === 'dividend' && f.symbol === sym && !f.deleted_at && iso(f.flow_date) > from && iso(f.flow_date) <= to; });
      if (q0 < EPS && q1 < EPS && !inRange.length && !divs.length) return;
      const ps = priceSeries[sym] || [];
      const p0 = valueAtOrBefore(ps, from), p1 = valueAtOrBefore(ps, to);
      const buys = inRange.filter(function (t) { return t.type !== 'sell'; }), sells = inRange.filter(function (t) { return t.type === 'sell'; });
      const buyCost = buys.reduce(function (s, t) { return s + num(t.quantity) * num(t.price) + num(t.fee); }, 0);
      const sellNet = sells.reduce(function (s, t) { return s + num(t.quantity) * num(t.price) - num(t.fee) - num(t.tax); }, 0);
      const fees = inRange.reduce(function (s, t) { return s + num(t.fee) + num(t.tax); }, 0);
      const dividends = divs.reduce(function (s, f) { return s + num(f.amount); }, 0);
      // Thiếu giá đầu/cuối khi đang nắm tại mốc đó -> không tính được; thay bằng giá giao dịch gần nhất để không bỏ sót cả mã
      let priceNote = null;
      let P0 = p0, P1 = p1;
      if (q0 > EPS && !(P0 > 0)) { priceNote = 'start'; }
      if (q1 > EPS && !(P1 > 0)) { priceNote = priceNote ? 'both' : 'end'; }
      if (priceNote) { missing.push(sym); }
      const v0 = q0 > EPS && P0 > 0 ? q0 * P0 : 0, v1 = q1 > EPS && P1 > 0 ? q1 * P1 : 0;
      const pnl = priceNote ? null : v1 - v0 - buyCost + sellNet + dividends;

      let benchPnl = null, avgMv = null;
      if (hasBench && !priceNote) {
        let acc = 0, sumMv = 0, n = 0;
        days.forEach(function (d) {
          const pd = prevDay[d];
          const qPrev = qtyOn(timeline, sym, pd);
          if (qPrev < EPS) { n++; return; }
          const pPrev = valueAtOrBefore(ps, pd);
          if (!(pPrev > 0)) return;
          acc += qPrev * pPrev * (benchRet[d] || 0);
          sumMv += qPrev * pPrev; n++;
        });
        benchPnl = acc; avgMv = n ? sumMv / n : 0;
      }
      rows.push({
        symbol: sym, sector: FC.sectorOf(sym), qtyStart: q0, qtyEnd: q1, priceStart: P0 > 0 ? P0 : null, priceEnd: P1 > 0 ? P1 : null,
        valueStart: v0, valueEnd: v1, bought: buyCost, sold: sellNet, dividends: dividends, fees: fees,
        pnl: pnl, benchPnl: benchPnl, activePnl: pnl !== null && benchPnl !== null ? pnl - benchPnl : null, avgMv: avgMv,
        held: q1 > EPS, closed: q1 <= EPS && q0 + buys.length > 0, priceMissing: !!priceNote,
      });
    });

    // Mẫu số: NAV đầu kỳ + ½ vốn nạp ròng (cùng quy ước Modified Dietz)
    const navs = (o.navHistory || []).map(function (r) { return { d: iso(r.snapshot_date), nav: num(r.nav), net: num(r.net_contributed), cash: num(r.cash) }; })
      .filter(function (r) { return r.d && r.nav > 0; }).sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    let base = null, baseKind = null, netFlows = null, navStart = null, navEnd = null;
    if (navs.length >= 2) {
      const before = navs.filter(function (r) { return r.d <= from; });
      const startRow = before.length ? before[before.length - 1] : navs[0];
      const inside = navs.filter(function (r) { return r.d <= to; });
      const endRow = inside.length ? inside[inside.length - 1] : null;
      if (endRow && endRow.d > startRow.d) {
        navStart = startRow.nav; navEnd = endRow.nav; netFlows = endRow.net - startRow.net;
        base = startRow.nav + 0.5 * netFlows; baseKind = 'nav';
        if (!(base > 0)) { base = null; baseKind = null; }
      }
    }
    if (base === null) {
      const cap = rows.reduce(function (s, r) { return s + (r.avgMv || 0); }, 0);
      if (cap > 0) { base = cap; baseKind = 'invested'; }
    }

    // Tiền mặt: chi phí cơ hội theo chuẩn trên số tiền mặt các lần chụp NAV trong kỳ
    let cashBench = null;
    if (hasBench && navs.length >= 2) {
      let acc = 0, used = 0;
      for (let i = 1; i < navs.length; i++) {
        const a = navs[i - 1], c = navs[i];
        if (c.d <= from || a.d >= to) continue;
        const d0 = a.d < from ? from : a.d, d1 = c.d > to ? to : c.d;
        const b0 = valueAtOrBefore(bench, d0), b1 = valueAtOrBefore(bench, d1);
        if (b0 > 0 && b1 > 0) { acc += a.cash * (b1 / b0 - 1); used++; }
      }
      if (used) cashBench = acc;
    }

    const valid = rows.filter(function (r) { return r.pnl !== null; });
    const totalPnl = valid.reduce(function (s, r) { return s + r.pnl; }, 0);
    const totalBench = hasBench ? valid.reduce(function (s, r) { return s + (r.benchPnl || 0); }, 0) : null;
    const unassignedDiv = (o.cashFlows || []).filter(function (f) { return f.flow_type === 'dividend' && !f.symbol && !f.deleted_at && iso(f.flow_date) > from && iso(f.flow_date) <= to; })
      .reduce(function (s, f) { return s + num(f.amount); }, 0);
    const actualPnl = navStart !== null ? navEnd - navStart - netFlows : null;
    const explained = totalPnl + unassignedDiv;

    rows.forEach(function (r) { r.contributionPct = base > 0 && r.pnl !== null ? r.pnl / base * 100 : null; r.activePct = base > 0 && r.activePnl !== null ? r.activePnl / base * 100 : null; });
    rows.sort(function (a, b) { return (Math.abs(b.pnl || 0) - Math.abs(a.pnl || 0)) || (a.symbol < b.symbol ? -1 : 1); });

    // Theo ngành
    const sec = {};
    valid.forEach(function (r) {
      const s = sec[r.sector] || (sec[r.sector] = { sector: r.sector, symbols: [], pnl: 0, benchPnl: 0, avgMv: 0 });
      s.symbols.push(r.symbol); s.pnl += r.pnl; s.benchPnl += r.benchPnl || 0; s.avgMv += r.avgMv || 0;
    });
    const sectors = Object.keys(sec).map(function (k) {
      const s = sec[k];
      s.activePnl = hasBench ? s.pnl - s.benchPnl : null;
      s.contributionPct = base > 0 ? s.pnl / base * 100 : null; s.activePct = base > 0 && s.activePnl !== null ? s.activePnl / base * 100 : null;
      return s;
    }).sort(function (a, b) { return Math.abs(b.pnl) - Math.abs(a.pnl); });

    const winners = valid.filter(function (r) { return r.pnl > 0; }), losers = valid.filter(function (r) { return r.pnl < 0; });
    const grossGain = winners.reduce(function (s, r) { return s + r.pnl; }, 0), grossLoss = losers.reduce(function (s, r) { return s + r.pnl; }, 0);
    const top = valid.slice().sort(function (a, b) { return b.pnl - a.pnl; });
    return {
      from: from, to: to, hasBench: hasBench, days: days.length, base: base, baseKind: baseKind,
      rows: rows, sectors: sectors, missing: missing,
      totals: {
        pnl: totalPnl, benchPnl: totalBench, activePnl: totalBench === null ? null : totalPnl - totalBench,
        cashBenchPnl: cashBench, cashActivePnl: cashBench === null ? null : -cashBench, unassignedDividends: unassignedDiv,
        fees: rows.reduce(function (s, r) { return s + r.fees; }, 0), dividends: rows.reduce(function (s, r) { return s + r.dividends; }, 0) + unassignedDiv,
        contributionPct: base > 0 ? totalPnl / base * 100 : null,
        actualPnl: actualPnl, unexplained: actualPnl === null ? null : actualPnl - explained,
        navStart: navStart, navEnd: navEnd, netFlows: netFlows,
      },
      breadth: { winners: winners.length, losers: losers.length, grossGain: grossGain, grossLoss: grossLoss, profitFactor: grossLoss < 0 ? grossGain / Math.abs(grossLoss) : null },
      best: top.slice(0, 3).filter(function (r) { return r.pnl > 0; }), worst: top.slice(-3).reverse().filter(function (r) { return r.pnl < 0; }),
      topShare: grossGain > 0 && top.length ? top[0].pnl / grossGain * 100 : null,
    };
  }

  // ---------- Theo quyết định trong nhật ký ----------
  // list: quyết định đã chuẩn hoá (DecisionJournal.normalize + planScore ở d.plan nếu có), evals: { [id]: kết quả đánh giá }.
  // Chỉ quyết định MUA/GIỮ có lợi suất; BÁN/BỎ QUA đánh giá bằng giá sau đó (bán đúng/né được hay bán sớm/bỏ lỡ).
  function median(a) { if (!a.length) return null; const s = a.slice().sort(function (x, y) { return x - y; }); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function groupStats(entries) {
    const rets = entries.filter(function (e) { return e.ev.returnPct !== undefined && e.ev.returnPct !== null; });
    const alphas = entries.filter(function (e) { return e.ev.alphaPct !== undefined && e.ev.alphaPct !== null; }).map(function (e) { return e.ev.alphaPct; });
    const r = rets.map(function (e) { return e.ev.returnPct; });
    return {
      n: entries.length, withReturn: rets.length,
      winRatePct: r.length ? r.filter(function (x) { return x > 0; }).length / r.length * 100 : null,
      avgReturnPct: r.length ? r.reduce(function (s, x) { return s + x; }, 0) / r.length : null,
      avgAlphaPct: alphas.length ? alphas.reduce(function (s, x) { return s + x; }, 0) / alphas.length : null,
      medianAlphaPct: median(alphas), alphaN: alphas.length,
    };
  }

  function planBucket(e) { return e.plan && e.plan.complete ? 'complete' : 'partial'; }
  function confBucket(e) { return e.confidence ? String(e.confidence) : 'none'; }

  function byDecision(list, evals, planScoreFn) {
    const entries = (list || []).map(function (d) {
      const ev = evals && evals[d.id];
      return ev && ev.status !== 'nodata' ? Object.assign({}, d, { ev: ev, plan: planScoreFn ? planScoreFn(d) : null }) : null;
    }).filter(Boolean);
    const buys = entries.filter(function (e) { return e.action === 'buy' || e.action === 'hold'; });
    const sells = entries.filter(function (e) { return e.action === 'sell' || e.action === 'skip'; });
    const group = function (arr, keyFn, labelFn, order) {
      const m = {};
      arr.forEach(function (e) { const k = keyFn(e); (m[k] = m[k] || []).push(e); });
      const keys = Object.keys(m);
      if (order) keys.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
      return keys.map(function (k) { return Object.assign({ key: k, label: labelFn(k) }, groupStats(m[k])); });
    };
    const tags = {};
    buys.forEach(function (e) { (e.tags && e.tags.length ? e.tags : []).forEach(function (t) { (tags[t] = tags[t] || []).push(e); }); });
    const byTag = Object.keys(tags).map(function (t) { return Object.assign({ key: t, label: t }, groupStats(tags[t])); }).sort(function (a, b) { return b.n - a.n; });
    const sellGood = sells.filter(function (e) { return e.ev.status === 'sold_well' || e.ev.status === 'avoided'; }).length;
    const sellBad = sells.filter(function (e) { return e.ev.status === 'sold_early' || e.ev.status === 'missed'; }).length;
    return {
      total: entries.length, buys: buys.length, sells: sells.length,
      overall: groupStats(buys),
      byAction: group(entries, function (e) { return e.action; }, function (k) { return { buy: 'Mua', hold: 'Giữ', sell: 'Bán', skip: 'Bỏ qua' }[k] || k; }),
      byPlan: group(buys, planBucket, function (k) { return k === 'complete' ? 'Kế hoạch đầy đủ' : 'Kế hoạch thiếu'; }, ['complete', 'partial']),
      byConfidence: group(buys, confBucket, function (k) { return k === 'none' ? 'Không ghi' : 'Tự tin ' + k + '/5'; }, ['1', '2', '3', '4', '5', 'none']),
      byVerdict: group(buys, function (e) { return e.valuation && e.valuation.verdict ? e.valuation.verdict : 'none'; }, function (k) { return { cheap: 'Định giá: Rẻ', fair: 'Định giá: Hợp lý', expensive: 'Định giá: Đắt', none: 'Chưa định giá' }[k] || k; }, ['cheap', 'fair', 'expensive', 'none']),
      byTag: byTag,
      sellQuality: { total: sells.length, good: sellGood, bad: sellBad, neutral: sells.length - sellGood - sellBad, goodPct: sells.length ? sellGood / sells.length * 100 : null },
      // Hiệu chỉnh mức tự tin: tự tin cao có thực sự cho alpha cao hơn không (cần đủ mẫu)
      calibration: (function () {
        const hi = buys.filter(function (e) { return e.confidence >= 4; }), lo = buys.filter(function (e) { return e.confidence && e.confidence <= 2; });
        const a = groupStats(hi), b = groupStats(lo);
        return { highN: hi.length, lowN: lo.length, highAlpha: a.avgAlphaPct, lowAlpha: b.avgAlphaPct, ok: hi.length >= 3 && lo.length >= 3, calibrated: a.avgAlphaPct !== null && b.avgAlphaPct !== null ? a.avgAlphaPct > b.avgAlphaPct : null };
      })(),
    };
  }

  return { periodFor, buildTimeline, qtyOn, analyze, byDecision, groupStats, valueAtOrBefore };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AttributionCalc;
