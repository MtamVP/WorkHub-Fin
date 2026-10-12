-- 12/10/2026: BÍ MẬT CHO LỊCH CHẠY NỀN. Trước đây pg_cron gọi 11 Edge Function dùng service role bằng "Authorization: Bearer <khoá publishable>" và verify_jwt = true,
-- nhưng khoá publishable nằm công khai trong api.js nên AI CŨNG gọi được các hàm này (ghi đè kho giá, đốt hạn mức AI, gửi email...). Nay:
--  1. Một bí mật ngẫu nhiên lưu trong Supabase Vault (tên cron_secret). pg_cron đọc từ Vault và gửi ở tiêu đề x-cron-secret; KHÔNG nằm trong git, không nằm trong lệnh cron (lệnh chỉ chứa câu truy vấn Vault).
--  2. fn_cron_gate(p_secret): Edge Function (service role) gọi để kiểm bí mật: trả 'ok' | 'monitor' | 'deny'. 'monitor' = bí mật sai/thiếu nhưng cron_guard_state.enforce = false (giai đoạn chuyển tiếp: vẫn cho qua, chỉ ghi cảnh báo);
--     'deny' = đã bật enforce. Bật bằng: update public.cron_guard_state set enforce = true where id = 1;  (tắt khẩn cấp: = false). Không cần triển khai lại hàm.
--  3. Hàm chỉ chấp nhận: bí mật cron hợp lệ, HOẶC (ở hàm có người dùng gọi từ app) JWT đăng nhập thật. Khoá publishable một mình không còn đủ.
-- Xoay bí mật: select vault.update_secret(id, encode(extensions.gen_random_bytes(32), 'hex')) cho secret tên cron_secret (cron đọc lại từ Vault ở mỗi lần chạy nên không cần đổi lịch).
-- Chạy lại an toàn. Lịch cron gửi bí mật: finance-cron-schedule-migration.sql.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret', 'x-cron-secret: pg_cron -> Edge Functions (xem finance-cron-secret-migration.sql)');
  end if;
end $$;

create table if not exists public.cron_guard_state (
  id integer primary key default 1 check (id = 1),
  enforce boolean not null default false,
  changed_at timestamptz not null default now()
);
insert into public.cron_guard_state (id, enforce) values (1, false) on conflict (id) do nothing;
alter table public.cron_guard_state enable row level security;       -- không có chính sách: chỉ service role / owner đọc ghi
revoke all on public.cron_guard_state from anon, authenticated;

create or replace function public.fn_cron_gate(p_secret text)
returns text
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_ok boolean := false;
  v_enf boolean;
begin
  if p_secret is not null and length(p_secret) between 16 and 256 then
    select exists (select 1 from vault.decrypted_secrets s where s.name = 'cron_secret' and s.decrypted_secret = p_secret) into v_ok;
  end if;
  if v_ok then return 'ok'; end if;
  select enforce into v_enf from public.cron_guard_state where id = 1;
  return case when coalesce(v_enf, false) then 'deny' else 'monitor' end;
end;
$function$;

revoke all on function public.fn_cron_gate(text) from public, anon, authenticated;
grant execute on function public.fn_cron_gate(text) to service_role;
