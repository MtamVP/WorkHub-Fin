-- Migration "security_perf_hardening_2026_10_08" -- theo cảnh báo bảo mật/hiệu năng của Supabase (advisors), tổng kiểm tra 08/10/2026.
-- Đã áp dụng lên dự án Supabase dùng chung của cả 3 app bằng apply_migration. KHÔNG đổi hành vi của app.
--
-- 1) Hàm trigger SECURITY DEFINER đang gọi trực tiếp được qua /rest/v1/rpc/... bởi anon và authenticated. Chúng chỉ chạy khi có
--    INSERT/UPDATE (trigger); PostgreSQL không kiểm quyền EXECUTE lúc trigger chạy, nên thu hồi quyền gọi trực tiếp không ảnh hưởng gì.
--    KHÔNG đụng các hàm current_user_* / org_unit_*: chính sách RLS gọi chúng với quyền của người dùng nên phải giữ EXECUTE.
revoke execute on function public.fn_finance_approval_audit_guard() from public, anon, authenticated;
revoke execute on function public.fn_finance_approval_policy_guard() from public, anon, authenticated;
revoke execute on function public.fn_finance_data_health_guard() from public, anon, authenticated;
revoke execute on function public.fn_finance_ideas_guard() from public, anon, authenticated;
revoke execute on function public.fn_finance_order_requests_guard() from public, anon, authenticated;
revoke execute on function public.fn_finance_order_requests_idea_guard() from public, anon, authenticated;
revoke execute on function public.fn_finance_restricted_guard() from public, anon, authenticated;
revoke execute on function public.fn_finance_transactions_enforce() from public, anon, authenticated;

-- 2) RLS: auth.uid() / auth.jwt() trong chính sách bị tính lại cho TỪNG dòng. Bọc trong (select ...) để Postgres tính một lần mỗi truy vấn
--    (khuyến nghị chính thức của Supabase). Điều kiện giữ nguyên từng ký tự, chỉ thêm (select ...).
alter policy "audit_log_client_insert_own" on public.audit_log
  with check ((source = 'client'::text) and (actor_id = (select auth.uid())));

alter policy "calendar_connections_owner_all" on public.calendar_connections
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

alter policy "calendar_google_sync_owner_all" on public.calendar_google_sync
  using (exists (select 1 from public.events e where e.id = calendar_google_sync.event_id and e.created_by = ((select auth.jwt()) ->> 'email'::text)))
  with check (exists (select 1 from public.events e where e.id = calendar_google_sync.event_id and e.created_by = ((select auth.jwt()) ->> 'email'::text)));

alter policy "Delete events in group, personal only to owner" on public.events
  using (((group_key = current_user_group()) or (current_user_group() = 'admin'::text))
    and ((calendar_type is distinct from 'personal'::text) or (created_by = ((select auth.jwt()) ->> 'email'::text)))
    and current_user_role_at_least(group_key, 'editor'::text));

alter policy "Update events in group, personal only to owner" on public.events
  using (((group_key = current_user_group()) or (current_user_group() = 'admin'::text))
    and ((calendar_type is distinct from 'personal'::text) or (created_by = ((select auth.jwt()) ->> 'email'::text)))
    and current_user_role_at_least(group_key, 'editor'::text))
  with check (((group_key = current_user_group()) or (current_user_group() = 'admin'::text))
    and ((calendar_type is distinct from 'personal'::text) or (created_by = ((select auth.jwt()) ->> 'email'::text)))
    and current_user_role_at_least(group_key, 'editor'::text));

alter policy "personal_items_select_own" on public.personal_items using (user_id = (select auth.uid()));
alter policy "personal_items_insert_own" on public.personal_items with check (user_id = (select auth.uid()));
alter policy "personal_items_update_own" on public.personal_items using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
alter policy "personal_items_delete_own" on public.personal_items using (user_id = (select auth.uid()));

alter policy "personal_sync_files_owner_all" on public.personal_sync_files
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
