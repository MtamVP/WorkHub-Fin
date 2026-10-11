// Dữ liệu tổng hợp cho test kiểm thử chiến lược: dựng các dòng finance_price_days / finance_bt_index và bảng số liệu theo thời điểm từ hàm lợi suất cho trước.
const dayMs = 86400000;
function bizDays(start, n) {
  const out = []; let t = Date.parse(start + 'T00:00:00Z');
  while (out.length < n) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) out.push(new Date(t).toISOString().slice(0, 10)); t += dayMs; }
  return out;
}
// stocks: { MÃ: { ret: (t) => lợi suất ngày, p0: giá đầu (nghìn đồng), val: giá trị khớp (triệu đồng) hoặc (t) => giá trị, ex: sàn 0/1/2, from, to: khoảng ngày có mặt, lim: { [t]: 1 | -1 }, retOverride: { [t]: lợi suất } } }
function makeRows(days, stocks, opts) {
  const o = Object.assign({ index: null }, opts || {});
  const dates = bizDays(o.start || '2021-01-04', days);
  const rows = dates.map((d) => ({ day: d, data: {} }));
  Object.keys(stocks).forEach((sym) => {
    const s = stocks[sym], from = s.from === undefined ? 0 : s.from, to = s.to === undefined ? days - 1 : s.to;
    let close = s.p0 || 20;
    for (let t = from; t <= to; t++) {
      const r = typeof s.ret === 'function' ? s.ret(t) : s.ret;
      close = Math.round(close * (1 + r) * 1000) / 1000;
      const val = typeof s.val === 'function' ? s.val(t) : (s.val === undefined ? 20000 : s.val);
      rows[t].data[sym] = [close, s.retOverride && s.retOverride[t] !== undefined ? s.retOverride[t] : r, val, (s.lim && s.lim[t]) || 0, s.ex || 0];
    }
  });
  return { rows, dates };
}
function indexRow(symbol, dates, fn) {
  let v = 1000; const c = [];
  dates.forEach((d, t) => { v = v * (1 + (typeof fn === 'function' ? fn(t) : fn)); c.push(Math.round(v * 100) / 100); });
  return { symbol, data: { d: dates.slice(), c } };
}
// Bảng số liệu theo thời điểm (hàng thô của finance_pit_market_daily)
const PIT_COLS = ['icb2', 'price', 'marketcap', 'pe', 'pb', 'ps', 'evEbitda', 'divYield', 'roae', 'roaa', 'beta', 'chg1m', 'chg3m', 'chg6m', 'chg1y', 'chgYtd', 'advValue20', 'freefloat', 'netMargin', 'grossMargin', 'debtToEquity', 'netProfitGrowthYoY', 'salesGrowthYoY', 'epsGrowthYoY', 'jdkRs', 'jdkMom', 'shares'];
function pitRow(asOf, perSymbol) {
  const data = {};
  Object.keys(perSymbol).forEach((sym) => { data[sym] = PIT_COLS.map((c) => (perSymbol[sym][c] === undefined ? null : perSymbol[sym][c])); });
  return { as_of: asOf, n: Object.keys(data).length, cols: PIT_COLS.slice(), data };
}
module.exports = { bizDays, makeRows, indexRow, PIT_COLS, pitRow };
