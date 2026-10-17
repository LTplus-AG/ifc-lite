// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::SchemaFamily;

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
///    ([`SchemaFamily::detect`], over `first_declared_schema`, the selection
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
    SchemaFamily::detect(content).unwrap_or(SchemaFamily::Ifc4).as_str()
}

#[cfg(test)]
#[path = "schema_detection_tests.rs"]
mod tests;
