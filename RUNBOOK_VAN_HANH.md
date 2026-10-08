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
- Làm sâu định giá (06/10/2026): DCF theo động lực, bộ mã so sánh tự chọn (đọc `finance_market_snapshot` qua `API.asset.vb.peerRows`) và điều chỉnh khoản bất thường; đều chạy ở máy khách, lựa chọn của người dùng lưu trong `assumptions` của bản định giá.
- Bảng điểm độ chính xác: chạy `node scripts/vb-backtest-run.mjs --icb <tệp ngành>` (dữ liệu VNDirect, ~5 phút lần đầu rồi dùng bộ đệm) để sinh `valuation/vb-scorecard.js`; nên chạy lại mỗi quý hoặc sau khi đổi bảng vai trò, rồi phát hành app. Ghi chú: hiệu chỉnh vai trò 10/2026 chỉ dựa trên giai đoạn T đến 2023 và không cải thiện giai đoạn sau; muốn đổi bảng vai trò tiếp phải kiểm ngoài mẫu như vậy.
- Quy trình định giá 7 bước (06/10/2026, `lib/vb-process.js` + tab Quy trình): phân loại mô hình kinh doanh, cổng dữ liệu, vai trò Chính/Hỗ trợ/Đối chiếu/Tham khảo/Loại -> trọng số, đối chiếu, kiểm tra hợp lý, hồ sơ quyết định. Chạy hoàn toàn ở máy khách, không cần Edge Function hay migration mới: hồ sơ quy trình lưu trong cột JSON `summary.process` và `assumptions.process` của `finance_vb_valuations`. Khi bản định giá có mục "không đạt" hoặc thiếu dữ liệu then chốt, ứng dụng bắt buộc ghi lý do chấp nhận trước khi lưu.
- EV/EBITDA và EV/Doanh thu ngành (từ 05/10/2026, `market-data-sync` v8): tính trong `peers.ts` từ `OPERATING_EBITDA_TR`, `OWNERS_EQUITY_AQ`, `NET_CASH_TO_EQUITY_AQ`, `NET_SALES_TR` của VNDirect; EV = vốn hoá - tiền mặt ròng; bỏ ngân hàng/bảo hiểm/chứng khoán (ICB 8300, 8500, 8700). Ảnh chụp 05/10: 829 mã có EV/EBITDA, trung vị toàn thị trường 6,66x; sau khi triển khai phải chạy `{"mode":"snapshot"}` một lần để ngành có thống kê mới.
- Giới hạn đã biết: NPL/CAR ngân hàng không có từ nguồn miễn phí; chưa kiểm trong ứng dụng Tauri thật với JWT thật, mới kiểm trên bản xem thử với dữ liệu VNDirect thật.
- Bộ lọc thị trường mở rộng (07/10/2026, `market-data-sync` v9): ảnh chụp có thêm `chgYtd` (biến động giá từ 1/1, mã VNDirect `PRICE_CHG_PCT_CR_YD`, đã đối chiếu với giá đóng cửa thật: lệch dưới 1 điểm % do giá điều chỉnh), `chg1m`, `chg6m`, và tăng trưởng lợi nhuận ròng `netProfitGrowthYoY` (12 tháng), `netProfitGrowthQ` (quý), `netProfitGrowth3y` (kép 3 năm, đã đối chiếu với số tự tính), `pretaxGrowthYoY`. Giao diện thêm vốn hoá tối đa, chọn nhiều ngành, tối đa mỗi ngành và tối đa tổng cộng. Sau khi triển khai, ảnh chụp cũ chưa có các trường mới: tiêu chí mới báo "thiếu số liệu" cho tới lần chạy `{"mode":"snapshot"}` kế tiếp (cron 18:20 ngày làm việc).
- Lịch sử ảnh chụp thị trường lưu TRONG MÁY (07/10/2026, không đụng Supabase): `market-history.js` (trang gốc, cạnh `local-backup.js`) mỗi giờ kiểm `finance_sector_stats.as_of` (một dòng); nếu mới hơn tệp mới nhất đã lưu thì tải `finance_market_snapshot` + `finance_sector_stats` (chỉ đọc) và ghi `market-history/snapshot-YYYY-MM-DD.json.gz` trong AppLocalData (Windows: `%LOCALAPPDATA%\com.workhub.fin\market-history`), thêm một bản vào `<thư mục mạng>/market-history/` nếu đã cấu hình ở Sao lưu. Định dạng tệp và hàm đọc: `lib/market-history.js` (`unpack` trả đúng đầu vào của `MarketScreener.buildRows`). Cần quyền `fs:allow-write-file` (đã thêm vào `default.json`, chỉ có hiệu lực từ bản cài mới). Không xoá tệp cũ (mỗi tệp ~150-250 KB). Ngày không mở app thì không có tệp. Dùng sau vài tháng để kiểm chứng mẫu lọc bằng số liệu thật.
- Định giá hàng loạt ở bộ lọc thị trường (`lib/market-batch.js`, `stocksheet/market-screener-ui.js`): mỗi mã một lượt gọi `vb-data` (`API.asset.vb.data(..., {lite:true})` bỏ truy vấn bội số ngành và lịch sử), tối đa 150 mã mỗi lần, 3 mã đồng thời; không ghi gì vào `finance_vb_valuations`. Bộ lọc đã lưu nằm trong localStorage của máy (`wh.fin.marketscreener.saved.v1`).
- Backtest hằng quý: `node scripts/vb-backtest-run.mjs --cache <thư mục đệm> --symbols <danh sách> --icb <tệp {SYM:icb2}>` (tập mã 10/2026: các mã vốn hoá từ 1.500 tỷ và thanh khoản từ 2 tỷ/ngày, 171 mã dùng được; danh sách và tệp ngành sinh từ ảnh chụp thị trường). Mỗi lần chạy thêm một dòng vào `valuation/vb-scorecard-log.json` (IC 12 tháng, huấn luyện/ngoài mẫu, IC từng mô hình) để thấy độ chính xác có ổn định theo thời gian không. Lần chạy lại 07/10/2026 trên 171 mã (12.256 quan sát): IC 12 tháng +0,28 (khoảng tin cậy +0,26 đến +0,30), huấn luyện +0,25, ngoài mẫu +0,28. Mở rộng mẫu bác bỏ kết luận cũ "nhóm cổ tức dự báo ngược" (53 mã, 9 mã cổ tức) vì 32 mã cổ tức cho EPV +0,22/+0,27, Graham +0,28/+0,31, Lynch +0,37/+0,46 (huấn luyện/ngoài mẫu): vai trò nhóm DIVIDEND (EPV, Graham lên hỗ trợ, Lynch lên đối chiếu) và nhóm GROWTH (Graham lên đối chiếu) đã sửa theo QUY TẮC chỉ đổi khi cả hai giai đoạn cùng chiều (IC >= 0,2). Kiểm gần đúng ghép trọng số: IC nhóm DIVIDEND huấn luyện 0,22 lên 0,26, ngoài mẫu 0,24 lên 0,29; GROWTH 0,35 lên 0,37 và 0,07 lên 0,12 (cùng dữ liệu đã dùng để chọn nên chưa phải bằng chứng độc lập). Còn hạn chế: người sống sót, một chu kỳ thị trường, thiếu thống kê ngành lịch sử.
- Giá trực tiếp Danh Mục (07/10/2026, `lib/live-quotes.js`, `mastersheet/assets/live-ui.js`): đã dò các nguồn giá trong ngày (07/10/2026 lúc sàn mở): VNDirect finfo `stock_prices` (CORS mở, một lượt cho nhiều mã `q=code:A,B,C~date:YYYY-MM-DD`, trễ 15 giây đến 2 phút), VNDirect dchart nến 1 phút (CORS mở), VCI gap-chart nến 1 phút (trễ 13-43 giây nhưng CORS chỉ cho trading.vietcap.com.vn, chỉ dùng được từ máy chủ), DNSE entrade (không CORS), TradingView scanner (`delayed_streaming_900` = chậm 15 phút, không dùng), SSI iboard-query (403 chặn) và TCBS (Cloudflare chặn). Chọn finfo vì cùng nhà cung cấp đang dùng, không cần khoá, gọi thẳng từ app. Ghi đè GIÁ HIỂN THỊ ở máy khách (không qua `getHoldingsView`, nên `recomputeAndSnapshot` và lịch sử NAV không bao giờ nhận giá trực tiếp). Cron `fetch-stock-prices-hourly` (`*/5 2-7 * * 1-5` UTC) vẫn là giá chính thức. Nếu cần nhịp nhanh hơn hoặc ổn định hơn: thêm Edge Function proxy VCI (cần triển khai trên Supabase) hoặc SSI FastConnect (cần khoá riêng từng người dùng, xác nhận điều khoản với SSI).
- Edge Function `live-quotes` (07/10/2026, v1, verify_jwt true, KHÔNG đụng CSDL, không có khoá bí mật): bảng giá VCI `POST /api/price/v1/w/priceboard/tickers/price/group {group:"HOSE"|"HNX"|"UPCOM"}` trả cả sàn trong một lượt (HOSE 430 mã 205 KB, 2-6 giây); hàm lọc theo mã yêu cầu (tối đa 80), tìm HOSE trước rồi HNX/UPCOM cho mã còn thiếu, bộ nhớ đệm 3 giây trong isolate dùng chung. Gọi từ app bằng `API.asset.market.liveQuotes` (JWT người dùng). Đã gọi thật: FPT, HPG, VNM, SHS đúng giá, mã lạ báo `missing`, thiếu `symbols` trả 400. `lib/live-quotes.js` ưu tiên VCI, rồi VNDirect finfo, rồi nến dchart. Bảng VCI KHÔNG có ngày: cuối tuần/nghỉ lễ nó vẫn giữ giá phiên trước, nên app chỉ nhận giá VCI khi VNDirect xác nhận hôm nay có giao dịch. Mỗi người mở Danh Mục trong phiên tốn 3 lượt gọi hàm mỗi phút (20 giây một lần): theo dõi mức dùng Edge Function nếu nhiều người dùng cùng lúc. Triển khai lại: gửi đủ `index.ts` và `parse.ts` nguyên văn (deploy_edge_function, verify_jwt true).
- Đợt sau 0.1.11 (07/10/2026, CHƯA release): (1) `lib/vn-holidays.js` lịch nghỉ lễ sàn, đối chiếu ngày thật không có dòng giá (2025, 2026 đủ; 2027 mới có 1/1): **mỗi năm phải thêm lịch Tết Nguyên đán và các ngày lễ khi Chính phủ công bố** (không thêm thì app vẫn đúng nhờ VNDirect không có giá hôm nay, chỉ thiếu thông báo "nghỉ lễ"); ngày lễ trong danh sách mà VNDirect vẫn có giá thì app tin dữ liệu. (2) Cảnh báo theo giá trực tiếp + đường lãi/lỗ trong ngày trong Danh Mục (`mastersheet/assets/live-ui.js`, `lib/live-alerts.js`, `lib/live-series.js`): chỉ máy khách, dữ liệu ở localStorage (`wh.fin.live.v1`, `wh.fin.liveseries.v1`, `wh.fin.livealerts.v1`), khoá chống báo lặp dùng chung `wh_notified_price_alerts_<ngày>` với `notify-deadlines.js`. LƯU Ý: `notify-deadlines.js` chỉ chạy ở trang gốc, KHÔNG chạy trong trang Danh Mục, nên khi ở Danh Mục thông báo hệ điều hành là do `live-ui.js` gửi. (3) Menu tài khoản > "Kiểm tra hệ thống" (`self-check.js`, `lib/self-check.js`): thử hàm VCI, VNDirect, ghi tệp trong máy (tệp tạm `market-history/_selfcheck.tmp`, tự xoá), thông báo, ảnh chụp thị trường (số liệu mới đã nạp chưa), vb-data và chạy thử định giá hàng loạt 1 mã; có nút sao chép báo cáo (không chứa khoá/email) và gửi thông báo thử. (4) Bản đồ nhiệt ngành ở Tổng Hợp CP > Thị trường (`lib/sector-heatmap.js`, `stocksheet/market-screener-ui.js`): bấm ô để chọn ngành vào bộ lọc; màn hình hẹp hiện danh sách xếp theo biến động thay cho treemap. (5) `check-limits` đối chiếu bản đang chạy (v2) với kho mã ngày 07/10/2026: chỉ khác một chú thích, một nhánh hiển thị `live` của `finance-calc.js` mà hàm không dùng và cách viết ký tự BOM; hành vi giống nhau nên KHÔNG cần triển khai lại.
- VN-Index trực tiếp và Theo Dõi trực tiếp (07/10/2026, chưa release): `LiveQuotes.refresh(..., { index: true })` gọi thêm một lượt nến 1 phút dchart `symbol=VNINDEX` (4 ngày gần nhất) lấy nến cuối hôm nay làm giá trị và nến cuối phiên trước làm tham chiếu; không có nến hôm nay thì chỉ số trống (ngày lễ/cuối tuần). `LiveUI.afterWatchlist` gộp mã Theo Dõi vào cùng lượt lấy giá (tối đa 80 mã, danh mục trước). LƯU Ý khi kiểm bằng trình duyệt headless: VNDirect trả 403 "Access Denied" cho User-Agent HeadlessChrome; đặt User-Agent Edge thường (CDP `Emulation.setUserAgentOverride`) thì chạy (app thật dùng WebView2 nên không bị).
- Đợt sau 0.1.12 (07/10/2026, chưa release): (1) `filter-watch.js` + `lib/filter-watch.js`: đọc 2 tệp `market-history/snapshot-*.json.gz` gần nhất (cần quyền `fs:allow-read-file` MỚI trong `src-tauri/capabilities/default.json`, chỉ có từ bản cài mới; scope vẫn `$APPLOCALDATA/**`), so các bộ lọc đã lưu (`wh.fin.marketscreener.saved.v1`), cất kết quả gọn ở `wh.fin.filterwatch.v1`, gửi MỘT thông báo cho mỗi ngày dữ liệu khi có mã mới lọt vào; thẻ hiển thị ở Valuation Bench > Thị trường. Trang gốc nạp thêm `lib/peer-valuation.js` và `lib/market-screener.js` (do đó `self-check.js` KHÔNG nạp lại hai tệp này khi chạy thử định giá hàng loạt: nạp lại sẽ lỗi khai báo trùng). (2) Cảnh báo cấp danh mục trong `live-ui.js`: ô "Báo NAV giảm" (0/1/2/3/5%) và giới hạn đầu tư theo giá trong phiên (nạp `listLimits`, `getLimitActor`, `getCashDebt` nền, tối đa 5 phút một lần; lỗi thì chỉ mất cảnh báo giới hạn). (3) Thẻ "Hôm nay" (`mastersheet/assets/today.js`, `lib/today-brief.js`): chỉ đọc, mỗi phần tải riêng và tự bỏ khi lỗi; cảnh báo của ngày trước được `live-ui.js` cất sang `wh.fin.livealerts.prev.v1` khi sang ngày mới. Kiểm tra sau khi cài: Kiểm tra hệ thống mục "Ghi tệp trong máy" phải ghi chữ "lịch sử ảnh chụp và theo dõi bộ lọc dùng được" (đã thử cả đọc tệp nhị phân).
- source-watch (07/10/2026, LIVE trên Supabase v2, cron `source-probe` `*/30 2-7 * * 1-5` UTC và `source-daily` `50 11 * * 1-5` UTC; migration `finance-source-watch-migration.sql`): KHÔNG có bảng mới. Ghi `finance_function_runs` (fn `source-watch`, mode `probe:vci|probe:finfo|probe:dchart|daily`) và `finance_data_health` (kind `source_probe` | `snapshot_stale`, dedupe_key theo loại + nguồn + ngày). Quy tắc: 4 lần lỗi liền = cảnh báo không email; lỗi quá nửa (tối thiểu 6 lần/ngày) trong 2 ngày giao dịch liền, hoặc ảnh chụp chậm từ 2 ngày giao dịch = mức lỗi + email quản lý (RESEND_API_KEY, quản lý bật email cảnh báo). ĐO THẬT: ảnh chụp thị trường chạy tối ngày D mang ngày số liệu của phiên TRƯỚC (06/10 -> 05/10), nên ngày kỳ vọng là `prevTradingDay(today)`. `api.js` `market.runs` loại `source-watch` (để thăm dò không đẩy các lần chạy hằng ngày ra khỏi 400 dòng), `market.sourceProbes(days)` lấy riêng. Triển khai lại: gửi đủ `index.ts`, `logic.ts`, `vn-holidays.js` nguyên văn (deploy_edge_function, verify_jwt true); `vn-holidays.js` là bản sao do `node scripts/sync-edge-libs.mjs` tạo (test so khớp). Thêm lịch lễ mới vào `lib/vn-holidays.js` rồi chạy sync và triển khai lại hàm.
- Giá trực tiếp trong form nhập lệnh (`lib/pretrade-live.js`, `mastersheet/assets/pretrade.js`): tự điền giá khi gõ mã (ô trống hoặc đang giữ giá tự điền), kiểm tra trước lệnh theo giá trực tiếp, cảnh báo ngoài trần/sàn; chỉ gợi ý, không đổi sổ. Nhật ký phiên (`lib/session-log.js`, `mastersheet/assets/session-ui.js`): localStorage `wh.fin.sessionlog.v1` + tệp `session-log/session-log.json` trong AppLocalData (cần quyền `fs:allow-write-text-file`, đã có); LiveUI gọi `SessionUI.record` mỗi lần có giá trực tiếp. LƯU Ý khi viết test phụ thuộc ngày: giờ máy chạy test có thể lệch giờ VN (đã gặp: máy ở UTC-3, qua nửa đêm VN trong khi máy chưa sang ngày); dùng `LiveQuotes.vnParts()` thay vì hằng số ngày.
- Sau 0.1.13 (08/10/2026, CHƯA release, cần 0.1.14; chỉ có phía app, KHÔNG đổi máy chủ): (1) "Kiểm tra hệ thống" nay báo trước lịch nghỉ lễ năm sau (từ 1/11 mà lịch năm sau chưa đủ thì ở mức Chú ý): khi Chính phủ công bố lịch Tết thì thêm vào `lib/vn-holidays.js` (đối chiếu dòng giá thật), thêm năm vào `COMPLETE_YEARS`, chạy `node scripts/sync-edge-libs.mjs` rồi **deploy lại Edge `source-watch`** (bản trên máy chủ giữ bản sao cũ của lịch); (2) bộ lọc thị trường có thêm EV/EBITDA tối đa và EV/EBITDA so với trung vị ngành (dùng số có sẵn từ `market-data-sync` v8, không cần chạy lại snapshot), cột EV/EBITDA trong bảng và CSV; (3) "Ôn lại cảnh báo" ở Hiệu Suất (`lib/alert-review.js`, `mastersheet/assets/alert-review-ui.js`, localStorage `wh.fin.alerthist.v1`) và nút "Ghi quyết định" từ cảnh báo (thẻ tự gắn `cảnh báo giá`, Nhật Ký Quyết Định và báo cáo tháng đếm số quyết định từ cảnh báo); (4) "Kiểm chứng bộ lọc bằng lịch sử" ở Thị trường (`lib/filter-validate.js`, `filter-watch.js` validate, localStorage `wh.fin.filtervalid.v1`): đo lợi suất 1/3/6 tháng sau khi mã lọt vào bộ lọc so với trung vị thị trường từ chính ảnh chụp trong máy (cần nhiều tháng lịch sử mới có ý nghĩa; thiên lệch người sống sót). Chưa kiểm trong app Tauri thật.
- Tổng kiểm tra 08/10/2026 (ĐÃ áp dụng lên máy chủ): deploy Edge `fetch-stock-prices` v7, `send-price-alerts` v8, `refresh-financials` v3, `check-limits` v3, `valuation-watch` v2 -- đọc bảng theo trang (fetchAll, không còn bị cắt ở 1.000 dòng; đọc lỗi thì dừng thay vì tính trên mảng rỗng) và sự kiện doanh nghiệp cùng ngày áp TRƯỚC lệnh. Kiểm sau deploy: `selftest` của check-limits/valuation-watch khớp kết quả tính trên repo (`vb-probe/selftest-expect.mjs` + `call-selftest.mjs`), refresh-financials chạy thật OK, fetch-stock-prices dryRun OK. Migration `security_perf_hardening_2026_10_08` (tệp `security-perf-hardening-migration.sql`): thu hồi EXECUTE của 8 hàm trigger fn_finance_* khỏi anon/authenticated (trigger vẫn chạy), bọc auth.uid()/auth.jwt() bằng (select ...) ở 10 chính sách RLS (đã kiểm: chủ dữ liệu thấy đủ, người lạ thấy 0). Cảnh báo còn lại là CÓ CHỦ ĐÍCH: hàm current_user_*/org_unit_* (RLS cần EXECUTE), pg_net ở schema public, finance_alert_log chỉ service role. Người dùng tự bật: Auth > Leaked password protection.
- Liên kết web kế toán OnyxLine Accounting (08/10/2026, CHƯA release app; web kế toán CHƯA deploy): `lib/accounting-bridge.js` (+ `lib/portfolio-calc.js`) đổi sổ lệnh, cổ tức tiền, nạp/rút, giá thị trường thành bút toán đề xuất theo TT200 (mua Nợ 121; bán Nợ tiền + 635 / Có 121 + 515 theo giá vốn FIFO của Fin; cổ tức Có 515; nạp/rút đối ứng 4111; dự phòng giảm giá Nợ 635 / Có 2291 so với số dư sổ). Hai nơi chạy CÙNG một bản: thẻ Báo Cáo > Liên Kết Kế Toán trong Fin (`mastersheet/assets/accounting-link-ui.js`, chỉ xem + tải CSV + mở web kế toán, không ghi gì) và màn "Đầu tư (WorkHub Fin)" trong web kế toán (`onyxline-accounting/src/views-fin-link.js`, đọc finance_* bằng chính phiên WorkHub-AI qua RLS rồi POST /api/v9/vouchers => chứng từ NHÁP vào hàng đợi duyệt, người lập khác người duyệt). **Bản sao ở web kế toán phải giống hệt**: sửa `lib/accounting-bridge.js` ở Fin rồi chép sang `onyxline-accounting/src/accounting-bridge.js` (và `lib/portfolio-calc.js` -> `src/portfolio-calc.js`); kiểm: `ONYXLINE_PATH=<thư mục onyxline-accounting> npx vitest run tests/unit/accounting-bridge.test.js` (bài so sánh bản sao chỉ chạy khi có biến này). Mã chứng từ cố định `FIN-<MUA|BAN|CT|NAP|RUT>-<mã gốc>` (`FIN-DP-YYYYMMDD` cho dự phòng) nên gửi hai lần không trùng; bị từ chối thì gửi lại thành `~2`, `~3`. Điều kiện chạy thật: Supabase `Workhub-Tool` (dữ liệu kế toán) phải có hệ thống tài khoản TT200 (08/10/2026 bảng `accounts` còn TRỐNG, cần nạp `seed-coa-tt200.sql`), người dùng thuộc nhóm tài chính/admin trên WorkHub (RLS đọc finance_*) và có tài khoản trong bảng `users` của web kế toán; cần người duyệt thứ hai. Giới hạn: một danh mục của một người; thuế bán 0,1% ghi vào 635; nạp/rút mặc định đối ứng vốn góp.
