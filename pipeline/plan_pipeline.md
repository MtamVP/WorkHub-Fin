# WorkHub Ecosystem - Kế hoạch triển khai Pipeline (Dài hạn)

Tài liệu này vạch ra kiến trúc triển khai cải tiến cho hệ thống xử lý dữ liệu tài chính (7 giai đoạn).

## Tổng quan Kiến trúc Pipeline
1. **Source Connectors**
2. **Ingest Validation**
3. **BRONZE LAYER**
4. **Source & License Review**
5. **Cleaning + Mapping + Entity Resolution**
6. **SILVER LAYER**
7. **Analysis Run**
8. **Report + Evidence Pack**
9. **Human QA**
10. **GOLD LAYER**
11. **Storage / AI Dataset / Knowledge**

---

## Chi tiết 7 Giai đoạn (E1 - E7)

### E1 - Ingest (Thu thập dữ liệu thô)
**Đầu vào:** Upload (File / Thư mục). Loại bỏ hoàn toàn Website/API.
**Xử lý:** Pre-flight Check (Kiểm tra Edge problems, dung lượng, định dạng) → Chuyển vào Bronze.
**Tiêu chí hoàn thành (Quality Gate):** Định dạng được phép (docx, pdf, txt, csv, tsv, json, xlsx), file không lỗi/rỗng, metadata khai báo đầy đủ.

> **💡 Quy định xử lý tại E1:**
> - **Pre-flight Check chặt chẽ:** Kiểm tra nghiêm ngặt ngay tại trình duyệt. Chỉ cho phép các định dạng: `docx, pdf, txt, csv, tsv, json, xlsx`. Chặn các file rỗng (0KB), file quá dung lượng (Max 50MB) hoặc file lỗi định dạng trước khi đẩy vào Bronze.
> - **Khai báo Metadata:**
>   - **Tên tài liệu:** Nhập tên ngắn gọn cho gói dữ liệu tải lên.
>   - **Phân loại (Category):** Chọn từ danh sách có sẵn (Báo cáo tài chính, Báo cáo thị trường...) hoặc cho phép người dùng tự gõ loại mới nếu không có trong danh sách.

### E2 - Source Validation
**Xử lý:** Đánh giá độ tin cậy (reliability), mức độ cập nhật (freshness), độ phủ (coverage) và bản quyền (license).
**Tiêu chí hoàn thành:** Điểm đánh giá nguồn (Source score) đạt ngưỡng quy định.

### E3 - Standardization
**Xử lý:** Làm sạch (Cleaning), chuẩn hóa (Normalize), ánh xạ (Mapping), và nhận diện thực thể (Entity resolution) → Chuyển vào Silver.
**Tiêu chí hoàn thành:** Vượt qua kiểm tra cấu trúc (Schema pass), tính toàn vẹn (completeness), loại bỏ trùng lặp (dedup) và kiểm tra bất thường (anomaly check).

### E4 - Analysis
**Xử lý:** Áp dụng tập luật (Rule), thống kê, Học máy (ML), RAG và logic chuyên ngành (domain logic).
**Tiêu chí hoàn thành:** Quá trình chạy có thể tái lập (Reproducible run); Dữ liệu đầu vào và đầu ra phải được đánh version rõ ràng.

### E5 - Report Generation
**Xử lý:** Sinh báo cáo định dạng PDF, DOCX, Excel và các định dạng cho máy đọc (machine-readable output).
**Tiêu chí hoàn thành:** Vượt qua kiểm tra Template, trích dẫn (citation) và nguồn gốc (provenance) hiển thị đầy đủ, minh bạch.

### E6 - Human QA
**Xử lý:** Con người kiểm tra lại số liệu, logic, cách diễn giải, định dạng báo cáo và các rủi ro tiềm ẩn.
**Tiêu chí hoàn thành:** Nhận được phê duyệt của người đánh giá (Reviewer approval).

### E7 - Publish
**Xử lý:** Đóng băng phiên bản (Freeze version) → Chuyển vào Gold → Lưu trữ/Repository/Knowledge Base.
**Tiêu chí hoàn thành:** Nhận được phê duyệt của người làm chủ dữ liệu (Owner approval) và có đầy đủ bản ghi kiểm toán (audit record).
