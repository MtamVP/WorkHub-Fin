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
| market-snapshot-daily | `20 11 * * 1-5` | market-data-sync `snapshot` | ảnh chụp cả thị trường + thống kê ngành (CHƯA bật: cần áp dụng `finance-market-snapshot-migration.sql` và triển khai lại hàm) |
| cleanup_system_logs | `0 3 1 * *` | SQL | dọn nhật ký hệ thống |

### Edge Function (phiên bản đang chạy tại 04/10/2026)

`fetch-stock-prices` v6 · `send-price-alerts` v6 · `stock-history` v5 · `stock-financials` v1 · `stock-events` v2 · `refresh-financials` v2 · `check-limits` v1 (bản triển khai CŨ hơn kho mã) · `approval-watch` v2 · `market-data-sync` v4 · `storage-proxy` v7.

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

## 11. Đang chờ áp dụng lên Supabase (viết xong ở kho mã 04/10/2026, CHƯA áp dụng)

Thứ tự khuyến nghị; mỗi bước kiểm xong mới sang bước sau.

1. **`finance-approval-enforce-migration.sql`** (tên migration `fin_limit_block_enforce`): trigger chặn MUA vượt giới hạn vị thế ở chế độ Chặn + loại dòng kiểm tra `limit`. Áp dụng phần từ khối `do $$` đến hết (bỏ các dòng chú thích đầu tệp nếu muốn). Kiểm: khối `DO` thử bằng `set local role authenticated` (một thành viên mua vượt `max_symbol_pct` chế độ block bị từ chối `LIMIT_BLOCKED`; quản lý không bị chặn; lệnh có `import_batch` ghi dòng kiểm tra `limit`), kết thúc bằng `raise exception` để huỷ dữ liệu thử.
2. **`finance-market-snapshot-migration.sql`** (tên `fin_market_snapshot`): hai bảng `finance_market_snapshot`, `finance_sector_stats` + cron `market-snapshot-daily`.
3. **Triển khai lại `market-data-sync`** (gồm tệp mới `peers.ts`; gửi TẤT CẢ tệp: `index.ts`, `logic.ts`, `peers.ts`). Chạy thử: `{"mode":"snapshot"}` rồi kiểm `select count(*) from finance_market_snapshot;` (kỳ vọng ~1.500) và `select icb2_code, n from finance_sector_stats;` (kỳ vọng ~20 ngành + `ALL`).
4. Sau bước 3 thẻ "So với ngành" (Định Giá CP) và cột "So với ngành" (Toàn Nhóm > Định Lượng) tự có dữ liệu; trước đó chúng tự ẩn, không báo lỗi.
5. `check-limits` v1 trên máy chủ cũ hơn kho mã: triển khai lại (gửi tất cả tệp) khi muốn cập nhật.
