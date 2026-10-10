-- Nhật ký mô phỏng (Market Simulation đợt 3): mỗi lần người dùng bấm "Lưu lần chạy" ghi một ảnh chụp dự báo (lib/sim-score.js snapshot, ~30 KB) để khi các mốc
-- 1 tuần / 1 tháng / 3 tháng tới, trang tự chấm điểm với VN-Index thật (độ phủ, PIT, CRPS, Brier; có bối cảnh so với chỉ lịch sử) và hiện cây sống.
-- marks: sự kiện người dùng đánh dấu đã xảy ra / chưa ({ "<id thẻ>": true|false }). finance_decisions.sim_run_id nối quyết định trong nhật ký với lần mô phỏng làm căn cứ.
-- Quyền giống finance_decisions: nhóm finance / admin xem được; chỉ chủ (hoặc quản lý tài sản) thêm/sửa/xoá. Chạy lại an toàn.

create table if not exists finance_sim_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  as_of date not null,
  subject text not null check (subject in ('mine', 'group', 'index', 'custom', 'outlook')),
  label text check (label is null or char_length(label) <= 120),
  chosen_policy text,
  note text check (note is null or char_length(note) <= 1000),
  snapshot jsonb not null check (octet_length(snapshot::text) < 400000),
  marks jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists finance_sim_runs_user_idx on finance_sim_runs (user_id, created_at desc) where deleted_at is null;

alter table finance_sim_runs enable row level security;
drop policy if exists "Finance team can view sim runs" on finance_sim_runs;
create policy "Finance team can view sim runs" on finance_sim_runs for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own sim runs" on finance_sim_runs;
create policy "Insert own sim runs" on finance_sim_runs for insert
  with check ((user_id = current_user_id() or current_user_has_fin_role('asset_manager')) and current_user_group() = any (array['finance','admin']));
drop policy if exists "Update own sim runs" on finance_sim_runs;
create policy "Update own sim runs" on finance_sim_runs for update
  using (user_id = current_user_id() or current_user_has_fin_role('asset_manager'))
  with check ((user_id = current_user_id() or current_user_has_fin_role('asset_manager')) and current_user_group() = any (array['finance','admin']));
drop policy if exists "Delete own sim runs" on finance_sim_runs;
create policy "Delete own sim runs" on finance_sim_runs for delete
  using (user_id = current_user_id() or current_user_has_fin_role('asset_manager'));

alter table finance_decisions add column if not exists sim_run_id uuid references finance_sim_runs(id) on delete set null;
create index if not exists finance_decisions_sim_run_idx on finance_decisions (sim_run_id) where sim_run_id is not null and deleted_at is null;
