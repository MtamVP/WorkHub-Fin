-- Nhật ký ĐỐI SOÁT sổ lệnh với sao kê công ty chứng khoán (đã áp dụng trên Supabase qua MCP apply_migration "fin_reconciliations"). Chạy lại an toàn.
-- Mỗi lần đối soát ghi 1 dòng: loại (số dư mã / lệnh trong kỳ), ngày sao kê, số mục khớp / lệch, giá trị đang lệch, so khớp tiền mặt, tóm tắt các mã lệch.
-- Chỉ thêm, không sửa/xoá (có dấu vết để quản lý biết ai đã đối soát tới ngày nào). Quản lý xem ở Toàn Nhóm > Giới Hạn > "Đối soát".
create table if not exists finance_reconciliations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('positions','trades')),
  as_of date not null,
  source text,
  total int not null default 0,
  matched int not null default 0,
  mismatched int not null default 0,
  value_at_stake numeric not null default 0,
  cash_statement numeric,
  cash_app numeric,
  cash_ok boolean,
  summary jsonb,
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists finance_reconciliations_user_idx on finance_reconciliations (user_id, created_at desc);
alter table finance_reconciliations enable row level security;
drop policy if exists "Finance team can view reconciliations" on finance_reconciliations;
create policy "Finance team can view reconciliations" on finance_reconciliations for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own reconciliations" on finance_reconciliations;
create policy "Insert own reconciliations" on finance_reconciliations for insert
  with check (current_user_group() = any (array['finance','admin']) and (user_id = current_user_id() or current_user_has_fin_role('asset_manager')));

drop trigger if exists trg_audit_finance_reconciliations on public.finance_reconciliations;
create trigger trg_audit_finance_reconciliations after insert or update or delete on public.finance_reconciliations for each row execute function public.fn_audit_row_change();
