// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Planar face triangulation and winding through the brep processors
//! (#7686: GEOM-3, PROC-S10, PROC-S5, PROC-S16, and the D14 hole-loop rule).

use super::super::advanced_face::process_advanced_face;
use super::{FaceBasedSurfaceModelProcessor, FacetedBrepProcessor};
use crate::router::GeometryProcessor;
use crate::{Mesh, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema};

/// Signed area of every triangle projected on +Z (CCW about +Z is positive).
fn signed_area_z(mesh: &Mesh) -> f64 {
    let p = |i: u32| {
        let b = i as usize * 3;
        (mesh.positions[b] as f64, mesh.positions[b + 1] as f64)
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            0.5 * ((b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0))
        })
        .sum()
}

/// `IfcFacetedBrep` (#90) over the faces in `body`, which defines `#20` as
/// the face list's single face.
fn faceted(body: &str) -> (Mesh, bool) {
    let content = format!("{body}#80=IFCCLOSEDSHELL((#20));\n#90=IFCFACETEDBREP(#80);\n");
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(90).unwrap();
    let _ = crate::processors::take_face_refused();
    let mesh = FacetedBrepProcessor::new()
        .process(&entity, &mut decoder, &IfcSchema::new(), TessellationQuality::Medium)
        .expect("a faceted brep never fails as a whole for a refused face");
    (mesh, crate::processors::take_face_refused())
}

/// The dart `[(0,0),(2,2),(4,0),(2,10)]`: CCW, signed area +16, reflex at
/// vertex 1. `ring` lists the point numbers in loop order.
fn dart_points() -> &'static str {
    "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((2.,2.,0.));\
     #3=IFCCARTESIANPOINT((4.,0.,0.));#4=IFCCARTESIANPOINT((2.,10.,0.));\n"
}

fn dart_face(ring: &str, bound: &str) -> String {
    format!(
        "{}#10=IFCPOLYLOOP(({ring}));#11={bound}(#10,.T.);{}",
        dart_points(),
        "#20=IFCFACE((#11));\n"
    )
}

/// GEOM-3 / PROC-S10: a hole-free concave quad was fanned `0,1,2 / 0,2,3`
/// across the OUTSIDE diagonal. Every rotation of the ring (reflex vertex at
/// 1, 2, 3 or 0) must cover the dart once, wound with the ring.
#[test]
fn concave_quad_is_covered_once_in_every_rotation() {
    for ring in ["#1,#2,#3,#4", "#2,#3,#4,#1", "#3,#4,#1,#2", "#4,#1,#2,#3"] {
        let (mesh, refused) = faceted(&dart_face(ring, "IFCFACEOUTERBOUND"));
        assert!(!refused);
        assert_eq!(mesh.indices.len(), 6, "ring {ring}");
        let area = signed_area_z(&mesh);
        assert!((area - 16.0).abs() < 1e-4, "ring {ring}: signed area {area}, want +16");
        for t in mesh.indices.chunks_exact(3) {
            let one = Mesh { indices: t.to_vec(), ..mesh.clone() };
            assert!(signed_area_z(&one) > 0.0, "ring {ring}: a triangle winds against the ring");
        }
    }
}

/// The same dart wound clockwise keeps its own winding (signed area -16).
#[test]
fn concave_clockwise_quad_keeps_its_winding() {
    let (mesh, _) = faceted(&dart_face("#4,#3,#2,#1", "IFCFACEOUTERBOUND"));
    let area = signed_area_z(&mesh);
    assert!((area + 16.0).abs() < 1e-4, "signed area {area}, want -16");
}

/// GEOM-3: the quad normal came from `(p1-p0)x(p2-p0)`, which is -Z for the
/// CCW dart, so a concave quad with a hole was mirrored and wound backwards.
#[test]
fn concave_quad_with_a_hole_winds_with_its_ring() {
    let body = format!(
        "{}#5=IFCCARTESIANPOINT((1.9,3.,0.));#6=IFCCARTESIANPOINT((2.1,3.,0.));\
         #7=IFCCARTESIANPOINT((2.,4.,0.));\
         #10=IFCPOLYLOOP((#1,#2,#3,#4));#11=IFCFACEOUTERBOUND(#10,.T.);\
         #12=IFCPOLYLOOP((#5,#6,#7));#13=IFCFACEBOUND(#12,.T.);\
         #20=IFCFACE((#11,#13));\n",
        dart_points()
    );
    let (mesh, refused) = faceted(&body);
    assert!(!refused);
    let area = signed_area_z(&mesh);
    // 16 minus the 0.2 x 1 triangular hole.
    assert!((area - 15.9).abs() < 1e-3, "signed area {area}, want +15.9");
}

const SQUARE_WITH_BAD_HOLE: &str = "\
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((10.,0.,0.));\
#3=IFCCARTESIANPOINT((10.,10.,0.));#4=IFCCARTESIANPOINT((0.,10.,0.));\
#5=IFCCARTESIANPOINT((4.,4.,0.));#6=IFCCARTESIANPOINT((1.0E400,4.,0.));\
#7=IFCCARTESIANPOINT((6.,6.,0.));\
#10=IFCPOLYLOOP((#1,#2,#3,#4));#11=IFCFACEOUTERBOUND(#10,.T.);\
#12=IFCPOLYLOOP((#5,#6,#7));#13=IFCFACEBOUND(#12,.T.);\
#20=IFCFACE((#11,#13));\n";

/// PROC-S5: a hole that cannot be triangulated filled the opening with a fan
/// of the outer ring. The face is refused (empty, counted), as the planar
/// advanced-face path already does.
#[test]
fn faceted_hole_that_cannot_triangulate_refuses_the_face() {
    let (mesh, refused) = faceted(SQUARE_WITH_BAD_HOLE);
    assert!(mesh.is_empty(), "no filled pane over the authored opening");
    assert!(refused, "the refusal is counted");
}

/// The surface-model processors share the faceted face triangulator.
#[test]
fn surface_model_hole_that_cannot_triangulate_refuses_the_face() {
    let content =
        format!("{SQUARE_WITH_BAD_HOLE}#30=IFCCONNECTEDFACESET((#20));\n#31=IFCFACEBASEDSURFACEMODEL((#30));\n");
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(31).unwrap();
    let _ = crate::processors::take_face_refused();
    let mesh = FaceBasedSurfaceModelProcessor::new()
        .process(&entity, &mut decoder, &IfcSchema::new(), TessellationQuality::Medium)
        .unwrap();
    assert!(mesh.is_empty());
    assert!(crate::processors::take_face_refused());
}

const SQUARE_WITH_UNREADABLE_HOLE: &str = "\
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((10.,0.,0.));\
#3=IFCCARTESIANPOINT((10.,10.,0.));#4=IFCCARTESIANPOINT((0.,10.,0.));\
#5=IFCCARTESIANPOINT((4.,4.,0.));#7=IFCCARTESIANPOINT((6.,6.,0.));\
#10=IFCPOLYLOOP((#1,#2,#3,#4));#11=IFCFACEOUTERBOUND(#10,.T.);\
#12=IFCPOLYLOOP((#5,#99,#7));#13=IFCFACEBOUND(#12,.T.);\
#20=IFCFACE((#11,#13));\n";

/// D14: a hole loop that does not read refuses the face. Dropping it drew the
/// face filled over its opening.
#[test]
fn faceted_unreadable_hole_loop_refuses_the_face() {
    let (mesh, refused) = faceted(SQUARE_WITH_UNREADABLE_HOLE);
    assert!(mesh.is_empty());
    assert!(refused);
}

#[test]
fn surface_model_unreadable_hole_loop_refuses_the_face() {
    let content = format!(
        "{SQUARE_WITH_UNREADABLE_HOLE}#30=IFCCONNECTEDFACESET((#20));\n#31=IFCFACEBASEDSURFACEMODEL((#30));\n"
    );
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(31).unwrap();
    let _ = crate::processors::take_face_refused();
    let mesh = FaceBasedSurfaceModelProcessor::new()
        .process(&entity, &mut decoder, &IfcSchema::new(), TessellationQuality::Medium)
        .unwrap();
    assert!(mesh.is_empty());
    assert!(crate::processors::take_face_refused());
}

/// A hole loop under three points is degenerate, not unread: the face still
/// renders, as before (the bounds reader's rule, `advanced_face/bounds.rs`).
#[test]
fn faceted_degenerate_hole_loop_is_skipped_not_refused() {
    let body = SQUARE_WITH_UNREADABLE_HOLE.replace("(#5,#99,#7)", "(#5,#7)");
    let (mesh, refused) = faceted(&body);
    assert!(!refused);
    assert!((signed_area_z(&mesh) - 100.0).abs() < 1e-3);
}

/// A unit cube of six planar `IfcAdvancedFace`s whose loops wind CCW about the
/// OUTWARD normal. `flip` lists faces authored `SameSense=.F.` (their plane
/// axis points inward). Returns the signed volume of the tessellation.
fn cube_signed_volume(flip: &[usize]) -> f64 {
    // (outward normal, 4 corners CCW about it)
    let faces: [([f64; 3], [[f64; 3]; 4]); 6] = [
        ([0., 0., -1.], [[0., 0., 0.], [0., 1., 0.], [1., 1., 0.], [1., 0., 0.]]),
        ([0., 0., 1.], [[0., 0., 1.], [1., 0., 1.], [1., 1., 1.], [0., 1., 1.]]),
        ([0., -1., 0.], [[0., 0., 0.], [1., 0., 0.], [1., 0., 1.], [0., 0., 1.]]),
        ([0., 1., 0.], [[0., 1., 0.], [0., 1., 1.], [1., 1., 1.], [1., 1., 0.]]),
        ([-1., 0., 0.], [[0., 0., 0.], [0., 0., 1.], [0., 1., 1.], [0., 1., 0.]]),
        ([1., 0., 0.], [[1., 0., 0.], [1., 1., 0.], [1., 1., 1.], [1., 0., 1.]]),
    ];
    let mut s = String::new();
    for (k, (n, c)) in faces.iter().enumerate() {
        let b = 100 * (k + 1);
        let sign = if flip.contains(&k) { -1.0 } else { 1.0 };
        for (i, p) in c.iter().enumerate() {
            s += &format!("#{}=IFCCARTESIANPOINT(({:?},{:?},{:?}));", b + i, p[0], p[1], p[2]);
        }
        s += &format!(
            "#{}=IFCPOLYLOOP((#{},#{},#{},#{}));#{}=IFCFACEOUTERBOUND(#{},.T.);\
             #{}=IFCCARTESIANPOINT((0.,0.,0.));#{}=IFCDIRECTION(({:?},{:?},{:?}));\
             #{}=IFCAXIS2PLACEMENT3D(#{},#{},$);#{}=IFCPLANE(#{});\
             #{}=IFCADVANCEDFACE((#{}),#{},{});\n",
            b + 10, b, b + 1, b + 2, b + 3, b + 11, b + 10,
            b + 20, b + 21, sign * n[0], sign * n[1], sign * n[2],
            b + 22, b + 20, b + 21, b + 23, b + 22,
            b + 30, b + 11, b + 23, if flip.contains(&k) { ".F." } else { ".T." },
        );
    }
    let mut decoder = EntityDecoder::new(&s);
    let mut volume = 0.0;
    for k in 0..6 {
        let face = decoder.decode_by_id((100 * (k + 1) + 30) as u32).unwrap();
        let (pos, idx) =
            process_advanced_face(&face, &mut decoder, TessellationQuality::Medium, None).unwrap();
        let v = |i: u32| {
            let b = i as usize * 3;
            [pos[b] as f64, pos[b + 1] as f64, pos[b + 2] as f64]
        };
        for t in idx.chunks_exact(3) {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            let cr = [
                b[1] * c[2] - b[2] * c[1],
                b[2] * c[0] - b[0] * c[2],
                b[0] * c[1] - b[1] * c[0],
            ];
            volume += (a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]) / 6.0;
        }
    }
    volume
}

/// PROC-S16: `SameSense=.F.` flipped loop-derived planar triangulations, whose
/// winding the loops already give. A cube authored with some `.F.` planes
/// (loops outward) must stay outward: signed volume +1.
#[test]
fn same_sense_false_planar_faces_keep_the_loop_winding() {
    assert!((cube_signed_volume(&[]) - 1.0).abs() < 1e-6);
    let flipped = cube_signed_volume(&[1, 3, 5]);
    assert!((flipped - 1.0).abs() < 1e-6, "signed volume {flipped}, want +1");
}
