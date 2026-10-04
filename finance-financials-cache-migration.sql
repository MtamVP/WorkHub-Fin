-- Làm mới số liệu tài chính tự động mỗi ngày (Edge Function refresh-financials) -> bảng đệm dùng chung để trang Tổng Hợp CP biết
-- mã nào vừa có báo cáo mới. Áp dụng trên Supabase qua MCP (apply_migration "fin_financials_cache" + lịch cron bên dưới). Chạy lại an toàn.

create table if not exists finance_financials_cache (
  symbol text primary key,
  form text,
  payload jsonb not null,          -- đúng định dạng kết quả của Edge Function stock-financials (form, annual[], quarters[], dividends{})
  annual_year int,
  quarter_key text,                -- vd '2026Q2'
  fingerprint text,
  fetched_at timestamptz not null default now(),
  changed_at timestamptz not null default now()   -- chỉ đổi khi số liệu thật sự đổi (báo cáo mới / điều chỉnh / cổ tức mới)
);
alter table finance_financials_cache enable row level security;
-- Chỉ ĐỌC cho nhóm finance/admin; không có chính sách ghi: chỉ Edge Function (service role) ghi được.
drop policy if exists "Finance team can view financials cache" on finance_financials_cache;
create policy "Finance team can view financials cache" on finance_financials_cache for select
  using (current_user_group() = any (array['finance','admin']));

-- Lịch: 07:15 và 18:15 giờ Việt Nam (00:15 và 11:15 UTC), mỗi ngày. Cùng kiểu với fetch-stock-prices / send-price-alerts.
-- (đã chạy: select cron.schedule('refresh-financials-daily', '15 0,11 * * *', $cmd$ ... $cmd$);)
select cron.unschedule('refresh-financials-daily') where exists (select 1 from cron.job where jobname = 'refresh-financials-daily');
select cron.schedule('refresh-financials-daily', '15 0,11 * * *', $cmd$
  select net.http_post(
    url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/refresh-financials',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) as request_id;
$cmd$);
