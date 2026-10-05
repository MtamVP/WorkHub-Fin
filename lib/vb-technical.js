// Logic thuần của VALUATION BENCH: PHÂN TÍCH KỸ THUẬT trên nến ngày (mở, cao, thấp, đóng, khối lượng) -- bộ chỉ báo đầy đủ và cách đọc có quy tắc rõ ràng:
//   * Xu hướng: SMA/EMA (20/50/100/200), ADX và +DI/−DI, Ichimoku, Supertrend, Parabolic SAR, Aroon, giao cắt vàng/chết
//   * Động lượng: RSI (Wilder), MACD, Stochastic, StochRSI, CCI, Williams %R, ROC, phân kỳ RSI-giá
//   * Khối lượng/dòng tiền: OBV, MFI, CMF, A/D, VWAP trượt 20 phiên, tỷ lệ khối lượng
//   * Biến động: ATR, Bollinger (%B, độ rộng, nén), Keltner, Donchian, biến động lịch sử (annualized), sụt giảm từ đỉnh
//   * Mức giá: điểm xoay (cổ điển/Fibonacci, ngày-tuần-tháng), thoái lui và mở rộng Fibonacci, hỗ trợ/kháng cự theo cụm các đỉnh đáy swing, vị trí trong biên độ 52 tuần
//   * Mẫu nến (doji, búa, sao băng, nhấn chìm, sao mai/sao hôm, ba chàng lính trắng/ba con quạ đen) và nhận định bứt phá khỏi dải nén
//   * Sức mạnh tương đối so với chỉ số (VN-Index) theo 1/3/6 tháng và độ dốc đường RS
//   * Điểm kỹ thuật tổng hợp −100..+100 theo 4 nhóm (xu hướng 40, động lượng 30, dòng tiền 15, vị thế 15), mỗi tín hiệu kèm số liệu để người dùng tự kiểm.
// Phân tích kỹ thuật mô tả hành vi giá đã xảy ra, KHÔNG dự đoán chắc chắn: tín hiệu thường nhiễu trên mã kém thanh khoản và các chỉ báo tương quan với nhau (đếm nhiều tín hiệu cùng hướng không làm xác suất tăng theo cấp số nhân).
// Nến cổ phiếu Việt Nam: giá nguồn VNDirect đã điều chỉnh cổ tức/chia tách (khối lượng thì không), nên đừng so khối lượng qua các mốc chia tách. KHÔNG đụng DOM/mạng/Supabase.
// Nạp bằng thẻ <script> thường (global VBTechnical) và module.exports cho Vitest.
const VBTechnical = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const nan = () => null;
  const fill = (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = null; return a; };
  const last = (a) => (a && a.length ? a[a.length - 1] : null);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // ---------- chỉ báo cơ bản ----------
  function sma(x, n) {
    const out = fill(x.length); let s = 0, cnt = 0;
    for (let i = 0; i < x.length; i++) {
      if (x[i] === null) { s = 0; cnt = 0; continue; }
      s += x[i]; cnt++;
      if (cnt > n) s -= x[i - n];
      if (cnt >= n) out[i] = s / n;
    }
    return out;
  }
  function ema(x, n) {
    const out = fill(x.length), k = 2 / (n + 1); let prev = null, seed = [];
    for (let i = 0; i < x.length; i++) {
      if (x[i] === null) continue;
      if (prev === null) { seed.push(x[i]); if (seed.length === n) { prev = seed.reduce(function (a, b) { return a + b; }, 0) / n; out[i] = prev; } continue; }
      prev = x[i] * k + prev * (1 - k); out[i] = prev;
    }
    return out;
  }
  function wilder(x, n) {            // làm mượt Wilder: seed = trung bình n điểm đầu, sau đó (prev × (n−1) + x) / n
    const out = fill(x.length); let prev = null, seed = [];
    for (let i = 0; i < x.length; i++) {
      if (x[i] === null) continue;
      if (prev === null) { seed.push(x[i]); if (seed.length === n) { prev = seed.reduce(function (a, b) { return a + b; }, 0) / n; out[i] = prev; } continue; }
      prev = (prev * (n - 1) + x[i]) / n; out[i] = prev;
    }
    return out;
  }
  function stdev(x, n) {
    const out = fill(x.length);
    for (let i = n - 1; i < x.length; i++) {
      let s = 0, ok = true; for (let j = i - n + 1; j <= i; j++) { if (x[j] === null) { ok = false; break; } s += x[j]; }
      if (!ok) continue; const m = s / n; let v = 0; for (let j = i - n + 1; j <= i; j++) v += (x[j] - m) * (x[j] - m);
      out[i] = Math.sqrt(v / n);
    }
    return out;
  }
  function highest(x, n) { const out = fill(x.length); for (let i = n - 1; i < x.length; i++) { let m = -Infinity; for (let j = i - n + 1; j <= i; j++) if (x[j] !== null && x[j] > m) m = x[j]; out[i] = m === -Infinity ? null : m; } return out; }
  function lowest(x, n) { const out = fill(x.length); for (let i = n - 1; i < x.length; i++) { let m = Infinity; for (let j = i - n + 1; j <= i; j++) if (x[j] !== null && x[j] < m) m = x[j]; out[i] = m === Infinity ? null : m; } return out; }

  function rsi(c, n) {
    n = n || 14; const out = fill(c.length); let g = fill(c.length), l = fill(c.length);
    for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g[i] = d > 0 ? d : 0; l[i] = d < 0 ? -d : 0; }
    const ag = wilder(g.slice(1), n), al = wilder(l.slice(1), n);
    for (let i = 1; i < c.length; i++) { const a = ag[i - 1], b = al[i - 1]; if (a === null || b === null) continue; out[i] = b === 0 ? (a === 0 ? 50 : 100) : 100 - 100 / (1 + a / b); }
    return out;
  }
  function macd(c, fast, slow, sig) {
    fast = fast || 12; slow = slow || 26; sig = sig || 9;
    const ef = ema(c, fast), es = ema(c, slow), line = c.map(function (_, i) { return ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null; });
    const signal = ema(line, sig), hist = line.map(function (v, i) { return v !== null && signal[i] !== null ? v - signal[i] : null; });
    return { line: line, signal: signal, hist: hist };
  }
  function trueRange(h, l, c) { return h.map(function (_, i) { return i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); }); }
  function atr(h, l, c, n) { return wilder(trueRange(h, l, c), n || 14); }
  function stochastic(h, l, c, n, k, d) {
    n = n || 14; k = k || 3; d = d || 3;
    const hh = highest(h, n), ll = lowest(l, n), fast = c.map(function (_, i) { return hh[i] !== null && hh[i] !== ll[i] ? (c[i] - ll[i]) / (hh[i] - ll[i]) * 100 : null; });
    const slowK = sma(fast, k), slowD = sma(slowK, d);
    return { fastK: fast, k: slowK, d: slowD };
  }
  function cci(h, l, c, n) {
    n = n || 20; const tp = c.map(function (_, i) { return (h[i] + l[i] + c[i]) / 3; }), m = sma(tp, n), out = fill(c.length);
    for (let i = n - 1; i < c.length; i++) { let md = 0; for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]); md /= n; out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md); }
    return out;
  }
  function williamsR(h, l, c, n) { n = n || 14; const hh = highest(h, n), ll = lowest(l, n); return c.map(function (_, i) { return hh[i] !== null && hh[i] !== ll[i] ? (hh[i] - c[i]) / (hh[i] - ll[i]) * -100 : null; }); }
  function roc(c, n) { return c.map(function (v, i) { return i >= n && c[i - n] > 0 ? (v / c[i - n] - 1) * 100 : null; }); }
  function adx(h, l, c, n) {
    n = n || 14; const len = c.length, pdm = fill(len), mdm = fill(len), tr = trueRange(h, l, c);
    for (let i = 1; i < len; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; pdm[i] = up > dn && up > 0 ? up : 0; mdm[i] = dn > up && dn > 0 ? dn : 0; }
    const trS = wilder(tr.slice(1), n), pS = wilder(pdm.slice(1), n), mS = wilder(mdm.slice(1), n), pdi = fill(len), mdi = fill(len), dx = fill(len), out = fill(len);
    for (let i = 1; i < len; i++) { const t = trS[i - 1]; if (t === null || t === 0) continue; pdi[i] = pS[i - 1] / t * 100; mdi[i] = mS[i - 1] / t * 100; const s = pdi[i] + mdi[i]; dx[i] = s === 0 ? 0 : Math.abs(pdi[i] - mdi[i]) / s * 100; }
    const sm = wilder(dx.slice(1), n);
    for (let i = 1; i < len; i++) out[i] = sm[i - 1];
    return { adx: out, pdi: pdi, mdi: mdi };
  }
  function bollinger(c, n, k) {
    n = n || 20; k = k || 2; const m = sma(c, n), sd = stdev(c, n);
    const up = c.map(function (_, i) { return m[i] !== null ? m[i] + k * sd[i] : null; }), lo = c.map(function (_, i) { return m[i] !== null ? m[i] - k * sd[i] : null; });
    return { mid: m, upper: up, lower: lo, pctB: c.map(function (v, i) { return up[i] !== null && up[i] !== lo[i] ? (v - lo[i]) / (up[i] - lo[i]) : null; }), width: c.map(function (_, i) { return m[i] ? (up[i] - lo[i]) / m[i] : null; }) };
  }
  function keltner(h, l, c, n, mult) { n = n || 20; mult = mult || 1.5; const m = ema(c, n), a = atr(h, l, c, n); return { mid: m, upper: m.map(function (v, i) { return v !== null && a[i] !== null ? v + mult * a[i] : null; }), lower: m.map(function (v, i) { return v !== null && a[i] !== null ? v - mult * a[i] : null; }) }; }
  function donchian(h, l, n) { n = n || 20; const u = highest(h, n), d = lowest(l, n); return { upper: u, lower: d, mid: u.map(function (v, i) { return v !== null ? (v + d[i]) / 2 : null; }) }; }
  function obv(c, v) { const out = fill(c.length); let s = 0; out[0] = 0; for (let i = 1; i < c.length; i++) { s += c[i] > c[i - 1] ? v[i] : (c[i] < c[i - 1] ? -v[i] : 0); out[i] = s; } return out; }
  function moneyFlowMult(h, l, c) { return c.map(function (_, i) { return h[i] === l[i] ? 0 : ((c[i] - l[i]) - (h[i] - c[i])) / (h[i] - l[i]); }); }
  function adLine(h, l, c, v) { const m = moneyFlowMult(h, l, c), out = fill(c.length); let s = 0; for (let i = 0; i < c.length; i++) { s += m[i] * v[i]; out[i] = s; } return out; }
  function cmf(h, l, c, v, n) { n = n || 20; const m = moneyFlowMult(h, l, c), out = fill(c.length); for (let i = n - 1; i < c.length; i++) { let a = 0, b = 0; for (let j = i - n + 1; j <= i; j++) { a += m[j] * v[j]; b += v[j]; } out[i] = b > 0 ? a / b : null; } return out; }
  function mfi(h, l, c, v, n) {
    n = n || 14; const tp = c.map(function (_, i) { return (h[i] + l[i] + c[i]) / 3; }), out = fill(c.length);
    for (let i = n; i < c.length; i++) { let pos = 0, neg = 0; for (let j = i - n + 1; j <= i; j++) { const f = tp[j] * v[j]; if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f; } out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg); }
    return out;
  }
  function vwapRolling(h, l, c, v, n) { n = n || 20; const out = fill(c.length); for (let i = n - 1; i < c.length; i++) { let pv = 0, vv = 0; for (let j = i - n + 1; j <= i; j++) { pv += (h[j] + l[j] + c[j]) / 3 * v[j]; vv += v[j]; } out[i] = vv > 0 ? pv / vv : null; } return out; }
  function aroon(h, l, n) {
    n = n || 25; const up = fill(h.length), dn = fill(h.length);
    for (let i = n; i < h.length; i++) { let hi = i - n, lo = i - n; for (let j = i - n; j <= i; j++) { if (h[j] >= h[hi]) hi = j; if (l[j] <= l[lo]) lo = j; } up[i] = (n - (i - hi)) / n * 100; dn[i] = (n - (i - lo)) / n * 100; }
    return { up: up, down: dn };
  }
  function psar(h, l, step, maxStep) {
    step = step || 0.02; maxStep = maxStep || 0.2; const n = h.length, out = fill(n), dir = fill(n);
    if (n < 3) return { sar: out, dir: dir };
    let up = h[1] + l[1] > h[0] + l[0], af = step, ep = up ? h[1] : l[1], sar = up ? l[0] : h[0];
    out[1] = sar; dir[1] = up ? 1 : -1;
    for (let i = 2; i < n; i++) {
      sar = sar + af * (ep - sar);
      if (up) { sar = Math.min(sar, l[i - 1], l[i - 2]); if (l[i] < sar) { up = false; sar = ep; ep = l[i]; af = step; } else if (h[i] > ep) { ep = h[i]; af = Math.min(maxStep, af + step); } }
      else { sar = Math.max(sar, h[i - 1], h[i - 2]); if (h[i] > sar) { up = true; sar = ep; ep = h[i]; af = step; } else if (l[i] < ep) { ep = l[i]; af = Math.min(maxStep, af + step); } }
      out[i] = sar; dir[i] = up ? 1 : -1;
    }
    return { sar: out, dir: dir };
  }
  function supertrend(h, l, c, n, mult) {
    n = n || 10; mult = mult || 3; const a = atr(h, l, c, n), len = c.length, line = fill(len), dir = fill(len); let fub = null, flb = null, d = 1;
    for (let i = 0; i < len; i++) {
      if (a[i] === null) continue; const hl2 = (h[i] + l[i]) / 2, ub = hl2 + mult * a[i], lb = hl2 - mult * a[i];
      if (fub === null) { fub = ub; flb = lb; d = c[i] >= hl2 ? 1 : -1; } else {
        fub = (ub < fub || c[i - 1] > fub) ? ub : fub; flb = (lb > flb || c[i - 1] < flb) ? lb : flb;
        if (d === 1 && c[i] < flb) d = -1; else if (d === -1 && c[i] > fub) d = 1;
      }
      dir[i] = d; line[i] = d === 1 ? flb : fub;
    }
    return { line: line, dir: dir };
  }
  function ichimoku(h, l, c) {
    const hh26 = highest(h, 26), ll26 = lowest(l, 26), hh52 = highest(h, 52), ll52 = lowest(l, 52), hh9 = highest(h, 9), ll9 = lowest(l, 9);
    const tenkan = c.map(function (_, i) { return hh9[i] !== null ? (hh9[i] + ll9[i]) / 2 : null; }), kijun = c.map(function (_, i) { return hh26[i] !== null ? (hh26[i] + ll26[i]) / 2 : null; });
    const spanA = c.map(function (_, i) { return tenkan[i] !== null && kijun[i] !== null ? (tenkan[i] + kijun[i]) / 2 : null; }), spanB = c.map(function (_, i) { return hh52[i] !== null ? (hh52[i] + ll52[i]) / 2 : null; });
    // mây tại chỉ số i là giá trị tính từ 26 phiên trước
    const cloudA = c.map(function (_, i) { return i >= 26 ? spanA[i - 26] : null; }), cloudB = c.map(function (_, i) { return i >= 26 ? spanB[i - 26] : null; });
    return { tenkan: tenkan, kijun: kijun, spanA: spanA, spanB: spanB, cloudA: cloudA, cloudB: cloudB };
  }
  function logReturns(c) { return c.map(function (v, i) { return i && c[i - 1] > 0 && v > 0 ? Math.log(v / c[i - 1]) : null; }); }
  function histVol(c, n) { n = n || 20; const r = logReturns(c), s = stdev(r, n); return s.map(function (v) { return v === null ? null : v * Math.sqrt(252) * Math.sqrt(n / (n - 1)); }); }
  function drawdown(c) { let peak = -Infinity; return c.map(function (v) { if (v > peak) peak = v; return peak > 0 ? v / peak - 1 : null; }); }

  // ---------- mức giá ----------
  function pivotsOf(h, l, c) {
    const P = (h + l + c) / 3, r = h - l;
    return { classic: { p: P, r1: 2 * P - l, s1: 2 * P - h, r2: P + r, s2: P - r, r3: h + 2 * (P - l), s3: l - 2 * (h - P) }, fibonacci: { p: P, r1: P + 0.382 * r, r2: P + 0.618 * r, r3: P + r, s1: P - 0.382 * r, s2: P - 0.618 * r, s3: P - r } };
  }
  function swings(h, l, n) {
    n = n || 5; const highs = [], lows = [];
    for (let i = n; i < h.length - n; i++) {
      let isH = true, isL = true;
      for (let j = i - n; j <= i + n; j++) { if (j === i) continue; if (h[j] > h[i]) isH = false; if (l[j] < l[i]) isL = false; if (!isH && !isL) break; }
      if (isH) highs.push({ i: i, price: h[i] }); if (isL) lows.push({ i: i, price: l[i] });
    }
    return { highs: highs, lows: lows };
  }
  // Cụm mức giá: gom các đỉnh/đáy swing cách nhau không quá `tol` (tuyệt đối); độ mạnh = số lần chạm cộng trọng số gần đây
  function levelsFrom(points, tol, n) {
    const pts = points.slice().sort(function (a, b) { return a.price - b.price; }), clusters = [];
    pts.forEach(function (p) {
      const c = clusters[clusters.length - 1];
      if (c && p.price - c.max <= tol) { c.items.push(p); c.max = p.price; } else clusters.push({ items: [p], min: p.price, max: p.price });
    });
    return clusters.map(function (c) {
      const price = c.items.reduce(function (s, x) { return s + x.price; }, 0) / c.items.length, recent = c.items.reduce(function (s, x) { return s + (x.i > n - 120 ? 1 : 0.5); }, 0);
      return { price: price, touches: c.items.length, strength: recent, lastIndex: Math.max.apply(null, c.items.map(function (x) { return x.i; })) };
    });
  }
  function fibonacci(h, l, c, lookback) {
    const n = h.length, from = Math.max(0, n - (lookback || 120));
    let hi = from, lo = from;
    for (let i = from; i < n; i++) { if (h[i] >= h[hi]) hi = i; if (l[i] <= l[lo]) lo = i; }
    const range = h[hi] - l[lo]; if (!(range > 0)) return null;
    const up = lo < hi, ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
    const retr = ratios.map(function (r) { return { ratio: r, price: up ? h[hi] - range * r : l[lo] + range * r }; });
    const ext = [1.272, 1.618].map(function (r) { return { ratio: r, price: up ? l[lo] + range * r : h[hi] - range * r }; });
    return { direction: up ? 'up' : 'down', high: h[hi], highIndex: hi, low: l[lo], lowIndex: lo, retracements: retr, extensions: ext, positionPct: (c[n - 1] - l[lo]) / range * 100 };
  }

  // ---------- mẫu nến (ba nến cuối) ----------
  function candlePatterns(o, h, l, c, atrNow) {
    const n = c.length, out = []; if (n < 4) return out;
    const body = (i) => Math.abs(c[i] - o[i]), rng = (i) => h[i] - l[i], upSh = (i) => h[i] - Math.max(o[i], c[i]), loSh = (i) => Math.min(o[i], c[i]) - l[i], bull = (i) => c[i] > o[i], bear = (i) => c[i] < o[i];
    const i = n - 1, p = n - 2, q = n - 3, a = atrNow || rng(i), small = (k) => body(k) <= 0.25 * rng(k) && rng(k) > 0;
    const downtrend = c[i - 1] < c[i - 6], uptrend = c[i - 1] > c[i - 6];
    if (rng(i) > 0 && body(i) <= 0.1 * rng(i)) out.push({ key: 'doji', label: 'Doji', bias: 'neutral', detail: 'Thân nến rất nhỏ: do dự giữa mua và bán.' });
    if (rng(i) > 0 && loSh(i) >= 2 * body(i) && upSh(i) <= 0.3 * rng(i) && body(i) > 0) out.push(downtrend ? { key: 'hammer', label: 'Nến búa', bias: 'bull', detail: 'Bóng dưới dài sau chuỗi giảm: lực bán bị hấp thụ.' } : { key: 'hanging', label: 'Người treo cổ', bias: 'bear', detail: 'Hình búa sau chuỗi tăng: cảnh báo yếu đà.' });
    if (rng(i) > 0 && upSh(i) >= 2 * body(i) && loSh(i) <= 0.3 * rng(i) && body(i) > 0) out.push(uptrend ? { key: 'shooting', label: 'Sao băng', bias: 'bear', detail: 'Bóng trên dài sau chuỗi tăng: lực mua bị từ chối.' } : { key: 'invhammer', label: 'Búa ngược', bias: 'bull', detail: 'Bóng trên dài sau chuỗi giảm: cần nến xác nhận.' });
    if (bear(p) && bull(i) && o[i] <= c[p] && c[i] >= o[p] && body(i) > body(p)) out.push({ key: 'bull-engulf', label: 'Nhấn chìm tăng', bias: 'bull', detail: 'Nến tăng bao trùm nến giảm liền trước.' });
    if (bull(p) && bear(i) && o[i] >= c[p] && c[i] <= o[p] && body(i) > body(p)) out.push({ key: 'bear-engulf', label: 'Nhấn chìm giảm', bias: 'bear', detail: 'Nến giảm bao trùm nến tăng liền trước.' });
    if (bear(q) && body(q) >= 0.5 * rng(q) && small(p) && bull(i) && c[i] > (o[q] + c[q]) / 2) out.push({ key: 'morning', label: 'Sao mai', bias: 'bull', detail: 'Ba nến đảo chiều tăng: giảm mạnh, do dự, rồi tăng lấy lại hơn nửa thân nến đầu.' });
    if (bull(q) && body(q) >= 0.5 * rng(q) && small(p) && bear(i) && c[i] < (o[q] + c[q]) / 2) out.push({ key: 'evening', label: 'Sao hôm', bias: 'bear', detail: 'Ba nến đảo chiều giảm: tăng mạnh, do dự, rồi giảm xuyên hơn nửa thân nến đầu.' });
    if (bull(i) && bull(p) && bull(q) && c[i] > c[p] && c[p] > c[q] && body(i) > 0.5 * a && body(p) > 0.5 * a && body(q) > 0.5 * a) out.push({ key: 'three-white', label: 'Ba chàng lính trắng', bias: 'bull', detail: 'Ba nến tăng liên tiếp đóng cửa cao dần.' });
    if (bear(i) && bear(p) && bear(q) && c[i] < c[p] && c[p] < c[q] && body(i) > 0.5 * a && body(p) > 0.5 * a && body(q) > 0.5 * a) out.push({ key: 'three-black', label: 'Ba con quạ đen', bias: 'bear', detail: 'Ba nến giảm liên tiếp đóng cửa thấp dần.' });
    return out;
  }

  // Phân kỳ RSI-giá trong 60 phiên gần nhất: giá tạo đáy thấp hơn mà RSI đáy cao hơn (tăng) hoặc ngược lại ở đỉnh (giảm)
  function divergence(h, l, c, rsiArr) {
    const n = c.length; if (n < 40) return null;
    const sw = swings(h, l, 3), from = n - 60, lows = sw.lows.filter(function (x) { return x.i >= from; }), highs = sw.highs.filter(function (x) { return x.i >= from; });
    if (lows.length >= 2) { const a = lows[lows.length - 2], b = lows[lows.length - 1]; if (rsiArr[a.i] !== null && rsiArr[b.i] !== null && b.price < a.price && rsiArr[b.i] > rsiArr[a.i] + 2) return { type: 'bull', label: 'Phân kỳ tăng', detail: 'Giá tạo đáy thấp hơn nhưng RSI tạo đáy cao hơn (đà giảm yếu đi).' }; }
    if (highs.length >= 2) { const a = highs[highs.length - 2], b = highs[highs.length - 1]; if (rsiArr[a.i] !== null && rsiArr[b.i] !== null && b.price > a.price && rsiArr[b.i] < rsiArr[a.i] - 2) return { type: 'bear', label: 'Phân kỳ giảm', detail: 'Giá tạo đỉnh cao hơn nhưng RSI tạo đỉnh thấp hơn (đà tăng yếu đi).' }; }
    return null;
  }

  // Sức mạnh tương đối so với chỉ số: closes của cổ phiếu và chỉ số đã căn theo ngày (dates chung). Trả lợi suất vượt trội 1/3/6 tháng và độ dốc đường RS.
  function relativeStrength(dates, c, idxDates, idxClose) {
    if (!idxDates || !idxClose || !idxDates.length) return null;
    const map = {}; idxDates.forEach(function (d, i) { map[d] = idxClose[i]; });
    const rs = [], rsDates = [];
    dates.forEach(function (d, i) { if (map[d] > 0 && c[i] > 0) { rs.push(c[i] / map[d]); rsDates.push(d); } });
    if (rs.length < 70) return null;
    const idxAt = (d) => map[d], n = rs.length, ret = function (k) { if (n <= k) return null; const a = rsDates[n - 1 - k], b = rsDates[n - 1]; const ci = dates.indexOf(a), cj = dates.indexOf(b); if (ci < 0 || cj < 0 || !(c[ci] > 0) || !(idxAt(a) > 0)) return null; return { stock: c[cj] / c[ci] - 1, index: idxAt(b) / idxAt(a) - 1 }; };
    const r1 = ret(21), r3 = ret(63), r6 = ret(126), r12 = ret(250);
    const slope = function (k) { if (n <= k) return null; return rs[n - 1] / rs[n - 1 - k] - 1; };
    const win = rs.slice(-250), below = win.filter(function (v) { return v < rs[n - 1]; }).length;
    const ex = (r) => (r ? r.stock - r.index : null);
    return { rs: rs[n - 1], excess1m: ex(r1), excess3m: ex(r3), excess6m: ex(r6), excess12m: ex(r12), returns: { m1: r1, m3: r3, m6: r6, m12: r12 }, slope1m: slope(21), slope3m: slope(63), percentile: below / win.length * 100, series: { dates: rsDates, values: rs } };
  }

  // ---------- phân tích tổng hợp ----------
  // candles: { t:[YYYY-MM-DD], o, h, l, c, v } tăng dần theo ngày. opts: { index: { t, c } (VN-Index để tính sức mạnh tương đối), minBars }
  function analyze(candles, opts) {
    const o = opts || {};
    const t = candles.t || [], O = candles.o, H = candles.h, L = candles.l, C = candles.c, V = candles.v, n = C ? C.length : 0;
    if (n < (o.minBars || 60)) return { ok: false, reason: 'Cần ít nhất ' + (o.minBars || 60) + ' phiên giá.', bars: n };
    const sma20 = sma(C, 20), sma50 = sma(C, 50), sma100 = sma(C, 100), sma200 = sma(C, 200), ema12 = ema(C, 12), ema26 = ema(C, 26);
    const rsiA = rsi(C, 14), mac = macd(C), sto = stochastic(H, L, C), cciA = cci(H, L, C), wr = williamsR(H, L, C), rocA = roc(C, 12), roc60 = roc(C, 60);
    const atrA = atr(H, L, C, 14), adxA = adx(H, L, C, 14), bb = bollinger(C, 20, 2), kel = keltner(H, L, C), don = donchian(H, L, 20);
    const obvA = obv(C, V), obvMa = sma(obvA, 20), cmfA = cmf(H, L, C, V, 20), mfiA = mfi(H, L, C, V, 14), adA = adLine(H, L, C, V), vw = vwapRolling(H, L, C, V, 20);
    const ar = aroon(H, L, 25), ps = psar(H, L), st = supertrend(H, L, C, 10, 3), ich = ichimoku(H, L, C), hv = histVol(C, 20), dd = drawdown(C);
    const i = n - 1, px = C[i], v = (a) => last(a);
    const volAvg20 = sma(V, 20), volAvg50 = sma(V, 50);
    // StochRSI
    const rs14 = rsiA, hhR = highest(rs14.map(function (x) { return x; }), 14), llR = lowest(rs14.map(function (x) { return x; }), 14), stochRsi = rs14.map(function (x, k) { return x !== null && hhR[k] !== null && hhR[k] !== llR[k] ? (x - llR[k]) / (hhR[k] - llR[k]) * 100 : null; });

    // ---- tín hiệu: mỗi tín hiệu có state -1..+1, weight, nhóm ----
    const sig = [];
    const S = (group, key, label, score, weight, detail) => sig.push({ group: group, key: key, label: label, score: score, weight: weight, state: score > 0.15 ? 'bull' : (score < -0.15 ? 'bear' : 'neutral'), detail: detail });
    const f = (x, d) => (x === null || x === undefined ? '—' : (Math.round(x * Math.pow(10, d === undefined ? 1 : d)) / Math.pow(10, d === undefined ? 1 : d)).toString().replace('.', ','));
    const s200 = v(sma200), s50 = v(sma50), s20 = v(sma20), s100 = v(sma100);
    // Xu hướng
    if (s200 !== null) { const rising = sma200[i - 20] !== null && s200 > sma200[i - 20]; S('trend', 'ma200', 'Giá so với SMA200', px > s200 ? (rising ? 1 : 0.5) : (rising ? -0.5 : -1), 3, 'Giá ' + f(px, 2) + ' ' + (px > s200 ? 'trên' : 'dưới') + ' SMA200 ' + f(s200, 2) + ' (đường dài hạn ' + (rising ? 'đang dốc lên' : 'đang dốc xuống') + ').'); }
    if (s50 !== null) S('trend', 'ma50', 'Giá so với SMA50', px > s50 ? 1 : -1, 2, 'Giá ' + (px > s50 ? 'trên' : 'dưới') + ' SMA50 ' + f(s50, 2) + '.');
    if (s20 !== null) { const rising = sma20[i - 5] !== null && s20 > sma20[i - 5]; S('trend', 'ma20', 'Giá và độ dốc SMA20', (px > s20 ? 0.6 : -0.6) + (rising ? 0.4 : -0.4), 1.5, 'Giá ' + (px > s20 ? 'trên' : 'dưới') + ' SMA20 ' + f(s20, 2) + ', đường ngắn hạn ' + (rising ? 'dốc lên' : 'dốc xuống') + '.'); }
    if (s50 !== null && s200 !== null) S('trend', 'align', 'Sắp xếp các đường trung bình', s50 > s200 ? (s20 !== null && s20 > s50 ? 1 : 0.5) : (s20 !== null && s20 < s50 ? -1 : -0.5), 2, 'SMA50 ' + (s50 > s200 ? 'trên' : 'dưới') + ' SMA200' + (s20 !== null ? ', SMA20 ' + (s20 > s50 ? 'trên' : 'dưới') + ' SMA50' : '') + '.');
    const adxNow = v(adxA.adx), pdi = v(adxA.pdi), mdi = v(adxA.mdi);
    if (adxNow !== null && pdi !== null && mdi !== null) { const dirv = pdi > mdi ? 1 : -1, strength = adxNow >= 25 ? 1 : (adxNow >= 20 ? 0.5 : 0.2); S('trend', 'adx', 'ADX và +DI/−DI', dirv * strength, 2, 'ADX ' + f(adxNow, 1) + ' (' + (adxNow >= 25 ? 'xu hướng rõ' : (adxNow >= 20 ? 'xu hướng yếu' : 'đi ngang')) + '), +DI ' + f(pdi, 1) + ' ' + (pdi > mdi ? '>' : '<') + ' −DI ' + f(mdi, 1) + '.'); }
    const cA = v(ich.cloudA), cB = v(ich.cloudB);
    if (cA !== null && cB !== null) { const top = Math.max(cA, cB), bot = Math.min(cA, cB); S('trend', 'ichimoku', 'Ichimoku (vị trí so với mây)', px > top ? 1 : (px < bot ? -1 : 0), 2, 'Giá ' + (px > top ? 'trên mây (' + f(top, 2) + ')' : (px < bot ? 'dưới mây (' + f(bot, 2) + ')' : 'trong mây')) + '; Tenkan ' + f(v(ich.tenkan), 2) + ' ' + (v(ich.tenkan) > v(ich.kijun) ? '>' : '<') + ' Kijun ' + f(v(ich.kijun), 2) + '.'); }
    if (v(st.dir) !== null) S('trend', 'supertrend', 'Supertrend (10, 3)', v(st.dir), 1.5, 'Supertrend đang ' + (v(st.dir) === 1 ? 'báo tăng, hỗ trợ động' : 'báo giảm, kháng cự động') + ' tại ' + f(v(st.line), 2) + '.');
    if (v(ps.dir) !== null) S('trend', 'psar', 'Parabolic SAR', v(ps.dir), 1, 'SAR ' + f(v(ps.sar), 2) + ' ' + (v(ps.dir) === 1 ? 'dưới giá (xu hướng tăng)' : 'trên giá (xu hướng giảm)') + '.');
    const aU = v(ar.up), aD = v(ar.down); if (aU !== null) S('trend', 'aroon', 'Aroon 25', (aU - aD) / 100, 1, 'Aroon Up ' + f(aU, 0) + ', Aroon Down ' + f(aD, 0) + '.');
    // Động lượng
    const r = v(rsiA); if (r !== null) { const sc = r >= 70 ? 0.3 : (r >= 55 ? 0.8 : (r >= 45 ? 0 : (r >= 30 ? -0.8 : -0.3))); S('momentum', 'rsi', 'RSI 14', sc, 2, 'RSI ' + f(r, 1) + (r >= 70 ? ' (quá mua: đà mạnh nhưng dễ điều chỉnh ngắn hạn)' : (r <= 30 ? ' (quá bán: đà giảm mạnh nhưng dễ hồi kỹ thuật)' : (r >= 50 ? ' (phe mua chiếm ưu thế)' : ' (phe bán chiếm ưu thế)'))) + '.'); }
    const ml = v(mac.line), ms = v(mac.signal), mh = v(mac.hist), mhPrev = mac.hist[i - 1];
    if (ml !== null && ms !== null) S('momentum', 'macd', 'MACD (12, 26, 9)', (ml > ms ? 0.5 : -0.5) + (ml > 0 ? 0.3 : -0.3) + (mh !== null && mhPrev !== null ? (mh > mhPrev ? 0.2 : -0.2) : 0), 2, 'MACD ' + f(ml, 3) + (ml > ms ? ' trên' : ' dưới') + ' đường tín hiệu ' + f(ms, 3) + ', ' + (ml > 0 ? 'trên' : 'dưới') + ' đường 0; histogram ' + (mh !== null && mhPrev !== null ? (mh > mhPrev ? 'đang mở rộng theo hướng tăng' : 'đang thu hẹp/đổi hướng giảm') : '—') + '.');
    const k = v(sto.k), d = v(sto.d); if (k !== null && d !== null) S('momentum', 'stoch', 'Stochastic (14, 3, 3)', (k > d ? 0.5 : -0.5) + (k > 80 ? -0.2 : (k < 20 ? 0.2 : 0)), 1, '%K ' + f(k, 1) + (k > d ? ' trên' : ' dưới') + ' %D ' + f(d, 1) + (k > 80 ? ' (vùng quá mua)' : (k < 20 ? ' (vùng quá bán)' : '')) + '.');
    const cc = v(cciA); if (cc !== null) S('momentum', 'cci', 'CCI 20', clamp(cc / 150, -1, 1), 1, 'CCI ' + f(cc, 0) + (cc > 100 ? ' (mạnh)' : (cc < -100 ? ' (yếu)' : '')) + '.');
    const r12 = v(rocA), r60 = v(roc60); if (r12 !== null) S('momentum', 'roc', 'Tốc độ thay đổi giá (12 và 60 phiên)', clamp(r12 / 8, -1, 1) * 0.5 + (r60 !== null ? clamp(r60 / 20, -1, 1) * 0.5 : 0), 1.5, 'ROC12 ' + f(r12, 1) + '%' + (r60 !== null ? ', ROC60 ' + f(r60, 1) + '%' : '') + '.');
    // Dòng tiền
    const ob = v(obvA), obm = v(obvMa); if (ob !== null && obm !== null) S('flow', 'obv', 'OBV so với trung bình 20', ob > obm ? 1 : -1, 1.5, 'OBV ' + (ob > obm ? 'trên' : 'dưới') + ' trung bình 20 phiên (dòng tiền ' + (ob > obm ? 'đang vào' : 'đang ra') + ').');
    const cm = v(cmfA); if (cm !== null) S('flow', 'cmf', 'Dòng tiền Chaikin (CMF 20)', clamp(cm / 0.2, -1, 1), 1.5, 'CMF ' + f(cm, 3) + (cm > 0.05 ? ' (áp lực mua)' : (cm < -0.05 ? ' (áp lực bán)' : ' (cân bằng)')) + '.');
    const mf = v(mfiA); if (mf !== null) S('flow', 'mfi', 'MFI 14', mf >= 80 ? 0.2 : (mf >= 55 ? 0.8 : (mf >= 45 ? 0 : (mf >= 20 ? -0.8 : -0.2))), 1, 'MFI ' + f(mf, 1) + (mf >= 80 ? ' (quá mua)' : (mf <= 20 ? ' (quá bán)' : '')) + '.');
    const va = v(volAvg20), vb = v(volAvg50);
    if (va !== null && vb > 0) { const up = C[i] >= C[i - 1]; const ratio = va / vb; S('flow', 'volume', 'Khối lượng 20 phiên so với 50', (ratio > 1.15 ? 1 : (ratio < 0.85 ? -0.3 : 0)) * (C[i] > (v(sma20) || px) ? 1 : -1) * 0.8, 1, 'Khối lượng TB 20 phiên bằng ' + f(ratio * 100, 0) + '% TB 50 phiên; phiên cuối ' + (up ? 'tăng' : 'giảm') + ' với khối lượng ' + f(V[i] / va * 100, 0) + '% TB 20.'); }
    const vwN = v(vw); if (vwN !== null) S('flow', 'vwap', 'Giá so với VWAP 20 phiên', px > vwN ? 0.8 : -0.8, 1, 'Giá ' + (px > vwN ? 'trên' : 'dưới') + ' VWAP 20 phiên ' + f(vwN, 2) + ' (giá vốn bình quân của người mua gần đây).');
    // Vị thế
    const pb = v(bb.pctB); if (pb !== null) S('position', 'bollinger', 'Vị trí trong dải Bollinger', pb > 1 ? -0.3 : (pb > 0.8 ? 0.5 : (pb > 0.5 ? 0.6 : (pb > 0.2 ? -0.4 : (pb >= 0 ? -0.6 : 0.2)))), 1.5, '%B ' + f(pb, 2) + (pb > 1 ? ' (vượt dải trên)' : (pb < 0 ? ' (thủng dải dưới)' : '')) + '.');
    if (s200 !== null) { const ext = px / s200 - 1; S('position', 'extension', 'Độ giãn so với SMA200', ext > 0.35 ? -0.8 : (ext > 0.2 ? -0.3 : (ext > 0 ? 0.6 : (ext > -0.2 ? -0.4 : -0.2))), 1.5, 'Giá cách SMA200 ' + f(ext * 100, 1) + '%' + (ext > 0.35 ? ' (giãn quá xa, dễ điều chỉnh)' : '') + '.'); }
    const hi52 = Math.max.apply(null, H.slice(-250)), lo52 = Math.min.apply(null, L.slice(-250)), pos52 = hi52 > lo52 ? (px - lo52) / (hi52 - lo52) : null;
    if (pos52 !== null) S('position', 'range52', 'Vị trí trong biên độ 52 tuần', pos52 > 0.8 ? 0.7 : (pos52 > 0.5 ? 0.4 : (pos52 > 0.2 ? -0.4 : -0.1)), 1.5, 'Giá nằm ở ' + f(pos52 * 100, 0) + '% biên độ 52 tuần (đỉnh ' + f(hi52, 2) + ', đáy ' + f(lo52, 2) + ').');
    const dn = v(don.upper), dl = v(don.lower); if (dn !== null && n > 21) { const prevHi = Math.max.apply(null, H.slice(-21, -1)), prevLo = Math.min.apply(null, L.slice(-21, -1)); S('position', 'donchian', 'Bứt phá khỏi biên 20 phiên', px > prevHi ? 1 : (px < prevLo ? -1 : 0), 1, px > prevHi ? 'Giá vượt đỉnh 20 phiên ' + f(prevHi, 2) + '.' : (px < prevLo ? 'Giá thủng đáy 20 phiên ' + f(prevLo, 2) + '.' : 'Giá nằm trong biên 20 phiên.')); }

    // nhóm điểm
    const groups = { trend: { weight: 40, label: 'Xu hướng' }, momentum: { weight: 30, label: 'Động lượng' }, flow: { weight: 15, label: 'Dòng tiền' }, position: { weight: 15, label: 'Vị thế giá' } };
    let tw = 0, ts = 0;
    Object.keys(groups).forEach(function (gk) {
      const list = sig.filter(function (x) { return x.group === gk; }), sw = list.reduce(function (s, x) { return s + x.weight; }, 0);
      const sc = sw > 0 ? list.reduce(function (s, x) { return s + x.score * x.weight; }, 0) / sw * 100 : null;
      groups[gk].score = sc; groups[gk].count = list.length; groups[gk].bull = list.filter(function (x) { return x.state === 'bull'; }).length; groups[gk].bear = list.filter(function (x) { return x.state === 'bear'; }).length;
      if (sc !== null) { tw += groups[gk].weight; ts += sc * groups[gk].weight; }
    });
    const total = tw > 0 ? ts / tw : null;
    const rating = total === null ? null : (total >= 50 ? { key: 'strong-up', label: 'Xu hướng tăng mạnh', tone: 'ok' } : (total >= 20 ? { key: 'up', label: 'Xu hướng tăng', tone: 'ok' } : (total > -20 ? { key: 'flat', label: 'Đi ngang / chưa rõ', tone: 'mute' } : (total > -50 ? { key: 'down', label: 'Xu hướng giảm', tone: 'warn' } : { key: 'strong-down', label: 'Xu hướng giảm mạnh', tone: 'warn' }))));

    // mức giá
    const a14 = v(atrA), sw = swings(H, L, 5), tol = Math.max(a14 !== null ? a14 : px * 0.01, px * 0.008), win = Math.min(n, 500);
    const recentHighs = sw.highs.filter(function (x) { return x.i >= n - win; }), recentLows = sw.lows.filter(function (x) { return x.i >= n - win; });
    const resist = levelsFrom(recentHighs.concat(recentLows), tol, n).filter(function (x) { return x.price > px * 1.002; }).sort(function (a, b) { return a.price - b.price; });
    const supp = levelsFrom(recentHighs.concat(recentLows), tol, n).filter(function (x) { return x.price < px * 0.998; }).sort(function (a, b) { return b.price - a.price; });
    const weekH = Math.max.apply(null, H.slice(-5)), weekL = Math.min.apply(null, L.slice(-5)), monthH = Math.max.apply(null, H.slice(-21)), monthL = Math.min.apply(null, L.slice(-21));
    const levels = { resistances: resist.slice(0, 4), supports: supp.slice(0, 4), pivots: { daily: pivotsOf(H[i], L[i], C[i]), weekly: pivotsOf(weekH, weekL, C[i]), monthly: pivotsOf(monthH, monthL, C[i]) }, fibonacci: fibonacci(H, L, C, 120), high52: hi52, low52: lo52 };
    // nén biến động
    const widths = bb.width.filter(function (x) { return x !== null; }).slice(-120), wNow = v(bb.width), wBelow = wNow === null ? null : widths.filter(function (x) { return x < wNow; }).length / (widths.length || 1) * 100;
    const squeeze = wBelow !== null && wBelow <= 10 ? { active: true, percentile: wBelow, detail: 'Độ rộng Bollinger ở phân vị ' + f(wBelow, 0) + ' của 120 phiên: giá đang nén, thường đi trước một nhịp biến động lớn (chưa biết hướng).' } : { active: false, percentile: wBelow };
    // golden/death cross gần đây
    let cross = null; if (s50 !== null && s200 !== null) { for (let k = i; k > Math.max(1, i - 30); k--) { if (sma50[k] !== null && sma200[k] !== null && sma50[k - 1] !== null && sma200[k - 1] !== null) { if (sma50[k] > sma200[k] && sma50[k - 1] <= sma200[k - 1]) { cross = { type: 'golden', daysAgo: i - k, label: 'Giao cắt vàng (SMA50 cắt lên SMA200)' }; break; } if (sma50[k] < sma200[k] && sma50[k - 1] >= sma200[k - 1]) { cross = { type: 'death', daysAgo: i - k, label: 'Giao cắt chết (SMA50 cắt xuống SMA200)' }; break; } } } }
    const patterns = candlePatterns(O, H, L, C, a14), div = divergence(H, L, C, rsiA);
    const rsStrength = o.index && o.index.t && o.index.c ? relativeStrength(t, C, o.index.t, o.index.c) : null;
    const hvNow = v(hv), hvWin = hv.filter(function (x) { return x !== null; }).slice(-250), hvPct = hvNow === null ? null : hvWin.filter(function (x) { return x < hvNow; }).length / (hvWin.length || 1) * 100;
    const volatility = { atr: a14, atrPct: a14 !== null ? a14 / px : null, hv20: hvNow, hvPercentile: hvPct, regime: hvPct === null ? null : (hvPct >= 80 ? 'Biến động cao' : (hvPct <= 20 ? 'Biến động thấp' : 'Biến động bình thường')), drawdown: v(dd), maxDrawdown1y: Math.min.apply(null, dd.slice(-250).filter(function (x) { return x !== null; })) };
    // đọc nhanh bối cảnh vào lệnh
    const overbought = (r !== null && r >= 70) || (pb !== null && pb > 1) || (s200 !== null && px / s200 - 1 > 0.35);
    const oversold = (r !== null && r <= 30) || (pb !== null && pb < 0);
    let timing;
    if (total === null) timing = null;
    else if (total >= 20 && overbought) timing = { key: 'wait', label: 'Xu hướng tốt nhưng đang nóng: chờ nhịp điều chỉnh', tone: 'mute' };
    else if (total >= 20) timing = { key: 'favorable', label: 'Bối cảnh giá thuận lợi', tone: 'ok' };
    else if (total <= -20 && oversold) timing = { key: 'rebound', label: 'Xu hướng xấu nhưng quá bán: dễ hồi kỹ thuật, chưa phải đảo chiều', tone: 'mute' };
    else if (total <= -20) timing = { key: 'unfavorable', label: 'Bối cảnh giá bất lợi: chưa có tín hiệu cải thiện', tone: 'warn' };
    else timing = { key: 'neutral', label: 'Chưa rõ xu hướng: nên chờ thêm xác nhận', tone: 'mute' };

    return {
      ok: true, bars: n, asOf: t[i], price: px, signals: sig, groups: groups, score: total, rating: rating, timing: timing, overbought: overbought, oversold: oversold,
      latest: { sma20: s20, sma50: s50, sma100: s100, sma200: s200, rsi: r, macd: ml, macdSignal: ms, macdHist: mh, stochK: k, stochD: d, stochRsi: v(stochRsi), cci: cc, williamsR: v(wr), roc12: r12, roc60: r60, adx: adxNow, plusDi: pdi, minusDi: mdi,
        atr: a14, bbUpper: v(bb.upper), bbMid: v(bb.mid), bbLower: v(bb.lower), pctB: pb, bbWidth: v(bb.width), obv: ob, cmf: cm, mfi: mf, vwap20: vwN, aroonUp: aU, aroonDown: aD, supertrend: v(st.line), psar: v(ps.sar), tenkan: v(ich.tenkan), kijun: v(ich.kijun), cloudA: cA, cloudB: cB,
        volume: V[i], volAvg20: va, volAvg50: vb, keltnerUpper: v(kel.upper), keltnerLower: v(kel.lower), donchianUpper: dn, donchianLower: dl },
      levels: levels, patterns: patterns, divergence: div, squeeze: squeeze, cross: cross, volatility: volatility, relativeStrength: rsStrength,
      series: { t: t, sma20: sma20, sma50: sma50, sma100: sma100, sma200: sma200, ema12: ema12, ema26: ema26, bbUpper: bb.upper, bbLower: bb.lower, bbMid: bb.mid, rsi: rsiA, macd: mac.line, macdSignal: mac.signal, macdHist: mac.hist, stochK: sto.k, stochD: sto.d,
        adx: adxA.adx, plusDi: adxA.pdi, minusDi: adxA.mdi, obv: obvA, atr: atrA, cmf: cmfA, mfi: mfiA, supertrend: st.line, supertrendDir: st.dir, psar: ps.sar, tenkan: ich.tenkan, kijun: ich.kijun, cloudA: ich.cloudA, cloudB: ich.cloudB, vwap20: vw, drawdown: dd },
    };
  }

  return { sma, ema, wilder, stdev, highest, lowest, rsi, macd, atr, trueRange, stochastic, cci, williamsR, roc, adx, bollinger, keltner, donchian, obv, adLine, cmf, mfi, vwapRolling, aroon, psar, supertrend, ichimoku, histVol, drawdown,
    pivotsOf, swings, levelsFrom, fibonacci, candlePatterns, divergence, relativeStrength, analyze };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBTechnical;
