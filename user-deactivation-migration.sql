-- ============================================================================
-- User deactivation (soft-disable in place of hard DELETE on public.users) --
-- enterprise-readiness round-2 roadmap. Applied ONCE against the shared
-- Supabase project (all 3 apps point at the same Postgres database) --
-- running it from any single app repo covers all three. Safe to re-run:
-- IF NOT EXISTS / OR REPLACE / DROP IF EXISTS guards throughout.
--
-- Mirrors the exact shape of trg_prevent_self_group_key_escalation (see
-- rbac-migration.sql / live DB): the "Admin or self can update users" UPDATE
-- policy is row-scoped, not column-scoped, so a non-admin's self-UPDATE
-- (used today for nickname/wallpaper self-editing) could otherwise also
-- smuggle in an `active` flip. A BEFORE UPDATE trigger comparing old/new is
-- the only way to block that column specifically while leaving the rest of
-- self-editing untouched -- same reason the group_key guard exists.
--
-- Applied live 2026-09-02 against project gqsbsqaxzpzcloaopzvv, verified via
-- Supabase MCP (column + trigger both confirmed present). This file is kept
-- here for documentation/version-control parity with rbac-migration.sql /
-- org-hierarchy-migration.sql / audit-log-migration.sql, which follow the
-- same "one canonical migration, copied byte-identical into all 3 repos"
-- convention.
-- ============================================================================

alter table public.users add column if not exists active boolean not null default true;

comment on column public.users.active is
  'Soft-disable flag, replaces hard DELETE from public.users. false = account is '
  'deactivated: blocked from logging in by app-layer checks in index.html / '
  'script.js (RLS itself does not gate SELECT on this -- "Anyone can view users" '
  'stays unchanged so the login-gate check itself can read the flag). Only an '
  'admin (current_user_group() = admin) may change this column -- see '
  'trg_prevent_self_active_change below.';

create or replace function public.prevent_self_active_change()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.active is distinct from old.active then
    if current_user_group() <> 'admin' then
      raise exception 'PERMISSION_DENIED: only admin can change active status' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_prevent_self_active_change on public.users;
create trigger trg_prevent_self_active_change
  before update on public.users
  for each row execute function public.prevent_self_active_change();
