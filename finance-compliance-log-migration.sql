-- Nhật ký tuân thủ giới hạn đầu tư theo ngày (ghi bởi Edge Function check-limits qua service role; người dùng chỉ ĐỌC).
-- Mỗi ngày mỗi thành viên 1 dòng (user_id rỗng = danh mục gộp cả nhóm): NAV, số giới hạn áp dụng, danh sách đang vượt / gần chạm.
-- Dùng cho Toàn Nhóm > Giới Hạn > "Lịch sử tuân thủ" (vi phạm kéo dài bao nhiêu ngày) -- chạy cả khi không ai mở app. Chạy lại an toàn.
create table if not exists finance_compliance_log (
  id uuid primary key default gen_random_uuid(),
  log_date date not null,
  user_id uuid references users(id) on delete cascade,
  nav numeric not null default 0,
  limit_count int not null default 0,
  breaches jsonb not null default '[]'::jsonb,   -- [{ kind, subject, current, threshold, mode, scope, symbols? }]
  warns jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists finance_compliance_log_day_user on finance_compliance_log (log_date, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists finance_compliance_log_user_idx on finance_compliance_log (user_id, log_date desc);
alter table finance_compliance_log enable row level security;
drop policy if exists "Finance team can view compliance log" on finance_compliance_log;
create policy "Finance team can view compliance log" on finance_compliance_log for select
  using (current_user_group() = any (array['finance','admin']));
-- Không có chính sách insert/update/delete: chỉ service role (Edge Function) ghi được.

-- Chạy mỗi ngày giao dịch lúc 15:40 giờ Việt Nam (08:40 UTC), sau khi bộ lấy giá đóng cửa. Bearer = publishable key như các job khác; phản hồi chỉ có số lượng.
select cron.unschedule('check-limits-daily') where exists (select 1 from cron.job where jobname = 'check-limits-daily');
select cron.schedule('check-limits-daily', '40 8 * * 1-5', $job$
  select net.http_post(
    url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/check-limits',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$job$);
