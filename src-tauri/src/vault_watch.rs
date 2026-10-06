//! Recursive filesystem watcher for open vaults.
//! Debounces change bursts and notifies the frontend via `vault-fs-changed`.
//!
//! One watcher is kept per vault root, so closing one vault no longer stops
//! watching every other open vault.

use crate::access::canonicalize_lossy;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const DEBOUNCE: Duration = Duration::from_millis(400);
/// How long a self-write suppression entry stays valid.
const SUPPRESS_TTL: Duration = Duration::from_secs(10);

#[derive(Clone, Serialize)]
struct VaultFsChanged {
    root: String,
}

/// Keeps the OS watcher alive; dropping stops watching and ends the debounce thread.
struct WatchGuard {
    _watcher: RecommendedWatcher,
}

static ACTIVE: OnceLock<Mutex<HashMap<PathBuf, WatchGuard>>> = OnceLock::new();

fn active() -> &'static Mutex<HashMap<PathBuf, WatchGuard>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Canonical key so `open_vault` and `revoke_vault` (which may pass a raw vs.
/// resolved root) address the same watcher.
fn watch_key(root: &Path) -> PathBuf {
    canonicalize_lossy(root)
}

static SUPPRESS: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();

fn suppressed() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    SUPPRESS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune_suppressed(map: &mut HashMap<PathBuf, Instant>, now: Instant) {
    map.retain(|_, t| now.duration_since(*t) < SUPPRESS_TTL);
}

/// Record that this process just wrote `path`, so the watcher ignores the echo of
/// our own save. Entries expire after [`SUPPRESS_TTL`] and are pruned on every
/// read/write, so the table cannot grow unbounded.
pub fn note_self_write(path: &Path) {
    let now = Instant::now();
    if let Ok(mut map) = suppressed().lock() {
        prune_suppressed(&mut map, now);
        map.insert(watch_key(path), now);
    }
}

fn is_self_write(path: &Path) -> bool {
    let now = Instant::now();
    let Ok(mut map) = suppressed().lock() else {
        return false;
    };
    prune_suppressed(&mut map, now);
    map.contains_key(&watch_key(path))
}

fn is_interesting(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
    )
}

/// Ignore events our own writers generate (history, temp files) so saving a note
/// does not trigger the watcher and re-index in a feedback loop.
fn is_ignored_path(path: &Path) -> bool {
    let s = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if s.contains("/.markelle/") || s.ends_with("/.markelle") {
        return true;
    }
    if s.contains("/.git/") || s.ends_with("/.git") {
        return true;
    }
    // Atomic-write temp files and the `.bak` swap produced by the `commit_atomic`
    // fallback (see lib.rs) — they must not look like external edits.
    if s.ends_with(".tmp") || s.ends_with(".mkl-tmp") || s.ends_with(".bak") {
        return true;
    }
    // Editor backup / swap files and lock files.
    if s.ends_with(".swp") || s.ends_with('~') {
        return true;
    }
    let name = s.rsplit('/').next().unwrap_or(&s);
    if name.starts_with(".#") || name.starts_with(".~lock") {
        return true;
    }
    false
}

/// Stop watching `root` only; other open vaults keep their watchers.
/// Safe to call when `root` is not being watched.
pub fn stop_vault_watch(root: &Path) {
    let key = watch_key(root);
    if let Ok(mut guard) = active().lock() {
        guard.remove(&key);
    }
}

/// Stop every vault watcher. Only for genuine app shutdown.
pub fn stop_all_vault_watches() {
    if let Ok(mut guard) = active().lock() {
        guard.clear();
    }
}

/// Start watching `root` recursively. Replaces only this root's watcher.
pub fn start_vault_watch(app: AppHandle, root: PathBuf) {
    let key = watch_key(&root);

    // Replace any previous watcher for this root (drop it before rebuilding).
    if let Ok(mut guard) = active().lock() {
        guard.remove(&key);
    }

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
            if event.paths.is_empty()
                || event
                    .paths
                    .iter()
                    .all(|p| is_ignored_path(p) || is_self_write(p))
            {
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
        guard.insert(key, WatchGuard { _watcher: watcher });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignore_rules_cover_own_writes_and_temp_files() {
        assert!(is_ignored_path(Path::new("C:/vault/.markelle/history/x")));
        assert!(is_ignored_path(Path::new("C:/vault/.git/index")));
        assert!(is_ignored_path(Path::new("C:/vault/.note.md.1.tmp")));
        assert!(is_ignored_path(Path::new("C:/vault/.note.md.1.bak")));
        assert!(is_ignored_path(Path::new("C:/vault/.note.md.swp")));
        assert!(is_ignored_path(Path::new("C:/vault/note.md~")));
        assert!(is_ignored_path(Path::new("C:/vault/.#note.md")));
        assert!(is_ignored_path(Path::new("C:/vault/.~lock.note.md#")));
        // Real note edits must still be reported.
        assert!(!is_ignored_path(Path::new("C:/vault/note.md")));
        assert!(!is_ignored_path(Path::new("C:/vault/sub/page.md")));
    }

    #[test]
    fn self_write_suppression_is_path_scoped_and_pruned() {
        let dir = std::env::temp_dir().join(format!("mkl-watch-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let written = dir.join("just-saved.md");
        let other = dir.join("external.md");
        std::fs::write(&written, b"x").unwrap();

        note_self_write(&written);
        assert!(is_self_write(&written));
        assert!(
            !is_self_write(&other),
            "unrelated paths must not be suppressed"
        );

        // Expired entries are pruned so the table cannot grow unbounded.
        let mut map = HashMap::new();
        map.insert(
            watch_key(&other),
            Instant::now()
                .checked_sub(SUPPRESS_TTL * 2)
                .expect("monotonic clock"),
        );
        prune_suppressed(&mut map, Instant::now());
        assert!(map.is_empty(), "expired suppression not pruned");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
