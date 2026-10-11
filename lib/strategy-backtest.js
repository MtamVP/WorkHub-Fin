// Logic thuần: KIỂM THỬ CHIẾN LƯỢC TỔNG QUÁT trên lịch sử thị trường Việt Nam. Bạn mô tả quy tắc (vũ trụ, bộ lọc, cách xếp hạng, số mã, cách chia tỷ trọng, tần suất cân bằng, chi phí); hàm này chạy lại trên lịch sử và trả
// lãi/lỗ, sụt giảm, Sharpe, vòng quay, so với VN-Index VÀ so với rổ đều toàn vũ trụ, kèm các phép thử để biết kết quả có đáng tin không.
//
// Quy tắc chống gian lận (look-ahead) -- mọi quyết định ở ngày t chỉ dùng dữ liệu tới hết ngày t, lệnh khớp ở giá đóng cửa phiên t + lag (mặc định 1):
//   * Giá: lợi suất tổng theo giá tham chiếu của sàn (lib/bt-panel.js); số liệu cơ bản: bản chụp theo thời điểm gần nhất <= ngày t (lib/pit-calc.js) và không cũ quá pitMaxStale ngày.
//   * Mã được chọn có thể không mua được lúc khớp: kẹt trần (không mua), kẹt sàn (không bán), không có phiên (tạm ngừng / hủy niêm yết). Mỗi phiên chỉ khớp tối đa `participation` giá trị giao dịch (lấy mức thấp hơn của
//     phiên đó và trung bình 20 phiên), phần dư để lại cho kỳ sau; chi phí tác động giá theo căn bậc hai (cùng công thức với Market Simulation và lib/liquidity-calc.js); phí hai chiều + thuế bán.
//   * Mã hủy niêm yết: giữ tới phiên cuối cùng có giá rồi bán ở giá đó (không phạt thêm).
// Các phép thử độ tin cậy (đọc kết quả KÈM chúng, đừng đọc riêng con số lãi):
//   * Rổ ngẫu nhiên: cùng vũ trụ, cùng số mã, cùng lịch và chi phí nhưng chọn ngẫu nhiên -> chiến lược nằm ở phân vị nào. Đây là phép so công bằng nhất vì cùng loại lợi suất (đã gồm cổ tức) và cùng thiên lệch vũ trụ.
//   * Khoảng tin cậy bootstrap theo khối (21 phiên) cho CAGR, Sharpe và lợi suất vượt VN-Index.
//   * Chia đôi giai đoạn (nửa đầu / nửa sau) và lợi suất từng năm: chiến lược chỉ ăn ở một giai đoạn là dấu hiệu khớp quá mức.
//   * Lưới độ nhạy (số mã, tần suất, độ trễ, chi phí gấp đôi): kết quả mong manh khi đổi nhẹ tham số = không đáng tin.
//   * Sharpe đã trừ may rủi cho số lần thử (Bailey và López de Prado): thử càng nhiều cấu hình trên cùng dữ liệu, Sharpe tốt nhất càng có khả năng do ngẫu nhiên.
// Giới hạn nói thẳng: (1) VN-Index là chỉ số GIÁ (không gồm cổ tức) nên so với nó chiến lược được lợi khoảng 1-2 điểm %/năm; hãy nhìn thêm rổ đều và rổ ngẫu nhiên. (2) Số liệu cơ bản (P/E, ROE...) lấy từ chỉ số
// VNDirect tính theo ngày: P/E, P/B đổi đúng ngày công bố báo cáo nhưng chỉ số theo quý chỉ lấy quý đã qua hạn công bố bảo thủ. (3) Mã UPCoM thanh khoản rất thấp không có trong kho. (4) Quá khứ không bảo đảm tương lai;
// một cấu hình tốt trên lịch sử có thể chỉ là kết quả của việc đã thử nhiều cấu hình. (5) Không mô phỏng lô 100, T+2 và hạn mức margin.
// KHÔNG đụng DOM/mạng/tệp. Nạp bằng thẻ <script> thường (global StrategyBacktest) và module.exports cho Vitest. Cần BtPanel và PitCalc.
const StrategyBacktest = (function () {
  const NODE = typeof require === 'function' && typeof module !== 'undefined';
  const PC = NODE ? require('./pit-calc.js') : globalThis.PitCalc;
  const BP = NODE ? require('./bt-panel.js') : globalThis.BtPanel;
  const TD = 252;
  const VERSION = 1;
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- danh mục tiêu chí ----------
  // group 'price': tính từ chuỗi giá tại ngày t (không cần bảng cơ bản). group 'fund': đọc từ bản chụp theo thời điểm. look = số phiên lịch sử tối thiểu.
  const FACTORS = [
    { key: 'mom1', label: 'Lợi suất 1 tháng', group: 'price', unit: 'pct', look: 21, hint: 'Giá hiện tại so với 21 phiên trước.' },
    { key: 'mom3', label: 'Lợi suất 3 tháng', group: 'price', unit: 'pct', look: 63 },
    { key: 'mom6', label: 'Lợi suất 6 tháng', group: 'price', unit: 'pct', look: 126 },
    { key: 'mom12', label: 'Lợi suất 12 tháng', group: 'price', unit: 'pct', look: 252 },
    { key: 'mom12_1', label: 'Động lượng 12-1 (bỏ tháng gần nhất)', group: 'price', unit: 'pct', look: 252, hint: 'Lợi suất từ 12 tháng trước tới 1 tháng trước: bỏ tháng gần nhất để tránh hiệu ứng đảo chiều ngắn hạn.' },
    { key: 'rev5', label: 'Lợi suất 1 tuần (đảo chiều)', group: 'price', unit: 'pct', look: 5, hint: 'Chọn mã giảm mạnh tuần qua (dir = thấp) là chiến lược đảo chiều ngắn hạn.' },
    { key: 'vol60', label: 'Biến động 60 phiên (năm hoá)', group: 'price', unit: 'pct', look: 60 },
    { key: 'beta252', label: 'Beta 1 năm so với VN-Index', group: 'price', unit: 'x', look: 252 },
    { key: 'high52', label: 'Gần đỉnh 52 tuần (0 = đang ở đỉnh)', group: 'price', unit: 'pct', look: 126, hint: 'Giá / đỉnh 52 tuần - 1 (luôn <= 0).' },
    { key: 'ma200', label: 'Giá so với trung bình 200 phiên', group: 'price', unit: 'pct', look: 200 },
    { key: 'ma50', label: 'Giá so với trung bình 50 phiên', group: 'price', unit: 'pct', look: 50 },
    { key: 'adv', label: 'Giá trị giao dịch TB 20 phiên (đồng)', group: 'price', unit: 'vnd', look: 20 },
    { key: 'pe', label: 'P/E', group: 'fund', unit: 'x' }, { key: 'pb', label: 'P/B', group: 'fund', unit: 'x' }, { key: 'ps', label: 'P/S', group: 'fund', unit: 'x' },
    { key: 'evEbitda', label: 'EV/EBITDA', group: 'fund', unit: 'x' },
    { key: 'earningsYield', label: 'Lợi suất lợi nhuận (1/PE)', group: 'fund', unit: 'pct', hint: 'Mã lỗ (P/E không dương) không có giá trị: bị loại khỏi tiêu chí này.' },
    { key: 'bookYield', label: 'Lợi suất giá trị sổ sách (1/PB)', group: 'fund', unit: 'pct' },
    { key: 'salesYield', label: 'Lợi suất doanh thu (1/PS)', group: 'fund', unit: 'pct' },
    { key: 'divYield', label: 'Tỷ suất cổ tức', group: 'fund', unit: 'pct' },
    { key: 'roae', label: 'ROE', group: 'fund', unit: 'pct' }, { key: 'roaa', label: 'ROA', group: 'fund', unit: 'pct' },
    { key: 'netMargin', label: 'Biên lợi nhuận ròng', group: 'fund', unit: 'pct' }, { key: 'grossMargin', label: 'Biên lợi nhuận gộp', group: 'fund', unit: 'pct' },
    { key: 'debtToEquity', label: 'Nợ / vốn chủ', group: 'fund', unit: 'x' },
    { key: 'netProfitGrowthYoY', label: 'Tăng trưởng lợi nhuận (so cùng kỳ)', group: 'fund', unit: 'pct' }, { key: 'salesGrowthYoY', label: 'Tăng trưởng doanh thu (so cùng kỳ)', group: 'fund', unit: 'pct' },
    { key: 'epsGrowthYoY', label: 'Tăng trưởng EPS (so cùng kỳ)', group: 'fund', unit: 'pct' },
    { key: 'marketcap', label: 'Vốn hoá (đồng)', group: 'fund', unit: 'vnd' },
    { key: 'size', label: 'Quy mô (log vốn hoá)', group: 'fund', unit: 'x' },
    { key: 'beta', label: 'Beta (VNDirect)', group: 'fund', unit: 'x' },
    { key: 'jdkRs', label: 'Sức mạnh tương đối JdK', group: 'fund', unit: 'x' }, { key: 'jdkMom', label: 'Động lượng sức mạnh tương đối JdK', group: 'fund', unit: 'x' },
  ];
  const BY_KEY = {}; FACTORS.forEach((f) => { BY_KEY[f.key] = f; });

  // ---------- cấu hình ----------
  const DEFAULT_SPEC = {
    v: VERSION, name: 'Chiến lược mới', period: { from: null, to: null },
    universe: { minAdv: 1e9, minPrice: 0, exchanges: ['HOSE', 'HNX'], icbIn: [], icbOut: [], minHistory: 120 },
    filters: [], rank: [{ key: 'mom12_1', dir: 'high', w: 1 }], select: { n: 20, keep: 0 },
    weighting: 'equal', maxWeight: 0.15, rebalance: 'M', lag: 1, participation: 0.2,
    costs: { fee: 0.0015, tax: 0.001, impact: true, impactK: 0.8, impactCap: 0.1 }, rf: 0.03, capital: 1e9, pitMaxStale: 45,
  };
  const PRESETS = [
    { id: 'momentum', label: 'Động lượng 12-1', note: 'Mua 20 mã tăng mạnh nhất 12 tháng (bỏ tháng gần nhất), cân bằng hằng tháng.', spec: { name: 'Động lượng 12-1', rank: [{ key: 'mom12_1', dir: 'high', w: 1 }], select: { n: 20 } } },
    { id: 'lowvol', label: 'Biến động thấp', note: 'Mua 20 mã biến động thấp nhất, chia theo nghịch đảo biến động.', spec: { name: 'Biến động thấp', rank: [{ key: 'vol60', dir: 'low', w: 1 }], select: { n: 20 }, weighting: 'invvol' } },
    { id: 'trend', label: 'Xu hướng tăng', note: 'Chỉ mã đang trên trung bình 200 phiên, chọn 20 mã có đà 6 tháng mạnh nhất.', spec: { name: 'Xu hướng tăng', filters: [{ key: 'ma200', min: 0 }], rank: [{ key: 'mom6', dir: 'high', w: 1 }], select: { n: 20 } } },
    { id: 'value-quality', label: 'Rẻ và chất lượng', note: 'P/E từ 0 đến 15, ROE trên 12%; xếp hạng theo lợi suất lợi nhuận và ROE. Cần bản chụp cơ bản theo thời điểm.', spec: { name: 'Rẻ và chất lượng', filters: [{ key: 'pe', min: 0.01, max: 15 }, { key: 'roae', min: 0.12 }], rank: [{ key: 'earningsYield', dir: 'high', w: 1 }, { key: 'roae', dir: 'high', w: 1 }], select: { n: 20 } } },
    { id: 'reversal', label: 'Đảo chiều tuần', note: 'Mua 20 mã giảm mạnh nhất tuần qua, cân bằng hằng tuần (vòng quay rất cao, chi phí quyết định kết quả).', spec: { name: 'Đảo chiều tuần', rank: [{ key: 'rev5', dir: 'low', w: 1 }], select: { n: 20 }, rebalance: 'W' } },
    { id: 'growth', label: 'Tăng trưởng lợi nhuận', note: 'Chọn 20 mã tăng trưởng lợi nhuận cao nhất trong các mã đang có lãi.', spec: { name: 'Tăng trưởng lợi nhuận', filters: [{ key: 'pe', min: 0.01, max: 40 }], rank: [{ key: 'netProfitGrowthYoY', dir: 'high', w: 1 }], select: { n: 20 } } },
  ];
  const WEIGHTINGS = ['equal', 'invvol', 'score'];
  const FREQS = ['W', 'M', 'Q', 'Y'];

  const merge = (base, over) => {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    Object.keys(over || {}).forEach((k) => {
      const v = over[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v); else if (v !== undefined) out[k] = v;
    });
    return out;
  };
  // Chuẩn hoá và kiểm tra cấu hình. Trả { spec, errors[], warnings[] }; errors không rỗng thì không chạy.
  function normalizeSpec(raw) {
    const errors = [], warnings = [];
    const s = merge(DEFAULT_SPEC, raw || {});
    s.v = VERSION;
    s.name = String(s.name || 'Chiến lược').slice(0, 120);
    s.universe.minAdv = clamp(Number(s.universe.minAdv) || 0, 0, 1e13);
    s.universe.minPrice = clamp(Number(s.universe.minPrice) || 0, 0, 1e7);
    s.universe.minHistory = clamp(Math.round(Number(s.universe.minHistory) || 0), 0, 1000);
    s.universe.exchanges = (Array.isArray(s.universe.exchanges) ? s.universe.exchanges : []).map((x) => String(x).toUpperCase()).filter((x) => ['HOSE', 'HNX', 'UPCOM'].includes(x));
    if (!s.universe.exchanges.length) errors.push('Chọn ít nhất một sàn.');
    s.universe.icbIn = (Array.isArray(s.universe.icbIn) ? s.universe.icbIn : []).map(String); s.universe.icbOut = (Array.isArray(s.universe.icbOut) ? s.universe.icbOut : []).map(String);
    s.filters = (Array.isArray(s.filters) ? s.filters : []).slice(0, 12).map((f) => ({ key: String(f && f.key), min: isNum(Number(f && f.min)) && f.min !== null && f.min !== '' && f.min !== undefined ? Number(f.min) : null, max: isNum(Number(f && f.max)) && f.max !== null && f.max !== '' && f.max !== undefined ? Number(f.max) : null }));
    s.filters.forEach((f) => { if (!BY_KEY[f.key]) errors.push('Bộ lọc dùng tiêu chí không có: ' + f.key); else if (f.min === null && f.max === null) errors.push('Bộ lọc ' + f.key + ' chưa có ngưỡng.'); else if (f.min !== null && f.max !== null && f.min > f.max) errors.push('Bộ lọc ' + f.key + ': ngưỡng dưới lớn hơn ngưỡng trên.'); });
    s.rank = (Array.isArray(s.rank) ? s.rank : []).slice(0, 8).map((r) => ({ key: String(r && r.key), dir: r && r.dir === 'low' ? 'low' : 'high', w: clamp(Number(r && r.w) || 1, 0.1, 10) }));
    if (!s.rank.length) errors.push('Cần ít nhất một tiêu chí xếp hạng.');
    s.rank.forEach((r) => { if (!BY_KEY[r.key]) errors.push('Xếp hạng dùng tiêu chí không có: ' + r.key); });
    s.select.n = clamp(Math.round(Number(s.select.n) || 20), 1, 100);
    s.select.keep = clamp(Number(s.select.keep) || 0, 0, 2);
    if (!WEIGHTINGS.includes(s.weighting)) { errors.push('Cách chia tỷ trọng không hợp lệ.'); }
    s.maxWeight = clamp(Number(s.maxWeight) || 1, 0.01, 1);
    if (s.maxWeight * s.select.n < 0.999) warnings.push('Trần tỷ trọng ' + Math.round(s.maxWeight * 100) + '% x ' + s.select.n + ' mã nhỏ hơn 100%: phần còn lại giữ tiền mặt.');
    if (!FREQS.includes(s.rebalance)) errors.push('Tần suất cân bằng không hợp lệ.');
    s.lag = clamp(Math.round(Number(s.lag) || 1), 1, 5);
    s.participation = clamp(Number(s.participation) || 0.2, 0.01, 1);
    s.costs.fee = clamp(Number(s.costs.fee), 0, 0.02); if (!isNum(s.costs.fee)) s.costs.fee = DEFAULT_SPEC.costs.fee;
    s.costs.tax = clamp(Number(s.costs.tax), 0, 0.02); if (!isNum(s.costs.tax)) s.costs.tax = DEFAULT_SPEC.costs.tax;
    s.costs.impact = s.costs.impact !== false;
    s.costs.impactK = clamp(Number(s.costs.impactK) || 0.8, 0, 5); s.costs.impactCap = clamp(Number(s.costs.impactCap) || 0.1, 0, 0.5);
    s.rf = clamp(Number(s.rf) || 0, 0, 0.3);
    s.capital = clamp(Number(s.capital) || 1e9, 1e7, 1e13);
    s.pitMaxStale = clamp(Math.round(Number(s.pitMaxStale) || 45), 1, 400);
    ['from', 'to'].forEach((k) => { const v = s.period[k]; s.period[k] = /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; });
    if (s.period.from && s.period.to && s.period.from >= s.period.to) errors.push('Ngày bắt đầu phải trước ngày kết thúc.');
    if (s.rebalance === 'W' && s.filters.concat(s.rank).some((x) => BY_KEY[x.key] && BY_KEY[x.key].group === 'fund')) warnings.push('Cân bằng hằng tuần dùng số liệu cơ bản theo tháng (bản chụp cuối tháng gần nhất): số liệu có thể cũ tới ~1 tháng.');
    return { spec: s, errors, warnings };
  }
  const usesFund = (spec) => spec.filters.concat(spec.rank).some((x) => BY_KEY[x.key] && BY_KEY[x.key].group === 'fund') || spec.universe.icbIn.length > 0 || spec.universe.icbOut.length > 0;
  const lookback = (spec) => Math.max(spec.universe.minHistory, 21, ...spec.filters.concat(spec.rank).map((x) => (BY_KEY[x.key] && BY_KEY[x.key].look) || 0));

  // ---------- đặc trưng từ chuỗi giá (chỉ dùng dữ liệu <= t) ----------
  function median(a) { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function lvlAt(P, s, t) { const v = P.lvl[s][t]; return v === v ? v : NaN; }
  function advOf(P, s, t) {                                 // giá trị khớp lệnh TB 20 phiên (đồng): trung vị các phiên có giá; cần >= 10 phiên có dữ liệu
    const v = P.val[s], out = [];
    for (let k = t; k >= 0 && out.length < 20 && t - k < 40; k--) { const x = v[k]; if (x === x) out.push(x); }
    return out.length >= 10 ? median(out) * 1e6 : NaN;
  }
  function volOf(P, s, t, n) {                              // độ lệch chuẩn lợi suất ngày n phiên gần nhất (chưa năm hoá); cần >= 2/3 số phiên
    const r = P.ret[s]; let cnt = 0, sum = 0, sq = 0;
    for (let k = t; k > t - n && k >= 0; k--) { const x = r[k]; if (x === x) { cnt++; sum += x; sq += x * x; } }
    if (cnt < Math.ceil(n * 2 / 3) || cnt < 2) return NaN;
    const m = sum / cnt; return Math.sqrt(Math.max(0, (sq - cnt * m * m) / (cnt - 1)));
  }
  function indexRets(P, code) {                             // lợi suất ngày của chỉ số (cache trong panel)
    P._ir = P._ir || {};
    if (P._ir[code]) return P._ir[code];
    const ix = P.index[code], out = new Float64Array(P.T).fill(NaN);
    if (ix) for (let t = 1; t < P.T; t++) if (ix[t] > 0 && ix[t - 1] > 0) out[t] = ix[t] / ix[t - 1] - 1;
    P._ir[code] = out; return out;
  }
  function betaOf(P, s, t, n) {
    const r = P.ret[s], b = indexRets(P, 'VNINDEX'); let c = 0, sa = 0, sb = 0, sab = 0, sbb = 0;
    for (let k = t; k > t - n && k >= 1; k--) { const x = r[k], y = b[k]; if (x === x && y === y) { c++; sa += x; sb += y; sab += x * y; sbb += y * y; } }
    if (c < 120) return NaN;
    const vb = sbb / c - (sb / c) * (sb / c); return vb > 0 ? (sab / c - (sa / c) * (sb / c)) / vb : NaN;
  }
  function priceFactor(P, key, s, t) {
    const L = P.lvl[s], f = P.first[s];
    const back = (n) => (t - n >= f && t - n >= 0 ? L[t - n] : NaN);
    switch (key) {
      case 'mom1': return L[t] / back(21) - 1;
      case 'mom3': return L[t] / back(63) - 1;
      case 'mom6': return L[t] / back(126) - 1;
      case 'mom12': return L[t] / back(252) - 1;
      case 'mom12_1': { const a = back(252), b = back(21); return L[t] > 0 ? b / a - 1 : NaN; }
      case 'rev5': return L[t] / back(5) - 1;
      case 'vol60': { const v = volOf(P, s, t, 60); return v === v ? v * Math.sqrt(TD) : NaN; }
      case 'beta252': return betaOf(P, s, t, 252);
      case 'high52': { if (t - f < 125) return NaN; let mx = 0; for (let k = Math.max(f, t - 251); k <= t; k++) if (L[k] > mx) mx = L[k]; return mx > 0 ? L[t] / mx - 1 : NaN; }
      case 'ma200': case 'ma50': { const n = key === 'ma200' ? 200 : 50; if (t - f < n - 1) return NaN; let sum = 0; for (let k = t - n + 1; k <= t; k++) sum += L[k]; return L[t] / (sum / n) - 1; }
      case 'adv': return advOf(P, s, t);
      default: return NaN;
    }
  }
  function fundFactor(m, key) {
    if (!m) return NaN;
    const g = (k) => (isNum(m[k]) ? m[k] : NaN);
    switch (key) {
      case 'earningsYield': { const x = g('pe'); return x > 0 ? 1 / x : NaN; }
      case 'bookYield': { const x = g('pb'); return x > 0 ? 1 / x : NaN; }
      case 'salesYield': { const x = g('ps'); return x > 0 ? 1 / x : NaN; }
      case 'size': { const x = g('marketcap'); return x > 0 ? Math.log(x) : NaN; }
      default: return g(key);
    }
  }
  // Giá trị tiêu chí cho mã s tại ngày t. fm = hàng bản chụp cơ bản của mã (hoặc null).
  function factorValue(P, key, s, t, fm) {
    const f = BY_KEY[key]; if (!f) return NaN;
    return f.group === 'price' ? priceFactor(P, key, s, t) : fundFactor(fm, key);
  }

  // ---------- lịch cân bằng ----------
  function periodKey(iso, freq) {
    if (freq === 'M') return iso.slice(0, 7);
    if (freq === 'Y') return iso.slice(0, 4);
    if (freq === 'Q') return iso.slice(0, 4) + 'Q' + Math.floor((Number(iso.slice(5, 7)) - 1) / 3);
    const day = Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);
    return 'W' + Math.floor((day + 3) / 7);                // tuần bắt đầu thứ Hai (1/1/1970 là thứ Năm)
  }
  // Chỉ số ngày TÍN HIỆU = phiên cuối cùng của mỗi kỳ trong [from, to] (phiên cuối kỳ chưa trọn của dữ liệu được giữ: sẽ không có phiên khớp nên bị bỏ ở bước dựng lịch)
  function signalDays(P, freq, from, to) {
    const out = [];
    for (let t = from; t <= to; t++) {
      if (t === to || periodKey(P.dates[t], freq) !== periodKey(P.dates[t + 1], freq)) out.push(t);
    }
    return out;
  }

  // ---------- chọn mã và dựng kế hoạch ----------
  function pctRanks(values) {                              // values: [{s, v}] -> Map s -> phân vị (0..1), điểm bằng nhau chia đều
    const sorted = values.slice().sort((a, b) => a.v - b.v), out = new Map(), n = sorted.length;
    let i = 0;
    while (i < n) {
      let j = i; while (j + 1 < n && sorted[j + 1].v === sorted[i].v) j++;
      const r = n > 1 ? ((i + j) / 2) / (n - 1) : 0.5;
      for (let k = i; k <= j; k++) out.set(sorted[k].s, r);
      i = j + 1;
    }
    return out;
  }
  function capWeights(w, maxW) {                           // trần tỷ trọng: phần vượt chia đều cho mã chưa chạm trần; không đủ chỗ thì để tiền mặt
    const out = w.slice(); let free = new Set(out.map((_, i) => i)), guard = 0;
    for (;;) {
      let excess = 0; const over = [];
      out.forEach((x, i) => { if (x > maxW + 1e-12) { excess += x - maxW; out[i] = maxW; over.push(i); } });
      over.forEach((i) => free.delete(i));
      if (excess <= 1e-12 || !free.size || guard++ > 50) break;
      let room = 0; free.forEach((i) => { room += Math.max(0, maxW - out[i]); });
      if (room <= 1e-12) break;
      const add = Math.min(excess, room);
      free.forEach((i) => { out[i] += add * Math.max(0, maxW - out[i]) / room; });
      if (excess - add <= 1e-12) break;
    }
    return out;
  }
  function weightsFor(spec, picks) {                       // picks: [{s, score, vol}] đã sắp theo điểm giảm dần -> tỷ trọng cộng <= 1
    const n = picks.length; if (!n) return [];
    let raw;
    if (spec.weighting === 'invvol') {
      const inv = picks.map((p) => (p.vol > 0 ? 1 / p.vol : NaN)), ok = inv.filter((x) => x === x);
      const fill = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 1;
      raw = inv.map((x) => (x === x ? x : fill));
    } else if (spec.weighting === 'score') raw = picks.map((p) => 0.25 + p.score);
    else raw = picks.map(() => 1);
    const tot = raw.reduce((a, b) => a + b, 0);
    return capWeights(raw.map((x) => x / tot), spec.maxWeight);
  }

  // Vũ trụ tại ngày t (chỉ dùng dữ liệu <= t): mã có phiên ở t, đủ lịch sử, đúng sàn TẠI NGÀY t, đủ giá và thanh khoản; day = bản chụp cơ bản (hoặc null) để lọc ngành. Trả { uni: [chỉ số mã], info: Map mã -> { fm, adv } }.
  function universeAt(P, uspec, t, day) {
    const uni = [], info = new Map();
    for (let s = 0; s < P.S; s++) {
      if (!(P.first[s] >= 0) || P.first[s] > t - uspec.minHistory || P.last[s] < t) continue;
      if (!(P.ret[s][t] === P.ret[s][t])) continue;                    // không có phiên ở ngày t
      if (uspec.exchanges.indexOf(P.exchanges[P.exd[s][t]]) === -1) continue;                  // sàn TẠI NGÀY t (mã chuyển sàn sau này không bị nhìn trước)
      if (uspec.minPrice > 0 && P.close[s][t] * 1000 < uspec.minPrice) continue;
      const adv = advOf(P, s, t);
      if (!(adv >= uspec.minAdv)) continue;
      let fm = null;
      if (day) {
        fm = day.get(P.symbols[s]);
        if (uspec.icbIn && uspec.icbIn.length && !(fm && uspec.icbIn.indexOf(String(fm.icb2)) !== -1)) continue;
        if (uspec.icbOut && uspec.icbOut.length && fm && uspec.icbOut.indexOf(String(fm.icb2)) !== -1) continue;
      }
      uni.push(s); info.set(s, { fm, adv });
    }
    return { uni, info };
  }

  // pit: PitCalc.decodeDays(...) (tăng dần). Trả { items: [{ sig, exec, universe: [s], targets: [{ s, w }], meta }], warnings }.
  function buildPlan(P, pit, spec, o) {
    const opt = Object.assign({ random: null, all: false }, o || {});
    const warnings = [], items = [];
    const needFund = usesFund(spec);
    const look = lookback(spec);
    const startMin = Math.max(look, 1);
    const fromIdx = Math.max(spec.period.from ? Math.max(0, BP.indexOnOrAfter(P, spec.period.from)) : 0, startMin);
    const toIdx = spec.period.to ? Math.min(P.T - 1, BP.indexOnOrBefore(P, spec.period.to)) : P.T - 1;
    if (fromIdx >= toIdx) return { items, warnings: ['Khoảng thời gian không đủ dữ liệu cho các tiêu chí đã chọn (cần ' + look + ' phiên lịch sử trước ngày đầu tiên).'], fromIdx, toIdx };
    const sigs = signalDays(P, spec.rebalance, fromIdx, toIdx);
    let prevHold = new Set(), noFund = 0, thin = 0;
    const ukey = JSON.stringify([spec.universe, needFund ? spec.pitMaxStale : 0, needFund]);
    for (const t of sigs) {
      const e = t + spec.lag;
      if (e > toIdx) continue;
      // vũ trụ (có nhớ đệm theo ngày + cấu hình vũ trụ: rổ ngẫu nhiên, rổ đều và lưới độ nhạy dùng lại, không dò lại ~1.900 mã mỗi lần)
      const ck = t + '|' + ukey, hit = opt.cache ? opt.cache.get(ck) : null;
      let day = null, uni = [], cache = new Map();
      if (hit) { if (hit.noFund) { noFund++; continue; } day = hit.day; uni = hit.uni; cache = hit.info; }
      else {
      if (needFund) {
        const r = PC.dayAsOf(pit || [], P.dates[t], spec.pitMaxStale);
        if (!r) { noFund++; if (opt.cache) opt.cache.set(ck, { noFund: true }); continue; }
        day = r.day;
      }
      const u = universeAt(P, spec.universe, t, day);
      uni = u.uni; cache = u.info;
      if (opt.cache) opt.cache.set(ck, { day, uni, info: cache });
      }
      const item = { sig: t, exec: e, universe: uni, targets: [], meta: { eligible: uni.length, passed: 0, ranked: 0, picked: 0, fundAsOf: day ? day.asOf : null } };
      if (uni.length < 5) { thin++; items.push(item); continue; }
      let picks;
      if (opt.all) picks = uni.map((s) => ({ s, score: 0.5, vol: NaN }));
      else if (opt.random) {
        const arr = uni.slice(), n = Math.min(spec.select.n, arr.length);
        for (let i = 0; i < n; i++) { const j = i + Math.floor(opt.random() * (arr.length - i)); const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; }
        picks = arr.slice(0, n).map((s) => ({ s, score: 0.5, vol: NaN }));
      } else {
        // bộ lọc
        const passed = uni.filter((s) => spec.filters.every((f) => { const v = factorValue(P, f.key, s, t, cache.get(s).fm); return v === v && (f.min === null || v >= f.min) && (f.max === null || v <= f.max); }));
        item.meta.passed = passed.length;
        // xếp hạng: điểm = trung bình có trọng số của phân vị từng tiêu chí; thiếu số liệu ở bất kỳ tiêu chí nào thì loại
        const vals = spec.rank.map((r) => passed.map((s) => ({ s, v: factorValue(P, r.key, s, t, cache.get(s).fm) })).filter((x) => x.v === x.v));
        const have = new Map(); vals.forEach((arr) => arr.forEach((x) => have.set(x.s, (have.get(x.s) || 0) + 1)));
        const full = passed.filter((s) => have.get(s) === spec.rank.length);
        item.meta.ranked = full.length;
        const fullSet = new Set(full), score = new Map(full.map((s) => [s, 0]));
        let wsum = 0;
        spec.rank.forEach((r, k) => {
          const pr = pctRanks(vals[k].filter((x) => fullSet.has(x.s)));
          full.forEach((s) => { const p = pr.get(s); score.set(s, score.get(s) + r.w * (r.dir === 'low' ? 1 - p : p)); });
          wsum += r.w;
        });
        const ordered = full.map((s) => ({ s, score: score.get(s) / wsum })).sort((a, b) => (b.score - a.score) || (P.symbols[a.s] < P.symbols[b.s] ? -1 : 1));
        // giữ mã đang nắm nếu còn trong top n x (1 + keep): giảm vòng quay
        const nSel = Math.min(spec.select.n, ordered.length);
        const keepTo = Math.min(ordered.length, Math.floor(spec.select.n * (1 + spec.select.keep)));
        const chosen = [], chosenSet = new Set();
        if (spec.select.keep > 0) ordered.slice(0, keepTo).forEach((x) => { if (prevHold.has(x.s) && chosen.length < nSel) { chosen.push(x); chosenSet.add(x.s); } });
        for (const x of ordered) { if (chosen.length >= nSel) break; if (!chosenSet.has(x.s)) { chosen.push(x); chosenSet.add(x.s); } }
        chosen.sort((a, b) => b.score - a.score);
        picks = chosen.map((x) => ({ s: x.s, score: x.score, vol: spec.weighting === 'invvol' ? volOf(P, x.s, t, 60) : NaN }));
      }
      item.meta.picked = picks.length;
      if (picks.length) {
        const w = opt.all || opt.random ? picks.map(() => 1 / picks.length) : weightsFor(spec, picks);
        const wf = opt.all ? w : (opt.random ? capWeights(w, spec.maxWeight) : w);
        item.targets = picks.map((p, i) => ({ s: p.s, w: wf[i] })).filter((x) => x.w > 1e-9);
        prevHold = new Set(item.targets.map((x) => x.s));
      }
      items.push(item);
    }
    if (noFund) warnings.push(noFund + ' kỳ cân bằng bị bỏ vì chưa có bản chụp số liệu cơ bản trong ' + spec.pitMaxStale + ' ngày trước đó (kho theo thời điểm chỉ phủ một phần giai đoạn).');
    if (thin) warnings.push(thin + ' kỳ có quá ít mã đủ điều kiện (dưới 5): giữ nguyên danh mục kỳ trước.');
    return { items, warnings, fromIdx, toIdx };
  }

  // ---------- mô phỏng ----------
  // Trả { startIdx, endIdx, nav: Float64Array theo từng ngày từ startIdx, trades: [...theo kỳ], stats }.
  function simulate(P, plan, spec) {
    const items = plan.items;
    const first = items.find((it) => it.targets.length);
    if (!first) return null;
    const startIdx = first.exec, endIdx = plan.toIdx;
    const n = endIdx - startIdx + 1;
    const nav = new Float64Array(n), cashArr = new Float64Array(n), npos = new Int16Array(n);
    const qty = new Float64Array(P.S);
    const held = new Set();
    let cash = spec.capital;
    const dailyRf = Math.pow(1 + spec.rf, 1 / TD) - 1;
    const stat = { fee: 0, tax: 0, impact: 0, buy: 0, sell: 0, desired: 0, done: 0, lockedBuy: 0, lockedSell: 0, noTrade: 0, delisted: 0, partial: 0, rebalances: 0 };
    const rebals = [];
    const byExec = new Map(); items.forEach((it) => { if (it.targets.length) byExec.set(it.exec, it); });
    const costs = spec.costs;
    const markValue = (s, t) => { const L = P.lvl[s]; const v = L[t]; return v === v ? v : (P.last[s] >= 0 && t > P.last[s] ? L[P.last[s]] : NaN); };
    for (let t = startIdx; t <= endIdx; t++) {
      if (t > startIdx) cash *= 1 + dailyRf;
      // mã hết dữ liệu (hủy niêm yết): bán ở giá cuối
      held.forEach((s) => {
        if (t > P.last[s]) {
          const px = P.lvl[s][P.last[s]], val = qty[s] * px, c = val * (costs.fee + costs.tax);
          cash += val - c; stat.fee += val * costs.fee; stat.tax += val * costs.tax; stat.sell += val; qty[s] = 0; held.delete(s); stat.delisted++;
        }
      });
      const it = byExec.get(t);
      if (it) {
        // giá trị hiện tại
        let navNow = cash; const cur = new Map();
        held.forEach((s) => { const v = qty[s] * markValue(s, t); cur.set(s, v); navNow += v; });
        const tgt = new Map(it.targets.map((x) => [x.s, x.w * navNow]));
        const syms = new Set([...cur.keys(), ...tgt.keys()]);
        const sells = [], buys = [];
        syms.forEach((s) => {
          const diff = (tgt.get(s) || 0) - (cur.get(s) || 0);
          if (Math.abs(diff) < navNow * 1e-4) return;
          (diff < 0 ? sells : buys).push({ s, v: Math.abs(diff) });
        });
        const exec = (list, isBuy) => list.map((x) => {
          const s = x.s; stat.desired += x.v;
          const hasRow = P.ret[s][t] === P.ret[s][t];
          const lock = P.lim[s][t];
          if (!hasRow) { stat.noTrade++; return { s, done: 0, sigma: NaN, adv: NaN }; }
          if (isBuy && lock === 1) { stat.lockedBuy++; return { s, done: 0, sigma: NaN, adv: NaN }; }
          if (!isBuy && lock === -1) { stat.lockedSell++; return { s, done: 0, sigma: NaN, adv: NaN }; }
          const adv = advOf(P, s, t), dayVal = P.val[s][t] * 1e6;
          const room = spec.participation * Math.min(isFinite(dayVal) ? dayVal : 0, isFinite(adv) ? adv : 0);
          let done = Math.min(x.v, room);
          if (done < x.v - 1e-6) stat.partial++;
          const sigma = volOf(P, s, t, 60);
          return { s, done: Math.max(0, done), sigma: sigma === sigma ? sigma : 0.025, adv };
        });
        const sellRes = exec(sells, false);
        sellRes.forEach((r) => {
          if (!(r.done > 0)) return;
          const imp = costs.impact && r.adv > 0 ? Math.min(costs.impactCap, costs.impactK * r.sigma * Math.sqrt(r.done / r.adv)) : 0;
          const fee = r.done * costs.fee, tax = r.done * costs.tax, im = r.done * imp;
          cash += r.done - fee - tax - im; stat.fee += fee; stat.tax += tax; stat.impact += im; stat.sell += r.done; stat.done += r.done;
          qty[r.s] -= r.done / P.lvl[r.s][t];
          if (qty[r.s] * P.lvl[r.s][t] < navNow * 1e-5) { qty[r.s] = 0; held.delete(r.s); }
        });
        const buyRes = exec(buys, true);
        let outlay = 0;
        buyRes.forEach((r) => { if (r.done > 0) { r.imp = costs.impact && r.adv > 0 ? Math.min(costs.impactCap, costs.impactK * r.sigma * Math.sqrt(r.done / r.adv)) : 0; outlay += r.done * (1 + costs.fee + r.imp); } });
        const scale = outlay > cash ? Math.max(0, cash) / outlay : 1;
        buyRes.forEach((r) => {
          if (!(r.done > 0)) return;
          const v = r.done * scale; if (!(v > 0)) return;
          const fee = v * costs.fee, im = v * r.imp;
          cash -= v + fee + im; stat.fee += fee; stat.impact += im; stat.buy += v; stat.done += v;
          qty[r.s] += v / P.lvl[r.s][t]; held.add(r.s);
        });
        stat.rebalances++;
        const after = []; let navAfter = cash;
        held.forEach((s) => { const v = qty[s] * markValue(s, t); navAfter += v; after.push({ s, v }); });
        rebals.push({ idx: t, sig: it.sig, nav: navAfter, holdings: after.map((x) => ({ s: x.s, w: x.v / navAfter })).sort((a, b) => b.w - a.w), cashW: cash / navAfter, meta: it.meta });
      }
      let v = cash, c = 0;
      held.forEach((s) => { const m = markValue(s, t); if (m === m) { v += qty[s] * m; c++; } });
      nav[t - startIdx] = v; cashArr[t - startIdx] = cash / v; npos[t - startIdx] = c;
    }
    return { startIdx, endIdx, nav, cashW: cashArr, npos, stat, rebalances: rebals, lastHeld: [...held].map((s) => P.symbols[s]) };
  }

  // ---------- thống kê ----------
  const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; };
  function stdev(a) { const n = a.length; if (n < 2) return NaN; const m = mean(a); let s = 0; for (let i = 0; i < n; i++) s += (a[i] - m) * (a[i] - m); return Math.sqrt(s / (n - 1)); }
  function moments(a) {                                   // độ lệch và độ nhọn (không trừ 3) của mẫu
    const n = a.length, m = mean(a); let m2 = 0, m3 = 0, m4 = 0;
    for (let i = 0; i < n; i++) { const d = a[i] - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
    m2 /= n; m3 /= n; m4 /= n;
    return { skew: m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0, kurt: m2 > 0 ? m4 / (m2 * m2) : 3 };
  }
  function dailyReturns(series) { const out = new Float64Array(series.length - 1); for (let i = 1; i < series.length; i++) out[i - 1] = series[i] / series[i - 1] - 1; return out; }
  function drawdownOf(series) {
    let peak = series[0], peakI = 0, maxDD = 0, ddFrom = 0, ddTo = 0, longest = 0, curStart = 0;
    for (let i = 1; i < series.length; i++) {
      if (series[i] >= peak) { if (i - curStart > longest) longest = i - curStart; peak = series[i]; peakI = i; curStart = i; }
      const dd = series[i] / peak - 1;
      if (dd < maxDD) { maxDD = dd; ddFrom = peakI; ddTo = i; }
    }
    if (series.length - 1 - curStart > longest) longest = series.length - 1 - curStart;
    return { maxDD, from: ddFrom, to: ddTo, longest, current: series[series.length - 1] / peak - 1 };
  }
  // Hồi quy hai biến y = a + b x (OLS có hệ số chặn); phương sai Newey-West (độ trễ lag) cho t của a và b. V = (X'X)^-1 S (X'X)^-1, S = G0 + sum w_l (G_l + G_l').
  function olsNW(y, x, lag) {
    const n = y.length, mx = mean(x), my = mean(y);
    let sxx = 0, sxy = 0, sst = 0;
    for (let i = 0; i < n; i++) { sxx += (x[i] - mx) * (x[i] - mx); sxy += (x[i] - mx) * (y[i] - my); sst += (y[i] - my) * (y[i] - my); }
    if (!(sxx > 0) || n < 3) return { alpha: NaN, beta: NaN, tAlpha: NaN, tBeta: NaN, r2: NaN };
    const b = sxy / sxx, a = my - b * mx;
    const u0 = new Float64Array(n), u1 = new Float64Array(n); let sse = 0;
    for (let i = 0; i < n; i++) { const e = y[i] - a - b * x[i]; sse += e * e; u0[i] = e; u1[i] = e * x[i]; }
    const G = (p, q, l) => { let sum = 0; for (let t = l; t < n; t++) sum += p[t] * q[t - l]; return sum; };
    const S = [[G(u0, u0, 0), G(u0, u1, 0)], [G(u1, u0, 0), G(u1, u1, 0)]];
    for (let l = 1; l <= lag && l < n; l++) {
      const w = 1 - l / (lag + 1);
      S[0][0] += w * 2 * G(u0, u0, l); S[1][1] += w * 2 * G(u1, u1, l);
      const c01 = G(u0, u1, l), c10 = G(u1, u0, l);
      S[0][1] += w * (c01 + c10); S[1][0] += w * (c01 + c10);
    }
    const inv = [[(1 / n + mx * mx / sxx), -mx / sxx], [-mx / sxx, 1 / sxx]];                // (X'X)^-1
    const V = [[0, 0], [0, 0]];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { let sum = 0; for (let k = 0; k < 2; k++) for (let l = 0; l < 2; l++) sum += inv[i][k] * S[k][l] * inv[l][j]; V[i][j] = sum; }
    return { alpha: a, beta: b, tAlpha: a / Math.sqrt(Math.max(V[0][0], 1e-300)), tBeta: b / Math.sqrt(Math.max(V[1][1], 1e-300)), r2: sst > 0 ? 1 - sse / sst : NaN };
  }
  function monthlyReturns(dates, series) {                // [{ month, ret }] từ chuỗi giá trị theo ngày
    const out = []; let curM = dates[0].slice(0, 7), startV = series[0];
    for (let i = 1; i < series.length; i++) {
      const m = dates[i].slice(0, 7);
      if (m !== curM) { out.push({ month: curM, ret: series[i - 1] / startV - 1 }); curM = m; startV = series[i - 1]; }
    }
    out.push({ month: curM, ret: series[series.length - 1] / startV - 1 });
    return out;
  }
  function yearlyReturns(dates, series) {
    const out = []; let cur = dates[0].slice(0, 4), startV = series[0], startI = 0;
    for (let i = 1; i < series.length; i++) {
      const y = dates[i].slice(0, 4);
      if (y !== cur) { out.push({ year: Number(cur), ret: series[i - 1] / startV - 1, days: i - startI, partial: startI === 0 }); cur = y; startV = series[i - 1]; startI = i; }
    }
    out.push({ year: Number(cur), ret: series[series.length - 1] / startV - 1, days: series.length - startI, partial: true });
    return out;
  }

  // Chỉ số của một chuỗi giá trị theo ngày (series: số, dates: ngày tương ứng, rf: lãi suất phi rủi ro năm)
  function metricsOf(dates, series, rf) {
    const n = series.length;
    if (n < 3) return null;
    const r = dailyReturns(series), years = (n - 1) / TD;
    const total = series[n - 1] / series[0] - 1, cagr = Math.pow(series[n - 1] / series[0], 1 / years) - 1;
    const sd = stdev(r), rfd = Math.pow(1 + rf, 1 / TD) - 1, ex = Array.from(r, (x) => x - rfd);
    const dd = drawdownOf(series), down = Math.sqrt(mean(ex.map((x) => (x < 0 ? x * x : 0))));
    const mo = monthlyReturns(dates, series), mom = moments(r);
    return {
      days: n, years: years, total, cagr, annVol: sd * Math.sqrt(TD), sharpe: sd > 0 ? mean(ex) / sd * Math.sqrt(TD) : NaN, sortino: down > 0 ? mean(ex) / down * Math.sqrt(TD) : NaN,
      maxDD: dd.maxDD, ddFrom: dates[dd.from], ddTo: dates[dd.to], ddLongest: dd.longest, currentDD: dd.current, calmar: dd.maxDD < 0 ? cagr / -dd.maxDD : NaN,
      bestMonth: mo.length ? Math.max.apply(null, mo.map((x) => x.ret)) : NaN, worstMonth: mo.length ? Math.min.apply(null, mo.map((x) => x.ret)) : NaN, positiveMonths: mo.length ? mo.filter((x) => x.ret > 0).length / mo.length : NaN,
      skew: mom.skew, kurt: mom.kurt, nMonths: mo.length,
    };
  }
  function relativeTo(dates, series, bench, rf) {
    const r = dailyReturns(series), b = dailyReturns(bench), n = Math.min(r.length, b.length);
    if (n < 30) return null;
    const rfd = Math.pow(1 + rf, 1 / TD) - 1;
    const ex = new Float64Array(n), bx = new Float64Array(n), act = new Float64Array(n);
    for (let i = 0; i < n; i++) { ex[i] = r[i] - rfd; bx[i] = b[i] - rfd; act[i] = r[i] - b[i]; }
    const reg = olsNW(ex, bx, 5), te = stdev(act) * Math.sqrt(TD);
    const years = n / TD, cagrS = Math.pow(series[n] / series[0], 1 / years) - 1, cagrB = Math.pow(bench[n] / bench[0], 1 / years) - 1;
    const ms = monthlyReturns(dates, series), mb = monthlyReturns(dates, bench), mm = Math.min(ms.length, mb.length);
    let up = 0, upB = 0, dn = 0, dnB = 0, beat = 0;
    for (let i = 0; i < mm; i++) { if (ms[i].ret > mb[i].ret) beat++; if (mb[i].ret > 0) { up += ms[i].ret; upB += mb[i].ret; } else if (mb[i].ret < 0) { dn += ms[i].ret; dnB += mb[i].ret; } }
    return { beta: reg.beta, alpha: reg.alpha * TD, tAlpha: reg.tAlpha, r2: reg.r2, excessCagr: cagrS - cagrB, trackingError: te, infoRatio: te > 0 ? mean(act) * TD / te : NaN, hitMonths: mm ? beat / mm : NaN, upCapture: upB > 0 ? up / upB : NaN, downCapture: dnB < 0 ? dn / dnB : NaN, corr: Math.sqrt(Math.max(0, reg.r2)) * (reg.beta < 0 ? -1 : 1) };
  }

  // ---------- RNG và bootstrap ----------
  function mulberry32(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  // Bootstrap dừng theo khối: lấy mẫu lại cặp (lợi suất chiến lược, lợi suất chuẩn) theo khối độ dài TB `block`. Trả khoảng 90% cho CAGR, Sharpe, lợi suất vượt.
  function bootstrapCI(r, b, rf, opts) {
    const o = Object.assign({ B: 300, block: 21, seed: 20261011 }, opts || {});
    const n = Math.min(r.length, b.length), rnd = mulberry32(o.seed), p = 1 / o.block, rfd = Math.pow(1 + rf, 1 / TD) - 1;
    const cagr = [], sharpe = [], excess = [];
    for (let k = 0; k < o.B; k++) {
      let prodS = 1, prodB = 1, sum = 0, sq = 0, i = Math.floor(rnd() * n);
      for (let j = 0; j < n; j++) {
        if (j > 0) i = rnd() < p ? Math.floor(rnd() * n) : (i + 1) % n;
        const x = r[i]; prodS *= 1 + x; prodB *= 1 + b[i]; const e = x - rfd; sum += e; sq += e * e;
      }
      const years = n / TD, m = sum / n, sd = Math.sqrt(Math.max(0, (sq - n * m * m) / (n - 1)));
      cagr.push(Math.pow(prodS, 1 / years) - 1); excess.push(Math.pow(prodS, 1 / years) - Math.pow(prodB, 1 / years)); sharpe.push(sd > 0 ? m / sd * Math.sqrt(TD) : NaN);
    }
    const q = (a, p2) => { const s = a.filter((x) => x === x).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(p2 * s.length)))] : NaN; };
    return { B: o.B, block: o.block, cagr: [q(cagr, 0.05), q(cagr, 0.95)], sharpe: [q(sharpe, 0.05), q(sharpe, 0.95)], excess: [q(excess, 0.05), q(excess, 0.95)], probExcessPositive: excess.filter((x) => x > 0).length / excess.length };
  }

  // ---------- Sharpe đã trừ may rủi (Bailey & López de Prado 2014) ----------
  // erfc chính xác ~1e-14: chuỗi Taylor cho |z| < 2, phân số liên tục cho |z| >= 2
  function erfc(z) {
    const az = Math.abs(z); let v;
    if (az < 2) { let term = az, sum = az; for (let n = 1; n < 120; n++) { term *= -az * az / n; sum += term / (2 * n + 1); } v = 1 - 2 / Math.sqrt(Math.PI) * sum; }
    else { let cf = az; for (let k = 80; k >= 1; k--) cf = az + (k / 2) / cf; v = Math.exp(-az * az) / Math.sqrt(Math.PI) / cf; }
    return z >= 0 ? v : 2 - v;
  }
  const normCdf = (x) => 0.5 * erfc(-x / Math.SQRT2);
  function normInv(p) {                                   // Acklam
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00], b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00], d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const lo = 0.02425, hi = 1 - lo; let q, r;
    if (p < lo) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > hi) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  // Xác suất Sharpe THẬT vượt ngưỡng sr0 (cùng đơn vị với sr: theo kỳ, KHÔNG năm hoá) khi đã quan sát nObs kỳ, độ lệch skew, độ nhọn kurt (không trừ 3)
  function psr(sr, sr0, nObs, skew, kurt) {
    const den = Math.sqrt(Math.max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr * sr));
    return normCdf((sr - sr0) * Math.sqrt(Math.max(1, nObs - 1)) / den);
  }
  // Sharpe kỳ vọng cao nhất trong K lần thử độc lập khi Sharpe thật = 0 và phương sai Sharpe giữa các lần thử là srVar (theo kỳ)
  function expectedMaxSharpe(trials, srVar) {
    if (!(trials > 1) || !(srVar > 0)) return 0;
    const g = 0.5772156649015329;
    return Math.sqrt(srVar) * ((1 - g) * normInv(1 - 1 / trials) + g * normInv(1 - 1 / (trials * Math.E)));
  }
  // dailySharpe: Sharpe THEO NGÀY của chiến lược đang xét; trials: số lần đã thử (>= 1); srVarDaily: phương sai Sharpe theo ngày giữa các lần thử. Trả { psr0, dsr, sr0 }
  function deflatedSharpe(dailySharpe, nObs, skew, kurt, trials, srVarDaily) {
    const sr0 = expectedMaxSharpe(trials, srVarDaily);
    return { psr0: psr(dailySharpe, 0, nObs, skew, kurt), dsr: psr(dailySharpe, sr0, nObs, skew, kurt), sr0AnnualEq: sr0 * Math.sqrt(TD), trials };
  }

  // ---------- chạy trọn bộ ----------
  const tick = () => new Promise((res) => setTimeout(res, 0));
  function toSeries(P, sim) {                              // chuỗi giá trị chuẩn hoá 1 và ngày
    const dates = [], v = [];
    for (let i = 0; i < sim.nav.length; i++) { dates.push(P.dates[sim.startIdx + i]); v.push(sim.nav[i] / sim.nav[0]); }
    return { dates, v };
  }
  function benchSeries(P, code, sim) {
    const ix = P.index[code]; if (!ix) return null;
    const out = []; const base = ix[sim.startIdx];
    if (!(base > 0)) return null;
    for (let i = 0; i < sim.nav.length; i++) out.push(ix[sim.startIdx + i] / base);
    return out;
  }
  const round = (v, k) => (isNum(v) ? Math.round(v * k) / k : null);
  const roundObj = (o, k) => { const out = {}; Object.keys(o || {}).forEach((key) => { const v = o[key]; out[key] = typeof v === 'number' ? round(v, k) : v; }); return out; };
  const fastCagr = (nav) => Math.pow(nav[nav.length - 1] / nav[0], TD / (nav.length - 1)) - 1;
  const fastSharpe = (nav, rf) => { const r = dailyReturns(nav), rfd = Math.pow(1 + rf, 1 / TD) - 1, sd = stdev(r); return sd > 0 ? (mean(r) - rfd) / sd * Math.sqrt(TD) : NaN; };

  // Trả Promise { ok, ... }. opts: { onProgress(stage, frac), pit (đã decode), randomRuns (mặc định 150), sensitivity (true), trials: { count, srVarDaily } , seed }
  async function run(P, rawSpec, opts) {
    const o = Object.assign({ pit: [], randomRuns: 150, sensitivity: true, seed: 20261011, trials: null, onProgress: null, yieldEvery: true }, opts || {});
    const prog = (st, f) => { if (o.onProgress) o.onProgress(st, f); };
    const norm = normalizeSpec(rawSpec);
    if (norm.errors.length) return { ok: false, errors: norm.errors };
    const spec = norm.spec, warnings = norm.warnings.slice();
    if (!P || !P.T || P.T < 300) return { ok: false, errors: ['Kho giá chưa đủ ngày (cần ít nhất 300 phiên).'] };
    if (usesFund(spec) && !(o.pit && o.pit.length)) return { ok: false, errors: ['Chiến lược dùng số liệu cơ bản nhưng chưa có bản chụp theo thời điểm nào được tải.'] };
    prog('plan', 0);
    const cache = new Map();
    const plan = buildPlan(P, o.pit, spec, { cache });
    plan.warnings.forEach((w) => warnings.push(w));
    if (!plan.items.some((it) => it.targets.length)) return { ok: false, errors: ['Không chọn được mã nào ở kỳ nào: nới lỏng bộ lọc hoặc ngưỡng thanh khoản.'].concat(plan.warnings) };
    const sim = simulate(P, plan, spec);
    if (!sim || sim.nav.length < 30) return { ok: false, errors: ['Giai đoạn mô phỏng quá ngắn (dưới 30 phiên).'] };
    const ser = toSeries(P, sim), bench = benchSeries(P, 'VNINDEX', sim);
    if (!bench) return { ok: false, errors: ['Kho thiếu chuỗi VN-Index.'] };
    if (o.yieldEvery) await tick();
    // rổ đều toàn vũ trụ (cùng lịch, chi phí)
    prog('universe', 0.2);
    const uPlan = buildPlan(P, o.pit, spec, { all: true, cache }), uSim = simulate(P, uPlan, spec);
    let uni = null;
    if (uSim) {
      // căn cùng điểm bắt đầu với chiến lược
      const off = sim.startIdx - uSim.startIdx;
      if (off >= 0 && uSim.nav.length - off >= sim.nav.length) { const arr = []; const base = uSim.nav[off]; for (let i = 0; i < sim.nav.length; i++) arr.push(uSim.nav[off + i] / base); uni = arr; }
    }
    const m = metricsOf(ser.dates, ser.v, spec.rf), mBench = metricsOf(ser.dates, bench, spec.rf), mUni = uni ? metricsOf(ser.dates, uni, spec.rf) : null;
    const rel = relativeTo(ser.dates, ser.v, bench, spec.rf), relUni = uni ? relativeTo(ser.dates, ser.v, uni, spec.rf) : null;
    // chia đôi giai đoạn
    const mid = Math.floor(ser.v.length / 2), firstHalf = ser.v.slice(0, mid + 1), secondHalf = ser.v.slice(mid);
    const split = { at: ser.dates[mid], early: metricsOf(ser.dates.slice(0, mid + 1), firstHalf, spec.rf), late: metricsOf(ser.dates.slice(mid), secondHalf, spec.rf),
      earlyBench: metricsOf(ser.dates.slice(0, mid + 1), bench.slice(0, mid + 1), spec.rf), lateBench: metricsOf(ser.dates.slice(mid), bench.slice(mid), spec.rf) };
    const yS = yearlyReturns(ser.dates, ser.v), yB = yearlyReturns(ser.dates, bench), yU = uni ? yearlyReturns(ser.dates, uni) : null;
    const yearly = yS.map((x, i) => ({ year: x.year, partial: x.days < 200, strat: x.ret, bench: yB[i] ? yB[i].ret : null, univ: yU && yU[i] ? yU[i].ret : null }));
    // bootstrap
    prog('bootstrap', 0.35); if (o.yieldEvery) await tick();
    const boot = bootstrapCI(dailyReturns(ser.v), dailyReturns(bench), spec.rf, { seed: o.seed });
    // rổ ngẫu nhiên
    let random = null;
    if (o.randomRuns > 0) {
      const cg = [], sh = [], rnd = mulberry32(o.seed + 7);
      for (let k = 0; k < o.randomRuns; k++) {
        const rp = buildPlan(P, o.pit, spec, { random: rnd, cache });
        const rs = simulate(P, rp, spec);
        if (rs && rs.startIdx <= sim.startIdx && rs.nav.length - (sim.startIdx - rs.startIdx) >= sim.nav.length) {
          const off = sim.startIdx - rs.startIdx, arr = []; const base = rs.nav[off];
          for (let i = 0; i < sim.nav.length; i++) arr.push(rs.nav[off + i] / base);
          cg.push(fastCagr(arr)); sh.push(fastSharpe(arr, spec.rf));
        }
        if (k % 15 === 14) { prog('random', 0.35 + 0.4 * (k + 1) / o.randomRuns); if (o.yieldEvery) await tick(); }
      }
      if (cg.length >= 20) {
        const sortedC = cg.slice().sort((a, b) => a - b), sortedS = sh.filter((x) => x === x).sort((a, b) => a - b);
        const q = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))];
        const geC = cg.filter((x) => x >= m.cagr).length, geS = sh.filter((x) => x >= m.sharpe).length;
        random = { runs: cg.length, cagr: { median: q(sortedC, 0.5), p05: q(sortedC, 0.05), p95: q(sortedC, 0.95), rank: 1 - geC / cg.length, p: (geC + 1) / (cg.length + 1) },
          sharpe: { median: q(sortedS, 0.5), p05: q(sortedS, 0.05), p95: q(sortedS, 0.95), rank: 1 - geS / sh.length, p: (geS + 1) / (sh.length + 1) }, hist: histogram(cg, 18, m.cagr) };
      } else warnings.push('Không dựng đủ rổ ngẫu nhiên để so sánh (dưới 20 lần chạy hợp lệ).');
    }
    // độ nhạy
    let sens = null;
    if (o.sensitivity) { prog('sensitivity', 0.78); if (o.yieldEvery) await tick(); sens = sensitivityGrid(P, o.pit, spec, sim, ser, cache); }
    // Sharpe đã trừ may rủi
    const rd = dailyReturns(ser.v), rfd = Math.pow(1 + spec.rf, 1 / TD) - 1, exd = Array.from(rd, (x) => x - rfd), srD = mean(exd) / stdev(exd);
    const trialsN = (o.trials && o.trials.count > 0 ? Math.round(o.trials.count) : 0) + 1;
    const dsr = deflatedSharpe(srD, rd.length, m.skew, m.kurt, trialsN, (o.trials && o.trials.srVarDaily > 0) ? o.trials.srVarDaily : (1 / rd.length));
    // đối soát tổng quát
    const st = sim.stat, avgNav = mean(Array.from(sim.nav)) , years = m.years;
    const trade = {
      turnover: (st.buy + st.sell) / 2 / avgNav / years, costDrag: (st.fee + st.tax + st.impact) / avgNav / years, fee: st.fee, tax: st.tax, impact: st.impact,
      fillRatio: st.desired > 0 ? st.done / st.desired : 1, lockedBuy: st.lockedBuy, lockedSell: st.lockedSell, noTrade: st.noTrade, partial: st.partial, delisted: st.delisted, rebalances: st.rebalances,
      avgPositions: mean(Array.from(sim.npos)), avgCash: mean(Array.from(sim.cashW)),
    };
    if (trade.fillRatio < 0.9) warnings.push('Chỉ khớp được ' + Math.round(trade.fillRatio * 100) + '% khối lượng muốn giao dịch (giới hạn ' + Math.round(spec.participation * 100) + '% giá trị giao dịch mỗi phiên, kẹt trần/sàn): quy mô vốn này khó đạt kết quả như mô phỏng.');
    if (P.missingDays.length > 5) warnings.push('Kho thiếu ' + P.missingDays.length + ' phiên giao dịch (VN-Index có, kho chưa có): lợi suất các phiên đó bị bỏ.');
    const rebs = sim.rebalances.map((r) => ({ date: P.dates[r.idx], n: r.holdings.length, eligible: r.meta.eligible, passed: r.meta.passed, ranked: r.meta.ranked, cash: r.cashW, top: r.holdings.slice(0, 12).map((h) => ({ sym: P.symbols[h.s], w: h.w })) }));
    // đường giá trị rút gọn cho biểu đồ (mỗi 3 phiên + phiên cuối)
    const idxs = []; for (let i = 0; i < ser.v.length; i += 3) idxs.push(i); if (idxs[idxs.length - 1] !== ser.v.length - 1) idxs.push(ser.v.length - 1);
    const curve = { dates: idxs.map((i) => ser.dates[i]), strat: idxs.map((i) => round(ser.v[i], 1e4)), bench: idxs.map((i) => round(bench[i], 1e4)), univ: uni ? idxs.map((i) => round(uni[i], 1e4)) : null };
    prog('done', 1);
    return {
      ok: true, version: VERSION, spec, warnings, dataThrough: P.dates[P.T - 1], dataFrom: P.dates[0], period: { from: ser.dates[0], to: ser.dates[ser.dates.length - 1], days: ser.v.length },
      metrics: roundObj(m, 1e5), bench: roundObj(mBench, 1e5), univ: mUni ? roundObj(mUni, 1e5) : null, rel: rel ? roundObj(rel, 1e5) : null, relUniv: relUni ? roundObj(relUni, 1e5) : null,
      split: { at: split.at, early: roundObj(split.early || {}, 1e5), late: roundObj(split.late || {}, 1e5), earlyBench: roundObj(split.earlyBench || {}, 1e5), lateBench: roundObj(split.lateBench || {}, 1e5) },
      yearly: yearly.map((y) => ({ year: y.year, partial: y.partial, strat: round(y.strat, 1e5), bench: round(y.bench, 1e5), univ: round(y.univ, 1e5) })),
      bootstrap: boot, random, dsr: roundObj(dsr, 1e5), sensitivity: sens, trade: roundObj(trade, 1e5), curve, rebalances: rebs, lastHeld: sim.lastHeld,
      plan: { items: plan.items.length, exec: plan.items.filter((it) => it.targets.length).length },
    };
  }

  function histogram(vals, bins, mark) {
    const mn = Math.min.apply(null, vals.concat([mark])), mx = Math.max.apply(null, vals.concat([mark])), w = (mx - mn) / bins || 1, h = new Array(bins).fill(0);
    vals.forEach((v) => { h[Math.min(bins - 1, Math.floor((v - mn) / w))]++; });
    return { min: mn, max: mx, counts: h, mark: mark, markBin: Math.min(bins - 1, Math.floor((mark - mn) / w)) };
  }

  // Lưới độ nhạy: đổi từng tham số quanh cấu hình gốc, chạy lại và so CAGR / Sharpe / sụt giảm tối đa (cùng điểm bắt đầu, không dò lại ngẫu nhiên)
  function sensitivityGrid(P, pit, spec, baseSim, baseSer, cache) {
    const variants = [];
    [10, 20, 30, 50].filter((n) => n !== spec.select.n).forEach((n) => variants.push({ id: 'n' + n, label: 'Số mã = ' + n, mut: (s) => { s.select.n = n; } }));
    FREQS.filter((f) => f !== spec.rebalance && f !== 'W' && f !== 'Y').forEach((f) => variants.push({ id: 'f' + f, label: 'Cân bằng ' + ({ M: 'hằng tháng', Q: 'hằng quý' }[f]), mut: (s) => { s.rebalance = f; } }));
    if (spec.rebalance !== 'M' && spec.rebalance !== 'Q') variants.push({ id: 'fM', label: 'Cân bằng hằng tháng', mut: (s) => { s.rebalance = 'M'; } });
    [spec.lag + 1, spec.lag + 2].forEach((l) => variants.push({ id: 'lag' + l, label: 'Trễ ' + l + ' phiên', mut: (s) => { s.lag = l; } }));
    variants.push({ id: 'cost2', label: 'Chi phí gấp đôi', mut: (s) => { s.costs.fee *= 2; s.costs.tax *= 2; s.costs.impactK *= 2; } });
    variants.push({ id: 'part', label: 'Giới hạn khớp ' + Math.round(spec.participation * 50) + '% giá trị giao dịch', mut: (s) => { s.participation = spec.participation / 2; } });
    const out = [];
    const mk = (id, label, nav, startIdx) => {
      if (!nav || nav.length < 30) return;
      const base = nav; const off = baseSim.startIdx - startIdx;
      const arr = off >= 0 ? Array.from(nav.slice(off)).map((x) => x / nav[off]) : Array.from(nav).map((x) => x / nav[0]);
      out.push({ id, label, cagr: round(fastCagr(arr), 1e5), sharpe: round(fastSharpe(arr, spec.rf), 1e4), maxDD: round(drawdownOf(arr).maxDD, 1e5), days: arr.length }); void base;
    };
    mk('base', 'Cấu hình gốc', baseSim.nav, baseSim.startIdx);
    variants.forEach((v) => {
      const s2 = JSON.parse(JSON.stringify(spec)); v.mut(s2);
      const n2 = normalizeSpec(s2); if (n2.errors.length) return;
      const pl = buildPlan(P, pit, n2.spec, { cache }), sm = simulate(P, pl, n2.spec);
      if (sm) mk(v.id, v.label, sm.nav, sm.startIdx);
    });
    void baseSer;
    return out;
  }

  return {
    VERSION, TD, FACTORS, BY_KEY, DEFAULT_SPEC, PRESETS, normalizeSpec, universeAt, usesFund, lookback, priceFactor, fundFactor, factorValue, advOf, volOf, signalDays, periodKey, pctRanks, capWeights, weightsFor, buildPlan, simulate,
    metricsOf, relativeTo, drawdownOf, olsNW, monthlyReturns, yearlyReturns, bootstrapCI, mulberry32, normCdf, normInv, psr, expectedMaxSharpe, deflatedSharpe, run, sensitivityGrid,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StrategyBacktest;
globalThis.StrategyBacktest = StrategyBacktest;
