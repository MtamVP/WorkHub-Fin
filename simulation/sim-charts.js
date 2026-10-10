/* --- FILE: /simulation/sim-charts.js ---
   Biểu đồ canvas của Market Simulation (không thư viện ngoài): quạt xác suất (dải phân vị 5-95 / 25-75 + trung vị), phân phối kết quả chồng nhau,
   và lịch sử xác suất chế độ căng thẳng kèm VN-Index. Vẽ lại khi đổi cỡ khung hoặc đổi giao diện sáng / tối. Màu lấy từ token CSS của trang. */
const SimCharts = (function () {
  const registry = [];
  function css(name, fallback) { const v = getComputedStyle(document.body).getPropertyValue(name).trim(); return v || fallback; }
  function pal() {
    return {
      accent: css('--finance-accent', '#4B3A78'), outer: css('--sim-band-outer', 'rgba(75,58,120,.12)'), inner: css('--sim-band-inner', 'rgba(75,58,120,.24)'),
      grid: css('--sim-grid', 'rgba(0,0,0,.07)'), ref: css('--sim-ref', 'rgba(0,0,0,.45)'), text: css('--text-muted', '#8A8377'), primary: css('--text-primary', '#1C1915'),
      down: css('--sim-down', '#C23B3B'), up: css('--sim-up', '#12855A'), flat: css('--sim-flat', '#8A8377'),
    };
  }
  function setup(canvas, height) {
    const dpr = window.devicePixelRatio || 1, w = canvas.parentElement ? canvas.parentElement.clientWidth : 600;
    canvas.style.height = height + 'px'; canvas.width = Math.max(10, Math.round(w * dpr)); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '11px "DM Mono", ui-monospace, monospace'; ctx.textBaseline = 'middle';
    return { ctx: ctx, W: w, H: height };
  }
  function tip(canvas) {
    let el = canvas.parentElement.querySelector('.sim-tip');
    if (!el) { el = document.createElement('div'); el.className = 'sim-tip'; canvas.parentElement.appendChild(el); }
    return el;
  }
  function track(canvas, draw) {
    const i = registry.findIndex((r) => r.canvas === canvas);
    if (i !== -1) registry.splice(i, 1);
    registry.push({ canvas: canvas, draw: draw });
    if (typeof ResizeObserver !== 'undefined' && !canvas.__ro) {
      let last = 0;
      canvas.__ro = new ResizeObserver(function () { const w = canvas.parentElement ? canvas.parentElement.clientWidth : 0; if (w && Math.abs(w - last) > 2) { last = w; const r = registry.find((x) => x.canvas === canvas); if (r) r.draw(); } });
      canvas.__ro.observe(canvas.parentElement);
    }
    draw();
  }
  function redrawAll() { for (let i = registry.length - 1; i >= 0; i--) { if (!document.body.contains(registry[i].canvas)) registry.splice(i, 1); else registry[i].draw(); } }
  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0))), f = step0 / mag;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(v);
    return out;
  }

  // spec: { bands: { q05,q25,q50,q75,q95 } (tương đối, 1 = hôm nay), base (nhân ra giá trị tuyệt đối), fmt(v tuyệt đối), pct (true: trục theo % thay đổi),
  //         overlay: { data, label } (đường trung vị của một chính sách khác để so), markers: [số phiên], labels: { 5: '1 tuần' }, height }
  function fan(canvas, spec) {
    const draw = function () {
      const P = pal(), s = setup(canvas, spec.height || 280), ctx = s.ctx, b = spec.bands, n = b.q50.length;
      const padL = 8, padR = 64, padT = 12, padB = 26, plotW = s.W - padL - padR, plotH = s.H - padT - padB;
      let lo = Infinity, hi = -Infinity;
      [b.q05, b.q95, spec.overlay ? spec.overlay.data : []].forEach((a) => a.forEach((v) => { if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
      lo = Math.min(lo, 1); hi = Math.max(hi, 1); const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
      const x = (i) => padL + plotW * i / Math.max(1, n - 1), y = (v) => padT + plotH * (1 - (v - lo) / (hi - lo));
      const lab = (v) => (spec.pct ? ((v - 1) * 100 >= 0 ? '+' : '−') + Math.abs((v - 1) * 100).toFixed(Math.abs(hi - lo) < 0.12 ? 1 : 0) + '%' : spec.fmt(v * spec.base));
      // lưới
      ctx.strokeStyle = P.grid; ctx.lineWidth = 1; ctx.fillStyle = P.text; ctx.textAlign = 'left';
      niceTicks(lo, hi, 4).forEach((v) => { ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(padL + plotW, y(v)); ctx.stroke(); ctx.fillText(lab(v), padL + plotW + 8, y(v)); });
      // mốc thời gian
      ctx.textAlign = 'center';
      // nhãn mốc: bỏ nhãn nào quá sát nhãn "Hôm nay" hoặc nhãn trước (khung hẹp, mốc 1 tuần nằm rất gần đầu trục)
      let lastX = padL + 52;
      (spec.markers || []).forEach((m) => {
        if (m >= n) return;
        ctx.strokeStyle = P.grid; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x(m), padT); ctx.lineTo(x(m), padT + plotH); ctx.stroke(); ctx.setLineDash([]);
        const lx = Math.min(x(m), padL + plotW - 24); if (lx - lastX < 34) return;
        ctx.fillStyle = P.text; ctx.fillText((spec.labels && spec.labels[m]) || m + ' phiên', lx, s.H - 10); lastX = lx + 20;
      });
      ctx.textAlign = 'left'; ctx.fillStyle = P.text; ctx.fillText(spec.startLabel || 'Hôm nay', padL, s.H - 10);
      const band = (a, c, col) => { ctx.fillStyle = col; ctx.beginPath(); a.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)))); for (let i = n - 1; i >= 0; i--) ctx.lineTo(x(i), y(c[i])); ctx.closePath(); ctx.fill(); };
      band(b.q95, b.q05, P.outer); band(b.q75, b.q25, P.inner);
      // mốc 1 (giá trị hiện tại)
      ctx.strokeStyle = P.ref; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(padL, y(1)); ctx.lineTo(padL + plotW, y(1)); ctx.stroke(); ctx.setLineDash([]);
      if (spec.overlay) { ctx.strokeStyle = P.text; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath(); spec.overlay.data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)))); ctx.stroke(); ctx.setLineDash([]); }
      ctx.strokeStyle = P.accent; ctx.lineWidth = 2; ctx.beginPath(); b.q50.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)))); ctx.stroke();
      const last = n - 1; ctx.fillStyle = P.accent; ctx.beginPath(); ctx.arc(x(last), y(b.q50[last]), 3.5, 0, Math.PI * 2); ctx.fill();
      const el = tip(canvas);
      canvas.onmousemove = function (e) {
        const r = canvas.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - padL) / plotW * (n - 1))));
        el.style.display = 'block';
        const row = (k, t) => '<div>' + t + ': <b>' + lab(b[k][i]) + '</b></div>';
        el.innerHTML = '<div><b>' + (i === 0 ? spec.startLabel || 'Hôm nay' : 'Sau ' + i + ' phiên') + '</b></div>' + row('q95', 'Tốt (95%)') + row('q75', '75%') + row('q50', 'Trung vị') + row('q25', '25%') + row('q05', 'Xấu (5%)') + (spec.overlay ? '<div class="sim-muted">' + spec.overlay.label + ': ' + lab(spec.overlay.data[i]) + '</div>' : '');
        const left = Math.min(x(i) + 14, s.W - el.offsetWidth - 4); el.style.left = left + 'px'; el.style.top = '6px';
      };
      canvas.onmouseleave = function () { el.style.display = 'none'; };
    };
    track(canvas, draw);
  }

  // spec: { lo, hi, series: [{ counts, label, strong }], height } -- trục là lợi nhuận (tỷ lệ)
  function hist(canvas, spec) {
    const draw = function () {
      const P = pal(), s = setup(canvas, spec.height || 190), ctx = s.ctx;
      const padL = 8, padR = 8, padT = 10, padB = 24, plotW = s.W - padL - padR, plotH = s.H - padT - padB, NB = spec.series[0].counts.length;
      let mx = 1; spec.series.forEach((se) => se.counts.forEach((c) => { mx = Math.max(mx, c); }));
      const xv = (v) => padL + plotW * (v - spec.lo) / (spec.hi - spec.lo), bw = plotW / NB;
      ctx.strokeStyle = P.grid; ctx.fillStyle = P.text; ctx.textAlign = 'center';
      niceTicks(spec.lo, spec.hi, 6).forEach((v) => { ctx.beginPath(); ctx.moveTo(xv(v), padT); ctx.lineTo(xv(v), padT + plotH); ctx.stroke(); ctx.fillText((v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(0) + '%', xv(v), s.H - 9); });
      spec.series.forEach((se) => {
        if (se.strong) { ctx.fillStyle = P.inner; se.counts.forEach((c, i) => { const h = c / mx * plotH; ctx.fillRect(padL + i * bw + 0.5, padT + plotH - h, bw - 1, h); }); }
        ctx.strokeStyle = se.strong ? P.accent : P.text; ctx.lineWidth = se.strong ? 1.8 : 1.3; if (!se.strong) ctx.setLineDash([4, 3]);
        ctx.beginPath(); se.counts.forEach((c, i) => { const yy = padT + plotH - c / mx * plotH; if (i) ctx.lineTo(padL + i * bw, yy); else ctx.moveTo(padL, yy); ctx.lineTo(padL + (i + 1) * bw, yy); }); ctx.stroke(); ctx.setLineDash([]);
      });
      if (spec.lo < 0 && spec.hi > 0) { ctx.strokeStyle = P.ref; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(xv(0), padT); ctx.lineTo(xv(0), padT + plotH); ctx.stroke(); ctx.setLineDash([]); }
    };
    track(canvas, draw);
  }

  // spec: { dates, p (0..1, diện tích), line (VN-Index), height }
  function regime(canvas, spec) {
    const draw = function () {
      const P = pal(), s = setup(canvas, spec.height || 170), ctx = s.ctx, n = spec.p.length;
      const padL = 8, padR = 56, padT = 10, padB = 24, plotW = s.W - padL - padR, plotH = s.H - padT - padB;
      const x = (i) => padL + plotW * i / Math.max(1, n - 1);
      ctx.fillStyle = P.down; ctx.globalAlpha = 0.22; ctx.beginPath(); ctx.moveTo(x(0), padT + plotH);
      spec.p.forEach((v, i) => ctx.lineTo(x(i), padT + plotH * (1 - v))); ctx.lineTo(x(n - 1), padT + plotH); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      if (spec.line && spec.line.length === n) {
        let lo = Infinity, hi = -Infinity; spec.line.forEach((v) => { if (v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
        const y = (v) => padT + plotH * (1 - (v - lo) / (hi - lo || 1));
        ctx.strokeStyle = P.accent; ctx.lineWidth = 1.6; ctx.beginPath(); let st = false; spec.line.forEach((v, i) => { if (!(v > 0)) return; if (st) ctx.lineTo(x(i), y(v)); else { ctx.moveTo(x(i), y(v)); st = true; } }); ctx.stroke();
        ctx.fillStyle = P.text; ctx.textAlign = 'left';
        [lo, hi].forEach((v) => ctx.fillText(Math.round(v).toLocaleString('vi-VN'), padL + plotW + 6, y(v)));
      }
      ctx.fillStyle = P.text; ctx.textAlign = 'left';
      // nhãn năm ở đầu mỗi năm; nhãn của năm đầu (dở dang) bị bỏ nếu quá sát nhãn năm kế tiếp
      const yr = (d) => String(d).slice(0, 4), starts = [];
      spec.dates.forEach((d, i) => { if (!starts.length || yr(d) !== starts[starts.length - 1].y) starts.push({ y: yr(d), i: i }); });
      starts.forEach((st, k) => {
        if (st.i > 0) { ctx.strokeStyle = P.grid; ctx.beginPath(); ctx.moveTo(x(st.i), padT); ctx.lineTo(x(st.i), padT + plotH); ctx.stroke(); }
        if (k === 0 && starts[1] && x(starts[1].i) - x(st.i) < 40) return;
        ctx.fillText(st.y, x(st.i) + 3, s.H - 9);
      });
      const el = tip(canvas);
      canvas.onmousemove = function (e) {
        const r = canvas.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - padL) / plotW * (n - 1))));
        const d = String(spec.dates[i] || '').split('-');
        el.style.display = 'block';
        el.innerHTML = '<b>' + (d.length === 3 ? d[2] + '/' + d[1] + '/' + d[0] : '') + '</b><div>Xác suất chế độ căng thẳng: <b>' + Math.round(spec.p[i] * 100) + '%</b></div>' + (spec.line ? '<div>VN-Index: ' + Math.round(spec.line[i]).toLocaleString('vi-VN') + '</div>' : '');
        el.style.left = Math.min(x(i) + 12, s.W - el.offsetWidth - 4) + 'px'; el.style.top = '4px';
      };
      canvas.onmouseleave = function () { el.style.display = 'none'; };
    };
    track(canvas, draw);
  }

  return { fan: fan, hist: hist, regime: regime, redrawAll: redrawAll };
})();
