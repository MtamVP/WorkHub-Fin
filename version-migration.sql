-- Chạy 1 lần trong Supabase SQL Editor (project gqsbsqaxzpzcloaopzvv), dùng chung cho cả 3 app.
alter table public.projects add column if not exists version integer not null default 1;
alter table public.events add column if not exists version integer not null default 1;
alter table public.project_milestones add column if not exists version integer not null default 1;

create or replace function public.increment_version()
returns trigger
language plpgsql
as $function$
begin
  new.version := old.version + 1;
  return new;
end;
$function$;

drop trigger if exists trg_increment_projects_version on public.projects;
create trigger trg_increment_projects_version before update on public.projects
  for each row execute function public.increment_version();

drop trigger if exists trg_increment_events_version on public.events;
create trigger trg_increment_events_version before update on public.events
  for each row execute function public.increment_version();

drop trigger if exists trg_increment_project_milestones_version on public.project_milestones;
create trigger trg_increment_project_milestones_version before update on public.project_milestones
  for each row execute function public.increment_version();
