// SPDX-License-Identifier: MPL-2.0
//! Reused geometry: an Add that repeats every representation of a product
//! in the source, through new representations that list the source's own
//! items, and what is refused. Synthetic fixtures only.

use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::attrs::{build_record, unset_required};
use crate::plan::index::FileIndex;
use crate::plan::test_fixtures::{products_with_geometry, storey_with_typed_wall};
use crate::plan::types::*;

/// GlobalId of door `#200` in [`door_scene`].
const DOOR: &str = "0000000000000000000200";

/// A record as `build_record` takes it: id, entity, fields.
type Record<'a> = (u32, &'a str, &'a [(&'a str, &'a str)]);

/// `storey_with_typed_wall` with door `#200` in storey `#70`, two metres
/// along: its body `#204` is one 0.9 x 0.05 x 2.1 extruded rectangle `#206`.
/// `extra` records follow the door's.
fn door_scene(schema: &str, extra: &[Record]) -> Vec<u8> {
    let r = |id, entity, fields: &[(&str, &str)]| {
        let mut fields: Vec<(&str, String)> = fields.iter().map(|&(n, v)| (n, v.to_string())).collect();
        if schema == "IFC2X3" && entity == "IFCDOOR" {
            fields.push(("OwnerHistory", "#5".into()));
        }
        build_record(schema, id, entity, &fields) + "\n"
    };
    let door = format!("'{DOOR}'");
    let records = [
        r(200, "IFCDOOR", &[("GlobalId", &door), ("Name", "'Door'"), ("ObjectPlacement", "#201"), ("Representation", "#203")]),
        r(201, "IFCLOCALPLACEMENT", &[("PlacementRelTo", "#73"), ("RelativePlacement", "#202")]),
        r(202, "IFCAXIS2PLACEMENT3D", &[("Location", "#205")]),
        r(205, "IFCCARTESIANPOINT", &[("Coordinates", "(2.,0.,0.)")]),
        r(203, "IFCPRODUCTDEFINITIONSHAPE", &[("Representations", "(#204)")]),
        r(204, "IFCSHAPEREPRESENTATION", &[("ContextOfItems", "#100"), ("RepresentationIdentifier", "'Body'"), ("RepresentationType", "'SweptSolid'"), ("Items", "(#206)")]),
        r(206, "IFCEXTRUDEDAREASOLID", &[("SweptArea", "#207"), ("Position", "#208"), ("ExtrudedDirection", "#209"), ("Depth", "2.1")]),
        r(207, "IFCRECTANGLEPROFILEDEF", &[("ProfileType", ".AREA."), ("Position", "#210"), ("XDim", "0.9"), ("YDim", "0.05")]),
        r(208, "IFCAXIS2PLACEMENT3D", &[("Location", "#102")]),
        r(209, "IFCDIRECTION", &[("DirectionRatios", "(0.,0.,1.)")]),
        r(210, "IFCAXIS2PLACEMENT2D", &[("Location", "#211")]),
        r(211, "IFCCARTESIANPOINT", &[("Coordinates", "(0.45,0.025)")]),
    ]
    .concat()
        + &extra.iter().map(|&(id, entity, fields)| r(id, entity, fields)).collect::<String>();
    let text = String::from_utf8(storey_with_typed_wall(schema)).unwrap();
    text.replacen("ENDSEC;\nEND-ISO", &format!("{records}ENDSEC;\nEND-ISO"), 1).into_bytes()
}

/// A copy of `source` at `x` along, in `container` when given.
fn copy(n: u128, class: IfcClass, source: ObjectRef, container: Option<ObjectRef>, x: f64) -> NewObject {
    let mut obj = object(class, gid(n), container, Representation::SameAs(source));
    obj.placement = NewPlacement::new(translated(x));
    obj
}

/// Ids an output record names, as written.
fn refs_of(index: &FileIndex, id: u32) -> Vec<u32> {
    index.attrs(id).unwrap().iter().flat_map(|a| a.refs().collect::<Vec<_>>()).collect()
}

/// `b` is `a` moved by `shift`, within 0.1 mm on every axis.
fn assert_shifted(a: [(f64, f64); 3], b: [(f64, f64); 3], shift: [f64; 3], schema: &str) {
    for axis in 0..3 {
        assert!((b[axis].0 - a[axis].0 - shift[axis]).abs() < 1e-4 && (b[axis].1 - a[axis].1 - shift[axis]).abs() < 1e-4, "{schema}: {a:?} vs {b:?}");
    }
}

/// Validates (every reference resolves) and leaves no required attribute
/// the slot tables cover unset.
fn assert_valid(out: &[u8], schema: &str) {
    let findings = crate::plan::validate::validate(out, schema);
    assert!(findings.is_empty(), "{schema}: {findings:?}");
    let index = FileIndex::scan(out, &Default::default());
    for (id, ..) in index.records() {
        let line = index.raw_line(id).unwrap();
        let unset = unset_required(schema, &line);
        assert!(unset.is_empty(), "{schema}: #{id} leaves {unset:?} unset");
    }
}

/// The new product's shape and its representations, each as
/// `(ContextOfItems, RepresentationIdentifier, RepresentationType, Items)`.
fn shape_of(out: &[u8], schema: &str, product: u32) -> (u32, Vec<(u32, [String; 4])>) {
    let shape: u32 = attr(out, schema, product, "Representation").trim_start_matches('#').parse().unwrap();
    assert_eq!(type_in(out, shape), "IFCPRODUCTDEFINITIONSHAPE");
    let index = FileIndex::scan(out, &Default::default());
    let reps = refs_of(&index, shape);
    let reps = reps
        .into_iter()
        .map(|rep| {
            let a = |name| attr(out, schema, rep, name);
            (rep, [a("ContextOfItems"), a("RepresentationIdentifier"), a("RepresentationType"), a("Items")])
        })
        .collect();
    (shape, reps)
}

#[test]
fn a_copy_lists_its_source_doors_extruded_solid_in_its_own_shape() {
    for schema in SCHEMAS {
        let source = door_scene(schema, &[]);
        let door = copy(1, IfcClass::Door, ObjectRef::Guid(DOOR.into()), Some(ObjectRef::Id(70)), 5.0);
        let (out, report) = run(&source, vec![add(door)]);
        assert_clean(&report, schema);
        assert_valid(&out, schema);

        let (shape, reps) = shape_of(&out, schema, id_in(&out, gid(1)));
        assert_ne!(shape, 203, "{schema}: its own shape, not the source's");
        assert_eq!(reps.len(), 1, "{schema}");
        let (rep, fields) = &reps[0];
        assert_ne!(*rep, 204, "{schema}: its own representation");
        assert_eq!(type_in(&out, *rep), "IFCSHAPEREPRESENTATION");
        assert_eq!(fields, &["#100", "'Body'", "'SweptSolid'", "(#206)"].map(String::from), "{schema}");
        assert_eq!(count(&out, "IFCEXTRUDEDAREASOLID"), 1, "{schema}: the source's solid, not a copy");
        assert_eq!(attr(&out, schema, 200, "Representation"), "#203", "{schema}: the source keeps its own shape");

        // The engine meshes the copy as the door, three metres further along.
        let result = ifc_lite_processing::process_geometry(&out);
        let (a, b) = (bounds(&result, 200), bounds(&result, id_in(&out, gid(1))));
        assert_shifted(a, b, [3.0, 0.0, 0.0], schema);
        assert!((a[2].1 - a[2].0 - 2.1).abs() < 1e-4, "{schema}: {a:?}");
    }
}

#[test]
fn a_source_with_a_body_and_an_axis_gives_the_copy_both() {
    for schema in SCHEMAS {
        let source = products_with_geometry(schema);
        let (out, report) = run(&source, vec![add(copy(1, IfcClass::Wall, ObjectRef::Id(10), None, 10.0))]);
        assert_clean(&report, schema);
        assert_valid(&out, schema);

        let (_, reps) = shape_of(&out, schema, id_in(&out, gid(1)));
        let fields: Vec<_> = reps.into_iter().map(|(_, f)| f).collect();
        assert_eq!(
            fields,
            [["#103", "'Body'", "'SweptSolid'", "(#63,#76)"], ["#104", "'Axis'", "'Curve2D'", "(#73)"]].map(|f| f.map(String::from)),
            "{schema}"
        );
        // The source's styled item still styles `#63`, which the copy lists.
        assert_eq!(count(&out, "IFCSTYLEDITEM"), 2, "{schema}: no style written");
    }
}

#[test]
fn a_mapped_item_is_shared_not_copied() {
    for schema in SCHEMAS {
        let source = products_with_geometry(schema);
        let (out, report) = run(&source, vec![add(copy(1, IfcClass::Wall, ObjectRef::Id(12), None, 20.0))]);
        assert_clean(&report, schema);
        assert_valid(&out, schema);

        let (_, reps) = shape_of(&out, schema, id_in(&out, gid(1)));
        let fields: Vec<_> = reps.into_iter().map(|(_, f)| f).collect();
        assert_eq!(fields, [["#103", "'Body'", "'MappedRepresentation'", "(#112)"].map(String::from)], "{schema}");
        assert_eq!(count(&out, "IFCMAPPEDITEM"), 2, "{schema}: the source's mapped items only");

        // Wall #12 sits at x = 12; the copy at 20.
        let result = ifc_lite_processing::process_geometry(&out);
        let (a, b) = (bounds(&result, 12), bounds(&result, id_in(&out, gid(1))));
        assert_shifted(a, b, [8.0, 0.0, 0.0], schema);
    }
}

/// The reason an Add of `obj` is refused with, after `before`; its output is
/// what `before` alone writes.
fn refusal(source: &[u8], before: Vec<(ObjectRef, Disposition)>, obj: NewObject) -> String {
    let (alone, _) = run(source, before.clone());
    let mut plan = before;
    plan.push(add(obj));
    let (out, report) = run(source, plan);
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert_eq!(out, alone, "a refused Add leaves no trace");
    report.refusals[0].reason.clone()
}

#[test]
fn reused_geometry_is_refused_when_its_source_cannot_lend_it() {
    for schema in SCHEMAS {
        let source = products_with_geometry(schema);
        let wall = |r| copy(1, IfcClass::Wall, r, None, 0.0);
        let delete = |id| vec![(ObjectRef::Id(id), Disposition::Delete)];
        let cases = [
            (Vec::new(), wall(ObjectRef::Id(9999)), "#9999 not found"),
            (Vec::new(), wall(ObjectRef::Guid("0000000000000000009999".into())), "not found"),
            (Vec::new(), wall(ObjectRef::Id(14)), "has no representation"),
            (delete(10), wall(ObjectRef::Id(10)), "deleted by this plan"),
            (delete(104), wall(ObjectRef::Id(10)), "representation #62 is in a context this plan removes"),
            (delete(76), wall(ObjectRef::Id(10)), "representation #61: item #76 is removed by this plan"),
            (delete(61), wall(ObjectRef::Id(10)), "representation #61 is removed by this plan"),
            (Vec::new(), wall(ObjectRef::Id(120)), "IFCWALLTYPE, not a product"),
            (Vec::new(), wall(ObjectRef::Id(10)).with_style(SurfaceColour { rgb: [1.0, 0.0, 0.0], transparency: 0.0 }), "reused geometry keeps its source's colour"),
        ];
        for (before, obj, want) in cases {
            let reason = refusal(&source, before, obj);
            assert!(reason.contains(want), "{schema}: {reason}");
        }
        let empty = String::from_utf8(source).unwrap().replace("'Curve2D',(#73)", "'Curve2D',()");
        let reason = refusal(empty.as_bytes(), Vec::new(), wall(ObjectRef::Id(10)));
        assert!(reason.contains("representation #62 has no items"), "{schema}: {reason}");
    }
}

/// A patch giving door `#200` a tetrahedron for its body.
fn reshape_door() -> Vec<(ObjectRef, Disposition)> {
    let mesh = TriangleMesh::new(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]]);
    vec![(ObjectRef::Id(200), Disposition::Patch(Patch::new().with_geometry(GeometryPatch::new(mesh))))]
}

#[test]
fn reshaped_geometry_is_not_reused_while_another_product_keeps_the_old_one() {
    for schema in SCHEMAS {
        // Door `#220` has its own shape `#221` and placement `#223`, and lists
        // the door's solid `#206`, so the patch's sweep leaves `#206` in place.
        let twin: &[Record] = &[
            (220, "IFCDOOR", &[("GlobalId", "'0000000000000000000220'"), ("Name", "'Twin'"), ("ObjectPlacement", "#223"), ("Representation", "#221")]),
            (223, "IFCLOCALPLACEMENT", &[("PlacementRelTo", "#73"), ("RelativePlacement", "#202")]),
            (221, "IFCPRODUCTDEFINITIONSHAPE", &[("Representations", "(#222)")]),
            (222, "IFCSHAPEREPRESENTATION", &[("ContextOfItems", "#100"), ("RepresentationIdentifier", "'Body'"), ("RepresentationType", "'SweptSolid'"), ("Items", "(#206)")]),
        ];
        let source = door_scene(schema, twin);
        assert_valid(&source, schema);
        let (alone, report) = run(&source, reshape_door());
        assert_clean(&report, schema);
        assert_valid(&alone, schema);
        assert_eq!(attr(&alone, schema, 220, "Representation"), "#221", "{schema}");
        assert_eq!(attr(&alone, schema, 222, "Items"), "(#206)", "{schema}: the twin keeps the old solid");
        assert_eq!(type_in(&alone, 206), "IFCEXTRUDEDAREASOLID", "{schema}");
        assert!(!FileIndex::scan(&alone, &Default::default()).contains(204), "{schema}: the door's old representation goes");

        let door = copy(1, IfcClass::Door, ObjectRef::Guid(DOOR.into()), Some(ObjectRef::Id(70)), 5.0);
        let reason = refusal(&source, reshape_door(), door);
        assert!(reason.contains(&format!("{DOOR} gets new geometry from a patch in this plan")), "{schema}: {reason}");

        // The twin is not reshaped, so it lends the old solid.
        let mut plan = reshape_door();
        plan.push(add(copy(1, IfcClass::Door, ObjectRef::Id(220), Some(ObjectRef::Id(70)), 5.0)));
        let (out, report) = run(&source, plan);
        assert_clean(&report, schema);
        assert_valid(&out, schema);
        let (_, reps) = shape_of(&out, schema, id_in(&out, gid(1)));
        assert_eq!(reps.len(), 1, "{schema}");
        assert_eq!(reps[0].1[3], "(#206)", "{schema}");
    }
}

#[test]
fn a_reshaped_source_is_refused_even_when_its_old_shape_survives_the_patch() {
    // IFC2X3's `ShapeOfProduct` is SET [1:1], so only IFC4 on can share a shape.
    for schema in ["IFC4", "IFC4X3"] {
        // Door `#220` shares the door's shape `#203`, so the patch's sweep keeps
        // `#203`, `#204` and `#206`.
        let twin: &[Record] = &[
            (220, "IFCDOOR", &[("GlobalId", "'0000000000000000000220'"), ("Name", "'Twin'"), ("ObjectPlacement", "#223"), ("Representation", "#203")]),
            (223, "IFCLOCALPLACEMENT", &[("PlacementRelTo", "#73"), ("RelativePlacement", "#202")]),
        ];
        let source = door_scene(schema, twin);
        assert_valid(&source, schema);
        let (alone, report) = run(&source, reshape_door());
        assert_clean(&report, schema);
        assert_valid(&alone, schema);
        assert_ne!(attr(&alone, schema, 200, "Representation"), "#203", "{schema}: the door gets a new shape");
        assert_eq!(attr(&alone, schema, 220, "Representation"), "#203", "{schema}");
        assert_eq!(attr(&alone, schema, 204, "Items"), "(#206)", "{schema}: the old representation stays");

        let door = copy(1, IfcClass::Door, ObjectRef::Guid(DOOR.into()), Some(ObjectRef::Id(70)), 5.0);
        let reason = refusal(&source, reshape_door(), door);
        assert!(reason.contains(&format!("{DOOR} gets new geometry from a patch in this plan")), "{schema}: {reason}");
    }
}

#[test]
fn a_mapped_item_outlives_its_deleted_type_and_goes_with_its_map() {
    for schema in SCHEMAS {
        let source = products_with_geometry(schema);
        let wall = || copy(1, IfcClass::Wall, ObjectRef::Id(12), None, 20.0);

        // Deleting type `#120` keeps map `#113`: mapped items `#112` and `#132` still name it.
        let (out, report) = run(&source, vec![(ObjectRef::Id(120), Disposition::Delete), add(wall())]);
        assert_clean(&report, schema);
        assert_valid(&out, schema);
        assert!(!FileIndex::scan(&out, &Default::default()).contains(120), "{schema}: the type goes");
        assert_eq!(type_in(&out, 113), "IFCREPRESENTATIONMAP", "{schema}: its map stays");
        let (_, reps) = shape_of(&out, schema, id_in(&out, gid(1)));
        assert_eq!(reps[0].1[3], "(#112)", "{schema}");

        // Deleting the map, its representation or its transform takes mapped
        // item `#112` with it, so the copy is refused.
        for below in [113, 115, 117] {
            let reason = refusal(&source, vec![(ObjectRef::Id(below), Disposition::Delete)], wall());
            assert!(reason.contains("representation #111: item #112 is removed by this plan"), "{schema}: #{below}: {reason}");
        }

        // Deleting solid `#116` below the map leaves `#112`: the copy mirrors
        // the source as the plan leaves it. The map's representation `#115`
        // is left with no items for the source too; that is the delete
        // cascade's, not the reuse's.
        let (out, report) = run(&source, vec![(ObjectRef::Id(116), Disposition::Delete), add(wall())]);
        assert!(report.refusals.is_empty(), "{schema}: {:?}", report.refusals);
        assert_eq!(attr(&out, schema, 111, "Items"), "(#112)", "{schema}");
        let (_, reps) = shape_of(&out, schema, id_in(&out, gid(1)));
        assert_eq!(reps[0].1[3], "(#112)", "{schema}");
    }
}

#[test]
fn geometry_added_by_the_same_plan_is_not_reused() {
    let source = products_with_geometry("IFC4");
    let first = object(IfcClass::Wall, gid(1), None, Representation::Extrusion(block(1.0, 1.0, 1.0)));
    let second = copy(2, IfcClass::Wall, ObjectRef::Guid(gid(1).encode()), None, 5.0);
    let (_, report) = run(&source, vec![add(first), add(second)]);
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert!(report.refusals[0].reason.contains("is added by this plan"), "{:?}", report.refusals);
}

#[test]
fn a_type_cannot_reuse_a_products_geometry() {
    let source = products_with_geometry("IFC4");
    let mut t = NewType::new(IfcClass::Named("IfcWallType".into())).with_name("Copied");
    t.representation = Representation::SameAs(ObjectRef::Id(10));
    let mut wall = object(IfcClass::Wall, gid(1), None, Representation::None);
    wall.type_link = Some(TypeLink::New(t));
    let (_, report) = run(&source, vec![add(wall)]);
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert!(report.refusals[0].reason.contains("cannot reuse a product's"), "{:?}", report.refusals);
}
