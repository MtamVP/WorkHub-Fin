-- Google Calendar: đồng bộ 2 CHIỀU (WorkHub <-> Google), đợt 3 (nối tiếp
-- google-calendar-sync-migration.sql -- đợt "chỉ kéo về"). Applied ONCE against the shared
-- Supabase project (gqsbsqaxzpzcloaopzvv) -- 3 app dùng chung 1 Postgres.
--
-- Bảng bookkeeping RIÊNG cho trạng thái đồng bộ, tách khỏi bảng events -- KHÔNG được gộp
-- chung: events có trigger trg_increment_events_version tăng version VÔ ĐIỀU KIỆN trên mọi
-- UPDATE. Nếu lưu synced_version/google_updated_at ngay trên dòng events, mỗi lần ghi xong
-- bookkeeping ("đã đồng bộ dòng này rồi") sẽ TỰ làm version tăng thêm 1 -- khiến lần đồng bộ
-- kế tiếp luôn thấy "version > synced_version" dù không ai thực sự sửa nội dung gì, gây đẩy/
-- kéo lặp vô ích vĩnh viễn. Tách bảng khiến việc ghi bookkeeping không đụng tới events nữa,
-- nên không kích hoạt trigger đó.
create table if not exists public.calendar_google_sync (
  event_id text primary key references public.events(id) on delete cascade,
  google_event_id text not null,
  synced_version integer not null,
  google_updated_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists calendar_google_sync_google_event_id_idx on public.calendar_google_sync(google_event_id);

alter table public.calendar_google_sync enable row level security;

-- Chủ sở hữu event mới đọc/ghi được dòng bookkeeping tương ứng -- đối chiếu qua
-- events.created_by = auth.jwt() ->> 'email', ĐÚNG cách events' RLS tự dùng (không join qua
-- public.users.id = auth.uid() -- users.id không phải cùng giá trị với auth.uid() trong
-- schema này, users có auth_user_id RIÊNG mới là khoá ngoại thật tới auth.users).
create policy "calendar_google_sync_owner_all" on public.calendar_google_sync
  for all
  using (
    exists (
      select 1 from public.events e
      where e.id = calendar_google_sync.event_id
        and e.created_by = (auth.jwt() ->> 'email')
    )
  )
  with check (
    exists (
      select 1 from public.events e
      where e.id = calendar_google_sync.event_id
        and e.created_by = (auth.jwt() ->> 'email')
    )
  );
