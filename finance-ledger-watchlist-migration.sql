-- Bàn Tài Sản: thuế bán + nhập sao kê + danh sách theo dõi + tỷ trọng mục tiêu (đã áp dụng trên Supabase 2026-10-02 qua MCP apply_migration
-- "fin_ledger_tax_watchlist_targets"). File này chỉ để lưu vết trong repo; chạy lại an toàn (IF NOT EXISTS / DROP IF EXISTS).

-- 1) Sổ lệnh: thuế bán + mã tham chiếu của công ty chứng khoán (chống nhập trùng) + nhãn lô nhập (để hoàn tác)
alter table finance_transactions
  add column if not exists tax numeric not null default 0 check (tax >= 0),
  add column if not exists external_ref text,
  add column if not exists import_batch text;
create unique index if not exists finance_transactions_user_external_ref_uq
  on finance_transactions (user_id, external_ref) where external_ref is not null and deleted_at is null;
create index if not exists finance_transactions_import_batch_idx
  on finance_transactions (user_id, import_batch) where import_batch is not null;

-- 2) Danh sách theo dõi (mã chưa mua)
create table if not exists finance_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  symbol text not null,
  buy_below numeric check (buy_below is null or buy_below > 0),
  target_price numeric check (target_price is null or target_price > 0),
  note text,
  added_price numeric,
  created_at timestamptz not null default now(),
  unique (user_id, symbol)
);
alter table finance_watchlist enable row level security;
drop policy if exists "Finance team can view watchlist" on finance_watchlist;
create policy "Finance team can view watchlist" on finance_watchlist for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own watchlist" on finance_watchlist;
create policy "Insert own watchlist" on finance_watchlist for insert
  with check ((user_id = current_user_id() or current_user_has_fin_role('asset_manager')) and current_user_group() = any (array['finance','admin']));
drop policy if exists "Update own watchlist" on finance_watchlist;
create policy "Update own watchlist" on finance_watchlist for update
  using (user_id = current_user_id() or current_user_has_fin_role('asset_manager'))
  with check ((user_id = current_user_id() or current_user_has_fin_role('asset_manager')) and current_user_group() = any (array['finance','admin']));
drop policy if exists "Delete own watchlist" on finance_watchlist;
create policy "Delete own watchlist" on finance_watchlist for delete
  using (user_id = current_user_id() or current_user_has_fin_role('asset_manager'));

-- 3) Tỷ trọng mục tiêu để cân bằng danh mục (symbol 'CASH' = tiền mặt)
create table if not exists finance_allocation_targets (
  user_id uuid not null references users(id) on delete cascade,
  symbol text not null,
  target_pct numeric not null check (target_pct >= 0 and target_pct <= 100),
  updated_at timestamptz not null default now(),
  primary key (user_id, symbol)
);
alter table finance_allocation_targets enable row level security;
drop policy if exists "Finance team can view allocation targets" on finance_allocation_targets;
create policy "Finance team can view allocation targets" on finance_allocation_targets for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own allocation targets" on finance_allocation_targets;
create policy "Insert own allocation targets" on finance_allocation_targets for insert
  with check ((user_id = current_user_id() or current_user_has_fin_role('asset_manager')) and current_user_group() = any (array['finance','admin']));
drop policy if exists "Update own allocation targets" on finance_allocation_targets;
create policy "Update own allocation targets" on finance_allocation_targets for update
  using (user_id = current_user_id() or current_user_has_fin_role('asset_manager'))
  with check ((user_id = current_user_id() or current_user_has_fin_role('asset_manager')) and current_user_group() = any (array['finance','admin']));
drop policy if exists "Delete own allocation targets" on finance_allocation_targets;
create policy "Delete own allocation targets" on finance_allocation_targets for delete
  using (user_id = current_user_id() or current_user_has_fin_role('asset_manager'));

-- 4) Cảnh báo giá thêm loại 'buy' (mã trong danh sách theo dõi chạm giá muốn mua)
alter table finance_alert_log drop constraint if exists finance_alert_log_kind_check;
alter table finance_alert_log add constraint finance_alert_log_kind_check check (kind = any (array['target','stop','buy']));
