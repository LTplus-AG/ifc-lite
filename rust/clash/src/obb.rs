// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact penetration depth for the one shape family it can be exact for:
//! rectangular boxes.
//!
//! Faithful port of `packages/clash/src/engine-ts/obb.ts`. `TriMesh::
//! max_penetration_into` (removed) measured the distance from the nearest
//! crossing-triangle VERTEX to the other surface — an O(edge length) sampling
//! artifact that converges to 0 as a mesh is retessellated, the opposite of
//! what a depth metric should do (see the analytic-oracle fixtures in
//! `tests.rs`).
//!
//! This module instead detects when both meshes ARE (within tolerance)
//! rectangular boxes and, only then, reports the minimum translation distance
//! along a separating axis — the classical two-OBB penetration depth, exact
//! for boxes and, because it is derived from the box's face-plane geometry
//! rather than its triangulation, unchanged by retessellation. When either
//! mesh is not confirmed to be a box, the caller falls back to the AABB
//! estimate (never a wrong `Mesh` label).

use crate::vec3::{cross, dot, Vec3};

/// Tolerance for normal-direction dedup and offset-plane clustering. Same
/// literal in the TS kernel's `OBB_EPS`.
pub const OBB_EPS: f64 = 1e-6;

/// An oriented box: center, 3 mutually orthogonal unit axes, half-extent
/// along each axis (indices match `axes`).
#[derive(Clone, Copy)]
pub struct Obb {
    pub center: Vec3,
    pub axes: [Vec3; 3],
    pub half: [f64; 3],
}

fn normalize(v: Vec3) -> Option<Vec3> {
    let len = dot(v, v).sqrt();
    if !(len > OBB_EPS) {
        return None;
    }
    Some([v[0] / len, v[1] / len, v[2] / len])
}

/// Flip `n` so its largest-magnitude component is positive, so a face and its
/// antipodal opposite face collapse to the same canonical axis direction.
/// Ties broken in x, y, z order — identical to the TS `canonical`.
fn canonical(n: Vec3) -> Vec3 {
    let (ax, ay, az) = (n[0].abs(), n[1].abs(), n[2].abs());
    let mut idx = 0usize;
    if ay > ax && ay >= az {
        idx = 1;
    } else if az > ax && az > ay {
        idx = 2;
    }
    if n[idx] < 0.0 {
        [-n[0], -n[1], -n[2]]
    } else {
        n
    }
}

/// Minimal structural view of `TriMesh` this module needs.
pub trait MeshLike {
    fn tri_count(&self) -> usize;
    fn tri_verts(&self, t: usize) -> [Vec3; 3];
}

/// Detect whether `mesh` is a rectangular box. See the TS `detectObb` doc
/// comment for the full rationale — this is a faithful, bit-identical port.
pub fn detect_obb<M: MeshLike>(mesh: &M) -> Option<Obb> {
    let count = mesh.tri_count();
    if count == 0 {
        return None;
    }
    let mut groups: Vec<Vec3> = Vec::with_capacity(3);
    let mut group_of_tri: Vec<i32> = vec![-1; count];
    // `t` also drives `mesh.tri_verts(t)`, not just `group_of_tri`, and must
    // keep the TS reference's iteration order, so an `enumerate()` over the
    // flag vec is not the shape we want here (mirrors `narrow.rs`).
    #[allow(clippy::needless_range_loop)]
    for t in 0..count {
        let [a, b, c] = mesh.tri_verts(t);
        let n = match normalize(cross(
            [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
            [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        )) {
            Some(n) => n,
            None => continue, // degenerate triangle: no face-normal evidence
        };
        let cn = canonical(n);
        let mut gi: i32 = -1;
        for (g, rep) in groups.iter().enumerate() {
            if dot(*rep, cn) > 1.0 - OBB_EPS {
                gi = g as i32;
                break;
            }
        }
        if gi == -1 {
            if groups.len() >= 3 {
                return None; // a 4th face-normal family: not a box
            }
            groups.push(cn);
            gi = (groups.len() - 1) as i32;
        }
        group_of_tri[t] = gi;
    }
    if groups.len() != 3 {
        return None;
    }
    for i in 0..3 {
        for j in (i + 1)..3 {
            if dot(groups[i], groups[j]).abs() > OBB_EPS {
                return None;
            }
        }
    }

    let mut min_off = [f64::INFINITY; 3];
    let mut max_off = [f64::NEG_INFINITY; 3];
    #[allow(clippy::needless_range_loop)]
    for t in 0..count {
        let gi = group_of_tri[t];
        if gi == -1 {
            continue;
        }
        let gi = gi as usize;
        let [a, b, c] = mesh.tri_verts(t);
        for v in [a, b, c] {
            let o = dot(v, groups[gi]);
            if o < min_off[gi] {
                min_off[gi] = o;
            }
            if o > max_off[gi] {
                max_off[gi] = o;
            }
        }
    }
    // Reject a 3rd offset plane on any axis (e.g. an L-shaped footprint).
    #[allow(clippy::needless_range_loop)]
    for t in 0..count {
        let gi = group_of_tri[t];
        if gi == -1 {
            continue;
        }
        let gi = gi as usize;
        let [a, b, c] = mesh.tri_verts(t);
        for v in [a, b, c] {
            let o = dot(v, groups[gi]);
            let scale = 1.0f64.max(min_off[gi].abs()).max(max_off[gi].abs());
            let near_min = (o - min_off[gi]).abs() <= OBB_EPS * scale;
            let near_max = (o - max_off[gi]).abs() <= OBB_EPS * scale;
            if !near_min && !near_max {
                return None;
            }
        }
    }

    let mut half = [0.0f64; 3];
    let mut c0 = [0.0f64; 3];
    for i in 0..3 {
        half[i] = (max_off[i] - min_off[i]) / 2.0;
        c0[i] = (max_off[i] + min_off[i]) / 2.0;
    }
    let center: Vec3 = [
        c0[0] * groups[0][0] + c0[1] * groups[1][0] + c0[2] * groups[2][0],
        c0[0] * groups[0][1] + c0[1] * groups[1][1] + c0[2] * groups[2][1],
        c0[0] * groups[0][2] + c0[1] * groups[1][2] + c0[2] * groups[2][2],
    ];
    Some(Obb {
        center,
        axes: [groups[0], groups[1], groups[2]],
        half,
    })
}

/// Exact penetration depth between two oriented boxes: the minimum overlap
/// over the 15 canonical OBB-OBB separating-axis candidates. See the TS
/// `obbPenetrationDepth` doc comment for the full rationale.
pub fn obb_penetration_depth(a: &Obb, b: &Obb) -> Option<f64> {
    let t: Vec3 = [
        b.center[0] - a.center[0],
        b.center[1] - a.center[1],
        b.center[2] - a.center[2],
    ];
    let mut depth = f64::INFINITY;

    let mut test_axis = |l: Vec3| -> bool {
        let len = dot(l, l).sqrt();
        if !(len > OBB_EPS) {
            return true; // degenerate axis: not a candidate, not a failure
        }
        let u: Vec3 = [l[0] / len, l[1] / len, l[2] / len];
        let r_a = a.half[0] * dot(a.axes[0], u).abs()
            + a.half[1] * dot(a.axes[1], u).abs()
            + a.half[2] * dot(a.axes[2], u).abs();
        let r_b = b.half[0] * dot(b.axes[0], u).abs()
            + b.half[1] * dot(b.axes[1], u).abs()
            + b.half[2] * dot(b.axes[2], u).abs();
        let dist = dot(t, u).abs();
        let overlap = r_a + r_b - dist;
        if overlap <= 0.0 {
            return false;
        }
        if overlap < depth {
            depth = overlap;
        }
        true
    };

    for i in 0..3 {
        if !test_axis(a.axes[i]) {
            return None;
        }
    }
    for i in 0..3 {
        if !test_axis(b.axes[i]) {
            return None;
        }
    }
    for i in 0..3 {
        for j in 0..3 {
            if !test_axis(cross(a.axes[i], b.axes[j])) {
                return None;
            }
        }
    }
    if depth == f64::INFINITY {
        None
    } else {
        Some(depth)
    }
}
