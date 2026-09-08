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
//! - `\X\HH` single ISO-8859-1 byte (NOT code-page dependent: always the ISO
//!   10646 row-0 value, per ISO 10303-21 6.4.3)
//! - `\S\C` extended ASCII: code point of `C` plus 128, mapped through the
//!   currently selected `\P?\` code page (default ISO 8859-1)
//! - `\PA\`..`\PI\` code-page directive (A=ISO 8859-1 .. I=ISO 8859-9):
//!   tracked for subsequent `\S\` escapes, then dropped. Any other letter is
//!   dropped without changing the active page.
//!
//! ISO 10303-21 also doubles the reverse solidus inside a string literal, so
//! `\\` decodes to one `\`. That arm sits AFTER the directive arms: a directive
//! immediately followed by an escaped backslash ends in three backslashes
//! (`\X2\00FC\X0\` + `\\`), and collapsing pairs first would eat the
//! directive's own terminator.
//!
//! Unknown or malformed escapes are passed through unchanged. The `''`
//! doubled-quote escape is NOT handled here — the tokenizer's consumers strip
//! the surrounding quotes and un-double before calling this.

use std::borrow::Cow;

#[path = "step_codepages.rs"]
mod step_codepages;
use step_codepages::resolve_extended_char;

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
    let mut codepage: u8 = 1;

    while i < n {
        if bytes[i] != b'\\' {
            // Copy one whole UTF-8 character; `i` is always on a char boundary
            // because every escape marker is ASCII.
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }

        // `\PC\` code-page directive: track A..I as codepage 1..9 for
        // subsequent `\S\` escapes, then drop the four bytes. Any other
        // letter (or an unrecognized custom-page form) is dropped without
        // changing the active page.
        if i + 3 < n && bytes[i + 1] == b'P' && bytes[i + 3] == b'\\' {
            let letter = bytes[i + 2];
            if (b'A'..=b'I').contains(&letter) {
                codepage = letter - b'A' + 1;
            }
            i += 4;
            continue;
        }

        // `\S\C`: byte value is the code point of `C` plus 128, mapped
        // through the active code page. Read `C` as a whole char and advance
        // by its UTF-8 length so a malformed multi-byte `C` can't leave `i`
        // mid-character (which would panic the next slice).
        if i + 3 < n && bytes[i + 1] == b'S' && bytes[i + 2] == b'\\' {
            let c = s[i + 3..].chars().next().unwrap();
            let code = resolve_extended_char(codepage, c as u32 + 128);
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

        // `\\`: one literal reverse solidus (ISO 10303-21 doubles it inside a
        // string literal). Checked after the directive arms so a `\X0\`/`\X\`
        // terminator adjacent to an escaped backslash is consumed by its own
        // directive first, never paired with the escape that follows it.
        if i + 1 < n && bytes[i + 1] == b'\\' {
            out.push('\\');
            i += 2;
            continue;
        }

        // Unknown escape: keep the backslash and advance one byte.
        out.push('\\');
        i += 1;
    }

    Cow::Owned(out)
}

/// Encode a UTF-8 string back to IFC STEP escapes. Inverse of
/// [`decode_ifc_string`] for the canonical (non-overlong) forms.
///
/// Printable ASCII is preserved; everything else (and backslash) is escaped as
/// `\X\HH`, `\X2\HHHH\X0\`, or `\X4\HHHHHHHH\X0\` by code point.
///
/// This is escape encoding only — it does NOT double the apostrophe (`'`,
/// 0x27 is printable ASCII and passes through unchanged). Its output is
/// therefore **not** safe to place directly inside a STEP single-quoted
/// string literal: an undoubled `'` terminates the literal early and
/// produces a file no conformant reader parses as intended (e.g. a name like
/// `O'Brien`). A caller that writes into a literal must double `'` itself,
/// or use `step_text::escape` in `ifc-lite-export` (re-exported as
/// `escape_step_string`), which handles the full literal-context contract:
/// doubling `'` and `\`, mapping control characters to a space, and encoding
/// non-ASCII — per ISO 10303-21 6.3.3.4. The two functions do not produce
/// the same output for the same input; do not assume they agree.
///
/// Kept for round-trip tests (`decode_ifc_string(encode_ifc_string(s)) ==
/// s`), which hold regardless of apostrophe handling because doubling is a
/// literal-context requirement, not an encoding one.
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
    fn collapses_the_doubled_reverse_solidus() {
        // ISO 10303-21 doubles the reverse solidus inside a string literal just
        // as it doubles the apostrophe, so the pair is ONE backslash (#2323).
        assert_eq!(decode_ifc_string(r"C:\\temp"), r"C:\temp");
        // Two escaped backslashes stay two: exactly one collapsing pass.
        assert_eq!(decode_ifc_string(r"\\\\"), r"\\");
        // A directive consumes its own \X0\ terminator before the pair escape is
        // considered, so a trailing escaped backslash survives whole.
        assert_eq!(decode_ifc_string("\\X2\\00FC\\X0\\\\\\"), "\u{FC}\\");
        // Mirror case: a leading escaped backslash makes the rest literal text.
        assert_eq!(decode_ifc_string(r"\\X2\00FC\X0\"), r"\X2\00FC\X0\");
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
    fn s_escape_honours_the_selected_code_page() {
        // ISO 10303-21 6.4.3: \PE\ selects ISO 8859-5 (Cyrillic). Before
        // codepage tracking, every \S\ was decoded as if the default page
        // (ISO 8859-1) were active, giving U+00D0 (LATIN CAPITAL LETTER ETH)
        // instead of the correct U+0430 (CYRILLIC SMALL LETTER A).
        assert_eq!(decode_ifc_string(r"\PE\\S\P"), "\u{0430}");
        // The page persists across multiple \S\ escapes in the same string...
        assert_eq!(decode_ifc_string(r"\PE\\S\P\S\Q"), "\u{0430}\u{0431}");
        // ...until another \P?\ directive switches it again.
        assert_eq!(decode_ifc_string(r"\PE\\S\P\PA\\S\P"), "\u{0430}\u{00D0}");
        // A byte position ISO 8859-6 (Arabic, \PF\) itself leaves unassigned
        // falls back to the raw code point rather than U+FFFD.
        assert_eq!(decode_ifc_string(r"\PF\\S\0"), "\u{00B0}");
    }

    #[test]
    fn round_trips_through_encode() {
        for s in ["plain", "Br\u{FC}cke", "\u{1F600}", "a\u{E9}b"] {
            assert_eq!(decode_ifc_string(&encode_ifc_string(s)), s);
        }
    }

    #[test]
    fn encode_does_not_double_the_apostrophe() {
        // Pins the documented contract: `encode_ifc_string` is escape
        // encoding only, not literal-safe. `'` is printable ASCII and passes
        // through unchanged (unlike `step_text::escape`, which doubles it).
        // A behaviour change here is a deliberate decision, not a silent one
        // (issue #3445).
        assert_eq!(encode_ifc_string("'"), "'");
        assert_eq!(encode_ifc_string("O'Brien"), "O'Brien");
    }
}
