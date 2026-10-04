-- Giới hạn đầu tư của nhóm + ghi nhận ngoại lệ có lý do (đã áp dụng trên Supabase qua MCP apply_migration "fin_investment_limits").
-- Chạy lại an toàn (IF NOT EXISTS / DROP IF EXISTS).
--  scope 'member'       : áp dụng cho MỌI thành viên nhóm Finance (do quản lý danh mục / admin đặt)
--  scope 'consolidated' : áp dụng cho danh mục GỘP của cả nhóm (chỉ để theo dõi, không chặn lệnh)
--  scope 'user'         : giới hạn cá nhân tự đặt (kỷ luật riêng; chỉ được chặt hơn, app lấy mức chặt nhất)
--  kind: max_symbol_pct (1 mã tối đa % NAV; symbol = mã cụ thể thì chỉ mã đó), max_sector_pct (1 ngành tối đa % NAV; sector = ngành cụ thể),
--        min_cash_pct (tiền mặt tối thiểu % NAV), max_leverage (giá trị cổ phiếu / NAV tối đa), max_position_vnd (1 vị thế tối đa VND), blocked_symbol (cấm mã)
--  mode: warn (chỉ cảnh báo) | reason (vượt thì phải ghi lý do) | block (chặn; chỉ quản lý được ghi đè kèm lý do)

create table if not exists finance_limits (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('member','consolidated','user')),
  user_id uuid references users(id) on delete cascade,
  kind text not null check (kind in ('max_symbol_pct','max_sector_pct','min_cash_pct','max_leverage','max_position_vnd','blocked_symbol')),
  symbol text,
  sector text,
  value numeric check (value is null or value >= 0),
  mode text not null default 'reason' check (mode in ('warn','reason','block')),
  note text,
  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'user') = (user_id is not null)),
  check (kind = 'blocked_symbol' or value is not null)
);
create index if not exists finance_limits_scope_idx on finance_limits (scope, active);
alter table finance_limits enable row level security;

drop policy if exists "Finance team can view limits" on finance_limits;
create policy "Finance team can view limits" on finance_limits for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Manage limits" on finance_limits;
create policy "Manage limits" on finance_limits for insert
  with check (current_user_group() = any (array['finance','admin']) and (
    (scope in ('member','consolidated') and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
    or (scope = 'user' and (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))));
drop policy if exists "Update limits" on finance_limits;
create policy "Update limits" on finance_limits for update
  using (current_user_group() = any (array['finance','admin']) and (
    (scope in ('member','consolidated') and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
    or (scope = 'user' and (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))))
  with check (current_user_group() = any (array['finance','admin']) and (
    (scope in ('member','consolidated') and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
    or (scope = 'user' and (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))));
drop policy if exists "Delete limits" on finance_limits;
create policy "Delete limits" on finance_limits for delete
  using (current_user_group() = any (array['finance','admin']) and (
    (scope in ('member','consolidated') and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
    or (scope = 'user' and (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))));

-- Ngoại lệ: lý do bắt buộc khi một lệnh vượt giới hạn. Chỉ thêm, không sửa/xoá (có dấu vết cho quản lý xem lại).
create table if not exists finance_limit_exceptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  limit_id uuid references finance_limits(id) on delete set null,
  kind text not null,
  symbol text,
  txn_id uuid,
  trade_date date,
  mode text,
  reason text not null check (length(btrim(reason)) >= 3),
  metrics jsonb,                         -- { before, after, threshold, subject }
  override boolean not null default false,  -- true = quản lý ghi đè lệnh bị CHẶN
  created_at timestamptz not null default now()
);
create index if not exists finance_limit_exceptions_user_idx on finance_limit_exceptions (user_id, created_at desc);
alter table finance_limit_exceptions enable row level security;
drop policy if exists "Finance team can view limit exceptions" on finance_limit_exceptions;
create policy "Finance team can view limit exceptions" on finance_limit_exceptions for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert limit exceptions" on finance_limit_exceptions;
create policy "Insert limit exceptions" on finance_limit_exceptions for insert
  with check (current_user_group() = any (array['finance','admin']) and (user_id = current_user_id() or current_user_has_fin_role('asset_manager')));

-- Dấu vết kiểm toán (audit_log) cho cả hai bảng
do $do$
declare t text;
begin
  foreach t in array array['finance_limits','finance_limit_exceptions'] loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$s', t);
    execute format('create trigger trg_audit_%1$s after insert or update or delete on public.%1$s for each row execute function public.fn_audit_row_change()', t);
  end loop;
end;
$do$;
