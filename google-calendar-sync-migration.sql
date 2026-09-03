-- ============================================================================
-- Google Calendar sync (đợt 2, sau đợt "chỉ kết nối" -- calendar_connections
-- đã có sẵn từ trước). Applied ONCE against the shared Supabase project (all
-- 3 apps point at the same Postgres database) -- running it from any single
-- app repo covers all three. Safe to re-run: IF NOT EXISTS guards throughout.
--
-- google_event_id + unique index cho phép upsert idempotent mỗi lần đồng bộ
-- (onConflict: 'google_event_id' trong api.js's upsertGoogleEvents). source
-- phân biệt sự kiện tự tạo trong WorkHub ('workhub', mặc định -- không đổi
-- hành vi/dữ liệu cũ nào) với sự kiện kéo về từ Google ('google') -- dùng để
-- ẩn nút sửa/xoá phía UI (scope OAuth chỉ readonly, sửa/xoá cục bộ sẽ không
-- đẩy ngược lên Google được) và để pruneGoogleEvents biết chỉ dọn đúng
-- những dòng do chính tính năng này tạo ra.
--
-- Không cần đổi RLS -- các cột mới không nằm trong điều kiện policy nào của
-- bảng events/calendar_connections (xem rls_policies_events_files /
-- rbac_events_policies).
--
-- Applied live 2026-09-03 against project gqsbsqaxzpzcloaopzvv, verified via
-- Supabase MCP (cả 3 cột + unique index đã xác nhận có mặt). File này giữ
-- lại để tài liệu hoá/đồng bộ version-control với rbac-migration.sql /
-- org-hierarchy-migration.sql / user-deactivation-migration.sql, theo đúng
-- convention "one canonical migration, copied byte-identical into all 3
-- repos" đã dùng cho mọi migration trước đó.
-- ============================================================================

alter table public.events add column if not exists google_event_id text;
alter table public.events add column if not exists source text default 'workhub';

create unique index if not exists events_google_event_id_uq
  on public.events (google_event_id) where google_event_id is not null;

alter table public.calendar_connections add column if not exists last_synced_at timestamptz;

comment on column public.events.google_event_id is
  'ID gốc của sự kiện bên Google Calendar (chỉ có ở sự kiện source=''google''). '
  'Khoá upsert idempotent -- mỗi lần đồng bộ ghi đè đúng dòng cũ thay vì tạo trùng.';
comment on column public.events.source is
  '''workhub'' (mặc định, sự kiện tự tạo trong app) hoặc ''google'' (kéo về từ '
  'Google Calendar, chỉ đọc -- UI ẩn nút sửa/xoá cho loại này).';
comment on column public.calendar_connections.last_synced_at is
  'Lần cuối syncGoogleCalendarEvents() chạy thành công -- hiện ở panel Tích hợp, '
  'cũng dùng để initCalendarAutoSync() quyết định có cần tự đồng bộ lại hay chưa.';
