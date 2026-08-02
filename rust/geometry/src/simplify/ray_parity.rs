// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Axis-ray parity point-in-mesh test for enclosed-cavity classification.
//! Split from `cavities.rs` to keep it inside the module-size ratchet budget;
//! see that module's doc for the conservative-keep design.

/// Parity vote: cast the three axis-aligned rays from `point` (each with its
/// own sub-epsilon jitter to dodge edge/vertex grazing) against `tris` and
/// call the point enclosed when at least two rays report an odd crossing
/// count. A ray with any grazing hit is discarded; fewer than two clean rays
/// means "keep" (conservative).
pub(super) fn point_enclosed(point: [f64; 3], scale: f64, tris: &[[[f64; 3]; 3]]) -> bool {
    let dirs = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut valid = 0u32;
    let mut inside = 0u32;
    for (k, dir) in dirs.iter().enumerate() {
        // Distinct jitter per ray, orders of magnitude below feature size.
        let j = (k as f64 + 1.0) * 1e-7 * scale;
        let origin = [point[0] + j, point[1] + 1.3 * j, point[2] + 1.7 * j];
        match count_crossings(origin, *dir, scale, tris) {
            Some(n) => {
                valid += 1;
                if n % 2 == 1 {
                    inside += 1;
                }
            }
            None => continue, // grazing hit: discard this ray
        }
    }
    valid >= 2 && inside >= 2
}

/// Moller-Trumbore crossing count for one ray; `None` when any hit is too
/// close to a triangle edge/vertex or to the ray origin to trust.
fn count_crossings(
    origin: [f64; 3],
    dir: [f64; 3],
    scale: f64,
    tris: &[[[f64; 3]; 3]],
) -> Option<u32> {
    const BARY_EPS: f64 = 1e-9;
    let t_eps = 1e-9 * scale;
    let mut crossings = 0u32;
    for tri in tris {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let pv = [
            dir[1] * e2[2] - dir[2] * e2[1],
            dir[2] * e2[0] - dir[0] * e2[2],
            dir[0] * e2[1] - dir[1] * e2[0],
        ];
        let det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
        if det.abs() < 1e-16 {
            continue; // parallel: jittered siblings resolve true grazings
        }
        let inv = 1.0 / det;
        let tv = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
        let u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv;
        if u < -BARY_EPS || u > 1.0 + BARY_EPS {
            continue;
        }
        let qv = [
            tv[1] * e1[2] - tv[2] * e1[1],
            tv[2] * e1[0] - tv[0] * e1[2],
            tv[0] * e1[1] - tv[1] * e1[0],
        ];
        let v = (dir[0] * qv[0] + dir[1] * qv[1] + dir[2] * qv[2]) * inv;
        if v < -BARY_EPS || u + v > 1.0 + BARY_EPS {
            continue;
        }
        let t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv;
        if t <= -t_eps {
            continue; // behind the origin
        }
        if t < t_eps {
            return None; // origin on / grazing the surface
        }
        if u < BARY_EPS || v < BARY_EPS || u + v > 1.0 - BARY_EPS {
            return None; // edge/vertex hit: parity untrustworthy
        }
        crossings += 1;
    }
    Some(crossings)
}
