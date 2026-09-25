// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tri-tri predicate: flush and coplanar contact, scale, and translation
//! (#5406). Mirrored one for one by `packages/clash/src/math/triangle.test.ts`;
//! both kernels run the same generated predicate, so the TS twin is what
//! proves the TS flattening codemod kept it.
//!
//! The session-level consequences live in `world_frame_tests.rs`.

use super::tri_tri_intersect;
use crate::vec3::Vec3;
use crate::world_frame_corpus::{ulp32, WORLD_FRAME_CASES};

type Tri = [Vec3; 3];

fn f32_up(x: f64) -> f64 {
    let f = x as f32;
    f64::from(f32::from_bits(if f >= 0.0 { f.to_bits() + 1 } else { f.to_bits() - 1 }))
}

fn f32_down(x: f64) -> f64 {
    let f = x as f32;
    f64::from(f32::from_bits(if f > 0.0 { f.to_bits() - 1 } else { f.to_bits() + 1 }))
}

fn crosses(a: Tri, b: Tri) -> bool {
    tri_tri_intersect(a[0], a[1], a[2], b[0], b[1], b[2])
}

/// `t` translated by `off` and baked through f32, as ingestion stores it.
fn baked(t: Tri, off: [f64; 3]) -> Tri {
    t.map(|v| [0, 1, 2].map(|k| f64::from((v[k] + off[k]) as f32)))
}

/// Plane heights spanning six orders of magnitude, none a power of two.
const HEIGHTS: [f64; 6] = [0.05, 1.0, 3.3, 100.25, 1000.1, 10_000.3];

/// Triangle A in the horizontal plane at height `z` (f32 value), and B
/// overlapping it in plan with one vertex a single f32 ULP above the plane
/// and one a ULP below: nominally the same face, authored flush.
fn straddling_pair(z: f64) -> (Tri, Tri) {
    let z = f64::from(z as f32);
    let a = [[0.0, 0.0, z], [1.0, 0.0, z], [0.0, 1.0, z]];
    let b = [[0.2, 0.2, z], [1.2, 0.2, f32_down(z)], [0.2, 1.2, f32_up(z)]];
    (a, b)
}

#[test]
fn a_triangle_straddling_anothers_plane_by_one_ulp_does_not_cross_5406() {
    // Before #5406 every height here reported a crossing: the face-normal
    // axis separated only on an exact `<=` tie, which one ULP breaks.
    for z in HEIGHTS {
        let (a, b) = straddling_pair(z);
        assert!(!crosses(a, b), "z = {z}: a one-ULP straddle is a flush contact");
        assert!(!crosses(b, a), "z = {z}: the predicate is symmetric");
    }
}

#[test]
fn a_genuine_shallow_crossing_still_crosses_at_every_height_5406() {
    // Companion: the same pair tilted through A's plane by 100 f32 ULPs of
    // that height (>= 25x the noise band) must still cross, or a predicate
    // that answered `false` for every near-coplanar pair would pass above.
    // Below 1.0 the band keeps its unit-magnitude floor (the same
    // `max(1, |c|)` as the depth path's precision floor), so the ULP is taken there.
    for z in HEIGHTS {
        let zf = f64::from(z as f32);
        let tilt = 100.0 * ulp32(zf.max(1.0));
        let a = [[0.0, 0.0, zf], [1.0, 0.0, zf], [0.0, 1.0, zf]];
        let b = [[0.2, 0.2, zf], [1.2, 0.2, zf - tilt], [0.2, 1.2, zf + tilt]];
        assert!(crosses(a, b), "z = {z}: a {tilt} tilt through the plane is a crossing");
    }
}

/// A plane with a generic orientation (no axis-aligned normal), so its f32
/// vertices are NOT bit-identically coplanar: `(u, v)` in-plane coordinates
/// mapped through an orthonormal frame, then baked through f32.
fn on_rotated_plane(pts: [[f64; 2]; 3]) -> Tri {
    let e1 = [0.8, 0.36, 0.48];
    let e2 = [-0.6, 0.48, 0.64];
    let o = [1.7, -2.3, 0.9];
    pts.map(|[u, v]| [0, 1, 2].map(|k| f64::from((o[k] + u * e1[k] + v * e2[k]) as f32)))
}

/// The two coplanar end faces of `world_frame_tests`'s three-axis-rotated
/// panel and mullion, 20 mm apart in their shared plane: one triangle of
/// each, verbatim as the session stores them (f32).
fn coplanar_end_faces_20mm_apart() -> (Tri, Tri) {
    let f = |v: [f32; 3]| v.map(f64::from);
    (
        [
            f([-1.7465223, 2.6160913, 1.2723408]),
            f([-2.9620407, 2.9383893, 0.45310998]),
            f([-1.7253773, 2.6576362, 1.25426]),
        ],
        [
            f([-2.2528067, 2.7959137, 0.89986265]),
            f([-2.4176953, 2.8333476, 0.79304266]),
            f([-2.333115, 2.999527, 0.7207196]),
        ],
    )
}

#[test]
fn coplanar_faces_20mm_apart_in_their_plane_do_not_cross_5406() {
    // Before #5406 this pair reported a crossing, and it is what turned the
    // session's 20 mm clearance into a -1.38 m hard clash. For coplanar
    // triangles the face normals and every non-degenerate edge-edge axis are
    // (up to rounding) the SAME direction, the shared normal, and along it
    // each triangle projects to one point: each of those axes separated only
    // if rounding happened to order the two points, and here none did. No
    // axis in the set can see an in-plane gap, so the gap was never looked at.
    let (a, b) = coplanar_end_faces_20mm_apart();
    assert!(!crosses(a, b));
    assert!(!crosses(b, a));
}

#[test]
fn coplanar_triangles_overlapping_in_their_plane_touch_rather_than_cross_5406() {
    // Coplanar overlap is contact by contract (`tri_tri_intersect`'s doc),
    // now also when the two faces are coplanar only to within f32 rounding.
    let a = on_rotated_plane([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]);
    let b = on_rotated_plane([[0.2, 0.2], [1.2, 0.2], [0.2, 1.2]]);
    assert!(!crosses(a, b));
}

/// A pair that ONLY an edge-edge axis separates (both face normals fail),
/// with a 0.124 gap along it at unit scale: found by search, pinned here.
/// The separating axis is `(a1 - a0) x (b2 - b1)`.
fn edge_separated_pair(scale: f64, shift_toward_a: f64) -> (Tri, Tri) {
    let a = [[0.21, 0.58, 0.07], [-0.62, -0.64, -0.84], [0.65, -0.77, -0.95]];
    let b = [[0.93, -0.6, 0.79], [-0.83, -0.07, -0.55], [0.66, 0.23, 0.28]];
    // Unit separating axis, pointing from A towards B.
    let n = [-0.3980124791332504, -0.3589431092237397, 0.8442428032236925];
    let a = a.map(|v| v.map(|c| c * scale));
    let b = b.map(|v| [0, 1, 2].map(|k| (v[k] - shift_toward_a * n[k]) * scale));
    (a, b)
}

#[test]
fn an_edge_axis_separates_at_every_scale_5406() {
    // Before #5406 the degenerate-axis test was an absolute `|ea x eb|^2 >
    // 1e-12` on the raw edges, so below ~1 mm edge length EVERY edge axis
    // was dropped and this separated pair read as crossing at 1e-4 scale.
    // Scale-relative now (sin^2 of the edge angle), so scale is irrelevant.
    for scale in [1.0, 1e-2, 1e-4, 1e2] {
        let (a, b) = edge_separated_pair(scale, 0.0);
        assert!(!crosses(a, b), "scale {scale}: separated by an edge-edge axis");
    }
}

#[test]
fn the_edge_separated_pair_moved_through_each_other_crosses_at_every_scale_5406() {
    // Companion: shifted 0.2 (scaled) toward A along that same axis, the
    // pair has no separating axis left and must cross at every scale, or a
    // predicate that never crossed would pass the test above.
    for scale in [1.0, 1e-2, 1e-4, 1e2] {
        let (a, b) = edge_separated_pair(scale, 0.2);
        assert!(crosses(a, b), "scale {scale}");
    }
}

#[test]
fn the_verdict_does_not_depend_on_where_the_pair_sits_5406() {
    // The issue's origin-shift gap at predicate level: every configuration
    // above, translated and re-baked through f32, keeps its verdict. The
    // corpus's far case offsets X only; the planes under test are
    // horizontal, so an X offset must not widen their Z tolerance — a 1 mm
    // Z crossing stays a crossing 10 km out in X, where a max-over-axes band
    // (~2.4 mm) would swallow it.
    let mut offsets: Vec<[f64; 3]> = WORLD_FRAME_CASES.iter().map(|c| c.offset()).collect();
    offsets.extend_from_slice(&[[7.4, 0.0, 0.0], [123.456, -45.678, 9.1], [0.0, 1000.0, 0.0]]);

    let z = 1.0;
    let flush = straddling_pair(z);
    let shallow = (
        [[0.0, 0.0, z], [1.0, 0.0, z], [0.0, 1.0, z]],
        [[0.2, 0.2, z], [1.2, 0.2, z - 0.001], [0.2, 1.2, z + 0.001]],
    );
    let coplanar_apart = coplanar_end_faces_20mm_apart();
    let cases: [(&str, (Tri, Tri), bool); 5] = [
        ("flush straddle", flush, false),
        ("1 mm crossing", shallow, true),
        ("coplanar, 20 mm apart", coplanar_apart, false),
        ("edge-separated", edge_separated_pair(1.0, 0.0), false),
        ("edge-separated, moved through", edge_separated_pair(1.0, 0.2), true),
    ];
    for (name, (a, b), expected) in cases {
        for off in &offsets {
            assert_eq!(
                crosses(baked(a, *off), baked(b, *off)),
                expected,
                "{name}, translated by {off:?}"
            );
        }
    }
}
