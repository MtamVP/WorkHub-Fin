-- ============================================================================
-- Group-scoped RBAC (Admin/Editor/Viewer) — Phase B of the enterprise-readiness
-- round-2 roadmap. Applied ONCE against the shared Supabase project (all 3 apps
-- point at the same Postgres database) — running it from any single app repo
-- covers all three. Safe to re-run: uses IF NOT EXISTS / OR REPLACE / DROP IF
-- EXISTS / ALTER POLICY guards throughout.
--
-- Default role = editor for anyone with no explicit member_roles row --
-- preserves today's behavior for the entire existing user base; only an
-- explicit admin action moves someone to viewer or promotes to admin.
-- current_user_group() = 'admin' (existing org-wide superuser) always
-- resolves to role 'admin' in every group automatically.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. member_roles table
-- ----------------------------------------------------------------------------
create table if not exists public.member_roles (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references public.users(id) on delete cascade,
  group_key   text not null check (group_key = any (array['finance','science','admin','guest'])),
  role        text not null check (role = any (array['viewer','editor','admin'])),
  granted_by  uuid references public.users(id),
  created_at  timestamptz not null default now(),
  unique (user_id, group_key)
);

create index if not exists member_roles_group_idx on public.member_roles (group_key);
create index if not exists member_roles_user_idx  on public.member_roles (user_id);

comment on table public.member_roles is
  'Per-group RBAC (Phase B). One row per (user, group) with an explicit role. Absence of a row '
  'means the default role, editor -- resolved by current_user_role(), never by querying this table '
  'directly from application code. Mirrors the fin_roles/sci_roles pattern (user_id -> users.id via '
  'current_user_id(), not auth.uid() directly) but keyed by group_key + a fixed 3-role vocabulary '
  'instead of fin/sci''s open-ended named-role vocabulary.';

-- ----------------------------------------------------------------------------
-- 2. Helper functions (mirrors current_user_has_fin_role exactly)
-- ----------------------------------------------------------------------------
create or replace function public.current_user_role(p_group_key text)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case
    when public.current_user_group() = 'admin' then 'admin'
    else coalesce(
      (select role from public.member_roles
        where user_id = public.current_user_id() and group_key = p_group_key
        limit 1),
      'editor'
    )
  end;
$function$;

comment on function public.current_user_role(text) is
  'Resolves the caller''s effective role for a given group_key. Org-wide superusers '
  '(current_user_group() = admin) always resolve to admin, in every group. Absent any explicit '
  'member_roles row, defaults to editor -- preserves pre-Phase-B behavior for the entire existing '
  'user base on rollout.';

create or replace function public.current_user_role_at_least(p_group_key text, p_min_role text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case public.current_user_role(p_group_key)
    when 'admin' then true
    when 'editor' then p_min_role in ('editor', 'viewer')
    when 'viewer' then p_min_role = 'viewer'
    else false
  end;
$function$;

-- ----------------------------------------------------------------------------
-- 3. Self-lockout / self-escalation guard trigger
-- ----------------------------------------------------------------------------
create or replace function public.member_roles_guard_self_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_acting_user uuid := public.current_user_id();
  v_other_admins int;
begin
  -- Org-wide superusers are exempt, mirroring prevent_self_group_key_escalation's own
  -- current_user_group() = 'admin' bypass.
  if public.current_user_group() = 'admin' then
    return coalesce(new, old);
  end if;

  -- Self-escalation guard: defense-in-depth (RLS's current_user_role_at_least(group_key,
  -- 'admin') write-gate already makes this structurally unreachable for anyone who isn't
  -- already a group admin) -- makes the intent explicit and future-proofs against a
  -- looser RLS predicate later.
  if tg_op in ('INSERT', 'UPDATE') and new.user_id = v_acting_user and new.role = 'admin'
     and (tg_op = 'INSERT' or old.role is distinct from new.role) then
    raise exception 'PERMISSION_DENIED: cannot grant yourself the admin role' using errcode = '42501';
  end if;

  -- Self-lockout guard: block only if demoting/removing self would leave the group with
  -- zero remaining admins.
  if old.user_id = v_acting_user and old.role = 'admin'
     and ((tg_op = 'DELETE') or (tg_op = 'UPDATE' and new.role is distinct from old.role)) then
    select count(*) into v_other_admins
      from public.member_roles
      where group_key = old.group_key and role = 'admin' and user_id <> v_acting_user;
    if v_other_admins = 0 then
      raise exception 'PERMISSION_DENIED: cannot remove your own admin role -- you are the last admin of group %', old.group_key
        using errcode = '42501';
    end if;
  end if;

  return coalesce(new, old);
end;
$function$;

drop trigger if exists trg_member_roles_guard_self_change on public.member_roles;
create trigger trg_member_roles_guard_self_change
  before insert or update or delete on public.member_roles
  for each row execute function public.member_roles_guard_self_change();

-- ----------------------------------------------------------------------------
-- 4. RLS on member_roles
-- ----------------------------------------------------------------------------
alter table public.member_roles enable row level security;

drop policy if exists "member_roles_group_select" on public.member_roles;
create policy "member_roles_group_select" on public.member_roles
  for select using (group_key = current_user_group() or current_user_group() = 'admin');

drop policy if exists "member_roles_admin_insert" on public.member_roles;
create policy "member_roles_admin_insert" on public.member_roles
  for insert with check (current_user_role_at_least(group_key, 'admin'));

drop policy if exists "member_roles_admin_update" on public.member_roles;
create policy "member_roles_admin_update" on public.member_roles
  for update
  using (current_user_role_at_least(group_key, 'admin'))
  with check (current_user_role_at_least(group_key, 'admin'));

drop policy if exists "member_roles_admin_delete" on public.member_roles;
create policy "member_roles_admin_delete" on public.member_roles
  for delete using (current_user_role_at_least(group_key, 'admin'));

grant select, insert, update, delete on public.member_roles to anon, authenticated;
revoke truncate on public.member_roles from anon, authenticated;

drop trigger if exists trg_audit_member_roles on public.member_roles;
create trigger trg_audit_member_roles
  after insert or update or delete on public.member_roles
  for each row execute function public.fn_audit_row_change();

-- ----------------------------------------------------------------------------
-- 5. RLS changes on the 5 core work-management tables -- ALTER POLICY on the
-- exact live policy names, ANDing a role check onto the existing predicate.
-- Nothing renamed, nothing rewritten beyond the added AND clause.
-- ----------------------------------------------------------------------------

-- projects: DELETE needs admin, INSERT/UPDATE need editor
alter policy "Delete projects in own group" on public.projects
  using ((group_key = current_user_group() or current_user_group() = 'admin')
         and current_user_role_at_least(group_key, 'admin'));

alter policy "Insert projects in own group" on public.projects
  with check ((group_key = current_user_group() or current_user_group() = 'admin')
              and current_user_role_at_least(group_key, 'editor'));

alter policy "Update projects in own group" on public.projects
  using ((group_key = current_user_group() or current_user_group() = 'admin')
         and current_user_role_at_least(group_key, 'editor'))
  with check ((group_key = current_user_group() or current_user_group() = 'admin')
              and current_user_role_at_least(group_key, 'editor'));

-- tasks: role check added inside the existing EXISTS, against the parent project's group_key
alter policy "Delete tasks of their group projects" on public.tasks
  using (exists (
    select 1 from projects p
    where p.id = tasks.project_id
      and (p.group_key = current_user_group() or p.group_key = 'all' or current_user_group() = 'admin')
      and current_user_role_at_least(p.group_key, 'editor')
  ));

alter policy "Insert tasks of their group projects" on public.tasks
  with check (exists (
    select 1 from projects p
    where p.id = tasks.project_id
      and (p.group_key = current_user_group() or p.group_key = 'all' or current_user_group() = 'admin')
      and current_user_role_at_least(p.group_key, 'editor')
  ));

alter policy "Update tasks of their group projects" on public.tasks
  using (exists (
    select 1 from projects p
    where p.id = tasks.project_id
      and (p.group_key = current_user_group() or p.group_key = 'all' or current_user_group() = 'admin')
      and current_user_role_at_least(p.group_key, 'editor')
  ))
  with check (exists (
    select 1 from projects p
    where p.id = tasks.project_id
      and (p.group_key = current_user_group() or p.group_key = 'all' or current_user_group() = 'admin')
      and current_user_role_at_least(p.group_key, 'editor')
  ));

-- events: personal-event-owner carve-out preserved untouched, editor check ANDed at top level
alter policy "Delete events in group, personal only to owner" on public.events
  using (((group_key = current_user_group()) or (current_user_group() = 'admin'))
         and ((calendar_type is distinct from 'personal') or (created_by = (auth.jwt() ->> 'email')))
         and current_user_role_at_least(group_key, 'editor'));

alter policy "Insert events in own group" on public.events
  with check (((group_key = current_user_group()) or (current_user_group() = 'admin'))
              and current_user_role_at_least(group_key, 'editor'));

alter policy "Update events in group, personal only to owner" on public.events
  using (((group_key = current_user_group()) or (current_user_group() = 'admin'))
         and ((calendar_type is distinct from 'personal') or (created_by = (auth.jwt() ->> 'email')))
         and current_user_role_at_least(group_key, 'editor'))
  with check (((group_key = current_user_group()) or (current_user_group() = 'admin'))
              and ((calendar_type is distinct from 'personal') or (created_by = (auth.jwt() ->> 'email')))
              and current_user_role_at_least(group_key, 'editor'));

-- files
alter policy "Delete files in own group" on public.files
  using ((group_key = current_user_group() or current_user_group() = 'admin')
         and current_user_role_at_least(group_key, 'editor'));

alter policy "Insert files in own group" on public.files
  with check ((group_key = current_user_group() or current_user_group() = 'admin')
              and current_user_role_at_least(group_key, 'editor'));

alter policy "Update files in own group" on public.files
  using ((group_key = current_user_group() or current_user_group() = 'admin')
         and current_user_role_at_least(group_key, 'editor'))
  with check ((group_key = current_user_group() or current_user_group() = 'admin')
              and current_user_role_at_least(group_key, 'editor'));

-- project_milestones: role check added inside the existing EXISTS
alter policy "Delete milestones of own group projects" on public.project_milestones
  using (exists (
    select 1 from projects p
    where p.id = project_milestones.project_id
      and (p.group_key = current_user_group() or current_user_group() = 'admin')
      and current_user_role_at_least(p.group_key, 'editor')
  ));

alter policy "Insert milestones of own group projects" on public.project_milestones
  with check (exists (
    select 1 from projects p
    where p.id = project_milestones.project_id
      and (p.group_key = current_user_group() or current_user_group() = 'admin')
      and current_user_role_at_least(p.group_key, 'editor')
  ));

alter policy "Update milestones of own group projects" on public.project_milestones
  using (exists (
    select 1 from projects p
    where p.id = project_milestones.project_id
      and (p.group_key = current_user_group() or current_user_group() = 'admin')
      and current_user_role_at_least(p.group_key, 'editor')
  ))
  with check (exists (
    select 1 from projects p
    where p.id = project_milestones.project_id
      and (p.group_key = current_user_group() or current_user_group() = 'admin')
      and current_user_role_at_least(p.group_key, 'editor')
  ));

-- ----------------------------------------------------------------------------
-- 6. v1 scope, deliberately NOT gated by role at the RLS layer (unchanged from
-- pre-Phase-B behavior -- anyone in the group, regardless of role, can still do
-- these; app-layer also has no cosmetic gate for them):
--   - task_assignees, task_comments (assignment/commenting stays open to all)
--   - archive/restore project (setArchived), share project (is_shared flag)
--   - personal_items, personal_sync_files (private per-user data, role-irrelevant)
-- These may get role gates in a later round if the need shows up; not built now.
-- ----------------------------------------------------------------------------
