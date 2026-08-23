# Hướng dẫn Setup TrueNAS làm Storage tự host cho WorkHub

## Bối cảnh & mục tiêu

Hiện tại 3 app WorkHub (Fin/Sci/Org) dùng Supabase cho cả Postgres lẫn Storage (file upload trong task/project, ảnh đại diện, v.v.). Supabase free/pro tier có giới hạn dung lượng Storage và có rủi ro bị khoá/hạn chế account. Mục tiêu của tài liệu này: dựng một **TrueNAS SCALE** tại nhà làm nơi lưu trữ file tự chủ, giảm phụ thuộc vào Supabase Storage, đồng thời làm nơi chứa các bản backup tự động mà app đã tạo sẵn (`local-backup.js` — xem `workhub-local-features-shipped` trong memory).

**Phạm vi tài liệu này:** chỉ setup phần hạ tầng TrueNAS (cài đặt, pool, dataset, chia sẻ file, S3-compatible endpoint, bảo mật cơ bản). **Chưa** bao gồm phần code sửa `api.js` để 3 app thực sự chuyển sang dùng endpoint mới — đó là bước làm sau, sau khi bạn xác nhận TrueNAS đã chạy ổn.

---

## 1. Chuẩn bị phần cứng

- 1 máy chạy được TrueNAS SCALE (khuyến nghị SCALE thay vì CORE vì SCALE dùng Linux + hỗ trợ Docker apps, cần cho phần S3-compatible MinIO ở bước 5).
- Tối thiểu 8GB RAM (16GB+ nếu định chạy thêm MinIO/apps khác), CPU 64-bit.
- **Ổ cài hệ điều hành TrueNAS**: 1 ổ SSD/USB riêng ≥ 16GB, không dùng để chứa dữ liệu.
- **Ổ chứa dữ liệu**: tối thiểu 2 ổ cứng giống nhau nếu muốn làm RAID (khuyến nghị **Mirror** — tương đương RAID1 — để chống mất dữ liệu khi 1 ổ hỏng). 1 ổ cũng chạy được nhưng không có dự phòng.
- Cổng mạng Gigabit, dây LAN nối thẳng vào router/switch (không nên dùng WiFi cho NAS).
- 1 USB ≥ 16GB để tạo boot installer.

## 2. Cài đặt TrueNAS SCALE

1. Tải file ISO mới nhất tại `https://www.truenas.com/download-truenas-scale/`.
2. Dùng [Rufus](https://rufus.ie/) (Windows) để ghi ISO ra USB boot.
3. Cắm USB vào máy chủ, vào BIOS chọn boot từ USB.
4. Chạy trình cài đặt TrueNAS, chọn ổ cài hệ điều hành (ổ SSD/USB riêng đã chuẩn bị ở bước 1) — **không chọn nhầm ổ dữ liệu**.
5. Đặt mật khẩu root mạnh, hoàn tất cài đặt, khởi động lại, rút USB installer ra.
6. Sau khi khởi động, TrueNAS in ra địa chỉ IP trên màn hình console (dạng `https://192.168.x.x`) — dùng IP này để truy cập Web UI từ máy khác trong cùng mạng.

**Khuyến nghị:** vào router, đặt **IP tĩnh (Static/Reserved IP)** cho máy TrueNAS theo địa chỉ MAC, để IP không đổi sau khi reset router.

## 3. Tạo Storage Pool (ZFS)

1. Đăng nhập Web UI → **Storage** → **Create Pool**.
2. Đặt tên pool, ví dụ `workhub-pool`.
3. Chọn các ổ dữ liệu (không chọn ổ boot) → chọn layout:
   - **Mirror** (2 ổ): dự phòng 1-1, khuyến nghị cho NAS gia đình/nhóm nhỏ.
   - **RAIDZ1** (≥3 ổ): cân bằng dung lượng/dự phòng, chịu được mất 1 ổ.
4. Xác nhận tạo pool.

## 4. Tạo Dataset

Tạo cấu trúc dataset rõ ràng thay vì đổ hết vào 1 chỗ, để dễ phân quyền và backup riêng từng phần sau này:

```
workhub-pool/
├── wh-files          # file upload từ task/project (thay thế Supabase Storage buckets)
├── wh-backups        # nơi nhận snapshot JSON từ local-backup.js của 3 app
└── wh-media          # ảnh/avatar nếu cần tách riêng
```

Vào **Datasets** → chọn pool → **Add Dataset** cho từng cái, để mặc định ZFS record size trừ khi có nhu cầu đặc biệt.

**Bật snapshot tự động** (Storage → pool → Periodic Snapshot Tasks) cho `wh-files` và `wh-backups` — đây là lớp bảo vệ thứ 2 độc lập với `local-backup.js` (chống trường hợp app tự ghi đè/xoá nhầm dữ liệu).

## 5. Expose ra ngoài dưới dạng lưu trữ dùng được cho app

Có 2 hướng, chọn theo nhu cầu:

### 5a. SMB/NFS (đơn giản, đủ dùng cho backup file)
Phù hợp nếu chỉ cần `local-backup.js` ghi file JSON vào TrueNAS qua ổ mạng — không cần sửa code app nhiều, có thể mount ổ mạng trên máy chạy app rồi trỏ đường dẫn backup vào đó.

- **Shares** → **Windows Shares (SMB)** → chọn dataset `wh-backups` → tạo user/pass riêng cho SMB (không dùng chung root).
- Trên máy Windows chạy app: **Map Network Drive** trỏ tới `\\<ip-truenas>\wh-backups`.

### 5b. S3-compatible (khuyến nghị nếu muốn thay thế thật sự Supabase Storage)
Vì Supabase Storage vốn là S3-compatible, dùng MinIO trên TrueNAS SCALE cho phép `api.js` chuyển sang gọi endpoint mới **gần như không đổi cách gọi API** (chỉ đổi endpoint URL + access key).

1. **Apps** → **Discover Apps** → tìm và cài **MinIO**.
2. Khi cài, gán:
   - Dataset lưu dữ liệu → trỏ vào `wh-files`.
   - Port Web Console (mặc định 9001) và Port API (mặc định 9000).
3. Sau khi chạy, vào MinIO Console (`http://<ip-truenas>:9001`), tạo:
   - 1 **Bucket** cho mỗi app (`wh-fin-files`, `wh-sci-files`, `wh-org-files`), hoặc gộp chung 1 bucket có prefix theo app.
   - 1 **Access Key + Secret Key** riêng cho WorkHub dùng (không dùng key admin gốc).
4. Ghi lại: `Endpoint URL`, `Access Key`, `Secret Key`, `Bucket name(s)` — cần cho bước tích hợp code sau này.

## 6. Bảo mật (quan trọng nếu remote-access)

- **Không** port-forward trực tiếp port TrueNAS/MinIO ra Internet. Nếu cần truy cập từ xa (ví dụ để app chạy trên máy khác ghi file về NAS khi không cùng mạng LAN), dùng VPN riêng tư như **Tailscale** hoặc **WireGuard** — cài app Tailscale ngay trên TrueNAS (SCALE hỗ trợ cài qua Apps) và trên các máy client, tạo mạng riêng ảo, không mở port công khai.
- Đổi mật khẩu root mặc định ngay sau cài đặt, bật 2FA cho tài khoản Web UI (System Settings → General → 2FA).
- Tạo user riêng cho từng mục đích (SMB, MinIO) thay vì dùng chung 1 tài khoản quyền cao.
- Bật **Alert** qua email (System Settings → Alert Services) để được báo khi ổ cứng lỗi/pool degraded.

## 7. Backup chính TrueNAS

TrueNAS lưu dữ liệu quan trọng — bản thân nó cũng cần backup:
- **Replication Task** (Data Protection → Replication) để đẩy snapshot sang 1 ổ cứng ngoài hoặc 1 TrueNAS thứ 2 định kỳ, nếu có điều kiện.
- Tối thiểu: định kỳ export **Config Backup** (System Settings → General → Manual Config Backup) để không mất cấu hình pool/user/share khi máy chủ hỏng.

## 8. Checklist trước khi coi là "xong"

- [ ] Web UI truy cập được qua IP tĩnh, đăng nhập bằng tài khoản đã đổi mật khẩu.
- [ ] Pool ở trạng thái `ONLINE`, không cảnh báo.
- [ ] Dataset `wh-files` / `wh-backups` / `wh-media` đã tạo, phân quyền đúng user.
- [ ] Periodic Snapshot đã bật cho các dataset quan trọng.
- [ ] (Nếu dùng 5b) MinIO chạy được, tạo bucket + access key thành công, test upload/download 1 file thử qua MinIO Console.
- [ ] (Nếu remote-access) Tailscale/WireGuard đã cài và test kết nối từ máy ngoài mạng LAN.
- [ ] Alert email đã cấu hình và test gửi thử.
- [ ] Config Backup đã export và lưu ở nơi khác (không lưu trên chính TrueNAS).

---

## Bước tiếp theo (chưa làm trong tài liệu này)

Sau khi TrueNAS chạy ổn và checklist ở trên đã tick hết, quay lại phiên làm việc để:
1. Sửa `local-backup.js` ở cả 3 app trỏ đích ghi file sang ổ mạng/API MinIO mới, thay vì chỉ ghi vào `AppLocalData` trên máy Windows.
2. (Nếu chọn hướng 5b) Đánh giá có nên chuyển hẳn phần `uploadFile`/`API.file.upload` trong `api.js` sang gọi MinIO thay vì Supabase Storage — cần cân nhắc kỹ vì đây là thay đổi lớn, ảnh hưởng dữ liệu file đang có sẵn trên Supabase (cần kế hoạch di chuyển dữ liệu cũ, không chỉ đổi endpoint cho file mới).
