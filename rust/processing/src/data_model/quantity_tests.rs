// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `QuantityKind`, the one vocabulary for the seven quantity classes (EXPORT-DATA-17).

use super::*;

#[test]
fn every_spelling_derives_from_the_one_kind() {
    for kind in QuantityKind::ALL {
        let name = kind.as_str();
        assert_eq!(kind.ifc_entity(), format!("IfcQuantity{name}"));
        assert_eq!(kind.keyword(), format!("IFCQUANTITY{}", name.to_uppercase()));
        assert_eq!(kind.lower(), name.to_lowercase());
        assert_eq!(QuantityKind::parse(name), Some(kind));
        assert_eq!(QuantityKind::from_keyword(&kind.keyword().to_lowercase()), Some(kind));
        assert_eq!(QuantityKind::of(&ifc_lite_core::ifc_type_from_keyword(kind.keyword())), Some(kind));
    }
    assert_eq!(QuantityKind::from_keyword("IFCQUANTITYCOMPLEX"), None);
    assert_eq!(QuantityKind::parse("length"), None);
}

/// `Number` is read only by the opt-in analysis view until C6-14.
#[test]
fn flat_export_mode_still_drops_number() {
    let n = IfcType::IfcQuantityNumber;
    assert_eq!(quantity_kind(&n, QuantityDecodeMode::FlatExport), None);
    assert_eq!(quantity_kind(&n, QuantityDecodeMode::AuthoredAnalysis), Some(QuantityKind::Number));
}
