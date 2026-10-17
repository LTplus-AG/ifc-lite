// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! STEP string escape decoding (ISO 10303-21 / IFC).
//!
//! Decoding only. The one writer is `ifc_lite_export::escape_step_string`
//! (a second, literal-unsafe encoder here was deleted: architecture review
//! behind #4577, F6). The round trip `decode_ifc_string(escape(s)) == s` is
//! pinned in `rust/export/tests/step_escape_parity.rs`.
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

/// Whether the apostrophe at `pos`, inside a STEP string literal, is the
/// operand of the PAGE directive `\S\` (#7540). Tested before a doubled `''`:
/// `'5\S\''` is "5§" and closes at its last quote. No other legal string unit
/// ends in `\S\` right before an apostrophe, so this cannot misfire on a legal
/// file.
#[inline]
pub fn is_page_quote_operand(bytes: &[u8], pos: usize) -> bool {
    pos >= 3 && bytes[pos - 1] == b'\\' && bytes[pos - 2] == b'S' && bytes[pos - 3] == b'\\'
}

/// Index just past the apostrophe closing the STEP string literal whose
/// opening apostrophe is at `open`, or `None` when it never closes (#7589).
///
/// The one rule for every walker that splits, rewrites or scans STEP text:
/// `''` is an escaped quote and a `\S\` operand is text. A walker that ends
/// the literal at the operand misreads every later comma, paren and
/// reference in the record. The TypeScript twin is `stepStringLiteralEnd` in
/// `@ifc-lite/encoding`.
pub fn step_string_literal_end(bytes: &[u8], open: usize) -> Option<usize> {
    let mut p = open + 1;
    loop {
        p += memchr::memchr(b'\'', bytes.get(p..)?)?;
        if is_page_quote_operand(bytes, p) {
            p += 1;
        } else if bytes.get(p + 1) == Some(&b'\'') {
            p += 2;
        } else {
            return Some(p + 1);
        }
    }
}

/// Decode one STEP string literal, quotes included (`'O''Brien'`), to its
/// text: strip the quotes, un-double `''`, then resolve the backslash escapes
/// (F4-2, CORE-16). The one funnel for "literal bytes to text": the token
/// converter, the header reader and every raw-byte reader go through it.
///
/// The order is load-bearing: un-doubling FIRST, because decoding first would
/// let two separately escaped apostrophes (`\X\27\X\27`) become `''` and
/// collapse into one. The TypeScript twin is `decodeStepStringLiteral` in
/// `@ifc-lite/encoding`.
///
/// Borrowed from `raw` when there is nothing to undo (no `''`, no `\`).
/// Bytes that are not UTF-8 decode lossily. `None` when `raw` is not
/// wrapped in a pair of apostrophes.
pub fn decode_step_literal(raw: &[u8]) -> Option<Cow<'_, str>> {
    let inner = raw.strip_prefix(b"'")?.strip_suffix(b"'")?;
    Some(decode_step_literal_inner(inner))
}

/// [`decode_step_literal`] for the bytes between the quotes, which is what
/// the tokenizer's `Token::String` holds.
#[inline]
pub(crate) fn decode_step_literal_inner(inner: &[u8]) -> Cow<'_, str> {
    let text = String::from_utf8_lossy(inner);
    // One byte search settles the common literal: no apostrophe inside, so
    // there is no `''` to undouble.
    if memchr::memchr(b'\'', inner).is_none() {
        return match text {
            Cow::Borrowed(t) => decode_ifc_string(t),
            Cow::Owned(t) => Cow::Owned(decode_ifc_string(&t).into_owned()),
        };
    }
    Cow::Owned(decode_ifc_string(&text.replace("''", "'")).into_owned())
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
    let mut terminator = X0Search::default();

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
            if let Some(end) = terminator.next_from(bytes, i + 4) {
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
            if let Some(end) = terminator.next_from(bytes, i + 4) {
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

/// Value of one ASCII hex digit (either case), `None` for anything else.
#[inline]
pub fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decode a STEP binary literal (`"0FF"`) to its bytes: the one home for
/// byte decoding of `BINARY` values (F4-1).
///
/// `raw` is the literal's content, as [`crate::AttributeValue::Binary`]
/// holds it, or the literal with its surrounding quotes. The first hex digit
/// is the number of unused bits in the last byte; the rest is whole bytes,
/// two hex digits each, either case.
///
/// Refuses (`None`) what it cannot decode exactly, instead of the old
/// "skip the indicator and stop at the first bad digit": a non-zero
/// indicator (D18: the bytes are not byte-aligned, so no whole-byte reader
/// can use them), an indicator above `3`, an odd count of hex digits and a
/// non-hex byte. `"0"` is the empty binary.
pub fn decode_step_binary(raw: &[u8]) -> Option<Vec<u8>> {
    let raw = raw.strip_prefix(b"\"").unwrap_or(raw);
    let raw = raw.strip_suffix(b"\"").unwrap_or(raw);
    let (&indicator, hex) = raw.split_first()?;
    if indicator != b'0' || !hex.len().is_multiple_of(2) {
        return None;
    }
    hex.chunks_exact(2)
        .map(|pair| Some((hex_val(pair[0])? << 4) | hex_val(pair[1])?))
        .collect()
}

#[inline]
fn starts_with(bytes: &[u8], at: usize, pat: &[u8]) -> bool {
    bytes.len() >= at + pat.len() && &bytes[at..at + pat.len()] == pat
}

/// The next `\X0\` terminator at or after a position, memoised (CORE-28).
///
/// The decoder's cursor only moves forward, so one search answers every later
/// one: a miss means no terminator exists past any later position either, and
/// a hit at `p` is still the first terminator for every position up to `p`.
/// Without it, N unterminated `\X2\` / `\X4\` openers each searched to the
/// end of the input, which is quadratic in a hostile attribute value.
#[derive(Default)]
struct X0Search {
    /// `Some(None)`: no terminator remains. `Some(Some(p))`: the first one at
    /// or after the position it was searched from sits at `p`.
    last: Option<Option<usize>>,
}

impl X0Search {
    fn next_from(&mut self, bytes: &[u8], from: usize) -> Option<usize> {
        match self.last {
            Some(None) => return None,
            Some(Some(p)) if p >= from => return Some(p),
            _ => {}
        }
        let found = bytes
            .get(from..)
            .and_then(|rest| memchr::memmem::find(rest, b"\\X0\\"))
            .map(|off| from + off);
        self.last = Some(found);
        found
    }
}

#[cfg(test)]
#[path = "step_encoding_tests.rs"]
mod tests;
