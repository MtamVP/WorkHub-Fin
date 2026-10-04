-- LIÊN KẾT ĐỀ XUẤT LỆNH VỚI Ý TƯỞNG (đã áp dụng trên Supabase qua MCP apply_migration "fin_order_idea_link"). Chạy lại an toàn.
-- finance_order_requests.idea_id: đề xuất lệnh này sinh ra từ ý tưởng đầu tư nào (tuỳ chọn). Cùng với txn_id (lệnh đã ghi) cho phép dựng "Hành trình ý tưởng":
-- ý tưởng -> duyệt -> đề xuất lệnh -> duyệt lệnh -> ghi lệnh -> kết quả (Toàn Nhóm > Hành Trình). Không đổi được sau khi tạo (trigger).
alter table finance_order_requests add column if not exists idea_id uuid references finance_ideas(id) on delete set null;
create index if not exists finance_order_requests_idea_idx on finance_order_requests (idea_id) where idea_id is not null;

create or replace function public.fn_finance_order_requests_idea_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
begin
  if public.current_user_id() is null then return new; end if;
  if new.idea_id is distinct from old.idea_id then
    raise exception 'Không được đổi ý tưởng gắn với đề xuất sau khi tạo.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_finance_order_requests_idea_guard on public.finance_order_requests;
create trigger trg_finance_order_requests_idea_guard before update on public.finance_order_requests for each row execute function public.fn_finance_order_requests_idea_guard();
