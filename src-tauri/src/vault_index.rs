use crate::access::{
    canonicalize_lossy, ensure_allowed, is_symlink, is_under, register_vault, AppState,
};
use crate::encoding_util::{read_decoded, read_decoded_range};
use crate::file_name;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{AppHandle, Manager, State};

pub(crate) const MAX_VAULT_ENTRIES: usize = 8_000;
pub(crate) const MAX_SEARCH_HITS: usize = 80;
pub(crate) const MAX_SEARCH_FILE_BYTES: u64 = 1_500_000;
/// Tag extraction only needs frontmatter + early body — avoid full-file decode on index build.
const TAG_SCAN_BYTES: usize = 64 * 1024;
/// Graph edges: wikilinks / md links are usually early; cap decode to bound CPU on large vaults.
const GRAPH_SCAN_BYTES: usize = 256 * 1024;
/// Cap streaming scan so a pathological file cannot stall search forever.
const MAX_STREAM_SEARCH_LINES: usize = 2_000_000;

fn search_file_streaming(path: &Path, query: &str) -> Option<(usize, String)> {
    if let Ok((text, _)) = read_decoded(path) {
        for (idx, line) in text.lines().enumerate() {
            if idx >= MAX_STREAM_SEARCH_LINES {
                break;
            }
            if line.to_lowercase().contains(query) {
                let preview = line.trim().chars().take(140).collect::<String>();
                return Some((idx + 1, preview));
            }
        }
        return None;
    }
    let file = File::open(path).ok()?;
    let reader = BufReader::with_capacity(128 * 1024, file);
    for (idx, line) in reader.lines().enumerate() {
        if idx >= MAX_STREAM_SEARCH_LINES {
            break;
        }
        let Ok(line) = line else { continue };
        if line.to_lowercase().contains(query) {
            let preview = line.trim().chars().take(140).collect::<String>();
            return Some((idx + 1, preview));
        }
    }
    None
}
const MAX_WALK_DEPTH: usize = 64;
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    "vendor",
    ".markelle",
];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultNode {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub children: Option<Vec<VaultNode>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
    pub tree: VaultNode,
    pub file_count: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub line: usize,
    pub preview: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub tag: String,
    pub count: usize,
    pub paths: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QueryHit {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkHit {
    pub path: String,
    pub name: String,
    pub line: usize,
    pub preview: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub path: Option<String>,
    pub name: String,
    pub kind: String,
    pub is_focus: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphLink {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub mode: String,
    pub nodes: Vec<GraphNode>,
    pub links: Vec<GraphLink>,
    /// Nodes currently returned (after local filter / cap).
    pub file_count: usize,
    pub link_count: usize,
    /// True when full-graph cap dropped nodes.
    pub truncated: bool,
    /// Markdown notes in the vault index before graph filtering/cap.
    pub vault_note_count: usize,
    /// Cap applied for full mode (0 = unlimited / not applicable).
    pub max_nodes: usize,
}

pub(crate) fn is_markdown_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown" | "mdown" | "mkd")
    )
}

fn is_markdown(path: &Path) -> bool {
    is_markdown_file(path)
}

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name) || name.starts_with('.')
}

fn build_tree(
    root: &Path,
    path: &Path,
    counter: &mut usize,
    visited: &mut HashSet<PathBuf>,
    depth: usize,
) -> Result<Option<VaultNode>, String> {
    if *counter >= MAX_VAULT_ENTRIES || depth > MAX_WALK_DEPTH {
        return Ok(None);
    }
    if is_symlink(path) {
        return Ok(None);
    }
    let canon = canonicalize_lossy(path);
    if !is_under(&canon, root) {
        return Ok(None);
    }
    if !visited.insert(canon) {
        return Ok(None);
    }

    let meta = fs::metadata(path).map_err(|e| format!("无法读取: {e}"))?;
    let name = file_name(path);

    if meta.is_file() {
        if !is_markdown(path) {
            return Ok(None);
        }
        *counter += 1;
        return Ok(Some(VaultNode {
            name,
            path: path.to_string_lossy().to_string(),
            kind: "file".into(),
            children: None,
        }));
    }

    if !meta.is_dir() {
        return Ok(None);
    }

    let mut children = Vec::new();
    let mut entries: Vec<PathBuf> = fs::read_dir(path)
        .map_err(|e| format!("无法读取目录: {e}"))?
        .filter_map(|e| e.ok().map(|x| x.path()))
        .collect();

    entries.sort_by(|a, b| {
        let a_dir = !is_symlink(a) && a.is_dir();
        let b_dir = !is_symlink(b) && b.is_dir();
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a
                .file_name()
                .unwrap_or_default()
                .to_ascii_lowercase()
                .cmp(&b.file_name().unwrap_or_default().to_ascii_lowercase()),
        }
    });

    for entry in entries {
        if *counter >= MAX_VAULT_ENTRIES {
            break;
        }
        if is_symlink(&entry) {
            continue;
        }
        let entry_name = file_name(&entry);
        if entry.is_dir() {
            if should_skip_dir(&entry_name) {
                continue;
            }
            if let Some(child) = build_tree(root, &entry, counter, visited, depth + 1)? {
                children.push(child);
            }
        } else if is_markdown(&entry) {
            *counter += 1;
            children.push(VaultNode {
                name: entry_name,
                path: entry.to_string_lossy().to_string(),
                kind: "file".into(),
                children: None,
            });
        }
    }

    // Always keep directory nodes, including empty ones.
    Ok(Some(VaultNode {
        name,
        path: path.to_string_lossy().to_string(),
        kind: "dir".into(),
        children: Some(children),
    }))
}

fn walk_markdown_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    walk_markdown_files_for_export(root, out)
}

pub(crate) fn walk_markdown_files_for_export(
    root: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let mut visited = HashSet::new();
    walk_markdown_files_inner(root, root, out, &mut visited, 0)
}

fn walk_markdown_files_inner(
    root: &Path,
    dir: &Path,
    out: &mut Vec<PathBuf>,
    visited: &mut HashSet<PathBuf>,
    depth: usize,
) -> Result<(), String> {
    if out.len() >= MAX_VAULT_ENTRIES || depth > MAX_WALK_DEPTH {
        return Ok(());
    }
    if is_symlink(dir) {
        return Ok(());
    }
    let canon = canonicalize_lossy(dir);
    if !is_under(&canon, root) {
        return Ok(());
    }
    if !visited.insert(canon) {
        return Ok(());
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("无法读取目录: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if is_symlink(&path) {
            continue;
        }
        let name = file_name(&path);
        if path.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            walk_markdown_files_inner(root, &path, out, visited, depth + 1)?;
        } else if is_markdown(&path) {
            out.push(path);
            if out.len() >= MAX_VAULT_ENTRIES {
                break;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_vault(app: AppHandle, root: String) -> Result<VaultInfo, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("路径不是有效文件夹".into());
    }
    if is_symlink(&root) {
        return Err("拒绝打开符号链接作为库".into());
    }
    register_vault(&app, &root)?;
    if let Ok(mut cache) = app.state::<IndexCache>().0.lock() {
        *cache = None;
    }

    let root_for_walk = root.clone();
    let info = tauri::async_runtime::spawn_blocking(move || -> Result<VaultInfo, String> {
        let mut file_count = 0usize;
        let mut visited = HashSet::new();
        let tree = build_tree(&root_for_walk, &root_for_walk, &mut file_count, &mut visited, 0)?
            .unwrap_or(VaultNode {
                name: file_name(&root_for_walk),
                path: root_for_walk.to_string_lossy().to_string(),
                kind: "dir".into(),
                children: Some(Vec::new()),
            });
        let truncated = file_count >= MAX_VAULT_ENTRIES;

        Ok(VaultInfo {
            root: root_for_walk.to_string_lossy().to_string(),
            name: file_name(&root_for_walk),
            tree,
            file_count,
            truncated,
        })
    })
    .await
    .map_err(|e| format!("打开库任务失败: {e}"))??;

    crate::vault_watch::start_vault_watch(app, root);
    Ok(info)
}

#[tauri::command]
pub(crate) async fn search_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.chars().count() < 2 {
        return Err("请输入至少 2 个字符".into());
    }

    let root_path = PathBuf::from(&root);
    ensure_allowed(&state, &root_path)?;
    if !root_path.is_dir() {
        return Err("库路径无效".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.state::<IndexCache>();
        let (index, _) = get_or_build_index(&cache, &root_path)?;

        let mut hits = Vec::new();
        for path in index.files {
            if hits.len() >= MAX_SEARCH_HITS {
                break;
            }

            let name = file_name(&path);
            let name_l = name.to_lowercase();
            let path_l = path.to_string_lossy().to_lowercase();

            if name_l.contains(&query) || path_l.contains(&query) {
                hits.push(SearchHit {
                    path: path.to_string_lossy().to_string(),
                    name: name.clone(),
                    line: 0,
                    preview: name,
                });
                continue;
            }

            let meta = match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.is_file() {
                continue;
            }

            // Small files: full decode. Large files: buffered line scan (no full load).
            let hit = if meta.len() <= MAX_SEARCH_FILE_BYTES {
                let Ok((content, _)) = read_decoded(&path) else {
                    continue;
                };
                content.lines().enumerate().find_map(|(idx, line)| {
                    if line.to_lowercase().contains(&query) {
                        let preview = line.trim().chars().take(140).collect::<String>();
                        Some((idx + 1, preview))
                    } else {
                        None
                    }
                })
            } else {
                search_file_streaming(&path, &query)
            };

            if let Some((line, preview)) = hit {
                hits.push(SearchHit {
                    path: path.to_string_lossy().to_string(),
                    name: name.clone(),
                    line,
                    preview,
                });
            }
        }

        Ok(hits)
    })
    .await
    .map_err(|e| format!("搜索任务失败: {e}"))?
}

#[derive(Debug, Clone)]
struct QueryToken {
    tag: Option<String>,
    path_prefix: Option<String>,
    text: Option<String>,
}

fn parse_query_tokens(query: &str) -> Vec<QueryToken> {
    query
        .split_whitespace()
        .filter_map(|raw| {
            let token = raw.trim();
            if token.is_empty() {
                return None;
            }
            if let Some(tag) = token.strip_prefix("tag:") {
                let t = tag.trim().to_lowercase();
                if t.is_empty() {
                    return None;
                }
                Some(QueryToken {
                    tag: Some(t),
                    path_prefix: None,
                    text: None,
                })
            } else if let Some(path) = token.strip_prefix("path:") {
                let p = path.trim().trim_matches(|c| c == '/' || c == '\\').to_lowercase();
                if p.is_empty() {
                    return None;
                }
                Some(QueryToken {
                    tag: None,
                    path_prefix: Some(p),
                    text: None,
                })
            } else {
                Some(QueryToken {
                    tag: None,
                    path_prefix: None,
                    text: Some(token.to_lowercase()),
                })
            }
        })
        .collect()
}

fn path_matches_query(path: &Path, root: &Path, index: &VaultIndex, tokens: &[QueryToken]) -> bool {
    let name = file_name(path).to_lowercase();
    let rel = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/").to_lowercase())
        .unwrap_or_default();

    for token in tokens {
        if let Some(ref tag) = token.tag {
            let file_tag_set = index.file_tags.get(path);
            let matches = file_tag_set.is_some_and(|tags| tags.contains(tag));
            if !matches {
                return false;
            }
        }
        if let Some(ref prefix) = token.path_prefix {
            let matches = rel == *prefix || rel.starts_with(&format!("{prefix}/"));
            if !matches {
                return false;
            }
        }
        if let Some(ref text) = token.text {
            if !name.contains(text) && !rel.contains(text) {
                return false;
            }
        }
    }
    true
}

#[tauri::command]
pub(crate) async fn query_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    query: String,
) -> Result<Vec<QueryHit>, String> {
    let query_raw = query.trim().to_string();
    if query_raw.is_empty() {
        return Ok(Vec::new());
    }
    let tokens = parse_query_tokens(&query_raw);
    if tokens.is_empty() {
        return Err("查询无效".into());
    }

    let root_path = PathBuf::from(&root);
    ensure_allowed(&state, &root_path)?;
    if !root_path.is_dir() {
        return Err("库路径无效".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.state::<IndexCache>();
        let (index, _) = get_or_build_index(&cache, &root_path)?;

        let mut hits = Vec::new();
        for path in index.files.clone() {
            if hits.len() >= MAX_SEARCH_HITS {
                break;
            }
            if !path_matches_query(&path, &root_path, &index, &tokens) {
                continue;
            }
            hits.push(QueryHit {
                path: path.to_string_lossy().to_string(),
                name: file_name(&path),
            });
        }
        Ok(hits)
    })
    .await
    .map_err(|e| format!("查询任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn list_vault_tags(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> Result<Vec<TagInfo>, String> {
    let root_path = PathBuf::from(&root);
    ensure_allowed(&state, &root_path)?;
    if !root_path.is_dir() {
        return Err("库路径无效".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.state::<IndexCache>();
        let (index, _) = get_or_build_index(&cache, &root_path)?;

        let mut out: Vec<TagInfo> = index
            .by_tag
            .iter()
            .map(|(tag, paths)| {
                let unique: HashSet<_> = paths.iter().cloned().collect();
                let mut path_strs: Vec<String> = unique
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                path_strs.sort();
                TagInfo {
                    tag: tag.clone(),
                    count: path_strs.len(),
                    paths: path_strs,
                }
            })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
        Ok(out)
    })
    .await
    .map_err(|e| format!("标签列表任务失败: {e}"))?
}

pub(crate) fn note_stem(name: &str) -> String {
    let lower = name.to_lowercase();
    for ext in [".md", ".markdown", ".mdown", ".mkd"] {
        if lower.ends_with(ext) {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    name.to_string()
}

fn note_link_needles(note_path: &Path, root: &Path) -> Vec<String> {
    let name = file_name(note_path);
    let stem = note_stem(&name);
    let mut needles = vec![stem, name];

    if let Ok(rel) = note_path.strip_prefix(root) {
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        needles.push(rel_s.clone());
        let rel_stem = note_stem(&rel_s);
        if rel_stem != rel_s {
            needles.push(rel_stem);
        }
    }

    needles
        .into_iter()
        .map(|s| s.to_lowercase())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn line_has_wikilink_to(line: &str, needles: &[String]) -> bool {
    let lower = line.to_lowercase();
    for needle in needles {
        // Match [[needle]], [[needle|...]], [[needle#...]], ![[needle]]
        let patterns = [
            format!("[[{needle}]]"),
            format!("[[{needle}|"),
            format!("[[{needle}#"),
            format!("![[{needle}]]"),
            format!("![[{needle}|"),
            format!("![[{needle}#"),
        ];
        if patterns.iter().any(|p| lower.contains(p)) {
            return true;
        }
    }
    false
}

#[tauri::command]
pub(crate) async fn find_backlinks(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    note_path: String,
) -> Result<Vec<BacklinkHit>, String> {
    let root_path = PathBuf::from(&root);
    let note = PathBuf::from(&note_path);
    ensure_allowed(&state, &root_path)?;
    if !root_path.is_dir() {
        return Err("库路径无效".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let needles = note_link_needles(&note, &root_path);
        let cache = app.state::<IndexCache>();
        let (index, _) = get_or_build_index(&cache, &root_path)?;

        let mut hits = Vec::new();
        for path in index.files {
            if path == note {
                continue;
            }
            let meta = match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.is_file() || meta.len() > MAX_SEARCH_FILE_BYTES {
                continue;
            }

            let Ok((content, _)) = read_decoded(&path) else {
                continue;
            };
            let name = file_name(&path);
            for (idx, line) in content.lines().enumerate() {
                if line_has_wikilink_to(line, &needles) {
                    hits.push(BacklinkHit {
                        path: path.to_string_lossy().to_string(),
                        name: name.clone(),
                        line: idx + 1,
                        preview: line.trim().chars().take(140).collect(),
                    });
                    if hits.len() >= MAX_SEARCH_HITS {
                        return Ok(hits);
                    }
                    break;
                }
            }
        }

        Ok(hits)
    })
    .await
    .map_err(|e| format!("反向链接任务失败: {e}"))?
}

pub(crate) fn parse_wikilink_target(inner: &str) -> Option<String> {
    let mut target = inner.trim();
    if target.is_empty() {
        return None;
    }
    if let Some((left, _)) = target.split_once('|') {
        target = left.trim();
    }
    if let Some((left, _)) = target.split_once('#') {
        target = left.trim();
    }
    if target.is_empty() {
        None
    } else {
        Some(target.to_string())
    }
}

fn extract_wikilink_targets(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    let bytes = content.as_bytes();
    while i < bytes.len() {
        let mut start = i;
        if bytes[i] == b'!' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            start = i + 1;
        }
        if start + 1 < bytes.len() && bytes[start] == b'[' && bytes[start + 1] == b'[' {
            let rest = &content[start + 2..];
            if let Some(end) = rest.find("]]") {
                let inner = &rest[..end];
                if !inner.contains('\n') {
                    if let Some(target) = parse_wikilink_target(inner) {
                        out.push(target);
                    }
                }
                i = start + 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn extract_markdown_link_targets(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = content.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            i += 2;
            continue;
        }
        if bytes[i] == b'[' {
            if let Some(close_bracket) = content[i + 1..].find(']') {
                let after_close = i + 1 + close_bracket + 1;
                if after_close < bytes.len() && bytes[after_close] == b'(' {
                    if let Some(close_paren) = content[after_close + 1..].find(')') {
                        let link_target = content[after_close + 1..after_close + 1 + close_paren].trim();
                        if !link_target.is_empty()
                            && !link_target.contains("://")
                            && !link_target.starts_with('#')
                            && !link_target.starts_with("mailto:")
                            && !link_target.starts_with("javascript:")
                            && !link_target.contains('\n')
                        {
                            let clean = link_target.split_whitespace().next().unwrap_or(link_target);
                            let clean = clean.split('#').next().unwrap_or(clean);
                            let clean = clean.split('?').next().unwrap_or(clean);
                            if !clean.is_empty() {
                                out.push(clean.to_string());
                            }
                        }
                        i = after_close + 1 + close_paren + 1;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    out
}

#[derive(Clone)]
struct VaultIndex {
    files: Vec<PathBuf>,
    by_stem: HashMap<String, Vec<PathBuf>>,
    by_name: HashMap<String, PathBuf>,
    by_rel: HashMap<String, PathBuf>,
    by_rel_stem: HashMap<String, PathBuf>,
    /// tag (lowercase) -> note paths
    by_tag: HashMap<String, Vec<PathBuf>>,
    /// note path -> tags (lowercase)
    file_tags: HashMap<PathBuf, HashSet<String>>,
}

struct CachedIndex {
    root: PathBuf,
    fingerprint: u64,
    index: VaultIndex,
    /// Lazily filled; None until first graph build for this fingerprint
    graph_edges: Option<Vec<(String, String)>>,
}

pub(crate) struct IndexCache(Mutex<Option<CachedIndex>>);

impl IndexCache {
    pub(crate) fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = None;
        }
    }
}

fn vault_content_fingerprint(root: &Path) -> Result<u64, String> {
    let mut files = Vec::new();
    walk_markdown_files(root, &mut files)?;
    let mut fp: u64 = files.len() as u64;
    for path in files {
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        fp = fp
            .wrapping_mul(31)
            .wrapping_add(meta.len())
            .wrapping_mul(31)
            .wrapping_add(
                meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            );
    }
    Ok(fp)
}

fn extract_yaml_tags(content: &str) -> Vec<String> {
    let mut tags = Vec::new();
    if !content.starts_with("---") {
        return tags;
    }
    let Some(end) = content[3..].find("\n---") else {
        return tags;
    };
    let front = &content[3..3 + end];
    let mut in_tags = false;
    for line in front.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("tags:") {
            in_tags = true;
            let rest = rest.trim();
            if rest.starts_with('[') && rest.ends_with(']') {
                for part in rest[1..rest.len() - 1].split(',') {
                    let t = part.trim().trim_matches('"').trim_matches('\'');
                    if !t.is_empty() {
                        tags.push(t.to_string());
                    }
                }
                in_tags = false;
            } else if !rest.is_empty() {
                for part in rest.split(',') {
                    let t = part.trim().trim_matches('"').trim_matches('\'');
                    if !t.is_empty() {
                        tags.push(t.to_string());
                    }
                }
                in_tags = false;
            }
            continue;
        }
        if in_tags {
            if let Some(rest) = trimmed.strip_prefix("- ") {
                let t = rest.trim().trim_matches('"').trim_matches('\'');
                if !t.is_empty() {
                    tags.push(t.to_string());
                }
            } else if trimmed.is_empty() {
                continue;
            } else {
                in_tags = false;
            }
        }
    }
    tags
}

fn is_tag_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '-'
}

fn extract_inline_tags(content: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' {
            if i > 0 && is_tag_char(chars[i - 1]) {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while j < chars.len() && is_tag_char(chars[j]) {
                j += 1;
            }
            if j > i + 1 {
                tags.push(chars[i + 1..j].iter().collect());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    tags
}

fn extract_all_tags(content: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    for t in extract_yaml_tags(content) {
        set.insert(t.to_lowercase());
    }
    for t in extract_inline_tags(content) {
        set.insert(t.to_lowercase());
    }
    set
}

fn build_vault_index(root: &Path) -> Result<(VaultIndex, u64), String> {
    let mut files = Vec::new();
    walk_markdown_files(root, &mut files)?;
    let mut by_stem: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut by_name = HashMap::new();
    let mut by_rel = HashMap::new();
    let mut by_rel_stem = HashMap::new();
    let mut by_tag: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut file_tags: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    let mut fp: u64 = files.len() as u64;

    for path in &files {
        if let Ok(meta) = fs::metadata(path) {
            fp = fp
                .wrapping_mul(31)
                .wrapping_add(meta.len())
                .wrapping_mul(31)
                .wrapping_add(
                    meta.modified()
                        .ok()
                        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0),
                );
        }
        let name = file_name(path);
        let stem = note_stem(&name).to_lowercase();
        by_name.insert(name.to_lowercase(), path.clone());
        by_stem.entry(stem).or_default().push(path.clone());

        if let Ok(rel) = path.strip_prefix(root) {
            let rel_s = rel.to_string_lossy().replace('\\', "/");
            let rel_l = rel_s.to_lowercase();
            by_rel.insert(rel_l.clone(), path.clone());
            by_rel_stem.insert(note_stem(&rel_l), path.clone());
        }

        if let Ok(meta) = fs::metadata(path) {
            // Prefix scan only — full decode of every note was the vault-open bottleneck.
            if meta.is_file() && meta.len() > 0 {
                let scan = TAG_SCAN_BYTES.min(meta.len() as usize);
                if let Ok((content, _, _, _)) = read_decoded_range(path, 0, scan, None) {
                    let tags = extract_all_tags(&content);
                    if !tags.is_empty() {
                        file_tags.insert(path.clone(), tags.clone());
                        for tag in tags {
                            by_tag.entry(tag).or_default().push(path.clone());
                        }
                    }
                }
            }
        }
    }

    Ok((
        VaultIndex {
            files,
            by_stem,
            by_name,
            by_rel,
            by_rel_stem,
            by_tag,
            file_tags,
        },
        fp,
    ))
}

fn get_or_build_index(cache: &IndexCache, root: &Path) -> Result<(VaultIndex, u64), String> {
    // Hit path: one fingerprint walk. Miss/stale: one build walk (includes fingerprint).
    {
        let guard = cache.0.lock().map_err(|_| "索引缓存锁失败".to_string())?;
        let maybe = guard.as_ref().filter(|c| c.root == root).map(|c| c.fingerprint);
        drop(guard);
        if let Some(cached_fp) = maybe {
            let fingerprint = vault_content_fingerprint(root)?;
            if cached_fp == fingerprint {
                let guard = cache.0.lock().map_err(|_| "索引缓存锁失败".to_string())?;
                if let Some(cached) = guard.as_ref() {
                    if cached.root == root && cached.fingerprint == fingerprint {
                        return Ok((cached.index.clone(), fingerprint));
                    }
                }
            }
        }
    }
    let (index, built_fp) = build_vault_index(root)?;
    let mut guard = cache.0.lock().map_err(|_| "索引缓存锁失败".to_string())?;
    *guard = Some(CachedIndex {
        root: root.to_path_buf(),
        fingerprint: built_fp,
        index: index.clone(),
        graph_edges: None,
    });
    Ok((index, built_fp))
}

fn path_id(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\")
}

pub(crate) fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn find_indexed_path(index: &VaultIndex, focus: &Path) -> Option<PathBuf> {
    let key = path_key(focus);
    index
        .files
        .iter()
        .find(|p| path_key(p) == key)
        .cloned()
}

/// Media / binary wiki targets must not become orphan graph nodes.
pub(crate) fn is_media_wiki_target(target: &str) -> bool {
    let t = target.trim().to_lowercase().replace('\\', "/");
    let base = t.rsplit('/').next().unwrap_or(&t);
    matches!(
        base.rsplit_once('.').map(|(_, ext)| ext),
        Some(
            "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "svg"
                | "bmp"
                | "avif"
                | "ico"
                | "mp3"
                | "wav"
                | "ogg"
                | "m4a"
                | "flac"
                | "aac"
                | "mp4"
                | "webm"
                | "mov"
                | "mkv"
                | "avi"
                | "pdf"
                | "zip"
                | "tar"
                | "gz"
                | "7z"
                | "rar"
                | "docx"
                | "xlsx"
                | "pptx"
                | "doc"
                | "xls"
                | "ppt"
                | "exe"
                | "dmg"
                | "pkg"
                | "iso"
        )
    )
}

fn resolve_wiki_target_graph(
    index: &VaultIndex,
    source_path: Option<&Path>,
    target: &str,
) -> Result<PathBuf, String> {
    let mut raw = target.trim().replace('\\', "/");
    if let Some(stripped) = raw.strip_prefix("./") {
        raw = stripped.to_string();
    }
    if let Some(src) = source_path {
        if let Some(parent) = src.parent() {
            let candidate = parent.join(&raw);
            let cand_key = path_key(&candidate);
            if let Some(p) = index.files.iter().find(|p| path_key(p) == cand_key) {
                return Ok(p.clone());
            }
            let cand_key_md = format!("{cand_key}.md");
            if let Some(p) = index.files.iter().find(|p| path_key(p) == cand_key_md) {
                return Ok(p.clone());
            }
        }
    }

    let key = raw.to_lowercase();
    let key_no_ext = note_stem(&key);
    let base = key_no_ext.rsplit('/').next().unwrap_or(&key_no_ext).to_string();

    if let Some(p) = index
        .by_rel
        .get(&key)
        .or_else(|| index.by_rel.get(&format!("{key}.md")))
    {
        return Ok(p.clone());
    }
    if let Some(p) = index.by_rel_stem.get(&key_no_ext) {
        return Ok(p.clone());
    }
    if let Some(p) = index
        .by_name
        .get(&key)
        .or_else(|| index.by_name.get(&format!("{key}.md")))
    {
        return Ok(p.clone());
    }
    if let Some(list) = index.by_stem.get(&base) {
        if list.len() == 1 {
            return Ok(list[0].clone());
        }
        if list.len() > 1 {
            return Err(format!("conflict:{base}"));
        }
    }
    Err(format!("orphan:{}", target.to_lowercase()))
}

fn compute_graph_edges(index: &VaultIndex) -> Vec<(String, String)> {
    let mut edges: Vec<(String, String)> = Vec::new();
    for path in &index.files {
        let Ok(meta) = fs::metadata(path) else { continue };
        if !meta.is_file() || meta.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        let scan = (meta.len() as usize).min(GRAPH_SCAN_BYTES);
        let Ok((content, _, _, _)) = read_decoded_range(path, 0, scan, None) else {
            continue;
        };
        let source_id = path_id(path);
        // One edge per unique target per source — repeated links must not multiply forces.
        let mut seen_targets = HashSet::new();

        // 1. Wikilinks [[target]]
        for target in extract_wikilink_targets(&content) {
            if is_media_wiki_target(&target) {
                continue;
            }
            let target_id = match resolve_wiki_target_graph(index, Some(path), &target) {
                Ok(resolved) => path_id(&resolved),
                Err(id) => id,
            };
            if source_id == target_id {
                continue;
            }
            if !seen_targets.insert(target_id.clone()) {
                continue;
            }
            edges.push((source_id.clone(), target_id));
        }

        // 2. Markdown links [text](target.md)
        for target in extract_markdown_link_targets(&content) {
            if is_media_wiki_target(&target) {
                continue;
            }
            let is_explicit_md = target.ends_with(".md") || target.ends_with(".markdown");
            let target_res = resolve_wiki_target_graph(index, Some(path), &target);
            let target_id = match target_res {
                Ok(resolved) => path_id(&resolved),
                Err(id) if is_explicit_md => id,
                _ => continue,
            };
            if source_id == target_id {
                continue;
            }
            if !seen_targets.insert(target_id.clone()) {
                continue;
            }
            edges.push((source_id.clone(), target_id));
        }
    }
    edges
}

fn get_or_compute_graph_edges(
    cache: &IndexCache,
    root: &Path,
    index: &VaultIndex,
    fingerprint: u64,
) -> Result<Vec<(String, String)>, String> {
    {
        let guard = cache.0.lock().map_err(|_| "索引缓存锁失败".to_string())?;
        if let Some(cached) = guard.as_ref() {
            if cached.root == root && cached.fingerprint == fingerprint {
                if let Some(ref edges) = cached.graph_edges {
                    return Ok(edges.clone());
                }
            }
        }
    }
    let edges = compute_graph_edges(index);
    let mut guard = cache.0.lock().map_err(|_| "索引缓存锁失败".to_string())?;
    if let Some(cached) = guard.as_mut() {
        if cached.root == root && cached.fingerprint == fingerprint {
            cached.graph_edges = Some(edges.clone());
        }
    }
    Ok(edges)
}

#[tauri::command]
pub(crate) async fn build_vault_graph(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    mode: String,
    focus_path: Option<String>,
    local_hops: Option<u32>,
) -> Result<GraphData, String> {
    let root_path = PathBuf::from(&root);
    ensure_allowed(&state, &root_path)?;
    if !root_path.is_dir() {
        return Err("库路径无效".into());
    }
    let mode_flag = if mode == "local" { "local" } else { "full" };
    let focus = focus_path.clone();
    let hops = local_hops.unwrap_or(1).clamp(1, 3);

    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.state::<IndexCache>();
        let (index, fingerprint) = get_or_build_index(&cache, &root_path)?;
        let edges = get_or_compute_graph_edges(&cache, &root_path, &index, fingerprint)?;
        build_vault_graph_inner(index, edges, mode_flag, focus, hops)
    })
    .await
    .map_err(|e| format!("图谱任务失败: {e}"))?
}

fn ensure_special_node(meta: &mut HashMap<String, GraphNode>, id: &str, kind: &str, name: &str) {
    meta.entry(id.to_string()).or_insert_with(|| GraphNode {
        id: id.to_string(),
        path: None,
        name: name.to_string(),
        kind: kind.into(),
        is_focus: false,
    });
}

/// Collect node ids within `hops` undirected distance of `focus_id`.
fn local_neighborhood(
    edges: &[(String, String)],
    focus_id: &str,
    hops: u32,
) -> (std::collections::HashSet<String>, Vec<(String, String)>) {
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for (s, t) in edges {
        adj.entry(s.clone()).or_default().push(t.clone());
        adj.entry(t.clone()).or_default().push(s.clone());
    }
    let mut keep = std::collections::HashSet::new();
    keep.insert(focus_id.to_string());
    let mut frontier = vec![focus_id.to_string()];
    for _ in 0..hops {
        let mut next = Vec::new();
        for id in frontier {
            if let Some(neis) = adj.get(&id) {
                for n in neis {
                    if keep.insert(n.clone()) {
                        next.push(n.clone());
                    }
                }
            }
        }
        frontier = next;
    }
    let local_edges: Vec<_> = edges
        .iter()
        .filter(|(s, t)| keep.contains(s) && keep.contains(t))
        .cloned()
        .collect();
    (keep, local_edges)
}

fn build_vault_graph_inner(
    index: VaultIndex,
    mut edges: Vec<(String, String)>,
    mode: &str,
    focus_path: Option<String>,
    local_hops: u32,
) -> Result<GraphData, String> {
    let mut node_meta: HashMap<String, GraphNode> = HashMap::new();
    let vault_note_count = index.files.len();

    let focus_resolved = focus_path
        .as_ref()
        .map(PathBuf::from)
        .and_then(|p| find_indexed_path(&index, &p).or(Some(p)));
    let focus_key = focus_resolved.as_ref().map(|p| path_key(p));

    let ensure_file_node = |meta: &mut HashMap<String, GraphNode>, path: &Path| {
        let id = path_id(path);
        let key = path_key(path);
        meta.entry(id.clone()).or_insert_with(|| GraphNode {
            id: id.clone(),
            path: Some(id.clone()),
            name: file_name(path),
            kind: "note".into(),
            is_focus: focus_key.as_ref().is_some_and(|f| f == &key),
        });
        id
    };

    // Rebuild nodes from the index + cached edges (no content re-read).
    for path in &index.files {
        let Ok(meta) = fs::metadata(path) else { continue };
        if !meta.is_file() || meta.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        ensure_file_node(&mut node_meta, path);
    }
    for (s, t) in &edges {
        for id in [s.as_str(), t.as_str()] {
            if let Some(target) = id.strip_prefix("orphan:") {
                ensure_special_node(&mut node_meta, id, "orphan", target);
            } else if let Some(stem) = id.strip_prefix("conflict:") {
                ensure_special_node(&mut node_meta, id, "conflict", stem);
            } else {
                ensure_file_node(&mut node_meta, Path::new(id));
            }
        }
    }

    if mode == "local" {
        let Some(ref focus_path) = focus_resolved else {
            return Err("局部图需要当前打开的笔记".into());
        };
        let focus_id = ensure_file_node(&mut node_meta, focus_path);
        let (keep, local_edges) = local_neighborhood(&edges, &focus_id, local_hops);
        edges = local_edges;
        node_meta.retain(|id, _| keep.contains(id));
        if let Some(n) = node_meta.get_mut(&focus_id) {
            n.is_focus = true;
        }
    }

    // Cap full graph size — always keep focus + a budget of isolates, then by degree.
    const MAX_NODES: usize = 1_200;
    let mut truncated = false;
    if mode == "full" && node_meta.len() > MAX_NODES {
        truncated = true;
        let mut degree: HashMap<String, usize> = HashMap::new();
        for (s, t) in &edges {
            *degree.entry(s.clone()).or_default() += 1;
            *degree.entry(t.clone()).or_default() += 1;
        }

        let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Some(ref fp) = focus_resolved {
            keep.insert(path_id(fp));
        }

        // Prefer linked nodes by degree
        let mut ranked: Vec<_> = degree.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        for (id, _) in ranked {
            if keep.len() >= MAX_NODES {
                break;
            }
            keep.insert(id);
        }

        // Fill remaining slots with isolates (notes with no edges) so they aren't all dropped
        if keep.len() < MAX_NODES {
            let mut isolates: Vec<_> = node_meta
                .keys()
                .filter(|id| !keep.contains(*id))
                .cloned()
                .collect();
            isolates.sort();
            for id in isolates {
                if keep.len() >= MAX_NODES {
                    break;
                }
                keep.insert(id);
            }
        }

        edges.retain(|(s, t)| keep.contains(s) && keep.contains(t));
        node_meta.retain(|id, _| keep.contains(id));
    }

    // Global uniqueness pass (covers A→B emitted from multiple code paths).
    let mut unique = std::collections::HashSet::new();
    edges.retain(|(s, t)| unique.insert((s.clone(), t.clone())));

    let link_count = edges.len();
    let nodes: Vec<_> = node_meta.into_values().collect();
    let links = edges
        .into_iter()
        .map(|(source, target)| GraphLink { source, target })
        .collect::<Vec<_>>();

    Ok(GraphData {
        mode: mode.to_string(),
        file_count: nodes.len(),
        link_count,
        nodes,
        links,
        truncated,
        vault_note_count,
        max_nodes: if mode == "full" { MAX_NODES } else { 0 },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn note_stem_strips_markdown_extensions() {
        assert_eq!(note_stem("Note.md"), "Note");
        assert_eq!(note_stem("Note.markdown"), "Note");
        assert_eq!(note_stem("Note.MDOWN"), "Note");
        assert_eq!(note_stem("plain"), "plain");
    }

    #[test]
    fn parse_wikilink_target_strips_alias_and_heading() {
        assert_eq!(
            parse_wikilink_target("Foo|Alias"),
            Some("Foo".to_string())
        );
        assert_eq!(
            parse_wikilink_target("Bar#heading"),
            Some("Bar".to_string())
        );
        assert_eq!(
            parse_wikilink_target(" nested/path.md "),
            Some("nested/path.md".to_string())
        );
        assert_eq!(parse_wikilink_target("  "), None);
    }

    #[test]
    fn path_key_normalizes_slashes_and_case() {
        let p = Path::new(r"C:\Vault\Notes\Hello.MD");
        let key = path_key(p);
        assert!(key.contains('/'));
        assert!(!key.contains('\\'));
        assert_eq!(key, key.to_lowercase());
    }

    #[test]
    fn extract_yaml_and_inline_tags() {
        let md = "---\ntags:\n  - Project\n  - alpha\n---\n\nBody #inline-tag and #nested#no\n";
        let tags = extract_all_tags(md);
        assert!(tags.contains("project"));
        assert!(tags.contains("alpha"));
        assert!(tags.contains("inline-tag"));
        assert!(!tags.contains("no"));
    }

    #[test]
    fn parse_query_tokens_splits_operators() {
        let tokens = parse_query_tokens("tag:foo path:notes/bar hello");
        assert_eq!(tokens.len(), 3);
        assert_eq!(tokens[0].tag.as_deref(), Some("foo"));
        assert_eq!(tokens[1].path_prefix.as_deref(), Some("notes/bar"));
        assert_eq!(tokens[2].text.as_deref(), Some("hello"));
    }

    #[test]
    fn media_wiki_targets_are_filtered() {
        assert!(is_media_wiki_target("shot.png"));
        assert!(is_media_wiki_target("assets/a.JPG"));
        assert!(is_media_wiki_target("doc.pdf"));
        assert!(is_media_wiki_target("audio.m4a"));
        assert!(is_media_wiki_target("archive.tar.gz"));
        assert!(is_media_wiki_target("sheet.xlsx"));
        assert!(!is_media_wiki_target("项目Alpha"));
        assert!(!is_media_wiki_target("note.md"));
    }

    #[test]
    fn extract_markdown_link_targets_handles_links_and_filters_external() {
        let content = "See [Doc](notes/plan.md) and [Relative](./sub/note.md#anchor) and [External](https://google.com) and [Anchor](#heading)";
        let targets = extract_markdown_link_targets(content);
        assert_eq!(targets, vec!["notes/plan.md", "./sub/note.md"]);
    }

    #[test]
    fn local_neighborhood_respects_hops() {
        let edges = vec![
            ("A".into(), "B".into()),
            ("B".into(), "C".into()),
            ("C".into(), "D".into()),
            ("X".into(), "Y".into()),
        ];
        let (keep1, e1) = local_neighborhood(&edges, "A", 1);
        assert!(keep1.contains("A") && keep1.contains("B"));
        assert!(!keep1.contains("C"));
        assert_eq!(e1.len(), 1);

        let (keep2, e2) = local_neighborhood(&edges, "A", 2);
        assert!(keep2.contains("C"));
        assert!(!keep2.contains("D"));
        assert_eq!(e2.len(), 2);
    }
}
