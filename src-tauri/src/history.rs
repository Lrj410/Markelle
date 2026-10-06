use crate::access::{ensure_allowed, is_symlink, is_under, resolve_for_acl, AppState};
use crate::encoding_util::encode_utf8;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const DEFAULT_MAX_VERSIONS: usize = 20;
const MIN_MAX_VERSIONS: usize = 1;
const MAX_MAX_VERSIONS: usize = 100;
/// Above this the index is treated as corrupt and rebuilt from the snapshot
/// directory instead of being allocated/parsed in full.
const MAX_HISTORY_INDEX_BYTES: u64 = 4 * 1024 * 1024;

/// Serializes the index read→modify→write sequence. Concurrent snapshot saves
/// for the same note would otherwise both read the same index and one push would
/// be lost (leaving an orphan snapshot file that `prune_index` may later delete).
static INDEX_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn index_lock() -> &'static Mutex<()> {
    INDEX_LOCK.get_or_init(|| Mutex::new(()))
}

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

/// Marker file inside each per-note history directory recording which note it
/// belongs to, so a hash collision / case mismatch is reportable.
const NOTE_MARKER: &str = "note.txt";

/// Stable FNV-1a hex digest — filesystem-safe key component (no path separators).
fn note_key_hash(rel: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in rel.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Normalised relative path used as the history lookup basis: forward slashes,
/// and case folded on Windows only (consistent with [`crate::util::path_key`]).
/// Without this the same note referenced as `Note.md` / `notes\note.md` would get
/// different keys and its history would appear split.
fn normalize_rel(rel: &str) -> String {
    crate::util::path_key(Path::new(rel))
}

/// Per-note history directory name: a readable sanitised prefix over the
/// normalised path plus its full FNV-1a hash. The prefix keeps the directory
/// human-recognisable; hashing the *normalised* path keeps lookups stable.
fn note_key(rel: &str) -> String {
    let norm = normalize_rel(rel);
    let base = norm.rsplit('/').next().unwrap_or(&norm);
    let mut prefix: String = base
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    prefix.truncate(40);
    while prefix.ends_with('_') {
        prefix.pop();
    }
    if prefix.is_empty() {
        prefix = "note".into();
    }
    format!("{prefix}-{}", note_key_hash(&norm))
}

/// Legacy per-note history directory name: a bare FNV-1a digest of the **raw**
/// relative path (forward slashes, case preserved, no prefix). Kept only as a
/// read-fallback so history recorded before the prefix+normalised-hash scheme is
/// not silently lost — see `note_history_dir`. Do not use for new writes.
fn legacy_note_key(rel: &str) -> String {
    note_key_hash(rel)
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
fn resolve_note_under_vault(
    vault_root: &Path,
    note_path: &Path,
) -> Result<(PathBuf, PathBuf, String), String> {
    if note_path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
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
    let norm = normalize_rel(rel);
    let key = note_key(rel);
    let hist_root = vault.join(".markelle").join("history");
    let hist = hist_root.join(&key);
    // Lexical guard before create — the key charset cannot contain separators.
    if key
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Err("非法历史键".into());
    }
    if hist.exists() {
        let hist_resolved = resolve_for_acl(&hist)?;
        if !is_under(&hist_resolved, vault) {
            return Err("历史路径超出库根目录".into());
        }
        reject_symlink_path(&hist, "拒绝使用符号链接历史目录")?;
        // The marker records which normalised note path this directory owns. A
        // mismatch means two different notes produced the same key — report it
        // rather than silently merging their history.
        let marker = hist.join(NOTE_MARKER);
        if marker.is_file() && !is_symlink(&marker) {
            if let Ok(recorded) = fs::read_to_string(&marker) {
                let recorded = recorded.trim();
                if !recorded.is_empty() && recorded != norm {
                    return Err(format!(
                        "历史目录键冲突：{key} 同时对应 {recorded} 与 {norm}"
                    ));
                }
            }
        }
        return Ok(hist);
    }

    // Backward compatibility: history recorded before the prefix+normalised-hash
    // scheme lives under a bare FNV-1a key. Fall back to it when the new-style
    // directory is absent, otherwise existing users would appear to have lost all
    // their version history. (When both exist the new-style dir wins above.)
    let legacy = hist_root.join(legacy_note_key(rel));
    if legacy.exists() {
        let legacy_resolved = resolve_for_acl(&legacy)?;
        if !is_under(&legacy_resolved, vault) {
            return Err("历史路径超出库根目录".into());
        }
        reject_symlink_path(&legacy, "拒绝使用符号链接历史目录")?;
        // On the first successful legacy read, migrate by dropping the note
        // marker in place so the legacy directory gains the same collision
        // metadata as new-style ones. Best-effort: a failed marker write must
        // never break a history read.
        let marker = legacy.join(NOTE_MARKER);
        if !marker.is_file() {
            let _ = fs::write(&marker, norm.as_bytes());
        }
        return Ok(legacy);
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

/// Recover the save time encoded in a snapshot id `{key}_{saved_at}_{seq}`.
///
/// The `key` prefix is a readable sanitisation of the note's relative path with
/// illegal characters replaced by `_`, so it can itself contain underscores
/// (e.g. `2024_01_01.md`). The timestamp and sequence are therefore parsed from
/// the RIGHT. A missing or non-numeric/non-positive segment is not treated as a
/// save time — fall back to the file's mtime, matching the previous behaviour.
fn parse_snapshot_saved_at(name: &str, meta: &fs::Metadata) -> u64 {
    name.rsplit('_')
        .nth(1)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&t| t > 0)
        .unwrap_or_else(|| {
            meta.modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        })
}

/// Rebuild the index by scanning the snapshot files in `dir`. Used when
/// `index.json` is missing, over-large, or unparseable — the snapshots on disk
/// are the source of truth, so a corrupt index must not lose visible history.
fn rebuild_index_from_dir(dir: &Path) -> HistoryIndex {
    let mut versions = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || is_symlink(&path) {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // Skip the index, the note marker, and our temp files (`.{id}.{tag}.tmp`).
            if name == "index.json" || name == NOTE_MARKER || name.starts_with('.') {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            let saved_at = parse_snapshot_saved_at(name, &meta);
            versions.push(HistoryEntry {
                id: name.to_string(),
                saved_at,
                bytes: meta.len(),
            });
        }
    }
    HistoryIndex { versions }
}

fn read_index(dir: &Path) -> Result<HistoryIndex, String> {
    let path = index_path(dir);
    if !path.exists() {
        return Ok(HistoryIndex {
            versions: Vec::new(),
        });
    }
    reject_symlink_path(&path, "拒绝读取符号链接历史索引")?;
    // Bound the read before allocating: an over-large index is corrupt (or a DoS
    // vector) and is rebuilt from the snapshot directory instead.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_HISTORY_INDEX_BYTES {
            return Ok(rebuild_index_from_dir(dir));
        }
    }
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
    if let Ok(versions) = serde_json::from_str::<Vec<HistoryEntry>>(&text) {
        return Ok(HistoryIndex { versions });
    }
    // Unparseable → rebuild from the snapshot directory rather than erroring out.
    Ok(rebuild_index_from_dir(dir))
}

fn write_index(dir: &Path, index: &HistoryIndex) -> Result<(), String> {
    let path = index_path(dir);
    reject_symlink_path(&path, "拒绝写入符号链接历史索引")?;
    let json =
        serde_json::to_string_pretty(index).map_err(|e| format!("无法序列化历史索引: {e}"))?;
    crate::util::write_utf8_atomic(&path, &json, "file")
}

fn snapshot_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(id)
}

fn prune_index(dir: &Path, index: &mut HistoryIndex, max_versions: usize) -> Result<(), String> {
    index
        .versions
        .sort_by_key(|v| std::cmp::Reverse(v.saved_at));
    while index.versions.len() > max_versions {
        let Some(old) = index.versions.last().cloned() else {
            break;
        };
        let file = snapshot_file(dir, &old.id);
        if file.exists() {
            reject_symlink_path(&file, "拒绝删除符号链接历史快照")?;
            if fs::remove_file(&file).is_err() {
                // Keep the index entry: an indexed-but-missing ("phantom") version
                // is worse than temporarily exceeding the cap.
                break;
            }
        }
        index.versions.pop();
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

    let key = note_key(&rel);
    let dir = note_history_dir(&vault, &rel)?;
    if dir.exists() {
        reject_symlink_path(&dir, "拒绝写入符号链接历史目录")?;
    }
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建历史目录: {e}"))?;
    // Record the owning note path so a hash collision / case mismatch is
    // detectable (see `note_history_dir`) instead of silently merging history.
    let marker = dir.join(NOTE_MARKER);
    if !marker.exists() {
        fs::write(&marker, normalize_rel(&rel).as_bytes())
            .map_err(|e| format!("无法写入历史目录标记: {e}"))?;
    }

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

    // Serialize the whole read→modify→write of the index: two concurrent saves
    // for the same note must not drop each other's entry (orphan snapshot files
    // would later be pruned as "unknown").
    let _index_guard = index_lock()
        .lock()
        .map_err(|_| "历史索引锁失败".to_string())?;
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
    // Writes are capped at `MAX_HISTORY_SNAPSHOT_BYTES`; apply the same cap on
    // read so a locally-planted oversized file cannot be slurped whole. Over-size
    // means the snapshot is corrupt, not a legitimate large version.
    if let Ok(meta) = fs::metadata(&file) {
        if meta.len() > MAX_HISTORY_SNAPSHOT_BYTES as u64 {
            return Err(format!(
                "历史快照过大（上限 {} MB），按损坏处理",
                MAX_HISTORY_SNAPSHOT_BYTES / (1024 * 1024)
            ));
        }
    }
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
    // Held against concurrent saves so a wipe (e.g. after encrypt) cannot race a
    // snapshot write that would re-create the index after removal.
    let _index_guard = index_lock()
        .lock()
        .map_err(|_| "历史索引锁失败".to_string())?;
    // Remove the index first: if a snapshot delete below fails partway, an index
    // that still lists the now-deleted files would surface phantom versions. With
    // the index gone the remaining files are simply re-discovered on next list.
    let idx = index_path(&dir);
    if idx.is_file() {
        reject_symlink_path(&idx, "拒绝删除符号链接历史索引")?;
        fs::remove_file(&idx).map_err(|e| format!("无法删除历史索引: {e}"))?;
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
    tauri::async_runtime::spawn_blocking(move || save_snapshot_inner(&vault, &note, &content, max))
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
        assert!(resolve_note_under_vault(
            root,
            Path::new("C:/vault_markelle_unit_test/../outside.md")
        )
        .is_err());
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
    fn concurrent_saves_keep_every_index_entry() {
        let root = temp_vault();
        let note = root.join("concurrent.md");
        fs::write(&note, "x").unwrap();
        const N: usize = 12;
        std::thread::scope(|scope| {
            for _ in 0..N {
                let root = root.clone();
                let note = note.clone();
                scope.spawn(move || {
                    save_snapshot_inner(&root, &note, "body", 100).unwrap();
                });
            }
        });
        let list = list_inner(&root, &note).unwrap();
        assert_eq!(list.len(), N, "index lost a concurrent snapshot entry");
        // Every indexed snapshot must still exist on disk (no orphan/lost files).
        let (vault, _, rel) = resolve_note_under_vault(&root, &note).unwrap();
        let dir = note_history_dir(&vault, &rel).unwrap();
        for entry in &list {
            assert!(
                snapshot_file(&dir, &entry.id).is_file(),
                "indexed snapshot missing on disk: {}",
                entry.id
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_index_rebuilds_from_snapshots() {
        let root = temp_vault();
        let note = root.join("rebuild.md");
        fs::write(&note, "x").unwrap();
        let saved = save_snapshot_inner(&root, &note, "# v1", 5).unwrap();
        let (vault, _, rel) = resolve_note_under_vault(&root, &note).unwrap();
        let dir = note_history_dir(&vault, &rel).unwrap();
        // Corrupt the index: it must be rebuilt from the snapshot files, not lost.
        fs::write(dir.join("index.json"), b"{ this is not valid json").unwrap();
        let list = list_inner(&root, &note).unwrap();
        assert_eq!(list.len(), 1, "index should rebuild from snapshot files");
        assert_eq!(list[0].id, saved.id);
        assert_eq!(read_inner(&root, &note, &saved.id).unwrap(), "# v1");
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

    #[test]
    fn legacy_key_history_is_still_listed_and_readable() {
        let root = temp_vault();
        let note = root.join("legacy.md");
        fs::write(&note, "x").unwrap();
        let (vault, _, rel) = resolve_note_under_vault(&root, &note).unwrap();

        // Simulate history written by the pre-migration scheme: a bare FNV-1a key
        // directory holding a snapshot + index, and no `note.txt` marker. The
        // new-style (prefix + normalised hash) directory must NOT exist.
        let legacy_key = legacy_note_key(&rel);
        assert_ne!(
            legacy_key,
            note_key(&rel),
            "legacy and new keys must differ or the test proves nothing"
        );
        let legacy_dir = vault.join(".markelle").join("history").join(&legacy_key);
        fs::create_dir_all(&legacy_dir).unwrap();
        let id = format!("{legacy_key}_1700000000000_0");
        fs::write(legacy_dir.join(&id), b"# legacy body").unwrap();
        let index = HistoryIndex {
            versions: vec![HistoryEntry {
                id: id.clone(),
                saved_at: 1_700_000_000_000,
                bytes: 13,
            }],
        };
        fs::write(
            legacy_dir.join("index.json"),
            serde_json::to_string(&index).unwrap(),
        )
        .unwrap();
        assert!(!vault
            .join(".markelle")
            .join("history")
            .join(note_key(&rel))
            .exists());

        // New-style directory is absent → lookup must fall back to the legacy dir.
        let list = list_inner(&root, &note).unwrap();
        assert_eq!(list.len(), 1, "legacy snapshots must still be listed");
        assert_eq!(list[0].id, id);
        assert_eq!(
            read_inner(&root, &note, &id).unwrap(),
            "# legacy body",
            "legacy snapshot content must remain readable"
        );
        // First successful legacy read migrates the marker in place.
        assert!(
            legacy_dir.join(NOTE_MARKER).is_file(),
            "legacy read should migrate the note marker"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// The `key` prefix can contain underscores (the note's path is sanitised by
    /// replacing illegal characters with `_`), so the save time must be parsed
    /// from the RIGHT. Parsing from the left (`split('_').nth(1)`) picked the
    /// wrong segment and collapsed every snapshot in the directory to one bogus
    /// timestamp, corrupting ordering and pruning.
    #[test]
    fn rebuild_parses_saved_at_from_right() {
        let root = temp_vault();
        let dir = root.join("h");
        fs::create_dir_all(&dir).unwrap();

        let id = "2024_01_01-abc123_1700000000000_0";
        fs::write(dir.join(id), b"# body").unwrap();
        let idx = rebuild_index_from_dir(&dir);
        assert_eq!(idx.versions.len(), 1);
        assert_eq!(idx.versions[0].id, id);
        assert_eq!(
            idx.versions[0].saved_at, 1_700_000_000_000,
            "must read the timestamp segment, not the prefix's `01`"
        );

        // Second-from-right segment is not numeric → fall back to the file's
        // mtime (a real epoch-ms value far above any bogus small number).
        fs::write(dir.join("note_abc_0"), b"# body2").unwrap();
        let idx2 = rebuild_index_from_dir(&dir);
        let e = idx2.versions.iter().find(|v| v.id == "note_abc_0").unwrap();
        assert!(
            e.saved_at > 1_000_000_000_000,
            "non-numeric segment must fall back to mtime, got {}",
            e.saved_at
        );

        let _ = fs::remove_dir_all(&root);
    }
}
