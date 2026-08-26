# WorkHub-Fin

Ứng dụng quản lý tài chính cá nhân/nhóm của hệ sinh thái **WorkHub** — theo dõi task/dự án, giao dịch, tài sản, danh mục cổ phiếu, dòng tiền. Là 1 trong 3 app độc lập cùng hệ sinh thái (xem [WorkHub-Sci](https://github.com/MtamVP/WorkHub-Sci), [WorkHub-ORG](https://github.com/MtamVP/WorkHub-ORG)).

> 📋 Muốn nắm nhanh **tình trạng tổng thể cả 3 app** (đã xong gì, còn dang dở gì)? Đọc [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) trước — nội dung giống hệt ở cả 3 repo, chỉ cần đọc 1 lần.

## Clone repo

```bash
git clone https://github.com/MtamVP/WorkHub-Fin.git
cd WorkHub-Fin
```

Repo này **private** — cần được mời làm collaborator hoặc dùng tài khoản GitHub đã có quyền truy cập (`gh auth login`) mới clone được.

## Công nghệ

- **Frontend**: vanilla JavaScript SPA, không build step, không framework — `index.html` + `script.js` + `api.js` + `style.css`.
- **Backend**: [Supabase](https://supabase.com) (Postgres + Auth + Storage), dùng chung project với WorkHub-Sci và WorkHub-ORG. Không có server riêng — mọi logic nghiệp vụ nằm trong JS client hoặc DB trigger.
- **Desktop app**: đóng gói bằng [Tauri v2](https://v2.tauri.app) (`src-tauri/`), chạy song song với bản web (deploy tĩnh, ví dụ Cloudflare Pages).
- **Kiến trúc chi tiết**: xem [`WorkHub_Execution_Orchestration_Architecture_v2.md`](./WorkHub_Execution_Orchestration_Architecture_v2.md).

## Chạy thử / build desktop app

Yêu cầu máy đã cài: [Node.js](https://nodejs.org) ≥ 18, [Rust](https://www.rust-lang.org/tools/install), và [các prerequisite của Tauri cho Windows](https://v2.tauri.app/start/prerequisites/) (Microsoft C++ Build Tools, WebView2 — Windows 11 đã có sẵn WebView2).

```bash
npm install

# Build bản debug (nhanh hơn, để test)
npx tauri build --debug

# Build bản release (chậm hơn, dùng để phát hành/cài thật)
npx tauri build
```

File cài đặt (`.exe`/`.msi`) sẽ nằm trong `src-tauri/target/debug/bundle/` hoặc `src-tauri/target/release/bundle/` sau khi build xong.

Không có bước `npm run dev` riêng — app không dùng bundler nên mọi thay đổi ở `index.html`/`script.js`/`api.js`/`style.css` chỉ cần build lại (hoặc mở thẳng qua 1 static file server bất kỳ để test nhanh phần giao diện, không cần Tauri).

## Cấu hình

Không cần file `.env` — key Supabase dùng trong `api.js` là **publishable/anon key**, không phải secret key, nên được hardcode thẳng trong code theo đúng khuyến nghị của Supabase cho client-side app.

## Tài liệu liên quan trong repo này

- [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — tình trạng tổng thể dự án, việc còn dang dở.
- [`TrueNAS_Storage_Setup_Guide.md`](./TrueNAS_Storage_Setup_Guide.md) — hướng dẫn setup TrueNAS làm storage tự host, thay thế/bổ sung Supabase Storage.
- [`version-migration.sql`](./version-migration.sql) — SQL cần chạy tay trong Supabase SQL Editor (xem `PROJECT_STATUS.md` để biết lý do và trạng thái).
- [`WorkHub_Execution_Orchestration_Architecture_v2.md`](./WorkHub_Execution_Orchestration_Architecture_v2.md) — tài liệu kiến trúc gốc, đầy đủ hơn phần tóm tắt trong `PROJECT_STATUS.md`.
