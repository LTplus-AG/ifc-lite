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

/// Upper-half (0xA0..=0xFF) code-point tables for the ISO 8859 parts a `\P?\`
/// directive can select for a subsequent `\S\` (ISO 10303-21 6.4.3): letters
/// A..I select ISO 8859-1..9 (A=1, the default, needs no table here — its
/// upper half is already the Unicode-identity mapping `\S\` used before
/// codepage tracking existed). Index 0 is codepage 2 (`\PB\`) .. index 7 is
/// codepage 9 (`\PI\`). `0` marks a code position the ISO 8859 part itself
/// leaves unassigned; ISO 10303-21 does not define decoder behaviour there,
/// so [`resolve_extended_char`] falls back to the raw byte value (the same
/// answer the default page gives) rather than U+FFFD.
///
/// Source: <https://www.unicode.org/Public/MAPPINGS/ISO8859/8859-{2..9}.TXT>
/// (verified 2026-08-30). Keep in parity with `CODEPAGE_TABLES` in
/// `packages/encoding/src/ifc-string.ts` — both are pinned by the codepage
/// cases in `tests/fixtures/ifc_string_vectors.json`.
#[rustfmt::skip]
const CODEPAGE_TABLES: [[u16; 96]; 8] = [
    // codepage 2: ISO 8859-2 (Central European)
    [
        0x00A0, 0x0104, 0x02D8, 0x0141, 0x00A4, 0x013D, 0x015A, 0x00A7, 0x00A8, 0x0160, 0x015E, 0x0164, 0x0179, 0x00AD, 0x017D, 0x017B,
        0x00B0, 0x0105, 0x02DB, 0x0142, 0x00B4, 0x013E, 0x015B, 0x02C7, 0x00B8, 0x0161, 0x015F, 0x0165, 0x017A, 0x02DD, 0x017E, 0x017C,
        0x0154, 0x00C1, 0x00C2, 0x0102, 0x00C4, 0x0139, 0x0106, 0x00C7, 0x010C, 0x00C9, 0x0118, 0x00CB, 0x011A, 0x00CD, 0x00CE, 0x010E,
        0x0110, 0x0143, 0x0147, 0x00D3, 0x00D4, 0x0150, 0x00D6, 0x00D7, 0x0158, 0x016E, 0x00DA, 0x0170, 0x00DC, 0x00DD, 0x0162, 0x00DF,
        0x0155, 0x00E1, 0x00E2, 0x0103, 0x00E4, 0x013A, 0x0107, 0x00E7, 0x010D, 0x00E9, 0x0119, 0x00EB, 0x011B, 0x00ED, 0x00EE, 0x010F,
        0x0111, 0x0144, 0x0148, 0x00F3, 0x00F4, 0x0151, 0x00F6, 0x00F7, 0x0159, 0x016F, 0x00FA, 0x0171, 0x00FC, 0x00FD, 0x0163, 0x02D9,
    ],
    // codepage 3: ISO 8859-3 (South European)
    [
        0x00A0, 0x0126, 0x02D8, 0x00A3, 0x00A4, 0x0000, 0x0124, 0x00A7, 0x00A8, 0x0130, 0x015E, 0x011E, 0x0134, 0x00AD, 0x0000, 0x017B,
        0x00B0, 0x0127, 0x00B2, 0x00B3, 0x00B4, 0x00B5, 0x0125, 0x00B7, 0x00B8, 0x0131, 0x015F, 0x011F, 0x0135, 0x00BD, 0x0000, 0x017C,
        0x00C0, 0x00C1, 0x00C2, 0x0000, 0x00C4, 0x010A, 0x0108, 0x00C7, 0x00C8, 0x00C9, 0x00CA, 0x00CB, 0x00CC, 0x00CD, 0x00CE, 0x00CF,
        0x0000, 0x00D1, 0x00D2, 0x00D3, 0x00D4, 0x0120, 0x00D6, 0x00D7, 0x011C, 0x00D9, 0x00DA, 0x00DB, 0x00DC, 0x016C, 0x015C, 0x00DF,
        0x00E0, 0x00E1, 0x00E2, 0x0000, 0x00E4, 0x010B, 0x0109, 0x00E7, 0x00E8, 0x00E9, 0x00EA, 0x00EB, 0x00EC, 0x00ED, 0x00EE, 0x00EF,
        0x0000, 0x00F1, 0x00F2, 0x00F3, 0x00F4, 0x0121, 0x00F6, 0x00F7, 0x011D, 0x00F9, 0x00FA, 0x00FB, 0x00FC, 0x016D, 0x015D, 0x02D9,
    ],
    // codepage 4: ISO 8859-4 (North European)
    [
        0x00A0, 0x0104, 0x0138, 0x0156, 0x00A4, 0x0128, 0x013B, 0x00A7, 0x00A8, 0x0160, 0x0112, 0x0122, 0x0166, 0x00AD, 0x017D, 0x00AF,
        0x00B0, 0x0105, 0x02DB, 0x0157, 0x00B4, 0x0129, 0x013C, 0x02C7, 0x00B8, 0x0161, 0x0113, 0x0123, 0x0167, 0x014A, 0x017E, 0x014B,
        0x0100, 0x00C1, 0x00C2, 0x00C3, 0x00C4, 0x00C5, 0x00C6, 0x012E, 0x010C, 0x00C9, 0x0118, 0x00CB, 0x0116, 0x00CD, 0x00CE, 0x012A,
        0x0110, 0x0145, 0x014C, 0x0136, 0x00D4, 0x00D5, 0x00D6, 0x00D7, 0x00D8, 0x0172, 0x00DA, 0x00DB, 0x00DC, 0x0168, 0x016A, 0x00DF,
        0x0101, 0x00E1, 0x00E2, 0x00E3, 0x00E4, 0x00E5, 0x00E6, 0x012F, 0x010D, 0x00E9, 0x0119, 0x00EB, 0x0117, 0x00ED, 0x00EE, 0x012B,
        0x0111, 0x0146, 0x014D, 0x0137, 0x00F4, 0x00F5, 0x00F6, 0x00F7, 0x00F8, 0x0173, 0x00FA, 0x00FB, 0x00FC, 0x0169, 0x016B, 0x02D9,
    ],
    // codepage 5: ISO 8859-5 (Cyrillic)
    [
        0x00A0, 0x0401, 0x0402, 0x0403, 0x0404, 0x0405, 0x0406, 0x0407, 0x0408, 0x0409, 0x040A, 0x040B, 0x040C, 0x00AD, 0x040E, 0x040F,
        0x0410, 0x0411, 0x0412, 0x0413, 0x0414, 0x0415, 0x0416, 0x0417, 0x0418, 0x0419, 0x041A, 0x041B, 0x041C, 0x041D, 0x041E, 0x041F,
        0x0420, 0x0421, 0x0422, 0x0423, 0x0424, 0x0425, 0x0426, 0x0427, 0x0428, 0x0429, 0x042A, 0x042B, 0x042C, 0x042D, 0x042E, 0x042F,
        0x0430, 0x0431, 0x0432, 0x0433, 0x0434, 0x0435, 0x0436, 0x0437, 0x0438, 0x0439, 0x043A, 0x043B, 0x043C, 0x043D, 0x043E, 0x043F,
        0x0440, 0x0441, 0x0442, 0x0443, 0x0444, 0x0445, 0x0446, 0x0447, 0x0448, 0x0449, 0x044A, 0x044B, 0x044C, 0x044D, 0x044E, 0x044F,
        0x2116, 0x0451, 0x0452, 0x0453, 0x0454, 0x0455, 0x0456, 0x0457, 0x0458, 0x0459, 0x045A, 0x045B, 0x045C, 0x00A7, 0x045E, 0x045F,
    ],
    // codepage 6: ISO 8859-6 (Arabic)
    [
        0x00A0, 0x0000, 0x0000, 0x0000, 0x00A4, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x060C, 0x00AD, 0x0000, 0x0000,
        0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x061B, 0x0000, 0x0000, 0x0000, 0x061F,
        0x0000, 0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627, 0x0628, 0x0629, 0x062A, 0x062B, 0x062C, 0x062D, 0x062E, 0x062F,
        0x0630, 0x0631, 0x0632, 0x0633, 0x0634, 0x0635, 0x0636, 0x0637, 0x0638, 0x0639, 0x063A, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        0x0640, 0x0641, 0x0642, 0x0643, 0x0644, 0x0645, 0x0646, 0x0647, 0x0648, 0x0649, 0x064A, 0x064B, 0x064C, 0x064D, 0x064E, 0x064F,
        0x0650, 0x0651, 0x0652, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    ],
    // codepage 7: ISO 8859-7 (Greek)
    [
        0x00A0, 0x2018, 0x2019, 0x00A3, 0x20AC, 0x20AF, 0x00A6, 0x00A7, 0x00A8, 0x00A9, 0x037A, 0x00AB, 0x00AC, 0x00AD, 0x0000, 0x2015,
        0x00B0, 0x00B1, 0x00B2, 0x00B3, 0x0384, 0x0385, 0x0386, 0x00B7, 0x0388, 0x0389, 0x038A, 0x00BB, 0x038C, 0x00BD, 0x038E, 0x038F,
        0x0390, 0x0391, 0x0392, 0x0393, 0x0394, 0x0395, 0x0396, 0x0397, 0x0398, 0x0399, 0x039A, 0x039B, 0x039C, 0x039D, 0x039E, 0x039F,
        0x03A0, 0x03A1, 0x0000, 0x03A3, 0x03A4, 0x03A5, 0x03A6, 0x03A7, 0x03A8, 0x03A9, 0x03AA, 0x03AB, 0x03AC, 0x03AD, 0x03AE, 0x03AF,
        0x03B0, 0x03B1, 0x03B2, 0x03B3, 0x03B4, 0x03B5, 0x03B6, 0x03B7, 0x03B8, 0x03B9, 0x03BA, 0x03BB, 0x03BC, 0x03BD, 0x03BE, 0x03BF,
        0x03C0, 0x03C1, 0x03C2, 0x03C3, 0x03C4, 0x03C5, 0x03C6, 0x03C7, 0x03C8, 0x03C9, 0x03CA, 0x03CB, 0x03CC, 0x03CD, 0x03CE, 0x0000,
    ],
    // codepage 8: ISO 8859-8 (Hebrew)
    [
        0x00A0, 0x0000, 0x00A2, 0x00A3, 0x00A4, 0x00A5, 0x00A6, 0x00A7, 0x00A8, 0x00A9, 0x00D7, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x00AF,
        0x00B0, 0x00B1, 0x00B2, 0x00B3, 0x00B4, 0x00B5, 0x00B6, 0x00B7, 0x00B8, 0x00B9, 0x00F7, 0x00BB, 0x00BC, 0x00BD, 0x00BE, 0x0000,
        0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x2017,
        0x05D0, 0x05D1, 0x05D2, 0x05D3, 0x05D4, 0x05D5, 0x05D6, 0x05D7, 0x05D8, 0x05D9, 0x05DA, 0x05DB, 0x05DC, 0x05DD, 0x05DE, 0x05DF,
        0x05E0, 0x05E1, 0x05E2, 0x05E3, 0x05E4, 0x05E5, 0x05E6, 0x05E7, 0x05E8, 0x05E9, 0x05EA, 0x0000, 0x0000, 0x200E, 0x200F, 0x0000,
    ],
    // codepage 9: ISO 8859-9 (Turkish)
    [
        0x00A0, 0x00A1, 0x00A2, 0x00A3, 0x00A4, 0x00A5, 0x00A6, 0x00A7, 0x00A8, 0x00A9, 0x00AA, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x00AF,
        0x00B0, 0x00B1, 0x00B2, 0x00B3, 0x00B4, 0x00B5, 0x00B6, 0x00B7, 0x00B8, 0x00B9, 0x00BA, 0x00BB, 0x00BC, 0x00BD, 0x00BE, 0x00BF,
        0x00C0, 0x00C1, 0x00C2, 0x00C3, 0x00C4, 0x00C5, 0x00C6, 0x00C7, 0x00C8, 0x00C9, 0x00CA, 0x00CB, 0x00CC, 0x00CD, 0x00CE, 0x00CF,
        0x011E, 0x00D1, 0x00D2, 0x00D3, 0x00D4, 0x00D5, 0x00D6, 0x00D7, 0x00D8, 0x00D9, 0x00DA, 0x00DB, 0x00DC, 0x0130, 0x015E, 0x00DF,
        0x00E0, 0x00E1, 0x00E2, 0x00E3, 0x00E4, 0x00E5, 0x00E6, 0x00E7, 0x00E8, 0x00E9, 0x00EA, 0x00EB, 0x00EC, 0x00ED, 0x00EE, 0x00EF,
        0x011F, 0x00F1, 0x00F2, 0x00F3, 0x00F4, 0x00F5, 0x00F6, 0x00F7, 0x00F8, 0x00F9, 0x00FA, 0x00FB, 0x00FC, 0x0131, 0x015F, 0x00FF,
    ],
];

/// Map a `\S\` result code (0x80..=0xFF) through the currently selected code
/// page. `codepage` 1 (the default, ISO 8859-1) and any `code` outside
/// 0xA0..=0xFF (the C1 control range 0x80..=0x9F, or a malformed operand
/// wider than a single byte) pass through unchanged, matching the
/// pre-codepage-aware behaviour this decoder had before.
fn resolve_extended_char(codepage: u8, code: u32) -> u32 {
    if codepage <= 1 || !(0xA0..=0xFF).contains(&code) {
        return code;
    }
    let table = &CODEPAGE_TABLES[(codepage - 2) as usize];
    let mapped = table[(code - 0xA0) as usize] as u32;
    if mapped == 0 { code } else { mapped }
}

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
