// Logic thuần: tổng hợp cấp nhóm -- gộp danh mục của các thành viên thành một danh mục chung, mức trùng lặp giữa các thành viên, chuỗi NAV chung,
// bảng so sánh thành viên. KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global GroupCalc) và module.exports cho Vitest.
// Cần PortfolioCalc (lib/portfolio-calc.js), FinCalc (lib/finance-calc.js) nạp trước; PerfCalc (lib/perf-calc.js) khi so sánh hiệu quả.
//
// Quy ước: mỗi thành viên có sổ lệnh riêng (finance_transactions.user_id). Số cổ phiếu của từng người được tính lại bằng đúng FIFO + hành động
// doanh nghiệp của PortfolioCalc.replayLedger; giá thị trường lấy theo từng mã, ưu tiên giá cập nhật mới nhất giữa các thành viên (mỗi người có
// bản ghi giá riêng do cùng một bộ lấy giá cập nhật nên thường giống nhau).
const GroupCalc = (function () {
  const PC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./portfolio-calc.js') : PortfolioCalc;
  const FC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./finance-calc.js') : FinCalc;
  const PF = (typeof require === 'function' && typeof module !== 'undefined') ? require('./perf-calc.js') : (typeof PerfCalc !== 'undefined' ? PerfCalc : null);
  const EPS = 1e-9;

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function iso(v) { return String(v || '').slice(0, 10); }

  function displayName(m) {
    if (m.nickname) return m.nickname;
    return String(m.email || '').split('@')[0] || 'Thành viên';
  }

  // Giá theo mã: ưu tiên bản ghi mới nhất (price_date rồi updated_at), bỏ giá <= 0
  function priceMap(priceRows) {
    const best = {};
    (priceRows || []).forEach(function (p) {
      const price = num(p.market_price);
      if (!(price > 0) || !p.symbol) return;
      const key = (iso(p.price_date) || '0000') + '|' + String(p.updated_at || '');
      const cur = best[p.symbol];
      if (!cur || key > cur.key) best[p.symbol] = { key: key, price: price, date: iso(p.price_date) || null };
    });
    const out = {};
    Object.keys(best).forEach(function (s) { out[s] = best[s].price; });
    return out;
  }

  // Danh mục hiện tại của từng thành viên. input: { members:[{id,email,nickname}], txns, actions, prices, assets }
  // Trả [{ id, email, name, nav, marketValue, cash, debt, holdings:[{symbol, quantity, avgCost, price, value, weightPct, unrealizedPct, noPrice}] }]
  function memberPortfolios(input) {
    const prices = priceMap(input.prices);
    const byUser = function (rows) { const m = {}; (rows || []).forEach(function (r) { (m[r.user_id] = m[r.user_id] || []).push(r); }); return m; };
    const txnsBy = byUser((input.txns || []).filter(function (t) { return !t.deleted_at; })), actsBy = byUser((input.actions || []).filter(function (a) { return !a.deleted_at; }));
    const assetOf = {}; (input.assets || []).forEach(function (a) { assetOf[a.user_id] = a; });
    return (input.members || []).map(function (m) {
      const r = PC.replayLedger(txnsBy[m.id] || [], actsBy[m.id] || []);
      const holdings = [];
      Object.keys(r.lotsBySymbol).forEach(function (sym) {
        const lots = r.lotsBySymbol[sym];
        const qty = lots.reduce(function (s, l) { return s + l.quantity; }, 0);
        if (qty <= EPS) return;
        const cost = lots.reduce(function (s, l) { return s + l.quantity * l.cost; }, 0);
        const price = prices[sym] || 0;
        holdings.push({ symbol: sym, quantity: qty, avgCost: cost / qty, price: price, value: qty * price, noPrice: !(price > 0), unrealizedPct: price > 0 && cost > 0 ? (qty * price / cost - 1) * 100 : null });
      });
      const mv = holdings.reduce(function (s, h) { return s + h.value; }, 0);
      holdings.forEach(function (h) { h.weightPct = mv > 0 ? h.value / mv * 100 : 0; });
      holdings.sort(function (a, b) { return b.value - a.value; });
      const a = assetOf[m.id] || {};
      const cash = num(a.cash), debt = num(a.debt);
      return { id: m.id, email: m.email, name: displayName(m), cash: cash, debt: debt, marketValue: mv, nav: mv + cash - debt, holdings: holdings };
    });
  }

  // Gộp: mã -> tổng số lượng, giá trị, ai đang giữ. Trả { symbols, marketValue, cash, debt, nav, holdersOverlap }
  function consolidate(portfolios) {
    const bySym = {};
    let cash = 0, debt = 0, mv = 0;
    portfolios.forEach(function (p) {
      cash += p.cash; debt += p.debt; mv += p.marketValue;
      p.holdings.forEach(function (h) {
        const s = bySym[h.symbol] || (bySym[h.symbol] = { symbol: h.symbol, sector: FC.sectorOf(h.symbol), quantity: 0, value: 0, price: h.price, holders: [], costValue: 0 });
        s.quantity += h.quantity; s.value += h.value; s.costValue += h.quantity * h.avgCost;
        if (h.price > 0) s.price = h.price;
        s.holders.push({ id: p.id, name: p.name, quantity: h.quantity, value: h.value, weightInMemberPct: h.weightPct });
      });
    });
    const symbols = Object.keys(bySym).map(function (k) {
      const s = bySym[k];
      s.weightPct = mv > 0 ? s.value / mv * 100 : 0;
      s.holderCount = s.holders.length;
      s.avgCost = s.quantity > 0 ? s.costValue / s.quantity : 0;
      s.unrealizedPct = s.price > 0 && s.costValue > 0 ? (s.value / s.costValue - 1) * 100 : null;
      s.holders.sort(function (a, b) { return b.value - a.value; });
      s.topHolderSharePct = s.value > 0 ? s.holders[0].value / s.value * 100 : 0;
      return s;
    }).sort(function (a, b) { return b.value - a.value; });
    const shared = symbols.filter(function (s) { return s.holderCount >= 2; });
    return {
      symbols: symbols, marketValue: mv, cash: cash, debt: debt, nav: mv + cash - debt,
      sharedCount: shared.length, sharedValuePct: mv > 0 ? shared.reduce(function (s, x) { return s + x.value; }, 0) / mv * 100 : 0,
    };
  }

  // Mức trùng danh mục giữa từng cặp thành viên = tổng min(tỷ trọng) trên các mã chung (0-100%). Trả { names, matrix, avgPct, pairs }
  function overlap(portfolios) {
    const ps = portfolios.filter(function (p) { return p.holdings.length; });
    const matrix = ps.map(function (a) {
      return ps.map(function (b) {
        if (a === b) return 100;
        const wb = {}; b.holdings.forEach(function (h) { wb[h.symbol] = h.weightPct; });
        return a.holdings.reduce(function (s, h) { return s + Math.min(h.weightPct, wb[h.symbol] || 0); }, 0);
      });
    });
    const pairs = [];
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const common = ps[i].holdings.filter(function (h) { return ps[j].holdings.some(function (g) { return g.symbol === h.symbol; }); }).map(function (h) { return h.symbol; });
      pairs.push({ a: ps[i].name, b: ps[j].name, overlapPct: matrix[i][j], common: common });
    }
    pairs.sort(function (x, y) { return y.overlapPct - x.overlapPct; });
    return { names: ps.map(function (p) { return p.name; }), matrix: matrix, pairs: pairs, avgPct: pairs.length ? pairs.reduce(function (s, p) { return s + p.overlapPct; }, 0) / pairs.length : null };
  }

  // Chuỗi NAV chung theo ngày: cộng NAV và vốn nạp ròng của mọi thành viên; ngày thành viên không có bản ghi thì giữ giá trị gần nhất trước đó
  // (thành viên chưa bắt đầu = 0). navRows: dòng finance_nav_history của mọi người (có user_id).
  function groupNavHistory(navRows) {
    const rows = (navRows || []).filter(function (r) { return r.user_id && r.snapshot_date; });
    const dates = Array.from(new Set(rows.map(function (r) { return iso(r.snapshot_date); }))).sort();
    const byUser = {};
    rows.forEach(function (r) { (byUser[r.user_id] = byUser[r.user_id] || []).push({ d: iso(r.snapshot_date), nav: num(r.nav), net: num(r.net_contributed), cash: num(r.cash), mv: num(r.market_value) }); });
    Object.keys(byUser).forEach(function (u) { byUser[u].sort(function (a, b) { return a.d < b.d ? -1 : 1; }); });
    const cursor = {}, last = {};
    const out = [];
    dates.forEach(function (d) {
      let nav = 0, net = 0, cash = 0, mv = 0, n = 0;
      Object.keys(byUser).forEach(function (u) {
        const arr = byUser[u];
        let k = cursor[u] || 0;
        while (k < arr.length && arr[k].d <= d) { last[u] = arr[k]; k++; }
        cursor[u] = k;
        if (last[u]) { nav += last[u].nav; net += last[u].net; cash += last[u].cash; mv += last[u].mv; n++; }
      });
      out.push({ snapshot_date: d, nav: nav, net_contributed: net, cash: cash, market_value: mv, members: n });
    });
    return out;
  }

  // Bảng so sánh thành viên. perf: { [userId]: kết quả PerfCalc.analyze } (có thể thiếu). Trả các dòng + tổng nhóm.
  function memberTable(portfolios, perf, group) {
    const total = portfolios.reduce(function (s, p) { return s + p.nav; }, 0);
    return portfolios.map(function (p) {
      const a = perf && perf[p.id] ? perf[p.id] : null;
      const top = p.holdings[0];
      return {
        id: p.id, name: p.name, email: p.email, nav: p.nav, sharePct: total > 0 ? p.nav / total * 100 : 0, holdingCount: p.holdings.length,
        topSymbol: top ? top.symbol : null, topWeightPct: top ? top.weightPct : null, cashPct: p.nav > 0 ? p.cash / p.nav * 100 : null,
        leverage: p.nav > 0 && p.debt > 0 ? p.marketValue / p.nav : null,
        returnPct: a && a.ok ? a.cumulativePct : null, excessPct: a && a.ok && a.hasBench ? a.excessCumulativePct : null,
        alphaPct: a && a.ok && a.enough && a.hasBench ? a.alphaPct : null, beta: a && a.ok && a.enough && a.hasBench ? a.beta : null,
        sharpe: a && a.ok && a.enough ? a.sharpe : null, maxDD: a && a.ok ? a.maxDD : null, volatilityPct: a && a.ok && a.enough ? a.volatilityPct : null,
        informationRatio: a && a.ok && a.enough && a.hasBench ? a.informationRatio : null, periods: a ? a.periods : 0, enough: !!(a && a.enough),
        // đóng góp của thành viên vào hiệu quả chung: tỷ trọng NAV × lợi suất của họ
        contributionPct: a && a.ok && total > 0 ? p.nav / total * a.cumulativePct : null,
        overlapWithGroupPct: group ? overlapWithGroup(p, group) : null,
      };
    });
  }

  // Phần danh mục của thành viên trùng với mã mà người khác cũng giữ (theo giá trị của thành viên đó)
  function overlapWithGroup(p, group) {
    if (!(p.marketValue > 0)) return null;
    const shared = {};
    group.symbols.forEach(function (s) { if (s.holderCount >= 2) shared[s.symbol] = true; });
    return p.holdings.reduce(function (s, h) { return s + (shared[h.symbol] ? h.value : 0); }, 0) / p.marketValue * 100;
  }

  // ---- Sổ lệnh chung của nhóm ----
  // Lệnh của mọi thành viên trong khoảng ngày, kèm tên người, giá trị, và ngoại lệ giới hạn đã ghi cho lệnh đó (nếu có).
  // input: { members, txns }; opts: { from, to (YYYY-MM-DD, gồm cả hai đầu), userId, symbol, side: 'buy'|'sell', exceptions: [finance_limit_exceptions] }
  function blotter(input, opts) {
    const o = opts || {};
    const nameOf = {}; (input.members || []).forEach(function (m) { nameOf[m.id] = displayName(m); });
    const exByTxn = {}, exByBatch = {};
    (o.exceptions || []).forEach(function (e) {
      if (e.txn_id) (exByTxn[e.txn_id] = exByTxn[e.txn_id] || []).push(e);
      else if (e.metrics && e.metrics.importBatch) (exByBatch[e.user_id + '|' + e.metrics.importBatch] = exByBatch[e.user_id + '|' + e.metrics.importBatch] || []).push(e);
    });
    const sym = o.symbol ? String(o.symbol).toUpperCase() : null;
    return (input.txns || []).filter(function (t) {
      if (t.deleted_at) return false;
      const d = iso(t.trade_date);
      if (o.from && d < o.from) return false;
      if (o.to && d > o.to) return false;
      if (o.userId && t.user_id !== o.userId) return false;
      if (sym && String(t.symbol).toUpperCase() !== sym) return false;
      if (o.side && t.type !== o.side) return false;
      return t.type === 'buy' || t.type === 'sell';
    }).map(function (t) {
      const ex = (exByTxn[t.id] || []).concat(t.import_batch ? (exByBatch[t.user_id + '|' + t.import_batch] || []) : []);
      return {
        id: t.id, date: iso(t.trade_date), createdAt: t.created_at || null, userId: t.user_id, name: nameOf[t.user_id] || 'Thành viên',
        type: t.type, symbol: String(t.symbol).toUpperCase(), quantity: num(t.quantity), price: num(t.price), value: num(t.quantity) * num(t.price),
        fee: num(t.fee), tax: num(t.tax), note: t.note || '', imported: !!t.import_batch,
        exception: ex.length ? { reason: ex[0].reason, mode: ex[0].mode, override: ex.some(function (e) { return e.override; }), count: ex.length } : null,
      };
    }).sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : String(b.createdAt || '') < String(a.createdAt || '') ? -1 : 1); });
  }

  // Dòng giao dịch của nhóm trong kỳ: mã nào nhiều người cùng mua/bán (đồng thuận) hay mua bán trái chiều, và mức hoạt động của từng thành viên.
  // rows = kết quả blotter(); portfolios = memberPortfolios() để lấy NAV hiện tại tính vòng quay.
  function flow(rows, portfolios) {
    const bySym = {}, byMember = {};
    const navOf = {}; (portfolios || []).forEach(function (p) { navOf[p.id] = p.nav; byMember[p.id] = { id: p.id, name: p.name, nav: p.nav, trades: 0, buyValue: 0, sellValue: 0, symbols: {}, exceptions: 0 }; });
    let buyValue = 0, sellValue = 0;
    (rows || []).forEach(function (r) {
      const s = (bySym[r.symbol] = bySym[r.symbol] || { symbol: r.symbol, sector: FC.sectorOf(r.symbol), buyers: {}, sellers: {}, buyValue: 0, sellValue: 0, trades: 0 });
      const m = (byMember[r.userId] = byMember[r.userId] || { id: r.userId, name: r.name, nav: 0, trades: 0, buyValue: 0, sellValue: 0, symbols: {}, exceptions: 0 });
      s.trades++; m.trades++; m.symbols[r.symbol] = true;
      if (r.exception) m.exceptions++;
      if (r.type === 'buy') { s.buyers[r.userId] = r.name; s.buyValue += r.value; m.buyValue += r.value; buyValue += r.value; }
      else { s.sellers[r.userId] = r.name; s.sellValue += r.value; m.sellValue += r.value; sellValue += r.value; }
    });
    const symbols = Object.keys(bySym).map(function (k) {
      const s = bySym[k];
      const buyers = Object.keys(s.buyers).map(function (u) { return s.buyers[u]; }), sellers = Object.keys(s.sellers).map(function (u) { return s.sellers[u]; });
      const opposite = Object.keys(s.buyers).some(function (u) { return Object.keys(s.sellers).some(function (v) { return u !== v; }); });
      const stance = opposite ? 'conflict' : (buyers.length >= 2 && !sellers.length ? 'consensus_buy' : (sellers.length >= 2 && !buyers.length ? 'consensus_sell' : (buyers.length && !sellers.length ? 'buy' : (sellers.length && !buyers.length ? 'sell' : 'mixed'))));
      return { symbol: s.symbol, sector: s.sector, buyers: buyers, sellers: sellers, buyValue: s.buyValue, sellValue: s.sellValue, net: s.buyValue - s.sellValue, traded: s.buyValue + s.sellValue, trades: s.trades, stance: stance };
    }).sort(function (a, b) { return b.traded - a.traded; });
    const members = Object.keys(byMember).map(function (k) {
      const m = byMember[k];
      return { id: m.id, name: m.name, nav: m.nav, trades: m.trades, buyValue: m.buyValue, sellValue: m.sellValue, net: m.buyValue - m.sellValue, symbolCount: Object.keys(m.symbols).length, exceptions: m.exceptions,
        turnoverPct: m.nav > 0 ? (m.buyValue + m.sellValue) / 2 / m.nav * 100 : null };
    }).sort(function (a, b) { return b.buyValue + b.sellValue - (a.buyValue + a.sellValue); });
    return { symbols: symbols, members: members, totals: { trades: (rows || []).length, buyValue: buyValue, sellValue: sellValue, net: buyValue - sellValue },
      consensusBuy: symbols.filter(function (s) { return s.stance === 'consensus_buy'; }), consensusSell: symbols.filter(function (s) { return s.stance === 'consensus_sell'; }), conflicts: symbols.filter(function (s) { return s.stance === 'conflict'; }) };
  }

  return { displayName, priceMap, memberPortfolios, consolidate, overlap, groupNavHistory, memberTable, overlapWithGroup, blotter, flow };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GroupCalc;
