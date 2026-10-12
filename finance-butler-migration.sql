-- Quản gia (AI trợ lý trong app, Edge Function butler): hạn mức dùng AI theo ngày và nhật ký sử dụng. Áp dụng MỘT lần lên dự án Supabase dùng chung; chạy lại an toàn.
-- Quyền riêng tư: nhật ký KHÔNG lưu nội dung câu hỏi hay câu trả lời, chỉ ý định, công cụ đã chạy, mô hình, thời gian và mức độ hữu ích người dùng bấm. Mỗi người chỉ đọc được dòng của chính mình (current_user_id()).
-- Hạn mức: hàm fn_butler_take() tăng bộ đếm trong MỘT câu lệnh có điều kiện (không đua nhau vượt trần), tính theo ngày giờ Việt Nam.

create table if not exists public.butler_usage (
  user_id uuid not null references public.users(id) on delete cascade,
  day date not null,
  calls integer not null default 0 check (calls >= 0),
  primary key (user_id, day)
);
alter table public.butler_usage enable row level security;
drop policy if exists "Own butler usage" on public.butler_usage;
create policy "Own butler usage" on public.butler_usage for select using (user_id = current_user_id());

create table if not exists public.butler_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  at timestamptz not null default now(),
  intent text,
  mode text,
  tools text[] not null default '{}',
  model text,
  fallback text,
  ok boolean not null default true,
  ms integer,
  rating smallint check (rating in (-1, 1))
);
create index if not exists butler_log_user_at_idx on public.butler_log (user_id, at desc);
alter table public.butler_log enable row level security;
drop policy if exists "Own butler log select" on public.butler_log;
drop policy if exists "Own butler log insert" on public.butler_log;
drop policy if exists "Own butler log update" on public.butler_log;
drop policy if exists "Own butler log delete" on public.butler_log;
create policy "Own butler log select" on public.butler_log for select using (user_id = current_user_id());
create policy "Own butler log insert" on public.butler_log for insert with check (user_id = current_user_id());
create policy "Own butler log update" on public.butler_log for update using (user_id = current_user_id()) with check (user_id = current_user_id());
create policy "Own butler log delete" on public.butler_log for delete using (user_id = current_user_id());

-- Tăng bộ đếm lượt AI của người gọi nếu còn dưới trần; trả {ok, used, cap} hoặc {ok:false, reason: auth|cap}
create or replace function public.fn_butler_take(p_cost integer default 1, p_cap integer default 30)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := public.current_user_id();
  v_day date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_cost integer := greatest(coalesce(p_cost, 1), 1);
  v_cap integer := least(greatest(coalesce(p_cap, 30), 1), 200);
  v_used integer;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  insert into public.butler_usage (user_id, day, calls) values (v_uid, v_day, 0) on conflict do nothing;
  update public.butler_usage set calls = calls + v_cost
    where user_id = v_uid and day = v_day and calls + v_cost <= v_cap
    returning calls into v_used;
  if v_used is null then
    select calls into v_used from public.butler_usage where user_id = v_uid and day = v_day;
    return jsonb_build_object('ok', false, 'reason', 'cap', 'used', coalesce(v_used, 0), 'cap', v_cap);
  end if;
  return jsonb_build_object('ok', true, 'used', v_used, 'cap', v_cap);
end;
$function$;
revoke all on function public.fn_butler_take(integer, integer) from public, anon;
grant execute on function public.fn_butler_take(integer, integer) to authenticated;

comment on table public.butler_usage is 'Số lượt gọi AI của Quản gia theo người và ngày (giờ VN). Chỉ ghi qua fn_butler_take().';
comment on table public.butler_log is 'Nhật ký Quản gia: ý định, công cụ, mô hình, thời gian, đánh giá. KHÔNG chứa nội dung câu hỏi / câu trả lời.';
