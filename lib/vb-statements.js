// Logic thuần của VALUATION BENCH: CHUẨN HOÁ BÁO CÁO TÀI CHÍNH từ VNDirect finfo v4 (/financial_statements) thành các kỳ có tên trường rõ ràng, dùng chung cho phân tích cơ bản, DCF và chấm điểm chất lượng.
// Bốn loại doanh nghiệp có mã mô hình báo cáo khác nhau: doanh nghiệp thường (1 bảng cân đối / 2 kết quả kinh doanh / 3 lưu chuyển tiền), ngân hàng (101/102/103), chứng khoán (89/90/91), bảo hiểm (411/412/413).
// Quy ước của nguồn (đã đối chiếu số thật FPT, VCB): chi phí trong báo cáo kết quả kinh doanh là SỐ DƯƠNG; khoản chi trong lưu chuyển tiền là SỐ ÂM; hao mòn luỹ kế trên bảng cân đối là số âm; số liệu quý của kết quả kinh doanh là QUÝ RIÊNG LẺ
// (tổng 4 quý = cả năm). Đơn vị: đồng. Thiếu khoản mục -> null (KHÔNG coi là 0) để các hàm phân tích biết "không có dữ liệu" khác với "bằng không".
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VBStatements) và module.exports cho Vitest.
const VBStatements = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const MODELS = { NON_FINANCE: [1, 2, 3], BANK: [101, 102, 103], SECURITIES: [89, 90, 91], INSURANCE: [411, 412, 413] };
  const FORM_LABEL = { NON_FINANCE: 'Doanh nghiệp (phi tài chính)', BANK: 'Ngân hàng', SECURITIES: 'Chứng khoán', INSURANCE: 'Bảo hiểm' };

  // Tên trường -> danh sách mã khoản mục, thử lần lượt (mã đầu tiên có số liệu thắng)
  const MAP = {
    NON_FINANCE: {
      revenue: [21001, 21000], grossRevenue: [21000], cogs: [22100], grossProfit: [23100], selling: [22110], admin: [22200],
      finIncome: [21500], finExpense: [22500], interest: [22510, 22509], assoc: [23300, 23200], otherProfit: [23900], opProfit: [23110],
      pretax: [23800, 23810], tax: [22070], netIncomeAll: [23003], nci: [23500], netIncome: [23000], eps: [23001, 700087],
      cash: [11100], stInvest: [11200], receivables: [11300], inventory: [11400], currentAssets: [11000], ltReceivables: [12100], fixedAssets: [12200],
      investProp: [12400], ltInvest: [12500], goodwill: [12690], totalAssets: [12700], liabilities: [13000], currentLiab: [13100], stDebt: [13110], payables: [13120],
      ltLiab: [13300], ltDebt: [13340], equityAll: [14000], paidIn: [14110], retained: [14200], nciEquity: [14240], deferredRevenue: [13199, 13197], prepaidFromCustomers: [13130],
      cfo: [32000], capexRaw: [32100], capexProceeds: [32200], cfi: [33000], cff: [34000], da: [22230], divPaidRaw: [33600], interestPaidRaw: [31170], taxPaidRaw: [31180],
      shareIssue: [33100], buyback: [33200], debtRaised: [33300], debtRepaid: [33400],
    },
    BANK: {
      interestIncomeGross: [421100], interestExpense: [422100], nii: [421900], feeIncome: [421200], feeExpense: [422200], netFee: [423200], fx: [423300], tradingNet: [423400], investNet: [423500],
      otherNet: [421600], assocIncome: [421700], toi: [421701], opex: [22200], ppop: [88888], provision: [422900], pretax: [23800], tax: [22070], netIncomeAll: [23003], nci: [23500], netIncome: [23000], eps: [23001],
      totalAssets: [12700], liabilities: [13000], equityAll: [14000], paidIn: [14110], retained: [14200], cash: [411100], tradingSec: [411500], investSec: [412300], loansGross: [412000], loansNet: [412100], loanProvision: [412200],
      deposits: [413300], bonds: [413600], borrowFromSBV: [413100], interbankLiab: [413200], interbankAsset: [411400], nciEquity: [14240],
    },
    SECURITIES: {
      revenue: [21001, 21000], grossProfit: [23100], fvtplIncome: [700039], loanIncome: [700044], brokerageRevenue: [621110], brokerageExpense: [700056], interest: [22509], finExpense: [22500], admin: [22200],
      opProfit: [23110], pretax: [23800], tax: [22070], netIncomeAll: [23003], netIncome: [23000], eps: [23001],
      totalAssets: [12700], liabilities: [13000], equityAll: [14000], paidIn: [14110], retained: [14200], cash: [11100], stInvest: [11200], loans: [700001], borrowings: [13110, 700023], htm: [412320], ltInvest: [12500], nciEquity: [14240],
    },
    INSURANCE: {
      revenue: [21001], netPremium: [21440], grossPremium: [21410], claims: [22150], finIncome: [21500], finProfit: [22175], admin: [22200], opProfit: [23110],
      pretax: [23800], tax: [22070], netIncomeAll: [23003], netIncome: [23000], eps: [23001],
      totalAssets: [12700], liabilities: [13000], equityAll: [14000], paidIn: [14110], retained: [14200], cash: [11100], stInvest: [11200], ltInvest: [12500], nciEquity: [14240],
    },
  };

  // Hàng API [{ itemCode, fiscalDate, numericValue }] -> { 'YYYY-MM-DD': { [itemCode]: giá trị } }; nhiều mô hình cùng kỳ được gộp (mã khoản mục không trùng nhau giữa các mô hình)
  function mergeRows(rows) {
    const out = {};
    (rows || []).forEach(function (r) {
      const d = String(r && r.fiscalDate || '').slice(0, 10), c = Math.round(Number(r && r.itemCode)), v = num(r && r.numericValue);
      if (!d || !isFinite(c) || v === null) return;
      (out[d] = out[d] || {})[c] = v;
    });
    return out;
  }

  // Loại doanh nghiệp theo mã mô hình báo cáo xuất hiện nhiều nhất trong hàng API (cột modelType) -- cách nhận dạng chắc chắn nhất.
  function detectFormFromRows(rows) {
    const of = {}; Object.keys(MODELS).forEach(function (f) { MODELS[f].forEach(function (m) { of[m] = f; }); });
    const count = {};
    (rows || []).forEach(function (r) { const f = of[Math.round(Number(r && r.modelType))]; if (f) count[f] = (count[f] || 0) + 1; });
    let best = null; Object.keys(count).forEach(function (f) { if (!best || count[f] > count[best]) best = f; });
    return best;
  }

  // Nhận dạng loại doanh nghiệp từ các mã khoản mục có mặt (khi nguồn không trả cờ riêng): mã 421xxx/411xxx/412xxx đặc trưng ngân hàng...
  function detectForm(items) {
    const has = (c) => items && items[c] !== undefined && items[c] !== null;
    if (has(421701) || has(412000) || has(413300)) return 'BANK';
    if (has(11100) && has(21001)) return 'NON_FINANCE';
    return null;
  }

  function pick(items, codes) { for (let i = 0; i < codes.length; i++) { const v = num(items[codes[i]]); if (v !== null) return v; } return null; }
  const sub = (a, b) => (a === null || b === null ? null : a - b);
  const add = (a, b) => (a === null && b === null ? null : (a || 0) + (b || 0));
  const abs = (a) => (a === null ? null : Math.abs(a));

  // byDate: kết quả mergeRows. Trả mảng kỳ tăng dần theo ngày, mỗi kỳ có trường chuẩn + trường suy ra.
  function normalize(byDate, form) {
    const f = MAP[form] ? form : 'NON_FINANCE', m = MAP[f];
    const dates = Object.keys(byDate || {}).sort();
    return dates.map(function (d) {
      const it = byDate[d], p = { date: d, year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), form: f };
      Object.keys(m).forEach(function (k) { p[k] = pick(it, m[k]); });
      if (f === 'NON_FINANCE') {
        p.equity = p.nciEquity === null ? p.equityAll : sub(p.equityAll, p.nciEquity);                       // vốn chủ của cổ đông công ty mẹ (cùng cơ sở với lợi nhuận của công ty mẹ)
        p.debt = add(p.stDebt, p.ltDebt);
        p.capex = abs(p.capexRaw); p.divPaid = abs(p.divPaidRaw); p.interestPaid = abs(p.interestPaidRaw); p.taxPaid = abs(p.taxPaidRaw);
        p.ebit = p.grossProfit !== null ? sub(sub(p.grossProfit, p.selling === null ? 0 : p.selling), p.admin === null ? 0 : p.admin) : null;   // EBIT hoạt động: lợi nhuận gộp − bán hàng − quản lý (loại thu/chi tài chính, liên kết, thu nhập khác)
        p.ebitda = p.ebit !== null && p.da !== null ? p.ebit + p.da : null;
        p.fcf = p.cfo !== null && p.capex !== null ? p.cfo - p.capex : null;
        p.netCash = sub(add(p.cash, p.stInvest), p.debt);
        p.workingCapital = p.receivables !== null || p.inventory !== null || p.payables !== null ? (p.receivables || 0) + (p.inventory || 0) - (p.payables || 0) : null;
        p.investedCapital = p.equityAll !== null && p.debt !== null ? p.equityAll + p.debt - (p.cash || 0) - (p.stInvest || 0) : null;   // vốn đầu tư theo hướng tài trợ: vốn chủ (cả cổ đông thiểu số) + nợ vay − tiền và đầu tư tài chính ngắn hạn
        p.effTaxRate = p.pretax > 0 && p.tax !== null ? Math.max(0, Math.min(0.5, p.tax / p.pretax)) : null;
      } else if (f === 'BANK') {
        p.equity = p.nciEquity === null ? p.equityAll : sub(p.equityAll, p.nciEquity);
        p.nonInterestIncome = p.toi !== null && p.nii !== null ? p.toi - p.nii : null;
        p.loansNetOfProvision = p.loansNet;
        p.costIncome = p.opex !== null && p.toi > 0 ? p.opex / p.toi : null;
        p.creditCostPct = p.provision !== null && p.loansGross > 0 ? p.provision / p.loansGross : null;
        p.ldr = p.loansGross !== null && p.deposits > 0 ? p.loansGross / p.deposits : null;
      } else {
        p.equity = p.nciEquity === null ? p.equityAll : sub(p.equityAll, p.nciEquity);
      }
      return p;
    });
  }

  // 4 quý gần nhất cộng lại (TTM) cho các trường dòng chảy của kết quả kinh doanh; các trường số dư lấy kỳ mới nhất. periods: kết quả normalize của dữ liệu QUÝ.
  const FLOW = ['revenue', 'cogs', 'grossProfit', 'selling', 'admin', 'finIncome', 'finExpense', 'interest', 'pretax', 'tax', 'netIncomeAll', 'nci', 'netIncome', 'ebit', 'nii', 'toi', 'opex', 'ppop', 'provision', 'netFee'];
  function ttm(quarters) {
    const q = (quarters || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (q.length < 4) return null;
    const last4 = q.slice(-4), latest = q[q.length - 1];
    // 4 quý phải liên tiếp: khoảng giữa kỳ đầu và kỳ cuối không quá ~ 10 tháng
    const spanDays = (Date.parse(last4[3].date) - Date.parse(last4[0].date)) / 86400000;
    if (spanDays > 300) return null;
    const out = Object.assign({}, latest, { ttm: true, date: latest.date });
    FLOW.forEach(function (k) {
      const vals = last4.map(function (x) { return x[k]; });
      out[k] = vals.some(function (v) { return v === null || v === undefined; }) ? null : vals.reduce(function (s, v) { return s + v; }, 0);
    });
    return out;
  }

  // Tăng trưởng gộp hằng năm của một trường qua các kỳ năm (null nếu thiếu/âm)
  function cagr(periods, key, years) {
    const p = (periods || []).filter(function (x) { return x[key] !== null && x[key] !== undefined; });
    if (p.length < 2) return null;
    const n = Math.min(years || p.length - 1, p.length - 1), a = p[p.length - 1 - n][key], b = p[p.length - 1][key];
    if (!(a > 0) || !(b > 0)) return null;
    return Math.pow(b / a, 1 / n) - 1;
  }

  return { MODELS, FORM_LABEL, MAP, mergeRows, detectForm, detectFormFromRows, normalize, ttm, cagr };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBStatements;
