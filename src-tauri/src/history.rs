use crate::access::{
    ensure_allowed, is_symlink, is_under, resolve_for_acl, AppState,
};
use crate::encoding_util::encode_utf8;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const DEFAULT_MAX_VERSIONS: usize = 20;
const MIN_MAX_VERSIONS: usize = 1;
const MAX_MAX_VERSIONS: usize = 100;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub saved_at: u64,
    pub bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HistoryIndex {
    versions: Vec<HistoryEntry>,
}

fn clamp_max_versions(max_versions: Option<usize>) -> usize {
    max_versions
        .unwrap_or(DEFAULT_MAX_VERSIONS)
        .clamp(MIN_MAX_VERSIONS, MAX_MAX_VERSIONS)
}

/// Stable FNV-1a hex digest — filesystem-safe note key (no path separators).
fn note_key_hash(rel: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in rel.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 同一毫秒内的多次保存会撞 ID，追加进程内单调序号保证唯一；
/// 时间排序仍由 `saved_at` 决定，ID 只是键前缀 + 时间戳 + 序号。
static SNAPSHOT_ID_SEQ: AtomicU64 = AtomicU64::new(0);

fn validate_id(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("版本 ID 不能为空".into());
    }
    if id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    {
        return Err("非法版本 ID".into());
    }
    Ok(())
}

/// Resolve absolute `note_path` under vault; reject escapes and `..`.
fn resolve_note_under_vault(vault_root: &Path, note_path: &Path) -> Result<(PathBuf, PathBuf, String), String> {
    if note_path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("路径包含非法的上级目录引用 (..)".into());
    }
    let vault = resolve_for_acl(vault_root)?;
    let note = resolve_for_acl(note_path)?;
    if !is_under(&note, &vault) {
        return Err(format!("路径超出库根目录: {}", note_path.display()));
    }
    let rel = note
        .strip_prefix(&vault)
        .map_err(|_| "无法计算笔记相对路径".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    if rel.is_empty() {
        return Err("笔记路径无效".into());
    }
    Ok((vault, note, rel))
}

/// History storage for a note: `{vault}/.markelle/history/{note_key}/`
fn note_history_dir(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let key = note_key_hash(rel);
    let hist_root = vault.join(".markelle").join("history");
    let hist = hist_root.join(&key);
    // Lexical guard before create — key is hex-only so join cannot escape.
    if key.chars().any(|c| !c.is_ascii_hexdigit()) {
        return Err("非法历史键".into());
    }
    if hist.exists() {
        let hist_resolved = resolve_for_acl(&hist)?;
        if !is_under(&hist_resolved, vault) {
            return Err("历史路径超出库根目录".into());
        }
        reject_symlink_path(&hist, "拒绝使用符号链接历史目录")?;
    }
    Ok(hist)
}

fn reject_symlink_path(path: &Path, msg: &str) -> Result<(), String> {
    if path.exists() && is_symlink(path) {
        return Err(msg.into());
    }
    Ok(())
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

fn read_index(dir: &Path) -> Result<HistoryIndex, String> {
    let path = index_path(dir);
    if !path.exists() {
        return Ok(HistoryIndex {
            versions: Vec::new(),
        });
    }
    reject_symlink_path(&path, "拒绝读取符号链接历史索引")?;
    let text = fs::read_to_string(&path).map_err(|e| format!("无法读取历史索引: {e}"))?;
    if text.trim().is_empty() {
        return Ok(HistoryIndex {
            versions: Vec::new(),
        });
    }
    // Accept either `{ versions: [...] }` or a bare array for resilience.
    if let Ok(idx) = serde_json::from_str::<HistoryIndex>(&text) {
        return Ok(idx);
    }
    let versions: Vec<HistoryEntry> =
        serde_json::from_str(&text).map_err(|e| format!("历史索引损坏: {e}"))?;
    Ok(HistoryIndex { versions })
}

fn write_index(dir: &Path, index: &HistoryIndex) -> Result<(), String> {
    let path = index_path(dir);
    reject_symlink_path(&path, "拒绝写入符号链接历史索引")?;
    let json = serde_json::to_string_pretty(index).map_err(|e| format!("无法序列化历史索引: {e}"))?;
    write_utf8_atomic(&path, &json)
}

fn write_utf8_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {e}"))?;
        }
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let tmp = parent.join(format!(".{stem}.{}.tmp", crate::unique_tmp_tag()));
    let bytes = encode_utf8(content);
    fs::write(&tmp, &bytes).map_err(|e| format!("无法写入临时文件: {e}"))?;
    crate::commit_atomic(&tmp, path)
}

fn snapshot_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(id)
}

fn prune_index(dir: &Path, index: &mut HistoryIndex, max_versions: usize) -> Result<(), String> {
    index
        .versions
        .sort_by_key(|v| std::cmp::Reverse(v.saved_at));
    while index.versions.len() > max_versions {
        let Some(old) = index.versions.pop() else {
            break;
        };
        let file = snapshot_file(dir, &old.id);
        if file.exists() {
            reject_symlink_path(&file, "拒绝删除符号链接历史快照")?;
            let _ = fs::remove_file(&file);
        }
    }
    Ok(())
}

/// True when `content` is a Markelle ciphertext blob (`{ v, magic: MARKELLE_ENC_V1, … }`).
/// Parsed JSON is matched structurally (shape-independent). Unparseable content is
/// only treated as ciphertext when it carries the marker, so ordinary notes that
/// merely start with `{` keep their local history.
fn is_encrypted_blob(content: &str) -> bool {
    let trimmed = content.trim_start();
    if !trimmed.starts_with('{') {
        return false;
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(value) => value.get("magic").and_then(|m| m.as_str()) == Some("MARKELLE_ENC_V1"),
        Err(_) => trimmed.contains("MARKELLE_ENC_V1"),
    }
}

fn save_snapshot_inner(
    vault_root: &Path,
    note_path: &Path,
    content: &str,
    max_versions: usize,
) -> Result<HistoryEntry, String> {
    if content.len() > MAX_HISTORY_SNAPSHOT_BYTES {
        return Err(format!(
            "历史快照过大（上限 {} MB）",
            MAX_HISTORY_SNAPSHOT_BYTES / (1024 * 1024)
        ));
    }
    // Encrypted blobs: do not snapshot ciphertext; plaintext history is purged on encrypt.
    if is_encrypted_blob(content) {
        return Err("加密笔记不写入历史版本".into());
    }
    let (vault, note, rel) = resolve_note_under_vault(vault_root, note_path)?;
    reject_symlink_path(&note, "拒绝为符号链接笔记保存历史")?;

    let key = note_key_hash(&rel);
    let dir = note_history_dir(&vault, &rel)?;
    if dir.exists() {
        reject_symlink_path(&dir, "拒绝写入符号链接历史目录")?;
    }
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建历史目录: {e}"))?;

    let dir_resolved = resolve_for_acl(&dir)?;
    if !is_under(&dir_resolved, &vault) {
        return Err("历史路径超出库根目录".into());
    }
    let hist_marker = dir_resolved
        .strip_prefix(&vault)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if !hist_marker.starts_with(".markelle/history/") {
        return Err("历史路径必须位于 .markelle/history 下".into());
    }

    let saved_at = now_ms();
    // 追加进程内单调序号，保证同毫秒内的并发/连续保存不会生成同一 ID 而互相覆盖。
    let id = format!(
        "{key}_{saved_at}_{}",
        SNAPSHOT_ID_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    validate_id(&id)?;
    let file = snapshot_file(&dir, &id);

    let bytes = encode_utf8(content);
    let entry = HistoryEntry {
        id: id.clone(),
        saved_at,
        bytes: bytes.len() as u64,
    };
    // 先写临时文件再原子替换：崩溃/断电不会在历史目录留下半截快照。
    let tmp = dir.join(format!(".{id}.{}.tmp", crate::unique_tmp_tag()));
    fs::write(&tmp, &bytes).map_err(|e| format!("无法写入历史快照: {e}"))?;
    crate::commit_atomic(&tmp, &file)?;

    let mut index = read_index(&dir)?;
    index.versions.retain(|v| v.id != id);
    index.versions.push(entry.clone());
    prune_index(&dir, &mut index, max_versions)?;
    write_index(&dir, &index)?;

    Ok(entry)
}

fn list_inner(vault_root: &Path, note_path: &Path) -> Result<Vec<HistoryEntry>, String> {
    let (vault, _note, rel) = resolve_note_under_vault(vault_root, note_path)?;
    let dir = note_history_dir(&vault, &rel)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    reject_symlink_path(&dir, "拒绝读取符号链接历史目录")?;
    let mut index = read_index(&dir)?;
    index
        .versions
        .sort_by_key(|v| std::cmp::Reverse(v.saved_at));
    Ok(index.versions)
}

fn read_inner(vault_root: &Path, note_path: &Path, id: &str) -> Result<String, String> {
    validate_id(id)?;
    let (vault, _note, rel) = resolve_note_under_vault(vault_root, note_path)?;
    let dir = note_history_dir(&vault, &rel)?;
    reject_symlink_path(&dir, "拒绝读取符号链接历史目录")?;

    let file = snapshot_file(&dir, id);
    let file_resolved = resolve_for_acl(&file)?;
    if !is_under(&file_resolved, &vault) {
        return Err("快照路径超出库根目录".into());
    }
    let under = file_resolved
        .strip_prefix(&vault)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if !under.starts_with(".markelle/history/") {
        return Err("快照路径必须位于 .markelle/history 下".into());
    }
    if !file.is_file() {
        return Err("历史版本不存在".into());
    }
    reject_symlink_path(&file, "拒绝读取符号链接历史快照")?;
    fs::read_to_string(&file).map_err(|e| format!("无法读取历史快照: {e}"))
}

/// Cap a single history snapshot (notes, not attachments).
const MAX_HISTORY_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;

/// Wipe all history snapshots for a note (e.g. after encrypt so plaintext is not retained).
fn clear_note_history_inner(vault_root: &Path, note_path: &Path) -> Result<usize, String> {
    let (vault, _note, rel) = resolve_note_under_vault(vault_root, note_path)?;
    let dir = note_history_dir(&vault, &rel)?;
    if !dir.exists() {
        return Ok(0);
    }
    reject_symlink_path(&dir, "拒绝删除符号链接历史目录")?;
    let dir_resolved = resolve_for_acl(&dir)?;
    if !is_under(&dir_resolved, &vault) {
        return Err("历史路径超出库根目录".into());
    }
    let under = dir_resolved
        .strip_prefix(&vault)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    if !under.starts_with(".markelle/history/") {
        return Err("历史路径必须位于 .markelle/history 下".into());
    }
    let mut removed = 0usize;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                reject_symlink_path(&path, "拒绝删除符号链接历史文件")?;
                fs::remove_file(&path).map_err(|e| format!("无法删除历史文件: {e}"))?;
                removed += 1;
            }
        }
    }
    let _ = fs::remove_dir(&dir);
    Ok(removed)
}

#[tauri::command]
pub async fn history_save_snapshot(
    state: State<'_, AppState>,
    vault_root: String,
    note_path: String,
    content: String,
    max_versions: Option<usize>,
) -> Result<HistoryEntry, String> {
    let vault = PathBuf::from(&vault_root);
    let note = PathBuf::from(&note_path);
    ensure_allowed(&state, &vault)?;
    ensure_allowed(&state, &note)?;
    let max = clamp_max_versions(max_versions);
    tauri::async_runtime::spawn_blocking(move || {
        save_snapshot_inner(&vault, &note, &content, max)
    })
    .await
    .map_err(|e| format!("保存历史任务失败: {e}"))?
}

#[tauri::command]
pub async fn history_list(
    state: State<'_, AppState>,
    vault_root: String,
    note_path: String,
) -> Result<Vec<HistoryEntry>, String> {
    let vault = PathBuf::from(&vault_root);
    let note = PathBuf::from(&note_path);
    ensure_allowed(&state, &vault)?;
    ensure_allowed(&state, &note)?;
    tauri::async_runtime::spawn_blocking(move || list_inner(&vault, &note))
        .await
        .map_err(|e| format!("历史列表任务失败: {e}"))?
}

#[tauri::command]
pub async fn history_read(
    state: State<'_, AppState>,
    vault_root: String,
    note_path: String,
    id: String,
) -> Result<String, String> {
    let vault = PathBuf::from(&vault_root);
    let note = PathBuf::from(&note_path);
    ensure_allowed(&state, &vault)?;
    ensure_allowed(&state, &note)?;
    tauri::async_runtime::spawn_blocking(move || read_inner(&vault, &note, &id))
        .await
        .map_err(|e| format!("读取历史任务失败: {e}"))?
}

/// Delete all local history snapshots for a note (used after encrypt).
#[tauri::command]
pub async fn history_clear_note(
    state: State<'_, AppState>,
    vault_root: String,
    note_path: String,
) -> Result<usize, String> {
    let vault = PathBuf::from(&vault_root);
    let note = PathBuf::from(&note_path);
    ensure_allowed(&state, &vault)?;
    ensure_allowed(&state, &note)?;
    tauri::async_runtime::spawn_blocking(move || clear_note_history_inner(&vault, &note))
        .await
        .map_err(|e| format!("清除历史任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("markelle_hist_test_{n}"));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn reject_path_escape() {
        let root = Path::new("C:/vault_markelle_unit_test");
        assert!(resolve_note_under_vault(root, Path::new("C:/vault_markelle_unit_test/../outside.md")).is_err());
    }

    #[test]
    fn reject_illegal_id() {
        assert!(validate_id("../evil").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("abc_123").is_ok());
    }

    #[test]
    fn clamp_versions() {
        assert_eq!(clamp_max_versions(None), 20);
        assert_eq!(clamp_max_versions(Some(0)), 1);
        assert_eq!(clamp_max_versions(Some(200)), 100);
        assert_eq!(clamp_max_versions(Some(15)), 15);
    }

    #[test]
    fn save_list_read_roundtrip() {
        let root = temp_vault();
        let note = root.join("notes/test.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "# original").unwrap();

        let saved = save_snapshot_inner(&root, &note, "# v1", 5).unwrap();
        assert!(saved.id.contains('_'));
        assert!(saved.bytes > 0);

        let list = list_inner(&root, &note).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, saved.id);

        let content = read_inner(&root, &note, &saved.id).unwrap();
        assert_eq!(content, "# v1");

        // Prune keeps newest N
        let _ = save_snapshot_inner(&root, &note, "# v2", 2).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let _ = save_snapshot_inner(&root, &note, "# v3", 2).unwrap();
        let list2 = list_inner(&root, &note).unwrap();
        assert_eq!(list2.len(), 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn encrypted_detection_is_shape_independent() {
        // Leading whitespace + canonical ciphertext JSON.
        assert!(is_encrypted_blob(
            "\n  \t{\"v\":1,\"magic\":\"MARKELLE_ENC_V1\",\"salt\":\"\",\"iv\":\"\",\"ct\":\"\"}"
        ));
        // Magic delivered via a JSON unicode escape — string sniffing would miss it.
        assert!(is_encrypted_blob("{\"magic\":\"\\u004dARKELLE_ENC_V1\"}"));
        // Reordered keys / extra fields still detected.
        assert!(is_encrypted_blob(
            "{\"ct\":\"AA==\",\"iv\":\"AA==\",\"salt\":\"AA==\",\"magic\":\"MARKELLE_ENC_V1\",\"v\":2}"
        ));
        // Plain JSON without the marker is allowed.
        assert!(!is_encrypted_blob("{\"title\":\"hello\"}"));
        // Plain markdown is allowed.
        assert!(!is_encrypted_blob("# note\n\nbody"));
        // JSON-looking but unparseable and without the marker → keep history.
        assert!(!is_encrypted_blob("{ not valid json"));
        // Unparseable yet carrying the marker → still treated as ciphertext.
        assert!(is_encrypted_blob("{ \"MARKELLE_ENC_V1\" broken"));
    }

    #[test]
    fn encrypted_content_skips_snapshot_and_clear_wipes() {
        let root = temp_vault();
        let note = root.join("secret.md");
        fs::write(&note, "plain secret").unwrap();
        let _ = save_snapshot_inner(&root, &note, "plain secret", 5).unwrap();
        assert_eq!(list_inner(&root, &note).unwrap().len(), 1);

        let enc = r#"{
  "v": 1,
  "magic": "MARKELLE_ENC_V1",
  "salt": "AA==",
  "iv": "AA==",
  "ct": "AA=="
}"#;
        assert!(save_snapshot_inner(&root, &note, enc, 5).is_err());

        let removed = clear_note_history_inner(&root, &note).unwrap();
        assert!(removed >= 1);
        assert!(list_inner(&root, &note).unwrap().is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_ids_unique_within_same_millisecond() {
        let root = temp_vault();
        let note = root.join("n.md");
        fs::write(&note, "x").unwrap();
        // 连续快速保存：旧实现会在同毫秒内撞 ID 并报错丢版本，这里必须每次都成功且 ID 唯一。
        let mut ids = std::collections::HashSet::new();
        for _ in 0..8 {
            let entry = save_snapshot_inner(&root, &note, "body", 50).unwrap();
            assert!(ids.insert(entry.id.clone()), "重复的版本 ID: {}", entry.id);
        }
        let list = list_inner(&root, &note).unwrap();
        assert_eq!(list.len(), 8);
        assert!(list.windows(2).all(|w| w[0].saved_at >= w[1].saved_at));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshots_live_under_markelle_history() {
        let root = temp_vault();
        let note = root.join("a.md");
        fs::write(&note, "x").unwrap();
        let saved = save_snapshot_inner(&root, &note, "body", 3).unwrap();
        let (vault, _, rel) = resolve_note_under_vault(&root, &note).unwrap();
        let dir = note_history_dir(&vault, &rel).unwrap();
        let file = snapshot_file(&dir, &saved.id);
        let file_s = file.to_string_lossy().replace('\\', "/");
        assert!(
            file_s.contains("/.markelle/history/"),
            "expected under .markelle/history, got {file_s}"
        );
        assert!(file.is_file());
        let _ = fs::remove_dir_all(&root);
    }
}
