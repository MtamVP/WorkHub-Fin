// Cầu nối Bàn Tài Sản (Fin) -> web kế toán (OnyxLine Accounting): đổi sổ lệnh, cổ tức, dòng tiền và giá thị trường thành BÚT TOÁN ĐỀ XUẤT
// theo Thông tư 200 (chứng khoán kinh doanh, TK 121). Logic thuần (không đụng DOM/Supabase/mạng), nạp bằng thẻ <script> thường
// (global AccountingBridge) và module.exports cho Vitest. Cần PortfolioCalc (lib/portfolio-calc.js) nạp trước.
// BẢN SAO GIỐNG HỆT nằm ở onyxline-accounting/src/accounting-bridge.js -- sửa ở Fin rồi chép sang (tests/unit/accounting-bridge.test.js giữ hai bên khớp).
//
// Nguyên tắc ghi sổ (TT200):
//  - Mua: Nợ 121 (giá gốc = giá mua + phí mua) / Có 1121. Tuỳ chọn buyFeePolicy:'expense' đưa phí mua vào 635 thay vì giá gốc.
//  - Bán: Nợ 1121 (tiền thu - phí - thuế) + Nợ 635 (phí + thuế + lỗ) / Có 121 (giá vốn FIFO) + Có 515 (lãi). Giá vốn lấy từ FIFO của Fin.
//  - Cổ tức tiền: Nợ 1121 / Có 515. Cổ phiếu thưởng, chia tách: KHÔNG có bút toán (chỉ đổi số lượng và giá vốn bình quân).
//  - Nạp / rút tiền: Nợ 1121 / Có 4111 và ngược lại (tài khoản đối ứng chỉnh được).
//  - Cuối kỳ: dự phòng giảm giá CK kinh doanh = tổng max(0, giá gốc - giá trị thị trường) theo từng mã; chênh với số dư TK 2291 đang có trong sổ
//    thì trích thêm (Nợ 635 / Có 2291) hoặc hoàn nhập (Nợ 2291 / Có 635).
// Mọi bút toán chỉ là ĐỀ XUẤT: web kế toán đưa vào hàng đợi duyệt (người lập != người duyệt), không ghi thẳng vào sổ cái.
const AccountingBridge = (function () {
  const PC = (typeof PortfolioCalc !== 'undefined') ? PortfolioCalc : (typeof require !== 'undefined' ? require('./portfolio-calc.js') : null);
  const EPS = 1e-9;

  const DEFAULT_ACCOUNTS = { cash: '1121', securities: '121', provision: '2291', capital: '4111', finIncome: '515', finExpense: '635' };
  const VOUCHER_TYPE = 'Đầu tư chứng khoán';
  const ID_CODE = { buy: 'MUA', sell: 'BAN', dividend: 'CT', deposit: 'NAP', withdrawal: 'RUT', provision: 'DP' };
  const KIND_LABEL = {
    buy: 'Mua chứng khoán', sell: 'Bán chứng khoán', dividend: 'Cổ tức tiền mặt',
    deposit: 'Nạp tiền vào tài khoản đầu tư', withdrawal: 'Rút tiền khỏi tài khoản đầu tư', provision: 'Dự phòng giảm giá chứng khoán kinh doanh',
  };

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function int(v) { const n = num(v); return Math.sign(n) * Math.round(Math.abs(n)); }
  function day(v) { return String(v || '').slice(0, 10); }
  function vn(n) { return Math.round(num(n)).toLocaleString('vi-VN'); }
  function dmy(iso) { const s = day(iso); return s ? s.split('-').reverse().join('/') : ''; }
  // Mã chứng từ dùng TOÀN BỘ mã gốc (bỏ gạch ngang), không cắt: cắt ngắn có thể trùng khi nhiều lệnh nhập cùng lúc có chung đầu mã, và trùng mã nghĩa là lệnh sau bị coi là 'đã gửi'.
  function short(id) { return String(id == null ? '' : id).replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
  function lastDayOfMonth(ym) { const [y, m] = String(ym).split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }

  // Khoảng thời gian từ nhãn: 'YYYY-MM' -> cả tháng; 'YYYY' -> cả năm; 'YYYY-Qn' -> quý.
  function periodRange(label) {
    const s = String(label || '').trim();
    let m;
    if ((m = /^(\d{4})-(\d{2})$/.exec(s))) return { from: m[1] + '-' + m[2] + '-01', to: lastDayOfMonth(s) };
    if ((m = /^(\d{4})-Q([1-4])$/i.exec(s))) { const q = Number(m[2]); const a = String((q - 1) * 3 + 1).padStart(2, '0'); const b = String(q * 3).padStart(2, '0'); return { from: m[1] + '-' + a + '-01', to: lastDayOfMonth(m[1] + '-' + b) }; }
    if ((m = /^(\d{4})$/.exec(s))) return { from: m[1] + '-01-01', to: m[1] + '-12-31' };
    return null;
  }

  function line(account, side, amount) { return { account: String(account), side: side, amount: int(amount) }; }
  // Gộp dòng cùng tài khoản + cùng bên, bỏ dòng 0 (web kế toán từ chối dòng không dương).
  function tidy(lines) {
    const out = [];
    lines.forEach((l) => {
      if (!(l.amount > 0)) return;
      const hit = out.find((x) => x.account === l.account && x.side === l.side);
      if (hit) hit.amount += l.amount; else out.push({ account: l.account, side: l.side, amount: l.amount });
    });
    return out;
  }
  function totals(lines) {
    return lines.reduce((t, l) => { if (l.side === 'N') t.debit += l.amount; else t.credit += l.amount; return t; }, { debit: 0, credit: 0 });
  }
  function isBalanced(lines) {
    if (!lines || lines.length < 2) return false;
    const t = totals(lines);
    return t.debit === t.credit && t.debit > 0;
  }

  function mk(kind, refId, date, memo, lines, meta, idOverride) {
    const clean = tidy(lines);
    return {
      key: kind + ':' + refId,
      id: idOverride || ('FIN-' + ID_CODE[kind] + '-' + short(refId)),
      kind, date: day(date), type: VOUCHER_TYPE,
      memo: ('[Fin] ' + memo).slice(0, 280),
      lines: clean, total: totals(clean).debit, balanced: isBalanced(clean), meta: meta || {},
    };
  }

  // ---------------------------------------------------------------------------------------------
  // input: {
  //   txns, actions, flows,         // dòng thô từ finance_transactions / finance_corporate_actions / finance_cash_flows (đã bỏ deleted_at)
  //   from, to,                     // 'YYYY-MM-DD' (hoặc dùng period: 'YYYY-MM' | 'YYYY-Qn' | 'YYYY')
  //   prices: { SYMBOL: giáThịTrườngTạiNgàyTo },   // để tính dự phòng và giá trị hợp lý
  //   books: { provision: số dư CÓ của TK dự phòng trong sổ kế toán, securities: số dư NỢ TK 121 }, // để đối soát / tính phần trích thêm
  //   accounts, buyFeePolicy: 'capitalize' | 'expense', depositCounter: mã TK đối ứng nạp/rút (mặc định 4111)
  // }
  function build(input) {
    const o = input || {};
    const range = o.period ? periodRange(o.period) : null;
    const from = day(o.from || (range && range.from));
    const to = day(o.to || (range && range.to));
    const acc = Object.assign({}, DEFAULT_ACCOUNTS, o.accounts || {});
    const capital = String(o.depositCounter || acc.capital);
    const capitalize = o.buyFeePolicy !== 'expense';
    const out = { from, to, accounts: acc, buyFeePolicy: capitalize ? 'capitalize' : 'expense', vouchers: [], skipped: [], notes: [], issues: [], holdings: [], summary: null, recon: null };
    if (!from || !to || from > to) { out.issues.push('Khoảng thời gian không hợp lệ.'); return out; }

    const live = (r) => r && !r.deleted_at;
    const txnsAll = (o.txns || []).filter(live);
    const actionsAll = (o.actions || []).filter(live);
    const flowsAll = (o.flows || []).filter(live);
    // FIFO cần TOÀN BỘ lịch sử đến hết ngày to (lô mua cũ nằm ngoài kỳ vẫn quyết định giá vốn của lệnh bán trong kỳ).
    const txnsToDate = txnsAll.filter((t) => day(t.trade_date) <= to);
    const actionsToDate = actionsAll.filter((a) => day(a.ex_date) <= to);
    const replay = PC.replayLedger(txnsToDate, actionsToDate);
    const saleByTxn = {};
    replay.sales.forEach((s) => { saleByTxn[s.txnId] = s; });
    const inRange = (d) => day(d) >= from && day(d) <= to;
    const cashAcc = acc.cash, secAcc = acc.securities, incAcc = acc.finIncome, expAcc = acc.finExpense;

    const periodTxns = txnsToDate.filter((t) => inRange(t.trade_date))
      .sort((a, b) => (day(a.trade_date) < day(b.trade_date) ? -1 : day(a.trade_date) > day(b.trade_date) ? 1 : String(a.created_at || '').localeCompare(String(b.created_at || ''))));
    const salesInPeriod = [];
    let buyCount = 0, sellCount = 0, buyValue = 0, expensedBuyFees = 0;

    periodTxns.forEach((t) => {
      const qty = num(t.quantity), price = num(t.price), sym = String(t.symbol || '').toUpperCase();
      const value = int(qty * price);
      const label = qty.toLocaleString('vi-VN') + ' ' + sym + ' @ ' + vn(price) + ' (' + dmy(t.trade_date) + ')';
      if (!(qty > 0) || !(value > 0) || !sym) { out.skipped.push({ kind: t.type === 'sell' ? 'sell' : 'buy', ref: t.id, reason: 'Lệnh thiếu mã, khối lượng hoặc giá: ' + label }); return; }
      if (t.type === 'buy') {
        const fee = int(t.fee);
        const lines = capitalize
          ? [line(secAcc, 'N', value + fee), line(cashAcc, 'C', value + fee)]
          : [line(secAcc, 'N', value), line(expAcc, 'N', fee), line(cashAcc, 'C', value + fee)];
        buyCount++; buyValue += value + (capitalize ? fee : 0); if (!capitalize) expensedBuyFees += fee;
        out.vouchers.push(mk('buy', t.id, t.trade_date, 'Mua ' + label + (fee ? ', phí ' + vn(fee) : ''), lines, { symbol: sym, quantity: qty, price, fee }));
        return;
      }
      const sale = saleByTxn[t.id];
      if (!sale) { out.skipped.push({ kind: 'sell', ref: t.id, reason: 'Không dựng lại được lệnh bán trong sổ FIFO: ' + label }); return; }
      if (sale.shortfall > EPS) { out.skipped.push({ kind: 'sell', ref: t.id, reason: 'Bán vượt khối lượng đang nắm (thiếu ' + sale.shortfall.toLocaleString('vi-VN') + ' cp) -- sửa sổ lệnh trong Fin trước: ' + label }); return; }
      const fee = int(sale.sellFee), tax = int(sale.tax);
      const cost = int(sale.costBasis + (capitalize ? sale.buyFees : 0));
      const net = value - fee - tax;
      if (!(net > 0)) { out.skipped.push({ kind: 'sell', ref: t.id, reason: 'Phí và thuế lớn hơn tiền bán: ' + label }); return; }
      const diff = value - cost;
      const lines = [line(cashAcc, 'N', net), line(expAcc, 'N', fee + tax + (diff < 0 ? -diff : 0)), line(secAcc, 'C', cost), line(incAcc, 'C', diff > 0 ? diff : 0)];
      sellCount++; salesInPeriod.push(sale);
      out.vouchers.push(mk('sell', t.id, t.trade_date,
        'Bán ' + label + ', giá vốn ' + vn(cost) + (diff >= 0 ? ', lãi ' : ', lỗ ') + vn(Math.abs(diff)) + (fee ? ', phí ' + vn(fee) : '') + (tax ? ', thuế ' + vn(tax) : ''),
        lines, { symbol: sym, quantity: qty, price, cost, gain: diff, fee, tax, realizedNet: sale.realizedNet }));
    });

    // Dòng tiền: cổ tức tiền mặt, nạp, rút
    let dividends = 0, deposits = 0, withdrawals = 0;
    flowsAll.filter((f) => inRange(f.flow_date)).sort((a, b) => (day(a.flow_date) < day(b.flow_date) ? -1 : day(a.flow_date) > day(b.flow_date) ? 1 : 0)).forEach((f) => {
      const amount = int(f.amount), sym = String(f.symbol || '').toUpperCase();
      if (!(amount > 0)) { out.skipped.push({ kind: f.flow_type, ref: f.id, reason: 'Số tiền dòng tiền không dương (' + dmy(f.flow_date) + ')' }); return; }
      if (f.flow_type === 'dividend') {
        dividends += amount;
        out.vouchers.push(mk('dividend', f.id, f.flow_date, 'Cổ tức tiền mặt' + (sym ? ' ' + sym : '') + ' ' + vn(amount) + ' (' + dmy(f.flow_date) + ')', [line(cashAcc, 'N', amount), line(incAcc, 'C', amount)], { symbol: sym || null, amount }));
      } else if (f.flow_type === 'deposit') {
        deposits += amount;
        out.vouchers.push(mk('deposit', f.id, f.flow_date, 'Nạp ' + vn(amount) + ' vào tài khoản đầu tư (' + dmy(f.flow_date) + ')' + (f.note ? ': ' + String(f.note).slice(0, 80) : ''), [line(cashAcc, 'N', amount), line(capital, 'C', amount)], { amount }));
      } else if (f.flow_type === 'withdrawal') {
        withdrawals += amount;
        out.vouchers.push(mk('withdrawal', f.id, f.flow_date, 'Rút ' + vn(amount) + ' khỏi tài khoản đầu tư (' + dmy(f.flow_date) + ')' + (f.note ? ': ' + String(f.note).slice(0, 80) : ''), [line(capital, 'N', amount), line(cashAcc, 'C', amount)], { amount }));
      } else {
        out.skipped.push({ kind: f.flow_type, ref: f.id, reason: 'Loại dòng tiền chưa hỗ trợ: ' + f.flow_type });
      }
    });

    // Hành động doanh nghiệp trong kỳ: không có bút toán, chỉ ghi chú để kế toán biết số lượng đã đổi
    actionsAll.filter((a) => inRange(a.ex_date)).forEach((a) => {
      const what = a.action_type === 'split' ? 'chia tách/gộp ' + num(a.ratio) + ':1' : 'cổ phiếu thưởng ' + (num(a.ratio) * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
      out.notes.push(String(a.symbol || '').toUpperCase() + ' ' + dmy(a.ex_date) + ': ' + what + ' -- không có bút toán, chỉ tăng số lượng và giảm giá vốn bình quân (theo dõi trên thuyết minh).');
    });

    // Tồn kho cuối kỳ + giá trị hợp lý + dự phòng
    const prices = o.prices || {};
    let costHeld = 0, mvHeld = 0, provisionRequired = 0;
    const missingPrice = [];
    Object.keys(replay.lotsBySymbol).sort().forEach((sym) => {
      const lots = replay.lotsBySymbol[sym].filter((l) => l.quantity > EPS);
      if (!lots.length) return;
      const quantity = lots.reduce((s, l) => s + l.quantity, 0);
      const cost = lots.reduce((s, l) => s + l.quantity * (l.cost + (capitalize ? l.feePerUnit : 0)), 0);
      const p = num(prices[sym]);
      const priced = p > 0;
      const marketValue = priced ? quantity * p : null;
      const provision = priced ? Math.max(0, int(cost - marketValue)) : null;
      if (!priced) missingPrice.push(sym);
      costHeld += cost; if (priced) { mvHeld += marketValue; provisionRequired += provision; }
      out.holdings.push({ symbol: sym, quantity, cost: int(cost), avgCost: quantity > 0 ? cost / quantity : 0, price: priced ? p : null, marketValue: priced ? int(marketValue) : null, unrealized: priced ? int(marketValue - cost) : null, provision });
    });
    costHeld = int(costHeld);

    // Dự phòng: chỉ đề xuất khi đã biết số dư TK dự phòng trong sổ và đủ giá mọi mã đang nắm
    const books = o.books || {};
    const hasProvBook = books.provision !== undefined && books.provision !== null && isFinite(Number(books.provision));
    let provisionVoucher = null;
    if (hasProvBook && out.holdings.length + int(books.provision) > 0) {
      if (missingPrice.length) {
        out.issues.push('Thiếu giá thị trường của ' + missingPrice.join(', ') + ' -- chưa đề xuất bút toán dự phòng.');
      } else {
        const delta = provisionRequired - int(books.provision);
        if (delta !== 0) {
          const detail = out.holdings.filter((h) => h.provision > 0).map((h) => h.symbol + ' ' + vn(h.provision)).join(', ');
          const memo = (delta > 0 ? 'Trích lập' : 'Hoàn nhập') + ' dự phòng giảm giá chứng khoán kinh doanh tại ' + dmy(to) + ': cần ' + vn(provisionRequired) + ', sổ đang có ' + vn(books.provision) + (detail ? ' (' + detail + ')' : '');
          const lines = delta > 0 ? [line(expAcc, 'N', delta), line(acc.provision, 'C', delta)] : [line(acc.provision, 'N', -delta), line(expAcc, 'C', -delta)];
          provisionVoucher = mk('provision', 'DP' + to, to, memo, lines, { required: provisionRequired, booked: int(books.provision), delta }, 'FIN-DP-' + to.replace(/-/g, ''));
          out.vouchers.push(provisionVoucher);
        }
      }
    }

    out.vouchers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const pnl = PC.summarizeSales(salesInPeriod);
    const gains = out.vouchers.filter((v) => v.kind === 'sell');
    out.summary = {
      buyCount, sellCount, buyValue: int(buyValue),
      proceeds: int(pnl.proceeds), costOfSold: int(pnl.costBasis + (capitalize ? pnl.buyFees : 0)),
      realizedGross: int(pnl.grossPnl), realizedNet: int(pnl.netPnl),
      gainTotal: gains.reduce((s, v) => s + Math.max(0, v.meta.gain), 0), lossTotal: gains.reduce((s, v) => s + Math.max(0, -v.meta.gain), 0),
      sellFees: int(pnl.sellFees), sellTaxes: int(pnl.taxes), buyFeesExpensed: int(expensedBuyFees),
      dividends, deposits, withdrawals,
      costHeld, marketValueHeld: missingPrice.length ? null : int(mvHeld), unrealizedHeld: missingPrice.length ? null : int(mvHeld - costHeld),
      provisionRequired: missingPrice.length ? null : provisionRequired, missingPrice,
      voucherCount: out.vouchers.length,
    };
    // Đối soát: giá gốc đang nắm theo Fin so với số dư TK 121 trong sổ (chênh lệch bình thường khi còn chứng từ nháp chưa duyệt)
    const hasSecBook = books.securities !== undefined && books.securities !== null && isFinite(Number(books.securities));
    out.recon = {
      costHeld,
      securitiesBook: hasSecBook ? int(books.securities) : null,
      securitiesDiff: hasSecBook ? int(books.securities) - costHeld : null,
      provisionRequired: missingPrice.length ? null : provisionRequired,
      provisionBook: hasProvBook ? int(books.provision) : null,
    };
    return out;
  }

  // Gắn trạng thái đã gửi sang web kế toán. existing: [{id, status}] -- mọi chứng từ có id bắt đầu bằng 'FIN-'.
  // Chứng từ bị TỪ CHỐI thì cho gửi lại bằng hậu tố ~2, ~3...; nháp/đã ghi sổ/đã đảo thì KHÔNG gửi lại (tránh ghi sổ hai lần).
  function plan(vouchers, existing) {
    const byBase = {};
    (existing || []).forEach((e) => {
      const id = String(e.id || '');
      const base = id.replace(/~\d+$/, '');
      (byBase[base] = byBase[base] || []).push({ id, status: String(e.status || '') });
    });
    return (vouchers || []).map((v) => {
      const hist = byBase[v.id] || [];
      const live = hist.find((h) => !/^rejected$/i.test(h.status));
      if (live) return Object.assign({}, v, { state: 'sent', sendId: null, status: live.status, existingId: live.id });
      if (hist.length) return Object.assign({}, v, { state: 'rejected', sendId: v.id + '~' + (hist.length + 1), status: 'Rejected', existingId: hist[hist.length - 1].id });
      return Object.assign({}, v, { state: 'new', sendId: v.id, status: null, existingId: null });
    });
  }

  // Thân yêu cầu cho POST /api/v9/vouchers (người lập luôn là người đăng nhập, máy chủ tự gắn)
  function toApiPayload(v, sendId) {
    return {
      voucher: { id: sendId || v.sendId || v.id, date: v.date, posting_date: v.date, type: v.type, memo: v.memo, evidence_status: 'Pending' },
      lines: v.lines.map((l) => ({ account: l.account, side: l.side, amount: l.amount })),
    };
  }

  // Mọi mã tài khoản mà các bút toán dùng -- để kiểm tra có trong hệ thống tài khoản trước khi gửi
  function accountsUsed(vouchers) {
    const set = {};
    (vouchers || []).forEach((v) => v.lines.forEach((l) => { set[l.account] = true; }));
    return Object.keys(set).sort();
  }

  // Bảng chứng khoán kinh doanh theo mẫu thuyết minh B09 (giá gốc, giá trị hợp lý, dự phòng) cho CSV
  const HOLDINGS_HEADER = ['Mã', 'Số lượng', 'Giá gốc', 'Giá gốc bình quân', 'Giá thị trường', 'Giá trị hợp lý', 'Lãi/lỗ chưa thực hiện', 'Dự phòng cần lập'];
  function holdingsCsv(holdings) {
    const rows = [HOLDINGS_HEADER];
    (holdings || []).forEach((h) => rows.push([h.symbol, h.quantity, h.cost, Math.round(h.avgCost), h.price === null ? '' : h.price, h.marketValue === null ? '' : h.marketValue, h.unrealized === null ? '' : h.unrealized, h.provision === null ? '' : h.provision]));
    return rows;
  }

  return { DEFAULT_ACCOUNTS, VOUCHER_TYPE, KIND_LABEL, periodRange, build, plan, toApiPayload, accountsUsed, isBalanced, holdingsCsv, HOLDINGS_HEADER };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AccountingBridge;
