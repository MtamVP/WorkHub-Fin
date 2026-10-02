-- Dữ liệu quý của từng mã để tính EPS/P-E TTM (4 quý liền nhau gần nhất) trong Định Giá / Tổng Hợp Cổ Phiếu.
-- Áp dụng trên Supabase 2026-10-02 qua MCP apply_migration "fin_stock_quarters". File này chỉ để lưu vết trong repo; chạy lại an toàn.
-- Quyền giống finance_stock_valuations: nhóm finance / admin được xem + sửa (số liệu doanh nghiệp dùng chung cả nhóm).

create table if not exists finance_stock_quarters (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  year integer not null check (year between 2000 and 2100),
  quarter integer not null check (quarter between 1 and 4),
  lnst numeric not null,
  revenue numeric,
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (symbol, year, quarter)
);
alter table finance_stock_quarters enable row level security;

drop policy if exists "Finance team can view stock quarters" on finance_stock_quarters;
create policy "Finance team can view stock quarters" on finance_stock_quarters for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert stock quarters" on finance_stock_quarters;
create policy "Insert stock quarters" on finance_stock_quarters for insert
  with check (current_user_group() = any (array['finance','admin']));
drop policy if exists "Update stock quarters" on finance_stock_quarters;
create policy "Update stock quarters" on finance_stock_quarters for update
  using (current_user_group() = any (array['finance','admin']))
  with check (current_user_group() = any (array['finance','admin']));
drop policy if exists "Delete stock quarters" on finance_stock_quarters;
create policy "Delete stock quarters" on finance_stock_quarters for delete
  using (current_user_group() = any (array['finance','admin']));
