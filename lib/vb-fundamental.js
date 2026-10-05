// Logic thuần của VALUATION BENCH: PHÂN TÍCH CƠ BẢN từ các kỳ báo cáo đã chuẩn hoá (lib/vb-statements.js): tỷ số sinh lời / hiệu quả / đòn bẩy / thanh khoản / dòng tiền, phân rã DuPont 3 và 5 bước, ROIC,
// tăng trưởng và CAGR, và các điểm chất lượng kinh điển -- Piotroski F-score (9 tiêu chí), Altman Z (3 biến thể), Beneish M-score (8 biến), chỉ số dồn tích Sloan. Có bộ riêng cho ngân hàng.
// Nguyên tắc: thiếu số liệu thì tiêu chí/tỷ số đó là null và KHÔNG tính vào điểm (điểm ghi rõ "n/tối đa"); mọi tiêu chí kèm số liệu để người dùng tự kiểm.
// Các điểm chất lượng là công cụ SÀNG LỌC, không phải khẳng định: Altman và Beneish được hiệu chỉnh trên mẫu doanh nghiệp Mỹ, nên dùng cho Việt Nam như tín hiệu cần soát kỹ hơn.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VBFundamental) và module.exports cho Vitest.
const VBFundamental = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const div = (a, b) => (num(a) === null || num(b) === null || b === 0 ? null : a / b);
  const avg2 = (a, b) => (num(a) === null ? null : (num(b) === null ? a : (a + b) / 2));
  const pct = (a, b) => (num(a) === null || !(num(b) > 0) ? null : a / b - 1);
  const DAYS = 365;

  // Tài sản hoạt động ròng = (tổng tài sản − tiền − đầu tư tài chính) − nợ không chịu lãi; dùng cho ROIC theo hướng hoạt động
  function netOperatingAssets(p) {
    if (num(p.totalAssets) === null || num(p.liabilities) === null) return null;
    return (p.totalAssets - (p.cash || 0) - (p.stInvest || 0) - (p.ltInvest || 0)) - (p.liabilities - (p.debt || 0));
  }

  // Tỷ số của một kỳ năm; prev = kỳ năm liền trước (để tính bình quân và tăng trưởng)
  function ratios(p, prev) {
    const r = { date: p.date, year: p.year };
    r.grossMargin = div(p.grossProfit, p.revenue);
    r.ebitMargin = div(p.ebit, p.revenue);
    r.ebitdaMargin = div(p.ebitda, p.revenue);
    r.netMargin = div(p.netIncome, p.revenue);
    r.sgaRatio = p.selling !== null || p.admin !== null ? div((p.selling || 0) + (p.admin || 0), p.revenue) : null;
    const eq = avg2(p.equity, prev && prev.equity), ta = avg2(p.totalAssets, prev && prev.totalAssets);
    r.roe = div(p.netIncome, eq);
    r.roa = div(p.netIncomeAll, ta);
    r.assetTurnover = div(p.revenue, ta);
    r.equityMultiplier = div(ta, eq);
    // vốn đầu tư và ROIC (sau thuế, theo tài sản hoạt động ròng bình quân)
    const noa = avg2(netOperatingAssets(p), prev && netOperatingAssets(prev));
    const tax = p.effTaxRate !== null && p.effTaxRate !== undefined ? p.effTaxRate : 0.2;
    r.taxRate = tax;
    r.nopat = p.ebit !== null ? p.ebit * (1 - tax) : null;
    r.noa = noa;
    r.roic = noa > 0 && r.nopat !== null ? r.nopat / noa : null;
    // vốn lưu động
    r.dso = p.revenue > 0 && p.receivables !== null ? avg2(p.receivables, prev && prev.receivables) / p.revenue * DAYS : null;
    r.dio = p.cogs > 0 && p.inventory !== null ? avg2(p.inventory, prev && prev.inventory) / p.cogs * DAYS : null;
    r.dpo = p.cogs > 0 && p.payables !== null ? avg2(p.payables, prev && prev.payables) / p.cogs * DAYS : null;
    r.ccc = r.dso !== null && r.dio !== null && r.dpo !== null ? r.dso + r.dio - r.dpo : null;
    // thanh khoản và đòn bẩy
    r.currentRatio = div(p.currentAssets, p.currentLiab);
    r.quickRatio = p.currentAssets !== null && p.currentLiab > 0 ? (p.currentAssets - (p.inventory || 0)) / p.currentLiab : null;
    r.debtToEquity = div(p.debt, p.equityAll);
    r.liabToAssets = div(p.liabilities, p.totalAssets);
    r.netDebt = p.debt !== null ? p.debt - (p.cash || 0) - (p.stInvest || 0) : null;
    r.netDebtToEbitda = p.ebitda > 0 && r.netDebt !== null ? r.netDebt / p.ebitda : null;
    r.interestCover = p.interest > 0 && p.ebit !== null ? p.ebit / p.interest : null;
    // dòng tiền
    r.cfoToNetIncome = p.netIncomeAll > 0 ? div(p.cfo, p.netIncomeAll) : null;
    r.fcfMargin = div(p.fcf, p.revenue);
    r.capexToRevenue = div(p.capex, p.revenue);
    r.capexToDa = p.da > 0 ? div(p.capex, p.da) : null;
    r.payout = p.netIncome > 0 && p.divPaid !== null ? p.divPaid / p.netIncome : null;
    r.reinvestmentRate = r.payout !== null ? Math.max(0, 1 - r.payout) : null;
    r.sustainableGrowth = r.roe !== null && r.reinvestmentRate !== null ? r.roe * r.reinvestmentRate : null;      // g bền vững = ROE × tỷ lệ giữ lại lợi nhuận
    // tăng trưởng so với năm trước
    if (prev) {
      r.revenueGrowth = pct(p.revenue, prev.revenue); r.grossProfitGrowth = pct(p.grossProfit, prev.grossProfit); r.ebitGrowth = pct(p.ebit, prev.ebit); r.netIncomeGrowth = pct(p.netIncome, prev.netIncome);
      r.epsGrowth = pct(p.eps, prev.eps); r.cfoGrowth = pct(p.cfo, prev.cfo); r.equityGrowth = pct(p.equity, prev.equity); r.assetsGrowth = pct(p.totalAssets, prev.totalAssets);
    }
    return r;
  }

  // Chuỗi tỷ số mọi năm + CAGR 3 và 5 năm của các đại lượng chính
  function analyze(periods) {
    const p = (periods || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    const rows = p.map(function (x, i) { return ratios(x, i ? p[i - 1] : null); });
    const cg = function (k, n) { return require_cagr(p, k, n); };
    const growth = { revenue3y: cg('revenue', 3), revenue5y: cg('revenue', 5), ebit3y: cg('ebit', 3), ebit5y: cg('ebit', 5), netIncome3y: cg('netIncome', 3), netIncome5y: cg('netIncome', 5), eps3y: cg('eps', 3), equity3y: cg('equity', 3), cfo3y: cg('cfo', 3) };
    return { periods: p, ratios: rows, growth: growth, latest: rows.length ? rows[rows.length - 1] : null };
  }
  function require_cagr(p, key, years) {
    const v = p.filter(function (x) { return num(x[key]) !== null; });
    if (v.length < 2) return null;
    const n = Math.min(years, v.length - 1), a = v[v.length - 1 - n][key], b = v[v.length - 1][key];
    if (!(a > 0) || !(b > 0)) return null;
    return Math.pow(b / a, 1 / n) - 1;
  }

  // DuPont. 3 bước: ROE = biên ròng × vòng quay tài sản × đòn bẩy tài chính. 5 bước: = gánh nặng thuế × gánh nặng lãi × biên EBIT × vòng quay × đòn bẩy.
  function dupont(p, prev) {
    const ta = avg2(p.totalAssets, prev && prev.totalAssets), eq = avg2(p.equity, prev && prev.equity);
    const margin = div(p.netIncome, p.revenue), turn = div(p.revenue, ta), lev = div(ta, eq);
    const out = { roe: div(p.netIncome, eq), margin: margin, turnover: turn, leverage: lev, check: margin !== null && turn !== null && lev !== null ? margin * turn * lev : null };
    if (p.ebit !== null && p.pretax !== null && p.revenue > 0) {
      const ebt = p.pretax, taxBurden = div(p.netIncomeAll, ebt), interestBurden = p.ebit !== 0 ? ebt / p.ebit : null;
      out.five = { taxBurden: taxBurden, interestBurden: interestBurden, ebitMargin: p.ebit / p.revenue, turnover: turn, leverage: lev };
      out.five.note = 'Gánh nặng lãi = LNTT / EBIT hoạt động: gồm cả thu nhập tài chính và liên kết nên có thể lớn hơn 1.';
    }
    return out;
  }

  // Piotroski F-score: 9 tiêu chí 0/1 về sinh lời, đòn bẩy-thanh khoản và hiệu quả. cur/prev: hai kỳ năm liền kề (đã chuẩn hoá). ROA = lợi nhuận / tổng tài sản cuối kỳ.
  function piotroski(cur, prev) {
    if (!cur || !prev) return { score: null, max: 9, available: 0, tests: [], grade: null, note: 'Cần ít nhất 2 năm báo cáo.' };
    const roa = (x) => div(x.netIncomeAll, x.totalAssets), lev = (x) => div(x.ltDebt !== null ? x.ltDebt : x.debt, x.totalAssets);
    const cr = (x) => div(x.currentAssets, x.currentLiab), gm = (x) => div(x.grossProfit, x.revenue), at = (x) => div(x.revenue, x.totalAssets);
    const T = [];
    const t = (key, label, pass, detail) => T.push({ key: key, label: label, pass: pass, detail: detail });
    const f = (v, d) => (v === null ? '—' : (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toString());
    const r0 = roa(cur), r1 = roa(prev);
    t('roa', 'ROA dương', r0 === null ? null : r0 > 0, 'ROA ' + f(r0 === null ? null : r0 * 100, 1) + '%');
    t('cfo', 'Dòng tiền kinh doanh dương', num(cur.cfo) === null ? null : cur.cfo > 0, 'CFO ' + f(cur.cfo === null ? null : cur.cfo / 1e9, 0) + ' tỷ');
    t('droa', 'ROA tăng so với năm trước', r0 === null || r1 === null ? null : r0 > r1, 'ROA ' + f(r1 === null ? null : r1 * 100, 1) + '% → ' + f(r0 === null ? null : r0 * 100, 1) + '%');
    t('accrual', 'CFO lớn hơn lợi nhuận (chất lượng lợi nhuận)', num(cur.cfo) === null || num(cur.netIncomeAll) === null ? null : cur.cfo > cur.netIncomeAll, 'CFO ' + f(cur.cfo === null ? null : cur.cfo / 1e9, 0) + ' tỷ so với lợi nhuận ' + f(cur.netIncomeAll === null ? null : cur.netIncomeAll / 1e9, 0) + ' tỷ');
    const l0 = lev(cur), l1 = lev(prev);
    t('dlev', 'Nợ dài hạn / tài sản giảm', l0 === null || l1 === null ? null : l0 < l1 || (l0 === 0 && l1 === 0), f(l1 === null ? null : l1 * 100, 1) + '% → ' + f(l0 === null ? null : l0 * 100, 1) + '%');
    const c0 = cr(cur), c1 = cr(prev);
    t('dcr', 'Thanh toán hiện hành cải thiện', c0 === null || c1 === null ? null : c0 > c1, f(c1, 2) + ' → ' + f(c0, 2));
    // Cổ phiếu thưởng/chia cổ tức bằng cổ phiếu làm tăng vốn góp nhưng KHÔNG pha loãng: chỉ tính phát hành thu tiền (ESOP, riêng lẻ, công khai) vượt 1% vốn chủ đầu năm
    const issued = num(cur.shareIssue), baseEq = num(prev.equityAll);
    t('shares', 'Không phát hành thêm cổ phiếu thu tiền', issued !== null && baseEq > 0 ? issued <= 0.01 * baseEq : (num(cur.paidIn) === null || num(prev.paidIn) === null ? null : cur.paidIn <= prev.paidIn * 1.005),
      issued !== null ? 'Tiền thu phát hành cổ phiếu ' + f(issued / 1e9, 0) + ' tỷ' : 'Vốn góp ' + f(prev.paidIn === null ? null : prev.paidIn / 1e9, 0) + ' → ' + f(cur.paidIn === null ? null : cur.paidIn / 1e9, 0) + ' tỷ');
    const g0 = gm(cur), g1 = gm(prev);
    t('dgm', 'Biên lợi nhuận gộp tăng', g0 === null || g1 === null ? null : g0 > g1, f(g1 === null ? null : g1 * 100, 1) + '% → ' + f(g0 === null ? null : g0 * 100, 1) + '%');
    const a0 = at(cur), a1 = at(prev);
    t('dat', 'Vòng quay tài sản tăng', a0 === null || a1 === null ? null : a0 > a1, f(a1, 2) + ' → ' + f(a0, 2));
    const known = T.filter(function (x) { return x.pass !== null; });
    const score = known.reduce(function (s, x) { return s + (x.pass ? 1 : 0); }, 0);
    // thang 8-9 mạnh, 5-7 trung bình, 0-4 yếu: nếu thiếu tiêu chí thì quy đổi theo tỷ lệ trên 9
    const scaled = known.length ? score / known.length * 9 : null;
    const grade = scaled === null ? null : (scaled >= 7.5 ? { key: 'strong', label: 'Mạnh', tone: 'ok' } : (scaled >= 4.5 ? { key: 'mid', label: 'Trung bình', tone: 'mute' } : { key: 'weak', label: 'Yếu', tone: 'warn' }));
    return { score: known.length ? score : null, max: 9, available: known.length, tests: T, grade: grade };
  }

  // Altman Z. Z'' (doanh nghiệp không sản xuất / thị trường mới nổi): 6,56·X1 + 3,26·X2 + 6,72·X3 + 1,05·X4, vùng an toàn > 2,6, nguy cơ < 1,1.
  // Z gốc (niêm yết, sản xuất): 1,2·X1 + 1,4·X2 + 3,3·X3 + 0,6·X4 + 1,0·X5, an toàn > 2,99, nguy cơ < 1,81. Không dùng cho ngân hàng/tài chính.
  function altman(p, marketCap) {
    if (!p || p.form !== 'NON_FINANCE') return { z2: null, z: null, note: 'Altman Z không áp dụng cho ngân hàng, chứng khoán, bảo hiểm.' };
    const ta = num(p.totalAssets), tl = num(p.liabilities);
    if (!(ta > 0) || !(tl > 0) || num(p.currentAssets) === null || num(p.currentLiab) === null) return { z2: null, z: null, note: 'Thiếu số liệu để tính.' };
    const x1 = (p.currentAssets - p.currentLiab) / ta, x2 = num(p.retained) === null ? null : p.retained / ta, x3 = num(p.ebit) === null ? null : p.ebit / ta, x4b = num(p.equityAll) === null ? null : p.equityAll / tl;
    const mc = num(marketCap), x4m = mc > 0 ? mc / tl : null, x5 = num(p.revenue) === null ? null : p.revenue / ta;
    const zone2 = (z) => (z === null ? null : (z > 2.6 ? { key: 'safe', label: 'An toàn', tone: 'ok' } : (z >= 1.1 ? { key: 'grey', label: 'Vùng xám', tone: 'mute' } : { key: 'distress', label: 'Nguy cơ', tone: 'warn' })));
    const zone1 = (z) => (z === null ? null : (z > 2.99 ? { key: 'safe', label: 'An toàn', tone: 'ok' } : (z >= 1.81 ? { key: 'grey', label: 'Vùng xám', tone: 'mute' } : { key: 'distress', label: 'Nguy cơ', tone: 'warn' })));
    const z2 = x2 === null || x3 === null || x4b === null ? null : 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4b;
    const z = x2 === null || x3 === null || x4m === null || x5 === null ? null : 1.2 * x1 + 1.4 * x2 + 3.3 * x3 + 0.6 * x4m + 1.0 * x5;
    return { z2: z2, zone2: zone2(z2), z: z, zone: zone1(z), x: { x1: x1, x2: x2, x3: x3, x4book: x4b, x4market: x4m, x5: x5 }, note: 'Retained earnings dùng lợi nhuận chưa phân phối; EBIT là EBIT hoạt động (không gồm thu nhập tài chính).' };
  }

  // Beneish M-score (8 biến): M > −1,78 gợi ý khả năng điều chỉnh lợi nhuận. Cần hai năm báo cáo liền kề.
  function beneish(cur, prev) {
    if (!cur || !prev || cur.form !== 'NON_FINANCE') return { m: null, note: 'Cần 2 năm báo cáo của doanh nghiệp thường.' };
    const sga = (x) => (x.selling !== null || x.admin !== null ? (x.selling || 0) + (x.admin || 0) : null);
    const dep = (x) => num(x.da), ppe = (x) => num(x.fixedAssets);
    const dsri = div(div(cur.receivables, cur.revenue), div(prev.receivables, prev.revenue));
    const gmi = div(div(prev.grossProfit, prev.revenue), div(cur.grossProfit, cur.revenue));
    const aqiOf = (x) => (num(x.currentAssets) === null || ppe(x) === null || !(x.totalAssets > 0) ? null : 1 - (x.currentAssets + ppe(x)) / x.totalAssets);
    const aqi = div(aqiOf(cur), aqiOf(prev));
    const sgi = div(cur.revenue, prev.revenue);
    const depRate = (x) => (dep(x) === null || ppe(x) === null || dep(x) + ppe(x) === 0 ? null : dep(x) / (dep(x) + ppe(x)));
    const depi = div(depRate(prev), depRate(cur));
    const sgai = div(div(sga(cur), cur.revenue), div(sga(prev), prev.revenue));
    const lvOf = (x) => (num(x.currentLiab) === null || !(x.totalAssets > 0) ? null : ((x.currentLiab + (x.ltDebt || 0)) / x.totalAssets));
    const lvgi = div(lvOf(cur), lvOf(prev));
    const tata = num(cur.netIncomeAll) === null || num(cur.cfo) === null || !(cur.totalAssets > 0) ? null : (cur.netIncomeAll - cur.cfo) / cur.totalAssets;
    const v = { dsri: dsri, gmi: gmi, aqi: aqi, sgi: sgi, depi: depi, sgai: sgai, tata: tata, lvgi: lvgi };
    const missing = Object.keys(v).filter(function (k) { return v[k] === null; });
    if (missing.length) return { m: null, vars: v, missing: missing, note: 'Thiếu biến: ' + missing.join(', ') + '.' };
    const m = -4.84 + 0.920 * dsri + 0.528 * gmi + 0.404 * aqi + 0.892 * sgi + 0.115 * depi - 0.172 * sgai + 4.679 * tata - 0.327 * lvgi;
    return { m: m, vars: v, flag: m > -1.78 ? { key: 'risk', label: 'Có dấu hiệu cần soát', tone: 'warn' } : { key: 'ok', label: 'Chưa thấy dấu hiệu', tone: 'ok' }, threshold: -1.78 };
  }

  // Chỉ số dồn tích Sloan = (lợi nhuận − CFO) / tổng tài sản bình quân. Trên +10% hoặc dưới −10% là vùng cần soát (lợi nhuận phần lớn là dồn tích chứ không phải tiền).
  function accruals(cur, prev) {
    if (!cur || num(cur.netIncomeAll) === null || num(cur.cfo) === null) return null;
    const ta = avg2(cur.totalAssets, prev && prev.totalAssets);
    if (!(ta > 0)) return null;
    const v = (cur.netIncomeAll - cur.cfo) / ta;
    return { value: v, flag: v > 0.1 ? { label: 'Dồn tích cao: lợi nhuận kém chuyển thành tiền', tone: 'warn' } : (v < -0.1 ? { label: 'Dòng tiền vượt lợi nhuận nhiều', tone: 'mute' } : { label: 'Bình thường', tone: 'ok' }) };
  }

  // Ngân hàng: các chỉ số đặc thù từ báo cáo ngân hàng. nim xấp xỉ bằng NII / tài sản bình quân (nguồn không công bố tài sản sinh lãi).
  function bank(p, prev) {
    const ta = avg2(p.totalAssets, prev && prev.totalAssets), eq = avg2(p.equity, prev && prev.equity), loans = avg2(p.loansGross, prev && prev.loansGross);
    return {
      roe: div(p.netIncome, eq), roa: div(p.netIncomeAll, ta), nimApprox: div(p.nii, ta), costIncome: p.costIncome, creditCost: div(p.provision, loans), ldr: p.ldr,
      nonInterestShare: div(p.nonInterestIncome, p.toi), equityToAssets: div(p.equityAll, p.totalAssets), leverage: div(ta, eq),
      loanGrowth: prev ? pct(p.loansGross, prev.loansGross) : null, depositGrowth: prev ? pct(p.deposits, prev.deposits) : null, niiGrowth: prev ? pct(p.nii, prev.nii) : null, profitGrowth: prev ? pct(p.netIncome, prev.netIncome) : null,
      provisionToPpop: div(p.provision, p.ppop), loanProvisionCoverage: p.loansGross > 0 && p.loanProvision !== null ? Math.abs(p.loanProvision) / p.loansGross : null,
      epsGrowth: prev ? pct(p.eps, prev.eps) : null,
    };
  }

  return { netOperatingAssets, ratios, analyze, dupont, piotroski, altman, beneish, accruals, bank };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBFundamental;
