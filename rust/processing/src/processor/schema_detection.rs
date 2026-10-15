// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// The IFC schema family a STEP file declares: `"IFC4X3"`, `"IFC4"` or the
/// `"IFC2X3"` default. THE detector for every `schema_version` this workspace
/// reports, the native pipeline's `ModelMetadata` and the server's
/// `/parse/metadata` alike (PROCESSING-5 / SERVER-18, #7691: the server kept a
/// second, case-sensitive copy, so the two routes answered differently for the
/// same upload).
///
/// Only the HEADER's `FILE_SCHEMA` declaration counts, read by the shared
/// quote- and comment-aware header reader
/// ([`ifc_lite_core::parser::header::declared_schemas`]), which stops at the
/// header's `ENDSEC;`/`DATA;`. Schema-like text in DATA values, header strings
/// or comments does not count: a file declaring IFC2X3 whose model mentions
/// "IFC4X3" in a description is still IFC2X3. This used to be a raw substring
/// search over the whole file (#3987), which let such text win.
///
/// ISO 10303-21 keywords are case-insensitive, and so is the match on each
/// declared identifier, so `FILE_SCHEMA(('ifc4'))` is IFC4 (#4661). An
/// identifier containing `IFC4X3` wins over one containing `IFC4`; any other
/// IFC4-family identifier (`IFC4X1`, `IFC4X2`, `IFC4_ADD2`) reports as IFC4.
pub fn detect_schema_version(content: &[u8]) -> &'static str {
    let declared = ifc_lite_core::parser::header::declared_schemas(content);
    let mentions = |needle: &str| {
        declared
            .iter()
            .any(|label| label.to_ascii_uppercase().contains(needle))
    };
    if mentions("IFC4X3") {
        "IFC4X3"
    } else if mentions("IFC4") {
        "IFC4"
    } else {
        "IFC2X3"
    }
}

#[cfg(test)]
#[path = "schema_detection_tests.rs"]
mod tests;
