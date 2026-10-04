// Logic thuần: ĐỐI SOÁT sổ lệnh trong app với sao kê của công ty chứng khoán -- bước kiểm soát cơ bản nhất của mọi quỹ: số dư mã và các lệnh trong sổ phải khớp
// với bên giữ tài sản. Hai kiểu sao kê: (1) SỐ DƯ chứng khoán (mã + khối lượng, có thể kèm giá vốn/giá thị trường) so với số cổ phiếu app tính được tới cùng ngày;
// (2) LỆNH giao dịch trong một kỳ so với sổ lệnh (thiếu lệnh, thừa lệnh, lệch khối lượng/giá). Khi lệch, đưa ra GỢI Ý nguyên nhân có thể (thiếu hành động
// doanh nghiệp như thưởng/tách, một lệnh nhập trùng hoặc nhập nhầm chiều, thiếu lệnh mua/bán) để người dùng sửa đúng chỗ thay vì phải dò từng dòng.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global Reconcile) và module.exports cho Vitest.
// Cần StatementImport (lib/statement-import.js: đọc file, parseNumber/parseDate) và PortfolioCalc (lib/portfolio-calc.js) nạp trước.
const Reconcile = (function () {
  const SI = (typeof require === 'function' && typeof module !== 'undefined') ? require('./statement-import.js') : StatementImport;
  const PC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./portfolio-calc.js') : PortfolioCalc;
  const EPS = 1e-9;
  const STALE_DAYS = 35;           // quá số ngày này chưa đối soát thì báo "đã lâu"
  const COST_TOL_PCT = 2;          // giá vốn lệch quá mức này thì ghi chú

  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const iso = (v) => String(v || '').slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(iso(b) + 'T00:00:00Z') - Date.parse(iso(a) + 'T00:00:00Z')) / 86400000);

  // ---------- 1) Sao kê SỐ DƯ: nhận cột và chuẩn hoá ----------
  const FIELDS = ['symbol', 'quantity', 'cost', 'price', 'value', 'date'];
  const SYNONYMS = {
    symbol: ['ma', 'ma ck', 'ma cp', 'ma chung khoan', 'ma co phieu', 'chung khoan', 'symbol', 'ticker', 'stock', 'ma cks'],
    quantity: ['tong kl', 'tong khoi luong', 'tong so luong', 'so luong', 'khoi luong', 'kl so huu', 'kl nam giu', 'so luong nam giu', 'so du', 'so du ck', 'so du chung khoan', 'sl', 'kl', 'quantity', 'qty', 'holding', 'balance', 'total volume'],
    cost: ['gia von', 'gia von tb', 'gia von binh quan', 'gia von trung binh', 'gia mua tb', 'gia mua binh quan', 'gia binh quan', 'avg cost', 'average cost', 'average price', 'cost price', 'avg price'],
    price: ['gia thi truong', 'gia tt', 'gia hien tai', 'gia dong cua', 'gia tham chieu', 'market price', 'last price', 'close', 'closing price', 'gia'],
    value: ['gia tri thi truong', 'gia tri tt', 'gia tri', 'tong gia tri', 'market value', 'value', 'thanh tien'],
    date: ['ngay sao ke', 'ngay chot', 'ngay cap nhat', 'den ngay', 'as of', 'statement date', 'ngay', 'date'],
  };

  // Tìm dòng tiêu đề + ghép cột cho sao kê số dư. Cần tối thiểu cột mã và khối lượng. Trả { headerRow, headers, mapping, score }.
  function detectPositionColumns(rows) {
    let best = { headerRow: -1, score: 0, mapping: {}, headers: [] };
    const limit = Math.min(rows.length, 30);
    for (let r = 0; r < limit; r++) {
      const headers = (rows[r] || []).map((h) => SI.normalize(h));
      const mapping = {}, used = new Set();
      [false, true].forEach((loose) => {
        FIELDS.forEach((field) => {
          if (mapping[field] !== undefined) return;
          for (let c = 0; c < headers.length; c++) {
            if (used.has(c) || !headers[c]) continue;
            const hit = SYNONYMS[field].some((syn) => loose ? ((syn.includes(' ') || syn.length >= 4) && (' ' + headers[c] + ' ').includes(' ' + syn + ' ')) : headers[c] === syn);
            if (hit) { mapping[field] = c; used.add(c); break; }
          }
        });
      });
      const score = Object.keys(mapping).length;
      if (mapping.symbol !== undefined && mapping.quantity !== undefined && score > best.score) best = { headerRow: r, score, mapping, headers: rows[r] };
    }
    return best;
  }

  // Sao kê số dư thường KHÔNG có cột loại lệnh/ngày giao dịch -- dùng đặc điểm này để phân biệt với sao kê lệnh. Trả 'trades' | 'positions' | null.
  function detectKind(rows) {
    const t = SI.detectColumns(rows);
    if (t.headerRow >= 0 && t.mapping.side !== undefined && t.mapping.date !== undefined) return 'trades';
    return detectPositionColumns(rows).headerRow >= 0 ? 'positions' : null;
  }

  const SKIP_WORDS = /^(tong|total|cong|sum|tien|cash|so du tien|tong cong|grand total)/;
  // rows: bảng thô; opts: { headerRow, mapping }. Trả { rows:[{line, symbol, quantity, cost, price, value, merged}], skipped:[{line, reason}], asOf }
  function normalizePositions(rows, opts) {
    const o = opts || {}, m = o.mapping || {}, start = (o.headerRow === undefined ? 0 : o.headerRow) + 1;
    const out = [], skipped = [], by = {};
    let asOf = null;
    for (let i = start; i < rows.length; i++) {
      const row = rows[i] || [], line = i + 1;
      if (!row.some((c) => String(c == null ? '' : c).trim() !== '')) continue;
      const raw = String(row[m.symbol] == null ? '' : row[m.symbol]).trim();
      const sym = raw.toUpperCase().replace(/\s+/g, '');
      if (!raw || SKIP_WORDS.test(SI.normalize(raw))) { skipped.push({ line, reason: 'Dòng tổng hoặc không có mã' }); continue; }
      if (!/^[A-Z0-9]{1,12}$/.test(sym)) { skipped.push({ line, reason: 'Mã không hợp lệ: ' + raw }); continue; }
      const qty = SI.parseNumber(row[m.quantity]);
      if (qty === null || qty < 0) { skipped.push({ line, reason: 'Khối lượng không hợp lệ' }); continue; }
      const cost = m.cost !== undefined ? SI.parseNumber(row[m.cost]) : null, price = m.price !== undefined ? SI.parseNumber(row[m.price]) : null, value = m.value !== undefined ? SI.parseNumber(row[m.value]) : null;
      if (m.date !== undefined && !asOf) asOf = SI.parseDate(row[m.date]) || null;
      const e = by[sym];
      if (e) {                         // cùng mã nhiều dòng (nhiều tiểu khoản/lô): cộng khối lượng, giá vốn bình quân gia quyền
        const q = e.quantity + qty;
        e.cost = e.cost !== null && cost !== null && q > 0 ? (e.cost * e.quantity + cost * qty) / q : (e.cost !== null ? e.cost : cost);
        e.quantity = q; e.merged = (e.merged || 1) + 1; if (e.price === null) e.price = price; if (e.value !== null && value !== null) e.value += value;
      } else { by[sym] = { line, symbol: sym, quantity: qty, cost: cost > 0 ? cost : null, price: price > 0 ? price : null, value: value > 0 ? value : null, merged: 1 }; out.push(by[sym]); }
    }
    return { rows: out, skipped, asOf };
  }

  // ---------- 2) Số cổ phiếu app tính được tới một ngày ----------
  function positionsAsOf(txns, actions, asOf) {
    const d = iso(asOf);
    const r = PC.replayLedger((txns || []).filter((t) => !t.deleted_at && (!d || iso(t.trade_date) <= d)), (actions || []).filter((a) => !a.deleted_at && (!d || iso(a.ex_date) <= d)));
    const out = {};
    Object.keys(r.lotsBySymbol).forEach((sym) => {
      const lots = r.lotsBySymbol[sym];
      const q = lots.reduce((s, l) => s + l.quantity, 0);
      if (q <= EPS) return;
      out[sym] = { quantity: q, avgCost: lots.reduce((s, l) => s + l.quantity * l.cost, 0) / q };
    });
    return out;
  }

  // ---------- 3) So khớp số dư + gợi ý nguyên nhân ----------
  const RATIOS = [1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.5, 2, 3, 4, 5];
  function ratioHint(stmtQty, appQty) {
    if (!(stmtQty > 0) || !(appQty > 0)) return null;
    const r = stmtQty / appQty;
    const hit = RATIOS.find((x) => Math.abs(r / x - 1) < 0.003);
    if (!hit) return null;
    return hit >= 2 ? { actionType: 'split', ratio: hit, text: 'Khối lượng sao kê gấp ' + hit + ' lần sổ: có thể thiếu hành động doanh nghiệp (tách cổ phiếu ' + hit + ':1 hoặc thưởng ' + Math.round((hit - 1) * 100) + '%).' }
      : { actionType: 'stock_dividend', ratio: Math.round((hit - 1) * 1000) / 1000, text: 'Khối lượng sao kê gấp ' + hit + ' lần sổ: có thể thiếu cổ phiếu thưởng/cổ tức bằng cổ phiếu ' + Math.round((hit - 1) * 100) + '%.' };
  }
  function txnHint(sym, diff, txns, asOf) {
    const d = iso(asOf), q = Math.abs(diff);
    const same = (txns || []).filter((t) => !t.deleted_at && t.symbol === sym && (!d || iso(t.trade_date) <= d) && Math.abs(num(t.quantity) - q) < 0.5);
    if (!same.length) return null;
    const last = same[same.length - 1];
    if (diff < 0 && last.type === 'buy') return 'Sổ nhiều hơn sao kê đúng bằng lệnh MUA ' + q.toLocaleString('vi-VN') + ' cp ngày ' + iso(last.trade_date) + ': có thể lệnh này nhập trùng, nhập sai, hoặc đã bán mà chưa ghi.';
    if (diff > 0 && last.type === 'sell') return 'Sổ ít hơn sao kê đúng bằng lệnh BÁN ' + q.toLocaleString('vi-VN') + ' cp ngày ' + iso(last.trade_date) + ': có thể lệnh bán này nhập sai (thực tế chưa bán).';
    if (diff > 0 && last.type === 'buy') return 'Có lệnh mua cùng khối lượng ' + q.toLocaleString('vi-VN') + ' cp ngày ' + iso(last.trade_date) + ' trong sổ: kiểm tra xem có thiếu một lệnh mua tương tự.';
    return null;
  }

  // stmt: kết quả normalizePositions().rows; app: positionsAsOf(); opts: { asOf, txns, qtyTolerance }
  function comparePositions(stmt, app, opts) {
    const o = opts || {}, tol = o.qtyTolerance === undefined ? 0.5 : o.qtyTolerance;
    const sMap = {}; (stmt || []).forEach((r) => { sMap[r.symbol] = r; });
    const symbols = Array.from(new Set(Object.keys(sMap).concat(Object.keys(app || {})))).sort();
    const items = symbols.map((sym) => {
      const s = sMap[sym] || null, a = (app || {})[sym] || null;
      const sq = s ? s.quantity : 0, aq = a ? a.quantity : 0, diff = sq - aq;
      const item = { symbol: sym, statementQty: sq, appQty: aq, diff: diff, statementCost: s ? s.cost : null, appCost: a ? a.avgCost : null, price: s && s.price ? s.price : null, costNote: null, hints: [], fix: null, fixAction: null };
      const stmtZero = !s || sq <= tol;
      if (Math.abs(diff) <= tol || (stmtZero && aq <= tol)) { item.status = 'match'; }
      else if (!a && s) item.status = 'missing_in_app';
      else if (stmtZero && a) item.status = 'extra_in_app';
      else item.status = 'qty_diff';
      if (item.status !== 'match') {
        const rh = ratioHint(sq, aq);
        if (rh) { item.hints.push(rh.text); item.fixAction = { actionType: rh.actionType, ratio: rh.ratio }; }
        const th = txnHint(sym, diff, o.txns, o.asOf);
        if (th) item.hints.push(th);
        if (item.status === 'missing_in_app') item.hints.unshift('Sao kê có mã này nhưng sổ lệnh không có: thiếu lệnh mua' + (s && s.cost ? ' (giá vốn sao kê ' + Math.round(s.cost).toLocaleString('vi-VN') + ' đ)' : '') + '.');
        else if (item.status === 'extra_in_app') item.hints.unshift('Sổ lệnh còn giữ mã này nhưng sao kê không có: có thể đã bán mà chưa ghi lệnh bán, hoặc đã chuyển khoản.');
        else if (!rh) item.hints.unshift(diff > 0 ? 'Sao kê nhiều hơn sổ ' + diff.toLocaleString('vi-VN') + ' cp: thiếu lệnh mua hoặc thiếu hành động doanh nghiệp.' : 'Sổ nhiều hơn sao kê ' + Math.abs(diff).toLocaleString('vi-VN') + ' cp: thiếu lệnh bán hoặc nhập thừa lệnh mua.');
        // Lệnh điều chỉnh gợi ý: mua phần thiếu (giá vốn sao kê, rồi giá thị trường sao kê), bán phần thừa (giá thị trường sao kê nếu có)
        const px = diff > 0 ? (s && s.cost) || (s && s.price) || null : (s && s.price) || (a && a.avgCost) || null;
        item.fix = { type: diff > 0 ? 'buy' : 'sell', quantity: Math.abs(diff), price: px ? Math.round(px) : null };
      } else if (s && a && s.cost > 0 && a.avgCost > 0 && Math.abs(s.cost / a.avgCost - 1) * 100 > COST_TOL_PCT) {
        item.costNote = 'Giá vốn sao kê ' + Math.round(s.cost).toLocaleString('vi-VN') + ' đ khác giá vốn FIFO của sổ ' + Math.round(a.avgCost).toLocaleString('vi-VN') + ' đ (' + (s.cost > a.avgCost ? '+' : '') + ((s.cost / a.avgCost - 1) * 100).toFixed(1) + '%): khác phương pháp tính (bình quân so với FIFO) hoặc phí/thuế.';
      }
      return item;
    });
    const bad = items.filter((i) => i.status !== 'match');
    const priceOf = (i) => i.price || (i.statementCost || i.appCost) || 0;
    return {
      items, total: items.length, matched: items.length - bad.length, mismatched: bad.length,
      missingInApp: bad.filter((i) => i.status === 'missing_in_app').length, extraInApp: bad.filter((i) => i.status === 'extra_in_app').length, qtyDiff: bad.filter((i) => i.status === 'qty_diff').length,
      matchedPct: items.length ? (items.length - bad.length) / items.length * 100 : null,
      valueAtStake: bad.reduce((s, i) => s + Math.abs(i.diff) * priceOf(i), 0),
      costNotes: items.filter((i) => i.costNote).length,
    };
  }

  function compareCash(statementCash, appCash, tolerance) {
    const t = tolerance === undefined ? 1000 : tolerance;
    const s = num(statementCash), a = num(appCash), diff = s - a;
    return { statement: s, app: a, diff: diff, ok: Math.abs(diff) <= t,
      hint: Math.abs(diff) <= t ? null : (diff > 0 ? 'Sao kê có nhiều tiền hơn sổ ' + Math.round(diff).toLocaleString('vi-VN') + ' đ: chưa ghi tiền nạp, cổ tức tiền hoặc lệnh bán.' : 'Sổ có nhiều tiền hơn sao kê ' + Math.round(-diff).toLocaleString('vi-VN') + ' đ: chưa ghi tiền rút, phí hoặc lệnh mua.') };
  }

  // ---------- 4) So khớp LỆNH trong một kỳ ----------
  // stmt: kết quả StatementImport.normalizeRows().rows (mua/bán hợp lệ); app: sổ lệnh (finance_transactions). Khớp theo mã tham chiếu, rồi theo (ngày, mã, chiều, KL, giá);
  // phần còn lại ghép theo (ngày, mã, chiều) để chỉ ra lệnh LỆCH khối lượng/giá thay vì báo hai dòng rời nhau.
  function compareTrades(stmt, app, opts) {
    const rows = (stmt || []).filter((r) => (r.type === 'buy' || r.type === 'sell') && !(r.issues && r.issues.length));
    const dates = rows.map((r) => r.date).filter(Boolean).sort();
    const from = (opts && opts.from) || dates[0] || null, to = (opts && opts.to) || dates[dates.length - 1] || null;
    const inRange = (t) => !t.deleted_at && (t.type === 'buy' || t.type === 'sell') && (!from || iso(t.trade_date) >= from) && (!to || iso(t.trade_date) <= to);
    const appIn = (app || []).filter(inRange);
    const usedApp = new Set(), matched = [];
    const key = (d, sym, type, q, p) => [iso(d), String(sym).toUpperCase(), type, num(q), Math.round(num(p) * 100) / 100].join('|');
    const refIdx = {}; appIn.forEach((t, i) => { if (t.external_ref) refIdx[t.external_ref] = i; });
    const keyIdx = {}; appIn.forEach((t, i) => { (keyIdx[key(t.trade_date, t.symbol, t.type, t.quantity, t.price)] = keyIdx[key(t.trade_date, t.symbol, t.type, t.quantity, t.price)] || []).push(i); });
    const left = [];
    rows.forEach((r) => {
      let idx = -1;
      if (r.ref && refIdx[r.ref] !== undefined && !usedApp.has(refIdx[r.ref])) idx = refIdx[r.ref];
      if (idx < 0) { const k = key(r.date, r.symbol, r.type, r.quantity, r.price); const list = keyIdx[k] || []; idx = list.find((i) => !usedApp.has(i)); if (idx === undefined) idx = -1; }
      if (idx >= 0) { usedApp.add(idx); matched.push({ statement: r, app: appIn[idx] }); } else left.push(r);
    });
    const appLeft = appIn.map((t, i) => ({ t, i })).filter((x) => !usedApp.has(x.i));
    const mismatched = [], missingInApp = [];
    left.forEach((r) => {
      const j = appLeft.findIndex((x) => iso(x.t.trade_date) === r.date && String(x.t.symbol).toUpperCase() === r.symbol && x.t.type === r.type);
      if (j >= 0) {
        const t = appLeft[j].t; appLeft.splice(j, 1);
        const reasons = [];
        if (Math.abs(num(t.quantity) - r.quantity) > 0.5) reasons.push('khối lượng sao kê ' + r.quantity.toLocaleString('vi-VN') + ' ≠ sổ ' + num(t.quantity).toLocaleString('vi-VN'));
        if (Math.abs(num(t.price) - r.price) > 0.5) reasons.push('giá sao kê ' + Math.round(r.price).toLocaleString('vi-VN') + ' ≠ sổ ' + Math.round(num(t.price)).toLocaleString('vi-VN'));
        mismatched.push({ statement: r, app: t, reasons });
      } else missingInApp.push(r);
    });
    const extraInApp = appLeft.map((x) => x.t);
    const total = rows.length;
    return { from, to, total, matched, mismatched, missingInApp, extraInApp, matchedPct: total ? matched.length / total * 100 : null, ok: !mismatched.length && !missingInApp.length && !extraInApp.length, appInRange: appIn.length };
  }

  // Tóm tắt gọn để lưu nhật ký đối soát
  function summarize(kind, result, extra) {
    const r = result || {};
    const base = kind === 'positions'
      ? { matched: r.matched, mismatched: r.mismatched, total: r.total, valueAtStake: Math.round(r.valueAtStake || 0), items: (r.items || []).filter((i) => i.status !== 'match').slice(0, 50).map((i) => ({ symbol: i.symbol, status: i.status, statementQty: i.statementQty, appQty: i.appQty })) }
      : { matched: (r.matched || []).length, mismatched: (r.mismatched || []).length + (r.missingInApp || []).length + (r.extraInApp || []).length, total: r.total, missingInApp: (r.missingInApp || []).length, extraInApp: (r.extraInApp || []).length, differing: (r.mismatched || []).length, from: r.from, to: r.to };
    return Object.assign(base, extra || {});
  }

  // Đã lâu chưa đối soát? lastAsOf = ngày sao kê của lần đối soát gần nhất (rỗng = chưa bao giờ)
  function staleness(lastAsOf, today) {
    if (!lastAsOf) return { level: 'never', days: null, text: 'Chưa đối soát lần nào' };
    const d = daysBetween(lastAsOf, today);
    return { level: d > STALE_DAYS ? 'stale' : 'ok', days: d, text: d <= 0 ? 'Hôm nay' : d + ' ngày trước' };
  }

  return { STALE_DAYS, detectPositionColumns, detectKind, normalizePositions, positionsAsOf, comparePositions, compareCash, compareTrades, summarize, staleness, ratioHint };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Reconcile;
