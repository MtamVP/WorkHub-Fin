-- ============================================================================
-- Security hardening pass (Step 0 + Phase A of the enterprise-readiness
-- round-2 roadmap). Applied ONCE against the shared Supabase project (all 3
-- apps point at the same Postgres database).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 0 — close the TRUNCATE hole everywhere.
--
-- TRUNCATE was granted to anon/authenticated on every table in `public`
-- except audit_log/messages/system_logs (hardened in an earlier migration).
-- Postgres RLS cannot restrict TRUNCATE at all -- the only defense is
-- revoking the grant. This has zero functional impact: no application code
-- in any of the 3 apps ever issues TRUNCATE.
-- ----------------------------------------------------------------------------
revoke truncate on all tables in schema public from anon, authenticated;

-- Prevents the hole from silently reappearing on any table created later.
alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Phase A — pin search_path on trigger/helper functions flagged by the
-- linter (function_search_path_mutable). None of these are SECURITY
-- DEFINER, so the real risk is low, but pinning is a cheap, zero-behavior
-- -change hardening fix. Bodies below are copied verbatim from the live
-- definitions -- only `set search_path to 'public'` is added.
--
-- Deliberately NOT touched in this pass: current_user_group() /
-- current_user_has_fin_role() / current_user_has_sci_role() /
-- current_user_id() -- the linter flags these as directly RPC-callable,
-- but they are invoked inside RLS policy predicates across nearly every
-- table for both anon and authenticated sessions. Revoking EXECUTE would
-- break RLS evaluation itself. Reviewed and intentionally left as-is.
-- ----------------------------------------------------------------------------

create or replace function public.increment_tasks_version()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.version := old.version + 1;
  return new;
end;
$function$;

create or replace function public.increment_version()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.version := old.version + 1;
  return new;
end;
$function$;

create or replace function public.personal_items_set_updated_at()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

create or replace function public.personal_sync_files_set_updated_at()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

create or replace function public.recalc_project_percent_for(p_project_id text)
returns void
language plpgsql
set search_path to 'public'
as $function$
declare
  v_total int;
  v_done int;
  v_percent int;
begin
  if p_project_id is null then
    return;
  end if;

  select count(*), count(*) filter (where status = 'Done')
    into v_total, v_done
    from public.tasks
    where project_id = p_project_id and deleted_at is null;

  v_percent := case when v_total > 0 then round((v_done::numeric / v_total) * 100) else 0 end;

  update public.projects set percent = v_percent where id = p_project_id;
end;
$function$;

create or replace function public.trg_recalc_project_percent()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.recalc_project_percent_for(old.project_id);
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.recalc_project_percent_for(new.project_id);
    return new;
  end if;

  if new.project_id is distinct from old.project_id then
    perform public.recalc_project_percent_for(old.project_id);
    perform public.recalc_project_percent_for(new.project_id);
  elsif new.status is distinct from old.status or new.deleted_at is distinct from old.deleted_at then
    perform public.recalc_project_percent_for(new.project_id);
  end if;

  return new;
end;
$function$;

create or replace function public.validate_task_dependencies()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  direct_ids text[];
  blocker_id text;
  visited text[];
  frontier text[];
  next_frontier text[];
  depth int := 0;
  row_blocked_by text;
  parent_ids text[];
  parent_id text;
  blocker_name text;
  unfinished_names text[];
begin
  if new.blocked_by is null or btrim(new.blocked_by) = '' then
    return new;
  end if;

  direct_ids := array(select btrim(x) from unnest(string_to_array(new.blocked_by, ',')) as x where btrim(x) != '');

  if new.id = any(direct_ids) then
    raise exception 'Một công việc không thể tự chặn chính nó.' using errcode = '23514';
  end if;

  frontier := direct_ids;
  visited := direct_ids;
  while depth < 50 and array_length(frontier, 1) > 0 loop
    next_frontier := '{}';
    foreach blocker_id in array frontier loop
      select t.blocked_by into row_blocked_by from public.tasks t
        where t.id = blocker_id and t.deleted_at is null;

      if row_blocked_by is not null and btrim(row_blocked_by) != '' then
        parent_ids := array(select btrim(x) from unnest(string_to_array(row_blocked_by, ',')) as x where btrim(x) != '');
        foreach parent_id in array parent_ids loop
          if parent_id = new.id then
            select t.name into blocker_name from public.tasks t where t.id = blocker_id;
            raise exception 'Không thể đặt phụ thuộc này: sẽ tạo thành vòng lặp. Công việc "%" đang bị chặn ngược lại bởi chính công việc bạn đang sửa.', coalesce(blocker_name, blocker_id) using errcode = '23514';
          end if;
          if not (parent_id = any(visited)) then
            visited := array_append(visited, parent_id);
            next_frontier := array_append(next_frontier, parent_id);
          end if;
        end loop;
      end if;
    end loop;
    frontier := next_frontier;
    depth := depth + 1;
  end loop;

  if new.status = 'Done' then
    select array_agg(coalesce(t.name, t.id)) into unfinished_names
      from public.tasks t
      where t.id = any(direct_ids) and t.deleted_at is null and coalesce(t.status, '') != 'Done';

    if unfinished_names is not null and array_length(unfinished_names, 1) > 0 then
      raise exception 'Không thể đánh dấu Done: còn đang bị chặn bởi "%"', array_to_string(unfinished_names, '", "') using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Manual step (not SQL): enable "Leaked password protection" in the
-- Supabase dashboard -- Authentication -> Policies. Cannot be set via
-- migration.
-- ----------------------------------------------------------------------------
