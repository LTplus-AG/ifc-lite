// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::generated::schema_registry::SchemaVersion;
use crate::{
    attribute_names_for_schema, entity_info_for_schema, is_subtype_of_for_schema, IfcType,
};

// These tests enter the new public registry API directly. A whole-file revert
// necessarily removes those exports before Rust can compile this module, so
// the PR uses the documented revert-oracle exemption for public API additions.

#[test]
fn generated_registries_answer_schema_local_inheritance_facts() {
    let ifc2x3_door_style = entity_info_for_schema("IFC2X3", "IFCDOORSTYLE")
        .expect("IFC2X3 declares IfcDoorStyle");
    assert_eq!(ifc2x3_door_style.name, "IFCDOORSTYLE");
    assert_eq!(ifc2x3_door_style.parent, Some("IFCTYPEPRODUCT"));
    assert!(!ifc2x3_door_style.is_abstract);
    assert!(is_subtype_of_for_schema(
        "IFC2X3",
        "IFCDOORSTYLE",
        "IFCTYPEPRODUCT"
    ));
    assert!(!is_subtype_of_for_schema(
        "IFC4X3",
        "IFCDOORSTYLE",
        "IFCTYPEPRODUCT"
    ));
    assert!(!is_subtype_of_for_schema("IFC5", "IFCWALL", "IFCPRODUCT"));
}

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
fn registry_accepts_supported_release_labels_but_not_unknown_families() {
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
    assert_eq!(
        SchemaVersion::from_file_schema("IFC4X1"),
        Some(SchemaVersion::Ifc4x1)
    );
    assert_eq!(
        SchemaVersion::from_file_schema("IFC4X2"),
        Some(SchemaVersion::Ifc4x2)
    );
    for unknown in [
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
fn generated_registries_use_ifc4x1_and_ifc4x2_not_transitional_tables() {
    assert_eq!(
        attribute_names_for_schema("IFC4X1", "IFCALIGNMENTCURVE"),
        Some(&["Horizontal", "Vertical", "Tag"][..])
    );
    assert!(is_subtype_of_for_schema(
        "IFC4X2",
        "IFCALIGNMENTCURVE",
        "IFCCURVE"
    ));
}

#[test]
fn schema_local_metadata_replaces_legacy_attribute_lookup() {
    assert_eq!(
        attribute_names_for_schema("IFC2X3", "IFCDOORSTYLE").and_then(|names| names.last()),
        Some(&"Sizeable")
    );
}

#[test]
fn canonical_ifc4x3_type_lookup_is_unchanged_by_registry_modules() {
    assert_eq!(IfcType::from_str("IFCWALL"), IfcType::IfcWall);
    // Since the exact-name universe landed, a legacy keyword keeps its name
    // through the canonical enum instead of collapsing to a hash — but the
    // canonical schema itself still does not declare it.
    let door_style = IfcType::from_str("IFCDOORSTYLE");
    assert!(!matches!(door_style, IfcType::Unknown(_)));
    assert!(!door_style.declared_by_canonical_schema());
    assert!(IfcType::IfcWall.declared_by_canonical_schema());
}
