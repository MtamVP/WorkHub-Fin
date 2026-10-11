-- KHO DỮ LIỆU THEO THỜI ĐIỂM (point-in-time, 11/10/2026). Chạy lại an toàn. Chỉ service role / hàm bảo mật ghi; nhóm finance / admin đọc.
-- Mục đích: lưu lại số liệu NHƯ ĐÃ THẤY vào từng ngày để sau này backtest chiến lược không bị "nhìn trước tương lai" (số liệu quá khứ bị doanh nghiệp / nguồn sửa lại).
--  finance_pit_market_daily  : mỗi ngày dữ liệu một dòng; toàn thị trường dạng gọn { "FPT": [giá trị theo thứ tự cột cols] }. Bất kỳ bộ lọc nào cũng chạy lại được "như ngày đó" từ bảng này.
--  finance_pit_fundamentals  : mỗi lần số liệu báo cáo tài chính của một mã ĐỔI (dấu vân tay mới) thêm một dòng, kèm ngày LẦN ĐẦU thấy (seen_at) = lúc báo cáo thật sự công bố với hệ thống.
--  finance_pit_news          : tin các báo đã đọc được, kèm lúc thấy lần đầu và mã được nhắc trong tiêu đề (nền cho trích sự kiện theo mã).
-- Dung lượng ước tính: ~70 KB/ngày cho bảng thị trường (đã nén), vài MB/năm cho hai bảng còn lại.

create table if not exists finance_pit_market_daily (
  as_of date primary key,                       -- NGÀY CỦA SỐ LIỆU (daily_date của ảnh chụp thị trường), không phải ngày chạy
  n integer not null,
  cols text[] not null,
  data jsonb not null,
  captured_at timestamptz not null default now()
);
create table if not exists finance_pit_fundamentals (
  symbol text not null,
  fingerprint text not null,
  quarter_key text,
  annual_year integer,
  form text,
  seen_at date not null,
  data jsonb not null,                          -- { annual: [3 năm gần nhất], quarters: [8 quý gần nhất], dividends: {...} }, mới nhất trước
  primary key (symbol, fingerprint)
);
create index if not exists finance_pit_fundamentals_symbol_idx on finance_pit_fundamentals (symbol, seen_at);
create table if not exists finance_pit_news (
  id text primary key,
  published_at timestamptz,
  first_seen timestamptz not null default now(),
  source text,
  title text not null,
  link text,
  summary text,
  symbols text[] not null default '{}'
);
create index if not exists finance_pit_news_time_idx on finance_pit_news (published_at desc);
create index if not exists finance_pit_news_symbols_idx on finance_pit_news using gin (symbols);

alter table finance_pit_market_daily enable row level security;
alter table finance_pit_fundamentals enable row level security;
alter table finance_pit_news enable row level security;
drop policy if exists "Finance team can view pit market" on finance_pit_market_daily;
create policy "Finance team can view pit market" on finance_pit_market_daily for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Finance team can view pit fundamentals" on finance_pit_fundamentals;
create policy "Finance team can view pit fundamentals" on finance_pit_fundamentals for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Finance team can view pit news" on finance_pit_news;
create policy "Finance team can view pit news" on finance_pit_news for select using (current_user_group() = any (array['finance','admin']));

-- Làm tròn gọn cho lưu trữ: >= 1000 lấy nguyên, còn lại 5 chữ số thập phân; không phải số -> null
create or replace function public.fn_pit_r(m jsonb, k text) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(m -> k) = 'number'
    then to_jsonb(case when abs((m ->> k)::numeric) >= 1000 then round((m ->> k)::numeric) else round((m ->> k)::numeric, 5) end)
    else 'null'::jsonb end
$$;

-- Chụp mỗi ngày làm việc (pg_cron 12:05 UTC = 19:05 giờ VN, sau ảnh chụp thị trường 11:20). Trả tóm tắt; ghi finance_function_runs.
create or replace function public.fn_pit_capture() returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  d date; n integer; obj jsonb; prev integer; added integer := 0; t0 timestamptz := clock_timestamp(); res jsonb;
  cols text[] := array['icb2','price','marketcap','pe','pb','ps','evEbitda','divYield','roae','roaa','beta','chg1m','chg3m','chg6m','chg1y','chgYtd','advValue20','freefloat','netMargin','grossMargin','debtToEquity','netProfitGrowthYoY','salesGrowthYoY','epsGrowthYoY','jdkRs','jdkMom','shares'];
begin
  select max(daily_date) into d from finance_market_snapshot;
  if d is null then
    res := jsonb_build_object('ok', false, 'reason', 'no_snapshot');
  else
    select count(*), jsonb_object_agg(symbol, arr) into n, obj from (
      select s.symbol, jsonb_build_array(
        s.icb2_code,
        case when jsonb_typeof(s.metrics -> 'marketcap') = 'number' and jsonb_typeof(s.metrics -> 'shares') = 'number' and (s.metrics ->> 'shares')::numeric > 0
             then to_jsonb(round((s.metrics ->> 'marketcap')::numeric / (s.metrics ->> 'shares')::numeric)) else 'null'::jsonb end,
        public.fn_pit_r(s.metrics, 'marketcap'), public.fn_pit_r(s.metrics, 'pe'), public.fn_pit_r(s.metrics, 'pb'), public.fn_pit_r(s.metrics, 'ps'), public.fn_pit_r(s.metrics, 'evEbitda'),
        public.fn_pit_r(s.metrics, 'divYield'), public.fn_pit_r(s.metrics, 'roae'), public.fn_pit_r(s.metrics, 'roaa'), public.fn_pit_r(s.metrics, 'beta'),
        public.fn_pit_r(s.metrics, 'chg1m'), public.fn_pit_r(s.metrics, 'chg3m'), public.fn_pit_r(s.metrics, 'chg6m'), public.fn_pit_r(s.metrics, 'chg1y'), public.fn_pit_r(s.metrics, 'chgYtd'),
        public.fn_pit_r(s.metrics, 'advValue20'), public.fn_pit_r(s.metrics, 'freefloat'), public.fn_pit_r(s.metrics, 'netMargin'), public.fn_pit_r(s.metrics, 'grossMargin'), public.fn_pit_r(s.metrics, 'debtToEquity'),
        public.fn_pit_r(s.metrics, 'netProfitGrowthYoY'), public.fn_pit_r(s.metrics, 'salesGrowthYoY'), public.fn_pit_r(s.metrics, 'epsGrowthYoY'), public.fn_pit_r(s.metrics, 'jdkRs'), public.fn_pit_r(s.metrics, 'jdkMom'),
        public.fn_pit_r(s.metrics, 'shares')
      ) arr
      from finance_market_snapshot s where s.daily_date = d
    ) x;
    select f.n into prev from finance_pit_market_daily f where f.as_of = d;
    -- Ngày đã có: chỉ ghi đè khi bản mới ĐẦY ĐỦ HƠN (nhiều mã hơn); bản đã chụp không bị thay bằng bản kém hơn
    insert into finance_pit_market_daily (as_of, n, cols, data) values (d, n, cols, coalesce(obj, '{}'::jsonb))
      on conflict (as_of) do update set n = excluded.n, cols = excluded.cols, data = excluded.data, captured_at = now()
      where excluded.n > finance_pit_market_daily.n;

    -- Báo cáo tài chính: thêm dòng cho mỗi dấu vân tay chưa lưu. seen_at = lúc dữ liệu đổi lần cuối trong bảng đệm; bảng đệm cũ có changed_at = 1970 (chưa từng ghi) thì lấy NGÀY GHI NHẬN đầu tiên (hôm nay), không bịa ngày công bố sớm hơn
    insert into finance_pit_fundamentals (symbol, fingerprint, quarter_key, annual_year, form, seen_at, data)
    select c.symbol, c.fingerprint, c.quarter_key, c.annual_year, c.form, case when c.changed_at >= date '2020-01-01' then least(c.changed_at::date, current_date) else current_date end,
      jsonb_build_object(
        'annual', coalesce((select jsonb_agg(e order by i) from (select e, i from jsonb_array_elements(c.payload -> 'annual') with ordinality t(e, i) order by i limit 3) z), '[]'::jsonb),
        'quarters', coalesce((select jsonb_agg(e order by i) from (select e, i from jsonb_array_elements(c.payload -> 'quarters') with ordinality t(e, i) order by i limit 8) z), '[]'::jsonb),
        'dividends', coalesce(c.payload -> 'dividends', '{}'::jsonb))
    from finance_financials_cache c
    where c.fingerprint is not null
      and not exists (select 1 from finance_pit_fundamentals f where f.symbol = c.symbol and f.fingerprint = c.fingerprint);
    get diagnostics added = row_count;
    res := jsonb_build_object('ok', true, 'as_of', d, 'symbols', n, 'was', prev, 'fundamentals_added', added);
  end if;
  insert into finance_function_runs (fn, mode, ok, duration_ms, detail)
    values ('pit-capture', 'daily', coalesce((res ->> 'ok')::boolean, false), (extract(epoch from clock_timestamp() - t0) * 1000)::integer, res);
  return res;
end;
$fn$;
revoke all on function public.fn_pit_capture() from public, anon, authenticated;

select cron.unschedule('pit-capture-daily') where exists (select 1 from cron.job where jobname = 'pit-capture-daily');
select cron.schedule('pit-capture-daily', '5 12 * * 1-5', $job$ select public.fn_pit_capture(); $job$);
