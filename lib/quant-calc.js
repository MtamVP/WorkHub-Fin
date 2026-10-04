// Logic thuần: BẢNG ĐIỀU KHIỂN ĐỊNH LƯỢNG cho các mã đang nắm -- tập hợp những chỉ báo mà hội đồng đầu tư và quản lý rủi ro thường soát trước khi họp, tính từ chỉ số VNDirect (finance_stock_ratios):
//   * Vòng quay sức mạnh tương đối JdK (RS-Ratio, RS-Momentum so với thị trường): Dẫn đầu / Suy yếu / Tụt hậu / Cải thiện.
//   * Vị trí trong biên độ 52 tuần, cách đỉnh bao nhiêu; thay đổi giá 1/3/6/12 tháng.
//   * Định giá so với chính lịch sử: P/E hiện tại / bình quân 1, 3, 5 năm; P/E điều hoà có trọng số của cả danh mục.
//   * Thanh khoản: số phiên để thoát vị thế nếu chỉ chiếm 20% giá trị giao dịch ngày; room ngoại còn lại; dòng tiền khối ngoại 5 phiên so với thanh khoản.
//   * Cờ cần chú ý bằng ngôn ngữ thường. Mọi cờ kèm số liệu; không phải khuyến nghị mua/bán.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global QuantCalc) và module.exports cho Vitest.
const QuantCalc = (function () {
  const PARTICIPATION = 0.2;       // chỉ nên chiếm tối đa 20% giá trị giao dịch ngày (cùng quy ước với SizingCalc / RebalanceCalc)
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };

  // Vòng quay JdK: RS-Ratio > 100 = mạnh hơn thị trường; RS-Momentum > 100 = đang tăng tốc
  const QUADRANTS = {
    leading: { label: 'Dẫn đầu', tone: 'ok' }, weakening: { label: 'Suy yếu', tone: 'warn' }, lagging: { label: 'Tụt hậu', tone: 'bad' }, improving: { label: 'Cải thiện', tone: 'info' },
  };
  function rotation(rs, mom) {
    const r = num(rs), m = num(mom);
    if (r === null || m === null) return null;
    const key = r >= 100 ? (m >= 100 ? 'leading' : 'weakening') : (m >= 100 ? 'improving' : 'lagging');
    return Object.assign({ key: key, rs: r, mom: m }, QUADRANTS[key]);
  }

  // Vị trí 0-100% trong biên độ 52 tuần (0 = đáy, 100 = đỉnh) và % cách đỉnh
  function range52(price, low, high) {
    const p = num(price), lo = num(low), hi = num(high);
    if (!(p > 0) || !(lo > 0) || !(hi > lo)) return null;
    return { positionPct: Math.min(100, Math.max(0, (p - lo) / (hi - lo) * 100)), fromHighPct: (p / hi - 1) * 100, fromLowPct: (p / lo - 1) * 100 };
  }

  // Số phiên để thoát vị thế: giá trị đang giữ / (giá trị giao dịch TB ngày x tỷ lệ tham gia). null nếu thiếu thanh khoản.
  function daysToExit(heldValue, advValue, participation) {
    const h = num(heldValue), a = num(advValue), p = participation > 0 ? participation : PARTICIPATION;
    if (!(h >= 0) || !(a > 0)) return null;
    return h / (a * p);
  }

  // Dòng tiền khối ngoại ròng 5 phiên so với tổng giá trị giao dịch 5 phiên (% thanh khoản): âm = bán ròng
  function foreignPressure(net5d, advValue20) {
    const n = num(net5d), a = num(advValue20);
    return n !== null && a > 0 ? n / (a * 5) * 100 : null;
  }

  // holdings: [{ symbol, value }]; ratios: { SYMBOL: { metrics } }; opts: { prices: {SYM: giá hiện tại} }. Trả { rows, summary }.
  function dashboard(holdings, ratios, opts) {
    const o = opts || {}, list = (holdings || []).filter((h) => num(h.value) > 0);
    const total = list.reduce((s, h) => s + num(h.value), 0);
    const rows = list.map((h) => {
      const sym = String(h.symbol).toUpperCase(), r = (ratios && ratios[sym]) || null, m = r ? (r.metrics || {}) : {};
      const price = num(o.prices && o.prices[sym]);
      const peRatio = (k) => (num(m.pe) > 0 && num(m[k]) > 0 ? m.pe / m[k] : null);
      const row = {
        symbol: sym, value: num(h.value), weightPct: total > 0 ? num(h.value) / total * 100 : null, hasData: !!r,
        pe: num(m.pe), pb: num(m.pb), roe: num(m.roae), beta: num(m.beta), peVs1y: peRatio('pe1y'), peVs3y: peRatio('pe3y'), peVs5y: peRatio('pe5y'),
        chg1m: num(m.chg1m), chg3m: num(m.chg3m), chg6m: num(m.chg6m), chg1y: num(m.chg1y),
        rotation: rotation(m.jdkRs, m.jdkMom), range: range52(price, m.low52, m.high52),
        daysToExit: daysToExit(h.value, m.advValue20), foreignPressurePct: foreignPressure(m.foreignNet5d, m.advValue20), foreignRoomLeftPct: num(m.foreignRoomLeftPct), foreignNet5d: num(m.foreignNet5d),
        advValue20: num(m.advValue20), updatedAt: r ? r.updatedAt : null, flags: [],
      };
      const f = row.flags;
      if (row.daysToExit !== null && row.daysToExit > 5) f.push({ tone: 'bad', text: 'Khó thoát vị thế: cần ' + Math.round(row.daysToExit * 10) / 10 + ' phiên nếu chỉ chiếm 20% thanh khoản ngày.' });
      else if (row.daysToExit !== null && row.daysToExit > 2) f.push({ tone: 'warn', text: 'Thoát vị thế cần khoảng ' + Math.round(row.daysToExit * 10) / 10 + ' phiên (tối đa 20% thanh khoản ngày).' });
      if (row.rotation && row.rotation.key === 'lagging' && row.weightPct >= 10) f.push({ tone: 'warn', text: 'Chiếm ' + Math.round(row.weightPct) + '% danh mục nhưng đang TỤT HẬU so với thị trường (RS ' + Math.round(row.rotation.rs * 10) / 10 + ', động lượng ' + Math.round(row.rotation.mom * 10) / 10 + ').' });
      if (row.peVs5y !== null && row.peVs5y > 1.3) f.push({ tone: 'warn', text: 'P/E cao hơn ' + Math.round((row.peVs5y - 1) * 100) + '% so với bình quân 5 năm của chính mã.' });
      if (row.peVs5y !== null && row.peVs5y < 0.6) f.push({ tone: 'info', text: 'P/E chỉ bằng ' + Math.round(row.peVs5y * 100) + '% bình quân 5 năm của chính mã (rẻ so với lịch sử, nhưng cần xem tăng trưởng có đổi không).' });
      if (row.range && row.range.positionPct >= 95) f.push({ tone: 'info', text: 'Giá sát đỉnh 52 tuần.' });
      if (row.range && row.range.positionPct <= 5) f.push({ tone: 'warn', text: 'Giá sát đáy 52 tuần (cách đỉnh ' + Math.round(-row.range.fromHighPct) + '%).' });
      if (row.foreignPressurePct !== null && row.foreignPressurePct <= -10) f.push({ tone: 'warn', text: 'Khối ngoại bán ròng 5 phiên bằng ' + Math.round(-row.foreignPressurePct) + '% thanh khoản.' });
      if (row.foreignRoomLeftPct !== null && row.foreignRoomLeftPct < 3) f.push({ tone: 'info', text: 'Room ngoại gần hết (còn ' + Math.round(row.foreignRoomLeftPct * 10) / 10 + '%): khối ngoại khó mua thêm.' });
      return row;
    }).sort((a, b) => b.value - a.value);
    const covered = rows.filter((r) => r.hasData), cw = covered.reduce((s, r) => s + r.value, 0);
    const wavg = (k) => { const x = covered.filter((r) => r[k] !== null); const w = x.reduce((s, r) => s + r.value, 0); return w > 0 ? x.reduce((s, r) => s + r[k] * r.value, 0) / w : null; };
    // P/E điều hoà có trọng số: 1 / tổng(trọng số / P/E) -- lợi suất thu nhập (1/PE) mới là đại lượng cộng được
    const withPe = covered.filter((r) => r.pe > 0), wPe = withPe.reduce((s, r) => s + r.value, 0);
    const harmPe = wPe > 0 ? wPe / withPe.reduce((s, r) => s + r.value / r.pe, 0) : null;
    const byQ = {}; covered.forEach((r) => { if (r.rotation) byQ[r.rotation.key] = (byQ[r.rotation.key] || 0) + r.value; });
    const illiquid = rows.filter((r) => r.daysToExit !== null && r.daysToExit > 5).reduce((s, r) => s + r.value, 0);
    return {
      rows: rows,
      summary: { count: rows.length, covered: covered.length, coveragePct: total > 0 ? cw / total * 100 : 0, harmonicPe: harmPe, roe: wavg('roe'), beta: wavg('beta'), pb: wavg('pb'),
        rotationPct: Object.fromEntries(Object.keys(QUADRANTS).map((k) => [k, cw > 0 ? (byQ[k] || 0) / cw * 100 : 0])), illiquidPct: total > 0 ? illiquid / total * 100 : 0,
        flagged: rows.filter((r) => r.flags.some((x) => x.tone === 'bad' || x.tone === 'warn')).length },
    };
  }

  return { PARTICIPATION, QUADRANTS, rotation, range52, daysToExit, foreignPressure, dashboard };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QuantCalc;
