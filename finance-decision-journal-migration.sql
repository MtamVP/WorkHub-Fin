-- Nhật ký quyết định đầu tư: lý do + kỳ vọng (giá mục tiêu, cắt lỗ, thời hạn) ghi NGAY LÚC ra quyết định để cuối tháng đối chiếu với kết quả.
-- Áp dụng trên Supabase 2026-10-02 qua MCP apply_migration "fin_decision_journal". File này chỉ để lưu vết trong repo; chạy lại an toàn.
-- Quyền giống danh sách theo dõi: nhóm finance / admin xem được; chỉ chủ nhật ký (hoặc quản lý tài sản) thêm/sửa/xoá.

create table if not exists finance_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  symbol text not null,
  action text not null check (action in ('buy', 'sell', 'hold', 'skip')),
  decided_at date not null default current_date,
  price_at_decision numeric check (price_at_decision is null or price_at_decision > 0),
  quantity numeric check (quantity is null or quantity > 0),
  reason text,
  expected_price numeric check (expected_price is null or expected_price > 0),
  stop_price numeric check (stop_price is null or stop_price > 0),
  horizon_months integer check (horizon_months is null or horizon_months between 1 and 120),
  confidence smallint check (confidence is null or confidence between 1 and 5),
  tags text[] not null default '{}',
  valuation jsonb,
  txn_id uuid references finance_transactions(id) on delete set null,
  review_date date,
  review_rating smallint check (review_rating is null or review_rating between 1 and 5),
  review_note text,
  lesson text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- Mỗi lệnh giao dịch có tối đa 1 quyết định đang hoạt động
create unique index if not exists finance_decisions_txn_uq on finance_decisions (txn_id) where txn_id is not null and deleted_at is null;
create index if not exists finance_decisions_user_date_idx on finance_decisions (user_id, decided_at desc) where deleted_at is null;

alter table finance_decisions enable row level security;
drop policy if exists "Finance team can view decisions" on finance_decisions;
create policy "Finance team can view decisions" on finance_decisions for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own decisions" on finance_decisions;
create policy "Insert own decisions" on finance_decisions for insert
  with check ((user_id = current_user_id() or current_user_has_fin_role('asset_manager')) and current_user_group() = any (array['finance','admin']));
drop policy if exists "Update own decisions" on finance_decisions;
create policy "Update own decisions" on finance_decisions for update
  using (user_id = current_user_id() or current_user_has_fin_role('asset_manager'))
  with check ((user_id = current_user_id() or current_user_has_fin_role('asset_manager')) and current_user_group() = any (array['finance','admin']));
drop policy if exists "Delete own decisions" on finance_decisions;
create policy "Delete own decisions" on finance_decisions for delete
  using (user_id = current_user_id() or current_user_has_fin_role('asset_manager'));
