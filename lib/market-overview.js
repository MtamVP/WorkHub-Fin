// Logic thuần: TỔNG QUAN THỊ TRƯỜNG cho trang "Thị Trường" -- chỉ số, độ rộng, thanh khoản, khối ngoại, cổ phiếu nổi bật, ngành trong ngày, định giá thị trường.
// Nguồn (miễn phí, công khai, gọi thẳng từ ứng dụng vì CORS mở): VNDirect dchart (nến ngày và nến 1 phút của chỉ số), VNDirect finfo `stock_prices` (cả thị trường một lượt: giá, tham chiếu, trần/sàn, giá trị khớp lệnh và thỏa thuận)
// và `foreigns` (khối ngoại theo mã). Bảng giá finfo tính bằng NGHÌN đồng và trễ 15 giây đến 2 phút; ở đây đổi sang đồng. Các nguồn không có cam kết dịch vụ nên mọi hàm đều chịu được dữ liệu thiếu/lỗi (trả rỗng, không ném).
// Quy ước đếm giống các bảng giá phổ biến: chỉ cổ phiếu (type STOCK) khi đếm tăng/giảm/đứng; "tăng" = giá hiện tại > tham chiếu (mã chưa khớp lệnh giữ giá tham chiếu nên tính là đứng giá); trần/sàn = đạt giá trần/sàn VÀ khác tham chiếu.
// Giá trị giao dịch = khớp lệnh + thỏa thuận; khối lượng của chỉ số (nến dchart) chỉ gồm khớp lệnh nên khi so với tổng hợp theo mã phải dùng nmVolume.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global MarketOverview) và module.exports cho Vitest.
const MarketOverview = (function () {
  const INDICES = [
    { code: 'VNINDEX', label: 'VN-Index', exchange: 'HOSE', hint: 'Toàn bộ cổ phiếu sàn HOSE' },
    { code: 'VN30', label: 'VN30', exchange: 'HOSE', hint: '30 cổ phiếu vốn hoá lớn, thanh khoản cao nhất HOSE' },
    { code: 'HNX', label: 'HNX-Index', exchange: 'HNX', hint: 'Toàn bộ cổ phiếu sàn HNX' },
    { code: 'HNX30', label: 'HNX30', exchange: 'HNX', hint: '30 cổ phiếu hàng đầu sàn HNX' },
    { code: 'UPCOM', label: 'UPCoM-Index', exchange: 'UPCOM', hint: 'Toàn bộ cổ phiếu sàn UPCoM' },
  ];
  const EXCHANGES = ['ALL', 'HOSE', 'HNX', 'UPCOM'];
  const EXCHANGE_LABEL = { ALL: 'Tất cả', HOSE: 'HOSE', HNX: 'HNX', UPCOM: 'UPCoM' };
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const pos = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };
  const validSym = (s) => /^[A-Z0-9]{1,12}$/.test(s);
  const vnDate = (sec) => new Date(sec * 1000 + 7 * 3600000).toISOString().slice(0, 10);
  const vnMinute = (sec) => { const d = new Date(sec * 1000 + 7 * 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const normEx = (f) => { const e = String(f || '').toUpperCase(); return e === 'HSX' ? 'HOSE' : (e === 'HOSE' || e === 'HNX' || e === 'UPCOM' ? e : null); };
  const inEx = (r, ex) => !ex || ex === 'ALL' || r.exchange === ex;

  // ---------- chỉ số ----------
  // dchart: { t: [unix], o, h, l, c, v, s: 'ok' } -> [{ date, o, h, l, c, v }] tăng theo ngày (bỏ nến giá <= 0 hoặc lệch độ dài)
  function parseDaily(json) {
    if (!json || json.s !== 'ok' || !Array.isArray(json.t) || !Array.isArray(json.c)) return [];
    const out = [];
    for (let i = 0; i < json.t.length; i++) {
      const c = pos(json.c[i]), t = num(json.t[i]);
      if (c === null || t === null) continue;
      const o = pos(json.o && json.o[i]) || c, h = Math.max(pos(json.h && json.h[i]) || c, c, o), l = Math.min(pos(json.l && json.l[i]) || c, c, o);
      out.push({ date: vnDate(t), o: o, h: h, l: l, c: c, v: num(json.v && json.v[i]) || 0 });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
    return out.filter((r, i) => i === 0 || r.date !== out[i - 1].date);
  }
  // Nến 1 phút -> [{ t, date, min, c, v }] tăng theo thời gian
  function parseIntraday(json) {
    if (!json || json.s !== 'ok' || !Array.isArray(json.t) || !Array.isArray(json.c)) return [];
    const out = [];
    for (let i = 0; i < json.t.length; i++) {
      const c = pos(json.c[i]), t = num(json.t[i]);
      if (c === null || t === null) continue;
      out.push({ t: t, date: vnDate(t), min: vnMinute(t), c: c, h: pos(json.h && json.h[i]) || c, l: pos(json.l && json.l[i]) || c, o: pos(json.o && json.o[i]) || c, v: num(json.v && json.v[i]) || 0 });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  // Các nến của phiên gần nhất có trong dữ liệu (hoặc của `date` nếu truyền)
  function lastSession(points, date) {
    if (!points || !points.length) return { date: null, points: [] };
    const d = date || points[points.length - 1].date;
    return { date: d, points: points.filter((p) => p.date === d) };
  }
  // Ghép phiên đang diễn ra vào chuỗi ngày: nếu nến phút có ngày MỚI hơn nến ngày cuối thì thêm một dòng ngày dựng từ nến phút;
  // nếu `live` (đang trong phiên) và cùng ngày thì cập nhật dòng cuối bằng nến phút (nến ngày của nguồn có thể trễ). Ngoài phiên, nến ngày của nguồn được tin.
  function mergeToday(daily, intraday, live) {
    const d = (daily || []).slice(), s = lastSession(intraday);
    if (!s.points.length) return d;
    const last = d.length ? d[d.length - 1] : null;
    if (last && s.date < last.date) return d;
    if (last && s.date === last.date && !live) return d;
    const first = s.points[0], lastP = s.points[s.points.length - 1];
    const row = { date: s.date, o: first.o, h: Math.max.apply(null, s.points.map((p) => p.h)), l: Math.min.apply(null, s.points.map((p) => p.l)), c: lastP.c, v: s.points.reduce((t, p) => t + p.v, 0) };
    if (last && s.date === last.date) { row.o = last.o; row.h = Math.max(row.h, last.h); row.l = Math.min(row.l, last.l); row.v = Math.max(row.v, last.v); d[d.length - 1] = row; }
    else d.push(row);
    return d;
  }
  // Báo giá của một chỉ số từ chuỗi ngày: giá cuối, đóng cửa hôm trước, thay đổi, mở/cao/thấp, khối lượng và so với trung bình 20 phiên TRƯỚC đó
  function quote(daily) {
    if (!daily || !daily.length) return null;
    const last = daily[daily.length - 1], prev = daily.length > 1 ? daily[daily.length - 2] : null;
    const before = daily.slice(Math.max(0, daily.length - 21), daily.length - 1).filter((r) => r.v > 0);
    const avg = before.length >= 5 ? before.reduce((t, r) => t + r.v, 0) / before.length : null;
    return { date: last.date, last: last.c, prev: prev ? prev.c : null, change: prev ? last.c - prev.c : null, pct: prev ? (last.c / prev.c - 1) * 100 : null,
      open: last.o, high: last.h, low: last.l, volume: last.v, avgVolume20: avg, volVsAvgPct: avg && last.v > 0 ? (last.v / avg - 1) * 100 : null };
  }
  // Đoạn lấy theo cửa sổ: 'ID' = trong ngày là chuỗi phút; còn lại số phiên gần nhất
  const RANGES = [{ key: '1D', label: 'Trong ngày', sessions: 1 }, { key: '1M', label: '1 tháng', sessions: 22 }, { key: '3M', label: '3 tháng', sessions: 64 }, { key: '6M', label: '6 tháng', sessions: 127 }, { key: '1Y', label: '1 năm', sessions: 252 }];
  function windowOf(daily, sessions) { return (daily || []).slice(-Math.max(2, isFinite(sessions) ? Math.floor(sessions) : 22)); }

  // ---------- bảng giá toàn thị trường ----------
  // finfo stock_prices -> [{ symbol, exchange, type, ref, price, ceil, floor, open, high, low, nmVolume, nmValue, ptVolume, ptValue, volume, value, change, pct, date, time, traded }] (giá đồng).
  // Chỉ nhận cổ phiếu và chứng chỉ quỹ ETF trên HOSE/HNX/UPCoM; bỏ chứng quyền và dòng giá không hợp lệ. `date` (tuỳ chọn): chỉ nhận dòng của ngày đó.
  function parsePrices(json, date) {
    const rows = json && Array.isArray(json.data) ? json.data : [], out = [];
    rows.forEach((r) => {
      const symbol = String((r && r.code) || '').trim().toUpperCase(), type = String((r && r.type) || '').toUpperCase(), exchange = normEx(r && r.floor);
      if (!validSym(symbol) || !exchange || (type !== 'STOCK' && type !== 'ETF')) return;
      if (date && String(r.date || '').slice(0, 10) !== date) return;
      const ref = pos(r.basicPrice), close = pos(r.close);
      if (ref === null || close === null) return;
      const k = 1000, nmVolume = num(r.nmVolume) || 0, ptVolume = num(r.ptVolume) || 0, nmValue = num(r.nmValue) || 0, ptValue = num(r.ptValue) || 0;
      out.push({ symbol: symbol, exchange: exchange, type: type, ref: ref * k, price: close * k, ceil: pos(r.ceilingPrice) ? r.ceilingPrice * k : null, floor: pos(r.floorPrice) ? r.floorPrice * k : null,
        open: pos(r.open) ? r.open * k : null, high: pos(r.high) ? r.high * k : null, low: pos(r.low) ? r.low * k : null, nmVolume: nmVolume, nmValue: nmValue, ptVolume: ptVolume, ptValue: ptValue,
        volume: nmVolume + ptVolume, value: nmValue + ptValue, change: (close - ref) * k, pct: (close / ref - 1) * 100, date: String(r.date || '').slice(0, 10), time: String(r.time || '').slice(0, 8) || null, traded: nmVolume > 0 || ptVolume > 0 });
    });
    return out;
  }
  // Độ rộng và thanh khoản của một sàn ('ALL' = cả ba). Chỉ cổ phiếu (không tính ETF) cho tăng/giảm/đứng.
  function breadth(rows, exchange) {
    const b = { exchange: exchange || 'ALL', total: 0, up: 0, down: 0, flat: 0, ceil: 0, floor: 0, traded: 0, nmVolume: 0, volume: 0, nmValue: 0, ptValue: 0, value: 0 };
    (rows || []).forEach((r) => {
      if (!inEx(r, exchange)) return;
      b.nmVolume += r.nmVolume; b.volume += r.volume; b.nmValue += r.nmValue; b.ptValue += r.ptValue; b.value += r.value;     // thanh khoản tính cả ETF (nằm trong giá trị giao dịch của sàn)
      if (r.type !== 'STOCK') return;
      b.total++; if (r.traded) b.traded++;
      if (r.price > r.ref + 1e-9) { b.up++; if (r.ceil && r.price >= r.ceil - 1e-9) b.ceil++; }
      else if (r.price < r.ref - 1e-9) { b.down++; if (r.floor && r.price <= r.floor + 1e-9) b.floor++; }
      else b.flat++;
    });
    return b;
  }

  // ---------- khối ngoại ----------
  // finfo foreigns -> [{ symbol, exchange, type, buyVal, sellVal, netVal, buyVol, sellVol, netVol, room, currentRoom }] (giá trị đồng). Cổ phiếu và ETF; bỏ chứng quyền.
  function parseForeign(json, date) {
    const rows = json && Array.isArray(json.data) ? json.data : [], out = [];
    rows.forEach((r) => {
      const symbol = String((r && r.code) || '').trim().toUpperCase(), type = String((r && r.type) || '').toUpperCase(), exchange = normEx(r && r.floor);
      if (!validSym(symbol) || !exchange || (type !== 'STOCK' && type !== 'ETF')) return;
      if (date && String(r.tradingDate || '').slice(0, 10) !== date) return;
      out.push({ symbol: symbol, exchange: exchange, type: type, buyVal: num(r.buyVal) || 0, sellVal: num(r.sellVal) || 0, netVal: num(r.netVal) || 0, buyVol: num(r.buyVol) || 0, sellVol: num(r.sellVol) || 0, netVol: num(r.netVol) || 0, room: num(r.totalRoom), currentRoom: num(r.currentRoom) });
    });
    return out;
  }
  function foreignFlow(frows, exchange) {
    const f = { exchange: exchange || 'ALL', buy: 0, sell: 0, net: 0, buyVol: 0, sellVol: 0, n: 0 };
    (frows || []).forEach((r) => { if (!inEx(r, exchange)) return; f.buy += r.buyVal; f.sell += r.sellVal; f.buyVol += r.buyVol; f.sellVol += r.sellVol; f.n++; });
    f.net = f.buy - f.sell;                                      // tính lại từ mua - bán để luôn khớp hai số hiển thị
    return f;
  }

  // ---------- cổ phiếu nổi bật ----------
  const MOVER_KINDS = [
    { key: 'gain', label: 'Tăng mạnh' }, { key: 'loss', label: 'Giảm mạnh' }, { key: 'value', label: 'Giá trị GD' },
    { key: 'fbuy', label: 'NN mua ròng' }, { key: 'fsell', label: 'NN bán ròng' },
  ];
  // kind: gain | loss | value | fbuy | fsell. opts: { n (mặc định 10), minValue (đồng; mặc định 1 tỷ cho tăng/giảm để loại mã gần như không giao dịch), includeEtf }.
  // Trả [{ symbol, exchange, type, price, ref, pct, change, value, volume, foreignNet, atCeil, atFloor }]
  function movers(rows, frows, kind, exchange, opts) {
    const o = opts || {}, n = o.n > 0 ? o.n : 10, minValue = o.minValue === undefined ? 1e9 : o.minValue;
    const fnet = {}; (frows || []).forEach((f) => { fnet[f.symbol] = f.netVal; });
    const base = (rows || []).filter((r) => inEx(r, exchange) && (o.includeEtf || r.type === 'STOCK')).map((r) => ({ symbol: r.symbol, exchange: r.exchange, type: r.type, price: r.price, ref: r.ref, pct: r.pct, change: r.change, value: r.value, volume: r.volume, foreignNet: fnet[r.symbol] === undefined ? null : fnet[r.symbol],
      atCeil: !!(r.ceil && r.price >= r.ceil - 1e-9 && r.price > r.ref + 1e-9), atFloor: !!(r.floor && r.price <= r.floor + 1e-9 && r.price < r.ref - 1e-9) }));
    let list, cmp;
    if (kind === 'loss') { list = base.filter((r) => r.pct < 0 && r.value >= minValue); cmp = (a, b) => a.pct - b.pct; }
    else if (kind === 'value') { list = base.filter((r) => r.value > 0); cmp = (a, b) => b.value - a.value; }
    else if (kind === 'fbuy') { list = base.filter((r) => r.foreignNet > 0); cmp = (a, b) => b.foreignNet - a.foreignNet; }
    else if (kind === 'fsell') { list = base.filter((r) => r.foreignNet < 0); cmp = (a, b) => a.foreignNet - b.foreignNet; }
    else { list = base.filter((r) => r.pct > 0 && r.value >= minValue); cmp = (a, b) => b.pct - a.pct; }
    return list.sort((a, b) => cmp(a, b) || b.value - a.value || (a.symbol < b.symbol ? -1 : 1)).slice(0, n);
  }

  // ---------- ngành trong ngày ----------
  // rows: parsePrices; universe: [{ symbol, icb2_code, metrics: { marketcap } }] (ảnh chụp thị trường hằng ngày). Biến động ngành = trung bình gia quyền vốn hoá của % thay đổi hôm nay.
  // names: { icb2: tên }. Trả { sectors: [{ code, name, pct, cap, n, up, down, flat, value }], coverage: tỷ lệ vốn hoá có số liệu, market: pct gia quyền cả thị trường }
  function sectorsToday(rows, universe, names) {
    const price = {}; (rows || []).forEach((r) => { if (r.type === 'STOCK') price[r.symbol] = r; });
    const by = {}; let capAll = 0, capHave = 0, sumAll = 0;
    (universe || []).forEach((u) => {
      const cap = num(u && u.metrics && u.metrics.marketcap), code = String((u && u.icb2_code) || '').trim();
      if (!(cap > 0)) return;
      capAll += cap;
      const r = price[String(u.symbol || '').toUpperCase()];
      if (!r) return;
      capHave += cap; sumAll += cap * r.pct;
      const k = code || '_', s = by[k] || (by[k] = { code: code || null, cap: 0, capHave: 0, sum: 0, n: 0, up: 0, down: 0, flat: 0, value: 0 });
      s.cap += cap; s.capHave += cap; s.sum += cap * r.pct; s.n++; s.value += r.value;
      if (r.price > r.ref + 1e-9) s.up++; else if (r.price < r.ref - 1e-9) s.down++; else s.flat++;
    });
    const nm = names || {};
    const sectors = Object.keys(by).map((k) => { const s = by[k]; return { code: s.code, name: nm[k] || (k === '_' ? 'Chưa phân ngành' : 'ICB ' + k), pct: s.capHave > 0 ? s.sum / s.capHave : null, cap: s.cap, n: s.n, up: s.up, down: s.down, flat: s.flat, value: s.value }; })
      .filter((s) => s.pct !== null && s.n >= 2).sort((a, b) => b.pct - a.pct);
    return { sectors: sectors, coverage: capAll > 0 ? capHave / capAll : 0, market: capHave > 0 ? sumAll / capHave : null };
  }

  // ---------- hiệu suất nhiều kỳ và vị thế kỹ thuật (từ nến ngày) ----------
  // Chỉ số ngành của HOSE và vài chỉ số bổ sung; mã theo VNDirect dchart (đã kiểm có dữ liệu ngày 09/10/2026).
  const SECTOR_INDICES = [
    { code: 'VNFIN', label: 'Tài chính' }, { code: 'VNREAL', label: 'Bất động sản' }, { code: 'VNIT', label: 'Công nghệ thông tin' }, { code: 'VNMAT', label: 'Nguyên vật liệu' },
    { code: 'VNENE', label: 'Năng lượng' }, { code: 'VNCOND', label: 'Tiêu dùng không thiết yếu' }, { code: 'VNCONS', label: 'Tiêu dùng thiết yếu' }, { code: 'VNHEAL', label: 'Y tế' },
    { code: 'VNIND', label: 'Công nghiệp' }, { code: 'VNUTI', label: 'Tiện ích' },
  ];
  const EXTRA_INDICES = [
    { code: 'VN100', label: 'VN100', hint: '100 cổ phiếu vốn hoá lớn nhất HOSE' }, { code: 'VNSML', label: 'VN Small Cap', hint: 'Nhóm cổ phiếu vốn hoá nhỏ HOSE' },
    { code: 'VNDIAMOND', label: 'VN Diamond', hint: 'Cổ phiếu chất lượng cao, vốn hoá lớn, giới hạn tỷ lệ sở hữu nước ngoài còn rộng' }, { code: 'VNFINLEAD', label: 'VN Fin Lead', hint: 'Nhóm cổ phiếu tài chính dẫn đầu' },
  ];
  // n = số PHIÊN lùi lại để lấy mốc so sánh; ytd lấy đóng cửa phiên cuối của năm trước
  const PERIODS = [{ key: 'd1', label: '1 phiên', n: 1 }, { key: 'w1', label: '1 tuần', n: 5 }, { key: 'm1', label: '1 tháng', n: 22 }, { key: 'm3', label: '3 tháng', n: 64 }, { key: 'm6', label: '6 tháng', n: 127 }, { key: 'ytd', label: 'Từ 1/1' }, { key: 'y1', label: '1 năm', n: 252 }];
  // Biến động % của phiên cuối so với mốc từng kỳ; null khi chuỗi chưa đủ dài (không đoán)
  function returns(daily) {
    const out = {}, d = daily || [];
    PERIODS.forEach((p) => { out[p.key] = null; });
    if (!d.length) return out;
    const last = d[d.length - 1];
    PERIODS.forEach((p) => {
      let base = null;
      if (p.key === 'ytd') { const y = last.date.slice(0, 4) + '-01-01'; for (let i = d.length - 1; i >= 0; i--) if (d[i].date < y) { base = d[i].c; break; } }
      else { const i = d.length - 1 - p.n; base = i >= 0 ? d[i].c : null; }
      out[p.key] = base > 0 ? (last.c / base - 1) * 100 : null;
    });
    return out;
  }
  const sma = (d, n) => (d && d.length >= n ? d.slice(d.length - n).reduce((t, r) => t + r.c, 0) / n : null);
  // RSI Wilder (n phiên, làm mượt Wilder trên TOÀN chuỗi). Chỉ tăng -> 100, đứng yên hoàn toàn -> 50; thiếu n+1 nến -> null
  function rsi(d, n) {
    const N = n || 14;
    if (!d || d.length < N + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= N; i++) { const x = d[i].c - d[i - 1].c; if (x > 0) g += x; else l -= x; }
    g /= N; l /= N;
    for (let i = N + 1; i < d.length; i++) { const x = d[i].c - d[i - 1].c; g = (g * (N - 1) + (x > 0 ? x : 0)) / N; l = (l * (N - 1) + (x < 0 ? -x : 0)) / N; }
    if (l === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / l);
  }
  // Vùng giá 252 phiên gần nhất (dùng cao/thấp trong phiên): đỉnh, đáy, khoảng cách và vị trí của giá hiện tại trong vùng (0 = đáy, 100 = đỉnh)
  function range52(d) {
    if (!d || !d.length) return null;
    const w = d.slice(-252), last = d[d.length - 1].c, high = Math.max.apply(null, w.map((r) => r.h)), low = Math.min.apply(null, w.map((r) => r.l));
    return { n: w.length, high: high, low: low, fromHighPct: (last / high - 1) * 100, fromLowPct: (last / low - 1) * 100, posPct: high > low ? (last - low) / (high - low) * 100 : null };
  }
  // Tóm tắt vị thế kỹ thuật: MA20/50/200 và khoảng cách %, RSI14, vùng 52 tuần. Mô tả hiện trạng, không phải tín hiệu mua bán.
  function technical(d) {
    if (!d || d.length < 2) return null;
    const last = d[d.length - 1].c, mk = (n) => { const v = sma(d, n); return { n: n, value: v, vsPct: v ? (last / v - 1) * 100 : null }; };
    const ma = { ma20: mk(20), ma50: mk(50), ma200: mk(200) }, r = rsi(d, 14);
    let place = null;
    if (ma.ma50.value && ma.ma200.value) place = last > ma.ma50.value && last > ma.ma200.value ? 'Trên cả MA50 và MA200' : (last < ma.ma50.value && last < ma.ma200.value ? 'Dưới cả MA50 và MA200' : 'Nằm giữa MA50 và MA200');
    return { last: last, date: d[d.length - 1].date, sessions: d.length, ma: ma, place: place, ma50AboveMa200: ma.ma50.value && ma.ma200.value ? ma.ma50.value > ma.ma200.value : null,
      rsi: r, rsiState: r === null ? null : (r >= 70 ? 'Vùng quá mua' : (r <= 30 ? 'Vùng quá bán' : 'Trung tính')), range52: range52(d) };
  }

  // ---------- mức tác động của từng cổ phiếu lên chỉ số sàn ----------
  // VN-Index (và HNX-Index, UPCoM-Index) tính theo VỐN HOÁ toàn bộ cổ phiếu niêm yết nên điểm đóng góp của mã i ≈ chỉ số hôm trước × vốn hoá_i × %thay đổi_i / tổng vốn hoá.
  // rows: parsePrices; universe: ảnh chụp thị trường [{ symbol, metrics: { marketcap } }] (vốn hoá cuối phiên trước); prevIndex: điểm đóng cửa hôm trước. Chỉ tính cổ phiếu của `exchange` có cả giá hôm nay và vốn hoá.
  // Ước tính (chưa tính mã thiếu ảnh chụp hay đổi cổ phiếu lưu hành trong ngày); trả cả tổng điểm ước tính để so với thay đổi thật. Chỉ số VN30/HNX30 điều chỉnh tỷ lệ tự do chuyển nhượng nên không tính ở đây.
  function contributions(rows, universe, exchange, prevIndex) {
    const price = {}; (rows || []).forEach((r) => { if (r.type === 'STOCK' && r.exchange === exchange) price[r.symbol] = r; });
    const items = []; let total = 0;
    (universe || []).forEach((u) => {
      const cap = num(u && u.metrics && u.metrics.marketcap), sym = String((u && u.symbol) || '').toUpperCase(), r = price[sym];
      if (!(cap > 0) || !r) return;
      total += cap; items.push({ symbol: sym, cap: cap, pct: r.pct });
    });
    if (!items.length || !(prevIndex > 0)) return { items: [], up: [], down: [], sumPoints: null, coverage: 0, n: 0 };
    items.forEach((i) => { i.points = prevIndex * i.cap * i.pct / 100 / total; });
    const sorted = items.slice().sort((a, b) => b.points - a.points || (a.symbol < b.symbol ? -1 : 1));
    return { items: items, up: sorted.filter((i) => i.points > 0), down: sorted.filter((i) => i.points < 0).reverse(), sumPoints: items.reduce((t, i) => t + i.points, 0), coverage: Object.keys(price).length ? items.length / Object.keys(price).length : 0, n: items.length };
  }

  // ---------- hình học biểu đồ đường (SVG) ----------
  // points: [{ x, y }]; W,H: kích thước vùng vẽ; opts: { pad: { l, r, t, b }, xMin, xMax, include: [giá trị y phải nằm trong khung, ví dụ giá tham chiếu], padY (tỷ lệ đệm, mặc định 0.08) }
  // Trả { d (đường), area (vùng tô đến đáy), coords: [{ x, y, px, py }], yMin, yMax, xMin, xMax, refY (px của include[0]) } hoặc null khi không đủ điểm.
  function lineGeometry(points, W, H, opts) {
    const o = opts || {}, pad = Object.assign({ l: 8, r: 8, t: 10, b: 10 }, o.pad || {});
    const pts = (points || []).filter((p) => isFinite(p.x) && isFinite(p.y));
    if (pts.length < 2 || !(W > 0) || !(H > 0)) return null;
    let yMin = Math.min.apply(null, pts.map((p) => p.y).concat(o.include || [])), yMax = Math.max.apply(null, pts.map((p) => p.y).concat(o.include || []));
    if (yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; }
    const py0 = (yMax - yMin) * (o.padY === undefined ? 0.08 : o.padY); yMin -= py0; yMax += py0;
    const xMin = o.xMin === undefined ? Math.min.apply(null, pts.map((p) => p.x)) : o.xMin, xMax = o.xMax === undefined ? Math.max.apply(null, pts.map((p) => p.x)) : o.xMax;
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, xs = xMax > xMin ? iw / (xMax - xMin) : 0;
    const px = (x) => pad.l + (x - xMin) * xs, py = (y) => pad.t + (yMax - y) / (yMax - yMin) * ih;
    const r1 = (v) => Math.round(v * 10) / 10;
    const coords = pts.map((p) => ({ x: p.x, y: p.y, px: r1(px(p.x)), py: r1(py(p.y)) }));
    const d = coords.map((c, i) => (i ? 'L' : 'M') + c.px + ' ' + c.py).join(' ');
    const base = r1(pad.t + ih);
    return { d: d, area: d + ' L' + coords[coords.length - 1].px + ' ' + base + ' L' + coords[0].px + ' ' + base + ' Z', coords: coords, yMin: yMin, yMax: yMax, xMin: xMin, xMax: xMax,
      refY: o.include && o.include.length ? r1(py(o.include[0])) : null, bottom: base, left: pad.l, right: r1(W - pad.r) };
  }
  // Trục thời gian trong ngày của sàn VN rút gọn: 9:00-11:30 và 13:00-15:00 (bỏ giờ nghỉ trưa) -> 0..270 phút giao dịch
  function sessionX(min) { if (min <= 540) return 0; if (min <= 690) return min - 540; if (min <= 780) return 150; return Math.min(270, 150 + (min - 780) * 1); }
  const SESSION_TICKS = [{ x: 0, label: '9:00' }, { x: 90, label: '10:30' }, { x: 150, label: '11:30' }, { x: 210, label: '14:00' }, { x: 270, label: '15:00' }];
  // Điểm trong ngày cho lineGeometry: một điểm mỗi phút (trùng phút lấy nến sau cùng)
  function intradayPoints(points) {
    const by = {}; (points || []).forEach((p) => { by[p.min] = p; });
    return Object.keys(by).map(Number).sort((a, b) => a - b).map((m) => ({ x: sessionX(m), y: by[m].c, min: m, label: hhmm(m), v: by[m].v }));
  }

  return { INDICES, EXCHANGES, EXCHANGE_LABEL, RANGES, MOVER_KINDS, SESSION_TICKS, parseDaily, parseIntraday, lastSession, mergeToday, quote, windowOf, parsePrices, breadth, parseForeign, foreignFlow, movers, sectorsToday, SECTOR_INDICES, EXTRA_INDICES, PERIODS, returns, sma, rsi, range52, technical, contributions, lineGeometry, sessionX, intradayPoints, hhmm, vnDate };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MarketOverview;
