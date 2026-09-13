// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Read the schema a STEP file declares from its raw header bytes.
//!
//! Schema detection deliberately shares the complete, case-insensitive header
//! reader. Keeping a second scanner here previously gave long and lower-case
//! headers different answers depending on which reader reached them (#4593).

/// Detect the source `FILE_SCHEMA` label (for example `IFC2X3`); defaults
/// to `IFC4` when the input has no readable declaration.
pub(crate) fn detect_schema(content: &[u8]) -> String {
    crate::source_header::declared_schema(content)
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "IFC4".to_string())
}

#[cfg(test)]
#[path = "schema_detect_tests.rs"]
mod tests;
