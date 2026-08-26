-- Personal Hub v2: tags, private calendar (rides personal_items), and local-folder-sync
-- bookkeeping + private storage bucket. Run once in the Supabase SQL Editor for project
-- gqsbsqaxzpzcloaopzvv, after personal_items.sql has already been applied.

-- Tags: cross-cutting across every Personal Hub item type (notes/pins/checklist/shortcuts/
-- calendar events/prefs all share this one column).
alter table public.personal_items add column if not exists tags text[] not null default '{}'::text[];
create index if not exists personal_items_tags_idx on public.personal_items using gin (tags);

-- Local-folder sync bookkeeping — a dedicated table (needs unique lookup by relative_path
-- and hash comparison, a different access pattern than the jsonb-blob personal_items rows).
create table if not exists public.personal_sync_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  relative_path text not null,
  content_hash text,
  size bigint,
  remote_updated_at timestamptz,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, relative_path)
);

alter table public.personal_sync_files enable row level security;

drop policy if exists "personal_sync_files_owner_all" on public.personal_sync_files;
create policy "personal_sync_files_owner_all" on public.personal_sync_files
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.personal_sync_files_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists personal_sync_files_touch_updated_at on public.personal_sync_files;
create trigger personal_sync_files_touch_updated_at
  before update on public.personal_sync_files
  for each row execute function public.personal_sync_files_set_updated_at();

alter publication supabase_realtime add table public.personal_sync_files;

-- Private storage bucket for synced local files — owner-only via folder-prefix RLS
-- (standard Supabase pattern: first path segment must equal the caller's auth.uid()).
insert into storage.buckets (id, name, public)
values ('personal_files', 'personal_files', false)
on conflict (id) do nothing;

drop policy if exists "personal_files_owner_select" on storage.objects;
create policy "personal_files_owner_select" on storage.objects for select
  using (bucket_id = 'personal_files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "personal_files_owner_insert" on storage.objects;
create policy "personal_files_owner_insert" on storage.objects for insert
  with check (bucket_id = 'personal_files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "personal_files_owner_update" on storage.objects;
create policy "personal_files_owner_update" on storage.objects for update
  using (bucket_id = 'personal_files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "personal_files_owner_delete" on storage.objects;
create policy "personal_files_owner_delete" on storage.objects for delete
  using (bucket_id = 'personal_files' and (storage.foldername(name))[1] = auth.uid()::text);
