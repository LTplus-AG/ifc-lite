// SPDX-License-Identifier: MPL-2.0
//! An Add's optional string attributes: `LongName`, `Tag` and `ObjectType`
//! on an object, `Tag` and `ElementType` on a new type. Written where the
//! class has the attribute in the file's schema, refused where it does not.
//! Synthetic fixtures only.

use ifc_lite_core::{decode_ifc_string, entity_info_for_schema, EntityDecoder};

use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::test_fixtures::storey_with_typed_wall;
use crate::plan::types::*;

fn storey() -> Option<ObjectRef> {
    Some(ObjectRef::Id(70))
}

fn building() -> Option<ObjectRef> {
    Some(ObjectRef::Id(60))
}

/// The one refusal of a plan, and that it wrote nothing.
fn refusal(source: &[u8], plan: Vec<(ObjectRef, Disposition)>) -> String {
    let (out, report) = run(source, plan);
    assert_eq!((report.added, report.refusals.len()), (0, 1), "{:?}", report.refusals);
    let (untouched, _) = run(source, Vec::new());
    assert_eq!(out, untouched, "a refused Add leaves no trace");
    report.refusals[0].reason.clone()
}

#[test]
fn a_space_and_a_storey_carry_their_long_names() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let space = object(IfcClass::Space, gid(1), storey(), Representation::Extrusion(block(4.0, 3.0, 2.5))).with_name("1.01").with_long_name("Meeting room");
        let level = object(IfcClass::BuildingStorey, gid(2), building(), Representation::None).with_name("L2").with_long_name("Second floor");
        let (out, report) = run(&source, vec![add(space), add(level)]);
        assert_valid(&out, &report, schema);
        let (space, level) = (id_in(&out, gid(1)), id_in(&out, gid(2)));
        assert_eq!((attr(&out, schema, space, "Name"), attr(&out, schema, space, "LongName")), ("'1.01'".into(), "'Meeting room'".into()), "{schema}");
        assert_eq!(attr(&out, schema, level, "LongName"), "'Second floor'", "{schema}");
        assert_eq!(attr(&out, schema, space, "ObjectType"), "$", "{schema}: none given, none written");
    }
}

#[test]
fn an_element_carries_its_tag_and_object_type() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let wall = object(IfcClass::Wall, gid(3), storey(), Representation::Extrusion(block(4.0, 0.2, 3.0))).with_tag("3f2a-17").with_object_type("Partition 100");
        // USERDEFINED takes an ObjectType naming the kind. IfcSlab has a
        // PredefinedType in all three schemas, IfcWall not in IFC2X3.
        let slab = ClassSpec::new(IfcClass::Named("IfcSlab".into())).with_predefined_type("userdefined");
        let slab = NewObject::new(gid(4), slab, NewPlacement::new(IDENTITY)).with_container(ObjectRef::Id(70)).with_object_type("Ramp");
        let (out, report) = run(&source, vec![add(wall), add(slab)]);
        assert_valid(&out, &report, schema);
        let (wall, slab) = (id_in(&out, gid(3)), id_in(&out, gid(4)));
        assert_eq!((attr(&out, schema, wall, "Tag"), attr(&out, schema, wall, "ObjectType")), ("'3f2a-17'".into(), "'Partition 100'".into()), "{schema}");
        assert_eq!((attr(&out, schema, slab, "PredefinedType"), attr(&out, schema, slab, "ObjectType")), (".USERDEFINED.".into(), "'Ramp'".into()), "{schema}");
    }
}

#[test]
fn a_new_type_carries_its_tag_and_element_type() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let wall_type = NewType::new(ClassSpec::new(IfcClass::Named("IfcWallType".into())).with_predefined_type("USERDEFINED"))
            .with_name("Partition 100")
            .with_tag("wt-100")
            .with_element_type("Acoustic partition");
        let wall = object(IfcClass::Wall, gid(5), storey(), Representation::None).with_type(TypeLink::New(wall_type));
        // IFC2X3 has no IfcDoorType: its door is typed by an IfcDoorStyle,
        // which is not an element type and takes a Tag but no ElementType.
        let door_type = match schema {
            "IFC2X3" => NewType::new(IfcClass::Named("IfcDoorStyle".into())),
            _ => NewType::new(IfcClass::Named("IfcDoorType".into())).with_element_type("Fire door"),
        };
        let door = object(IfcClass::Door, gid(6), storey(), Representation::None).with_type(TypeLink::New(door_type.with_name("D").with_tag("dt-7")));
        let (out, report) = run(&source, vec![add(wall), add(door)]);
        assert_valid(&out, &report, schema);
        let rels = crate::relationships(&out);
        let (wall_type, door_type) = (rels.type_of[&id_in(&out, gid(5))], rels.type_of[&id_in(&out, gid(6))]);
        assert_eq!(type_in(&out, wall_type), "IFCWALLTYPE", "{schema}");
        assert_eq!(attr(&out, schema, wall_type, "PredefinedType"), ".USERDEFINED.", "{schema}");
        assert_eq!((attr(&out, schema, wall_type, "Tag"), attr(&out, schema, wall_type, "ElementType")), ("'wt-100'".into(), "'Acoustic partition'".into()), "{schema}");
        assert_eq!(attr(&out, schema, door_type, "Tag"), "'dt-7'", "{schema}");
        if schema != "IFC2X3" {
            assert_eq!(attr(&out, schema, door_type, "ElementType"), "'Fire door'", "{schema}");
        }
    }
}

#[test]
fn a_type_added_on_its_own_carries_its_element_type() {
    let source = storey_with_typed_wall("IFC4");
    let t = NewType::new(IfcClass::Named("IfcWallType".into())).with_global_id(gid(7)).with_name("W").with_element_type("Curtain");
    let (out, report) = run(&source, vec![add_type(t)]);
    assert_valid(&out, &report, "IFC4");
    assert_eq!(attr(&out, "IFC4", id_in(&out, gid(7)), "ElementType"), "'Curtain'");
}

/// Every schema that declares IfcDoorStyle gives it no ElementType: IFC2X3,
/// where it is the only door type, and IFC4, which keeps it beside
/// IfcDoorType. The value is refused there rather than dropped.
#[test]
fn an_element_type_on_a_door_style_is_refused() {
    let styled: Vec<&str> = SCHEMAS.into_iter().filter(|s| entity_info_for_schema(s, "IFCDOORSTYLE").is_some()).collect();
    assert!(styled.contains(&"IFC2X3"), "{styled:?}");
    for schema in styled {
        let source = storey_with_typed_wall(schema);
        let style = NewType::new(IfcClass::Named("IfcDoorStyle".into())).with_global_id(gid(8)).with_name("D").with_element_type("Fire door");
        assert_eq!(refusal(&source, vec![add_type(style)]), format!("IFCDOORSTYLE has no ElementType in {schema}"));
    }
}

#[test]
fn a_string_attribute_the_class_lacks_is_refused() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let wall = object(IfcClass::Wall, gid(9), storey(), Representation::None).with_long_name("Long");
        assert_eq!(refusal(&source, vec![add(wall)]), format!("IFCWALL has no LongName in {schema}"));
        let space = object(IfcClass::Space, gid(10), storey(), Representation::None).with_tag("S-1");
        assert_eq!(refusal(&source, vec![add(space)]), format!("IFCSPACE has no Tag in {schema}"));
    }
}

#[test]
fn a_userdefined_predefined_type_needs_its_kind_named() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let slab = ClassSpec::new(IfcClass::Named("IfcSlab".into())).with_predefined_type("USERDEFINED");
        let slab = NewObject::new(gid(11), slab, NewPlacement::new(IDENTITY)).with_container(ObjectRef::Id(70));
        assert_eq!(refusal(&source, vec![add(slab)]), "PredefinedType USERDEFINED needs an ObjectType naming the kind", "{schema}");
        let t = NewType::new(ClassSpec::new(IfcClass::Named("IfcWallType".into())).with_predefined_type("USERDEFINED")).with_global_id(gid(12)).with_name("W");
        assert_eq!(refusal(&source, vec![add_type(t.clone())]), "PredefinedType USERDEFINED needs an ElementType naming the kind", "{schema}");
        // An ObjectType on the occurrence does not name its new type's kind.
        let wall = object(IfcClass::Wall, gid(13), storey(), Representation::None).with_object_type("Partition").with_type(TypeLink::New(NewType { global_id: None, ..t }));
        assert_eq!(refusal(&source, vec![add(wall)]), "PredefinedType USERDEFINED needs an ElementType naming the kind", "{schema}");
    }
}

/// A blank ObjectType or ElementType names no kind.
#[test]
fn a_blank_kind_does_not_satisfy_userdefined() {
    let source = storey_with_typed_wall("IFC4");
    for blank in ["", "  "] {
        let slab = ClassSpec::new(IfcClass::Named("IfcSlab".into())).with_predefined_type("USERDEFINED");
        let slab = NewObject::new(gid(15), slab, NewPlacement::new(IDENTITY)).with_container(ObjectRef::Id(70)).with_object_type(blank);
        assert_eq!(refusal(&source, vec![add(slab)]), "PredefinedType USERDEFINED needs an ObjectType naming the kind", "{blank:?}");
        let t = NewType::new(ClassSpec::new(IfcClass::Named("IfcWallType".into())).with_predefined_type("USERDEFINED")).with_global_id(gid(16)).with_name("W").with_element_type(blank);
        assert_eq!(refusal(&source, vec![add_type(t)]), "PredefinedType USERDEFINED needs an ElementType naming the kind", "{blank:?}");
    }
}

/// Values go out as STEP strings: an apostrophe and a reverse solidus
/// doubled, anything outside printable ASCII as a `\X2\` directive, and the
/// decoder reads back what was given.
#[test]
fn special_characters_are_escaped() {
    let given = "Bob's \\ Küche\nNord";
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let space = object(IfcClass::Space, gid(14), storey(), Representation::None).with_long_name(given).with_object_type("€");
        let (out, report) = run(&source, vec![add(space)]);
        assert_valid(&out, &report, schema);
        let id = id_in(&out, gid(14));
        let written = attr(&out, schema, id, "LongName");
        assert_eq!(written, r"'Bob''s \\ K\X2\00FC\X0\che\X2\000A\X0\Nord'", "{schema}");
        let index = crate::plan::attrs::attribute_index(schema, "IFCSPACE", "LongName").unwrap();
        let decoded = EntityDecoder::new(&out).decode_by_id(id).unwrap();
        assert_eq!(decode_ifc_string(decoded.get_string(index).unwrap()), given, "{schema}");
        assert_eq!(attr(&out, schema, id, "ObjectType"), r"'\X2\20AC\X0\'", "{schema}");
    }
}
