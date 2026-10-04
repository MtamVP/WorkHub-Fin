-- DỮ LIỆU THỊ TRƯỜNG MIỄN PHÍ + GIÁM SÁT VẬN HÀNH (đã áp dụng trên Supabase qua MCP apply_migration "fin_market_data"). Chạy lại an toàn.
--   finance_stock_meta   : thông tin mã (sàn, phân ngành ICB cấp 2, thuộc VN30, ngày niêm yết) do Edge Function market-data-sync cập nhật hằng tuần từ nguồn công khai.
--                          App dùng để phân ngành đầy đủ thay bảng tự gõ (lib/sector-map.js đổi mã ICB sang ngành nội bộ).
--   finance_rates        : lợi suất trái phiếu chính phủ theo kỳ hạn (1/2/3/5/7/10/15 năm) chụp mỗi ngày làm lãi phi rủi ro THEO NGÀY (không còn hằng số 4,5%). Lịch sử bắt đầu từ ngày chạy đầu tiên.
--   finance_data_health  : kết quả kiểm chất lượng dữ liệu (giá hai nguồn lệch, nhảy giá vượt biên độ, thiếu phiên...) -- Edge Function ghi, quản lý đánh dấu đã xử lý.
--   finance_function_runs: nhật ký chạy của các Edge Function định kỳ (để biết hàm nào không chạy / lỗi): app cảnh báo khi quá hạn.
-- Chỉ service role ghi (không có policy INSERT); thành viên nhóm Finance/admin đọc. Quản lý được đánh dấu đã xử lý cảnh báo dữ liệu.

create table if not exists finance_stock_meta (
  symbol text primary key,
  name text,
  exchange text,                       -- HOSE | HNX | UPCOM
  type text,                           -- STOCK | ETF | FUND ...
  icb2_code text,                      -- mã ICB cấp 2 (supersector, bộ ICB 2008 mà nhà cung cấp dùng), vd 8300 = Ngân hàng
  vn30 boolean not null default false,
  listed_date date,
  status text not null default 'listed',
  source text,
  updated_at timestamptz not null default now()
);
create index if not exists finance_stock_meta_exchange_idx on finance_stock_meta (exchange);
alter table finance_stock_meta enable row level security;
drop policy if exists "Finance team can view stock meta" on finance_stock_meta;
create policy "Finance team can view stock meta" on finance_stock_meta for select using (current_user_group() = any (array['finance','admin']));

create table if not exists finance_rates (
  rate_date date not null,
  tenor text not null check (tenor in ('1Y','2Y','3Y','5Y','7Y','10Y','15Y')),
  yield_pct numeric not null check (yield_pct > -5 and yield_pct < 100),
  source text,
  captured_at timestamptz not null default now(),
  primary key (rate_date, tenor)
);
alter table finance_rates enable row level security;
drop policy if exists "Finance team can view rates" on finance_rates;
create policy "Finance team can view rates" on finance_rates for select using (current_user_group() = any (array['finance','admin']));

create table if not exists finance_data_health (
  id uuid primary key default gen_random_uuid(),
  detected_at timestamptz not null default now(),
  kind text not null,                  -- price_mismatch | price_jump | stale_price | missing_session | source_down | meta_gap
  symbol text,
  severity text not null default 'warn' check (severity in ('info','warn','error')),
  ref_date date,
  detail jsonb not null default '{}'::jsonb,
  dedupe_key text unique,              -- cùng loại + mã + ngày chỉ ghi một lần
  resolved boolean not null default false,
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  resolve_note text
);
create index if not exists finance_data_health_open_idx on finance_data_health (resolved, detected_at desc);
alter table finance_data_health enable row level security;
drop policy if exists "Finance team can view data health" on finance_data_health;
create policy "Finance team can view data health" on finance_data_health for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Manager resolves data health" on finance_data_health;
create policy "Manager resolves data health" on finance_data_health for update
  using (current_user_group() = any (array['finance','admin']) and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
  with check (current_user_group() = any (array['finance','admin']));

-- Quản lý chỉ được đánh dấu đã xử lý (resolved/resolve_note); nội dung cảnh báo không sửa được
create or replace function public.fn_finance_data_health_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
begin
  if public.current_user_id() is null then return new; end if;   -- service role
  if new.kind is distinct from old.kind or new.symbol is distinct from old.symbol or new.severity is distinct from old.severity or new.ref_date is distinct from old.ref_date
     or new.detail is distinct from old.detail or new.dedupe_key is distinct from old.dedupe_key or new.detected_at is distinct from old.detected_at then
    raise exception 'Không được sửa nội dung cảnh báo dữ liệu.' using errcode = '42501';
  end if;
  if new.resolved and not old.resolved then new.resolved_by := public.current_user_id(); new.resolved_at := now(); end if;
  if not new.resolved and old.resolved then raise exception 'Không mở lại cảnh báo đã xử lý.' using errcode = '42501'; end if;
  return new;
end;
$fn$;
drop trigger if exists trg_finance_data_health_guard on public.finance_data_health;
create trigger trg_finance_data_health_guard before update on public.finance_data_health for each row execute function public.fn_finance_data_health_guard();

create table if not exists finance_function_runs (
  id bigserial primary key,
  fn text not null,
  mode text,
  run_at timestamptz not null default now(),
  ok boolean not null,
  duration_ms integer,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists finance_function_runs_fn_idx on finance_function_runs (fn, run_at desc);
alter table finance_function_runs enable row level security;
drop policy if exists "Finance team can view function runs" on finance_function_runs;
create policy "Finance team can view function runs" on finance_function_runs for select using (current_user_group() = any (array['finance','admin']));

-- ---- Lịch chạy (pg_cron + pg_net, cùng kiểu approval-watch): Edge Function market-data-sync, Bearer = publishable key (verify_jwt giữ true) ----
-- meta: Chủ nhật 20:00 UTC (3h sáng thứ Hai giờ VN); rates: ngày làm việc 10:30 UTC (17:30 VN, sau khi thị trường đóng cửa); health: 10:45 UTC (17:45 VN).
select cron.unschedule('market-meta-weekly') where exists (select 1 from cron.job where jobname = 'market-meta-weekly');
select cron.schedule('market-meta-weekly', '0 20 * * 0', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/market-data-sync',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"meta"}'::jsonb, timeout_milliseconds := 120000);
$job$);
select cron.unschedule('market-rates-daily') where exists (select 1 from cron.job where jobname = 'market-rates-daily');
select cron.schedule('market-rates-daily', '30 10 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/market-data-sync',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"rates"}'::jsonb, timeout_milliseconds := 60000);
$job$);
select cron.unschedule('market-health-daily') where exists (select 1 from cron.job where jobname = 'market-health-daily');
select cron.schedule('market-health-daily', '45 10 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/market-data-sync',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"health"}'::jsonb, timeout_milliseconds := 150000);
$job$);

-- ---- Chỉ số cơ bản và thị trường (VNDirect ratios): cache theo mã, cập nhật mỗi ngày làm việc cho mã đang nắm/theo dõi và theo yêu cầu từ app ----
create table if not exists finance_stock_ratios (
  symbol text primary key,
  daily_date date,                    -- ngày báo cáo của nhóm chỉ số ngày (P/E, P/B, beta, 52 tuần...)
  quarter_date date,                  -- ngày báo cáo (cuối quý) của nhóm chỉ số quý (ROE, biên lợi nhuận, tăng trưởng...)
  metrics jsonb not null default '{}'::jsonb,
  source text,
  updated_at timestamptz not null default now()
);
alter table finance_stock_ratios enable row level security;
drop policy if exists "Finance team can view stock ratios" on finance_stock_ratios;
create policy "Finance team can view stock ratios" on finance_stock_ratios for select using (current_user_group() = any (array['finance','admin']));

select cron.unschedule('market-ratios-daily') where exists (select 1 from cron.job where jobname = 'market-ratios-daily');
select cron.schedule('market-ratios-daily', '0 11 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/market-data-sync',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"ratios"}'::jsonb, timeout_milliseconds := 150000);
$job$);
