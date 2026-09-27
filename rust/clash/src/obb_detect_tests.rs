// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Box recognition far from the origin (#5474). Mirrored by the `detectObb`
//! world-frame block in `packages/clash/src/engine-ts/obb.test.ts`.

use super::{detect_obb, MeshLike};
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
