# WorkHub — Tình trạng tổng thể dự án

> File này dành cho 1 phiên Claude Code khác (trên máy khác) đọc để nắm bối cảnh nhanh, không cần hỏi lại người dùng từ đầu. Cập nhật lần cuối: 2026-08-26.

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

### 2. TrueNAS storage — hạ tầng ĐÃ DỰNG XONG (2026-08-26), code integration CHƯA làm
Xem `TrueNAS_Storage_Setup_Guide.md` cùng thư mục — file đó đã được cập nhật để phản ánh đúng những gì đã làm thật (khác một phần so với hướng dẫn gốc, vì máy người dùng không có sẵn hardware rời cho NAS chuyên dụng). Tóm tắt:

- **Không phải máy vật lý riêng** — TrueNAS SCALE 25.10.6 chạy dưới dạng **VM trong VirtualBox** ngay trên máy Windows chính của người dùng (CPU AMD Ryzen 5 5600, 32GB RAM). Ổ boot của VM là 1 file `.vdi` 32GB nằm trong phần dư của ổ Windows; ổ data là 1 ổ cứng ngoài 500GB (Apple HDD qua enclosure USB, chip Norelsys NS1068) pass-through thẳng vào VM.
- **Pool**: `workhub-pool` — kiểu Stripe, 1 ổ duy nhất (465.76 GiB khả dụng), **không có RAID/dự phòng** (chấp nhận đánh đổi vì chỉ có 1 ổ data).
- **Dataset đã tạo**: `wh-files`, `wh-backups`, `wh-media` (dưới `workhub-pool`), có Periodic Snapshot Task (giữ 2 tuần, chạy hàng ngày 00:00) cho `wh-files` và `wh-backups`.
- **MinIO đã cài** qua tính năng "Custom App" của TrueNAS (không phải catalog chính thức — MinIO đã bị gỡ khỏi catalog TrueNAS do đổi giấy phép 2025). Image `minio/minio:latest`, port 9000 (S3 API) + 9001 (Console) map ra host, thư mục `/data` trong container mount Host Path vào `/mnt/workhub-pool/wh-files`. Root user: `workhub-admin` (mật khẩu do người dùng tự đặt, không lưu trong repo).
- **Bucket đã tạo**: `wh-fin-files`, `wh-sci-files`, `wh-org-files` (mỗi app 1 bucket riêng).
- **Giới hạn quan trọng**: bản MinIO Community Edition hiện tại **không có mục Identity/Access Keys** trong Console (tính năng IAM đã bị cắt khỏi bản free) — nghĩa là khi tích hợp code, `api.js` phải dùng thẳng credential root (`workhub-admin` + mật khẩu) làm Access Key/Secret Key, không tạo được key riêng scoped cho từng app.
- **Chưa làm** (theo guide gốc, không bắt buộc): đặt IP tĩnh/reserved cho VM (hiện đang DHCP), bật 2FA cho TrueNAS Web UI, cấu hình Alert email, export Config Backup, Tailscale/WireGuard (chỉ cần nếu muốn truy cập từ ngoài mạng LAN).

**2 việc tích hợp code vẫn CHƯA làm** (cố ý dừng lại chờ xác nhận riêng, vì ảnh hưởng dữ liệu đang chạy — xem chi tiết cuối file guide):
   - Trỏ `local-backup.js` (cả 3 app) sang ghi vào TrueNAS (SMB hoặc gọi thẳng MinIO) thay vì chỉ ghi `AppLocalData` local.
   - Cân nhắc (thận trọng, ảnh hưởng dữ liệu cũ) chuyển `API.file.upload` sang gọi MinIO thay vì Supabase Storage — cần kế hoạch di chuyển dữ liệu file cũ, không chỉ đổi endpoint.

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
