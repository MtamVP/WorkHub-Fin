// Logic thuần: TỐI ƯU HOÁ TỶ TRỌNG giữa các mã đang nắm (chỉ mua dài, không vay, tổng tỷ trọng phần cổ phiếu = 100%, mỗi mã trong [cận dưới, cận trên]).
// Ba cách, đều dùng ma trận hiệp phương sai CO (Ledoit-Wolf, lib/risk-models.js) ước lượng từ lợi suất ngày đã điều chỉnh sự kiện:
//   * Phương sai nhỏ nhất: danh mục ít biến động nhất trong các ràng buộc -- không cần dự báo lợi nhuận (ít nhạy với sai số ước lượng nhất).
//   * Cân bằng rủi ro (equal risk contribution): mỗi mã đóng góp rủi ro như nhau -- tránh một vài mã biến động mạnh chiếm phần lớn rủi ro.
//   * Tối đa hoá tỷ lệ Sharpe: lợi nhuận kỳ vọng vượt lãi phi rủi ro trên mỗi đơn vị rủi ro; lợi nhuận kỳ vọng do bên gọi đưa vào (vd. từ giá trị hợp lý của Valuation Bench).
// Thuật toán: gradient chiếu lên "đơn hình có chặn" (projection bằng chia đôi trên hệ số Lagrange) cho phương sai nhỏ nhất và trung bình - phương sai;
// Sharpe tối đa = dò dọc đường biên hiệu quả theo hệ số ngại rủi ro (lưới log + tinh chỉnh tỷ lệ vàng); cân bằng rủi ro = hạ toạ độ vòng (Griveau-Billion 2013).
// Kết quả đã đối chiếu với scipy.optimize (SLSQP) trên cùng dữ liệu: tests/fixtures/optimizer-golden.json (tạo bằng tests/fixtures/make-optimizer-golden.py).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global PortfolioOptimizer) và module.exports cho Vitest. Cần RiskModels (lib/risk-models.js) cho covFromReturns.
const PortfolioOptimizer = (function () {
  const TD = 252;
  const RM = (typeof require === 'function' && typeof module !== 'undefined') ? require('./risk-models.js') : (typeof RiskModels !== 'undefined' ? RiskModels : null);
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const matVec = (A, x) => A.map((row) => row.reduce((s, a, j) => s + a * x[j], 0));
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const fill = (n, v) => new Array(n).fill(v);

  // Chiếu v lên { w : Σw = 1, lo <= w <= hi }: w_i = clip(v_i - λ, lo_i, hi_i), tìm λ bằng chia đôi. null nếu không khả thi (Σlo > 1 hoặc Σhi < 1).
  function project(v, lo, hi) {
    const n = v.length;
    const sLo = lo.reduce((s, x) => s + x, 0), sHi = hi.reduce((s, x) => s + x, 0);
    if (sLo > 1 + 1e-9 || sHi < 1 - 1e-9) return null;
    const at = (lam) => v.reduce((s, x, i) => s + Math.min(hi[i], Math.max(lo[i], x - lam)), 0);
    let a = Math.min(...v.map((x, i) => x - hi[i])) - 1, b = Math.max(...v.map((x, i) => x - lo[i])) + 1;
    for (let k = 0; k < 200; k++) { const m = (a + b) / 2; if (at(m) > 1) a = m; else b = m; if (b - a < 1e-15) break; }
    const lam = (a + b) / 2, w = v.map((x, i) => Math.min(hi[i], Math.max(lo[i], x - lam)));
    const s = w.reduce((x, y) => x + y, 0), gap = 1 - s;                       // sai số làm tròn: dồn vào mã còn chỗ
    if (Math.abs(gap) > 1e-12) for (let i = 0; i < n; i++) { const room = gap > 0 ? hi[i] - w[i] : w[i] - lo[i]; if (room > 1e-12) { w[i] += gap > 0 ? Math.min(gap, room) : -Math.min(-gap, room); break; } }
    return w;
  }

  // Cận trên của trị riêng lớn nhất (Gershgorin) cho bước gradient an toàn
  const lipschitz = (C) => Math.max(1e-12, ...C.map((row) => row.reduce((s, x) => s + Math.abs(x), 0)));

  // max μᵀw − (γ/2) wᵀCw trên đơn hình có chặn (γ = Infinity -> phương sai nhỏ nhất). Gradient chiếu với bước 1/(γL) và gia tốc Nesterov (FISTA).
  function meanVariance(mu, C, gamma, lo, hi, opts) {
    const n = C.length, o = opts || {}, L = lipschitz(C), minVar = !(gamma < Infinity);
    const g = minVar ? 1 : gamma, m = mu || fill(n, 0), eta = 1 / (g * L);
    let w = project(o.start || fill(n, 1 / n), lo, hi);
    if (!w) return null;
    let y = w.slice(), t = 1;
    for (let k = 0; k < (o.maxIter || 20000); k++) {
      const Cy = matVec(C, y);
      const step = y.map((yi, i) => yi + eta * ((minVar ? 0 : m[i]) - g * Cy[i]));
      const wn = project(step, lo, hi);
      const tn = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
      y = wn.map((x, i) => x + ((t - 1) / tn) * (x - w[i]));
      let diff = 0; for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(wn[i] - w[i]));
      w = wn; t = tn;
      if (diff < 1e-12 && k > 20) break;
    }
    return w;
  }
  const minVariance = (C, lo, hi, opts) => meanVariance(null, C, Infinity, lo, hi, opts);

  function stats(w, C, mu, rf) {
    const Cw = matVec(C, w), v = Math.max(0, dot(w, Cw)), vol = Math.sqrt(v);
    const contrib = w.map((wi, i) => (vol > 0 ? wi * Cw[i] / vol : 0));
    const ret = mu ? dot(w, mu) : null;
    return { vol: vol, ret: ret, sharpe: ret !== null && vol > 0 ? (ret - (rf || 0)) / vol : null, riskShare: contrib.map((c) => (vol > 0 ? c / vol : 0)) };
  }

  // Sharpe tối đa: dò γ trên lưới log, chọn tốt nhất rồi tinh chỉnh tỷ lệ vàng trên log γ; so thêm với phương sai nhỏ nhất. Mọi μ <= rf thì Sharpe vô nghĩa -> null.
  function maxSharpe(mu, C, rf, lo, hi) {
    const r = rf || 0;
    if (!mu.some((x) => x > r)) return null;
    const ex = mu.map((x) => x - r);
    const sh = (w) => { const s = stats(w, C, mu, r); return s.vol > 0 ? s.sharpe : -Infinity; };
    let best = { w: minVariance(C, lo, hi), lg: null }; best.s = sh(best.w);
    let prev = best.w;
    const grid = []; for (let lg = -2; lg <= 4.0001; lg += 0.25) grid.push(lg);
    const scores = grid.map((lg) => { const w = meanVariance(ex, C, Math.pow(10, lg), lo, hi, { start: prev, maxIter: 6000 }); prev = w; const s = sh(w); if (s > best.s) best = { w, s, lg }; return s; });
    if (best.lg !== null) {
      let a = best.lg - 0.25, b = best.lg + 0.25, phi = (Math.sqrt(5) - 1) / 2;
      const f = (lg) => { const w = meanVariance(ex, C, Math.pow(10, lg), lo, hi, { start: best.w }); const s = sh(w); if (s > best.s) best = { w, s, lg }; return s; };
      let c = b - phi * (b - a), d = a + phi * (b - a), fc = f(c), fd = f(d);
      for (let k = 0; k < 30 && b - a > 1e-4; k++) { if (fc > fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = f(c); } else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = f(d); } }
    }
    return { w: best.w, sharpe: best.s, gamma: best.lg === null ? Infinity : Math.pow(10, best.lg), scanned: scores.length };
  }

  // Cân bằng rủi ro (ngân sách b_i, mặc định đều): hạ toạ độ vòng trên x không chuẩn hoá: C_ii x_i² + (Σ_{j≠i} C_ij x_j) x_i − b_i·σ(x) = 0 (Griveau-Billion, Richard, Roncalli 2013).
  // Sau đó chuẩn hoá Σ = 1; nếu vượt cận thì chiếu lên miền ràng buộc và báo `capped` (không còn cân bằng tuyệt đối).
  function riskParity(C, lo, hi, budgets) {
    const n = C.length, b = budgets || fill(n, 1 / n);
    let x = C.map((row, i) => 1 / Math.sqrt(Math.max(row[i], 1e-18)));
    const s0 = x.reduce((s, v) => s + v, 0); x = x.map((v) => v / s0);
    for (let it = 0; it < 2000; it++) {
      let maxRel = 0;
      for (let i = 0; i < n; i++) {
        const sig = Math.sqrt(Math.max(1e-30, dot(x, matVec(C, x))));
        let c = 0; for (let j = 0; j < n; j++) if (j !== i) c += C[i][j] * x[j];
        const a = C[i][i], xi = (-c + Math.sqrt(c * c + 4 * a * b[i] * sig)) / (2 * a);
        maxRel = Math.max(maxRel, Math.abs(xi - x[i]) / Math.max(1e-12, x[i])); x[i] = xi;
      }
      if (maxRel < 1e-12) break;
    }
    const s = x.reduce((t, v) => t + v, 0);
    let w = x.map((v) => v / s), capped = false;
    if (w.some((v, i) => v > hi[i] + 1e-9 || v < lo[i] - 1e-9)) { w = project(w, lo, hi); capped = true; }
    return w ? { w, capped } : null;
  }

  // Hiệp phương sai NĂM (co Ledoit-Wolf) từ lợi suất ngày { SYM: [r, null...] } theo thứ tự `symbols`; chỗ thiếu điền 0 như RiskModels.summary
  function covFromReturns(rets, symbols) {
    if (!RM) return null;
    const T = Math.min(...symbols.map((s) => (rets[s] || []).length));
    if (!(T >= 60)) return null;
    const X = []; for (let t = 0; t < T; t++) X.push(symbols.map((s) => { const v = rets[s][rets[s].length - T + t]; return v === null || v === undefined || !isFinite(v) ? 0 : v; }));
    const sh = RM.shrinkCov(X);
    return sh ? { cov: sh.cov.map((row) => row.map((v) => v * TD)), delta: sh.delta, obs: T } : null;
  }

  // Lợi nhuận kỳ vọng NĂM từ giá trị hợp lý: khoảng cách giá đóng dần trong `horizon` năm, rồi co một nửa về mức chung (thận trọng với sai số định giá) và chặn [-30%, +40%]
  function expectedFromFair(price, fair, horizon, marketMu, blend) {
    const p = num(price), f = num(fair), h = num(horizon) > 0 ? horizon : 2, m = num(marketMu) !== null ? marketMu : 0.09, k = num(blend) !== null ? blend : 0.5;
    if (!(p > 0 && f > 0)) return null;
    const own = Math.pow(f / p, 1 / h) - 1;
    return Math.max(-0.3, Math.min(0.4, k * own + (1 - k) * m));
  }

  // Gộp cho giao diện. input: { symbols, rets, values: { SYM: giá trị đang giữ }, maxPct (cận trên mỗi mã, phần cổ phiếu, 0..1), minPct, method, mu: { SYM: năm } | null, rf }
  function optimize(input) {
    const o = input || {}, syms = (o.symbols || []).filter((s) => o.rets && o.rets[s]);
    if (syms.length < 2) return { ok: false, reason: 'few', need: 2, have: syms.length };
    const cv = covFromReturns(o.rets, syms);
    if (!cv) return { ok: false, reason: 'short' };
    const n = syms.length, hiV = Math.min(1, num(o.maxPct) > 0 ? o.maxPct : 1), loV = Math.max(0, num(o.minPct) || 0);
    const lo = fill(n, loV), hi = fill(n, hiV);
    if (loV * n > 1 + 1e-9 || hiV * n < 1 - 1e-9) return { ok: false, reason: 'infeasible', minPct: loV, maxPct: hiV, n: n };
    const total = syms.reduce((s, x) => s + Math.max(0, num((o.values || {})[x]) || 0), 0);
    const cur = syms.map((s) => (total > 0 ? Math.max(0, num(o.values[s]) || 0) / total : 1 / n));
    const rf = num(o.rf) !== null ? o.rf : 0.03;
    const mu = o.mu ? syms.map((s) => num(o.mu[s])) : null;
    const muOk = mu && mu.every((x) => x !== null) ? mu : null;
    const method = o.method || 'minvar';
    let w = null, extra = {};
    if (method === 'minvar') w = minVariance(cv.cov, lo, hi);
    else if (method === 'riskparity') { const r = riskParity(cv.cov, lo, hi); if (r) { w = r.w; extra.capped = r.capped; } }
    else if (method === 'maxsharpe') {
      if (!muOk) return { ok: false, reason: 'no-mu' };
      const r = maxSharpe(muOk, cv.cov, rf, lo, hi);
      if (!r) return { ok: false, reason: 'mu-below-rf' };
      w = r.w; extra.gamma = r.gamma;
    } else return { ok: false, reason: 'method' };
    if (!w) return { ok: false, reason: 'infeasible', minPct: loV, maxPct: hiV, n: n };
    const now = stats(cur, cv.cov, muOk, rf), next = stats(w, cv.cov, muOk, rf);
    const turnover = w.reduce((s, x, i) => s + Math.abs(x - cur[i]), 0) / 2;
    return Object.assign({ ok: true, method, symbols: syms, weights: w, current: cur, now, next, turnover, shrink: cv.delta, obs: cv.obs, rf, mu: muOk, maxPct: hiV, minPct: loV }, extra);
  }

  // Lệnh để chuyển từ tỷ trọng hiện tại sang đề xuất, giữ nguyên tổng giá trị phần cổ phiếu (tiền mặt không đổi, bỏ qua phí). Khối lượng làm tròn lô 100 cổ phiếu.
  function orders(res, holdings, lot) {
    if (!res || !res.ok) return [];
    const L = lot > 0 ? lot : 100, by = {}; (holdings || []).forEach((h) => { by[String(h.symbol).toUpperCase()] = h; });
    const total = res.symbols.reduce((s, x) => s + Math.max(0, num((by[x] || {}).value) || 0), 0);
    return res.symbols.map((s, i) => {
      const h = by[s] || {}, value = Math.max(0, num(h.value) || 0), qty = num(h.quantity), price = qty > 0 ? value / qty : null;
      const target = res.weights[i] * total, delta = target - value;
      const shares = price > 0 ? Math.round(delta / price / L) * L : null;
      return { symbol: s, value, target, delta, price, shares, side: shares === null ? null : (shares > 0 ? 'buy' : (shares < 0 ? 'sell' : null)) };
    });
  }

  return { project, meanVariance, minVariance, maxSharpe, riskParity, stats, covFromReturns, expectedFromFair, optimize, orders, TD };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PortfolioOptimizer;
