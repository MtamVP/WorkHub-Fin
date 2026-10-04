-- Quy trình nghiên cứu và ý tưởng đầu tư của nhóm (đã áp dụng trên Supabase qua MCP apply_migration "fin_investment_ideas"). Chạy lại an toàn.
-- Đường đi của một ý tưởng: idea -> research -> review (chờ phản biện) -> approved | rejected -> in_portfolio -> closed.
-- Quy tắc chuyển trạng thái nằm ở lib/ideas.js và được kiểm lại ở api.js (RLS chỉ giới hạn ai được ghi dòng nào).

create table if not exists finance_ideas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,        -- tác giả
  symbol text not null,
  title text not null check (length(btrim(title)) >= 3),
  direction text not null default 'long' check (direction in ('long','avoid')),   -- avoid = ý tưởng "tránh/không mua"
  status text not null default 'idea' check (status in ('idea','research','review','approved','rejected','in_portfolio','closed')),
  thesis text,
  catalysts text,
  risks text,
  entry_price numeric check (entry_price is null or entry_price > 0),
  index_at_entry numeric,
  buy_below numeric check (buy_below is null or buy_below > 0),
  target_price numeric check (target_price is null or target_price > 0),
  stop_price numeric check (stop_price is null or stop_price > 0),
  horizon_months int check (horizon_months is null or (horizon_months >= 1 and horizon_months <= 120)),
  conviction int check (conviction is null or (conviction >= 1 and conviction <= 5)),
  valuation jsonb,
  tags text[] not null default '{}',
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references users(id),
  decision_note text,
  closed_at date,
  close_price numeric,
  index_at_close numeric,
  close_reason text check (close_reason is null or close_reason in ('target','stop','thesis_broken','time','other')),
  close_note text,
  status_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists finance_ideas_status_idx on finance_ideas (status, updated_at desc);
create index if not exists finance_ideas_user_idx on finance_ideas (user_id);
create index if not exists finance_ideas_symbol_idx on finance_ideas (symbol);

create table if not exists finance_idea_comments (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references finance_ideas(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null default 'comment' check (kind in ('comment','challenge','answer')),
  text text not null check (length(btrim(text)) >= 1),
  created_at timestamptz not null default now()
);
create index if not exists finance_idea_comments_idea_idx on finance_idea_comments (idea_id, created_at);

create table if not exists finance_idea_votes (
  idea_id uuid not null references finance_ideas(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  vote text not null check (vote in ('for','against','abstain')),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);

alter table finance_ideas enable row level security;
alter table finance_idea_comments enable row level security;
alter table finance_idea_votes enable row level security;

drop policy if exists "Finance team can view ideas" on finance_ideas;
create policy "Finance team can view ideas" on finance_ideas for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own ideas" on finance_ideas;
create policy "Insert own ideas" on finance_ideas for insert
  with check (user_id = current_user_id() and current_user_group() = any (array['finance','admin']));
drop policy if exists "Update ideas" on finance_ideas;
create policy "Update ideas" on finance_ideas for update
  using (current_user_group() = any (array['finance','admin']) and (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'))
  with check (current_user_group() = any (array['finance','admin']) and (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'));
drop policy if exists "Delete ideas" on finance_ideas;
create policy "Delete ideas" on finance_ideas for delete
  using (current_user_group() = any (array['finance','admin']) and (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin'));

drop policy if exists "Finance team can view idea comments" on finance_idea_comments;
create policy "Finance team can view idea comments" on finance_idea_comments for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own idea comments" on finance_idea_comments;
create policy "Insert own idea comments" on finance_idea_comments for insert
  with check (user_id = current_user_id() and current_user_group() = any (array['finance','admin']));
drop policy if exists "Delete own idea comments" on finance_idea_comments;
create policy "Delete own idea comments" on finance_idea_comments for delete
  using (user_id = current_user_id() or current_user_has_fin_role('asset_manager') or current_user_group() = 'admin');

drop policy if exists "Finance team can view idea votes" on finance_idea_votes;
create policy "Finance team can view idea votes" on finance_idea_votes for select using (current_user_group() = any (array['finance','admin']));
drop policy if exists "Insert own idea votes" on finance_idea_votes;
create policy "Insert own idea votes" on finance_idea_votes for insert
  with check (user_id = current_user_id() and current_user_group() = any (array['finance','admin']));
drop policy if exists "Update own idea votes" on finance_idea_votes;
create policy "Update own idea votes" on finance_idea_votes for update
  using (user_id = current_user_id()) with check (user_id = current_user_id());
drop policy if exists "Delete own idea votes" on finance_idea_votes;
create policy "Delete own idea votes" on finance_idea_votes for delete using (user_id = current_user_id());

do $do$
declare t text;
begin
  foreach t in array array['finance_ideas','finance_idea_comments','finance_idea_votes'] loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$s', t);
    execute format('create trigger trg_audit_%1$s after insert or update or delete on public.%1$s for each row execute function public.fn_audit_row_change()', t);
  end loop;
end;
$do$;

-- Chỉ quản lý danh mục / admin được duyệt hoặc bác ý tưởng và ghi các cột quyết định -- ép ở database để không lách được bằng gọi API trực tiếp
-- (auth.uid() rỗng = service role / bảo trì: không chặn).
create or replace function public.fn_finance_ideas_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
declare mgr boolean;
begin
  if public.current_user_id() is null then return new; end if;
  mgr := public.current_user_has_fin_role('asset_manager') or public.current_user_group() = 'admin';
  if tg_op = 'INSERT' then
    if not mgr and (new.status in ('approved','rejected','in_portfolio') or new.decided_by is not null or new.decided_at is not null) then
      raise exception 'Chỉ quản lý danh mục được tạo ý tưởng ở trạng thái đã quyết định.' using errcode = '42501';
    end if;
    return new;
  end if;
  if not mgr then
    if new.status is distinct from old.status and new.status in ('approved','rejected') then
      raise exception 'Chỉ quản lý danh mục được duyệt hoặc bác ý tưởng.' using errcode = '42501';
    end if;
    if new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at or new.decision_note is distinct from old.decision_note then
      raise exception 'Chỉ quản lý danh mục được ghi quyết định duyệt/bác.' using errcode = '42501';
    end if;
    if new.status = 'in_portfolio' and old.status not in ('approved','in_portfolio') then
      raise exception 'Ý tưởng chưa được duyệt nên chưa thể chuyển vào danh mục.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;
drop trigger if exists trg_finance_ideas_guard on public.finance_ideas;
create trigger trg_finance_ideas_guard before insert or update on public.finance_ideas for each row execute function public.fn_finance_ideas_guard();
