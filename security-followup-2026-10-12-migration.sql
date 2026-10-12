-- 12/10/2026: ĐÃ ÁP DỤNG trên WorkHub-AI. Theo get_advisors(security) sau đợt thêm Insight / Kiểm thử / audit mở rộng:
--  - ba hàm trigger SECURITY DEFINER mới (fn_audit_row_change_slim, fn_finance_forecasts_guard, fn_finance_thesis_guard) còn gọi được qua /rest/v1/rpc bởi anon và authenticated:
--    bỏ quyền EXECUTE như đã làm với tám hàm trigger khác ở security-perf-hardening-migration.sql (trigger vẫn chạy bình thường: quyền chỉ kiểm lúc tạo trigger).
--  - fn_pit_r (chỉ dùng hàm dựng sẵn của PostgreSQL) cố định search_path rỗng.
-- Còn lại CỐ Ý: fn_cron_health / fn_data_freshness (authenticated gọi được, tự kiểm nhóm finance/admin trong thân hàm), các hàm current_user_* (chính sách RLS cần),
--   finance_alert_log bật RLS không có chính sách (bảng chỉ dành cho service role), pg_net nằm ở schema public (đã biết), Leaked password protection (người dùng tự bật ở Dashboard).
revoke execute on function public.fn_audit_row_change_slim() from public, anon, authenticated;
revoke execute on function public.fn_finance_forecasts_guard() from public, anon, authenticated;
revoke execute on function public.fn_finance_thesis_guard() from public, anon, authenticated;
alter function public.fn_pit_r(jsonb, text) set search_path = '';

-- Đăng nhập bằng biệt danh cần đổi biệt danh -> email TRƯỚC khi có phiên, nên chính sách "Anyone can view users" (select ... using (true)) đang cho BẤT KỲ AI cầm khoá
-- publishable công khai (nằm trong api.js) đọc được email, biệt danh và nhóm của MỌI người dùng (và bảng org_units). fn_resolve_login trả đúng một email cho một biệt danh/email,
-- không liệt kê được. Fin 0.1.20 đã dùng RPC này (api.js getRealEmail, có dự phòng đọc bảng). CHƯA siết chính sách users / org_units vì Sci và Org (và Fin bản cũ đã cài) vẫn đọc bảng users
-- trực tiếp khi đăng nhập bằng biệt danh: siết (đổi `to public` thành `to authenticated`) chỉ làm SAU khi cả ba app đã dùng RPC. ĐÃ ÁP DỤNG hàm; chính sách chưa đổi.
create or replace function public.fn_resolve_login(p_ident text)
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select u.email
  from public.users u
  where p_ident is not null and length(p_ident) between 1 and 200
    and (u.nickname = p_ident or lower(u.email) = lower(p_ident))
  order by (lower(u.email) = lower(p_ident)) desc
  limit 1;
$function$;
comment on function public.fn_resolve_login(text) is
  'Đăng nhập bằng biệt danh: đổi biệt danh/email người dùng nhập thành email thật TRƯỚC khi có phiên. Chỉ trả đúng một email, không liệt kê được bảng users. Cho phép anon gọi (cần cho màn đăng nhập).';
revoke all on function public.fn_resolve_login(text) from public;
grant execute on function public.fn_resolve_login(text) to anon, authenticated;
