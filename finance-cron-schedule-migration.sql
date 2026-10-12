-- 12/10/2026: LỊCH CHẠY NỀN gửi bí mật cron (x-cron-secret) và được ghi lại trong git (repo là nguồn sự thật cho pg_cron).
-- Trước đây 24 lịch gọi Edge Function chỉ gửi "Authorization: Bearer <khoá publishable>" (khoá công khai trong api.js) và 4 lịch chỉ tồn tại trên máy chủ, không có trong repo.
-- Nay mỗi lịch gọi hàm gửi THÊM x-cron-secret đọc từ Vault (secret cron_secret, xem finance-cron-secret-migration.sql) -- bí mật không nằm trong git và không nằm trong lệnh cron, chỉ có câu truy vấn Vault.
-- Chạy lại an toàn: lịch đã có (theo tên) được cập nhật tại chỗ (giữ jobid và lịch sử chạy), lịch chưa có được tạo mới.
-- LƯU Ý: tệp này GHI ĐÈ lệnh của mọi lịch cùng tên trong các migration cũ (finance-*-migration.sql còn lệnh chỉ gửi khoá publishable): khi dựng lại máy chủ từ đầu, chạy tệp này SAU các migration đó.
-- THỨ TỰ BẬT: (1) chạy tệp này (hàm đang ở chế độ theo dõi nên mọi lời gọi vẫn qua), (2) chạy tay từng lịch một lần và kiểm finance_function_runs / cron.job_run_details,
-- (3) update public.cron_guard_state set enforce = true where id = 1; -- từ đây khoá publishable một mình bị 401. Tắt khẩn cấp: enforce = false.

do $$
declare
  v_base constant text := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/';
  v_key  constant text := 'sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR';      -- khoá publishable (công khai theo thiết kế; verify_jwt = true vẫn cần Authorization)
  j record;
  v_cmd text;
  v_id bigint;
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    raise exception 'Chưa có secret cron_secret: chạy finance-cron-secret-migration.sql trước';
  end if;

  for j in
    select * from (values
      -- (tên, lịch UTC, hàm, body JSON, timeout ms)
      ('approval-audit-daily',      '0 9 * * 1-5',        'approval-watch',      '{"mode":"audit"}',               120000),
      ('approval-notify',           '*/10 * * * *',       'approval-watch',      '{"mode":"notify"}',               60000),
      ('bt-fill-daily',             '30 12 * * 1-5',      'bt-data',             '{"mode":"fill","limit":10}',     140000),
      ('check-limits-daily',        '40 8 * * 1-5',       'check-limits',        '{}',                             120000),
      ('fetch-stock-prices-hourly', '*/5 2-7 * * 1-5',    'fetch-stock-prices',  '{}',                              55000),
      ('insight-digest-daily',      '30 1 * * 1-5',       'insight-sync',        '{"mode":"digest"}',              120000),
      ('insight-news-3h',           '10 */3 * * *',       'insight-sync',        '{"mode":"news"}',                 60000),
      ('insight-ownership-daily',   '15 12 * * 1-5',      'insight-sync',        '{"mode":"ownership"}',           150000),
      ('insight-thesis-daily',      '35 12 * * 1-5',      'insight-sync',        '{"mode":"thesis"}',               90000),
      ('market-health-daily',       '45 10 * * 1-5',      'market-data-sync',    '{"mode":"health"}',              150000),
      ('market-meta-weekly',        '0 20 * * 0',         'market-data-sync',    '{"mode":"meta"}',                120000),
      ('market-rates-daily',        '30 10 * * 1-5',      'market-data-sync',    '{"mode":"rates"}',                60000),
      ('market-ratios-daily',       '0 11 * * 1-5',       'market-data-sync',    '{"mode":"ratios"}',              150000),
      ('market-ratios-morning',     '5 1 * * 2-6',        'market-data-sync',    '{"mode":"ratios"}',              150000),
      ('market-snapshot-daily',     '20 11 * * 1-5',      'market-data-sync',    '{"mode":"snapshot"}',            150000),
      ('market-snapshot-morning',   '15 1 * * 2-6',       'market-data-sync',    '{"mode":"snapshot"}',            150000),
      ('refresh-financials-daily',  '15 0,11 * * *',      'refresh-financials',  '{}',                             120000),
      ('send-price-alerts-hourly',  '2-57/5 2-7 * * 1-5', 'send-price-alerts',   '{}',                              55000),
      ('sim-watch-daily',           '55 11 * * 1-5',      'sim-watch',           '{"news":true}',                  150000),
      ('sim-watch-morning',         '25 1 * * 2-6',       'sim-watch',           '{}',                             120000),
      ('source-daily',              '50 11 * * 1-5',      'source-watch',        '{"mode":"daily"}',                90000),
      ('source-probe',              '*/30 2-7 * * 1-5',   'source-watch',        '{"mode":"probe"}',                60000),
      ('valuation-watch-daily',     '40 11 * * 1-5',      'valuation-watch',     '{}',                              60000)
    ) as t(name, schedule, fn, body, timeout_ms)
  loop
    v_cmd := format(
      $cmd$select net.http_post(url := %L, headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), body := %L::jsonb, timeout_milliseconds := %s);$cmd$,
      v_base || j.fn, 'Bearer ' || v_key, j.body, j.timeout_ms);
    select jobid into v_id from cron.job where jobname = j.name;
    if v_id is null then perform cron.schedule(j.name, j.schedule, v_cmd);
    else perform cron.alter_job(v_id, schedule := j.schedule, command := v_cmd, active := true);
    end if;
  end loop;

  -- Các lịch thuần SQL (không gọi hàm): ghi lại để repo đủ bộ; lịch đã có thì cập nhật tại chỗ
  for j in
    select * from (values
      ('cleanup_system_logs',        '0 3 1 * *',   $q$delete from public.system_logs where created_at < now() - interval '180 days'$q$),
      ('daily-finance-nav-snapshot', '50 23 * * *', $q$select public.snapshot_all_finance_nav();$q$),
      ('pit-capture-daily',          '5 12 * * 1-5', $q$ select public.fn_pit_capture(); $q$)
    ) as t(name, schedule, cmd)
  loop
    select jobid into v_id from cron.job where jobname = j.name;
    if v_id is null then perform cron.schedule(j.name, j.schedule, j.cmd);
    else perform cron.alter_job(v_id, schedule := j.schedule, command := j.cmd, active := true);
    end if;
  end loop;
end $$;

-- Mẫu gọi thử một hàm như lịch cron (đọc kết quả ở lần chạy SAU trong net._http_response, vì net.http_post chỉ gửi sau khi giao dịch kết thúc):
--   select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/bt-data',
--     headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json',
--       'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), body := '{"mode":"status"}'::jsonb);
--   select id, status_code, left(content::text, 200) from net._http_response order by id desc limit 5;
