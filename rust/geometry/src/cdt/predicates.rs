// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Small exact-ish geometric predicates used by the CDT.
//!
//! Split out of `cdt.rs` to keep it under the module-size ratchet.

use super::{ekey, P2};

pub(super) use crate::math::v2::dist2;

/// For `p` known EXACTLY collinear with `a`-`b` (exact `orient == 0`): does it
/// lie strictly between them? Pure lexicographic comparison — no arithmetic,
/// no rounding, and `false` when `p` coincides with an endpoint.
#[inline]
pub(super) fn strictly_between(a: P2, b: P2, p: P2) -> bool {
    let lt = |u: P2, w: P2| u[0] < w[0] || (u[0] == w[0] && u[1] < w[1]);
    (lt(a, p) && lt(p, b)) || (lt(b, p) && lt(p, a))
}

pub(super) use crate::math::geom2d::segments_properly_cross;

/// Build the initial (Steiner-free) constraint set + point list from rings.
/// `rings[0]` = outer, `rings[1..]` = holes. Returns `(points, segments)`.
pub(super) fn rings_to_pslg(rings: &[Vec<P2>]) -> (Vec<P2>, Vec<(usize, usize)>) {
    let mut points: Vec<P2> = Vec::new();
    let mut segments: Vec<(usize, usize)> = Vec::new();
    for ring in rings {
        if ring.len() < 3 {
            continue;
        }
        let base = points.len();
        points.extend_from_slice(ring);
        let m = ring.len();
        for i in 0..m {
            let a = base + i;
            let b = base + (i + 1) % m;
            if a != b {
                segments.push(ekey(a, b));
            }
        }
    }
    (points, segments)
}
