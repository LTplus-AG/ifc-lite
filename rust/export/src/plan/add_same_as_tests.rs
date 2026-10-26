// SPDX-License-Identifier: MPL-2.0
//! Reused bodies: an Add with the same geometry as a product in the source,
//! through new representations that list the source's own items, and what
//! is refused. Synthetic fixtures only.

use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::attrs::build_record;
use crate::plan::index::FileIndex;
use crate::plan::test_fixtures::{products_with_geometry, storey_with_typed_wall};
use crate::plan::types::*;

/// GlobalId of door `#200` in [`door_scene`].
const DOOR: &str = "0000000000000000000200";

/// `storey_with_typed_wall` with door `#200` in storey `#70`, two metres
/// along: its body `#204` is one 0.9 x 0.05 x 2.1 extruded rectangle `#206`.
fn door_scene(schema: &str) -> Vec<u8> {
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
    .concat();
    let text = String::from_utf8(storey_with_typed_wall(schema)).unwrap();
    text.replacen("ENDSEC;\nEND-ISO", &format!("{records}ENDSEC;\nEND-ISO"), 1).into_bytes()
}

fn translated(x: f64) -> [[f64; 4]; 4] {
    let mut m = IDENTITY;
    m[0][3] = x;
    m
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

/// Validates, and every reference names a record of the output.
fn assert_valid(out: &[u8], schema: &str) {
    let findings = crate::plan::validate::validate(out, schema);
    assert!(findings.is_empty(), "{schema}: {findings:?}");
    let index = FileIndex::scan(out, &Default::default());
    for (id, ..) in index.records() {
        for r in refs_of(&index, id) {
            assert!(index.contains(r), "{schema}: #{id} names missing #{r}");
        }
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
        let source = door_scene(schema);
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
        for (axis, shift) in [3.0, 0.0, 0.0].into_iter().enumerate() {
            assert!((b[axis].0 - a[axis].0 - shift).abs() < 1e-4 && (b[axis].1 - a[axis].1 - shift).abs() < 1e-4, "{schema}: {a:?} vs {b:?}");
        }
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
fn a_mapped_body_is_shared_not_copied() {
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
        for (axis, shift) in [8.0, 0.0, 0.0].into_iter().enumerate() {
            assert!((b[axis].0 - a[axis].0 - shift).abs() < 1e-4 && (b[axis].1 - a[axis].1 - shift).abs() < 1e-4, "{schema}: {a:?} vs {b:?}");
        }
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
fn a_reused_body_is_refused_when_its_source_cannot_lend_one() {
    for schema in SCHEMAS {
        let source = products_with_geometry(schema);
        let wall = |r| copy(1, IfcClass::Wall, r, None, 0.0);
        let delete = |id| vec![(ObjectRef::Id(id), Disposition::Delete)];
        let cases = [
            (Vec::new(), wall(ObjectRef::Id(9999)), "#9999 not found"),
            (Vec::new(), wall(ObjectRef::Guid("0000000000000000009999".into())), "not found"),
            (Vec::new(), wall(ObjectRef::Id(14)), "has no representation"),
            (delete(10), wall(ObjectRef::Id(10)), "deleted by this plan"),
            (delete(104), wall(ObjectRef::Id(10)), "representation #62 is in a context the output does not have"),
            (Vec::new(), wall(ObjectRef::Id(120)), "IFCWALLTYPE, not a product"),
            (Vec::new(), wall(ObjectRef::Id(10)).with_style(SurfaceColour { rgb: [1.0, 0.0, 0.0], transparency: 0.0 }), "keeps its source's colour"),
        ];
        for (before, obj, want) in cases {
            let reason = refusal(&source, before, obj);
            assert!(reason.contains(want), "{schema}: {reason}");
        }
    }
}

#[test]
fn a_body_added_by_the_same_plan_is_not_reused() {
    let source = products_with_geometry("IFC4");
    let first = object(IfcClass::Wall, gid(1), None, Representation::Extrusion(block(1.0, 1.0, 1.0)));
    let second = copy(2, IfcClass::Wall, ObjectRef::Guid(gid(1).encode()), None, 5.0);
    let (_, report) = run(&source, vec![add(first), add(second)]);
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert!(report.refusals[0].reason.contains("is added by this plan"), "{:?}", report.refusals);
}

#[test]
fn a_type_cannot_reuse_a_products_body() {
    let source = products_with_geometry("IFC4");
    let mut t = NewType::new(IfcClass::Named("IfcWallType".into())).with_name("Copied");
    t.representation = Representation::SameAs(ObjectRef::Id(10));
    let mut wall = object(IfcClass::Wall, gid(1), None, Representation::None);
    wall.type_link = Some(TypeLink::New(t));
    let (_, report) = run(&source, vec![add(wall)]);
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert!(report.refusals[0].reason.contains("cannot reuse a product's"), "{:?}", report.refusals);
}
