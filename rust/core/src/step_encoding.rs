//! STEP string escape decoding/encoding (ISO 10303-21 / IFC).
//!
//! IFC string attribute values encode non-ASCII characters with backslash
//! escape sequences. This module decodes them to native UTF-8 so the Rust
//! crates, CLI, and server surface the same text the browser parser does via
//! `decodeIfcString` in `@ifc-lite/encoding`. The two decoders are pinned to a
//! shared test-vector fixture (`tests/fixtures/ifc_string_vectors.json`).
//!
//! Supported escapes:
//! - `\X2\HHHH..\X0\` UTF-16 code units, 4 hex digits each (surrogate pairs ok)
//! - `\X4\HHHHHHHH..\X0\` Unicode scalar values, 8 hex digits each
//! - `\X\HH` single ISO-8859-1 byte
//! - `\S\C` extended ASCII: code point of `C` plus 128
//! - `\PC\` code-page directive, consumed and dropped
//!
//! Unknown or malformed escapes are passed through unchanged. The `''`
//! doubled-quote escape is NOT handled here — the tokenizer's consumers strip
//! the surrounding quotes and un-double before calling this.

use std::borrow::Cow;

/// Decode IFC STEP string escapes to UTF-8.
///
/// Returns the input borrowed and untouched when it contains no backslash, so
/// the common case (plain names, GUIDs, enums) is allocation-free.
///
/// This handles only backslash escapes. The `''` doubled-quote escape is
/// collapsed by the STEP tokenizer's consumers (they strip the surrounding
/// quotes and un-double), so decoding must not touch quotes or it would
/// double-collapse those paths.
pub fn decode_ifc_string(s: &str) -> Cow<'_, str> {
    if !s.as_bytes().contains(&b'\\') {
        return Cow::Borrowed(s);
    }

    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;

    while i < n {
        if bytes[i] != b'\\' {
            // Copy one whole UTF-8 character; `i` is always on a char boundary
            // because every escape marker is ASCII.
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }

        // `\PC\` code-page directive: consume four bytes and drop.
        if i + 3 < n && bytes[i + 1] == b'P' && bytes[i + 3] == b'\\' {
            i += 4;
            continue;
        }

        // `\S\C`: byte value is the code point of `C` plus 128. Read `C` as a
        // whole char and advance by its UTF-8 length so a malformed multi-byte
        // `C` can't leave `i` mid-character (which would panic the next slice).
        if i + 3 < n && bytes[i + 1] == b'S' && bytes[i + 2] == b'\\' {
            let c = s[i + 3..].chars().next().unwrap();
            let code = c as u32 + 128;
            out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
            i += 3 + c.len_utf8();
            continue;
        }

        // `\X\HH`: a single ISO-8859-1 byte.
        if i + 4 < n && bytes[i + 1] == b'X' && bytes[i + 2] == b'\\' {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 3]), hex_val(bytes[i + 4])) {
                let code = ((hi << 4) | lo) as u32;
                out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                i += 5;
                continue;
            }
        }

        // `\X2\HHHH..\X0\`: UTF-16 code units (decoded as a unit, so surrogate
        // pairs spanning two groups combine correctly).
        if starts_with(bytes, i, b"\\X2\\") {
            if let Some(end) = find(bytes, i + 4, b"\\X0\\") {
                let hex = &s[i + 4..end];
                if !hex.is_empty()
                    && hex.len().is_multiple_of(4)
                    && hex.bytes().all(|c| c.is_ascii_hexdigit())
                {
                    let units: Vec<u16> = (0..hex.len())
                        .step_by(4)
                        .map(|j| u16::from_str_radix(&hex[j..j + 4], 16).unwrap())
                        .collect();
                    out.push_str(&String::from_utf16_lossy(&units));
                    i = end + 4;
                    continue;
                }
            }
        }

        // `\X4\HHHHHHHH..\X0\`: Unicode scalar values.
        if starts_with(bytes, i, b"\\X4\\") {
            if let Some(end) = find(bytes, i + 4, b"\\X0\\") {
                let hex = &s[i + 4..end];
                if !hex.is_empty()
                    && hex.len().is_multiple_of(8)
                    && hex.bytes().all(|c| c.is_ascii_hexdigit())
                {
                    for j in (0..hex.len()).step_by(8) {
                        let v = u32::from_str_radix(&hex[j..j + 8], 16).unwrap();
                        out.push(char::from_u32(v).unwrap_or('\u{FFFD}'));
                    }
                    i = end + 4;
                    continue;
                }
            }
        }

        // Unknown escape: keep the backslash and advance one byte.
        out.push('\\');
        i += 1;
    }

    Cow::Owned(out)
}

/// Encode a UTF-8 string back to IFC STEP escapes. Inverse of
/// [`decode_ifc_string`] for the canonical (non-overlong) forms; kept for STEP
/// writers and round-trip tests.
///
/// Printable ASCII is preserved; everything else (and backslash) is escaped as
/// `\X\HH`, `\X2\HHHH\X0\`, or `\X4\HHHHHHHH\X0\` by code point.
pub fn encode_ifc_string(s: &str) -> Cow<'_, str> {
    if s.bytes().all(|b| (0x20..=0x7E).contains(&b) && b != b'\\') {
        return Cow::Borrowed(s);
    }

    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        let cp = ch as u32;
        if (0x20..=0x7E).contains(&cp) && ch != '\\' {
            out.push(ch);
        } else if cp <= 0xFF {
            out.push_str(&format!("\\X\\{cp:02X}"));
        } else if cp <= 0xFFFF {
            out.push_str(&format!("\\X2\\{cp:04X}\\X0\\"));
        } else {
            out.push_str(&format!("\\X4\\{cp:08X}\\X0\\"));
        }
    }
    Cow::Owned(out)
}

#[inline]
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[inline]
fn starts_with(bytes: &[u8], at: usize, pat: &[u8]) -> bool {
    bytes.len() >= at + pat.len() && &bytes[at..at + pat.len()] == pat
}

fn find(bytes: &[u8], from: usize, pat: &[u8]) -> Option<usize> {
    if pat.is_empty() || from + pat.len() > bytes.len() {
        return None;
    }
    bytes[from..]
        .windows(pat.len())
        .position(|w| w == pat)
        .map(|p| from + p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_backslash_is_borrowed_and_unchanged() {
        assert!(matches!(decode_ifc_string("Hello World"), Cow::Borrowed(_)));
        // A typical base64 IFC GUID contains no backslash.
        assert_eq!(decode_ifc_string("3Bvg7$qHb0gP37$Qz2vN1k"), "3Bvg7$qHb0gP37$Qz2vN1k");
    }

    #[test]
    fn decodes_x2_bmp() {
        assert_eq!(decode_ifc_string(r"Br\X2\00FC\X0\cke"), "Br\u{FC}cke");
    }

    #[test]
    fn decodes_x2_surrogate_pair() {
        assert_eq!(decode_ifc_string(r"\X2\D83DDE00\X0\"), "\u{1F600}");
    }

    #[test]
    fn decodes_x4_astral() {
        assert_eq!(decode_ifc_string(r"\X4\0001F600\X0\"), "\u{1F600}");
    }

    #[test]
    fn decodes_x_and_s() {
        assert_eq!(decode_ifc_string(r"\X\E9"), "\u{E9}");
        assert_eq!(decode_ifc_string(r"\S\a"), "\u{E1}");
    }

    #[test]
    fn drops_code_page_directive() {
        assert_eq!(decode_ifc_string(r"\PA\Hello"), "Hello");
    }

    #[test]
    fn keeps_unknown_escape() {
        assert_eq!(decode_ifc_string(r"a\Qb"), r"a\Qb");
        // Malformed (no terminator) is passed through, not panicked on.
        assert_eq!(decode_ifc_string(r"\X2\00FC"), r"\X2\00FC");
    }

    #[test]
    fn s_escape_before_multibyte_char_does_not_panic() {
        // A malformed `\S\` followed by a multi-byte UTF-8 char must not leave
        // the cursor mid-character (previously panicked via a non-boundary
        // slice, aborting the whole wasm instance under panic=abort).
        let _ = decode_ifc_string("\\S\\\u{00E9}tail");
        let _ = decode_ifc_string("x\\S\\\u{1F600}y");
        // The canonical single-ASCII form is unchanged.
        assert_eq!(decode_ifc_string(r"\S\a"), "\u{E1}");
    }

    #[test]
    fn round_trips_through_encode() {
        for s in ["plain", "Br\u{FC}cke", "\u{1F600}", "a\u{E9}b"] {
            assert_eq!(decode_ifc_string(&encode_ifc_string(s)), s);
        }
    }
}
