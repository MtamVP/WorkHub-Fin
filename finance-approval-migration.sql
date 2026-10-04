-- DUYỆT LỆNH LỚN trước khi đặt (đã áp dụng trên Supabase qua MCP apply_migration "fin_order_approval"). Chạy lại an toàn.
-- Hai bảng:
--   finance_approval_policy : đúng 1 dòng (id = 1) -- bật/tắt, ngưỡng % NAV và/hoặc số tiền, số ngày hiệu lực của đề xuất đã duyệt. Quản lý / admin sửa.
--   finance_order_requests  : mỗi đề xuất lệnh 1 dòng. Thành viên tạo cho danh mục của mình (hoặc quản lý nhập hộ); quản lý duyệt/từ chối.
-- Trigger fn_finance_order_requests_guard là chốt chặn thật (không lách được bằng gọi API trực tiếp):
--   * tạo mới luôn ở trạng thái 'pending'; các trường cốt lõi của đề xuất không sửa được sau khi tạo;
--   * chỉ quản lý / admin duyệt hoặc từ chối; người duyệt = người đang đăng nhập, thời điểm do máy chủ ghi;
--   * KHÔNG tự duyệt đề xuất của chính mình (danh mục của mình hoặc do mình nhập hộ) -- ngoại lệ duy nhất là nhóm admin, và phải ghi lý do >= 10 ký tự;
--   * từ chối cần lý do >= 3 ký tự; duyệt phải có hạn dùng (valid_until);
--   * chủ đề xuất được huỷ khi đang chờ / đã duyệt, và đánh dấu 'executed' (kèm txn_id) sau khi lệnh được ghi.
-- Việc GHI lệnh có cần đề xuất đã duyệt hay không do api.js (addTransaction) kiểm; đây là kiểm soát phía ứng dụng, giống giới hạn đầu tư.

create table if not exists finance_approval_policy (
  id int primary key default 1 check (id = 1),
  active boolean not null default false,
  threshold_pct numeric check (threshold_pct is null or (threshold_pct > 0 and threshold_pct <= 100)),
  threshold_vnd numeric check (threshold_vnd is null or threshold_vnd > 0),
  valid_days int not null default 3 check (valid_days between 1 and 30),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
alter table finance_approval_policy enable row level security;
drop policy if exists "Finance team can view approval policy" on finance_approval_policy;
create policy "Finance team can view approval policy" on finance_approval_policy for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Manager manages approval policy" on finance_approval_policy;
create policy "Manager manages approval policy" on finance_approval_policy for all
  using (current_user_group() = any (array['finance','admin']) and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
  with check (current_user_group() = any (array['finance','admin']) and (current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'));
drop trigger if exists trg_audit_finance_approval_policy on public.finance_approval_policy;
create trigger trg_audit_finance_approval_policy after insert or update or delete on public.finance_approval_policy for each row execute function public.fn_audit_row_change();

create table if not exists finance_order_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,        -- chủ danh mục
  created_by uuid references users(id),                                  -- người nhập đề xuất (khác user_id khi quản lý nhập hộ)
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  quantity numeric not null check (quantity > 0),
  price_ref numeric not null check (price_ref > 0),
  value numeric not null check (value > 0),
  nav_at_request numeric,
  order_pct numeric,
  reason text not null check (char_length(btrim(reason)) >= 10),
  status text not null default 'pending' check (status in ('pending','approved','rejected','executed','cancelled')),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text,
  valid_until date,
  txn_id uuid,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists finance_order_requests_user_idx on finance_order_requests (user_id, created_at desc);
create index if not exists finance_order_requests_status_idx on finance_order_requests (status, created_at desc);
alter table finance_order_requests enable row level security;
drop policy if exists "Finance team can view order requests" on finance_order_requests;
create policy "Finance team can view order requests" on finance_order_requests for select
  using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Create own order requests" on finance_order_requests;
create policy "Create own order requests" on finance_order_requests for insert
  with check (current_user_group() = any (array['finance','admin']) and (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'));
drop policy if exists "Update order requests" on finance_order_requests;
create policy "Update order requests" on finance_order_requests for update
  using (current_user_group() = any (array['finance','admin']) and (user_id = current_user_id() or created_by = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
  with check (current_user_group() = any (array['finance','admin']));
-- không có policy DELETE: đề xuất là dấu vết, chỉ huỷ chứ không xoá

create or replace function public.fn_finance_order_requests_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
declare
  me uuid; mgr boolean; adm boolean; owner boolean; own_req boolean; note text;
begin
  me := public.current_user_id();
  if me is null then return new; end if;                 -- service role / migration
  mgr := public.current_user_has_fin_role('asset_manager') or public.current_user_group() = 'admin';
  adm := public.current_user_group() = 'admin';

  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.decided_by is not null or new.decided_at is not null or new.decision_note is not null
       or new.valid_until is not null or new.txn_id is not null or new.executed_at is not null then
      raise exception 'Đề xuất mới luôn ở trạng thái chờ duyệt.' using errcode = '42501';
    end if;
    new.created_by := me;
    return new;
  end if;

  -- UPDATE: các trường cốt lõi không đổi
  if new.user_id is distinct from old.user_id or new.symbol is distinct from old.symbol or new.side is distinct from old.side
     or new.quantity is distinct from old.quantity or new.price_ref is distinct from old.price_ref or new.value is distinct from old.value
     or new.nav_at_request is distinct from old.nav_at_request or new.order_pct is distinct from old.order_pct
     or new.reason is distinct from old.reason or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'Không được sửa nội dung đề xuất sau khi tạo; hãy huỷ và tạo đề xuất mới.' using errcode = '42501';
  end if;
  if new.status is not distinct from old.status then
    if new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at or new.decision_note is distinct from old.decision_note
       or new.valid_until is distinct from old.valid_until or new.txn_id is distinct from old.txn_id or new.executed_at is distinct from old.executed_at then
      raise exception 'Không được sửa thông tin quyết định của đề xuất.' using errcode = '42501';
    end if;
    return new;
  end if;

  owner := old.user_id = me or old.created_by = me;
  own_req := owner;                                       -- "của chính mình": danh mục của mình hoặc do mình nhập hộ
  note := btrim(coalesce(new.decision_note, ''));

  if old.status = 'pending' and new.status in ('approved','rejected') then
    if not mgr then raise exception 'Chỉ quản lý danh mục hoặc admin được duyệt lệnh.' using errcode = '42501'; end if;
    if own_req then
      if not adm then raise exception 'Không được tự duyệt lệnh của chính mình (nguyên tắc hai người).' using errcode = '42501'; end if;
      if new.status = 'approved' and char_length(note) < 10 then raise exception 'Admin tự duyệt lệnh của mình phải ghi lý do (tối thiểu 10 ký tự).' using errcode = '42501'; end if;
    end if;
    if new.status = 'rejected' and char_length(note) < 3 then raise exception 'Từ chối cần ghi lý do.' using errcode = '42501'; end if;
    if new.status = 'approved' and (new.valid_until is null or new.valid_until < current_date) then raise exception 'Duyệt phải có hạn dùng từ hôm nay trở đi.' using errcode = '42501'; end if;
    if new.txn_id is not null or new.executed_at is not null then raise exception 'Đề xuất chưa được thực hiện.' using errcode = '42501'; end if;
    new.decided_by := me;                                 -- máy chủ ghi, không tin giá trị client gửi
    new.decided_at := now();
    if new.status = 'rejected' then new.valid_until := null; end if;
    return new;
  end if;

  if old.status in ('pending','approved') and new.status = 'cancelled' then
    if not (owner or mgr) then raise exception 'Chỉ người đề xuất hoặc quản lý được huỷ đề xuất.' using errcode = '42501'; end if;
    if new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at or new.decision_note is distinct from old.decision_note
       or new.valid_until is distinct from old.valid_until or new.txn_id is distinct from old.txn_id then
      raise exception 'Huỷ đề xuất không được đổi thông tin quyết định.' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status = 'approved' and new.status = 'executed' then
    if not (owner or mgr) then raise exception 'Chỉ người đề xuất hoặc quản lý ghi nhận việc thực hiện lệnh.' using errcode = '42501'; end if;
    if new.txn_id is null then raise exception 'Cần gắn lệnh đã ghi vào đề xuất.' using errcode = '42501'; end if;
    if new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at or new.decision_note is distinct from old.decision_note
       or new.valid_until is distinct from old.valid_until then
      raise exception 'Không được đổi thông tin quyết định khi ghi nhận thực hiện.' using errcode = '42501';
    end if;
    new.executed_at := now();
    return new;
  end if;

  raise exception 'Không thể chuyển đề xuất từ "%" sang "%".', old.status, new.status using errcode = '42501';
end;
$fn$;
drop trigger if exists trg_finance_order_requests_guard on public.finance_order_requests;
create trigger trg_finance_order_requests_guard before insert or update on public.finance_order_requests for each row execute function public.fn_finance_order_requests_guard();

drop trigger if exists trg_audit_finance_order_requests on public.finance_order_requests;
create trigger trg_audit_finance_order_requests after insert or update or delete on public.finance_order_requests for each row execute function public.fn_audit_row_change();
