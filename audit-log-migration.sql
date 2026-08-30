-- ============================================================================
-- Organization-level audit log (Phase 1 of the enterprise-readiness track)
-- Applied ONCE against the shared Supabase project (all 3 apps: wh-fin/wh-sci/wh-org
-- point at the same Postgres database) — running it from any single app repo covers
-- all three. Safe to re-run: uses IF NOT EXISTS / OR REPLACE / DROP IF EXISTS guards.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. audit_log table
-- ----------------------------------------------------------------------------
create table if not exists public.audit_log (
  id              uuid primary key default gen_random_uuid(),
  occurred_at     timestamptz not null default now(),

  -- WHO — captured server-side inside the trigger via auth.uid(), never trusted from client row data
  actor_id        uuid,
  actor_email     text,               -- denormalized snapshot, survives later user rename/delete
  actor_group_key text,

  -- WHAT
  entity_type     text not null,      -- table name for trigger rows; app-level noun for client rows
  entity_id       text,
  operation       text not null check (operation in ('INSERT','UPDATE','DELETE')),
  action          text,               -- dispatcher action name, client-driven rows only (see §5 below)
  source          text not null check (source in ('trigger','client')),

  -- DETAIL / reconstruction
  before_data     jsonb,              -- OLD row (UPDATE/DELETE), null on INSERT
  after_data      jsonb,              -- NEW row (INSERT/UPDATE), null on DELETE
  changed_fields  text[],             -- top-level key diff, UPDATE only
  before_version  integer,
  after_version   integer,

  -- CONTEXT / filtering
  group_key       text,
  trace_id        text,               -- client-driven rows only; trigger rows can't see the dispatcher's trace_id
  result          text not null default 'success' check (result in ('success','error')),
  error_message   text,
  summary         text
);

create index if not exists audit_log_occurred_at_idx on public.audit_log (occurred_at desc);
create index if not exists audit_log_actor_idx        on public.audit_log (actor_id);
create index if not exists audit_log_entity_idx        on public.audit_log (entity_type, entity_id);
create index if not exists audit_log_group_idx         on public.audit_log (group_key);

comment on table public.audit_log is
  'Compliance-grade change trail. Append-only: no UPDATE/DELETE policy is defined below, so writes '
  'from anon/authenticated are permanently insert-only. Retained indefinitely by design (unlike '
  'system_logs, which stays on a bounded retention window — see the retention section at the bottom '
  'of this file). Populated primarily by DB triggers (source=''trigger''), with a narrow client-driven '
  'fallback (source=''client'') for actions with no single mutated row.';

-- ----------------------------------------------------------------------------
-- 2. Generic trigger function
-- ----------------------------------------------------------------------------
create or replace function public.fn_audit_row_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old jsonb := case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) else null end;
  v_new jsonb := case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) else null end;
  v_changed text[];
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_actor_group text;
  v_entity_id text;
begin
  if TG_OP = 'UPDATE' then
    select array_agg(key) into v_changed
      from jsonb_each(v_new) n
      where n.value is distinct from (v_old -> n.key);

    -- Noise control: a bare reorder/touch (only sort_order and/or updated_at changed)
    -- carries no compliance value and would otherwise flood the log on every drag-reorder.
    if v_changed is not null and v_changed <@ array['sort_order','updated_at'] then
      return coalesce(NEW, OLD);
    end if;
  end if;

  select email, group_key into v_actor_email, v_actor_group
    from public.users where auth_user_id = v_actor limit 1;

  v_entity_id := coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'user_id', v_old ->> 'user_id');

  insert into public.audit_log (
    actor_id, actor_email, actor_group_key,
    entity_type, entity_id, operation, source,
    before_data, after_data, changed_fields,
    before_version, after_version, group_key
  ) values (
    v_actor, v_actor_email, v_actor_group,
    TG_TABLE_NAME, v_entity_id, TG_OP, 'trigger',
    v_old, v_new, v_changed,
    nullif(v_old ->> 'version','')::int, nullif(v_new ->> 'version','')::int,
    coalesce(v_new ->> 'group_key', v_old ->> 'group_key')
  );

  return coalesce(NEW, OLD);
end;
$function$;

comment on function public.fn_audit_row_change() is
  'SECURITY DEFINER, owned by postgres -> bypasses RLS/grants on audit_log, so no client code path '
  '(current or future, in any of the 3 apps) can skip an audit write or forge a different actor. '
  'auth.uid() is read server-side at execution time, never from row data.';

-- ----------------------------------------------------------------------------
-- 3. Attach triggers
--
-- Covered in this pass (matches the approved plan's named list, "finance transaction
-- tables" resolved to the 3 true transaction/record tables): tasks, projects, events,
-- project_milestones, messages, users, fin_roles, finance_transactions,
-- finance_cash_flows, finance_corporate_actions.
--
-- Deliberately NOT covered (documented exclusions, not oversights):
--   - user_status        : high-frequency presence pings, zero compliance value.
--   - personal_items,
--     personal_sync_files: private per-user data; a generic admin-visible audit trail
--                           would leak private note/file content to the audit viewer.
--   - lounge_players      : unrelated minigame/break-room feature, zero compliance value.
--   - storage.objects (file bytes): the row-level change to tasks.attachments (which file
--                           record was added/removed) is already captured by the tasks
--                           trigger; auditing raw bucket byte deletes is a separate, larger
--                           lift given the app's dual-bucket setup and is left for later.
--
-- NOT yet covered but plausible follow-up candidates (kept out of this pass to match
-- what was reviewed/approved, not silently expanded): task_comments, task_assignees,
-- files, app_settings, sci_roles, sci_journals, finance_assets, finance_notes,
-- finance_stocks, and the computed/imported market-data tables (finance_nav_history,
-- finance_holdings_price, finance_stock_valuations, finance_benchmark_prices — likely
-- populated by scheduled recompute/import jobs, high row-churn, low audit value, same
-- reasoning as the sort_order/updated_at noise-control rule above).
-- ----------------------------------------------------------------------------

do $do$
declare
  t text;
begin
  foreach t in array array[
    'tasks','projects','events','project_milestones','messages','users',
    'fin_roles','finance_transactions','finance_cash_flows','finance_corporate_actions'
  ]
  loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$s', t);
    execute format(
      'create trigger trg_audit_%1$s after insert or update or delete on public.%1$s '
      'for each row execute function public.fn_audit_row_change()', t
    );
  end loop;
end;
$do$;

-- ----------------------------------------------------------------------------
-- 4. RLS
-- ----------------------------------------------------------------------------
alter table public.audit_log enable row level security;

drop policy if exists "audit_log_admin_select" on public.audit_log;
create policy "audit_log_admin_select" on public.audit_log
  for select using (current_user_group() = 'admin');

drop policy if exists "audit_log_client_insert_own" on public.audit_log;
create policy "audit_log_client_insert_own" on public.audit_log
  for insert with check (source = 'client' and actor_id = auth.uid());

-- No UPDATE/DELETE policy is defined at all -> default deny for anon/authenticated.
-- Trigger inserts run as SECURITY DEFINER (owned by postgres) and bypass RLS entirely,
-- so they don't need (and must not get) an insert policy of their own.

-- ----------------------------------------------------------------------------
-- 5. Grants / tamper-resistance hardening
-- ----------------------------------------------------------------------------
revoke all on public.audit_log from anon, authenticated;
grant select, insert on public.audit_log to authenticated;   -- RLS still gates both of these

-- Pre-existing hole, found while building this feature, fixed here as a bundled but
-- INDEPENDENT remediation (not something the new feature introduced): system_logs and
-- messages currently grant TRUNCATE (and system_logs also grants UPDATE/DELETE at the
-- privilege level, only blocked today by the absence of an RLS policy for those verbs)
-- to anon/authenticated. Any client could currently wipe the entire operational log.
revoke update, delete, truncate on public.system_logs from anon, authenticated;
revoke truncate on public.messages from anon, authenticated;

-- ============================================================================
-- Retention (separate concern from the table/trigger/RLS work above — apply after
-- confirming the above succeeded; safe to skip/retry independently)
-- ============================================================================
-- audit_log: indefinite retention by design (the compliance record) — no cleanup job.
-- system_logs: still backs the live "task history" UI feature (API.task.getHistory),
-- so it can't be dropped, only bounded. Recommended: 180 days.
--
-- pg_cron is available on this project (checked: not yet installed, default_version
-- 1.6.4) but installing/scheduling it is applied as a separate migration step so a
-- failure here (e.g. plan-tier restrictions) never blocks the audit_log rollout above.
-- If it fails, fall back to running this manually, periodically, via the SQL Editor:
--
--   delete from public.system_logs where created_at < now() - interval '180 days';
--
-- create extension if not exists pg_cron;
-- select cron.schedule(
--   'cleanup_system_logs',
--   '0 3 1 * *',  -- monthly, 03:00 UTC on the 1st
--   $$delete from public.system_logs where created_at < now() - interval '180 days'$$
-- );
