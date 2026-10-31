// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Footprint reconciliation before the coaxial union (#8190).
//!
//! Each footprint is projected from its own cutter's f32 caps, so two openings
//! authored flush share an edge only up to their independent roundings. The
//! i_overlay union is exact, so it keeps that disagreement: a strip a few
//! micrometres wide and as long as the shared edge, between two shapes, or as
//! a notch or slit hole in one shape where the footprints also touch elsewhere.
//! The re-extruded prisms then leave that strip of host standing inside the
//! opening. The kernel's abutting prepass catches the two-shape form only for
//! axis-aligned facing planes within one cell, and never the one-shape form.
//! (ISSUE_129 slab #12381: openings #12659 and #13497 share y = 3.100046 in
//! the file and came back 1 to 7 um apart, 12 m2 of strip faces.)
//!
//! [`snap_onto_earlier`] moves each vertex onto a vertex, or else an edge, of
//! an EARLIER contour when one is within `tau`, so flush edges coincide before
//! the union and the slit never forms. Earlier contours are never moved, so the
//! result is deterministic in contour order and no vertex moves twice.
//!
//! `tau` is [`noise_radius`]: one [`SNAP_GRID`] cell at any magnitude, the rule
//! the kernel's abutting prepass uses (`kernel::abutting`), and what keeps an
//! authored pier (the 68 um one on ISSUE_068 #144568) standing. Past 128 m an
//! f32 step exceeds the cell, so a gap the world cast made there can be as wide
//! as a narrow authored pier and is deliberately NOT welded: the same
//! conservative far-field limit as the prepass (#8190 item 2d).

use crate::kernel::mesh_bridge::SNAP_GRID;
use nalgebra::Point2;

/// [`snap_onto_earlier`] at the contours' own [`noise_radius`].
pub(super) fn reconcile(contours: &mut [Vec<Point2<f64>>]) -> usize {
    let tau = noise_radius(contours);
    snap_onto_earlier(contours, tau)
}

/// Distance within which two footprint features are one authored feature:
/// one snap cell, whatever the contours' magnitude (see the module doc).
pub(super) fn noise_radius(_contours: &[Vec<Point2<f64>>]) -> f64 {
    SNAP_GRID
}

/// Snap every vertex of every contour onto the nearest vertex of an earlier
/// contour within `tau`, else onto the nearest point of an earlier contour's
/// edge within `tau`. Returns how many vertices moved.
pub(super) fn snap_onto_earlier(contours: &mut [Vec<Point2<f64>>], tau: f64) -> usize {
    let mut moved = 0;
    for i in 1..contours.len() {
        let (earlier, rest) = contours.split_at_mut(i);
        for p in rest[0].iter_mut() {
            if let Some(q) = nearest_on(earlier, *p, tau) {
                if q != *p {
                    *p = q;
                    moved += 1;
                }
            }
        }
    }
    moved
}

/// The nearest vertex of `contours` within `tau` of `p`, else the nearest edge
/// point within `tau`. Vertices first: a corner that lands on a corner must
/// land on it exactly, not on a point of one of its edges a rounding away.
fn nearest_on(contours: &[Vec<Point2<f64>>], p: Point2<f64>, tau: f64) -> Option<Point2<f64>> {
    let mut best: Option<(f64, Point2<f64>)> = None;
    for q in contours.iter().flatten() {
        let d = (q - p).norm();
        if d <= tau && best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, *q));
        }
    }
    if best.is_some() {
        return best.map(|(_, q)| q);
    }
    for c in contours {
        for k in 0..c.len() {
            let (a, b) = (c[k], c[(k + 1) % c.len()]);
            let ab = b - a;
            let len2 = ab.norm_squared();
            if len2 == 0.0 {
                continue;
            }
            let t = ((p - a).dot(&ab) / len2).clamp(0.0, 1.0);
            let q = a + ab * t;
            let d = (q - p).norm();
            if d <= tau && best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, q));
            }
        }
    }
    best.map(|(_, q)| q)
}

#[cfg(test)]
#[path = "coaxial_union_snap_tests.rs"]
mod tests;
