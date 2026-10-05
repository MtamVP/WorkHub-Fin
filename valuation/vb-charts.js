/* --- FILE: /valuation/vb-charts.js ---
   Biểu đồ của Valuation Bench vẽ trực tiếp bằng canvas (không phụ thuộc thư viện ngoài): biểu đồ nến kèm đường trung bình, Bollinger, mây Ichimoku, Supertrend, khối lượng, đường hỗ trợ/kháng cự;
   biểu đồ đường/cột cho RSI, MACD, Stochastic, ADX...; histogram Monte Carlo. Mọi biểu đồ tự vẽ lại khi đổi kích thước (ResizeObserver) và đọc màu từ biến CSS nên theo đúng giao diện sáng/tối.
   Dữ liệu vào là mảng thuần (null = không có giá trị). Nạp bằng thẻ <script> thường (global VBCharts). Phần tính toán nằm ở /lib/vb-technical.js. */
const VBCharts = (function () {
  const registry = [];     // { canvas, draw } để vẽ lại khi đổi theme / kích thước
  function css(name, fallback) { const v = getComputedStyle(document.body).getPropertyValue(name).trim(); return v || fallback; }
  function palette() {
    return { up: css('--vb-up', '#12855A'), down: css('--vb-down', '#C23B3B'), ma20: css('--vb-ma20', '#D98E04'), ma50: css('--vb-ma50', '#2F6AE0'), ma200: css('--vb-ma200', '#7B3FA0'), grid: css('--vb-grid', 'rgba(0,0,0,.07)'),
      text: css('--text-secondary', '#5B554B'), muted: css('--text-muted', '#8A8377'), primary: css('--text-primary', '#1C1915'), accent: css('--finance-accent', '#27476E'), band: css('--vb-band', 'rgba(39,71,110,.10)'),
      cloudUp: css('--vb-cloud-up', 'rgba(18,133,90,.12)'), cloudDown: css('--vb-cloud-down', 'rgba(194,59,59,.12)'), card: css('--card-bg', '#fff'), border: css('--border-strong', 'rgba(0,0,0,.2)'), warn: css('--warning-color', '#9A6B0D') };
  }
  function setup(canvas, height) {
    const dpr = window.devicePixelRatio || 1, w = Math.max(240, canvas.parentElement ? canvas.parentElement.clientWidth : canvas.clientWidth), h = height;
    canvas.style.height = h + 'px'; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.font = '11px ' + (css('--font-mono', 'monospace')); ctx.textBaseline = 'middle';
    return { ctx: ctx, w: w, h: h };
  }
  const nice = (v, d) => (v === null || v === undefined || !isFinite(v) ? '—' : Number(v).toLocaleString('vi-VN', { maximumFractionDigits: d === undefined ? 0 : d, minimumFractionDigits: 0 }));
  const dd = (iso) => { const p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0].slice(2) : ''; };

  function tip(canvas) {
    let el = canvas.parentElement.querySelector('.vb-chart-tip');
    if (!el) { el = document.createElement('div'); el.className = 'vb-chart-tip'; canvas.parentElement.appendChild(el); }
    return el;
  }
  function track(canvas, draw) {
    const i = registry.findIndex(function (r) { return r.canvas === canvas; });
    if (i >= 0) registry[i].draw = draw; else registry.push({ canvas: canvas, draw: draw });
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement && !canvas.__ro) {
      let last = canvas.parentElement.clientWidth;
      canvas.__ro = new ResizeObserver(function () { const w = canvas.parentElement ? canvas.parentElement.clientWidth : 0; if (w && Math.abs(w - last) > 2) { last = w; const r = registry.find(function (x) { return x.canvas === canvas; }); if (r) r.draw(); } });
      canvas.__ro.observe(canvas.parentElement);
    }
  }
  function redrawAll() { registry.forEach(function (r) { if (document.body.contains(r.canvas)) r.draw(); }); for (let i = registry.length - 1; i >= 0; i--) if (!document.body.contains(registry[i].canvas)) registry.splice(i, 1); }

  // ---------- nến ----------
  // data: { t, o, h, l, c, v }; opts: { height, window (số nến hiển thị), series (analysis.series), show: { sma20, sma50, sma200, bb, ich, st, vwap, volume }, levels: { supports, resistances }, priceDigits }
  function candles(canvas, data, opts) {
    const o = opts || {};
    const draw = function () {
      const P = palette(), n = data.c.length, win = Math.min(o.window || 180, n), from = n - win, H = o.height || 400;
      const S = setup(canvas, H), ctx = S.ctx, W = S.w, padR = 62, padT = 8, padB = 22, volH = (o.show && o.show.volume === false) ? 0 : Math.round(H * 0.17), plotH = H - padT - padB - volH, plotW = W - padR;
      const sr = o.series || {}, show = o.show || {};
      const get = (k, i) => (sr[k] ? sr[k][i] : null);
      let lo = Infinity, hi = -Infinity;
      for (let i = from; i < n; i++) { lo = Math.min(lo, data.l[i]); hi = Math.max(hi, data.h[i]); [show.sma20 && 'sma20', show.sma50 && 'sma50', show.sma200 && 'sma200', show.bb && 'bbUpper', show.bb && 'bbLower'].forEach(function (k) { if (k) { const v = get(k, i); if (v !== null && v !== undefined) { lo = Math.min(lo, v); hi = Math.max(hi, v); } } }); }
      if (!(hi > lo)) { hi = lo + 1; }
      const padV = (hi - lo) * 0.05; lo -= padV; hi += padV;
      const x = (i) => ((i - from) + 0.5) / win * plotW, y = (v) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
      // lưới ngang và nhãn giá
      ctx.strokeStyle = P.grid; ctx.fillStyle = P.muted; ctx.lineWidth = 1; ctx.textAlign = 'left';
      const ticks = 5;
      for (let k = 0; k <= ticks; k++) { const v = lo + (hi - lo) * k / ticks, yy = y(v); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); ctx.fillText(nice(v, o.priceDigits || 0), plotW + 6, yy); }
      // nhãn thời gian
      ctx.textAlign = 'center'; const step = Math.max(1, Math.round(win / 6));
      for (let i = from; i < n; i += step) ctx.fillText(dd(data.t[i]), Math.min(plotW - 24, Math.max(24, x(i))), H - 8);
      // mây Ichimoku
      if (show.ich && sr.cloudA) {
        for (let i = from + 1; i < n; i++) {
          const a0 = get('cloudA', i - 1), b0 = get('cloudB', i - 1), a1 = get('cloudA', i), b1 = get('cloudB', i);
          if (a0 === null || b0 === null || a1 === null || b1 === null) continue;
          ctx.fillStyle = a1 >= b1 ? P.cloudUp : P.cloudDown; ctx.beginPath(); ctx.moveTo(x(i - 1), y(a0)); ctx.lineTo(x(i), y(a1)); ctx.lineTo(x(i), y(b1)); ctx.lineTo(x(i - 1), y(b0)); ctx.closePath(); ctx.fill();
        }
      }
      // dải Bollinger
      if (show.bb && sr.bbUpper) {
        ctx.fillStyle = P.band; ctx.beginPath(); let started = false;
        for (let i = from; i < n; i++) { const u = get('bbUpper', i); if (u === null) continue; if (!started) { ctx.moveTo(x(i), y(u)); started = true; } else ctx.lineTo(x(i), y(u)); }
        for (let i = n - 1; i >= from; i--) { const l = get('bbLower', i); if (l === null) continue; ctx.lineTo(x(i), y(l)); }
        ctx.closePath(); ctx.fill();
      }
      // khối lượng
      if (volH) {
        let vm = 0; for (let i = from; i < n; i++) vm = Math.max(vm, data.v[i] || 0);
        const bw = Math.max(1, plotW / win * 0.7);
        for (let i = from; i < n; i++) { const up = data.c[i] >= data.o[i]; ctx.fillStyle = up ? P.up : P.down; ctx.globalAlpha = 0.35; const vh = vm > 0 ? (data.v[i] || 0) / vm * (volH - 4) : 0; ctx.fillRect(x(i) - bw / 2, padT + plotH + 4 + (volH - 4 - vh), bw, vh); }
        ctx.globalAlpha = 1;
      }
      // hỗ trợ / kháng cự
      const lev = o.levels || {};
      [['supports', P.up], ['resistances', P.down]].forEach(function (pair) {
        (lev[pair[0]] || []).slice(0, 3).forEach(function (L) { if (L.price < lo || L.price > hi) return; const yy = y(L.price); ctx.strokeStyle = pair[1]; ctx.globalAlpha = 0.65; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = pair[1]; ctx.textAlign = 'left'; ctx.fillText(nice(L.price, o.priceDigits || 0), plotW + 6, yy - 7); });
      });
      // nến
      const bw = Math.max(1.2, plotW / win * 0.68);
      for (let i = from; i < n; i++) {
        const up = data.c[i] >= data.o[i], col = up ? P.up : P.down;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x(i), y(data.h[i])); ctx.lineTo(x(i), y(data.l[i])); ctx.stroke();
        const y1 = y(data.o[i]), y2 = y(data.c[i]); ctx.fillRect(x(i) - bw / 2, Math.min(y1, y2), bw, Math.max(1, Math.abs(y2 - y1)));
      }
      // đường chồng
      const line = (key, color, width) => { if (!sr[key]) return; ctx.strokeStyle = color; ctx.lineWidth = width || 1.4; ctx.beginPath(); let st = false; for (let i = from; i < n; i++) { const v = get(key, i); if (v === null || v === undefined) { st = false; continue; } if (!st) { ctx.moveTo(x(i), y(v)); st = true; } else ctx.lineTo(x(i), y(v)); } ctx.stroke(); };
      if (show.sma20) line('sma20', P.ma20); if (show.sma50) line('sma50', P.ma50); if (show.sma200) line('sma200', P.ma200, 1.8);
      if (show.vwap) line('vwap20', P.accent, 1.2);
      if (show.ich) { line('tenkan', P.ma50, 1); line('kijun', P.down, 1); }
      if (show.st && sr.supertrend) {
        ctx.lineWidth = 1.6;
        for (let i = from + 1; i < n; i++) { const a = get('supertrend', i - 1), b = get('supertrend', i), d = get('supertrendDir', i); if (a === null || b === null || get('supertrendDir', i - 1) !== d) continue; ctx.strokeStyle = d === 1 ? P.up : P.down; ctx.beginPath(); ctx.moveTo(x(i - 1), y(a)); ctx.lineTo(x(i), y(b)); ctx.stroke(); }
      }
      // giá cuối
      const lastP = data.c[n - 1], ly = y(lastP); ctx.strokeStyle = P.primary; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = P.primary; ctx.fillRect(plotW + 1, ly - 9, padR - 2, 18); ctx.fillStyle = P.card; ctx.textAlign = 'left'; ctx.fillText(nice(lastP, o.priceDigits || 0), plotW + 6, ly);
      // tooltip và đường dọc
      const el = tip(canvas);
      canvas.onmousemove = function (e) {
        const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left;
        if (mx < 0 || mx > plotW) { el.style.display = 'none'; return; }
        const i = Math.min(n - 1, Math.max(from, Math.round(mx / plotW * win - 0.5) + from)), ch = i > 0 ? data.c[i] / data.c[i - 1] - 1 : 0;
        const vals = []; ['sma20', 'sma50', 'sma200'].forEach(function (k) { if (show[k] && get(k, i) !== null) vals.push(k.toUpperCase() + ' ' + nice(get(k, i), o.priceDigits || 0)); });
        el.innerHTML = dd(data.t[i]) + '<br>M ' + nice(data.o[i], 0) + ' C ' + nice(data.h[i], 0) + ' T ' + nice(data.l[i], 0) + ' Đ ' + nice(data.c[i], 0) + '<br>' + (ch >= 0 ? '+' : '') + (ch * 100).toFixed(2).replace('.', ',') + '% · KL ' + nice(data.v[i], 0) + (vals.length ? '<br>' + vals.join(' · ') : '');
        el.style.display = 'block'; el.style.left = Math.min(mx + 14, W - 210) + 'px'; el.style.top = '8px';
      };
      canvas.onmouseleave = function () { el.style.display = 'none'; };
    };
    draw(); track(canvas, draw);
  }

  // ---------- đường / cột (chỉ báo con) ----------
  // spec: { t, window, height, series: [{ data, color, width, type: 'line'|'bars'|'area', dash }], refs: [{ y, color, label }], min, max, digits, zeroLine }
  function lines(canvas, spec) {
    const draw = function () {
      const P = palette(), n = spec.t.length, win = Math.min(spec.window || 180, n), from = n - win, H = spec.height || 120;
      const S = setup(canvas, H), ctx = S.ctx, W = S.w, padR = 62, padT = 6, padB = 6, plotW = W - padR, plotH = H - padT - padB;
      let lo = spec.min !== undefined ? spec.min : Infinity, hi = spec.max !== undefined ? spec.max : -Infinity;
      spec.series.forEach(function (s) { for (let i = from; i < n; i++) { const v = s.data[i]; if (v === null || v === undefined || !isFinite(v)) continue; if (spec.min === undefined) lo = Math.min(lo, v); if (spec.max === undefined) hi = Math.max(hi, v); } });
      (spec.refs || []).forEach(function (r) { if (spec.min === undefined) lo = Math.min(lo, r.y); if (spec.max === undefined) hi = Math.max(hi, r.y); });
      if (!isFinite(lo) || !isFinite(hi)) { ctx.fillStyle = P.muted; ctx.textAlign = 'center'; ctx.fillText('Chưa đủ dữ liệu', W / 2, H / 2); return; }
      if (spec.zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      if (hi === lo) { hi += 1; lo -= 1; } const padV = (hi - lo) * 0.08; if (spec.min === undefined) lo -= padV; if (spec.max === undefined) hi += padV;
      const x = (i) => ((i - from) + 0.5) / win * plotW, y = (v) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
      ctx.strokeStyle = P.grid; ctx.lineWidth = 1; ctx.fillStyle = P.muted; ctx.textAlign = 'left';
      [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1].forEach(function (v) { ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(plotW, y(v)); ctx.stroke(); ctx.fillText(nice(v, spec.digits || 0), plotW + 6, y(v)); });
      (spec.refs || []).forEach(function (r) { ctx.strokeStyle = r.color || P.muted; ctx.globalAlpha = 0.7; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, y(r.y)); ctx.lineTo(plotW, y(r.y)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; });
      if (spec.zeroLine) { ctx.strokeStyle = P.border; ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(plotW, y(0)); ctx.stroke(); }
      spec.series.forEach(function (s) {
        const col = s.color || P.accent;
        if (s.type === 'bars') { const bw = Math.max(1, plotW / win * 0.7), y0 = y(0); for (let i = from; i < n; i++) { const v = s.data[i]; if (v === null || v === undefined) continue; ctx.fillStyle = v >= 0 ? P.up : P.down; ctx.globalAlpha = 0.7; ctx.fillRect(x(i) - bw / 2, Math.min(y0, y(v)), bw, Math.max(1, Math.abs(y(v) - y0))); } ctx.globalAlpha = 1; return; }
        ctx.strokeStyle = col; ctx.lineWidth = s.width || 1.5; if (s.dash) ctx.setLineDash(s.dash); ctx.beginPath(); let st = false, firstX = 0, lastX = 0;
        for (let i = from; i < n; i++) { const v = s.data[i]; if (v === null || v === undefined || !isFinite(v)) { st = false; continue; } if (!st) { ctx.moveTo(x(i), y(v)); st = true; if (!firstX) firstX = x(i); } else ctx.lineTo(x(i), y(v)); lastX = x(i); }
        ctx.stroke(); ctx.setLineDash([]);
        if (s.type === 'area') { ctx.lineTo(lastX, y(lo)); ctx.lineTo(firstX, y(lo)); ctx.closePath(); ctx.globalAlpha = 0.12; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1; }
      });
      const el = tip(canvas);
      canvas.onmousemove = function (e) {
        const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left; if (mx < 0 || mx > plotW) { el.style.display = 'none'; return; }
        const i = Math.min(n - 1, Math.max(from, Math.round(mx / plotW * win - 0.5) + from));
        el.innerHTML = dd(spec.t[i]) + '<br>' + spec.series.map(function (s) { return (s.label ? s.label + ' ' : '') + nice(s.data[i], spec.digits === undefined ? 1 : spec.digits); }).join(' · ');
        el.style.display = 'block'; el.style.left = Math.min(mx + 14, W - 190) + 'px'; el.style.top = '2px';
      };
      canvas.onmouseleave = function () { el.style.display = 'none'; };
    };
    draw(); track(canvas, draw);
  }

  // ---------- histogram (Monte Carlo): counts + vạch đánh dấu ----------
  // spec: { lo, step, counts, marks: [{ value, color, label }], height }
  function histogram(canvas, spec) {
    const draw = function () {
      const P = palette(), H = spec.height || 180, S = setup(canvas, H), ctx = S.ctx, W = S.w, padB = 24, padT = 16, n = spec.counts.length, mx = Math.max.apply(null, spec.counts) || 1, bw = W / n;
      ctx.fillStyle = P.accent; ctx.globalAlpha = 0.55;
      spec.counts.forEach(function (c, i) { const h = c / mx * (H - padB - padT); ctx.fillRect(i * bw + 1, H - padB - h, bw - 2, h); });
      ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.fillStyle = P.muted;
      for (let k = 0; k <= 4; k++) { const v = spec.lo + spec.step * n * k / 4; ctx.fillText(nice(v / 1000, 0) + 'k', Math.min(W - 18, Math.max(18, W * k / 4)), H - 8); }
      (spec.marks || []).forEach(function (m, idx) {
        const xx = (m.value - spec.lo) / (spec.step * n) * W; if (xx < 0 || xx > W) return;
        ctx.strokeStyle = m.color || P.primary; ctx.lineWidth = 2; ctx.setLineDash(m.dash || []); ctx.beginPath(); ctx.moveTo(xx, padT - 4); ctx.lineTo(xx, H - padB); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = m.color || P.primary; ctx.textAlign = xx > W - 60 ? 'right' : 'left'; ctx.fillText(m.label, xx + (xx > W - 60 ? -4 : 4), 8 + (idx % 2) * 11);
      });
    };
    draw(); track(canvas, draw);
  }

  return { palette, candles, lines, histogram, redrawAll, nice };
})();
