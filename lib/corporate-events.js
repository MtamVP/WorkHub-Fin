// Logic thuần: đối chiếu sự kiện doanh nghiệp từ nguồn thị trường (Edge Function stock-events) với sổ lệnh của người dùng
// để gợi ý "bạn được nhận gì, đã ghi chưa". KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global CorporateEvents)
// và module.exports cho Vitest. Cần PortfolioCalc (lib/portfolio-calc.js) nạp trước.
//
// Quy ước:
//  - Số cổ phiếu được hưởng quyền = số đang giữ khi KẾT THÚC NGÀY TRƯỚC ngày giao dịch không hưởng quyền (exDate): lệnh có
//    trade_date < exDate. Các hành động doanh nghiệp đã ghi trước exDate được tính vào (ví dụ đã nhận cổ phiếu thưởng đợt trước).
//  - Cổ tức tiền: nguồn công bố số tiền GỘP (đ/cp). Thuế TNCN 5% khấu trừ tại nguồn -> tiền thực nhận = gộp x 95%.
//  - Cổ tức bằng cổ phiếu / cổ phiếu thưởng: ratio = % (15 = 100:15) -> hệ số 1,15; ghi vào sổ như hành động 'stock_dividend'.
//  - Phát hành thêm cho cổ đông hiện hữu: chỉ THÔNG TIN (đóng tiền mua hay không là quyết định của người dùng), không tự ghi.
//  - Sự kiện chưa tới hạn (exDate/ngày thanh toán ở tương lai) hiện là 'upcoming', chưa cho ghi: ghi cổ phiếu thưởng trước ngày
//    giao dịch không hưởng quyền sẽ làm sổ lệnh nhân khối lượng sớm; ghi cổ tức tiền trước ngày thanh toán sẽ cộng tiền chưa có.
const CorporateEvents = (function () {
  const PC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./portfolio-calc.js') : PortfolioCalc;

  const CASH_TAX_RATE = 0.05;
  const EPS = 1e-9;
  const KIND_LABEL = { cash_dividend: 'Cổ tức tiền', stock_dividend: 'Cổ tức bằng cổ phiếu', bonus: 'Cổ phiếu thưởng', rights: 'Quyền mua phát hành thêm' };

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function iso(v) { return String(v || '').slice(0, 10); }
  function addDays(isoDate, n) {
    const d = new Date(isoDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Khối lượng đang giữ của symbol vào cuối ngày trước exDate (theo FIFO + hành động doanh nghiệp đã ghi).
  function entitledQuantity(symbol, exDate, txns, actions) {
    const t = (txns || []).filter(function (x) { return x.symbol === symbol && iso(x.trade_date) < exDate; });
    if (!t.length) return 0;
    const a = (actions || []).filter(function (x) { return x.symbol === symbol && iso(x.ex_date) < exDate; });
    const r = PC.replayLedger(t, a);
    return (r.lotsBySymbol[symbol] || []).reduce(function (s, l) { return s + l.quantity; }, 0);
  }

  // Ghi chú gắn vào bản ghi để lần sau nhận ra sự kiện đã xử lý ("#<id>" là khoá đối chiếu).
  function noteFor(ev) {
    return '[Tự gợi ý từ sự kiện #' + ev.id + '] ' + (ev.note || KIND_LABEL[ev.kind]);
  }
  function hasTag(note, id) { return String(note || '').indexOf('#' + id) !== -1; }

  function cashRecorded(ev, qty, flows, taxRate) {
    const gross = qty * num(ev.dps);
    const net = gross * (1 - taxRate);
    const lo = addDays(ev.exDate, -5), hi = addDays(ev.payDate || ev.exDate, 45);
    return (flows || []).find(function (f) {
      if (f.flow_type !== 'dividend' || f.symbol !== ev.symbol || f.deleted_at) return false;
      if (hasTag(f.note, ev.id)) return true;
      const d = iso(f.flow_date);
      if (d < lo || d > hi) return false;
      const amt = num(f.amount);
      const tol = function (x) { return Math.max(1000, x * 0.015); };
      return Math.abs(amt - gross) <= tol(gross) || Math.abs(amt - net) <= tol(net);
    }) || null;
  }

  function stockRecorded(ev, actions) {
    const r = num(ev.ratio) / 100;
    return (actions || []).find(function (a) {
      if (a.symbol !== ev.symbol || a.deleted_at || a.action_type !== 'stock_dividend') return false;
      if (hasTag(a.note, ev.id)) return true;
      const gap = Math.abs((new Date(iso(a.ex_date) + 'T00:00:00Z') - new Date(ev.exDate + 'T00:00:00Z')) / 86400000);
      return gap <= 7 && Math.abs(num(a.ratio) - r) < 1e-6;
    }) || null;
  }

  // 1 sự kiện -> gợi ý. ctx: { today, txns, actions, cashFlows, dismissed: Set|array id, taxRate }
  function planFor(ev, ctx) {
    const today = ctx.today || new Date().toISOString().slice(0, 10);
    const taxRate = ctx.taxRate === undefined ? CASH_TAX_RATE : ctx.taxRate;
    const dismissed = ctx.dismissed instanceof Set ? ctx.dismissed : new Set(ctx.dismissed || []);
    const qty = entitledQuantity(ev.symbol, ev.exDate, ctx.txns, ctx.actions);
    const out = { event: ev, kind: ev.kind, label: KIND_LABEL[ev.kind], symbol: ev.symbol, quantity: qty, status: 'pending', due: null };

    if (qty <= EPS) { out.status = 'not_held'; return out; }
    if (dismissed.has(ev.id)) { out.status = 'dismissed'; return out; }

    if (ev.kind === 'cash_dividend') {
      const gross = Math.round(qty * num(ev.dps));
      out.dps = num(ev.dps); out.gross = gross; out.taxRate = taxRate;
      out.net = Math.round(gross * (1 - taxRate));
      out.flowDate = ev.payDate || ev.exDate;
      const rec = cashRecorded(ev, qty, ctx.cashFlows, taxRate);
      if (rec) { out.status = 'recorded'; out.recordedAmount = num(rec.amount); return out; }
      if (out.flowDate > today) { out.status = 'upcoming'; out.due = out.flowDate; }
      return out;
    }

    if (ev.kind === 'stock_dividend' || ev.kind === 'bonus') {
      const r = num(ev.ratio) / 100;
      out.ratioPct = num(ev.ratio); out.multiplier = 1 + r;
      out.bonusShares = Math.floor(qty * r + 1e-9);
      out.quantityAfter = qty + out.bonusShares;
      const rec = stockRecorded(ev, ctx.actions);
      if (rec) { out.status = 'recorded'; return out; }
      if (ev.exDate > today) { out.status = 'upcoming'; out.due = ev.exDate; }
      return out;
    }

    // rights: chỉ thông tin
    out.ratioPct = num(ev.ratio);
    out.rightsShares = Math.floor(qty * num(ev.ratio) / 100 + 1e-9);
    out.issuePrice = num(ev.price);
    out.cost = Math.round(out.rightsShares * out.issuePrice);
    out.status = 'info';
    out.deadline = ev.payDate || null;
    return out;
  }

  // Danh sách gợi ý đã sắp xếp: cần xử lý (mới nhất trước) -> sắp tới -> thông tin -> đã ghi -> đã ẩn. Bỏ mã không nắm.
  function suggest(events, ctx) {
    const ORDER = { pending: 0, upcoming: 1, info: 2, recorded: 3, dismissed: 4 };
    // Xử lý theo thứ tự thời gian và coi cổ phiếu thưởng CHƯA ghi như đã ghi khi tính quyền của các sự kiện SAU nó
    // (cổ tức tiền sau đợt thưởng được tính trên số cổ phiếu đã tăng). Bản ghi ảo chỉ dùng để tính, không lưu.
    const virtualActions = (ctx.actions || []).slice();
    const asc = (events || []).slice().sort(function (a, b) { return a.exDate < b.exDate ? -1 : (a.exDate > b.exDate ? 1 : (a.id < b.id ? -1 : 1)); });
    const plans = [];
    asc.forEach(function (e) {
      const p = planFor(e, Object.assign({}, ctx, { actions: virtualActions }));
      plans.push(p);
      if ((p.status === 'pending' || p.status === 'upcoming') && (e.kind === 'stock_dividend' || e.kind === 'bonus')) {
        virtualActions.push({ symbol: e.symbol, action_type: 'stock_dividend', ratio: num(e.ratio) / 100, ex_date: e.exDate, created_at: e.exDate + 'T00:00:00Z' });
      }
    });
    const items = plans.filter(function (p) { return p.status !== 'not_held'; });
    items.sort(function (a, b) {
      if (ORDER[a.status] !== ORDER[b.status]) return ORDER[a.status] - ORDER[b.status];
      return a.event.exDate < b.event.exDate ? 1 : (a.event.exDate > b.event.exDate ? -1 : 0);
    });
    const summary = { pending: 0, upcoming: 0, info: 0, recorded: 0, dismissed: 0, pendingCash: 0, pendingBonusSymbols: [] };
    items.forEach(function (p) {
      summary[p.status]++;
      if (p.status === 'pending' && p.kind === 'cash_dividend') summary.pendingCash += p.net;
      if (p.status === 'pending' && p.kind !== 'cash_dividend' && summary.pendingBonusSymbols.indexOf(p.symbol) === -1) summary.pendingBonusSymbols.push(p.symbol);
    });
    return { items: items, summary: summary };
  }

  // Các mã và ngày bắt đầu cần hỏi nguồn: mọi mã từng có giao dịch, từ ngày giao dịch đầu tiên.
  function queryScope(txns) {
    const symbols = {};
    let since = null;
    (txns || []).forEach(function (t) {
      if (!t.symbol) return;
      symbols[t.symbol] = true;
      const d = iso(t.trade_date);
      if (d && (!since || d < since)) since = d;
    });
    return { symbols: Object.keys(symbols).sort(), since: since };
  }

  // Bản ghi để lưu: cổ tức tiền -> tham số cho API.asset.cashFlow.add; cổ phiếu -> API.asset.corporateAction.add
  function toRecord(plan, opts) {
    const o = opts || {};
    const ev = plan.event;
    if (ev.kind === 'cash_dividend') {
      const useNet = o.afterTax !== false;
      const amount = useNet ? plan.net : plan.gross;
      return { type: 'cashFlow', flow: { flowType: 'dividend', amount: amount, flowDate: plan.flowDate, symbol: ev.symbol,
        note: noteFor(ev) + (useNet ? ' · đã trừ thuế TNCN ' + Math.round(plan.taxRate * 100) + '%' : ' · chưa trừ thuế') } };
    }
    if (ev.kind === 'stock_dividend' || ev.kind === 'bonus') {
      return { type: 'corporateAction', action: { symbol: ev.symbol, actionType: 'stock_dividend', ratio: num(ev.ratio) / 100, exDate: ev.exDate, note: noteFor(ev) } };
    }
    return null;
  }

  return { entitledQuantity, planFor, suggest, queryScope, toRecord, noteFor, CASH_TAX_RATE, KIND_LABEL };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CorporateEvents;
