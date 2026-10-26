// SPDX-License-Identifier: MPL-2.0
//! Mapped bodies: an Add instancing a source type's representation maps, a
//! new type's map shared by many occurrences, a type added on its own with
//! a map, and what is refused. The geometry engine meshes every output.
//! Synthetic fixtures only.

use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::attrs::build_record;
use crate::plan::index::FileIndex;
use crate::plan::test_fixtures::storey_with_typed_wall;
use crate::plan::types::*;

/// `storey_with_typed_wall` with its wall type `#40` given two maps: `#300`,
/// a `Body` map of a 1 x 0.2 x 2 extruded rectangle, and `#310`, an `Axis`
/// map, as a file from another tool could carry them.
fn type_with_maps(schema: &str) -> Vec<u8> {
    let r = |id, entity, fields: &[(&str, &str)]| {
        let mut fields: Vec<(&str, String)> = fields.iter().map(|&(n, v)| (n, v.to_string())).collect();
        // IFC2X3 requires an owner history: the fixture preamble's.
        if schema == "IFC2X3" {
            fields.push(("OwnerHistory", "#5".into()));
        }
        build_record(schema, id, entity, &fields) + "\n"
    };
    let records = [
        r(40, "IFCWALLTYPE", &[("GlobalId", "'0000000000000000000040'"), ("Name", "'WallType 1'"), ("RepresentationMaps", "(#300,#310)"), ("PredefinedType", ".NOTDEFINED.")]),
        r(300, "IFCREPRESENTATIONMAP", &[("MappingOrigin", "#301"), ("MappedRepresentation", "#302")]),
        r(301, "IFCAXIS2PLACEMENT3D", &[("Location", "#102")]),
        r(302, "IFCSHAPEREPRESENTATION", &[("ContextOfItems", "#100"), ("RepresentationIdentifier", "'Body'"), ("RepresentationType", "'SweptSolid'"), ("Items", "(#303)")]),
        r(303, "IFCEXTRUDEDAREASOLID", &[("SweptArea", "#304"), ("Position", "#301"), ("ExtrudedDirection", "#305"), ("Depth", "2.")]),
        r(304, "IFCRECTANGLEPROFILEDEF", &[("ProfileType", ".AREA."), ("Position", "#306"), ("XDim", "1."), ("YDim", "0.2")]),
        r(305, "IFCDIRECTION", &[("DirectionRatios", "(0.,0.,1.)")]),
        r(306, "IFCAXIS2PLACEMENT2D", &[("Location", "#307")]),
        r(307, "IFCCARTESIANPOINT", &[("Coordinates", "(0.5,0.1)")]),
        r(310, "IFCREPRESENTATIONMAP", &[("MappingOrigin", "#301"), ("MappedRepresentation", "#311")]),
        r(311, "IFCSHAPEREPRESENTATION", &[("ContextOfItems", "#100"), ("RepresentationIdentifier", "'Axis'"), ("RepresentationType", "'Curve2D'"), ("Items", "(#312)")]),
        r(312, "IFCPOLYLINE", &[("Points", "(#102,#313)")]),
        r(313, "IFCCARTESIANPOINT", &[("Coordinates", "(1.,0.,0.)")]),
    ]
    .concat();
    let text = String::from_utf8(storey_with_typed_wall(schema)).unwrap();
    let text: String = text.lines().filter(|l| !l.starts_with("#40=")).map(|l| format!("{l}\n")).collect();
    text.replacen("ENDSEC;\nEND-ISO", &format!("{records}ENDSEC;\nEND-ISO"), 1).into_bytes()
}

fn translated(x: f64) -> [[f64; 4]; 4] {
    let mut m = IDENTITY;
    m[0][3] = x;
    m
}

fn mapped_wall(n: u128, type_link: TypeLink, transform: [[f64; 4]; 4]) -> NewObject {
    let mut w = object(IfcClass::Wall, gid(n), Some(ObjectRef::Id(70)), Representation::Mapped(MappedBody::new(transform)));
    w.type_link = Some(type_link);
    w
}

/// `(min, max)` of every axis of the meshes the engine made for `id`.
fn bounds(result: &ifc_lite_processing::ProcessingResult, id: u32) -> [(f64, f64); 3] {
    let meshes: Vec<_> = result.meshes.iter().filter(|m| m.express_id == id).collect();
    assert!(!meshes.is_empty(), "#{id} not meshed");
    let mut b = [(f64::INFINITY, f64::NEG_INFINITY); 3];
    for m in meshes {
        for v in m.positions.chunks_exact(3) {
            for axis in 0..3 {
                b[axis] = (b[axis].0.min(f64::from(v[axis])), b[axis].1.max(f64::from(v[axis])));
            }
        }
    }
    b
}

fn extents(b: [(f64, f64); 3]) -> Vec<f64> {
    let mut e: Vec<f64> = b.iter().map(|(lo, hi)| hi - lo).collect();
    e.sort_by(f64::total_cmp);
    e
}

#[test]
fn a_copy_takes_its_source_types_body_through_a_mapped_item() {
    for schema in SCHEMAS {
        let source = type_with_maps(schema);
        let existing = || TypeLink::Existing(ObjectRef::Id(40));
        let (out, report) = run(&source, vec![add(mapped_wall(1, existing(), IDENTITY)), add(mapped_wall(2, existing(), translated(5.0)))]);
        assert_clean(&report, schema);
        assert!(crate::plan::validate::validate(&out, schema).is_empty(), "{schema}: {:?}", crate::plan::validate::validate(&out, schema));

        // Only the Body map is instanced, once per copy, from the copy's
        // own MappedRepresentation in the map's context.
        let items = ids_of_type(&out, "IFCMAPPEDITEM");
        assert_eq!(items.len(), 2, "{schema}");
        let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
        for &item in &items {
            assert_eq!(decoder.decode_by_id(item).unwrap().get_ref(0), Some(300), "{schema}: the Body map, not the Axis one");
        }
        assert_eq!(count(&out, "IFCREPRESENTATIONMAP"), 2, "{schema}: the source's maps, none new");
        assert_eq!(count(&out, "IFCEXTRUDEDAREASOLID"), 1, "{schema}: no geometry copied");
        assert!(String::from_utf8_lossy(&out).contains("(#100,'Body','MappedRepresentation',"), "{schema}");

        // The engine meshes both copies with the type's geometry, the second
        // five metres along.
        let result = ifc_lite_processing::process_geometry(&out);
        let (a, b) = (bounds(&result, id_in(&out, gid(1))), bounds(&result, id_in(&out, gid(2))));
        for e in [extents(a), extents(b)] {
            for (got, want) in e.iter().zip([0.2, 1.0, 2.0]) {
                assert!((got - want).abs() < 1e-4, "{schema}: extents {e:?}");
            }
        }
        assert!((b[0].0 - a[0].0 - 5.0).abs() < 1e-4, "{schema}: {a:?} vs {b:?}");
    }
}

/// A closed, outward-facing prism over an `n`-gon: many triangles, so the
/// size of a copy per occurrence shows.
fn prism(n: u32) -> TriangleMesh {
    let mut positions = Vec::new();
    for z in [0.0, 1.0] {
        for i in 0..n {
            let a = std::f64::consts::TAU * f64::from(i) / f64::from(n);
            positions.push([a.cos(), a.sin(), z]);
        }
    }
    positions.push([0.0, 0.0, 0.0]);
    positions.push([0.0, 0.0, 1.0]);
    let (bottom, top) = (2 * n, 2 * n + 1);
    let mut triangles = Vec::new();
    for i in 0..n {
        let j = (i + 1) % n;
        triangles.push([i, j, n + j]);
        triangles.push([i, n + j, n + i]);
        triangles.push([bottom, j, i]);
        triangles.push([top, n + i, n + j]);
    }
    TriangleMesh::new(positions, triangles)
}

#[test]
fn many_occurrences_share_one_new_type_map_instead_of_a_copy_each() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let colour = SurfaceColour::new([0.2, 0.5, 0.8], 0.0);
        let column = NewType::new(IfcClass::Named("IfcColumnType".into()))
            .with_global_id(gid(500))
            .with_name("Round column")
            .with_representation(Representation::Mesh(prism(64)))
            .with_style(colour);
        let typed = |n: u128, link: TypeLink| {
            let mut c = object(IfcClass::Named("IfcColumn".into()), gid(n), Some(ObjectRef::Id(70)), Representation::Mapped(MappedBody::new(translated(n as f64 * 2.0))));
            c.type_link = Some(link);
            add(c)
        };
        let mut plan = vec![typed(1, TypeLink::New(column))];
        plan.extend((2..=50).map(|n| typed(n, TypeLink::Existing(ObjectRef::Guid(gid(500).encode())))));
        let (out, report) = run(&source, plan);
        assert_clean(&report, schema);
        assert_eq!(report.added, 50, "{schema}");
        assert!(crate::plan::validate::validate(&out, schema).is_empty(), "{schema}");
        assert_eq!(count(&out, "IFCREPRESENTATIONMAP"), 1, "{schema}");
        assert_eq!(count(&out, "IFCMAPPEDITEM"), 50, "{schema}");
        let mesh_items = count(&out, "IFCTRIANGULATEDFACESET") + count(&out, "IFCFACETEDBREP");
        assert_eq!(mesh_items, 1, "{schema}: the mesh is written once");
        let ty = id_in(&out, gid(500));
        let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
        let maps_idx = crate::plan::attrs::attribute_index(schema, "IFCCOLUMNTYPE", "RepresentationMaps").unwrap();
        assert_eq!(decoder.decode_by_id(ty).unwrap().get_refs(maps_idx).map(|m| m.len()), Some(1), "{schema}");

        // The same fifty columns each carrying the mesh.
        let copies = (1..=50).map(|n| {
            let c = object(IfcClass::Named("IfcColumn".into()), gid(n), Some(ObjectRef::Id(70)), Representation::Mesh(prism(64)));
            add(NewObject { style: Some(colour), ..c })
        });
        let (flat, _) = run(&source, copies.collect());
        let base = source.len();
        assert!((out.len() - base) * 10 < (flat.len() - base), "{schema}: mapped {} bytes vs copied {}", out.len() - base, flat.len() - base);

        // Every instance is meshed in the type's colour at its own place.
        let result = ifc_lite_processing::process_geometry(&out);
        for n in [1u128, 25, 50] {
            let id = id_in(&out, gid(n));
            let b = bounds(&result, id);
            assert!((b[0].0 - (n as f64 * 2.0 - 1.0)).abs() < 1e-3, "{schema}: column {n} at {b:?}");
            let mesh = result.meshes.iter().find(|m| m.express_id == id).unwrap();
            assert!((mesh.color[2] - 0.8).abs() < 1e-3, "{schema}: colour {:?}", mesh.color);
        }
    }
}

#[test]
fn a_type_added_on_its_own_carries_a_map_later_adds_instance() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let t = NewType::new(IfcClass::Named("IfcWallType".into()))
            .with_global_id(gid(600))
            .with_name("Panel")
            .with_representation(Representation::Extrusion(block(1.0, 0.1, 2.5)));
        let link = || TypeLink::Existing(ObjectRef::Guid(gid(600).encode()));
        let (out, report) = run(
            &source,
            vec![(ObjectRef::Guid(gid(600).encode()), Disposition::AddType(Box::new(t))), add(mapped_wall(601, link(), IDENTITY)), add(mapped_wall(602, link(), translated(3.0)))],
        );
        assert_clean(&report, schema);
        assert!(crate::plan::validate::validate(&out, schema).is_empty(), "{schema}");
        assert_eq!((count(&out, "IFCREPRESENTATIONMAP"), count(&out, "IFCMAPPEDITEM")), (1, 2), "{schema}");
        let result = ifc_lite_processing::process_geometry(&out);
        let e = extents(bounds(&result, id_in(&out, gid(602))));
        assert!((e[2] - 2.5).abs() < 1e-4, "{schema}: {e:?}");
    }
}

#[test]
fn a_mapped_body_that_cannot_be_built_is_refused() {
    let source = type_with_maps("IFC4");
    let plain = storey_with_typed_wall("IFC4");
    let mesh_type = || NewType::new(IfcClass::Named("IfcWallType".into())).with_name("T");
    let mut scaled = IDENTITY;
    scaled[0][0] = 2.0;
    let mut coloured = mapped_wall(9, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY);
    coloured.style = Some(SurfaceColour::new([1.0, 0.0, 0.0], 0.0));
    let mut untyped = mapped_wall(9, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY);
    untyped.type_link = None;
    let cases: Vec<(&[u8], NewObject, &str)> = vec![
        (&source, untyped, "needs a type"),
        (&plain, mapped_wall(9, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY), "has no Body representation map"),
        (&source, coloured, "takes its type's colour"),
        (&source, mapped_wall(9, TypeLink::Existing(ObjectRef::Id(40)), scaled), "rotation and a translation"),
        (&source, mapped_wall(9, TypeLink::New(mesh_type()), IDENTITY), "new type to have a representation"),
        (
            &source,
            mapped_wall(9, TypeLink::New(mesh_type().with_representation(Representation::Mapped(MappedBody::new(IDENTITY)))), IDENTITY),
            "cannot itself be mapped",
        ),
    ];
    for (src, obj, expected) in cases {
        let (out, report) = run(src, vec![add(obj)]);
        assert_eq!(report.added, 0, "{expected}");
        assert!(report.refusals[0].reason.contains(expected), "{expected}: {:?}", report.refusals);
        assert_eq!(out, run(src, Vec::new()).0, "{expected}: a refused Add writes nothing");
    }
}

/// Deleting the source's only occurrence of the type keeps the maps a copy
/// in the same plan instances.
#[test]
fn a_delete_in_the_same_plan_keeps_the_maps_a_copy_instances() {
    for schema in SCHEMAS {
        let source = type_with_maps(schema);
        let copy = mapped_wall(1, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY);
        let (out, report) = run(&source, vec![(ObjectRef::Id(10), Disposition::Delete), add(copy)]);
        assert_clean(&report, schema);
        assert!(crate::plan::validate::validate(&out, schema).is_empty(), "{schema}");
        let index = FileIndex::scan(&out, &Default::default());
        assert!(index.contains(300) && index.contains(302), "{schema}: the Body map and its representation stay");
    }
}

/// Copies at one transform share one transformation operator, across Adds.
#[test]
fn copies_at_the_same_transform_share_one_operator() {
    let source = type_with_maps("IFC4");
    let copies = (1..=3).map(|n| add(mapped_wall(n, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY))).collect();
    let (out, report) = run(&source, copies);
    assert_clean(&report, "IFC4");
    assert_eq!((count(&out, "IFCMAPPEDITEM"), count(&out, "IFCCARTESIANTRANSFORMATIONOPERATOR3D")), (3, 1));
}

/// `type_with_maps` with a second Body map, `#320`, in a second 3D context
/// `#330`, listed first, as a type keeping one body per level of detail does.
fn type_with_two_bodies(schema: &str) -> Vec<u8> {
    let r = |id, entity, fields: &[(&str, &str)]| {
        let mut fields: Vec<(&str, String)> = fields.iter().map(|&(n, v)| (n, v.to_string())).collect();
        // IFC2X3 requires an owner history: the fixture preamble's.
        if schema == "IFC2X3" {
            fields.push(("OwnerHistory", "#5".into()));
        }
        build_record(schema, id, entity, &fields) + "\n"
    };
    let extra = [
        r(320, "IFCREPRESENTATIONMAP", &[("MappingOrigin", "#301"), ("MappedRepresentation", "#321")]),
        r(321, "IFCSHAPEREPRESENTATION", &[("ContextOfItems", "#330"), ("RepresentationIdentifier", "'Body'"), ("RepresentationType", "'SweptSolid'"), ("Items", "(#303)")]),
        r(330, "IFCGEOMETRICREPRESENTATIONCONTEXT", &[("ContextType", "'Model'"), ("CoordinateSpaceDimension", "3"), ("Precision", "1.E-05"), ("WorldCoordinateSystem", "#301")]),
    ]
    .concat();
    let text = String::from_utf8(type_with_maps(schema)).unwrap().replace("(#300,#310)", "(#320,#300,#310)");
    text.replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1).into_bytes()
}

/// One context's Body maps are instanced, the plan's body context first:
/// a level-of-detail alternative is not drawn on top.
#[test]
fn only_one_contexts_body_maps_are_instanced() {
    for schema in SCHEMAS {
        let source = type_with_two_bodies(schema);
        let (out, report) = run(&source, vec![add(mapped_wall(1, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY))]);
        assert_clean(&report, schema);
        let items = ids_of_type(&out, "IFCMAPPEDITEM");
        assert_eq!(items.len(), 1, "{schema}");
        let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
        assert_eq!(decoder.decode_by_id(items[0]).unwrap().get_ref(0), Some(300), "{schema}: the map in the body context #100");
    }
}

/// A representation without an identifier is body geometry when its type
/// says so, as the geometry engine reads it.
#[test]
fn a_map_without_an_identifier_is_body_by_its_type() {
    for schema in SCHEMAS {
        let source = String::from_utf8(type_with_maps(schema)).unwrap().replace("(#100,'Body','SweptSolid',(#303))", "(#100,$,'SweptSolid',(#303))");
        assert!(source.contains("(#100,$,'SweptSolid',(#303))"), "{schema}: fixture");
        let (out, report) = run(source.as_bytes(), vec![add(mapped_wall(1, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY))]);
        assert_clean(&report, schema);
        assert_eq!(count(&out, "IFCMAPPEDITEM"), 1, "{schema}");
    }
}

/// -0.0 and 0.0 are one transform.
#[test]
fn a_negative_zero_shares_the_operator() {
    let source = type_with_maps("IFC4");
    let mut negative = IDENTITY;
    negative[0][1] = -0.0;
    let link = || TypeLink::Existing(ObjectRef::Id(40));
    let (out, report) = run(&source, vec![add(mapped_wall(1, link(), IDENTITY)), add(mapped_wall(2, link(), negative))]);
    assert_clean(&report, "IFC4");
    assert_eq!(count(&out, "IFCCARTESIANTRANSFORMATIONOPERATOR3D"), 1);
}

/// A plan that deletes part of the type's Body map refuses the copy rather
/// than give it part of a body.
#[test]
fn a_body_map_the_plan_deletes_part_of_refuses_the_copy() {
    let source = type_with_maps("IFC4");
    let (_, report) = run(&source, vec![(ObjectRef::Id(302), Disposition::Delete), add(mapped_wall(1, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY))]);
    // Deleting the representation takes its map with it, and the refusal says so.
    let refusal = report.refusals.iter().find(|r| r.object == ObjectRef::Guid(gid(1).encode()));
    assert!(refusal.is_some_and(|r| r.reason.starts_with("the Body maps of type #40 are deleted by this plan")), "{:?}", report.refusals);
    assert_eq!(report.added, 0);
}

/// What a copy can still instance after a delete: a level of detail gone
/// with its context is no longer a candidate; a chosen map whose items are
/// gone refuses the copy.
#[test]
fn a_delete_takes_a_candidate_or_refuses_the_copy() {
    let link = || TypeLink::Existing(ObjectRef::Id(40));
    for schema in SCHEMAS {
        let (out, report) = run(&type_with_two_bodies(schema), vec![(ObjectRef::Id(330), Disposition::Delete), add(mapped_wall(1, link(), IDENTITY))]);
        assert_clean(&report, schema);
        let items = ids_of_type(&out, "IFCMAPPEDITEM");
        let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
        assert_eq!(items.iter().map(|&i| decoder.decode_by_id(i).unwrap().get_ref(0)).collect::<Vec<_>>(), [Some(300)], "{schema}");

        let (_, report) = run(&type_with_maps(schema), vec![(ObjectRef::Id(303), Disposition::Delete), add(mapped_wall(1, link(), IDENTITY))]);
        assert_eq!(report.added, 0, "{schema}: an empty body is not a copy");
        let refusal = report.refusals.iter().find(|r| r.object == ObjectRef::Guid(gid(1).encode()));
        assert!(refusal.is_some_and(|r| r.reason.starts_with("the Body maps of type #40 are deleted by this plan")), "{schema}: {:?}", report.refusals);
    }
}

/// A body's fallback is instanced only when the type has no plain Body.
#[test]
fn a_fallback_body_stands_in_only_without_a_body() {
    let fallback = |s: String| s.replace("(#100,'Body','SweptSolid',(#303))", "(#100,'Body-FallBack','SweptSolid',(#303))");
    let only = fallback(String::from_utf8(type_with_maps("IFC4X3")).unwrap());
    let (out, report) = run(only.as_bytes(), vec![add(mapped_wall(1, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY))]);
    assert_clean(&report, "IFC4X3");
    assert_eq!(count(&out, "IFCMAPPEDITEM"), 1);
    // With a plain Body map (#320) beside it in another context, only that one.
    let both = fallback(String::from_utf8(type_with_two_bodies("IFC4X3")).unwrap());
    let (out, report) = run(both.as_bytes(), vec![add(mapped_wall(1, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY))]);
    assert_clean(&report, "IFC4X3");
    let items = ids_of_type(&out, "IFCMAPPEDITEM");
    let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
    assert_eq!(items.iter().map(|&i| decoder.decode_by_id(i).unwrap().get_ref(0)).collect::<Vec<_>>(), [Some(320)]);
}

/// A non-Body identifier is not body geometry, whatever its type.
#[test]
fn a_clearance_map_is_not_instanced() {
    let source = String::from_utf8(type_with_maps("IFC4")).unwrap().replace("(#100,'Body','SweptSolid',(#303))", "(#100,'Clearance','SweptSolid',(#303))");
    let (_, report) = run(source.as_bytes(), vec![add(mapped_wall(1, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY))]);
    assert!(report.refusals[0].reason.contains("no Body representation map"), "{:?}", report.refusals);
}

/// A plain Body map this plan deletes part of gives way to the type's
/// intact fallback; a fallback that is not body geometry never stands in.
#[test]
fn a_fallback_stands_in_for_a_deleted_body_but_not_a_bounding_box() {
    let link = || TypeLink::Existing(ObjectRef::Id(40));
    // #320 is a Body-FallBack copy of the body in the second context.
    let source = String::from_utf8(type_with_two_bodies("IFC4X3")).unwrap().replace("(#330,'Body','SweptSolid',(#303))", "(#330,'Body-FallBack','SweptSolid',(#340))");
    let extra = build_record("IFC4X3", 340, "IFCEXTRUDEDAREASOLID", &[("SweptArea", "#304".into()), ("Position", "#301".into()), ("ExtrudedDirection", "#305".into()), ("Depth", "2.".into())]) + "\n";
    let source = source.replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
    let (out, report) = run(source.as_bytes(), vec![(ObjectRef::Id(303), Disposition::Delete), add(mapped_wall(1, link(), IDENTITY))]);
    assert_clean(&report, "IFC4X3");
    let items = ids_of_type(&out, "IFCMAPPEDITEM");
    let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
    assert_eq!(items.iter().map(|&i| decoder.decode_by_id(i).unwrap().get_ref(0)).collect::<Vec<_>>(), [Some(320)]);

    let boxed = String::from_utf8(type_with_maps("IFC4X3")).unwrap().replace("(#100,'Body','SweptSolid',(#303))", "(#100,'Body-FallBack','BoundingBox',(#303))");
    let (_, report) = run(boxed.as_bytes(), vec![add(mapped_wall(1, link(), IDENTITY))]);
    assert!(report.refusals[0].reason.contains("no Body representation map"), "{:?}", report.refusals);
}

/// When this plan breaks the body in the body context, the same rank's
/// intact body in another context is instanced, not a lower rank.
#[test]
fn an_intact_body_in_another_context_wins_over_a_fallback() {
    // #310 becomes a fallback in the body context, so a lower rank is there to take.
    let source = String::from_utf8(type_with_two_bodies("IFC4"))
        .unwrap()
        .replace("(#330,'Body','SweptSolid',(#303))", "(#330,'Body','SweptSolid',(#340))")
        .replace("(#100,'Axis','Curve2D',(#312))", "(#100,'Body-FallBack','SweptSolid',(#340))");
    let extra = build_record("IFC4", 340, "IFCEXTRUDEDAREASOLID", &[("SweptArea", "#304".into()), ("Position", "#301".into()), ("ExtrudedDirection", "#305".into()), ("Depth", "2.".into())]) + "\n";
    let source = source.replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
    let (out, report) = run(source.as_bytes(), vec![(ObjectRef::Id(303), Disposition::Delete), add(mapped_wall(1, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY))]);
    assert_clean(&report, "IFC4");
    let items = ids_of_type(&out, "IFCMAPPEDITEM");
    let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
    assert_eq!(items.iter().map(|&i| decoder.decode_by_id(i).unwrap().get_ref(0)).collect::<Vec<_>>(), [Some(320)]);
}

/// A map whose origin this plan deletes is unusable, and the refusal says so.
#[test]
fn a_deleted_map_origin_refuses_the_copy() {
    let source = String::from_utf8(type_with_maps("IFC4")).unwrap().replace("#300=IFCREPRESENTATIONMAP(#301,#302);", "#300=IFCREPRESENTATIONMAP(#350,#302);");
    let origin = build_record("IFC4", 350, "IFCAXIS2PLACEMENT3D", &[("Location", "#102".into())]) + "\n";
    let source = source.replacen("ENDSEC;\nEND-ISO", &format!("{origin}ENDSEC;\nEND-ISO"), 1);
    let (out, report) = run(source.as_bytes(), vec![(ObjectRef::Id(350), Disposition::Delete), add(mapped_wall(1, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY))]);
    assert_eq!(report.added, 0, "{:?}", report.refusals);
    assert!(crate::plan::validate::validate(&out, "IFC4").is_empty());
    let refusal = report.refusals.iter().find(|r| r.object == ObjectRef::Guid(gid(1).encode())).expect("refused");
    assert!(refusal.reason.starts_with("the Body maps of type #40 are deleted by this plan"), "{}", refusal.reason);
}

/// Deleting one of two Body maps in one context leaves the type, and the
/// copy, with the other.
#[test]
fn a_copy_instances_the_body_maps_its_type_keeps() {
    let source = String::from_utf8(type_with_two_bodies("IFC4")).unwrap().replace("(#330,'Body','SweptSolid',(#303))", "(#100,'Body','SweptSolid',(#303))");
    assert!(source.contains("#321=IFCSHAPEREPRESENTATION(#100,'Body'"), "fixture: both maps in #100");
    let (out, report) = run(source.as_bytes(), vec![(ObjectRef::Id(320), Disposition::Delete), add(mapped_wall(1, TypeLink::Existing(ObjectRef::Id(40)), IDENTITY))]);
    assert_clean(&report, "IFC4");
    let items = ids_of_type(&out, "IFCMAPPEDITEM");
    let mut decoder = ifc_lite_core::EntityDecoder::new(&out);
    assert_eq!(items.iter().map(|&i| decoder.decode_by_id(i).unwrap().get_ref(0)).collect::<Vec<_>>(), [Some(300)]);
}
