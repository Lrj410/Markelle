use encoding_rs::{Encoding, GBK};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Heuristic: does `bytes` contain enough GBK/CJK double-byte sequences to
/// justify overriding a chardetng `windows-1252` / `iso-8859-*` guess?
/// Requires at least two GBK lead/trail pairs covering a meaningful share of the
/// bytes, so western (windows-1252) text with a few accented chars is left alone.
fn looks_like_gbk(bytes: &[u8]) -> bool {
    let mut pairs = 0usize;
    let mut i = 0usize;
    while i + 1 < bytes.len() {
        let lead = bytes[i];
        let trail = bytes[i + 1];
        if (0x81..=0xFE).contains(&lead) && (0x40..=0xFE).contains(&trail) && trail != 0x7F {
            pairs += 1;
            i += 2;
        } else {
            i += 1;
        }
    }
    let pair_bytes = pairs * 2;
    pair_bytes >= 4 && pair_bytes * 8 >= bytes.len()
}

/// Strip a UTF-8 BOM if present.
fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    }
}

/// Decode file bytes with UTF-8 preference and chardetng fallback (GBK common on CN Windows).
pub fn decode_bytes(bytes: &[u8]) -> (String, String) {
    if bytes.is_empty() {
        return (String::new(), "utf-8".into());
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => {
            let text = String::from_utf8_lossy(strip_utf8_bom(bytes)).into_owned();
            return (text, "utf-8".into());
        }
        // `error_len() == None` means the input ended mid-sequence. A read cut at
        // a byte budget produces exactly this, and it is still a UTF-8 file — do
        // not let a half character at the tail trigger a legacy re-guess.
        Err(err) if err.error_len().is_none() => {
            let head = strip_utf8_bom(&bytes[..err.valid_up_to()]);
            return (String::from_utf8_lossy(head).into_owned(), "utf-8".into());
        }
        Err(_) => { /* genuinely not UTF-8 — fall through to detection */ }
    }

    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let mut enc: &'static Encoding = detector.guess(None, true);

    // chardetng sometimes picks windows-1252 for GBK Chinese text. Only override
    // when the bytes actually look like GBK, otherwise western text is mangled.
    if (enc == encoding_rs::WINDOWS_1252 || enc == encoding_rs::ISO_8859_2)
        && looks_like_gbk(bytes)
    {
        enc = GBK;
    }

    let (cow, _enc_used, had_errors) = enc.decode(bytes);
    if had_errors && enc != GBK {
        let (cow2, _, _) = GBK.decode(bytes);
        return (cow2.into_owned(), "gbk".into());
    }
    (cow.into_owned(), enc.name().to_ascii_lowercase())
}

fn encoding_from_hint(hint: &str) -> Option<&'static Encoding> {
    let h = hint.to_ascii_lowercase();
    match h.as_str() {
        "utf-8" | "utf8" => Some(encoding_rs::UTF_8),
        "gbk" | "gb2312" | "gb18030" => Some(GBK),
        other => Encoding::for_label(other.as_bytes()),
    }
}

pub(crate) fn decode_with_hint(bytes: &[u8], hint: Option<&str>, strip_bom: bool) -> (String, String) {
    if bytes.is_empty() {
        return (
            String::new(),
            hint.unwrap_or("utf-8").to_ascii_lowercase(),
        );
    }
    if let Some(name) = hint {
        if let Some(enc) = encoding_from_hint(name) {
            let slice = if strip_bom && enc == encoding_rs::UTF_8 && bytes.starts_with(&[0xEF, 0xBB, 0xBF])
            {
                &bytes[3..]
            } else {
                bytes
            };
            let (cow, _, _) = enc.decode(slice);
            return (cow.into_owned(), enc.name().to_ascii_lowercase());
        }
    }
    decode_bytes(bytes)
}

/// Trim truncated reads so we don't cut mid-character for UTF-8 or GBK/GB18030.
///
/// Deciding "which encoding is this" from a *trimmed* slice is a trap: trimming
/// to a UTF-8 boundary always yields a valid UTF-8 prefix, so a naive
/// `from_utf8(trimmed).is_ok()` check would route every GBK buffer into the
/// UTF-8 branch. Classify from the original bytes instead.
fn trim_to_encoding_boundary(bytes: &[u8]) -> &[u8] {
    if bytes.is_empty() {
        return bytes;
    }
    match std::str::from_utf8(bytes) {
        // Already aligned.
        Ok(_) => bytes,
        // Valid UTF-8 except for a sequence cut off by the read budget.
        Err(err) if err.error_len().is_none() => &bytes[..err.valid_up_to()],
        // Genuinely not UTF-8 (GBK/GB18030 and friends).
        Err(_) => {
            // Lead byte 0x81–0xFE; if the tail is an odd run of high bytes it is
            // a lone lead, so drop it.
            let mut end = bytes.len();
            let last = bytes[end - 1];
            if (0x81..=0xFE).contains(&last) {
                let mut i = end;
                while i > 0 && bytes[i - 1] >= 0x81 {
                    i -= 1;
                }
                if (end - i) % 2 == 1 {
                    end -= 1;
                }
            }
            if end == 0 {
                bytes
            } else {
                &bytes[..end]
            }
        }
    }
}

pub fn read_decoded(path: &Path) -> Result<(String, String), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("无法读取文件: {e}"))?;
    Ok(decode_bytes(&bytes))
}

/// Read up to `max_bytes` starting at `byte_offset`.
/// Returns `(text, encoding, next_offset, eof)`.
pub fn read_decoded_range(
    path: &Path,
    byte_offset: u64,
    max_bytes: usize,
    encoding_hint: Option<&str>,
) -> Result<(String, String, u64, bool), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取文件信息: {e}"))?;
    let file_len = meta.len();
    if byte_offset >= file_len {
        let enc = encoding_hint.unwrap_or("utf-8").to_ascii_lowercase();
        return Ok((String::new(), enc, file_len, true));
    }

    let remaining = (file_len - byte_offset) as usize;
    let to_read = max_bytes.min(remaining);
    let mut file = File::open(path).map_err(|e| format!("无法读取文件: {e}"))?;
    file.seek(SeekFrom::Start(byte_offset))
        .map_err(|e| format!("无法定位文件: {e}"))?;

    let mut buf = vec![0u8; to_read];
    let mut read_total = 0usize;
    while read_total < to_read {
        match file.read(&mut buf[read_total..]) {
            Ok(0) => break,
            Ok(n) => read_total += n,
            Err(e) => return Err(format!("无法读取文件: {e}")),
        }
    }
    buf.truncate(read_total);

    let partial = byte_offset + (read_total as u64) < file_len;
    let slice = if partial {
        trim_to_encoding_boundary(&buf)
    } else {
        &buf[..]
    };
    let consumed = slice.len() as u64;
    // Avoid stalling if a pathological trim would consume nothing.
    let advance = if consumed == 0 && read_total > 0 {
        1u64
    } else {
        consumed
    };
    let next_offset = byte_offset + advance;
    let (text, enc) = if consumed == 0 {
        (
            String::new(),
            encoding_hint.unwrap_or("utf-8").to_ascii_lowercase(),
        )
    } else {
        decode_with_hint(slice, encoding_hint, byte_offset == 0)
    };
    let eof = next_offset >= file_len;
    Ok((text, enc, next_offset, eof))
}

/// One disk read for large-file open: index up to `index_max` bytes, decode only
/// `paint_max` for the WebView payload (avoids shipping 1MB strings over IPC).
/// Returns `(paint_text, encoding, raw_bytes_for_index, indexed_end, eof)`.
pub fn read_large_open(
    path: &Path,
    index_max: usize,
    paint_max: usize,
) -> Result<(String, String, Vec<u8>, u64, bool), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取文件信息: {e}"))?;
    let file_len = meta.len();
    if file_len == 0 {
        return Ok((String::new(), "utf-8".into(), Vec::new(), 0, true));
    }

    let to_read = index_max.min(file_len as usize).max(1);
    let mut file = File::open(path).map_err(|e| format!("无法读取文件: {e}"))?;
    let mut buf = vec![0u8; to_read];
    let mut read_total = 0usize;
    while read_total < to_read {
        match file.read(&mut buf[read_total..]) {
            Ok(0) => break,
            Ok(n) => read_total += n,
            Err(e) => return Err(format!("无法读取文件: {e}")),
        }
    }
    buf.truncate(read_total);
    let indexed_end = read_total as u64;
    let eof = indexed_end >= file_len;

    let mut paint_cap = paint_max.min(buf.len());
    // Prefer a newline boundary so the paint payload never ends mid-glyph.
    if paint_cap < buf.len() {
        if let Some(nl) = buf[..paint_cap].iter().rposition(|&b| b == b'\n') {
            // Keep at least half the budget when the last newline is very early.
            if nl + 1 >= paint_cap / 2 {
                paint_cap = nl + 1;
            }
        }
    }
    let paint_slice = if paint_cap < buf.len() {
        trim_to_encoding_boundary(&buf[..paint_cap])
    } else {
        &buf[..]
    };
    // Detect encoding from the index buffer (more signal than the paint slice),
    // but only after aligning it to a character boundary. `buf` is cut at a fixed
    // byte budget, so it usually ends mid-glyph; feeding that half-character to
    // the detector makes a perfectly valid UTF-8 file fail `from_utf8` and get
    // mis-guessed as GBK/legacy, which renders the whole document as mojibake.
    // Paint text then reuses that label so window reads stay consistent.
    let probe = trim_to_encoding_boundary(&buf);
    let (_probe, enc) = if probe.is_empty() {
        (String::new(), "utf-8".into())
    } else {
        decode_bytes(probe)
    };
    let (text, _) = if paint_slice.is_empty() {
        (String::new(), enc.clone())
    } else {
        decode_with_hint(paint_slice, Some(&enc), true)
    };
    Ok((text, enc, buf, indexed_end, eof))
}

/// Encode text back to bytes for saving. Prefer UTF-8 always for writes (stable).
pub fn encode_utf8(content: &str) -> Vec<u8> {
    content.as_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn trim_keeps_ascii() {
        assert_eq!(trim_to_encoding_boundary(b"hello"), b"hello");
    }

    #[test]
    fn gbk_heuristic_gates_chardetng_override() {
        // Real GBK CJK pairs ("中文" = D6 D0 CE C4) → override allowed.
        assert!(looks_like_gbk(&[0xD6, 0xD0, 0xCE, 0xC4]));
        // Windows-1252 "café" (63 61 66 E9) — a lone trailing high byte must not
        // be mistaken for CJK double-byte text.
        assert!(!looks_like_gbk(&[0x63, 0x61, 0x66, 0xE9]));
        assert!(!looks_like_gbk(b"plain ascii text"));
    }

    #[test]
    fn trim_drops_lone_gbk_lead() {
        // "中" in GBK is 0xD6 0xD0 — lone 0xD6 at end should be dropped.
        let bytes = [b'a', 0xD6];
        assert_eq!(trim_to_encoding_boundary(&bytes), b"a");
    }

    #[test]
    fn utf8_roundtrip_label() {
        let (t, enc) = decode_bytes("你好".as_bytes());
        assert_eq!(t, "你好");
        assert_eq!(enc, "utf-8");
    }

    #[test]
    fn range_reads_concatenate() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("markelle-range-{stamp}.md"));
        let body = "abcdefghijklmnopqrstuvwxyz0123456789";
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(body.as_bytes()).unwrap();
        }
        let (a, enc, next, eof) = read_decoded_range(&path, 0, 10, None).unwrap();
        assert_eq!(a, "abcdefghij");
        assert_eq!(enc, "utf-8");
        assert!(!eof);
        let (b, _, next2, eof2) = read_decoded_range(&path, next, 10, Some(&enc)).unwrap();
        assert_eq!(b, "klmnopqrst");
        assert!(!eof2);
        let (c, _, _, eof3) = read_decoded_range(&path, next2, 100, Some(&enc)).unwrap();
        assert_eq!(format!("{a}{b}{c}"), body);
        assert!(eof3);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn large_open_paints_less_than_indexed() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("markelle-large-open-{stamp}.md"));
        let body = "line\n".repeat(50_000); // ~250KB
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(body.as_bytes()).unwrap();
        }
        let (text, enc, raw, indexed, eof) =
            read_large_open(&path, 1024 * 1024, 128 * 1024).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(enc, "utf-8");
        assert!(eof);
        assert!(text.len() <= 128 * 1024 + 8);
        assert_eq!(raw.len() as u64, indexed);
        assert!(indexed as usize >= text.len());
    }

    #[test]
    fn trim_drops_incomplete_utf8_lead() {
        // "中" is E4 B8 AD. A read cut after 1 or 2 bytes leaves a lead that is
        // still invalid UTF-8, so the trim must drop the whole partial sequence.
        assert_eq!(trim_to_encoding_boundary(b"ab\xE4"), b"ab");
        assert_eq!(trim_to_encoding_boundary(b"ab\xE4\xB8"), b"ab");
        // A complete char is kept.
        assert_eq!(
            trim_to_encoding_boundary(b"ab\xE4\xB8\xAD"),
            b"ab\xE4\xB8\xAD"
        );
        // 4-byte sequence cut short (emoji) also drops cleanly.
        assert_eq!(trim_to_encoding_boundary(b"ab\xF0\x9F\x98"), b"ab");
    }

    /// The index buffer for large files is cut at a fixed byte budget, which
    /// lands mid-glyph on any Chinese UTF-8 file. Encoding detection must not
    /// see that half-character, or a valid UTF-8 file gets decoded as GBK.
    #[test]
    fn large_open_keeps_utf8_when_index_cuts_mid_char() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("markelle-large-cut-{stamp}.md"));
        // Every "中" is 3 bytes; index_max = 3k+1 always splits one.
        let body = "中".repeat(400_000);
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(body.as_bytes()).unwrap();
        }
        let index_max = 300_001; // 3 * 100_000 + 1 → mid-char cut
        let (text, enc, _raw, indexed, _eof) =
            read_large_open(&path, index_max, 64 * 1024).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(indexed, index_max as u64);
        assert_eq!(enc, "utf-8", "cut buffer must still be detected as UTF-8");
        assert!(text.starts_with("中中中"));
        assert!(!text.contains('涓'), "buffer decoded as GBK: {text:.32}");
    }

    /// The mirror case: a GBK note must still be detected as GBK. A UTF-8-only
    /// boundary trim must not short-circuit the legacy-encoding branch.
    #[test]
    fn large_open_detects_gbk_not_utf8() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("markelle-large-gbk-{stamp}.md"));
        let mut body = String::from("---\nstatus: fixture\n---\n\n");
        // 15 bytes per line → 5k lines is comfortably past the index window.
        body.push_str(&"中文内容测试行\n".repeat(5_000));
        let (gbk_bytes, _, _) = GBK.encode(&body);
        let index_max = 40_001; // ends mid-pair
        assert!(gbk_bytes.len() > index_max);
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(&gbk_bytes).unwrap();
        }
        let (text, enc, _raw, _indexed, _eof) =
            read_large_open(&path, index_max, 64 * 1024).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(enc, "gbk", "GBK note misdetected as {enc}");
        assert!(text.contains("中文内容测试行"), "GBK text not decoded");
    }

    #[test]
    fn decode_bytes_tolerates_truncated_utf8_tail() {
        // "中文" = E4 B8 AD E6 96 87, cut after 2 bytes of the second char.
        let bytes = [0xE4, 0xB8, 0xAD, 0xE6, 0x96];
        let (text, enc) = decode_bytes(&bytes);
        assert_eq!(enc, "utf-8");
        assert_eq!(text, "中");
    }

    /// Same failure, but driven by the production budgets: a large UTF-8 note
    /// whose 2MB index window provably cuts a 3-byte glyph must still open as
    /// UTF-8, with the frontmatter intact and no replacement characters.
    #[test]
    fn large_open_at_production_budgets_stays_utf8() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("markelle-large-prod-{stamp}.md"));
        let index_max = crate::FIRST_CHUNK_BYTES as usize;
        let paint_max = crate::FIRST_PAINT_BYTES as usize;
        // CJK early (so it lands in the 256KB paint window), then ASCII padding,
        // then a 3-byte char placed so its first byte is the last byte of the
        // index window: the index read ends mid-glyph, deterministically.
        let mut body = String::from("---\nstatus: fixture\ngraph_tier: ladder-20\n---\n\n");
        body.push_str(&"中文内容测试行\n".repeat(4_000));
        body.push_str(&"a".repeat(index_max - 1 - body.len()));
        body.push('中');
        assert!(body.len() > index_max);
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(body.as_bytes()).unwrap();
        }
        let (text, enc, raw, indexed, eof) =
            read_large_open(&path, index_max, paint_max).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(indexed, index_max as u64);
        assert!(raw.len() == index_max);
        assert!(!eof, "file is longer than the index window");
        assert_eq!(enc, "utf-8");
        assert!(text.contains("status: fixture"));
        assert!(text.contains('中'), "paint text lost its CJK payload");
        assert!(!text.contains('\u{FFFD}'), "paint text has broken glyphs");
    }

    #[test]
    fn large_open_detects_utf8_from_index_not_paint() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("markelle-large-enc-{stamp}.md"));
        // ASCII frontmatter + UTF-8 Chinese body — paint may truncate mid-file.
        let mut body = String::from("---\nstatus: ok\n---\n\n");
        for i in 0..8_000 {
            body.push_str(&format!("# 超大文件压测行-{i}\n正文内容一二三四五六七八九十\n"));
        }
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(body.as_bytes()).unwrap();
        }
        let (text, enc, _raw, _indexed, _eof) =
            read_large_open(&path, 1024 * 1024, 8 * 1024).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(enc, "utf-8");
        assert!(text.contains("超大") || text.contains("status: ok"));
        assert!(!text.contains("瓒嗙ぇ"));
    }
}
