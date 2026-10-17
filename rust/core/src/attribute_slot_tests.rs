// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{AttrKind, AttrSlot};
use crate::generated::schema_registry::SchemaVersion;
use crate::generated::{ifc2x3, ifc4, ifc4x1, ifc4x2, IFC_TYPES};

const ALL_SCHEMAS: [SchemaVersion; 5] = [
    SchemaVersion::Ifc2x3,
    SchemaVersion::Ifc4,
    SchemaVersion::Ifc4x1,
    SchemaVersion::Ifc4x2,
    SchemaVersion::Ifc4x3,
];

/// The entity names each schema declares, from its own generated catalog
/// (not from the lookup under test). The canonical universe lacks entities
/// IFC4X3 dropped (IfcDoorStyle, IfcBuildingElement), so the older schemas
/// enumerate their own.
fn declared(schema: SchemaVersion) -> Vec<&'static str> {
    fn names(all: &'static [impl NamedType]) -> Vec<&'static str> {
        all.iter().filter_map(NamedType::known).collect()
    }
    match schema {
        SchemaVersion::Ifc2x3 => names(ifc2x3::ALL),
        SchemaVersion::Ifc4 => names(ifc4::ALL),
        SchemaVersion::Ifc4x1 => names(ifc4x1::ALL),
        SchemaVersion::Ifc4x2 => names(ifc4x2::ALL),
        SchemaVersion::Ifc4x3 => IFC_TYPES
            .iter()
            .filter(|t| t.declared_by_canonical_schema())
            .filter_map(|t| t.known_as_str())
            .collect(),
    }
}

/// The per-schema `IfcType`s are distinct types with the same method.
trait NamedType {
    fn known(&self) -> Option<&'static str>;
}
macro_rules! named {
    ($($m:ident),*) => {$(
        impl NamedType for $m::IfcType {
            fn known(&self) -> Option<&'static str> {
                self.known_as_str()
            }
        }
    )*};
}
named!(ifc2x3, ifc4, ifc4x1, ifc4x2);

fn slot(index: usize, kind: AttrKind, aggregate: bool, optional: bool) -> Option<AttrSlot> {
    Some(AttrSlot { index, kind, aggregate, optional })
}

/// Every declared entity of every schema: the iterator and the by-name lookup
/// agree with `attribute_names` position for position, and every flag byte is
/// a code the decoder knows.
#[test]
fn lookup_matches_attribute_names_for_every_entity_of_every_schema() {
    for schema in ALL_SCHEMAS {
        let entities = declared(schema);
        assert!(entities.len() > 500, "{schema:?} declares {}", entities.len());
        for entity in entities {
            let names = schema.attribute_names(entity).expect("declared entity");
            let slots: Vec<AttrSlot> = schema.attributes(entity).expect("declared entity").collect();
            assert_eq!(slots.len(), names.len(), "{schema:?} {entity}");
            for (i, name) in names.iter().enumerate() {
                assert_eq!(slots[i].index, i, "{schema:?} {entity}.{name}");
                let found = schema.attribute(entity, name).expect(name);
                // A repeated name resolves to its first position.
                let first = names.iter().position(|n| n == name).unwrap();
                assert_eq!(found, slots[first], "{schema:?} {entity}.{name}");
                assert_eq!(schema.attribute(entity, &name.to_ascii_uppercase()), Some(found));
                assert_eq!(schema.attribute(entity, &name.to_ascii_lowercase()), Some(found));
            }
        }
    }
}

#[test]
fn flag_bytes_use_only_known_codes() {
    for schema in ALL_SCHEMAS {
        for entity in declared(schema) {
            let (_, flags) = schema.attribute_layout(entity).expect("declared entity");
            for flag in flags {
                assert_eq!(flag & 0xC0, 0, "{schema:?} {entity}: reserved bits set");
                assert!(AttrKind::from_code(flag & 0x0F).is_some(), "{schema:?} {entity}: kind {flag}");
            }
        }
    }
}

/// Facts read off the committed EXPRESS files (see also the codegen test,
/// which checks every flag against the parsed declaration).
#[test]
fn flags_report_kind_aggregate_and_optional() {
    let v = SchemaVersion::Ifc4;
    assert_eq!(v.attribute("IfcWall", "GlobalId"), slot(0, AttrKind::Text, false, false));
    assert_eq!(v.attribute("IFCWALL", "OwnerHistory"), slot(1, AttrKind::Ref, false, true));
    assert_eq!(v.attribute("IfcWall", "PredefinedType"), slot(8, AttrKind::Enum, false, true));
    assert_eq!(v.attribute("IfcCartesianPoint", "Coordinates"), slot(0, AttrKind::List, true, false));
    assert_eq!(v.attribute("IfcPolyline", "Points"), slot(0, AttrKind::RefList, true, false));
    assert_eq!(
        v.attribute("IfcRelDefinesByProperties", "RelatedObjects"),
        slot(4, AttrKind::RefList, true, false)
    );
    // A select with an inline-SET alternative may be written as a list.
    assert_eq!(
        v.attribute("IfcRelDefinesByProperties", "RelatingPropertyDefinition"),
        slot(5, AttrKind::Select, true, false)
    );
}

/// The flag really is per schema: IfcProject.UnitsInContext is mandatory in
/// IFC2X3 and OPTIONAL from IFC4.
#[test]
fn lookup_is_per_schema() {
    let units = |s: SchemaVersion| s.attribute("IfcProject", "UnitsInContext").expect("declared");
    assert!(!units(SchemaVersion::Ifc2x3).optional);
    assert_eq!(units(SchemaVersion::Ifc2x3).index, 8);
    assert!(units(SchemaVersion::Ifc4).optional);
    assert_eq!(units(SchemaVersion::Ifc4).index, 8);
}

/// IfcGridPlacement gained the inherited `PlacementRelTo` in IFC4X2, not
/// IFC4X1 (the `schema_layout` module doc said IFC4X1 before F3e-0a).
#[test]
fn grid_placement_gained_placement_rel_to_in_ifc4x2() {
    let rel_to = |s: SchemaVersion| s.attribute("IfcGridPlacement", "PlacementRelTo").map(|a| a.index);
    assert_eq!(rel_to(SchemaVersion::Ifc2x3), None);
    assert_eq!(rel_to(SchemaVersion::Ifc4), None);
    assert_eq!(rel_to(SchemaVersion::Ifc4x1), None);
    assert_eq!(rel_to(SchemaVersion::Ifc4x2), Some(0));
    assert_eq!(rel_to(SchemaVersion::Ifc4x3), Some(0));
}

#[test]
fn unknowns_are_explicit_none() {
    for schema in ALL_SCHEMAS {
        assert_eq!(schema.attribute("IfcNotAnEntity", "Name"), None);
        assert_eq!(schema.attribute("IfcWall", "NotAnAttribute"), None);
        assert_eq!(schema.attribute("", "Name"), None);
        assert!(schema.attributes("IfcNotAnEntity").is_none());
        // Dotless-i uppercases to ASCII `I`; the API is ASCII-only.
        assert_eq!(schema.attribute("\u{131}fcWall", "Name"), None);
        assert!(schema.attributes("\u{131}fcWall").is_none());
        // The shared registry lookup is ASCII-only too, not just this API.
        assert_eq!(schema.attribute_names("\u{131}fcWall"), None);
        assert!(schema.attribute_names("ifcwall").is_some());
    }
    // Declared by IFC2X3 only: absent from the later schemas, not an empty list.
    assert!(SchemaVersion::Ifc2x3.attributes("IfcDoorStyle").is_some());
    assert!(SchemaVersion::Ifc4x3.attributes("IfcDoorStyle").is_none());
    // A declared entity with no attributes is Some(empty), never None.
    assert_eq!(SchemaVersion::Ifc4.attributes("IfcRoot").map(|a| a.len()), Some(4));
}
