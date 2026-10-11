-- 12/10/2026: mở rộng audit log (audit-log-migration.sql) sang các bảng Finance còn thiếu. Chạy lại an toàn.
--
-- Thêm trigger cho: finance_sim_runs (Nhật ký mô phỏng), finance_decisions (Nhật Ký Quyết Định), finance_bt_runs (lần kiểm thử đã lưu),
-- finance_assets (tiền mặt / dư nợ), finance_allocation_targets (tỷ trọng mục tiêu).
-- Không thêm (chủ ý): finance_watchlist, finance_notes (dữ liệu cá nhân, ít giá trị tuân thủ).
--
-- Dùng hàm RIÊNG fn_audit_row_change_slim (hàm gốc fn_audit_row_change giữ nguyên) vì hai lý do:
--  1. Cột quá nặng KHÔNG ghi vào audit_log (giữ vĩnh viễn, mỗi lần sửa ghi cả bản trước lẫn sau): finance_sim_runs.snapshot ~30 KB, .watch, finance_bt_runs.summary.
--  2. Cột "nhiễu" do máy chủ / tính lại tự cập nhật (sim-watch ghi watch + watched_at hằng ngày, tính lại NAV ghi nav): một lần UPDATE chỉ đổi các cột này thì BỎ QUA,
--     để không tràn nhật ký. Tham số: TG_ARGV[0] = cột bỏ khỏi bản ghi (phân cách dấu phẩy), TG_ARGV[1] = cột nhiễu.

create or replace function public.fn_audit_row_change_slim()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_drop text[] := coalesce(string_to_array(nullif(TG_ARGV[0], ''), ','), '{}');
  v_noise text[] := coalesce(string_to_array(nullif(TG_ARGV[1], ''), ','), '{}');
  v_old jsonb := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) else null end;
  v_new jsonb := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) else null end;
  v_changed text[];
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_actor_group text;
  v_entity_id text;
begin
  if TG_OP = 'UPDATE' then
    select array_agg(n.key) into v_changed
      from jsonb_each(v_new) n
      where n.value is distinct from (v_old -> n.key) and not (n.key = any (v_noise));
    if v_changed is null then
      return coalesce(NEW, OLD);   -- không đổi gì, hoặc chỉ đổi cột nhiễu
    end if;
  end if;

  select email, group_key into v_actor_email, v_actor_group
    from public.users where auth_user_id = v_actor limit 1;

  v_entity_id := coalesce(
    v_new ->> 'id', v_old ->> 'id',
    case when coalesce(v_new ->> 'symbol', v_old ->> 'symbol') is not null
         then coalesce(v_new ->> 'user_id', v_old ->> 'user_id') || '/' || coalesce(v_new ->> 'symbol', v_old ->> 'symbol') end,
    v_new ->> 'user_id', v_old ->> 'user_id');

  insert into public.audit_log (
    actor_id, actor_email, actor_group_key,
    entity_type, entity_id, operation, source,
    before_data, after_data, changed_fields,
    before_version, after_version, group_key
  ) values (
    v_actor, v_actor_email, v_actor_group,
    TG_TABLE_NAME, v_entity_id, TG_OP, 'trigger',
    v_old - v_drop, v_new - v_drop, v_changed,
    null, null,
    coalesce(v_new ->> 'group_key', v_old ->> 'group_key', v_actor_group)
  );

  return coalesce(NEW, OLD);
end;
$function$;

comment on function public.fn_audit_row_change_slim() is
  'Như fn_audit_row_change nhưng bỏ cột nặng khỏi bản ghi (TG_ARGV[0]) và bỏ qua lần UPDATE chỉ đổi cột nhiễu (TG_ARGV[1]). SECURITY DEFINER: không client nào bỏ qua hay giả người thực hiện.';

do $do$
declare
  r record;
begin
  for r in select * from (values
    ('finance_sim_runs',          'snapshot,watch', 'updated_at,watch,watched_at'),
    ('finance_decisions',         '',               'updated_at'),
    ('finance_bt_runs',           'summary',        ''),
    ('finance_assets',            'data',           'nav,data,updated_at,created_at'),
    ('finance_allocation_targets','',               'updated_at')
  ) as v(tbl, drop_cols, noise_cols)
  loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$s', r.tbl);
    execute format(
      'create trigger trg_audit_%1$s after insert or update or delete on public.%1$s '
      'for each row execute function public.fn_audit_row_change_slim(%2$L, %3$L)', r.tbl, r.drop_cols, r.noise_cols);
  end loop;
end;
$do$;
