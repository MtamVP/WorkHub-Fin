// Logic thuần: MARKET SIMULATION -- mô phỏng Monte Carlo thị trường Việt Nam và danh mục, so sánh các cách xử lý (chính sách) trên CÙNG một bộ đường giá.
//   * Thị trường (VN-Index): trộn hai mô hình đã ước lượng trên lịch sử thật (lib/sim-models.js): GJR-GARCH lấy mẫu lại phần dư chuẩn hoá (biến động hiện tại, đuôi dày)
//     và chuyển chế độ Markov (đổi tính khí thị trường, lấy mẫu lại lợi suất thật của những ngày cùng chế độ). Mặc định nửa số đường mỗi mô hình.
//   * Từng mã = beta (theo chế độ) x thị trường + phần riêng lấy mẫu lại THEO NGÀY lịch sử (cả hàng cùng ngày: giữ tương quan ngành và các phiên sập cùng lúc).
//   * Quy định thị trường Việt Nam: biên độ giá theo sàn (giá "ẩn" vượt biên độ thì dồn sang phiên sau -> chuỗi phiên sàn liên tiếp), nằm sàn thì KHÔNG bán được, nằm trần thì
//     không mua được, cổ phiếu mua T+2 mới bán được, lô 100, phí + thuế bán, chi phí tác động giá theo căn bậc hai khối lượng / thanh khoản, giới hạn tỷ lệ tham gia mỗi phiên.
//   * Chính sách: giữ, bán bớt ngay, cắt lỗ (cố định / động), chốt lời, mua khi thị trường giảm, kế hoạch có điều kiện theo nhánh thị trường ở mốc 1 tuần / 1 tháng.
//     Lệnh quyết định theo giá đóng cửa phiên t được khớp ở giá đóng cửa phiên t+1 (không nhìn trước tương lai).
//   * Đầu ra: phân phối lợi nhuận, VaR/CVaR, sụt giảm, xác suất, mức hối tiếc so với chính sách tốt nhất trên từng đường, lợi suất tương đương chắc chắn theo khẩu vị rủi ro,
//     cây kịch bản 3 mốc x 3 nhánh (giảm / đi ngang / tăng của VN-Index) với xác suất = tỷ lệ đường đi qua, và "điều gì phải đúng" ở nhóm đường xấu nhất.
//     Có sự kiện bối cảnh thì thêm cây theo sự kiện (gốc: xảy ra / không xảy ra). Kèm xác suất nhánh từng giai đoạn và lưới 39 phân vị (VN-Index, Giữ nguyên) để lưu và chấm điểm sau (lib/sim-score.js).
//   * Kiểm chứng ngược (backtest) của mô hình thị trường: tại nhiều ngày gốc trong quá khứ chỉ dùng dữ liệu tới ngày đó, dự báo phân phối 1 tuần / 1 tháng / 3 tháng rồi so với
//     thực tế: độ phủ khoảng dự báo, biểu đồ PIT, CRPS, điểm Brier cho xác suất nhánh so với tần suất lịch sử.
// Đây là xác suất THEO MÔ HÌNH (giả định lịch sử còn đại diện cho tương lai), không phải sự thật; trang hiển thị kèm kết quả kiểm chứng để biết mô hình đáng tin đến đâu.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường hoặc importScripts trong Web Worker (global MarketSim) và module.exports cho Vitest. Cần SimModels nạp trước.
const MarketSim = (function () {
  const SM = typeof SimModels !== 'undefined' ? SimModels : require('./sim-models.js');
  const TD = 252, LOT = 100;
  const BAND = { HOSE: 0.07, HNX: 0.10, UPCOM: 0.15 };
  const INDEX = '__INDEX__';
  const DEFAULTS = {
    paths: 10000, horizons: [5, 21, 63], seed: 20261009, model: 'blend', drift: 0.09, fee: 0.0015, tax: 0.001, participation: 0.2, impactK: 0.8,
    bands: [0.02, 0.04, 0.06], fitDays: 1750, riskAversion: 3, target: 0.1, K: null,
  };
  const isNum = (v) => v !== null && v !== undefined && typeof v === 'number' && isFinite(v);
  const bandOf = (ex) => { const e = String(ex || '').toUpperCase(); return BAND[e === 'HSX' ? 'HOSE' : e] || BAND.HOSE; };
  const lotDown = (q) => Math.floor(q / LOT + 1e-9) * LOT;
  const sortNum = (a) => Float64Array.from(a).sort();
  const q = SM.quantileSorted;

  // ---------- chuẩn bị: ước lượng mô hình từ lịch sử ----------
  // input: { dates: [YYYY-MM-DD], index: [điểm đóng cửa], stocks: { MÃ: { closes: [giá đã điều chỉnh, căn theo dates, null = thiếu], exchange, adv (giá trị giao dịch TB/phiên, đồng) } } }
  function logRets(closes) {
    const r = [];
    for (let t = 1; t < closes.length; t++) {
      const a = closes[t - 1], b = closes[t];
      const v = a > 0 && b > 0 ? Math.log(b / a) : null;
      r.push(v !== null && Math.abs(v) <= 0.35 ? v : null);    // nhảy > 35% một phiên = lỗi dữ liệu / sự kiện chưa điều chỉnh: bỏ
    }
    return r;
  }
  function anchorDrift(o, garch, hmm) {
    const out = { garchMu: garch ? garch.mu : 0, hmmShift: 0, mode: o.drift === null || o.drift === undefined ? 'hist' : 'anchored' };
    if (out.mode === 'hist') return out;
    const ld = Math.log(1 + Number(o.drift)) / TD;
    if (garch) out.garchMu = ld - 0.5 * garch.uncondVar;
    if (hmm) {
      const pi = hmm.stationary; let m = 0, ex2 = 0;
      for (let k = 0; k < hmm.K; k++) { m += pi[k] * hmm.mu[k]; ex2 += pi[k] * (hmm.sigma[k] * hmm.sigma[k] + hmm.mu[k] * hmm.mu[k]); }
      out.hmmShift = ld - 0.5 * (ex2 - m * m) - m;
    }
    return out;
  }
  function buildPools(hmm, T) {
    const pools = [];
    for (let k = 0; k < hmm.K; k++) {
      let p = []; for (let t = 0; t < T; t++) if (hmm.state[t] === k) p.push(t);
      if (p.length < 20) { p = hmm.smoothed.map((g, t) => [g[k], t]).sort((a, b) => b[0] - a[0]).slice(0, 20).map((x) => x[1]); }
      pools.push(Int32Array.from(p));
    }
    return pools;
  }
  // Hiệu chỉnh độ dời bằng mô phỏng thử: lợi suất đơn TRUNG BÌNH một năm, xuất phát từ trạng thái dừng (HMM) / phương sai dài hạn (GARCH), đúng bằng mức giả định.
  // Cần vì chế độ kéo dài nhiều phiên (trung bình theo chế độ tự tương quan) và đuôi dày làm công thức log chuẩn lệch: mô hình chế độ lệch tới vài điểm %/năm nếu chỉ dùng công thức.
  // Cùng hạt giống ở mọi vòng nên lặp hội tụ ổn định; sai số còn lại ~ độ lệch chuẩn lợi suất năm / căn(số đường).
  function calibrateDrift(lite, target, opts) {
    const o = opts || {}, P = o.paths || 4000, iters = o.iters || 2;
    ['garch', 'hmm'].forEach((m) => {
      for (let it = 0; it < iters; it++) {
        const last = simIndexOnly(lite, m, TD, P, SM.rng(o.seed || 99), { uncond: true, lastOnly: true });
        let s = 0; for (let p = 0; p < P; p++) s += Math.exp(last[p]);
        const adj = Math.log((1 + target) / (s / P)) / TD;
        if (m === 'garch') lite.drift.garchMu += adj; else lite.drift.hmmShift += adj;
      }
    });
    lite.drift.calibrated = true;
    return lite.drift;
  }
  function prepare(input, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const inp = input || {}, dates = inp.dates || [], idx = inp.index || [];
    if (dates.length !== idx.length || idx.length < 260) return { ok: false, reason: 'short', have: idx.length };
    let rmAll = logRets(idx), dAll = dates.slice(1);
    // bỏ ngày chỉ số thiếu, cắt theo cửa sổ ước lượng
    const keep = []; rmAll.forEach((v, t) => { if (isNum(v)) keep.push(t); });
    const sel = keep.slice(-o.fitDays);
    const rm = sel.map((t) => rmAll[t]), rdates = sel.map((t) => dAll[t]);
    const stocks = {}, meta = {};
    Object.keys(inp.stocks || {}).forEach((s) => {
      const st = inp.stocks[s], r = logRets(st.closes || []);
      const ser = sel.map((t) => r[t]);
      const n = ser.filter(isNum).length;
      const lastClose = (() => { const c = st.closes || []; for (let i = c.length - 1; i >= 0; i--) if (c[i] > 0) return c[i]; return null; })();
      const recent = ser.slice(-60).filter(isNum);
      meta[s] = { exchange: st.exchange || 'HOSE', band: bandOf(st.exchange), adv: st.adv > 0 ? st.adv : null, lastClose: lastClose, obs: n, sigD: recent.length > 10 ? Math.sqrt(SM.variance(recent)) : null };
      if (n >= 60) stocks[s] = ser;
    });
    const garch = SM.fitGarch(rm);
    const hmm = o.K ? SM.fitHmm(rm, o.K) : SM.fitHmmBest(rm, [2, 3]);
    if (!garch || !hmm) return { ok: false, reason: 'fit', have: rm.length };
    const factors = SM.fitFactors(rm, stocks, hmm.state, hmm.K);
    const ctx = {
      ok: true, opts: o, dates: rdates, lastDate: dates[dates.length - 1], indexLevel: idx[idx.length - 1], rm: Float64Array.from(rm),
      garch: garch, hmm: hmm, factors: factors, fIndex: {}, pools: buildPools(hmm, rm.length), meta: meta, drift: anchorDrift(o, garch, hmm), eventScale: eventScale(rm),
    };
    factors.syms.forEach((s, i) => { ctx.fIndex[s] = i; });
    if (ctx.drift.mode === 'anchored') calibrateDrift(ctx, Number(o.drift));
    return ctx;
  }

  // Tóm tắt mô hình cho giao diện (không gửi mảng lớn)
  function describe(ctx) {
    if (!ctx || !ctx.ok) return ctx;
    const g = ctx.garch, h = ctx.hmm, f = ctx.factors, TDs = Math.sqrt(TD);
    const ahead = (n) => { let p = h.current.slice(); for (let s = 0; s < n; s++) { const nx = new Array(h.K).fill(0); for (let i = 0; i < h.K; i++) for (let j = 0; j < h.K; j++) nx[j] += p[i] * h.P[i][j]; p = nx; } return p; };
    // lịch sử xác suất chế độ căng thẳng nhất (để vẽ), mỗi điểm một phiên
    const stressHist = h.filtered.map((a) => a[h.K - 1]);
    // dựng lại mức VN-Index ở từng ngày lợi suất (lùi từ mức cuối) để vẽ cùng xác suất chế độ
    const lv = new Array(ctx.rm.length); let L = ctx.indexLevel;
    for (let t = ctx.rm.length - 1; t >= 0; t--) { lv[t] = L; L = L / Math.exp(ctx.rm[t]); }
    return {
      ok: true, lastDate: ctx.lastDate, indexLevel: ctx.indexLevel, obs: ctx.rm.length, from: ctx.dates[0], to: ctx.dates[ctx.dates.length - 1], drift: ctx.drift, driftAnnual: ctx.opts.drift,
      garch: { alpha: g.alpha, gamma: g.gamma, beta: g.beta, persistence: g.persistence, volNowAnn: g.volNextAnn, volLongAnn: g.volLongAnn, halfLife: g.halfLife },
      hmm: {
        K: h.K, tried: h.tried || null, current: h.current, stationary: h.stationary, P: h.P, durations: h.durations,
        states: h.mu.map((m, k) => ({ k: k, muAnn: m * TD, volAnn: h.sigma[k] * TDs, share: h.state.filter((s) => s === k).length / h.state.length })),
        ahead: ctx.opts.horizons.map((n) => ({ h: n, p: ahead(n) })),
      },
      stressHist: { dates: ctx.dates, p: stressHist, index: lv },
      stocks: f.syms.map((s, i) => ({ symbol: s, beta: f.beta[i], betaK: f.betaK[i], idioAnn: f.idioAnn[i], idioNowAnn: f.sNow[i] === null ? null : f.sNow[i] * TDs, obs: f.obs[i], exchange: ctx.meta[s].exchange, adv: ctx.meta[s].adv })),
      thin: Object.keys(ctx.meta).filter((s) => ctx.fIndex[s] === undefined),
      eventScale: ctx.eventScale,
    };
  }

  // ---------- sinh một đường thị trường + giá các mã ----------
  // Ghi vào buf: ix (Float64Array H+1, chỉ số tương đối, ix[0]=1), st (Int8Array H+1, trạng thái HMM hoặc -1 với GARCH), px (Float64Array (H+1)*M), lk (Uint8Array (H+1)*M: 1 nằm sàn, 2 nằm trần)
  // shock (tuỳ chọn): { m: Float64Array H+1 cộng vào lợi suất log thị trường phiên t, s: Float64Array (H+1)*M cộng thêm riêng cho mã j (cú sốc ngành) } -- sự kiện của bối cảnh.
  // Với GARCH cú sốc thị trường đi vào phần "bất ngờ" e nên biến động các phiên sau tăng theo (cú sốc lớn làm thị trường biến động mạnh hơn, như thật).
  function genPath(ctx, pos, H, model, R, buf, alphaAdj, shock) {
    const f = ctx.factors, N = f.N, M = pos.length, rm = ctx.rm, T = rm.length;
    const g = ctx.garch, h = ctx.hmm, dr = ctx.drift;
    const lat = buf.lat; for (let j = 0; j < M; j++) { lat[j] = 0; buf.px[j] = pos[j].price; buf.lk[j] = 0; }
    buf.ix[0] = 1; buf.st[0] = -1;
    let level = 1, s2 = g.sigma2Next, s = -1;
    if (model === 'hmm') { const u = R.u(); let c = 0; s = h.K - 1; for (let k = 0; k < h.K; k++) { c += h.current[k]; if (u < c) { s = k; break; } } }
    for (let t = 1; t <= H; t++) {
      let r, d;
      if (model === 'hmm') {
        const row = h.P[s], u = R.u(); let c = 0, ns = h.K - 1; for (let k = 0; k < h.K; k++) { c += row[k]; if (u < c) { ns = k; break; } } s = ns;
        const pool = ctx.pools[s]; d = pool[R.int(pool.length)];
        r = rm[d] + dr.hmmShift + (shock ? shock.m[t] : 0);
      } else {
        d = R.int(T);
        const e = Math.sqrt(s2) * g.z[d] + (shock ? shock.m[t] : 0); r = dr.garchMu + e;
        s2 = g.omega + (g.alpha + (e < 0 ? g.gamma : 0)) * e * e + g.beta * s2;
      }
      level *= Math.exp(r); buf.ix[t] = level; buf.st[t] = model === 'hmm' ? s : -1;
      const base = t * M, prev = (t - 1) * M;
      for (let j = 0; j < M; j++) {
        const p = pos[j];
        if (p.kind === 'index') { buf.px[base + j] = p.price * level; buf.lk[base + j] = 0; continue; }
        if (p.kind === 'flat') { buf.px[base + j] = p.price; buf.lk[base + j] = 0; continue; }
        const i = p.fi;
        let e = f.resid[d * N + i];
        if (model !== 'hmm' && isNum(e)) { const sc = f.scale[d * N + i], now = f.sNow[i]; e *= sc > 0 && now > 0 ? Math.min(2.5, Math.max(0.5, now / sc)) : 1; }
        if (!isNum(e)) {                                       // mã không giao dịch ngày đó: lấy phần riêng của một ngày khác cùng chế độ
          for (let tries = 0; tries < 12 && !isNum(e); tries++) { const dd = model === 'hmm' ? ctx.pools[s][R.int(ctx.pools[s].length)] : R.int(T); e = f.resid[dd * N + i]; }
          if (!isNum(e)) e = 0;
        }
        const b = model === 'hmm' ? f.betaK[i][s] : f.beta[i];
        lat[j] += (alphaAdj ? alphaAdj[j] : 0) + b * r + e + (shock ? shock.s[base + j] : 0);
        const target = p.price * Math.exp(lat[j]), pr = buf.px[prev + j], lo = pr * (1 - p.band), hi = pr * (1 + p.band);
        let obs = target, lock = 0;
        if (target <= lo) { obs = lo; lock = 1; } else if (target >= hi) { obs = hi; lock = 2; }
        buf.px[base + j] = obs; buf.lk[base + j] = lock;
      }
    }
  }

  // ---------- chính sách ----------
  // pol: { id, label, now: { sellPct, buyPct }, stop: { pct, trailing }, take: { pct, sellPct }, dip: { drop, deployPct }, rules: [{ stage: 1|2, when: 'down'|'flat'|'up', act: 'sell'|'buy', pct }] }
  const PRESETS = [
    { id: 'hold', label: 'Giữ nguyên' },
    { id: 'trim30', label: 'Giảm 30% ngay', now: { sellPct: 30 } },
    { id: 'stop8', label: 'Cắt lỗ cố định 8%', stop: { pct: 8, trailing: false } },
    { id: 'trail12', label: 'Cắt lỗ động 12%', stop: { pct: 12, trailing: true } },
    { id: 'tp20', label: 'Chốt lời một nửa khi +20%', take: { pct: 20, sellPct: 50 } },
    { id: 'dip', label: 'Mua thêm khi VN-Index giảm 7%', dip: { drop: 7, deployPct: 50 } },
    { id: 'plan', label: 'Kế hoạch: 1 tuần mà thị trường giảm thì hạ 30%', rules: [{ stage: 1, when: 'down', act: 'sell', pct: 30 }] },
    { id: 'cash', label: 'Bán hết, giữ tiền', now: { sellPct: 100 } },
  ];
  function validatePolicy(p) {
    const x = p || {}, out = { id: String(x.id || 'p'), label: String(x.label || x.id || 'Chính sách').slice(0, 80) };
    // tỷ lệ phần trăm "bao nhiêu" (bán / mua / dùng tiền) chặn về [lo, hi]; còn NGƯỠNG kích hoạt (cắt lỗ, chốt lời, mức giảm) ngoài khoảng hợp lệ thì BỎ, không chặn:
    // gõ nhầm -5 thành ngưỡng cắt lỗ 0,5% (cực chặt) nguy hiểm hơn là không có cắt lỗ
    const pct = (v, lo, hi) => { const n = Number(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
    const thr = (v, lo, hi) => { const n = Number(v); return isFinite(n) && n >= lo && n <= hi ? n : null; };
    if (x.now) { const s = pct(x.now.sellPct, 0, 100), b = pct(x.now.buyPct, 0, 100); if (s || b) out.now = { sellPct: s || 0, buyPct: b || 0 }; }
    if (x.stop && thr(x.stop.pct, 0.5, 90)) out.stop = { pct: thr(x.stop.pct, 0.5, 90), trailing: !!x.stop.trailing };
    if (x.take && thr(x.take.pct, 0.5, 500)) out.take = { pct: thr(x.take.pct, 0.5, 500), sellPct: pct(x.take.sellPct === undefined ? 100 : x.take.sellPct, 1, 100) };
    if (x.dip && thr(x.dip.drop, 0.5, 60)) out.dip = { drop: thr(x.dip.drop, 0.5, 60), deployPct: pct(x.dip.deployPct === undefined ? 50 : x.dip.deployPct, 1, 100) };
    if (Array.isArray(x.rules)) {
      const rules = x.rules.filter((r) => r && (r.stage === 1 || r.stage === 2) && ['down', 'flat', 'up'].indexOf(r.when) !== -1 && ['sell', 'buy'].indexOf(r.act) !== -1 && pct(r.pct, 1, 100))
        .map((r) => { const o2 = { stage: r.stage, when: r.when, act: r.act, pct: pct(r.pct, 1, 100) }; if (typeof r.path === 'string' && /^[012]+$/.test(r.path) && r.path.length === r.stage) { o2.path = r.path; o2.when = ['down', 'flat', 'up'][+r.path[r.stage - 1]]; } return o2; });
      if (rules.length) out.rules = rules;
    }
    return out;
  }
  const branchOf = (ret, band) => (ret < -band ? 0 : (ret > band ? 2 : 1));

  // Chạy một chính sách trên một đường đã sinh. Ghi NAV từng phiên vào navOut (Float64Array H+1). Trả số phiên bị kẹt sàn khi muốn bán (để thống kê).
  function runPolicy(pol, ctx, book, pos, H, buf, o, navOut, scratch) {
    const M = pos.length, qty = scratch.qty, avail = scratch.avail, sellQ = scratch.sellQ, buyV = scratch.buyV, peak = scratch.peak, done = scratch.done, w0 = scratch.w0;
    let cash = book.cash, pend = [], dipDone = false, stuck = 0;
    for (let j = 0; j < M; j++) { qty[j] = pos[j].qty; avail[j] = pos[j].qty; sellQ[j] = 0; buyV[j] = 0; peak[j] = pos[j].price; done[j] = 0; }
    const hz = o.horizons, ruleDone = {}, brs = [];
    const lotQ = (j, x) => (pos[j].kind === 'index' ? x : lotDown(x));          // tài sản theo chỉ số (như chứng chỉ quỹ ETF quy đổi) không làm tròn lô
    const queueSellPct = (pct) => { for (let j = 0; j < M; j++) if (pos[j].kind !== 'flat' && qty[j] > 0) { const want = pct >= 100 ? qty[j] : lotQ(j, qty[j] * pct / 100); sellQ[j] = Math.min(qty[j], sellQ[j] + (want > 0 ? want : (qty[j] < LOT ? qty[j] : 0))); } };
    const queueBuy = (budget) => { if (!(budget > 0)) return; for (let j = 0; j < M; j++) if (pos[j].kind !== 'flat' && w0[j] > 0) buyV[j] += budget * w0[j]; };
    if (pol.now) { if (pol.now.sellPct) queueSellPct(pol.now.sellPct); if (pol.now.buyPct) queueBuy(cash * pol.now.buyPct / 100); }
    for (let t = 0; t <= H; t++) {
      const base = t * M;
      // thanh toán T+2
      if (pend.length) { const keep = []; for (let k = 0; k < pend.length; k++) { const x = pend[k]; if (x.day <= t) avail[x.j] += x.q; else keep.push(x); } pend = keep; }
      // khớp lệnh đang chờ ở giá phiên t
      for (let j = 0; j < M; j++) {
        const p = pos[j]; if (p.kind === 'flat') continue;
        const price = buf.px[base + j], lock = buf.lk[base + j];
        const cap = p.adv ? o.participation * p.adv / price : Infinity;
        if (sellQ[j] > 0) {
          if (lock === 1) stuck++;
          else {
            let qq = Math.min(sellQ[j], avail[j], qty[j]);
            if (qq > cap) qq = lotQ(j, cap);
            if (qq > 0) {
              const v = qq * price, imp = p.adv ? Math.min(0.1, o.impactK * p.sigD * Math.sqrt(v / p.adv)) : 0;
              cash += v * (1 - o.fee - o.tax - imp); qty[j] -= qq; avail[j] -= qq; sellQ[j] -= qq;
            }
            if (qty[j] <= 0) sellQ[j] = 0;
          }
        }
        if (buyV[j] > 0 && lock !== 2) {
          const v = Math.min(buyV[j], Math.max(0, cash), p.adv ? o.participation * p.adv : Infinity);
          const imp = p.adv ? Math.min(0.1, o.impactK * p.sigD * Math.sqrt(v / p.adv)) : 0;
          const qq = lotQ(j, v / (price * (1 + o.fee + imp)));
          if (qq > 0) { cash -= qq * price * (1 + o.fee + imp); qty[j] += qq; pend.push({ j: j, q: qq, day: t + 2 }); }
          buyV[j] = qq > 0 && buyV[j] - qq * price > price * (p.kind === 'index' ? 0.01 : LOT) ? buyV[j] - qq * price : 0;
        }
      }
      let nav = cash - book.debt; for (let j = 0; j < M; j++) nav += qty[j] * buf.px[base + j];
      navOut[t] = nav;
      if (t === H) break;
      // quyết định theo giá đóng cửa phiên t, khớp từ phiên t+1
      for (let j = 0; j < M; j++) {
        const p = pos[j]; if (p.kind === 'flat' || qty[j] <= 0) continue;
        const price = buf.px[base + j];
        if (pol.stop && !(done[j] & 1)) {
          if (price > peak[j]) peak[j] = price;
          const level = (pol.stop.trailing ? peak[j] : p.price) * (1 - pol.stop.pct / 100);
          if (price <= level) { sellQ[j] = qty[j]; done[j] |= 1; }
        }
        if (pol.take && !(done[j] & 2) && price >= p.price * (1 + pol.take.pct / 100)) {
          const want = pol.take.sellPct >= 100 ? qty[j] : Math.max(lotQ(j, qty[j] * pol.take.sellPct / 100), qty[j] < LOT ? qty[j] : 0);
          sellQ[j] = Math.min(qty[j], sellQ[j] + want); done[j] |= 2;
        }
      }
      if (pol.dip && !dipDone && buf.ix[t] <= 1 - pol.dip.drop / 100) { dipDone = true; queueBuy(cash * pol.dip.deployPct / 100); }
      if (pol.rules) {
        for (let k = 0; k < 2; k++) {
          if (t !== hz[k]) continue;
          const prevT = k === 0 ? 0 : hz[k - 1], ret = Math.log(buf.ix[t] / buf.ix[prevT]), br = branchOf(ret, o.bands[k]);
          brs[k] = br;
          pol.rules.forEach((r, ri) => {
            if (r.stage !== k + 1 || ruleDone[ri]) return;
            if (['down', 'flat', 'up'][br] !== r.when) return;
            if (r.path) { for (let s2 = 0; s2 < k; s2++) if (+r.path[s2] !== brs[s2]) return; }
            ruleDone[ri] = true;
            if (r.act === 'sell') queueSellPct(r.pct); else queueBuy(cash * r.pct / 100);
          });
        }
      }
    }
    return stuck;
  }

  // ---------- thống kê ----------
  function stats(arr, o, dd) {
    const s = sortNum(arr), n = s.length; if (!n) return null;
    let sum = 0, l0 = 0, l5 = 0, l10 = 0, g10 = 0, tg = 0, ceSum = 0;
    const gam = o.riskAversion, tgt = o.target;
    for (let i = 0; i < n; i++) {
      const v = s[i]; sum += v; if (v < 0) l0++; if (v < -0.05) l5++; if (v < -0.1) l10++; if (v > 0.1) g10++; if (v >= tgt) tg++;
      const w = Math.max(1 + v, 1e-4); ceSum += gam === 1 ? Math.log(w) : Math.pow(w, 1 - gam);
    }
    const k = Math.max(1, Math.floor(n * 0.05)); let tail = 0; for (let i = 0; i < k; i++) tail += s[i];
    const ce = gam === 1 ? Math.exp(ceSum / n) - 1 : Math.pow(ceSum / n, 1 / (1 - gam)) - 1;
    const out = { n: n, mean: sum / n, median: q(s, 0.5), q05: q(s, 0.05), q25: q(s, 0.25), q75: q(s, 0.75), q95: q(s, 0.95), pLoss: l0 / n, pLoss5: l5 / n, pLoss10: l10 / n, pGain10: g10 / n, pTarget: tg / n, var95: -q(s, 0.05), cvar95: -tail / k, ce: ce };
    if (dd) { const d = sortNum(dd); out.ddMedian = q(d, 0.5); out.dd95 = q(d, 0.05); }
    return out;
  }

  // ---------- sự kiện của bối cảnh (thẻ sự kiện do AI gợi ý hoặc người dùng nhập) ----------
  // Mức thô -> số: độ lớn cú sốc hiệu chỉnh theo CHÍNH lịch sử VN-Index (phân vị của |lợi suất 5 phiên|: nhỏ = trung vị, vừa = 85%, lớn = 97%), không do AI đặt.
  // Khả năng thô -> xác suất xảy ra trong kỳ: thấp 15%, vừa 35%, cao 60% (điểm xuất phát; người dùng chỉnh trên thẻ).
  // Sự kiện ngành: cổ phiếu trong ngành chịu thêm 1,5 lần mức sốc (ngành biến động mạnh hơn chỉ số), thị trường chung chịu 25% (lan toả); người dùng ghi đè được cả hai.
  const EVENT_PRIOR = { low: 0.15, medium: 0.35, high: 0.6 };
  const EVENT_WINDOW = { '1w': 5, '1m': 21, '3m': 63 };
  const SECTOR_MULT = 1.5, SECTOR_SPILL = 0.25, EVENT_TREES = 3;
  // Mức phân vị lưu cho việc chấm điểm sau này: 0,025 .. 0,975 bước 0,025 (39 mức, gồm 5/25/50/75/95%)
  const GRID = Array.from({ length: 39 }, (v, i) => Math.round((i + 1) * 25) / 1000);
  function eventScale(rm) {
    const r = Array.from(rm || []).filter(isNum), a = [];
    for (let i = 0; i + 5 <= r.length; i++) a.push(Math.abs(r[i] + r[i + 1] + r[i + 2] + r[i + 3] + r[i + 4]));
    if (a.length < 50) return { small: 0.02, medium: 0.05, large: 0.1, obs: a.length };
    const s = sortNum(a);
    return { small: q(s, 0.5), medium: q(s, 0.85), large: q(s, 0.97), obs: a.length };
  }
  // Thẻ (do giao diện giữ) -> sự kiện cho bộ máy. card: { id, title, on, prob (0..1, null = theo likelihood), likelihood, window, direction, magnitude, scope, sectors[],
  //   marketMove / sectorMove (tỷ lệ, ghi đè độ lớn; null = theo thang) }. Trả null nếu thẻ tắt hoặc không có tác động.
  function eventFromCard(card, scale) {
    const c = card || {}, sc = scale || { small: 0.02, medium: 0.05, large: 0.1 };
    if (c.on === false) return null;
    const p0 = isNum(Number(c.prob)) && c.prob !== null && c.prob !== '' ? Number(c.prob) : (EVENT_PRIOR[c.likelihood] || EVENT_PRIOR.medium);
    const p = Math.min(1, Math.max(0, p0));
    const base = sc[c.magnitude] || sc.medium, sector = c.scope === 'sector' && Array.isArray(c.sectors) && c.sectors.length;
    const mm = c.marketMove !== null && c.marketMove !== undefined && c.marketMove !== '' && isNum(Number(c.marketMove)) ? Math.abs(Number(c.marketMove)) : (sector ? SECTOR_SPILL * base : base);
    const sm = !sector ? 0 : (c.sectorMove !== null && c.sectorMove !== undefined && c.sectorMove !== '' && isNum(Number(c.sectorMove)) ? Math.abs(Number(c.sectorMove)) : SECTOR_MULT * base);
    if (!(p > 0) || !(mm > 0 || sm > 0)) return null;
    // độ lớn nhập theo tỷ lệ giá (ví dụ 5% = 0,05) -> lợi suất log; chặn để một thẻ không thể xoá sạch thị trường
    const lg = (x) => Math.log(1 + Math.min(0.6, x));
    return { id: String(c.id || 'e'), title: String(c.title || '').slice(0, 110), p: p, win: EVENT_WINDOW[c.window] || 21, sign: c.direction === 'up' ? 1 : (c.direction === 'down' ? -1 : 0),
      jM: lg(mm), jS: sector ? lg(sm) : 0, sectors: sector ? c.sectors.slice(0, 6) : [] };
  }

  // ---------- mô phỏng chính ----------
  // book: { cash, debt, positions: [{ symbol, qty, price, sector? }] } -- symbol INDEX = tài sản đi theo VN-Index (như quỹ ETF chỉ số); sector dùng cho sự kiện ngành.
  // opts.events: danh sách sự kiện từ eventFromCard (mỗi đường: xảy ra với xác suất p, vào một phiên ngẫu nhiên trong cửa sổ, chiều theo hướng; "chưa rõ chiều" thì 50/50).
  // policies: danh sách chính sách (mục đầu tiên là gốc để tính đóng góp lỗ). opts: paths, seed, model ('blend'|'garch'|'hmm'), horizons, expected (MÃ -> lợi suất năm kỳ vọng, tuỳ chọn).
  function simulate(ctx, book, policies, opts) {
    if (!ctx || !ctx.ok) return { ok: false, reason: 'model' };
    const o = Object.assign({}, ctx.opts, opts || {});
    const hz = o.horizons.slice().sort((a, b) => a - b), H = hz[hz.length - 1], nH = hz.length, P = Math.max(100, Math.min(100000, Math.round(o.paths)));
    o.horizons = hz;
    const pols = (policies && policies.length ? policies : [PRESETS[0]]).map(validatePolicy);
    const bk = { cash: Number(book && book.cash) || 0, debt: Number(book && book.debt) || 0 };
    const pos = [], skipped = [];
    ((book && book.positions) || []).forEach((x) => {
      const sym = String(x.symbol || '').toUpperCase(), qty = Number(x.qty) || 0;
      if (!(qty > 0)) return;
      if (sym === INDEX) { pos.push({ symbol: INDEX, kind: 'index', qty: qty, price: Number(x.price) || ctx.indexLevel, band: 1, adv: null, sigD: 0 }); return; }
      const fi = ctx.fIndex[sym], m = ctx.meta[sym];
      const price = Number(x.price) > 0 ? Number(x.price) : (m && m.lastClose) || 0;
      if (fi === undefined || !(price > 0)) { pos.push({ symbol: sym, kind: 'flat', qty: qty, price: price, band: 0, adv: null, sigD: 0 }); skipped.push(sym); return; }
      pos.push({ symbol: sym, kind: 'stock', fi: fi, qty: qty, price: price, band: m.band, adv: m.adv, sigD: m.sigD || 0.02, sector: x.sector ? String(x.sector) : null });
    });
    const M = pos.length;
    let nav0 = bk.cash - bk.debt; pos.forEach((p) => { nav0 += p.qty * p.price; });
    if (!(nav0 > 0)) return { ok: false, reason: 'nav' };
    const mv0 = pos.reduce((s, p) => s + (p.kind === 'flat' ? 0 : p.qty * p.price), 0);
    const w0 = new Float64Array(M); pos.forEach((p, j) => { w0[j] = mv0 > 0 && p.kind !== 'flat' ? p.qty * p.price / mv0 : 0; });
    if (!(mv0 > 0)) { const live = pos.filter((p) => p.kind !== 'flat').length; pos.forEach((p, j) => { w0[j] = p.kind !== 'flat' && live ? 1 / live : 0; }); }
    // độ dời riêng của mã theo lợi suất kỳ vọng người dùng nhập (ví dụ từ giá trị hợp lý): alpha = ln(1+E)/252 - beta * ln(1+thị trường)/252
    let alphaAdj = null;
    if (o.expected && typeof o.expected === 'object') {
      alphaAdj = new Float64Array(M);
      const lm = Math.log(1 + (o.drift === null || o.drift === undefined ? 0.09 : o.drift)) / TD;
      pos.forEach((p, j) => { const e = Number(o.expected[p.symbol]); if (p.kind === 'stock' && isFinite(e) && e > -0.9) alphaAdj[j] = Math.log(1 + e) / TD - ctx.factors.beta[p.fi] * lm; });
    }
    const R = SM.rng(o.seed);
    const buf = { ix: new Float64Array(H + 1), st: new Int8Array(H + 1), px: new Float64Array((H + 1) * Math.max(1, M)), lk: new Uint8Array((H + 1) * Math.max(1, M)), lat: new Float64Array(Math.max(1, M)) };
    const scratch = { qty: new Float64Array(M), avail: new Float64Array(M), sellQ: new Float64Array(M), buyV: new Float64Array(M), peak: new Float64Array(M), done: new Uint8Array(M), w0: w0 };
    const nP = pols.length;
    const navH = pols.map(() => new Float64Array(P * nH)), ddH = pols.map(() => new Float64Array(P * nH)), navDay = pols.map(() => new Float32Array(P * (H + 1)));
    const idxH = new Float64Array(P * nH), idxDay = new Float32Array(P * (H + 1)), branch = new Uint8Array(P * nH), stressDays = new Float32Array(P * nH), modelOf = new Uint8Array(P);
    const posPnl = new Float64Array(P * nH * Math.max(1, M));
    const navTmp = new Float64Array(H + 1);
    // sự kiện: lịch xảy ra được bốc bằng bộ số ngẫu nhiên RIÊNG (hạt giống lệch) để bật/tắt sự kiện không làm xáo trộn phần lịch sử của các đường
    const evs = (Array.isArray(o.events) ? o.events : []).filter((e) => e && e.p > 0 && e.win > 0).slice(0, 12), nE = evs.length;
    const evDay = new Int16Array(P * Math.max(1, nE)), RE = SM.rng((Number(o.seed) || 1) ^ 0x5bd1e995);
    const shock = nE ? { m: new Float64Array(H + 1), s: new Float64Array((H + 1) * Math.max(1, M)) } : null;
    const inSector = evs.map((e) => pos.map((x) => (x.sector && e.sectors.indexOf(x.sector) !== -1 ? 1 : 0)));
    let stuckTotal = 0;
    for (let p = 0; p < P; p++) {
      const model = o.model === 'blend' ? (p % 2 ? 'hmm' : 'garch') : o.model;
      modelOf[p] = model === 'hmm' ? 1 : 0;
      if (shock) {
        shock.m.fill(0); shock.s.fill(0);
        for (let e = 0; e < nE; e++) {
          const ev = evs[e], hit = RE.u() < ev.p, day = 1 + RE.int(Math.min(ev.win, H)), sg = ev.sign || (RE.u() < 0.5 ? -1 : 1);
          if (!hit) continue;
          evDay[p * nE + e] = day;
          shock.m[day] += sg * ev.jM;
          if (ev.jS) for (let j = 0; j < M; j++) if (inSector[e][j]) shock.s[day * M + j] += sg * ev.jS;
        }
      }
      genPath(ctx, pos, H, model, R, buf, alphaAdj, shock);
      for (let t = 0; t <= H; t++) idxDay[p * (H + 1) + t] = buf.ix[t];
      let prevB = 0, stressN = 0, hk = 0;
      for (let t = 1; t <= H; t++) {
        if (model === 'hmm' && buf.st[t] === ctx.hmm.K - 1) stressN++;
        if (t === hz[hk]) {
          idxH[p * nH + hk] = buf.ix[t] - 1;
          branch[p * nH + hk] = branchOf(Math.log(buf.ix[t] / buf.ix[prevB]), o.bands[Math.min(hk, o.bands.length - 1)]);
          stressDays[p * nH + hk] = model === 'hmm' ? stressN / t : NaN;
          for (let j = 0; j < M; j++) posPnl[(p * nH + hk) * M + j] = pos[j].qty * (buf.px[t * M + j] - pos[j].price);
          prevB = t; hk++;
        }
      }
      for (let k = 0; k < nP; k++) {
        stuckTotal += runPolicy(pols[k], ctx, bk, pos, H, buf, o, navTmp, scratch);
        let peakN = nav0, dd = 0, hk2 = 0;
        for (let t = 0; t <= H; t++) {
          const v = navTmp[t]; navDay[k][p * (H + 1) + t] = v / nav0;
          if (v > peakN) peakN = v; const d = peakN > 0 ? v / peakN - 1 : -1; if (d < dd) dd = d;
          if (hk2 < nH && t === hz[hk2]) { navH[k][p * nH + hk2] = v / nav0 - 1; ddH[k][p * nH + hk2] = dd; hk2++; }
        }
      }
    }
    return summarize({ ctx: ctx, o: o, pols: pols, pos: pos, skipped: skipped, nav0: nav0, P: P, H: H, hz: hz, navH: navH, ddH: ddH, navDay: navDay, idxH: idxH, idxDay: idxDay, branch: branch, stressDays: stressDays, posPnl: posPnl, modelOf: modelOf, stuck: stuckTotal, evs: evs, evDay: evDay, inSector: inSector });
  }

  function fanOf(day, P, H) {
    const out = { q05: [], q25: [], q50: [], q75: [], q95: [] }, col = new Float64Array(P);
    for (let t = 0; t <= H; t++) {
      for (let p = 0; p < P; p++) col[p] = day[p * (H + 1) + t];
      col.sort();
      out.q05.push(q(col, 0.05)); out.q25.push(q(col, 0.25)); out.q50.push(q(col, 0.5)); out.q75.push(q(col, 0.75)); out.q95.push(q(col, 0.95));
    }
    return out;
  }
  // Thống kê của các chính sách trên một tập con đường (idx: Int32Array chỉ số đường) ở mốc hk
  function compare(S, idx, hk) {
    const nP = S.pols.length, nH = S.hz.length, n = idx.length;
    if (!n) return null;
    const vals = S.pols.map((p, k) => { const a = new Float64Array(n), d = new Float64Array(n); for (let i = 0; i < n; i++) { a[i] = S.navH[k][idx[i] * nH + hk]; d[i] = S.ddH[k][idx[i] * nH + hk]; } return { a: a, d: d }; });
    const regret = S.pols.map(() => new Float64Array(n)), best = new Float64Array(nP);
    for (let i = 0; i < n; i++) {
      let mx = -Infinity; for (let k = 0; k < nP; k++) if (vals[k].a[i] > mx) mx = vals[k].a[i];
      let ties = 0; for (let k = 0; k < nP; k++) if (vals[k].a[i] >= mx - 1e-12) ties++;
      for (let k = 0; k < nP; k++) { regret[k][i] = mx - vals[k].a[i]; if (vals[k].a[i] >= mx - 1e-12) best[k] += 1 / ties; }
    }
    return S.pols.map((p, k) => {
      const st = stats(vals[k].a, S.o, vals[k].d), rs = sortNum(regret[k]);
      st.regretMean = SM.mean(regret[k]); st.regret95 = q(rs, 0.95); st.pBest = best[k] / n;
      return Object.assign({ id: p.id, label: p.label }, st);
    });
  }
  function pickBest(rows) {
    if (!rows || !rows.length) return null;
    const by = (f, dir) => rows.reduce((b, r) => (b === null || dir * (f(r) - f(b)) > 0 ? r : b), null).id;
    return { mean: by((r) => r.mean, 1), ce: by((r) => r.ce, 1), cvar: by((r) => -r.cvar95, 1), regret: by((r) => -r.regretMean, 1) };
  }

  // Cây (mảng nút) cho một tập đường idx, các nút có id = prefix + chuỗi nhánh; nút chỉ được tách tiếp khi có từ 30 đường trở lên
  function treeOf(S, prefix, idx) {
    const o = S.o, P = S.P, nH = S.hz.length, nodes = [];
    const walk = (pre, list, depth) => {
      if (depth >= nH) return;
      const groups = [[], [], []]; for (let i = 0; i < list.length; i++) groups[S.branch[list[i] * nH + depth]].push(list[i]);
      groups.forEach((g, b) => {
        const id = pre + b, gi = Int32Array.from(g);
        const ia = new Float64Array(g.length); for (let i = 0; i < g.length; i++) ia[i] = S.idxH[g[i] * nH + depth];
        const sd = g.map((p) => S.stressDays[p * nH + depth]).filter((v) => isFinite(v));
        const rows = g.length >= 30 ? compare(S, gi, depth) : null;
        nodes.push({ id: id, depth: depth + 1, h: S.hz[depth], branch: b, n: g.length, prob: g.length / P, parentProb: list.length ? g.length / list.length : 0,
          index: g.length ? stats(ia, o) : null, stressShare: sd.length ? SM.mean(sd) : null, policies: rows, best: pickBest(rows) });
        if (g.length >= 30) walk(id, gi, depth + 1);
      });
    };
    walk(prefix, idx, 0);
    return nodes;
  }

  function summarize(S) {
    const o = S.o, P = S.P, nH = S.hz.length, all = new Int32Array(P); for (let p = 0; p < P; p++) all[p] = p;
    const horizons = S.hz.map((h, hk) => {
      const rows = compare(S, all, hk);
      const ia = new Float64Array(P); for (let p = 0; p < P; p++) ia[p] = S.idxH[p * nH + hk];
      return { h: h, policies: rows, best: pickBest(rows), index: stats(ia, o) };
    });
    // cây kịch bản: mỗi nút = tiền tố nhánh qua các mốc; thống kê chính sách ở mốc của nút, chỉ trên các đường đi qua nút
    const nodes = treeOf(S, '', all);
    // xác suất 3 nhánh của từng giai đoạn (không điều kiện) và lưới phân vị lợi suất VN-Index ở từng mốc: phần lưu lại để sau này chấm điểm với thực tế (lib/sim-score.js)
    const branchProb = S.hz.map((h, hk) => { const c = [0, 0, 0]; for (let p = 0; p < P; p++) c[S.branch[p * nH + hk]]++; return c.map((v) => v / P); });
    const gridOf = (get) => S.hz.map((h, hk) => { const a = new Float64Array(P); for (let p = 0; p < P; p++) a[p] = get(p, hk); a.sort(); return GRID.map((g) => q(a, g)); });
    const indexGrid = gridOf((p, hk) => S.idxH[p * nH + hk]), holdGrid = gridOf((p, hk) => S.navH[0][p * nH + hk]);
    // điều gì phải đúng: 5% đường xấu nhất và tốt nhất của chính sách gốc ở từng mốc
    const M = S.pos.length;
    const drivers = S.hz.map((h, hk) => {
      const ord = Array.from(all).sort((a, b) => S.navH[0][a * nH + hk] - S.navH[0][b * nH + hk]);
      const k = Math.max(1, Math.floor(P * 0.05));
      const side = (list) => {
        const ia = list.map((p) => S.idxH[p * nH + hk]).sort((a, b) => a - b);
        const sd = list.map((p) => S.stressDays[p * nH + hk]).filter((v) => isFinite(v));
        const contrib = S.pos.map((x, j) => { let s = 0; list.forEach((p) => { s += S.posPnl[(p * nH + hk) * M + j]; }); return { symbol: x.symbol, vnd: s / list.length, pctNav: s / list.length / S.nav0 }; }).sort((a, b) => a.vnd - b.vnd);
        const port = list.map((p) => S.navH[0][p * nH + hk]);
        return { portMean: SM.mean(port), indexMedian: q(ia, 0.5), indexQ25: q(ia, 0.25), indexQ75: q(ia, 0.75), stressShare: sd.length ? SM.mean(sd) : null, contrib: contrib };
      };
      return { h: h, worst: side(ord.slice(0, k)), best: side(ord.slice(P - k)) };
    });
    // độ nhạy với VN-Index: lợi nhuận trung vị của chính sách gốc theo từng khoảng thay đổi của chỉ số (mốc cuối)
    const hkL = nH - 1, bins = [-Infinity, -0.15, -0.08, -0.03, 0.03, 0.08, 0.15, Infinity];
    const sens = bins.slice(0, -1).map((lo, b) => {
      const hi = bins[b + 1], list = []; for (let p = 0; p < P; p++) { const v = S.idxH[p * nH + hkL]; if (v >= lo && v < hi) list.push(S.navH[0][p * nH + hkL]); }
      const s = sortNum(list); return { lo: lo, hi: hi, n: list.length, prob: list.length / P, median: list.length ? q(s, 0.5) : null, q05: list.length ? q(s, 0.05) : null, q95: list.length ? q(s, 0.95) : null };
    });
    // tác động từng sự kiện: so sánh các đường có sự kiện xảy ra (tới mốc) với các đường không có; cách xử lý tốt nhất khi sự kiện xảy ra
    const nE = S.evs ? S.evs.length : 0;
    const events = (S.evs || []).map((ev, e) => ({
      id: ev.id, title: ev.title, p: ev.p, win: ev.win, sign: ev.sign, jM: ev.jM, jS: ev.jS, sectors: ev.sectors, exposed: S.pos.filter((x, j) => S.inSector[e][j]).map((x) => x.symbol),
      byHorizon: S.hz.map((h, hk) => {
        const yes = [], no = [];
        for (let p = 0; p < P; p++) { const d = S.evDay[p * nE + e]; if (d > 0 && d <= h) yes.push(p); else no.push(p); }
        const part = (list) => { if (!list.length) return null; const a = list.map((p) => S.navH[0][p * nH + hk]), ia = list.map((p) => S.idxH[p * nH + hk]); return { n: list.length, port: stats(a, o), index: stats(ia, o) }; };
        const rows = yes.length >= 30 ? compare(S, Int32Array.from(yes), hk) : null;
        return { h: h, share: yes.length / P, yes: part(yes), no: part(no), policies: rows, best: pickBest(rows) };
      }),
    }));
    // cây theo sự kiện: gốc tách các đường có sự kiện xảy ra (trước mốc cuối) và không xảy ra, rồi tới 3 giai đoạn của VN-Index như cây thường.
    // Dùng để hỏi "nếu sự kiện này thành hiện thực thì các nhánh và cách xử lý thay đổi ra sao"; khi đã biết sự kiện xảy ra hay chưa, cây sống chọn đúng gốc.
    const eventTrees = (S.evs || []).slice(0, EVENT_TREES).map((ev, e) => {
      const yes = [], no = [];
      for (let p = 0; p < P; p++) { const d = S.evDay[p * nE + e]; if (d > 0 && d <= S.H) yes.push(p); else no.push(p); }
      const roots = [['Y', yes], ['N', no]].map(([id, list]) => {
        const gi = Int32Array.from(list), ia = new Float64Array(list.length); for (let i = 0; i < list.length; i++) ia[i] = S.idxH[list[i] * nH + hkL];
        const rows = list.length >= 30 ? compare(S, gi, hkL) : null;
        return { node: { id: id, depth: 0, h: S.H, branch: null, n: list.length, prob: list.length / P, parentProb: list.length / P, index: list.length ? stats(ia, o) : null, stressShare: null, policies: rows, best: pickBest(rows) }, idx: gi };
      });
      return { id: ev.id, title: ev.title, p: ev.p, sign: ev.sign, nodes: roots.reduce((acc, r) => acc.concat([r.node], r.idx.length >= 30 ? treeOf(S, r.node.id, r.idx) : []), []) };
    });
    const fans = S.pols.map((p, k) => fanOf(S.navDay[k], P, S.H));
    // biểu đồ phân phối (mốc cuối) cho từng chính sách: 40 ô chung thang
    const lastAll = []; S.pols.forEach((p, k) => { for (let i = 0; i < P; i++) lastAll.push(S.navH[k][i * nH + hkL]); });
    const ls = sortNum(lastAll), lo = q(ls, 0.005), hi = q(ls, 0.995), NB = 40, w = (hi - lo) / NB || 1;
    // giá trị ngoài khoảng 0,5%-99,5% chung bị bỏ khỏi biểu đồ (không dồn vào ô mép, tránh cột ảo ở hai đầu)
    const hist = S.pols.map((p, k) => { const c = new Array(NB).fill(0); for (let i = 0; i < P; i++) { const v = S.navH[k][i * nH + hkL]; if (v < lo || v > hi) continue; c[Math.min(NB - 1, Math.floor((v - lo) / w))]++; } return c; });
    return {
      ok: true, paths: P, H: S.H, horizons: S.hz, nav0: S.nav0, model: o.model, seed: o.seed, drift: o.drift, bands: o.bands.slice(0, nH), riskAversion: o.riskAversion, target: o.target,
      costs: { fee: o.fee, tax: o.tax, participation: o.participation, impactK: o.impactK }, stuckSessions: S.stuck / Math.max(1, P * S.pols.length),
      positions: S.pos.map((p) => ({ symbol: p.symbol, kind: p.kind, qty: p.qty, price: p.price, value: p.qty * p.price, band: p.band, adv: p.adv })), skipped: S.skipped,
      policies: S.pols, byHorizon: horizons, tree: nodes, eventTrees: eventTrees, drivers: drivers, sensitivity: sens, events: events, branchProb: branchProb, grid: { levels: GRID.slice(), index: indexGrid, hold: holdGrid },
      fan: { policies: fans, index: fanOf(S.idxDay, P, S.H) }, hist: { lo: lo, hi: hi, bins: NB, counts: hist },
      modelShare: { hmm: Array.from(S.modelOf).filter((m) => m === 1).length / P },
    };
  }

  // ---------- kiểm chứng ngược mô hình thị trường ----------
  // Chỉ mô phỏng chỉ số (không phí, không biên độ). rmAll: lợi suất log ngày của VN-Index theo thứ tự thời gian.
  // opts: minFit (số phiên tối thiểu trước ngày gốc), step (khoảng cách ngày gốc), refitEvery (ước lượng lại tham số), paths, horizons, bands, drift, seed, models
  // opt.uncond: xuất phát từ phương sai dài hạn (GARCH) / phân phối dừng (HMM) thay vì trạng thái hôm nay (dùng khi hiệu chỉnh độ dời).
  // opt.lastOnly: chỉ trả lợi suất log tích luỹ ở phiên cuối của mỗi đường (Float64Array P).
  function simIndexOnly(ctxLite, model, H, P, R, opt) {
    const op = opt || {}, out = op.lastOnly ? new Float64Array(P) : [];
    if (!op.lastOnly) for (let p = 0; p < P; p++) out.push(new Float64Array(H + 1));
    const g = ctxLite.garch, h = ctxLite.hmm, rm = ctxLite.rm, T = rm.length, dr = ctxLite.drift, start = op.uncond ? h.stationary : h.current;
    for (let p = 0; p < P; p++) {
      const m = model === 'blend' ? (p % 2 ? 'hmm' : 'garch') : model;
      let cum = 0, s2 = op.uncond ? g.uncondVar : g.sigma2Next, s = h.K - 1;
      if (m === 'hmm') { const u = R.u(); let c = 0; for (let k = 0; k < h.K; k++) { c += start[k]; if (u < c) { s = k; break; } } }
      for (let t = 1; t <= H; t++) {
        let r;
        if (m === 'hist') r = rm[R.int(T)] + dr.histShift;
        else if (m === 'hmm') { const row = h.P[s], u = R.u(); let c = 0, ns = h.K - 1; for (let k = 0; k < h.K; k++) { c += row[k]; if (u < c) { ns = k; break; } } s = ns; const pool = ctxLite.pools[s]; r = rm[pool[R.int(pool.length)]] + dr.hmmShift; }
        else { const e = Math.sqrt(s2) * g.z[R.int(T)]; r = dr.garchMu + e; s2 = g.omega + (g.alpha + (e < 0 ? g.gamma : 0)) * e * e + g.beta * s2; }
        cum += r; if (!op.lastOnly) out[p][t] = cum;
      }
      if (op.lastOnly) out[p] = cum;
    }
    return out;
  }
  function crpsSorted(s, y) {
    const n = s.length; let a = 0, b = 0;
    for (let i = 0; i < n; i++) { a += Math.abs(s[i] - y); b += (2 * i - n + 1) * s[i]; }
    return a / n - b / (n * n);
  }
  function backtest(rmAll, opts) {
    const o = Object.assign({ minFit: 750, step: 10, refitEvery: 63, paths: 2000, horizons: [5, 21, 63], bands: [0.02, 0.04, 0.06], drift: 0.09, seed: 7, fitDays: 1750, models: ['blend', 'garch', 'hmm', 'hist'], K: null }, opts || {});
    const r = Array.from(rmAll || []).filter(isNum), T = r.length, hz = o.horizons, H = Math.max.apply(null, hz);
    if (T < o.minFit + hz[0] + 5) return { ok: false, reason: 'short', have: T, need: o.minFit + hz[0] + 5 };
    const R = SM.rng(o.seed);
    const acc = {}; o.models.forEach((m) => { acc[m] = hz.map(() => ({ n: 0, in50: 0, in80: 0, in90: 0, pit: new Array(10).fill(0), crps: 0, brier: 0, brierClim: 0, nb: 0 })); });
    let garch = null, hmm = null, lastFit = -Infinity, origins = 0;
    const firstOrigin = o.minFit;
    for (let t0 = firstOrigin; t0 < T - hz[0]; t0 += o.step) {
      const win = r.slice(Math.max(0, t0 - o.fitDays), t0);
      if (t0 - lastFit >= o.refitEvery || !garch || !hmm) {
        garch = SM.fitGarch(win); hmm = o.K ? SM.fitHmm(win, o.K) : SM.fitHmmBest(win, [2, 3]); lastFit = t0;
        if (!garch || !hmm) continue;
      } else { garch = SM.garchRefilter(garch, win); hmm = SM.hmmRefilter(hmm, win); }
      // trạng thái cứng theo tham số hiện có (cho kho lấy mẫu theo chế độ)
      const fw = SM.hmmForward(win, hmm.mu, hmm.sigma, hmm.P, hmm.stationary);
      const st = fw.alpha.map((a) => { let b = 0; for (let k = 1; k < hmm.K; k++) if (a[k] > a[b]) b = k; return b; });
      const hmmL = Object.assign({}, hmm, { state: st, smoothed: fw.alpha });
      const g2 = Object.assign({}, garch); if (garch.z.length !== win.length) { const e = win.map((v) => v - garch.mu), s2 = SM.garchFilter(e, garch.uncondVar, garch.alpha, garch.gamma, garch.beta); g2.z = Float64Array.from(e.map((v, i) => v / Math.sqrt(s2[i]))); }
      const dr = anchorDrift({ drift: o.drift }, g2, hmmL);
      // lấy mẫu độc lập: E[exp(tổng h ngày)] = (E[exp(r)])^h nên độ dời tính đúng bằng công thức
      let ex = 0; for (let i = 0; i < win.length; i++) ex += Math.exp(win[i]);
      dr.histShift = o.drift === null || o.drift === undefined ? 0 : Math.log(1 + o.drift) / TD - Math.log(ex / win.length);
      const lite = { garch: g2, hmm: hmmL, rm: Float64Array.from(win), pools: buildPools(hmmL, win.length), drift: dr };
      if (dr.mode === 'anchored') calibrateDrift(lite, Number(o.drift), { paths: 1500 });
      // tần suất lịch sử của các nhánh (để so điểm Brier)
      const clim = hz.map((h, hk) => { const c = [0, 0, 0]; let n = 0; for (let i = 0; i + h <= win.length; i++) { let s = 0; for (let k = 0; k < h; k++) s += win[i + k]; c[branchOf(s, o.bands[hk])]++; n++; } return c.map((v) => v / Math.max(1, n)); });
      origins++;
      o.models.forEach((m) => {
        const sims = simIndexOnly(lite, m, H, o.paths, R);
        hz.forEach((h, hk) => {
          if (t0 + h > T) return;
          let y = 0; for (let k = 0; k < h; k++) y += r[t0 + k];
          const s = Float64Array.from(sims.map((x) => x[h])).sort(), a = acc[m][hk], n = s.length;
          let below = 0; while (below < n && s[below] <= y) below++;
          const pit = below / n;
          a.n++; a.pit[Math.min(9, Math.floor(pit * 10))]++;
          if (pit > 0.25 && pit < 0.75) a.in50++; if (pit > 0.1 && pit < 0.9) a.in80++; if (pit > 0.05 && pit < 0.95) a.in90++;
          a.crps += crpsSorted(s, y);
          const pr = [0, 0, 0]; for (let i = 0; i < n; i++) pr[branchOf(s[i], o.bands[hk])]++;
          const yc = branchOf(y, o.bands[hk]);
          let br = 0, bc = 0; for (let c = 0; c < 3; c++) { const oc = c === yc ? 1 : 0; br += (pr[c] / n - oc) * (pr[c] / n - oc); bc += (clim[hk][c] - oc) * (clim[hk][c] - oc); }
          a.brier += br; a.brierClim += bc; a.nb++;
        });
      });
    }
    const res = {};
    o.models.forEach((m) => {
      res[m] = acc[m].map((a, hk) => ({
        h: hz[hk], n: a.n, cover50: a.n ? a.in50 / a.n : null, cover80: a.n ? a.in80 / a.n : null, cover90: a.n ? a.in90 / a.n : null,
        pit: a.pit.map((c) => (a.n ? c / a.n : 0)), crps: a.n ? a.crps / a.n : null, brier: a.nb ? a.brier / a.nb : null, brierClim: a.nb ? a.brierClim / a.nb : null,
        bss: a.nb && a.brierClim > 0 ? 1 - a.brier / a.brierClim : null,
        // số ngày gốc độc lập xấp xỉ (các cửa sổ chồng lấn nhau): dùng để nói kết luận mạnh hay yếu
        nEff: a.n ? Math.max(1, Math.round(a.n * Math.min(1, o.step / hz[hk]))) : 0,
      }));
    });
    return { ok: true, origins: origins, obs: T, step: o.step, paths: o.paths, minFit: o.minFit, refitEvery: o.refitEvery, horizons: hz, bands: o.bands, drift: o.drift, models: o.models, results: res };
  }

  // ---------- dựng đầu vào từ dữ liệu thô của API (getSimInputs) ----------
  // raw: { histories: { MÃ: [[ngày, giá]] , VNINDEX }, events, volumes: { MÃ: [[ngày, khối lượng]] }, listings: { MÃ: { exchange } } }.
  // RC: RiskCalc (adjustSeries điều chỉnh giá theo cổ tức / chia tách, alignSeries căn theo lịch VN-Index). Thanh khoản = trung vị giá trị giao dịch 20 phiên gần nhất.
  function fromHistories(raw, RC, opts) {
    const o = opts || {}, r = raw || {}, H = r.histories || {}, syms = Object.keys(H).filter((s) => s !== 'VNINDEX');
    const adj = {}; syms.forEach((s) => { adj[s] = RC.adjustSeries(H[s], r.events || [], s); });
    adj.VNINDEX = H.VNINDEX || [];
    const al = RC.alignSeries(adj, syms, { windowDays: o.windowDays || 4000, benchKey: 'VNINDEX' });
    const stocks = {};
    syms.forEach((s) => {
      const close = {}; (H[s] || []).forEach((p) => { close[String(p[0]).slice(0, 10)] = Number(p[1]); });
      const vals = ((r.volumes || {})[s] || []).map((p) => { const c = close[String(p[0]).slice(0, 10)]; return c > 0 && Number(p[1]) > 0 ? c * Number(p[1]) : null; }).filter((v) => v !== null).slice(-20).sort((a, b) => a - b);
      const L = (r.listings || {})[s] || {};
      stocks[s] = { closes: al.closes[s], exchange: L.exchange || 'HOSE', adv: vals.length >= 5 ? q(vals, 0.5) : null };
    });
    return { dates: al.dates, index: al.bench, stocks: stocks };
  }

  return { DEFAULTS, PRESETS, INDEX, BAND, LOT, GRID, EVENT_PRIOR, EVENT_WINDOW, SECTOR_MULT, SECTOR_SPILL, eventScale, eventFromCard, logRets, fromHistories, calibrateDrift, simIndexOnly, prepare, describe, simulate, validatePolicy, runPolicy, genPath, stats, compare, backtest, crpsSorted, branchOf, anchorDrift };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MarketSim;
