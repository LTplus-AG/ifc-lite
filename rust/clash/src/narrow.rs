// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Narrow-phase classification for one candidate element pair.
//!
//! Faithful port of `packages/clash/src/engine-ts/narrow.ts`. The control flow,
//! comparisons, and result construction match the TS reference bit-for-bit in
//! logic so this kernel and the TS engine agree on classification.

use crate::aabb::{aabb_contains, bounds_of_points, overlap_bounds, signed_gap, Aabb};
use crate::obb::{is_through_penetration, obb_penetration_depth};
use crate::triangle::{tri_tri_distance, tri_tri_intersect};
use crate::tri_mesh::TriMesh;
use crate::vec3::{centroid, mid, Vec3};

/// Exact box-box penetration depth when BOTH meshes are (within tolerance)
/// rectangular boxes, else `None`. This is the only source of a `Mesh` label
/// for a distance that used to come from `TriMesh::max_penetration_into` — a
/// nearest-crossing-vertex sampling probe that converges to 0 under
/// retessellation instead of to the true depth (see `obb.rs`, `tests.rs`).
///
/// Declines (returns `None`, same as "not both boxes") for a THROUGH-
/// PENETRATION pair — a thin member piercing clean through the other, e.g. a
/// duct through a wall — where the minimum-translation-distance is dominated
/// by the piercing member's own extent, not the material crossed. Faithful
/// port of the TS `boxMeasuredDepth` (review: #2536).
fn box_measured_depth(small: &TriMesh, large: &TriMesh) -> Option<f64> {
    let oa = small.get_obb()?;
    let ob = large.get_obb()?;
    if is_through_penetration(&oa, &ob) {
        return None;
    }
    obb_penetration_depth(&oa, &ob)
}

/// Clash classification. Discriminants match the public ABI (`Hard = 0`, etc.).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ClashStatus {
    Hard = 0,
    Clearance = 1,
    Touch = 2,
}

/// How `NarrowResult::distance` was obtained. Discriminants match the public
/// ABI and the TS `ClashDistanceKind` (`Mesh = 0`, `Estimate = 1`).
///
/// `Mesh` is a value measured on the triangle meshes; `Estimate` is read off the
/// two element AABBs (the smallest overlapping box dimension) because no
/// crossing-triangle vertex of either mesh lies strictly inside the other solid.
/// The two are not interchangeable, so every result carries its provenance.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum DistanceKind {
    Mesh = 0,
    Estimate = 1,
}

/// The narrow-phase outcome for one element pair.
pub struct NarrowResult {
    pub status: ClashStatus,
    pub distance: f64,
    pub distance_kind: DistanceKind,
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
    // Tight contact AABB: min/max of the per-pair contact points (the crossing
    // representatives), so a hard verdict reports the local contact region rather
    // than the whole-element AABB overlap (#1362 / #1402).
    let mut c_min: Vec3 = [f64::INFINITY; 3];
    let mut c_max: Vec3 = [f64::NEG_INFINITY; 3];
    // Near-contact AABB for coplanar/flush overlaps (no triangle crossing): the
    // local touching region, so the hard box is the contact patch (e.g. a wall
    // corner) not the whole-element AABB intersection, which for angled members
    // spans nearly the full member length (#1362 / #1402).
    let mut nc_min: Vec3 = [f64::INFINITY; 3];
    let mut nc_max: Vec3 = [f64::NEG_INFINITY; 3];
    let mut nc_n: u32 = 0;
    let mut min_dist = f64::INFINITY;
    let mut closest_a: Vec3 = aabb_a.min;
    let mut closest_b: Vec3 = aabb_b.min;

    // The index drives `small.tri_bounds`/`small.tri` as well as the crossing
    // flags, and the loop must keep the TS reference's iteration order, so an
    // `enumerate()` over the flag vec is not the shape we want here.
    #[allow(clippy::needless_range_loop)]
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
                for i in 0..3 {
                    if c[i] < c_min[i] {
                        c_min[i] = c[i];
                    }
                    if c[i] > c_max[i] {
                        c_max[i] = c[i];
                    }
                }
            } else {
                // Not a crossing: measure the gap (drives clearance/touch) and,
                // when touching (within tolerance), accumulate the pair into the
                // contact region. Done even after a crossing is found, since
                // coincident faces of flush members register as touches (not
                // crossings) yet carry most of the real contact area.
                let (dist, p_a, p_b) = tri_tri_distance(s0, s1, s2, l0, l1, l2);
                if dist < min_dist {
                    min_dist = dist;
                    closest_a = p_a;
                    closest_b = p_b;
                }
                if dist <= tolerance {
                    let cp = mid(p_a, p_b);
                    nc_n += 1;
                    for i in 0..3 {
                        if cp[i] < nc_min[i] {
                            nc_min[i] = cp[i];
                        }
                        if cp[i] > nc_max[i] {
                            nc_max[i] = cp[i];
                        }
                    }
                }
            }
        }
    }

    let overlap = overlap_bounds(aabb_a, aabb_b);

    // Tight contact region: the union of the genuine triangle crossings
    // (c_min/c_max) and the coplanar/flush touching pairs within tolerance
    // (nc_min/nc_max), clamped to the element overlap. Crossings alone miss
    // coincident faces (which register as touches, not crossings) so flush members
    // reported only a partial, mis-placed patch; near-contacts alone miss angled
    // crossings. Falls back to the overlap when neither was captured (#1362/#1402).
    let mut t_min: Vec3 = [f64::INFINITY; 3];
    let mut t_max: Vec3 = [f64::NEG_INFINITY; 3];
    let mut t_n: u32 = 0;
    if contact_n > 0 {
        for i in 0..3 {
            if c_min[i] < t_min[i] {
                t_min[i] = c_min[i];
            }
            if c_max[i] > t_max[i] {
                t_max[i] = c_max[i];
            }
        }
        t_n += 1;
    }
    if nc_n > 0 {
        for i in 0..3 {
            if nc_min[i] < t_min[i] {
                t_min[i] = nc_min[i];
            }
            if nc_max[i] > t_max[i] {
                t_max[i] = nc_max[i];
            }
        }
        t_n += 1;
    }
    let contact_bounds = if t_n > 0 {
        // Clamp the contact AABB to the element overlap per-axis. (overlap_bounds
        // would degenerate a disjoint axis to a midpoint that can land OUTSIDE the
        // overlap, breaking the "clamped to overlap" contract for the box.)
        let mut min: Vec3 = [0.0; 3];
        let mut max: Vec3 = [0.0; 3];
        for i in 0..3 {
            min[i] = t_min[i].max(overlap.min[i]).min(overlap.max[i]);
            max[i] = t_max[i].max(overlap.min[i]).min(overlap.max[i]);
        }
        Aabb::new(min, max)
    } else {
        overlap
    };

    if intersects {
        let point: Vec3 = if contact_n > 0 {
            let n = contact_n as f64;
            [contact_sum[0] / n, contact_sum[1] / n, contact_sum[2] / n]
        } else {
            overlap.center()
        };
        // Exact box-box penetration depth when both elements are rectangular
        // boxes (see `box_measured_depth`); otherwise fall back to the AABB
        // overlap, i.e. the smallest overlapping box dimension. That fallback
        // is an estimate, not a measured depth — for a non-box shape it can
        // report a dimension of one of the elements rather than how far they
        // interpenetrate.
        let box_depth = box_measured_depth(small, large);
        let measured = box_depth.is_some();
        let penetration = if let Some(d) = box_depth {
            d
        } else {
            (-signed_gap(aabb_a, aabb_b)).max(0.0)
        };
        return Some(NarrowResult {
            status: ClashStatus::Hard,
            distance: -penetration,
            distance_kind: if measured {
                DistanceKind::Mesh
            } else {
                DistanceKind::Estimate
            },
            point,
            bounds: contact_bounds,
        });
    }

    // Fully-enclosed solid: no surface crossing, but one element's AABB is wholly
    // inside the other's, so it may be buried. With no surface crossing the inner
    // solid is entirely inside OR entirely outside the other, so ray-casting ONE
    // representative vertex of the contained mesh decides it — and ray casting
    // (not an AABB test) correctly returns "outside" for a concave-notch case.
    // Test B-contains-A first, then A-contains-B, so the inner pick is
    // deterministic (and identical to the TS kernel) on equal AABBs.
    // Either way there is no surface crossing. When both elements are boxes
    // the exact box-box depth is available (see `box_measured_depth`) and is
    // reported as measured; otherwise the AABB gap is an estimate, not a
    // measured depth.
    let enclosed = if aabb_contains(aabb_b, aabb_a) {
        tri_a.count > 0 && tri_b.contains_point(tri_a.tri(0)[0])
    } else if aabb_contains(aabb_a, aabb_b) {
        tri_b.count > 0 && tri_a.contains_point(tri_b.tri(0)[0])
    } else {
        false
    };
    if enclosed {
        let box_depth = box_measured_depth(small, large);
        return Some(match box_depth {
            Some(d) => NarrowResult {
                status: ClashStatus::Hard,
                distance: -d,
                distance_kind: DistanceKind::Mesh,
                point: overlap.center(),
                bounds: overlap,
            },
            None => NarrowResult {
                status: ClashStatus::Hard,
                distance: signed_gap(aabb_a, aabb_b),
                distance_kind: DistanceKind::Estimate,
                point: overlap.center(),
                bounds: overlap,
            },
        });
    }

    if min_dist == f64::INFINITY {
        // Broad-phase candidate with no triangle-level proximity — not a clash.
        return None;
    }

    // Surfaces coincide/touch with no genuine crossing, but the AABBs penetrate
    // beyond tolerance (coplanar surfaces, e.g. axis-aligned boxes). AABB
    // penetration ALONE is not enough: two skewed/abutting members that merely
    // share a face have overlapping AABBs yet no shared volume, and the old proxy
    // promoted that touch to a false hard clash (#1362). Confirm a real shared
    // volume first by probing for an interior point inside BOTH solids. Two probes
    // are needed: the vertex-centroid midpoint sits inside a skewed straddling
    // overlap, while the AABB-overlap centre covers an unequal-length aligned
    // overlap (whose centroid midpoint can fall outside the shorter member). A
    // bare face touch has no interior point common to both, so neither probe
    // qualifies. Accept the pair if EITHER probe is inside both.
    if min_dist <= tolerance {
        let gap = signed_gap(aabb_a, aabb_b);
        if gap < -tolerance {
            let probe_centroid = mid(tri_a.vertex_centroid(), tri_b.vertex_centroid());
            let probe_overlap = overlap.center();
            if (tri_a.contains_point(probe_centroid) && tri_b.contains_point(probe_centroid))
                || (tri_a.contains_point(probe_overlap) && tri_b.contains_point(probe_overlap))
            {
                // Report the tight contact region (the touching patch where the
                // surfaces actually coincide), clamped to the element overlap — not
                // the whole-element AABB intersection, which for angled members
                // spans nearly the full member length and sits away from the real
                // contact (#1362/#1402). When both elements are boxes the exact
                // box-box depth is available and is reported as measured, not
                // estimated.
                let box_depth = box_measured_depth(small, large);
                return Some(NarrowResult {
                    status: ClashStatus::Hard,
                    distance: box_depth.map_or(gap, |d| -d),
                    distance_kind: if box_depth.is_some() {
                        DistanceKind::Mesh
                    } else {
                        DistanceKind::Estimate
                    },
                    point: mid(closest_a, closest_b),
                    bounds: contact_bounds,
                });
            }
            // Only a face touch (no shared volume): fall through to the touch
            // handling below, which suppresses it unless report_touch is set.
        }
    }

    // Clearance rule: ANY gap within the required clearance is a violation,
    // including sub-tolerance, nearly-touching gaps (the most severe). These
    // must not be swallowed by the touch band below.
    if is_clearance && min_dist <= clearance {
        return Some(NarrowResult {
            status: ClashStatus::Clearance,
            distance: min_dist,
            // `min_dist` is an exact triangle-to-triangle distance.
            distance_kind: DistanceKind::Mesh,
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
            distance_kind: DistanceKind::Mesh,
            point: mid(closest_a, closest_b),
            bounds: bounds_of_points(closest_a, closest_b),
        });
    }

    None
}
