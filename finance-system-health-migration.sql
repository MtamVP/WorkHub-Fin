-- 12/10/2026: hai hàm đọc cho "Kiểm tra hệ thống" (self-check.js) -- sức khoẻ lịch chạy nền và độ tươi dữ liệu phía máy chủ. Chạy lại an toàn.
-- Chỉ nhóm finance / admin gọi được (kiểm trong thân hàm bằng current_user_group()); người khác nhận rỗng. SECURITY DEFINER vì cần đọc schema cron.
-- fn_cron_health(): mỗi job pg_cron một dòng: lịch, lần chạy gần nhất, trạng thái, số lần chạy / lỗi trong 48 giờ. LƯU Ý: trạng thái này là việc pg_cron có PHÁT lệnh gọi hay không;
--   kết quả của Edge Function (HTTP) nằm ở finance_function_runs (hàm nào có ghi) và ở độ tươi dữ liệu bên dưới.
-- fn_data_freshness(): mốc mới nhất của các bảng dữ liệu nền, trả jsonb để thêm mục mới không phải đổi kiểu trả về.

create or replace function public.fn_cron_health()
returns table(jobname text, schedule text, active boolean, last_start timestamptz, last_status text, last_message text, runs_48h integer, fails_48h integer)
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if coalesce(public.current_user_group(), '') not in ('admin', 'finance') then
    return;
  end if;
  return query
  select j.jobname::text, j.schedule::text, j.active,
    (select max(d.start_time) from cron.job_run_details d where d.jobid = j.jobid),
    (select d.status::text from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1),
    (select left(d.return_message, 200) from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1),
    (select count(*)::int from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '48 hours'),
    (select count(*)::int from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '48 hours' and d.status = 'failed')
  from cron.job j
  order by j.jobname;
end;
$function$;

create or replace function public.fn_data_freshness()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if coalesce(public.current_user_group(), '') not in ('admin', 'finance') then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'price_days', (select max(day)::text from public.finance_price_days),
    'price_days_count', (select count(*) from public.finance_price_days),
    'pit_market', (select max(as_of)::text from public.finance_pit_market_daily where source = 'live'),
    'pit_news', (select max(first_seen) from public.finance_pit_news),
    'ownership', (select max(synced_at) from public.finance_ownership_sync where ok),
    'sim_watch', (select max(watched_at) from public.finance_sim_runs where deleted_at is null),
    'sim_runs_open', (select count(*) from public.finance_sim_runs where deleted_at is null),
    'financials', (select max(fetched_at) from public.finance_financials_cache),
    'market_snapshot', (select max(updated_at) from public.finance_market_snapshot),
    'nav_history', (select max(snapshot_date)::text from public.finance_nav_history),
    'compliance', (select max(log_date)::text from public.finance_compliance_log),
    'news_events', (select max(created_at) from public.finance_news_events),
    'data_health_open_errors', (select count(*) from public.finance_data_health where not resolved and severity = 'error')
  );
end;
$function$;

revoke all on function public.fn_cron_health() from public, anon;
revoke all on function public.fn_data_freshness() from public, anon;
grant execute on function public.fn_cron_health() to authenticated;
grant execute on function public.fn_data_freshness() to authenticated;
