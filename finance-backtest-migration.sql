-- KIỂM THỬ CHIẾN LƯỢC (11/10/2026). Chạy lại an toàn. Chỉ service role (Edge Function bt-data) ghi dữ liệu thị trường; nhóm finance / admin đọc.
--  finance_price_days : MỖI NGÀY GIAO DỊCH MỘT DÒNG, cả thị trường dạng gọn { "FPT": [đóng cửa thô, giá tham chiếu, giá trị khớp lệnh (triệu đồng), cờ trần/sàn (1 / -1 / 0), sàn (0 HOSE, 1 HNX, 2 UPCoM)] }
--                       (nghìn đồng). Lợi suất ngày = đóng cửa / tham chiếu - 1: không bao giờ đổi nên kho chỉ thêm ngày mới. Gồm cả mã sau này hủy niêm yết. ~20-25 KB mỗi ngày.
--  finance_bt_index   : chuỗi chỉ số (VN-Index, VN30, HNX-Index và 10 chỉ số ngành HOSE) { d: [ngày], c: [điểm] }.
--  finance_pit_market_daily.source : 'live' (ảnh chụp hằng ngày) hoặc 'backfill' (dựng ngược cho quá khứ từ chỉ số VNDirect đã tính theo ngày).
--  finance_bt_runs    : mỗi lần người dùng lưu một lần kiểm thử (cấu hình + tóm tắt kết quả). Số lần đã thử trên cùng dữ liệu dùng để hiệu chỉnh Sharpe (Sharpe "đã trừ may rủi" cho nhiều lần thử).

create table if not exists finance_price_days (
  day date primary key,
  n integer not null,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);
create table if not exists finance_bt_index (
  symbol text primary key,
  first_date date,
  last_date date,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table finance_pit_market_daily add column if not exists source text not null default 'live';

create table if not exists finance_bt_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  spec jsonb not null check (octet_length(spec::text) < 30000),
  summary jsonb not null check (octet_length(summary::text) < 400000),
  data_through date,
  note text check (note is null or char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists finance_bt_runs_user_idx on finance_bt_runs (user_id, created_at desc) where deleted_at is null;

alter table finance_price_days enable row level security;
alter table finance_bt_index enable row level security;
alter table finance_bt_runs enable row level security;
drop policy if exists "Finance team can view price days" on finance_price_days;
create policy "Finance team can view price days" on finance_price_days for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Finance team can view bt index" on finance_bt_index;
create policy "Finance team can view bt index" on finance_bt_index for select using (current_user_group() = any (array['finance','admin']));
-- Lần kiểm thử là việc RIÊNG của từng người: chỉ chủ xem / thêm / sửa / xoá (không chia sẻ cho cả nhóm như ý tưởng)
drop policy if exists "Own bt runs select" on finance_bt_runs;
create policy "Own bt runs select" on finance_bt_runs for select using (user_id = current_user_id() and current_user_group() = any (array['finance','admin']));
drop policy if exists "Own bt runs insert" on finance_bt_runs;
create policy "Own bt runs insert" on finance_bt_runs for insert with check (user_id = current_user_id() and current_user_group() = any (array['finance','admin']));
drop policy if exists "Own bt runs update" on finance_bt_runs;
create policy "Own bt runs update" on finance_bt_runs for update using (user_id = current_user_id()) with check (user_id = current_user_id() and current_user_group() = any (array['finance','admin']));
drop policy if exists "Own bt runs delete" on finance_bt_runs;
create policy "Own bt runs delete" on finance_bt_runs for delete using (user_id = current_user_id());

-- Cron: sau khi VNDirect đã đăng đủ dữ liệu cuối phiên (15:10 VN) và trước ảnh chụp PIT / luận điểm; hàm tự bỏ qua ngày nguồn chưa đủ và thử lại ở lần sau.
select cron.unschedule('bt-fill-daily') where exists (select 1 from cron.job where jobname = 'bt-fill-daily');
select cron.schedule('bt-fill-daily', '30 12 * * 1-5', $job$
  select net.http_post(url := 'https://gqsbsqaxzpzcloaopzvv.supabase.co/functions/v1/bt-data',
    headers := jsonb_build_object('Authorization', 'Bearer sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR', 'Content-Type', 'application/json'),
    body := '{"mode":"fill","limit":10}'::jsonb, timeout_milliseconds := 140000);
$job$);
