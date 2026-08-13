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

/// f32-ULP scale factor for a "worst-case" single-precision coordinate: for a
/// value with magnitude in `[2, 4)` the true float32 ULP is `2^-22`, and for
/// larger magnitudes the ULP only grows. Same `2^-22` term (and reasoning) as
/// `near_band_from_extent` in `rust/geometry/src/kernel/mesh_bridge.rs` — see
/// that function's doc for the derivation; kept here rather than shared
/// because the two crates serve different callers.
const F32_ULP_SCALE: f64 = 1.0 / 4_194_304.0; // 2^-22

/// Penetration-depth floor below which a computed overlap cannot be
/// distinguished from float32 rounding noise, scaled to the pair's own
/// coordinate magnitude (not a fixed constant — infra models sit far from the
/// origin, where a fixed epsilon would be far too tight, and small models sit
/// near it, where a fixed epsilon would be far too loose).
///
/// `tri_mesh.rs` ingests geometry from f32 buffers and stores/queries it in
/// f64, so f64 arithmetic cannot recover precision the source data never
/// had: two surfaces authored to be flush round to adjacent f32 values, and
/// the resulting "penetration" is bit-noise at the ULP of whichever operand
/// coordinate is largest, not a measured overlap. Extent is the max abs
/// coordinate over both elements' AABBs (matching `near_band_from_extent`'s
/// use of the actual compared coordinates), floored at 1.0 so a model near
/// the origin still gets the single-unit ULP, not zero.
///
/// The floor grows linearly with the pair's distance from the origin — that
/// is the point, since f32 precision itself degrades the same way. The
/// consequence: on a georeferenced model whose elements sit at real map
/// coordinates (hundreds of kilometres out, which real IFC files do), the
/// floor reaches decimetre scale, and a genuine clash below that threshold
/// reclassifies as `Touch`. That is not a bug in this function — at those
/// magnitudes f32 genuinely cannot represent a finer distinction, so the
/// "penetration" is not reliably measurable either way — but it means the
/// floor tracks a limitation of the source data, not of clash detection.
/// The fix for a model in that position is ingesting geometry closer to the
/// origin (or in f64), not lowering this floor.
fn precision_floor(aabb_a: &Aabb, aabb_b: &Aabb) -> f64 {
    let mut extent = 1.0f64;
    for b in [aabb_a, aabb_b] {
        for v in [&b.min, &b.max] {
            for &c in v {
                let a = c.abs();
                if a > extent {
                    extent = a;
                }
            }
        }
    }
    extent * F32_ULP_SCALE
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

    // One AABB containing the other flags the contained-contact case (#1866):
    // for such pairs the AABB signed gap measures how deep the small BOX sits in
    // the big one (its own extent), not how far the MESHES interpenetrate, so
    // collect the crossing triangles for a mesh-level depth measurement instead.
    let contained = aabb_contains(aabb_b, aabb_a) || aabb_contains(aabb_a, aabb_b);
    let mut cross_small: Vec<bool> = if contained { vec![false; small.count] } else { Vec::new() };
    let mut cross_large: Vec<bool> = if contained { vec![false; large.count] } else { Vec::new() };

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
                // Flag the crossing pair for the contained-case depth
                // measurement; the flag vecs are empty (`get_mut` = None)
                // when the pair is not contained.
                if let Some(flag) = cross_small.get_mut(ts) {
                    *flag = true;
                }
                if let Some(flag) = cross_large.get_mut(tl as usize) {
                    *flag = true;
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
        // Penetration estimate from the AABB overlap...
        let mut penetration = (-signed_gap(aabb_a, aabb_b)).max(0.0);
        // ...EXCEPT for a contained pair (#1866): there the AABB overlap equals
        // the small element's own extent, wildly overstating depth for designed
        // face contacts (e.g. opening fills inset in their host). Measure the
        // real mesh-level depth instead: the deepest crossing-triangle vertex of
        // either mesh inside the other solid. Falls back to the AABB estimate
        // when no such vertex lies inside (thin member piercing straight
        // through).
        if contained {
            let mesh_depth = small
                .max_penetration_into(large, &cross_small)
                .max(large.max_penetration_into(small, &cross_large));
            if mesh_depth > 0.0 {
                penetration = mesh_depth;
            }
        }
        // A genuine triangle crossing was found, but the measured depth is at
        // or below the f32 precision floor for this pair's coordinate scale:
        // it cannot be distinguished from rounding noise (see
        // `precision_floor`), so it is not a measured overlap. Reclassify as
        // `Touch` rather than `Hard` — the crossing still means the surfaces
        // are in contact, which is real information (this codebase already
        // distinguishes touching from overlapping, e.g. the viewer's
        // `clashHideTouching` toggle) — rather than silently dropping the
        // pair or reporting a fabricated depth.
        if penetration <= precision_floor(aabb_a, aabb_b) {
            if !report_touch {
                return None;
            }
            return Some(NarrowResult {
                status: ClashStatus::Touch,
                distance: 0.0,
                point,
                bounds: contact_bounds,
            });
        }
        return Some(NarrowResult {
            status: ClashStatus::Hard,
            distance: -penetration,
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
                // contact (#1362/#1402).
                return Some(NarrowResult {
                    status: ClashStatus::Hard,
                    distance: gap,
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
