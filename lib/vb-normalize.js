// Logic thuần của VALUATION BENCH: ĐIỀU CHỈNH KHOẢN BẤT THƯỜNG (chuẩn hoá lợi nhuận) -- loại lãi/lỗ không lặp lại khỏi kỳ cơ sở trước khi tính P/E, EV/EBITDA, EPV và biên DCF.
// Một điều chỉnh: { label, type: 'operating' | 'nonoperating', amount (đồng; DƯƠNG = cộng thêm vào lợi nhuận, ÂM = loại bớt khoản lãi một lần), afterTax (mặc định false) }.
//   operating: khoản nằm TRONG EBIT (ví dụ hoàn nhập dự phòng, thanh lý tài sản): cộng vào EBIT, EBITDA, lợi nhuận trước thuế và sau thuế (qua thuế suất).
//   nonoperating: khoản dưới EBIT (ví dụ lãi bán đầu tư, đánh giá lại): chỉ cộng vào lợi nhuận trước thuế và sau thuế, không đổi EBIT/EBITDA.
// suggest() chỉ GỢI Ý (heuristic từ số liệu, có nêu căn cứ); người dùng quyết định áp dụng. Không bao giờ tự động đổi số liệu.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global VBNormalize) và module.exports cho Vitest.
const VBNormalize = (function () {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const TAX = 0.2;

  function clean(list) {
    return (Array.isArray(list) ? list : []).map(function (a) {
      const amount = num(a && a.amount);
      if (amount === null || amount === 0) return null;
      return { label: String((a && a.label) || 'Khoản điều chỉnh').slice(0, 80), type: a.type === 'operating' ? 'operating' : 'nonoperating', amount: amount, afterTax: !!a.afterTax };
    }).filter(function (a) { return a; });
  }

  // Áp điều chỉnh lên kỳ cơ sở (bản sao). taxRate: thuế suất để quy đổi khoản trước thuế sang sau thuế.
  function apply(basis, adjustments, taxRate) {
    const list = clean(adjustments), t = num(taxRate) === null ? TAX : Math.max(0, Math.min(0.5, taxRate));
    const out = Object.assign({}, basis), eff = { ebit: 0, pretax: 0, netIncome: 0 };
    list.forEach(function (a) {
      const pre = a.afterTax ? a.amount / (1 - t) : a.amount, post = a.afterTax ? a.amount : a.amount * (1 - t);
      if (a.type === 'operating') eff.ebit += pre;
      eff.pretax += pre; eff.netIncome += post;
    });
    if (list.length) {
      if (num(out.ebit) !== null) out.ebit = out.ebit + eff.ebit;
      if (num(out.ebitda) !== null) out.ebitda = out.ebitda + eff.ebit;
      if (num(out.pretax) !== null) out.pretax = out.pretax + eff.pretax;
      if (num(out.netIncome) !== null) out.netIncome = out.netIncome + eff.netIncome;
      if (num(out.netIncomeAll) !== null) out.netIncomeAll = out.netIncomeAll + eff.netIncome;
      out.normalized = true;
    }
    return { basis: out, effects: eff, list: list, marginShift: num(basis && basis.revenue) > 0 ? eff.ebit / basis.revenue : 0 };
  }

  // Gợi ý khoản cần soát. Trả { suggestions: [{ id, label, type, amount, why }], flags: [text] }.
  // - thu nhập tài chính vượt xa mức bình quân các năm trước (thường là lãi bán/đánh giá đầu tư) -> gợi ý loại phần vượt (có số tiền)
  // - lợi nhuận đổi mạnh trong khi doanh thu gần như không đổi, hoặc thuế suất bất thường -> chỉ cảnh báo (không có số tiền: cần đọc thuyết minh)
  function suggest(periods, ttm) {
    const P = (periods || []).filter(function (p) { return p && p.form === 'NON_FINANCE'; }), out = { suggestions: [], flags: [] };
    if (P.length < 3) return out;
    const cur = ttm || P[P.length - 1], hist = P.slice(0, -1).slice(-3);
    const fi = num(cur.finIncome), pretax = num(cur.pretax);
    const avgFi = hist.map(function (p) { return num(p.finIncome); }).filter(function (v) { return v !== null; });
    if (fi !== null && pretax > 0 && avgFi.length >= 2) {
      const mean = avgFi.reduce(function (s, v) { return s + v; }, 0) / avgFi.length, excess = fi - mean * 1.5;
      if (fi / pretax > 0.25 && excess > 0.05 * pretax) out.suggestions.push({ id: 'fin-income', label: 'Thu nhập tài chính vượt mức thường lệ', type: 'nonoperating', amount: -Math.round(excess),
        why: 'Thu nhập tài chính kỳ cơ sở chiếm ' + Math.round(fi / pretax * 100) + '% lợi nhuận trước thuế, cao hơn 1,5 lần bình quân ' + avgFi.length + ' năm trước. Gợi ý loại phần vượt (' + Math.round(excess / 1e9) + ' tỷ) nếu là lãi bán hoặc đánh giá lại đầu tư không lặp lại.' });
    }
    const prev = P.length > 1 ? (ttm ? P[P.length - 1] : P[P.length - 2]) : null;
    if (prev && num(cur.netIncome) !== null && num(prev.netIncome) > 0 && num(cur.revenue) > 0 && num(prev.revenue) > 0) {
      const gNi = cur.netIncome / prev.netIncome - 1, gRev = cur.revenue / prev.revenue - 1;
      if (Math.abs(gNi) > 0.6 && Math.abs(gRev) < 0.15) out.flags.push('Lợi nhuận ' + (gNi > 0 ? 'tăng ' : 'giảm ') + Math.round(Math.abs(gNi) * 100) + '% trong khi doanh thu chỉ ' + (gRev >= 0 ? 'tăng ' : 'giảm ') + Math.round(Math.abs(gRev) * 100) + '%: có thể có khoản bất thường, đọc thuyết minh báo cáo để xác định.');
    }
    const eff = num(cur.effTaxRate);
    if (eff !== null && cur.pretax > 0 && (eff < 0.08 || eff > 0.32)) out.flags.push('Thuế suất thực tế ' + Math.round(eff * 100) + '% lệch xa mức 20%: lợi nhuận sau thuế có thể chứa hoàn nhập thuế hoặc ưu đãi tạm thời.');
    return out;
  }

  return { TAX, clean, apply, suggest };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VBNormalize;
