// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #7689 (Rust sweep B6e): one index rule for both tessellated face
//! sets. `PnIndex` remaps on `IfcTriangulatedFaceSet` as on
//! `IfcPolygonalFaceSet` (PROC-3), the CoordIndex fast path refuses what the
//! decoded path refuses (PROC-14, CORE-12), and `Closed = $` orients the
//! same way in both processors (PROC-3).

use super::{PolygonalFaceSetProcessor, TriangulatedFaceSetProcessor};
use crate::processors::texture::{ImageTextureRef, ResolvedTextureMap, TextureSource};
use crate::router::GeometryProcessor;
use crate::{Mesh, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema};

type Triangle = [[f32; 3]; 3];

/// Four points: the origin and the three unit-10 axis tips.
const POINTS: &str = "#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(10.,0.,0.),(0.,10.,0.),(0.,0.,10.)));\n";

fn mesh(content: &str, id: u32) -> Mesh {
    let mut decoder = EntityDecoder::new(content);
    let entity = decoder.decode_by_id(id).expect("face set decodes");
    let schema = IfcSchema::new();
    let quality = TessellationQuality::Medium;
    if entity.ifc_type == ifc_lite_core::IfcType::IfcPolygonalFaceSet {
        PolygonalFaceSetProcessor::new().process(&entity, &mut decoder, &schema, quality)
    } else {
        TriangulatedFaceSetProcessor::new().process(&entity, &mut decoder, &schema, quality)
    }
    .expect("face set meshes")
}

fn triangles(mesh: &Mesh) -> Vec<Triangle> {
    let p = |i: u32| {
        let i = i as usize * 3;
        [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]
    };
    mesh.indices.chunks_exact(3).map(|t| [p(t[0]), p(t[1]), p(t[2])]).collect()
}

/// The triangulated and the polygonal spelling of the same faces, with the
/// same `Closed` and `PnIndex` (`$` for none).
fn both(faces: &[&str], closed: &str, pn_index: &str) -> (Vec<Triangle>, Vec<Triangle>) {
    let coord_index = faces.join(",");
    let triangulated = format!("{POINTS}#2=IFCTRIANGULATEDFACESET(#1,$,{closed},({coord_index}),{pn_index});\n");
    let mut polygonal = POINTS.to_string();
    let face_ids: Vec<String> = (0..faces.len()).map(|i| format!("#{}", 10 + i)).collect();
    for (i, face) in faces.iter().enumerate() {
        polygonal.push_str(&format!("#{}=IFCINDEXEDPOLYGONALFACE({face});\n", 10 + i));
    }
    polygonal.push_str(&format!("#3=IFCPOLYGONALFACESET(#1,{closed},({}),{pn_index});\n", face_ids.join(",")));
    (triangles(&mesh(&triangulated, 2)), triangles(&mesh(&polygonal, 3)))
}

const O: [f32; 3] = [0., 0., 0.];
const X: [f32; 3] = [10., 0., 0.];
const Y: [f32; 3] = [0., 10., 0.];
const Z: [f32; 3] = [0., 0., 10.];

/// PROC-3: CoordIndex values index `PnIndex`, whose values index
/// `Coordinates`. The triangulated processor used CoordIndex against
/// `Coordinates` directly and drew `(O, X, Y)` here.
#[test]
fn triangulated_face_set_remaps_through_pn_index_7689() {
    let (triangulated, polygonal) = both(&["(1,2,3)"], ".F.", "(4,2,3)");
    assert_eq!(triangulated, vec![[Z, X, Y]], "PROC-3: IfcTriangulatedFaceSet must honour PnIndex");
    assert_eq!(polygonal, triangulated, "both face sets apply the one PnIndex rule");
}

/// PROC-3 follow-on: an invalid `PnIndex` entry is a hole in the remap, not a
/// gap that shifts every later entry left. The polygonal processor filtered
/// `0` out of the list first, so `(2,3,4)` read entries 2 and 3 of the
/// compacted list and the face drew the wrong vertices or none at all.
#[test]
fn invalid_pn_index_entry_keeps_later_positions_7689() {
    let (triangulated, polygonal) = both(&["(2,3,4)", "(1,2,3)"], ".F.", "(0,4,2,3)");
    assert_eq!(polygonal, vec![[Z, X, Y]], "(2,3,4) resolves through PnIndex 2..4; (1,2,3) uses the invalid entry and is dropped");
    assert_eq!(triangulated, polygonal);
}

/// A CoordIndex past the end of `PnIndex`, or a `PnIndex` entry past the end
/// of `Coordinates`, drops the face: neither falls back to `Coordinates`.
#[test]
fn out_of_range_through_pn_index_drops_the_face_7689() {
    let (triangulated, polygonal) = both(&["(1,2,3)", "(1,2,4)", "(2,3,5)"], ".F.", "(4,2,3,9)");
    assert_eq!(triangulated, vec![[Z, X, Y]]);
    assert_eq!(polygonal, triangulated);
}

/// PROC-14 / CORE-12: the raw-byte CoordIndex fast path accepted `-` and
/// read `-2` as `2`, read `0` as vertex 1, and flattened every digit run so a
/// two- or four-entry face shifted every later triangle. Only the two
/// well-formed faces may survive, and they must be the right two.
#[test]
fn coord_index_fast_path_refuses_what_the_decoded_path_refuses_7689() {
    let faces = ["(1,2,3)", "(1,-2,3)", "(0,2,3)", "(1,2)", "(1,2,3,4)", "(2,3,4)"];
    let (triangulated, polygonal) = both(&faces, ".F.", "$");
    assert_eq!(triangulated, vec![[O, X, Y], [X, Y, Z]], "PROC-14: malformed faces are dropped, not aliased");
    // The polygonal reading of the same loops: a loop of four is a quad, so
    // `(1,2,3,4)` legitimately meshes there. Every other bad loop is dropped.
    assert_eq!(polygonal.len(), 4, "(1,2,3), the (1,2,3,4) quad's two triangles, (2,3,4): {polygonal:?}");
    assert_eq!(polygonal.first(), Some(&[O, X, Y]));
    assert_eq!(polygonal.last(), Some(&[X, Y, Z]));
}

/// Which CoordIndex grammar runs depended only on whether the decoder could
/// hand back the face set's raw bytes, so one file meshed differently in the
/// two configurations. Drive both: the fast path with the face set's own
/// decoder, the decoded path with a decoder that holds only the point list.
#[test]
fn fast_and_decoded_coord_index_paths_mesh_identically_7689() {
    let quality = TessellationQuality::Medium;
    let cases = ["((1,2,3),(2,3,4))", "((1,2,3),(0,3,4))", "((1,2,3),(2,-3,4))", "((1,2),(2,3,4))", "((1,2,3,4),(2,3,4))", "((1,2,3),(1,2,9))"];
    for coord_index in cases {
        for pn_index in ["$", "(4,3,2,1)", "(0,1,2,3)"] {
            let content = format!("{POINTS}#2=IFCTRIANGULATEDFACESET(#1,$,.F.,{coord_index},{pn_index});\n");
            let fast = triangles(&mesh(&content, 2));
            let entity = EntityDecoder::new(&content).decode_by_id(2).unwrap();
            let mut points_only = EntityDecoder::new(POINTS);
            assert!(points_only.get_raw_bytes(2).is_none(), "the face set's raw bytes are out of reach");
            let decoded = TriangulatedFaceSetProcessor::new()
                .process(&entity, &mut points_only, &IfcSchema::new(), quality)
                .unwrap();
            assert_eq!(fast, triangles(&decoded), "{coord_index} PnIndex {pn_index}");
        }
    }
}

fn signed_volume(triangles: &[Triangle]) -> f64 {
    triangles
        .iter()
        .map(|[a, b, c]| {
            let [a, b, c] = [a, b, c].map(|p| p.map(f64::from));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
        })
        .sum()
}

/// PROC-3: the two processors read `Closed = $` oppositely. The triangulated
/// one orients an unknown shell outward (#819, Revit closed shells written
/// with `$`); the polygonal one left it inward. One policy now: orient unless
/// `Closed = .F.`.
#[test]
fn closed_unknown_orients_the_same_in_both_processors_7689() {
    // An inward-wound tetrahedron (every face reversed).
    let inward = ["(1,2,3)", "(1,4,2)", "(1,3,4)", "(2,4,3)"];
    for closed in [".T.", "$"] {
        let (triangulated, polygonal) = both(&inward, closed, "$");
        assert!(signed_volume(&triangulated) > 0.0, "Closed = {closed}: triangulated shell faces outward");
        assert!(signed_volume(&polygonal) > 0.0, "Closed = {closed}: polygonal shell faces outward");
    }
    // `.F.` is an explicit open shell: winding is kept as authored.
    let (triangulated, polygonal) = both(&inward, ".F.", "$");
    assert!(signed_volume(&triangulated) < 0.0);
    assert!(signed_volume(&polygonal) < 0.0);
}

/// With `TexCoordIndex = $` the CoordIndex doubles as the UV index (#1781).
/// Under `PnIndex` that is the authored CoordIndex value, not the remapped
/// coordinate: texture vertex `n` pairs with the face set's `n`-th point.
#[test]
fn texture_without_tex_coord_index_pairs_uvs_with_coord_index_under_pn_index_7689() {
    let content = format!("{POINTS}#2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),(4,2,3));\n");
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(2).unwrap();
    let map = ResolvedTextureMap {
        texture_id: 9,
        texture: TextureSource::Image(ImageTextureRef { url: "t.png".into(), repeat_s: true, repeat_t: true }),
        tex_coords: vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
        tex_coord_index: None,
    };
    let (mesh, uvs) = TriangulatedFaceSetProcessor::new().process_with_texture(&entity, &mut decoder, &map).unwrap();
    assert_eq!(triangles(&mesh), vec![[Z, X, Y]]);
    // V is flipped to a top-left origin.
    assert_eq!(uvs, vec![0.0, 1.0, 1.0, 1.0, 0.0, 0.0]);
}
