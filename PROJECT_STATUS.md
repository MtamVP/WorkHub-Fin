# WorkHub — Tình trạng tổng thể dự án

> File này dành cho 1 phiên Claude Code khác (trên máy khác) đọc để nắm bối cảnh nhanh, không cần hỏi lại người dùng từ đầu. Cập nhật lần cuối: 2026-08-22.

## Dự án là gì

WorkHub gồm **3 app độc lập** cùng hệ sinh thái, cùng dùng chung 1 Supabase project (`gqsbsqaxzpzcloaopzvv`):

| App | Mục đích | Repo GitHub | Repo local (máy hiện tại) |
|---|---|---|---|
| **Fin** | Quản lý tài chính cá nhân/nhóm (giao dịch, tài sản, cổ phiếu) | `MtamVP/WorkHub-Fin` | `C:\wh-build\wh-fin` |
| **Sci** | Quản lý dự án khoa học + viết bài báo (Journal → LaTeX) | `MtamVP/WorkHub-Sci` | `C:\wh-build\wh-sci` |
| **Org** | Quản lý dự án/task tổ chức chung, có RAG chatbot | `MtamVP/WorkHub-ORG` | `C:\wh-build\wh-org` |

Cả 3 là **vanilla JS SPA** (không build step, không framework) — `index.html` + `script.js` + `api.js` + `style.css`, được đóng gói thành **desktop app bằng Tauri v2** (`src-tauri/`). Trước đó từng có bản PWA, giờ dùng song song: web app (deploy Cloudflare Pages) + desktop app (Tauri, cài local trên máy người dùng).

**Lưu ý quan trọng về wh-org:** UI thật của app nằm ở `dashboard/index.html`, KHÔNG phải `index.html` gốc (đó chỉ là trang login). wh-org cũng dùng `showModal()`/`hideModal()` thay vì `openAppModal()`/`closeAppModal()` như Fin/Sci — đừng giả định pattern của Fin/Sci áp dụng y hệt cho Org, luôn grep code thật trước khi sửa.

## Kiến trúc chung (áp dụng cả 3 app)

- **Backend**: Supabase (Postgres + Auth + Storage), không có backend server riêng — mọi logic nghiệp vụ hoặc nằm trong JS client hoặc trong **DB trigger** (Postgres).
- **Điểm trung tâm mọi read/write**: `window.callGAS(action, params)` trong `api.js` — 1 dispatcher duy nhất (~90 case switch) mà toàn bộ UI gọi vào, tên cũ từ thời còn dùng Google Apps Script làm backend (đã bỏ từ lâu, giờ chỉ còn cái tên). Muốn thêm tính năng mới liên quan đến dữ liệu, luôn tìm hiểu qua `callGAS` trước.
- **`MUTATING_ACTIONS`**: Set liệt kê action nào là ghi (write), dùng để audit log + (mới thêm) để xác định thao tác nào cần queue khi offline.
- **Tauri**: 3 app dùng chung 1 khuôn `src-tauri/` gần như y hệt (chỉ khác `productName`/`identifier`/port). Không dùng package `@tauri-apps/api` — dùng thẳng global `window.__TAURI__` (do `withGlobalTauri: true`). Convention bắt buộc: mọi lời gọi Tauri phải feature-detect `window.__TAURI__.<plugin>` rồi fallback về hành vi web, vì cùng 1 file JS chạy cả bản desktop lẫn bản web.

## Trạng thái các hạng mục lớn

### ✅ Đã xong — Đóng gói PWA + Tauri desktop
Cả 3 app đã có bản PWA (manifest, service worker) và bản Tauri desktop (build `.exe`/`.msi`, cài được trên Windows). Icon, offline shell, install flow đều hoạt động.

### ✅ Đã xong — WorkHub Execution Orchestration (4 bước, xem `WorkHub_Execution_Orchestration_Architecture_v2.md` trong cùng thư mục)
1. Vá lỗ hổng leo quyền admin qua `group_key` (RLS gap) — chặn bằng DB trigger.
2. Optimistic concurrency thật (cột `version` + `WHERE id=? AND version=?`) thay cho check `updated_at` mơ hồ — hiện chỉ áp dụng cho bảng `tasks`.
3. Validate dependency/cycle/blocker của task chuyển hẳn xuống DB trigger, bỏ check phía client.
4. Tự động tính lại `projects.percent` bằng DB trigger, bỏ ~10 chỗ gọi `API.project.recalculate()` thủ công.

### ✅ Đã xong — Journal (LaTeX) cho WorkHub-Sci
Viết bài báo khoa học dạng form → tự convert sang `.tex` → quản lý (sửa/nhân bản/xoá) → xuất file `.tex` → **đã có thêm** cả "Mở trong Overleaf" và xuất PDF ngay trên trình duyệt (WASM LaTeX, không cần server/API ngoài — giữ riêng tư nội dung nghiên cứu).

### ✅ Đã xong (2026-08-17) — 4 tính năng local-machine cho cả 3 app desktop
1. **Khay hệ thống + phím tắt Ctrl+Shift+N** — quick-add task từ bất kỳ đâu, kể cả khi app đang ẩn.
2. **Thông báo Windows native** cho task quá hạn/sắp đến hạn (poll mỗi 5 phút qua `listMyTasks`).
3. **Auto backup local** — mỗi ngày snapshot JSON các bảng chính vào `%LOCALAPPDATA%\<app>\backups`, giữ 14 bản.
4. **Offline sync 2 chiều đầy đủ** — mọi thao tác (kể cả sửa task, giao dịch tài chính) dùng được khi mất mạng, xếp hàng (SQLite local qua `tauri-plugin-sql`) và tự đồng bộ khi có mạng lại, qua đúng dispatcher `callGAS`/`_dispatchAction` sẵn có. Khi 1 write bị server từ chối lúc đồng bộ lại (ví dụ trigger chống vòng lặp phụ thuộc ở bước 3 phía trên từ chối), nó rơi vào bảng `sync_conflicts` + màn hình xung đột riêng (nút "Sửa lại"/"Bỏ qua"), không mất âm thầm.

Cả 3 app đã: build sạch (debug + release), khởi động không lỗi, **commit + push lên GitHub**, **build release + cài đặt (silent install) vào máy này**. Commit mới nhất mỗi repo:
- wh-fin: `57d624e` — "Add system tray, deadline notifications, auto local backup, and full offline sync"
- wh-sci: `c6ce937` — cùng nội dung, thêm domain riêng (`sci_journals`, group key `'science'`)
- wh-org: `80bdcfc` — cùng nội dung, thích ứng cấu trúc riêng (`dashboard/index.html`, `showModal`/`hideModal`, group key `'all'`)

**File liên quan mới** (giống nhau ở cả 3 repo, tên file): `tray-hotkey.js`, `notify-deadlines.js`, `backup-config.js`, `local-backup.js`, `sync-config.js`, `sync-engine.js`, `sync-conflict-ui.js`.

## ⚠️ Việc còn dang dở — cần người dùng tự làm

### 1. Chạy `version-migration.sql` (đã có sẵn file, nằm cùng thư mục với file này)
Thêm cột `version` + trigger tăng version cho bảng `projects`, `events`, `project_milestones` (mở rộng pattern optimistic-concurrency đang chỉ có ở `tasks`, để offline-sync conflict-detection hoạt động đầy đủ cho phần dự án/sự kiện). Công cụ DB tool tự động (Supabase MCP `apply_migration`) đã bị chặn 2 lần bởi bộ lọc an toàn của auto-mode — **cần người dùng tự chạy tay** trong Supabase SQL Editor (project `gqsbsqaxzpzcloaopzvv`). App vẫn chạy bình thường nếu chưa chạy — chỉ là project/event edit tạm thời last-write-wins thay vì có cảnh báo ghi đè.

### 2. TrueNAS storage (xem `TrueNAS_Storage_Setup_Guide.md` cùng thư mục)
Guide setup TrueNAS SCALE làm storage tự host, để giảm phụ thuộc Supabase Storage. **Chỉ là tài liệu hướng dẫn** — chưa có hạ tầng nào được dựng thật, người dùng sẽ tự làm ở máy khác. Sau khi xong, còn 2 việc tích hợp code chưa làm (ghi rõ ở cuối file guide):
   - Trỏ `local-backup.js` (cả 3 app) sang ghi vào TrueNAS thay vì `AppLocalData` local.
   - Cân nhắc (thận trọng, ảnh hưởng dữ liệu cũ) chuyển `API.file.upload` sang MinIO/S3 thay vì Supabase Storage.

### 3. Giới hạn xác minh UI trong phiên vừa rồi
Công cụ điều khiển màn hình bị ngắt kết nối giữa phiên làm việc, nên 4 tính năng local-machine ở trên **chỉ được xác minh ở mức "compile sạch + app khởi động không crash"**, chưa tự bấm-thử tray icon/hotkey/toast thông báo/màn hình xung đột bằng tay. Nên tự mở app kiểm tra qua 1 lượt trước khi coi là hoàn toàn ổn định.

## Gợi ý việc tiếp theo (chưa quyết định, chỉ là khả năng)
- Tính năng mới riêng cho Fin hoặc Org (Sci vừa có Journal, Fin/Org chưa có hạng mục lớn tương đương gần đây).
- Tích hợp thật TrueNAS sau khi hạ tầng dựng xong (mục 2 ở trên).
- Xem lại phần audit-log/system_logs có cần dọn dẹp/giới hạn dung lượng không (chưa khảo sát trong phiên này).

## Nơi tìm thêm chi tiết
- `WorkHub_Execution_Orchestration_Architecture_v2.md` — kiến trúc gốc, đầy đủ hơn phần tóm tắt 4 bước ở trên.
- `TrueNAS_Storage_Setup_Guide.md` — hướng dẫn TrueNAS chi tiết.
- `version-migration.sql` — SQL cần chạy tay (mục 1 ở trên).
- Memory của Claude Code (không nằm trong repo, chỉ máy đã chạy các phiên trước mới có): các file `workhub-*.md` trong thư mục memory — ghi lại quyết định kỹ thuật, gotcha đã gặp (cache HTTP browser, PowerShell Start-Process với Tauri exe, cấu trúc khác biệt của wh-org, v.v).
