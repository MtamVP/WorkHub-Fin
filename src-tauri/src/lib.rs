use tauri::{
  menu::{Menu, MenuItem},
  tray::TrayIconBuilder,
  Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

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
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(
      tauri_plugin_sql::Builder::default()
        .add_migrations("sqlite:workhub-fin-cache.db", migrations)
        .build(),
    )
    .plugin(
      tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
          let quick_add = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN);
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
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      if let Err(e) = app
        .global_shortcut()
        .register(Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN))
      {
        log::warn!("Không đăng ký được phím tắt Ctrl+Shift+N (có thể đã bị app khác dùng): {e}");
      }

      let show_i = MenuItem::with_id(app, "show", "Mở WorkHub", true, None::<&str>)?;
      let quick_add_i = MenuItem::with_id(app, "quick_add", "Thêm nhanh...", true, None::<&str>)?;
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
