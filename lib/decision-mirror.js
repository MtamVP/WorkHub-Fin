// Logic thuần: "Gương Quyết Định" -- soi chính cách MÌNH ra quyết định, không chỉ xem danh mục lãi hay lỗ.
// Đọc sổ lệnh + nhật ký quyết định + giá lịch sử rồi đo: (1) mức tự tin của mình có dự báo đúng kết quả không (hiệu chỉnh), (2) thiên kiến hành vi:
// bán lời quá sớm / giữ lỗ quá lâu (disposition effect, Odean 1998), mua đuổi sau khi giá đã tăng, bán hoảng loạn sau khi giá giảm,
// (3) điểm vào/ra lệnh có tạo lợi thế so với thị trường không, (4) bán xong giá đi đâu (bán rồi giá tăng tiếp hay giảm), (5) quy trình tốt có cho kết quả tốt không.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global DecisionMirror) và module.exports cho Vitest.
// Cần PortfolioCalc (lib/portfolio-calc.js) và DecisionJournal (lib/decision-journal.js) nạp trước.
//
// Nguyên tắc trung thực: mọi con số kèm cỡ mẫu (n); mẫu nhỏ thì nói thẳng là chưa đủ để kết luận; lợi suất tính theo GIÁ (chưa gồm cổ tức tiền) và đã điều chỉnh
// thưởng/tách theo hành động doanh nghiệp đã ghi; "so với thị trường" = VN-Index cùng kỳ. Gương chỉ mô tả thói quen đã đo được, không phải khuyến nghị đầu tư.
const DecisionMirror = (function () {
  const PC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./portfolio-calc.js') : PortfolioCalc;
  const DJ = (typeof require === 'function' && typeof module !== 'undefined') ? require('./decision-journal.js') : DecisionJournal;
  const EPS = 1e-9;
  const MIN_N = 8;            // dưới mức này thì chỉ gọi là "dấu hiệu", chưa đủ để kết luận
  const STALE_DAYS = 10;      // giá cũ hơn số ngày này so với ngày cần thì coi như không có giá
  const FWD = [30, 90];       // các chân trời nhìn tới (ngày lịch)

  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const iso = (v) => String(v || '').slice(0, 10);
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

  // ---- thống kê nhỏ ----
  function normCdf(z) {            // Abramowitz-Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  // Kiểm định hai tỷ lệ (hai phía): trả { z, p }
  function twoProportionTest(x1, n1, x2, n2) {
    if (n1 < 1 || n2 < 1) return { z: null, p: null };
    const p1 = x1 / n1, p2 = x2 / n2, p = (x1 + x2) / (n1 + n2);
    const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    if (se < EPS) return { z: 0, p: 1 };
    const z = (p1 - p2) / se;
    return { z: z, p: 2 * (1 - normCdf(Math.abs(z))) };
  }
  function ranks(a) {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(a.length);
    for (let i = 0; i < idx.length;) {
      let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  }
  function spearman(x, y) {
    if (x.length < 3 || x.length !== y.length) return null;
    const rx = ranks(x), ry = ranks(y), mx = mean(rx), my = mean(ry);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < rx.length; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) * (rx[i] - mx); syy += (ry[i] - my) * (ry[i] - my); }
    return sxx < EPS || syy < EPS ? null : sxy / Math.sqrt(sxx * syy);
  }

  // ---- giá ----
  function valueAtOrBefore(series, d) {
    let lo = 0, hi = series.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid][0] <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans === -1 ? null : { date: series[ans][0], v: num(series[ans][1]) };
  }
  function makeContext(input) {
    const histories = {};
    Object.keys(input.histories || {}).forEach(function (k) { histories[k] = (input.histories[k] || []).filter(function (r) { return r && num(r[1]) > 0; }).slice().sort(function (a, b) { return a[0] < b[0] ? -1 : 1; }); });
    const actionsBySym = {};
    (input.actions || []).filter(function (a) { return !a.deleted_at; }).forEach(function (a) { (actionsBySym[a.symbol] = actionsBySym[a.symbol] || []).push({ d: iso(a.ex_date), m: a.action_type === 'split' ? num(a.ratio) : 1 + num(a.ratio) }); });
    const bench = (input.bench && input.bench.length ? input.bench : histories.VNINDEX || []).filter(function (r) { return r && num(r[1]) > 0; }).slice().sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
    const today = iso(input.today) || new Date().toISOString().slice(0, 10);
    const priceAt = function (sym, d) { const s = histories[sym]; if (!s) return null; const p = valueAtOrBefore(s, d); return p && daysBetween(p.date, d) <= STALE_DAYS ? p.v : null; };
    const mult = function (sym, d0, d1) { return (actionsBySym[sym] || []).reduce(function (m, a) { return a.d > d0 && a.d <= d1 && a.m > 0 ? m * a.m : m; }, 1); };
    // Lợi suất giá (%) của mã giữa hai ngày, đã điều chỉnh thưởng/tách. null nếu thiếu giá
    const ret = function (sym, d0, d1) {
      const p0 = priceAt(sym, d0), p1 = priceAt(sym, d1);
      return p0 && p1 ? (p1 * mult(sym, d0, d1) / p0 - 1) * 100 : null;
    };
    const benchRet = function (d0, d1) {
      const a = valueAtOrBefore(bench, d0), b = valueAtOrBefore(bench, d1);
      return a && b && daysBetween(a.date, d0) <= STALE_DAYS && daysBetween(b.date, d1) <= STALE_DAYS ? (b.v / a.v - 1) * 100 : null;
    };
    return { histories, actionsBySym, bench, today, priceAt, mult, ret, benchRet };
  }

  function normTrades(txns) {
    return (txns || []).filter(function (t) { return !t.deleted_at && (t.type === 'buy' || t.type === 'sell') && num(t.quantity) > 0; }).map(function (t) {
      return { id: t.id, symbol: String(t.symbol).toUpperCase(), type: t.type, date: iso(t.trade_date), quantity: num(t.quantity), price: num(t.price), fee: num(t.fee), tax: num(t.tax), ts: t.created_at || '' };
    }).sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : (a.ts < b.ts ? -1 : 1)); });
  }

  function summarizeExcess(rows, key) {
    const v = rows.map(function (r) { return r[key]; }).filter(function (x) { return x !== null && x !== undefined; });
    return { n: v.length, avg: mean(v), hitPct: v.length ? v.filter(function (x) { return x > 0; }).length / v.length * 100 : null };
  }

  // ---- 1) Điểm vào/ra lệnh: sau khi mua / bán, mã đó đi thế nào so với thị trường ----
  function timing(trades, ctx) {
    const out = { buys: {}, sells: {} };
    FWD.forEach(function (h) {
      const b = [], s = [];
      trades.forEach(function (t) {
        const end = addDays(t.date, h);
        if (end > ctx.today) return;
        const r = ctx.ret(t.symbol, t.date, end), m = ctx.benchRet(t.date, end);
        if (r === null) return;
        const row = { ret: r, bench: m, excess: m === null ? null : r - m };
        (t.type === 'buy' ? b : s).push(row);
      });
      const sum = function (rows) { const e = summarizeExcess(rows, 'excess'), r = summarizeExcess(rows, 'ret'); return { n: rows.length, avgReturn: r.avg, avgExcess: e.avg, nExcess: e.n, hitPct: e.hitPct }; };
      out.buys[h] = sum(b); out.sells[h] = sum(s);
    });
    return out;
  }

  // ---- 2) Mua đuổi / bán hoảng loạn ----
  function behavior(trades, ctx) {
    const chase = { runup: [], flat: [], dip: [] }, panic = [];
    trades.forEach(function (t) {
      if (t.type === 'buy') {
        const prior = ctx.ret(t.symbol, addDays(t.date, -28), t.date);
        if (prior === null) return;
        const end = addDays(t.date, 30);
        const fwd = end <= ctx.today ? ctx.ret(t.symbol, t.date, end) : null, bm = end <= ctx.today ? ctx.benchRet(t.date, end) : null;
        const row = { symbol: t.symbol, date: t.date, prior: prior, fwd: fwd, excess: fwd !== null && bm !== null ? fwd - bm : null };
        (prior >= 10 ? chase.runup : (prior <= -5 ? chase.dip : chase.flat)).push(row);
      } else {
        const prior = ctx.ret(t.symbol, addDays(t.date, -14), t.date);
        if (prior === null || prior > -8) return;
        const end = addDays(t.date, 30);
        panic.push({ symbol: t.symbol, date: t.date, prior: prior, after: end <= ctx.today ? ctx.ret(t.symbol, t.date, end) : null });
      }
    });
    const nBuys = chase.runup.length + chase.flat.length + chase.dip.length;
    const grp = function (rows) { const e = summarizeExcess(rows, 'excess'); return { n: rows.length, avgPrior: mean(rows.map(function (r) { return r.prior; })), nFwd: e.n, avgExcess: e.avg }; };
    const pAfter = panic.filter(function (r) { return r.after !== null; });
    return {
      chase: { n: nBuys, runup: grp(chase.runup), flat: grp(chase.flat), dip: grp(chase.dip), runupSharePct: nBuys ? chase.runup.length / nBuys * 100 : null },
      panic: { n: panic.length, nAfter: pAfter.length, avgAfter: mean(pAfter.map(function (r) { return r.after; })), reboundPct: pAfter.length ? pAfter.filter(function (r) { return r.after >= 5; }).length / pAfter.length * 100 : null, items: panic.slice(-10) },
    };
  }

  // ---- 3) Disposition effect (Odean): tỷ lệ chốt lời (PGR) so với tỷ lệ cắt lỗ (PLR) trong các ngày có bán ----
  function disposition(trades, ctx) {
    const byDate = {};
    trades.forEach(function (t) { (byDate[t.date] = byDate[t.date] || []).push(t); });
    const state = {};                        // symbol -> { qty, cost (tổng giá vốn) }
    const acts = [];
    Object.keys(ctx.actionsBySym).forEach(function (sym) { ctx.actionsBySym[sym].forEach(function (a) { acts.push({ sym: sym, d: a.d, m: a.m }); }); });
    acts.sort(function (x, y) { return x.d < y.d ? -1 : (x.d > y.d ? 1 : 0); });
    let ai = 0, RG = 0, RL = 0, PG = 0, PL = 0;
    Object.keys(byDate).sort().forEach(function (d) {
      // thưởng/tách có hiệu lực tới ngày d (kể cả ngày không có giao dịch): nhân số cổ phiếu, giữ nguyên tổng giá vốn
      while (ai < acts.length && acts[ai].d <= d) { const a = acts[ai++]; if (state[a.sym] && state[a.sym].qty > 0 && a.m > 0) state[a.sym].qty *= a.m; }
      const day = byDate[d], sold = {};
      day.filter(function (t) { return t.type === 'sell'; }).forEach(function (t) { (sold[t.symbol] = sold[t.symbol] || { qty: 0, value: 0 }); sold[t.symbol].qty += t.quantity; sold[t.symbol].value += t.quantity * t.price; });
      if (Object.keys(sold).length) {
        Object.keys(state).forEach(function (sym) {
          const st = state[sym];
          if (st.qty <= EPS || st.cost <= 0) return;
          const avg = st.cost / st.qty;
          if (sold[sym]) {
            const px = sold[sym].value / sold[sym].qty;
            if (px > avg + EPS) RG++; else if (px < avg - EPS) RL++;
          } else {
            const px = ctx.priceAt(sym, d);
            if (px === null) return;
            if (px > avg + EPS) PG++; else if (px < avg - EPS) PL++;
          }
        });
      }
      day.forEach(function (t) {
        const st = state[t.symbol] || (state[t.symbol] = { qty: 0, cost: 0 });
        if (t.type === 'buy') { st.qty += t.quantity; st.cost += t.quantity * t.price; }
        else if (st.qty > EPS) { const avg = st.cost / st.qty, q = Math.min(t.quantity, st.qty); st.qty -= q; st.cost -= q * avg; if (st.qty <= EPS) { st.qty = 0; st.cost = 0; } }
      });
    });
    const gains = RG + PG, losses = RL + PL;
    const pgr = gains ? RG / gains : null, plr = losses ? RL / losses : null;
    const test = pgr !== null && plr !== null ? twoProportionTest(RG, gains, RL, losses) : { z: null, p: null };
    return { RG: RG, RL: RL, PG: PG, PL: PL, pgr: pgr, plr: plr, diff: pgr !== null && plr !== null ? pgr - plr : null, z: test.z, p: test.p, nRealized: RG + RL };
  }

  // ---- 4) Thời gian giữ lệnh lời so với lệnh lỗ, và "bán xong giá đi đâu" ----
  function holding(trades, input, ctx) {
    const sales = PC.replayLedger((input.txns || []).filter(function (t) { return !t.deleted_at; }), (input.actions || []).filter(function (a) { return !a.deleted_at; })).sales;
    const w = [], l = [];
    sales.forEach(function (s) { if (s.shortfall > 1e-9) return; if (s.realizedNet > EPS) w.push(s); else if (s.realizedNet < -EPS) l.push(s); });
    const wavg = function (a) { const q = a.reduce(function (s, x) { return s + x.quantity; }, 0); return q ? a.reduce(function (s, x) { return s + x.avgHoldingDays * x.quantity; }, 0) / q : null; };
    // Bán xong giá đi đâu: giá trị nếu cứ giữ đến nay so với tiền đã bán (dương = bán đã có lợi hơn giữ)
    let impact = 0, n = 0, right = 0, fees = 0;
    trades.forEach(function (t) {
      if (t.type !== 'sell') return;
      fees += t.fee + t.tax;
      const now = ctx.priceAt(t.symbol, ctx.today);
      if (now === null) return;
      const heldValue = t.quantity * now * ctx.mult(t.symbol, t.date, ctx.today);
      const diff = t.quantity * t.price - heldValue;
      impact += diff; n++; if (diff > 0) right++;
    });
    return { winners: { n: w.length, avgDays: wavg(w) }, losers: { n: l.length, avgDays: wavg(l) },
      lossHoldRatio: wavg(w) > 0 && wavg(l) !== null ? wavg(l) / wavg(w) : null, sellImpact: { n: n, valueVnd: impact, rightPct: n ? right / n * 100 : null }, sellCosts: fees };
  }

  // ---- 5) Hiệu chỉnh mức tự tin + quy trình vs kết quả ----
  function decisionsOutcomes(decisions, ctx) {
    const rows = [];
    (decisions || []).forEach(function (raw) {
      const d = raw && 'expected' in raw ? raw : DJ.normalize(raw);
      if (d.action !== 'buy') return;
      const entryDate = d.date;
      const end0 = d.horizonMonths > 0 ? addDays(entryDate, Math.round(d.horizonMonths * 30.4)) : addDays(entryDate, 180);
      const end = end0 > ctx.today ? ctx.today : end0;
      if (daysBetween(entryDate, end) < 30) return;
      const p0 = d.price > 0 ? d.price : ctx.priceAt(d.symbol, entryDate), p1 = ctx.priceAt(d.symbol, end);
      if (!p0 || !p1) return;
      const r = (p1 * ctx.mult(d.symbol, entryDate, end) / p0 - 1) * 100, m = ctx.benchRet(entryDate, end);
      const plan = DJ.planScore(d);
      rows.push({ id: d.id, symbol: d.symbol, date: entryDate, end: end, confidence: d.confidence || null, ret: r, bench: m, alpha: m === null ? null : r - m, planComplete: plan.complete, planScore: plan.score, matured: end0 <= ctx.today });
    });
    const calib = [1, 2, 3, 4, 5].map(function (level) {
      const g = rows.filter(function (r) { return r.confidence === level && r.alpha !== null; });
      return { level: level, n: g.length, avgAlpha: mean(g.map(function (r) { return r.alpha; })), avgReturn: mean(g.map(function (r) { return r.ret; })), beatPct: g.length ? g.filter(function (r) { return r.alpha > 0; }).length / g.length * 100 : null };
    });
    const withConf = rows.filter(function (r) { return r.confidence && r.alpha !== null; });
    const corr = withConf.length >= MIN_N ? spearman(withConf.map(function (r) { return r.confidence; }), withConf.map(function (r) { return r.alpha; })) : null;
    const quad = { goodGood: 0, goodBad: 0, badGood: 0, badBad: 0 };
    rows.filter(function (r) { return r.alpha !== null; }).forEach(function (r) { quad[(r.planComplete ? 'good' : 'bad') + (r.alpha > 0 ? 'Good' : 'Bad')]++; });
    return { rows: rows, calibration: calib, nWithConfidence: withConf.length, confidenceCorr: corr, process: quad, nOutcomes: rows.filter(function (r) { return r.alpha !== null; }).length,
      planCompletePct: rows.length ? rows.filter(function (r) { return r.planComplete; }).length / rows.length * 100 : null };
  }

  // ---- Nhận xét của "huấn luyện viên": chỉ nêu điều đo được, kèm cỡ mẫu và mức chắc chắn ----
  const f1 = (v) => Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
  function coach(m) {
    const out = [];
    const add = function (key, tone, title, evidence, tip, n) { out.push({ key: key, tone: tone, title: title, evidence: evidence, tip: tip || '', n: n, solid: n >= MIN_N * 2 }); };
    const d = m.disposition;
    if (d.nRealized >= 6 && d.diff !== null) {
      if (d.diff >= 0.1 && d.p !== null && d.p < 0.1) add('disposition', 'warn', 'Bạn có xu hướng chốt lời sớm và giữ lệnh lỗ lâu', `Khi có cơ hội, bạn chốt ${f1(d.pgr * 100)}% số lần đang lãi nhưng chỉ cắt ${f1(d.plr * 100)}% số lần đang lỗ (${d.nRealized} lần bán, p≈${f1(d.p)}).`, 'Đặt sẵn ngưỡng cắt lỗ lúc mua và tuân thủ; xem lại lệnh lỗ cũ hằng tháng thay vì chờ "hồi vốn".', d.nRealized);
      else if (d.diff <= -0.1 && d.p !== null && d.p < 0.1) add('disposition-rev', 'good', 'Bạn cắt lỗ kỷ luật hơn chốt lời', `Cắt ${f1(d.plr * 100)}% số lần lỗ so với chốt ${f1(d.pgr * 100)}% số lần lãi (${d.nRealized} lần bán).`, '', d.nRealized);
      else add('disposition-none', 'info', 'Chưa thấy thiên kiến chốt lời/giữ lỗ rõ rệt', `Tỷ lệ chốt lời ${f1(d.pgr * 100)}% so với cắt lỗ ${f1(d.plr * 100)}% (${d.nRealized} lần bán) — chênh lệch chưa đủ để kết luận.`, '', d.nRealized);
    }
    const h = m.holding;
    if (h.winners.n >= 5 && h.losers.n >= 5 && h.lossHoldRatio !== null && h.lossHoldRatio >= 1.3) add('hold-loss', 'warn', 'Lệnh lỗ được giữ lâu hơn lệnh lời', `Trung bình giữ lệnh lỗ ${f1(h.losers.avgDays)} ngày so với ${f1(h.winners.avgDays)} ngày của lệnh lời (${h.losers.n} lệnh lỗ, ${h.winners.n} lệnh lời).`, 'Cắt lỗ dở dang làm tiền mắc kẹt vào mã yếu thay vì mã tốt hơn.', h.losers.n + h.winners.n);
    const c = m.behavior.chase;
    if (c.n >= MIN_N && c.runupSharePct !== null && c.runupSharePct >= 40) {
      const worse = c.runup.avgExcess !== null && c.dip.avgExcess !== null && c.runup.avgExcess < c.dip.avgExcess;
      add('chase', worse ? 'warn' : 'info', 'Nhiều lệnh mua đến sau khi giá đã tăng mạnh', `${f1(c.runupSharePct)}% lệnh mua diễn ra sau khi mã đã tăng từ 10% trong 4 tuần trước${worse ? `; những lệnh đó sau 30 ngày kém thị trường ${f1(Math.abs(c.runup.avgExcess))} điểm, trong khi lệnh mua sau nhịp giảm ${c.dip.avgExcess >= 0 ? 'hơn' : 'kém'} thị trường ${f1(Math.abs(c.dip.avgExcess))} điểm` : ''}.`, worse ? 'Đặt giá mua mong muốn thấp hơn thay vì mua đuổi; dùng danh sách theo dõi với "giá muốn mua".' : '', c.n);
    }
    const p = m.behavior.panic;
    if (p.nAfter >= 3 && p.avgAfter !== null && p.avgAfter >= 5) add('panic', 'warn', 'Một số lệnh bán sau nhịp giảm mạnh rồi giá hồi lại', `${p.nAfter} lệnh bán sau khi mã giảm từ 8% trong 2 tuần; sau 30 ngày các mã đó trung bình ${f1(p.avgAfter)}% (${f1(p.reboundPct)}% hồi từ 5% trở lên).`, 'Nếu bán vì kế hoạch (chạm cắt lỗ) thì đúng; nếu vì hoảng thì hãy chờ 24 giờ trước khi bán sau nhịp giảm lớn.', p.nAfter);
    const t = m.timing.buys[30];
    if (t.nExcess >= MIN_N && t.avgExcess !== null) {
      if (t.avgExcess <= -2) add('timing-bad', 'warn', 'Điểm mua chưa tạo được lợi thế so với thị trường', `Sau 30 ngày, các mã bạn mua trung bình kém VN-Index ${f1(Math.abs(t.avgExcess))} điểm (${t.nExcess} lệnh, ${f1(t.hitPct)}% thắng thị trường).`, 'Mua chia nhỏ nhiều đợt hoặc chờ vùng giá hợp lý theo Định Giá CP có thể giúp.', t.nExcess);
      else if (t.avgExcess >= 2) add('timing-good', 'good', 'Điểm mua của bạn đang tạo lợi thế', `Sau 30 ngày, các mã bạn mua trung bình hơn VN-Index ${f1(t.avgExcess)} điểm (${t.nExcess} lệnh, ${f1(t.hitPct)}% thắng thị trường).`, '', t.nExcess);
    }
    const si = m.holding.sellImpact;
    if (si.n >= 5 && si.valueVnd !== null) {
      if (si.valueVnd < 0) add('sell-early', 'warn', 'Các lệnh bán thường bán trước khi giá tăng tiếp', `Nếu cứ giữ các mã đã bán đến nay, bạn có thêm ${Math.round(Math.abs(si.valueVnd)).toLocaleString('vi-VN')} đ (chỉ ${f1(si.rightPct)}% lệnh bán là đúng, ${si.n} lệnh; chưa tính cổ tức và rủi ro khi giữ).`, '', si.n);
      else add('sell-good', 'good', 'Các lệnh bán nhìn chung đúng thời điểm', `So với việc giữ đến nay, các lệnh bán đã có lợi hơn ${Math.round(si.valueVnd).toLocaleString('vi-VN')} đ (${f1(si.rightPct)}% lệnh bán đúng, ${si.n} lệnh).`, '', si.n);
    }
    const dc = m.decisions;
    if (dc.nWithConfidence >= MIN_N && dc.confidenceCorr !== null) {
      if (dc.confidenceCorr <= 0.1) add('confidence', 'warn', 'Mức tự tin của bạn chưa dự báo được kết quả', `Tương quan hạng giữa mức tự tin và kết quả so với thị trường chỉ ${f1(dc.confidenceCorr)} (${dc.nWithConfidence} quyết định có mức tự tin).`, 'Tự tin cao nên đi cùng nghiên cứu kỹ hơn; đừng dồn tỷ trọng chỉ vì "cảm thấy chắc".', dc.nWithConfidence);
      else if (dc.confidenceCorr >= 0.3) add('confidence-good', 'good', 'Mức tự tin của bạn có giá trị dự báo', `Tương quan hạng giữa mức tự tin và kết quả là ${f1(dc.confidenceCorr)} (${dc.nWithConfidence} quyết định) — có thể mạnh dạn hơn ở các lệnh bạn tự tin nhất.`, '', dc.nWithConfidence);
    }
    if (dc.rows.length >= MIN_N && dc.planCompletePct !== null && dc.planCompletePct < 50) add('plan', 'warn', 'Nhiều lệnh mua thiếu kế hoạch đầy đủ', `Chỉ ${f1(dc.planCompletePct)}% quyết định mua có đủ lý do, giá mục tiêu và ngưỡng cắt lỗ (${dc.rows.length} quyết định).`, 'Ghi kế hoạch ngay lúc đặt lệnh: không có ngưỡng cắt lỗ thì không thể đo kỷ luật của chính mình.', dc.rows.length);
    const order = { warn: 0, info: 2, good: 1 };
    return out.sort(function (a, b) { return (order[a.tone] - order[b.tone]) || (b.n - a.n); });
  }

  // input: { txns, actions, histories ({SYM: [[ngày, giá]], VNINDEX}), bench?, decisions, today }
  function analyze(raw) {
    const input = raw || {};
    const ctx = makeContext(input);
    const trades = normTrades(input.txns);
    const symbols = Array.from(new Set(trades.map(function (t) { return t.symbol; })));
    const missing = symbols.filter(function (s) { return !(ctx.histories[s] && ctx.histories[s].length); });
    const out = { ok: false, reason: null, nTrades: trades.length, nBuys: trades.filter(function (t) { return t.type === 'buy'; }).length, nSells: trades.filter(function (t) { return t.type === 'sell'; }).length,
      firstDate: trades.length ? trades[0].date : null, missingSymbols: missing, hasBench: ctx.bench.length > 0, today: ctx.today };
    if (!trades.length) { out.reason = 'empty'; return out; }
    out.ok = true;
    out.timing = timing(trades, ctx);
    out.behavior = behavior(trades, ctx);
    out.disposition = disposition(trades, ctx);
    out.holding = holding(trades, input, ctx);
    out.decisions = decisionsOutcomes(input.decisions, ctx);
    out.smallSample = trades.length < 20;
    out.findings = coach(out);
    return out;
  }

  return { MIN_N, FWD, analyze, coach, disposition, twoProportionTest, spearman, normCdf, makeContext, normTrades };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DecisionMirror;
