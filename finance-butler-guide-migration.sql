-- Quản gia đọc HƯỚNG DẪN SỬ DỤNG: bảng chỉ mục hướng dẫn (mỗi mục: tên, tóm tắt, từ khoá). Áp dụng MỘT lần lên dự án Supabase dùng chung; chạy lại an toàn.
-- Nội dung do `node scripts/build-guide-web.mjs` sinh từ docs/huong-dan-su-dung.html vào finance-butler-guide-data.sql; sau mỗi lần hướng dẫn đổi / nâng phiên bản thì chạy lại tệp dữ liệu đó (không cần triển khai lại hàm butler).
-- Quyền: mọi người dùng đã đăng nhập ĐỌC được (đó là tài liệu hướng dẫn công khai trong app, không có dữ liệu cá nhân); không ai ghi được từ app (không có chính sách ghi: chỉ migration / service role).

create table if not exists public.butler_guide (
  id text primary key,
  ord integer not null,
  ver text not null,
  n text not null default '',
  t text not null,
  ct text not null default '',
  s text not null default '',
  k jsonb not null default '[]'::jsonb,
  w text not null default '',
  p text
);
alter table public.butler_guide enable row level security;
drop policy if exists "Guide readable by signed-in users" on public.butler_guide;
create policy "Guide readable by signed-in users" on public.butler_guide for select to authenticated using (true);
revoke all on public.butler_guide from anon;
revoke insert, update, delete, truncate on public.butler_guide from authenticated;
grant select on public.butler_guide to authenticated;
