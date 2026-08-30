-- ============================================================================
-- Google Calendar OAuth connection storage (Phase E, connection-only round).
-- Applied ONCE against the shared Supabase project (all 3 apps point at the
-- same Postgres database).
--
-- v1 trust model note, stated plainly: this table is client-readable-via-RLS
-- (same pattern as personal_items/personal_sync_files), i.e. NOT a server-side
-- -only vault. A user's own access_token/refresh_token are readable by their
-- own authenticated client session. This mirrors how this app already treats
-- personal data as private-but-client-readable; it is a real tradeoff (a
-- compromised client session, or leaked browser storage on that device,
-- exposes the refresh token) accepted for v1 consistency with the rest of
-- Personal Hub, not hidden.
-- ============================================================================

create table if not exists public.calendar_connections (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider        text not null default 'google',
  access_token    text,
  refresh_token   text,
  expires_at      timestamptz,
  scope           text,
  connected_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, provider)
);

comment on table public.calendar_connections is
  'Google Calendar OAuth token storage (connection only -- no sync logic yet, that is a '
  'separate follow-up round, same "core then completion" split as local-folder-sync). RLS '
  'scoped to auth.uid() exactly like personal_items -- see the trust-model note above.';

alter table public.calendar_connections enable row level security;

drop policy if exists "calendar_connections_owner_all" on public.calendar_connections;
create policy "calendar_connections_owner_all" on public.calendar_connections
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.calendar_connections from anon;
grant select, insert, update, delete on public.calendar_connections to authenticated;
revoke truncate on public.calendar_connections from anon, authenticated;

create or replace function public.calendar_connections_set_updated_at()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

drop trigger if exists calendar_connections_touch_updated_at on public.calendar_connections;
create trigger calendar_connections_touch_updated_at
  before update on public.calendar_connections
  for each row execute function public.calendar_connections_set_updated_at();
