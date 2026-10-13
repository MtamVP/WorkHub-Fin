// BẢN ĐỒ TÍNH NĂNG của WorkHub Fin cho Quản gia: mỗi mục là một việc người dùng muốn làm, kèm từ khoá (viết có dấu hay không đều được: lõi tự bỏ dấu), vài bước chỉ dẫn và đường dẫn.
// Đường dẫn LUÔN do lib/links.js dựng (to(L, sym) nhận global Links) hoặc là đường dẫn mục của trang chính ('/#section=KHOÁ', '/#do=HÀNH_ĐỘNG') nên không thể lệch với các trang đích;
// tests/unit/butler-map.test.js kiểm: id không trùng, mọi đường dẫn trỏ tới trang có thật, hash được trang đích khai báo, mục cần mã có `sym: true`, mỗi từ khoá khớp đúng mục của nó.
// Giữ bản đồ NGẮN và CHÍNH XÁC: chỉ ghi bước thao tác khi chắc chắn có nút / tab đó trong giao diện (nhãn lấy từ chính HTML). Sửa giao diện thì sửa ở đây (test bắt các đường dẫn hỏng).
// data: tên công cụ DỮ LIỆU của Quản gia (butler-data) trả lời được câu hỏi về mục này (danh mục, nhóm, giới hạn, lệnh chờ duyệt). need: null (ai cũng thấy) | { admin: true } | { minRole: 'editor' }. Nạp bằng thẻ <script> thường (global ButlerMapFin) và module.exports cho Vitest; bản sao chạy ở Edge Function butler.
const ButlerMapFin = (function () {
  const sec = (key) => () => '/#section=' + key;
  const act = (key) => () => '/#do=' + key;
  const FEATURES = [
    // ===== Công việc, lịch, cá nhân (trang chính) =====
    { id: 'tasks-mine', area: 'Việc của tôi', label: 'Xem các việc được giao cho tôi', icon: 'fa-list-check', section: 'mytasks', to: sec('mytasks'),
      keys: ['việc của tôi', 'công việc của tôi', 'nhiệm vụ của tôi', 'việc được giao', 'công việc được giao', 'task của tôi', 'tôi được giao gì'], steps: ['Mở "Việc của tôi" ở thanh bên trái.'] },
    { id: 'tasks-manage', area: 'Nhiệm Vụ', label: 'Tạo và quản lý nhiệm vụ, dự án', icon: 'fa-diagram-project', section: 'task', to: sec('task'),
      keys: ['tạo nhiệm vụ', 'thêm công việc', 'tạo task', 'thêm task', 'tạo dự án', 'quản lý dự án', 'kanban', 'bảng công việc', 'giao việc', 'giao nhiệm vụ'], steps: ['Mở "Nhiệm Vụ" ở thanh bên trái.', 'Chọn dự án rồi thêm nhiệm vụ; đổi giữa dạng bảng, thẻ và Kanban ở góc trên bên phải.'] },
    { id: 'progress', area: 'Tiến Độ', label: 'Xem tiến độ dự án', icon: 'fa-chart-line', section: 'progress', to: sec('progress'),
      keys: ['tiến độ', 'tiến độ dự án', 'phần trăm hoàn thành', 'burndown', 'mốc dự án'], steps: ['Mở "Tiến Độ" ở thanh bên trái.'] },
    { id: 'calendar', area: 'Lịch', label: 'Xem và thêm sự kiện trên lịch', icon: 'fa-calendar-days', section: 'calendar', to: sec('calendar'),
      keys: ['lịch', 'thêm sự kiện', 'tạo sự kiện', 'lịch họp', 'đặt lịch', 'google calendar', 'đồng bộ lịch', 'lịch làm việc'], steps: ['Mở "Lịch" ở thanh bên trái.', 'Bấm vào một ngày để thêm sự kiện; kết nối Google Calendar ở mục Tích hợp nếu muốn đồng bộ hai chiều.'] },
    { id: 'personal', area: 'Không gian cá nhân', label: 'Ghi chú, lối tắt và thư mục đồng bộ cá nhân', icon: 'fa-user-astronaut', section: 'personal', to: sec('personal'),
      keys: ['không gian cá nhân', 'ghi chú', 'ghi nhớ', 'lối tắt', 'thư mục đồng bộ', 'ghi nhanh', 'quick capture'], steps: ['Mở "Không gian cá nhân" ở thanh bên trái.'] },
    { id: 'chat', area: 'Trò Chuyện', label: 'Trò chuyện với nhóm', icon: 'fa-comments', section: 'chat', to: sec('chat'),
      keys: ['trò chuyện', 'chat', 'nhắn tin', 'tin nhắn nhóm'], steps: ['Mở "Trò Chuyện" ở thanh bên trái.'] },
    { id: 'files', area: 'UploadFile', label: 'Tải lên và quản lý tệp', icon: 'fa-folder-open', section: 'drive', to: sec('drive'),
      keys: ['tải tệp', 'tải lên', 'upload', 'tệp đính kèm', 'quản lý tệp', 'kho tệp', 'file'], steps: ['Mở "UploadFile" ở thanh bên trái.'] },
    { id: 'bi-report', area: 'Báo Cáo BI', label: 'Báo cáo BI về công việc và nhóm', icon: 'fa-chart-pie', section: 'team-status', to: sec('team-status'),
      keys: ['báo cáo bi', 'báo cáo công việc', 'trạng thái nhóm', 'khối lượng công việc', 'ai đang làm gì'], steps: ['Mở "Báo Cáo BI" ở thanh bên trái.'] },
    { id: 'fin-roles', area: 'Phân Quyền', label: 'Cấp hoặc thu hồi vai trò Finance cho thành viên', icon: 'fa-user-shield', section: 'fin-roles', to: sec('fin-roles'), need: { admin: true },
      keys: ['phân quyền', 'cấp quyền', 'cấp vai trò', 'thu hồi quyền', 'vai trò finance', 'fin role', 'quản lý quyền'], steps: ['Mở "Phân Quyền" ở thanh bên trái (chỉ quản trị viên thấy).'] },
    { id: 'audit-log', area: 'Nhật Ký Kiểm Toán', label: 'Xem ai đã sửa, xoá, tạo gì và lúc nào', icon: 'fa-clipboard-list', section: 'audit-log', to: sec('audit-log'), need: { admin: true },
      keys: ['nhật ký kiểm toán', 'audit', 'ai đã sửa', 'ai đã xoá', 'lịch sử thay đổi', 'nhật ký hệ thống', 'ai đã thêm'], steps: ['Mở "Nhật Ký Kiểm Toán" ở thanh bên trái (chỉ quản trị viên thấy).', 'Lọc theo bảng, người thực hiện hoặc thời gian.'] },
    { id: 'self-check', area: 'Menu tài khoản', label: 'Kiểm tra hệ thống: giá trực tiếp, ghi tệp, thông báo, dữ liệu', icon: 'fa-stethoscope', to: act('selfcheck'),
      keys: ['kiểm tra hệ thống', 'chẩn đoán', 'app không chạy', 'không có giá', 'lỗi kết nối', 'self check', 'kiểm tra kết nối', 'sao lại không có dữ liệu'], steps: ['Mở menu tài khoản ở góc trên bên phải.', 'Chọn "Kiểm tra hệ thống" rồi bấm chạy kiểm tra.'] },
    { id: 'backup', area: 'Sao lưu', label: 'Sao lưu và phục hồi dữ liệu', icon: 'fa-database', to: act('backup'),
      keys: ['sao lưu', 'phục hồi', 'backup', 'restore', 'xuất toàn bộ dữ liệu', 'lưu dữ liệu ra máy'], steps: ['Bấm biểu tượng "Sao lưu & Phục hồi" ở thanh trên cùng.', 'Chọn "Sao lưu ngay"; muốn khôi phục thì chọn tệp sao lưu.'] },
    { id: 'update-check', area: 'Menu tài khoản', label: 'Kiểm tra bản cập nhật ứng dụng', icon: 'fa-cloud-arrow-down', to: act('update'),
      keys: ['cập nhật ứng dụng', 'kiểm tra cập nhật', 'phiên bản mới', 'bản mới', 'update', 'nâng cấp ứng dụng'], steps: ['Mở menu tài khoản ở góc trên bên phải.', 'Chọn "Kiểm tra cập nhật".'] },

    // ===== Investment Workbench: Toàn Nhóm =====
    { id: 'group-portfolio', data: 'group', area: 'Toàn Nhóm', label: 'Xem danh mục chung của cả nhóm', icon: 'fa-layer-group', to: (L) => L.group('portfolio'),
      keys: ['danh mục chung', 'danh mục nhóm', 'danh mục của nhóm', 'danh mục của cả nhóm', 'toàn nhóm', 'cả nhóm đang nắm', 'tổng danh mục'], steps: ['Vào Investment Workbench › Toàn Nhóm › "Danh Mục Chung".'] },
    { id: 'group-members', area: 'Toàn Nhóm', label: 'Xem thành viên và vai trò trong nhóm', icon: 'fa-user-group', to: (L) => L.group('members'),
      keys: ['thành viên nhóm', 'danh sách thành viên', 'ai trong nhóm', 'thành viên'], steps: ['Vào Toàn Nhóm › "Thành Viên".'] },
    { id: 'group-limits', data: 'limits', area: 'Toàn Nhóm', label: 'Xem và đặt giới hạn đầu tư, mã hạn chế', icon: 'fa-gauge-high', to: (L) => L.group('limits'),
      keys: ['giới hạn', 'hạn mức', 'giới hạn đầu tư', 'vượt giới hạn', 'mã hạn chế', 'mã cấm', 'tỷ trọng tối đa', 'limit', 'ngoại lệ giới hạn'], steps: ['Vào Toàn Nhóm › "Giới Hạn".', 'Quản lý tài sản đặt hoặc sửa giới hạn; thành viên xem mức đang dùng và xin ngoại lệ.'] },
    { id: 'group-quant', area: 'Toàn Nhóm', label: 'Phân tích định lượng của cả nhóm', icon: 'fa-chart-simple', to: (L) => L.group('quant'),
      keys: ['định lượng', 'phân tích định lượng', 'quant', 'mô hình rủi ro nhóm', 'sổ đăng ký mô hình'], steps: ['Vào Toàn Nhóm › "Định Lượng".'] },
    { id: 'group-data', area: 'Toàn Nhóm', label: 'Kiểm tra chất lượng dữ liệu và hàm chạy nền', icon: 'fa-database', to: (L) => L.group('data'),
      keys: ['chất lượng dữ liệu', 'dữ liệu lỗi', 'dữ liệu cũ', 'hàm chạy nền', 'cron', 'độ tươi dữ liệu', 'dữ liệu thiếu'], steps: ['Vào Toàn Nhóm › "Dữ Liệu".'] },
    { id: 'group-execution', area: 'Toàn Nhóm', label: 'Chất lượng khớp lệnh (trượt giá, VWAP)', icon: 'fa-bullseye', to: (L) => L.group('execution'),
      keys: ['khớp lệnh', 'chất lượng khớp', 'trượt giá', 'vwap', 'tca', 'chi phí giao dịch'], steps: ['Vào Toàn Nhóm › "Khớp Lệnh".'] },
    { id: 'group-journey', area: 'Toàn Nhóm', label: 'Theo dõi hành trình từ ý tưởng đến lệnh', icon: 'fa-route', to: (L) => L.group('journey'),
      keys: ['hành trình', 'ý tưởng đầu tư', 'ý tưởng', 'đề xuất đầu tư', 'idea', 'ý tưởng nào được duyệt'], steps: ['Vào Toàn Nhóm › "Hành Trình".'] },
    { id: 'group-approvals', data: 'approvals', area: 'Toàn Nhóm', label: 'Xem và duyệt các lệnh lớn đang chờ', icon: 'fa-stamp', to: (L) => L.group('approvals'),
      keys: ['duyệt lệnh', 'phê duyệt', 'chờ duyệt', 'lệnh chờ duyệt', 'lệnh lớn', 'approval', 'xin duyệt lệnh'], steps: ['Vào Toàn Nhóm › "Duyệt Lệnh".', 'Người có quyền duyệt xem chi tiết rồi duyệt hoặc bác.'] },
    { id: 'group-strategy', area: 'Toàn Nhóm', label: 'Chiến lược và cân bằng danh mục về chuẩn của nhóm', icon: 'fa-bullseye', to: (L) => L.group('strategy'),
      keys: ['chiến lược nhóm', 'cân bằng về chuẩn', 'danh mục chuẩn', 'tỷ trọng mục tiêu nhóm', 'cân bằng nhóm'], steps: ['Vào Toàn Nhóm › "Chiến Lược".'] },
    { id: 'group-activity', area: 'Toàn Nhóm', label: 'Xem hoạt động gần đây của cả nhóm', icon: 'fa-receipt', to: (L) => L.group('activity'),
      keys: ['hoạt động nhóm', 'hoạt động gần đây', 'ai vừa thêm lệnh', 'lệnh của nhóm', 'giao dịch của nhóm'], steps: ['Vào Toàn Nhóm › "Hoạt Động".'] },
    { id: 'group-report', area: 'Toàn Nhóm', label: 'Báo cáo của cả nhóm', icon: 'fa-file-lines', to: (L) => L.group('report'),
      keys: ['báo cáo nhóm', 'báo cáo toàn nhóm', 'báo cáo cho hội đồng', 'hồ sơ họp đầu tư'], steps: ['Vào Toàn Nhóm › "Báo Cáo".'] },

    // ===== Investment Workbench: Danh Mục cá nhân =====
    { id: 'assets-holdings', data: 'portfolio', area: 'Danh Mục', label: 'Xem danh mục tôi đang nắm giữ, NAV và lãi lỗ', icon: 'fa-sack-dollar', to: (L) => L.assets('holdings'),
      keys: ['danh mục', 'danh mục của tôi', 'danh mục cá nhân', 'đang nắm giữ', 'cổ phiếu của tôi', 'vị thế', 'nav', 'lãi lỗ', 'tôi đang giữ gì', 'tài sản của tôi'], steps: ['Vào Investment Workbench › Danh Mục › "Danh Mục".'] },
    { id: 'price-alerts', area: 'Danh Mục', label: 'Đặt giá mục tiêu và ngưỡng cắt lỗ, nhận cảnh báo giá', icon: 'fa-bell', to: (L) => L.assets('holdings'),
      keys: ['giá mục tiêu', 'cắt lỗ', 'ngưỡng cắt lỗ', 'cảnh báo giá', 'email cảnh báo', 'báo khi giá chạm', 'chốt lời'], steps: ['Vào Danh Mục › "Danh Mục".', 'Đặt giá mục tiêu và ngưỡng cắt lỗ cho từng mã; bật email cảnh báo nếu muốn nhận khi app đã tắt.'] },
    { id: 'watchlist', area: 'Danh Mục', label: 'Theo dõi mã quan tâm và giá muốn mua', icon: 'fa-eye', to: (L) => L.assets('watchlist'),
      keys: ['theo dõi', 'watchlist', 'mã quan tâm', 'giá muốn mua', 'danh sách theo dõi', 'thêm mã theo dõi'], steps: ['Vào Danh Mục › "Theo Dõi".'] },
    { id: 'ledger', area: 'Danh Mục', label: 'Ghi lệnh mua bán, nạp rút tiền, cổ tức', icon: 'fa-receipt', to: (L) => L.assets('ledger'),
      keys: ['ghi lệnh', 'thêm lệnh', 'sổ lệnh', 'mua cổ phiếu', 'bán cổ phiếu', 'nạp tiền', 'rút tiền', 'cổ tức', 'ghi giao dịch', 'nhập lệnh'], steps: ['Vào Danh Mục › "Sổ Lệnh".', 'Thêm lệnh mua / bán, hoặc ghi nạp / rút tiền và cổ tức; lãi lỗ chốt tính theo FIFO.'] },
    { id: 'ledger-import', area: 'Danh Mục', label: 'Nhập hàng loạt từ sao kê của công ty chứng khoán', icon: 'fa-file-import', to: (L) => L.assets('ledger'),
      keys: ['nhập sao kê', 'import sao kê', 'tải sao kê', 'sao kê công ty chứng khoán', 'nhập từ excel', 'nhập từ csv', 'nhập hàng loạt'], steps: ['Vào Danh Mục › "Sổ Lệnh".', 'Bấm nút nhập hàng loạt từ file sao kê (Excel hoặc CSV), kiểm bản xem trước rồi xác nhận.'] },
    { id: 'reconcile', area: 'Danh Mục', label: 'Đối soát sổ lệnh với sao kê số dư và sao kê lệnh', icon: 'fa-scale-unbalanced', to: (L) => L.assets('ledger'),
      keys: ['đối soát', 'đối chiếu sao kê', 'lệch số dư', 'sổ lệnh lệch', 'kiểm tra lệch', 'reconcile'], steps: ['Vào Danh Mục › "Sổ Lệnh".', 'Bấm nút đối soát với sao kê để tìm chênh lệch.'] },
    { id: 'pretrade', area: 'Danh Mục', label: 'Kiểm tra trước lệnh và tính khối lượng theo rủi ro', icon: 'fa-scale-balanced', to: (L) => L.assets('ledger'),
      keys: ['kiểm tra trước lệnh', 'tính khối lượng', 'nên mua bao nhiêu', 'mua bao nhiêu cổ phiếu', 'khối lượng theo rủi ro', 'pre trade', 'trước khi đặt lệnh', 'sizing'], steps: ['Vào Danh Mục › "Sổ Lệnh".', 'Mở mục "Kiểm tra trước lệnh & tính khối lượng theo rủi ro" trước khi ghi lệnh.'] },
    { id: 'journal', area: 'Danh Mục', label: 'Ghi nhật ký quyết định (lý do mua bán, mức tự tin)', icon: 'fa-book-open', to: (L) => L.journal(),
      keys: ['nhật ký quyết định', 'ghi quyết định', 'lý do mua', 'lý do bán', 'nhật ký đầu tư', 'decision journal', 'nhật ký', 'ra quyết định', 'ghi lại vì sao', 'lý do quyết định', 'ghi lại quyết định'], steps: ['Vào Danh Mục › "Nhật Ký".', 'Ghi lý do và mức tự tin; sau này tab "Gương" đo quyết định của bạn đúng đến đâu.'] },
    { id: 'performance', area: 'Danh Mục', label: 'Xem hiệu suất đầu tư so với VN-Index', icon: 'fa-chart-area', to: (L) => L.assets('performance'),
      keys: ['hiệu suất', 'hiệu quả đầu tư', 'lợi nhuận', 'twr', 'xirr', 'sharpe', 'so với vn index', 'benchmark', 'alpha', 'đường vốn'], steps: ['Vào Danh Mục › "Hiệu Suất".'] },
    { id: 'mirror', area: 'Danh Mục', label: 'Soi cách tôi ra quyết định (thiên kiến, độ hiệu chỉnh)', icon: 'fa-user-check', to: (L) => L.assets('mirror'),
      keys: ['gương', 'gương quyết định', 'thiên kiến', 'bán lời quá sớm', 'giữ lỗ quá lâu', 'tôi quyết định có tốt không', 'mirror'], steps: ['Vào Danh Mục › "Gương".'] },
    { id: 'risk', area: 'Danh Mục', label: 'Rủi ro danh mục: VaR, kiểm thử căng thẳng, tối ưu tỷ trọng', icon: 'fa-shield-halved', to: (L) => L.assets('risk'),
      keys: ['rủi ro', 'var', 'kiểm thử căng thẳng', 'stress test', 'tối ưu tỷ trọng', 'tối ưu hoá', 'tập trung ngành', 'thanh khoản bán', 'cân bằng rủi ro', 'drawdown'], steps: ['Vào Danh Mục › "Rủi Ro".', 'Thẻ "Tối ưu hoá tỷ trọng" cho gợi ý khối lượng mua / bán theo lô 100.'] },
    { id: 'assets-calendar', area: 'Danh Mục', label: 'Lịch cổ tức và sự kiện doanh nghiệp của danh mục', icon: 'fa-calendar-days', to: (L) => L.assets('calendar'),
      keys: ['lịch cổ tức', 'sự kiện doanh nghiệp', 'chia cổ tức', 'quyền mua', 'ngày giao dịch không hưởng quyền', 'lịch quyền', 'chia tách'], steps: ['Vào Danh Mục › "Lịch".'] },
    { id: 'reports-monthly', area: 'Danh Mục', label: 'Báo cáo tháng và xuất dữ liệu báo cáo', icon: 'fa-file-powerpoint', to: (L) => L.assets('reports'),
      keys: ['báo cáo tháng', 'báo cáo cuối tháng', 'xuất báo cáo', 'xuất dữ liệu', 'pptx', 'báo cáo danh mục'], steps: ['Vào Danh Mục › "Báo Cáo".', 'Dùng "Dữ Liệu Báo Cáo Cuối Tháng" để xuất số liệu cho mẫu báo cáo.'] },
    { id: 'accounting-link', area: 'Danh Mục', label: 'Gửi sổ lệnh sang web kế toán (bút toán TT200)', icon: 'fa-calculator', to: (L) => L.assets('reports'),
      keys: ['kế toán', 'web kế toán', 'bút toán', 'hạch toán', 'tt200', 'onyxline', 'đẩy sang kế toán', 'liên kết kế toán', 'đối soát kế toán', 'dự phòng giảm giá'], steps: ['Vào Danh Mục › "Báo Cáo" › thẻ "Liên Kết Kế Toán".', 'Xem bút toán đề xuất; bấm mở web kế toán để gửi chứng từ nháp chờ duyệt.'] },

    // ===== Thị trường, nghiên cứu, định giá =====
    { id: 'market-overview', area: 'Tổng Quan TT', label: 'Xem tổng quan thị trường: chỉ số, độ rộng, khối ngoại, tin', icon: 'fa-earth-asia', to: (L) => L.market(),
      keys: ['tổng quan thị trường', 'thị trường hôm nay', 'vn index', 'vnindex', 'độ rộng thị trường', 'khối ngoại', 'tin thị trường', 'tóm tắt tin', 'tin tức'], steps: ['Mở "Tổng Quan TT" ở thanh bên trái hoặc thanh điều hướng Investment.'] },
    { id: 'stock-research', sym: true, area: 'Nghiên Cứu', label: 'Nghiên cứu một cổ phiếu: báo cáo tài chính, chỉ số', icon: 'fa-chart-column', to: (L, s) => L.stock(s),
      keys: ['nghiên cứu', 'báo cáo tài chính', 'bctc', 'nghiên cứu mã', 'số liệu tài chính', 'stocksheet', 'chỉ số tài chính', 'roe', 'eps'], steps: ['Mở Investment Workbench › "Nghiên Cứu" và chọn mã.'] },
    { id: 'stock-screener', area: 'Nghiên Cứu', label: 'Lọc cổ phiếu theo tiêu chí (bộ lọc thị trường)', icon: 'fa-filter', to: (L) => L.stock(''),
      keys: ['bộ lọc', 'lọc cổ phiếu', 'screener', 'tìm cổ phiếu', 'tìm mã', 'lọc mã', 'cổ phiếu rẻ', 'điểm sức khoẻ'], steps: ['Mở Investment Workbench › "Nghiên Cứu".', 'Bấm "Bộ lọc", chọn tiêu chí hoặc mẫu lọc có sẵn.'] },
    { id: 'valuation', sym: true, area: 'Valuation Bench', label: 'Định giá cổ phiếu: giá trị hợp lý, biên an toàn', icon: 'fa-scale-balanced', to: (L, s) => L.valuation(s),
      keys: ['định giá', 'giá trị hợp lý', 'biên an toàn', 'dcf', 'đắt hay rẻ', 'cổ phiếu có đắt không', 'valuation', 'fair value', 'hồ sơ cổ phiếu'], steps: ['Mở Valuation Bench › "Hồ sơ cổ phiếu" và chọn mã.', 'Đi qua quy trình 7 bước rồi lưu bản định giá.'] },
    { id: 'valuation-technical', sym: true, area: 'Valuation Bench', label: 'Phân tích kỹ thuật một mã', icon: 'fa-chart-line', to: (L, s) => L.valuation(s, 'technical'),
      keys: ['phân tích kỹ thuật', 'kỹ thuật', 'đường trung bình', 'ma20', 'biểu đồ giá', 'xu hướng giá', 'hỗ trợ kháng cự'], steps: ['Mở hồ sơ mã trong Valuation Bench › tab "Kỹ thuật".'] },
    { id: 'valuation-saved', area: 'Valuation Bench', label: 'Xem các bản định giá đã lưu', icon: 'fa-bookmark', to: (L) => L.valuation('', 'saved'),
      keys: ['định giá đã lưu', 'bản định giá đã lưu', 'định giá cũ', 'định giá quá hạn'], steps: ['Mở Valuation Bench rồi vào tab "Đã lưu".'] },

    // ===== Insight =====
    { id: 'insight-inbox', area: 'Insight', label: 'Xem Việc cần làm: mọi tín hiệu hôm nay xếp theo mức khẩn', icon: 'fa-inbox', to: (L) => L.insight('inbox'),
      keys: ['việc cần làm của insight', 'tín hiệu hôm nay', 'cảnh báo hôm nay', 'hộp việc cần làm', 'cần chú ý gì', 'có gì cần xử lý', 'inbox'], steps: ['Mở Insight › "Việc cần làm".'] },
    { id: 'insight-thesis', sym: true, area: 'Insight', label: 'Luận điểm đầu tư: điều kiện nào còn nguyên hay đã bị phá vỡ', icon: 'fa-list-check', to: (L, s) => L.insight('thesis', s),
      keys: ['luận điểm', 'điều kiện đầu tư', 'thesis', 'luận điểm bị phá vỡ', 'tại sao tôi mua'], steps: ['Mở Insight › "Luận điểm".'] },
    { id: 'insight-liquidity', sym: true, area: 'Insight', label: 'Thanh khoản: thoát vị thế mất bao lâu, chi phí tác động giá', icon: 'fa-droplet', to: (L, s) => L.insight('liquidity', s),
      keys: ['thanh khoản', 'bán hết mất bao lâu', 'thoát vị thế', 'sức chứa', 'tác động giá', 'khối lượng trung bình', 'adv'], steps: ['Mở Insight › "Thanh khoản".'] },
    { id: 'insight-cash', area: 'Insight', label: 'Dự báo dòng tiền vài tuần tới (cổ tức, tiền bán về T+2)', icon: 'fa-wallet', to: (L) => L.insight('cash'),
      keys: ['dòng tiền', 'dự báo tiền mặt', 'tiền về', 't+2', 'tiền mặt còn lại', 'còn bao nhiêu tiền'], steps: ['Mở Insight › "Dòng tiền".'] },
    { id: 'insight-ownership', sym: true, area: 'Insight', label: 'Sở hữu: cổ đông lớn, giao dịch nội bộ, khối ngoại', icon: 'fa-user-tie', to: (L, s) => L.insight('ownership', s),
      keys: ['sở hữu', 'cổ đông lớn', 'giao dịch nội bộ', 'nội bộ mua bán', 'insider', 'room ngoại', 'khối ngoại sở hữu'], steps: ['Mở Insight › "Sở hữu".'] },
    { id: 'insight-events', sym: true, area: 'Insight', label: 'Sự kiện theo mã: lợi nhuận, cổ tức, giải chấp, đình chỉ', icon: 'fa-newspaper', to: (L, s) => L.insight('events', s),
      keys: ['sự kiện theo mã', 'tin theo mã', 'tin về mã', 'giải chấp', 'đình chỉ giao dịch', 'tin xấu', 'công bố lợi nhuận'], steps: ['Mở Insight › "Sự kiện".'] },
    { id: 'insight-rotation', area: 'Insight', label: 'Luân chuyển ngành: sức mạnh tương đối so với VN-Index', icon: 'fa-arrows-spin', to: (L) => L.insight('rotation'),
      keys: ['luân chuyển ngành', 'sức mạnh tương đối', 'dòng tiền ngành', 'ngành nào mạnh', 'ngành nào yếu', 'sector rotation', 'bản đồ nhiệt ngành'], steps: ['Mở Insight › "Luân chuyển ngành".'] },
    { id: 'insight-accuracy', area: 'Insight', label: 'Độ chính xác dự phóng của chính tôi', icon: 'fa-bullseye', to: (L) => L.insight('accuracy'),
      keys: ['độ chính xác', 'dự phóng của tôi', 'tôi dự đoán đúng không', 'forecast', 'chấm điểm dự báo'], steps: ['Mở Insight › "Độ chính xác".'] },
    { id: 'insight-archive', area: 'Insight', label: 'Kho dữ liệu theo thời điểm (nền cho kiểm thử không nhìn trước tương lai)', icon: 'fa-box-archive', to: (L) => L.insight('archive'),
      keys: ['kho dữ liệu', 'dữ liệu theo thời điểm', 'point in time', 'không nhìn trước tương lai', 'kho pit'], steps: ['Mở Insight › "Kho dữ liệu".'] },

    // ===== Phòng kiểm thử, Mô phỏng =====
    { id: 'lab-backtest', area: 'Kiểm thử', label: 'Kiểm thử chiến lược trên lịch sử giá', icon: 'fa-flask-vial', to: (L) => L.lab('backtest'),
      keys: ['kiểm thử chiến lược', 'backtest', 'thử chiến lược', 'chạy lại lịch sử', 'chiến lược có lãi không', 'kiểm thử lịch sử'], steps: ['Mở Kiểm thử › "Kiểm thử chiến lược".', 'Dựng bộ lọc, xếp hạng, cân bằng và chi phí rồi chạy; lần chạy được lưu để mở lại.'] },
    { id: 'lab-factors', area: 'Kiểm thử', label: 'Danh mục lãi hay lỗ vì yếu tố nào (thị trường, quy mô, giá trị, động lượng)', icon: 'fa-layer-group', to: (L) => L.lab('factors'),
      keys: ['yếu tố', 'phong cách đầu tư', 'factor', 'lãi vì đâu', 'lỗ vì đâu', 'beta danh mục', 'động lượng', 'quy mô giá trị'], steps: ['Mở Kiểm thử › "Yếu tố và phong cách".'] },
    { id: 'sim-home', area: 'Market Simulation', label: 'Mô phỏng xác suất thị trường và danh mục', icon: 'fa-code-branch', to: (L) => L.simulation('outlook'),
      keys: ['mô phỏng', 'simulation', 'kịch bản thị trường', 'monte carlo', 'xác suất thị trường', 'nếu thị trường giảm', 'cây kịch bản'], steps: ['Mở Market Simulation › "Triển vọng" hoặc "Mô phỏng".'] },
    { id: 'sim-runs', area: 'Market Simulation', label: 'Xem nhật ký các lần mô phỏng đã lưu (của tôi hoặc cả nhóm)', icon: 'fa-clock-rotate-left', to: (L) => L.simulation('runs'),
      keys: ['nhật ký mô phỏng', 'lần chạy mô phỏng', 'kết quả mô phỏng', 'mô phỏng đã lưu', 'ai đã chạy mô phỏng', 'chấm điểm mô phỏng'], steps: ['Mở Market Simulation › "Nhật ký".', 'Chuyển giữa "Của tôi" và "Cả nhóm" để xem ai đã chạy.'] },
    { id: 'sim-symbol', sym: true, area: 'Market Simulation', label: 'Mô phỏng cho một mã trong danh mục', icon: 'fa-bullseye', to: (L, s) => L.simSymbol(s),
      keys: ['mô phỏng mã', 'mô phỏng cho mã', 'kịch bản cho mã', 'mã này nếu thị trường giảm'], steps: ['Mở Market Simulation › "Danh mục" và chọn mã.'] },
  ];

  const EXAMPLES = [
    'Hôm nay có việc gì?',
    'Tôi muốn nhập sao kê',
    'Xem giới hạn đầu tư ở đâu?',
    'Cách ghi nhật ký quyết định',
    'Xem sở hữu của FPT',
    'Kiểm thử chiến lược ở đâu?',
    'Cách xem việc cần làm của Insight',
    'Tôi muốn sao lưu dữ liệu',
    'Biên an toàn là gì?',
    'Cách đọc bảng điểm độ chính xác',
  ];

  const byId = (id) => FEATURES.find((f) => f.id === id) || null;
  // Đường dẫn của một tính năng (L = global Links; sym = mã nếu có). Tính năng cần mã mà chưa có mã thì trả về trang gốc của khu đó.
  function hrefOf(f, L, sym) { try { return String(f.to(L, sym || '')); } catch (e) { return '/'; } }

  return { domain: 'fin', name: 'WorkHub Fin', features: FEATURES, examples: EXAMPLES, byId, hrefOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ButlerMapFin;
globalThis.ButlerMapFin = ButlerMapFin;
