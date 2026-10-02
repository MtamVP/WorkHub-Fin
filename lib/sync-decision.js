// Logic thuần của đồng bộ thư mục (Không Gian Riêng) -- không đụng DOM/Tauri/Supabase, nên chạy được cả trong
// trình duyệt (thẻ <script> thường, thành global) lẫn Node/Vitest (module.exports). File này GIỐNG HỆT ở cả 3 app.
// personal-sync.js (engine) chỉ gọi các hàm này để QUYẾT ĐỊNH; mọi I/O nằm bên engine.

// ---------------------------------------------------------------------------
// Khoá lưu trữ (Supabase Storage)
// ---------------------------------------------------------------------------
// Storage chỉ nhận khoá có các ký tự: A-Z a-z 0-9 _ - . ' , ! * & $ @ = ; : + ( ) khoảng-trắng và '/'.
// Tên file tiếng Việt ("Báo cáo.docx") hay emoji bị từ chối bằng lỗi "Invalid key" -- trước đây lỗi đó làm
// cả lượt đồng bộ dừng ở file đầu tiên có dấu. Mỗi ký tự ngoài tập an toàn được viết thành !<mã hex>!. Ký tự
// thoát PHẢI nằm trong tập Storage chấp nhận (nên không dùng '~' hay '%'), và PHẢI bị loại khỏi tập "giữ
// nguyên" bên dưới để chính '!' trong tên cũng được mã hoá => phép biến đổi không bao giờ nhập nhằng. Tên chỉ
// gồm ký tự an toàn giữ NGUYÊN khoá cũ nên file đã đồng bộ từ trước vẫn tìm thấy.
const SYNC_SAFE_KEY_CHAR = /^[A-Za-z0-9_\-.',*&$@=;:+() ]$/;

function encodeSyncStorageKey(relativePath) {
  let out = '';
  for (const ch of String(relativePath)) {
    if (ch === '/' || SYNC_SAFE_KEY_CHAR.test(ch)) out += ch;
    else out += '!' + ch.codePointAt(0).toString(16) + '!';
  }
  return out;
}

function decodeSyncStorageKey(key) {
  return String(key).replace(/!([0-9a-f]+)!/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

// ---------------------------------------------------------------------------
// File tạm không nên đồng bộ
// ---------------------------------------------------------------------------
// .wh-tmp-<pid>: file ghi dở của chính sync_write_file (Rust). ~$xxx: file khoá của Word/Excel/PowerPoint.
// .~lock.xxx#: file khoá của LibreOffice. .crdownload/.part: file đang tải dở của trình duyệt.
const SYNC_TEMP_PATTERN = /(^|\/)(~\$[^/]*|\.~lock\.[^/]*#|[^/]*\.wh-tmp-\d+|[^/]*\.crdownload|[^/]*\.part)$/i;

function isTempSyncPath(relativePath) {
  return SYNC_TEMP_PATTERN.test(String(relativePath));
}

// ---------------------------------------------------------------------------
// Quyết định đồng bộ 1 file (so khớp 3 chiều)
// ---------------------------------------------------------------------------
// local  = hash file trên máy này (null nếu không có)
// last   = hash của lần đồng bộ thành công gần nhất trên máy này (null nếu chưa từng)
// remote = hash trên đám mây (null nếu chưa có hoặc đã bị xoá)
// Trả về 1 trong: 'record' | 'forget' | 'push' | 'pull' | 'delete-local' | 'delete-remote' | 'conflict' | 'noop'
//
// Điểm mấu chốt (bản cũ thiếu): khi 1 phía VẮNG MẶT, phải nhìn "last" để biết phía đó mới-chưa-tới hay đã-bị-xoá.
//  - đám mây có, máy không có, từng đồng bộ  => bạn đã xoá lúc app tắt => xoá trên đám mây (trừ khi nơi kia đã sửa tiếp)
//  - máy có, đám mây không có, từng đồng bộ  => máy khác đã xoá => xoá bản trên máy (trừ khi bạn đã sửa tiếp)
// Bản cũ coi cả hai trường hợp là "file mới" nên file đã xoá cứ hồi sinh lại.
function decideSyncAction(state) {
  const L = state.local || null;
  const S = state.last || null;
  const R = state.remote || null;

  if (L && R && L === R) return 'record';
  if (!L && !R) return S ? 'forget' : 'noop';

  if (L && !R) {
    if (!S) return 'push';
    return L === S ? 'delete-local' : 'push';
  }
  if (!L && R) {
    if (!S) return 'pull';
    return R === S ? 'delete-remote' : 'pull';
  }

  // Cả hai có nhưng khác nhau.
  if (!S) return 'conflict';
  if (L === S) return 'pull';
  if (R === S) return 'push';
  return 'conflict';
}

// Chặn thảm hoạ "thư mục biến mất => coi như xoá hết": ổ ngoài rút ra, thư mục bị đổi tên, OneDrive chưa tải...
// Danh sách file trên máy rỗng trong khi đang theo dõi từ 5 file trở lên là dấu hiệu gần như chắc chắn của sự cố,
// không phải ý định xoá (thư mục nhỏ thì xoá sạch là chuyện bình thường). Xoá hàng loạt (>= 10 file và quá nửa số file đang theo dõi) cũng bị giữ lại để hỏi.
function isSuspiciousMassDelete(deleteCount, trackedCount, localCount) {
  if (deleteCount === 0) return false;
  if (trackedCount >= 5 && localCount === 0) return true;
  return deleteCount >= 10 && deleteCount > trackedCount * 0.5;
}

// ---------------------------------------------------------------------------
// Thông báo lỗi dễ hiểu
// ---------------------------------------------------------------------------
function describeSyncError(err) {
  const raw = String((err && (err.message || err.error_description || err.error)) || err || '');
  const m = raw.toLowerCase();
  if (m.includes('invalid key')) return 'Tên file/thư mục có ký tự lưu trữ không nhận';
  if (m.includes('maximum allowed size') || m.includes('payload too large') || m.includes('too large') || m.includes('exceeded') && m.includes('size'))
    return 'File quá lớn so với giới hạn lưu trữ';
  if (m.includes('vượt quá giới hạn')) return 'File vượt giới hạn 200MB của đồng bộ';
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network request failed') || m.includes('load failed'))
    return 'Mất kết nối mạng';
  if (m.includes('row-level security') || m.includes('not authorized') || m.includes('jwt') || m.includes('unauthorized'))
    return 'Phiên đăng nhập hết hạn hoặc không có quyền — đăng nhập lại';
  if (m.includes('being used by another process') || m.includes('os error 32') || m.includes('os error 5') || m.includes('access is denied'))
    return 'File đang được chương trình khác dùng (mở trong Word/Excel?)';
  if (m.includes('not found') || m.includes('os error 2') || m.includes('os error 3')) return 'Không tìm thấy file hoặc thư mục';
  return raw || 'Lỗi không rõ';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    encodeSyncStorageKey, decodeSyncStorageKey, isTempSyncPath,
    decideSyncAction, isSuspiciousMassDelete, describeSyncError,
  };
}
