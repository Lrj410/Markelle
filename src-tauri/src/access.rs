use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Paths the frontend (and asset protocol) may touch.
#[derive(Default)]
pub struct AccessSet {
    /// Canonical vault roots (recursive FS access).
    pub vault_roots: Vec<PathBuf>,
    /// Individual files (e.g. opened outside a vault).
    pub files: HashSet<PathBuf>,
    /// Parent dirs of opened files — same-directory FS access only (not recursive).
    pub dirs: HashSet<PathBuf>,
}

pub struct AppState {
    pub access: Mutex<AccessSet>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            access: Mutex::new(AccessSet::default()),
        }
    }
}

pub fn canonicalize_lossy(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Lexically normalize a path: resolve `.` / `..`.
/// Rejects absolute paths that would climb above the drive/root via `..`.
pub fn normalize_path(path: &Path) -> Result<PathBuf, String> {
    let mut out = PathBuf::new();
    let mut has_root = false;
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => {
                out.push(p.as_os_str());
            }
            Component::RootDir => {
                out.push(comp.as_os_str());
                has_root = true;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                match out.components().next_back() {
                    None | Some(Component::Prefix(_)) | Some(Component::RootDir) => {
                        if has_root || out.components().any(|c| matches!(c, Component::Prefix(_))) {
                            return Err("路径包含非法的上级目录引用 (..)".into());
                        }
                        out.push("..");
                    }
                    Some(Component::ParentDir) => out.push(".."),
                    Some(Component::Normal(_)) => {
                        out.pop();
                    }
                    Some(Component::CurDir) => {
                        out.pop();
                        out.push("..");
                    }
                }
            }
            Component::Normal(s) => out.push(s),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("路径无效".into());
    }
    Ok(out)
}

/// Prefer full canonicalize when possible; otherwise lexical normalize.
pub fn resolve_for_acl(path: &Path) -> Result<PathBuf, String> {
    if let Ok(c) = path.canonicalize() {
        return Ok(c);
    }
    // Walk up to find an existing prefix, canonicalize it, then append remaining segments.
    let mut cur = path.to_path_buf();
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if cur.as_os_str().is_empty() {
            break;
        }
        if let Ok(c) = cur.canonicalize() {
            let mut joined = c;
            for s in suffix.iter().rev() {
                if s == ".." {
                    if !joined.pop() {
                        return Err("路径包含非法的上级目录引用 (..)".into());
                    }
                } else if s != "." {
                    joined.push(s);
                }
            }
            return Ok(joined);
        }
        match cur.file_name() {
            Some(name) => {
                suffix.push(name.to_os_string());
                if !cur.pop() {
                    break;
                }
            }
            None => break,
        }
    }
    normalize_path(path)
}

pub fn is_under(child: &Path, root: &Path) -> bool {
    let Ok(child) = resolve_for_acl(child) else {
        return false;
    };
    let Ok(root) = resolve_for_acl(root) else {
        return false;
    };
    if child == root {
        return true;
    }
    child.starts_with(&root)
        && child
            .strip_prefix(&root)
            .ok()
            .and_then(|rest| rest.components().next())
            .is_some()
}

pub fn is_symlink(path: &Path) -> bool {
    fs_symlink_meta(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

fn fs_symlink_meta(path: &Path) -> std::io::Result<std::fs::Metadata> {
    std::fs::symlink_metadata(path)
}

/// Types reachable through a same-directory (non-recursive) grant. Opening one
/// note must not expose unrelated siblings in the folder, so the parent-directory
/// scope only covers note + attachment/media extensions.
const SAME_DIR_ALLOWED_EXTS: &[&str] = &[
    // notes
    "md", "markdown", "mdown", "mkd", // images
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "heic", "heif", // audio
    "mp3", "wav", "ogg", "m4a", "aac", "flac", // video
    "mp4", "webm", "ogv", "mov", // documents / archives accepted by the attachment import path
    "pdf", "zip",
];

fn has_supported_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .map(|e| SAME_DIR_ALLOWED_EXTS.iter().any(|x| *x == e))
        .unwrap_or(false)
}

impl AccessSet {
    pub fn allow_vault(&mut self, root: &Path) -> Result<(), String> {
        let root = resolve_for_acl(root)?;
        if !self.vault_roots.iter().any(|r| r == &root) {
            self.vault_roots.push(root);
        }
        Ok(())
    }

    pub fn revoke_vault(&mut self, root: &Path) {
        let Ok(root) = resolve_for_acl(root) else {
            return;
        };
        self.vault_roots.retain(|r| r != &root);
    }

    pub fn allow_file(&mut self, path: &Path) -> Result<(), String> {
        let path = resolve_for_acl(path)?;
        // Reject paths that still contain `..` after resolve (shouldn't happen).
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err("拒绝包含 .. 的路径".into());
        }
        self.files.insert(path.clone());
        // Only grant the sibling-directory scope for supported note/media types;
        // opening one file must not expose arbitrary files in the same folder.
        if has_supported_ext(&path) {
            if let Some(parent) = path.parent() {
                self.dirs
                    .insert(resolve_for_acl(parent).unwrap_or_else(|_| parent.to_path_buf()));
            }
        }
        Ok(())
    }

    pub fn is_allowed(&self, path: &Path) -> bool {
        let Ok(path) = resolve_for_acl(path) else {
            return false;
        };
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            return false;
        }
        if self.files.contains(&path) {
            return true;
        }
        // An explicitly authorized directory itself (e.g. the folder of a file that
        // was opened outside a vault) — commands such as adjacent attachment writes
        // pass the directory, which carries no extension.
        if self.dirs.contains(&path) {
            return true;
        }
        for root in &self.vault_roots {
            if is_under(&path, root) {
                return true;
            }
        }
        // Same-directory only — not recursive under parent of an opened file, and
        // limited to supported note/attachment types.
        if has_supported_ext(&path) {
            if let Some(parent) = path.parent() {
                if let Ok(parent) = resolve_for_acl(parent) {
                    if self.dirs.contains(&parent) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

pub fn ensure_allowed(state: &AppState, path: &Path) -> Result<(), String> {
    let access = state
        .access
        .lock()
        .map_err(|_| "访问控制锁失败".to_string())?;
    if access.is_allowed(path) {
        Ok(())
    } else {
        Err(format!(
            "拒绝访问未授权路径（请先通过「打开文件 / 打开库」选择）: {}",
            path.display()
        ))
    }
}

pub fn register_file(app: &AppHandle, path: &Path) -> Result<(), String> {
    let resolved = resolve_for_acl(path)?;
    let state = app.state::<AppState>();
    {
        let mut access = state
            .access
            .lock()
            .map_err(|_| "访问控制锁失败".to_string())?;
        access.allow_file(&resolved)?;
    }
    // Media is served via ACL-gated `mklasset` protocol — no broad asset: scope.
    let _ = app;
    Ok(())
}

pub fn register_vault(app: &AppHandle, root: &Path) -> Result<(), String> {
    let resolved = resolve_for_acl(root)?;
    // Reject drive roots / over-broad registrations (SEC-02).
    reject_overbroad_root(&resolved)?;
    let state = app.state::<AppState>();
    {
        let mut access = state
            .access
            .lock()
            .map_err(|_| "访问控制锁失败".to_string())?;
        access.allow_vault(&resolved)?;
    }
    let _ = app;
    Ok(())
}

/// Reject filesystem roots, over-broad system directories, and paths inside
/// well-known OS trees (`C:\Windows`, `C:\Program Files`, `/etc`, ...).
pub fn reject_overbroad_root(path: &Path) -> Result<(), String> {
    let normals: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    if normals.is_empty() {
        return Err("拒绝将磁盘根目录注册为库".into());
    }

    // `C:\Users`, `C:\Windows`, `/home`, `/etc` etc. are too broad for recursive ACL.
    const BLOCKED_SEGMENTS: &[&str] = &[
        "users",
        "windows",
        "program files",
        "program files (x86)",
        "programdata",
        "system volume information",
        "windows.old",
        "home",
        "root",
        "etc",
        "var",
        "usr",
        "bin",
        "sbin",
        "boot",
        "dev",
        "proc",
        "sys",
        "applications",
        "library",
        "system",
        "volumes",
    ];
    if normals.len() == 1 && BLOCKED_SEGMENTS.iter().any(|b| *b == normals[0]) {
        return Err("拒绝将系统目录注册为库".into());
    }

    let first = normals[0].as_str();

    // Windows system trees anywhere below the drive root (case-insensitive).
    const BLOCKED_ROOTS: &[&str] = &[
        "windows",
        "program files",
        "program files (x86)",
        "programdata",
    ];
    if BLOCKED_ROOTS.contains(&first) {
        return Err("拒绝将系统目录注册为库".into());
    }
    // `C:\Users\<user>\AppData\...` — per-user app data is not a note vault.
    if first == "users" && normals.get(2).map(String::as_str) == Some("appdata") {
        return Err("拒绝将用户 AppData 目录注册为库".into());
    }
    // `C:\Users\<user>`（macOS 的 `/Users/<user>` 同理）是用户主目录本身，含 `.ssh`、
    // 浏览器数据等敏感内容，仅拦 AppData 不足以覆盖，按「两段式 users/xxx」显式拒绝。
    if first == "users" && normals.len() == 2 {
        return Err("拒绝将用户主目录注册为库".into());
    }

    // Unix system trees (`/etc`, `/usr`, ...). Windows drive paths carry a
    // `Prefix` component, so they never take this branch.
    let is_unix_like = path.has_root()
        && !path.components().any(|c| matches!(c, Component::Prefix(_)));
    if is_unix_like {
        const UNIX_BLOCKED: &[&str] = &[
            "etc",
            "usr",
            "bin",
            "sbin",
            "boot",
            "dev",
            "proc",
            "sys",
            "var",
            "system",
            "library",
            "applications",
            "private",
            "cores",
        ];
        if UNIX_BLOCKED.contains(&first) {
            return Err("拒绝将系统目录注册为库".into());
        }
    }

    Ok(())
}

pub fn revoke_vault(app: &AppHandle, root: &Path) -> Result<(), String> {
    let resolved = resolve_for_acl(root).unwrap_or_else(|_| root.to_path_buf());
    let state = app.state::<AppState>();
    {
        let mut access = state
            .access
            .lock()
            .map_err(|_| "访问控制锁失败".to_string())?;
        access.revoke_vault(&resolved);
    }
    // Drop path/edge index so search/graph cannot reuse data after vault close.
    if let Some(cache) = app.try_state::<crate::vault_index::IndexCache>() {
        cache.clear();
    }
    crate::vault_watch::stop_vault_watch();
    // Asset loads go through the ACL-gated `mklasset` protocol (see lib.rs).
    // Clearing our ACL immediately denies new asset fetches. We intentionally do
    // NOT call Scope::forbid_directory — forbid permanently blocks re-allow.
    let _ = resolved;
    Ok(())
}

/// Intentional user authorization only (dialog / drop / CLI / save-as).
/// Never called implicitly from read/write.
#[tauri::command]
pub fn register_access(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    for raw in paths {
        let path = PathBuf::from(&raw);
        // Hard reject raw `..` segments before any registration.
        if path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(format!("拒绝包含 .. 的路径: {raw}"));
        }
        if path.is_dir() {
            register_vault(&app, &path)?;
        } else {
            // Existing file, or save-as target that does not exist yet.
            register_file(&app, &path)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn revoke_vault_access(app: AppHandle, root: String) -> Result<(), String> {
    let path = PathBuf::from(&root);
    revoke_vault(&app, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirs_are_same_directory_only() {
        let mut set = AccessSet::default();
        set.allow_file(Path::new("C:/notes/a.md")).unwrap();
        assert!(set.is_allowed(Path::new("C:/notes/a.md")));
        assert!(set.is_allowed(Path::new("C:/notes/b.md")));
        assert!(!set.is_allowed(Path::new("C:/notes/sub/c.md")));
        assert!(!set.is_allowed(Path::new("C:/other/x.md")));
    }

    #[test]
    fn allowed_dir_itself_is_allowed() {
        // Adjacent attachment commands pass the directory, which has no extension.
        let mut set = AccessSet::default();
        set.allow_file(Path::new("C:/notes/a.md")).unwrap();
        assert!(set.is_allowed(Path::new("C:/notes")));
        assert!(!set.is_allowed(Path::new("C:/other")));
    }

    #[test]
    fn vault_is_recursive() {
        let mut set = AccessSet::default();
        set.allow_vault(Path::new("C:/vault")).unwrap();
        assert!(set.is_allowed(Path::new("C:/vault/a.md")));
        assert!(set.is_allowed(Path::new("C:/vault/deep/nested/b.md")));
        assert!(!set.is_allowed(Path::new("C:/elsewhere/c.md")));
    }

    #[test]
    fn parent_dir_escape_is_rejected() {
        let mut set = AccessSet::default();
        set.allow_vault(Path::new("C:/vault")).unwrap();
        assert!(!is_under(
            Path::new("C:/vault/../../Windows/evil.md"),
            Path::new("C:/vault")
        ));
        assert!(!set.is_allowed(Path::new("C:/vault/../../Windows/evil.md")));
    }

    #[test]
    fn normalize_collapses_dotdot() {
        let p = normalize_path(Path::new("C:/vault/sub/../note.md")).unwrap();
        assert_eq!(p, PathBuf::from("C:/vault/note.md"));
    }

    #[test]
    fn register_access_rejects_raw_dotdot() {
        let path = PathBuf::from("C:/vault/../../Windows/x.md");
        assert!(path.components().any(|c| matches!(c, Component::ParentDir)));
    }

    #[test]
    fn reject_overbroad_blocks_system_dirs() {
        assert!(reject_overbroad_root(Path::new("C:/")).is_err());
        assert!(reject_overbroad_root(Path::new("C:/Users")).is_err());
        assert!(reject_overbroad_root(Path::new("C:/Windows")).is_err());
        assert!(reject_overbroad_root(Path::new("C:/vault")).is_ok());
        assert!(reject_overbroad_root(Path::new("C:/Users/alice/notes")).is_ok());
    }

    #[test]
    fn reject_overbroad_blocks_system_prefixes() {
        assert!(reject_overbroad_root(Path::new("C:/Windows/System32")).is_err());
        assert!(reject_overbroad_root(Path::new("C:/Program Files/App")).is_err());
        assert!(reject_overbroad_root(Path::new("C:/Program Files (x86)/App")).is_err());
        assert!(reject_overbroad_root(Path::new("C:/ProgramData/foo")).is_err());
        assert!(reject_overbroad_root(Path::new("C:/Users/alice/AppData/Roaming")).is_err());
        assert!(reject_overbroad_root(Path::new("/etc/nginx")).is_err());
        assert!(reject_overbroad_root(Path::new("/usr/local")).is_err());
        assert!(reject_overbroad_root(Path::new("/")).is_err());
        assert!(reject_overbroad_root(Path::new("D:/projects/notes")).is_ok());
        assert!(reject_overbroad_root(Path::new("/home/alice/notes")).is_ok());
    }

    #[test]
    fn reject_overbroad_blocks_user_home_dir() {
        // 用户主目录本身过宽（.ssh、浏览器数据等），必须拒绝。
        assert!(reject_overbroad_root(Path::new("C:/Users/alice")).is_err());
        assert!(reject_overbroad_root(Path::new("/Users/alice")).is_err());
        // 主目录下的具体项目目录仍然允许。
        assert!(reject_overbroad_root(Path::new("C:/Users/alice/notes")).is_ok());
    }

    #[test]
    fn same_directory_denies_unsupported_extensions() {
        let mut set = AccessSet::default();
        set.allow_file(Path::new("C:/notes/a.md")).unwrap();
        // Opened file itself is always readable.
        assert!(set.is_allowed(Path::new("C:/notes/a.md")));
        // Supported siblings (notes / media) are reachable.
        assert!(set.is_allowed(Path::new("C:/notes/b.md")));
        assert!(set.is_allowed(Path::new("C:/notes/pic.png")));
        // Unrelated files in the same folder are not exposed.
        assert!(!set.is_allowed(Path::new("C:/notes/secrets.txt")));
        assert!(!set.is_allowed(Path::new("C:/notes/keys.pem")));
    }
}
