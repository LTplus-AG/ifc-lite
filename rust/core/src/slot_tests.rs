// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{kind, SchemaSlot, Slot, ABSENT};
use crate::attribute_slot::tests::{declared, ALL_SCHEMAS};
use crate::generated::schema_registry::SchemaVersion;
use crate::generated::slots as gen;
use crate::generated::slots_table::table;
use crate::{slot, DecodedEntity, EntityDecoder};
use std::collections::{HashMap, HashSet};

/// How a generated slot lays out, as the tests read it back from the consts.
pub(crate) enum Shape {
    Fixed(usize),
    Moving([u8; 5]),
}

/// One generated slot, bound to its const (see `generated::slots::table`).
pub(crate) struct Row {
    pub entity: &'static str,
    pub attribute: &'static str,
    pub kind: &'static str,
    pub shape: Shape,
}

fn kind_name<K>() -> &'static str {
    std::any::type_name::<K>().rsplit("::").next().unwrap_or("")
}

pub(crate) fn fixed<K>(entity: &'static str, attribute: &'static str, slot: Slot<K>) -> Row {
    Row { entity, attribute, kind: kind_name::<K>(), shape: Shape::Fixed(slot.index()) }
}

pub(crate) fn moving<K>(entity: &'static str, attribute: &'static str, slot: SchemaSlot<K>) -> Row {
    Row { entity, attribute, kind: kind_name::<K>(), shape: Shape::Moving(slot.by_schema) }
}

const RENAMES: &str = include_str!("../../../packages/codegen/schemas/attribute-renames.json");

/// The committed rename table, read independently of the generator.
struct Renames {
    /// (canonical, aliases, entities)
    rows: Vec<(String, Vec<String>, Vec<String>)>,
    omit: HashSet<(String, String)>,
}

fn renames() -> Renames {
    let json: serde_json::Value = serde_json::from_str(RENAMES).unwrap();
    let strings = |v: &serde_json::Value| -> Vec<String> {
        v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
    };
    let rows = json["renames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["name"].as_str().unwrap().to_string(), strings(&r["aliases"]), strings(&r["entities"])))
        .collect();
    let omit = json["omit"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["entity"].as_str().unwrap().to_string(), r["attribute"].as_str().unwrap().to_string()))
        .collect();
    Renames { rows, omit }
}

impl Renames {
    /// Every spelling of `attribute` on `entity`: itself plus applicable aliases.
    fn spellings(&self, entity: &str, attribute: &str) -> Vec<String> {
        let mut out = vec![attribute.to_string()];
        for (name, aliases, entities) in &self.rows {
            let applies = entities.iter().any(|root| {
                entity == root || ALL_SCHEMAS.iter().any(|schema| schema.is_subtype_of(entity, root))
            });
            if applies && name == attribute {
                out.extend(aliases.iter().cloned());
            }
        }
        out
    }
}

fn names_in(schema: SchemaVersion, entity: &str) -> Option<&'static [&'static str]> {
    schema.attribute_names(entity)
}

/// Re-derive the classification of every generated slot from the five
/// registries' `attribute_names`, without the generator's code: each position
/// a slot claims must hold the attribute (or a listed same-position rename),
/// and a slot may only claim "absent" where no spelling of it is declared.
#[test]
fn every_slot_matches_every_schemas_attribute_names() {
    let renames = renames();
    let mut moving_rows = 0usize;
    for Row { entity, attribute, kind: _, shape } in table() {
        let spellings = renames.spellings(entity, attribute);
        let matches = |name: &str| spellings.iter().any(|s| s == name);
        let mut claimed: Vec<Option<usize>> = Vec::new();
        for (ordinal, schema) in ALL_SCHEMAS.into_iter().enumerate() {
            let names = names_in(schema, entity);
            let claim = match &shape {
                Shape::Fixed(index) => Some(*index),
                Shape::Moving(by) if by[ordinal] == ABSENT => None,
                Shape::Moving(by) => Some(by[ordinal] as usize),
            };
            let Some(names) = names else {
                assert!(
                    !matches!(&shape, Shape::Moving(by) if by[ordinal] != ABSENT),
                    "{entity}.{attribute}: claims a position in {schema:?}, which does not declare it"
                );
                continue;
            };
            claimed.push(claim);
            let present = names.iter().any(|n| matches(n));
            match claim {
                Some(index) if index < names.len() => assert!(
                    matches(names[index]),
                    "{entity}.{attribute} at {index} in {schema:?} is {:?}",
                    names[index]
                ),
                // Past the end of the record: only legitimate when the
                // attribute is not declared there at all.
                Some(index) => assert!(
                    !present,
                    "{entity}.{attribute} claims trailing {index} in {schema:?} but it is declared"
                ),
                None => assert!(
                    !present,
                    "{entity}.{attribute} claims absent in {schema:?} but it is declared at {:?}",
                    names.iter().position(|n| matches(n))
                ),
            }
        }
        if matches!(shape, Shape::Moving(_)) {
            moving_rows += 1;
            // A moving slot must actually move: more than one distinct claim
            // among the schemas that declare the entity.
            let distinct: HashSet<_> = claimed.iter().collect();
            assert!(distinct.len() > 1, "{entity}.{attribute} is moving but every schema agrees");
        }
    }
    assert!(moving_rows > 100, "anti-vacuity: only {moving_rows} moving slots");
}

/// The other direction: every declared (entity, attribute, position) of every
/// schema is covered by exactly one generated slot that resolves to that
/// position in that schema.
#[test]
fn every_declared_attribute_has_a_slot_at_its_position() {
    let renames = renames();
    // `declared` names are the keywords (upper case); rows carry the EXPRESS spelling.
    let mut by_entity: HashMap<String, Vec<&Row>> = HashMap::new();
    let rows = table();
    for row in &rows {
        by_entity.entry(row.entity.to_ascii_uppercase()).or_default().push(row);
    }
    let mut checked = 0usize;
    let mut missing_entities = Vec::new();
    for (ordinal, schema) in ALL_SCHEMAS.into_iter().enumerate() {
        for entity in declared(schema) {
            let Some(slots) = by_entity.get(&entity.to_ascii_uppercase()) else {
                // An entity without attributes has no slots; any other must.
                if !names_in(schema, entity).unwrap().is_empty() {
                    missing_entities.push(format!("{entity} ({schema:?})"));
                }
                continue;
            };
            for (index, name) in names_in(schema, entity).unwrap().iter().enumerate() {
                let express = slots[0].entity;
                if renames.omit.contains(&(express.to_string(), name.to_string())) {
                    continue;
                }
                let covering = slots
                    .iter()
                    .filter(|row| {
                        let at = match row.shape {
                            Shape::Fixed(i) => Some(i),
                            Shape::Moving(by) => (by[ordinal] != ABSENT).then_some(by[ordinal] as usize),
                        };
                        at == Some(index) && renames.spellings(express, row.attribute).iter().any(|s| s == name)
                    })
                    .count();
                assert_eq!(covering, 1, "{entity}.{name} at {index} in {schema:?}");
                checked += 1;
            }
        }
    }
    assert!(missing_entities.is_empty(), "declared entities without slots: {missing_entities:?}");
    assert!(checked > 20_000, "anti-vacuity: only {checked} (schema, entity, attribute) triples");
}

/// A slot's kind is the registry's kind at that position in the newest schema
/// that has it (or Select when the schemas disagree).
#[test]
fn slot_kinds_match_the_attribute_flags() {
    for Row { entity, attribute, kind, shape } in table() {
        let allowed = |schema: SchemaVersion, index: usize| {
            let slot = schema.attributes(entity)?.nth(index)?;
            Some(format!("{:?}", slot.kind))
        };
        let positions: Vec<(SchemaVersion, usize)> = ALL_SCHEMAS
            .into_iter()
            .enumerate()
            .filter_map(|(ordinal, schema)| match shape {
                Shape::Fixed(i) => Some((schema, i)),
                Shape::Moving(by) => (by[ordinal] != ABSENT).then_some((schema, by[ordinal] as usize)),
            })
            .collect();
        let kinds: HashSet<String> = positions.iter().filter_map(|&(s, i)| allowed(s, i)).collect();
        if kinds.len() == 1 {
            assert!(
                kinds.contains(kind),
                "{entity}.{attribute} is {kind} but the registries say {kinds:?}"
            );
        } else {
            assert!(
                kinds.is_empty() || kind == "Select",
                "{entity}.{attribute} differs across schemas ({kinds:?}) so it must be Select, not {kind}"
            );
        }
    }
}

#[test]
fn the_positions_the_campaign_depends_on() {
    use SchemaVersion::*;
    // Stable slots are consts.
    const UNITS: usize = slot::IfcProject::UNITS_IN_CONTEXT.index();
    assert_eq!(UNITS, 8);
    assert_eq!(slot::IfcWall::OBJECT_PLACEMENT.index(), 5);
    assert_eq!(slot::IfcWallStandardCase::REPRESENTATION.index(), 6);
    assert_eq!(slot::IfcProductDefinitionShape::REPRESENTATIONS.index(), 2);
    // IfcLinearPlacement: PlacementRelTo is stable; the rest moved in 4X3.
    assert_eq!(slot::IfcLinearPlacement::PLACEMENT_REL_TO.index(), 0);
    let rel = slot::IfcLinearPlacement::RELATIVE_PLACEMENT;
    let pos = slot::IfcLinearPlacement::CARTESIAN_POSITION;
    for (schema, relative, cartesian) in [
        (Ifc2x3, None, None),
        (Ifc4, None, None),
        (Ifc4x1, None, Some(3)),
        (Ifc4x2, None, Some(4)),
        (Ifc4x3, Some(1), Some(2)),
    ] {
        assert_eq!(rel.at(schema).map(Slot::index), relative, "{schema:?}");
        assert_eq!(pos.at(schema).map(Slot::index), cartesian, "{schema:?}");
    }
    // IfcAlignment.Axis exists in IFC4X1/4X2 only; PredefinedType moved to 7.
    let axis = slot::IfcAlignment::AXIS;
    let predefined = slot::IfcAlignment::PREDEFINED_TYPE;
    for (schema, axis_at, predefined_at) in
        [(Ifc4, None, None), (Ifc4x1, Some(7), Some(8)), (Ifc4x2, Some(7), Some(8)), (Ifc4x3, None, Some(7))]
    {
        assert_eq!(axis.at(schema).map(Slot::index), axis_at, "{schema:?}");
        assert_eq!(predefined.at(schema).map(Slot::index), predefined_at, "{schema:?}");
    }
    // A semantic replacement is not a rename: IfcSpace.PredefinedType is absent in IFC2X3.
    assert!(slot::IfcSpace::PREDEFINED_TYPE.at(Ifc2x3).is_none());
    assert_eq!(slot::IfcSpace::PREDEFINED_TYPE.at(Ifc4).map(Slot::index), Some(9));
    assert_eq!(slot::IfcSpace::INTERIOR_OR_EXTERIOR_SPACE.at(Ifc2x3).map(Slot::index), Some(9));
    // IfcGridPlacement: PlacementRelTo arrived in IFC4X2, shifting the others.
    assert_eq!(slot::IfcGridPlacement::PLACEMENT_LOCATION.at(Ifc4).map(Slot::index), Some(0));
    assert_eq!(slot::IfcGridPlacement::PLACEMENT_LOCATION.at(Ifc4x3).map(Slot::index), Some(1));
    // A same-position rename shares one slot: IfcSurfaceTexture.Mode was TextureType.
    assert_eq!(slot::IfcImageTexture::MODE.index(), 2);
    assert_eq!(slot::IfcPerson::IDENTIFICATION.index(), 0);
}

fn entity(content: &str, id: u32) -> DecodedEntity {
    EntityDecoder::new(content).decode_by_id(id).unwrap()
}

#[test]
fn typed_accessors_read_the_value_at_the_slot() {
    let content = "#1=IFCPROJECT('g',$,'P',$,$,$,$,(#7,#8),#9);\n\
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\n\
#3=IFCPROPERTYSINGLEVALUE('N',$,IFCLENGTHMEASURE(2.5),$);\n\
#4=IFCRELDEFINESBYPROPERTIES('r',$,$,$,(#1),#5);\n\
#5=IFCMAPPEDITEM(#1,#2);\n\
#6=IFCSTRUCTURALCURVEMEMBER('m',$,$,$,$,$,$,.RIGID_JOINED_MEMBER.,#1);\n";
    let project = entity(content, 1);
    assert_eq!(project.string_at(slot::IfcProject::NAME), Some("P"));
    assert_eq!(project.ref_at(slot::IfcProject::UNITS_IN_CONTEXT), Some(9));
    assert_eq!(
        project.ref_list_at(slot::IfcProject::REPRESENTATION_CONTEXTS),
        Some(vec![7, 8]),
        "ref_list_at is get_refs"
    );
    assert_eq!(project.ref_list_at(slot::IfcProject::REPRESENTATION_CONTEXTS), project.get_refs(7));
    assert_eq!(project.ref_at(slot::IfcProject::OWNER_HISTORY), None, "$ reads as None");
    assert!(project.attr(slot::IfcProject::OWNER_HISTORY).is_some_and(|v| v.is_null()));

    let unit = entity(content, 2);
    assert_eq!(unit.enum_at(slot::IfcSIUnit::UNIT_TYPE), Some("LENGTHUNIT"));
    assert_eq!(unit.enum_at(slot::IfcSIUnit::PREFIX), Some("MILLI"));

    let single = entity(content, 3);
    assert_eq!(single.string_at(slot::IfcPropertySingleValue::NAME), Some("N"));
    let nominal = single.attr(slot::IfcPropertySingleValue::NOMINAL_VALUE).unwrap();
    assert_eq!(nominal.as_float(), Some(2.5), "a typed wrapper is the value's problem, not the slot's");

    let member = entity(content, 6);
    assert_eq!(member.enum_at(slot::IfcStructuralCurveMember::PREDEFINED_TYPE), Some("RIGID_JOINED_MEMBER"));
}

#[test]
fn logical_ints_and_computed_positions() {
    let content = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.)),$);\n\
#2=IFCTRIANGULATEDFACESET(#1,$,.T.,((1,2,3)),$);\n\
#3=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);\n\
#4=IFCTRIANGULATEDFACESET(#1,$,.U.,((1,2,3)),$);\n\
#5=IFCRELNESTS('g',$,$,$,#1,(#2,#3));\n";
    assert_eq!(entity(content, 2).logical_at(slot::IfcTriangulatedFaceSet::CLOSED), Some(true));
    assert_eq!(entity(content, 3).logical_at(slot::IfcTriangulatedFaceSet::CLOSED), Some(false));
    assert_eq!(entity(content, 4).logical_at(slot::IfcTriangulatedFaceSet::CLOSED), None, ".U. is unknown");
    let faces = entity(content, 2);
    assert_eq!(faces.list_at(slot::IfcTriangulatedFaceSet::COORD_INDEX).map(<[_]>::len), Some(1));
    // A computed usize still reads, for generic walkers.
    let index: usize = 3;
    assert_eq!(faces.ref_at(0usize), Some(1));
    assert_eq!(faces.list_at(index).map(<[_]>::len), Some(1));
    assert!(faces.attr(index).is_some());
    // A Select slot fits any kind.
    let nested: Slot<kind::Select> = Slot::new(0, 0);
    assert_eq!(faces.ref_at(nested), Some(1));
}

#[test]
fn a_schema_slot_resolves_against_the_declared_schema() {
    fn source(schema: &str) -> String {
        format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n")
    }
    let axis = slot::IfcAlignment::AXIS;
    let cartesian = slot::IfcLinearPlacement::CARTESIAN_POSITION;
    for (schema, axis_at, cartesian_at) in [
        ("IFC4X1", Some(7), Some(3)),
        ("IFC4X2", Some(7), Some(4)),
        ("IFC4X3_ADD2", None, Some(2)),
        ("IFC4", None, None),
        // Undeclared or unknown reads as IFC4X3 (D54).
        ("NOT_A_SCHEMA", None, Some(2)),
    ] {
        let content = source(schema);
        let mut decoder = EntityDecoder::new(&content);
        assert_eq!(decoder.slot(axis).map(Slot::index), axis_at, "{schema}");
        assert_eq!(decoder.slot(cartesian).map(Slot::index), cartesian_at, "{schema}");
    }
    let mut headerless = EntityDecoder::new("#1=IFCPROJECT('g',$,$,$,$,$,$,$,$);");
    assert_eq!(headerless.slot(cartesian).map(Slot::index), Some(2));
}

/// `slot_or` trusts the declared schema where it declares the entity, and
/// reads a file whose schema predates the entity with the named fallback.
#[test]
fn slot_or_falls_back_only_when_the_declared_schema_predates_the_entity() {
    fn source(schema: &str) -> String {
        format!("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n")
    }
    let cartesian = slot::IfcLinearPlacement::CARTESIAN_POSITION;
    let axis = slot::IfcAlignment::AXIS;
    for (schema, linear, alignment) in [
        // IFC2X3 and IFC4 declare neither entity: mislabelled exports.
        ("IFC2X3", Some(2), Some(7)),
        ("IFC4", Some(2), Some(7)),
        // Declared: the schema's own layout, no fallback.
        ("IFC4X1", Some(3), Some(7)),
        ("IFC4X2", Some(4), Some(7)),
        ("IFC4X3_ADD2", Some(2), None),
        // An unknown label reads as IFC4X3, which declares both.
        ("NOT_A_SCHEMA", Some(2), None),
    ] {
        let content = source(schema);
        let mut decoder = EntityDecoder::new(&content);
        let linear_at = decoder.slot_or(cartesian, SchemaVersion::Ifc4x3).map(Slot::index);
        let axis_at = decoder.slot_or(axis, SchemaVersion::Ifc4x1).map(Slot::index);
        assert_eq!((linear_at, axis_at), (linear, alignment), "{schema}");
    }
    assert!(!cartesian.entity_declared_in(SchemaVersion::Ifc4));
    assert!(cartesian.entity_declared_in(SchemaVersion::Ifc4x1));
    assert!(slot::IfcAlignment::PREDEFINED_TYPE.entity_declared_in(SchemaVersion::Ifc4x3));
}

/// Debug builds assert the entity is the slot's owner or a subtype of it.
#[test]
fn a_subtype_reads_its_supertypes_slots() {
    let content = "#1=IFCWALLSTANDARDCASE('g',$,$,$,$,#5,#6,$,.SOLIDWALL.);\n";
    let wall = entity(content, 1);
    assert_eq!(wall.ref_at(slot::IfcWall::OBJECT_PLACEMENT), Some(5));
    assert_eq!(wall.ref_at(slot::IfcProduct::REPRESENTATION), Some(6));
    assert_eq!(wall.ref_at(slot::IfcElement::OBJECT_PLACEMENT), Some(5));
}

#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "belongs to IFCWALL")]
fn a_slot_read_from_the_wrong_entity_panics_in_debug_builds() {
    let point = entity("#1=IFCCARTESIANPOINT((0.,0.,0.));", 1);
    let _ = point.list_at(slot::IfcWall::OBJECT_PLACEMENT.into_list());
}

impl Slot<kind::Ref> {
    /// Test-only: the same position as a different kind, to reach the owner
    /// assertion through an accessor that would otherwise reject the kind.
    fn into_list(self) -> Slot<kind::List> {
        Slot::new(self.index() as u8, gen::IfcWall::IFC_TYPE.id())
    }
}

#[test]
fn schema_slot_is_const_constructible() {
    const AT: Option<Slot<kind::Ref>> = slot::IfcLinearPlacement::CARTESIAN_POSITION.at(SchemaVersion::Ifc4x2);
    assert_eq!(AT.map(Slot::index), Some(4));
    let _: SchemaSlot<kind::Enum> = slot::IfcAlignment::PREDEFINED_TYPE;
}
