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
//! Snapping alone closes a seam only where both ends of the shared span are
//! vertices of the LATER contour. Where the two edges overlap only in part,
//! one end of the span is a corner of the earlier contour lying on the later
//! edge, and the later edge's far vertex, beyond the earlier contour and out
//! of reach of the snap, keeps the edge a rounding off that corner. Two
//! footprints flush in the file then reach the union as two shapes a wedge
//! apart, or touching along one edge that only one of them carries as a
//! vertex pair. Either way the union keeps two prisms, and the kernel's
//! abutting prepass closes the seam between them only when it is axis-aligned
//! in the cut frame. (ISSUE_129 slab #12381: rectangle #12681 against the
//! pentagon #13475, overlapping for 1.32 m along y = 34.97 in the slab frame,
//! the seam at 23 degrees in the cut frame, 4.78 m2 of strip faces.)
//! [`close_t_junctions`] therefore splits every edge at each vertex of another
//! contour within `tau` of its interior, so both footprints carry the shared
//! span with the same two endpoints and the union fuses them. It adds vertices
//! and moves no existing one, so an earlier contour's boundary moves only
//! where a later vertex it gains sits off the edge, by at most `tau`.
//!
//! `tau` is [`noise_radius`]: one [`SNAP_GRID`] cell at any magnitude, the rule
//! the kernel's abutting prepass uses (`kernel::abutting`), and what keeps an
//! authored pier (the 68 um one on ISSUE_068 #144568) standing. Past 128 m an
//! f32 step exceeds the cell, so a gap the world cast made there can be as wide
//! as a narrow authored pier and is deliberately NOT welded: the same
//! conservative far-field limit as the prepass (#8190 item 2d).

use crate::kernel::mesh_bridge::SNAP_GRID;
use nalgebra::Point2;

/// [`snap_onto_earlier`], then [`close_t_junctions`], at the contours' own
/// [`noise_radius`]. Returns how many vertices moved or were added.
pub(super) fn reconcile(contours: &mut [Vec<Point2<f64>>]) -> usize {
    let tau = noise_radius(contours);
    snap_onto_earlier(contours, tau) + close_t_junctions(contours, tau)
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

/// Split every edge at each vertex of ANOTHER contour within `tau` of its
/// interior (and farther than `tau` from both its ends), in order along the
/// edge. Candidates are read from the contours as they stand on entry, so the
/// result does not depend on which contour is split first. Returns how many
/// vertices were added. Only contours whose bounds come within `tau` of each
/// other are compared, so a cluster of many small footprints stays cheap.
pub(super) fn close_t_junctions(contours: &mut [Vec<Point2<f64>>], tau: f64) -> usize {
    let before: Vec<Vec<Point2<f64>>> = contours.to_vec();
    let bounds: Vec<[f64; 4]> = before.iter().map(|c| padded_bounds(c, tau)).collect();
    let mut added = 0;
    for (i, c) in contours.iter_mut().enumerate() {
        let near: Vec<&Point2<f64>> = (0..before.len())
            .filter(|&j| j != i && overlap(&bounds[i], &bounds[j]))
            .flat_map(|j| &before[j])
            .collect();
        if near.is_empty() {
            continue;
        }
        let mut out = Vec::with_capacity(c.len());
        for k in 0..c.len() {
            let (a, b) = (c[k], c[(k + 1) % c.len()]);
            out.push(a);
            let ab = b - a;
            let len2 = ab.norm_squared();
            if len2 == 0.0 {
                continue;
            }
            let mut hits: Vec<(f64, Point2<f64>)> = Vec::new();
            for &q in &near {
                if (q - a).norm() <= tau || (q - b).norm() <= tau {
                    continue;
                }
                let t = (q - a).dot(&ab) / len2;
                if t > 0.0 && t < 1.0 && (a + ab * t - q).norm() <= tau {
                    hits.push((t, *q));
                }
            }
            hits.sort_by(|x, y| x.0.total_cmp(&y.0));
            hits.dedup_by(|x, y| x.1 == y.1);
            added += hits.len();
            out.extend(hits.into_iter().map(|(_, q)| q));
        }
        *c = out;
    }
    added
}

/// `[min x, min y, max x, max y]` of `c`, grown by `pad` on every side.
fn padded_bounds(c: &[Point2<f64>], pad: f64) -> [f64; 4] {
    c.iter().fold(
        [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY],
        |b, p| [b[0].min(p.x - pad), b[1].min(p.y - pad), b[2].max(p.x + pad), b[3].max(p.y + pad)],
    )
}

fn overlap(a: &[f64; 4], b: &[f64; 4]) -> bool {
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
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
