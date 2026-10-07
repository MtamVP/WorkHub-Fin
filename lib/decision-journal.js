// Logic thuần của Nhật Ký Quyết Định (không đụng DOM/Supabase): điểm kế hoạch, đánh giá kết quả theo đường giá
// (chạm mục tiêu / chạm cắt lỗ / hết hạn), so với VN-Index, tổng hợp theo kỳ, gợi ý kế hoạch từ Định Giá CP.
// Nạp bằng thẻ <script> thường (global DecisionJournal) và module.exports cho Vitest -- cùng kiểu lib/portfolio-calc.js.
//
// Nguyên tắc: nhật ký đo QUY TRÌNH (có ghi lý do, mục tiêu, cắt lỗ, thời hạn ngay lúc quyết định hay không) tách khỏi KẾT QUẢ
// (giá sau đó đi thế nào). Quyết định tốt vẫn có thể thua, quyết định tệ vẫn có thể thắng -- hai chỉ số không được trộn làm một.
const DecisionJournal = (function () {
  const ACTIONS = {
    buy:  { label: 'Mua', icon: 'fa-arrow-down' },
    sell: { label: 'Bán', icon: 'fa-arrow-up' },
    hold: { label: 'Giữ', icon: 'fa-hand' },
    skip: { label: 'Bỏ qua', icon: 'fa-ban' },
  };
  // Quyết định BÁN / BỎ QUA: giá sau đó chênh từ mức này mới coi là "bán sớm/bỏ lỡ" hoặc "bán đúng/né được"
  const ALERT_TAG = 'cảnh báo giá';   // thẻ tự gắn khi quyết định bắt đầu từ một cảnh báo giá (lib/alert-review.js)
  const AFTER_THRESHOLD_PCT = 10;
  const DEFAULT_STOP_PCT = 10;     // gợi ý cắt lỗ mặc định: 10% dưới giá quyết định
  const DEFAULT_HORIZON_MONTHS = 12;

  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const opt = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const round = (v, d) => { if (v === null || v === undefined || !isFinite(v)) return null; const f = Math.pow(10, d === undefined ? 2 : d); return Math.round(v * f) / f; };

  function dateDiffDays(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
  function addMonths(iso, months) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  }

  // Dòng DB -> dạng chuẩn dùng trong app
  function normalize(row) {
    const r = row || {};
    return {
      id: r.id || null, symbol: String(r.symbol || '').toUpperCase(), action: ACTIONS[r.action] ? r.action : 'buy',
      date: String(r.decided_at || r.date || '').slice(0, 10), price: opt(r.price_at_decision !== undefined ? r.price_at_decision : r.price),
      quantity: opt(r.quantity), reason: r.reason ? String(r.reason) : '', expected: opt(r.expected_price !== undefined ? r.expected_price : r.expected),
      stop: opt(r.stop_price !== undefined ? r.stop_price : r.stop), horizonMonths: opt(r.horizon_months !== undefined ? r.horizon_months : r.horizonMonths),
      confidence: opt(r.confidence), tags: Array.isArray(r.tags) ? r.tags.slice() : [], valuation: r.valuation || null,
      txnId: r.txn_id || r.txnId || null,
      review: r.review_date || r.review_rating || r.review_note || r.lesson
        ? { date: r.review_date || null, rating: opt(r.review_rating), note: r.review_note || '', lesson: r.lesson || '' } : null,
      createdAt: r.created_at || null,
    };
  }

  // Điểm kế hoạch 0-100 theo từng loại quyết định + danh sách phần còn thiếu. complete = đủ phần BẮT BUỘC.
  const PLAN_WEIGHTS = {
    buy:  { reason: 30, expected: 25, stop: 25, horizon: 10, context: 10 },
    sell: { reason: 60, expected: 20, context: 20 },
    hold: { reason: 70, expected: 15, context: 15 },
    skip: { reason: 70, expected: 15, context: 15 },
  };
  const PLAN_LABELS = {
    buy:  { reason: 'lý do', expected: 'giá mục tiêu', stop: 'ngưỡng cắt lỗ', horizon: 'thời hạn', context: 'định giá hoặc mức tự tin' },
    sell: { reason: 'lý do', expected: 'giá cân nhắc mua lại', context: 'định giá hoặc mức tự tin' },
    hold: { reason: 'lý do', expected: 'giá kỳ vọng', context: 'định giá hoặc mức tự tin' },
    skip: { reason: 'lý do', expected: 'giá sẽ mua nếu giảm tới', context: 'định giá hoặc mức tự tin' },
  };
  function planScore(d) {
    const x = d && d.action && d.symbol !== undefined && 'expected' in d ? d : normalize(d);
    const w = PLAN_WEIGHTS[x.action] || PLAN_WEIGHTS.buy;
    const has = {
      reason: String(x.reason || '').trim().length >= 10,
      expected: x.expected > 0, stop: x.stop > 0, horizon: x.horizonMonths > 0,
      context: !!x.valuation || x.confidence > 0,
    };
    let score = 0;
    const missing = [];
    Object.keys(w).forEach(k => { if (has[k]) score += w[k]; else missing.push(PLAN_LABELS[x.action][k]); });
    const complete = x.action === 'buy' ? has.reason && has.expected && has.stop : has.reason;
    return { score, missing, complete };
  }

  function priceAtOrBefore(series, date) {
    let best = null;
    for (let i = 0; i < series.length; i++) { if (series[i][0] <= date) best = num(series[i][1]); else break; }
    return best;
  }

  const STATUS_LABEL = {
    target_hit: 'Đã chạm mục tiêu', stop_hit: 'Đã chạm cắt lỗ', expired: 'Hết hạn chưa chạm', open: 'Đang theo dõi',
    sold_early: 'Bán sớm', sold_well: 'Bán đúng', missed: 'Bỏ lỡ', avoided: 'Né được', neutral: 'Trung tính', nodata: 'Chưa có giá',
  };
  const STATUS_TONE = {
    target_hit: 'good', stop_hit: 'bad', expired: 'warn', open: 'neutral', sold_early: 'warn', sold_well: 'good', missed: 'warn', avoided: 'good', neutral: 'neutral', nodata: 'neutral',
  };

  // Đánh giá 1 quyết định theo đường giá sau ngày quyết định.
  // ctx: { series: [[YYYY-MM-DD, giá]] tăng dần, today: 'YYYY-MM-DD', nowPrice?: giá hiện tại (mặc định = giá cuối chuỗi), bench?: [[ngày, điểm VN-Index]] }
  function evaluate(decision, ctx) {
    const d = decision && 'expected' in decision ? decision : normalize(decision);
    const c = ctx || {};
    const series = (c.series || []).filter(r => r && num(r[1]) > 0).slice().sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const today = c.today || (series.length ? series[series.length - 1][0] : d.date);
    const path = series.filter(r => r[0] >= d.date && r[0] <= today);
    const entry = d.price > 0 ? d.price : (priceAtOrBefore(series, d.date) || (path.length ? num(path[0][1]) : null));
    const base = { status: 'nodata', label: STATUS_LABEL.nodata, tone: 'neutral', entry: entry || null, now: null, returnPct: null, peakPct: null, troughPct: null, benchPct: null, alphaPct: null, hitDate: null, hitDays: null, daysHeld: null, horizonEnd: null, progressPct: null, afterPct: null };
    if (!(entry > 0) || !path.length) return base;

    const now = c.nowPrice > 0 ? c.nowPrice : num(path[path.length - 1][1]);
    const out = Object.assign(base, { now, returnPct: (now / entry - 1) * 100, daysHeld: Math.max(0, dateDiffDays(d.date, today)) });
    const closes = path.map(r => num(r[1]));
    out.peakPct = (Math.max.apply(null, closes) / entry - 1) * 100;
    out.troughPct = (Math.min.apply(null, closes) / entry - 1) * 100;

    if (c.bench && c.bench.length) {
      const b0 = priceAtOrBefore(c.bench, d.date) || num((c.bench.find(r => r[0] >= d.date) || [0, 0])[1]);
      const b1 = priceAtOrBefore(c.bench, today);
      if (b0 > 0 && b1 > 0) { out.benchPct = (b1 / b0 - 1) * 100; out.alphaPct = out.returnPct - out.benchPct; }
    }

    if (d.action === 'sell' || d.action === 'skip') {
      out.afterPct = out.returnPct;   // giá sau quyết định: tăng = bán sớm / bỏ lỡ, giảm = bán đúng / né được
      const up = out.afterPct >= AFTER_THRESHOLD_PCT, down = out.afterPct <= -AFTER_THRESHOLD_PCT;
      out.status = d.action === 'sell' ? (up ? 'sold_early' : (down ? 'sold_well' : 'neutral')) : (up ? 'missed' : (down ? 'avoided' : 'neutral'));
    } else {
      // MUA / GIỮ: ngày ĐẦU TIÊN chạm mục tiêu hoặc cắt lỗ (theo giá đóng cửa), cái nào tới trước thì tính
      let target = null, stop = null;
      for (let i = 0; i < path.length; i++) {
        const px = num(path[i][1]);
        if (!target && d.expected > 0 && px >= d.expected) target = path[i][0];
        if (!stop && d.stop > 0 && px <= d.stop) stop = path[i][0];
        if (target && stop) break;
      }
      const horizonEnd = d.horizonMonths > 0 ? addMonths(d.date, d.horizonMonths) : null;
      out.horizonEnd = horizonEnd;
      if (target && (!stop || target <= stop)) { out.status = 'target_hit'; out.hitDate = target; }
      else if (stop) { out.status = 'stop_hit'; out.hitDate = stop; }
      else if (horizonEnd && today > horizonEnd) out.status = 'expired';
      else out.status = 'open';
      if (out.hitDate) out.hitDays = dateDiffDays(d.date, out.hitDate);
      if (d.expected > entry) out.progressPct = (now - entry) / (d.expected - entry) * 100;
    }
    out.label = STATUS_LABEL[out.status];
    out.tone = STATUS_TONE[out.status];
    return out;
  }

  // Tổng hợp nhiều quyết định (đã normalize) + kết quả đánh giá tương ứng (evals[i] ứng với list[i], có thể thiếu).
  function summarize(list, evals) {
    const items = list || [];
    const ev = evals || [];
    const scores = items.map(planScore);
    const out = {
      total: items.length, byAction: { buy: 0, sell: 0, hold: 0, skip: 0 },
      planAvg: items.length ? scores.reduce((s, x) => s + x.score, 0) / items.length : null,
      fullPlanCount: scores.filter(x => x.complete).length, fullPlanPct: items.length ? scores.filter(x => x.complete).length / items.length * 100 : null,
      evaluated: 0, targetHit: 0, stopHit: 0, expired: 0, open: 0, soldEarly: 0, soldWell: 0, missed: 0, avoided: 0,
      buyEvaluated: 0, buyWins: 0, winRatePct: null, avgReturnPct: null, avgAlphaPct: null, reviewed: 0, avgRating: null,
      alertDriven: items.filter((d) => (d.tags || []).indexOf(ALERT_TAG) >= 0).length,        // quyết định ghi từ cảnh báo giá (nút "Ghi quyết định" ở Danh Mục / Ôn lại cảnh báo)
    };
    let retSum = 0, retN = 0, alphaSum = 0, alphaN = 0, ratingSum = 0;
    items.forEach((d, i) => {
      out.byAction[d.action] = (out.byAction[d.action] || 0) + 1;
      if (d.review) { out.reviewed++; if (d.review.rating) ratingSum += d.review.rating; }
      const e = ev[i];
      if (!e || e.status === 'nodata') return;
      out.evaluated++;
      const key = { target_hit: 'targetHit', stop_hit: 'stopHit', expired: 'expired', open: 'open', sold_early: 'soldEarly', sold_well: 'soldWell', missed: 'missed', avoided: 'avoided' }[e.status];
      if (key) out[key]++;
      if (d.action === 'buy') {
        out.buyEvaluated++;
        if (e.returnPct > 0) out.buyWins++;
        retSum += e.returnPct; retN++;
        if (e.alphaPct !== null) { alphaSum += e.alphaPct; alphaN++; }
      }
    });
    out.winRatePct = out.buyEvaluated ? out.buyWins / out.buyEvaluated * 100 : null;
    out.avgReturnPct = retN ? retSum / retN : null;
    out.avgAlphaPct = alphaN ? alphaSum / alphaN : null;
    out.avgRating = out.reviewed && ratingSum ? ratingSum / items.filter(d => d.review && d.review.rating).length : null;
    return out;
  }

  // Ảnh chụp định giá lúc quyết định (lưu kèm để sau này biết lúc đó ta đã thấy gì). a = kết quả ValuationCalc.analyze.
  function snapshotFrom(a, year) {
    if (!a || !a.v || !(a.v.fair > 0)) return null;
    return {
      year: year || null, fair: round(a.v.fair, 0), bear: round(a.v.fairBear, 0), bull: round(a.v.fairBull, 0),
      verdict: a.verdict ? a.verdict.key : null, pe: round(a.m.pe, 2), pb: round(a.m.pb, 2), roe: round(a.m.roe, 1), price: a.price > 0 ? round(a.price, 0) : null,
    };
  }

  // Gợi ý kế hoạch từ Định Giá CP. MUA: mục tiêu = giá hợp lý (nếu cao hơn giá ≥ 3%) hoặc kịch bản tốt; cắt lỗ = 10% dưới giá.
  // BÁN/BỎ QUA/GIỮ: kỳ vọng = giá hợp lý (mức giá nên cân nhắc mua lại / mua nếu giảm tới).
  function suggestPlan(action, price, snapshot) {
    const p = num(price);
    const s = snapshot || null;
    const out = { expected: null, stop: null, horizonMonths: null };
    if (!s || !(s.fair > 0)) {
      if (action === 'buy' && p > 0) { out.stop = Math.round(p * (1 - DEFAULT_STOP_PCT / 100)); out.horizonMonths = DEFAULT_HORIZON_MONTHS; }
      return out;
    }
    if (action === 'buy') {
      out.expected = p > 0 && s.fair >= p * 1.03 ? s.fair : (s.bull > p ? s.bull : s.fair);
      if (p > 0) out.stop = Math.round(p * (1 - DEFAULT_STOP_PCT / 100));
      out.horizonMonths = DEFAULT_HORIZON_MONTHS;
    } else {
      out.expected = s.fair;
    }
    return out;
  }

  // Kiểm tra dữ liệu trước khi lưu; trả { ok, error, row } với row đúng cột DB (chưa có user_id).
  function validate(input) {
    const i = input || {};
    const symbol = String(i.symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return { ok: false, error: 'Mã không hợp lệ' };
    const action = ACTIONS[i.action] ? i.action : null;
    if (!action) return { ok: false, error: 'Chọn hành động (Mua, Bán, Giữ hoặc Bỏ qua)' };
    const date = String(i.date || i.decidedAt || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Ngày quyết định không hợp lệ' };
    const pos = (v, label) => { const n = opt(v); if (n !== null && !(n > 0)) throw new Error(label + ' phải lớn hơn 0'); return n; };
    try {
      const price = pos(i.price, 'Giá'), quantity = pos(i.quantity, 'Khối lượng'), expected = pos(i.expected, 'Giá mục tiêu'), stop = pos(i.stop, 'Ngưỡng cắt lỗ');
      const horizon = opt(i.horizonMonths);
      if (horizon !== null && !(horizon >= 1 && horizon <= 120)) return { ok: false, error: 'Thời hạn từ 1 đến 120 tháng' };
      const confidence = opt(i.confidence);
      if (confidence !== null && !(confidence >= 1 && confidence <= 5)) return { ok: false, error: 'Mức tự tin từ 1 đến 5' };
      if (action === 'buy' && price && stop && stop >= price) return { ok: false, error: 'Với lệnh mua, ngưỡng cắt lỗ phải thấp hơn giá mua' };
      if (action === 'buy' && price && expected && expected <= price) return { ok: false, error: 'Với lệnh mua, giá mục tiêu phải cao hơn giá mua' };
      const tags = (Array.isArray(i.tags) ? i.tags : String(i.tags || '').split(',')).map(t => String(t).trim().toLowerCase()).filter(Boolean);
      return {
        ok: true, error: null,
        row: {
          symbol, action, decided_at: date, price_at_decision: price, quantity, reason: i.reason ? String(i.reason).trim().slice(0, 1000) : null,
          expected_price: expected, stop_price: stop, horizon_months: horizon, confidence, tags: [...new Set(tags)].slice(0, 8),
          valuation: i.valuation || null, txn_id: i.txnId || null,
        },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return {
    ACTIONS, STATUS_LABEL, STATUS_TONE, AFTER_THRESHOLD_PCT, DEFAULT_STOP_PCT, DEFAULT_HORIZON_MONTHS,
    normalize, planScore, evaluate, summarize, snapshotFrom, suggestPlan, validate, addMonths, dateDiffDays, priceAtOrBefore,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DecisionJournal;
