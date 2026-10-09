// Logic thuần: KIỂM TRA VÀ CÀI BẢN CẬP NHẬT ỨNG DỤNG từ menu tài khoản (giao diện ở updater.js). Gồm so sánh phiên bản, lời báo kết quả, tiến độ tải, rút gọn ghi chú phát hành,
// đổi lỗi kỹ thuật của bộ cập nhật Tauri sang câu người dùng hiểu, và quyết định khi nào nên tự kiểm tra ngầm lại. KHÔNG đụng DOM/mạng/Tauri.
// Nạp bằng thẻ <script> thường (global UpdateCheck) và module.exports cho Vitest.
const UpdateCheck = (function () {
  const parts = (v) => String(v === null || v === undefined ? '' : v).trim().replace(/^v/i, '').split('-')[0].split('.').map((x) => { const n = parseInt(x, 10); return isFinite(n) ? n : 0; });
  // So phiên bản kiểu số.số.số (bỏ chữ v đầu và phần sau dấu gạch): -1 nếu a < b, 0 nếu bằng, 1 nếu a > b. Thiếu số coi là 0 (0.1 == 0.1.0).
  function compareVersions(a, b) {
    const x = parts(a), y = parts(b), n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) { const p = x[i] || 0, q = y[i] || 0; if (p !== q) return p < q ? -1 : 1; }
    return 0;
  }
  const plainVer = (v) => String(v === null || v === undefined ? '' : v).trim().replace(/^v/i, '');
  // Kết quả một lần kiểm tra: update = đối tượng bản cập nhật của Tauri (có .version, .body) hoặc null. Bản "mới" phải thật sự CAO HƠN bản đang chạy (nguồn có thể trả đúng bản cũ).
  function describeResult(current, update) {
    const cur = plainVer(current);
    if (update && update.version && compareVersions(update.version, cur) > 0) {
      return { kind: 'available', version: plainVer(update.version), headline: 'Có bản mới v' + plainVer(update.version), detail: cur ? 'Bạn đang dùng v' + cur + '.' : '' };
    }
    return { kind: 'latest', version: cur, headline: 'Bạn đang dùng bản mới nhất', detail: cur ? 'Phiên bản hiện tại: v' + cur + '.' : '' };
  }
  // Tiến độ tải: có tổng dung lượng thì ra phần trăm (0-100), không thì chỉ số MB đã tải
  function progress(downloaded, total) {
    const d = Math.max(0, Number(downloaded) || 0), t = Number(total) || 0;
    if (t > 0) { const p = Math.max(0, Math.min(100, Math.round(d / t * 100))); return { percent: p, text: p + '%' + ' (' + (d / 1048576).toFixed(1) + ' / ' + (t / 1048576).toFixed(1) + ' MB)' }; }
    return { percent: null, text: (d / 1048576).toFixed(1) + ' MB đã tải' };
  }
  // Ghi chú phát hành: bỏ dòng trống thừa, cắt ở `max` ký tự (mặc định 900) rồi thêm "…" ở ranh giới dòng/từ gần nhất
  function notesBrief(notes, max) {
    const lim = max > 0 ? max : 900, s = String(notes === null || notes === undefined ? '' : notes).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (s.length <= lim) return s;
    const cut = s.slice(0, lim), at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
    return (at > lim * 0.6 ? cut.slice(0, at) : cut).trimEnd() + '…';
  }
  // Lỗi của bộ cập nhật (chuỗi tiếng Anh từ Rust/Tauri) -> câu rõ ràng kèm cách xử lý; lỗi lạ giữ nguyên nhưng cắt ngắn
  function friendlyError(err) {
    const m = String(err && err.message ? err.message : err === null || err === undefined ? '' : err).trim();
    const l = m.toLowerCase();
    if (/signature|minisign|verif/.test(l)) return 'Bản tải về không qua được bước kiểm tra chữ ký nên KHÔNG được cài. Thử lại sau vài phút; nếu vẫn lỗi hãy báo quản trị nhóm.';
    if (/error sending request|dns|connect|timed out|timeout|network|offline|os error 10060|os error 11001|failed to lookup/.test(l)) return 'Không kết nối được tới máy chủ cập nhật (GitHub). Kiểm tra mạng rồi bấm kiểm tra lại.';
    if (/valid release json|could not fetch|status code|404|403|429/.test(l)) return 'Chưa đọc được thông tin bản phát hành (máy chủ chưa phản hồi đúng). Thử lại sau ít phút.';
    return m ? 'Lỗi cập nhật: ' + m.slice(0, 160) : 'Không kiểm tra được bản cập nhật. Thử lại sau.';
  }
  // Kiểm tra ngầm lại khi đã quá `everyMs` kể từ lần cuối (mặc định 4 giờ) hoặc chưa kiểm lần nào
  function shouldAutoCheck(lastMs, nowMs, everyMs) {
    const ev = everyMs > 0 ? everyMs : 4 * 3600000;
    return !isFinite(lastMs) || !lastMs || nowMs - lastMs >= ev;
  }
  return { compareVersions, describeResult, progress, notesBrief, friendlyError, shouldAutoCheck };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = UpdateCheck;
