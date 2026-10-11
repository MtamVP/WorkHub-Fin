-- INSIGHT (11/10/2026): luận điểm đầu tư, sở hữu / giao dịch nội bộ, nhật ký dự phóng lợi nhuận. Chạy lại an toàn.
-- Kho dữ liệu theo thời điểm (finance_pit_*) nằm ở finance-pit-migration.sql.
--  finance_thesis_conditions : điều kiện ĐO ĐƯỢC của một ý tưởng (ROE >= 15%, nợ/vốn <= 1...). Người dùng sửa phần mô tả; các cột last_* chỉ máy chủ (insight-sync, chế độ thesis) ghi.
--  finance_thesis_log        : mỗi lần một điều kiện đổi trạng thái đúng <-> sai (chỉ máy chủ ghi).
--  finance_shareholders / finance_insider_trades / finance_ownership_sync : cổ đông lớn và giao dịch nội bộ từ Vietcap iq-insight (insight-sync, chế độ ownership; chỉ máy chủ ghi).
--  finance_forecasts         : dự phóng lợi nhuận / doanh thu người dùng ghi lại để chấm với báo cáo thật. BẤT BIẾN: không sửa, ngày ghi do máy chủ đặt (không lùi ngày được).

-- ---------- Luận điểm ----------
create table if not exists finance_thesis_conditions (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references finance_ideas(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  metric text not null check (metric ~ '^[A-Za-z0-9_]{1,40}$'),
  op text not null check (op in ('>=','<=','>','<')),
  threshold numeric,
  severity text not null default 'watch' check (severity in ('critical','watch')),
  label text check (label is null or length(label) <= 120),
  manual_met boolean,
  last_state text check (last_state is null or last_state in ('ok','fail','unknown')),
  last_value numeric,
  last_checked timestamptz,
  state_since timestamptz,
  notified_state text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists finance_thesis_conditions_idea_idx on finance_thesis_conditions (idea_id);
create table if not exists finance_thesis_log (
  id bigserial primary key,
  condition_id uuid not null references finance_thesis_conditions(id) on delete cascade,
  idea_id uuid not null references finance_ideas(id) on delete cascade,
  at timestamptz not null default now(),
  from_state text,
  to_state text not null,
  value numeric
);
create index if not exists finance_thesis_log_idea_idx on finance_thesis_log (idea_id, at desc);

alter table finance_thesis_conditions enable row level security;
alter table finance_thesis_log enable row level security;
drop policy if exists "Finance team can view thesis conditions" on finance_thesis_conditions;
create policy "Finance team can view thesis conditions" on finance_thesis_conditions for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Finance team can view thesis log" on finance_thesis_log;
create policy "Finance team can view thesis log" on finance_thesis_log for select using (current_user_group() = any (array['finance','admin']));
-- Ghi: chủ ý tưởng, quản lý danh mục hoặc admin (cùng quy tắc sửa ý tưởng)
drop policy if exists "Write thesis conditions" on finance_thesis_conditions;
create policy "Write thesis conditions" on finance_thesis_conditions for all
  using (current_user_group() = any (array['finance','admin']) and exists (select 1 from finance_ideas i where i.id = idea_id and (i.user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin')))
  with check (current_user_group() = any (array['finance','admin']) and exists (select 1 from finance_ideas i where i.id = idea_id and (i.user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin')));

-- Cột kết quả kiểm (last_*, state_since, notified_state) không do người dùng đặt: khi chèn thì để trống, khi sửa thì giữ nguyên giá trị cũ. Máy chủ (không có người dùng) bỏ qua.
-- Đổi điều kiện (chỉ tiêu, phép so, ngưỡng) thì xoá kết quả cũ để máy chủ kiểm lại từ đầu.
create or replace function public.fn_finance_thesis_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
begin
  if public.current_user_id() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.last_state := null; new.last_value := null; new.last_checked := null; new.state_since := null; new.notified_state := null;
    return new;
  end if;
  if new.idea_id is distinct from old.idea_id then raise exception 'Không được chuyển điều kiện sang ý tưởng khác.' using errcode = '42501'; end if;
  if new.metric is distinct from old.metric or new.op is distinct from old.op or new.threshold is distinct from old.threshold or new.manual_met is distinct from old.manual_met or new.severity is distinct from old.severity then
    new.last_state := null; new.last_value := null; new.last_checked := null; new.state_since := null; new.notified_state := null;
  else
    new.last_state := old.last_state; new.last_value := old.last_value; new.last_checked := old.last_checked; new.state_since := old.state_since; new.notified_state := old.notified_state;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;
drop trigger if exists trg_finance_thesis_guard on public.finance_thesis_conditions;
create trigger trg_finance_thesis_guard before insert or update on public.finance_thesis_conditions for each row execute function public.fn_finance_thesis_guard();

-- ---------- Sở hữu ----------
create table if not exists finance_shareholders (
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,12}$'),
  owner_key text not null,
  owner_name text not null,
  owner_type text,
  position text,
  quantity numeric,
  pct numeric,                                   -- PHẦN TRĂM (6.89 = 6,89%)
  public_date date,
  updated_at timestamptz not null default now(),
  primary key (symbol, owner_key)
);
create table if not exists finance_insider_trades (
  id text primary key,                           -- id của nguồn: chạy lại không nhân đôi
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,12}$'),
  trader text,
  position text,
  related text,
  action text not null check (action in ('B','S')),
  event_code text,
  status text,                                   -- done | registered | other
  shares_before numeric,
  shares_after numeric,
  registered numeric,
  acquired numeric,
  pct_after numeric,
  start_date date,
  end_date date,
  public_date date not null,
  url text,
  fetched_at timestamptz not null default now()
);
create index if not exists finance_insider_trades_symbol_idx on finance_insider_trades (symbol, public_date desc);
create table if not exists finance_ownership_sync (
  symbol text primary key,
  synced_at timestamptz not null default now(),
  ok boolean not null default true,
  holders integer,
  trades integer,
  note text
);
alter table finance_shareholders enable row level security;
alter table finance_insider_trades enable row level security;
alter table finance_ownership_sync enable row level security;
drop policy if exists "Finance team can view shareholders" on finance_shareholders;
create policy "Finance team can view shareholders" on finance_shareholders for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Finance team can view insider trades" on finance_insider_trades;
create policy "Finance team can view insider trades" on finance_insider_trades for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Finance team can view ownership sync" on finance_ownership_sync;
create policy "Finance team can view ownership sync" on finance_ownership_sync for select using (current_user_group() = any (array['finance','admin']));

-- ---------- Nhật ký dự phóng lợi nhuận ----------
create table if not exists finance_forecasts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,12}$'),
  metric text not null check (metric in ('lnst','revenue')),
  year integer not null check (year between 2015 and 2100),
  quarter integer check (quarter is null or quarter between 1 and 4),    -- null = cả năm
  value numeric not null,                        -- đồng
  note text check (note is null or length(note) <= 300),
  made_at date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists finance_forecasts_user_idx on finance_forecasts (user_id, made_at desc);
create index if not exists finance_forecasts_symbol_idx on finance_forecasts (symbol, year, quarter);
alter table finance_forecasts enable row level security;
drop policy if exists "Finance team can view forecasts" on finance_forecasts;
create policy "Finance team can view forecasts" on finance_forecasts for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own forecasts" on finance_forecasts;
create policy "Insert own forecasts" on finance_forecasts for insert with check (user_id = current_user_id() and current_user_group() = any (array['finance','admin']));
drop policy if exists "Delete forecasts" on finance_forecasts;
create policy "Delete forecasts" on finance_forecasts for delete using (current_user_group() = any (array['finance','admin']) and (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'));
-- không có chính sách UPDATE: dự phóng đã ghi không sửa được (muốn đổi thì ghi dự phóng mới; bản cũ vẫn được chấm)
create or replace function public.fn_finance_forecasts_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
begin
  if public.current_user_id() is null then return new; end if;
  new.made_at := current_date;                    -- ngày ghi do máy chủ đặt: không khai lùi ngày để "dự đoán" sau khi đã biết kết quả
  return new;
end;
$fn$;
drop trigger if exists trg_finance_forecasts_guard on public.finance_forecasts;
create trigger trg_finance_forecasts_guard before insert on public.finance_forecasts for each row execute function public.fn_finance_forecasts_guard();

do $do$
declare t text;
begin
  foreach t in array array['finance_thesis_conditions','finance_forecasts'] loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$s', t);
    execute format('create trigger trg_audit_%1$s after insert or update or delete on public.%1$s for each row execute function public.fn_audit_row_change()', t);
  end loop;
end;
$do$;

-- ---------- Lịch chạy (giờ UTC; Việt Nam = UTC+7) ----------
-- tin: mỗi 3 giờ (lưu tin vào kho theo thời điểm); sở hữu: 19:15 VN ngày làm việc; luận điểm: 19:35 VN sau khi đã có ảnh chụp thị trường (18:20) và sở hữu
select cron.unschedule('insight-news-3h') where exists (select 1 from cron.job where jobname = 'insight-news-3h');
select cron.schedule('insight-news-3h', '10 */3 * * *', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/insight-sync',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"news"}'::jsonb, timeout_milliseconds := 60000);
$job$);
select cron.unschedule('insight-ownership-daily') where exists (select 1 from cron.job where jobname = 'insight-ownership-daily');
select cron.schedule('insight-ownership-daily', '15 12 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/insight-sync',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"ownership"}'::jsonb, timeout_milliseconds := 150000);
$job$);
select cron.unschedule('insight-thesis-daily') where exists (select 1 from cron.job where jobname = 'insight-thesis-daily');
select cron.schedule('insight-thesis-daily', '35 12 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/insight-sync',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"thesis"}'::jsonb, timeout_milliseconds := 90000);
$job$);
