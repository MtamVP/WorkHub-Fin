-- DANH SÁCH HẠN CHẾ MÃ (đã áp dụng trên Supabase qua MCP apply_migration "fin_restricted_symbols"). Chạy lại an toàn.
-- Quản lý / admin đưa một mã vào danh sách hạn chế (đang nắm thông tin chưa công bố, xung đột lợi ích, đang trong giai đoạn nghiên cứu riêng...), áp dụng cho MỌI thành viên
-- (user_id null) hoặc một người. Khác "cấm mã" của giới hạn đầu tư: cấm cả MUA lẫn BÁN, kể cả quản lý; không có ghi đè -- muốn giao dịch phải gỡ hạn chế (để lại dấu vết).
-- Trigger fn_finance_transactions_enforce (finance-approval-enforce-migration.sql) chặn ghi lệnh vào mã đang hạn chế; lệnh nhập từ sao kê / đối soát (việc đã xảy ra) không chặn nhưng
-- ghi ngay một dòng finance_approval_audit kind 'restricted' để quản lý xem xét. Không có DELETE: chỉ tắt (active = false), danh sách là dấu vết.

create table if not exists finance_restricted_symbols (
  id uuid primary key default gen_random_uuid(),
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,12}$'),
  user_id uuid references users(id) on delete cascade,                  -- null = áp dụng cho mọi thành viên
  reason text not null check (char_length(btrim(reason)) >= 5),
  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists finance_restricted_symbols_uniq on finance_restricted_symbols (symbol, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists finance_restricted_symbols_active_idx on finance_restricted_symbols (active, symbol);
alter table finance_restricted_symbols enable row level security;
drop policy if exists "Finance team can view restricted symbols" on finance_restricted_symbols;
create policy "Finance team can view restricted symbols" on finance_restricted_symbols for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Manager adds restricted symbols" on finance_restricted_symbols;
create policy "Manager adds restricted symbols" on finance_restricted_symbols for insert
  with check (current_user_group() = any (array['finance','admin']) and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'));
drop policy if exists "Manager updates restricted symbols" on finance_restricted_symbols;
create policy "Manager updates restricted symbols" on finance_restricted_symbols for update
  using (current_user_group() = any (array['finance','admin']) and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
  with check (current_user_group() = any (array['finance','admin']));
drop trigger if exists trg_audit_finance_restricted_symbols on public.finance_restricted_symbols;
create trigger trg_audit_finance_restricted_symbols after insert or update or delete on public.finance_restricted_symbols for each row execute function public.fn_audit_row_change();

-- Chỉ đổi trạng thái / lý do: mã và phạm vi không sửa được sau khi tạo (tạo mới nếu cần)
create or replace function public.fn_finance_restricted_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
begin
  if tg_op = 'INSERT' then
    new.symbol := upper(btrim(new.symbol));
    if public.current_user_id() is not null then new.created_by := public.current_user_id(); end if;
    return new;
  end if;
  if new.symbol is distinct from old.symbol or new.user_id is distinct from old.user_id or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by then
    raise exception 'Không sửa mã hoặc phạm vi của hạn chế; hãy tắt và tạo hạn chế mới.' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;
drop trigger if exists trg_finance_restricted_guard on public.finance_restricted_symbols;
create trigger trg_finance_restricted_guard before insert or update on public.finance_restricted_symbols for each row execute function public.fn_finance_restricted_guard();
