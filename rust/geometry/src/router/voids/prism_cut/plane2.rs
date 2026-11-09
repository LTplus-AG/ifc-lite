// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Plane predicates of the prism cut: even-odd point-in-polygon and the
//! segment crossing parameter, over the kit's `V2`.
//!
//! ROUTER-7 sites, moved as-is: they keep their own arithmetic and
//! tolerances (`1e-18` parallel cutoff, `1e-12` endpoint slack) rather than
//! `math::v2` / `geom2d`. Unifying them is not part of this move.

use super::kit::V2;

/// Even-odd point-in-polygon (half-open crossing rule — deterministic on
/// boundary-adjacent points, and identical for every caller testing the same
/// point, which is what the neighbour-consistency argument needs).
pub(super) fn pip(pt: V2, poly: &[V2]) -> bool {
    let (x, y) = (pt[0], pt[1]);
    let n = poly.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i][0], poly[i][1]);
        let (xj, yj) = (poly[j][0], poly[j][1]);
        if (yi > y) != (yj > y) {
            let xc = xi + (y - yi) / (yj - yi) * (xj - xi);
            if x < xc {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// Parameter `t ∈ [0, 1]` on segment `p→q` where it crosses segment `a→b`
/// (proper or endpoint-touching crossing), or `None` when parallel / disjoint.
pub(super) fn seg_cross_param(p: V2, q: V2, a: V2, b: V2) -> Option<f64> {
    let r = [q[0] - p[0], q[1] - p[1]];
    let s = [b[0] - a[0], b[1] - a[1]];
    let denom = r[0] * s[1] - r[1] * s[0];
    if denom.abs() < 1.0e-18 {
        return None;
    }
    let ap = [a[0] - p[0], a[1] - p[1]];
    let t = (ap[0] * s[1] - ap[1] * s[0]) / denom;
    let u = (ap[0] * r[1] - ap[1] * r[0]) / denom;
    const E: f64 = 1.0e-12;
    if (-E..=1.0 + E).contains(&t) && (-E..=1.0 + E).contains(&u) {
        Some(t.clamp(0.0, 1.0))
    } else {
        None
    }
}
