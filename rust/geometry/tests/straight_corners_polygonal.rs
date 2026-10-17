// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Re-closing the rvt01 and MiniBIM hosts after the census restore (#7809,
//! #7826, part of #7781): a corner that every face of an `IfcPolygonalFaceSet`
//! sees on a straight edge is dissolved from all of them, so no ear-clipper can
//! keep it on one side of the seam and cut it on the other.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};

/// A 4 x 2 x 1 box. Vertex 9 sits on the top-front edge, halfway; the top face
/// and the front face both list it. `extra` adds a face (entity lines and its
/// reference) so a test can turn vertex 9 into a real corner.
fn box_with_edge_vertex(extra: Option<(&str, &str)>) -> Mesh {
    let (lines, reference) = extra.unwrap_or(("", ""));
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #2=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(4.,0.,0.),(4.,2.,0.),(0.,2.,0.),\
         (0.,0.,1.),(4.,0.,1.),(4.,2.,1.),(0.,2.,1.),(2.,0.,1.),(3.,-1.,1.5)));\n\
         #10=IFCINDEXEDPOLYGONALFACE((1,4,3,2));\n#11=IFCINDEXEDPOLYGONALFACE((5,9,6,7,8));\n\
         #12=IFCINDEXEDPOLYGONALFACE((1,2,6,9,5));\n#13=IFCINDEXEDPOLYGONALFACE((3,4,8,7));\n\
         #14=IFCINDEXEDPOLYGONALFACE((1,5,8,4));\n#15=IFCINDEXEDPOLYGONALFACE((2,3,7,6));\n{lines}\
         #1=IFCPOLYGONALFACESET(#2,.T.,(#10,#11,#12,#13,#14,#15{reference}),$);\nENDSEC;\nEND-ISO-10303-21;\n"
    );
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(1).expect("decode");
    router.process_representation_item(&entity, &mut decoder).expect("mesh")
}

/// Signed volume of the closed box (4 x 2 x 1 = 8) from its triangles.
fn volume(mesh: &Mesh) -> f64 {
    let p = |i: u32| {
        let k = i as usize * 3;
        [mesh.positions[k] as f64, mesh.positions[k + 1] as f64, mesh.positions[k + 2] as f64]
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum()
}

#[test]
fn a_corner_both_faces_see_straight_leaves_both_and_the_box_is_twelve_triangles() {
    let mesh = box_with_edge_vertex(None);
    assert_eq!(mesh.triangle_count(), 12, "the straight corner must not survive in either face");
    assert!((volume(&mesh) - 8.0).abs() < 1e-5, "volume {}", volume(&mesh));
}

#[test]
fn a_corner_another_face_turns_at_stays_in_every_face() {
    // A triangle (9, 6, 10) hangs off vertex 9: it is a real corner of the set.
    let mesh = box_with_edge_vertex(Some(("#16=IFCINDEXEDPOLYGONALFACE((9,6,10));\n", ",#16")));
    // top 3 + front 3 + four side/bottom quads (2 each) + the triangle.
    assert_eq!(mesh.triangle_count(), 3 + 3 + 8 + 1);
}

/// A triangular prism whose base edges carry one straight corner each: the
/// one on edge A-B under a single side face (it dissolves), the one on edge
/// B-C under two side quads that pin it. The bottom cap is left a quad with
/// that pinned straight corner at index 1, where the quad split's `0-2`
/// diagonal used to cut it off as a zero-area ear of arbitrary winding
/// (three signed-open edges on a closed prism; found by fuzzing #7869).
#[test]
fn a_cap_left_a_quad_with_a_pinned_straight_corner_stays_closed() {
    let content = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #2=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(4.,0.,0.),(2.,2.,0.),(0.,4.,0.),\
         (0.,0.,1.),(2.,0.,1.),(4.,0.,1.),(2.,2.,1.),(0.,4.,1.)));\n\
         #10=IFCINDEXEDPOLYGONALFACE((5,4,3,2,1));\n#11=IFCINDEXEDPOLYGONALFACE((6,7,8,9,10));\n\
         #12=IFCINDEXEDPOLYGONALFACE((1,2,3,8,7,6));\n#13=IFCINDEXEDPOLYGONALFACE((3,4,9,8));\n\
         #14=IFCINDEXEDPOLYGONALFACE((4,5,10,9));\n#15=IFCINDEXEDPOLYGONALFACE((5,1,6,10));\n\
         #1=IFCPOLYGONALFACESET(#2,.T.,(#10,#11,#12,#13,#14,#15),$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let entity = decoder.decode_by_id(1).expect("decode");
    let mesh = GeometryRouter::new().process_representation_item(&entity, &mut decoder).expect("mesh");
    // Welded by position: the mesh may carry a vertex once per face.
    let at = |i: u32| {
        let k = i as usize * 3;
        [mesh.positions[k], mesh.positions[k + 1], mesh.positions[k + 2]].map(f32::to_bits)
    };
    let mut uses: std::collections::HashMap<([u32; 3], [u32; 3]), i32> = std::collections::HashMap::new();
    for t in mesh.indices.chunks_exact(3) {
        let t = [at(t[0]), at(t[1]), at(t[2])];
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *uses.entry((a.min(b), a.max(b))).or_insert(0) += if a < b { 1 } else { -1 };
        }
    }
    let p = |i: u32| {
        let k = i as usize * 3;
        nalgebra::Vector3::new(mesh.positions[k] as f64, mesh.positions[k + 1] as f64, mesh.positions[k + 2] as f64)
    };
    let slivers = mesh
        .indices
        .chunks_exact(3)
        .filter(|t| (p(t[1]) - p(t[0])).cross(&(p(t[2]) - p(t[0]))).norm() < 1e-9)
        .count();
    assert_eq!(slivers, 0, "a zero-area ear survives; CSG hygiene drops it and tears the seam");
    let open = uses.values().filter(|&&n| n != 0).count();
    assert_eq!(open, 0, "signed-open edges on a closed prism");
    assert!((volume(&mesh) - 8.0).abs() < 1e-5, "volume {}", volume(&mesh));
}
