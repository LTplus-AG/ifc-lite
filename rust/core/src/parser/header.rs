// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared, quote-aware ISO 10303-21 header record and schema reading.
//! The export writer and analytic processing use the same lexical rules.

use std::borrow::Cow;

#[path = "header_scan.rs"]
mod scan;

pub use scan::{close_paren, find_keyword_then, KeywordHit, Then};

/// The scan window for the source header, shared by the header readers and
/// the scanner's `DATA;` search (F4-2): one cap, so a header both read agree
/// on is a header both find the end of. Real headers are under 2 KB; the cap
/// keeps a file with no HEADER at all from costing a pass over its body.
pub const MAX_HEADER_BYTES: usize = 256 * 1024;

/// Split STEP record arguments at top-level commas, respecting parenthesis
/// nesting, string literals and comments. Returns the raw, still-escaped
/// argument substrings, trimmed. A thin owned wrapper over
/// [`crate::parser::split_top_level_args_str`]: the splitter is core's own.
pub fn split_top_level(inner: &str) -> Vec<String> {
    crate::parser::split_top_level_args_str(inner)
        .into_iter()
        .map(str::to_owned)
        .collect()
}

/// Decode one argument to a string, or `None` for `$` (unset), `*` (derived)
/// or empty.
pub fn decode_opt_string(arg: &str) -> Option<String> {
    let t = arg.trim();
    if t.is_empty() || t == "$" || t == "*" {
        return None;
    }
    if t.len() >= 2 && t.starts_with('\'') && t.ends_with('\'') {
        return crate::step_encoding::decode_step_literal(t.as_bytes()).map(Cow::into_owned);
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
        find_keyword_then(content, b"ENDSEC", Then::Semicolon),
        find_keyword_then(content, b"DATA", Then::ParenOrSemicolon),
    ]
    .into_iter()
    .flatten()
    .map(|hit| hit.start)
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

/// The first declared `FILE_SCHEMA` identifier that `recognise` accepts, read
/// from the bounded header window ([`declared_schemas_bounded`]).
///
/// THE schema-selection rule: the first RECOGNISED identifier wins, so
/// `FILE_SCHEMA(('IFC2X3','IFC4X3'))` is IFC2X3 and an unrecognised leading
/// identifier is skipped rather than ending the search. It mirrors the TS
/// parser's `detectSchemaVersion` (`packages/parser/src/source-header.ts`).
/// Every Rust reader of the declared schema goes through it with its own
/// recogniser: the decoder's attribute layout (`SchemaVersion::from_file_schema`)
/// and processing's reported `schema_version` (#7691).
///
/// What is shared is the SELECTION, not the recogniser. The decoder's
/// recogniser names only the schemas with an EXPRESS registry (no IFC5),
/// processing's also knows IFC5, so `('IFC5','IFC4')` reads as IFC4 to the
/// former and IFC5 to the latter, deliberately: guessing a nearby registry for
/// IFC5 would relabel positional values (#7740).
pub fn first_declared_schema<T>(
    content: &[u8],
    mut recognise: impl FnMut(&str) -> Option<T>,
) -> Option<T> {
    declared_schemas_bounded(content)
        .iter()
        .find_map(|label| recognise(label))
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
    let open = find_keyword_then(bytes, keyword.as_bytes(), Then::Paren)?.then;
    let close = close_paren(bytes, open)?;
    Some(text[open + 1..close].to_string())
}

#[cfg(test)]
mod tests {
    use super::{declared_schema, declared_schema_bounded, MAX_HEADER_BYTES};
    use super::{find_keyword_then, Then};

    #[test]
    fn page_quote_operands_keep_header_decoys_inside_literals_7540() {
        let source = r"'\S\' FILE_SCHEMA((fake)); DATA;' FILE_SCHEMA(('IFC4')); DATA;";
        let schema = find_keyword_then(source.as_bytes(), b"FILE_SCHEMA", Then::Paren).unwrap();
        assert_eq!(schema.then, source.rfind("FILE_SCHEMA").unwrap() + "FILE_SCHEMA".len());
        let data = find_keyword_then(source.as_bytes(), b"DATA", Then::Semicolon).unwrap();
        assert_eq!(Some(data.start), source.rfind("DATA"));
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/step-page-directive.json"
        )).unwrap();
        for vector in vectors.as_array().unwrap() {
            let literal = vector["literal"].as_str().unwrap();
            // A keyword after the literal is found; one inside it is not.
            let text = format!("{literal} FILE_SCHEMA(");
            let hit = find_keyword_then(text.as_bytes(), b"FILE_SCHEMA", Then::Paren);
            assert_eq!(hit.map(|h| h.start), Some(literal.len() + 1), "{}", vector["name"]);
        }
    }

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
