// Logic: GIÁ TRỰC TIẾP trong phiên cho Danh Mục (chỉ để HIỂN THỊ lãi lỗ theo thời gian thực, KHÔNG ghi vào sổ, NAV hay lịch sử).
// Nguồn: VNDirect finfo /v4/stock_prices (một lượt gọi cho cả danh mục, giá khớp gần nhất kèm giờ, giá tham chiếu, trần/sàn) - cho phép gọi thẳng từ ứng dụng (CORS mở), không cần khoá.
// Dự phòng khi finfo lỗi: nến 1 phút của VNDirect dchart (cũng CORS mở). Đo 07/10/2026 trong phiên: giá trễ khoảng 15 giây đến 2 phút so với giờ thực (mốc thời gian nhảy theo từng phút).
// Giá lưu trong máy chủ (cron 5 phút) vẫn là giá "chính thức" của sổ; lớp này chỉ ghi đè hiển thị cho mã chưa khoá giá.
// Nạp bằng thẻ <script> thường (global LiveQuotes) và module.exports cho Vitest. fetch và đồng hồ truyền vào được để kiểm thử.
const LiveQuotes = (function () {
  const FINFO = 'https://api-finfo.vndirect.com.vn/v4/stock_prices', DCHART = 'https://dchart-api.vndirect.com.vn/dchart/history';
  const BATCH = 60, FALLBACK_MAX = 20;
  const state = { quotes: {}, fetchedAt: null, source: null, error: null, session: 'closed', rejected: [] };
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const validSym = (s) => /^[A-Z0-9]{1,12}$/.test(s);

  // Giờ Việt Nam (UTC+7) của một thời điểm (Date | ms)
  function vnParts(now) {
    const ms = now instanceof Date ? now.getTime() : (now === undefined ? Date.now() : now), t = new Date(ms + 7 * 3600000);
    return { date: t.toISOString().slice(0, 10), min: t.getUTCHours() * 60 + t.getUTCMinutes(), sec: t.getUTCSeconds(), dow: t.getUTCDay() };
  }
  // 'open' (9:00-11:30, 13:00-14:50) | 'break' (nghỉ trưa) | 'pre' (trước 9:00) | 'closed' (sau 14:50 hoặc cuối tuần). Ngày lễ không biết: finfo không có dòng của hôm nay thì không có giá trực tiếp.
  function session(now) {
    const p = vnParts(now);
    if (p.dow === 0 || p.dow === 6) return 'closed';
    if (p.min < 540) return 'pre';
    if (p.min < 690) return 'open';
    if (p.min < 780) return 'break';
    if (p.min < 890) return 'open';
    return 'closed';
  }
  const hhmmss = (sec) => { const p = vnParts(sec * 1000); return String(Math.floor(p.min / 60)).padStart(2, '0') + ':' + String(p.min % 60).padStart(2, '0') + ':' + String(p.sec).padStart(2, '0'); };

  // finfo stock_prices: { data: [{ code, date, time, basicPrice, ceilingPrice, floorPrice, open, high, low, close, nmVolume }] } (giá tính bằng nghìn đồng).
  // Chỉ nhận dòng của hôm nay (today = YYYY-MM-DD giờ VN), giá khớp > 0 và trong biên trần/sàn (+/-2% dung sai): ngoài biên là dữ liệu lỗi.
  function parseFinfo(json, today) {
    const quotes = {}, rejected = [], rows = json && Array.isArray(json.data) ? json.data : [];
    rows.forEach((r) => {
      const sym = String(r && r.code || '').trim().toUpperCase();
      if (!validSym(sym) || String(r.date || '').slice(0, 10) !== today) return;
      const close = num(r.close), ceil = num(r.ceilingPrice), floor = num(r.floorPrice);
      if (!(close > 0)) return;                                         // chưa khớp lệnh nào (ví dụ đang ATO)
      if (ceil > 0 && floor > 0 && (close > ceil * 1.02 || close < floor * 0.98)) { rejected.push(sym); return; }
      const ts = Date.parse(today + 'T' + String(r.time || '00:00:00').slice(0, 8) + '+07:00');
      quotes[sym] = { price: Math.round(close * 1000), ref: num(r.basicPrice) > 0 ? Math.round(num(r.basicPrice) * 1000) : null, open: num(r.open) > 0 ? Math.round(r.open * 1000) : null, high: num(r.high) > 0 ? Math.round(r.high * 1000) : null,
        low: num(r.low) > 0 ? Math.round(r.low * 1000) : null, volume: num(r.nmVolume), date: today, time: String(r.time || '').slice(0, 8) || null, ts: isFinite(ts) ? Math.floor(ts / 1000) : null, source: 'vnd-finfo' };
    });
    return { quotes: quotes, rejected: rejected };
  }
  // dchart nến 1 phút: { s: 'ok', t: [unix], c: [giá nghìn đồng] }. Lấy nến cuối nếu thuộc hôm nay.
  function parseDchart(json, sym, today) {
    if (!json || json.s !== 'ok' || !Array.isArray(json.t) || !json.t.length || !Array.isArray(json.c)) return null;
    const i = json.t.length - 1, c = num(json.c[i]), t = num(json.t[i]);
    if (!(c > 0) || t === null || vnParts(t * 1000).date !== today) return null;
    return { price: Math.round(c * 1000), ref: null, open: null, high: null, low: null, volume: null, date: today, time: hhmmss(t), ts: t, source: 'vnd-dchart' };
  }

  async function getJson(f, url, ms) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = ctl ? setTimeout(() => ctl.abort(), ms || 8000) : null;
    try { const r = await f(url, ctl ? { signal: ctl.signal } : {}); if (!r || !r.ok) return null; return await r.json(); } catch (e) { return null; } finally { if (timer) clearTimeout(timer); }
  }

  // Làm mới giá cho danh sách mã. opts: { fetch, now }. Cập nhật và trả về state ({ quotes: {SYM: quote}, fetchedAt, source, error, session }).
  async function refresh(symbols, opts) {
    const o = opts || {}, f = o.fetch || (typeof fetch === 'function' ? fetch : null), nowMs = o.now === undefined ? Date.now() : o.now, today = vnParts(nowMs).date;
    const syms = [...new Set((symbols || []).map((s) => String(s || '').trim().toUpperCase()).filter(validSym))];
    state.session = session(nowMs);
    if (!f) { state.error = 'Môi trường không có fetch'; return state; }
    if (!syms.length) { state.quotes = {}; state.fetchedAt = nowMs; state.error = null; return state; }
    const quotes = {}, rejected = [];
    let okChunks = 0, failed = [];
    for (let i = 0; i < syms.length; i += BATCH) {
      const chunk = syms.slice(i, i + BATCH);
      const j = await getJson(f, FINFO + '?q=code:' + chunk.join(',') + '~date:' + today + '&size=' + (chunk.length + 5));
      if (!j || !Array.isArray(j.data)) { failed = failed.concat(chunk); continue; }
      okChunks++;
      const p = parseFinfo(j, today); Object.assign(quotes, p.quotes); rejected.push(...p.rejected);
    }
    let source = failed.length ? null : 'vnd-finfo';
    if (failed.length) {                                                // finfo lỗi: dự phòng nến 1 phút của dchart cho tối đa FALLBACK_MAX mã
      const todo = failed.slice(0, FALLBACK_MAX), from = Math.floor(nowMs / 1000) - 6 * 3600, to = Math.floor(nowMs / 1000) + 600;
      for (let i = 0; i < todo.length; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map(async (s) => {
          const q = parseDchart(await getJson(f, DCHART + '?resolution=1&symbol=' + s + '&from=' + from + '&to=' + to), s, today);
          if (q) quotes[s] = q;
        }));
      }
      source = okChunks ? 'vnd-finfo+dchart' : 'vnd-dchart';
    }
    if (failed.length && !Object.keys(quotes).length && okChunks === 0) {   // không nguồn nào trả: giữ giá cũ, báo lỗi
      state.error = 'Không lấy được giá trực tiếp từ nguồn'; return state;
    }
    state.quotes = quotes; state.fetchedAt = nowMs; state.source = source; state.error = null; state.rejected = rejected;
    return state;
  }

  // Ghi đè giá hiển thị lên các dòng danh mục (kết quả getHoldingsView): mã chưa khoá giá và có giá trực tiếp thì tính lại giá trị, lãi lỗ, khoảng cách tới mục tiêu/cắt lỗ, lãi lỗ trong ngày.
  function applyToHoldings(holdings, quotes) {
    const q = quotes || state.quotes;
    return (holdings || []).map((h) => {
      const x = q[h.symbol];
      if (!x || h.priceLocked || !(x.price > 0)) return Object.assign({}, h, { live: false });
      const qty = Number(h.quantity) || 0, cost = h.costValue !== undefined ? Number(h.costValue) : (Number(h.avgCost) || 0) * qty, mv = x.price * qty;
      const out = Object.assign({}, h, {
        live: true, storedPrice: h.marketPrice, marketPrice: x.price, marketValue: mv, unrealizedPnl: mv - cost, unrealizedPct: cost > 0 ? (mv - cost) / cost * 100 : 0,
        upsidePct: h.targetPrice > 0 ? (h.targetPrice - x.price) / x.price * 100 : null, stopDistancePct: h.stopLoss > 0 ? (h.stopLoss - x.price) / x.price * 100 : null,
        priceMeta: { kind: 'live', date: x.date, time: x.time, ageDays: 0, stale: false, source: x.source },
      });
      if (x.ref > 0) { out.dayPnl = qty * (x.price - x.ref); out.dayPct = (x.price - x.ref) / x.ref * 100; }
      return out;
    });
  }

  // Tổng hợp cho KPI: giá trị thị trường, lãi lỗ chưa thực hiện, lãi lỗ hôm nay (chỉ mã có giá tham chiếu), số mã có giá trực tiếp.
  function totals(holdings) {
    let mv = 0, unreal = 0, day = 0, dayBase = 0, live = 0, dayCovered = 0;
    (holdings || []).forEach((h) => {
      mv += Number(h.marketValue) || 0; unreal += Number(h.unrealizedPnl) || 0;
      if (h.live) live++;
      if (h.dayPnl !== undefined) { day += h.dayPnl; dayBase += (h.marketValue - h.dayPnl); dayCovered++; }
    });
    return { marketValue: mv, unrealizedPnl: unreal, dayPnl: dayCovered ? day : null, dayPct: dayCovered && dayBase > 0 ? day / dayBase * 100 : null, liveCount: live, total: (holdings || []).length };
  }

  return { state, FINFO, DCHART, vnParts, session, parseFinfo, parseDchart, refresh, applyToHoldings, totals, hhmmss };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LiveQuotes;
