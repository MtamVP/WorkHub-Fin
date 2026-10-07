-- GIÁM SÁT NGUỒN DỮ LIỆU (đã áp dụng trên Supabase qua MCP apply_migration "fin_source_watch", 07/10/2026). Chạy lại an toàn.
-- Không có bảng mới: Edge Function source-watch dùng finance_function_runs (fn = 'source-watch', mode = 'probe:vci' | 'probe:finfo' | 'probe:dchart' | 'daily')
-- và finance_data_health (kind = 'source_probe' | 'snapshot_stale', dedupe_key theo loại + nguồn + ngày), cả hai chỉ service role ghi (xem finance-market-data-migration.sql).
-- pg_cron (cùng kiểu approval-watch, Bearer = publishable key, verify_jwt giữ true):
--   source-probe : mỗi 30 phút 02:00-07:30 UTC = 9:00-14:30 giờ VN, ngày làm việc -> thăm dò bảng giá VCI, VNDirect finfo, dchart.
--   source-daily : 11:50 UTC = 18:50 giờ VN, ngày làm việc (sau market-snapshot-daily 18:20) -> kiểm ảnh chụp thị trường và nguồn lỗi hai ngày liền, email quản lý nếu có sự cố mức lỗi mới.
-- Ngày lễ: hàm tự bỏ qua (lib/vn-holidays.js). Đo thật 07/10/2026: ngày số liệu của ảnh chụp luôn là phiên TRƯỚC (chạy tối 06/10 ra 05/10); hàm đã tính điều này.

select cron.unschedule('source-probe') where exists (select 1 from cron.job where jobname = 'source-probe');
select cron.schedule('source-probe', '*/30 2-7 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/source-watch',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"probe"}'::jsonb, timeout_milliseconds := 60000);
$job$);
select cron.unschedule('source-daily') where exists (select 1 from cron.job where jobname = 'source-daily');
select cron.schedule('source-daily', '50 11 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/source-watch',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"daily"}'::jsonb, timeout_milliseconds := 90000);
$job$);
