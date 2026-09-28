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
//! Uses the shared quote-aware header reader rather than the generic STEP
//! value parser: `FILE_DESCRIPTION` items and `FILE_NAME`
//! fields routinely carry commas and parentheses inside quoted strings (e.g.
//! `'CoordinateReference [..., ProjectSite: Origin]'`), which a splitter blind
//! to quote state mis-splits.

use ifc_lite_core::parser::header::{decode_opt_string, decode_opt_string_list,
    decode_string_list, extract_record_args, find_section_marker, split_top_level,
    MAX_HEADER_BYTES};
pub(crate) use ifc_lite_core::parser::header::{declared_schema, declared_schemas};
#[cfg(test)]
use ifc_lite_core::parser::header::Lex;

/// The `HEADER` records a source file carried, decoded to Unicode.
///
/// Field-for-field the `IfcSourceHeader` of `@ifc-lite/data`. Absent optional
/// fields are `None`; absent lists are empty, except the two `FILE_NAME` lists,
/// which are `None` for `$` so a writer can tell "never stated" from a literal
/// `()` (#5470).
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
    /// `FILE_NAME[2]`; `None` for `$` or no `FILE_NAME` record.
    pub author: Option<Vec<String>>,
    /// `FILE_NAME[3]`; `None` for `$` or no `FILE_NAME` record.
    pub organization: Option<Vec<String>>,
    /// `FILE_NAME[4]` — the tool that WROTE the source file.
    pub preprocessor_version: Option<String>,
    /// `FILE_NAME[5]` — the authoring application behind it.
    pub originating_system: Option<String>,
    /// `FILE_NAME[6]`.
    pub authorization: Option<String>,
    /// `FILE_SCHEMA` identifiers.
    pub schema_identifiers: Vec<String>,
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
        header.author = decode_opt_string_list(at(2));
        header.organization = decode_opt_string_list(at(3));
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
