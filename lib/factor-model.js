// Logic thuần: MÔ HÌNH YẾU TỐ tự dựng cho thị trường Việt Nam, để trả lời "danh mục này lãi / lỗ vì đâu: do thị trường chung, do cầm cổ phiếu nhỏ, cổ phiếu rẻ, cổ phiếu đang thắng, cổ phiếu ít biến động hay cổ phiếu chất lượng?".
// Cách làm (kiểu Fama-French / Carhart, đơn giản hoá, dựng bằng kho giá và số liệu cơ bản theo thời điểm của Phòng kiểm thử):
//   * Mỗi cuối tháng xếp các mã trong vũ trụ (HOSE/HNX, thanh khoản đủ, đủ lịch sử; gồm cả mã sau này hủy niêm yết) theo một đặc trưng (quy mô, 1/PB, động lượng 12-1, biến động 60 phiên, ROE đã công bố);
//     rổ MUA = 30% mã tốt nhất theo hướng của yếu tố, rổ BÁN = 30% tệ nhất; lợi suất yếu tố mỗi ngày = lợi suất trung bình rổ mua - rổ bán (chia đều, cân bằng lại mỗi ngày; không tính chi phí: đây là đối tượng nghiên cứu).
//   * Yếu tố thị trường = lợi suất VN-Index vượt lãi suất tiền mặt (VN-Index là chỉ số giá nên bị trừ ~1-2 điểm %/năm cổ tức: hệ số beta vẫn đúng, hằng số alpha hơi thấp).
//   * Danh mục (tỷ trọng HIỆN TẠI, cùng cách hồi tố với lib/risk-calc.js) được hồi quy lợi suất ngày vượt lãi suất tiền mặt lên các yếu tố; sai số chuẩn kiểu Newey-West (độ trễ 5) vì lợi suất ngày có tự tương quan.
//   * Song song là phép đo theo TỪNG MÃ ĐANG NẮM: phân vị đặc trưng của danh mục so với vũ trụ hôm nay (không cần lịch sử lợi suất).
// Giới hạn nói thẳng: (1) đây là mô hình TỰ DỰNG từ số liệu miễn phí, KHÔNG so trực tiếp được với MSCI Barra / Fama-French của Mỹ; (2) hồi tố với tỷ trọng hiện tại không phản ánh danh mục thật đã giữ trong quá khứ;
// (3) vũ trụ Việt Nam nhỏ (vài trăm mã đủ thanh khoản) nên yếu tố nhiễu và phụ thuộc vài mã lớn; (4) hệ số có ý nghĩa thống kê khi |t| >= 2, mẫu ngắn thì thường không đạt; (5) các yếu tố tương quan với nhau
// (đã báo hệ số VIF), hệ số riêng lẻ khó đọc khi VIF lớn.
// KHÔNG đụng DOM/mạng/tệp. Nạp bằng thẻ <script> thường (global FactorModel) và module.exports cho Vitest. Cần StrategyBacktest, PitCalc.
const FactorModel = (function () {
  const NODE = typeof require === 'function' && typeof module !== 'undefined';
  const SB = NODE ? require('./strategy-backtest.js') : globalThis.StrategyBacktest;
  const PC = NODE ? require('./pit-calc.js') : globalThis.PitCalc;
  const TD = 252;
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const mean = (a) => { let s = 0, n = 0; for (let i = 0; i < a.length; i++) { if (isNum(a[i])) { s += a[i]; n++; } } return n ? s / n : NaN; };
  const stdev = (a) => { const m = mean(a); let s = 0, n = 0; for (let i = 0; i < a.length; i++) { if (isNum(a[i])) { s += (a[i] - m) * (a[i] - m); n++; } } return n > 1 ? Math.sqrt(s / (n - 1)) : NaN; };

  // char = khoá đặc trưng của lib/strategy-backtest.js; long = hướng của rổ MUA ('high' = giá trị cao của đặc trưng); fund = cần số liệu cơ bản theo thời điểm
  const FACTORS = [
    { key: 'MKT', label: 'Thị trường', short: 'Thị trường', desc: 'VN-Index vượt lãi suất tiền mặt. Hệ số beta: danh mục dao động bao nhiêu lần VN-Index.', kind: 'market' },
    { key: 'SIZE', label: 'Quy mô: nhỏ trừ lớn', short: 'Quy mô nhỏ', char: 'size', long: 'low', fund: true, desc: 'Mua 30% mã vốn hoá nhỏ nhất, bán 30% lớn nhất. Hệ số dương = danh mục nghiêng về cổ phiếu nhỏ.' },
    { key: 'VALUE', label: 'Giá trị: rẻ trừ đắt (theo 1/PB)', short: 'Giá trị (rẻ)', char: 'bookYield', long: 'high', fund: true, desc: 'Mua mã P/B thấp, bán mã P/B cao. Hệ số dương = nghiêng về cổ phiếu rẻ theo giá trị sổ sách.' },
    { key: 'MOM', label: 'Động lượng: thắng trừ thua (12-1)', short: 'Động lượng', char: 'mom12_1', long: 'high', desc: 'Mua mã tăng mạnh 12 tháng (bỏ tháng gần nhất), bán mã giảm mạnh. Hệ số dương = đang đi theo xu hướng.' },
    { key: 'LVOL', label: 'Biến động thấp: thấp trừ cao', short: 'Biến động thấp', char: 'vol60', long: 'low', desc: 'Mua mã dao động ít, bán mã dao động nhiều. Hệ số dương = nghiêng về cổ phiếu "hiền".' },
    { key: 'QUAL', label: 'Chất lượng: ROE cao trừ thấp', short: 'Chất lượng', char: 'roae', long: 'high', fund: true, desc: 'Mua mã ROE cao (đã công bố), bán mã ROE thấp. Hệ số dương = nghiêng về doanh nghiệp sinh lời tốt.' },
  ];
  const BY_KEY = {}; FACTORS.forEach((f) => { BY_KEY[f.key] = f; });

  // ---------- dựng lợi suất yếu tố ----------
  // P: bảng giá (BtPanel); pit: PitCalc.decodeDays(...). opts: { rf, minAdv, exchanges, minHistory, quantile, minStocks, maxStale, warmup, onlyKeys }
  function buildFactorReturns(P, pit, opts) {
    const o = Object.assign({ rf: 0.03, minAdv: 1e9, exchanges: ['HOSE', 'HNX'], minHistory: 120, quantile: 0.3, minStocks: 30, maxStale: 45, warmup: 260, onlyKeys: null }, opts || {});
    const uspec = { minAdv: o.minAdv, minPrice: 0, exchanges: o.exchanges, minHistory: o.minHistory, icbIn: [], icbOut: [] };
    const keys = FACTORS.filter((f) => f.kind !== 'market' && (!o.onlyKeys || o.onlyKeys.indexOf(f.key) !== -1));
    const T = P.T, start = Math.max(o.warmup, o.minHistory + 1);
    const sigs = SB.signalDays(P, 'M', start, T - 1).filter((t) => t < T - 1);
    const out = { series: {}, built: {}, legN: {}, months: sigs.length };
    const first = sigs.length ? sigs[0] + 1 : T;
    keys.forEach((f) => { out.series[f.key] = new Float64Array(T).fill(NaN); out.built[f.key] = 0; out.legN[f.key] = 0; });
    for (let k = 0; k < sigs.length; k++) {
      const t = sigs[k], t2 = k + 1 < sigs.length ? sigs[k + 1] : T - 1;
      let day = null;
      const needFund = keys.some((f) => f.fund);
      if (needFund) { const r = PC.dayAsOf(pit || [], P.dates[t], o.maxStale); day = r ? r.day : null; }
      const u = SB.universeAt(P, uspec, t, day);
      keys.forEach((f) => {
        if (f.fund && !day) return;
        const vals = [];
        for (let i = 0; i < u.uni.length; i++) { const s = u.uni[i]; const v = SB.factorValue(P, f.char, s, t, u.info.get(s).fm); if (v === v && isFinite(v)) vals.push([v, s]); }
        if (vals.length < o.minStocks) return;
        vals.sort((a, b) => a[0] - b[0]);
        const q = Math.max(5, Math.floor(vals.length * o.quantile));
        const low = vals.slice(0, q).map((x) => x[1]), high = vals.slice(vals.length - q).map((x) => x[1]);
        const L = f.long === 'high' ? high : low, S = f.long === 'high' ? low : high;
        out.built[f.key]++; out.legN[f.key] += q;
        for (let d = t + 1; d <= t2; d++) {
          let a = 0, na = 0, b = 0, nb = 0;
          for (let i = 0; i < L.length; i++) { const r = P.ret[L[i]][d]; if (r === r) { a += r; na++; } }
          for (let i = 0; i < S.length; i++) { const r = P.ret[S[i]][d]; if (r === r) { b += r; nb++; } }
          if (na >= 5 && nb >= 5) out.series[f.key][d] = a / na - b / nb;
        }
      });
    }
    // yếu tố thị trường: VN-Index vượt lãi suất tiền mặt
    const rfd = Math.pow(1 + o.rf, 1 / TD) - 1;
    const mk = new Float64Array(T).fill(NaN), ix = P.index.VNINDEX;
    if (ix) for (let d = 1; d < T; d++) if (ix[d] > 0 && ix[d - 1] > 0) mk[d] = ix[d] / ix[d - 1] - 1 - rfd;
    out.series.MKT = mk; out.built.MKT = T ? 1 : 0;
    Object.keys(out.legN).forEach((k) => { out.legN[k] = out.built[k] ? Math.round(out.legN[k] / out.built[k]) : 0; });
    out.first = first; out.rf = o.rf;
    return out;
  }

  // ---------- hồi quy nhiều biến với sai số Newey-West ----------
  function solve(A, B) {                           // A (n x n) X = B (n x m), Gauss-Jordan có chọn trụ
    const n = A.length, m = B[0].length, M = A.map((r, i) => r.concat(B[i]));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-14) return null;
      const t = M[c]; M[c] = M[p]; M[p] = t;
      const div = M[c][c]; for (let j = c; j < n + m; j++) M[c][j] /= div;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f !== 0) for (let j = c; j < n + m; j++) M[r][j] -= f * M[c][j]; }
    }
    return M.map((r) => r.slice(n));
  }
  // y: Float64Array/mảng (n), X: mảng các cột (k) mỗi cột n phần tử. Có hệ số chặn. lag: độ trễ Newey-West. Trả null nếu suy biến.
  function regress(y, X, lag) {
    const n = y.length, k = X.length, p = k + 1;
    if (n < p + 10) return null;
    const col = (j, i) => (j === 0 ? 1 : X[j - 1][i]);
    const XtX = Array.from({ length: p }, () => new Array(p).fill(0)), Xty = new Array(p).fill(0);
    for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { const xa = col(a, i); Xty[a] += xa * y[i]; for (let b = a; b < p; b++) XtX[a][b] += xa * col(b, i); }
    for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];
    const inv = solve(XtX, XtX.map((_, i) => XtX.map((__, j) => (i === j ? 1 : 0))));
    if (!inv) return null;
    const beta = new Array(p).fill(0);
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) beta[a] += inv[a][b] * Xty[b];
    const e = new Float64Array(n); let sse = 0, sst = 0, my = 0;
    for (let i = 0; i < n; i++) my += y[i]; my /= n;
    for (let i = 0; i < n; i++) { let f = 0; for (let a = 0; a < p; a++) f += beta[a] * col(a, i); e[i] = y[i] - f; sse += e[i] * e[i]; sst += (y[i] - my) * (y[i] - my); }
    // S = G0 + sum w_l (G_l + G_l'), G_l[a][b] = sum_t u_t[a] u_{t-l}[b], u_t = x_t e_t
    const U = []; for (let a = 0; a < p; a++) { const arr = new Float64Array(n); for (let i = 0; i < n; i++) arr[i] = col(a, i) * e[i]; U.push(arr); }
    const S = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let l = 0; l <= lag && l < n; l++) {
      const w = l === 0 ? 1 : 1 - l / (lag + 1);
      for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) { let g = 0; for (let i = l; i < n; i++) g += U[a][i] * U[b][i - l]; S[a][b] += w * g; if (l > 0) S[b][a] += w * g; }
    }
    const V = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) { let s = 0; for (let c = 0; c < p; c++) for (let d = 0; d < p; d++) s += inv[a][c] * S[c][d] * inv[d][b]; V[a][b] = s; }
    const se = V.map((r, i) => Math.sqrt(Math.max(r[i], 1e-300)));
    const r2 = sst > 0 ? 1 - sse / sst : NaN;
    // VIF từ ma trận tương quan của các biến giải thích (k >= 2)
    let vif = new Array(k).fill(1);
    if (k >= 2) {
      const mu = X.map((c) => mean(c)), sd = X.map((c) => stdev(c));
      const C = Array.from({ length: k }, () => new Array(k).fill(0));
      for (let a = 0; a < k; a++) for (let b = a; b < k; b++) { let s = 0; for (let i = 0; i < n; i++) s += (X[a][i] - mu[a]) * (X[b][i] - mu[b]); C[a][b] = C[b][a] = s / (n - 1) / (sd[a] * sd[b]); }
      const ci = solve(C, C.map((_, i) => C.map((__, j) => (i === j ? 1 : 0))));
      vif = ci ? ci.map((r, i) => r[i]) : vif.map(() => NaN);
    }
    return { n, k, alpha: beta[0], beta: beta.slice(1), tAlpha: beta[0] / se[0], t: beta.slice(1).map((b, i) => b / se[i + 1]), se: se.slice(1), r2, adjR2: 1 - (1 - r2) * (n - 1) / (n - p), residVol: Math.sqrt(sse / (n - p)) * Math.sqrt(TD), vif };
  }

  // ---------- danh mục ----------
  // weights: { MÃ: tỷ trọng trên NAV } (tổng <= 1, phần còn lại là tiền mặt hưởng lãi suất rf). Trả { dates, ret } trên cửa sổ [i0, i1].
  function portfolioReturns(P, weights, i0, i1, rf) {
    const syms = Object.keys(weights || {}).filter((s) => P.sIndex[s] !== undefined && weights[s] > 0), idx = syms.map((s) => P.sIndex[s]), w = syms.map((s) => weights[s]);
    const wsum = w.reduce((a, b) => a + b, 0), rfd = Math.pow(1 + (rf === undefined ? 0.03 : rf), 1 / TD) - 1;
    const n = i1 - i0 + 1, ret = new Float64Array(n), cov = new Float64Array(n);
    for (let d = 0; d < n; d++) {
      let r = 0, c = 0;
      for (let j = 0; j < idx.length; j++) { const x = P.ret[idx[j]][i0 + d]; if (x === x) { r += w[j] * x; c += w[j]; } }
      ret[d] = r + Math.max(0, 1 - wsum) * rfd; cov[d] = c;
    }
    return { symbols: syms, weights: w, wsum, ret, coverage: cov };
  }

  function drawdown(ret) { let v = 1, pk = 1, mdd = 0; for (let i = 0; i < ret.length; i++) { if (ret[i] === ret[i]) v *= 1 + ret[i]; if (v > pk) pk = v; const dd = v / pk - 1; if (dd < mdd) mdd = dd; } return mdd; }
  function perf(ret) {
    const n = ret.length; let v = 1, c = 0; for (let i = 0; i < n; i++) if (ret[i] === ret[i]) { v *= 1 + ret[i]; c++; }
    const sd = stdev(Array.from(ret)), m = mean(Array.from(ret));
    return { n: c, annReturn: c ? Math.pow(v, TD / c) - 1 : NaN, annVol: sd * Math.sqrt(TD), sharpe: sd > 0 ? m / sd * Math.sqrt(TD) : NaN, maxDD: drawdown(ret), cum: v - 1 };
  }

  // Hồi quy danh mục trên các yếu tố trong cửa sổ `window` phiên cuối. Trả { ok, reason, ... }.
  function analyze(P, pit, weights, opts, factors) {
    const o = Object.assign({ window: 504, rf: 0.03, keys: null, lag: 5 }, opts || {});
    const F = factors || buildFactorReturns(P, pit, o);
    const i1 = P.T - 1, i0 = Math.max(0, i1 - o.window + 1);
    const pr = portfolioReturns(P, weights, i0, i1, o.rf);
    if (!pr.symbols.length) return { ok: false, reason: 'Không có mã nào của danh mục trong kho giá.' };
    const rfd = Math.pow(1 + o.rf, 1 / TD) - 1;
    const keys = (o.keys || FACTORS.map((f) => f.key)).filter((k) => F.series[k] && Array.prototype.some.call(F.series[k].subarray(i0, i1 + 1), (x) => x === x));
    // chỉ giữ phiên mà mọi yếu tố được chọn và danh mục đều có số liệu
    const rows = [];
    for (let d = 0; d < pr.ret.length; d++) {
      const t = i0 + d; let ok = pr.coverage[d] > 0.5 * pr.wsum && pr.ret[d] === pr.ret[d];
      for (let j = 0; ok && j < keys.length; j++) if (!(F.series[keys[j]][t] === F.series[keys[j]][t])) ok = false;
      if (ok) rows.push(d);
    }
    if (rows.length < 100) return { ok: false, reason: 'Chỉ có ' + rows.length + ' phiên đủ số liệu cho cả danh mục và các yếu tố (cần ít nhất 100). Thử bỏ bớt yếu tố cần số liệu cơ bản hoặc rút ngắn cửa sổ.' };
    const y = Float64Array.from(rows, (d) => pr.ret[d] - rfd), X = keys.map((k) => Float64Array.from(rows, (d) => F.series[k][i0 + d]));
    const fit = regress(y, X, o.lag);
    if (!fit) return { ok: false, reason: 'Các yếu tố gần như trùng nhau (suy biến): không hồi quy được.' };
    const years = rows.length / TD;
    const contrib = keys.map((k, j) => ({ key: k, beta: fit.beta[j], t: fit.t[j], vif: fit.vif[j], meanFactorAnn: mean(Array.from(X[j])) * TD, contribAnn: fit.beta[j] * mean(Array.from(X[j])) * TD, sig: Math.abs(fit.t[j]) >= 2 }));
    const excessAnn = mean(Array.from(y)) * TD, explained = contrib.reduce((s, c) => s + c.contribAnn, 0);
    const factorPerf = keys.map((k) => { const sub = Float64Array.from(rows, (d) => F.series[k][i0 + d]); const full = Array.from(F.series[k]).filter((x) => x === x); const pf = perf(sub); return { key: k, annReturn: pf.annReturn, annVol: pf.annVol, sharpe: pf.sharpe, maxDD: pf.maxDD, fullAnnReturn: full.length ? mean(full) * TD : NaN, built: F.built[k], legN: F.legN[k] }; });
    return { ok: true, n: rows.length, years, from: P.dates[i0 + rows[0]], to: P.dates[i0 + rows[rows.length - 1]], keys, alphaAnn: fit.alpha * TD, tAlpha: fit.tAlpha, r2: fit.r2, adjR2: fit.adjR2, residVol: fit.residVol, contrib, excessAnn, explainedAnn: explained,
      port: perf(Float64Array.from(rows, (d) => pr.ret[d])), factorPerf, symbols: pr.symbols, weights: pr.weights, wsum: pr.wsum, multicollinear: contrib.some((c) => c.vif > 5) };
  }

  // ---------- phép đo theo từng mã đang nắm ----------
  // Phân vị đặc trưng (0-1) của danh mục (trọng số) so với vũ trụ tại ngày t. Trả { rows: [{ key, pct, z, coverage }], universe }.
  function exposures(P, pit, weights, t, opts) {
    const o = Object.assign({ minAdv: 1e9, exchanges: ['HOSE', 'HNX'], minHistory: 120, maxStale: 45 }, opts || {});
    const uspec = { minAdv: o.minAdv, minPrice: 0, exchanges: o.exchanges, minHistory: o.minHistory, icbIn: [], icbOut: [] };
    const r = PC.dayAsOf(pit || [], P.dates[t], o.maxStale), day = r ? r.day : null;
    const u = SB.universeAt(P, uspec, t, day);
    const held = Object.keys(weights || {}).filter((s) => P.sIndex[s] !== undefined && weights[s] > 0);
    const rows = [];
    FACTORS.filter((f) => f.kind !== 'market').forEach((f) => {
      if (f.fund && !day) { rows.push({ key: f.key, pct: null, z: null, coverage: 0, note: 'Chưa có bản chụp số liệu cơ bản gần ngày này.' }); return; }
      const vals = []; u.uni.forEach((s) => { const v = SB.factorValue(P, f.char, s, t, u.info.get(s).fm); if (v === v && isFinite(v)) vals.push(v); });
      if (vals.length < 30) { rows.push({ key: f.key, pct: null, z: null, coverage: 0, note: 'Vũ trụ có quá ít mã có số liệu.' }); return; }
      const sorted = vals.slice().sort((a, b) => a - b), mu = mean(vals), sd = stdev(vals);
      let wp = 0, wz = 0, wc = 0, wtot = 0;
      held.forEach((sym) => {
        const s = P.sIndex[sym], w = weights[sym]; wtot += w;
        const fm = u.info.get(s) ? u.info.get(s).fm : (day ? day.get(sym) : null);
        const v = SB.factorValue(P, f.char, s, t, fm);
        if (!(v === v && isFinite(v))) return;
        let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
        wp += w * (lo / sorted.length); wz += w * ((v - mu) / sd); wc += w;
      });
      // Hướng theo rổ MUA của yếu tố: quy mô và biến động có rổ mua là giá trị THẤP, nên lật phân vị / z để "cao hơn" luôn nghĩa là nghiêng về phía mua (mã nhỏ, ít biến động...)
      const flip = f.long === 'low';
      rows.push({ key: f.key, pct: wc > 0 ? (flip ? 1 - wp / wc : wp / wc) : null, z: wc > 0 ? (flip ? -wz / wc : wz / wc) : null, coverage: wtot > 0 ? wc / wtot : 0 });
    });
    return { rows, universe: u.uni.length, asOf: P.dates[t], fundAsOf: day ? day.asOf : null };
  }

  // Đường tích luỹ của từng yếu tố (1 = đầu), lấy mẫu mỗi `step` phiên, từ phiên đầu tiên có dữ liệu. dates: lịch của bảng giá.
  function curves(F, dates, step) {
    const T = dates.length, st = Math.max(1, step || 5), keys = Object.keys(F.series), out = { dates: [], series: {} };
    keys.forEach((k) => { out.series[k] = []; });
    const cum = {}; keys.forEach((k) => { cum[k] = 1; });
    const first = Math.max(1, F.first || 1);
    for (let d = first; d < T; d++) {
      keys.forEach((k) => { const r = F.series[k][d]; if (r === r) cum[k] *= 1 + r; });
      if ((d - first) % st === 0 || d === T - 1) { out.dates.push(dates[d]); keys.forEach((k) => { out.series[k].push(Math.round(cum[k] * 1e5) / 1e5); }); }
    }
    return out;
  }

  // Diễn giải bằng lời (chỉ nói điều số liệu cho phép)
  function narrate(res) {
    if (!res || !res.ok) return [];
    const out = [], name = (k) => (BY_KEY[k] ? BY_KEY[k].short : k);
    const pct = (v, d) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(d === undefined ? 1 : d).replace('.', ',') + '%';
    out.push('Các yếu tố giải thích ' + Math.round(res.r2 * 100) + '% biến động ngày của danh mục (R² điều chỉnh ' + Math.round(res.adjR2 * 100) + '%); phần còn lại là rủi ro riêng của từng mã (' + (res.residVol * 100).toFixed(1).replace('.', ',') + '%/năm).');
    const m = res.contrib.find((c) => c.key === 'MKT');
    if (m) out.push('Beta thị trường ' + m.beta.toFixed(2).replace('.', ',') + (m.beta > 1.1 ? ': danh mục khuếch đại biến động của VN-Index.' : m.beta < 0.8 ? ': danh mục phòng thủ hơn VN-Index.' : ': gần ngang VN-Index.'));
    res.contrib.filter((c) => c.key !== 'MKT' && c.sig).forEach((c) => out.push('Nghiêng về "' + name(c.key) + '" (hệ số ' + (c.beta >= 0 ? '+' : '−') + Math.abs(c.beta).toFixed(2).replace('.', ',') + ', t = ' + c.t.toFixed(1).replace('.', ',') + '): đóng góp ' + pct(c.contribAnn) + '/năm vào lợi suất.'));
    const ns = res.contrib.filter((c) => c.key !== 'MKT' && !c.sig).map((c) => name(c.key));
    if (ns.length) out.push('Chưa đủ bằng chứng thống kê (|t| < 2) về độ nghiêng theo: ' + ns.join(', ') + '.');
    out.push('Alpha ' + pct(res.alphaAnn) + '/năm (t = ' + res.tAlpha.toFixed(1).replace('.', ',') + (Math.abs(res.tAlpha) < 2 ? ': chưa khác 0 rõ rệt' : '') + ').');
    if (res.multicollinear) out.push('Cảnh báo: một số yếu tố tương quan mạnh với nhau (VIF > 5) nên hệ số riêng lẻ khó đọc.');
    return out;
  }

  return { TD, FACTORS, BY_KEY, buildFactorReturns, regress, portfolioReturns, perf, analyze, exposures, narrate, curves, solve };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FactorModel;
globalThis.FactorModel = FactorModel;
