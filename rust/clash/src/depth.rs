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

/// Exact box-box penetration depth when BOTH meshes are (within tolerance)
/// rectangular boxes, else `None` — the only source of a `Mesh` label for a
/// distance that used to come from `TriMesh::max_penetration_into`, a
/// nearest-crossing-vertex sampling probe that converges to 0 under
/// retessellation instead of to the true depth (see `obb.rs`, `tests.rs`).
/// Also declines (returns `None`) for a THROUGH-PENETRATION pair — a thin
/// member piercing clean through the other, e.g. a duct through a wall —
/// where the MTD is dominated by the piercing member's own extent, not the
/// material crossed. Faithful port of the TS `boxMeasuredDepth` (#2536).
pub(crate) fn box_measured_depth(small: &TriMesh, large: &TriMesh) -> Option<f64> {
    let oa = small.get_obb()?;
    let ob = large.get_obb()?;
    if is_through_penetration(&oa, &ob) {
        return None;
    }
    obb_penetration_depth(&oa, &ob)
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

/// Turns a candidate penetration depth into the final `NarrowResult`. The
/// ONLY place allowed to build a `Mesh`/`Estimate`-labelled `Hard` result off
/// a depth number — every branch in `narrow.rs` that can label a result
/// `Mesh` off `box_measured_depth` (or its AABB-estimate fallback) MUST route
/// through here instead of constructing the result itself. The floor is
/// checked here before `measured` picks `Mesh` vs `Estimate`, so a depth
/// below it always reports `Touch`, regardless of which branch or quantity
/// produced it. A fourth `Mesh`-labelling branch added later inherits this
/// precedence as long as it calls this function. Faithful port of the TS
/// `depthClashResult`.
pub(crate) fn depth_clash_result(
    depth: f64,
    measured: bool,
    aabb_a: &Aabb,
    aabb_b: &Aabb,
    report_touch: bool,
    point: Vec3,
    bounds: Aabb,
) -> Option<NarrowResult> {
    if depth <= precision_floor(aabb_a, aabb_b) {
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
    Some(NarrowResult {
        status: ClashStatus::Hard,
        distance: -depth,
        distance_kind: if measured {
            DistanceKind::Mesh
        } else {
            DistanceKind::Estimate
        },
        point,
        bounds,
    })
}
