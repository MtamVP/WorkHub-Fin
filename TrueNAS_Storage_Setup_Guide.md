# Hướng dẫn Setup TrueNAS làm Storage tự host cho WorkHub

> **Cập nhật 2026-08-26 — ĐÃ TRIỂN KHAI THẬT, xem mục "Thực tế đã triển khai" ở cuối file.** Máy người dùng không có sẵn hardware rời cho NAS chuyên dụng, nên phần cài đặt thực tế đi theo hướng **TrueNAS chạy dưới dạng VM (VirtualBox) trên chính máy Windows đang dùng**, khác một phần so với hướng dẫn bare-metal gốc bên dưới. Đọc mục cuối file trước khi làm theo bất kỳ bước nào ở đây nếu mục tiêu là dựng lại/khôi phục hệ thống đã có.

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

---

## Thực tế đã triển khai (2026-08-26)

Phần này ghi lại **chính xác những gì đã làm trên máy thật**, để phiên sau (hoặc máy khác) không phải đoán lại hay hỏi từ đầu.

### Vì sao khác hướng dẫn gốc
Khi bắt đầu, máy người dùng chỉ có: 1 ổ 930GB đang chạy Windows (không thể xoá để cài TrueNAS bare-metal) và 1 ổ cứng ngoài 500GB qua USB (Apple HDD, enclosure dùng chip Norelsys NS1068). Không có máy vật lý rời nào khác. Vì máy có CPU AMD Ryzen 5 5600 (hỗ trợ SVM/AMD-V) và 32GB RAM, quyết định chạy TrueNAS SCALE dưới dạng **VM trong VirtualBox** ngay trên máy Windows chính, thay vì bare-metal.

### Các bước đã làm khác/thêm so với hướng dẫn gốc ở trên
1. **Bật SVM Mode (AMD-V) trong BIOS** (ASUS, tab Advanced → CPU Configuration → SVM Mode → Enabled) — bắt buộc để chạy VM, máy này mặc định tắt.
2. **Cài VirtualBox 7.2.16 + Extension Pack** (tải từ virtualbox.org) thay vì cài TrueNAS trực tiếp lên phần cứng.
3. **Tạo VM** qua `VBoxManage` (không qua wizard GUI): tên `TrueNAS-SCALE`, ostype `Debian13_64`, 8GB RAM, 4 vCPU, firmware BIOS, ổ boot ảo `.vdi` 32GB (nằm trong ổ Windows, không đụng phân vùng có sẵn), gắn ISO TrueNAS SCALE 25.10.6 vào ổ đĩa ảo để cài.
4. **Network**: bridge NIC của VM vào card mạng **dây (Ethernet)**, không phải WiFi — máy có cả 2 nhưng chỉ dây đang có kết nối thật ra Internet lúc setup. VM nhận IP qua DHCP (`10.0.0.61` tại thời điểm setup — **chưa đặt static/reserved IP**, cần làm nếu muốn IP không đổi).
5. **Cài TrueNAS SCALE vào ổ ảo boot** (không phải ổ USB 500GB) qua console cài đặt text-based bình thường (Install/Upgrade → chọn ổ ảo 32GB → đặt mật khẩu root → cài).
6. **Gắn ổ USB 500GB vào VM sau khi cài xong**: bật USB xHCI controller cho VM, ngắt ổ khỏi Windows, `VBoxManage controlvm ... usbattach` để pass-through nguyên ổ vào VM (TrueNAS nhận diện là `sdb`, 465.76 GiB).
7. **Tạo pool `workhub-pool`** — layout **Stripe** (không phải Mirror/RAIDZ như khuyến nghị gốc, vì chỉ có đúng 1 ổ data) → chấp nhận không có dự phòng, đã thông báo rõ với người dùng.
8. **Tạo 3 dataset** đúng như guide gốc: `wh-files`, `wh-backups`, `wh-media`.
9. **Bật Periodic Snapshot Task** cho `wh-files` và `wh-backups` (giữ 2 tuần, chạy hàng ngày lúc 00:00) — chưa bật cho `wh-media` (chưa có nhu cầu rõ ràng, có thể thêm sau).
10. **MinIO KHÔNG cài được qua catalog Apps** — MinIO đã bị gỡ khỏi catalog chính thức của TrueNAS (đổi giấy phép 2025, mất tính năng multi-tenant/IAM ở bản free). Giải pháp: dùng tính năng **Custom App** của TrueNAS, kéo thẳng Docker image `minio/minio:latest`:
    - Command: `server /data --console-address :9001`
    - Env: `MINIO_ROOT_USER=workhub-admin`, `MINIO_ROOT_PASSWORD=<người dùng tự đặt>`
    - Port: `9000:9000` (S3 API), `9001:9001` (Console)
    - Storage: Host Path, mount `/mnt/workhub-pool/wh-files` → `/data` trong container
11. **Tạo 3 bucket** trong MinIO Console: `wh-fin-files`, `wh-sci-files`, `wh-org-files`.
12. **Giới hạn phát hiện được**: bản MinIO Console hiện tại (Community Edition, sau đổi license) **không có mục Identity/Access Keys** — không tạo được access key riêng scoped theo app. Khi tích hợp `api.js`, sẽ phải dùng thẳng credential root (`workhub-admin` + password) làm access key/secret key cho S3 client. Đây là đánh đổi bảo mật cần biết (root key có toàn quyền, không giới hạn theo bucket).

### Truy cập
- TrueNAS Web UI: `http://<ip-vm>:80` (redirect sang `/ui/`), login `root` + mật khẩu đặt lúc cài.
- MinIO Console: `http://<ip-vm>:9001`, login `workhub-admin` + mật khẩu đã đặt.
- MinIO S3 API endpoint (dùng cho `api.js` sau này): `http://<ip-vm>:9000`.
- IP hiện tại (`10.0.0.61`) là DHCP, có thể đổi sau khi VM/máy khởi động lại — **nên đặt DHCP reservation trên router** hoặc static IP trong TrueNAS trước khi tích hợp code phụ thuộc vào IP này.

### Chưa làm (không bắt buộc, có thể làm sau)
- Đặt IP tĩnh/reserved cho VM.
- Bật 2FA cho TrueNAS Web UI.
- Cấu hình Alert email.
- Export Config Backup định kỳ.
- Tailscale/WireGuard (chỉ cần nếu có nhu cầu truy cập NAS từ ngoài mạng LAN).
- ~~2 việc tích hợp code ở mục "Bước tiếp theo" phía trên (`local-backup.js`, `api.js` upload)~~ — `local-backup.js` đã tích hợp thư mục mạng (Phase F, xem mục "Ghi chú DR & bảo mật" bên dưới). Phần `api.js` upload file qua MinIO **đã build riêng nhưng đang tắt** (xem ghi chú bên dưới), không thuộc phạm vi Phase F.

## Ghi chú DR (Disaster Recovery) & bảo mật — Phase F (2026-09-02)

**Khóa ký cập nhật (`workhub.key`)**: cả 3 app dùng chung một khóa minisign để ký các bản cập nhật tự động (`tauri-plugin-updater`). Khóa này hiện **chỉ tồn tại trên máy dev hiện tại** — không có trong CI/CD (vì chưa có CI/CD, build hoàn toàn thủ công bằng `tauri build`), không có nơi lưu trữ phụ nào. **Nếu mất file này hoặc mất máy này, sẽ không thể ký và phát hành bản cập nhật mới cho bất kỳ bản nào trong 3 app đã cài trên máy người dùng** — người dùng sẽ phải cài lại thủ công thay vì auto-update. Khuyến nghị: sao chép `workhub.key` sang ít nhất 1 nơi lưu trữ bền vững, tách biệt khỏi máy dev (USB mã hóa, tính năng đính kèm file của trình quản lý mật khẩu, hoặc dataset `wh-backups` trên TrueNAS này — giờ đã có sẵn).

**MinIO storage-proxy**: có một tính năng riêng (route upload file qua MinIO thay vì Supabase Storage) đã được build (Edge Function `storage-proxy` + `api.js` wiring) nhưng đang **tắt** (`USE_MINIO_STORAGE = false`) do một lỗi hang chưa liên quan đến Phase F này — việc đọc/xóa file vẫn đi qua MinIO theo tên bucket bất kể cờ này, chỉ upload mới là còn dùng Supabase Storage cũ. Đây là vấn đề riêng, không thuộc phạm vi sao lưu/phục hồi, chưa được xử lý trong Phase F.
