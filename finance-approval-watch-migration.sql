-- GIÁM SÁT DUYỆT LỆNH (đã áp dụng trên Supabase qua MCP apply_migration "fin_approval_watch"). Chạy lại an toàn.
-- 1) finance_order_requests.notified_at: Edge Function approval-watch "chiếm chỗ" đề xuất mới trước khi gửi email cho quản lý (mỗi đề xuất báo 1 lần).
-- 2) finance_approval_policy.active_since: thời điểm quy định được bật (trigger tự đặt) -- kiểm tra độc lập chỉ xét lệnh ghi SAU mốc này, không soi ngược lệnh cũ.
-- 3) finance_approval_audit: lệnh lớn đã ghi vào sổ mà KHÔNG có đề xuất đã duyệt gắn với nó (kiểm tra độc lập hằng ngày của approval-watch, vì việc ép duyệt khi ghi lệnh
--    nằm trong code app nên cần một lớp kiểm ở máy chủ). Chỉ service role ghi; quản lý đánh dấu "đã xem xét" kèm ghi chú (trigger ép).
-- 4) pg_cron: approval-notify (mỗi 10 phút) và approval-audit-daily (16:00 giờ VN các ngày làm việc, sau check-limits).

alter table finance_order_requests add column if not exists notified_at timestamptz;
alter table finance_approval_policy add column if not exists active_since timestamptz;

create or replace function public.fn_finance_approval_policy_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
begin
  -- mốc bật quy định: đặt khi chuyển sang bật, xoá khi tắt (không tin giá trị client gửi)
  if tg_op = 'INSERT' then
    new.active_since := case when new.active then now() else null end;
  else
    if new.active and not old.active then new.active_since := now();
    elsif not new.active then new.active_since := null;
    else new.active_since := old.active_since; end if;
  end if;
  if public.current_user_id() is null then return new; end if;            -- service role / migration
  if tg_op = 'INSERT' then
    if coalesce(array_length(new.self_approvers, 1), 0) > 0 and public.current_user_group() <> 'admin' then
      raise exception 'Chỉ admin được đặt danh sách người miễn nguyên tắc hai người.' using errcode = '42501';
    end if;
  elsif new.self_approvers is distinct from old.self_approvers and public.current_user_group() <> 'admin' then
    raise exception 'Chỉ admin được sửa danh sách người miễn nguyên tắc hai người.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_finance_approval_policy_guard on public.finance_approval_policy;
create trigger trg_finance_approval_policy_guard before insert or update on public.finance_approval_policy for each row execute function public.fn_finance_approval_policy_guard();

create table if not exists finance_approval_audit (
  id uuid primary key default gen_random_uuid(),
  txn_id uuid not null unique,
  user_id uuid not null references users(id) on delete cascade,
  symbol text not null,
  side text not null,
  trade_date date not null,
  quantity numeric not null,
  price numeric not null,
  value numeric not null,
  nav_ref numeric,
  pct numeric,
  reasons text[] not null default '{}',
  kind text not null default 'unapproved' check (kind in ('unapproved','reconcile')),
  status text not null default 'open' check (status in ('open','reviewed')),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  review_note text,
  detected_at timestamptz not null default now()
);
create index if not exists finance_approval_audit_status_idx on finance_approval_audit (status, detected_at desc);
alter table finance_approval_audit enable row level security;
drop policy if exists "Finance team can view approval audit" on finance_approval_audit;
create policy "Finance team can view approval audit" on finance_approval_audit for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Manager reviews approval audit" on finance_approval_audit;
create policy "Manager reviews approval audit" on finance_approval_audit for update
  using (current_user_group() = any (array['finance','admin']) and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
  with check (current_user_group() = any (array['finance','admin']));
-- không có policy INSERT/DELETE: chỉ service role (Edge Function) ghi, không ai xoá được

create or replace function public.fn_finance_approval_audit_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
declare me uuid; note text;
begin
  me := public.current_user_id();
  if me is null then return new; end if;
  if new.txn_id is distinct from old.txn_id or new.user_id is distinct from old.user_id or new.symbol is distinct from old.symbol or new.side is distinct from old.side
     or new.trade_date is distinct from old.trade_date or new.quantity is distinct from old.quantity or new.price is distinct from old.price or new.value is distinct from old.value
     or new.nav_ref is distinct from old.nav_ref or new.pct is distinct from old.pct or new.reasons is distinct from old.reasons or new.kind is distinct from old.kind
     or new.detected_at is distinct from old.detected_at then
    raise exception 'Không được sửa nội dung bản ghi kiểm tra.' using errcode = '42501';
  end if;
  if new.status is not distinct from old.status then
    if new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at or new.review_note is distinct from old.review_note then
      raise exception 'Không được sửa ghi chú xem xét đã lưu.' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.status = 'open' and new.status = 'reviewed' then
    note := btrim(coalesce(new.review_note, ''));
    if char_length(note) < 3 then raise exception 'Đánh dấu đã xem xét cần ghi chú (ít nhất 3 ký tự).' using errcode = '42501'; end if;
    new.reviewed_by := me;
    new.reviewed_at := now();
    return new;
  end if;
  raise exception 'Không thể chuyển trạng thái từ "%" sang "%".', old.status, new.status using errcode = '42501';
end;
$fn$;
drop trigger if exists trg_finance_approval_audit_guard on public.finance_approval_audit;
create trigger trg_finance_approval_audit_guard before update on public.finance_approval_audit for each row execute function public.fn_finance_approval_audit_guard();
drop trigger if exists trg_audit_finance_approval_audit on public.finance_approval_audit;
create trigger trg_audit_finance_approval_audit after insert or update or delete on public.finance_approval_audit for each row execute function public.fn_audit_row_change();

select cron.unschedule('approval-notify') where exists (select 1 from cron.job where jobname = 'approval-notify');
select cron.schedule('approval-notify', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/approval-watch',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"notify"}'::jsonb,
    timeout_milliseconds := 60000
  );
$job$);
select cron.unschedule('approval-audit-daily') where exists (select 1 from cron.job where jobname = 'approval-audit-daily');
select cron.schedule('approval-audit-daily', '0 9 * * 1-5', $job$
  select net.http_post(
    url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/approval-watch',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"audit"}'::jsonb,
    timeout_milliseconds := 120000
  );
$job$);
