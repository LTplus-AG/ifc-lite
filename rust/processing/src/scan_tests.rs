// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::{keyword_eq, IFC_TYPES};

/// The keyword chain every scan used to carry, in the order the native scan
/// evaluated it. `classify` must return what its first true arm returned.
fn chain(type_name: &str) -> ScanClass {
    if keyword_eq(type_name, "IFCINDEXEDCOLOURMAP") {
        ScanClass::IndexedColourMap
    } else if keyword_eq(type_name, "IFCSTYLEDITEM") {
        ScanClass::StyledItem
    } else if keyword_eq(type_name, "IFCMATERIALDEFINITIONREPRESENTATION") {
        ScanClass::MaterialDefinitionRepresentation
    } else if keyword_eq(type_name, "IFCRELASSOCIATESMATERIAL") {
        ScanClass::RelAssociatesMaterial
    } else if keyword_eq(type_name, "IFCPRESENTATIONLAYERASSIGNMENT") {
        ScanClass::PresentationLayerAssignment
    } else if keyword_eq(type_name, "IFCPROPERTYSET") {
        ScanClass::PropertySet
    } else if keyword_eq(type_name, "IFCRELDEFINESBYPROPERTIES") {
        ScanClass::RelDefinesByProperties
    } else if keyword_starts_with(type_name, "IFCPROPERTY") {
        ScanClass::Property
    } else if keyword_eq(type_name, "IFCRELVOIDSELEMENT") {
        ScanClass::RelVoidsElement
    } else if keyword_eq(type_name, "IFCRELFILLSELEMENT") {
        ScanClass::RelFillsElement
    } else if keyword_eq(type_name, "IFCRELAGGREGATES") {
        ScanClass::RelAggregates
    } else if keyword_eq(type_name, "IFCPROJECT") {
        ScanClass::Project
    } else if keyword_eq(type_name, "IFCSITE") {
        ScanClass::Site
    } else if keyword_eq(type_name, "IFCBUILDING") {
        ScanClass::Building
    } else if keyword_eq(type_name, "IFCMAPPEDITEM") {
        ScanClass::MappedItem
    } else if keyword_eq(type_name, "IFCRELDEFINESBYTYPE") {
        ScanClass::RelDefinesByType
    } else if keyword_eq(type_name, "IFCMATERIALLAYERSET")
        || keyword_eq(type_name, "IFCMATERIALLAYERSETUSAGE")
    {
        ScanClass::MaterialLayerSet
    } else {
        ScanClass::Other
    }
}

const KEYWORDS: &[&str] = &[
    "IFCINDEXEDCOLOURMAP",
    "IFCSTYLEDITEM",
    "IFCMATERIALDEFINITIONREPRESENTATION",
    "IFCRELASSOCIATESMATERIAL",
    "IFCPRESENTATIONLAYERASSIGNMENT",
    "IFCPROPERTYSET",
    "IFCRELDEFINESBYPROPERTIES",
    "IFCPROPERTYSINGLEVALUE",
    "IFCPROPERTY",
    "IFCRELVOIDSELEMENT",
    "IFCRELFILLSELEMENT",
    "IFCRELAGGREGATES",
    "IFCPROJECT",
    "IFCSITE",
    "IFCBUILDING",
    "IFCMAPPEDITEM",
    "IFCRELDEFINESBYTYPE",
    "IFCMATERIALLAYERSET",
    "IFCMATERIALLAYERSETUSAGE",
];

/// Spellings a file may use: as written, lowercase, CamelCase-ish, and off by one.
fn spellings(upper: &str) -> Vec<String> {
    let lower = upper.to_ascii_lowercase();
    let camel: String = lower
        .char_indices()
        .map(|(i, c)| if i % 3 == 0 { c.to_ascii_uppercase() } else { c })
        .collect();
    vec![
        upper.to_string(),
        lower,
        camel,
        format!("{upper}S"),
        upper[..upper.len() - 1].to_string(),
        format!("X{upper}"),
    ]
}

#[test]
fn scan_class_matches_the_keyword_chain() {
    let mut checked = 0usize;
    for name in IFC_TYPES.iter().map(|t| t.as_str().to_ascii_uppercase()) {
        for spelling in spellings(&name) {
            assert_eq!(ScanClass::classify(&spelling), chain(&spelling), "{spelling}");
            checked += 1;
        }
    }
    for keyword in KEYWORDS {
        for spelling in spellings(keyword) {
            assert_eq!(ScanClass::classify(&spelling), chain(&spelling), "{spelling}");
            checked += 1;
        }
    }
    for odd in ["", "I", "IFC", "IFCPROPERT", "IFCPROPERTY ", "ifcproperty\u{e9}", "IFC\u{212a}SITE"] {
        assert_eq!(ScanClass::classify(odd), chain(odd), "{odd:?}");
    }
    assert!(checked > 3_000, "fixture rot: only {checked} spellings checked");
}

/// Every named class is reached by its keyword in any case, and nothing else.
#[test]
fn every_keyword_reaches_its_class() {
    let expected = [
        ("IFCINDEXEDCOLOURMAP", ScanClass::IndexedColourMap),
        ("IFCSTYLEDITEM", ScanClass::StyledItem),
        ("IFCMATERIALDEFINITIONREPRESENTATION", ScanClass::MaterialDefinitionRepresentation),
        ("IFCRELASSOCIATESMATERIAL", ScanClass::RelAssociatesMaterial),
        ("IFCPRESENTATIONLAYERASSIGNMENT", ScanClass::PresentationLayerAssignment),
        ("IFCPROPERTYSET", ScanClass::PropertySet),
        ("IFCRELDEFINESBYPROPERTIES", ScanClass::RelDefinesByProperties),
        ("IFCPROPERTYSINGLEVALUE", ScanClass::Property),
        ("IFCRELVOIDSELEMENT", ScanClass::RelVoidsElement),
        ("IFCRELFILLSELEMENT", ScanClass::RelFillsElement),
        ("IFCRELAGGREGATES", ScanClass::RelAggregates),
        ("IFCPROJECT", ScanClass::Project),
        ("IFCSITE", ScanClass::Site),
        ("IFCBUILDING", ScanClass::Building),
        ("IFCMAPPEDITEM", ScanClass::MappedItem),
        ("IFCRELDEFINESBYTYPE", ScanClass::RelDefinesByType),
        ("IFCMATERIALLAYERSET", ScanClass::MaterialLayerSet),
        ("IFCMATERIALLAYERSETUSAGE", ScanClass::MaterialLayerSet),
        ("IFCWALL", ScanClass::Other),
    ];
    for (keyword, class) in expected {
        for spelling in [keyword.to_string(), keyword.to_ascii_lowercase()] {
            assert_eq!(ScanClass::classify(&spelling), class, "{spelling}");
        }
    }
}

/// The wire code round-trips for the classes the shard scan names and is
/// `PREPASS_CLASS_NONE` for the rest.
#[test]
fn wire_codes_round_trip() {
    let named = [
        ScanClass::Project,
        ScanClass::Site,
        ScanClass::StyledItem,
        ScanClass::IndexedColourMap,
        ScanClass::MaterialDefinitionRepresentation,
        ScanClass::RelAssociatesMaterial,
        ScanClass::RelVoidsElement,
        ScanClass::RelFillsElement,
        ScanClass::RelAggregates,
        ScanClass::MappedItem,
        ScanClass::RelDefinesByType,
        ScanClass::MaterialLayerSet,
    ];
    for class in named {
        let code = u8::from(class);
        assert_ne!(code, crate::PREPASS_CLASS_NONE, "{class:?}");
        assert_eq!(ScanClass::try_from(code), Ok(class));
    }
    for class in [ScanClass::Building, ScanClass::PropertySet, ScanClass::Property, ScanClass::Other] {
        assert_eq!(u8::from(class), crate::PREPASS_CLASS_NONE, "{class:?}");
    }
    assert_eq!(ScanClass::try_from(crate::PREPASS_CLASS_NONE), Err(crate::PREPASS_CLASS_NONE));
    assert_eq!(ScanClass::try_from(1), Err(1));
}
