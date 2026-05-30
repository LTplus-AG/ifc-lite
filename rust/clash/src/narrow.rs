// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Narrow-phase classification for one candidate element pair.
//!
//! Faithful port of `packages/clash/src/engine-ts/narrow.ts`. The control flow,
//! comparisons, and result construction match the TS reference bit-for-bit in
//! logic so this kernel and the TS engine agree on classification.

use crate::aabb::{aabb_contains, bounds_of_points, overlap_bounds, signed_gap, Aabb};
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

    // Fully-enclosed solid: no surface crossing, but one element's AABB is wholly
    // inside the other's, so it may be buried. With no surface crossing the inner
    // solid is entirely inside OR entirely outside the other, so ray-casting ONE
    // representative vertex of the contained mesh decides it — and ray casting
    // (not an AABB test) correctly returns "outside" for a concave-notch case.
    // Test B-contains-A first, then A-contains-B, so the inner pick is
    // deterministic (and identical to the TS kernel) on equal AABBs.
    let enclosed = if aabb_contains(aabb_b, aabb_a) {
        tri_a.count > 0 && tri_b.contains_point(tri_a.tri(0)[0])
    } else if aabb_contains(aabb_a, aabb_b) {
        tri_b.count > 0 && tri_a.contains_point(tri_b.tri(0)[0])
    } else {
        false
    };
    if enclosed {
        return Some(NarrowResult {
            status: ClashStatus::Hard,
            distance: signed_gap(aabb_a, aabb_b),
            point: overlap.center(),
            bounds: overlap,
        });
    }

    if min_dist == f64::INFINITY {
        // Broad-phase candidate with no triangle-level proximity — not a clash.
        return None;
    }

    // Surfaces coincide/touch with no genuine crossing, but the volumes overlap
    // beyond tolerance (coplanar surfaces, e.g. axis-aligned boxes) -> hard.
    if min_dist <= tolerance {
        let gap = signed_gap(aabb_a, aabb_b);
        if gap < -tolerance {
            return Some(NarrowResult {
                status: ClashStatus::Hard,
                distance: gap,
                point: overlap.center(),
                bounds: overlap,
            });
        }
    }

    // Clearance rule: ANY gap within the required clearance is a violation,
    // including sub-tolerance, nearly-touching gaps (the most severe). These
    // must not be swallowed by the touch band below.
    if is_clearance && min_dist <= clearance {
        return Some(NarrowResult {
            status: ClashStatus::Clearance,
            distance: min_dist,
            point: mid(closest_a, closest_b),
            bounds: bounds_of_points(closest_a, closest_b),
        });
    }

    // Otherwise only bare contact within tolerance remains; suppressed unless the
    // rule opts in. `<=` so an exact touch at tolerance 0 is still caught.
    if min_dist <= tolerance {
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

    None
}
