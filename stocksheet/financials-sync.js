/* --- FILE: /stocksheet/financials-sync.js ---
   Đồng bộ số liệu tài chính từ nguồn thị trường (Edge Function stock-financials) vào hồ sơ định giá + dữ liệu quý.
   Dùng chung cho Tổng Hợp CP (đồng bộ hàng loạt, thêm mã) và Định Giá CP (xem trước + điền form + lưu lịch sử).
   Phép ghép dữ liệu nằm ở ValuationCalc.syncRecords (có kiểm thử); file này chỉ gọi API và điều phối. */
const FinancialsSync = (function () {
  async function call(action, params) {
    const r = await callGAS(action, params || {});
    if (!r || r.status !== 'success') throw new Error((r && r.message) || 'Lỗi không xác định');
    return r.data;
  }

  // Lấy số liệu nguồn của 1 mã (đã có sẵn trong `fetched` nếu gọi hàng loạt) rồi ghép với hồ sơ đã lưu -> kế hoạch (chưa ghi gì).
  async function planFor(symbol, fin, opts) {
    const o = opts || {};
    const rows = await call('getStockHistory', { symbol: symbol });
    let livePrice = o.livePrice;
    if (livePrice === undefined) {
      try { const live = await call('getStockLivePrices', { symbols: [symbol] }); livePrice = live[symbol] ? live[symbol].price : 0; } catch (e) { livePrice = 0; }
    }
    const plan = ValuationCalc.syncRecords(rows, fin, { symbol: symbol, livePrice: livePrice, maxYears: o.maxYears, maxQuarters: o.maxQuarters, at: new Date().toISOString() });
    return { symbol: symbol, fin: fin, rows: rows, plan: plan };
  }

  // Xem trước 1 mã: lấy từ nguồn + dựng kế hoạch, KHÔNG ghi vào hệ thống.
  async function preview(symbol, opts) {
    const sym = String(symbol || '').trim().toUpperCase();
    const out = await call('fetchStockFinancials', { symbols: [sym] });
    if (!out.results[sym]) throw new Error(out.errors[sym] || ('Không lấy được số liệu của ' + sym));
    return planFor(sym, out.results[sym], opts);
  }

  // Ghi kế hoạch: hồ sơ theo năm + dữ liệu quý (ghi đè số liệu tài chính, giữ nguyên giả định của người dùng).
  async function apply(p) {
    const records = p.plan.records;
    if (!records.length && !p.plan.quarters.length) throw new Error('Nguồn dữ liệu chưa có số liệu để lưu cho ' + p.symbol);
    if (records.length) await call('saveStockValuationBatch', { records: records });
    if (p.plan.quarters.length) await call('saveStockQuarterBatch', { rows: p.plan.quarters });
    return p.plan.summary;
  }

  // Đồng bộ nhiều mã: gom tối đa 5 mã mỗi lần gọi nguồn, ghi từng mã; mã lỗi không làm hỏng các mã còn lại.
  // onProgress(done, total, symbol). Trả [{ symbol, ok, summary | error }].
  async function syncMany(symbols, onProgress) {
    const list = [...new Set((symbols || []).map(s => String(s || '').trim().toUpperCase()).filter(Boolean))];
    const results = [];
    let done = 0;
    for (let i = 0; i < list.length; i += 5) {
      const chunk = list.slice(i, i + 5);
      let fetched = { results: {}, errors: {} };
      try { fetched = await call('fetchStockFinancials', { symbols: chunk }); }
      catch (e) { chunk.forEach(s => { fetched.errors[s] = e.message; }); }
      for (const sym of chunk) {
        try {
          if (!fetched.results[sym]) throw new Error(fetched.errors[sym] || 'Không lấy được số liệu');
          const p = await planFor(sym, fetched.results[sym]);
          results.push({ symbol: sym, ok: true, summary: await apply(p) });
        } catch (e) {
          results.push({ symbol: sym, ok: false, error: e.message });
        }
        done++;
        if (onProgress) onProgress(done, list.length, sym);
      }
    }
    return results;
  }

  // Thời điểm đồng bộ gần nhất trong các hồ sơ (ISO) hoặc null, và số ngày đã qua.
  function lastSyncOf(datas) {
    let best = null;
    (datas || []).forEach(d => { const t = d && d.financialsAt; if (t && (!best || t > best)) best = t; });
    return best ? { at: best, ageDays: Math.floor((Date.now() - Date.parse(best)) / 86400000) } : null;
  }

  return { preview, apply, syncMany, planFor, lastSyncOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FinancialsSync;
