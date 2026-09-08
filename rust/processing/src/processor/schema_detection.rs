// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Preserve the historical raw-byte predicate, including matches outside HEADER:
/// IFC4X3 anywhere wins over IFC4. Search disjoint source regions rather than
/// scanning the whole file twice when IFC4X3 is absent (#3987).
pub(super) fn detect_schema_version(content: &[u8]) -> &'static str {
    let Some(offset) = memchr::memmem::find(content, b"IFC4") else {
        return "IFC2X3";
    };
    let remaining = &content[offset + 4..];
    // IFC4 has no self-overlap: a later IFC4X3 cannot start inside this match.
    if remaining.starts_with(b"X3")
        || memchr::memmem::find(remaining, b"IFC4X3").is_some()
    {
        "IFC4X3"
    } else {
        "IFC4"
    }
}

#[cfg(test)]
#[path = "schema_detection_tests.rs"]
mod tests;
