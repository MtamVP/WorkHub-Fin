-- Personal Hub: a single, flexible per-user table shared across wh-fin / wh-sci / wh-org.
-- Run once in the Supabase SQL Editor for project gqsbsqaxzpzcloaopzvv.
-- Not gated by group_key — visible only to its owning user (auth.uid()), synced across
-- that user's devices and readable identically from all 3 apps since they share one project.

create table if not exists public.personal_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type text not null,           -- 'note' | 'pin' | 'saved_view' | 'checklist' | 'shortcut' | 'pref'
  title text,
  data jsonb not null default '{}'::jsonb,
  pinned boolean not null default false,
  archived boolean not null default false,
  source_app text,              -- 'fin' | 'sci' | 'org' — display only, never used to filter
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists personal_items_user_type_idx
  on public.personal_items (user_id, type)
  where not archived;

alter table public.personal_items enable row level security;

drop policy if exists "personal_items_select_own" on public.personal_items;
create policy "personal_items_select_own" on public.personal_items
  for select using (user_id = auth.uid());

drop policy if exists "personal_items_insert_own" on public.personal_items;
create policy "personal_items_insert_own" on public.personal_items
  for insert with check (user_id = auth.uid());

drop policy if exists "personal_items_update_own" on public.personal_items;
create policy "personal_items_update_own" on public.personal_items
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "personal_items_delete_own" on public.personal_items;
create policy "personal_items_delete_own" on public.personal_items
  for delete using (user_id = auth.uid());

-- keep updated_at fresh on every write
create or replace function public.personal_items_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists personal_items_touch_updated_at on public.personal_items;
create trigger personal_items_touch_updated_at
  before update on public.personal_items
  for each row execute function public.personal_items_set_updated_at();

alter publication supabase_realtime add table public.personal_items;
