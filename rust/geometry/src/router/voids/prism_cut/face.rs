// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-face geometry of the stepped solid: the canonical-order crossing
//! cache, seam segments, face planes and face-local coordinates.

use super::frame::{Face, PrismFrame};
use super::kit::{add, bits, dot, lerp, scale, V2, V3};
use rustc_hash::FxHashMap;

// ─────────────────────────────── the prism cut ──────────────────────────────

/// Canonical-order edge×face-plane crossing cache. Both triangles sharing an
/// edge compute the crossing from the SAME endpoint order, so the point is
/// bit-identical on both sides — the T-junction-freedom cornerstone.
pub(super) type CrossCache = FxHashMap<([u64; 3], [u64; 3], u16), V3>;

/// A seam sub-segment on a prism face: exact 3D endpoints plus their
/// face-local 2D coordinates.
pub(super) struct Seam {
    pub(super) a3: V3,
    pub(super) b3: V3,
    pub(super) a2: V2,
    pub(super) b2: V2,
}

/// Plane of a face: (unit normal, offset) with the plane `{x : n·x = c}`.
pub(super) fn face_plane(pf: &PrismFrame, face: Face) -> Option<(V3, f64)> {
    match face {
        Face::Cap { j } => Some((pf.d, pf.planes[j])),
        Face::Strip { k, i } => {
            let prof = &pf.profiles[k];
            let n = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % n];
            let e = [b[0] - a[0], b[1] - a[1]];
            let len = (e[0] * e[0] + e[1] * e[1]).sqrt();
            if len < 1.0e-9 {
                return None;
            }
            // Outward 2D normal of a CCW ring edge.
            let n2 = [e[1] / len, -e[0] / len];
            let n3 = add(scale(pf.u, n2[0]), scale(pf.v, n2[1]));
            let c = n2[0] * a[0] + n2[1] * a[1];
            Some((n3, c))
        }
    }
}

/// Intersection of segment (a, b) with face plane `f` (`{x: m·x = c}`),
/// computed in canonical endpoint order and cached. Endpoint-clamped crossings
/// return the endpoint EXACTLY (bit-equal), so they intern to the same pooled
/// vertex instead of a 1-ulp duplicate.
pub(super) fn cached_crossing(cache: &mut CrossCache, f: u16, m: V3, c: f64, a: V3, b: V3) -> V3 {
    let (ka, kb) = (bits(a), bits(b));
    let (first, second, key) = if ka <= kb {
        (a, b, (ka, kb, f))
    } else {
        (b, a, (kb, ka, f))
    };
    if let Some(p) = cache.get(&key) {
        return *p;
    }
    let da = dot(first, m) - c;
    let db = dot(second, m) - c;
    let denom = da - db;
    let t = if denom.abs() < 1.0e-300 {
        0.5
    } else {
        (da / denom).clamp(0.0, 1.0)
    };
    let p = if t <= 0.0 {
        first
    } else if t >= 1.0 {
        second
    } else {
        lerp(first, second, t)
    };
    cache.insert(key, p);
    p
}

/// Face-local 2D coordinates of a 3D point.
pub(super) fn face_coords(pf: &PrismFrame, face: Face, p: V3) -> V2 {
    match face {
        Face::Cap { .. } => pf.to2(p),
        Face::Strip { k, i } => {
            let prof = &pf.profiles[k];
            let n = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % n];
            let e = [b[0] - a[0], b[1] - a[1]];
            let len = (e[0] * e[0] + e[1] * e[1]).sqrt();
            let ed = [e[0] / len, e[1] / len];
            let q = pf.to2(p);
            [
                (q[0] - a[0]) * ed[0] + (q[1] - a[1]) * ed[1],
                dot(p, pf.d),
            ]
        }
    }
}
