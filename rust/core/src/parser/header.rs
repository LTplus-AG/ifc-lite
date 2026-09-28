// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared, quote-aware ISO 10303-21 header record and schema reading.
//! The export writer and analytic processing use the same lexical rules.

#[path = "header_scan.rs"]
mod scan;

pub use scan::{find_record_open, find_section_marker, Lex};

/// The bounded source-header reader's maximum scan window.
pub const MAX_HEADER_BYTES: usize = 64 * 1024;

/// Split STEP record arguments at top-level commas, respecting paren/bracket
/// nesting and single-quoted strings (with `''` escapes). Returns the raw,
/// still-escaped argument substrings, trimmed.
pub fn split_top_level(inner: &str) -> Vec<String> {
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
    crate::decode_ifc_string(&undoubled).into_owned()
}

/// Decode one argument to a string, or `None` for `$` (unset), `*` (derived)
/// or empty.
pub fn decode_opt_string(arg: &str) -> Option<String> {
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
pub fn decode_string_list(arg: &str) -> Vec<String> {
    decode_opt_string_list(arg).unwrap_or_default()
}

/// [`decode_string_list`], but an unset (`$`, `*`) or missing argument is
/// `None` rather than an empty list, so a writer can tell "never stated" from a
/// literal `()` (#5470).
pub fn decode_opt_string_list(arg: &str) -> Option<Vec<String>> {
    let t = arg.trim();
    if t.is_empty() || t == "$" || t == "*" {
        return None;
    }
    if !(t.starts_with('(') && t.ends_with(')')) {
        return Some(decode_opt_string(t).into_iter().collect());
    }
    let entries = split_top_level(&t[1..t.len() - 1]);
    let values: Vec<String> = entries.iter().filter_map(|a| decode_opt_string(a)).collect();
    // A list whose every entry is unset (`($)`) states nothing either; only a
    // literal `()` is an empty list.
    if !entries.is_empty() && values.is_empty() {
        return None;
    }
    Some(values)
}

/// Read all declared schema identifiers from the complete header.
///
/// This is the uncapped schema-detection entry point. It shares this module's
/// lexical and record parser, but does not widen the export writer's
/// public 64 KiB allocation contract. If a malformed header omits its own
/// `ENDSEC;`, `DATA;` still stops the window before the model body. With no
/// recognisable section boundary at all, the allocation remains capped.
pub fn declared_schemas(content: &[u8]) -> Vec<String> {
    schema_values_before_section(content, content.len().min(MAX_HEADER_BYTES))
}

fn schema_values_before_section(content: &[u8], fallback: usize) -> Vec<String> {
    let boundary = [
        find_section_marker(content, b"ENDSEC"),
        find_section_marker(content, b"DATA"),
    ]
    .into_iter()
    .flatten()
    .min()
    .unwrap_or(fallback);
    let text = String::from_utf8_lossy(&content[..boundary]);
    extract_record_args(&text, "FILE_SCHEMA")
        .map(|record| decode_string_list(&record))
        .unwrap_or_default()
}

/// Read schema identifiers from a bounded header window.
///
/// Processing only needs source identity and must not scan arbitrary model
/// bodies. The export writer uses [`declared_schemas`] to preserve unusually
/// long source headers for round-trip fidelity.
pub fn declared_schemas_bounded(content: &[u8]) -> Vec<String> {
    let window = &content[..content.len().min(MAX_HEADER_BYTES)];
    schema_values_before_section(window, window.len())
}

/// Read the first declared schema identifier from a bounded header window.
pub fn declared_schema_bounded(content: &[u8]) -> Option<String> {
    declared_schemas_bounded(content).into_iter().next()
}

/// Read the first declared schema identifier from the complete header.
///
/// STEP re-export preserves the declaration's first identifier. Consumers
/// which need a supported schema (rather than exact header preservation) must
/// inspect [`declared_schemas`] instead.
pub fn declared_schema(content: &[u8]) -> Option<String> {
    declared_schemas(content).into_iter().next()
}

/// Extract the argument substring inside the parentheses of `KEYWORD( ... )`.
/// Quote- and nesting-aware, so a quoted `)` never closes the record early.
///
/// The keyword search itself skips quoted text: a `FILE_DESCRIPTION` item that
/// mentions `FILE_NAME` in prose is not the `FILE_NAME` record, and matching it
/// drops the real one (the character after it is not `(`).
pub fn extract_record_args(text: &str, keyword: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::{declared_schema, declared_schema_bounded, MAX_HEADER_BYTES};

    #[test]
    fn header_schema_reader_skips_decoys_and_respects_window() {
        let source = b"ISO-10303-21;\nHEADER;\n\
            FILE_DESCRIPTION(('mentions FILE_SCHEMA((''IFC4X3''));'),'2;1');\n\
            /* FILE_SCHEMA(('IFC4')); */\n\
            file_schema /* actual */ (('IFC2X3'));\nENDSEC;\nDATA;\n\
            #1=IFCPROJECT('g',$,$,$,$,$,$,$,$);\nENDSEC;";
        assert_eq!(declared_schema_bounded(source).as_deref(), Some("IFC2X3"));

        let mut long_header = b"ISO-10303-21;\nHEADER;\n".to_vec();
        long_header.extend(std::iter::repeat_n(b' ', MAX_HEADER_BYTES));
        long_header.extend_from_slice(b"FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;");
        assert_eq!(declared_schema_bounded(&long_header), None);
        assert_eq!(declared_schema(&long_header).as_deref(), Some("IFC4"));
    }
}
