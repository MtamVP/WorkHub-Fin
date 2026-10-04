// Logic thuần: HỆ QUẢ CỦA KỊCH BẢN CĂNG THẲNG và KỊCH BẢN NGƯỢC. Phần "mất bao nhiêu" đã có ở RiskCalc.customStress / historicalScenarios; file này trả lời câu hỏi kế tiếp mà hội đồng đầu tư
// hay hỏi: sau cú sốc thì (1) giới hạn đầu tư nào bị vi phạm, (2) đòn bẩy / tỷ lệ ký quỹ ra sao, có chạm ngưỡng công ty chứng khoán gọi ký quỹ không, và đảo ngược lại --
// (3) VN-Index phải giảm bao nhiêu thì NAV mất 10/20/30%, NAV về 0, chạm ngưỡng ký quỹ, hoặc vi phạm giới hạn đầu tiên.
// Kịch bản ngược dùng beta điều chỉnh của từng mã (như customStress) với mã chưa có beta coi là 1; cú sốc riêng theo ngành/mã không đưa vào kịch bản ngược (chỉ cú sốc thị trường chung).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global StressCalc) và module.exports cho Vitest. Cần LimitsCalc truyền vào (libs.LC) để chấm giới hạn.
const StressCalc = (function () {
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const DEFAULT_MAINTENANCE_PCT = 30;   // tỷ lệ NAV / giá trị cổ phiếu tối thiểu giả định trước khi công ty chứng khoán gọi ký quỹ (tuỳ công ty: thường 30-40%)

  // Danh mục sau cú sốc từ kết quả RiskCalc.customStress: S.rows [{ symbol, value, vnd }]
  function shockedPortfolio(S, cash, debt) {
    const holdings = (S.rows || []).map((x) => ({ symbol: x.symbol, value: Math.max(0, num(x.value) + num(x.vnd)) }));
    return { holdings, cash: num(cash), debt: num(debt) };
  }
  const pfOf = (r) => ({ holdings: (r.symbols || []).map((x) => ({ symbol: x.symbol, value: num(x.value) })), cash: num(r.cash), debt: num(r.debt) });
  const mvOf = (pf) => pf.holdings.reduce((s, h) => s + num(h.value), 0);

  function marginState(pf, maintenancePct) {
    const mv = mvOf(pf), nav = mv + pf.cash - pf.debt;
    const hasDebt = pf.debt > 0;
    const equityPct = mv > 0 ? nav / mv * 100 : null;
    return { hasDebt, mv, nav, leverage: nav > 0 ? mv / nav : null, equityPct, maintenancePct, breached: hasDebt && (nav <= 0 || (equityPct !== null && equityPct < maintenancePct)) };
  }

  // r: kết quả RiskCalc.analyze (cần symbols[{symbol,value}], cash, debt, nav); S: RiskCalc.customStress(r, shocks); opts: { LC, limits, maintenancePct }
  function consequences(r, S, opts) {
    const o = opts || {};
    const m = o.maintenancePct > 0 ? o.maintenancePct : DEFAULT_MAINTENANCE_PCT;
    const before = pfOf(r), after = shockedPortfolio(S, r.cash, r.debt);
    const out = { navBefore: num(r.nav), navAfter: num(S.navAfter), navChangePct: num(r.nav) > 0 ? (num(S.navAfter) - num(r.nav)) / num(r.nav) * 100 : null, margin: { before: marginState(before, m), after: marginState(after, m) }, limits: null };
    out.cashPctBefore = num(r.nav) > 0 ? before.cash / num(r.nav) * 100 : null;
    out.cashPctAfter = num(S.navAfter) > 0 ? after.cash / num(S.navAfter) * 100 : null;
    if (o.LC && o.limits && o.limits.length) {
      const key = (i) => i.kind + '|' + i.subject;
      const eb = o.LC.evaluate(o.limits, before), ea = o.LC.evaluate(o.limits, after);
      const bk = new Set(eb.breaches.map(key)), ak = new Set(ea.breaches.map(key));
      out.limits = {
        before: eb.breaches, after: ea.breaches,
        added: ea.breaches.filter((i) => !bk.has(key(i))),          // vi phạm MỚI do cú sốc
        cured: eb.breaches.filter((i) => !ak.has(key(i))),          // hết vi phạm nhờ cú sốc (VD tỷ trọng mã lớn giảm)
        warnsAfter: ea.warns,
      };
    }
    return out;
  }

  // Beta điều chỉnh: lấy từ r.symbols[].betaAdj, thiếu thì 1. Trả { vb: tổng giá trị x beta, mv, nav }
  function exposure(r) {
    const syms = r.symbols || [];
    const vb = syms.reduce((s, x) => s + num(x.value) * (x.betaAdj !== undefined && x.betaAdj !== null ? num(x.betaAdj) : 1), 0);
    return { vb, mv: syms.reduce((s, x) => s + num(x.value), 0), nav: num(r.nav) };
  }

  // Danh mục sau khi VN-Index đổi s% (chỉ beta): giá trị mỗi mã x (1 + beta x s/100), không âm
  function betaShocked(r, s) {
    const syms = r.symbols || [];
    return { holdings: syms.map((x) => ({ symbol: x.symbol, value: Math.max(0, num(x.value) * (1 + (x.betaAdj !== undefined && x.betaAdj !== null ? num(x.betaAdj) : 1) * s / 100)) })), cash: num(r.cash), debt: num(r.debt) };
  }

  // Kịch bản ngược: VN-Index phải giảm bao nhiêu (%, số âm; null = không xảy ra dù VN-Index về đáy) để:
  //   NAV mất 10/20/30%; NAV về 0; chạm ngưỡng ký quỹ (nếu có nợ); vi phạm giới hạn đầu tiên (nếu có LC + limits)
  function reverse(r, opts) {
    const o = opts || {};
    const e = exposure(r);
    const m = o.maintenancePct > 0 ? o.maintenancePct : DEFAULT_MAINTENANCE_PCT;
    const out = [];
    if (!(e.nav > 0) || !(e.vb > 0)) return out;
    const solve = (loss) => { const s = -100 * loss / e.vb; return s >= -100 ? s : null; };   // NAV giảm `loss` (đồng) = vb x s/100
    [10, 20, 30].forEach((p) => out.push({ key: 'nav' + p, label: 'NAV mất ' + p + '%', indexPct: solve(e.nav * p / 100), navLossPct: p }));
    out.push({ key: 'nav0', label: 'NAV về 0', indexPct: solve(e.nav), navLossPct: 100 });
    if (num(r.debt) > 0 && e.mv > 0) {
      const before = e.nav / e.mv * 100;
      if (before < m) out.push({ key: 'margin', label: 'Chạm ngưỡng ký quỹ ' + m + '%', indexPct: 0, navLossPct: 0, note: 'Đã dưới ngưỡng giả định ngay bây giờ (' + before.toFixed(1) + '%).' });
      else {
        const k = (m / 100 * e.mv - e.nav) / (1 - m / 100);      // thay đổi giá trị cổ phiếu (âm) để NAV = m% x giá trị cổ phiếu
        const s = 100 * k / e.vb;
        out.push({ key: 'margin', label: 'Chạm ngưỡng ký quỹ ' + m + '%', indexPct: s >= -100 ? s : null, navLossPct: s >= -100 ? -k / e.nav * 100 : null });
      }
    }
    if (o.LC && o.limits && o.limits.length) {
      const key = (i) => i.kind + '|' + i.subject;
      const base = new Set(o.LC.evaluate(o.limits, betaShocked(r, 0)).breaches.map(key));
      let found = null;
      for (let s = -0.5; s >= -80 && !found; s -= 0.5) {
        const added = o.LC.evaluate(o.limits, betaShocked(r, s)).breaches.filter((i) => !base.has(key(i)));
        if (added.length) found = { s, item: added[0] };
      }
      if (found) out.push({ key: 'limit', label: 'Vi phạm giới hạn đầu tiên', indexPct: found.s, navLossPct: Math.abs(e.vb * found.s / e.nav), note: found.item.subject + ' (' + found.item.kind + ')', item: found.item });
      else out.push({ key: 'limit', label: 'Vi phạm giới hạn đầu tiên', indexPct: null, navLossPct: null, note: 'Không có giới hạn nào bị vi phạm thêm khi VN-Index giảm tới −80%.' });
    }
    return out.map((x) => Object.assign(x, { navLossPct: x.navLossPct === null || x.navLossPct === undefined ? null : Math.abs(x.navLossPct) }));
  }

  return { DEFAULT_MAINTENANCE_PCT, shockedPortfolio, marginState, consequences, exposure, betaShocked, reverse };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StressCalc;
