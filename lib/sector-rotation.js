// Logic thuần: LUÂN CHUYỂN NGÀNH và ĐỘNG LƯỢNG từ lịch sử chỉ số ngành HOSE (VNFIN, VNREAL, VNIT...) so với VN-Index.
// Cách tính (kiểu đồ "Relative Rotation Graph", TỰ TÍNH từ giá đóng cửa, KHÔNG phải số JdK/RRG của nhà cung cấp nên không so trực tiếp được với phần mềm khác):
//   RS_t       = chỉ số ngành / VN-Index (cùng ngày)
//   RS-Ratio_t = 100 x SMA(RS, ngắn) / SMA(RS, dài)      -> > 100: ngành đang mạnh hơn thị trường so với xu hướng dài của chính nó
//   RS-Mom_t   = 100 x RS-Ratio_t / RS-Ratio_(t-m)         -> > 100: sức mạnh tương đối đang tăng
//   Bốn góc: Dẫn đầu (ratio >= 100, mom >= 100), Suy yếu (>= 100, < 100), Tụt hậu (< 100, < 100), Cải thiện (< 100, >= 100). Ngành thường đi vòng theo chiều Cải thiện -> Dẫn đầu -> Suy yếu -> Tụt hậu.
// Đây là MÔ TẢ quá khứ gần: góc "Dẫn đầu" không bảo đảm ngành sẽ còn dẫn đầu, và vòng luân chuyển không đều đặn. Chuỗi ngắn hơn cần thiết thì trả null (không đoán).
// KHÔNG đụng DOM/mạng. Nạp bằng thẻ <script> thường (global SectorRotation) và module.exports cho Vitest.
const SectorRotation = (function () {
  const DEFAULTS = { short: 10, long: 60, mom: 10, step: 5, trail: 6 };
  const QUADRANTS = {
    leading: { key: 'leading', label: 'Dẫn đầu', hint: 'Mạnh hơn thị trường và sức mạnh đang tăng' },
    weakening: { key: 'weakening', label: 'Suy yếu', hint: 'Vẫn mạnh hơn thị trường nhưng đà đang chậm lại' },
    lagging: { key: 'lagging', label: 'Tụt hậu', hint: 'Yếu hơn thị trường và sức mạnh đang giảm' },
    improving: { key: 'improving', label: 'Cải thiện', hint: 'Còn yếu hơn thị trường nhưng đà đang quay lên' },
  };
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };

  // Hai chuỗi [[ngày, giá]] -> các ngày chung, tăng dần: { dates, a, b }. Giá không dương bị bỏ.
  function align(sa, sb) {
    const mb = {}; (sb || []).forEach((r) => { const v = num(r[1]); if (v > 0) mb[String(r[0]).slice(0, 10)] = v; });
    const dates = [], a = [], b = [], seen = {};
    (sa || []).slice().sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)).forEach((r) => {
      const d = String(r[0]).slice(0, 10), v = num(r[1]);
      if (v > 0 && mb[d] !== undefined && !seen[d]) { seen[d] = true; dates.push(d); a.push(v); b.push(mb[d]); }
    });
    return { dates: dates, a: a, b: b };
  }
  // Trung bình trượt đơn giản; phần tử đầu thiếu cửa sổ là null
  function sma(x, n) {
    const out = new Array(x.length).fill(null); let s = 0;
    for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= n) s -= x[i - n]; if (i >= n - 1) out[i] = s / n; }
    return out;
  }
  const quadrantOf = (ratio, mom) => (ratio >= 100 ? (mom >= 100 ? QUADRANTS.leading : QUADRANTS.weakening) : (mom >= 100 ? QUADRANTS.improving : QUADRANTS.lagging));

  // Chuỗi RS-Ratio / RS-Mom của một ngành so với chuẩn. Trả null khi chuỗi chung quá ngắn.
  function rotationSeries(sector, bench, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const al = align(sector, bench);
    if (al.dates.length < o.long + o.mom + 2) return null;
    const rs = al.a.map((v, i) => v / al.b[i]);
    const fast = sma(rs, o.short), slow = sma(rs, o.long);
    const ratio = rs.map((_, i) => (fast[i] !== null && slow[i] !== null ? 100 * fast[i] / slow[i] : null));
    const mom = ratio.map((r, i) => (r !== null && i >= o.mom && ratio[i - o.mom] !== null ? 100 * r / ratio[i - o.mom] : null));
    return { dates: al.dates, rs: rs, ratio: ratio, mom: mom, sector: al.a, bench: al.b };
  }

  // Lợi suất (%) của chuỗi giá trong n phiên gần nhất; null nếu chưa đủ phiên
  const ret = (px, n, end) => { const e = end === undefined ? px.length - 1 : end; return e - n >= 0 && px[e - n] > 0 ? (px[e] / px[e - n] - 1) * 100 : null; };
  const PERIODS = [{ key: 'm1', label: '1 tháng', n: 22 }, { key: 'm3', label: '3 tháng', n: 64 }, { key: 'm6', label: '6 tháng', n: 127 }];

  // series: { MÃ: [[ngày, điểm]] } gồm cả chuẩn; names: { MÃ: tên hiển thị }. Trả { benchmark, asOf, sectors: [...], skipped: [mã thiếu/ngắn] } xếp theo RS-Ratio giảm dần.
  // Mỗi ngành: { code, name, ratio, mom, quadrant, trail: [{date, ratio, mom}], ret: {m1,m3,m6}, rel: {m1,m3,m6} (chênh lệch so với chuẩn, điểm %), rank, rank1m, rankChange }
  function analyze(series, benchCode, names, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const bench = (series || {})[benchCode];
    const skipped = [];
    const rows = [];
    let asOf = null;
    Object.keys(series || {}).forEach((code) => {
      if (code === benchCode) return;
      const r = rotationSeries(series[code], bench, o);
      if (!r) { skipped.push(code); return; }
      const last = r.dates.length - 1;
      if (r.ratio[last] === null || r.mom[last] === null) { skipped.push(code); return; }
      if (!asOf || r.dates[last] > asOf) asOf = r.dates[last];
      const trail = [];
      for (let k = o.trail - 1; k >= 0; k--) {
        const i = last - k * o.step;
        if (i >= 0 && r.ratio[i] !== null && r.mom[i] !== null) trail.push({ date: r.dates[i], ratio: r.ratio[i], mom: r.mom[i] });
      }
      const out = { code: code, name: (names && names[code]) || code, ratio: r.ratio[last], mom: r.mom[last], quadrant: quadrantOf(r.ratio[last], r.mom[last]), trail: trail, ret: {}, rel: {}, date: r.dates[last], _r: r };
      PERIODS.forEach((p) => {
        const a = ret(r.sector, p.n), b = ret(r.bench, p.n);
        out.ret[p.key] = a; out.rel[p.key] = a !== null && b !== null ? a - b : null;
      });
      rows.push(out);
    });
    rows.sort((a, b) => b.ratio - a.ratio);
    // thứ hạng hiện tại và thứ hạng 1 tháng (22 phiên) trước, theo RS-Ratio ở từng thời điểm
    rows.forEach((x, i) => { x.rank = i + 1; });
    const past = rows.map((x) => { const i = x._r.dates.length - 1 - 22; return { x: x, v: i >= 0 ? x._r.ratio[i] : null }; }).filter((p) => p.v !== null).sort((a, b) => b.v - a.v);
    past.forEach((p, i) => { p.x.rank1m = i + 1; });
    rows.forEach((x) => { x.rankChange = x.rank1m ? x.rank1m - x.rank : null; delete x._r; });
    return { benchmark: benchCode, asOf: asOf, sectors: rows, skipped: skipped, params: o };
  }

  // Tóm tắt bằng lời: ngành dẫn đầu, vừa chuyển sang Dẫn đầu/Cải thiện, đang suy yếu. prevQuadrants: { MÃ: key } một tháng trước (tuỳ chọn, để nêu chuyển góc).
  function narrate(an) {
    const by = (k) => an.sectors.filter((s) => s.quadrant.key === k);
    const names = (a) => a.map((s) => s.name).join(', ');
    const lines = [];
    if (by('leading').length) lines.push('Dẫn đầu: ' + names(by('leading')) + '.');
    if (by('improving').length) lines.push('Đang cải thiện (còn dưới trung bình nhưng đà quay lên): ' + names(by('improving')) + '.');
    if (by('weakening').length) lines.push('Đang suy yếu (vẫn trên trung bình nhưng đà chậm lại): ' + names(by('weakening')) + '.');
    if (by('lagging').length) lines.push('Tụt hậu: ' + names(by('lagging')) + '.');
    const up = an.sectors.filter((s) => s.rankChange !== null && s.rankChange >= 3);
    if (up.length) lines.push('Tăng hạng mạnh trong 1 tháng: ' + up.map((s) => s.name + ' (+' + s.rankChange + ')').join(', ') + '.');
    return lines;
  }

  // Cổ phiếu có sức mạnh tương đối cao trong một nhóm hàng của ảnh chụp thị trường (jdkRs, jdkMom có sẵn trong ảnh chụp). rows: [{ symbol, m }]. Chỉ mã đủ thanh khoản.
  function leaders(rows, n, minAdv) {
    return (rows || []).filter((r) => r && r.m && num(r.m.jdkRs) !== null && num(r.m.jdkMom) !== null && (num(r.m.advValue20) || 0) >= (minAdv === undefined ? 5e9 : minAdv))
      .map((r) => ({ symbol: r.symbol, rs: r.m.jdkRs, mom: r.m.jdkMom, score: (r.m.jdkRs + r.m.jdkMom) / 2, chg1m: num(r.m.chg1m), adv: num(r.m.advValue20) }))
      .sort((a, b) => b.score - a.score).slice(0, n || 5);
  }

  return { DEFAULTS, QUADRANTS, PERIODS, align, sma, rotationSeries, quadrantOf, analyze, narrate, leaders };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SectorRotation;
