-- ẢNH CHỤP CẢ THỊ TRƯỜNG + THỐNG KÊ THEO NGÀNH để định giá tương đối. CHƯA áp dụng lên Supabase (viết 04/10/2026; chờ cho phép áp dụng migration "fin_market_snapshot").
-- Chạy lại an toàn. Chỉ service role (Edge Function market-data-sync, mode "snapshot") ghi; nhóm finance / admin đọc.
--  finance_market_snapshot : mỗi mã niêm yết một dòng (P/E, P/B, P/S, vốn hoá, cổ tức, ROE, tăng trưởng, beta, thanh khoản... theo tên ngắn như finance_stock_ratios) + ngành ICB cấp 2.
--  finance_sector_stats    : mỗi ngành ICB cấp 2 (và 'ALL' = toàn thị trường) một dòng: số mã, trung vị và 11 điểm phân vị (p0, p10, ..., p100) của P/E, P/B, P/S, ROE, tỷ suất cổ tức,
--                            chỉ tính trên mã vốn hoá từ 300 tỷ và giá trị hợp lý (P/E 0-100, P/B 0-30...).

create table if not exists finance_market_snapshot (
  symbol text primary key,
  icb2_code text,
  daily_date date,
  quarter_date date,
  metrics jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists finance_market_snapshot_icb_idx on finance_market_snapshot (icb2_code);
alter table finance_market_snapshot enable row level security;
drop policy if exists "Finance team can view market snapshot" on finance_market_snapshot;
create policy "Finance team can view market snapshot" on finance_market_snapshot for select using (current_user_group() = any (array['finance','admin']));

create table if not exists finance_sector_stats (
  icb2_code text primary key,
  n integer not null default 0,
  as_of date,
  stats jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table finance_sector_stats enable row level security;
drop policy if exists "Finance team can view sector stats" on finance_sector_stats;
create policy "Finance team can view sector stats" on finance_sector_stats for select using (current_user_group() = any (array['finance','admin']));

-- Chạy mỗi ngày làm việc 11:20 UTC (18:20 VN), sau khi VNDirect cập nhật chỉ số cuối ngày
select cron.unschedule('market-snapshot-daily') where exists (select 1 from cron.job where jobname = 'market-snapshot-daily');
select cron.schedule('market-snapshot-daily', '20 11 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/market-data-sync',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"snapshot"}'::jsonb, timeout_milliseconds := 150000);
$job$);
