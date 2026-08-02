// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ring bbox + point-in-ring, used by `safe_earcut`'s hole classification.
//!
//! Split out of `triangulation.rs` to keep it under the module-size ratchet.

/// Axis-aligned bbox of a flat `[x0,y0,x1,y1,…]` ring: `(min_x, min_y, max_x, max_y)`.
pub(super) fn ring_bbox(coords: &[f64]) -> (f64, f64, f64, f64) {
    let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
    let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in coords.chunks_exact(2) {
        min_x = min_x.min(p[0]);
        min_y = min_y.min(p[1]);
        max_x = max_x.max(p[0]);
        max_y = max_y.max(p[1]);
    }
    (min_x, min_y, max_x, max_y)
}

/// Even-odd ray cast of `(x, y)` against a flat `[x0,y0,…]` ring.
pub(super) fn point_in_ring(x: f64, y: f64, ring: &[f64]) -> bool {
    let n = ring.len() / 2;
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (ring[i * 2], ring[i * 2 + 1]);
        let (xj, yj) = (ring[j * 2], ring[j * 2 + 1]);
        if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}
