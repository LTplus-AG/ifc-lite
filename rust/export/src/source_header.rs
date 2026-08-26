// SPDX-License-Identifier: MPL-2.0
//! Read the ISO 10303-21 `HEADER` section of a source file into the structured
//! form the writer needs to round-trip header fidelity.
//!
//! Twin of `parseSourceHeader` in `packages/parser/src/source-header.ts`; the
//! two are held together by the shared vectors in
//! `rust/export/tests/fixtures/step_header_vectors.json`
//! (`rust/export/tests/step_header_parity.rs` and
//! `packages/export/src/step-header.parity.test.ts`), not by looking alike.
//!
//! Deliberately a small, self-contained, quote-aware reader rather than a reuse
//! of the generic STEP value parser: `FILE_DESCRIPTION` items and `FILE_NAME`
//! fields routinely carry commas and parentheses inside quoted strings (e.g.
//! `'CoordinateReference [..., ProjectSite: Origin]'`), which a splitter blind
//! to quote state mis-splits.

/// Headers are tiny; cap the scan so a huge file's body is never decoded.
const MAX_HEADER_BYTES: usize = 64 * 1024;

/// The `HEADER` records a source file carried, decoded to Unicode.
///
/// Field-for-field the `IfcSourceHeader` of `@ifc-lite/data`. Absent optional
/// fields are `None`; absent lists are empty.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceHeader {
    /// `FILE_DESCRIPTION` item list — the MVD/view-definition claim.
    pub description: Vec<String>,
    /// `FILE_DESCRIPTION` implementation level; defaults to `2;1` when absent.
    pub implementation_level: String,
    /// `FILE_NAME[0]` — the name the source file was written under.
    pub name: Option<String>,
    /// `FILE_NAME[1]` — the source's date-time stamp.
    pub time_stamp: Option<String>,
    /// `FILE_NAME[2]`.
    pub author: Vec<String>,
    /// `FILE_NAME[3]`.
    pub organization: Vec<String>,
    /// `FILE_NAME[4]` — the tool that WROTE the source file.
    pub preprocessor_version: Option<String>,
    /// `FILE_NAME[5]` — the authoring application behind it.
    pub originating_system: Option<String>,
    /// `FILE_NAME[6]`.
    pub authorization: Option<String>,
    /// `FILE_SCHEMA` identifiers.
    pub schema_identifiers: Vec<String>,
}

/// If a STEP string literal or a `/* ... */` comment starts at `bytes[i]`,
/// return the index just past it. Otherwise `None`.
///
/// Neither carries structure: a keyword, a comma or a bracket inside one is
/// text. Every scan in this file has to agree on that, so it is one function
/// rather than a copy per loop.
///
/// The TypeScript counterpart is `source-header.ts::skipLexicalAt`, and the two
/// must stay in step. This file and that one read the same headers, and #3284
/// is the shape of what happens when they drift: each half documented itself as
/// matching the other while they disagreed.
///
/// The two unterminated cases are deliberately not symmetric. An unterminated
/// literal runs to end-of-text, because a lone `'` cannot be read as ordinary
/// text. An unterminated `/*` is simply not a comment, because it can: running
/// it to the end would lose every record after it.
pub(crate) fn skip_lexical_at(bytes: &[u8], i: usize) -> Option<usize> {
    match *bytes.get(i)? {
        b'\'' => {
            let mut p = i + 1;
            while p < bytes.len() {
                if bytes[p] != b'\'' {
                    p += 1;
                } else if bytes.get(p + 1) == Some(&b'\'') {
                    p += 2; // `''` is an escaped apostrophe, not the end
                } else {
                    return Some(p + 1);
                }
            }
            Some(bytes.len())
        }
        b'/' if bytes.get(i + 1) == Some(&b'*') => {
            let close = bytes[i + 2..].windows(2).position(|w| w == b"*/")?;
            Some(i + 2 + close + 2)
        }
        _ => None,
    }
}

/// Advance past whitespace and comments. ISO 10303-21 allows a comment wherever
/// whitespace is allowed, including between a record keyword and its `(`.
fn skip_trivia(bytes: &[u8], mut i: usize) -> usize {
    loop {
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if bytes.get(i) == Some(&b'\'') {
            return i;
        }
        match skip_lexical_at(bytes, i) {
            Some(end) => i = end, // only a comment can match here
            None => return i,
        }
    }
}

/// Split STEP record arguments at top-level commas, respecting paren/bracket
/// nesting and single-quoted strings (with `''` escapes). Returns the raw,
/// still-escaped argument substrings, trimmed.
fn split_top_level(inner: &str) -> Vec<String> {
    let bytes = inner.as_bytes();
    let mut args: Vec<String> = Vec::new();
    let mut depth: i32 = 0;
    let mut current = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if let Some(end) = skip_lexical_at(bytes, i) {
            // A literal is part of the argument's text; a comment is not.
            if bytes[i] == b'\'' {
                current.push_str(&inner[i..end]);
            }
            i = end;
            continue;
        }
        match bytes[i] {
            b'(' | b'[' => {
                depth += 1;
                current.push(bytes[i] as char);
                i += 1;
            }
            b')' | b']' => {
                depth -= 1;
                current.push(bytes[i] as char);
                i += 1;
            }
            b',' if depth == 0 => {
                args.push(current.trim().to_string());
                current.clear();
                i += 1;
            }
            _ => {
                // Copy one whole UTF-8 character. Delimiters are all ASCII, so a
                // continuation byte can never be one and is safe to run over.
                let start = i;
                i += 1;
                while i < bytes.len() && (bytes[i] & 0xC0) == 0x80 {
                    i += 1;
                }
                current.push_str(&inner[start..i]);
            }
        }
    }
    if !current.trim().is_empty() || !args.is_empty() {
        args.push(current.trim().to_string());
    }
    args
}

/// Decode a header string literal's inner text (outer quotes already stripped).
///
/// Both escape layers in the order the TS twin uses: un-double `''` FIRST, then
/// resolve the ISO 10303-21 backslash directives (`\X2\HHHH\X0\`, `\X\HH`,
/// `\S\`, `\Px\`). The order is load-bearing — decoding first would let two
/// separately-escaped apostrophes (`\X\27\X\27`) become `''` and then collapse
/// into one, losing a character.
fn decode_literal(inner: &str) -> String {
    let undoubled = if inner.contains("''") { inner.replace("''", "'") } else { inner.to_string() };
    ifc_lite_core::decode_ifc_string(&undoubled).into_owned()
}

/// Decode one argument to a string, or `None` for `$` (unset), `*` (derived)
/// or empty.
fn decode_opt_string(arg: &str) -> Option<String> {
    let t = arg.trim();
    if t.is_empty() || t == "$" || t == "*" {
        return None;
    }
    if t.len() >= 2 && t.starts_with('\'') && t.ends_with('\'') {
        return Some(decode_literal(&t[1..t.len() - 1]));
    }
    Some(t.to_string())
}

/// Decode a list argument (`('a','b',...)`). `$`/empty yield an empty list, and
/// unset entries are dropped. A bare single value where a list was expected is
/// tolerated, as on the TS side.
fn decode_string_list(arg: &str) -> Vec<String> {
    let t = arg.trim();
    if t.is_empty() || t == "$" || t == "*" {
        return Vec::new();
    }
    if !(t.starts_with('(') && t.ends_with(')')) {
        return decode_opt_string(t).into_iter().collect();
    }
    split_top_level(&t[1..t.len() - 1]).iter().filter_map(|a| decode_opt_string(a)).collect()
}

/// Find `needle` (ASCII) in `haystack`, ignoring ASCII case, returning a byte
/// offset into `haystack` itself, optionally skipping matches inside a
/// single-quoted STEP string literal.
///
/// Not `to_uppercase().find(..)`: that builds a copy whose byte offsets can
/// drift from the original (`'ß'` uppercases to two bytes), and slicing the
/// original with an offset taken from the copy is how a header value comes back
/// mangled. Case-folding ASCII in place keeps every offset the caller's.
///
/// Quote state toggles on every `'`; a literal apostrophe is written doubled
/// (ISO 10303-21 6.3.2.4), so a doubled pair toggles twice and nets to a no-op
/// — the same technique `step_text::find_unquoted` and `refs_in_line` use.
fn find_ascii_ci_from(haystack: &[u8], needle: &[u8], skip_quoted: bool) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let last_start = haystack.len() - needle.len();
    let mut i = 0;
    while i <= last_start {
        if skip_quoted {
            if let Some(end) = skip_lexical_at(haystack, i) {
                i = end;
                continue;
            }
        }
        if haystack[i..i + needle.len()].iter().zip(needle).all(|(a, b)| a.eq_ignore_ascii_case(b))
        {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Extract the argument substring inside the parentheses of `KEYWORD( ... )`.
/// Quote- and nesting-aware, so a quoted `)` never closes the record early.
///
/// The keyword search itself skips quoted text: a `FILE_DESCRIPTION` item that
/// mentions `FILE_NAME` in prose is not the `FILE_NAME` record, and matching it
/// drops the real one (the character after it is not `(`).
fn extract_record_args(text: &str, keyword: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let at = find_ascii_ci_from(bytes, keyword.as_bytes(), true)?;
    let mut i = skip_trivia(bytes, at + keyword.len());
    if bytes.get(i) != Some(&b'(') {
        return None;
    }
    let start = i;
    let mut depth: i32 = 0;
    while i < bytes.len() {
        if let Some(end) = skip_lexical_at(bytes, i) {
            i = end;
            continue;
        }
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start + 1..i].to_string());
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Parse the `HEADER` section of `content`.
///
/// Returns `None` when no recognisable header record is present (a non-STEP
/// input), which is the caller's signal to fall back to its own defaults rather
/// than to write empty fields. Cheap: only the first [`MAX_HEADER_BYTES`] are
/// examined, truncated at the first `ENDSEC` so `DATA` is never scanned.
pub fn parse_source_header(content: &[u8]) -> Option<SourceHeader> {
    let cap = content.len().min(MAX_HEADER_BYTES);
    let raw = String::from_utf8_lossy(&content[..cap]);
    // Truncate at the section terminator so the DATA section is never scanned.
    // The search skips quoted text, for the reason `step_text::detect_schema`
    // gives at its own `ENDSEC;` search: a header field's plain-text VALUE can
    // carry the literal `ENDSEC`, and a raw byte search cannot tell that from
    // the terminator — it would cut the header short and drop every record
    // after it. The offset comes from the string itself, so it is already a
    // char boundary.
    let text = match find_ascii_ci_from(raw.as_bytes(), b"ENDSEC", true) {
        Some(end) => raw[..end].to_string(),
        None => raw.to_string(),
    };

    let desc_record = extract_record_args(&text, "FILE_DESCRIPTION");
    let name_record = extract_record_args(&text, "FILE_NAME");
    let schema_record = extract_record_args(&text, "FILE_SCHEMA");

    if desc_record.is_none() && name_record.is_none() && schema_record.is_none() {
        return None;
    }

    let mut header = SourceHeader { implementation_level: "2;1".to_string(), ..Default::default() };

    if let Some(record) = &desc_record {
        let parts = split_top_level(record);
        if let Some(p) = parts.first() {
            header.description = decode_string_list(p);
        }
        if let Some(p) = parts.get(1) {
            header.implementation_level =
                decode_opt_string(p).unwrap_or_else(|| "2;1".to_string());
        }
    }

    if let Some(record) = &name_record {
        let parts = split_top_level(record);
        let at = |n: usize| parts.get(n).map(String::as_str).unwrap_or("");
        header.name = decode_opt_string(at(0));
        header.time_stamp = decode_opt_string(at(1));
        header.author = decode_string_list(at(2));
        header.organization = decode_string_list(at(3));
        header.preprocessor_version = decode_opt_string(at(4));
        header.originating_system = decode_opt_string(at(5));
        header.authorization = decode_opt_string(at(6));
    }

    if let Some(record) = &schema_record {
        header.schema_identifiers = decode_string_list(record);
    }

    Some(header)
}
