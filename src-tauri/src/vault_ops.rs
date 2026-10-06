use crate::access::{
    ensure_allowed, is_symlink, is_under, resolve_for_acl, verify_parent_within, AppState,
};
use crate::util::percent_decode_str;
use std::fs;
use std::fs::OpenOptions;
use std::path::{Component, Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};

/// Resolve `relative` under vault `root`. Rejects `..`, absolute relatives, and escapes.
pub fn resolve_under_vault(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative.trim_matches(|c| c == '/' || c == '\\');
    let rel = Path::new(relative);
    if rel.is_absolute() {
        return Err("相对路径不能为绝对路径".into());
    }
    for comp in rel.components() {
        match comp {
            Component::ParentDir => {
                return Err("路径包含非法的上级目录引用 (..)".into());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("相对路径无效".into());
            }
            Component::CurDir => {}
            Component::Normal(_) => {}
        }
    }

    let joined = if relative.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };

    let resolved = resolve_for_acl(&joined)?;
    let root_resolved = resolve_for_acl(root)?;
    if !is_under(&resolved, &root_resolved) {
        return Err("路径超出库根目录".into());
    }
    Ok(resolved)
}

fn ensure_absolute_in_vault(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("路径包含非法的上级目录引用 (..)".into());
    }
    let root_resolved = resolve_for_acl(root)?;
    let path_resolved = resolve_for_acl(path)?;
    if !is_under(&path_resolved, &root_resolved) {
        return Err(format!("路径超出库根目录: {}", path.display()));
    }
    if path.exists() && is_symlink(path) {
        return Err("拒绝操作符号链接".into());
    }
    Ok(path_resolved)
}

#[tauri::command]
pub async fn vault_create_dir(
    state: State<'_, AppState>,
    root: String,
    relative: String,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    ensure_allowed(&state, &root_path)?;
    if relative.trim().is_empty() {
        return Err("相对路径不能为空".into());
    }
    let target = resolve_under_vault(&root_path, &relative)?;
    let root_resolved = resolve_for_acl(&root_path)?;
    if target == root_resolved {
        return Err("不能创建库根目录本身".into());
    }
    if target.exists() {
        if target.is_dir() {
            return Ok(());
        }
        return Err(format!("路径已存在且不是目录: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        if parent.exists() && is_symlink(parent) {
            return Err("拒绝在符号链接下创建目录".into());
        }
    }
    let container = root_resolved.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                verify_parent_within(&container, parent)?;
            }
        }
        fs::create_dir_all(&target).map_err(|e| format!("无法创建目录: {e}"))
    })
    .await
    .map_err(|e| format!("创建目录任务失败: {e}"))?
}

#[tauri::command]
pub async fn vault_rename(
    state: State<'_, AppState>,
    root: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    ensure_allowed(&state, &root_path)?;

    let from = PathBuf::from(&from_path);
    let to = PathBuf::from(&to_path);
    let from_resolved = ensure_absolute_in_vault(&root_path, &from)?;
    let to_resolved = ensure_absolute_in_vault(&root_path, &to)?;

    let root_resolved = resolve_for_acl(&root_path)?;
    if from_resolved == root_resolved {
        return Err("不能重命名库根目录".into());
    }
    if !from_resolved.exists() {
        return Err(format!("源路径不存在: {}", from.display()));
    }
    if to_resolved.exists() {
        return Err(format!("目标路径已存在: {}", to.display()));
    }
    let container = root_resolved.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = to_resolved.parent() {
            if !parent.as_os_str().is_empty() {
                if !parent.exists() {
                    fs::create_dir_all(parent).map_err(|e| format!("无法创建目标父目录: {e}"))?;
                }
                verify_parent_within(&container, parent)?;
            }
        }
        fs::rename(&from_resolved, &to_resolved).map_err(|e| format!("无法重命名: {e}"))
    })
    .await
    .map_err(|e| format!("重命名任务失败: {e}"))?
}

/// Max bytes for a single imported attachment (align with mklasset display cap).
pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 128 * 1024 * 1024;

/// Windows reserved device names (case-insensitive): a file whose stem is one of
/// these resolves to a device, not a regular file.
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Validate a bare attachment file name (no directory components).
///
/// Rejects separators, `..`, Windows reserved device names (also with an
/// extension, e.g. `CON.md`), trailing dots/spaces (which Windows strips, so
/// `NUL.` still hits the device), and — on Windows — any `:` (an NTFS alternate
/// data stream like `a.md:secret` would bypass the same-directory assumption).
fn validate_attachment_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
    {
        return Err("非法附件文件名".into());
    }
    if cfg!(windows) && name.contains(':') {
        return Err("附件文件名不能包含冒号（仅 Windows）".into());
    }
    // `trim()` above already removed trailing spaces; reject trailing dots as
    // well (Windows strips them, so `NUL.` would still hit the device).
    if name.ends_with('.') {
        return Err("附件文件名不能以点或空格结尾".into());
    }
    let stem = name.split('.').next().unwrap_or(name);
    let stem = stem.to_ascii_lowercase();
    if WINDOWS_RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(format!("附件文件名不能使用系统保留名称: {stem}"));
    }
    Ok(())
}

/// If `preferred` exists, pick `stem-2.ext`, `stem-3.ext`, … (never overwrite).
///
/// The name is claimed atomically with `create_new`, so two concurrent imports
/// of the same name cannot both select `-2` and clobber each other. The caller
/// writes into the returned (empty) file. The parent directory must already
/// exist; it is created if missing.
fn allocate_unique_file_path(preferred: &Path) -> Result<PathBuf, String> {
    // Try to claim `path`. `Ok(true)` = claimed, `Ok(false)` = already exists.
    fn claim(path: &Path) -> Result<bool, String> {
        match OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(format!("无法创建附件文件: {e}")),
        }
    }

    let parent = preferred
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    if !parent.as_os_str().is_empty() {
        fs::create_dir_all(&parent).map_err(|e| format!("无法创建目录: {e}"))?;
    }

    match fs::symlink_metadata(preferred) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err("拒绝写入符号链接".into());
            }
            if meta.is_dir() {
                return Err("目标已是目录".into());
            }
        }
        Err(_) => {
            if claim(preferred)? {
                return Ok(preferred.to_path_buf());
            }
        }
    }

    let stem = preferred
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = preferred
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for i in 2..=500 {
        let candidate = parent.join(format!("{stem}-{i}{ext}"));
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(_) => {
                if claim(&candidate)? {
                    return Ok(candidate);
                }
            }
        }
    }
    Err("无法分配唯一附件文件名".into())
}

/// Write a single file into an already-authorized directory (same-folder ACL).
/// `file_name` must be a bare name — no separators — so we never create subdirs
/// outside the open-file directory grant.
#[tauri::command]
pub async fn write_adjacent_bytes(
    state: State<'_, AppState>,
    dir: String,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    if data.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "附件过大（上限 {} MB）",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let name = file_name.trim();
    validate_attachment_name(name)?;
    let dir_path = PathBuf::from(&dir);
    ensure_allowed(&state, &dir_path)?;
    let preferred = dir_path.join(name);
    // Check before claiming a name so a rejected request cannot leave an empty
    // file behind (the suffix allocation creates the file atomically).
    ensure_allowed(&state, &preferred)?;
    let target = allocate_unique_file_path(&preferred)?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::write(&target, &data).map_err(|e| format!("无法写入附件: {e}"))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("写入附件任务失败: {e}"))?
}

fn header_decoded(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("缺少请求头 {name}"))?
        .to_str()
        .map_err(|_| format!("请求头 {name} 无效"))?;
    Ok(percent_decode_str(raw).unwrap_or_else(|| raw.to_string()))
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(data) => Ok(data.clone()),
        _ => Err("需要原始二进制请求体".into()),
    }
}

/// Raw-body write: Uint8Array payload + `X-Mkl-Dir` / `X-Mkl-Name` headers (percent-encoded).
#[tauri::command]
pub async fn write_adjacent_bytes_raw(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<String, String> {
    let data = raw_body(&request)?;
    let dir = header_decoded(&request, "X-Mkl-Dir")?;
    let file_name = header_decoded(&request, "X-Mkl-Name")?;
    write_adjacent_bytes(state, dir, file_name, data).await
}

/// Raw-body write under vault: Uint8Array + `X-Mkl-Root` / `X-Mkl-Relative` headers.
#[tauri::command]
pub async fn vault_write_bytes_raw(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<String, String> {
    let data = raw_body(&request)?;
    let root = header_decoded(&request, "X-Mkl-Root")?;
    let relative = header_decoded(&request, "X-Mkl-Relative")?;
    vault_write_bytes(state, root, relative, data).await
}

/// Read an ACL-allowed file as a raw binary response (no JSON number[]).
#[tauri::command]
pub async fn read_allowed_bytes(
    state: State<'_, AppState>,
    path: String,
) -> Result<Response, String> {
    let path = PathBuf::from(&path);
    ensure_allowed(&state, &path)?;
    if is_symlink(&path) {
        return Err("拒绝读取符号链接".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| format!("无法读取文件信息: {e}"))?;
        if !meta.is_file() {
            return Err("不是文件".into());
        }
        if meta.len() > MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "附件过大（上限 {} MB）",
                MAX_ATTACHMENT_BYTES / (1024 * 1024)
            ));
        }
        let data = fs::read(&path).map_err(|e| format!("无法读取文件: {e}"))?;
        Ok(Response::new(data))
    })
    .await
    .map_err(|e| format!("读取附件任务失败: {e}"))?
}

/// Write raw bytes under the vault at `relative` (creates parent dirs).
#[tauri::command]
pub async fn vault_write_bytes(
    state: State<'_, AppState>,
    root: String,
    relative: String,
    data: Vec<u8>,
) -> Result<String, String> {
    if data.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "附件过大（上限 {} MB）",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    if relative.trim().is_empty() {
        return Err("相对路径不能为空".into());
    }
    let root_path = PathBuf::from(&root);
    ensure_allowed(&state, &root_path)?;
    let target = resolve_under_vault(&root_path, &relative)?;
    let root_resolved = resolve_for_acl(&root_path)?;
    if target == root_resolved {
        return Err("不能覆盖库根目录".into());
    }
    if target.exists() {
        if is_symlink(&target) {
            return Err("拒绝写入符号链接".into());
        }
        if target.is_dir() {
            return Err("目标已是目录".into());
        }
    }
    if let Some(parent) = target.parent() {
        if parent.exists() && is_symlink(parent) {
            return Err("拒绝在符号链接下写入".into());
        }
    }
    let container = root_resolved.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {e}"))?;
            verify_parent_within(&container, parent)?;
        }
        let final_target = allocate_unique_file_path(&target)?;
        fs::write(&final_target, &data).map_err(|e| format!("无法写入附件: {e}"))?;
        Ok(final_target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("写入附件任务失败: {e}"))?
}

/// Copy an already-authorized filesystem file into the vault at `relative`.
#[tauri::command]
pub async fn vault_import_file(
    state: State<'_, AppState>,
    root: String,
    relative: String,
    source_path: String,
) -> Result<String, String> {
    if relative.trim().is_empty() {
        return Err("相对路径不能为空".into());
    }
    let root_path = PathBuf::from(&root);
    ensure_allowed(&state, &root_path)?;
    let source = PathBuf::from(&source_path);
    ensure_allowed(&state, &source)?;
    if !source.is_file() {
        return Err(format!("源不是文件: {}", source.display()));
    }
    if is_symlink(&source) {
        return Err("拒绝导入符号链接".into());
    }
    let meta = fs::metadata(&source).map_err(|e| format!("无法读取源文件: {e}"))?;
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "附件过大（上限 {} MB）",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let target = resolve_under_vault(&root_path, &relative)?;
    let root_resolved = resolve_for_acl(&root_path)?;
    if target == root_resolved {
        return Err("不能覆盖库根目录".into());
    }
    if target.exists() {
        if is_symlink(&target) {
            return Err("拒绝写入符号链接".into());
        }
        if target.is_dir() {
            return Err("目标已是目录".into());
        }
    }
    if let Some(parent) = target.parent() {
        if parent.exists() && is_symlink(parent) {
            return Err("拒绝在符号链接下写入".into());
        }
    }
    let container = root_resolved.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {e}"))?;
            verify_parent_within(&container, parent)?;
        }
        let final_target = allocate_unique_file_path(&target)?;
        fs::copy(&source, &final_target).map_err(|e| format!("无法复制附件: {e}"))?;
        Ok(final_target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("导入附件任务失败: {e}"))?
}

/// Copy an authorized source file into an already-authorized note directory
/// (single-file mode without a vault).
#[tauri::command]
pub async fn import_adjacent_file(
    state: State<'_, AppState>,
    dir: String,
    source_path: String,
    file_name: String,
) -> Result<String, String> {
    let name = file_name.trim();
    validate_attachment_name(name)?;
    let dir_path = PathBuf::from(&dir);
    ensure_allowed(&state, &dir_path)?;
    let source = PathBuf::from(&source_path);
    ensure_allowed(&state, &source)?;
    if !source.is_file() {
        return Err(format!("源不是文件: {}", source.display()));
    }
    if is_symlink(&source) {
        return Err("拒绝导入符号链接".into());
    }
    let meta = fs::metadata(&source).map_err(|e| format!("无法读取源文件: {e}"))?;
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "附件过大（上限 {} MB）",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let target = dir_path.join(name);
    ensure_allowed(&state, &target)?;
    let final_target = allocate_unique_file_path(&target)?;
    ensure_allowed(&state, &final_target)?;
    // Re-verify the parent just before copy, matching the other write commands'
    // check-to-use hardening.
    let container = resolve_for_acl(&dir_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = final_target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {e}"))?;
            verify_parent_within(&container, parent)?;
        }
        fs::copy(&source, &final_target).map_err(|e| format!("无法复制附件: {e}"))?;
        Ok(final_target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("导入附件任务失败: {e}"))?
}

/// List `*.md` template files under `{vault}/.markelle/templates/`.
#[tauri::command]
pub async fn list_vault_templates(
    state: State<'_, AppState>,
    vault_root: String,
) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&vault_root);
    ensure_allowed(&state, &root)?;
    let dir = root.join(".markelle").join("templates");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    if is_symlink(&dir) {
        return Err("拒绝读取符号链接模板目录".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| format!("无法读取模板目录: {e}"))? {
            let entry = entry.map_err(|e| format!("无法读取条目: {e}"))?;
            let path = entry.path();
            if is_symlink(&path) {
                continue;
            }
            if path.is_file() {
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if name.ends_with(".md") || name.ends_with(".markdown") {
                    out.push(path.to_string_lossy().to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| format!("读取模板任务失败: {e}"))?
}

#[tauri::command]
pub async fn vault_delete(
    state: State<'_, AppState>,
    root: String,
    path: String,
) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    ensure_allowed(&state, &root_path)?;

    let target = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = ensure_absolute_in_vault(&root_path, &target)?;
        let root_resolved = resolve_for_acl(&root_path)?;
        if resolved == root_resolved {
            return Err("拒绝删除库根目录".into());
        }
        if !resolved.exists() {
            return Err(format!("路径不存在: {}", target.display()));
        }

        let meta = fs::symlink_metadata(&resolved).map_err(|e| format!("无法读取: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err("拒绝删除符号链接".into());
        }
        if meta.is_file() || meta.is_dir() {
            // Prefer system trash / recycle bin; fall back to permanent delete.
            match trash::delete(&resolved) {
                Ok(()) => return Ok(()),
                Err(trash_err) => {
                    // Do not silently permanently delete — surface trash failure to the UI.
                    return Err(format!(
                        "无法移至回收站: {trash_err}（未执行永久删除，请重试或手动处理）"
                    ));
                }
            }
        }
        Err("无法删除该路径类型".into())
    })
    .await
    .map_err(|e| format!("删除任务失败: {e}"))?
}

/// Media/attachment extensions the app can open. Shared with `instance` so a
/// CLI / file-association launch cannot register arbitrary files.
pub(crate) const MEDIA_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "heic", "heif", "mp3", "wav", "ogg",
    "m4a", "aac", "flac", "mp4", "webm", "ogv", "mov", "pdf",
];

fn is_media_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    MEDIA_EXTS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{ext}")))
}

/// Cap for basename walk — keep Obsidian-style lookup snappy on large vaults.
const MEDIA_WALK_MAX_FILES: usize = 8_000;
const MEDIA_WALK_MAX_DEPTH: usize = 12;

fn try_existing_file(state: &AppState, path: &Path) -> Option<PathBuf> {
    if ensure_allowed(state, path).is_err() {
        return None;
    }
    if is_symlink(path) {
        return None;
    }
    match fs::metadata(path) {
        Ok(m) if m.is_file() => Some(path.to_path_buf()),
        _ => None,
    }
}

fn walk_find_media_by_name(
    state: &AppState,
    dir: &Path,
    want_name: &str,
    depth: usize,
    scanned: &mut usize,
    hits: &mut Vec<PathBuf>,
) {
    if depth > MEDIA_WALK_MAX_DEPTH || *scanned >= MEDIA_WALK_MAX_FILES || hits.len() >= 2 {
        return;
    }
    if is_symlink(dir) {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *scanned >= MEDIA_WALK_MAX_FILES || hits.len() >= 2 {
            return;
        }
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.starts_with('.') {
            continue;
        }
        if is_symlink(&path) {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            // Skip heavy / irrelevant trees.
            let skip = matches!(
                name.as_str(),
                "node_modules" | ".git" | ".trash" | ".obsidian" | "target" | "dist"
            );
            if !skip {
                walk_find_media_by_name(state, &path, want_name, depth + 1, scanned, hits);
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        *scanned += 1;
        if !is_media_file_name(&name) {
            continue;
        }
        if name.eq_ignore_ascii_case(want_name) && ensure_allowed(state, &path).is_ok() {
            hits.push(path);
        }
    }
}

/// Normalize media target strings from the frontend / pasted markdown.
fn normalize_media_target(raw: &str) -> String {
    let mut s = raw.trim().replace('\\', "/");
    // Decode %20 etc. so lookup matches on-disk names.
    for _ in 0..3 {
        if !s.contains('%') {
            break;
        }
        match percent_decode_str(&s) {
            Some(next) if next != s => s = next,
            _ => break,
        }
    }
    if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    // `/C:/Users/...` (common when a leading slash was joined onto a drive path)
    if s.len() >= 3 {
        let bytes = s.as_bytes();
        if bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
            s = s[1..].to_string();
        }
    }
    s
}

/// If a broken relative link still embeds an absolute Windows path, extract it.
fn extract_embedded_abs_path(raw: &str) -> Option<String> {
    let s = normalize_media_target(raw);
    // Find `X:/` drive marker
    let bytes = s.as_bytes();
    for i in 0..bytes.len().saturating_sub(2) {
        if bytes[i].is_ascii_alphabetic() && bytes[i + 1] == b':' && bytes[i + 2] == b'/' {
            return Some(s[i..].to_string());
        }
    }
    None
}

/// Join `base` + relative segments, honoring `..` / `.` without requiring the path to exist.
fn join_with_dots(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for seg in rel.replace('\\', "/").split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if !out.pop() {
                return None;
            }
            continue;
        }
        out.push(seg);
    }
    Some(out)
}

fn normalize_attachment_folder(raw: Option<&str>) -> String {
    let trimmed = raw.unwrap_or("attachments").trim().replace('\\', "/");
    let segments: Vec<&str> = trimmed
        .trim_matches('/')
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if segments.is_empty() || segments.iter().any(|s| *s == "." || *s == "..") {
        return "attachments".into();
    }
    segments.join("/")
}

/// Resolve an Obsidian-style media target (`photo.png`, `assets/a.jpg`) under the
/// vault / note directory. Prefers exact relative hits, then a unique basename match.
#[tauri::command]
pub async fn resolve_vault_media(
    app: AppHandle,
    root: String,
    base_dir: String,
    target: String,
    attachment_folder: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        resolve_vault_media_blocking(&state, root, base_dir, target, attachment_folder)
    })
    .await
    .map_err(|e| format!("媒体解析任务失败: {e}"))?
}

fn resolve_vault_media_blocking(
    state: &AppState,
    root: String,
    base_dir: String,
    target: String,
    attachment_folder: Option<String>,
) -> Result<String, String> {
    let raw = normalize_media_target(&target);
    if raw.is_empty() {
        return Err("媒体路径为空".into());
    }
    let name = Path::new(&raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if name.is_empty() || !is_media_file_name(&name) {
        return Err("不是可嵌入的媒体文件".into());
    }

    let folder = normalize_attachment_folder(attachment_folder.as_deref());

    let mut candidates: Vec<PathBuf> = Vec::new();
    let push_cand = |list: &mut Vec<PathBuf>, p: PathBuf| {
        if !list.iter().any(|x| x == &p) {
            list.push(p);
        }
    };

    // Recover absolute path embedded in broken `../../../../C:/…` links.
    if let Some(abs) = extract_embedded_abs_path(&raw) {
        push_cand(&mut candidates, PathBuf::from(&abs));
    }

    let as_path = PathBuf::from(&raw);
    if as_path.is_absolute() {
        push_cand(&mut candidates, as_path);
    }

    let base = PathBuf::from(base_dir.trim());
    let root_path = PathBuf::from(root.trim());

    if !base.as_os_str().is_empty() {
        if let Some(joined) = join_with_dots(&base, &raw) {
            push_cand(&mut candidates, joined);
        }
        push_cand(&mut candidates, base.join(&name));
        push_cand(&mut candidates, base.join(&folder).join(&name));
        // Always keep legacy default as a fallback.
        if folder != "attachments" {
            push_cand(&mut candidates, base.join("attachments").join(&name));
        }
    }

    if !root_path.as_os_str().is_empty() {
        // Prefer vault-root-relative targets (`attachments/yyyy/mm/x.jpg`).
        if !raw.contains("..") {
            push_cand(&mut candidates, root_path.join(&raw));
        } else if let Some(joined) = join_with_dots(&root_path, &raw) {
            push_cand(&mut candidates, joined);
        }
        push_cand(&mut candidates, root_path.join(&name));
        push_cand(&mut candidates, root_path.join(&folder).join(&name));
        if folder != "attachments" {
            push_cand(&mut candidates, root_path.join("attachments").join(&name));
        }
        // Bare filename under dated attachment folders is handled by walk below.
        if !raw.contains("..") && raw.contains('/') {
            push_cand(&mut candidates, root_path.join(&folder).join(&raw));
            if folder != "attachments" {
                push_cand(&mut candidates, root_path.join("attachments").join(&raw));
            }
        }
    }

    // Only accept candidates that stay under an authorized vault/note root when possible.
    let guard_root = if !root_path.as_os_str().is_empty() {
        resolve_for_acl(&root_path).ok()
    } else if !base.as_os_str().is_empty() {
        resolve_for_acl(&base).ok()
    } else {
        None
    };

    for cand in &candidates {
        if let Some(ref gr) = guard_root {
            if let Ok(resolved) = resolve_for_acl(cand) {
                if !is_under(&resolved, gr) {
                    // Candidate escapes the vault/note root: skip it unless it is an
                    // exact ACL-granted file (e.g. a recovered broken absolute link
                    // that points at an authorized copy).
                    if ensure_allowed(state, cand).is_err() {
                        continue;
                    }
                }
            }
        }
        if let Some(hit) = try_existing_file(state, cand) {
            if let Some(ref gr) = guard_root {
                if let Ok(resolved) = resolve_for_acl(&hit) {
                    if is_under(&resolved, gr) || resolved == *gr {
                        return Ok(hit.to_string_lossy().replace('\\', "/"));
                    }
                }
                // Absolute path outside vault but ACL-granted (e.g. recovered broken link
                // that still points at the vault copy) — try_existing_file already ACL'd.
                return Ok(hit.to_string_lossy().replace('\\', "/"));
            }
            return Ok(hit.to_string_lossy().replace('\\', "/"));
        }
    }

    // Obsidian: unique basename anywhere under the vault (or note folder).
    let search_root = if !root_path.as_os_str().is_empty() {
        root_path
    } else {
        base
    };
    if search_root.as_os_str().is_empty() {
        return Err("未找到媒体文件".into());
    }
    ensure_allowed(state, &search_root)?;
    let mut hits = Vec::new();
    let mut scanned = 0usize;
    walk_find_media_by_name(state, &search_root, &name, 0, &mut scanned, &mut hits);
    if hits.len() == 1 {
        return Ok(hits[0].to_string_lossy().replace('\\', "/"));
    }
    if hits.len() > 1 {
        hits.sort_by_key(|p| p.components().count());
        return Ok(hits[0].to_string_lossy().replace('\\', "/"));
    }
    Err("未找到媒体文件".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::is_under;

    #[test]
    fn resolve_joins_safe_relative() {
        let root = Path::new("C:/vault_markelle_unit_test");
        let p = resolve_under_vault(root, "notes/daily").unwrap();
        assert!(
            p.ends_with(Path::new("notes/daily")) || p.ends_with("notes\\daily"),
            "unexpected path: {}",
            p.display()
        );
        let root_r = resolve_for_acl(root).unwrap();
        assert!(is_under(&p, &root_r));
    }

    #[test]
    fn resolve_rejects_parent_escape() {
        let root = Path::new("C:/vault_markelle_unit_test");
        assert!(resolve_under_vault(root, "../outside").is_err());
        assert!(resolve_under_vault(root, "a/../../Windows").is_err());
        assert!(resolve_under_vault(root, "C:/other").is_err());
    }

    #[test]
    fn resolve_empty_relative_is_root() {
        let root = Path::new("C:/vault_markelle_unit_test");
        let p = resolve_under_vault(root, "").unwrap();
        let root_r = resolve_for_acl(root).unwrap();
        assert_eq!(p, root_r);
    }

    #[test]
    fn attachment_names_reject_devices_and_ads() {
        assert!(validate_attachment_name("note.md").is_ok());
        assert!(validate_attachment_name("photo-2.png").is_ok());
        // Reserved device names, bare and with an extension.
        assert!(validate_attachment_name("CON").is_err());
        assert!(validate_attachment_name("con.md").is_err());
        assert!(validate_attachment_name("COM1.png").is_err());
        assert!(validate_attachment_name("lpt9").is_err());
        // Trailing dot (Windows strips it).
        assert!(validate_attachment_name("nul.").is_err());
        // Separators / parent refs.
        assert!(validate_attachment_name("a/b.md").is_err());
        assert!(validate_attachment_name("..").is_err());
        // NTFS alternate data stream — the `:` rule is Windows-only.
        if cfg!(windows) {
            assert!(validate_attachment_name("a.md:secret").is_err());
        }
    }

    #[test]
    fn allocate_claims_a_unique_name_atomically() {
        let dir = std::env::temp_dir().join(format!("mkl-alloc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let preferred = dir.join("a.md");

        let first = allocate_unique_file_path(&preferred).unwrap();
        assert_eq!(first, preferred);
        assert!(first.exists(), "allocation claims the name by creating it");

        // A second allocation must not return the same (claimed) path.
        let second = allocate_unique_file_path(&preferred).unwrap();
        assert_ne!(second, first);
        assert!(second.to_string_lossy().contains("-2"));
        assert!(second.exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
