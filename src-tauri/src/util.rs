//! Shared helpers extracted from duplicated per-module copies.
//!
//! Keeping these in one place makes the cross-platform path/case semantics and
//! the atomic-write contract identical everywhere they are used.

use std::fs;
use std::path::Path;
use std::time::SystemTime;

/// Normalize a path to a stable lookup key.
///
/// Separators are always normalised to `/`. Case is folded **only on Windows**:
/// there the filesystem is case-insensitive so `Note.md` and `note.md` are the
/// same file, but on macOS/Linux they are distinct, and folding case would
/// collide unrelated notes (wrong file served, wrong graph edge, merged history).
pub(crate) fn path_key(path: &Path) -> String {
    let normalised = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        normalised.to_lowercase()
    } else {
        normalised
    }
}

/// Disk mtime as Unix epoch milliseconds (0 when unavailable).
pub(crate) fn meta_mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Percent-decode `input`; `None` on malformed escapes or invalid UTF-8.
pub(crate) fn percent_decode_str(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
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
    String::from_utf8(out).ok()
}

/// Atomic UTF-8 write: temp file in the same directory, then rename over target.
///
/// `fallback_stem` is only used when the target has no usable file name. The two
/// copies this replaces differed there (`"note.md"` vs `"file"`), so the
/// difference is kept explicit as a parameter instead of silently picking one.
pub(crate) fn write_utf8_atomic(
    path: &Path,
    content: &str,
    fallback_stem: &str,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {e}"))?;
        }
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(fallback_stem);
    let tmp = parent.join(format!(".{stem}.{}.tmp", crate::unique_tmp_tag()));
    let bytes = crate::encoding_util::encode_utf8(content);
    fs::write(&tmp, &bytes).map_err(|e| format!("无法写入临时文件: {e}"))?;
    crate::commit_atomic(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_key_folds_case_only_on_windows() {
        let mixed = path_key(Path::new(r"C:\Vault\Notes\Hello.MD"));
        let lower = path_key(Path::new("C:/vault/notes/hello.md"));
        assert!(
            !mixed.contains('\\') && mixed.contains('/'),
            "separators are normalised on every platform: {mixed}"
        );
        if cfg!(windows) {
            assert_eq!(mixed, lower, "Windows folds case");
        } else {
            assert_ne!(mixed, lower, "POSIX keeps case");
        }
    }

    #[test]
    fn percent_decode_roundtrip_and_rejects_malformed() {
        assert_eq!(percent_decode_str("a%20b").as_deref(), Some("a b"));
        assert_eq!(percent_decode_str("plain").as_deref(), Some("plain"));
        assert_eq!(percent_decode_str("bad%zz"), None);
    }
}
