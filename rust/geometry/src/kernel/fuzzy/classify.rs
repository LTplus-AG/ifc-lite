// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Point-in-mesh classification by f64 ray-cast crossing parity, BVH-culled and
//! voted across three fixed directions for robustness.
//!
//! A closed oriented mesh contains `p` iff a ray from `p` crosses its surface an
//! odd number of times. We use Möller–Trumbore ray–triangle tests (no back-face
//! cull — a solid's far side must count), prune candidates with the shared BVH,
//! and take the MAJORITY verdict over three fixed generic directions so a single
//! grazing/edge-hit degeneracy on one ray cannot flip the result. Any residual
//! misclassification only makes the fuzzy mesh fail the caller's watertight /
//! volume self-check → exact fallback, never a silent wrong answer.
//!
//! DETERMINISM: FMA-free f64, fixed directions, IEEE ops only; the crossing
//! COUNT (hence parity) is independent of BVH candidate order ⇒ byte-identical
//! native==wasm.

use super::super::arrangement::Tri;
use super::super::broadphase::Bvh;
use super::{cross, dot, sub};

/// Three fixed generic ray directions: none axis-aligned, no two components
/// equal, and no pairwise ratio near a simple architectural slope — so a ray is
/// unlikely to lie in any operand face plane. (The first mirrors the exact
/// kernel's parity direction.)
const DIRS: [[f64; 3]; 3] = [
    [0.301_511_3, 0.557_328_1, 0.773_890_1],
    [-0.673_1, 0.211_7, 0.708_9],
    [0.418_3, -0.802_5, 0.425_7],
];

/// Möller–Trumbore: does the ray `orig + s·dir` (`s ∈ (ε, 1]` along `orig→far`,
/// parametrised so `dir = far − orig`) cross triangle `t`? Two-sided; a grazing
/// (near-parallel or barycentric-boundary) hit is rejected — the non-barycentric
/// centroid and 3-direction vote make those vanishingly rare and self-cancelling.
fn ray_hits(orig: [f64; 3], dir: [f64; 3], t: &Tri) -> bool {
    let e1 = sub(t[1], t[0]);
    let e2 = sub(t[2], t[0]);
    let pvec = cross(dir, e2);
    let det = dot(e1, pvec);
    // Parallel / edge-on: reject (grazing).
    if det.abs() <= 1.0e-12 {
        return false;
    }
    let inv = 1.0 / det;
    let tvec = sub(orig, t[0]);
    let u = dot(tvec, pvec) * inv;
    if u <= 0.0 || u >= 1.0 {
        return false;
    }
    let qvec = cross(tvec, e1);
    let v = dot(dir, qvec) * inv;
    if v <= 0.0 || u + v >= 1.0 {
        return false;
    }
    let s = dot(e2, qvec) * inv;
    // s ∈ (ε, 1]: strictly in front of the origin and within the segment.
    s > 1.0e-9 && s <= 1.0
}

/// Crossing parity of the segment `p → p + dir·(far/|dir|)` against `tris`
/// (BVH-culled). `far_len` is the ray length (past the operand extent). Returns
/// `true` for an odd count (inside).
fn crossings_odd(
    p: [f64; 3],
    unit_dir: [f64; 3],
    tris: &[Tri],
    bvh: &Bvh,
    far_len: f64,
    scratch: &mut Vec<u32>,
) -> bool {
    let dir = [unit_dir[0] * far_len, unit_dir[1] * far_len, unit_dir[2] * far_len];
    let far = [p[0] + dir[0], p[1] + dir[1], p[2] + dir[2]];
    scratch.clear();
    bvh.ray_candidates(p, far, scratch);
    let mut count = 0usize;
    for &i in scratch.iter() {
        if ray_hits(p, dir, &tris[i as usize]) {
            count += 1;
        }
    }
    count % 2 == 1
}

/// Is `p` inside the closed mesh `tris`? Majority vote of the three fixed-
/// direction ray parities (`far_len` past the operand extent).
pub(super) fn inside_vote(
    p: [f64; 3],
    tris: &[Tri],
    bvh: &Bvh,
    far_len: f64,
    scratch: &mut Vec<u32>,
) -> bool {
    let mut yes = 0u8;
    for d in DIRS {
        if crossings_odd(p, d, tris, bvh, far_len, scratch) {
            yes += 1;
        }
    }
    yes >= 2
}
