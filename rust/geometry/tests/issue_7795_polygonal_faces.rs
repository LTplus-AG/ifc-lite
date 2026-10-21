// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7795 (sibling of #7686): `IfcPolygonalFaceSet` faces go through the one
//! planar-face home (`triangulate_planar_face` / `quad_split_3d`), so
//! - a concave quad is split across its INTERIOR diagonal (the fixed `0-2`
//!   fan covered the convex hull twice for a reflex vertex 1 or 3), and
//! - a holed face whose triangulation fails is refused and counted (D3),
//!   never filled over its openings by a fan of the outer loop.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};

fn wrap(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// `IfcPolygonalFaceSet` #1 over `coords` (flat `x,y,z` triples) and `faces`
/// (entity lines for #10.., listed by `face_refs`). Returns the mesh and the
/// unsupported-item counts.
fn process(coords: &[[f64; 3]], faces: &str, face_refs: &str) -> (Mesh, Vec<(String, u64)>) {
    process_closed(coords, faces, face_refs, false)
}

fn process_closed(
    coords: &[[f64; 3]],
    faces: &str,
    face_refs: &str,
    closed: bool,
) -> (Mesh, Vec<(String, u64)>) {
    let points: Vec<String> =
        coords.iter().map(|[x, y, z]| format!("({x:.3},{y:.3},{z:.3})")).collect();
    let closed = if closed { ".T." } else { ".F." };
    let content = wrap(&format!(
        "#2=IFCCARTESIANPOINTLIST3D(({}));\n{faces}#1=IFCPOLYGONALFACESET(#2,{closed},({face_refs}),$);\n",
        points.join(",")
    ));
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(1).expect("decode");
    let mesh = router.process_representation_item(&entity, &mut decoder).expect("mesh");
    let mut counted: Vec<_> = router.take_unsupported_items().into_iter().collect();
    counted.sort();
    (mesh, counted)
}

/// Sum of (unsigned) triangle areas, and of signed areas about +Z.
fn areas(mesh: &Mesh) -> (f64, f64) {
    let p = |i: u32| {
        let k = i as usize * 3;
        [mesh.positions[k] as f64, mesh.positions[k + 1] as f64]
    };
    let signed: Vec<f64> = mesh
        .indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0
        })
        .collect();
    (signed.iter().map(|a| a.abs()).sum(), signed.iter().sum())
}

/// The dart `[(0,0),(2,2),(4,0),(2,10)]`: CCW, signed area 16, reflex at
/// vertex 1. The `0-2` fan covers the hull twice (total area 40).
#[test]
fn concave_polygonal_quad_covers_its_own_area_once_7795() {
    for ring in ["(1,2,3,4)", "(4,3,2,1)", "(2,3,4,1)"] {
        let (mesh, counted) = process(
            &[[0., 0., 0.], [2., 2., 0.], [4., 0., 0.], [2., 10., 0.]],
            &format!("#10=IFCINDEXEDPOLYGONALFACE({ring});\n"),
            "#10",
        );
        let (unsigned, signed) = areas(&mesh);
        assert!(counted.is_empty(), "{counted:?}");
        assert!((unsigned - 16.0).abs() < 1e-6, "{ring}: triangles cover {unsigned}, ring is 16");
        assert!((signed.abs() - 16.0).abs() < 1e-6, "{ring}: signed {signed}");
    }
}

/// A convex quad keeps the `0-2` split byte for byte.
#[test]
fn convex_polygonal_quad_is_unchanged_7795() {
    let (mesh, _) = process(
        &[[0., 0., 0.], [4., 0., 0.], [4., 4., 0.], [0., 4., 0.]],
        "#10=IFCINDEXEDPOLYGONALFACE((1,2,3,4));\n",
        "#10",
    );
    assert_eq!(mesh.indices.len(), 6);
    assert!((areas(&mesh).0 - 16.0).abs() < 1e-6);
}

/// An open unit quad remains two real triangles with unit area.
#[test]
fn open_unit_quad_keeps_two_triangles_7795() {
    let (mesh, counted) = process(
        &[[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]],
        "#10=IFCINDEXEDPOLYGONALFACE((1,2,3,4));\n",
        "#10",
    );
    assert_eq!(mesh.indices.len(), 6);
    assert!((areas(&mesh).0 - 1.0).abs() < 1e-6);
    assert!(counted.is_empty());
}

/// A missing independent face record drops only that entry and is reported
/// through the public router path (#7779).
#[test]
fn dangling_polygonal_face_refuses_only_that_face_7779() {
    let coords = [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]];
    let authored = "#10=IFCINDEXEDPOLYGONALFACE((1,2,3));\n";
    let (reference, clean) = process(&coords, authored, "#10");
    assert!(clean.is_empty());
    for refs in ["#10,#999", "#999,#10"] {
        let (mesh, counted) = process(&coords, authored, refs);
        assert_eq!(mesh.indices, reference.indices, "authored indices survive for {refs}");
        assert_eq!(mesh.positions, reference.positions, "authored vertices survive for {refs}");
        assert_eq!(mesh.normals, reference.normals, "authored normals survive for {refs}");
        assert_eq!(mesh.indices.len(), 3, "the authored triangle survives for {refs}");
        assert_eq!(areas(&mesh).0, 0.5);
        assert_eq!(counted, vec![("IfcIndexedPolygonalFace".to_string(), 1)]);
    }
}

/// A refusal is drained per representation item; it does not leak into the
/// next valid direct item on the same router/thread (#7779).
#[test]
fn dangling_face_refusal_does_not_leak_to_next_router_item_7779() {
    let content = wrap(
        "#2=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(1.,1.,0.)));\n\
         #10=IFCINDEXEDPOLYGONALFACE((1,2,3));\n\
         #1=IFCPOLYGONALFACESET(#2,.F.,(#999),$);\n\
         #3=IFCPOLYGONALFACESET(#2,.F.,(#10),$);\n",
    );
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let router = GeometryRouter::new();

    let missing = decoder.decode_by_id(1).expect("decode set");
    let empty = router.process_representation_item(&missing, &mut decoder).expect("missing face is a partial success");
    assert!(empty.indices.is_empty());
    assert_eq!(router.take_unsupported_items().get("IfcIndexedPolygonalFace"), Some(&1));

    let valid = decoder.decode_by_id(3).expect("decode following set");
    let mesh = router.process_representation_item(&valid, &mut decoder).expect("valid following item");
    assert_eq!(mesh.indices.len(), 3);
    assert!(router.take_unsupported_items().is_empty(), "previous refusal must already be drained");
}

/// A missing or malformed Coordinates attribute remains a set-level error;
/// face-local recovery must not invent a coordinate basis (#7779).
#[test]
fn polygonal_face_recovery_does_not_hide_bad_coordinates_7779() {
    for coordinates in ["$", "'not-an-entity'"] {
        let content = wrap(&format!(
            "#1=IFCPOLYGONALFACESET({coordinates},.F.,(#999),$);\n"
        ));
        let index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, index);
        let router = GeometryRouter::new();
        let set = decoder.decode_by_id(1).expect("decode set");
        assert!(router.process_representation_item(&set, &mut decoder).is_err(), "Coordinates={coordinates}");
    }
}

/// Missing-only and repeated missing entries produce no fabricated geometry;
/// the refusal signal is deduplicated by face type for this item (#7779).
#[test]
fn all_missing_polygonal_faces_are_empty_and_counted_7779() {
    let coords = [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.]];
    let (mesh, counted) = process(&coords, "", "#999,#999");
    assert!(mesh.indices.is_empty());
    assert!(mesh.positions.is_empty());
    assert_eq!(counted, vec![("IfcIndexedPolygonalFace".to_string(), 1)]);
}

fn cube_face_records() -> String {
    [
        "#10=IFCINDEXEDPOLYGONALFACE((1,4,3,2));\n",
        "#11=IFCINDEXEDPOLYGONALFACE((5,6,7,8));\n",
        "#12=IFCINDEXEDPOLYGONALFACE((1,2,6,5));\n",
        "#13=IFCINDEXEDPOLYGONALFACE((2,3,7,6));\n",
        "#14=IFCINDEXEDPOLYGONALFACE((3,4,8,7));\n",
        "#15=IFCINDEXEDPOLYGONALFACE((4,1,5,8));\n",
    ]
    .concat()
}

fn signed_volume(mesh: &Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|tri| {
            let point = |i: u32| {
                let i = i as usize * 3;
                [mesh.positions[i] as f64, mesh.positions[i + 1] as f64, mesh.positions[i + 2] as f64]
            };
            let (a, b, c) = (point(tri[0]), point(tri[1]), point(tri[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1])
                + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum()
}

/// Closed cube control and the same authored shell with one dangling entry
/// retain the authored twelve triangles; no face is synthesized (#7779).
#[test]
fn closed_polygonal_cube_with_dangling_entry_keeps_authored_shell_7779() {
    let coords = [
        [0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.],
        [0., 0., 1.], [1., 0., 1.], [1., 1., 1.], [0., 1., 1.],
    ];
    let records = cube_face_records();
    let refs = "#10,#11,#12,#13,#14,#15";
    let (cube, clean) = process_closed(&coords, &records, refs, true);
    assert!(clean.is_empty());
    assert_eq!(cube.indices.len() / 3, 12);
    assert!((signed_volume(&cube) - 1.0).abs() < 1e-6, "outward volume {}", signed_volume(&cube));

    let (with_dangling, counted) = process_closed(&coords, &records, &format!("{refs},#999"), true);
    assert_eq!(with_dangling.indices, cube.indices);
    assert_eq!(with_dangling.positions, cube.positions);
    assert_eq!(with_dangling.normals, cube.normals);
    assert_eq!(with_dangling.indices.len() / 3, 12);
    assert!((signed_volume(&with_dangling) - 1.0).abs() < 1e-6);
    assert_eq!(counted, vec![("IfcIndexedPolygonalFace".to_string(), 1)]);
}

/// A holed face whose triangulation fails (two overlapping openings) is
/// refused and counted under its real type; the sibling face still meshes.
/// It used to be a fan of the outer loop: filled over both openings.
#[test]
fn failed_holed_face_is_refused_not_filled_7795() {
    let coords = [
        [0., 0., 0.], [10., 0., 0.], [10., 10., 0.], [0., 10., 0.], // outer 1..4
        [2., 2., 0.], [6., 2., 0.], [6., 6., 0.], [2., 6., 0.], // opening A 5..8
        [4., 4., 0.], [8., 4., 0.], [8., 8., 0.], [4., 8., 0.], // opening B 9..12 (overlaps A)
        [20., 0., 0.], [21., 0., 0.], [20., 1., 0.], // a plain triangle 13..15
    ];
    let (mesh, counted) = process(
        &coords,
        "#10=IFCINDEXEDPOLYGONALFACEWITHVOIDS((1,2,3,4),((5,6,7,8),(9,10,11,12)));\n\
         #11=IFCINDEXEDPOLYGONALFACE((13,14,15));\n",
        "#10,#11",
    );
    assert_eq!(mesh.indices.len(), 3, "only the plain triangle survives");
    assert!((areas(&mesh).0 - 0.5).abs() < 1e-6);
    assert_eq!(counted, vec![("IfcIndexedPolygonalFaceWithVoids".to_string(), 1)]);
}

/// Control: one valid opening still cuts a hole.
#[test]
fn valid_opening_still_cuts_a_hole_7795() {
    let coords = [
        [0., 0., 0.], [10., 0., 0.], [10., 10., 0.], [0., 10., 0.],
        [2., 2., 0.], [6., 2., 0.], [6., 6., 0.], [2., 6., 0.],
    ];
    let (mesh, counted) = process(
        &coords,
        "#10=IFCINDEXEDPOLYGONALFACEWITHVOIDS((1,2,3,4),((5,6,7,8)));\n",
        "#10",
    );
    assert!(counted.is_empty(), "{counted:?}");
    assert!((areas(&mesh).0 - 84.0).abs() < 1e-6);
}
