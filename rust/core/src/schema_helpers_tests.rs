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
