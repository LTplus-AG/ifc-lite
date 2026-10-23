// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ring bbox + point-in-ring, used by `safe_earcut`'s hole classification.
//!
//! Split out of `triangulation.rs` to keep it under the module-size ratchet.
//! Flat-buffer adapters over the shared [`crate::math::v2`] loops.

use crate::math::v2::{bbox, point_in_ring_by};

/// Axis-aligned bbox of a flat `[x0,y0,x1,y1,…]` ring: `(min_x, min_y, max_x, max_y)`.
pub(super) fn ring_bbox(coords: &[f64]) -> (f64, f64, f64, f64) {
    let [min_x, min_y, max_x, max_y] = bbox(coords.chunks_exact(2).map(|p| [p[0], p[1]]));
    (min_x, min_y, max_x, max_y)
}

/// Even-odd ray cast of `(x, y)` against a flat `[x0,y0,…]` ring (`false`
/// for fewer than three vertices).
pub(super) fn point_in_ring(x: f64, y: f64, ring: &[f64]) -> bool {
    point_in_ring_by([x, y], ring.len() / 2, |i| [ring[i * 2], ring[i * 2 + 1]])
}
