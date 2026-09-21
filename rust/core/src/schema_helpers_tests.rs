// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn supported_schema_keywords_keep_their_exact_type() {
    let exact = IfcType::from_str("IFCSLABSTANDARDCASE");
    assert_eq!(exact.as_str(), "IFCSLABSTANDARDCASE");
    assert!(exact.is_subtype_of(IfcType::IfcProduct));
}

#[test]
fn non_express_stratum_aliases_are_the_only_compatibility_geometry_override() {
    for &alias in crate::EXPORTER_STRATUM_ALIASES {
        assert!(crate::is_exporter_stratum_alias(alias));
        assert!(has_geometry_by_name(alias));
    }
    assert!(!crate::is_exporter_stratum_alias("IFCVENDORSTRATUM"));
}

#[test]
fn unknown_keywords_keep_their_owned_label_through_record_recovery() {
    let parsed = IfcType::from_str("IFC_VENDOR_WIDGET");
    assert_eq!(
        ifc_type_from_record(parsed, b"#1=IFC_VENDOR_WIDGET();").as_str(),
        "IFC_VENDOR_WIDGET"
    );
}

#[test]
fn classification_is_case_insensitive_across_the_generated_catalog() {
    for name in crate::generated::IFC_TYPES.iter().map(IfcType::as_str) {
        let expected = geometry_flags_by_name(name);
        assert_eq!(
            geometry_flags_by_name(&name.to_ascii_lowercase()),
            expected,
            "{name}"
        );
    }
}

#[test]
fn representative_geometry_categories_and_spatial_exclusions_stay_distinct() {
    for name in [
        "IFCWALL",
        "IFCBEAM",
        "IFCCHILLER",
        "IFCPAVEMENT",
        "IFCREINFORCEDSOIL",
    ] {
        assert!(has_geometry_by_name(name), "{name}");
    }
    for name in [
        "IFCPROJECT",
        "IFCMATERIAL",
        "IFCBUILDINGSTOREY",
        "IFCFACILITY",
        "IFCROAD",
    ] {
        assert!(!has_geometry_by_name(name), "{name}");
    }
}

#[test]
fn simple_geometry_categories_remain_explicit() {
    for name in ["IFCWALL", "IFCSLAB", "IFCBEAM", "IFCCOLUMN"] {
        assert!(is_simple_geometry_type(name), "{name}");
    }
    for name in ["IFCDOOR", "IFCWINDOW", "IFCFLOWSEGMENT", "IFCSPACE"] {
        assert!(!is_simple_geometry_type(name), "{name}");
    }
}

#[test]
fn unknown_keywords_use_fallbacks_without_growing_the_catalog_cache() {
    let before = classifications().len();
    assert!(has_geometry_by_name("IFCREINFORCINGVENDOREXTENSION"));
    assert!(!has_geometry_by_name("IFCVENDORGEOMETRY"));
    assert_eq!(classifications().len(), before);
}
