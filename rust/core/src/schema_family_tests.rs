// SPDX-License-Identifier: MPL-2.0
use super::SchemaFamily::{self, *};
use crate::SchemaVersion;

/// The pre-C6-1 export `canon`, kept as the oracle for the label sweep.
fn old_canon(s: &str) -> &'static str {
    let u = s.to_uppercase();
    if u.starts_with("IFC2X3") {
        "IFC2X3"
    } else if u.starts_with("IFC4X3") {
        "IFC4X3"
    } else if u.starts_with("IFC4") {
        "IFC4"
    } else if u.starts_with("IFC5") || u.starts_with("IFCX") {
        "IFC5"
    } else {
        "IFC4"
    }
}

/// The pre-C6-1 processing `schema_of_identifier`.
fn old_identifier(identifier: &str) -> Option<&'static str> {
    let token = identifier.trim().to_ascii_uppercase();
    ["IFC5", "IFC4X3", "IFC4", "IFC2X3"].into_iter().find(|f| token.starts_with(f))
}

const LABELS: &[&str] = &[
    "IFC2X3", "IFC2X3_TC1", "ifc2x3", "IFC4", "IFC4_ADD2_TC1", "ifc4", "IFC4X1", "IFC4X2",
    "IFC4X3", "IFC4X3_ADD2", "ifc4x3_add2", "IFC5", "ifc5", "IFCX", "ifcx", "IFCX_ALPHA", "",
    "IFC", "IFC3", "IFC2X", "IFC4X", "IFC4X3RC", "NOT_IFC", "IFC'4X3", "IFC\\4",
];

#[test]
fn from_label_matches_the_old_canon_on_untrimmed_labels() {
    for label in LABELS {
        assert_eq!(
            SchemaFamily::from_label(label).unwrap_or(Ifc4).as_str(),
            old_canon(label),
            "label {label:?}"
        );
    }
}

#[test]
fn from_label_matches_the_old_identifier_recogniser_except_for_ifcx() {
    for label in LABELS {
        let want = old_identifier(label);
        let got = SchemaFamily::from_step_label(label).map(SchemaFamily::as_str);
        assert_eq!(got, want, "label {label:?}");
    }
}

#[test]
fn from_label_trims_and_ignores_case_and_returns_none_when_nothing_matches() {
    assert_eq!(SchemaFamily::from_label("  Ifc2x3_tc1 "), Some(Ifc2x3));
    assert_eq!(SchemaFamily::from_label("IFCX"), Some(Ifc5));
    assert_eq!(SchemaFamily::from_label("IFC4X3_ADD2"), Some(Ifc4x3));
    assert_eq!(SchemaFamily::from_label("IFC4X1"), Some(Ifc4));
    assert_eq!(SchemaFamily::from_label("nonsense"), None);
    assert_eq!(SchemaFamily::from_label(""), None);
    // Non-ASCII input never panics on a char boundary.
    assert_eq!(SchemaFamily::from_label("ıfc4"), None);
    assert_eq!(SchemaFamily::from_label("IFC\u{e9}"), None);
}

#[test]
fn detect_uses_the_first_named_family_then_the_head_scan() {
    let declared = b"ISO-10303-21;HEADER;FILE_SCHEMA(('X','IFC2X3'));ENDSEC;DATA;ENDSEC;";
    assert_eq!(SchemaFamily::detect(declared), Some(Ifc2x3));
    assert_eq!(SchemaFamily::detect(b"\xff\xfe ifc4x3 \x80"), Some(Ifc4x3));
    assert_eq!(SchemaFamily::detect(b"not a step file"), None);
    // IFCX is not a header token (the TS twin has none), so it is not detected.
    let ifcx = b"ISO-10303-21;HEADER;FILE_SCHEMA(('IFCX'));ENDSEC;DATA;ENDSEC;";
    assert_eq!(SchemaFamily::detect(ifcx), None);
}

#[test]
fn of_maps_every_registry_version() {
    assert_eq!(SchemaFamily::of(SchemaVersion::Ifc2x3), Ifc2x3);
    assert_eq!(SchemaFamily::of(SchemaVersion::Ifc4), Ifc4);
    assert_eq!(SchemaFamily::of(SchemaVersion::Ifc4x1), Ifc4);
    assert_eq!(SchemaFamily::of(SchemaVersion::Ifc4x2), Ifc4);
    assert_eq!(SchemaFamily::of(SchemaVersion::Ifc4x3), Ifc4x3);
}

#[test]
fn every_registry_label_has_the_family_of_its_version() {
    for label in LABELS {
        if let Some(v) = SchemaVersion::from_file_schema(label) {
            assert_eq!(SchemaFamily::from_label(label), Some(SchemaFamily::of(v)), "{label}");
        }
    }
}

/// (#8142) The registry selector's family, with IFC5 named by its label.
#[test]
fn of_file_schema_is_the_registry_family_plus_ifc5() {
    assert_eq!(SchemaFamily::of_file_schema("IFC4X1"), Some(Ifc4));
    assert_eq!(SchemaFamily::of_file_schema("IFC4X2"), Some(Ifc4));
    assert_eq!(SchemaFamily::of_file_schema("IFC4X3_ADD2"), Some(Ifc4x3));
    assert_eq!(SchemaFamily::of_file_schema("IFC2X3"), Some(Ifc2x3));
    assert_eq!(SchemaFamily::of_file_schema(" ifc5 "), Some(Ifc5));
    assert_eq!(SchemaFamily::of_file_schema("IFC4FOO"), None);
    assert_eq!(SchemaFamily::of_file_schema("IFCX"), None);
}
