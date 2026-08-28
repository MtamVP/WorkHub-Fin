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
        SYNC_IGNORE_NAMES
            .iter()
            .any(|ignored| name.as_ref() == *ignored)
    })
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
    let full = PathBuf::from(&root).join(&relative_path);
    let bytes = fs::read(&full).map_err(|e| e.to_string())?;
    Ok(BASE64.encode(bytes))
}

#[tauri::command]
fn sync_write_file(
    root: String,
    relative_path: String,
    content_base64: String,
) -> Result<(), String> {
    let full = PathBuf::from(&root).join(&relative_path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = BASE64.decode(content_base64).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(&full).map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn sync_file_exists(root: String, relative_path: String) -> bool {
    PathBuf::from(&root).join(&relative_path).is_file()
}

#[tauri::command]
fn sync_delete_file(root: String, relative_path: String) -> Result<(), String> {
    let full = PathBuf::from(&root).join(&relative_path);
    if full.exists() {
        fs::remove_file(&full).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn sync_hash_file(root: String, relative_path: String) -> Result<String, String> {
    let full = PathBuf::from(&root).join(&relative_path);
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
            loop {
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
                    if event.state() == ShortcutState::Pressed && shortcut == &quick_add {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                            let _ = win.emit("quick-add-task", ());
                        }
                    }
                })
                .build(),
        )
        .manage(SyncWatcherState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            sync_list_folder,
            sync_read_file,
            sync_write_file,
            sync_file_exists,
            sync_delete_file,
            sync_hash_file,
            sync_start_watch,
            sync_stop_watch
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

            let show_i = MenuItem::with_id(app, "show", "Mở WorkHub", true, None::<&str>)?;
            let quick_add_i =
                MenuItem::with_id(app, "quick_add", "Thêm nhanh...", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quick_add_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
