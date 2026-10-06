use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

pub const TRAY_ID: &str = "main-tray";

/// Desired tray visibility, remembered independently of whether the icon has
/// been created yet.
///
/// The frontend calls `set_tray_visible` as soon as settings hydrate — which can
/// easily happen *before* the deferred tray creation runs (see `lib.rs::run`).
/// Without this, `set_tray_visible(false)` would be a no-op and the deferred
/// pass would then pop an icon the user had explicitly turned off.
static TRAY_DESIRED: AtomicBool = AtomicBool::new(true);

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

static TRAY_LOCALE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let is_en = TRAY_LOCALE
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
        == Some("en");

    let (lbl_show, lbl_settings, lbl_quit) = if is_en {
        ("Show Window", "Settings…", "Quit Markelle")
    } else {
        ("显示主窗口", "设置…", "退出 Markelle")
    };

    let show_i = MenuItem::with_id(app, "show", lbl_show, true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", lbl_settings, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", lbl_quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show_i, &settings_i, &sep, &quit_i])
}

/// Idempotent: safe to call from both the deferred startup pass and
/// `set_tray_visible`. Creating a second tray under the same id would replace
/// the first one, so the early return matters.
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let menu = build_tray_menu(app)?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::FailedToReceiveMessage)?;

    // Registering with the app's tray registry keeps the icon alive after this
    // handle is dropped, so binding to `_` here is intentional.
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Markelle")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "settings" => {
                show_main(app);
                let _ = app.emit("markelle-tray", serde_json::json!({ "action": "settings" }));
            }
            "quit" => {
                let _ = app.emit("markelle-tray", serde_json::json!({ "action": "quit" }));
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    // Honour a preference the frontend may have already expressed.
    if !TRAY_DESIRED.load(Ordering::Relaxed) {
        let _ = tray.set_visible(false);
    }

    Ok(())
}

#[tauri::command]
pub fn set_tray_visible(
    app: AppHandle,
    visible: bool,
    locale: Option<String>,
) -> Result<(), String> {
    if let Some(loc) = locale {
        if let Ok(mut g) = TRAY_LOCALE.lock() {
            *g = Some(loc);
        }
    }
    // Cheap boot probe: this is the first IPC the frontend makes once settings
    // have hydrated, so seeing it in the trace proves React mounted.
    crate::boot_trace(&format!("frontend: set_tray_visible({visible}) received"));
    TRAY_DESIRED.store(visible, Ordering::Relaxed);

    if app.tray_by_id(TRAY_ID).is_none() {
        if !visible {
            // Nothing to hide yet — the deferred creation reads TRAY_DESIRED.
            return Ok(());
        }
        // Create on demand, on the main thread: a tray icon owns a Win32 message
        // window, so it must be built from the event loop thread.
        let host = app.clone();
        return app
            .run_on_main_thread(move || {
                if let Err(err) = setup_tray(&host) {
                    eprintln!("tray setup failed: {err}");
                }
            })
            .map_err(|e| e.to_string());
    }

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_visible(visible).map_err(|e| e.to_string())?;
        if let Ok(new_menu) = build_tray_menu(&app) {
            let _ = tray.set_menu(Some(new_menu));
        }
    }
    Ok(())
}

/// Best-effort quit grace period. On quit we first emit `app://before-quit` so
/// the frontend can flush unsaved editor content and any in-flight history
/// snapshot write, then we wait this long before exiting for real.
///
/// The handshake is intentionally fire-and-forget: a frontend that does not (yet)
/// listen for the event must NOT be able to hang the quit, so this is a hard
/// timeout, not a wait for an acknowledgement. Keeping it short (<½s) means the
/// worst case is a barely-perceptible delay rather than a "stuck" app.
const QUIT_GRACE: std::time::Duration = std::time::Duration::from_millis(400);

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    // Ask the frontend to flush. Deliberately ignore the result: no listener is a
    // valid, expected state (this degrades to today's immediate-exit behaviour).
    let _ = app.emit("app://before-quit", ());
    // Wait out the grace period on a detached thread so this command never blocks
    // the IPC caller, then exit unconditionally — the frontend must not be able to
    // prevent the app from closing.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_GRACE);
        handle.exit(0);
    });
}
