-- ÉP DUYỆT LỆNH Ở MÁY CHỦ (đã áp dụng trên Supabase qua MCP apply_migration "fin_approval_enforce"). Chạy lại an toàn.
-- LƯU Ý: khối "giới hạn theo vị thế ở chế độ chặn" (max_symbol_pct / max_position_vnd) và kind kiểm tra mới 'limit' đã áp dụng lên Supabase ngày 05/10/2026 (migration "fin_limit_block_enforce"), kiểm bằng 9 ca DO có huỷ dữ liệu.
-- Trước đây việc "lệnh lớn phải có đề xuất đã duyệt" chỉ nằm trong code app (api.js addTransaction); ai gọi thẳng API Supabase thì lách được.
-- Trigger fn_finance_transactions_enforce (BEFORE INSERT/UPDATE trên finance_transactions) lặp lại luật đó ở DB:
--   * quy định duyệt lệnh đang BẬT và lệnh vượt ngưỡng (% NAV theo finance_assets.nav và/hoặc số tiền) => phải có đề xuất đã duyệt, còn hạn, của đúng người/mã/chiều,
--     đủ khối lượng và giá trị (+5% như ApprovalCalc.matchApproval). Không có => từ chối "APPROVAL_REQUIRED: ...".
--   * đề xuất khớp được TIÊU THỤ ngay trong cùng giao dịch (status 'executed', txn_id = lệnh mới) nên 1 đề xuất chỉ dùng cho 1 lệnh, không dùng lại bằng gọi trực tiếp.
--   * lệnh nhập từ sao kê (import_batch) là việc đã xảy ra ở công ty chứng khoán nên không chặn, nhưng nếu vượt ngưỡng thì GHI NGAY một dòng finance_approval_audit
--     kind 'import' để quản lý xem xét (không thể dùng import_batch để lách trong im lặng). Lệnh điều chỉnh đối soát (ghi chú bắt đầu "Đối soát") không chặn;
--     kiểm tra độc lập hằng ngày của approval-watch đã ghi nhận chúng với kind 'reconcile'.
--   * khi quy định đang bật, không sửa được mã/chiều/khối lượng/giá/chủ của lệnh đã ghi (app không có chức năng sửa; sửa trực tiếp là cách lách), và không khôi phục
--     lệnh đã xoá mà không qua kiểm tra như lệnh mới.
--   * danh sách hạn chế (finance_restricted_symbols, finance-restricted-migration.sql): chặn cả mua lẫn bán, kể cả quản lý; lệnh nhập sao kê/đối soát vào mã hạn chế ghi dòng kiểm tra kind 'restricted'.
--   * cấm mã (finance_limits kind 'blocked_symbol', mode 'block', scope member hoặc user của chính người đó): chặn MUA, chỉ quản lý/admin được ghi (app vẫn bắt quản lý ghi lý do).
--     Giới hạn theo vị thế ở chế độ chặn (max_symbol_pct, max_position_vnd) cũng chặn MUA ở máy chủ (xem khối bên dưới); loại cần phân ngành/tiền mặt/đòn bẩy vẫn do app kiểm + kiểm tra độc lập hằng ngày của check-limits.
-- Service role (current_user_id() null) bỏ qua. Muốn khôi phục sao lưu có lệnh lớn khi quy định đang bật: tắt quy định trong lúc khôi phục.

do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.finance_approval_audit'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.finance_approval_audit drop constraint %I', c);
  end loop;
end $$;
alter table public.finance_approval_audit add constraint finance_approval_audit_kind_check check (kind in ('unapproved','reconcile','import','restricted','split','limit'));

create or replace function public.fn_finance_transactions_enforce() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
declare
  me uuid; mgr boolean; pol record; v_nav numeric; v_val numeric; v_pct numeric; need boolean; by_pct boolean; by_vnd boolean;
  req record; v_sym text; v_side text; reconcile boolean; undelete boolean;
  v_held numeric; v_after numeric; v_posval numeric; v_poct numeric; v_breach text[]; lim record;
begin
  me := public.current_user_id();
  if me is null then return new; end if;                        -- service role / migration
  if new.deleted_at is not null then return new; end if;        -- dòng đã xoá mềm không phải lệnh mới

  select * into pol from public.finance_approval_policy where id = 1;

  if tg_op = 'UPDATE' then
    undelete := old.deleted_at is not null;
    if not undelete then
      if pol.active and (new.user_id is distinct from old.user_id or upper(new.symbol) is distinct from upper(old.symbol) or new.type is distinct from old.type
                         or new.quantity is distinct from old.quantity or new.price is distinct from old.price) then
        raise exception 'APPROVAL_REQUIRED: Không sửa được mã, chiều, khối lượng, giá của lệnh đã ghi khi bật duyệt lệnh; hãy xoá lệnh và ghi lại.' using errcode = '42501';
      end if;
      return new;
    end if;
    -- khôi phục lệnh đã xoá: kiểm như lệnh mới
  end if;

  v_sym := upper(btrim(new.symbol));
  v_side := case when new.type = 'sell' then 'sell' else 'buy' end;
  reconcile := coalesce(new.note, '') like 'Đối soát%';
  mgr := public.current_user_has_fin_role('asset_manager') or public.current_user_group() = 'admin';
  v_val := coalesce(new.quantity, 0) * coalesce(new.price, 0);
  select a.nav into v_nav from public.finance_assets a where a.user_id = new.user_id;
  v_pct := case when coalesce(v_nav, 0) > 0 then v_val / v_nav * 100 else null end;

  -- Danh sách hạn chế (finance-restricted-migration.sql): cấm cả MUA lẫn BÁN, kể cả quản lý. Lệnh nhập sao kê / đối soát (việc đã xảy ra) không chặn nhưng ghi dòng kiểm tra kind 'restricted'.
  if exists (select 1 from public.finance_restricted_symbols x where x.active and x.symbol = v_sym and (x.user_id is null or x.user_id = new.user_id)) then
    if new.import_batch is not null or reconcile then
      insert into public.finance_approval_audit (txn_id, user_id, symbol, side, trade_date, quantity, price, value, nav_ref, pct, reasons, kind)
      values (new.id, new.user_id, v_sym, v_side, new.trade_date, new.quantity, new.price, v_val, nullif(v_nav, 0), v_pct, array['restricted'], 'restricted')
      on conflict (txn_id) do nothing;
      return new;
    end if;
    raise exception 'RESTRICTED: Mã % đang trong danh sách hạn chế của nhóm, không được mua hoặc bán; quản lý cần gỡ hạn chế trước.', v_sym using errcode = '42501';
  end if;

  -- Cấm mã (block): chặn MUA, chỉ quản lý / admin được ghi
  if v_side = 'buy' and not reconcile and not mgr and exists (
       select 1 from public.finance_limits l
       where l.active and l.kind = 'blocked_symbol' and l.mode = 'block' and upper(coalesce(l.symbol, '')) = v_sym
         and (l.scope = 'member' or (l.scope = 'user' and l.user_id = new.user_id))) then
    raise exception 'LIMIT_BLOCKED: Mã % đang bị cấm mua theo giới hạn đầu tư của nhóm; chỉ quản lý được ghi đè kèm lý do.', v_sym using errcode = '42501';
  end if;

  -- Giới hạn theo vị thế ở chế độ CHẶN (max_symbol_pct, max_position_vnd): chỉ với lệnh MUA. Vị thế sau lệnh = (khối lượng đang giữ + khối lượng mua) x giá lệnh; mẫu số là finance_assets.nav.
  -- Trong mỗi tầng (nhóm / cá nhân) giới hạn riêng cho đúng mã thay thế giới hạn chung của tầng đó (như LimitsCalc). Khối lượng đang giữ chỉ cộng trừ các lệnh mua/bán, KHÔNG tính chia tách/cổ phiếu thưởng
  -- nên chỉ có thể đánh giá thấp vị thế (nghiêng về cho phép, không chặn nhầm). Quản lý/admin không bị chặn (app bắt ghi lý do); lệnh nhập sao kê/đối soát không chặn nhưng ghi dòng kiểm tra kind 'limit'.
  -- Giới hạn cần phân ngành, tiền mặt, đòn bẩy vẫn do app kiểm + check-limits hằng ngày.
  if v_side = 'buy' and v_val > 0 and (not mgr or new.import_batch is not null or reconcile) then
    select coalesce(sum(case when t.type = 'sell' then -t.quantity else t.quantity end), 0) into v_held
      from public.finance_transactions t
     where t.user_id = new.user_id and upper(t.symbol) = v_sym and t.deleted_at is null and t.id is distinct from new.id;
    v_after := greatest(v_held, 0) + coalesce(new.quantity, 0);
    v_posval := v_after * coalesce(new.price, 0);
    v_poct := case when coalesce(v_nav, 0) > 0 then v_posval / v_nav * 100 else null end;
    v_breach := array[]::text[];
    for lim in
      select distinct on (l.kind, case when l.scope = 'user' then 'u' else 'm' end) l.kind, l.value, l.mode, l.scope
        from public.finance_limits l
       where l.active and l.kind in ('max_symbol_pct', 'max_position_vnd') and l.value is not null
         and (l.scope = 'member' or (l.scope = 'user' and l.user_id = new.user_id))
         and (upper(coalesce(l.symbol, '')) = v_sym or l.symbol is null)
       order by l.kind, case when l.scope = 'user' then 'u' else 'm' end, (l.symbol is null)
    loop
      if lim.mode <> 'block' then continue; end if;
      if lim.kind = 'max_symbol_pct' and v_poct is not null and v_poct > lim.value + 1e-9 then
        v_breach := v_breach || format('%s vượt %s%% NAV (sau lệnh %s%%)', v_sym, lim.value, round(v_poct, 1));
      elsif lim.kind = 'max_position_vnd' and v_posval > lim.value + 1e-9 then
        v_breach := v_breach || format('%s vượt %s đ (sau lệnh %s đ)', v_sym, replace(to_char(round(lim.value), 'FM999G999G999G999G999'), ',', '.'), replace(to_char(round(v_posval), 'FM999G999G999G999G999'), ',', '.'));
      end if;
    end loop;
    if array_length(v_breach, 1) > 0 then
      if new.import_batch is not null or reconcile then
        insert into public.finance_approval_audit (txn_id, user_id, symbol, side, trade_date, quantity, price, value, nav_ref, pct, reasons, kind)
        values (new.id, new.user_id, v_sym, v_side, new.trade_date, new.quantity, new.price, v_val, nullif(v_nav, 0), v_poct, v_breach, 'limit')
        on conflict (txn_id) do nothing;
      else
        raise exception 'LIMIT_BLOCKED: Lệnh mua % vượt giới hạn đầu tư của nhóm: %. Chỉ quản lý được ghi đè kèm lý do.', v_sym, array_to_string(v_breach, '; ') using errcode = '42501';
      end if;
    end if;
  end if;

  if pol.id is null or not pol.active then return new; end if;
  if reconcile then return new; end if;

  by_pct := coalesce(pol.threshold_pct, 0) > 0 and v_pct is not null and v_pct > pol.threshold_pct + 1e-9;
  by_vnd := coalesce(pol.threshold_vnd, 0) > 0 and v_val > pol.threshold_vnd + 1e-9;
  need := v_val > 0 and (by_pct or by_vnd);
  if not need then return new; end if;

  if new.import_batch is not null then
    insert into public.finance_approval_audit (txn_id, user_id, symbol, side, trade_date, quantity, price, value, nav_ref, pct, reasons, kind)
    values (new.id, new.user_id, v_sym, v_side, new.trade_date, new.quantity, new.price, v_val, nullif(v_nav, 0), v_pct,
            array_remove(array[case when by_pct then 'pct' end, case when by_vnd then 'vnd' end], null), 'import')
    on conflict (txn_id) do nothing;
    return new;
  end if;

  select * into req from public.finance_order_requests r
   where r.user_id = new.user_id and r.status = 'approved' and r.valid_until is not null and r.valid_until >= current_date
     and upper(r.symbol) = v_sym and r.side = v_side
     and new.quantity <= r.quantity + 1e-9 and v_val <= r.value * 1.05 + 1e-9
   order by coalesce(r.decided_at, r.created_at) asc
   limit 1
   for update;
  if not found then
    raise exception 'APPROVAL_REQUIRED: Lệnh % % trị giá % đ% vượt ngưỡng duyệt lệnh; cần đề xuất đã được quản lý duyệt (còn hạn) trước khi ghi.',
      case when v_side = 'sell' then 'bán' else 'mua' end, v_sym, replace(to_char(round(v_val), 'FM999G999G999G999G999'), ',', '.'),
      case when v_pct is not null then ' (' || round(v_pct, 1) || '% NAV)' else '' end using errcode = '42501';
  end if;

  update public.finance_order_requests set status = 'executed', txn_id = new.id where id = req.id;   -- tiêu thụ đề xuất (trigger guard ghi executed_at)
  return new;
end;
$fn$;

drop trigger if exists trg_finance_transactions_enforce on public.finance_transactions;
create trigger trg_finance_transactions_enforce before insert or update on public.finance_transactions for each row execute function public.fn_finance_transactions_enforce();
