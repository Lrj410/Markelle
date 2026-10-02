//! Disk-windowed store for large markdown files.
//!
//! Contract:
//! - Never hold the full decoded file as a `String` in RAM.
//! - Keep a growing `file_line_starts` index (raw file byte offsets of each `\n` boundary).
//! - Serve windows by seek + decode; WebView only ever sees the visible slice.
//! - Edits use a sparse overlay; save streams a rewrite when needed.

use crate::access::{ensure_allowed, is_symlink, AppState};
use crate::encoding_util::read_decoded_range;
use crate::{FIRST_CHUNK_BYTES, HYDRATE_CHUNK_BYTES};
use memmap2::Mmap;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager, State};

const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(250);
const INDEX_CHUNK: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub struct LargeFileStore(pub Mutex<HashMap<String, LargeFileEntry>>);

#[derive(Clone)]
pub struct LargeFileEntry {
    pub path: PathBuf,
    pub mmap: Option<Arc<Mmap>>,
    /// Raw file byte offsets of each line start (`\n`-delimited).
    pub file_line_starts: Vec<u64>,
    pub encoding: String,
    pub mtime_ms: u64,
    pub size_bytes: u64,
    /// How far the line index has been scanned on disk.
    pub bytes_indexed: u64,
    pub partial: bool,
    /// True when the on-disk file ends with `\n`.
    pub ends_with_newline: bool,
    /// Sparse edits: 0-based line index → line text (no trailing newline).
    pub edits: HashMap<usize, String>,
}

pub fn open_mmap(path: &Path) -> Option<Arc<Mmap>> {
    let file = File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if meta.len() == 0 {
        return None;
    }
    // SAFETY: We only read from the mmap. The file is opened read-only.
    unsafe { Mmap::map(&file) }.ok().map(Arc::new)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileProgress {
    pub path: String,
    pub bytes_read: u64,
    pub size: u64,
    pub done: bool,
    pub ready: bool,
    pub line_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileLines {
    pub start_line: usize,
    pub total_lines: usize,
    pub lines: Vec<String>,
    pub partial: bool,
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn meta_mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ensure_under_cap(size: u64) -> Result<(), String> {
    crate::ensure_file_under_hard_cap(size)
}

fn emit_progress(app: &AppHandle, progress: LargeFileProgress) {
    let _ = app.emit("large-file-progress", progress);
}

/// Scan `[from, to)` for `\n` and append line-start offsets. Returns `(bytes_indexed, ends_with_newline)`.
fn scan_line_index(
    path: &Path,
    mmap: Option<&[u8]>,
    from: u64,
    to: u64,
    starts: &mut Vec<u64>,
) -> Result<(u64, bool), String> {
    if to <= from {
        return Ok((from, false));
    }
    if let Some(mm) = mmap {
        let file_len = mm.len() as u64;
        let start_pos = from.min(file_len) as usize;
        let end_pos = to.min(file_len) as usize;
        if start_pos >= end_pos {
            return Ok((from, false));
        }
        let slice = &mm[start_pos..end_pos];
        for (i, &b) in slice.iter().enumerate() {
            if b == b'\n' {
                let next = (start_pos + i + 1) as u64;
                if next < file_len {
                    starts.push(next);
                }
            }
        }
        let ends_with_nl = slice.last() == Some(&b'\n');
        return Ok((end_pos as u64, ends_with_nl));
    }

    let mut file = File::open(path).map_err(|e| format!("无法读取文件: {e}"))?;
    file.seek(SeekFrom::Start(from))
        .map_err(|e| format!("无法定位文件: {e}"))?;

    let mut offset = from;
    let mut ends_with_nl = false;
    let mut buf = vec![0u8; INDEX_CHUNK.min((to - from) as usize).max(64 * 1024)];

    while offset < to {
        let want = ((to - offset) as usize).min(buf.len());
        let n = file
            .read(&mut buf[..want])
            .map_err(|e| format!("无法读取文件: {e}"))?;
        if n == 0 {
            break;
        }
        ends_with_nl = scan_line_index_bytes(offset, &buf[..n], to, starts);
        offset += n as u64;
    }

    Ok((offset.min(to), ends_with_nl))
}

/// In-memory newline scan — used when open already held the first chunk bytes.
fn scan_line_index_bytes(base: u64, buf: &[u8], file_end: u64, starts: &mut Vec<u64>) -> bool {
    for (i, b) in buf.iter().enumerate() {
        if *b == b'\n' {
            let next = base + i as u64 + 1;
            if next < file_end {
                starts.push(next);
            }
        }
    }
    buf.last() == Some(&b'\n')
}

fn finalize_line_starts(starts: &mut Vec<u64>, size: u64) {
    if size == 0 {
        starts.clear();
        return;
    }
    if starts.is_empty() {
        starts.push(0);
    }
}

fn detect_encoding_hint(path: &Path) -> Result<String, String> {
    let (text_probe, enc, _, _) = read_decoded_range(path, 0, 4096, None)?;
    let _ = text_probe;
    Ok(enc)
}

fn strip_line_ending(mut s: String) -> String {
    if s.ends_with('\n') {
        s.pop();
        if s.ends_with('\r') {
            s.pop();
        }
    } else if s.ends_with('\r') {
        s.pop();
    }
    s
}

fn line_byte_end(entry: &LargeFileEntry, line_idx: usize) -> u64 {
    entry
        .file_line_starts
        .get(line_idx + 1)
        .copied()
        .unwrap_or(entry.bytes_indexed.min(entry.size_bytes))
}

fn read_line_from_disk(entry: &LargeFileEntry, line_idx: usize) -> Result<String, String> {
    if let Some(edited) = entry.edits.get(&line_idx) {
        return Ok(edited.clone());
    }
    let total = entry.file_line_starts.len();
    if line_idx >= total {
        return Ok(String::new());
    }
    let from = entry.file_line_starts[line_idx];
    let to = line_byte_end(entry, line_idx);
    if to <= from {
        return Ok(String::new());
    }

    if let Some(mmap) = &entry.mmap {
        let from_idx = from as usize;
        let to_idx = (to as usize).min(mmap.len());
        if to_idx > from_idx {
            let slice = &mmap[from_idx..to_idx];
            let (text, _) = crate::encoding_util::decode_with_hint(slice, Some(&entry.encoding), false);
            return Ok(strip_line_ending(text));
        }
    }

    let max = (to - from) as usize;
    let hint = Some(entry.encoding.as_str());
    let (text, _, _, _) = read_decoded_range(&entry.path, from, max, hint)?;
    Ok(strip_line_ending(text))
}

/// Split a contiguous decoded window into `expected` lines (index-defined by `\n`).
fn split_window_text(text: String, expected: usize) -> Option<Vec<String>> {
    if expected == 0 {
        return Some(Vec::new());
    }
    let mut lines = Vec::with_capacity(expected);
    let mut start = 0usize;
    let bytes = text.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'\n' {
            let mut end = i;
            if end > start && bytes[end - 1] == b'\r' {
                end -= 1;
            }
            lines.push(text[start..end].to_string());
            start = i + 1;
            if lines.len() == expected {
                return Some(lines);
            }
        }
    }
    if lines.len() + 1 == expected {
        let mut end = text.len();
        if end > start && bytes[end - 1] == b'\r' {
            end -= 1;
        }
        lines.push(text[start..end].to_string());
        return Some(lines);
    }
    None
}

/// One open/seek/decode for a contiguous unedited run — scroll hot path.
fn read_lines_run_from_disk(
    entry: &LargeFileEntry,
    start: usize,
    take: usize,
) -> Result<Vec<String>, String> {
    if take == 0 {
        return Ok(Vec::new());
    }
    let total = entry.file_line_starts.len();
    if start >= total {
        return Ok(vec![String::new(); take]);
    }
    let end = (start + take).min(total);
    let from = entry.file_line_starts[start];
    let to = if end < total {
        entry.file_line_starts[end]
    } else {
        entry.bytes_indexed.min(entry.size_bytes)
    };
    if to <= from {
        return Ok(vec![String::new(); end - start]);
    }

    let text = if let Some(mmap) = &entry.mmap {
        let from_idx = from as usize;
        let to_idx = (to as usize).min(mmap.len());
        if to_idx > from_idx {
            let slice = &mmap[from_idx..to_idx];
            let (text, _) = crate::encoding_util::decode_with_hint(slice, Some(&entry.encoding), false);
            text
        } else {
            String::new()
        }
    } else {
        let (t, _, _, _) = read_decoded_range(
            &entry.path,
            from,
            (to - from) as usize,
            Some(entry.encoding.as_str()),
        )?;
        t
    };

    let expected = end - start;
    if let Some(mut lines) = split_window_text(text, expected) {
        // Pad if index claimed more lines than bytes (partial index edge).
        while lines.len() < take {
            lines.push(String::new());
        }
        return Ok(lines);
    }
    // Encoding / boundary mismatch — fall back per line (rare).
    let mut lines = Vec::with_capacity(take);
    for i in start..start + take {
        lines.push(read_line_from_disk(entry, i)?);
    }
    Ok(lines)
}

/// Serve a line window with batched disk I/O; sparse edits break the run.
fn read_lines_window(entry: &LargeFileEntry, start: usize, take: usize) -> Result<Vec<String>, String> {
    let total = entry.file_line_starts.len();
    if take == 0 || total == 0 {
        return Ok(Vec::new());
    }
    let start = start.min(total.saturating_sub(1));
    let take = take.min(total - start);
    let mut out = Vec::with_capacity(take);
    let mut i = start;
    let end = start + take;
    while i < end {
        if let Some(edited) = entry.edits.get(&i) {
            out.push(edited.clone());
            i += 1;
            continue;
        }
        let run_start = i;
        i += 1;
        while i < end && !entry.edits.contains_key(&i) {
            i += 1;
        }
        out.extend(read_lines_run_from_disk(entry, run_start, i - run_start)?);
    }
    Ok(out)
}

/// Commit a finished background index over the seed entry.
///
/// Sparse edits (`entry.edits`) written while the scan was running must survive:
/// the final publish only refreshes the index and flags, never the overlay.
#[allow(clippy::too_many_arguments)]
fn finalize_hydrate_entry(
    store: &LargeFileStore,
    key: &str,
    path: &Path,
    starts: Vec<u64>,
    encoding: String,
    mtime_ms: u64,
    size: u64,
    ends_with_newline: bool,
) -> Result<(), String> {
    let mut guard = store
        .0
        .lock()
        .map_err(|_| "大文件缓存锁失败".to_string())?;
    if guard.contains_key(key) {
        if let Some(entry) = guard.get_mut(key) {
            entry.file_line_starts = starts;
            entry.encoding = encoding;
            entry.mtime_ms = mtime_ms;
            entry.size_bytes = size;
            entry.bytes_indexed = size;
            entry.partial = false;
            entry.ends_with_newline = ends_with_newline;
            // `entry.edits` intentionally left untouched.
        }
    } else {
        guard.insert(
            key.to_string(),
            LargeFileEntry {
                path: path.to_path_buf(),
                mmap: open_mmap(path),
                file_line_starts: starts,
                encoding,
                mtime_ms,
                size_bytes: size,
                bytes_indexed: size,
                partial: false,
                ends_with_newline,
                edits: HashMap::new(),
            },
        );
    }
    Ok(())
}

fn progress_payload(
    path: String,
    bytes_read: u64,
    size: u64,
    done: bool,
    ready: bool,
    line_count: usize,
    error: Option<String>,
) -> LargeFileProgress {
    LargeFileProgress {
        path,
        bytes_read,
        size,
        done,
        ready,
        line_count,
        error,
    }
}

/// Build / extend the on-disk line index; never materializes full text.
#[tauri::command]
pub(crate) async fn hydrate_large_file(
    app: AppHandle,
    state: State<'_, AppState>,
    store: State<'_, LargeFileStore>,
    path: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("文件不存在: {}", path_buf.display()));
    }
    ensure_allowed(&state, &path_buf)?;
    if is_symlink(&path_buf) {
        return Err("拒绝通过符号链接读取文件".into());
    }

    let meta = fs::metadata(&path_buf).map_err(|e| format!("无法读取文件信息: {e}"))?;
    let size = meta.len();
    ensure_under_cap(size)?;
    let mtime_ms = meta_mtime_ms(&meta);
    let key = path_key(&path_buf);

    let (resume_starts, resume_offset, resume_enc, resume_ends_nl) = {
        let mut guard = store
            .0
            .lock()
            .map_err(|_| "大文件缓存锁失败".to_string())?;
        if let Some(entry) = guard.get(&key) {
            if entry.mtime_ms == mtime_ms
                && entry.size_bytes == size
                && !entry.partial
                && entry.bytes_indexed >= size
            {
                let display = path_buf.to_string_lossy().to_string();
                emit_progress(
                    &app,
                    progress_payload(
                        display,
                        size,
                        size,
                        true,
                        true,
                        entry.file_line_starts.len(),
                        None,
                    ),
                );
                return Ok(());
            }
            if entry.mtime_ms == mtime_ms && entry.size_bytes == size && entry.bytes_indexed > 0 {
                (
                    entry.file_line_starts.clone(),
                    entry.bytes_indexed,
                    entry.encoding.clone(),
                    entry.ends_with_newline,
                )
            } else {
                guard.remove(&key);
                (Vec::new(), 0u64, String::new(), false)
            }
        } else {
            (Vec::new(), 0u64, String::new(), false)
        }
    };

    let app2 = app.clone();
    let path_for_emit = path_buf.to_string_lossy().to_string();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let store = app2.state::<LargeFileStore>();
        let mut starts = resume_starts;
        let mut offset = resume_offset;
        let mut ends_nl = resume_ends_nl;
        let encoding = if resume_enc.is_empty() {
            detect_encoding_hint(&path_buf)?
        } else {
            resume_enc
        };

        if size > 0 && starts.is_empty() {
            starts.push(0);
        }

        let mmap = open_mmap(&path_buf);

        // Publish seed snapshot immediately.
        {
            let mut guard = store
                .0
                .lock()
                .map_err(|_| "大文件缓存锁失败".to_string())?;
            guard.insert(
                key.clone(),
                LargeFileEntry {
                    path: path_buf.clone(),
                    mmap: mmap.clone(),
                    file_line_starts: starts.clone(),
                    encoding: encoding.clone(),
                    mtime_ms,
                    size_bytes: size,
                    bytes_indexed: offset,
                    partial: offset < size,
                    ends_with_newline: ends_nl,
                    edits: HashMap::new(),
                },
            );
        }
        emit_progress(
            &app2,
            progress_payload(
                path_for_emit.clone(),
                offset.min(size),
                size,
                false,
                true,
                starts.len(),
                None,
            ),
        );

        let mut last_emit = Instant::now()
            .checked_sub(PROGRESS_EMIT_INTERVAL)
            .unwrap_or_else(Instant::now);

        while offset < size {
            let chunk_size = if mmap.is_some() {
                32 * 1024 * 1024
            } else {
                HYDRATE_CHUNK_BYTES.max(FIRST_CHUNK_BYTES)
            };
            let chunk_end = (offset + chunk_size).min(size);
            let (next, chunk_ends_nl) = scan_line_index(&path_buf, mmap.as_deref().map(|m| &m[..]), offset, chunk_end, &mut starts)?;
            if next <= offset {
                offset = chunk_end;
            } else {
                offset = next;
            }
            ends_nl = chunk_ends_nl;

            {
                let mut guard = store
                    .0
                    .lock()
                    .map_err(|_| "大文件缓存锁失败".to_string())?;
                if let Some(entry) = guard.get_mut(&key) {
                    // Append only — avoid cloning the full index every chunk (GB files).
                    let prev = entry.file_line_starts.len();
                    if starts.len() > prev {
                        entry
                            .file_line_starts
                            .extend_from_slice(&starts[prev..]);
                    }
                    entry.bytes_indexed = offset.min(size);
                    entry.partial = offset < size;
                    entry.ends_with_newline = ends_nl;
                    entry.encoding = encoding.clone();
                }
            }

            let now = Instant::now();
            if offset >= size || now.duration_since(last_emit) >= PROGRESS_EMIT_INTERVAL {
                emit_progress(
                    &app2,
                    progress_payload(
                        path_for_emit.clone(),
                        offset.min(size),
                        size,
                        false,
                        true,
                        starts.len(),
                        None,
                    ),
                );
                last_emit = now;
            }
        }

        finalize_line_starts(&mut starts, size);
        let line_count = starts.len();
        finalize_hydrate_entry(
            &store,
            &key,
            &path_buf,
            starts,
            encoding,
            mtime_ms,
            size,
            ends_nl,
        )?;

        Ok::<_, String>((path_for_emit, size, line_count))
    })
    .await
    .map_err(|e| format!("大文件加载任务失败: {e}"))?;

    match result {
        Ok((display, size, line_count)) => {
            emit_progress(
                &app,
                progress_payload(display, size, size, true, true, line_count, None),
            );
            Ok(())
        }
        Err(e) => {
            emit_progress(
                &app,
                progress_payload(path, 0, size, true, false, 0, Some(e.clone())),
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub(crate) async fn large_file_lines(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    start_line: u32,
    count: u32,
) -> Result<LargeFileLines, String> {
    let path_buf = PathBuf::from(&path);
    ensure_allowed(&state, &path_buf)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<LargeFileStore>();
        large_file_lines_blocking(&store, &path_buf, start_line, count)
    })
    .await
    .map_err(|e| format!("大文件读取任务失败: {e}"))?
}

fn large_file_lines_blocking(
    store: &LargeFileStore,
    path_buf: &Path,
    start_line: u32,
    count: u32,
) -> Result<LargeFileLines, String> {
    let key = path_key(path_buf);

    // Snapshot under the lock, then read disk unlocked so hydrate can append indexes.
    let (mut snap, start, take, total, partial) = {
        let guard = store
            .0
            .lock()
            .map_err(|_| "大文件缓存锁失败".to_string())?;
        let entry = guard
            .get(&key)
            .ok_or_else(|| "大文件尚未就绪".to_string())?;
        let total = entry.file_line_starts.len();
        let partial = entry.partial;
        if total == 0 {
            return Ok(LargeFileLines {
                start_line: 1,
                total_lines: 0,
                lines: vec![],
                partial,
            });
        }
        let start = (start_line.max(1) as usize - 1).min(total.saturating_sub(1));
        let take = (count.clamp(1, 2_000) as usize).min(total - start);
        let end = start + take;
        // Line starts for the window + sentinel end offset.
        let mut starts = entry.file_line_starts[start..end].to_vec();
        let end_byte = if end < total {
            entry.file_line_starts[end]
        } else {
            entry.bytes_indexed.min(entry.size_bytes)
        };
        starts.push(end_byte);
        let mut edits = HashMap::new();
        for i in start..end {
            if let Some(text) = entry.edits.get(&i) {
                edits.insert(i - start, text.clone());
            }
        }
        let snap = LargeFileEntry {
            path: entry.path.clone(),
            mmap: entry.mmap.clone(),
            file_line_starts: starts,
            encoding: entry.encoding.clone(),
            mtime_ms: entry.mtime_ms,
            size_bytes: entry.size_bytes,
            bytes_indexed: end_byte,
            partial,
            ends_with_newline: entry.ends_with_newline,
            edits,
        };
        (snap, start, take, total, partial)
    };

    // Remap: snap indices are 0..take with a trailing sentinel start.
    // Drop the sentinel from "line count" for read_lines_window by using take.
    let sentinel = snap.file_line_starts.pop().unwrap_or(snap.bytes_indexed);
    snap.bytes_indexed = sentinel;
    let lines = read_lines_window(&snap, 0, take)?;
    Ok(LargeFileLines {
        start_line: start + 1,
        total_lines: total,
        lines,
        partial,
    })
}

#[tauri::command]
pub(crate) fn large_file_close(
    state: State<'_, AppState>,
    store: State<'_, LargeFileStore>,
    path: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    ensure_allowed(&state, &path_buf)?;
    let key = path_key(&path_buf);
    let mut guard = store
        .0
        .lock()
        .map_err(|_| "大文件缓存锁失败".to_string())?;
    guard.remove(&key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn scan_builds_line_starts() {
        let dir = std::env::temp_dir().join(format!("mkl-lf-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("t.md");
        {
            let mut f = File::create(&path).unwrap();
            write!(f, "a\nb\nc").unwrap();
        }
        let mut starts = vec![0u64];
        let (indexed, ends) = scan_line_index(&path, None, 0, 5, &mut starts).unwrap();
        assert_eq!(indexed, 5);
        assert!(!ends);
        assert_eq!(starts, vec![0, 2, 4]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn batch_window_matches_per_line() {
        let dir = std::env::temp_dir().join(format!("mkl-lf3-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("win.md");
        {
            let mut f = File::create(&path).unwrap();
            for i in 0..80 {
                writeln!(f, "row-{i}-内容").unwrap();
            }
            write!(f, "tail-no-nl").unwrap();
        }
        let meta = fs::metadata(&path).unwrap();
        let store = LargeFileStore::default();
        let key = path_key(&path);
        let mut starts = vec![0u64];
        let (indexed, ends_nl) =
            scan_line_index(&path, None, 0, meta.len(), &mut starts).unwrap();
        {
            let mut g = store.0.lock().unwrap();
            g.insert(
                key.clone(),
                LargeFileEntry {
                    path: path.clone(),
                    mmap: None,
                    file_line_starts: starts,
                    encoding: "utf-8".into(),
                    mtime_ms: 1,
                    size_bytes: meta.len(),
                    bytes_indexed: indexed,
                    partial: false,
                    ends_with_newline: ends_nl,
                    edits: HashMap::new(),
                },
            );
        }
        let guard = store.0.lock().unwrap();
        let entry = guard.get(&key).unwrap();
        let batch = read_lines_window(entry, 10, 25).unwrap();
        assert_eq!(batch.len(), 25);
        for (i, line) in batch.iter().enumerate() {
            let expected = read_line_from_disk(entry, 10 + i).unwrap();
            assert_eq!(line, &expected, "mismatch at {}", 10 + i);
        }
        // Sparse edit breaks the run but still matches.
        drop(guard);
        {
            let mut g = store.0.lock().unwrap();
            let e = g.get_mut(&path_key(&path)).unwrap();
            e.edits.insert(15, "EDITED".into());
            let mixed = read_lines_window(e, 10, 20).unwrap();
            assert_eq!(mixed[5], "EDITED");
            assert_eq!(mixed[0], read_line_from_disk(e, 10).unwrap());
            assert_eq!(mixed[19], read_line_from_disk(e, 29).unwrap());
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hydrate_finalize_keeps_sparse_edits() {
        // Regression: a partial seed entry with edits written during indexing must
        // retain those edits when the background scan finalizes.
        let store = LargeFileStore::default();
        let path = PathBuf::from("C:/vault/partial.md");
        let key = path_key(&path);
        {
            let mut g = store.0.lock().unwrap();
            g.insert(
                key.clone(),
                LargeFileEntry {
                    path: path.clone(),
                    mmap: None,
                    file_line_starts: vec![0, 2],
                    encoding: "utf-8".into(),
                    mtime_ms: 1,
                    size_bytes: 8,
                    bytes_indexed: 4,
                    partial: true,
                    ends_with_newline: false,
                    edits: HashMap::from([(0usize, "edited line".to_string())]),
                },
            );
        }

        finalize_hydrate_entry(
            &store,
            &key,
            &path,
            vec![0, 2, 4],
            "utf-8".into(),
            2,
            8,
            true,
        )
        .unwrap();

        let g = store.0.lock().unwrap();
        let entry = g.get(&key).unwrap();
        assert!(!entry.partial);
        assert_eq!(entry.bytes_indexed, 8);
        assert_eq!(entry.file_line_starts, vec![0, 2, 4]);
        assert_eq!(entry.edits.len(), 1, "sparse edits were dropped");
        assert_eq!(entry.edits.get(&0).map(String::as_str), Some("edited line"));
    }

    #[test]
    fn hydrate_finalize_inserts_when_absent() {
        let store = LargeFileStore::default();
        let path = PathBuf::from("C:/vault/new.md");
        let key = path_key(&path);
        finalize_hydrate_entry(
            &store,
            &key,
            &path,
            vec![0, 3],
            "utf-8".into(),
            5,
            9,
            false,
        )
        .unwrap();
        let g = store.0.lock().unwrap();
        let entry = g.get(&key).unwrap();
        assert_eq!(entry.file_line_starts, vec![0, 3]);
        assert_eq!(entry.bytes_indexed, 9);
        assert!(!entry.partial);
        assert!(entry.edits.is_empty());
    }
}
