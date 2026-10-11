-- Hộp việc cần làm: email buổi sáng (insight-sync mode "digest").
-- finance_digest_state ghi lại những mục đã gửi cho từng người để lần sau chỉ gửi khi có mục MỚI mức nghiêm trọng / cao.
-- Người dùng chỉ ĐỌC được dòng của mình; ghi bằng service role (Edge Function).
create table if not exists finance_digest_state (
  user_id uuid primary key references users(id) on delete cascade,
  item_ids text[] not null default '{}',
  sent_at timestamptz not null default now()
);
alter table finance_digest_state enable row level security;
drop policy if exists "Own digest state" on finance_digest_state;
create policy "Own digest state" on finance_digest_state for select using (user_id = current_user_id());

-- 08:30 VN (01:30 UTC) các ngày làm việc: trước phiên sáng, sau khi tin đêm qua và ảnh chụp 19:30 hôm trước đã vào kho.
select cron.unschedule('insight-digest-daily') where exists (select 1 from cron.job where jobname = 'insight-digest-daily');
select cron.schedule('insight-digest-daily', '30 1 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/insight-sync',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"digest"}'::jsonb, timeout_milliseconds := 120000);
$job$);
