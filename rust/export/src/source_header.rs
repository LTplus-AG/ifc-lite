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

#[path = "source_header_scan.rs"]
mod scan;

use scan::{find_record_open, find_section_marker, Lex};

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

/// Split STEP record arguments at top-level commas, respecting paren/bracket
/// nesting and single-quoted strings (with `''` escapes). Returns the raw,
/// still-escaped argument substrings, trimmed.
fn split_top_level(inner: &str) -> Vec<String> {
    let bytes = inner.as_bytes();
    let mut lex = Lex::new(bytes);
    let mut args: Vec<String> = Vec::new();
    let mut depth: i32 = 0;
    let mut current = String::new();
    // Everything except a comment is part of the argument's text, so the scan
    // copies contiguous runs and cuts only where something is dropped (a
    // comment) or where an argument ends (a top-level comma). Nothing is
    // inspected per character, so multi-byte UTF-8 needs no special handling.
    let mut run = 0;
    let mut i = 0;
    while i < bytes.len() {
        if let Some(end) = lex.skip_lexical_at(i) {
            if bytes[i] != b'\'' {
                current.push_str(&inner[run..i]); // a comment is not part of the text
                run = end;
            }
            i = end;
            continue;
        }
        if bytes[i] == b',' && depth == 0 {
            current.push_str(&inner[run..i]);
            args.push(current.trim().to_string());
            current.clear();
            run = i + 1;
        } else {
            match bytes[i] {
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                _ => {}
            }
        }
        i += 1;
    }
    current.push_str(&inner[run..]);
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
    let undoubled = if inner.contains("''") {
        inner.replace("''", "'")
    } else {
        inner.to_string()
    };
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
    split_top_level(&t[1..t.len() - 1])
        .iter()
        .filter_map(|a| decode_opt_string(a))
        .collect()
}

/// Read only the first declared schema identifier from the complete header.
///
/// This is the uncapped schema-detection entry point. It shares this module's
/// lexical and record parser, but does not widen [`parse_source_header`]'s
/// public 64 KiB allocation contract. If a malformed header omits its own
/// `ENDSEC;`, `DATA;` still stops the window before the model body. With no
/// recognisable section boundary at all, the allocation remains capped.
pub(crate) fn declared_schema(content: &[u8]) -> Option<String> {
    let boundary = [
        find_section_marker(content, b"ENDSEC"),
        find_section_marker(content, b"DATA"),
    ]
    .into_iter()
    .flatten()
    .min()
    .unwrap_or_else(|| content.len().min(MAX_HEADER_BYTES));
    let text = String::from_utf8_lossy(&content[..boundary]);
    extract_record_args(&text, "FILE_SCHEMA")
        .and_then(|record| decode_string_list(&record).into_iter().next())
}

/// Extract the argument substring inside the parentheses of `KEYWORD( ... )`.
/// Quote- and nesting-aware, so a quoted `)` never closes the record early.
///
/// The keyword search itself skips quoted text: a `FILE_DESCRIPTION` item that
/// mentions `FILE_NAME` in prose is not the `FILE_NAME` record, and matching it
/// drops the real one (the character after it is not `(`).
fn extract_record_args(text: &str, keyword: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = find_record_open(bytes, keyword.as_bytes())?;
    let mut lex = Lex::new(bytes);
    let start = i;
    let mut depth: i32 = 0;
    while i < bytes.len() {
        if let Some(end) = lex.skip_lexical_at(i) {
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
    // The search skips quoted text, for the reason `schema_detect::detect_schema`
    // gives at its own `ENDSEC;` search: a header field's plain-text VALUE can
    // carry the literal `ENDSEC`, and a raw byte search cannot tell that from
    // the terminator — it would cut the header short and drop every record
    // after it. The offset comes from the string itself, so it is already a
    // char boundary.
    let text = match find_section_marker(raw.as_bytes(), b"ENDSEC") {
        Some(end) => raw[..end].to_string(),
        None => raw.to_string(),
    };

    let desc_record = extract_record_args(&text, "FILE_DESCRIPTION");
    let name_record = extract_record_args(&text, "FILE_NAME");
    let schema_record = extract_record_args(&text, "FILE_SCHEMA");

    if desc_record.is_none() && name_record.is_none() && schema_record.is_none() {
        return None;
    }

    let mut header = SourceHeader {
        implementation_level: "2;1".to_string(),
        ..Default::default()
    };

    if let Some(record) = &desc_record {
        let parts = split_top_level(record);
        if let Some(p) = parts.first() {
            header.description = decode_string_list(p);
        }
        if let Some(p) = parts.get(1) {
            header.implementation_level = decode_opt_string(p).unwrap_or_else(|| "2;1".to_string());
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

#[cfg(test)]
#[path = "source_header_tests.rs"]
mod tests;
