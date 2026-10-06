//! Single-instance routing: reuse the main window (default) or spawn `doc-*` windows.

use crate::access::{register_file, register_vault};
use crate::vault_ops::MEDIA_EXTS;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static DOC_SEQ: AtomicU64 = AtomicU64::new(1);

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("markelle.json"))
}

/// Settings key `openFilesInNewWindow` — default false (reuse existing window).
pub fn open_files_in_new_window(app: &AppHandle) -> bool {
    let Some(path) = store_path(app) else {
        return false;
    };
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    v.get("settings")
        .and_then(|s| s.get("openFilesInNewWindow"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false)
}

fn resolve_arg(arg: &str, cwd: Option<&str>) -> PathBuf {
    let p = PathBuf::from(arg);
    if p.is_absolute() {
        return p;
    }
    if let Some(cwd) = cwd {
        return PathBuf::from(cwd).join(p);
    }
    p
}

/// First file/dir path from argv-style args (skips flags and the executable).
pub fn first_openable(args: &[String], cwd: Option<&str>) -> Option<PathBuf> {
    for arg in args.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let path = resolve_arg(arg, cwd);
        if path.is_file() || path.is_dir() {
            return Some(path);
        }
    }
    None
}

pub fn focus_window(app: &AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Extensions an OS file-association / CLI launch may auto-register. Anything
/// else is rejected: such paths reach the ACL with no user confirmation dialog,
/// so only the types the app actually handles are accepted.
fn is_openable_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    matches!(ext.as_str(), "md" | "markdown" | "mdown" | "mkd")
        || MEDIA_EXTS.contains(&ext.as_str())
}

pub fn deliver_path(app: &AppHandle, path: &Path, window_label: Option<&str>) {
    let arg = path.to_string_lossy().to_string();
    if path.is_file() {
        if !is_openable_file(path) {
            return;
        }
        // Registering adds the path to the ACL. If it fails, emitting the open
        // request would hand the frontend a path every read/write will reject;
        // skip the emit instead of producing an unexplained failure.
        if let Err(err) = register_file(app, path) {
            eprintln!("register file failed, skipping open request: {err}");
            return;
        }
        if let Some(label) = window_label {
            let _ = app.emit_to(label, "open-file-request", arg);
        } else {
            let _ = app.emit("open-file-request", arg);
        }
        return;
    }
    if path.is_dir() {
        if let Err(err) = register_vault(app, path) {
            eprintln!("register vault failed, skipping open request: {err}");
            return;
        }
        if let Some(label) = window_label {
            let _ = app.emit_to(label, "open-vault-request", arg);
        } else {
            let _ = app.emit("open-vault-request", arg);
        }
    }
}

fn spawn_doc_window(app: &AppHandle, path: Option<PathBuf>) -> Result<(), String> {
    let n = DOC_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("doc-{n}");

    // Same cold-start contract as the `main` window (see lib.rs::run): start
    // hidden so the user never sees the flat pre-paint rectangle, and let the
    // frontend reveal it after its first paint.
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Markelle")
        .inner_size(1280.0, 860.0)
        .min_inner_size(720.0, 480.0)
        .decorations(false)
        .visible(false)
        .build()
        .map_err(|e| format!("无法创建窗口: {e}"))?;

    // Failsafe: a process/thread that never paints must still end up visible.
    let guard = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(5000));
        if !guard.is_visible().unwrap_or(true) {
            let _ = guard.show();
        }
    });

    if let Some(path) = path {
        let app2 = app.clone();
        let label2 = label.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(450));
            deliver_path(&app2, &path, Some(&label2));
        });
    }

    Ok(())
}

/// Startup args for the first process.
pub fn emit_startup_path(app: &AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    if let Some(path) = first_openable(&args, None) {
        deliver_path(app, &path, Some("main"));
    }
}

/// Second process was launched (file association / shortcut) — route into the running app.
pub fn on_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    let path = first_openable(&args, Some(&cwd));

    if open_files_in_new_window(app) {
        let _ = spawn_doc_window(app, path);
        return;
    }

    focus_window(app, "main");
    if let Some(path) = path {
        deliver_path(app, &path, Some("main"));
    }
}
