//! Recursive filesystem watcher for the open vault.
//! Debounces change bursts and notifies the frontend via `vault-fs-changed`.

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Clone, Serialize)]
struct VaultFsChanged {
    root: String,
}

/// Keeps the OS watcher alive; dropping stops watching and ends the debounce thread.
struct WatchGuard {
    _watcher: RecommendedWatcher,
}

static ACTIVE: OnceLock<Mutex<Option<WatchGuard>>> = OnceLock::new();

fn active() -> &'static Mutex<Option<WatchGuard>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

fn is_interesting(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_)
            | EventKind::Modify(_)
            | EventKind::Remove(_)
            | EventKind::Any
    )
}

/// Ignore events our own writers generate (history, temp files) so saving a note
/// does not trigger the watcher and re-index in a feedback loop.
fn is_ignored_path(path: &Path) -> bool {
    let s = path.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    if s.contains("/.markelle/") || s.ends_with("/.markelle") {
        return true;
    }
    if s.contains("/.git/") || s.ends_with("/.git") {
        return true;
    }
    s.ends_with(".tmp") || s.ends_with(".mkl-tmp")
}

/// Stop any previous vault watch. Safe to call when none is active.
pub fn stop_vault_watch() {
    if let Ok(mut guard) = active().lock() {
        *guard = None;
    }
}

/// Start watching `root` recursively. Replaces any existing vault watch.
pub fn start_vault_watch(app: AppHandle, root: PathBuf) {
    stop_vault_watch();

    let (event_tx, event_rx) = mpsc::channel::<()>();

    let mut watcher = match RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            let event = match res {
                Ok(event) => event,
                Err(err) => {
                    eprintln!("vault watch error: {err}");
                    return;
                }
            };
            if !is_interesting(&event.kind) {
                return;
            }
            if event.paths.is_empty() || event.paths.iter().all(|p| is_ignored_path(p)) {
                return;
            }
            let _ = event_tx.send(());
        },
        Config::default(),
    ) {
        Ok(w) => w,
        Err(err) => {
            eprintln!("vault watcher init failed: {err}");
            return;
        }
    };

    if let Err(err) = watcher.watch(&root, RecursiveMode::Recursive) {
        eprintln!("vault watch failed for {}: {err}", root.display());
        return;
    }

    let root_payload = root.to_string_lossy().to_string();
    thread::spawn(move || {
        loop {
            // Wait for the first event in a burst.
            if event_rx.recv().is_err() {
                break;
            }
            // Debounce: reset the quiet window on every subsequent event.
            loop {
                match event_rx.recv_timeout(DEBOUNCE) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }

            if let Some(cache) = app.try_state::<crate::vault_index::IndexCache>() {
                cache.clear();
            }
            let _ = app.emit(
                "vault-fs-changed",
                VaultFsChanged {
                    root: root_payload.clone(),
                },
            );
        }
    });

    if let Ok(mut guard) = active().lock() {
        *guard = Some(WatchGuard {
            _watcher: watcher,
        });
    }
}
