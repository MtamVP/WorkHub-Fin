-- 09/10/2026 (ĐÃ ÁP DỤNG trên WorkHub-AI): lượt chạy BUỔI SÁNG cho chỉ số và ảnh chụp thị trường.
-- Lý do (đo thật): VNDirect chỉ có chỉ số của ngày D sau 18:20 tối ngày D (lượt 18:20 ngày 08/10 vẫn nhận ngày 07/10) và trước sáng D+1,
-- nên bộ lọc toàn thị trường luôn chậm một phiên. Thêm lượt 8:05 / 8:15 sáng (giờ Việt Nam) thứ Ba đến thứ Bảy; giữ lượt tối như cũ.
-- Dùng lại đúng lệnh (kèm khoá publishable) của job tối nên không lặp khoá trong tệp này.
select cron.schedule('market-ratios-morning', '5 1 * * 2-6', (select command from cron.job where jobname = 'market-ratios-daily'));
select cron.schedule('market-snapshot-morning', '15 1 * * 2-6', (select command from cron.job where jobname = 'market-snapshot-daily'));
