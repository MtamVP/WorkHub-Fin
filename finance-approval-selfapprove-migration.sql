-- Danh sách người được MIỄN nguyên tắc hai người khi duyệt lệnh lớn (đã áp dụng trên Supabase qua MCP apply_migration "fin_approval_self_approvers"). Chạy lại an toàn.
-- Cột self_approvers (mảng id người dùng) nằm trong dòng quy định duyệt lệnh (finance_approval_policy, id = 1). CHỈ nhóm admin sửa được cột này
-- (trigger fn_finance_approval_policy_guard) -- quản lý danh mục sửa ngưỡng được nhưng không tự thêm mình vào danh sách miễn.
-- Người trong danh sách (và admin) tự duyệt được đề xuất của chính mình; vẫn phải ghi lý do >= 10 ký tự để có dấu vết, và lịch sử gắn nhãn "tự duyệt".
alter table finance_approval_policy add column if not exists self_approvers uuid[] not null default '{}';

create or replace function public.fn_finance_approval_policy_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
begin
  if public.current_user_id() is null then return new; end if;            -- service role / migration
  if tg_op = 'INSERT' then
    if coalesce(array_length(new.self_approvers, 1), 0) > 0 and public.current_user_group() <> 'admin' then
      raise exception 'Chỉ admin được đặt danh sách người miễn nguyên tắc hai người.' using errcode = '42501';
    end if;
  elsif new.self_approvers is distinct from old.self_approvers and public.current_user_group() <> 'admin' then
    raise exception 'Chỉ admin được sửa danh sách người miễn nguyên tắc hai người.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_finance_approval_policy_guard on public.finance_approval_policy;
create trigger trg_finance_approval_policy_guard before insert or update on public.finance_approval_policy for each row execute function public.fn_finance_approval_policy_guard();

-- Trigger duyệt đề xuất: người trong self_approvers được tự duyệt như admin (vẫn cần lý do >= 10 ký tự)
create or replace function public.fn_finance_order_requests_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
declare
  me uuid; mgr boolean; adm boolean; exempt boolean; owner boolean; own_req boolean; note text;
begin
  me := public.current_user_id();
  if me is null then return new; end if;
  mgr := public.current_user_has_fin_role('asset_manager') or public.current_user_group() = 'admin';
  adm := public.current_user_group() = 'admin';
  exempt := adm or exists (select 1 from public.finance_approval_policy p where p.id = 1 and me = any (p.self_approvers));

  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.decided_by is not null or new.decided_at is not null or new.decision_note is not null
       or new.valid_until is not null or new.txn_id is not null or new.executed_at is not null then
      raise exception 'Đề xuất mới luôn ở trạng thái chờ duyệt.' using errcode = '42501';
    end if;
    new.created_by := me;
    return new;
  end if;

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
  own_req := owner;
  note := btrim(coalesce(new.decision_note, ''));

  if old.status = 'pending' and new.status in ('approved','rejected') then
    if not mgr then raise exception 'Chỉ quản lý danh mục hoặc admin được duyệt lệnh.' using errcode = '42501'; end if;
    if own_req then
      if not exempt then raise exception 'Không được tự duyệt lệnh của chính mình (nguyên tắc hai người).' using errcode = '42501'; end if;
      if new.status = 'approved' and char_length(note) < 10 then raise exception 'Tự duyệt lệnh của mình phải ghi lý do (tối thiểu 10 ký tự).' using errcode = '42501'; end if;
    end if;
    if new.status = 'rejected' and char_length(note) < 3 then raise exception 'Từ chối cần ghi lý do.' using errcode = '42501'; end if;
    if new.status = 'approved' and (new.valid_until is null or new.valid_until < current_date) then raise exception 'Duyệt phải có hạn dùng từ hôm nay trở đi.' using errcode = '42501'; end if;
    if new.txn_id is not null or new.executed_at is not null then raise exception 'Đề xuất chưa được thực hiện.' using errcode = '42501'; end if;
    new.decided_by := me;
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

-- Nguyễn Huy Long (huylongnguyen228@gmail.com) được miễn nguyên tắc hai người (yêu cầu của chủ dự án, 04/10/2026).
-- Nếu chưa có dòng quy định thì tạo dòng ở trạng thái TẮT (không đổi hành vi của ai).
insert into finance_approval_policy (id, active, valid_days, self_approvers)
select 1, false, 3, array[u.id] from users u where u.email = 'huylongnguyen228@gmail.com'
on conflict (id) do update set self_approvers = (select array(select distinct x from unnest(finance_approval_policy.self_approvers || excluded.self_approvers) x));
