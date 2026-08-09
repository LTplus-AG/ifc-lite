// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `streaming.rs` (ratchet-exempt sibling file).

use super::*;

/// No `FILE_SCHEMA` declaration at all must default to IFC2X3 rather than
/// panicking or misreporting a newer schema.
#[test]
fn detect_schema_version_defaults_to_ifc2x3_when_undeclared() {
    let content = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC2X3");
}

#[test]
fn detect_schema_version_detects_ifc4() {
    let content =
        b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC4");
}

/// `"IFC4X3"` contains `"IFC4"` as a literal substring, so a checker that
/// tests the IFC4 pattern before the IFC4X3 pattern (or that only ever tests
/// IFC4) would misclassify every IFC4X3 file as IFC4. The IFC4X3 branch must
/// be tried FIRST (or matched precisely) so this doesn't happen.
#[test]
fn detect_schema_version_detects_ifc4x3_not_ifc4() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC4X3");
}

/// Schema-like text appearing in the DATA section (after the header's
/// `ENDSEC;`) must NOT influence the detected schema — only the HEADER's
/// `FILE_SCHEMA` declaration is authoritative. The HEADER here declares no
/// `FILE_SCHEMA` at all (so the correct answer is the IFC2X3 default); a scan
/// that doesn't stop at the header's `ENDSEC;` would find the `FILE_SCHEMA`-
/// looking text stored as IFC data and misreport IFC4X3.
#[test]
fn detect_schema_version_ignores_schema_like_text_in_data_section() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\nDATA;\n#1=IFCTEXT('mentions FILE_SCHEMA((IFC4X3)) in a comment field');\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC2X3");
}
