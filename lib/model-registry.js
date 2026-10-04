// Logic thuần: SỔ ĐĂNG KÝ MÔ HÌNH -- liệt kê từng mô hình/phép tính chuyên môn mà Investment Workbench dùng, kèm phiên bản, tham số mặc định, nguồn dữ liệu, cách đã kiểm chứng và GIỚI HẠN đã biết.
// Mục đích: quản lý rủi ro mô hình (model risk governance) -- người dùng và hội đồng đầu tư biết con số đến từ đâu, đã được đối chiếu thế nào và khi nào KHÔNG nên tin.
// Mỗi mục `validation.tests` trỏ tới tệp kiểm thử thật (tests/unit/model-registry.test.js kiểm các tệp này tồn tại), `golden` là tệp số chuẩn sinh bằng Python (numpy/scipy) nếu có.
// KHÔNG đụng DOM/mạng/Supabase. Nạp bằng thẻ <script> thường (global ModelRegistry) và module.exports cho Vitest.
const ModelRegistry = (function () {
  const VERSION = '2026.10.04';

  const MODELS = [
    { id: 'risk-var', area: 'Rủi ro', name: 'VaR / ES: mô phỏng lịch sử lọc (FHS), EWMA, Ledoit-Wolf', lib: 'lib/risk-models.js, lib/risk-calc.js',
      method: 'Phương sai EWMA (lambda 0,94), co ma trận hiệp phương sai Ledoit-Wolf, beta Dimson cho mã kém thanh khoản, VaR/ES theo mô phỏng lịch sử lọc FHS; kiểm ngược Kupiec (số lần vượt) và Christoffersen (độc lập); tương quan căng thẳng.',
      params: 'Độ tin cậy 95%/99%, lambda 0,94, cửa sổ kiểm ngược thích ứng (~45% số quan sát, tối thiểu 60).',
      data: 'Giá đóng cửa VNDirect (dchart), lọc qua kiểm hai nguồn.',
      validation: { tests: ['tests/unit/risk-models.test.js'], golden: 'tests/fixtures/risk-models-golden.json', note: 'So khớp numpy/scipy tới 1e-9 trên dữ liệu cố định.' },
      limits: 'Chuỗi giá ngắn (dưới ~250 phiên) làm VaR 99% kém ổn định; không mô hình hoá nhảy giá do đình chỉ giao dịch; giả định thanh khoản đủ để bán ở giá đóng cửa.' },
    { id: 'perf', area: 'Hiệu quả', name: 'Hiệu quả đầu tư: TWR, XIRR, Sharpe, alpha/beta', lib: 'lib/perf-calc.js',
      method: 'TWR nối theo ngày, XIRR theo dòng tiền, Sharpe/Sortino với lãi phi rủi ro theo ngày (lợi suất TPCP 1 năm), alpha và khoảng tin cậy, số năm cần để alpha có ý nghĩa, lợi suất giá (không cổ tức) so với tổng.',
      params: 'Lãi phi rủi ro: chuỗi finance_rates 1Y; trước ngày có dữ liệu dùng mức cài tay. Chuẩn so sánh: VN-Index.',
      data: 'NAV hằng ngày, giao dịch, cổ tức, finance_rates.',
      validation: { tests: ['tests/unit/perf-calc.test.js'], golden: 'tests/fixtures/perf-golden.json', note: 'Đối chiếu Python cho TWR/XIRR/alpha.' },
      limits: 'Lịch sử lãi phi rủi ro chỉ bắt đầu từ 03/10/2026; trước đó dùng mức cài tay nên Sharpe các kỳ cũ là xấp xỉ.' },
    { id: 'brinson', area: 'Hiệu quả', name: 'Phân rã Brinson (BHB) + nối kỳ Carino', lib: 'lib/brinson-calc.js',
      method: 'Phân bổ ngành, chọn mã, tương tác theo từng kỳ; nối nhiều kỳ bằng hệ số Carino để các hiệu ứng cộng đúng bằng chênh lệch lợi suất tích luỹ.',
      params: 'Chuẩn ngành = trọng số VN-Index theo ICB cấp 2 (22 ngành); ngành Viễn thông không có chỉ số ngành nên bị loại khỏi chuẩn.',
      data: 'Vị thế theo ngày, phân ngành ICB (finance_stock_meta), chỉ số ngành.',
      validation: { tests: ['tests/unit/brinson-calc.test.js', 'tests/unit/sector-map.test.js'], golden: null, note: 'Kiểm tính chất: tổng hiệu ứng = chênh lệch lợi suất; nối Carino cộng đúng.' },
      limits: 'Phụ thuộc phân ngành đúng; mã chưa có ngành xếp vào "Chưa phân ngành" làm hiệu ứng chọn mã phình ra.' },
    { id: 'valuation', area: 'Định giá', name: 'Định giá: CAPM, P/B hợp lý, thu nhập thặng dư, FCFE nhiều giai đoạn', lib: 'lib/valuation-models.js',
      method: 'Chi phí vốn CAPM (rf + beta x ERP), P/B hợp lý = (ROE - g)/(Ke - g), thu nhập thặng dư (Residual Income), FCFE ba kịch bản nhiều giai đoạn, FCFE ngược (thị trường đang định giá tăng trưởng bao nhiêu), nhạy cảm Ke x g, điểm chất lượng, đối chiếu chéo các phương pháp.',
      params: 'ERP mặc định 8% (tham chiếu Damodaran ~8,1%, cần cập nhật tay hằng năm); g dài hạn tối đa 6%; kịch bản Thấp/Cơ sở/Cao.',
      data: 'Chỉ số VNDirect (finance_stock_ratios), báo cáo quý (stock-financials), lãi phi rủi ro.',
      validation: { tests: ['tests/unit/valuation-models.test.js', 'tests/unit/valuation-advanced.test.js'], golden: 'tests/fixtures/valuation-golden.json', note: 'Đối chiếu Python; thử nghiệm nhạy cảm và biên (Ke <= g trả null).' },
      limits: 'Kết quả rất nhạy với Ke và g; ngân hàng/bảo hiểm dùng P/B và thu nhập thặng dư, không dùng FCFE; ERP là giả định, không phải dữ liệu thị trường.' },
    { id: 'quant', area: 'Định lượng', name: 'Bảng định lượng: vòng quay JdK, biên 52 tuần, thanh khoản, khối ngoại', lib: 'lib/quant-calc.js',
      method: 'RS-Ratio/RS-Momentum (JdK) chia bốn góc phần tư; vị trí trong biên 52 tuần; P/E so với trung bình 1/3/5 năm và P/E điều hoà danh mục; số phiên thoát vị thế ở 20% thanh khoản ngày; áp lực khối ngoại 5 phiên.',
      params: 'Tỷ lệ tham gia 20% thanh khoản; ngưỡng cờ: thoát > 5 phiên, tụt hậu và >= 10% danh mục, khối ngoại bán ròng >= 10% thanh khoản.',
      data: 'VNDirect ratios và foreigns (cập nhật mỗi ngày làm việc).',
      validation: { tests: ['tests/unit/quant-calc.test.js'], golden: null, note: 'Số thật FPT/VCB ngày 02/10/2026 trong kiểm thử; JdK do VNDirect tính sẵn, không tự tính lại.' },
      limits: 'Chỉ báo để soát và đặt câu hỏi, không phải tín hiệu mua/bán; P/E trung bình lịch sử chưa điều chỉnh thay đổi tăng trưởng.' },
    { id: 'execution', area: 'Vận hành', name: 'Chất lượng khớp lệnh (TCA)', lib: 'lib/execution-quality.js',
      method: 'So giá khớp với giá đóng cửa, giá trung bình ngày (VWAP), giá đề xuất khi duyệt; chi phí phí+thuế; diễn biến 5 phiên sau lệnh. Chỉ nhận xét khi đủ mẫu (>= 5 lệnh cùng phía).',
      params: 'Dấu quy ước: dương = bất lợi cho người giao dịch (mua cao / bán thấp).',
      data: 'Giao dịch, giá đóng cửa, VWAP ngày từ VNDirect (stock-history averages).',
      validation: { tests: ['tests/unit/execution-quality.test.js'], golden: null, note: 'Kiểm số học và dấu quy ước cho mua/bán.' },
      limits: 'VWAP ngày, không phải VWAP trong phiên theo thời điểm đặt lệnh; thiếu VWAP thì chỉ số đó để trống.' },
    { id: 'vn-rules', area: 'Quy tắc thị trường', name: 'Quy tắc giao dịch Việt Nam', lib: 'lib/vn-market.js',
      method: 'Biên độ giá theo sàn (HOSE 7%, HNX 10%, UPCoM 15%), bước giá và lô theo sàn, giá trần/sàn/tham chiếu, thanh toán T+2 và giờ chốt, kiểm tra lệnh trước khi nhập.',
      params: 'Biên độ và bước giá theo quy định hiện hành tại thời điểm viết (10/2026).',
      data: 'Bảng quy tắc nội bộ; sàn và ngày niêm yết từ finance_stock_meta.',
      validation: { tests: ['tests/unit/vn-market.test.js'], golden: null, note: 'Kiểm giá trần/sàn làm tròn theo bước giá từng sàn.' },
      limits: 'Quy định có thể đổi (ví dụ T+1, biên độ): phải cập nhật tay khi cơ quan quản lý thay đổi; không tính ngày nghỉ lễ riêng.' },
    { id: 'limits', area: 'Tuân thủ', name: 'Giới hạn đầu tư và mã bị hạn chế', lib: 'lib/limits-calc.js',
      method: 'Kiểm giới hạn tỷ trọng mã/ngành/tiền mặt, danh sách mã hạn chế (chặn mua và bán), tính khối lượng trước lệnh; duyệt lệnh lớn có thể bắt buộc ở máy chủ.',
      params: 'Do quản lý đặt theo nhóm; chính sách duyệt mặc định TẮT.',
      data: 'finance_limits, finance_restricted_symbols, vị thế.',
      validation: { tests: ['tests/unit/approval-enforce-sql.test.js', 'tests/unit/api-restricted.test.js'], golden: null, note: 'Máy chủ: trigger kiểm bằng giao dịch DB thật rồi huỷ (18 + 15 ca).' },
      limits: 'Giới hạn phụ thuộc vị thế (tỷ trọng, ngành) chỉ kiểm ở phía ứng dụng và quét hằng ngày, chưa bắt buộc ở máy chủ.' },
    { id: 'data-quality', area: 'Dữ liệu', name: 'Kiểm chất lượng dữ liệu giá hằng ngày', lib: 'supabase/functions/market-data-sync/logic.ts',
      method: 'So giá hai nguồn độc lập (VNDirect và VCI), phát hiện nhảy giá vượt biên độ sàn, thiếu phiên so với VN-Index, giá cũ, nguồn lỗi; email cảnh báo quản lý cho cảnh báo MỚI mức lỗi/cảnh báo.',
      params: 'Ngưỡng lệch 0,5% (cảnh báo) / 2% (lỗi); nhảy giá > biên độ + 0,5 điểm.',
      data: 'VNDirect dchart, VCI gap-chart, TradingView scanner (lợi suất), VNDirect finfo.',
      validation: { tests: ['tests/unit/market-data-sync.test.js'], golden: null, note: 'Chạy thật trên Edge Function; chưa có SLA từ nguồn.' },
      limits: 'Tất cả nguồn là điểm cuối công khai không cam kết dịch vụ; hai nguồn có thể cùng sai khi doanh nghiệp có sự kiện chưa điều chỉnh.' },
  ];

  // Mô hình thiếu tệp kiểm thử hoặc ghi chú giới hạn thì coi là chưa đạt chuẩn đăng ký
  function validate(models, fileExists) {
    const problems = [];
    (models || MODELS).forEach((m) => {
      ['id', 'area', 'name', 'lib', 'method', 'params', 'data', 'limits'].forEach((k) => { if (!m[k]) problems.push(m.id + ': thiếu ' + k); });
      if (!m.validation || !Array.isArray(m.validation.tests) || !m.validation.tests.length) problems.push(m.id + ': chưa có kiểm thử');
      else if (fileExists) {
        m.validation.tests.forEach((t) => { if (!fileExists(t)) problems.push(m.id + ': không thấy tệp kiểm thử ' + t); });
        if (m.validation.golden && !fileExists(m.validation.golden)) problems.push(m.id + ': không thấy tệp số chuẩn ' + m.validation.golden);
      }
    });
    const ids = (models || MODELS).map((m) => m.id);
    if (new Set(ids).size !== ids.length) problems.push('id bị trùng');
    return problems;
  }

  function byArea() {
    const out = {};
    MODELS.forEach((m) => { (out[m.area] = out[m.area] || []).push(m); });
    return out;
  }

  return { VERSION, MODELS, validate, byArea };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ModelRegistry;
