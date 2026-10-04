-- Danh mục CHUẨN CHIẾN LƯỢC của nhóm: tỷ trọng mục tiêu theo ngành (phần còn lại là tiền mặt), dùng làm chuẩn cho phân tích Brinson
-- (đã áp dụng trên Supabase qua MCP apply_migration "fin_policy_weights"). Chạy lại an toàn.
-- Mọi thành viên finance/admin đọc được; chỉ quản lý danh mục / admin thêm, sửa, xoá. Tổng tỷ trọng <= 100% do api.js kiểm tra (BrinsonCalc.validatePolicy).
create table if not exists finance_policy_weights (
  sector text primary key,
  target_pct numeric not null check (target_pct >= 0 and target_pct <= 100),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
alter table finance_policy_weights enable row level security;
drop policy if exists "Finance team can view policy weights" on finance_policy_weights;
create policy "Finance team can view policy weights" on finance_policy_weights for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Manager manages policy weights" on finance_policy_weights;
create policy "Manager manages policy weights" on finance_policy_weights for all
  using (current_user_group() = any (array['finance','admin']) and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
  with check (current_user_group() = any (array['finance','admin']) and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'));
drop trigger if exists trg_audit_finance_policy_weights on public.finance_policy_weights;
create trigger trg_audit_finance_policy_weights after insert or update or delete on public.finance_policy_weights for each row execute function public.fn_audit_row_change();
