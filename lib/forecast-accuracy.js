// Logic thuần: ĐỘ CHÍNH XÁC DỰ PHÓNG CỦA CHÍNH BẠN -- chấm các dự phóng đã lưu với kết quả thực tế để biết mô hình / người lập nào hay lệch, lệch bao nhiêu và về phía nào.
// Bốn nguồn: (1) giá trị hợp lý đã lưu ở Valuation Bench (từng phương pháp), (2) giá mục tiêu / cắt lỗ của ý tưởng đầu tư, (3) giá kỳ vọng trong nhật ký quyết định, (4) dự phóng lợi nhuận / doanh thu bạn ghi lại.
// Nguyên tắc để không tự dối mình:
//   * Chấm theo GIÁ ĐÃ ĐIỀU CHỈNH (cổ tức tiền, thưởng, chia tách) và SO VỚI VN-INDEX: dự phóng "giá lên" mà cả thị trường lên thì chưa chứng tỏ gì (lợi suất vượt trội = excess).
//   * Chỉ chấm khi đã ĐỦ KỲ (đủ 3 / 6 / 12 tháng hoặc đã đóng ý tưởng); chưa đủ kỳ thì để "đang chờ", không đoán.
//   * Mẫu nhỏ thì nói thẳng: tỷ lệ đúng đi kèm khoảng tin cậy Wilson 95% và nhãn "mẫu nhỏ" dưới MIN_N. Với 5 dự phóng, "đúng 4/5" không chứng minh được gì.
//   * Giá chỉ theo giá đóng cửa, bỏ qua trượt giá và phí; chạm giá mục tiêu / cắt lỗ xét theo giá đóng cửa (không bắt được chạm trong phiên).
// KHÔNG đụng DOM/mạng. Nạp bằng thẻ <script> thường (global ForecastAccuracy) và module.exports cho Vitest.
const ForecastAccuracy = (function () {
  const MIN_N = 10;
  const HORIZONS = [{ key: 'm3', label: '3 tháng', months: 3 }, { key: 'm6', label: '6 tháng', months: 6 }, { key: 'm12', label: '12 tháng', months: 12 }];
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const iso = (v) => String(v || '').slice(0, 10);
  const addMonths = (d, n) => { const x = new Date(iso(d) + 'T00:00:00Z'); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

  // ---------- giá ----------
  // series: [[ngày, giá]] tăng dần. Phiên đầu tiên có ngày >= date (không nhìn lại quá khứ); null nếu không có
  function pointOn(series, date) {
    const d = iso(date), s = series || [];
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (iso(s[m][0]) < d) lo = m + 1; else hi = m; }
    return lo < s.length && num(s[lo][1]) > 0 ? { date: iso(s[lo][0]), price: num(s[lo][1]), i: lo } : null;
  }
  const lastDate = (series) => (series && series.length ? iso(series[series.length - 1][0]) : null);

  // Wilson 95%: khoảng tin cậy của tỷ lệ k/n
  function wilson(k, n) {
    if (!(n > 0)) return { k: k, n: n, p: null, lo: null, hi: null, small: true };
    const z = 1.96, p = k / n, den = 1 + z * z / n, c = (p + z * z / (2 * n)) / den, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
    return { k: k, n: n, p: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h), small: n < MIN_N };
  }
  function ranks(a) {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(a.length);
    for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
    return r;
  }
  // Hệ số tương quan hạng Spearman giữa hai dãy; null nếu < 3 cặp hoặc một dãy không đổi
  function spearman(x, y) {
    if (!x || !y || x.length !== y.length || x.length < 3) return null;
    const rx = ranks(x), ry = ranks(y), mx = mean(rx), my = mean(ry);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < rx.length; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
  }

  // ---------- (1) giá trị hợp lý đã lưu ----------
  // v: { id, symbol, asOf, price (giá lúc lưu, đồng), fairLow, fairBase, fairHigh, methods: [{key, name, base}], userId }
  // series: giá ĐÃ ĐIỀU CHỈNH của mã; bench: VN-Index. Với mỗi kỳ đã đủ trả { ret, benchRet, excess, priceEq, errFair, inRange, closed, hit }.
  //   priceEq = giá lúc lưu x (giá điều chỉnh sau / giá điều chỉnh lúc lưu): giá kỳ vọng "như nếu không có cổ tức/thưởng", để so được với giá trị hợp lý đã lưu.
  //   errFair = priceEq / giá trị hợp lý - 1 (âm: giá vẫn dưới giá trị -> giá trị có thể đã quá lạc quan, hoặc giá chưa hội tụ).
  //   closed  = phần chênh lệch ban đầu đã được thu hẹp ((priceEq - giá lúc lưu) / (fairBase - giá lúc lưu)), bị chặn trong [-2, 2].
  //   hit     = hướng đúng: gap ban đầu > 0 và vượt trội thị trường, hoặc gap < 0 và kém thị trường (bỏ qua khi |gap| < 2%).
  function scoreValuation(v, series, bench, today) {
    const p0 = num(v.price), fb = num(v.fairBase);
    const out = { id: v.id, symbol: v.symbol, userId: v.userId || null, asOf: iso(v.asOf), price: p0, fairBase: fb, gap: p0 > 0 && fb > 0 ? fb / p0 - 1 : null, horizons: {}, scorable: false };
    const a0 = pointOn(series, v.asOf), b0 = pointOn(bench, v.asOf);
    if (!(p0 > 0) || !(fb > 0) || !a0) return out;
    out.scorable = true;
    const last = lastDate(series), t = iso(today || last);
    HORIZONS.forEach((h) => {
      const end = addMonths(v.asOf, h.months);
      if (end > t || !last || end > last) { out.horizons[h.key] = null; return; }
      const a1 = pointOn(series, end), b1 = pointOn(bench, end);
      if (!a1 || !b1 || !b0) { out.horizons[h.key] = null; return; }
      const ret = a1.price / a0.price - 1, benchRet = b1.price / b0.price - 1, priceEq = p0 * a1.price / a0.price;
      const gap = out.gap;
      out.horizons[h.key] = {
        ret: ret, benchRet: benchRet, excess: ret - benchRet, priceEq: priceEq, errFair: priceEq / fb - 1,
        inRange: num(v.fairLow) > 0 && num(v.fairHigh) > 0 ? priceEq >= v.fairLow && priceEq <= v.fairHigh : null,
        closed: Math.abs(fb - p0) / p0 > 0.005 ? Math.max(-2, Math.min(2, (priceEq - p0) / (fb - p0))) : null,
        hit: Math.abs(gap) < 0.02 ? null : (gap > 0 ? ret - benchRet > 0 : ret - benchRet < 0),
      };
    });
    // từng phương pháp: lệch của giá trị cơ sở so với giá kỳ vọng ở kỳ 12 tháng đã đủ (hoặc kỳ dài nhất đã đủ)
    const hk = ['m12', 'm6', 'm3'].find((k) => out.horizons[k]);
    out.methods = hk ? (v.methods || []).filter((m) => num(m.base) > 0).map((m) => ({ key: m.key, name: m.name || m.key, errFair: out.horizons[hk].priceEq / m.base - 1, horizon: hk })) : [];
    return out;
  }

  // ---------- (2) ý tưởng đầu tư ----------
  // idea: { id, symbol, direction, status, entry, target, stop, horizonMonths, conviction, userId, startDate, closedAt, closePrice, closeReason, tags }
  function scoreIdea(idea, series, bench, today) {
    const start = iso(idea.startDate), dirAvoid = idea.direction === 'avoid';
    const out = { id: idea.id, symbol: idea.symbol, userId: idea.userId || null, conviction: num(idea.conviction), direction: dirAvoid ? 'avoid' : 'long', tags: idea.tags || [], matured: false, scorable: false };
    const a0 = pointOn(series, start), b0 = pointOn(bench, start), entry = num(idea.entry) > 0 ? num(idea.entry) : null;
    if (!a0 || !b0) return out;
    const p0 = entry || a0.price, scale = p0 / a0.price;       // quy mọi giá về cùng cơ sở với giá vào lệnh
    out.scorable = true; out.entry = p0; out.expectedRet = num(idea.target) > 0 ? num(idea.target) / p0 - 1 : null;
    const last = lastDate(series), t = iso(today || last);
    const horizonEnd = addMonths(start, Math.max(1, Math.round(num(idea.horizonMonths) || 12)));
    const closed = idea.status === 'closed' && idea.closedAt;
    const end = closed ? iso(idea.closedAt) : horizonEnd;
    if (!closed && (horizonEnd > t || horizonEnd > last)) { out.pendingUntil = horizonEnd; return out; }          // chưa đủ kỳ và chưa đóng: đang chờ
    const a1 = pointOn(series, end) || pointOn(series, last), b1 = pointOn(bench, end) || pointOn(bench, lastDate(bench));
    if (!a1 || !b1) return out;
    out.matured = true; out.end = a1.date;
    const exitPx = closed && num(idea.closePrice) > 0 ? num(idea.closePrice) : a1.price * scale;
    out.ret = exitPx / p0 - 1; out.benchRet = b1.price / b0.price - 1; out.excess = out.ret - out.benchRet;
    // chạm mục tiêu / cắt lỗ theo giá đóng cửa trong cửa sổ [start, end]
    let first = null, hitT = false, hitS = false, daysToTarget = null;
    const tgt = num(idea.target) > 0 ? num(idea.target) : null, stp = num(idea.stop) > 0 ? num(idea.stop) : null;
    for (let i = a0.i; i < series.length && iso(series[i][0]) <= a1.date; i++) {
      const px = num(series[i][1]) * scale; if (!(px > 0)) continue;
      if (!dirAvoid) {
        if (tgt && !hitT && px >= tgt) { hitT = true; daysToTarget = Math.round((Date.parse(iso(series[i][0])) - Date.parse(a0.date)) / 86400000); if (!first) first = 'target'; }
        if (stp && !hitS && px <= stp) { hitS = true; if (!first) first = 'stop'; }
      }
    }
    out.hitTarget = tgt && !dirAvoid ? hitT : null; out.hitStop = stp && !dirAvoid ? hitS : null; out.first = first; out.daysToTarget = daysToTarget;
    // thành công: ý tưởng "mua" -> vượt trội thị trường; ý tưởng "tránh" -> kém thị trường
    out.success = dirAvoid ? out.excess < 0 : out.excess > 0;
    return out;
  }

  // ---------- (3) nhật ký quyết định ----------
  // d: { id, symbol, action: buy|sell|hold|skip, decidedAt, priceAtDecision, expected, stop, horizonMonths, confidence, userId, reviewRating, tags }
  function scoreDecision(d, series, bench, today) {
    const act = d.action, long = act === 'buy' || act === 'hold';
    const out = { id: d.id, symbol: d.symbol, userId: d.userId || null, action: act, confidence: num(d.confidence), tags: d.tags || [], matured: false, scorable: false };
    const a0 = pointOn(series, d.decidedAt), b0 = pointOn(bench, d.decidedAt);
    if (!a0 || !b0) return out;
    const p0 = num(d.priceAtDecision) > 0 ? num(d.priceAtDecision) : a0.price, scale = p0 / a0.price;
    out.scorable = true; out.expectedRet = num(d.expected) > 0 ? num(d.expected) / p0 - 1 : null;
    const last = lastDate(series), t = iso(today || last), end = addMonths(d.decidedAt, Math.max(1, Math.round(num(d.horizonMonths) || 6)));
    if (end > t || end > last) { out.pendingUntil = end; return out; }
    const a1 = pointOn(series, end), b1 = pointOn(bench, end);
    if (!a1 || !b1) return out;
    out.matured = true; out.ret = a1.price * scale / p0 - 1; out.benchRet = b1.price / b0.price - 1; out.excess = out.ret - out.benchRet;
    // quyết định đúng: mua/giữ -> vượt trội thị trường; bán/bỏ qua -> kém thị trường (đã tránh được)
    out.success = long ? out.excess > 0 : out.excess < 0;
    if (out.expectedRet !== null && long) { let hit = false; for (let i = a0.i; i < series.length && iso(series[i][0]) <= a1.date; i++) { if (num(series[i][1]) * scale >= num(d.expected)) { hit = true; break; } } out.hitTarget = hit; }
    return out;
  }

  // ---------- (4) dự phóng lợi nhuận / doanh thu ----------
  // f: { id, symbol, metric: 'lnst'|'revenue', year, quarter (null = cả năm), value (đồng), madeAt, userId }
  // fin: kết quả stock-financials { annual: [{year, lnst, revenue}], quarters: [{year, quarter, lnst, revenue}] }
  function actualOf(f, fin) {
    if (!fin) return null;
    const rows = f.quarter ? (fin.quarters || []).filter((q) => q.year === f.year && q.quarter === f.quarter) : (fin.annual || []).filter((a) => a.year === f.year);
    const v = rows.length ? num(rows[0][f.metric]) : null;
    return v === null ? null : v;
  }
  function scoreEarnings(f, fin) {
    const fc = num(f.value), actual = actualOf(f, fin);
    const out = { id: f.id, symbol: f.symbol, userId: f.userId || null, metric: f.metric, year: f.year, quarter: f.quarter || null, forecast: fc, actual: actual, matured: false };
    if (actual === null || !(fc !== null)) return out;
    out.matured = true;
    // sai số theo phần trăm của |thực tế|; dương = dự phóng cao hơn thực tế (quá lạc quan)
    out.err = Math.abs(actual) > 0 ? (fc - actual) / Math.abs(actual) : null;
    out.ape = out.err === null ? null : Math.abs(out.err);
    out.within10 = out.ape === null ? null : out.ape <= 0.1;
    out.signRight = (fc >= 0) === (actual >= 0);
    return out;
  }

  // ---------- tổng hợp ----------
  const q = (arr) => ({ n: arr.length, mean: mean(arr), median: median(arr) });
  // items đã chấm; key(item) -> nhóm. Trả [{ group, n, ... }]
  function groupBy(items, keyFn) {
    const m = {};
    (items || []).forEach((it) => { const k = keyFn(it); if (k === null || k === undefined) return; (m[k] = m[k] || []).push(it); });
    return Object.keys(m).map((k) => ({ group: k, items: m[k] }));
  }
  // Tóm tắt các giá trị hợp lý đã chấm ở một kỳ: tỷ lệ hướng đúng (Wilson), sai số trung vị (có dấu), tỷ lệ nằm trong dải, tương quan hạng giữa gap ban đầu và lợi suất vượt trội.
  function summarizeValuations(scored, hk) {
    const rows = (scored || []).filter((s) => s.scorable && s.horizons[hk]);
    const hits = rows.filter((s) => s.horizons[hk].hit !== null);
    const inR = rows.filter((s) => s.horizons[hk].inRange !== null);
    const err = rows.map((s) => s.horizons[hk].errFair);
    const rho = spearman(rows.map((s) => s.gap), rows.map((s) => s.horizons[hk].excess));
    return {
      horizon: hk, n: rows.length, direction: wilson(hits.filter((s) => s.horizons[hk].hit).length, hits.length), inRange: wilson(inR.filter((s) => s.horizons[hk].inRange).length, inR.length),
      errMedian: median(err), errMean: mean(err), absErrMedian: median(err.map(Math.abs)), rho: rho, closedMedian: median(rows.map((s) => s.horizons[hk].closed).filter((x) => x !== null)),
      bias: err.length ? (median(err) < -0.05 ? 'optimistic' : (median(err) > 0.05 ? 'pessimistic' : 'balanced')) : null, small: rows.length < MIN_N,
    };
  }
  // Lệch theo từng phương pháp (khoá phương pháp) ở kỳ đã đủ
  function summarizeMethods(scored) {
    const all = [];
    (scored || []).forEach((s) => (s.methods || []).forEach((m) => all.push(m)));
    return groupBy(all, (m) => m.key).map((g) => ({ key: g.group, name: g.items[0].name, n: g.items.length, errMedian: median(g.items.map((x) => x.errFair)), absErrMedian: median(g.items.map((x) => Math.abs(x.errFair))), small: g.items.length < MIN_N }))
      .sort((a, b) => a.absErrMedian - b.absErrMedian);
  }
  // Ý tưởng / quyết định: tỷ lệ thành công, lợi suất vượt trội trung vị, tỷ lệ chạm mục tiêu / cắt lỗ
  function summarizeOutcomes(scored) {
    const rows = (scored || []).filter((s) => s.matured);
    const tg = rows.filter((s) => s.hitTarget !== undefined && s.hitTarget !== null), st = rows.filter((s) => s.hitStop !== undefined && s.hitStop !== null);
    return { n: rows.length, pending: (scored || []).filter((s) => s.scorable && !s.matured).length, success: wilson(rows.filter((s) => s.success).length, rows.length), excessMedian: median(rows.map((s) => s.excess)), retMedian: median(rows.map((s) => s.ret)),
      hitTarget: wilson(tg.filter((s) => s.hitTarget).length, tg.length), hitStop: wilson(st.filter((s) => s.hitStop).length, st.length), small: rows.length < MIN_N };
  }
  // Độ tin cậy có hiệu chỉnh hay không: nhóm theo mức tự tin (1-5): tỷ lệ thành công của từng mức. Mức tự tin cao mà không đúng hơn mức thấp là dấu hiệu tự tin thái quá.
  function calibration(scored, levelKey) {
    return groupBy((scored || []).filter((s) => s.matured && num(s[levelKey]) !== null), (s) => num(s[levelKey]))
      .map((g) => Object.assign({ level: Number(g.group) }, wilson(g.items.filter((s) => s.success).length, g.items.length))).sort((a, b) => a.level - b.level);
  }
  function summarizeEarnings(scored) {
    const rows = (scored || []).filter((s) => s.matured && s.err !== null);
    return { n: rows.length, pending: (scored || []).filter((s) => !s.matured).length, errMedian: median(rows.map((s) => s.err)), apeMedian: median(rows.map((s) => s.ape)), within10: wilson(rows.filter((s) => s.within10).length, rows.length),
      bias: rows.length ? (median(rows.map((s) => s.err)) > 0.05 ? 'optimistic' : (median(rows.map((s) => s.err)) < -0.05 ? 'pessimistic' : 'balanced')) : null, small: rows.length < MIN_N };
  }

  return { MIN_N, HORIZONS, addMonths, pointOn, wilson, spearman, scoreValuation, scoreIdea, scoreDecision, actualOf, scoreEarnings, groupBy, summarizeValuations, summarizeMethods, summarizeOutcomes, calibration, summarizeEarnings };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ForecastAccuracy;
