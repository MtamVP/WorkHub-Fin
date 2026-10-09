// Logic thuần: SÀNG LỌC TOÀN THỊ TRƯỜNG trên ảnh chụp ~1.500 mã niêm yết (finance_market_snapshot, cập nhật mỗi ngày làm việc từ VNDirect) và thống kê ngành (finance_sector_stats).
// Khác bộ lọc Tổng Hợp CP (chỉ các mã bạn đã nhập số liệu): ở đây tìm được cả mã bạn chưa từng xem, với tiêu chí định giá TƯƠNG ĐỐI trong ngành (phân vị), chất lượng, tăng trưởng, cổ tức, đòn bẩy, thanh khoản.
// Nguyên tắc (giống lib/screener.js): tiêu chí nào đang bật mà mã THIẾU số liệu thì mã không đạt (không đoán) nhưng được đếm riêng để biết "bao nhiêu mã bị loại vì thiếu dữ liệu";
// điểm 0-100 chỉ để XẾP HẠNG mã đã đạt, không phải khuyến nghị đầu tư. Đòn bẩy (nợ/vốn) không áp dụng cho ngân hàng, bảo hiểm, dịch vụ tài chính (vay là nguyên liệu kinh doanh).
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global MarketScreener) và module.exports cho Vitest. Cần PeerValuation (lib/peer-valuation.js).
const MarketScreener = (function () {
  const PV = (typeof require === 'function' && typeof module !== 'undefined') ? require('./peer-valuation.js') : PeerValuation;
  const FINANCIAL_ICB = ['8300', '8500', '8700'];       // ngân hàng, bảo hiểm, dịch vụ tài chính
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };

  // Mỗi tiêu chí: op 'min' (>= ngưỡng) / 'max' (<= ngưỡng); `pct`: người dùng gõ % nhưng số liệu là tỷ lệ thập phân; `scale`: đổi đơn vị gõ -> đơn vị số liệu (tỷ đồng -> đồng).
  const CRITERIA = [
    { key: 'cap', group: 'Quy mô & thanh khoản', label: 'Vốn hoá tối thiểu', unit: 'tỷ đồng', op: 'min', scale: 1e9, get: (r) => r.m.marketcap },
    { key: 'capMax', group: 'Quy mô & thanh khoản', label: 'Vốn hoá tối đa', unit: 'tỷ đồng', op: 'max', scale: 1e9, get: (r) => r.m.marketcap, hint: 'Kết hợp với vốn hoá tối thiểu để lọc theo khoảng quy mô (ví dụ 1.000 đến 10.000 tỷ).' },
    { key: 'adv', group: 'Quy mô & thanh khoản', label: 'Giá trị giao dịch TB 20 phiên tối thiểu', unit: 'tỷ đồng/ngày', op: 'min', scale: 1e9, get: (r) => r.m.advValue20, hint: 'Mã thanh khoản thấp khó mua bán với vị thế lớn.' },
    { key: 'pe', group: 'Định giá', label: 'P/E tối đa', unit: 'x', op: 'max', positive: true, get: (r) => r.m.pe },
    { key: 'pb', group: 'Định giá', label: 'P/B tối đa', unit: 'x', op: 'max', positive: true, get: (r) => r.m.pb },
    { key: 'evEbitda', group: 'Định giá', label: 'EV/EBITDA tối đa', unit: 'x', op: 'max', positive: true, nonFinancial: true, get: (r) => r.m.evEbitda, hint: 'Giá trị doanh nghiệp (vốn hoá cộng nợ ròng) chia EBITDA hoạt động 4 quý. Hợp với doanh nghiệp nhiều nợ hoặc chu kỳ, nơi P/E dễ lệch. Không áp dụng cho ngân hàng, bảo hiểm, chứng khoán; khoảng 70% doanh nghiệp phi tài chính có đủ số liệu.' },
    { key: 'evRel', group: 'Định giá', label: 'EV/EBITDA so với trung vị ngành tối đa', unit: '%', op: 'max', pct: true, positive: true, nonFinancial: true, get: (r) => r.evEbitdaRel, hint: '80% nghĩa là rẻ hơn trung vị ngành 20% theo EV/EBITDA. Cần ngành có ít nhất 5 mã có số liệu.' },
    { key: 'valPct', group: 'Định giá', label: 'Định giá thuộc nhóm rẻ nhất ngành (phân vị tối đa)', unit: '0-100', op: 'max', get: (r) => r.valuationPct, hint: 'Trung bình phân vị P/E và P/B trong cùng ngành ICB: 0 = rẻ nhất ngành. Cần ngành có ít nhất 5 mã vốn hoá từ 300 tỷ.' },
    { key: 'peHist', group: 'Định giá', label: 'P/E hiện tại so với bình quân 5 năm tối đa', unit: '%', op: 'max', pct: true, get: (r) => (r.m.pe > 0 && r.m.pe5y > 0 ? r.m.pe / r.m.pe5y : null), hint: '70% nghĩa là đang rẻ hơn 30% so với chính lịch sử của mã (chưa tính tăng trưởng đã đổi).' },
    { key: 'ps', group: 'Định giá', label: 'P/S (giá / doanh thu) tối đa', unit: 'x', op: 'max', positive: true, get: (r) => r.m.ps, hint: 'Hợp với doanh nghiệp đang lỗ hoặc lợi nhuận chưa ổn định, khi P/E không dùng được.' },
    { key: 'evSales', group: 'Định giá', label: 'EV/Doanh thu tối đa', unit: 'x', op: 'max', positive: true, nonFinancial: true, get: (r) => r.m.evSales },
    { key: 'pbHist', group: 'Định giá', label: 'P/B hiện tại so với bình quân 5 năm tối đa', unit: '%', op: 'max', pct: true, get: (r) => (r.m.pb > 0 && r.m.pb5y > 0 ? r.m.pb / r.m.pb5y : null), hint: 'Hợp với ngân hàng và doanh nghiệp tài sản nặng, nơi P/B ổn định hơn P/E.' },
    { key: 'roe', group: 'Chất lượng', label: 'ROE tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.roae },
    { key: 'roic', group: 'Chất lượng', label: 'ROIC tối thiểu', unit: '%', op: 'min', pct: true, nonFinancial: true, get: (r) => r.m.roic, hint: 'Lợi nhuận trên vốn đầu tư (vốn chủ cộng nợ vay), bình quân 5 quý. Khó "làm đẹp" bằng đòn bẩy hơn ROE: ROIC cao và bền là dấu hiệu lợi thế cạnh tranh.' },
    { key: 'roa', group: 'Chất lượng', label: 'ROA tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.roaa, hint: 'Ngân hàng tốt thường có ROA từ 1,5% trở lên.' },
    { key: 'margin', group: 'Chất lượng', label: 'Biên lợi nhuận ròng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.netMargin, hint: 'Không so sánh được giữa ngân hàng và doanh nghiệp thường.' },
    { key: 'gross', group: 'Chất lượng', label: 'Biên lợi nhuận gộp tối thiểu', unit: '%', op: 'min', pct: true, nonFinancial: true, get: (r) => r.m.grossMargin, hint: 'Biên gộp cao và ổn định thường là dấu hiệu sức mạnh định giá bán.' },
    { key: 'ebitM', group: 'Chất lượng', label: 'Biên EBIT tối thiểu', unit: '%', op: 'min', pct: true, nonFinancial: true, get: (r) => r.m.ebitMargin },
    { key: 'marginUp', group: 'Chất lượng', label: 'Thay đổi biên lợi nhuận so với cùng kỳ tối thiểu', unit: 'điểm %', op: 'min', pct: true, nonFinancial: true, get: (r) => r.m.deltaMargin, hint: '0 nghĩa là biên lợi nhuận 12 tháng không giảm so với cùng kỳ; số dương là đang cải thiện (VNDirect).' },
    { key: 'health', group: 'Chất lượng', label: 'Điểm sức khoẻ tài chính tối thiểu', unit: '0-9', op: 'min', get: (r) => (r.health ? r.health.score : null), hint: 'Đếm số dấu hiệu tốt trong 9 dấu hiệu kiểu Piotroski (lãi, dòng tiền, chất lượng lợi nhuận, biên, đòn bẩy, thanh khoản) tính từ chỉ số VNDirect; ngân hàng dùng 6 dấu hiệu riêng quy về thang 9. Bản rút gọn: dùng mức hiện tại thay cho thay đổi qua từng năm như điểm Piotroski gốc. Từ 8 trở lên là tốt (đo 09/10/2026: khoảng 31% doanh nghiệp phi tài chính có điểm đạt mức này).' },
    { key: 'epsG', group: 'Tăng trưởng', label: 'Tăng trưởng EPS so với cùng kỳ tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.epsGrowthYoY },
    { key: 'netG', group: 'Tăng trưởng', label: 'Tăng trưởng lợi nhuận ròng 12 tháng so với cùng kỳ tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.netProfitGrowthYoY, hint: 'Lợi nhuận ròng 4 quý gần nhất so với 4 quý cùng kỳ năm trước (VNDirect).' },
    { key: 'netGq', group: 'Tăng trưởng', label: 'Tăng trưởng lợi nhuận ròng quý gần nhất so với cùng quý tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.netProfitGrowthQ },
    { key: 'net3y', group: 'Tăng trưởng', label: 'Tăng trưởng lợi nhuận ròng bình quân 3 năm tối thiểu', unit: '%/năm', op: 'min', pct: true, get: (r) => r.m.netProfitGrowth3y, hint: 'Tốc độ tăng trưởng kép mỗi năm trong 3 năm: lọc bớt mã chỉ tăng nhờ một kỳ.' },
    { key: 'pretaxG', group: 'Tăng trưởng', label: 'Tăng trưởng lợi nhuận trước thuế 12 tháng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.pretaxGrowthYoY },
    { key: 'salesG', group: 'Tăng trưởng', label: 'Tăng trưởng doanh thu so với cùng kỳ tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.salesGrowthYoY },
    { key: 'div', group: 'Cổ tức & cổ đông', label: 'Tỷ suất cổ tức tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.divYield },
    { key: 'payout', group: 'Cổ tức & cổ đông', label: 'Tỷ lệ chi trả cổ tức tối đa', unit: '%', op: 'max', pct: true, get: (r) => r.m.payoutTtm, hint: 'Cổ tức chia cho lợi nhuận 12 tháng. Trên 100% là trả nhiều hơn lợi nhuận làm ra: khó bền.' },
    { key: 'freefloat', group: 'Cổ tức & cổ đông', label: 'Tỷ lệ cổ phiếu tự do chuyển nhượng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.freefloat, hint: 'Tỷ lệ thấp (cổ đông lớn nắm gần hết) thì giá dễ bị chi phối và khó mua lượng lớn.' },
    { key: 'de', group: 'An toàn & dòng tiền', label: 'Nợ / vốn chủ tối đa', unit: 'x', op: 'max', get: (r) => r.m.debtToEquity, nonFinancial: true, hint: 'Không áp dụng cho ngân hàng, bảo hiểm, dịch vụ tài chính.' },
    { key: 'netCash', group: 'An toàn & dòng tiền', label: 'Tiền mặt ròng / vốn chủ tối thiểu', unit: '%', op: 'min', pct: true, nonFinancial: true, get: (r) => r.m.netCashToEquity, hint: '0 nghĩa là không có nợ vay ròng; số dương là tiền mặt nhiều hơn nợ vay.' },
    { key: 'icr', group: 'An toàn & dòng tiền', label: 'Khả năng trả lãi (EBIT / chi phí lãi vay) tối thiểu', unit: 'x', op: 'min', nonFinancial: true, get: (r) => r.m.interestCoverage, hint: 'Dưới 1,5 lần là nguy hiểm. Doanh nghiệp không vay nợ thường không có số này nên bị coi là thiếu số liệu: dùng "Tiền mặt ròng / vốn chủ" thay thế.' },
    { key: 'cr', group: 'An toàn & dòng tiền', label: 'Thanh toán hiện hành tối thiểu', unit: 'x', op: 'min', nonFinancial: true, get: (r) => r.m.currentRatio, hint: 'Tài sản ngắn hạn / nợ ngắn hạn; dưới 1 là phải dựa vào vay mới để trả nợ đến hạn.' },
    { key: 'cfo', group: 'An toàn & dòng tiền', label: 'Dòng tiền kinh doanh / doanh thu tối thiểu', unit: '%', op: 'min', pct: true, nonFinancial: true, get: (r) => r.m.cfoToSales, hint: 'Lợi nhuận có thật bằng tiền: biên dòng tiền thấp hơn hẳn biên lợi nhuận ròng là dấu hiệu lợi nhuận "trên giấy".' },
    { key: 'cfoYears', group: 'An toàn & dòng tiền', label: 'Số năm có dòng tiền kinh doanh dương (trong 2 năm) tối thiểu', unit: 'năm', op: 'min', nonFinancial: true, get: (r) => r.m.positiveCfo2y },
    { key: 'betaMax', group: 'An toàn & dòng tiền', label: 'Beta tối đa', unit: 'x', op: 'max', get: (r) => r.m.beta, hint: 'Độ nhạy với thị trường chung: 1 là đi cùng thị trường, dưới 1 là ít biến động hơn.' },
    { key: 'nim', group: 'Riêng ngân hàng', label: 'Biên lãi ròng (NIM) tối thiểu', unit: '%', op: 'min', pct: true, bankOnly: true, get: (r) => r.m.nim, hint: 'Chỉ ngân hàng: bật tiêu chí trong nhóm này thì kết quả chỉ còn ngân hàng. Bình quân 5 quý.' },
    { key: 'nplCover', group: 'Riêng ngân hàng', label: 'Dự phòng / nợ xấu tối thiểu', unit: '%', op: 'min', pct: true, bankOnly: true, get: (r) => r.m.badDebtCoverage, hint: 'Tỷ lệ bao phủ nợ xấu: 100% là đã trích dự phòng bằng toàn bộ nợ xấu. Cao thì có "đệm" khi nợ xấu tăng.' },
    { key: 'eqAsset', group: 'Riêng ngân hàng', label: 'Vốn chủ / tổng tài sản tối thiểu', unit: '%', op: 'min', pct: true, bankOnly: true, get: (r) => r.m.equityToAsset, hint: 'Đệm vốn: ngân hàng có tỷ lệ cao chịu được tổn thất lớn hơn.' },
    { key: 'ytd', group: 'Giá', label: 'Biến động giá từ 1/1 đến nay tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.chgYtd, hint: 'Giá hiện tại so với giá đóng cửa cuối năm trước (VNDirect, có thể lệch nhẹ so với giá điều chỉnh).' },
    { key: 'ytdMax', group: 'Giá', label: 'Biến động giá từ 1/1 đến nay tối đa', unit: '%', op: 'max', pct: true, get: (r) => r.m.chgYtd, hint: 'Kết hợp với mức tối thiểu để lọc theo khoảng (ví dụ từ -10 đến +20). Số âm để tìm mã đã giảm từ đầu năm.' },
    { key: 'chg1m', group: 'Giá', label: 'Biến động giá 1 tháng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.chg1m },
    { key: 'chg3m', group: 'Giá', label: 'Biến động giá 3 tháng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.chg3m, hint: 'Động lượng ngắn hạn: giá 3 tháng qua tăng ít nhất bao nhiêu.' },
    { key: 'chg6m', group: 'Giá', label: 'Biến động giá 6 tháng tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.m.chg6m },
    { key: 'jdkRs', group: 'Giá', label: 'RS-Ratio (JdK) tối thiểu', unit: '100 = ngang thị trường', op: 'min', get: (r) => r.m.jdkRs, hint: 'Sức mạnh tương đối so với thị trường theo VNDirect; từ 100 trở lên là mạnh hơn thị trường.' },
    { key: 'jdkMom', group: 'Giá', label: 'RS-Momentum (JdK) tối thiểu', unit: '100 = ngang thị trường', op: 'min', get: (r) => r.m.jdkMom, hint: 'Sức mạnh tương đối đang tăng tốc (từ 100 trở lên) hay chậm lại.' },
    { key: 'chg1y', group: 'Giá', label: 'Biến động giá 12 tháng tối đa', unit: '%', op: 'max', pct: true, get: (r) => r.m.chg1y, hint: 'Đặt số âm (ví dụ -25) để tìm mã đã giảm sâu; kết hợp với ROE để tránh mã giảm vì kém.' },
    { key: 'nearHigh', group: 'Giá', label: 'Cách đỉnh 52 tuần tối đa', unit: '%', op: 'max', pct: true, get: (r) => r.offHigh, hint: '10 nghĩa là giá đang trong vòng 10% dưới đỉnh cao nhất 52 tuần: mã khoẻ, đang gần vùng đỉnh. Giá hiện tại = vốn hoá / số cổ phiếu.' },
    { key: 'offHigh', group: 'Giá', label: 'Giảm từ đỉnh 52 tuần tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.offHigh, hint: '30 nghĩa là giá đã thấp hơn đỉnh 52 tuần từ 30% trở lên.' },
    { key: 'aboveLow', group: 'Giá', label: 'Cao hơn đáy 52 tuần tối thiểu', unit: '%', op: 'min', pct: true, get: (r) => r.aboveLow, hint: 'Kết hợp với "Giảm từ đỉnh" để tìm mã đã giảm sâu nhưng bắt đầu rời đáy.' },
  ];
  const BY_KEY = {}; CRITERIA.forEach((c) => { BY_KEY[c.key] = c; });

  const PRESETS = [
    { key: 'qgarp', label: 'Rẻ và chất lượng', desc: 'Định giá thuộc 40% rẻ nhất ngành, ROE từ 15%, vốn hoá từ 1.000 tỷ, thanh khoản từ 5 tỷ/ngày.', values: { valPct: 40, roe: 15, cap: 1000, adv: 5 } },
    { key: 'income', label: 'Cổ tức bền', desc: 'Tỷ suất cổ tức từ 5%, ROE từ 10%, nợ/vốn chủ không quá 1,5 lần, vốn hoá từ 1.000 tỷ.', values: { div: 5, roe: 10, de: 1.5, cap: 1000 } },
    { key: 'growth', label: 'Tăng trưởng giá hợp lý', desc: 'Tăng trưởng EPS từ 15%, P/E không quá 15, ROE từ 12%, vốn hoá từ 1.000 tỷ.', values: { epsG: 15, pe: 15, roe: 12, cap: 1000 } },
    { key: 'history', label: 'Rẻ hơn lịch sử', desc: 'P/E hiện tại không quá 70% bình quân 5 năm của chính mã, ROE từ 10%, vốn hoá từ 1.000 tỷ.', values: { peHist: 70, roe: 10, cap: 1000 } },
    { key: 'momentum', label: 'Dẫn đầu và có nền tảng', desc: 'Sức mạnh tương đối so với thị trường từ 100 và đang tăng tốc (JdK dẫn đầu), ROE từ 12%, vốn hoá từ 1.000 tỷ, thanh khoản từ 5 tỷ/ngày, không đắt quá so với ngành (phân vị định giá tối đa 70).', values: { jdkRs: 100, jdkMom: 100, roe: 12, cap: 1000, adv: 5, valPct: 70 } },
    { key: 'bysector', label: 'Dẫn đầu từng ngành', desc: 'Vốn hoá từ 1.000 tỷ, thanh khoản từ 2 tỷ/ngày, lợi nhuận ròng 12 tháng tăng từ 10%, lấy tối đa 5 mã mỗi ngành theo điểm tổng hợp (khoảng 100 mã nếu chọn nhiều ngành).', values: { cap: 1000, adv: 2, netG: 10 }, perSector: 5 },
    { key: 'drawdown', label: 'Giảm sâu, nền tảng còn tốt', desc: 'Giá 12 tháng giảm từ 25%, ROE từ 12%, P/E không quá 15, thanh khoản từ 5 tỷ/ngày. Cần xem vì sao giảm trước khi quan tâm.', values: { chg1y: -25, roe: 12, pe: 15, adv: 5 } },
    { key: 'roicq', label: 'Chất lượng cao theo ROIC', desc: 'ROIC từ 15%, dòng tiền kinh doanh dương cả 2 năm, biên lợi nhuận không giảm quá 2 điểm %, vốn hoá từ 1.000 tỷ, thanh khoản từ 2 tỷ/ngày. Doanh nghiệp phi tài chính.', values: { roic: 15, cfoYears: 2, marginUp: -2, cap: 1000, adv: 2 } },
    { key: 'healthy', label: 'Sức khoẻ tài chính tốt, giá hợp lý', desc: 'Điểm sức khoẻ tài chính từ 8/9, định giá không đắt so với ngành (phân vị tối đa 60), vốn hoá từ 500 tỷ, thanh khoản từ 2 tỷ/ngày.', values: { health: 8, valPct: 60, cap: 500, adv: 2 } },
    { key: 'nearhigh', label: 'Gần đỉnh 52 tuần, chưa đắt', desc: 'Giá trong vòng 10% dưới đỉnh 52 tuần, sức mạnh tương đối từ 100, ROE từ 12%, định giá phân vị ngành tối đa 70, vốn hoá từ 1.000 tỷ, thanh khoản từ 5 tỷ/ngày.', values: { nearHigh: 10, jdkRs: 100, roe: 12, valPct: 70, cap: 1000, adv: 5 } },
    { key: 'bank', label: 'Ngân hàng tốt', desc: 'Chỉ ngân hàng: ROE từ 15%, NIM từ 2,5%, dự phòng từ 80% nợ xấu, P/B không quá 1,8 lần, thanh khoản từ 5 tỷ/ngày. (09/10/2026: trung vị ngân hàng niêm yết NIM khoảng 2,5%, dự phòng/nợ xấu khoảng 67%.)', values: { roe: 15, nim: 2.5, nplCover: 80, pb: 1.8, adv: 5 } },
  ];

  // Trọng số mặc định của điểm xếp hạng (người dùng chỉnh được theo từng bộ lọc: filters.weights). Động lượng mặc định 0 để giữ nguyên cách xếp cũ.
  const WEIGHTS = { value: 0.3, quality: 0.3, growth: 0.2, income: 0.1, safety: 0.1, momentum: 0 };
  const WEIGHT_LABELS = { value: 'Định giá', quality: 'Chất lượng', growth: 'Tăng trưởng', income: 'Cổ tức', safety: 'An toàn', momentum: 'Động lượng giá' };
  const BANK_ICB = '8300';
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const lin = (v, lo, hi) => clamp01((v - lo) / (hi - lo)) * 100;

  // Giá hiện tại = vốn hoá / số cổ phiếu (ảnh chụp không có giá); chỉ nhận khi nằm trong khoảng hợp lý quanh đỉnh/đáy 52 tuần (số cổ phiếu cũ sau phát hành thêm sẽ làm lệch)
  function priceOf(m) {
    const cap = num(m.marketcap), sh = num(m.shares);
    if (!(cap > 0 && sh > 0)) return null;
    const p = cap / sh, hi = num(m.high52), lo = num(m.low52);
    if (hi > 0 && p > hi * 1.15) return null;
    if (lo > 0 && p < lo * 0.85) return null;
    return p;
  }

  // ĐIỂM SỨC KHOẺ TÀI CHÍNH kiểu Piotroski, bản rút gọn từ chỉ số VNDirect (mức hiện tại thay cho thay đổi qua từng năm). Trả { score 0-9, pass, avail, items[{label, ok}] } hoặc null khi thiếu số liệu.
  // Doanh nghiệp phi tài chính: 9 dấu hiệu, cần đủ ít nhất 7. Ngân hàng: 6 dấu hiệu riêng (cần đủ 5) quy về thang 9. Bảo hiểm, chứng khoán: không tính (cấu trúc báo cáo khác hẳn).
  function health(row) {
    const m = row.m, icb = row.icb2_code, items = [];
    const add = (label, v, test) => { if (v === null) return; items.push({ label, ok: !!test(v) }); };
    let need;
    if (icb === BANK_ICB) {
      add('ROE từ 15%', num(m.roae), (v) => v >= 0.15);
      add('ROA từ 1%', num(m.roaa), (v) => v >= 0.01);
      add('NIM từ 2,5%', num(m.nim), (v) => v >= 0.025);
      add('Dự phòng từ 80% nợ xấu', num(m.badDebtCoverage), (v) => v >= 0.8);
      add('Vốn chủ từ 8% tổng tài sản', num(m.equityToAsset), (v) => v >= 0.08);
      add('Lợi nhuận 12 tháng tăng so với cùng kỳ', num(m.netProfitGrowthYoY), (v) => v > 0);
      need = 5;
    } else if (row.financial) {
      return null;
    } else {
      const cfo = num(m.cfoToSales), nm = num(m.netMargin), icr = num(m.interestCoverage), nc = num(m.netCashToEquity);
      add('Có lãi (ROA dương)', num(m.roaa), (v) => v > 0);
      add('Dòng tiền kinh doanh dương', cfo, (v) => v > 0);
      add('Dòng tiền kinh doanh dương cả 2 năm', num(m.positiveCfo2y), (v) => v >= 2);
      add('Lợi nhuận có tiền đi kèm (biên dòng tiền ≥ biên lợi nhuận ròng)', cfo !== null && nm !== null ? cfo - nm : null, (v) => v >= 0);
      add('Lợi nhuận 12 tháng tăng so với cùng kỳ', num(m.netProfitGrowthYoY), (v) => v > 0);
      add('Biên lợi nhuận không giảm', num(m.deltaMargin), (v) => v >= 0);
      add('Trả lãi vay thoải mái (từ 3 lần) hoặc không nợ ròng', icr === null && nc === null ? null : 1, () => (icr !== null && icr >= 3) || (nc !== null && nc >= 0));
      add('Thanh toán hiện hành từ 1', num(m.currentRatio), (v) => v >= 1);
      add('Nợ vay / vốn chủ không quá 1', num(m.debtToEquity), (v) => v <= 1);
      need = 7;
    }
    if (items.length < need) return null;
    const pass = items.filter((x) => x.ok).length;
    // thang 9 cho cả hai loại; thiếu vài dấu hiệu thì tính theo tỷ lệ đạt trên số dấu hiệu có số liệu
    return { score: Math.round((pass / items.length) * 9), pass, avail: items.length, items };
  }

  // Chuẩn hoá ảnh chụp -> hàng có thêm phân vị ngành. statsByIcb: { icb2_code: { stats } } (kể cả 'ALL' dùng khi ngành không đủ thống kê)
  function buildRows(snapshot, statsByIcb, meta) {
    const st = statsByIcb || {}, mt = meta || {}, qcache = {};
    return (snapshot || []).map((s) => {
      const m = s.metrics || {}, icb = s.icb2_code || null, sec = icb && st[icb] ? st[icb].stats : null;
      const a = sec ? PV.assess(m, sec) : null;
      const eb = sec && sec.evEbitda && sec.evEbitda.n >= 5 && sec.evEbitda.median > 0 ? sec.evEbitda.median : null;      // EV/EBITDA của mã so với trung vị ngành (ít nhất 5 mã có số liệu)
      const info = mt[s.symbol] || {};
      const price = priceOf(m), hi = num(m.high52), lo = num(m.low52);
      const row = { symbol: String(s.symbol).toUpperCase(), name: info.name || '', exchange: info.exchange || '', icb2_code: icb, financial: FINANCIAL_ICB.indexOf(icb) !== -1, bank: icb === BANK_ICB, m: m,
        evEbitdaRel: eb !== null && num(m.evEbitda) > 0 ? m.evEbitda / eb : null, valuationPct: a ? a.valuationPct : null, qualityPct: a ? a.qualityPct : null, verdict: a ? a.verdict : null, sectorN: a && a.n ? a.n : null,
        peerQuality: sec ? (qcache[icb] = qcache[icb] || PV.quality(st[icb], { financial: FINANCIAL_ICB.indexOf(icb) !== -1 })) : null,
        price: price, offHigh: price !== null && hi > 0 ? Math.max(0, 1 - price / hi) : null, aboveLow: price !== null && lo > 0 ? Math.max(0, price / lo - 1) : null };
      row.health = health(row);
      return row;
    });
  }

  function threshold(c, raw) {
    const v = num(raw);
    if (v === null) return null;
    return c.pct ? v / 100 : (c.scale ? v * c.scale : v);
  }
  function normalizeFilters(f) {
    const out = { values: {}, icbs: [], perSector: 0, topN: 0 };
    const src = f && f.values ? f.values : {};
    CRITERIA.forEach((c) => { const v = num(src[c.key]); if (v !== null) out.values[c.key] = v; });
    const raw = f && Array.isArray(f.icbs) ? f.icbs : (f && typeof f.icb === 'string' && f.icb ? [f.icb] : []);      // f.icb: định dạng cũ (một ngành)
    out.icbs = [...new Set(raw.map((x) => String(x)).filter(Boolean))];
    const cnt = (v) => { const n = num(v); return n !== null && n >= 1 ? Math.floor(n) : 0; };
    out.perSector = cnt(f && f.perSector); out.topN = cnt(f && f.topN);
    out.weights = normalizeWeights(f && f.weights);
    return out;
  }

  // Trọng số người dùng nhập (0-100 hoặc tỷ lệ, chỉ nhóm đã biết, không âm) -> null nếu không nhập gì hoặc tổng bằng 0 (dùng mặc định)
  function normalizeWeights(w) {
    if (!w || typeof w !== 'object') return null;
    const out = {}; let any = false, sum = 0;
    Object.keys(WEIGHTS).forEach((k) => { const v = num(w[k]); if (v !== null && v >= 0) { out[k] = v; any = true; sum += v; } });
    return any && sum > 0 ? out : null;
  }
  function weightsOf(f) {
    const w = f && f.weights ? f.weights : null;
    if (!w) return WEIGHTS;
    const out = {}; Object.keys(WEIGHTS).forEach((k) => { out[k] = w[k] !== undefined ? w[k] : 0; });
    return out;
  }

  function check(row, c, raw) {
    if (c.bankOnly && !row.bank) return { key: c.key, status: 'fail', value: null };      // tiêu chí riêng ngân hàng: mã khác không đạt
    if (c.nonFinancial && row.financial) return { key: c.key, status: 'na' };
    const v = num(c.get(row));
    if (v === null) return { key: c.key, status: 'missing' };
    if (c.positive && !(v > 0)) return { key: c.key, status: 'fail', value: v };
    const t = threshold(c, raw);
    const ok = c.op === 'min' ? v >= t - 1e-12 : v <= t + 1e-12;
    return { key: c.key, status: ok ? 'pass' : 'fail', value: v };
  }

  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  // Điểm xếp hạng 0-100: ghép 6 nhóm theo trọng số (mặc định WEIGHTS, hoặc của bộ lọc), chuẩn hoá theo nhóm có dữ liệu và trọng số > 0 (cần >= 2 nhóm)
  function score(row, weights) {
    const m = row.m, parts = {}, W = weights || WEIGHTS;
    if (row.valuationPct !== null) parts.value = 100 - row.valuationPct;
    else if (num(m.pe) > 0) parts.value = lin(25 - m.pe, 0, 20);
    const q = []; if (num(m.roae) !== null) q.push(lin(m.roae, 0.03, 0.25)); if (num(m.netMargin) !== null) q.push(lin(m.netMargin, 0.02, 0.2));
    if (row.health) q.push(row.health.score / 9 * 100);                                         // điểm sức khoẻ tài chính góp vào nhóm chất lượng
    if (q.length) parts.quality = avg(q);
    const g = []; if (num(m.epsGrowthYoY) !== null) g.push(lin(m.epsGrowthYoY, -0.1, 0.3)); if (num(m.salesGrowthYoY) !== null) g.push(lin(m.salesGrowthYoY, -0.05, 0.25)); if (g.length) parts.growth = avg(g);
    if (num(m.divYield) !== null) parts.income = lin(m.divYield, 0, 0.07);
    if (!row.financial && num(m.debtToEquity) !== null) parts.safety = 100 - lin(m.debtToEquity, 0.3, 2.5);
    // động lượng: sức mạnh tương đối JdK (90 -> 0 điểm, 110 -> 100) và vị trí so với đỉnh 52 tuần (cách đỉnh 40% -> 0, ở đỉnh -> 100)
    const mo = []; if (num(m.jdkRs) !== null) mo.push(lin(m.jdkRs, 90, 110)); if (row.offHigh !== null && row.offHigh !== undefined) mo.push(lin(0.4 - row.offHigh, 0, 0.4)); if (mo.length) parts.momentum = avg(mo);
    let sum = 0, wsum = 0, n = 0;
    Object.keys(parts).forEach((k) => { const w = W[k] || 0; if (!(w > 0)) return; sum += parts[k] * w; wsum += w; n++; });
    // cần đủ 2 nhóm có số liệu; nếu người dùng chỉ đặt trọng số cho 1 nhóm thì 1 nhóm là đủ (nếu không mọi điểm thành trống và bảng xếp theo vốn hoá)
    const need = Math.min(2, Object.keys(WEIGHTS).filter((k) => (W[k] || 0) > 0).length) || 2;
    return { total: n >= need ? sum / wsum : null, parts: parts };
  }

  // Cảnh báo "coi chừng" cho từng mã: số liệu trông đẹp nhưng thường do nguyên nhân không bền (lợi nhuận một lần, thanh khoản mỏng...)
  function flags(row) {
    const m = row.m, out = [];
    if (num(m.pe) > 0 && m.pe < 4) out.push('P/E dưới 4x thường do lợi nhuận bất thường một lần: kiểm tra báo cáo');
    if (num(m.epsGrowthYoY) !== null && m.epsGrowthYoY > 1) out.push('EPS tăng hơn gấp đôi cùng kỳ: có thể do khoản thu nhập một lần');
    if (num(m.roae) !== null && m.roae > 0.4 && !row.financial) out.push('ROE trên 40% bất thường: có thể do vốn chủ quá nhỏ hoặc lợi nhuận một lần');
    if (num(m.advValue20) !== null && m.advValue20 < 1e9) out.push('Thanh khoản dưới 1 tỷ/ngày: khó mua bán');
    if (row.sectorN !== null && row.sectorN < 10) out.push('Ngành chỉ có ' + row.sectorN + ' mã trong thống kê: phân vị kém chắc chắn');
    if (!row.financial && num(m.cfoToSales) !== null && m.cfoToSales < 0 && num(m.netMargin) > 0) out.push('Có lãi nhưng dòng tiền kinh doanh âm: lợi nhuận chưa thu được tiền');
    if (!row.financial && num(m.interestCoverage) !== null && m.interestCoverage < 1.5) out.push('Lợi nhuận hoạt động chưa tới 1,5 lần lãi vay: áp lực nợ');
    if (num(m.payoutTtm) !== null && m.payoutTtm > 1.2) out.push('Trả cổ tức nhiều hơn lợi nhuận làm ra: khó duy trì');
    return out;
  }

  // rows: kết quả buildRows; filters: { values, icb }. Trả { entries (đạt, điểm cao trước), counts: { universe, passed, missing: {key: số mã bị loại vì thiếu số liệu}, failedBy } }
  function evaluate(rows, filters) {
    const f = normalizeFilters(filters), active = CRITERIA.filter((c) => f.values[c.key] !== undefined), W = weightsOf(f);
    const counts = { universe: 0, passed: 0, missing: {}, failedBy: {} };
    const entries = [];
    (rows || []).forEach((r) => {
      if (f.icbs.length && f.icbs.indexOf(r.icb2_code) === -1) return;
      counts.universe++;
      let ok = true;
      active.forEach((c) => {
        const res = check(r, c, f.values[c.key]);
        if (res.status === 'missing') { counts.missing[c.key] = (counts.missing[c.key] || 0) + 1; ok = false; }
        else if (res.status === 'fail') { counts.failedBy[c.key] = (counts.failedBy[c.key] || 0) + 1; ok = false; }
      });
      if (ok) { const s = score(r, W); entries.push({ row: r, score: s.total, parts: s.parts, flags: flags(r) }); }
    });
    entries.sort((a, b) => (b.score === null ? -1 : b.score) - (a.score === null ? -1 : a.score) || b.row.m.marketcap - a.row.m.marketcap);
    counts.matched = entries.length;            // số mã đạt trước khi cắt theo "tối đa mỗi ngành / tổng"
    let out = entries;
    if (f.perSector) { const used = {}; out = out.filter((e) => { const k = e.row.icb2_code || ''; used[k] = (used[k] || 0) + 1; return used[k] <= f.perSector; }); }
    if (f.topN) out = out.slice(0, f.topN);
    counts.passed = out.length;
    counts.active = active.length;
    counts.cut = counts.matched - out.length;
    return { entries: out, counts: counts };
  }

  // Trong danh sách mã `symbols`, mã nào đạt mẫu lọc `presetKey` (mặc định "Rẻ và chất lượng"): { SYM: { label, score, valuationPct, roe, flags, name } }.
  // Dùng cho danh sách theo dõi: báo mã đang canh vừa lọt vào nhóm rẻ và chất lượng. Mã bị cờ số liệu bất thường (P/E dưới 4x, EPS tăng gấp đôi, ROE trên 40%) vẫn đạt nhưng kèm cờ để người dùng soát.
  function matches(rows, symbols, presetKey) {
    const preset = PRESETS.find((p) => p.key === (presetKey || 'qgarp')), want = {};
    (symbols || []).forEach((s) => { want[String(s).toUpperCase()] = true; });
    const out = {};
    if (!preset) return out;
    const sub = (rows || []).filter((r) => want[r.symbol]);
    evaluate(sub, { values: preset.values }).entries.forEach((e) => {
      out[e.row.symbol] = { label: preset.label, score: e.score, valuationPct: e.row.valuationPct, roe: num(e.row.m.roae), flags: e.flags, name: e.row.name };
    });
    return out;
  }

  function describe(key, raw) {
    const c = BY_KEY[key], v = num(raw);
    if (!c || v === null) return '';
    return c.label + (c.op === 'min' ? ' ≥ ' : ' ≤ ') + v + (c.unit && c.unit !== '0-100' ? ' ' + c.unit : '');
  }

  return { CRITERIA, BY_KEY, PRESETS, WEIGHTS, WEIGHT_LABELS, FINANCIAL_ICB, BANK_ICB, buildRows, normalizeFilters, normalizeWeights, weightsOf, evaluate, score, describe, flags, matches, health, priceOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MarketScreener;
