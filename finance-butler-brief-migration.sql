-- Quản gia giai đoạn C: BẢN TIN SÁNG qua email (Edge Function butler-brief, lịch 07:45 giờ VN các ngày làm việc) + tuỳ chọn của từng người. Áp dụng MỘT lần lên dự án Supabase dùng chung; chạy lại an toàn.
-- Mặc định TẮT cho mọi người: chỉ người tự bật mới nhận email. Bản tin chỉ có việc được giao cho CHÍNH người đó, lịch họ được phép xem và mốc dự án họ được phép xem (hàm lọc từng điều kiện RLS bằng mã, xem supabase/functions/butler/tools.ts).
-- Quyền: bảng KHÔNG có chính sách nào cho người dùng đăng nhập (không đọc / ghi trực tiếp được); người dùng chỉ đọc / đổi tuỳ chọn của chính mình qua hai hàm fn_butler_brief_get() / fn_butler_brief_set(). Chỉ service role (hàm butler-brief) ghi brief_sent_on / test_sent_at.

create table if not exists public.butler_prefs (
  user_id uuid primary key references public.users(id) on delete cascade,
  brief_email boolean not null default false,
  brief_sent_on date,
  test_sent_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.butler_prefs enable row level security;
revoke all on public.butler_prefs from anon, authenticated;

-- Tuỳ chọn hiện tại của người gọi: { ok, brief_email, sent_on }
create or replace function public.fn_butler_brief_get()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := public.current_user_id();
  v_on boolean; v_sent date;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  select brief_email, brief_sent_on into v_on, v_sent from public.butler_prefs where user_id = v_uid;
  return jsonb_build_object('ok', true, 'brief_email', coalesce(v_on, false), 'sent_on', v_sent);
end;
$function$;

-- Bật / tắt bản tin sáng của người gọi
create or replace function public.fn_butler_brief_set(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := public.current_user_id();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  insert into public.butler_prefs (user_id, brief_email) values (v_uid, coalesce(p_on, false))
    on conflict (user_id) do update set brief_email = excluded.brief_email, updated_at = now();
  return jsonb_build_object('ok', true, 'brief_email', coalesce(p_on, false));
end;
$function$;

revoke all on function public.fn_butler_brief_get() from public, anon;
revoke all on function public.fn_butler_brief_set(boolean) from public, anon;
grant execute on function public.fn_butler_brief_get() to authenticated;
grant execute on function public.fn_butler_brief_set(boolean) to authenticated;

comment on table public.butler_prefs is 'Tuỳ chọn Quản gia theo người: bật bản tin sáng qua email (mặc định tắt). Người dùng chỉ đổi qua fn_butler_brief_set(); butler-brief (service role) ghi brief_sent_on.';

-- Lịch: 07:45 giờ VN (00:45 UTC) thứ hai tới thứ sáu, gọi hàm butler-brief kèm bí mật cron (cùng cách với mọi lịch khác, xem finance-cron-schedule-migration.sql).
do $$
declare
  v_base constant text := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/';
  v_key  constant text := 'sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR';
  v_cmd text;
  v_id bigint;
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    raise exception 'Chưa có secret cron_secret: chạy finance-cron-secret-migration.sql trước';
  end if;
  v_cmd := format(
    $cmd$select net.http_post(url := %L, headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), body := %L::jsonb, timeout_milliseconds := %s);$cmd$,
    v_base || 'butler-brief', 'Bearer ' || v_key, '{"mode":"run"}', 120000);
  select jobid into v_id from cron.job where jobname = 'butler-brief-morning';
  if v_id is null then perform cron.schedule('butler-brief-morning', '45 0 * * 1-5', v_cmd);
  else perform cron.alter_job(v_id, schedule := '45 0 * * 1-5', command := v_cmd, active := true);
  end if;
end $$;
