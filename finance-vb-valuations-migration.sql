-- VALUATION BENCH: kết quả định giá chuyên sâu đã lưu (06/10/2026). Chạy lại an toàn. Mỗi lần lưu là MỘT BẢN GHI MỚI (lịch sử bất biến) để xem giá trị ước tính của một mã thay đổi thế nào theo thời gian và để Investment Workbench
-- (Chi tiết mã, Danh Mục) hiển thị bản mới nhất: dải giá trị hợp lý, giá so với giá trị, điểm kỹ thuật, bối cảnh thị trường, vùng giá tham khảo. Nhóm finance / admin được xem; mỗi người ghi bản của mình; xoá bản của mình
-- (quản lý danh mục / admin xoá được mọi bản). Không có UPDATE: muốn sửa thì lưu bản mới.
create table if not exists finance_vb_valuations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,12}$'),
  as_of date not null,                              -- ngày của giá dùng để định giá
  price numeric check (price is null or price > 0),
  form text,                                        -- NON_FINANCE | BANK | SECURITIES | INSURANCE
  fair_low numeric, fair_base numeric, fair_high numeric,
  margin_of_safety numeric,                         -- 1 - giá / giá trị đồng thuận (dương = giá rẻ hơn giá trị)
  grade text, stance text, confidence text, confidence_score numeric,
  tech_score numeric, tech_rating text, timing text, market_score numeric, composite numeric,
  accumulate_low numeric, accumulate_high numeric, invalidation numeric,
  methods jsonb not null default '[]'::jsonb,       -- từng phương pháp: khoá, tên, thấp/cơ sở/cao, trọng số
  assumptions jsonb not null default '{}'::jsonb,   -- giả định đã chỉnh (DCF, ngân hàng, trọng số, biên an toàn)
  summary jsonb not null default '{}'::jsonb,       -- lý do, cờ, "điều gì phải đúng", nhận định kỹ thuật để hiển thị lại
  note text,
  created_at timestamptz not null default now()
);
create index if not exists finance_vb_valuations_symbol_idx on finance_vb_valuations (symbol, created_at desc);
create index if not exists finance_vb_valuations_user_idx on finance_vb_valuations (user_id, created_at desc);

alter table finance_vb_valuations enable row level security;
drop policy if exists "Finance team can view vb valuations" on finance_vb_valuations;
create policy "Finance team can view vb valuations" on finance_vb_valuations for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own vb valuations" on finance_vb_valuations;
create policy "Insert own vb valuations" on finance_vb_valuations for insert
  with check (user_id = current_user_id() and current_user_group() = any (array['finance','admin']));
drop policy if exists "Delete vb valuations" on finance_vb_valuations;
create policy "Delete vb valuations" on finance_vb_valuations for delete
  using (current_user_group() = any (array['finance','admin']) and (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'));

drop trigger if exists trg_audit_finance_vb_valuations on public.finance_vb_valuations;
create trigger trg_audit_finance_vb_valuations after insert or update or delete on public.finance_vb_valuations for each row execute function public.fn_audit_row_change();
