# Hướng Dẫn Cập Nhật & Build App WorkHub-Fin

File này lưu lại các bước chuẩn để tạo ra bản cập nhật mới (Auto-Update) cho dự án `WorkHub-Fin`. Khi nào bạn sửa code xong và muốn tung ra bản cập nhật mới, chỉ cần làm đúng theo thứ tự sau:

---

## 1. Tăng Phiên Bản
1. Mở file `src-tauri/tauri.conf.json`.
2. Tìm dòng `"version": "0.x.x"` và tăng số phiên bản lên (ví dụ từ `0.1.1` lên `0.1.2`).

## 2. Build Ứng Dụng
Do quá trình Build cần phải có "chìa khóa" bảo mật (đang dùng chung key với WorkHub-main), nên bạn không dùng lệnh `npx tauri build` thông thường được. 

Hãy mở **Terminal** (tại thư mục `workhub-fin`) và copy/paste toàn bộ cụm lệnh sau để chạy:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH="C:\Users\Admin\Music\WorkHub-main\workhub.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="workhub28826"
npx tauri build
```

*(Thời gian build thường mất khoảng 3-10 phút).*

## 3. Nếu Tauri báo lỗi KHÔNG THỂ KÝ FILE ở cuối bước Build
Nếu Terminal báo lỗi: `Error: A public key has been found, but no private key...` thì bạn không cần Build lại! Bạn chỉ cần chạy tiếp cụm lệnh sau để ký file bằng tay:

```powershell
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content C:\Users\Admin\Music\WorkHub-main\workhub.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "workhub28826"
npx tauri signer sign C:\Users\Admin\Music\workhub-fin\src-tauri\target\release\bundle\nsis\WorkHub-Fin_0.1.3_x64-setup.exe
```
*(Lưu ý: Thay số `0.1.2` bằng đúng số version bạn đang build).*

Lệnh này sẽ tự đẻ ra file chữ ký `.sig` cho bạn. 

## 4. Tạo file `latest.json`
Tạo (hoặc sửa) file `latest.json` nằm trong thư mục `src-tauri/target/release/bundle/nsis/` với nội dung như sau:

```json
{
  "version": "v0.1.2",
  "notes": "Mô tả bản cập nhật...",
  "pub_date": "2026-08-28T11:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "DÁN_NỘI_DUNG_FILE_.SIG_VÀO_ĐÂY",
      "url": "https://github.com/MtamVP/WorkHub-Fin/releases/download/v0.1.2/WorkHub-Fin_0.1.2_x64-setup.exe"
    }
  }
}
```
- Đổi các chỗ `0.1.2` thành version hiện tại.
- Mở file `.sig` vừa sinh ra lên, copy dòng base64 khổng lồ dán vào chỗ `signature`.

## 5. Tung Bản Cập Nhật Lên GitHub (Publish)
1. Lên kho GitHub [WorkHub-Fin](https://github.com/MtamVP/WorkHub-Fin/releases).
2. Chọn **Draft a new release**.
3. Đặt **Tag** là `v0.1.2` (trùng version).
4. Vào thư mục `src-tauri/target/release/bundle/nsis/` và **KÉO THẢ CẢ 3 FILE NÀY LÊN**:
   - `WorkHub-Fin_0.1.2_x64-setup.exe`
   - `WorkHub-Fin_0.1.2_x64-setup.exe.sig`
   - `latest.json`
5. Bấm **Publish release**.

Lúc này, toàn bộ nhân viên/thành viên đang dùng app bản cũ (ví dụ 0.1.1) khi mở lên sẽ tự động nhận được thông báo đòi cập nhật lên bản 0.1.2! Hoàn tất.
