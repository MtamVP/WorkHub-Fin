// Logic thuần: ĐỊNH GIÁ HÀNG LOẠT danh sách mã sau khi lọc (Tổng Hợp CP > Thị trường) bằng bộ máy Valuation Bench, và xuất bảng kết quả.
// Mỗi mã: nạp báo cáo + giá từ vb-data (một lượt gọi), dựng ngữ cảnh bằng thống kê ngành đã tải sẵn (không gọi thêm), chạy VBEngine.analyze với giả định MẶC ĐỊNH
// (quy trình tự phân loại mô hình kinh doanh, chưa có điều chỉnh/giả định riêng của người dùng, chưa lưu). Kết quả là để SÀNG và XẾP HẠNG, không thay cho việc mở hồ sơ để rà soát.
// KHÔNG đụng DOM/mạng/Supabase: nạp dữ liệu và engine do bên gọi truyền vào. Nạp bằng thẻ <script> thường (global MarketBatch) và module.exports cho Vitest.
const MarketBatch = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };

  // vb: dữ liệu vb-data của mã ({ form, annualRows, quarterRows, candles, indexCandles, ratioSeries }); row: hàng của MarketScreener.buildRows;
  // uni: { stats: { icb2: { stats } } }; hist: { rows, bond10y } (lịch sử định giá thị trường); opts: { scorecard, sectorName, mcN }
  function buildCtx(vb, row, uni, hist, opts) {
    const o = opts || {}, v = vb || {};
    const sec = uni && uni.stats && row.icb2_code && uni.stats[row.icb2_code] ? uni.stats[row.icb2_code].stats : null;
    return {
      symbol: row.symbol, form: v.form || undefined, annualRows: v.annualRows || [], quarterRows: v.quarterRows || [], candles: v.candles, indexCandles: v.indexCandles,
      ratioSeries: v.ratioSeries || null, metrics: Object.assign({}, row.m), peerStats: sec, sectorStats: sec, sectorCode: row.icb2_code || null, sectorName: o.sectorName || null,
      histRows: hist && hist.rows ? hist.rows : [], bond10yPct: hist && hist.bond10y !== undefined ? hist.bond10y : null,
      scorecard: o.scorecard || null, mc: { n: o.mcN || 300 },
    };
  }

  // Kết quả engine -> một dòng gọn. engine cần analyze() và toRecord() (VBEngine). Trả { symbol, ok:false, reason } khi không định giá được.
  function summarize(result, engine) {
    const sym = result && result.symbol ? result.symbol : null;
    if (!result || !result.ok) return { symbol: sym, ok: false, reason: result && result.reason ? result.reason : 'Không định giá được' };
    const rec = engine.toRecord(result);
    if (!rec || !(num(rec.fair_base) > 0)) return { symbol: sym, ok: false, reason: 'Chưa có giá trị hợp lý (thiếu dữ liệu hoặc các phương pháp không đồng thuận)' };
    const proc = rec.summary && rec.summary.process ? rec.summary.process : null;
    const price = num(rec.price) > 0 ? num(rec.price) : null, base = num(rec.fair_base);
    return {
      symbol: sym, ok: true, asOf: rec.as_of, price: price, fairLow: num(rec.fair_low), fairBase: base, fairHigh: num(rec.fair_high),
      mos: price ? (base - price) / base : null,                        // biên an toàn theo giá hiện tại: (giá trị hợp lý - giá) / giá trị hợp lý
      grade: rec.grade, stance: rec.stance, confidence: rec.confidence, confidenceScore: num(rec.confidence_score),
      archetype: proc ? proc.archetypeLabel : null, processStatus: proc ? proc.status : null, reliability: proc ? proc.reliability : null, fails: proc ? proc.fails : null, warns: proc ? proc.warns : null,
    };
  }

  // Chạy lần lượt với `concurrency` mã cùng lúc. load(symbol) -> dữ liệu vb-data (có thể ném lỗi); analyze(vb, row) -> kết quả engine (đã gọi buildCtx); finish(result) -> summarize.
  // Gọi onProgress({ done, total, symbol, result }) sau mỗi mã; shouldCancel() trả true thì dừng nhận mã mới (mã đang chạy vẫn xong). Mã lỗi nạp được thử lại `retries` lần.
  async function run(rows, fns, opts) {
    const o = opts || {}, conc = Math.max(1, o.concurrency || 3), retries = o.retries === undefined ? 1 : o.retries;
    const out = {}, list = (rows || []).slice(), total = list.length;
    let next = 0, done = 0, cancelled = false;
    async function one(row) {
      let vb = null, err = null;
      for (let a = 0; a <= retries && !vb; a++) {
        try { vb = await fns.load(row.symbol); } catch (e) { err = e; if (a < retries && o.retryDelayMs) await new Promise((r) => setTimeout(r, o.retryDelayMs)); }
      }
      if (!vb) return { symbol: row.symbol, ok: false, reason: 'Không nạp được dữ liệu: ' + String(err && err.message || err || 'không rõ').slice(0, 120) };
      try { return fns.finish(fns.analyze(vb, row)); }
      catch (e) { return { symbol: row.symbol, ok: false, reason: 'Lỗi khi tính: ' + String(e && e.message || e).slice(0, 120) }; }
    }
    async function worker() {
      while (next < total) {
        if (o.shouldCancel && o.shouldCancel()) { cancelled = true; return; }
        const row = list[next++], res = await one(row);
        out[row.symbol] = res; done++;
        if (o.onProgress) o.onProgress({ done: done, total: total, symbol: row.symbol, result: res });
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, total) }, worker));
    return { results: out, done: done, total: total, cancelled: cancelled };
  }

  // Xếp theo biên an toàn giảm dần; mã chưa định giá được xuống cuối, giữ thứ tự cũ (điểm lọc)
  function rankByMos(entries, vals) {
    const v = vals || {};
    const keyOf = (e) => { const x = v[e.row.symbol]; return x && x.ok && x.mos !== null ? x.mos : -Infinity; };
    return entries.map((e, i) => ({ e: e, i: i })).sort((a, b) => (keyOf(b.e) - keyOf(a.e)) || (a.i - b.i)).map((x) => x.e);
  }

  // Bảng để xuất CSV (mảng các mảng, dùng với FinCalc.buildCsv). nameOf(icb2_code) -> tên ngành. Phần trăm xuất dạng số thập phân 1 chữ số (12.3), không kèm ký hiệu %.
  const HEADER = ['Mã', 'Tên', 'Ngành', 'Sàn', 'Điểm', 'Vốn hoá (tỷ)', 'P/E', 'P/B', 'EV/EBITDA', 'Phân vị định giá trong ngành (0 = rẻ nhất)', 'ROE %', 'Tăng trưởng EPS %', 'Tăng trưởng LN ròng 12 tháng %', 'Tăng trưởng LN ròng 3 năm %/năm', 'Cổ tức %', 'Nợ/vốn chủ', 'Giá từ 1/1 %', 'Giá 12 tháng %',
    'Giá hiện tại (đ)', 'Giá trị hợp lý (đ)', 'Biên an toàn %', 'Xếp loại', 'Độ tin cậy', 'Mô hình kinh doanh', 'Cờ số liệu'];
  function csvRows(entries, vals, nameOf) {
    const v = vals || {}, f = (x, d) => { const n = num(x); return n === null ? '' : n.toFixed(d === undefined ? 1 : d); }, p = (x) => { const n = num(x); return n === null ? '' : (n * 100).toFixed(1); };
    const rows = [HEADER];
    entries.forEach((e) => {
      const r = e.row, m = r.m, x = v[r.symbol] && v[r.symbol].ok ? v[r.symbol] : null;
      rows.push([r.symbol, r.name, nameOf ? nameOf(r.icb2_code) : (r.icb2_code || ''), r.exchange, f(e.score, 0), m.marketcap > 0 ? f(m.marketcap / 1e9, 0) : '', f(m.pe), f(m.pb, 2), r.financial ? '' : f(m.evEbitda), f(r.valuationPct, 0), p(m.roae), p(m.epsGrowthYoY), p(m.netProfitGrowthYoY), p(m.netProfitGrowth3y), p(m.divYield), r.financial ? '' : f(m.debtToEquity, 2), p(m.chgYtd), p(m.chg1y),
        x ? Math.round(x.price || 0) || '' : '', x ? Math.round(x.fairBase) : '', x && x.mos !== null ? p(x.mos) : '', x ? x.grade : '', x ? x.confidence : '', x ? x.archetype || '' : '', (e.flags || []).join(' | ')]);
    });
    return rows;
  }

  return { buildCtx, summarize, run, rankByMos, csvRows, HEADER };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MarketBatch;
