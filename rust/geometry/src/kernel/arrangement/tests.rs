// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::interner::Vid;
use super::super::rational::point_of;
use super::classify::{boolean_vids, cross3, dot3, to_f64_pt};
use super::*;
use std::collections::BTreeSet;

fn cube(lo: f64, hi: f64) -> Vec<Tri> {
    super::cube_mesh(lo, hi)
}

/// Signed volume of a closed mesh (divergence theorem): (1/6)Σ v0·(v1×v2).
fn volume(m: &[Tri]) -> f64 {
    m.iter().map(|t| dot3(t[0], cross3(t[1], t[2]))).sum::<f64>() / 6.0
}

/// 552611 regression — coplanar host face × cutter face complex where one
/// cutter corner's entire triangulation fan is swallowed by a constraint
/// channel: the tiny middle-quad diagonal (5.027,3.800)→(5.142,3.5) crosses
/// every fan spoke of the adjacent through-rectangle corner (5.142,3.800),
/// and `recover_subsegment`'s pocket rebuild used to DESTROY that vertex
/// (and every constraint edge through it). The host sub-triangulation then
/// overlapped the cutter footprint and the difference over-cut the wall 4×
/// (advanced_model wall #552611 / opening #552651). The conforming
/// arrangement must keep every cutter corner as a host vertex.
#[test]
fn coplanar_channel_swallowed_corner_survives_552611() {
    let x = 7.7642822265625;
    let host: Vec<Tri> = vec![
        [[x, 7.7840423583984375, 0.09417724609375], [x, -0.6199951171875, 0.09417724609375], [x, -0.6199951171875, 10.600006103515625]],
        [[x, 7.7840423583984375, 0.09417724609375], [x, -0.6199951171875, 10.600006103515625], [x, 7.7840423583984375, 10.600006103515625]],
    ];
    let cutter: Vec<Tri> = vec![
        [[x, -0.160003662109375, 3.8000030517578125], [x, 5.02655029296875, 3.8000030517578125], [x, 5.02655029296875, 3.5]],
        [[x, -0.160003662109375, 3.8000030517578125], [x, 5.02655029296875, 3.5], [x, -0.160003662109375, 3.5]],
        [[x, 5.02655029296875, 3.8000030517578125], [x, 5.14154052734375, 3.8000030517578125], [x, 5.14154052734375, 3.5]],
        [[x, 5.02655029296875, 3.8000030517578125], [x, 5.14154052734375, 3.5], [x, 5.02655029296875, 3.5]],
        [[x, 5.14154052734375, 3.8000030517578125], [x, 7.7840423583984375, 3.8000030517578125], [x, 7.7840423583984375, 3.5]],
        [[x, 5.14154052734375, 3.8000030517578125], [x, 7.7840423583984375, 3.5], [x, 5.14154052734375, 3.5]],
    ];
    let arr = arrange(&host, &cutter);
    // Every cutter corner must be a vertex of the host's conforming
    // sub-triangulation (they all lie strictly inside / on the host face).
    for ct in &cutter {
        for corner in ct {
            let found = arr.tris_a.iter().flatten().any(|&v| {
                let p = to_f64_pt(&arr, v);
                p[1] == corner[1] && p[2] == corner[2]
            });
            assert!(
                found,
                "cutter corner ({}, {}) lost from the host conforming triangulation",
                corner[1], corner[2]
            );
        }
    }
}

#[test]
fn arrange_two_crossing_triangles_conform_along_the_intersection() {
    // Two triangles that skewer each other (from the tri-tri tests).
    let ta: Tri = [[-2., 0., -1.], [2., 0., -1.], [0., 0., 2.]]; // plane y=0
    let tb: Tri = [[1., -2., 1.], [1., 2., 1.], [1., 0.5, -3.]]; // plane x=1
    let arr = arrange(&[ta], &[tb]);
    // both operands were subdivided
    assert!(arr.tris_a.len() >= 2, "operand A not subdivided");
    assert!(arr.tris_b.len() >= 2, "operand B not subdivided");
    // CONFORMITY: the intersection segment's two endpoints are shared vertices
    // (same Vid) of BOTH operands' sub-meshes — they have no coincident corners,
    // so the only shared vertices are the intersection endpoints.
    let va: BTreeSet<Vid> = arr.tris_a.iter().flatten().copied().collect();
    let vb: BTreeSet<Vid> = arr.tris_b.iter().flatten().copied().collect();
    let shared: Vec<Vid> = va.intersection(&vb).copied().collect();
    assert_eq!(
        shared.len(),
        2,
        "operands must share exactly the 2 intersection-segment vertices (conformity)"
    );
}

#[test]
fn arrange_disjoint_meshes_are_untouched() {
    let ta: Tri = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]];
    let tb: Tri = [[0., 0., 10.], [1., 0., 10.], [0., 1., 10.]]; // far away
    let arr = arrange(&[ta], &[tb]);
    assert_eq!(arr.tris_a.len(), 1, "disjoint A should pass through");
    assert_eq!(arr.tris_b.len(), 1, "disjoint B should pass through");
}

#[test]
fn cube_helper_has_outward_winding() {
    assert!((volume(&cube(0., 2.)) - 8.0).abs() < 1e-9, "cube volume wrong (winding?)");
}

#[test]
fn boolean_containment_cases_have_exact_volumes() {
    // A entirely inside B — no surface intersection, so this exercises the
    // classification + extraction WITHOUT the arrangement / seg×seg crossings.
    let a = cube(1., 2.); // vol 1, strictly inside B
    let b = cube(0., 3.); // vol 27
    let diff = boolean(&a, &b, BoolOp::Difference);
    assert!(volume(&diff).abs() < 1e-9, "A−B should be empty, vol={}", volume(&diff));
    let inter = boolean(&a, &b, BoolOp::Intersection);
    assert!((volume(&inter) - 1.0).abs() < 1e-9, "A∩B should be A (vol 1), got {}", volume(&inter));
    let uni = boolean(&a, &b, BoolOp::Union);
    assert!((volume(&uni) - 27.0).abs() < 1e-9, "A∪B should be B (vol 27), got {}", volume(&uni));
}

#[test]
fn box_minus_box_real_cut_has_exact_volume() {
    // Two overlapping cubes — a real surface cut, exercising seg×seg crossings
    // (each cut face gets a closed constraint loop with corner X-junctions).
    let a = cube(0., 2.); // vol 8
    let b = cube(1., 3.); // vol 8, overlap [1,2]³ = vol 1
    let diff = volume(&boolean(&a, &b, BoolOp::Difference));
    assert!((diff - 7.0).abs() < 1e-6, "A−B volume = {diff}, expected 7");
    let inter = volume(&boolean(&a, &b, BoolOp::Intersection));
    assert!((inter - 1.0).abs() < 1e-6, "A∩B volume = {inter}, expected 1");
    let uni = volume(&boolean(&a, &b, BoolOp::Union));
    assert!((uni - 15.0).abs() < 1e-6, "A∪B volume = {uni}, expected 15");
}

#[test]
fn abutting_boxes_union_is_manifold_and_correct_volume() {
    use num_rational::BigRational;
    use num_traits::ToPrimitive;
    use std::collections::BTreeMap;
    // two unit cubes sharing the x=1 face (a coplanar SHARED-FACE degeneracy)
    let a = box_mesh([0., 0., 0.], [1., 1., 1.]);
    let b = box_mesh([1., 0., 0.], [2., 1., 1.]);
    let arr = arrange(&a, &b);
    let result = boolean_vids(&arr, &a, &b, BoolOp::Union);
    assert!(!result.is_empty(), "union is empty");
    // manifold: every undirected edge used exactly twice (no doubled face)
    let mut edges: BTreeMap<(Vid, Vid), u32> = BTreeMap::new();
    for t in &result {
        for (u, v) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *edges.entry(if u < v { (u, v) } else { (v, u) }).or_insert(0) += 1;
        }
    }
    assert!(
        edges.values().all(|&c| c == 2),
        "abutting union is non-manifold (the shared x=1 face was not deduped)"
    );
    // volume == 2 (the merged [0,2]×[0,1]×[0,1] box)
    let co = |v: Vid| {
        let p = point_of(arr.interner.get(v));
        [
            BigRational::to_f64(&p[0]).unwrap(),
            BigRational::to_f64(&p[1]).unwrap(),
            BigRational::to_f64(&p[2]).unwrap(),
        ]
    };
    let vol: f64 = result
        .iter()
        .map(|t| dot3(co(t[0]), cross3(co(t[1]), co(t[2]))))
        .sum::<f64>()
        / 6.0;
    assert!((vol - 2.0).abs() < 1e-6, "abutting-boxes union volume = {vol}, expected 2");
}

/// Edge-use audit on a materialised f64 triangle list: returns
/// `(boundary, nonmanifold)` = count of undirected edges used exactly ONCE
/// (an open boundary) and MORE THAN twice (a non-manifold fin). Both zero ⇒
/// the surface is closed and 2-manifold. Vertices are keyed on the snap grid.
fn edge_audit(tris: &[Tri]) -> (usize, usize) {
    use std::collections::BTreeMap;
    let key = |p: [f64; 3]| {
        (
            (p[0] * 65536.0).round() as i64,
            (p[1] * 65536.0).round() as i64,
            (p[2] * 65536.0).round() as i64,
        )
    };
    let mut edges: BTreeMap<((i64, i64, i64), (i64, i64, i64)), u32> = BTreeMap::new();
    for t in tris {
        let k = [key(t[0]), key(t[1]), key(t[2])];
        for (u, v) in [(k[0], k[1]), (k[1], k[2]), (k[2], k[0])] {
            *edges.entry(if u < v { (u, v) } else { (v, u) }).or_insert(0) += 1;
        }
    }
    (
        edges.values().filter(|&&c| c == 1).count(),
        edges.values().filter(|&&c| c > 2).count(),
    )
}

fn bounds(tris: &[Tri]) -> ([f64; 3], [f64; 3]) {
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    for t in tris {
        for v in t {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
    }
    (lo, hi)
}

#[test]
fn abutting_boxes_union_is_watertight_combined_hull() {
    // The MINIMAL coplanar-union repro (the #960 root cause, distilled): two
    // unit boxes sharing the x=1 face union to ONE watertight 1×1×2 hull —
    // every edge shared by exactly two faces, no open boundary, bounds span
    // BOTH boxes. Pure geometry ⇒ must always pass.
    let a = box_mesh([0., 0., 0.], [1., 1., 1.]);
    let b = box_mesh([1., 0., 0.], [2., 1., 1.]);
    let u = boolean(&a, &b, BoolOp::Union);
    let (boundary, nonmanifold) = edge_audit(&u);
    assert_eq!(boundary, 0, "abutting-boxes union has {boundary} open boundary edges (torn)");
    assert_eq!(nonmanifold, 0, "abutting-boxes union has {nonmanifold} non-manifold edges (the shared x=1 face was not dissolved)");
    let (lo, hi) = bounds(&u);
    assert_eq!(lo, [0., 0., 0.], "union lower bound should span both boxes");
    assert_eq!(hi, [2., 1., 1.], "union upper bound should span both boxes");
}

#[test]
fn partial_coplanar_seam_union_is_watertight() {
    // Two boxes sharing the x=1 plane but with only PARTIAL face overlap in Y
    // (A: y∈[0,2], B: y∈[1,3]); each box's x=1 face extends past the shared
    // band. This is the #960 seam END-REGION case: the seam face of one box
    // reaches where the other has NO coincident face (its solid abuts via a
    // perpendicular wall). The end-region must still dissolve, not tear.
    let a = box_mesh([0., 0., 0.], [1., 2., 1.]);
    let b = box_mesh([1., 1., 0.], [2., 3., 1.]);
    let u = boolean(&a, &b, BoolOp::Union);
    let (boundary, nonmanifold) = edge_audit(&u);
    assert_eq!(boundary, 0, "partial-seam union has {boundary} open boundary edges");
    assert_eq!(nonmanifold, 0, "partial-seam union has {nonmanifold} non-manifold edges");
}

#[test]
fn identical_solids_union_is_the_single_solid() {
    // Union of a box with an exact COPY of itself = that box (every face is a
    // co-oriented coincident duplicate; exactly one copy survives). The
    // sloped/rotated variant is the case the narrow coincident-face dedup
    // missed before the Vid-key dedup.
    let a = box_mesh([0., 0., 0.], [2., 2., 2.]);
    let u = boolean(&a, &a, BoolOp::Union);
    let (boundary, nonmanifold) = edge_audit(&u);
    assert_eq!((boundary, nonmanifold), (0, 0), "self-union is not watertight: b={boundary} nm={nonmanifold}");
    assert_eq!(u.len(), 12, "self-union should be the single 12-triangle box, got {}", u.len());
}

#[test]
fn nary_union_of_abutting_and_duplicate_prisms_is_watertight() {
    // The #960 cutter-union shape (distilled to axis-aligned): a strip of
    // three abutting unit boxes PLUS an exact duplicate of the middle one —
    // unioned in ONE conforming arrangement (`union_all`), never re-meshing an
    // intermediate. Result = the 3×1×1 strip, watertight, duplicate dissolved.
    let b0 = box_mesh([0., 0., 0.], [1., 1., 1.]);
    let b1 = box_mesh([1., 0., 0.], [2., 1., 1.]);
    let b2 = box_mesh([2., 0., 0.], [3., 1., 1.]);
    let b1_dup = b1.clone();
    let meshes: Vec<&[Tri]> = vec![&b0, &b1, &b2, &b1_dup];
    let u = super::union_all(&meshes);
    let (boundary, nonmanifold) = edge_audit(&u);
    assert_eq!(boundary, 0, "N-ary union has {boundary} open boundary edges");
    assert_eq!(nonmanifold, 0, "N-ary union has {nonmanifold} non-manifold edges");
    let (lo, hi) = bounds(&u);
    assert_eq!((lo, hi), ([0., 0., 0.], [3., 1., 1.]), "N-ary union bounds wrong");
}

#[test]
fn boolean_manifest_is_pinned() {
    // The full-boolean topology fingerprint (cube[0,2]³ − cube[1,3]³),
    // byte-identical across x86_64/aarch64/wasm (re-pin + re-run the wasm
    // cross-check if the boolean logic legitimately changes).
    const PINNED: u64 = 0x0465_b83a_5fdb_8b2b;
    let m = super::boolean_manifest();
    assert_eq!(m, PINNED, "boolean topology manifest changed: 0x{m:016x}");
}
