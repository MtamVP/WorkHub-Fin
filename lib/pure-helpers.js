// Hàm logic thuần, không đụng DOM -- dùng chung giữa trình duyệt (nạp bằng thẻ <script>
// thường TRƯỚC script.js, trở thành global đúng kiểu script.js đang tự làm) và Node/Vitest
// (qua module.exports, CommonJS). Nguồn duy nhất -- các bản sao cục bộ của những hàm này
// trong script.js đã bị XOÁ, không được thêm lại.

function timeAgoVietnamese(dateInput) {
  if (!dateInput) return 'Chưa hoạt động';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return 'Chưa hoạt động';

  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 45) return 'Vừa mới đây';
  if (diffMin < 60) return `Hoạt động ${diffMin} phút trước`;
  if (diffHour < 24) return `Hoạt động ${diffHour} giờ trước`;
  return `Hoạt động ${diffDay} ngày trước`;
}

function getProgressBarColor(percent) {
  if (percent == 100) return 'var(--success-color)';
  if (percent >= 50) return 'var(--gold)';
  if (percent > 0) return 'var(--warning-color)';
  return 'var(--border-color)';
}

function orgUnitDepth(unitId, unitsById) {
  let depth = 0;
  let cursor = unitsById.get(unitId);
  const seen = new Set();
  while (cursor && cursor.parent_id && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    depth++;
    cursor = unitsById.get(cursor.parent_id);
  }
  return depth;
}

function orgUnitLabel(unit, unitsById) {
  return '— '.repeat(orgUnitDepth(unit.id, unitsById)) + unit.name;
}

// KHÔNG tái dùng timeAgoVietnamese: hàm đó nhét sẵn tiền tố 'Hoạt động ' vào kết quả và
// dừng ở đơn vị ngày; các chỗ gọi nó đang phụ thuộc đúng tiền tố ấy. Hàm này trả cụm trần
// ("2 giờ trước") để chỗ gọi tự ghép ("sửa …", "lưu trữ …").
function formatPersonalTimeAgo(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'vừa xong';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' phút trước';
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' giờ trước';
  const day = Math.floor(hour / 24);
  if (day < 30) return day + ' ngày trước';
  const month = Math.floor(day / 30);
  if (month < 12) return month + ' tháng trước';
  return Math.floor(month / 12) + ' năm trước';
}

// Giữ personalItemsCache đúng thứ tự mà API.personal.list trả về (pinned desc, updated_at
// desc) sau khi ghim/bỏ ghim tại chỗ, khỏi phải fetch lại cả danh sách.
function sortPersonalItemsCache(items) {
  return items.slice().sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { timeAgoVietnamese, getProgressBarColor, orgUnitDepth, orgUnitLabel, formatPersonalTimeAgo, sortPersonalItemsCache };
}
