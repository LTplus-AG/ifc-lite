// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::generated::schema_registry::SchemaVersion;
use crate::{attribute_names_for_schema, legacy_attribute_names, IfcType};

#[test]
fn generated_registries_keep_version_specific_door_style_slots() {
    let ifc2x3 = attribute_names_for_schema("IFC2X3", "IFCDOORSTYLE")
        .expect("IFCDOORSTYLE is declared by IFC2X3");
    let ifc4 = attribute_names_for_schema("IFC4_ADD2", "ifcdoorstyle")
        .expect("IFCDOORSTYLE is declared by IFC4");

    assert_eq!(ifc2x3, ifc4);
    assert_eq!(ifc2x3.last(), Some(&"Sizeable"));
    assert!(attribute_names_for_schema("IFC4X3_ADD2", "IFCDOORSTYLE").is_none());
}

#[test]
fn registry_accepts_ifc4x3_release_labels_but_not_unknown_families() {
    assert_eq!(
        SchemaVersion::from_file_schema("ifc4x3_rc4"),
        Some(SchemaVersion::Ifc4x3)
    );
    assert_eq!(
        SchemaVersion::from_file_schema(" IFC4_ADD2_TC1 "),
        Some(SchemaVersion::Ifc4)
    );
    assert_eq!(
        SchemaVersion::from_file_schema("IFC2X3_TC1"),
        Some(SchemaVersion::Ifc2x3)
    );
    for unknown in [
        "IFC4X1",
        "IFC4X4",
        "IFC4X30",
        "IFC4VENDOR",
        "IFC4_ADD",
        "IFC4_ADD2_VENDOR",
        "IFC5",
    ] {
        assert_eq!(
            SchemaVersion::from_file_schema(unknown),
            None,
            "must not guess a registry for {unknown}"
        );
    }
    assert_eq!(attribute_names_for_schema("IFC5", "IFCWALL"), None);
}

#[test]
fn legacy_wrapper_preserves_its_old_non_modern_contract() {
    assert_eq!(legacy_attribute_names("IFCWALL"), None);
    assert_eq!(
        legacy_attribute_names("ifcdoorstyle").and_then(|names| names.last()),
        Some(&"Sizeable")
    );
    assert_eq!(
        legacy_attribute_names("IFCALIGNMENTCURVE"),
        Some(&["Horizontal", "Vertical", "Tag"][..]),
        "retain IFC4.1 transitional metadata absent from the pinned EXPRESS inputs"
    );
}

#[test]
fn canonical_ifc4x3_type_lookup_is_unchanged_by_registry_modules() {
    assert_eq!(IfcType::from_str("IFCWALL"), IfcType::IfcWall);
    assert!(matches!(
        IfcType::from_str("IFCDOORSTYLE"),
        IfcType::Unknown(_)
    ));
}
