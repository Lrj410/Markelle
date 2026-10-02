mod access;
mod encoding_util;
mod history;
mod instance;
mod large_file;
mod plugins;
mod tray;
mod vault_index;
mod vault_ops;
mod vault_watch;

use access::{ensure_allowed, is_symlink, register_access, revoke_vault_access, AppState};
use encoding_util::{encode_utf8, read_decoded};
use history::{history_clear_note, history_list, history_read, history_save_snapshot};
use plugins::{get_user_plugins_dir, list_plugins, read_plugin_file};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime};
use tauri::{Manager, State};
use vault_index::{
    build_vault_graph, find_backlinks, list_vault_tags, open_vault, query_vault, search_vault,
    IndexCache, MAX_SEARCH_FILE_BYTES,
};
use tray::{quit_app, set_tray_visible, setup_tray};
use vault_ops::{
    import_adjacent_file, list_vault_templates, read_allowed_bytes, resolve_vault_media,
    vault_create_dir, vault_delete, vault_import_file, vault_rename, vault_write_bytes_raw,
    write_adjacent_bytes_raw,
};

const MAX_ASSET_BYTES: u64 = 128 * 1024 * 1024;
/// Files above this size use the native memmap virtual stream document path.
pub(crate) const LARGE_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// Bytes indexed on first open (line starts); not all sent to the WebView.
pub(crate) const FIRST_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
/// Decoded text returned to the UI on large-file open (keeps IPC + JS GC tiny).
pub(crate) const FIRST_PAINT_BYTES: u64 = 256 * 1024;
/// Background hydrate chunk size (frontend also requests this).
pub(crate) const HYDRATE_CHUNK_BYTES: u64 = 16 * 1024 * 1024;
/// Absolute ceiling for native memmap virtual documents (10 GB supported).
pub(crate) const ABSOLUTE_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024 * 1024;
/// Hard ceiling for a single markdown write via IPC (DoS / OOM guard).
const MAX_MARKDOWN_WRITE_BYTES: usize = 500 * 1024 * 1024;

/// How long the window may stay hidden waiting for the frontend's first paint.
/// Past this we show it anyway — a process with no visible window looks dead.
const REVEAL_FAILSAFE_MS: u64 = 5000;

static BOOT_T0: OnceLock<Instant> = OnceLock::new();

/// Cold-start tracing, off by default. Set `MARKELLE_BOOT_TRACE=1` and read
/// `%TEMP%\markelle-boot.log` to attribute startup time to a specific phase.
/// Kept in release builds on purpose: this is the only way to tell whether a
/// future regression sits before or after the WebView2 hand-off.
pub(crate) fn boot_trace(msg: &str) {
    let Some(path) =
        std::env::var_os("MARKELLE_BOOT_TRACE").map(|_| std::env::temp_dir().join("markelle-boot.log"))
    else {
        return;
    };
    let elapsed = BOOT_T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0;
    let pid = std::process::id();
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(file, "[pid {pid}] {elapsed:8.1}ms  {msg}");
    }
}

fn boot_trace_enabled() -> bool {
    std::env::var_os("MARKELLE_BOOT_TRACE").is_some()
}

/// Monotonic counter making on-disk temp names unique within a process, so two
/// concurrent writers to the same target can never clobber each other's temp file.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Unique `pid.nanos.seq` tag for atomic-write temp file names.
pub(crate) fn unique_tmp_tag() -> String {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}.{}.{}", std::process::id(), nanos, seq)
}

fn describe_page_load(event: tauri::webview::PageLoadEvent) -> &'static str {
    match event {
        tauri::webview::PageLoadEvent::Started => "started",
        tauri::webview::PageLoadEvent::Finished => "finished",
    }
}

fn window_is_visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// Reveal is idempotent and safe to call from any thread.
fn reveal_main_window(app: &tauri::AppHandle) {
    if window_is_visible(app) {
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn percent_decode_to_path(encoded: &str) -> Option<PathBuf> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let s = String::from_utf8(out).ok()?;
    if s.is_empty() {
        return None;
    }
    Some(PathBuf::from(s))
}

fn guess_asset_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        // SVG intentionally omitted — treat as denied (scriptable surface).
        _ => "application/octet-stream",
    }
}

fn deny_asset() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(403)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(b"forbidden".to_vec())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

fn parse_range(range_header: &str, total_len: u64) -> Option<(u64, u64)> {
    if total_len == 0 {
        return None;
    }
    let range = range_header.trim().strip_prefix("bytes=")?;
    let first = range.split(',').next()?.trim();
    let (start_str, end_str) = first.split_once('-')?;
    if start_str.is_empty() {
        let len = end_str.parse::<u64>().ok()?;
        let start = total_len.saturating_sub(len);
        Some((start, total_len - 1))
    } else {
        let start = start_str.parse::<u64>().ok()?;
        if start >= total_len {
            return None;
        }
        let end = if end_str.is_empty() {
            total_len - 1
        } else {
            let parsed_end = end_str.parse::<u64>().ok()?;
            parsed_end.min(total_len - 1)
        };
        if start <= end {
            Some((start, end))
        } else {
            None
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub content: String,
    pub size: u64,
    /// True while the file is not fully loaded into memory yet.
    pub truncated: bool,
    pub encoding: String,
    /// Disk mtime as Unix epoch milliseconds (0 if unavailable).
    pub mtime_ms: u64,
    /// Byte offset consumed from disk for `content` (for hydrate resume).
    pub bytes_read: u64,
    /// True when size exceeds [`LARGE_FILE_BYTES`].
    pub large: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub is_large: bool,
    pub mtime_ms: u64,
}

pub(crate) fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("未命名.md")
        .to_string()
}

fn meta_mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_size_hard_cap() -> u64 {
    ABSOLUTE_MAX_FILE_BYTES
}

pub(crate) fn ensure_file_under_hard_cap(size: u64) -> Result<(), String> {
    let cap = file_size_hard_cap();
    if size > cap {
        return Err(format!(
            "文件体积（{} MB）超出单文档全量载入硬上限（{} MB）。",
            size / (1024 * 1024),
            cap / (1024 * 1024)
        ));
    }
    Ok(())
}

fn read_path(path: &Path, _force_full: bool) -> Result<OpenedFile, String> {
    if is_symlink(path) {
        return Err("拒绝通过符号链接读取文件".into());
    }
    let meta = fs::metadata(path).map_err(|e| format!("无法读取文件信息: {e}"))?;
    if !meta.is_file() {
        return Err("路径不是文件".into());
    }

    let size = meta.len();
    let mtime_ms = meta_mtime_ms(&meta);
    ensure_file_under_hard_cap(size)?;
    let large = size > LARGE_FILE_BYTES;

    let (text, enc) = if large {
        let (paint, enc, _, _, _) = encoding_util::read_large_open(
            path,
            FIRST_CHUNK_BYTES as usize,
            FIRST_PAINT_BYTES as usize,
        )?;
        (paint, enc)
    } else {
        read_decoded(path)?
    };

    let bytes_read = text.len() as u64;

    Ok(OpenedFile {
        path: path.to_string_lossy().to_string(),
        name: file_name(path),
        content: text,
        size,
        truncated: large,
        encoding: enc,
        mtime_ms,
        bytes_read,
        large,
    })
}

#[tauri::command]
async fn read_markdown_file(
    state: State<'_, AppState>,
    path: String,
    force_full: Option<bool>,
) -> Result<OpenedFile, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err(format!("文件不存在: {}", path_buf.display()));
    }
    ensure_allowed(&state, &path_buf)?;
    let force = force_full.unwrap_or(true);

    let path_clone = path_buf.clone();
    let opened = tauri::async_runtime::spawn_blocking(move || read_path(&path_clone, force))
        .await
        .map_err(|e| format!("读取任务失败: {e}"))??;

    Ok(opened)
}

/// Atomic UTF-8 write: temp file in the same directory, then rename over target.
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
        .unwrap_or("note.md");
    let tmp = parent.join(format!(".{stem}.{}.tmp", unique_tmp_tag()));
    let bytes = encode_utf8(content);
    fs::write(&tmp, &bytes).map_err(|e| format!("无法写入临时文件: {e}"))?;
    commit_atomic(&tmp, path)
}

/// Commit `tmp` over `path`, replacing it.
///
/// On Windows a replace can be refused while another process (antivirus, a sync
/// client, the file indexer) still holds a handle on the target. Retry those
/// transient locks, then fall back to swapping via a backup — never *delete*
/// `path`: if both the target and the temp disappeared the user's note would be
/// gone for good. On failure `path` is left as it was and `tmp` is kept.
pub(crate) fn commit_atomic(tmp: &Path, path: &Path) -> Result<(), String> {
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..5u32 {
        match fs::rename(tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(40 * u64::from(attempt + 1)));
            }
        }
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let backup = parent.join(format!(".{stem}.{}.bak", unique_tmp_tag()));
    if fs::rename(path, &backup).is_ok() {
        match fs::rename(tmp, path) {
            Ok(()) => {
                let _ = fs::remove_file(&backup);
                return Ok(());
            }
            Err(e) => {
                // Put the original back so nothing is lost.
                let _ = fs::rename(&backup, path);
                last = Some(e);
            }
        }
    }
    Err(format!(
        "无法保存文件: {}（未改动原文件，内容已保留在 {}）",
        last.map(|e| e.to_string()).unwrap_or_else(|| "未知错误".into()),
        tmp.display()
    ))
}

#[tauri::command]
async fn write_markdown_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<FileStat, String> {
    if content.len() > MAX_MARKDOWN_WRITE_BYTES {
        return Err(format!(
            "内容过大，无法保存（上限 {} MB）",
            MAX_MARKDOWN_WRITE_BYTES / (1024 * 1024)
        ));
    }
    let path = PathBuf::from(path);
    ensure_allowed(&state, &path)?;
    if path.exists() && is_symlink(&path) {
        return Err("拒绝写入符号链接".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        write_utf8_atomic(&path, &content)?;
        let meta = fs::metadata(&path).map_err(|e| format!("无法读取文件信息: {e}"))?;
        Ok(FileStat {
            path: path.to_string_lossy().to_string(),
            name: file_name(&path),
            size: meta.len(),
            is_large: meta.len() > LARGE_FILE_BYTES,
            mtime_ms: meta_mtime_ms(&meta),
        })
    })
    .await
    .map_err(|e| format!("保存任务失败: {e}"))?
}

#[tauri::command]
async fn stat_markdown_file(state: State<'_, AppState>, path: String) -> Result<FileStat, String> {
    let path = PathBuf::from(path);
    ensure_allowed(&state, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| format!("无法读取文件信息: {e}"))?;
        Ok(FileStat {
            path: path.to_string_lossy().to_string(),
            name: file_name(&path),
            size: meta.len(),
            is_large: meta.len() > LARGE_FILE_BYTES,
            mtime_ms: meta_mtime_ms(&meta),
        })
    })
    .await
    .map_err(|e| format!("读取文件信息任务失败: {e}"))?
}

#[tauri::command]
async fn read_vault_style(
    state: State<'_, AppState>,
    vault_root: String,
) -> Result<Option<String>, String> {
    let vault = PathBuf::from(&vault_root);
    ensure_allowed(&state, &vault)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = vault.join(".markelle").join("style.css");
        if !path.is_file() {
            return Ok(None);
        }
        if is_symlink(&path) {
            return Err("拒绝读取符号链接库样式".into());
        }
        let meta = fs::metadata(&path).map_err(|e| format!("无法读取: {e}"))?;
        if meta.len() > MAX_SEARCH_FILE_BYTES {
            return Err("库样式文件过大".into());
        }
        Ok(Some(
            fs::read_to_string(&path).map_err(|e| format!("无法读取库样式: {e}"))?,
        ))
    })
    .await
    .map_err(|e| format!("读取库样式任务失败: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    BOOT_T0.get_or_init(Instant::now);
    boot_trace("process: run() entered");

    // Single-instance must register first so secondary launches exit cleanly.
    let mut builder = tauri::Builder::default();
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        instance::on_second_instance(app, args, cwd);
    }));

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(AppState::default())
        .manage(IndexCache::new())
        .manage(large_file::LargeFileStore::default())
        .on_page_load(|webview, payload| {
            // App-level hook, so it also covers the config-declared `main` window
            // (whose builder we never see). This is the only way to tell from the
            // native side whether the frontend actually reached the asset protocol.
            boot_trace(&format!(
                "webload {:<8} [{}] {}",
                describe_page_load(payload.event()),
                webview.label(),
                payload.url()
            ));
        })
        .register_uri_scheme_protocol("mklasset", |ctx, request| {
            let app = ctx.app_handle();
            let state = app.state::<AppState>();
            let uri = request.uri();
            let encoded = uri.path().trim_start_matches('/');
            let Some(path) = percent_decode_to_path(encoded) else {
                return deny_asset();
            };
            if ensure_allowed(&state, &path).is_err() {
                return deny_asset();
            }
            if is_symlink(&path) {
                return deny_asset();
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext == "svg" || ext == "svgz" {
                return deny_asset();
            }
            let meta = match fs::metadata(&path) {
                Ok(m) if m.is_file() => m,
                _ => return deny_asset(),
            };
            let total_len = meta.len();
            let mime = guess_asset_mime(&path);

            let range_header = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok());

            if let Some(range_str) = range_header {
                if let Some((start, end)) = parse_range(range_str, total_len) {
                    let chunk_len = (end - start + 1) as usize;
                    // Cap single-chunk buffer to avoid allocation spikes
                    if chunk_len > 32 * 1024 * 1024 {
                        return deny_asset();
                    }
                    use std::io::{Read, Seek, SeekFrom};
                    let Ok(mut file) = fs::File::open(&path) else {
                        return deny_asset();
                    };
                    if file.seek(SeekFrom::Start(start)).is_err() {
                        return deny_asset();
                    }
                    let mut buf = vec![0u8; chunk_len];
                    if file.read_exact(&mut buf).is_err() {
                        return deny_asset();
                    }
                    return tauri::http::Response::builder()
                        .status(206)
                        .header("Content-Type", mime)
                        .header("Accept-Ranges", "bytes")
                        .header(
                            "Content-Range",
                            format!("bytes {}-{}/{}", start, end, total_len),
                        )
                        .header("Content-Length", chunk_len.to_string())
                        .header("Cache-Control", "no-store")
                        .header("X-Content-Type-Options", "nosniff")
                        .body(buf)
                        .unwrap_or_else(|_| deny_asset());
                }
            }

            if total_len > MAX_ASSET_BYTES {
                return tauri::http::Response::builder()
                    .status(413)
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .body(
                        format!(
                            "asset too large ({} MB > {} MB cap)",
                            total_len / (1024 * 1024),
                            MAX_ASSET_BYTES / (1024 * 1024)
                        )
                        .into_bytes(),
                    )
                    .unwrap_or_else(|_| deny_asset());
            }

            let Ok(bytes) = fs::read(&path) else {
                return deny_asset();
            };
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", total_len.to_string())
                .header("Cache-Control", "no-store")
                // Prevent MIME sniffing so a mislabeled file cannot become scriptable HTML.
                .header("X-Content-Type-Options", "nosniff")
                .body(bytes)
                .unwrap_or_else(|_| deny_asset())
        })
        .invoke_handler(tauri::generate_handler![
            read_markdown_file,
            large_file::hydrate_large_file,
            large_file::large_file_lines,
            large_file::large_file_close,
            write_markdown_file,
            stat_markdown_file,
            open_vault,
            search_vault,
            query_vault,
            list_vault_tags,
            find_backlinks,
            get_user_plugins_dir,
            list_plugins,
            read_plugin_file,
            read_vault_style,
            build_vault_graph,
            register_access,
            revoke_vault_access,
            vault_create_dir,
            vault_rename,
            vault_delete,
            vault_write_bytes_raw,
            write_adjacent_bytes_raw,
            read_allowed_bytes,
            vault_import_file,
            import_adjacent_file,
            list_vault_templates,
            resolve_vault_media,
            history_save_snapshot,
            history_list,
            history_read,
            history_clear_note,
            set_tray_visible,
            quit_app
        ])
        .setup(|app| {
            // Drop any leftover desktop-orb window from older builds.
            if let Some(orb) = app.get_webview_window("desktop-orb") {
                let _ = orb.close();
            }

            /*
              COLD START CONTRACT
              ───────────────────
              Tauri runs `setup` AFTER the config window + its WebView2 controller
              exist (see tauri::app::setup). Anything slow in here sits directly
              between "window object created" and "event loop starts pumping the
              WebView2 message queue" — i.e. it delays the very first paint.

              Two rules follow from that, and both were violated before:

              1. Nothing in `setup` may spawn a process or block on I/O.
                 The old `system_prefers_dark()` shelled out to `reg.exe` to read
                 AppsUseLightTheme; a cold `reg.exe` costs tens to hundreds of ms
                 and, in locked-down environments, is simply blocked. `Window::theme()`
                 reads the same preference without leaving the process.

              2. The window must NOT be shown here. WebView2 needs ~1.3-2s to bring
                 up its browser/GPU processes before it can produce a frame, and the
                 config used to be `visible: true`. Net effect: the user stared at a
                 flat `backgroundColor` rectangle for the whole gap — the reported
                 "cold start black screen".
                 Now the window stays hidden (config `visible: false`) and the
                 frontend reveals it after its first paint via `Window.show()`.
                 `REVEAL_FAILSAFE_MS` below is the escape hatch: if the frontend
                 never boots we still must not leave an invisible process running.
            */
            if let Some(win) = app.get_webview_window("main") {
                // Keep the pre-composite frame on the right side of light/dark so
                // resizes and the reveal itself never flash the wrong colour.
                let dark = matches!(win.theme(), Ok(tauri::Theme::Dark));
                let (r, g, b) = if dark {
                    (0x12, 0x14, 0x16)
                } else {
                    (0xf0, 0xf1, 0xf3)
                };
                let _ = win.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
            }

            /*
              Reveal watchdog.

              Product path: sleep `REVEAL_FAILSAFE_MS` and, if the frontend never
              called `Window.show()`, show the window anyway — a process with no
              visible window looks dead.

              Trace path (`MARKELLE_BOOT_TRACE=1`): poll instead, so the log
              records the actual time-to-visible, which is the number that
              matters and is otherwise invisible from inside the process.
            */
            let watchdog = app.handle().clone();
            let tracing = boot_trace_enabled();
            std::thread::spawn(move || {
                if tracing {
                    const STEP: u64 = 50;
                    let mut waited = 0u64;
                    while waited < REVEAL_FAILSAFE_MS {
                        std::thread::sleep(std::time::Duration::from_millis(STEP));
                        waited += STEP;
                        if window_is_visible(&watchdog) {
                            boot_trace("reveal: window visible (frontend show())");
                            return;
                        }
                    }
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(REVEAL_FAILSAFE_MS));
                }

                let app = watchdog.clone();
                let _ = watchdog.run_on_main_thread(move || {
                    if window_is_visible(&app) {
                        return;
                    }
                    boot_trace("reveal: FAILSAFE fired (frontend never showed)");
                    reveal_main_window(&app);
                });
            });

            /*
              The tray used to be built right here, i.e. on the pre-navigation
              critical path. It is not needed until the user can actually see the
              window, so it is now created lazily:
                - `set_tray_visible(true)` from the frontend creates it on demand
                  (the normal path — see tray::set_tray_visible), and
                - this deferred pass is a backstop for the case where the user
                  turned the tray off, so the menu still exists when they turn it
                  back on.
            */
            let tray_host = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(600));
                let app = tray_host.clone();
                let _ = tray_host.run_on_main_thread(move || {
                    boot_trace("tray: deferred creation");
                    if let Err(err) = setup_tray(&app) {
                        eprintln!("tray setup failed: {err}");
                    }
                });
            });

            /*
              Startup path delivery.

              The frontend installs its `open-file-request` / `open-vault-request`
              listeners in `main.tsx` before React mounts, so a single deferred
              emit is enough — the previous 350/1000/2200ms retry burst only made
              the frontend re-de-duplicate the same path.
            */
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(350));
                instance::emit_startup_path(&handle);
            });

            boot_trace("setup: done (event loop free to pump WebView2)");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Markelle");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_range() {
        assert_eq!(parse_range("bytes=0-499", 1000), Some((0, 499)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-200", 1000), Some((800, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=0-2000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=300-200", 1000), None);
        assert_eq!(parse_range("not-bytes", 1000), None);
        assert_eq!(parse_range("bytes=0-100", 0), None);
    }

    /// Every save path (note, history snapshot, large-file rewrite) routes through
    /// `commit_atomic`, so its replace + cleanup behaviour is a data-safety contract.
    #[test]
    fn commit_atomic_replaces_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!("mkl-commit-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let target = dir.join("note.md");
        let tmp = dir.join(".note.md.1.tmp");
        fs::write(&target, b"old").unwrap();
        fs::write(&tmp, b"new").unwrap();

        commit_atomic(&tmp, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!tmp.exists(), "temp file should be consumed");

        // No leftover backup swap files.
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".bak"))
            .collect();
        assert!(leftovers.is_empty(), "unexpected backups: {leftovers:?}");

        let _ = fs::remove_dir_all(&dir);
    }
}
