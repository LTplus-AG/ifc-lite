// SPDX-License-Identifier: MPL-2.0
//! Disposition::Add: construction, relationships, atomic refusal, and
//! determinism. Geometry-specific tests live in `add_geometry_tests.rs`.

use ifc_lite_core::EntityDecoder;

use crate::plan::add_assoc_types::{NewProperty, NewPropertySet, PropertyValue};
use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::test_fixtures::{gid as fixture_gid, storey_with_headroom, storey_with_typed_wall};
use crate::plan::types::*;

fn storey() -> Option<ObjectRef> {
    Some(ObjectRef::Id(70))
}

#[test]
fn every_class_and_representation_tier_validates_in_every_schema() {
    let classes = [
        (IfcClass::Wall, ObjectRef::Id(70)),
        (IfcClass::Door, ObjectRef::Id(70)),
        (IfcClass::Window, ObjectRef::Id(70)),
        (IfcClass::BuildingElementProxy, ObjectRef::Id(70)),
        (IfcClass::Named("IfcSlab".into()), ObjectRef::Id(70)),
        (IfcClass::Space, ObjectRef::Id(70)),
        (IfcClass::BuildingStorey, ObjectRef::Id(60)),
    ];
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        for (n, (class, container)) in classes.iter().enumerate() {
            let reps = [Representation::None, Representation::Extrusion(block(1.0, 0.2, 2.0)), Representation::Mesh(tetrahedron())];
            for (r, rep) in reps.into_iter().enumerate() {
                let what = format!("{schema} {class:?} rep {r}");
                let g = gid((n * 10 + r) as u128);
                let (out, report) = run(&source, vec![add(object(class.clone(), g, Some(container.clone()), rep))]);
                assert_clean(&report, &what);
                assert_eq!(report.added, 1, "{what}");
                let id = id_in(&out, g);
                let line = type_in(&out, id);
                assert_eq!(line, class.keyword(), "{what}");
            }
        }
    }
}

#[test]
fn an_added_wall_extends_the_storeys_containment_and_the_types_relationship() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let mut wall = object(IfcClass::Wall, gid(1), storey(), Representation::Extrusion(block(4.0, 0.2, 3.0)));
        wall.type_link = Some(TypeLink::Existing(ObjectRef::Guid(fixture_gid(40))));
        let (out, report) = run(&source, vec![add(wall)]);
        assert_clean(&report, schema);
        let new_wall = id_in(&out, gid(1));

        // Read back through the engine's own relationship resolver.
        let rels = crate::relationships(&out);
        let children = &rels.spatial_children[&70];
        assert!(children.contains(&10) && children.contains(&new_wall), "{schema}: {children:?}");
        assert_eq!(rels.type_of.get(&new_wall), Some(&40), "{schema}");
        assert_eq!(count(&out, "IFCRELCONTAINEDINSPATIALSTRUCTURE"), 1, "{schema}: extended, not duplicated");
        assert_eq!(count(&out, "IFCRELDEFINESBYTYPE"), 1, "{schema}: extended, not duplicated");
    }
}

#[test]
fn a_door_fills_a_new_opening_cut_in_an_existing_wall() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let mut door = object(IfcClass::Door, gid(2), storey(), Representation::Extrusion(block(0.9, 0.2, 2.1)));
        door.opening = Some(NewOpening { host: ObjectRef::Id(10), matrix: IDENTITY, shape: block(0.9, 0.2, 2.1) });
        let (out, report) = run(&source, vec![add(door)]);
        assert_clean(&report, schema);
        let door_id = id_in(&out, gid(2));
        let opening_id = id_in(&out, gid(2).derive("opening"));

        let mut decoder = EntityDecoder::new(&out);
        let voids = id_in(&out, gid(2).derive("rel/voids"));
        let voids = decoder.decode_by_id(voids).unwrap();
        assert_eq!(voids.get_ref(4), Some(10), "{schema}: RelatingBuildingElement is the host wall");
        assert_eq!(voids.get_ref(5), Some(opening_id), "{schema}: RelatedOpeningElement");
        let fills = id_in(&out, gid(2).derive("rel/fills"));
        let fills = decoder.decode_by_id(fills).unwrap();
        assert_eq!(fills.get_ref(4), Some(opening_id), "{schema}: RelatingOpeningElement");
        assert_eq!(fills.get_ref(5), Some(door_id), "{schema}: RelatedBuildingElement is the door");
        let opening = decoder.decode_by_id(opening_id).unwrap();
        let op_placement = decoder.decode_by_id(opening.get_ref(5).unwrap()).unwrap();
        let door_placement = decoder.decode_by_id(door_id).unwrap().get_ref(5).unwrap();
        assert_eq!(op_placement.get_ref(0), Some(door_placement), "{schema}: opening placed in the door's frame");
    }
}

#[test]
fn a_window_without_a_host_gets_no_opening_and_a_wall_with_a_host_gets_no_fill() {
    let source = storey_with_typed_wall("IFC4");
    let window = object(IfcClass::Window, gid(3), storey(), Representation::None);
    let mut niche = object(IfcClass::Wall, gid(4), storey(), Representation::None);
    niche.opening = Some(NewOpening { host: ObjectRef::Id(10), matrix: IDENTITY, shape: block(0.5, 0.2, 0.5) });
    let (out, report) = run(&source, vec![add(window), add(niche)]);
    assert_clean(&report, "IFC4");
    assert_eq!(count(&out, "IFCOPENINGELEMENT"), 1);
    assert_eq!(count(&out, "IFCRELVOIDSELEMENT"), 1);
    assert_eq!(count(&out, "IFCRELFILLSELEMENT"), 0, "only a door or window fills an opening");
}

#[test]
fn a_named_parent_placement_is_used_instead_of_the_containers() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let mut by_product = object(IfcClass::Window, gid(5), storey(), Representation::None);
        by_product.placement.relative_to = Some(ObjectRef::Guid(fixture_gid(10)));
        let mut by_placement = object(IfcClass::Window, gid(6), storey(), Representation::None);
        by_placement.placement.relative_to = Some(ObjectRef::Id(63));
        let (out, report) = run(&source, vec![add(by_product), add(by_placement)]);
        assert_clean(&report, schema);
        let mut decoder = EntityDecoder::new(&out);
        for (g, parent) in [(gid(5), 20), (gid(6), 63)] {
            let placement = decoder.decode_by_id(id_in(&out, g)).unwrap().get_ref(5).unwrap();
            assert_eq!(decoder.decode_by_id(placement).unwrap().get_ref(0), Some(parent), "{schema}");
        }
    }
}

#[test]
fn objects_added_to_a_storey_added_in_the_same_plan_share_one_new_relationship() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let level2 = object(IfcClass::BuildingStorey, gid(10), Some(ObjectRef::Id(60)), Representation::None);
        let level2_ref = Some(ObjectRef::Guid(gid(10).encode()));
        let a = object(IfcClass::Wall, gid(11), level2_ref.clone(), Representation::None);
        let b = object(IfcClass::Wall, gid(12), level2_ref, Representation::None);
        let (out, report) = run(&source, vec![add(level2), add(a), add(b)]);
        assert_clean(&report, schema);
        assert_eq!(report.added, 3, "{schema}");

        let rels = crate::relationships(&out);
        let level2 = id_in(&out, gid(10));
        assert!(rels.spatial_children[&60].contains(&level2), "{schema}: the new storey joins the building's aggregation");
        assert_eq!(count(&out, "IFCRELAGGREGATES"), 2, "{schema}: building's existing aggregation extended");
        let mut walls = rels.spatial_children[&level2].clone();
        walls.sort();
        assert_eq!(walls, vec![id_in(&out, gid(11)), id_in(&out, gid(12))], "{schema}");
        assert_eq!(count(&out, "IFCRELCONTAINEDINSPATIALSTRUCTURE"), 2, "{schema}: one existing + one shared new");

        // Placed relative to the new storey's own placement by default.
        let mut decoder = EntityDecoder::new(&out);
        let storey_placement = decoder.decode_by_id(level2).unwrap().get_ref(5).unwrap();
        let wall_placement = decoder.decode_by_id(id_in(&out, gid(11))).unwrap().get_ref(5).unwrap();
        assert_eq!(decoder.decode_by_id(wall_placement).unwrap().get_ref(0), Some(storey_placement), "{schema}");
    }
}

fn wall_common(value: &str) -> NewPropertySet {
    NewPropertySet {
        name: "Pset_WallCommon".into(),
        kind: PsetKind::Property,
        properties: vec![
            NewProperty { name: "Reference".into(), value: PropertyValue::Label(value.into()), unit: None },
            NewProperty { name: "IsExternal".into(), value: PropertyValue::Boolean(true), unit: None },
        ],
    }
}

#[test]
fn a_new_type_with_property_sets_is_shared_by_a_later_add() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let mut first = object(IfcClass::Wall, gid(20), storey(), Representation::None);
        first.type_link = Some(TypeLink::New(NewType {
            global_id: None,
            class: ClassSpec { class: IfcClass::Named("IfcWallType".into()), predefined_type: Some("standard".into()) },
            name: Some("Generic 200".into()),
            tag: None,
            element_type: None,
            psets: vec![wall_common("W200")],
            representation: Representation::None,
            style: None,
        }));
        let mut second = object(IfcClass::Wall, gid(21), storey(), Representation::None);
        second.type_link = Some(TypeLink::Existing(ObjectRef::Guid(gid(20).derive("type").encode())));
        let (out, report) = run(&source, vec![add(first), add(second)]);
        assert_clean(&report, schema);

        let type_id = id_in(&out, gid(20).derive("type"));
        let rels = crate::relationships(&out);
        assert_eq!(rels.type_of.get(&id_in(&out, gid(20))), Some(&type_id), "{schema}");
        assert_eq!(rels.type_of.get(&id_in(&out, gid(21))), Some(&type_id), "{schema}");
        assert_eq!(count(&out, "IFCRELDEFINESBYTYPE"), 2, "{schema}: the fixture's + one for the new type");
        let text = String::from_utf8(out.clone()).unwrap();
        let type_line = text.lines().find(|l| l.starts_with(&format!("#{type_id}="))).unwrap();
        assert!(type_line.contains(".STANDARD."), "{schema}: {type_line}");
        assert!(type_line.contains("'Generic 200'"), "{schema}: {type_line}");
        assert_eq!(count(&out, "IFCRELDEFINESBYPROPERTIES"), 0, "{schema}: a type's sets hang off HasPropertySets");
    }
}

#[test]
fn occurrence_sets_attach_through_their_own_relationship_with_typed_values() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let mut wall = object(IfcClass::Wall, gid(30), storey(), Representation::None);
        wall.psets = vec![
            wall_common("W1"),
            NewPropertySet {
                name: "Qto_WallBaseQuantities".into(),
                kind: PsetKind::Quantity,
                properties: vec![NewProperty {
                    name: "Length".into(),
                    value: PropertyValue::Measure { measure_type: "IfcLengthMeasure".into(), value: 4.5 },
                    unit: None,
                }],
            },
        ];
        let (out, report) = run(&source, vec![add(wall)]);
        assert_clean(&report, schema);
        let text = String::from_utf8(out.clone()).unwrap();
        assert!(text.contains("IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('W1'),$)"), "{schema}");
        assert!(text.contains("IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$)"), "{schema}");
        let quantity = text.lines().find(|l| l.contains("IFCQUANTITYLENGTH(")).unwrap();
        assert!(quantity.contains(",4.5") && !quantity.contains("IFCLENGTHMEASURE"), "{schema}: {quantity}");
        assert_eq!(count(&out, "IFCRELDEFINESBYPROPERTIES"), 2, "{schema}");
    }
}

#[test]
fn deleting_one_wall_and_adding_another_in_one_storey_keeps_both_list_edits() {
    let source = storey_with_typed_wall("IFC4");
    let wall = object(IfcClass::Wall, gid(40), storey(), Representation::None);
    let (out, report) = run(&source, vec![(ObjectRef::Id(10), Disposition::Delete), add(wall)]);
    assert_clean(&report, "IFC4");
    let rels = crate::relationships(&out);
    assert_eq!(rels.spatial_children[&70], vec![id_in(&out, gid(40))]);
}

#[test]
fn an_add_may_reuse_the_global_id_of_an_object_the_same_plan_deletes() {
    let source = storey_with_typed_wall("IFC4");
    // The fixture's wall GlobalId is the text "0...010": '1' then '0' in the
    // last two base-64 digits, i.e. 64.
    let reused = GlobalId(64);
    assert_eq!(reused.encode(), fixture_gid(10));
    let wall = || object(IfcClass::Wall, reused, storey(), Representation::None);

    let (_, report) = run(&source, vec![add(wall())]);
    assert!(report.refusals[0].reason.contains("already exists"), "{:?}", report.refusals);

    let (out, report) = run(&source, vec![(ObjectRef::Guid(fixture_gid(10)), Disposition::Delete), add(wall())]);
    assert_clean(&report, "IFC4");
    assert_eq!(report.added, 1);
    assert_ne!(id_in(&out, reused), 10, "a new record, not the deleted one");
}

#[test]
fn same_plan_produces_byte_identical_output_twice() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let door_type = if schema == "IFC2X3" { "IfcDoorStyle" } else { "IfcDoorType" };
        let plan = || {
            let mut door = object(IfcClass::Door, gid(50), storey(), Representation::Mesh(tetrahedron()));
            door.opening = Some(NewOpening { host: ObjectRef::Id(10), matrix: IDENTITY, shape: block(0.9, 0.2, 2.1) });
            door.style = Some(SurfaceColour { rgb: [0.2, 0.4, 0.6], transparency: 0.0 });
            door.psets = vec![wall_common("D1")];
            door.type_link = Some(TypeLink::New(NewType {
            global_id: None,
                class: ClassSpec { class: IfcClass::Named(door_type.into()), predefined_type: None },
                name: Some("Type".into()),
                tag: None,
                element_type: None,
                psets: vec![wall_common("T")],
                representation: Representation::None,
                style: None,
            }));
            vec![add(door), add(object(IfcClass::Space, gid(51), storey(), Representation::Extrusion(block(3.0, 3.0, 2.5))))]
        };
        let (a, ra) = run(&source, plan());
        let (b, _) = run(&source, plan());
        assert_clean(&ra, schema);
        assert_eq!(a, b, "{schema}");
    }
}

fn refused(source: &[u8], obj: NewObject, expect: &str) {
    let (out, report) = run(source, vec![add(obj)]);
    assert_eq!(report.added, 0, "{expect}");
    assert_eq!(report.refusals.len(), 1, "{expect}: {:?}", report.refusals);
    assert!(report.refusals[0].reason.contains(expect), "{expect}: {}", report.refusals[0].reason);
    let (untouched, _) = run(source, Vec::new());
    assert_eq!(out, untouched, "a refused Add leaves no trace");
}

#[test]
fn a_dangling_parent_placement_is_refused_whole() {
    let source = storey_with_typed_wall("IFC4");
    let mut wall = object(IfcClass::Wall, gid(60), storey(), Representation::Extrusion(block(1.0, 1.0, 1.0)));
    wall.placement.relative_to = Some(ObjectRef::Id(99_999));
    refused(&source, wall, "#99999 not found");
}

#[test]
fn a_placement_with_a_zero_length_axis_is_refused() {
    let source = storey_with_typed_wall("IFC4");
    let mut wall = object(IfcClass::Wall, gid(70), storey(), Representation::None);
    wall.placement.matrix[0][0] = 0.0;
    wall.placement.matrix[1][0] = 0.0;
    wall.placement.matrix[2][0] = 0.0;
    refused(&source, wall, "not a rotation");

    let mut wall = object(IfcClass::Wall, gid(71), storey(), Representation::None);
    wall.placement.matrix[0][2] = 0.0;
    wall.placement.matrix[1][2] = 0.0;
    wall.placement.matrix[2][2] = 0.0;
    refused(&source, wall, "not a rotation");

    // A zero Y column is singular too, though X and Z alone look fine
    // (#8080 review).
    let mut wall = object(IfcClass::Wall, gid(73), storey(), Representation::None);
    wall.placement.matrix[0][1] = 0.0;
    wall.placement.matrix[1][1] = 0.0;
    wall.placement.matrix[2][1] = 0.0;
    refused(&source, wall, "not a rotation");
}

#[test]
fn a_placement_whose_x_and_z_axes_are_parallel_is_refused() {
    let source = storey_with_typed_wall("IFC4");
    let mut wall = object(IfcClass::Wall, gid(72), storey(), Representation::None);
    // Local X and Z both point along the global Z axis: they span no plane,
    // so their cross product is zero and IFC's Y axis (X x Z) cannot be built.
    wall.placement.matrix[0][0] = 0.0;
    wall.placement.matrix[1][0] = 0.0;
    wall.placement.matrix[2][0] = 1.0;
    refused(&source, wall, "not a rotation");
}

#[test]
fn two_property_sets_of_one_name_are_refused() {
    let source = storey_with_typed_wall("IFC4");
    let mut wall = object(IfcClass::Wall, gid(61), storey(), Representation::None);
    wall.psets = vec![wall_common("a"), wall_common("b")];
    refused(&source, wall, "two property sets named 'Pset_WallCommon'");
}

#[test]
fn classes_the_schema_cannot_instantiate_here_are_refused() {
    let source = storey_with_typed_wall("IFC4");
    refused(&source, object(IfcClass::Named("IfcBuildingElement".into()), gid(62), storey(), Representation::None), "abstract");
    refused(&source, object(IfcClass::Named("IfcNoSuchThing".into()), gid(63), storey(), Representation::None), "not declared");
    refused(&source, object(IfcClass::Named("IfcWallType".into()), gid(64), storey(), Representation::None), "not an IFCPRODUCT");
    let mut door = object(IfcClass::Door, gid(65), storey(), Representation::None);
    door.class.predefined_type = Some("DOOR".into());
    refused(&storey_with_typed_wall("IFC2X3"), door, "no PredefinedType in IFC2X3");
}

#[test]
fn keys_and_global_ids_that_collide_with_the_source_are_refused() {
    let source = storey_with_typed_wall("IFC4");
    let (_, report) = run(&source, vec![(ObjectRef::Id(10), Disposition::Add(Box::new(object(IfcClass::Wall, gid(66), None, Representation::None))))]);
    assert!(report.refusals[0].reason.contains("already exists"), "{:?}", report.refusals);
    let wall = object(IfcClass::Wall, gid(67), None, Representation::None);
    let (_, report) = run(&source, vec![(ObjectRef::Guid("not-the-encoding".into()), Disposition::Add(Box::new(wall)))]);
    assert!(report.refusals[0].reason.contains("does not match"), "{:?}", report.refusals);
    let (_, report) = run(&source, vec![add(object(IfcClass::Wall, gid(68), None, Representation::None)), add(object(IfcClass::Wall, gid(68), None, Representation::None))]);
    assert_eq!(report.added, 1);
    assert!(report.refusals[0].reason.contains("already in use"), "{:?}", report.refusals);
}

#[test]
fn a_container_that_is_not_spatial_or_is_deleted_is_refused() {
    let source = storey_with_typed_wall("IFC4");
    refused(&source, object(IfcClass::Wall, gid(69), Some(ObjectRef::Id(10)), Representation::None), "not a spatial element");
    let (_, report) = run(&source, vec![(ObjectRef::Id(70), Disposition::Delete), add(object(IfcClass::Wall, gid(70), storey(), Representation::None))]);
    assert!(report.refusals.iter().any(|r| r.reason.contains("deleted by this plan")), "{:?}", report.refusals);
}

/// One bare wall into an empty storey with no owner history in the source
/// consumes exactly 11 ids (5 synthesizing owner history, 4 for the axis
/// placement, 1 for the local placement, 1 for the object itself) before
/// the plan's relationships are written; the new containment relationship
/// needs a 12th. A source pinned to have exactly 11 ids of headroom lets
/// the object build succeed and then fails only when `finish` tries to
/// create that relationship, which is exactly the case where a stale
/// `added` count would say something built that never reached the output.
#[test]
fn an_id_space_exhausted_while_writing_relationships_reports_nothing_added() {
    let source = storey_with_headroom("IFC4", 11);
    let (out, report) = run(&source, vec![add(object(IfcClass::Wall, gid(90), Some(ObjectRef::Id(70)), Representation::None))]);
    assert_eq!(report.added, 0, "{:?}", report.refusals);
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert!(report.refusals[0].reason.contains("id space exhausted"), "{:?}", report.refusals);
    let (untouched, _) = run(&source, Vec::new());
    assert_eq!(out, untouched, "no trace of the built-then-discarded object survives in the output");
}

#[test]
fn a_new_type_with_its_own_global_id_keeps_it_and_later_adds_name_it() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let type_gid = gid(90);
        let mut first = object(IfcClass::Wall, gid(22), storey(), Representation::None);
        first.type_link = Some(TypeLink::New(NewType {
            global_id: Some(type_gid),
            class: ClassSpec { class: IfcClass::Named("IfcWallType".into()), predefined_type: None },
            name: Some("Own id".into()),
            tag: None,
            element_type: None,
            psets: vec![wall_common("W1")],
            representation: Representation::None,
            style: None,
        }));
        let mut second = object(IfcClass::Wall, gid(23), storey(), Representation::None);
        second.type_link = Some(TypeLink::Existing(ObjectRef::Guid(type_gid.encode())));
        let (out, report) = run(&source, vec![add(first), add(second)]);
        assert_clean(&report, schema);
        let type_id = id_in(&out, type_gid);
        let rels = crate::relationships(&out);
        assert_eq!(rels.type_of.get(&id_in(&out, gid(23))), Some(&type_id), "{schema}");
        assert!(!String::from_utf8(out).unwrap().contains(&gid(22).derive("type").encode()), "{schema}: no derived id");
    }
}

#[test]
fn a_new_type_sharing_its_occurrences_global_id_is_refused() {
    let source = storey_with_typed_wall("IFC4");
    let mut wall = object(IfcClass::Wall, gid(24), storey(), Representation::None);
    wall.type_link = Some(TypeLink::New(NewType {
        global_id: Some(gid(24)),
        class: ClassSpec { class: IfcClass::Named("IfcWallType".into()), predefined_type: None },
        name: Some("Type".into()),
        tag: None,
        element_type: None,
        psets: Vec::new(),
        representation: Representation::None,
        style: None,
    }));
    let (_, report) = run(&source, vec![add(wall)]);
    assert!(report.refusals[0].reason.contains("cannot share"), "{:?}", report.refusals);
}

#[test]
fn an_opening_is_placed_at_its_matrix_in_the_objects_frame() {
    let source = storey_with_typed_wall("IFC4");
    let mut door = object(IfcClass::Door, gid(40), storey(), Representation::Extrusion(block(0.9, 0.2, 2.1)));
    let mut matrix = IDENTITY;
    matrix[2][3] = -0.15;
    door.opening = Some(NewOpening { host: ObjectRef::Id(10), matrix, shape: block(0.9, 0.3, 2.1) });
    let (out, report) = run(&source, vec![add(door)]);
    assert_clean(&report, "IFC4");
    let text = String::from_utf8(out.clone()).unwrap();
    let mut decoder = EntityDecoder::new(&out);
    let opening = decoder.decode_by_id(id_in(&out, gid(40).derive("opening"))).unwrap();
    let placement = decoder.decode_by_id(opening.get_ref(5).unwrap()).unwrap();
    let a2p = decoder.decode_by_id(placement.get_ref(1).unwrap()).unwrap();
    let point = a2p.get_ref(0).unwrap();
    let line = text.lines().find(|l| l.starts_with(&format!("#{point}="))).unwrap();
    assert!(line.contains("(0.,0.,-0.15)"), "{line}");

    let mut skewed = object(IfcClass::Door, gid(41), storey(), Representation::None);
    let mut bad = IDENTITY;
    bad[2][2] = 0.0;
    skewed.opening = Some(NewOpening { host: ObjectRef::Id(10), matrix: bad, shape: block(0.9, 0.3, 2.1) });
    let (_, report) = run(&source, vec![add(skewed)]);
    assert!(report.refusals[0].reason.starts_with("opening:"), "{:?}", report.refusals);
}

#[test]
fn a_furniture_type_gets_its_mandatory_assembly_place() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        // IFC2X3 has no IfcFurniture; its furnishing elements take the same type.
        let class = if schema == "IFC2X3" { "IfcFurnishingElement" } else { "IfcFurniture" };
        let mut chair = object(IfcClass::Named(class.into()), gid(50), storey(), Representation::None);
        chair.type_link = Some(TypeLink::New(NewType {
            global_id: None,
            class: ClassSpec { class: IfcClass::Named("IfcFurnitureType".into()), predefined_type: None },
            name: Some("Chair".into()),
            tag: None,
            element_type: None,
            psets: Vec::new(),
            representation: Representation::None,
            style: None,
        }));
        let (out, report) = run(&source, vec![add(chair)]);
        assert_clean(&report, schema);
        let text = String::from_utf8(out.clone()).unwrap();
        let type_id = id_in(&out, gid(50).derive("type"));
        let line = text.lines().find(|l| l.starts_with(&format!("#{type_id}="))).unwrap();
        assert!(line.contains(".NOTDEFINED."), "{schema}: {line}");
    }
}

/// A new storey's Elevation is written as given, in the project's length
/// unit; the storey's placement is its own.
#[test]
fn a_new_storey_carries_the_elevation_it_is_given() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let mut level2 = object(IfcClass::BuildingStorey, gid(60), Some(ObjectRef::Id(60)), Representation::None);
        level2.elevation = Some(6.5);
        let level3 = object(IfcClass::BuildingStorey, gid(61), Some(ObjectRef::Id(60)), Representation::None);
        let (out, report) = run(&source, vec![add(level2), add(level3)]);
        assert_clean(&report, schema);
        assert!(crate::plan::validate::validate(&out, schema).is_empty(), "{schema}");
        let index = crate::plan::index::FileIndex::scan(&out, &Default::default());
        let idx = crate::plan::attrs::attribute_index(schema, "IFCBUILDINGSTOREY", "Elevation").unwrap();
        let elevation = |g| crate::step_text::attribute_of(&index.raw_line(id_in(&out, g)).unwrap(), idx).unwrap();
        assert_eq!(elevation(gid(60)), "6.5", "{schema}");
        assert_eq!(elevation(gid(61)), "$", "{schema}: none given, none written");
    }
}

#[test]
fn an_elevation_is_refused_off_a_storey_or_when_not_finite() {
    let source = storey_with_typed_wall("IFC4");
    let mut wall = object(IfcClass::Wall, gid(62), storey(), Representation::None);
    wall.elevation = Some(1.0);
    let mut adds = vec![(gid(62), "only a storey takes one")];
    let mut plan = vec![add(wall)];
    for (n, bad) in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY].into_iter().enumerate() {
        let g = gid(63 + n as u128);
        let mut level = object(IfcClass::BuildingStorey, g, Some(ObjectRef::Id(60)), Representation::None);
        level.elevation = Some(bad);
        plan.push(add(level));
        adds.push((g, "not finite"));
    }
    let (_, report) = run(&source, plan);
    assert_eq!(report.added, 0);
    assert_eq!(report.refusals.len(), adds.len(), "{:?}", report.refusals);
    for (g, expected) in adds {
        let key = ObjectRef::Guid(g.encode());
        let refusal = report.refusals.iter().find(|r| r.object == key).unwrap_or_else(|| panic!("{key} not refused"));
        assert!(refusal.reason.contains(expected), "{key}: {}", refusal.reason);
    }
}
