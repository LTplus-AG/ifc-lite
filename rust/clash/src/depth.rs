// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Depth measurement and the f32-precision floor for the narrow phase
//! (`narrow.rs`). Split out to keep `narrow.rs` under the module-size
//! ratchet; faithful port of `packages/clash/src/engine-ts/narrow.ts`'s
//! `boxMeasuredDepth` / `precisionFloor` / `depthClashResult`.

use crate::aabb::Aabb;
use crate::narrow::{ClashStatus, DistanceKind, NarrowResult};
use crate::obb::{is_through_penetration, obb_penetration_depth};
use crate::tri_mesh::TriMesh;
use crate::vec3::Vec3;

/// Exact box-box penetration when BOTH meshes are (within tolerance)
/// rectangular boxes, else `None`. `mtd` is the only source of a `Mesh`
/// label for a distance that used to come from
/// `TriMesh::max_penetration_into`, a nearest-crossing-vertex sampling probe
/// that converges to 0 under retessellation instead of to the true depth
/// (see `obb.rs`, `tests.rs`). `through` flags a THROUGH-PENETRATION pair —
/// a thin member piercing clean through the other, e.g. a duct through a
/// wall — where the MTD is dominated by the piercing member's own extent,
/// not the material crossed, so `depth_clash_result` reports the caller's
/// AABB estimate instead. The MTD is still returned (not discarded here)
/// because the f32 floor must see it: which number gets REPORTED is a
/// separate, later decision from whether the pair is measurable at all.
/// Faithful port of the TS `boxPenetration` (#2536).
#[derive(Clone, Copy)]
pub(crate) struct BoxPenetration {
    /// Exact box-box minimum-translation depth (Gottschalk 15-axis SAT).
    pub(crate) mtd: f64,
    /// The MTD is inflated by the piercing member's own extent; report the
    /// AABB estimate instead (see `is_through_penetration`).
    pub(crate) through: bool,
}

pub(crate) fn box_penetration(small: &TriMesh, large: &TriMesh) -> Option<BoxPenetration> {
    let oa = small.get_obb()?;
    let ob = large.get_obb()?;
    let mtd = obb_penetration_depth(&oa, &ob)?;
    Some(BoxPenetration {
        mtd,
        through: is_through_penetration(&oa, &ob),
    })
}

/// Deepest penetration of `mesh`'s crossing-triangle VERTICES into `other`:
/// the maximum `distance_to_surface` of `other` over the vertices of the
/// triangles flagged in `cross_flags` (the pairs the narrow phase saw
/// genuinely crossing `other`) that lie inside `other`. Each vertex is
/// visited once (deduped by vertex index, in index order — bit-identical to
/// the TS `crossingVertexPenetration`). Returns 0 when no flagged vertex is
/// inside.
///
/// This is NOT a depth metric and must never be reported as one — it is the
/// sampling probe PR #2536 was held over (`max_penetration_into`): its value
/// is an O(edge length) artifact that converges to 0 under retessellation
/// instead of to the true depth. It survives with exactly one client: the
/// f32 noise-floor gate for a CONTAINED pair (`depth_clash_result`), where
/// the question is not "how deep?" but "is any mesh-level penetration
/// measurably above the floor at all?" — sub-floor here means every crossing
/// vertex sits within f32 rounding noise of the other surface, i.e. surfaces
/// authored flush, which no amount of retessellation turns into a real
/// overlap. For that yes/no question the probe's underestimation is
/// harmless: underestimating can only keep a pair BELOW the floor, and the
/// floor is the very thing being tested.
pub(crate) fn crossing_vertex_penetration(
    mesh: &TriMesh,
    other: &TriMesh,
    cross_flags: &[bool],
) -> f64 {
    let mut seen = vec![false; mesh.vertex_count()];
    let mut depth = 0.0f64;
    // `cross_flags` has one entry per triangle (len == mesh.count).
    for (t, &flagged) in cross_flags.iter().enumerate() {
        if !flagged {
            continue;
        }
        for vi in mesh.tri_indices(t) {
            let vi = vi as usize;
            if seen[vi] {
                continue;
            }
            seen[vi] = true;
            let v = mesh.vertex(vi as u32);
            if !other.contains_point(v) {
                continue;
            }
            let d = other.distance_to_surface(v);
            if d > depth {
                depth = d;
            }
        }
    }
    depth
}

/// f32-ULP scale factor for a "worst-case" single-precision coordinate: for a
/// value with magnitude in `[2, 4)` the true float32 ULP is `2^-22`, and for
/// larger magnitudes the ULP only grows. Same term/reasoning as
/// `near_band_from_extent` in `rust/geometry/src/kernel/mesh_bridge.rs` —
/// kept here rather than shared since the two crates serve different callers.
const F32_ULP_SCALE: f64 = 1.0 / 4_194_304.0; // 2^-22

/// Penetration-depth floor below which a computed overlap cannot be
/// distinguished from float32 rounding noise, scaled to the pair's own
/// coordinate magnitude (a fixed constant would be far too tight for infra
/// models far from the origin, and far too loose for small ones near it).
///
/// `tri_mesh.rs` ingests geometry from f32 buffers and stores/queries it in
/// f64, so f64 arithmetic cannot recover precision the source never had: two
/// surfaces authored flush round to adjacent f32 values, and the resulting
/// "penetration" is bit-noise at the ULP of the largest operand coordinate,
/// not a measured overlap. Extent is the max abs coordinate over both
/// elements' AABBs, floored at 1.0 so a model near the origin still gets the
/// single-unit ULP, not zero.
///
/// The floor grows linearly with distance from the origin, same as f32
/// precision itself: on a georeferenced model (real map coordinates,
/// hundreds of km out) the floor reaches decimetre scale and a genuine clash
/// below it reclassifies as `Touch` — not a bug, since f32 genuinely cannot
/// represent a finer distinction there. The fix is ingesting geometry closer
/// to the origin (or in f64), not lowering this floor.
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

/// Turns the candidate penetration depths into the final `NarrowResult`. The
/// ONLY place allowed to build a `Mesh`/`Estimate`-labelled `Hard` result off
/// a depth number — every branch in `narrow.rs` that can label a result
/// `Mesh` off `box_penetration` (or its AABB-estimate fallback) MUST route
/// through here instead of constructing the result itself. That is what
/// makes the f32 floor apply to all of them, and what enforces its
/// precedence.
///
/// THE FLOOR WINS (#2536 rebase decision): a pair below the f32 noise floor
/// is `Touch` regardless of how its depth was derived — at that magnitude
/// the number is not measurable either way — so the floor is tested against
/// EVERY candidate depth the pair has, not against whichever one the
/// estimate-vs-mesh selection would report. Three candidates exist:
///
/// - the AABB `estimate` (always present);
/// - the box MTD, when both elements are certified boxes (`box_pen`);
/// - the crossing-vertex penetration, for a CONTAINED pair with a crossing
///   vertex inside the other solid (`mesh_evidence`) — evidence for this
///   gate only, never a reported depth (see `crossing_vertex_penetration`).
///
/// The pair is `Hard` only when the SMALLEST available candidate clears the
/// floor. That is what makes the floor unreachable by depth-source
/// selection: a sub-floor box MTD cannot be promoted by the through-
/// penetration guard swapping in a larger AABB estimate; a sub-floor
/// crossing-vertex penetration on a contained pair (surfaces authored
/// flush — the eight Infra-Bridge pairs that moved #2594's 50-hard-clash
/// pin to 58 when this PR's depth rework replaced their noise-scale mesh
/// depth with the fabricated 4 m AABB estimate) cannot be promoted by that
/// estimate; and a sub-floor AABB estimate cannot be promoted by a larger
/// MTD (a through-penetration far from the origin, where the MTD is
/// inflated by the piercing member's own extent). Only a pair already above
/// the floor reaches the selection, which then merely picks WHICH
/// above-floor reportable number is used and how it is labelled — so a
/// `Hard` result's distance clears the floor by construction, whichever
/// quantity it came from. Faithful port of the TS `depthClashResult`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn depth_clash_result(
    box_pen: Option<BoxPenetration>,
    estimate: f64,
    mesh_evidence: Option<f64>,
    aabb_a: &Aabb,
    aabb_b: &Aabb,
    report_touch: bool,
    point: Vec3,
    bounds: Aabb,
) -> Option<NarrowResult> {
    let mut floor_depth = estimate;
    if let Some(b) = box_pen {
        floor_depth = floor_depth.min(b.mtd);
    }
    if let Some(m) = mesh_evidence {
        floor_depth = floor_depth.min(m);
    }
    if floor_depth <= precision_floor(aabb_a, aabb_b) {
        if !report_touch {
            return None;
        }
        return Some(NarrowResult {
            status: ClashStatus::Touch,
            distance: 0.0,
            distance_kind: DistanceKind::Mesh, // distance is exact (0)
            point,
            bounds,
        });
    }
    // Estimate-vs-mesh selection, reachable only above the floor: the box
    // MTD is certified (`Mesh`) unless the pair is a through-penetration,
    // where the AABB estimate is the honest number (see `box_penetration`).
    let measured = box_pen.is_some_and(|b| !b.through);
    Some(NarrowResult {
        status: ClashStatus::Hard,
        distance: -(match box_pen {
            Some(b) if !b.through => b.mtd,
            _ => estimate,
        }),
        distance_kind: if measured {
            DistanceKind::Mesh
        } else {
            DistanceKind::Estimate
        },
        point,
        bounds,
    })
}
