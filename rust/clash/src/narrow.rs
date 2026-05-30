// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Narrow-phase classification for one candidate element pair.
//!
//! Faithful port of `packages/clash/src/engine-ts/narrow.ts`. The control flow,
//! comparisons, and result construction match the TS reference bit-for-bit in
//! logic so this kernel and the TS engine agree on classification.

use crate::aabb::{bounds_of_points, overlap_bounds, signed_gap, Aabb};
use crate::triangle::{tri_tri_distance, tri_tri_intersect};
use crate::tri_mesh::TriMesh;
use crate::vec3::{centroid, mid, Vec3};

/// Clash classification. Discriminants match the public ABI (`Hard = 0`, etc.).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ClashStatus {
    Hard = 0,
    Clearance = 1,
    Touch = 2,
}

/// The narrow-phase outcome for one element pair.
pub struct NarrowResult {
    pub status: ClashStatus,
    pub distance: f64,
    pub point: Vec3,
    pub bounds: Aabb,
}

/// Run the narrow phase for a candidate element pair.
///
/// `mode`: `0` = hard, `1` = clearance. `tolerance` and `clearance` carry the
/// rule parameters; `report_touch` toggles face-contact reporting. Returns
/// `None` when the pair is not a clash.
#[allow(clippy::too_many_arguments)]
pub fn test_pair(
    aabb_a: &Aabb,
    tri_a: &TriMesh,
    aabb_b: &Aabb,
    tri_b: &TriMesh,
    mode: u8,
    tolerance: f64,
    clearance: f64,
    report_touch: bool,
) -> Option<NarrowResult> {
    let is_clearance = mode == 1;
    let margin = tolerance.max(if is_clearance { clearance } else { 0.0 });

    // Iterate the smaller mesh, querying the larger one's BVH.
    let a_smaller = tri_a.count <= tri_b.count;
    let (small, large) = if a_smaller {
        (tri_a, tri_b)
    } else {
        (tri_b, tri_a)
    };

    let mut intersects = false;
    let mut contact_sum: [f64; 3] = [0.0, 0.0, 0.0];
    let mut contact_n: u32 = 0;
    let mut min_dist = f64::INFINITY;
    let mut closest_a: Vec3 = aabb_a.min;
    let mut closest_b: Vec3 = aabb_b.min;

    for ts in 0..small.count {
        let sb = small.tri_bounds(ts);
        let hits = large.query_tris(&sb.inflate(margin));
        if hits.is_empty() {
            continue;
        }
        let [s0, s1, s2] = small.tri(ts);
        for tl in hits {
            let [l0, l1, l2] = large.tri(tl as usize);
            if tri_tri_intersect(s0, s1, s2, l0, l1, l2) {
                intersects = true;
                let c = mid(centroid(s0, s1, s2), centroid(l0, l1, l2));
                contact_sum[0] += c[0];
                contact_sum[1] += c[1];
                contact_sum[2] += c[2];
                contact_n += 1;
            } else if !intersects {
                // Distance only matters while we might still be clearance/touch.
                let (dist, p_a, p_b) = tri_tri_distance(s0, s1, s2, l0, l1, l2);
                if dist < min_dist {
                    min_dist = dist;
                    closest_a = p_a;
                    closest_b = p_b;
                }
            }
        }
    }

    let overlap = overlap_bounds(aabb_a, aabb_b);

    if intersects {
        let point: Vec3 = if contact_n > 0 {
            let n = contact_n as f64;
            [contact_sum[0] / n, contact_sum[1] / n, contact_sum[2] / n]
        } else {
            overlap.center()
        };
        // Phase-0 penetration estimate from AABB overlap.
        let penetration = (-signed_gap(aabb_a, aabb_b)).max(0.0);
        return Some(NarrowResult {
            status: ClashStatus::Hard,
            distance: -penetration,
            point,
            bounds: overlap,
        });
    }

    if min_dist == f64::INFINITY {
        // Broad-phase candidate with no triangle-level proximity — not a clash.
        return None;
    }

    if min_dist < tolerance {
        // Surfaces coincide/touch with no genuine crossing. Distinguish a
        // volumetric overlap from mere face contact via AABB penetration depth.
        let gap = signed_gap(aabb_a, aabb_b);
        if gap < -tolerance {
            return Some(NarrowResult {
                status: ClashStatus::Hard,
                distance: gap,
                point: overlap.center(),
                bounds: overlap,
            });
        }
        if !report_touch {
            return None;
        }
        return Some(NarrowResult {
            status: ClashStatus::Touch,
            distance: min_dist,
            point: mid(closest_a, closest_b),
            bounds: bounds_of_points(closest_a, closest_b),
        });
    }

    if is_clearance && min_dist <= clearance {
        return Some(NarrowResult {
            status: ClashStatus::Clearance,
            distance: min_dist,
            point: mid(closest_a, closest_b),
            bounds: bounds_of_points(closest_a, closest_b),
        });
    }

    None
}
