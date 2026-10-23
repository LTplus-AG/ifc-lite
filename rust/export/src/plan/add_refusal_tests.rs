// SPDX-License-Identifier: MPL-2.0
//! Adds whose output would break a schema rule, and the references an Add
//! makes to objects the same plan replaces: each is either written validly
//! or refused whole.

use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::test_fixtures::{gid as fixture_gid, storey_with_headroom, storey_with_typed_wall};
use crate::plan::types::*;

fn storey() -> Option<ObjectRef> {
    Some(ObjectRef::Id(70))
}

fn refused(source: &[u8], obj: NewObject, expect: &str) {
    let (out, report) = run(source, vec![add(obj)]);
    assert_eq!(report.added, 0, "{expect}");
    assert_eq!(report.refusals.len(), 1, "{expect}: {:?}", report.refusals);
    assert!(report.refusals[0].reason.contains(expect), "{expect}: {}", report.refusals[0].reason);
    let (untouched, _) = run(source, Vec::new());
    assert_eq!(out, untouched, "a refused Add leaves no trace");
}

fn new_type(class: &str, predefined_type: Option<&str>) -> TypeLink {
    TypeLink::New(NewType {
        global_id: None,
        class: ClassSpec { class: IfcClass::Named(class.into()), predefined_type: predefined_type.map(Into::into) },
        name: Some("T".into()),
        psets: Vec::new(),
    })
}

/// A new door type with no predefined type still fills the slots IFC4 and
/// IFC4X3 declare mandatory, with NOTDEFINED.
#[test]
fn a_new_type_without_a_predefined_type_fills_its_mandatory_enums() {
    for schema in SCHEMAS {
        let class = if schema == "IFC2X3" { "IfcDoorStyle" } else { "IfcDoorType" };
        let mut door = object(IfcClass::Door, gid(1), storey(), Representation::None);
        door.type_link = Some(new_type(class, None));
        let (out, report) = run(&storey_with_typed_wall(schema), vec![add(door)]);
        assert_clean(&report, schema);
        let type_id = id_in(&out, gid(1).derive("type"));
        let text = String::from_utf8(out).unwrap();
        let line = text.lines().find(|l| l.starts_with(&format!("#{type_id}="))).unwrap();
        let unset = crate::plan::attrs::unset_required(schema, line);
        assert!(unset.is_empty(), "{schema}: {unset:?} in {line}");
        assert!(line.contains(".NOTDEFINED."), "{schema}: {line}");
    }
}

/// A product whose class has mandatory attributes an Add does not write is
/// refused rather than written with `$` there.
#[test]
fn a_class_with_mandatory_attributes_an_add_does_not_write_is_refused() {
    let source = storey_with_typed_wall("IFC4");
    refused(&source, object(IfcClass::Named("IfcGrid".into()), gid(2), storey(), Representation::None), "requires");
}

#[test]
fn a_userdefined_predefined_type_is_refused() {
    let mut wall = object(IfcClass::Wall, gid(3), storey(), Representation::None);
    wall.class.predefined_type = Some("userdefined".into());
    refused(&storey_with_typed_wall("IFC4"), wall, "USERDEFINED");
}

#[test]
fn a_type_that_is_not_a_product_type_is_refused() {
    let mut wall = object(IfcClass::Wall, gid(4), storey(), Representation::None);
    wall.type_link = Some(new_type("IfcTaskType", None));
    refused(&storey_with_typed_wall("IFC4"), wall, "not an IFCTYPEPRODUCT");
}

/// The GlobalId a new type derives from its occurrence must be free.
#[test]
fn a_new_type_whose_global_id_is_taken_is_refused() {
    let taken = object(IfcClass::Wall, gid(5).derive("type"), storey(), Representation::None);
    let mut wall = object(IfcClass::Wall, gid(5), storey(), Representation::None);
    wall.type_link = Some(new_type("IfcWallType", None));
    let (_, report) = run(&storey_with_typed_wall("IFC4"), vec![add(taken), add(wall)]);
    assert_eq!(report.added, 1, "{:?}", report.refusals);
    assert!(report.refusals[0].reason.contains("for the new type is already in use"), "{:?}", report.refusals);
}

/// An object added under the GlobalId of one this plan deletes is what a
/// later Add naming that GlobalId reaches.
#[test]
fn a_later_add_can_name_an_object_that_replaces_a_deleted_one() {
    let source = storey_with_typed_wall("IFC4");
    let reused = GlobalId(64);
    assert_eq!(reused.encode(), fixture_gid(10));
    let wall = object(IfcClass::Wall, reused, storey(), Representation::Extrusion(block(4.0, 0.2, 3.0)));
    let mut door = object(IfcClass::Door, gid(6), storey(), Representation::Extrusion(block(1.0, 0.2, 2.0)));
    door.opening = Some(NewOpening { host: ObjectRef::Guid(fixture_gid(10)), matrix: IDENTITY, shape: block(1.0, 0.4, 2.0) });
    let (_, report) = run(&source, vec![(ObjectRef::Guid(fixture_gid(10)), Disposition::Delete), add(wall), add(door)]);
    assert_clean(&report, "IFC4");
    assert_eq!(report.added, 2);
}

#[test]
fn a_negative_quantity_is_refused() {
    let mut wall = object(IfcClass::Wall, gid(7), storey(), Representation::None);
    wall.psets = vec![NewPropertySet {
        name: "Qto_WallBaseQuantities".into(),
        kind: PsetKind::Quantity,
        properties: vec![NewProperty { name: "Length".into(), value: PropertyValue::Measure { measure_type: "IfcLengthMeasure".into(), value: -3.0 }, unit: None }],
    }];
    refused(&storey_with_typed_wall("IFC4"), wall, "cannot be negative");
}

/// Values large enough that the degeneracy arithmetic overflows to NaN are
/// refused, not let through because NaN compares unequal to zero.
#[test]
fn degenerate_input_that_overflows_is_refused() {
    let source = storey_with_typed_wall("IFC4");
    let mut wall = object(IfcClass::Wall, gid(8), storey(), Representation::None);
    for row in 0..3 {
        wall.placement.matrix[row][0] = [1e200, 1e200, 0.0][row];
        wall.placement.matrix[row][2] = [1e200, 1e200, 0.0][row];
    }
    refused(&source, wall, "not a rotation");

    let collinear = Extrusion { profile: vec![[0.0, 0.0], [1e200, 1e200], [2e200, 2e200]], direction: [0.0, 0.0, 1.0], depth: 1.0 };
    refused(&source, object(IfcClass::Wall, gid(9), storey(), Representation::Extrusion(collinear)), "no area");

    let repeated = Extrusion { profile: vec![[0.0, 0.0], [0.0, 0.0], [1.0, 0.0], [1.0, 1.0]], direction: [0.0, 0.0, 1.0], depth: 1.0 };
    refused(&source, object(IfcClass::Wall, gid(10), storey(), Representation::Extrusion(repeated)), "repeats a point");
}

/// When writing the relationships runs out of ids, every Add that had
/// built is refused by name, not only the plan's first Add.
#[test]
fn an_exhausted_id_space_refuses_each_add_that_had_built() {
    let source = storey_with_headroom("IFC4", 11);
    let unknown = object(IfcClass::Named("IfcNoSuchThing".into()), gid(11), Some(ObjectRef::Id(70)), Representation::None);
    let wall = object(IfcClass::Wall, gid(12), Some(ObjectRef::Id(70)), Representation::None);
    let (_, report) = run(&source, vec![add(unknown), add(wall)]);
    assert_eq!(report.added, 0);
    let named: Vec<&ObjectRef> = report.refusals.iter().map(|r| &r.object).collect();
    assert_eq!(named, [&ObjectRef::Guid(gid(11).encode()), &ObjectRef::Guid(gid(12).encode())], "{:?}", report.refusals);
}

/// A PredefinedType outside the class's enumeration is refused, for an
/// object and for a new type; one inside it is written.
#[test]
fn a_predefined_type_outside_the_classs_enumeration_is_refused() {
    let source = storey_with_typed_wall("IFC4");
    let mut wall = object(IfcClass::Wall, gid(13), storey(), Representation::None);
    wall.class.predefined_type = Some("bogus".into());
    refused(&source, wall, "not a PredefinedType of IFCWALL");

    let mut wall = object(IfcClass::Wall, gid(14), storey(), Representation::None);
    wall.type_link = Some(new_type("IfcWallType", Some("bogus")));
    refused(&source, wall, "not a PredefinedType of IFCWALLTYPE");

    let mut wall = object(IfcClass::Wall, gid(15), storey(), Representation::None);
    wall.class.predefined_type = Some("partitioning".into());
    let (_, report) = run(&source, vec![add(wall)]);
    assert_clean(&report, "IFC4");
}

/// The enumeration is read by schema family, so an `IFC4X3_ADD2` label is
/// checked like `IFC4X3`.
#[test]
fn a_predefined_type_is_checked_under_an_addendum_schema_label() {
    let source = String::from_utf8(storey_with_typed_wall("IFC4X3")).unwrap().replace("'IFC4X3'", "'IFC4X3_ADD2'");
    assert!(source.contains("IFC4X3_ADD2"));
    let mut wall = object(IfcClass::Wall, gid(16), storey(), Representation::None);
    wall.class.predefined_type = Some("bogus".into());
    refused(source.as_bytes(), wall, "not a PredefinedType of IFCWALL");
}

/// Deleting a type's only occurrence would leave the type unreferenced, but
/// an Add in the same plan typed by it keeps it.
#[test]
fn an_add_keeps_the_type_its_replaced_occurrence_left_behind() {
    for schema in SCHEMAS {
        let mut wall = object(IfcClass::Wall, gid(17), storey(), Representation::None);
        wall.type_link = Some(TypeLink::Existing(ObjectRef::Id(40)));
        let (out, report) = run(&storey_with_typed_wall(schema), vec![(ObjectRef::Id(10), Disposition::Delete), add(wall)]);
        assert_clean(&report, schema);
        assert_eq!(report.added, 1, "{schema}");
        assert_eq!(type_in(&out, 40), "IFCWALLTYPE", "{schema}: the type survives");
    }
}

/// An occurrence is typed by its own class's type where the schema names one.
#[test]
fn a_door_typed_by_a_wall_type_is_refused() {
    let mut door = object(IfcClass::Door, gid(18), storey(), Representation::None);
    door.type_link = Some(TypeLink::Existing(ObjectRef::Id(40)));
    refused(&storey_with_typed_wall("IFC4"), door, "typed by an IFCDOORTYPE");
}

/// A new building is aggregated into the project.
#[test]
fn a_new_building_can_be_aggregated_into_the_project() {
    for schema in SCHEMAS {
        let building = object(IfcClass::Named("IfcBuilding".into()), gid(19), Some(ObjectRef::Id(1)), Representation::None);
        let (out, report) = run(&storey_with_typed_wall(schema), vec![add(building)]);
        assert_clean(&report, schema);
        assert_eq!(report.added, 1, "{schema}");
        let id = id_in(&out, gid(19));
        let text = String::from_utf8_lossy(&out);
        let member = |l: &str| ["(", ","].iter().any(|open| [")", ","].iter().any(|close| l.contains(&format!("{open}#{id}{close}"))));
        let aggregated = text.lines().any(|l| l.contains("IFCRELAGGREGATES(") && l.contains(",#1,") && member(l));
        assert!(aggregated, "{schema}: the building is aggregated into project #1");
    }
}

/// Only a site or building goes straight under the project.
#[test]
fn a_storey_cannot_be_aggregated_into_the_project() {
    let storey = object(IfcClass::BuildingStorey, gid(20), Some(ObjectRef::Id(1)), Representation::None);
    refused(&storey_with_typed_wall("IFC4"), storey, "not a spatial element");
}

/// A new type is paired with its occurrence's class like an existing one.
#[test]
fn a_door_with_a_new_wall_type_is_refused() {
    let mut door = object(IfcClass::Door, gid(21), storey(), Representation::None);
    door.type_link = Some(new_type("IfcWallType", None));
    refused(&storey_with_typed_wall("IFC4"), door, "typed by an IFCDOORTYPE");
}

/// A new type's derived GlobalId must not already be in the source.
#[test]
fn a_new_type_whose_derived_global_id_is_in_the_source_is_refused() {
    let mut wall = object(IfcClass::Wall, gid(23), storey(), Representation::None);
    wall.type_link = Some(new_type("IfcWallType", None));
    let taken = gid(23).derive("type").encode();
    let source = String::from_utf8(storey_with_typed_wall("IFC4")).unwrap().replace(&fixture_gid(40), &taken);
    refused(source.as_bytes(), wall, "for the new type is already in use");
}

/// A profile whose edges cross is refused, not written as a solid (#8080
/// review).
#[test]
fn a_self_crossing_profile_is_refused() {
    let bowtie = Extrusion { profile: vec![[0.0, 0.0], [3.0, 2.0], [0.0, 2.0], [2.0, 0.0]], direction: [0.0, 0.0, 1.0], depth: 1.0 };
    let wall = object(IfcClass::Wall, gid(24), storey(), Representation::Extrusion(bowtie));
    refused(&storey_with_typed_wall("IFC4"), wall, "crosses itself");
}

/// A measure the schema does not declare, or one that is not a number, is
/// refused (#8080 review).
#[test]
fn a_property_measure_must_be_a_declared_number() {
    for (measure, expect) in [("IfcBogusMeasure", "IfcBogusMeasure is not an IFC measure"), ("IfcDescriptiveMeasure", "not a number")] {
        let mut wall = object(IfcClass::Wall, gid(25), storey(), Representation::None);
        wall.psets = vec![NewPropertySet {
            name: "Pset_Test".into(),
            kind: PsetKind::Property,
            properties: vec![NewProperty { name: "P".into(), value: PropertyValue::Measure { measure_type: measure.into(), value: 1.0 }, unit: None }],
        }];
        refused(&storey_with_typed_wall("IFC4"), wall, expect);
    }
}

/// Deleting the only object that uses the file's owner history does not
/// leave an Add naming a removed record (#8080 review).
#[test]
fn an_add_keeps_the_owner_history_a_delete_would_take() {
    for schema in SCHEMAS {
        let source = String::from_utf8(storey_with_typed_wall(schema)).unwrap();
        let wall_head = format!("#10=IFCWALL('{}',$,", fixture_gid(10));
        assert!(source.contains(&wall_head), "{schema}: fixture wall");
        let source = source
            .replace(&wall_head, &format!("#10=IFCWALL('{}',#5,", fixture_gid(10)))
            .replace("ENDSEC;\nEND-ISO", "#5=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);\nENDSEC;\nEND-ISO");
        let wall = object(IfcClass::Wall, gid(26), storey(), Representation::None);
        let (out, report) = run(source.as_bytes(), vec![(ObjectRef::Id(10), Disposition::Delete), add(wall)]);
        assert_clean(&report, schema);
        assert_eq!(type_in(&out, 5), "IFCOWNERHISTORY", "{schema}: the file's owner history stays");
        let line = String::from_utf8_lossy(&out).lines().find(|l| l.starts_with(&format!("#{}=", id_in(&out, gid(26))))).unwrap().to_string();
        assert!(line.contains(",#5,"), "{schema}: the new wall names it: {line}");
    }
}

/// A measure only a later schema declares is refused in an IFC2X3 file
/// (#8080 review).
#[test]
fn a_property_measure_must_be_declared_by_the_files_schema() {
    let mut wall = object(IfcClass::Wall, gid(27), storey(), Representation::None);
    wall.psets = vec![NewPropertySet {
        name: "Pset_Test".into(),
        kind: PsetKind::Property,
        properties: vec![NewProperty { name: "P".into(), value: PropertyValue::Measure { measure_type: "IfcNonNegativeLengthMeasure".into(), value: 1.0 }, unit: None }],
    }];
    refused(&storey_with_typed_wall("IFC2X3"), wall, "not an IFC measure in IFC2X3");
}

/// A type with its own GlobalId is created by one `TypeLink::New`; a later
/// Add names it with `TypeLink::Existing` by that GlobalId (#8087 review).
#[test]
fn a_later_add_names_a_type_an_earlier_add_created() {
    for schema in SCHEMAS {
        let type_id = gid(40);
        let mut first = object(IfcClass::Wall, gid(41), storey(), Representation::None);
        first.type_link = Some(TypeLink::New(NewType {
            global_id: Some(type_id),
            class: ClassSpec { class: IfcClass::Named("IfcWallType".into()), predefined_type: None },
            name: Some("T".into()),
            psets: Vec::new(),
        }));
        let mut second = object(IfcClass::Wall, gid(42), storey(), Representation::None);
        second.type_link = Some(TypeLink::Existing(ObjectRef::Guid(type_id.encode())));
        let (out, report) = run(&storey_with_typed_wall(schema), vec![add(first), add(second)]);
        assert_clean(&report, schema);
        assert_eq!(report.added, 2, "{schema}");
        assert_eq!(type_in(&out, id_in(&out, type_id)), "IFCWALLTYPE", "{schema}: one new type");
    }
}
