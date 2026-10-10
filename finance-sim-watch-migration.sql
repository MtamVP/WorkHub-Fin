-- 10/10/2026: ĐÃ ÁP DỤNG trên WorkHub-AI (cột watch, watched_at; cron sim-watch-daily và sim-watch-morning).
-- Market Simulation đợt 4 (10/10/2026): hàm sim-watch (cron) chấm điểm nhật ký mô phỏng phía máy chủ, cập nhật cây sống, gợi ý sự kiện từ tin và nhắc khi tới mốc.
-- watch: trạng thái do máy chủ ghi (lib/sim-watch.js digest: từng mốc, cây sống, mốc đã báo "notified", gợi ý AI "hints"); trang chỉ đọc. watched_at: lần cuối máy chủ chấm.
-- Ghi bằng service role (bỏ qua RLS). Chạy lại an toàn.
alter table finance_sim_runs add column if not exists watch jsonb not null default '{}'::jsonb;
alter table finance_sim_runs add column if not exists watched_at timestamptz;

-- Lịch: tối 18:55 (sau ảnh chụp thị trường, có AI đọc tin) và sáng 8:25 giờ Việt Nam (VN-Index của ngày trước thường chỉ đủ vào sáng hôm sau; không gọi AI).
-- Dùng lại lệnh (kèm khoá publishable) của job valuation-watch-daily, chỉ đổi tên hàm và body, nên không lặp khoá trong tệp này.
select cron.schedule('sim-watch-daily', '55 11 * * 1-5',
  replace(replace((select command from cron.job where jobname = 'valuation-watch-daily'), 'valuation-watch', 'sim-watch'), '''{}''::jsonb, timeout_milliseconds := 60000', '''{"news":true}''::jsonb, timeout_milliseconds := 150000'));
select cron.schedule('sim-watch-morning', '25 1 * * 2-6',
  replace(replace((select command from cron.job where jobname = 'valuation-watch-daily'), 'valuation-watch', 'sim-watch'), 'timeout_milliseconds := 60000', 'timeout_milliseconds := 120000'));
