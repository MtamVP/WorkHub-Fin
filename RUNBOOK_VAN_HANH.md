# Sổ tay vận hành – WorkHub Fin (Investment Workbench)

Cập nhật 04/10/2026. Dành cho người trực vận hành (quản trị hệ thống / quản lý danh mục). KHÔNG ghi khoá bí mật vào tệp này (kho mã công khai).

## 1. Bản đồ hệ thống

Dự án Supabase dùng chung: `gqsbsqaxzpzcloaopzvv`. Mọi tác vụ định kỳ chạy bằng pg_cron gọi Edge Function qua pg_net (Bearer = publishable key; hàm giữ `verify_jwt = true`, riêng `storage-proxy` là `false`).

### Tác vụ định kỳ (giờ UTC; Việt Nam = UTC+7)

| Tác vụ (cron) | Lịch | Gọi | Việc |
|---|---|---|---|
| fetch-stock-prices-hourly | `*/5 2-7 * * 1-5` | fetch-stock-prices | giá cổ phiếu trong giờ giao dịch |
| send-price-alerts-hourly | `2-57/5 2-7 * * 1-5` | send-price-alerts | cảnh báo giá |
| daily-finance-nav-snapshot | `50 23 * * *` | SQL | chụp NAV hằng ngày |
| check-limits-daily | `40 8 * * 1-5` | check-limits | kiểm giới hạn đầu tư, ghi nhật ký tuân thủ |
| approval-notify | `*/10 * * * *` | approval-watch | email yêu cầu duyệt lệnh quá hạn / lệnh lách duyệt |
| approval-audit-daily | `0 9 * * 1-5` | approval-watch | quét lệnh tách nhỏ, lệnh chưa duyệt |
| refresh-financials-daily | `15 0,11 * * *` | refresh-financials | báo cáo tài chính, cổ tức |
| market-meta-weekly | `0 20 * * 0` | market-data-sync `meta` | sàn, ICB, VN30 |
| market-rates-daily | `30 10 * * 1-5` | market-data-sync `rates` | lợi suất TPCP |
| market-health-daily | `45 10 * * 1-5` | market-data-sync `health` | kiểm hai nguồn giá + email cảnh báo mới |
| market-ratios-daily | `0 11 * * 1-5` | market-data-sync `ratios` | P/E, P/B, beta, khối ngoại… |
| market-snapshot-daily | `20 11 * * 1-5` | market-data-sync `snapshot` | ảnh chụp cả thị trường + thống kê ngành + ghi tiếp lịch sử định giá |
| valuation-watch-daily | `40 11 * * 1-5` | valuation-watch | email cảnh báo định giá thị trường/ngành đang nắm cho quản lý đã bật nhận |
| cleanup_system_logs | `0 3 1 * *` | SQL | dọn nhật ký hệ thống |

### Edge Function (phiên bản đang chạy tại 04/10/2026)

`fetch-stock-prices` v6 · `send-price-alerts` v6 · `stock-history` v5 · `stock-financials` v1 · `stock-events` v2 · `refresh-financials` v2 · `check-limits` v1 (bản triển khai CŨ hơn kho mã) · `approval-watch` v2 · `market-data-sync` v8 · `storage-proxy` v7 · `valuation-watch` (mới) · `vb-data` (mới; dữ liệu báo cáo tài chính + nến cho Valuation Bench, cần JWT người dùng).

Secrets (đặt trong Supabase → Edge Functions → Secrets, KHÔNG ghi vào kho mã): `RESEND_API_KEY`, `ALERT_FROM_EMAIL`. Chỉ cần cho email cảnh báo.

## 2. Kiểm tra sức khoẻ hằng ngày (2 phút)

1. Mở WorkHub Fin → **Toàn Nhóm → Dữ Liệu**: bốn chỉ số đầu phải là 0 lỗi / 0 trễ / 0 dữ liệu cũ. Bảng "Hàm chạy nền" mỗi dòng phải "Tốt".
2. Hoặc chạy SQL (Supabase → SQL editor):

```sql
-- lần chạy gần nhất của từng chế độ
select mode, ok, run_at, duration_ms from finance_function_runs
where fn = 'market-data-sync' order by run_at desc limit 12;

-- cảnh báo dữ liệu đang mở
select severity, kind, symbol, ref_date, detail from finance_data_health
where resolved is not true order by detected_at desc limit 50;

-- cron có chạy thật không (lỗi gần đây)
select j.jobname, d.status, d.return_message, d.start_time
from cron.job_run_details d join cron.job j using (jobid)
where d.start_time > now() - interval '2 days' and d.status <> 'succeeded'
order by d.start_time desc limit 30;
```

## 3. Khi một nguồn dữ liệu chết ("Nguồn dữ liệu lỗi")

Nguồn đều là điểm cuối công khai, không cam kết dịch vụ.

1. Xác nhận bằng tay: mở URL nguồn trong trình duyệt hoặc `curl` (xem tệp `supabase/functions/market-data-sync/index.ts` để lấy URL).
2. **VNDirect dchart lỗi**: giá và chuỗi lịch sử có thể cũ. Con số NAV/rủi ro/hiệu quả của ngày đó coi là chưa tin cậy cho đến khi nguồn sống lại; ghi chú vào cảnh báo (nút "Đã xử lý").
3. **VCI lỗi**: mất lớp kiểm chéo (cảnh báo mức warn); giá vẫn dùng được nhưng không có đối chiếu.
4. **TradingView (lợi suất) lỗi**: ứng dụng tự dùng lãi phi rủi ro cài tay cho các ngày thiếu.
5. Nếu nguồn đổi định dạng: sửa bộ phân tích tại `logic.ts` (kèm kiểm thử trong `tests/unit/market-data-sync.test.js`), triển khai lại theo mục 4.
6. Bẫy đã gặp: dchart trả **406** nếu gửi header `Accept: application/json` → KHÔNG gửi header đó.

## 4. Triển khai Edge Function

1. Sửa mã trong `supabase/functions/<tên>/`, chạy `npx vitest run` và `node scripts/check-syntax.mjs` cho tới khi xanh.
2. Nếu sửa `lib/finance-calc.js`, `limits-calc.js`… chạy `node scripts/sync-edge-libs.mjs` để cập nhật bản sao nguyên văn dùng trong `check-limits` và `approval-watch`.
3. Triển khai bằng Supabase CLI (`supabase functions deploy <tên>`) hoặc công cụ MCP `deploy_edge_function`. **Phải gửi TẤT CẢ tệp của hàm nguyên văn** (index.ts, logic.ts, các bản sao lib…), không chỉ tệp vừa sửa; giữ `verify_jwt = true`.
4. Kiểm tra ngay: `curl -X POST <url hàm> -H "Authorization: Bearer <publishable key>" -H "apikey: <publishable key>" -H "Content-Type: application/json" -d '{"selftest":true}'` (với `market-data-sync`), rồi chạy một chế độ thật (`{"mode":"health"}`) và đọc `finance_function_runs`.
5. Ghi phiên bản mới vào mục 1 của tệp này.

## 5. Thay đổi cơ sở dữ liệu

- Mọi thay đổi lược đồ qua migration (công cụ `apply_migration`) và lưu bản SQL cùng tên vào gốc kho mã (`finance-*-migration.sql`).
- Trigger bảo vệ (`fn_finance_transactions_enforce`, bảo vệ `public.users`…) là `security definer`; trong đó gọi `current_user_id()` trả null nghĩa là service role → trigger bỏ qua.
- Kiểm tra quyền/RLS: viết khối `DO` dùng `set local role authenticated` + `set_config('request.jwt.claims', …)` và kết thúc bằng `raise exception` để huỷ toàn bộ dữ liệu thử. KHÔNG để dữ liệu thử lại trong CSDL thật.

## 6. Xoay khoá bí mật

- **Resend**: tạo khoá mới trong Resend, cập nhật secret `RESEND_API_KEY` trong Supabase, thu hồi khoá cũ, rồi gọi thử `approval-watch` hoặc đợi cảnh báo kế tiếp để kiểm.
- **Khoá ký bản cập nhật Tauri**: chỉ nằm ở máy phát hành (không nằm trong kho mã); mất khoá = người dùng hiện có không cập nhật tự động được nữa → sao lưu khoá ở nơi an toàn ngoài kho mã.
- **`GOOGLE_OAUTH_CLIENT_SECRET`**: chỉ truyền qua biến môi trường khi build; không ghi vào mã.
- Nếu nghi lộ khoá: thu hồi trước, xoay sau, rồi rà nhật ký sử dụng.

## 7. Sao lưu và khôi phục (diễn tập mỗi quý)

1. Trong WorkHub Fin: cấu hình sao lưu cục bộ (thư mục) và xác nhận tệp sao lưu mới nhất đúng ngày.
2. Diễn tập: tạo dự án Supabase tạm (hoặc nhánh), áp dụng lần lượt các tệp `*-migration.sql`, nạp bản sao lưu, đăng nhập thử bằng tài khoản kiểm thử, so tổng NAV với bản gốc.
3. Ghi lại thời gian khôi phục thực tế và những bước phải làm tay; cập nhật tài liệu này.
4. Lưu ý: bản sao lưu tự động của Supabase cần gói Pro (chưa nâng cấp) — hiện chỉ dựa vào sao lưu của ứng dụng.

## 8. Quy trình xử lý sự cố số liệu

1. Phát hiện (cảnh báo/email/người dùng báo) → ghi thời điểm và mã bị ảnh hưởng.
2. Xác định phạm vi: giá sai ảnh hưởng NAV, rủi ro, hiệu quả, báo cáo nào? (truy theo `finance_data_health` và bảng giá).
3. Chặn lan: nếu cần, báo quản lý tạm dừng ra quyết định dựa trên báo cáo ngày đó.
4. Khắc phục nguồn, tính lại bản chụp NAV bị ảnh hưởng nếu cần.
5. Đánh dấu "Đã xử lý" kèm ghi chú nguyên nhân; nếu lỗi lặp lại, thêm kiểm thử vào `market-data-sync.test.js`.

## 9. Rà soát định kỳ

- **Hằng quý**: đối chiếu biên độ giá, bước giá, chu kỳ thanh toán với quy định mới nhất của HOSE/HNX/UPCoM (xem `lib/vn-market.js`); xem lại giả định ERP (8%) trong `lib/valuation-models.js`.
- **Hằng năm**: cập nhật ERP; diễn tập khôi phục; rà soát Sổ đăng ký mô hình (tab Dữ Liệu).
- **Khi thêm mô hình mới**: thêm mục vào `lib/model-registry.js` kèm tệp kiểm thử thật (kiểm thử tự động sẽ báo nếu thiếu).

## 10. Việc chưa làm / giới hạn đã biết

- Giới hạn phụ thuộc vị thế (tỷ trọng, ngành) chưa bắt buộc ở máy chủ, chỉ kiểm ở ứng dụng và quét hằng ngày.
- Chính sách duyệt lệnh hiện TẮT (bật trong cài đặt chính sách khi cần).
- `check-limits` đang chạy bản cũ hơn kho mã; triển khai lại khi cần các cập nhật gần đây.
- Lịch sử lãi phi rủi ro theo ngày chỉ bắt đầu từ 03/10/2026.

## 11. Đã áp dụng ngày 05/10/2026 (theo yêu cầu của chủ dự án)

- `fin_market_snapshot` (2 bảng + cron `market-snapshot-daily`) và `fin_limit_block_enforce` (trigger chặn MUA vượt giới hạn vị thế, dòng kiểm tra `limit`) đã áp dụng.
- `market-data-sync` v5 (có `peers.ts`) đã triển khai; chạy thử `{"mode":"snapshot"}`: 1.523 mã, 18 ngành + `ALL`, trung vị P/E toàn thị trường 9,94x.
- Trigger đã kiểm bằng khối `DO` có huỷ dữ liệu (9 ca): mua nhỏ cho phép; mua vượt 10% NAV bị chặn `LIMIT_BLOCKED`; bán không bị chặn; quản lý không bị chặn; chế độ "phải ghi lý do" không chặn; giới hạn riêng cho mã thay thế giới hạn chung; cộng dồn vị thế vượt `max_position_vnd` bị chặn; nhập sao kê vượt giới hạn không chặn và ghi 1 dòng kiểm tra `limit`. Sau kiểm không còn dữ liệu thử.
- Còn lại: `check-limits` v1 trên máy chủ cũ hơn kho mã (triển khai lại khi cần). 523 mã trong ảnh chụp chưa có ngành ICB (phần lớn UPCoM nhỏ) nên không vào thống kê ngành.
- 05/10 (sau đó): phát hiện và sửa lỗi thật: PostgREST chỉ trả tối đa 1.000 dòng mỗi lần dù `.limit(5000)`, nên 523 mã trong ảnh chụp mất ngành ICB (thống kê ngành lệch: ngân hàng chỉ 20 mã thay vì 28). Đã thêm `fetchAll` đọc theo trang trong `market-data-sync` (v6) cho meta, giao dịch, theo dõi; chạy lại snapshot: 0 mã thiếu ngành. BẪY: mọi đọc bảng có thể quá 1.000 dòng trong Edge Function phải phân trang.

### Bù ngược lịch sử định giá (chạy tay, một lần)
Chế độ `history` bù theo tháng, tối đa 14 tháng mỗi lần gọi (mỗi tháng 3 lần gọi VNDirect, dò lùi tối đa 7 ngày để tìm ngày có dữ liệu):
```
curl -X POST <url hàm> -H "Authorization: Bearer <publishable key>" -H "apikey: <publishable key>" -H "Content-Type: application/json" -d '{"mode":"history","from":"2021-01","to":"2022-02"}'
```
Lặp cho các đoạn kế tiếp tới tháng hiện tại (6 năm ≈ 6 lần gọi). Chạy lại an toàn (ghi đè theo ngày + phạm vi). Kiểm: `select scope, count(*), min(as_of), max(as_of) from finance_valuation_history group by 1 order by 1;` (kỳ vọng ~70 ngày cho `ALL`).
- 06/10: migration `fin_valuation_history` đã áp dụng (bảng `finance_valuation_history`); `market-data-sync` v7 đã triển khai; bù ngược lịch sử 10/2020 – 10/2026: 70 ngày cho `ALL` và từng ngành. Hai tháng không có dữ liệu trong vòng 7 ngày (03/2024, 01/2025) bị bỏ qua, chuỗi vẫn dùng được (theo tháng, có lỗ hổng). Snapshot hằng ngày từ nay ghi tiếp lịch sử và thêm JdK, beta, vốn hoá, biến động giá vào thống kê.

## 12. Valuation Bench (tách khỏi Investment Workbench, 05/10/2026)

- Giao diện: `/valuation/` (Tổng quan, Hồ sơ cổ phiếu, Phương pháp); Bộ lọc, Thị trường, Bản đồ và Định Giá CP thủ công vẫn là các trang cũ, chỉ đổi khu điều hướng (`bench-nav.js`). Không xoá tính năng nào của Investment Workbench.
- Bảng `finance_vb_valuations` (RLS: cả nhóm tài chính xem; mỗi người chỉ thêm bản của mình; xoá do chủ bản, quản lý tài sản hoặc admin) lưu từng bản định giá; Investment Workbench đọc bản MỚI NHẤT để hiện thẻ "Định giá chuyên môn" ở Chi tiết mã và huy hiệu ở Danh Mục (`stocksheet/vb-card.js`). Nút "Áp dụng vào danh mục" trong Valuation Bench ghi giá mục tiêu như cũ.
- Edge Function `vb-data` (verify_jwt bật) lấy báo cáo tài chính nhiều năm + nến từ VNDirect, bản sao `lib/vb-statements.js` đồng bộ bằng `node scripts/sync-edge-libs.mjs`. `valuation-watch` + cron `valuation-watch-daily` gửi email cảnh báo định giá.
- Triển khai lại `vb-data`: gửi MỌI tệp trong `supabase/functions/vb-data/` nguyên văn (index.ts, parse.ts, vb-statements.js).
- Quy trình định giá 7 bước (06/10/2026, `lib/vb-process.js` + tab Quy trình): phân loại mô hình kinh doanh, cổng dữ liệu, vai trò Chính/Hỗ trợ/Đối chiếu/Tham khảo/Loại -> trọng số, đối chiếu, kiểm tra hợp lý, hồ sơ quyết định. Chạy hoàn toàn ở máy khách, không cần Edge Function hay migration mới: hồ sơ quy trình lưu trong cột JSON `summary.process` và `assumptions.process` của `finance_vb_valuations`. Khi bản định giá có mục "không đạt" hoặc thiếu dữ liệu then chốt, ứng dụng bắt buộc ghi lý do chấp nhận trước khi lưu.
- EV/EBITDA và EV/Doanh thu ngành (từ 05/10/2026, `market-data-sync` v8): tính trong `peers.ts` từ `OPERATING_EBITDA_TR`, `OWNERS_EQUITY_AQ`, `NET_CASH_TO_EQUITY_AQ`, `NET_SALES_TR` của VNDirect; EV = vốn hoá - tiền mặt ròng; bỏ ngân hàng/bảo hiểm/chứng khoán (ICB 8300, 8500, 8700). Ảnh chụp 05/10: 829 mã có EV/EBITDA, trung vị toàn thị trường 6,66x; sau khi triển khai phải chạy `{"mode":"snapshot"}` một lần để ngành có thống kê mới.
- Giới hạn đã biết: NPL/CAR ngân hàng không có từ nguồn miễn phí; chưa kiểm trong ứng dụng Tauri thật với JWT thật, mới kiểm trên bản xem thử với dữ liệu VNDirect thật.
