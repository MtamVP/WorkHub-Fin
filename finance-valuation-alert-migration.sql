-- CẢNH BÁO ĐỊNH GIÁ gửi email cho quản lý (06/10/2026). Chạy lại an toàn. Chỉ service role (Edge Function valuation-watch) ghi; nhóm finance/admin được xem.
-- Mỗi dòng = một cảnh báo đang theo dõi (khoá = loại cảnh báo + đối tượng, VD market-rich-P/E, sector-rich-2700). Bảng nhớ để KHÔNG báo lặp mỗi ngày:
--  - active: cảnh báo đang còn hiệu lực ở lần chạy gần nhất; hết hiệu lực thì active=false, nếu sau đó xuất hiện lại thì được coi là mới
--  - last_notified_at: lần gần nhất đã gửi email; không gửi lại trong 7 ngày kể cả khi cảnh báo nhấp nháy quanh ngưỡng
create table if not exists finance_valuation_alert_state (
  alert_key text primary key,
  level text not null check (level in ('warn', 'info')),
  scope text,
  title text not null,
  detail text,
  active boolean not null default true,
  first_seen date not null,
  last_seen date not null,
  last_notified_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table finance_valuation_alert_state enable row level security;
drop policy if exists "Finance team can view valuation alert state" on finance_valuation_alert_state;
create policy "Finance team can view valuation alert state" on finance_valuation_alert_state for select using (current_user_group() = any (array['finance','admin']));

-- Chạy sau ảnh chụp thị trường hằng ngày (11:20 UTC) 20 phút: 11:40 UTC = 18:40 giờ Việt Nam, các ngày làm việc
select cron.unschedule('valuation-watch-daily') where exists (select 1 from cron.job where jobname = 'valuation-watch-daily');
select cron.schedule('valuation-watch-daily', '40 11 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/valuation-watch',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$job$);
