// Logic thuần: BẢN ĐỒ NHIỆT NGÀNH từ ảnh chụp thị trường (các hàng của MarketScreener.buildRows). Mỗi ngành ICB: số mã, tổng vốn hoá, biến động giá của kỳ đã chọn (bình quân gia quyền theo vốn hoá, trung vị, tỷ lệ mã tăng),
// P/E trung vị, mã vốn hoá lớn nhất. Dựng bố cục treemap (diện tích = vốn hoá) bằng thuật toán squarified, và phân bậc màu theo biên độ của từng kỳ.
// Mô tả quá khứ để SOI NGÀNH nào đang mạnh/yếu: không phải tín hiệu mua bán. Kỳ gần nhất có trong ảnh chụp là 1 tháng (không có biến động trong ngày). Mã thiếu số liệu của kỳ bị bỏ khỏi trung bình của kỳ đó và được đếm riêng (cover).
// KHÔNG đụng DOM/mạng. Nạp bằng thẻ <script> thường (global SectorHeatmap) và module.exports cho Vitest.
const SectorHeatmap = (function () {
  // key = tên trường trong chỉ số ảnh chụp; span = biên độ ứng với màu đậm nhất (phần trăm dạng thập phân)
  const PERIODS = [
    { key: 'chg1m', label: '1 tháng', span: 0.08 },
    { key: 'chg3m', label: '3 tháng', span: 0.15 },
    { key: 'chg6m', label: '6 tháng', span: 0.25 },
    { key: 'chgYtd', label: 'Từ 1/1', span: 0.35 },
    { key: 'chg1y', label: '12 tháng', span: 0.5 },
  ];
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const periodOf = (k) => PERIODS.filter((p) => p.key === k)[0] || PERIODS[0];
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

  // Gộp một nhóm hàng thành chỉ số của kỳ
  function aggregate(rows, key) {
    const withCap = rows.filter((r) => num(r.m.marketcap) > 0);
    const have = withCap.filter((r) => num(r.m[key]) !== null);
    const cap = withCap.reduce((s, r) => s + r.m.marketcap, 0), capHave = have.reduce((s, r) => s + r.m.marketcap, 0);
    const chg = capHave > 0 ? have.reduce((s, r) => s + r.m.marketcap * r.m[key], 0) / capHave : null;
    const pes = withCap.filter((r) => num(r.m.pe) > 0 && r.m.pe < 200).map((r) => r.m.pe);
    return { n: rows.length, nCap: withCap.length, nHave: have.length, cap: cap, chg: chg, median: have.length ? median(have.map((r) => r.m[key])) : null,
      up: have.length ? have.filter((r) => r.m[key] > 0).length / have.length : null, cover: cap > 0 ? capHave / cap : 0, pe: median(pes), have: have };
  }

  // rows: MarketScreener.buildRows; key: 'chg1m' | ...; opts: { names: {icb: tên}, minCover: 0.5 }. Trả { key, market, sectors: [...theo vốn hoá giảm dần], empty }.
  function build(rows, key, opts) {
    const o = opts || {}, names = o.names || {}, minCover = o.minCover === undefined ? 0.5 : o.minCover;
    const by = {};
    (rows || []).forEach((r) => { const c = r.icb2_code || '_'; (by[c] = by[c] || []).push(r); });
    const market = aggregate(rows || [], key);
    const sectors = Object.keys(by).map((code) => {
      const a = aggregate(by[code], key), big = a.have.slice().sort((x, y) => y.m.marketcap - x.m.marketcap);
      const named = by[code].filter((r) => num(r.m.marketcap) > 0).sort((x, y) => y.m.marketcap - x.m.marketcap);
      const mid = a.have.filter((r) => r.m.marketcap >= 1e12).sort((x, y) => y.m[key] - x.m[key]);          // mã từ 1.000 tỷ trở lên: tránh mã nhỏ tăng/giảm cực đoan chiếm vị trí dẫn đầu
      return { code: code === '_' ? null : code, name: names[code] || (code === '_' ? 'Chưa phân ngành' : 'ICB ' + code), n: a.n, nHave: a.nHave, cap: a.cap, chg: a.chg, median: a.median, up: a.up, pe: a.pe, cover: a.cover,
        rel: a.chg !== null && market.chg !== null ? a.chg - market.chg : null, ok: a.chg !== null && a.cover >= minCover,
        biggest: named.slice(0, 3).map((r) => ({ symbol: r.symbol, cap: r.m.marketcap, chg: num(r.m[key]) })),
        best: mid.length ? { symbol: mid[0].symbol, chg: mid[0].m[key] } : null, worst: mid.length > 1 ? { symbol: mid[mid.length - 1].symbol, chg: mid[mid.length - 1].m[key] } : null, big: big.length };
    }).filter((s) => s.cap > 0).sort((a, b) => b.cap - a.cap);
    return { key: key, market: { n: market.n, cap: market.cap, chg: market.chg, median: market.median, up: market.up, pe: market.pe, cover: market.cover }, sectors: sectors, empty: !sectors.some((s) => s.ok) };
  }

  // Bậc màu từ -3 (giảm mạnh) đến +3 (tăng mạnh); null khi thiếu số liệu. Biên độ theo kỳ (kỳ dài dao động rộng hơn).
  function bucket(chg, key) {
    const v = num(chg);
    if (v === null) return null;
    const b = Math.sign(v) * Math.round(Math.abs(v) / periodOf(key).span * 3);      // đối xứng: +1,5 và -1,5 cùng làm tròn ra xa số 0
    return Math.max(-3, Math.min(3, b)) + 0;
  }

  // Treemap squarified. items: [{ key, value }] (value > 0), bố cục trong hình chữ nhật W x H. Trả [{ key, x, y, w, h }] cùng thứ tự giá trị giảm dần.
  function treemap(items, W, H) {
    const list = (items || []).filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
    const total = list.reduce((s, i) => s + i.value, 0);
    if (!list.length || !(W > 0) || !(H > 0)) return [];
    const nodes = list.map((i) => ({ key: i.key, area: i.value / total * W * H }));
    const out = []; let x = 0, y = 0, w = W, h = H, i = 0;
    const worst = (row, side) => { const s = row.reduce((t, n) => t + n.area, 0), mx = Math.max.apply(null, row.map((n) => n.area)), mn = Math.min.apply(null, row.map((n) => n.area)); return Math.max(side * side * mx / (s * s), s * s / (side * side * mn)); };
    while (i < nodes.length) {
      const side = Math.min(w, h); let row = [nodes[i]], j = i + 1;
      while (j < nodes.length && worst(row.concat([nodes[j]]), side) <= worst(row, side)) { row.push(nodes[j]); j++; }
      const rowArea = row.reduce((t, n) => t + n.area, 0);
      if (w >= h) { const cw = rowArea / h; let cy = y; row.forEach((n) => { const ch = n.area / cw; out.push({ key: n.key, x: x, y: cy, w: cw, h: ch }); cy += ch; }); x += cw; w -= cw; }
      else { const rh = rowArea / w; let cx = x; row.forEach((n) => { const cw = n.area / rh; out.push({ key: n.key, x: cx, y: y, w: cw, h: rh }); cx += cw; }); y += rh; h -= rh; }
      i = j;
    }
    return out;
  }

  return { PERIODS, periodOf, aggregate, build, bucket, treemap, median };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SectorHeatmap;
