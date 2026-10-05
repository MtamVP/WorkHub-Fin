-- LỊCH SỬ ĐỊNH GIÁ thị trường và theo ngành (06/10/2026). Chạy lại an toàn. Chỉ service role (Edge Function market-data-sync, mode "snapshot" hằng ngày và "history" bù ngược) ghi; nhóm finance / admin đọc.
-- Mỗi dòng = một ngày x một phạm vi ('ALL' = cả thị trường, hoặc mã ICB cấp 2): số mã, trung vị và giá trị TỔNG HỢP theo vốn hoá (P/E tổng hợp = tổng vốn hoá / tổng lợi nhuận của các mã có lãi) của P/E và P/B,
-- chỉ tính mã vốn hoá từ 300 tỷ. Phân ngành lấy theo danh sách hiện tại nên có thiên lệch người sống sót nhẹ ở dữ liệu quá khứ của từng ngành.

create table if not exists finance_valuation_history (
  as_of date not null,
  scope text not null,
  n integer not null default 0,
  n_pe integer not null default 0,
  n_pb integer not null default 0,
  pe_median numeric,
  pb_median numeric,
  pe_agg numeric,
  pb_agg numeric,
  mcap_total numeric,
  updated_at timestamptz not null default now(),
  primary key (as_of, scope)
);
create index if not exists finance_valuation_history_scope_idx on finance_valuation_history (scope, as_of);
alter table finance_valuation_history enable row level security;
drop policy if exists "Finance team can view valuation history" on finance_valuation_history;
create policy "Finance team can view valuation history" on finance_valuation_history for select using (current_user_group() = any (array['finance','admin']));
