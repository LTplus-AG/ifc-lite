// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Box recognition far from the origin (#5474). Mirrored by the `detectObb`
//! world-frame block in `packages/clash/src/engine-ts/obb.test.ts`.

use super::{detect_obb, normal_angle_error, MeshLike};
use crate::vec3::{dot, Vec3};
use crate::world_frame_corpus::ulp32;

struct Tris(Vec<[Vec3; 3]>);

impl MeshLike for Tris {
    fn tri_count(&self) -> usize {
        self.0.len()
    }
    fn tri_verts(&self, t: usize) -> [Vec3; 3] {
        self.0[t]
    }
}

const BOX_IDX: [usize; 36] = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1,
    5, 6, 1, 6, 2,
];

/// Yaw a local point by `yaw` about Z, then translate by `t`, baking the
/// result through f32 as ingestion does.
fn place(p: Vec3, yaw: f64, t: Vec3) -> Vec3 {
    let (c, s) = (yaw.cos(), yaw.sin());
    let w = [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
    [0, 1, 2].map(|k| f64::from((w[k] + t[k]) as f32))
}

/// A closed mesh from local `corners`, yawed and translated.
fn mesh(corners: &[Vec3], idx: &[usize], yaw: f64, t: Vec3) -> Tris {
    let v: Vec<Vec3> = corners.iter().map(|&p| place(p, yaw, t)).collect();
    Tris(idx.chunks(3).map(|q| [v[q[0]], v[q[1]], v[q[2]]]).collect())
}

/// A box of half-extents `h` centred on the origin (local frame).
fn box_corners(h: Vec3) -> Vec<Vec3> {
    [
        [-1.0, -1.0, -1.0],
        [1.0, -1.0, -1.0],
        [1.0, 1.0, -1.0],
        [-1.0, 1.0, -1.0],
        [-1.0, -1.0, 1.0],
        [1.0, -1.0, 1.0],
        [1.0, 1.0, 1.0],
        [-1.0, 1.0, 1.0],
    ]
    .iter()
    .map(|s| [s[0] * h[0], s[1] * h[1], s[2] * h[2]])
    .collect()
}

const OFFSETS: [Vec3; 5] = [
    [0.0, 0.0, 0.0],
    [123.456, -45.678, 9.1],
    [1_000.0, 0.0, 0.0],
    [0.0, 1_000.0, 0.0],
    [10_000.0, 0.0, 0.0],
];

#[test]
fn a_thin_rotated_panel_is_recovered_to_its_own_f32_resolution_at_any_distance_5474() {
    // A 50 mm curtain-wall panel yawed 0.3 rad. Before #5474 its centre was
    // rebuilt from offsets of ABSOLUTE coordinates along axes taken from one
    // triangle each, so the axes' error was multiplied by the distance from
    // the origin (centre off by ~5 mm at 123 m, 0.27 m at 1 km), and 10 km
    // out it was not recognised as a box at all.
    let half = [0.025, 0.75, 1.5];
    for t in OFFSETS {
        let o = detect_obb(&mesh(&box_corners(half), &BOX_IDX, 0.3, t))
            .unwrap_or_else(|| panic!("offset {t:?}: a box is still a box"));
        // Everything recovered to within a few f32 ULPs of the placement:
        // the input itself is only that precise.
        let tol = 8.0 * ulp32(t[0].abs().max(t[1].abs()).max(t[2].abs()) + 2.0);
        let centre = place([0.0; 3], 0.3, t);
        for (got, want) in o.center.iter().zip(centre) {
            assert!((got - want).abs() <= tol, "offset {t:?}: centre {:?}", o.center);
        }
        let mut got = o.half;
        got.sort_by(f64::total_cmp);
        for (g, want) in got.iter().zip([0.025, 0.75, 1.5]) {
            assert!((g - want).abs() <= tol, "offset {t:?}: half-extents {:?}", o.half);
        }
        for i in 0..3 {
            for j in (i + 1)..3 {
                assert!(dot(o.axes[i], o.axes[j]).abs() < 1e-12, "offset {t:?}: frame is orthonormal");
            }
        }
    }
}

#[test]
fn an_l_prism_is_still_not_a_box_at_any_distance_5474() {
    // Companion: the widened, noise-derived tolerances must not certify a
    // shape with a third offset plane. Footprint (0,0)-(2,0)-(2,1)-(1,1)-
    // (1,2)-(0,2), z 0..1, yawed and translated.
    let l = [
        [0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [2.0, 1.0, 0.0], [1.0, 1.0, 0.0], [1.0, 2.0, 0.0], [0.0, 2.0, 0.0],
        [0.0, 0.0, 1.0], [2.0, 0.0, 1.0], [2.0, 1.0, 1.0], [1.0, 1.0, 1.0], [1.0, 2.0, 1.0], [0.0, 2.0, 1.0],
    ];
    let idx = [
        0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 5, 4, 6, 7, 8, 6, 8, 9, 6, 9, 10, 6, 10, 11, 0, 1, 7, 0, 7, 6,
        1, 2, 8, 1, 8, 7, 2, 3, 9, 2, 9, 8, 3, 4, 10, 3, 10, 9, 4, 5, 11, 4, 11, 10, 5, 0, 6, 5, 6, 11,
    ];
    for t in OFFSETS {
        assert!(detect_obb(&mesh(&l, &idx, 0.3, t)).is_none(), "offset {t:?}");
    }
}

#[test]
fn a_rhombic_prism_is_still_not_a_box_far_out_5474() {
    // Companion for the angle cap: a 5 cm thick prism whose footprint is a
    // rhombus with 80 deg corners has three face families and two planes per
    // family, and fails ONLY the orthogonality test, by cos(80 deg) = 0.17.
    // 100 km out the worst-case direction error of its 5 cm side faces is
    // ~0.5 rad, so an uncapped noise tolerance would accept the 10 deg and
    // certify it a box; capped at 0.1 rad it stays rejected everywhere.
    let (c, s) = (80f64.to_radians().cos(), 80f64.to_radians().sin());
    let foot = [[0.0, 0.0], [1.0, 0.0], [1.0 + c, s], [c, s]];
    let mut corners = Vec::new();
    for z in [0.0, 0.05] {
        for p in foot {
            corners.push([p[0], p[1], z]);
        }
    }
    for t in OFFSETS.iter().copied().chain([[100_000.0, 0.0, 0.0]]) {
        assert!(detect_obb(&mesh(&corners, &BOX_IDX, 0.3, t)).is_none(), "offset {t:?}");
    }
}

/// Half-extents of the shared parity vectors (EDGE-CLASH-4, F2a X5). The same
/// table is `TINY_BOX_HALVES` in `obb.test.ts`: every row must be recognised,
/// at every offset, with these halves (sorted).
const TINY_BOX_HALVES: [Vec3; 5] = [
    [0.0005, 0.0005, 0.0005],
    [0.00025, 0.00025, 0.00025],
    [0.0005, 0.001, 0.002],
    [0.00005, 0.00005, 0.00005],
    [0.0001, 0.01, 0.5],
];

#[test]
fn a_box_under_a_millimetre_is_certified_scale_free_edge_clash_4() {
    // At base the fixed `|cross| <= 1e-6 m^2` rule dropped every face of a
    // 1 mm box (cross = 1e-6), so `detect_obb` was `None` (Estimate depth).
    for h in TINY_BOX_HALVES {
        for t in [[0.0, 0.0, 0.0], [12.5, -3.25, 1.0]] {
            let o = detect_obb(&mesh(&box_corners(h), &BOX_IDX, 0.3, t))
                .unwrap_or_else(|| panic!("half {h:?} offset {t:?}: a box is still a box"));
            let (mut got, mut want) = (o.half, h);
            got.sort_by(f64::total_cmp);
            want.sort_by(f64::total_cmp);
            let tol = 8.0 * ulp32(t[0].abs().max(t[1].abs()).max(t[2].abs()) + 2.0);
            for k in 0..3 {
                assert!((got[k] - want[k]).abs() <= tol, "half {h:?} offset {t:?}: {got:?}");
            }
        }
    }
}

#[test]
fn a_millimetre_l_prism_is_still_not_a_box_edge_clash_4() {
    // The scale-free rule must not turn a small non-box into a box.
    let k = 0.001;
    let l: Vec<Vec3> = [
        [0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [2.0, 1.0, 0.0], [1.0, 1.0, 0.0], [1.0, 2.0, 0.0], [0.0, 2.0, 0.0],
        [0.0, 0.0, 1.0], [2.0, 0.0, 1.0], [2.0, 1.0, 1.0], [1.0, 1.0, 1.0], [1.0, 2.0, 1.0], [0.0, 2.0, 1.0],
    ]
    .iter()
    .map(|p| [p[0] * k, p[1] * k, p[2] * k])
    .collect();
    let idx = [
        0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 5, 4, 6, 7, 8, 6, 8, 9, 6, 9, 10, 6, 10, 11, 0, 1, 7, 0, 7, 6,
        1, 2, 8, 1, 8, 7, 2, 3, 9, 2, 9, 8, 3, 4, 10, 3, 10, 9, 4, 5, 11, 4, 11, 10, 5, 0, 6, 5, 6, 11,
    ];
    assert!(detect_obb(&mesh(&l, &idx, 0.3, [0.0; 3])).is_none());
}


/// `BOX_IDX` with each face's 2nd triangle re-started at its other diagonal
/// corner: the same triangles and winding, but now BOTH triangles of every
/// face start at an acute corner. Mirrored as `ACUTE_START_IDX` in
/// `obb.test.ts`.
const ACUTE_START_IDX: [usize; 36] = [
    0, 1, 2, 2, 3, 0, 4, 6, 5, 6, 4, 7, 0, 5, 1, 5, 0, 4, 3, 2, 6, 6, 7, 3, 0, 3, 7, 7, 4, 0, 1,
    5, 6, 6, 2, 1,
];

/// Long thin members (shared parity vectors with `obb.test.ts`): a 10 m x
/// 1 m x 5 mm plate, a 12 m bar of 8 mm square section, and a 1 m x 2 cm x
/// 0.2 mm shim. Their long faces' halves have `sin` < `MIN_SIN_THETA` at an
/// acute corner.
const THIN_BOX_HALVES: [Vec3; 3] = [[5.0, 0.5, 0.0025], [6.0, 0.004, 0.004], [0.0001, 0.01, 0.5]];

#[test]
fn a_long_thin_member_is_a_box_whatever_vertex_its_triangles_start_at() {
    // Review of #7813: a `sin` measured at vertex `a` dropped BOTH triangles
    // of a 10 m x 5 mm face when each started at an acute corner, so the plate
    // lost a whole face family and fell to the AABB estimate. The rule now
    // measures the triangle's largest angle (`short_edges`).
    for idx in [&BOX_IDX, &ACUTE_START_IDX] {
        for h in THIN_BOX_HALVES {
            for t in [[0.0, 0.0, 0.0], [12.5, -3.25, 1.0]] {
                let o = detect_obb(&mesh(&box_corners(h), idx, 0.3, t))
                    .unwrap_or_else(|| panic!("half {h:?} offset {t:?}: a thin plate is a box"));
                let (mut got, mut want) = (o.half, h);
                got.sort_by(f64::total_cmp);
                want.sort_by(f64::total_cmp);
                let tol = 8.0 * ulp32(t[0].abs().max(t[1].abs()).max(t[2].abs()) + 6.0);
                for k in 0..3 {
                    assert!((got[k] - want[k]).abs() <= tol, "half {h:?} offset {t:?}: {got:?}");
                }
            }
        }
    }
}

/// The three rotations of a triangle's vertex order.
fn rotations(a: Vec3, b: Vec3, c: Vec3) -> [[Vec3; 3]; 3] {
    [[a, b, c], [b, c, a], [c, a, b]]
}

#[test]
fn the_normal_noise_bound_is_scale_free_and_vertex_order_free() {
    // A dyadic right triangle (every product exact): legs 1 and 2^-8, all
    // coordinates <= 1 so the coordinate error is the 2^-22 floor. At its
    // right angle `sin = 1`, so the bound is `2^-22 * (1/l0 + 1/l1)`, from
    // whichever vertex the triangle is listed. (The `a`-relative bound gave
    // `2^-22 * 2 / 2^-8` from either acute corner.)
    let unit_err = 2f64.powi(-22);
    for s in [1.0, 0.5, 0.25] {
        let (a, b, c) = ([0.0, 0.0, 0.0], [s, 0.0, 0.0], [0.0, s / 256.0, 0.0]);
        for [p, q, r] in rotations(a, b, c) {
            let (err, coord_err) = normal_angle_error(p, q, r);
            assert_eq!(coord_err, unit_err);
            assert_eq!(err, unit_err * 257.0 / s, "scale {s}");
        }
    }
}

/// Needle triangles `(0,0,0), (1,0,0), (2,h,0)` (largest angle at `(1,0,0)`,
/// `sin = h / sqrt(1 + h^2)`) on either side of `MIN_SIN_THETA` (1e-3), with the
/// expected keep decision. Shared with `obb.test.ts` (`NEEDLE_CASES`).
const NEEDLE_CASES: [(f64, bool); 5] =
    [(0.0, false), (1.0e-6, false), (0.9999e-3, false), (1.0001e-3, true), (0.01, true)];

#[test]
fn a_needle_has_no_noise_bound_and_a_kept_triangle_has_a_finite_one() {
    for (h, keep) in NEEDLE_CASES {
        assert_eq!(h / (1.0 + h * h).sqrt() >= 1.0e-3, keep, "fixture h {h}");
        for [p, q, r] in rotations([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, h, 0.0]) {
            let (err, _) = normal_angle_error(p, q, r);
            assert_eq!(err.is_finite(), keep, "h {h} start {p:?}: err {err}");
        }
    }
}

