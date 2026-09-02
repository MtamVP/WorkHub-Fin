-- ============================================================================
-- Phase C: Org hierarchy (sub-teams / "To") -- visibility + reporting rollup
-- only, additive on top of the existing group_key/member_roles RLS model.
-- Applied ONCE against the shared Supabase project (all 3 apps point at the
-- same Postgres database).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

create table if not exists public.org_units (
  id           uuid primary key default uuid_generate_v4(),
  name         text not null,
  group_key    text not null check (group_key = any (array['finance','science','admin','guest'])),
  parent_id    uuid references public.org_units(id) on delete restrict,
  lead_user_id uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists org_units_group_idx  on public.org_units (group_key);
create index if not exists org_units_parent_idx on public.org_units (parent_id);

comment on table public.org_units is
  'Optional finer-grained "To" (sub-team) layer living INSIDE an existing group_key. '
  'Additive read-visibility and reporting-rollup only -- write permissions remain at '
  'the group_key level via member_roles (Phase B). lead_user_id is descriptive metadata '
  'only, no RLS effect this round.';

alter table public.users    add column if not exists org_unit_id uuid references public.org_units(id) on delete set null;
alter table public.projects add column if not exists org_unit_id uuid references public.org_units(id) on delete set null;

create index if not exists users_org_unit_idx    on public.users (org_unit_id);
create index if not exists projects_org_unit_idx on public.projects (org_unit_id);

-- ---------------------------------------------------------------------------
-- 1.1 Hierarchy-validation trigger (cross-group guard + cycle prevention)
-- Trigger-only -- no legitimate direct-RPC use, EXECUTE revoked below.
-- ---------------------------------------------------------------------------

create or replace function public.org_units_validate_hierarchy()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_parent_group text;
  v_cursor       uuid;
  v_child_count  int;
  v_steps        int := 0;
begin
  -- Can't change group_key while the unit still has children -- their own
  -- parent-group match (validated when THEY were inserted/moved) would be
  -- silently invalidated.
  if tg_op = 'UPDATE' and new.group_key is distinct from old.group_key then
    select count(*) into v_child_count from public.org_units where parent_id = new.id;
    if v_child_count > 0 then
      raise exception 'ORG_UNIT_INVALID: không thể đổi nhóm khi đơn vị còn tổ con -- hãy chuyển hoặc xóa tổ con trước'
        using errcode = '23514';
    end if;
  end if;

  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'ORG_UNIT_INVALID: một tổ không thể là cha của chính nó' using errcode = '22023';
    end if;

    select group_key into v_parent_group from public.org_units where id = new.parent_id;
    if v_parent_group is null then
      raise exception 'ORG_UNIT_INVALID: không tìm thấy đơn vị cha' using errcode = '23503';
    end if;
    if v_parent_group is distinct from new.group_key then
      raise exception 'ORG_UNIT_INVALID: đơn vị cha và đơn vị con phải cùng nhóm (group_key)'
        using errcode = '23514';
    end if;

    -- Cycle prevention: walk up from parent_id; bounded loop (org_units is a
    -- handful of rows -- 1000 is a generous ceiling only a genuine cycle hits).
    v_cursor := new.parent_id;
    while v_cursor is not null and v_steps < 1000 loop
      if v_cursor = new.id then
        raise exception 'ORG_UNIT_INVALID: không thể tạo vòng lặp trong cây tổ chức' using errcode = '22023';
      end if;
      select parent_id into v_cursor from public.org_units where id = v_cursor;
      v_steps := v_steps + 1;
    end loop;
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

revoke execute on function public.org_units_validate_hierarchy() from public, anon, authenticated;

drop trigger if exists trg_org_units_validate_hierarchy on public.org_units;
create trigger trg_org_units_validate_hierarchy
  before insert or update of parent_id, group_key on public.org_units
  for each row execute function public.org_units_validate_hierarchy();

-- ---------------------------------------------------------------------------
-- 2. Descendant-ids + accessor functions (STABLE, modeled on current_user_group())
-- Called from inside RLS predicates -- must stay EXECUTE-able by anon/authenticated.
-- ---------------------------------------------------------------------------

create or replace function public.org_unit_descendant_ids(p_root uuid)
returns table(id uuid)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with recursive tree as (
    select ou.id from public.org_units ou where ou.id = p_root
    union all
    select child.id
      from public.org_units child
      join tree t on child.parent_id = t.id
  )
  select id from tree;
$function$;

create or replace function public.current_user_org_unit_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select org_unit_id from public.users where id = public.current_user_id();
$function$;

create or replace function public.current_user_can_see_org_unit(p_target_unit_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    p_target_unit_id is not null
    and public.current_user_org_unit_id() is not null
    and exists (
      select 1 from public.org_unit_descendant_ids(public.current_user_org_unit_id()) d
      where d.id = p_target_unit_id
    );
$function$;

-- ---------------------------------------------------------------------------
-- 3. RLS changes -- additive OR-branch on the two existing SELECT policies.
-- For any row with org_unit_id IS NULL, current_user_can_see_org_unit(NULL)
-- short-circuits to false, so the predicate reduces to exactly today's
-- behavior -- byte-for-byte unchanged visibility for pre-existing rows.
-- ---------------------------------------------------------------------------

alter policy "View projects in group or shared" on public.projects
  using (
    (group_key = current_user_group())
    or (group_key = 'all')
    or (is_shared = true)
    or (current_user_group() = 'admin')
    or current_user_can_see_org_unit(org_unit_id)
  );

alter policy "Users can view tasks of accessible projects" on public.tasks
  using (
    exists (
      select 1 from projects p
      where p.id = tasks.project_id
        and (
          (p.group_key = current_user_group())
          or (p.group_key = 'all')
          or (p.is_shared = true)
          or (current_user_group() = 'admin')
          or current_user_can_see_org_unit(p.org_unit_id)
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 3.1 RLS on org_units itself. Tree metadata is non-sensitive (comparable to
-- the hardcoded USER_GROUP_LABELS client-side today) -- SELECT is broad;
-- write access mirrors the existing role-at-least-admin pattern.
-- ---------------------------------------------------------------------------

alter table public.org_units enable row level security;

drop policy if exists "org_units_select_all" on public.org_units;
create policy "org_units_select_all" on public.org_units
  for select using (true);

drop policy if exists "org_units_admin_insert" on public.org_units;
create policy "org_units_admin_insert" on public.org_units
  for insert with check (current_user_role_at_least(group_key, 'admin'));

drop policy if exists "org_units_admin_update" on public.org_units;
create policy "org_units_admin_update" on public.org_units
  for update
  using (current_user_role_at_least(group_key, 'admin'))
  with check (current_user_role_at_least(group_key, 'admin'));

drop policy if exists "org_units_admin_delete" on public.org_units;
create policy "org_units_admin_delete" on public.org_units
  for delete using (current_user_role_at_least(group_key, 'admin'));

grant select, insert, update, delete on public.org_units to anon, authenticated;
revoke truncate on public.org_units from anon, authenticated;

drop trigger if exists trg_audit_org_units on public.org_units;
create trigger trg_audit_org_units
  after insert or update or delete on public.org_units
  for each row execute function public.fn_audit_row_change();
