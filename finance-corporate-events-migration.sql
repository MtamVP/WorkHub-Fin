-- Sự kiện doanh nghiệp tự gợi ý: lưu các sự kiện người dùng chọn "Bỏ qua" để không gợi ý lại.
-- (Áp dụng trên Supabase qua MCP apply_migration "fin_corporate_event_dismissals".) Chạy lại an toàn.
create table if not exists finance_event_dismissals (
  user_id uuid not null references users(id) on delete cascade,
  event_id text not null,
  symbol text not null,
  kind text,
  note text,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);
alter table finance_event_dismissals enable row level security;
drop policy if exists "Finance team can view event dismissals" on finance_event_dismissals;
create policy "Finance team can view event dismissals" on finance_event_dismissals for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own event dismissals" on finance_event_dismissals;
create policy "Insert own event dismissals" on finance_event_dismissals for insert
  with check ((user_id = current_user_id() or current_user_has_fin_role('asset_manager')) and current_user_group() = any (array['finance','admin']));
drop policy if exists "Delete own event dismissals" on finance_event_dismissals;
create policy "Delete own event dismissals" on finance_event_dismissals for delete
  using (user_id = current_user_id() or current_user_has_fin_role('asset_manager'));
