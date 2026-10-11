// Logic thuần: dựng BẢNG GIÁ cho kiểm thử chiến lược từ kho giá theo ngày (finance_price_days, do Edge Function bt-data ghi) và chuỗi chỉ số (finance_bt_index).
// Mỗi dòng ngày: { day, data: { "FPT": [đóng cửa thô, LỢI SUẤT NGÀY, giá trị khớp lệnh (triệu đồng), cờ trần/sàn (1 / -1 / 0), sàn (0 HOSE, 1 HNX, 2 UPCoM)] } } (giá nghìn đồng).
// Lợi suất ngày do bt-data tính = adClose(D) / adClose(D-1) - 1 trong CÙNG MỘT lần gọi nguồn: là LỢI SUẤT TỔNG (đã gồm cổ tức, thưởng, chia tách) và không bao giờ phải tính lại khi có sự kiện mới
// (khác giá "đã điều chỉnh" của nguồn, bị viết lại mỗi lần có cổ tức). Đã đối chiếu với chuỗi điều chỉnh của VNDirect (dchart) cho nhiều mã nhiều năm. KHÔNG nối chuỗi bằng giá tham chiếu: HNX và UPCoM lấy giá bình quân hôm trước làm tham chiếu.
// Chỉ số mức giá (lvl) = tích luỹ lợi suất, bắt đầu từ 100 ở phiên đầu của từng mã. Mã đã hủy niêm yết có mặt đến phiên cuối của nó (không bị loại khỏi lịch sử -> không thiên lệch người sống sót ở phần giá).
// Dựng DẦN từng ngày (create / add / finish) để trình duyệt không phải giữ cả ~1.700 dòng ngày (hàng triệu mảng nhỏ) trong bộ nhớ: mỗi trang tải về được ghi thẳng vào mảng số rồi bỏ.
// KHÔNG đụng DOM/mạng/tệp. Nạp bằng thẻ <script> thường (global BtPanel) và module.exports cho Vitest.
const BtPanel = (function () {
  const EXCHANGES = ['HOSE', 'HNX', 'UPCOM'];
  const BAND = [0.07, 0.10, 0.15];
  const MAX_ABS_RET = 3;                        // |lợi suất ngày| > 300% = lỗi dữ liệu, bỏ
  const MIN_ROWS = 20;                          // mã có ít hơn thế số phiên thì bỏ khỏi bảng
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : NaN; };

  // calendar: danh sách ngày giao dịch (tăng dần, thường lấy từ chuỗi VN-Index). Ngày không có trong lịch bị bỏ qua khi add.
  function create(calendar, opts) {
    const o = Object.assign({ minRows: MIN_ROWS }, opts || {});
    const dates = (calendar || []).filter(isDate).map(String), T = dates.length, pos = new Map();
    dates.forEach((d, t) => { pos.set(d, t); });
    const acc = new Map(), seen = new Uint8Array(T);
    let bad = 0, ignored = 0;
    const slot = (s) => {
      let a = acc.get(s);
      if (!a) {
        a = { ret: new Float32Array(T).fill(NaN), close: new Float32Array(T).fill(NaN), val: new Float32Array(T).fill(NaN), lim: new Int8Array(T), exd: new Int8Array(T), first: -1, last: -1, rows: 0, ex: 0 };
        acc.set(s, a);
      }
      return a;
    };
    function add(row) {
      if (!row || !row.data || typeof row.data !== 'object') return false;
      const t = pos.get(String(row.day));
      if (t === undefined) { ignored++; return false; }
      seen[t] = 1;
      const d = row.data;
      for (const s in d) {
        const x = d[s];
        if (!Array.isArray(x)) continue;
        const c = num(x[0]), r = num(x[1]);
        if (!(c > 0) || !(r === r)) continue;
        if (!(Math.abs(r) <= MAX_ABS_RET)) { bad++; continue; }
        const a = slot(s);
        a.ret[t] = r; a.close[t] = c; a.val[t] = num(x[2]) >= 0 ? num(x[2]) : NaN; a.lim[t] = x[3] === 1 ? 1 : (x[3] === -1 ? -1 : 0);
        a.exd[t] = x[4] === 1 ? 1 : (x[4] === 2 ? 2 : 0); a.rows++;
        if (a.first < 0 || t < a.first) a.first = t;
        if (t > a.last) a.last = t;
        a.ex = a.exd[t];
      }
      return true;
    }
    // indexRows: [{ symbol, data: { d: [ngày], c: [điểm] } }]
    function finish(indexRows) {
      const symbols = [...acc.keys()].filter((s) => acc.get(s).rows >= o.minRows).sort();
      const S = symbols.length, sIndex = {};
      symbols.forEach((s, i) => { sIndex[s] = i; });
      const ret = new Array(S), lvl = new Array(S), close = new Array(S), val = new Array(S), lim = new Array(S), exd = new Array(S);
      const first = new Int32Array(S).fill(-1), last = new Int32Array(S).fill(-1), ex = new Int8Array(S);
      symbols.forEach((s, i) => {
        const a = acc.get(s);
        ret[i] = a.ret; close[i] = a.close; val[i] = a.val; lim[i] = a.lim; exd[i] = a.exd; first[i] = a.first; last[i] = a.last; ex[i] = a.ex;
        const L = new Float32Array(T).fill(NaN); let cur = 100;
        for (let t = a.first; t <= a.last; t++) { const r = a.ret[t]; if (r === r) cur *= (1 + r); L[t] = cur; }      // điền tiếp qua ngày vắng (mã tạm ngừng) tới phiên cuối của mã
        lvl[i] = L;
      });
      // chỉ số thị trường căn theo lịch, điền tiếp ngày thiếu
      const index = {}, indexCoverage = {};
      (indexRows || []).forEach((row) => {
        if (!row || !row.data || !Array.isArray(row.data.d) || !Array.isArray(row.data.c)) return;
        const m = {}; row.data.d.forEach((d, k) => { m[d] = num(row.data.c[k]); });
        const out = new Float64Array(T).fill(NaN), sd = row.data.d;
        let cur = NaN, have = 0, k = 0;
        for (let t = 0; t < T; t++) {
          while (k < sd.length && sd[k] <= dates[t]) { if (m[sd[k]] > 0) cur = m[sd[k]]; k++; }
          if (m[dates[t]] > 0) have++;
          out[t] = cur;
        }
        index[row.symbol] = out; indexCoverage[row.symbol] = T ? have / T : 0;
      });
      // ngày trong lịch mà kho chưa có dòng nào (lợi suất các phiên đó bị bỏ)
      const missingDays = []; for (let t = 0; t < T; t++) if (!seen[t]) missingDays.push(dates[t]);
      return { dates, T, symbols, S, sIndex, ret, lvl, close, val, lim, exd, first, last, ex, index, indexCoverage, missingDays, badReturns: bad, ignoredRows: ignored, band: BAND, exchanges: EXCHANGES };
    }
    return { add, finish, size: () => acc.size, days: () => seen.reduce((s, x) => s + x, 0), T };
  }

  // Tiện ích: dựng một lần từ danh sách dòng ngày (lịch = chính các ngày đó). Dùng cho test và bộ dữ liệu nhỏ.
  function build(dayRows, indexRows, opts) {
    const rows = (dayRows || []).filter((r) => r && isDate(r.day) && r.data && typeof r.data === 'object').slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    // lịch = ngày có dòng + ngày VN-Index trong khoảng đó (ngày VN-Index có mà kho chưa có sẽ hiện ở missingDays)
    const cal = new Set(rows.map((r) => String(r.day)));
    const vn = (indexRows || []).find((r) => r && r.symbol === 'VNINDEX');
    if (vn && vn.data && Array.isArray(vn.data.d) && rows.length) vn.data.d.forEach((d) => { if (d >= rows[0].day && d <= rows[rows.length - 1].day) cal.add(d); });
    const b = create([...cal].sort(), opts);
    rows.forEach((r) => b.add(r));
    return b.finish(indexRows);
  }

  // Chỉ số ngày (vị trí) của ngày đầu tiên >= iso trong bảng; T nếu không có
  function indexOnOrAfter(panel, iso) {
    const d = panel.dates; let lo = 0, hi = d.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] < iso) lo = m + 1; else hi = m; }
    return lo;
  }
  // Chỉ số ngày của ngày cuối cùng <= iso; -1 nếu không có
  function indexOnOrBefore(panel, iso) {
    const d = panel.dates; let lo = 0, hi = d.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] <= iso) lo = m + 1; else hi = m; }
    return lo - 1;
  }

  // Tóm tắt kho cho giao diện: số ngày, khoảng, số mã, số mã đã hủy niêm yết (không còn giá ở phiên cuối), ngày thiếu so với lịch
  function summary(panel) {
    if (!panel || !panel.T) return { days: 0, first: null, last: null, symbols: 0, ended: 0, missing: 0 };
    let ended = 0;
    for (let i = 0; i < panel.S; i++) if (panel.last[i] >= 0 && panel.last[i] < panel.T - 5) ended++;
    return { days: panel.T, first: panel.dates[0], last: panel.dates[panel.T - 1], symbols: panel.S, ended: ended, missing: panel.missingDays.length };
  }

  return { EXCHANGES, BAND, MAX_ABS_RET, create, build, indexOnOrAfter, indexOnOrBefore, summary };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BtPanel;
globalThis.BtPanel = BtPanel;
