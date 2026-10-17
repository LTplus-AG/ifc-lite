// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Bytes of the source the last-resort scan reads when no declared identifier
/// is recognised. The TS parser's figure (`detectSchemaVersion`).
const FALLBACK_SCAN_BYTES: usize = 2000;

/// The IFC schema a STEP file declares: `"IFC2X3"`, `"IFC4"`, `"IFC4X3"` or
/// `"IFC5"`. THE detector for every `schema_version` this workspace reports,
/// the native pipeline's `ModelMetadata` and the server's `/parse/metadata`
/// alike (PROCESSING-5 / SERVER-18, #7691: the server kept a second,
/// case-sensitive copy, and processing searched the whole file, so `ifc4`
/// inside a GUID reported an IFC2X3 model as IFC4).
///
/// The rule is the TS parser's `detectSchemaVersion`
/// (`packages/parser/src/source-header.ts`), pinned against it by the shared
/// vectors in `rust/core/tests/fixtures/schema_version_vectors.json`:
/// 1. The first `FILE_SCHEMA` identifier that names a family wins
///    ([`ifc_lite_core::parser::header::first_declared_schema`], the selection
///    the decoder's attribute layout uses too). The header reader is quote-
///    and comment-aware, so text in DATA, header strings or comments does not
///    count.
/// 2. If none does (no, empty or unparseable declaration), the first 2000
///    bytes are searched for a schema token, ASCII case-insensitively. This
///    is a loose last resort: with no declaration it can match `ifc4` inside
///    a GUID in those bytes, exactly as the TS twin does (pinned by a shared
///    vector, #7740).
/// 3. Otherwise `"IFC4"`.
pub fn detect_schema_version(content: &[u8]) -> &'static str {
    ifc_lite_core::parser::header::first_declared_schema(content, schema_of_identifier)
        .or_else(|| fallback_scan(content))
        .unwrap_or("IFC4")
}

/// One declared identifier's family, by prefix, longest family first
/// (`IFC4X3_ADD2`, `IFC2X3_TC1` and `IFC4X1` all reach us in the wild, and
/// `IFC4X3` begins with `IFC4`). `None` for an identifier naming no family.
fn schema_of_identifier(identifier: &str) -> Option<&'static str> {
    let token = identifier.trim().to_ascii_uppercase();
    ["IFC5", "IFC4X3", "IFC4", "IFC2X3"]
        .into_iter()
        .find(|family| token.starts_with(family))
}

/// The last-resort substring scan over the head of the file.
fn fallback_scan(content: &[u8]) -> Option<&'static str> {
    let head = &content[..content.len().min(FALLBACK_SCAN_BYTES)];
    let text = String::from_utf8_lossy(head).to_ascii_uppercase();
    ["IFC5", "IFC4X3", "IFC4", "IFC2X3"]
        .into_iter()
        .find(|family| text.contains(family))
}

#[cfg(test)]
#[path = "schema_detection_tests.rs"]
mod tests;
