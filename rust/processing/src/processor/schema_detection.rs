// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Preserve the historical raw-byte predicate, including matches outside HEADER:
/// IFC4X3 anywhere wins over IFC4. Search disjoint source regions rather than
/// scanning the whole file twice when IFC4X3 is absent (#3987).
///
/// ISO 10303-21 keywords are case-insensitive, so `FILE_SCHEMA(('ifc4'))` is
/// legal and must not fall through to the `"IFC2X3"` default (#4661: it did,
/// silently, because this used to search with the case-sensitive
/// `memchr::memmem::find`). [`find_keyword`] is the shared case-insensitive
/// byte search: it anchors on the rarest letter in the needle instead of the
/// first one, which matters here exactly as it did for
/// `prepass::find_ifcproject_keyword` (#4498) — anchoring "IFC4" on its
/// leading `I` would fire on every IFC keyword and every GUID in the file.
/// `find_keyword` anchors on `F` (rank 20 of 26, vs. `I` at rank 24, on the
/// rarest-letter table measured for #4498/#4497); see the module doc on
/// [`ifc_lite_core::parser::keyword`] for the underlying measurement.
pub(super) fn detect_schema_version(content: &[u8]) -> &'static str {
    let Some(offset) = ifc_lite_core::parser::find_keyword(content, b"IFC4") else {
        return "IFC2X3";
    };
    let remaining = &content[offset + 4..];
    // IFC4 has no self-overlap: a later IFC4X3 cannot start inside this match.
    if remaining
        .get(..2)
        .is_some_and(|window| window.eq_ignore_ascii_case(b"X3"))
        || ifc_lite_core::parser::find_keyword(remaining, b"IFC4X3").is_some()
    {
        "IFC4X3"
    } else {
        "IFC4"
    }
}

#[cfg(test)]
#[path = "schema_detection_tests.rs"]
mod tests;
