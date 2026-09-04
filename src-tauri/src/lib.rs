use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};
use walkdir::WalkDir;

// -------------------- Personal Hub: local folder sync --------------------
// Deliberately implemented as plain #[tauri::command]s using std::fs directly
// (not the fs plugin's JS-exposed API) so file access for the user's chosen
// sync folder isn't gated by the fs plugin's static capability scope, which
// stays locked to $APPLOCALDATA for everything else in the app.

const SYNC_IGNORE_NAMES: [&str; 5] = [
    ".git",
    "node_modules",
    "Thumbs.db",
    ".DS_Store",
    "desktop.ini",
];
const SYNC_MAX_FILE_SIZE: u64 = 200 * 1024 * 1024; // 200MB guardrail

struct SyncWatcherState(Mutex<Option<RecommendedWatcher>>);

#[derive(Serialize)]
struct SyncFileEntry {
    #[serde(rename = "relativePath")]
    relative_path: String,
    size: u64,
}

fn is_sync_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        // eq_ignore_ascii_case thay vì == -- trước đây so khớp phân biệt hoa/thường, nên
        // "desktop.ini"/"Thumbs.DB" (đúng tên OS Windows thật sự tạo ra, filesystem Windows
        // không phân biệt hoa/thường) không khớp với "Thumbs.db"/"desktop.ini" trong danh
        // sách, lọt qua bị đồng bộ như file thường thay vì bị bỏ qua như ý định.
        SYNC_IGNORE_NAMES
            .iter()
            .any(|ignored| name.eq_ignore_ascii_case(ignored))
    })
}

// sync_read_file/sync_write_file/sync_file_exists/sync_delete_file/sync_hash_file trước đây
// join thẳng root + relative_path (PathBuf::join) không kiểm tra gì -- relative_path đến từ
// JS phía trước (dữ liệu đối chiếu remote/local trong personal-sync.js), và PathBuf::join với
// 1 path TUYỆT ĐỐI (vd "C:\Windows\System32\..." hay bắt đầu bằng "\") sẽ THAY THẾ HOÀN TOÀN
// root thay vì nối vào, còn ".." lồng nhau (vd "..\..\..\Windows\...") thoát khỏi root sau khi
// hệ điều hành resolve -- cho phép đọc/ghi/xoá bất kỳ file nào máy người dùng đọc/ghi được,
// nếu relative_path từng bị hỏng dữ liệu hoặc app từng có bug ở tầng JS phía trên. Hàm dùng
// chung này chặn cả 2 dạng tấn công: từ chối thẳng path tuyệt đối, rồi tự resolve ".." bằng
// tay (không đụng filesystem, vì file đích lúc ghi có thể chưa tồn tại) và xác nhận kết quả
// vẫn nằm trong root đã canonicalize.
fn resolve_sync_path(root: &str, relative_path: &str) -> Result<PathBuf, String> {
    let canon_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let candidate = Path::new(relative_path);
    if candidate.is_absolute()
        || candidate.components().any(|c| {
            matches!(
                c,
                std::path::Component::Prefix(_) | std::path::Component::RootDir
            )
        })
    {
        return Err("Đường dẫn không hợp lệ.".to_string());
    }
    let mut resolved = canon_root.clone();
    for comp in candidate.components() {
        match comp {
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            std::path::Component::Normal(seg) => resolved.push(seg),
            std::path::Component::CurDir => {}
            _ => return Err("Đường dẫn không hợp lệ.".to_string()),
        }
    }
    if !resolved.starts_with(&canon_root) {
        return Err("Đường dẫn nằm ngoài thư mục đồng bộ.".to_string());
    }
    Ok(resolved)
}

#[tauri::command]
fn sync_list_folder(root: String) -> Result<Vec<SyncFileEntry>, String> {
    let root_path = PathBuf::from(&root);
    let mut out = Vec::new();
    for entry in WalkDir::new(&root_path).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if is_sync_ignored(path) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > SYNC_MAX_FILE_SIZE {
            continue;
        }
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        out.push(SyncFileEntry {
            relative_path: rel.to_string_lossy().replace('\\', "/"),
            size: meta.len(),
        });
    }
    Ok(out)
}

#[tauri::command]
fn sync_read_file(root: String, relative_path: String) -> Result<String, String> {
    let full = resolve_sync_path(&root, &relative_path)?;
    // SYNC_MAX_FILE_SIZE trước đây chỉ được kiểm ở sync_list_folder (bỏ qua file quá lớn khi
    // liệt kê) -- sync_read_file/sync_hash_file lại đọc thẳng fs::read() không giới hạn, nên
    // relative_path trỏ vào 1 file rất lớn (vài GB) vẫn bị đọc hết vào bộ nhớ, có thể làm app
    // hết RAM và crash.
    if let Ok(meta) = fs::metadata(&full) {
        if meta.len() > SYNC_MAX_FILE_SIZE {
            return Err("File vượt quá giới hạn kích thước đồng bộ (200MB).".to_string());
        }
    }
    let bytes = fs::read(&full).map_err(|e| e.to_string())?;
    Ok(BASE64.encode(bytes))
}

#[tauri::command]
fn sync_write_file(
    root: String,
    relative_path: String,
    content_base64: String,
) -> Result<(), String> {
    let full = resolve_sync_path(&root, &relative_path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = BASE64.decode(content_base64).map_err(|e| e.to_string())?;
    // Ghi ra file tạm cùng thư mục rồi rename đè lên đích -- rename trên cùng ổ đĩa là thao
    // tác nguyên tử ở cấp hệ điều hành (Windows/POSIX đều đảm bảo), trong khi File::create()
    // ghi thẳng vào đích trước đây để lộ khoảng thời gian file bị truncate-rồi-đang-ghi-dở --
    // 1 lệnh sync_read_file/sync_hash_file khác chạy đúng lúc đó (vd sync engine đối chiếu lại
    // ngay sau khi nhận thay đổi) có thể đọc phải nội dung dở dang, hiểu nhầm là file hỏng hoặc
    // đổi thật.
    let tmp_name = format!(
        "{}.wh-tmp-{}",
        full.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    );
    let tmp = full
        .parent()
        .map(|p| p.join(&tmp_name))
        .unwrap_or_else(|| PathBuf::from(&tmp_name));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &full).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn sync_file_exists(root: String, relative_path: String) -> bool {
    match resolve_sync_path(&root, &relative_path) {
        Ok(full) => full.is_file(),
        Err(_) => false,
    }
}

#[tauri::command]
fn sync_delete_file(root: String, relative_path: String) -> Result<(), String> {
    let full = resolve_sync_path(&root, &relative_path)?;
    if full.exists() {
        fs::remove_file(&full).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn sync_hash_file(root: String, relative_path: String) -> Result<String, String> {
    let full = resolve_sync_path(&root, &relative_path)?;
    if let Ok(meta) = fs::metadata(&full) {
        if meta.len() > SYNC_MAX_FILE_SIZE {
            return Err("File vượt quá giới hạn kích thước đồng bộ (200MB).".to_string());
        }
    }
    let bytes = fs::read(&full).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
fn sync_start_watch(
    root: String,
    app: AppHandle,
    state: State<SyncWatcherState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None; // drop any previous watcher (also stops its background thread)

    let root_path = PathBuf::from(&root);
    let (tx, rx) = channel::<notify::Result<Event>>();

    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let root_for_thread = root_path.clone();
    let app_for_thread = app.clone();
    thread::spawn(move || {
        use std::collections::HashSet;
        loop {
            let first = match rx.recv() {
                Ok(r) => r,
                Err(_) => break, // sender dropped -> watcher was stopped
            };
            let mut changed: HashSet<String> = HashSet::new();
            if let Ok(event) = first {
                for p in event.paths {
                    if is_sync_ignored(&p) {
                        continue;
                    }
                    if let Ok(rel) = p.strip_prefix(&root_for_thread) {
                        changed.insert(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
            // Debounce: keep draining events that arrive within the window before emitting once.
            // batch_start giới hạn TỔNG thời gian gom -- trước đây chỉ có cửa sổ nghỉ 800ms
            // (reset lại mỗi lần có event mới), nên hoạt động ghi file LIÊN TỤC dày hơn 800ms
            // (giải nén 1 archive lớn, git checkout hàng loạt file, copy hàng loạt...) khiến
            // vòng lặp không bao giờ tới nhánh Err để thoát, "changed" gom mãi mà không bao
            // giờ emit -- UI/tầng đồng bộ không nhận được cập nhật nào suốt cả quá trình đó.
            // Ép emit nếu đã gom quá 8s dù hoạt động vẫn đang tiếp diễn.
            let batch_start = std::time::Instant::now();
            const MAX_BATCH_MS: u64 = 8_000;
            loop {
                if batch_start.elapsed() >= Duration::from_millis(MAX_BATCH_MS) {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(800)) {
                    Ok(Ok(event)) => {
                        for p in event.paths {
                            if is_sync_ignored(&p) {
                                continue;
                            }
                            if let Ok(rel) = p.strip_prefix(&root_for_thread) {
                                changed.insert(rel.to_string_lossy().replace('\\', "/"));
                            }
                        }
                    }
                    Ok(Err(_)) => {}
                    Err(_) => break,
                }
            }
            if !changed.is_empty() {
                let list: Vec<String> = changed.into_iter().collect();
                let _ = app_for_thread.emit("personal-sync-local-change", list);
            }
        }
    });

    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
fn sync_stop_watch(state: State<SyncWatcherState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

// -------------------- Personal Hub: quick-capture popup --------------------
// A tiny always-on-top, undecorated window (not the full main window) opened by a
// second global shortcut, so "jot a note" never means reopening the whole app.
// Reused/shown again on repeat presses instead of rebuilt, matching how the tray
// icon reuses the main window rather than recreating it.

fn show_quick_capture_window(app: &tauri::AppHandle) {
  if let Some(win) = app.get_webview_window("quick-capture") {
    let _ = win.show();
    let _ = win.set_focus();
    let _ = win.emit("quick-capture-reset", ());
    return;
  }
  if let Err(e) = tauri::WebviewWindowBuilder::new(
    app,
    "quick-capture",
    tauri::WebviewUrl::App("quick-capture.html".into()),
  )
  .title("Ghi chú nhanh")
  .inner_size(420.0, 260.0)
  .resizable(false)
  .decorations(false)
  .always_on_top(true)
  .skip_taskbar(true)
  .center()
  .build()
  {
    log::warn!("Không mở được cửa sổ ghi chú nhanh: {e}");
  }
}

// -------------------- SSO / Calendar OAuth: shared loopback catcher --------------------
// One fixed local HTTP port catches BOTH Supabase SSO's SAML redirect and Google
// Calendar's OAuth redirect (native desktop apps can't complete an external
// redirect in-webview -- production builds serve locally-bundled assets, not the
// real deployed URL). Per RFC 8252, loopback redirects are the standard native-app
// pattern; this fixed port (per app, wh-fin=43781/wh-sci=43782/wh-org=43783) is
// what gets registered in Supabase's redirect-URL allowlist / Google's OAuth client.

const OAUTH_LOOPBACK_PORT: u16 = 43781;

struct OAuthListenerState(Mutex<Option<std::sync::mpsc::Sender<()>>>);

fn oauth_response_body() -> &'static str {
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>WorkHub</title></head>\
     <body style=\"font-family:sans-serif;text-align:center;padding-top:80px;\">\
     <h2>Bạn có thể đóng tab này và quay lại WorkHub.</h2></body></html>"
}

fn parse_request_line_query(raw: &str) -> Option<String> {
    let first_line = raw.lines().next()?;
    let path_and_query = first_line.split_whitespace().nth(1)?;
    let q = path_and_query.find('?')?;
    Some(path_and_query[q + 1..].to_string())
}

#[tauri::command]
fn start_oauth_loopback(app: AppHandle, state: State<OAuthListenerState>) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write as _};
    use std::net::TcpListener;

    {
        // Trước đây chỉ *g = None -- điều này DROP cái Sender cũ chứ không GỬI tín hiệu huỷ
        // qua nó, nên cancel_rx.try_recv() ở luồng cũ trả về Err(Disconnected) (không phải
        // Ok), .is_ok() vẫn false, luồng cũ không hề biết mình cần dừng và giữ cổng
        // OAUTH_LOOPBACK_PORT tới khi tự hết hạn 300s. Phải GỬI trước khi thay thế, giống
        // đúng cách stop_oauth_loopback() (bên dưới) đã làm.
        let mut g = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(old_tx) = g.take() {
            let _ = old_tx.send(());
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", OAUTH_LOOPBACK_PORT))
        .map_err(|e| format!("Không mở được cổng {}: {}", OAUTH_LOOPBACK_PORT, e))?;

    let (cancel_tx, cancel_rx) = std::sync::mpsc::channel::<()>();
    {
        let mut g = state.0.lock().map_err(|e| e.to_string())?;
        *g = Some(cancel_tx);
    }

    let app_for_thread = app.clone();
    thread::spawn(move || {
        listener.set_nonblocking(true).ok();
        let start = std::time::Instant::now();
        let stream = loop {
            if cancel_rx.try_recv().is_ok() {
                return;
            }
            if start.elapsed() > Duration::from_secs(300) {
                let _ = app_for_thread.emit("oauth-loopback-timeout", ());
                return;
            }
            match listener.accept() {
                Ok((s, _)) => break s,
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(150));
                    continue;
                }
                Err(_) => {
                    thread::sleep(Duration::from_millis(150));
                    continue;
                }
            }
        };
        stream.set_nonblocking(false).ok();

        let mut reader = BufReader::new(&stream);
        let mut raw_request = String::new();
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let blank = line == "\r\n" || line == "\n";
                    raw_request.push_str(&line);
                    if blank {
                        break;
                    }
                }
            }
        }
        let query = parse_request_line_query(&raw_request).unwrap_or_default();

        let mut stream = stream;
        let body = oauth_response_body();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
        let _ = app_for_thread.emit("oauth-loopback-callback", query);
    });

    Ok(())
}

#[tauri::command]
fn stop_oauth_loopback(state: State<OAuthListenerState>) -> Result<(), String> {
    let mut g = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = g.take() {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "init offline sync tables",
        sql: "
      CREATE TABLE IF NOT EXISTS cache_responses (
        action TEXT NOT NULL,
        params_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        cached_at INTEGER NOT NULL,
        PRIMARY KEY (action, params_hash)
      );
      CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        params_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id TEXT PRIMARY KEY,
        original_queue_id TEXT NOT NULL,
        action TEXT NOT NULL,
        params_json TEXT NOT NULL,
        error_message TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        resolution TEXT
      );
    ",
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:workhub-fin-cache.db", migrations)
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let quick_add =
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN);
                    let quick_capture =
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &quick_add {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                            let _ = win.emit("quick-add-task", ());
                        }
                    } else if shortcut == &quick_capture {
                        show_quick_capture_window(app);
                    }
                })
                .build(),
        )
        .manage(SyncWatcherState(Mutex::new(None)))
        .manage(OAuthListenerState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            sync_list_folder,
            sync_read_file,
            sync_write_file,
            sync_file_exists,
            sync_delete_file,
            sync_hash_file,
            sync_start_watch,
            sync_stop_watch,
            start_oauth_loopback,
            stop_oauth_loopback
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Err(e) = app.global_shortcut().register(Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::SHIFT),
                Code::KeyN,
            )) {
                log::warn!(
                    "Không đăng ký được phím tắt Ctrl+Shift+N (có thể đã bị app khác dùng): {e}"
                );
            }
            if let Err(e) = app.global_shortcut().register(Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::SHIFT),
                Code::Space,
            )) {
                log::warn!(
                    "Không đăng ký được phím tắt Ctrl+Shift+Space (có thể đã bị app khác dùng): {e}"
                );
            }

            let show_i = MenuItem::with_id(app, "show", "Mở WorkHub", true, None::<&str>)?;
            let quick_add_i =
                MenuItem::with_id(app, "quick_add", "Thêm nhanh...", true, None::<&str>)?;
            let quick_capture_i =
                MenuItem::with_id(app, "quick_capture", "Ghi chú nhanh...", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&show_i, &quick_add_i, &quick_capture_i, &quit_i])?;

            // .unwrap() trước đây panic CẢ APP nếu default_window_icon() trả về None (icon
            // resource thiếu/lỗi decode trên 1 biến thể OS/build nào đó) -- mọi bước khác
            // trong setup() đều xuống cấp nhẹ nhàng qua log::warn! (đăng ký phím tắt ở trên
            // là ví dụ), chỉ riêng tray icon panic thẳng làm sập app khi khởi động. Không có
            // icon thì bỏ qua tray (mất icon khay hệ thống, không mất phần còn lại của app).
            if let Some(icon) = app.default_window_icon().cloned() {
                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quick_add" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = w.emit("quick-add-task", ());
                            }
                        }
                        "quick_capture" => show_quick_capture_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(w) = tray.app_handle().get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            } else {
                log::warn!("Không có icon mặc định -- bỏ qua tạo tray icon (phần còn lại của app vẫn chạy bình thường).");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Test khoá lại đúng hành vi của bản vá path-traversal ở resolve_sync_path() -- codebase
// Rust này trước đây chưa có test nào, thêm test đầu tiên đúng chỗ rủi ro cao nhất (đọc/ghi/
// xoá file tuỳ ý nếu relative_path không được kiểm) để bug không âm thầm quay lại sau này.
#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_root() -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "wh_resolve_sync_path_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn allows_plain_relative_path() {
        let root = make_temp_root();
        let resolved = resolve_sync_path(root.to_str().unwrap(), "notes/todo.txt").unwrap();
        assert!(resolved.starts_with(fs::canonicalize(&root).unwrap()));
        assert!(resolved.ends_with("notes/todo.txt") || resolved.ends_with("notes\\todo.txt"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_parent_dir_escape() {
        let root = make_temp_root();
        let err = resolve_sync_path(root.to_str().unwrap(), "../../../etc/passwd");
        assert!(err.is_err(), "\"..\" phải bị chặn khi thoát khỏi root");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_windows_absolute_path() {
        let root = make_temp_root();
        let err = resolve_sync_path(root.to_str().unwrap(), "C:\\Windows\\System32\\config");
        assert!(err.is_err(), "Đường dẫn tuyệt đối phải bị chặn");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rejects_leading_backslash_absolute_path() {
        let root = make_temp_root();
        let err = resolve_sync_path(root.to_str().unwrap(), "\\Windows\\System32\\config");
        assert!(err.is_err(), "Đường dẫn bắt đầu bằng \\ phải bị chặn");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn allows_parent_dir_that_stays_inside_root() {
        let root = make_temp_root();
        // "a/../b" resolve về "b", vẫn nằm trong root -- không nên bị chặn oan.
        let resolved = resolve_sync_path(root.to_str().unwrap(), "a/../b.txt").unwrap();
        assert!(resolved.starts_with(fs::canonicalize(&root).unwrap()));
        fs::remove_dir_all(&root).ok();
    }
}
