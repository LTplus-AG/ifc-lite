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
    let points: Vec<String> =
        coords.iter().map(|[x, y, z]| format!("({x:.3},{y:.3},{z:.3})")).collect();
    let content = wrap(&format!(
        "#2=IFCCARTESIANPOINTLIST3D(({}));\n{faces}#1=IFCPOLYGONALFACESET(#2,.F.,({face_refs}),$);\n",
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
