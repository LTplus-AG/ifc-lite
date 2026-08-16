// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Narrow-phase classification for one candidate element pair. Faithful port
//! of `packages/clash/src/engine-ts/narrow.ts`: control flow, comparisons,
//! and result construction match bit-for-bit so the two engines agree.

use crate::aabb::{aabb_contains, bounds_of_points, overlap_bounds, signed_gap, Aabb};
use crate::depth::{box_penetration, crossing_vertex_penetration, depth_clash_result};
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

    // A CONTAINED pair (one element's AABB wholly inside the other's) is the
    // one class whose AABB estimate is fabricated — the signed gap reads the
    // small element's own extent, not anything about the overlap (#1866) —
    // so for such pairs collect the crossing triangles: their vertices are
    // the mesh-level evidence `depth_clash_result`'s f32 noise-floor gate
    // needs (see `crossing_vertex_penetration` — evidence for the floor test
    // only, never a reported depth). Allocated only for contained pairs;
    // every other pair has a genuine AABB overlap bound to floor-test.
    let contained = aabb_contains(aabb_b, aabb_a) || aabb_contains(aabb_a, aabb_b);
    let mut cross_small = if contained {
        Some(vec![false; small.count])
    } else {
        None
    };
    let mut cross_large = if contained {
        Some(vec![false; large.count])
    } else {
        None
    };

    let mut intersects = false;
    let mut contact_sum: [f64; 3] = [0.0, 0.0, 0.0];
    let mut contact_n: u32 = 0;
    // Tight contact AABB: min/max of the crossing-triangle contact points, so
    // a hard verdict reports the local contact region, not the whole-element
    // AABB overlap (#1362 / #1402).
    let mut c_min: Vec3 = [f64::INFINITY; 3];
    let mut c_max: Vec3 = [f64::NEG_INFINITY; 3];
    // Near-contact AABB for coplanar/flush overlaps (no triangle crossing):
    // the local touching region, e.g. a wall corner, not the whole-element
    // AABB intersection (#1362 / #1402).
    let mut nc_min: Vec3 = [f64::INFINITY; 3];
    let mut nc_max: Vec3 = [f64::NEG_INFINITY; 3];
    let mut nc_n: u32 = 0;
    let mut min_dist = f64::INFINITY;
    let mut closest_a: Vec3 = aabb_a.min;
    let mut closest_b: Vec3 = aabb_b.min;

    // Must keep the TS reference's iteration order; not an `enumerate()` shape.
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
                if let (Some(cs), Some(cl)) = (cross_small.as_mut(), cross_large.as_mut()) {
                    cs[ts] = true;
                    cl[tl as usize] = true;
                }
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
                // when touching, accumulate into the contact region — even after
                // a crossing is found, since coincident faces of flush members
                // register as touches, not crossings, yet carry most of the area.
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

    // Tight contact region: union of the triangle crossings (c_min/c_max) and
    // coplanar/flush touches (nc_min/nc_max), clamped to the element overlap —
    // crossings alone miss coincident faces, near-contacts alone miss angled
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
        // Clamp per-axis to the element overlap (overlap_bounds would degenerate
        // a disjoint axis to a midpoint that can land OUTSIDE the overlap).
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
        // Exact box-box depth when both elements are boxes (see
        // `box_penetration`); otherwise the AABB overlap — an estimate,
        // not a measured depth, since it can be a dimension of one element.
        // `depth_clash_result` applies the f32 floor to EVERY candidate
        // depth before any estimate-vs-mesh selection, so a pair below the
        // floor reports `Touch` regardless of which quantity would have been
        // reported. For a contained pair the crossing-vertex penetration is
        // that third candidate: the estimate is fabricated there (the small
        // element's own extent), so without it a flush contained pair —
        // whose only measurable penetration is f32 noise — would be
        // promoted to `Hard` at a number that measures nothing (the eight
        // Infra-Bridge pairs, see `depth_clash_result`).
        let mesh_evidence = match (cross_small.as_ref(), cross_large.as_ref()) {
            (Some(cs), Some(cl)) => {
                let d = crossing_vertex_penetration(small, large, cs)
                    .max(crossing_vertex_penetration(large, small, cl));
                // 0 means "no crossing vertex inside at all" (e.g. a thin
                // member piercing straight through) — no evidence either
                // way, not evidence of a sub-floor contact.
                if d > 0.0 {
                    Some(d)
                } else {
                    None
                }
            }
            _ => None,
        };
        return depth_clash_result(
            box_penetration(small, large),
            (-signed_gap(aabb_a, aabb_b)).max(0.0),
            mesh_evidence,
            aabb_a,
            aabb_b,
            report_touch,
            point,
            contact_bounds,
        );
    }

    // Fully-enclosed solid: one element's AABB is wholly inside the other's,
    // so it may be buried. No surface crossing means the inner solid is
    // entirely inside OR outside, so ray-casting ONE vertex of the contained
    // mesh decides it (correctly "outside" for a concave notch, unlike an
    // AABB test). B-contains-A tested first so the inner pick is deterministic
    // on equal AABBs. Exact box-box depth when both are boxes; else the AABB
    // gap is an estimate.
    let enclosed = if aabb_contains(aabb_b, aabb_a) {
        tri_a.count > 0 && tri_b.contains_point(tri_a.tri(0)[0])
    } else if aabb_contains(aabb_a, aabb_b) {
        tri_b.count > 0 && tri_a.contains_point(tri_b.tri(0)[0])
    } else {
        false
    };
    if enclosed {
        // May legitimately return `None` (below the f32 floor and
        // `!report_touch`) — a suppressed touch, not "no clash" — so return
        // it as-is rather than falling through further.
        return depth_clash_result(
            box_penetration(small, large),
            -signed_gap(aabb_a, aabb_b),
            None,
            aabb_a,
            aabb_b,
            report_touch,
            overlap.center(),
            overlap,
        );
    }

    if min_dist == f64::INFINITY {
        // Broad-phase candidate with no triangle-level proximity — not a clash.
        return None;
    }

    // Surfaces coincide/touch with no genuine crossing, but the AABBs
    // penetrate beyond tolerance (coplanar surfaces, e.g. axis-aligned
    // boxes). AABB penetration ALONE is not enough: skewed/abutting members
    // sharing only a face have overlapping AABBs yet no shared volume (old
    // false-hard-clash bug, #1362). Confirm a real shared volume by probing
    // for an interior point inside BOTH solids — the vertex-centroid midpoint
    // (skewed overlaps) or the AABB-overlap centre (unequal-length aligned
    // overlaps); a bare face touch has neither. Accept if EITHER qualifies.
    if min_dist <= tolerance {
        let gap = signed_gap(aabb_a, aabb_b);
        if gap < -tolerance {
            let probe_centroid = mid(tri_a.vertex_centroid(), tri_b.vertex_centroid());
            let probe_overlap = overlap.center();
            if (tri_a.contains_point(probe_centroid) && tri_b.contains_point(probe_centroid))
                || (tri_a.contains_point(probe_overlap) && tri_b.contains_point(probe_overlap))
            {
                // Tight contact region (clamped to the element overlap, not the
                // whole-element AABB intersection, #1362/#1402). Exact box-box
                // depth when both are boxes. May legitimately return `None`
                // (below the f32 floor and `!report_touch`) — a suppressed
                // touch, not "no shared volume" — so return it as-is rather
                // than falling through to the face-touch handling meant for
                // the "probes failed" case below.
                return depth_clash_result(
                    box_penetration(small, large),
                    -gap,
                    None,
                    aabb_a,
                    aabb_b,
                    report_touch,
                    mid(closest_a, closest_b),
                    contact_bounds,
                );
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
