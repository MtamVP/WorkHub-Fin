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
    { id: 'peer-valuation', area: 'Định giá', name: 'Định giá tương đối so với ngành (phân vị ICB)', lib: 'lib/peer-valuation.js, supabase/functions/market-data-sync/peers.ts',
      method: 'Mỗi ngày lấy P/E, P/B, ROE, cổ tức của cả thị trường từ VNDirect (mỗi chỉ số một lần gọi), tính trung vị và 11 điểm phân vị theo ngành ICB cấp 2; một mã được xếp theo phân vị P/E và P/B trong ngành, kèm phân vị ROE để phân biệt "rẻ thật" với "rẻ vì kém".',
      params: 'Ngưỡng rẻ <= phân vị 30, đắt >= 70 (trung bình phân vị P/E và P/B); chỉ tính mã vốn hoá >= 300 tỷ; ngành tối thiểu 5 mã; loại P/E ngoài (0, 100), P/B ngoài (0, 30).',
      data: 'VNDirect finfo /v4/ratios toàn thị trường; ngành ICB từ VCI (finance_stock_meta).',
      validation: { tests: ['tests/unit/peer-valuation.test.js', 'tests/unit/market-peers.test.js'], golden: null, note: 'Logic kiểm trên dữ liệu giả; chạy thử với dữ liệu thật 02/10/2026 (1.523 mã, trung vị P/E toàn thị trường 9,9x).' },
      limits: 'So sánh P/E và P/B trong ngành chưa tính khác biệt tăng trưởng, đòn bẩy, quy mô; ngành ICB cấp 2 khá rộng (ví dụ Dịch vụ tài chính gộp chứng khoán và các dịch vụ khác); P/E của mã có lợi nhuận bất thường bị bóp méo.' },
    { id: 'market-screener', area: 'Định giá', name: 'Sàng lọc toàn thị trường (~1.500 mã)', lib: 'lib/market-screener.js',
      method: 'Lọc ảnh chụp thị trường hằng ngày theo quy mô/thanh khoản, định giá tuyệt đối và tương đối trong ngành (phân vị), chất lượng (ROE, biên), tăng trưởng, cổ tức, nợ/vốn chủ (không áp dụng ngân hàng/bảo hiểm/tài chính); xếp hạng bằng điểm ghép 5 nhóm (30/30/20/10/10) và cảnh báo số liệu "đẹp bất thường".',
      params: 'Mẫu lọc: Rẻ và chất lượng, Cổ tức bền, Tăng trưởng giá hợp lý, Rẻ hơn lịch sử, Giảm sâu nền tảng tốt. Tiêu chí bật mà thiếu số liệu thì mã không đạt (đếm riêng).',
      data: 'finance_market_snapshot, finance_sector_stats (VNDirect ratios cả thị trường, ngành ICB từ VCI).',
      validation: { tests: ['tests/unit/market-screener.test.js'], golden: null, note: 'Kiểm logic lọc/điểm/cảnh báo trên dữ liệu giả; chạy thử trên dữ liệu thật 02/10/2026 (mẫu "Rẻ và chất lượng" ra 15 mã).' },
      limits: 'Chỉ số VNDirect chưa soát với báo cáo tài chính gốc; P/E rất thấp thường do lợi nhuận một lần (đã cảnh báo nhưng không loại); điểm chỉ để xếp hạng, không phải khuyến nghị.' },
    { id: 'valuation-history', area: 'Định giá', name: 'Bản đồ định giá: lịch sử P/E, P/B thị trường và ngành', lib: 'lib/valuation-history.js, supabase/functions/market-data-sync/peers.ts',
      method: 'Mỗi ngày (và bù ngược theo tháng tới 2020) ghi P/E, P/B trung vị và TỔNG HỢP theo vốn hoá (tổng vốn hoá / tổng lợi nhuận hoặc vốn chủ, chỉ mã có lãi, vốn hoá từ 300 tỷ) của thị trường và từng ngành ICB; so mức hiện tại với phân phối của chính nó trong 3-6 năm bằng phân vị (midrank) và z-score; phần bù cổ phiếu = 1/P/E trừ lợi suất TPCP 10 năm.',
      params: 'Cửa sổ 3/5/6 năm; cần tối thiểu 12 điểm tháng để kết luận; nhãn: <=20 rẻ, <=40 hơi rẻ, <60 trung bình, <80 hơi đắt, >=80 đắt.',
      data: 'VNDirect finfo /v4/ratios theo ngày báo cáo (PRICE_TO_EARNINGS, PRICE_TO_BOOK, MARKETCAP); ngành ICB hiện tại từ VCI; lợi suất TPCP từ TradingView.',
      validation: { tests: ['tests/unit/valuation-history.test.js', 'tests/unit/market-peers.test.js'], golden: null, note: 'Logic kiểm bằng dữ liệu giả; chạy thử trên dữ liệu thật 2020-2026 (P/E thị trường tổng hợp 13,7x -> 11,8x; đáy 9,6x năm 2022).' },
      limits: 'Phân ngành quá khứ lấy theo danh sách hiện tại (thiên lệch người sống sót nhẹ); P/E tổng hợp bỏ mã lỗ nên thấp hơn P/E thật của chỉ số; lịch sử lợi suất TPCP chỉ từ 03/10/2026 nên phần bù chưa có chuỗi thời gian; "rẻ so với lịch sử" không có nghĩa sẽ tăng.' },
    { id: 'style-exposure', area: 'Rủi ro', name: 'Hồ sơ phong cách của danh mục', lib: 'lib/style-exposure.js',
      method: 'Sáu nhân tố (giá trị, chất lượng, quy mô, động lượng 12 tháng, ít biến động, cổ tức): phân vị của từng mã trong phân phối cả thị trường (vốn hoá từ 300 tỷ), lấy trung bình có trọng số giá trị vị thế; 50 = trung lập.',
      params: 'Nhân tố chỉ báo khi các vị thế có số liệu chiếm >= 50% giá trị; nghiêng rõ khi phân vị >= 65 hoặc <= 35; tô đỏ khi >= 80 hoặc <= 20.',
      data: 'finance_market_snapshot (mã đang nắm) và thống kê toàn thị trường (finance_sector_stats, phạm vi ALL).',
      validation: { tests: ['tests/unit/style-exposure.test.js'], golden: null, note: 'Kiểm số học trọng số, chiều nhân tố, thiếu dữ liệu; xem thử với 6 mã thật và thống kê thị trường thật.' },
      limits: 'P/E, P/B của ngân hàng được so chung với doanh nghiệp thường nên làm danh mục trông rẻ; phân vị là so với thị trường hiện tại, không phải chuẩn so sánh (benchmark) đã chọn; động lượng chỉ là giá 12 tháng.' },
    { id: 'replacement-ideas', area: 'Định giá', name: 'Gợi ý mã thay thế trong cùng ngành', lib: 'lib/replacement-ideas.js',
      method: 'Với vị thế đang đắt so với ngành (phân vị định giá >= 70) hoặc tụt hậu so với thị trường (RS-Ratio và RS-Momentum đều dưới 100), tìm trong cùng ngành ICB những mã rẻ hơn ít nhất 20 điểm phân vị, ROE không thấp hơn, vốn hoá >= 1.000 tỷ, thanh khoản >= 5 tỷ/ngày, chưa nắm, không bị hạn chế, nợ/vốn chủ <= 2,5 (trừ tài chính), loại mã có số liệu đẹp bất thường; xếp theo điểm tổng hợp của bộ lọc thị trường.',
      params: 'k = 3 ứng viên mỗi vị thế; ngưỡng đắt 70; chênh lệch tối thiểu 20 điểm phân vị.',
      data: 'finance_market_snapshot, finance_sector_stats, danh sách hạn chế của nhóm.',
      validation: { tests: ['tests/unit/replacement-ideas.test.js'], golden: null, note: 'Kiểm từng bộ lọc loại ứng viên và các trường hợp biên; xem thử trên danh mục 6 mã với dữ liệu thị trường thật (VCB -> CTG, MBB, NAB).' },
      limits: 'Chỉ để nghiên cứu, không phải khuyến nghị đổi mã: chưa tính thuế phí, tác động giá, lãi lỗ vị thế và lý do doanh nghiệp bị chấm đắt/yếu; ngành ICB cấp 2 rộng nên "cùng ngành" chưa chắc cùng mô hình kinh doanh.' },
    { id: 'valuation-alerts', area: 'Định giá', name: 'Cảnh báo định giá thị trường và ngành đang nắm', lib: 'lib/valuation-alerts.js',
      method: 'Từ phân vị P/E, P/B tổng hợp theo vốn hoá trong 5 năm (lib/valuation-history.js): báo thị trường hoặc ngành đang nắm (tỷ trọng từ 10%) ở phân vị từ 80 (đắt) hoặc đến 20 (rẻ); báo khi phân vị dịch chuyển từ 20 điểm trong 3 tháng; báo khi từ 20% danh mục nằm trong ngành đắt hoặc rẻ; báo chênh lệch giữa P/E theo vốn hoá và P/E trung vị (độ rộng); báo khi lợi suất lợi nhuận thấp hơn lãi suất trái phiếu 10 năm (nếu có lãi suất).',
      params: 'Cửa sổ 5 năm; ngưỡng 80/20; tỷ trọng ngành tối thiểu 10%; tập trung 20% danh mục; dịch chuyển 20 điểm trong 91 ngày; cần từ 12 điểm tháng mới kết luận.',
      data: 'finance_valuation_history (market-data-sync, mode snapshot hằng ngày và history bù ngược theo tháng).',
      validation: { tests: ['tests/unit/valuation-alerts.test.js'], golden: null, note: 'Kiểm từng loại cảnh báo trên chuỗi tổng hợp, các trường hợp thiếu dữ liệu và đầu vào sai kiểu; xem thử trên lịch sử thật 2020-2026.' },
      limits: 'Chỉ so với lịch sử của chính nó, không nói gì về lợi nhuận tương lai; P/E tổng hợp bỏ mã lỗ; phân ngành quá khứ theo danh sách hiện tại; chưa có chuỗi lãi suất trái phiếu dài nên cảnh báo phần bù chưa dùng trong app.' },
    { id: 'vb-dcf', area: 'Định giá', name: 'Valuation Bench: DCF FCFF, FCFE, thu nhập thặng dư, Monte Carlo, DCF ngược', lib: 'lib/vb-dcf.js, lib/vb-statements.js, lib/vb-engine.js',
      method: 'FCFF theo WACC (CAPM + Blume), tăng trưởng giảm dần, đường biên lợi nhuận, thuế hội tụ, phần cổ đông thiểu số theo tỷ trọng lợi nhuận, giá trị cuối kỳ Gordon (ràng buộc ROIC) hoặc bội số thoát, giữa kỳ; lưới nhạy cảm WACC x g; Monte Carlo (hạt giống cố định, phân phối tam giác); DCF ngược (chia đôi) tìm tăng trưởng thị trường đang định giá; FCFE, thu nhập thặng dư, P/B hợp lý và DDM cho ngân hàng/bảo hiểm.',
      params: 'ERP, g dài hạn, g năm 1 (trần 20%), thuế hội tụ về 20%, trọng số DDM theo tỷ lệ chi trả tiền mặt; mọi tham số người dùng sửa được và lưu cùng bản định giá.',
      data: 'Báo cáo tài chính VNDirect qua Edge Function vb-data (đã chuẩn hoá dấu và quý đơn lẻ), lãi phi rủi ro, beta.',
      validation: { tests: ['tests/unit/vb-statements.test.js', 'tests/unit/vb-dcf.test.js', 'tests/unit/vb-synthesis-engine.test.js', 'tests/unit/vb-data-parse.test.js'], golden: null, note: 'Kiểm tính chất (nhạy cảm đơn điệu, g >= WACC trả null, DCF ngược khớp lại giá) và chạy trên báo cáo thật của FPT, VCB, SSI, BVH, HPG; chưa có số chuẩn độc lập.' },
      limits: 'Kết quả rất nhạy với WACC, g và biên lợi nhuận; số liệu tự động chưa phân biệt khoản bất thường; ngân hàng thiếu NPL/CAR từ nguồn miễn phí nên chất lượng tài sản chưa vào mô hình.' },
    { id: 'vb-technical', area: 'Định giá', name: 'Valuation Bench: phân tích kỹ thuật và bối cảnh thị trường', lib: 'lib/vb-technical.js, lib/vb-market.js',
      method: 'SMA/EMA, RSI (Wilder), MACD, Stochastic, CCI, Williams %R, ROC, ADX, Bollinger, Keltner, Donchian, OBV, MFI, CMF, A/D, VWAP, Aroon, PSAR, Supertrend, Ichimoku, biến động lịch sử, sụt giảm, pivot, Fibonacci, cụm hỗ trợ/kháng cự, mẫu nến, phân kỳ, sức mạnh tương đối so với VN-Index; điểm xu hướng 40, động lượng 30, dòng tiền 15, vị thế giá 15; điểm bối cảnh thị trường.',
      params: 'Chu kỳ chuẩn của từng chỉ báo (RSI 14, MACD 12/26/9, ...); ngưỡng điểm mô tả trong thư viện phương pháp.',
      data: 'Nến ngày VNDirect (dchart), chỉ số VN-Index, thống kê thị trường.',
      validation: { tests: ['tests/unit/vb-technical.test.js', 'tests/unit/vb-synthesis-engine.test.js'], golden: null, note: 'RSI đối chiếu bảng tham chiếu StockCharts; các chỉ báo khác kiểm tính chất và trường hợp biên (chuỗi phẳng, thiếu dữ liệu).' },
      limits: 'Chỉ báo kỹ thuật mô tả quá khứ, không dự báo; điểm chỉ dùng để xếp bối cảnh thời điểm vào, không thay cho giá trị hợp lý; thanh khoản mã nhỏ làm chỉ báo dòng tiền nhiễu.' },
    { id: 'vb-synthesis', area: 'Định giá', name: 'Valuation Bench: tổng hợp phương pháp, độ tin cậy và vùng giá', lib: 'lib/vb-synthesis.js, lib/vb-multiples.js, lib/vb-asset.js, lib/vb-fundamental.js',
      method: 'Trung vị có trọng số của các phương pháp (dòng tiền, bội số ngành và lịch sử, tài sản, thu nhập), độ tin cậy từ độ phân tán và chất lượng số liệu, điểm tổng hợp 50% giá trị, 30% kỹ thuật, 20% thị trường, ma trận nhận định, vùng tích luỹ/hợp lý/chốt lời/vô hiệu hoá, điều kiện phải đúng từ DCF ngược; chất lượng: Piotroski, Altman, Beneish, Sloan, DuPont, ROIC.',
      params: 'Trọng số mặc định theo loại hình (doanh nghiệp, ngân hàng, chứng khoán, bảo hiểm) và chỉnh được; biên an toàn mặc định 20%; ngưỡng tin cậy 80/55.',
      data: 'Đầu ra của các mô-đun trên và thống kê ngành (finance_sector_stats).',
      validation: { tests: ['tests/unit/vb-synthesis-engine.test.js', 'tests/unit/vb-asset-multiples.test.js', 'tests/unit/vb-fundamental.test.js', 'tests/unit/vb-card.test.js'], golden: null, note: 'Kiểm từng bước tổng hợp, trường hợp thiếu phương pháp và dữ liệu lệch; xem thử toàn bộ trên dữ liệu thật của bốn loại hình doanh nghiệp.' },
      limits: 'Trọng số và ngưỡng là phán đoán, không ước lượng thống kê; nhận định chỉ là công cụ tham khảo, không phải khuyến nghị đầu tư; bội số EV/EBITDA và EV/Sales của ngành chưa có từ nguồn miễn phí.' },
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
