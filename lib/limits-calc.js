// Logic thuần: giới hạn đầu tư của nhóm -- tính mức sử dụng so với từng giới hạn, kiểm tra một lệnh TRƯỚC khi ghi (vượt thì phải ghi lý do hoặc bị chặn).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global LimitsCalc) và module.exports cho Vitest. Cần FinCalc (lib/finance-calc.js) nạp trước.
//
// Mẫu số của mọi tỷ lệ là NAV (giá trị cổ phiếu + tiền mặt − nợ), đúng cách một quỹ đặt hạn mức "một mã không quá X% NAV".
// Mỗi giới hạn có 2 TẦNG: giới hạn chung của nhóm (scope 'member') và giới hạn cá nhân tự đặt (scope 'user'); với cùng một đối tượng (mã/ngành), mức áp dụng là
// mức CHẶT HƠN của hai tầng (giới hạn cá nhân chỉ có thể siết thêm). Trong mỗi tầng, giới hạn riêng cho mã/ngành cụ thể thay thế giới hạn chung của tầng đó
// (cho phép quản lý đặt trần cao hơn cho một mã đặc biệt, hoặc thấp hơn cho mã rủi ro).
// Chế độ: warn = chỉ cảnh báo; reason = vượt thì phải ghi lý do; block = chặn (chỉ quản lý được ghi đè, kèm lý do).
const LimitsCalc = (function () {
  const FC = (typeof require === 'function' && typeof module !== 'undefined') ? require('./finance-calc.js') : FinCalc;
  const EPS = 1e-9;
  const NEAR = 0.9;   // dùng từ 90% hạn mức thì báo "gần chạm"

  const KINDS = {
    max_symbol_pct: { label: 'Một mã tối đa', unit: '% NAV', dir: 'max', subject: 'symbol' },
    max_sector_pct: { label: 'Một ngành tối đa', unit: '% NAV', dir: 'max', subject: 'sector' },
    min_cash_pct: { label: 'Tiền mặt tối thiểu', unit: '% NAV', dir: 'min', subject: 'portfolio' },
    max_leverage: { label: 'Đòn bẩy tối đa', unit: '× NAV', dir: 'max', subject: 'portfolio' },
    max_position_vnd: { label: 'Một vị thế tối đa', unit: 'đồng', dir: 'max', subject: 'symbol' },
    blocked_symbol: { label: 'Mã bị cấm', unit: '', dir: 'block', subject: 'symbol' },
  };
  const MODES = { warn: { label: 'Cảnh báo', rank: 0 }, reason: { label: 'Phải ghi lý do', rank: 1 }, block: { label: 'Chặn', rank: 2 } };

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

  // Dòng DB -> dạng chuẩn
  function normalize(row) {
    const r = row || {};
    return {
      id: r.id || null, scope: r.scope || 'member', userId: r.user_id || r.userId || null, kind: r.kind,
      symbol: r.symbol ? String(r.symbol).toUpperCase() : null, sector: r.sector || null,
      value: r.value === null || r.value === undefined || r.value === '' ? null : Number(r.value),
      mode: MODES[r.mode] ? r.mode : 'reason', note: r.note || '', active: r.active !== false,
    };
  }

  function validate(input) {
    const l = normalize(input);
    if (!KINDS[l.kind]) return { ok: false, error: 'Loại giới hạn không hợp lệ' };
    if (!['member', 'consolidated', 'user'].includes(l.scope)) return { ok: false, error: 'Phạm vi không hợp lệ' };
    if (l.kind === 'blocked_symbol') {
      if (!l.symbol || !/^[A-Z0-9]{1,12}$/.test(l.symbol)) return { ok: false, error: 'Nhập mã cần cấm' };
      return { ok: true, limit: Object.assign(l, { value: null, sector: null }) };
    }
    if (!(l.value >= 0) || l.value === null) return { ok: false, error: 'Nhập ngưỡng (số không âm)' };
    if ((l.kind === 'max_symbol_pct' || l.kind === 'max_sector_pct') && !(l.value > 0 && l.value <= 100)) return { ok: false, error: 'Tỷ lệ phải trong khoảng 0–100%' };
    if (l.kind === 'min_cash_pct' && !(l.value <= 100)) return { ok: false, error: 'Tiền mặt tối thiểu tối đa 100%' };
    if (l.kind === 'max_leverage' && !(l.value >= 0.1 && l.value <= 10)) return { ok: false, error: 'Đòn bẩy từ 0,1 đến 10 lần' };
    if (l.kind === 'max_position_vnd' && !(l.value > 0)) return { ok: false, error: 'Giá trị vị thế phải lớn hơn 0' };
    if (l.kind === 'max_symbol_pct' || l.kind === 'max_position_vnd') l.sector = null; else if (l.kind === 'max_sector_pct') l.symbol = null; else { l.symbol = null; l.sector = null; }
    return { ok: true, limit: l };
  }

  // Giới hạn đang hiệu lực. level: 'member' (nhóm đặt cho mọi thành viên) | 'consolidated'. userId: giới hạn cá nhân của người này được cộng vào tầng 'member'.
  function applicable(rows, userId, level) {
    return (rows || []).map(normalize).filter(function (l) {
      if (!l.active || !KINDS[l.kind]) return false;
      if (level === 'consolidated') return l.scope === 'consolidated';
      return l.scope === 'member' || (l.scope === 'user' && l.userId === userId);
    });
  }

  // Với 1 đối tượng: mỗi tầng (nhóm / cá nhân) lấy giới hạn riêng nếu có, không thì giới hạn chung; rồi lấy mức chặt nhất giữa các tầng.
  function pick(limits, kind, subjectKey, subjectVal) {
    const ofKind = limits.filter(function (l) { return l.kind === kind; });
    const dir = KINDS[kind].dir;
    const cands = [];
    ['member', 'consolidated', 'user'].forEach(function (scope) {
      const inScope = ofKind.filter(function (l) { return l.scope === scope; });
      if (!inScope.length) return;
      const specific = subjectKey ? inScope.filter(function (l) { return l[subjectKey] && l[subjectKey] === subjectVal; }) : [];
      const generic = subjectKey ? inScope.filter(function (l) { return !l[subjectKey]; }) : inScope;
      const use = specific.length ? specific : generic;
      if (!use.length) return;
      // trong cùng tầng: chặt nhất
      use.sort(function (a, b) { return dir === 'max' ? a.value - b.value : b.value - a.value; });
      cands.push(use[0]);
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return (dir === 'max' ? a.value - b.value : b.value - a.value) || (MODES[b.mode].rank - MODES[a.mode].rank); });
    return cands[0];
  }

  function item(l, kind, subject, current, threshold, extra) {
    const dir = KINDS[kind].dir;
    let usage, status;
    if (dir === 'max') {
      usage = threshold > 0 ? current / threshold : (current > EPS ? Infinity : 0);
      status = current > threshold + EPS ? 'breach' : (usage >= NEAR ? 'warn' : 'ok');
    } else {
      usage = current > EPS ? threshold / current : (threshold > 0 ? Infinity : 0);
      status = current < threshold - EPS ? 'breach' : (usage >= NEAR ? 'warn' : 'ok');
    }
    return Object.assign({ limitId: l.id, kind: kind, subject: subject, current: current, threshold: threshold, usage: usage, status: status, mode: l.mode, scope: l.scope, note: l.note }, extra || {});
  }

  // pf: { holdings:[{symbol, value}], cash, debt }. Trả { nav, items, breaches, warns }.
  function evaluate(limits, pf, level) {
    const holdings = (pf.holdings || []).filter(function (h) { return num(h.value) > 0; });
    const mv = holdings.reduce(function (s, h) { return s + num(h.value); }, 0);
    const cash = num(pf.cash), debt = num(pf.debt);
    const nav = mv + cash - debt;
    const out = { nav: nav, marketValue: mv, items: [], breaches: [], warns: [] };
    if (!(nav > 0)) return out;
    const L = limits;
    // theo mã
    holdings.forEach(function (h) {
      const w = num(h.value) / nav * 100;
      const a = pick(L, 'max_symbol_pct', 'symbol', h.symbol);
      if (a) out.items.push(item(a, 'max_symbol_pct', h.symbol, w, a.value, { value: num(h.value) }));
      const p = pick(L, 'max_position_vnd', 'symbol', h.symbol);
      if (p) out.items.push(item(p, 'max_position_vnd', h.symbol, num(h.value), p.value));
    });
    // theo ngành
    const bySector = {};
    holdings.forEach(function (h) { const s = FC.sectorOf(h.symbol); (bySector[s] = bySector[s] || { value: 0, symbols: [] }); bySector[s].value += num(h.value); bySector[s].symbols.push(h.symbol); });
    Object.keys(bySector).forEach(function (sec) {
      const a = pick(L, 'max_sector_pct', 'sector', sec);
      if (!a) return;
      if (sec === FC.UNKNOWN_SECTOR && a.sector !== sec) return;   // ngành chưa phân loại chỉ bị giới hạn khi có giới hạn đích danh
      out.items.push(item(a, 'max_sector_pct', sec, bySector[sec].value / nav * 100, a.value, { symbols: bySector[sec].symbols, value: bySector[sec].value }));
    });
    const mc = pick(L, 'min_cash_pct', null, null);
    if (mc) out.items.push(item(mc, 'min_cash_pct', 'Tiền mặt', cash / nav * 100, mc.value));
    const lv = pick(L, 'max_leverage', null, null);
    if (lv) out.items.push(item(lv, 'max_leverage', 'Đòn bẩy', mv / nav, lv.value));
    // mã bị cấm: mọi giới hạn blocked_symbol đang hiệu lực
    L.filter(function (l) { return l.kind === 'blocked_symbol'; }).forEach(function (l) {
      const h = holdings.find(function (x) { return x.symbol === l.symbol; });
      out.items.push({ limitId: l.id, kind: 'blocked_symbol', subject: l.symbol, current: h ? num(h.value) : 0, threshold: 0, usage: h ? Infinity : 0, status: h ? 'breach' : 'ok', mode: l.mode, scope: l.scope, note: l.note, held: !!h });
    });
    out.breaches = out.items.filter(function (x) { return x.status === 'breach'; });
    out.warns = out.items.filter(function (x) { return x.status === 'warn'; });
    void level;
    return out;
  }

  // Danh mục sau khi thực hiện lệnh (không sửa bản gốc)
  function applyTrade(pf, trade) {
    const sym = String(trade.symbol || '').toUpperCase();
    const qty = num(trade.quantity), price = num(trade.price), fee = num(trade.fee), tax = num(trade.tax);
    const holdings = (pf.holdings || []).map(function (h) { return { symbol: h.symbol, value: num(h.value) }; });
    let cash = num(pf.cash);
    let h = holdings.find(function (x) { return x.symbol === sym; });
    if (trade.type === 'sell') {
      const proceeds = qty * price;
      if (h) h.value = Math.max(0, h.value - proceeds);
      cash += proceeds - fee - tax;
    } else {
      if (!h) { h = { symbol: sym, value: 0 }; holdings.push(h); }
      h.value += qty * price;
      cash -= qty * price + fee;
    }
    return { holdings: holdings, cash: cash, debt: num(pf.debt) };
  }

  const MSG = {
    max_symbol_pct: function (i, after) { return i.subject + ' ' + (after ? 'sẽ chiếm' : 'chiếm') + ' ' + fmt(i.current, 1) + '% NAV (trần ' + fmt(i.threshold, 1) + '%)'; },
    max_sector_pct: function (i, after) { return 'Ngành ' + i.subject + ' ' + (after ? 'sẽ chiếm' : 'chiếm') + ' ' + fmt(i.current, 1) + '% NAV (trần ' + fmt(i.threshold, 1) + '%)'; },
    min_cash_pct: function (i, after) { return 'Tiền mặt ' + (after ? 'sẽ còn' : 'còn') + ' ' + fmt(i.current, 1) + '% NAV (tối thiểu ' + fmt(i.threshold, 1) + '%)'; },
    max_leverage: function (i, after) { return 'Đòn bẩy ' + (after ? 'sẽ lên' : 'đang là') + ' ' + fmt(i.current, 2) + ' lần NAV (tối đa ' + fmt(i.threshold, 2) + ')'; },
    max_position_vnd: function (i, after) { return 'Vị thế ' + i.subject + ' ' + (after ? 'sẽ đạt' : 'đang là') + ' ' + fmt(i.current, 0) + ' đ (tối đa ' + fmt(i.threshold, 0) + ' đ)'; },
    blocked_symbol: function (i) { return i.subject + ' nằm trong danh sách mã bị cấm'; },
  };
  function fmt(v, d) { return Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d }); }
  function describe(i, after) { return MSG[i.kind] ? MSG[i.kind](i, after) : i.kind; }

  // Kiểm tra một lệnh. Vi phạm = giới hạn đang vi phạm SAU lệnh mà TRƯỚC lệnh chưa vi phạm hoặc bị lệnh làm tệ thêm.
  function checkTrade(limits, pf, trade) {
    const before = evaluate(limits, pf);
    const after = evaluate(limits, applyTrade(pf, trade));
    const key = function (x) { return x.kind + '|' + x.subject; };
    const prev = {}; before.items.forEach(function (x) { prev[key(x)] = x; });
    const dirOf = function (x) { return KINDS[x.kind].dir; };
    const violations = [], near = [];
    // Bán không bao giờ làm tệ thêm một giới hạn "tối đa" của chính mã đó, nên không cần loại riêng: so sánh trước/sau là đủ.
    after.items.forEach(function (x) {
      const b = prev[key(x)];
      const worse = !b || (dirOf(x) === 'min' ? x.current < b.current - EPS : x.current > b.current + EPS);
      if (x.status === 'breach' && (!b || b.status !== 'breach' || worse)) {
        if (x.kind === 'blocked_symbol' && trade.type === 'sell') return;       // bán mã bị cấm luôn được
        violations.push(Object.assign({}, x, { before: b ? b.current : 0, after: x.current, text: describe(x, true) }));
      } else if (x.status === 'warn' && (!b || b.status === 'ok') && worse) {
        near.push(Object.assign({}, x, { before: b ? b.current : 0, after: x.current, text: describe(x, true) }));
      }
    });
    violations.sort(function (a, b) { return MODES[b.mode].rank - MODES[a.mode].rank; });
    const maxRank = violations.reduce(function (m, v) { return Math.max(m, MODES[v.mode].rank); }, -1);
    return {
      violations: violations, near: near, ok: !violations.length,
      blocked: maxRank >= MODES.block.rank, needsReason: maxRank >= MODES.reason.rank, maxMode: maxRank < 0 ? null : (maxRank === 2 ? 'block' : (maxRank === 1 ? 'reason' : 'warn')),
      before: before, after: after,
    };
  }

  // Ma trận tuân thủ cho trang nhóm: mỗi thành viên (và cả nhóm gộp) với các giới hạn của họ
  function complianceMatrix(limitRows, portfolios, group) {
    const rows = portfolios.map(function (p) {
      const lim = applicable(limitRows, p.id, 'member');
      const ev = evaluate(lim, { holdings: p.holdings.map(function (h) { return { symbol: h.symbol, value: h.value }; }), cash: p.cash, debt: p.debt });
      return { id: p.id, name: p.name, nav: ev.nav, evaluated: ev.items.length, breaches: ev.breaches, warns: ev.warns, items: ev.items, limits: lim.length };
    });
    let consolidated = null;
    if (group) {
      const lim = applicable(limitRows, null, 'consolidated');
      const ev = evaluate(lim, { holdings: group.symbols.map(function (s) { return { symbol: s.symbol, value: s.value }; }), cash: group.cash, debt: group.debt });
      consolidated = { name: 'Cả nhóm (gộp)', nav: ev.nav, evaluated: ev.items.length, breaches: ev.breaches, warns: ev.warns, items: ev.items, limits: lim.length };
    }
    return { rows: rows, consolidated: consolidated, totalBreaches: rows.reduce(function (s, r) { return s + r.breaches.length; }, 0) + (consolidated ? consolidated.breaches.length : 0) };
  }

  return { KINDS, MODES, normalize, validate, applicable, evaluate, applyTrade, checkTrade, describe, complianceMatrix, pick };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LimitsCalc;
