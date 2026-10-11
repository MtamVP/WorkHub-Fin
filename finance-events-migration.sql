-- SỰ KIỆN TRÍCH TỪ TIN THEO MÃ (11/10/2026). Chạy lại an toàn. Chỉ máy chủ (Edge Function insight-sync, service role) ghi; nhóm finance / admin đọc.
-- Mỗi tin trong finance_pit_news đã được gắn mã cổ phiếu; lib/news-events.js nhận ra tin NÓI VỀ VIỆC GÌ (luật từ khoá, không dùng mô hình ngôn ngữ) và insight-sync ghi mỗi (tin, mã, loại sự kiện) một dòng.
-- id = <id tin>|<mã>|<loại> nên chạy lại không nhân đôi. matched = các cụm từ đã khớp (để người đọc thấy vì sao tin bị xếp vào loại đó). direction: 1 tốt, -1 xấu, 0 chưa rõ (gợi ý theo từ ngữ, không phải đánh giá tác động giá).

create table if not exists finance_news_events (
  id text primary key,
  news_id text not null references finance_pit_news(id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,12}$'),
  event_type text not null check (event_type ~ '^[a-z_]{2,30}$'),
  direction smallint not null default 0 check (direction between -1 and 1),
  severity text not null default 'info' check (severity in ('alert', 'watch', 'info')),
  confidence numeric not null default 0.5 check (confidence between 0 and 1),
  matched text[] not null default '{}',
  multi boolean not null default false,
  published_at timestamptz,
  title text not null,
  link text,
  source text,
  created_at timestamptz not null default now()
);
create index if not exists finance_news_events_symbol_idx on finance_news_events (symbol, published_at desc);
create index if not exists finance_news_events_time_idx on finance_news_events (published_at desc);
create index if not exists finance_news_events_sev_idx on finance_news_events (severity, published_at desc) where severity <> 'info';
alter table finance_news_events enable row level security;
drop policy if exists "Finance team can view news events" on finance_news_events;
create policy "Finance team can view news events" on finance_news_events for select using (current_user_group() = any (array['finance','admin']));
