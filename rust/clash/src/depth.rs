// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Depth measurement and the f32-precision floor for the narrow phase
//! (`narrow.rs`). Split out to keep `narrow.rs` under the module-size
//! ratchet; faithful port of `packages/clash/src/engine-ts/narrow.ts`'s
//! `boxPenetration` / `crossingVertexPenetration` / `depthClashResult`.

use crate::aabb::{depth_floor, estimate_floor, Aabb};
use crate::narrow::{ClashStatus, DistanceKind, NarrowResult};
use crate::obb::{is_through_penetration, obb_penetration};
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
    /// The unit axis `mtd` was measured along (its precision floor's
    /// direction, #5405).
    pub(crate) axis: Vec3,
    /// The MTD is inflated by the piercing member's own extent; report the
    /// AABB estimate instead (see `is_through_penetration`).
    pub(crate) through: bool,
}

pub(crate) fn box_penetration(small: &TriMesh, large: &TriMesh) -> Option<BoxPenetration> {
    let oa = small.get_obb()?;
    let ob = large.get_obb()?;
    let pen = obb_penetration(&oa, &ob)?;
    Some(BoxPenetration {
        mtd: pen.depth,
        axis: pen.axis,
        through: is_through_penetration(&oa, &ob),
    })
}

/// A crossing vertex's penetration into the other solid, with the unit
/// direction it was measured along (from the other's surface to the
/// vertex), which is what its precision floor is projected onto (#5405).
#[derive(Clone, Copy)]
pub(crate) struct VertexPenetration {
    pub(crate) depth: f64,
    pub(crate) axis: Vec3,
}

/// Deepest penetration of `mesh`'s crossing-triangle VERTICES into `other`:
/// the vertex of the triangles flagged in `cross_flags` (the pairs the
/// narrow phase saw genuinely crossing `other`) that lies inside `other`
/// farthest from its surface. Each vertex is visited once (deduped by vertex
/// index, in index order, strict `>` — bit-identical to the TS
/// `crossingVertexPenetration`). `None` when no flagged vertex is strictly
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
) -> Option<VertexPenetration> {
    let mut seen = vec![false; mesh.vertex_count()];
    let mut deepest: Option<VertexPenetration> = None;
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
            let (d, q) = other.closest_on_surface(v);
            if d > deepest.map_or(0.0, |e| e.depth) {
                deepest = Some(VertexPenetration {
                    depth: d,
                    axis: [(v[0] - q[0]) / d, (v[1] - q[1]) / d, (v[2] - q[2]) / d],
                });
            }
        }
    }
    deepest
}

/// Whether `inner` — AABB-contained in `outer`, with no triangle pair
/// crossing beyond f32 noise — is buried in `outer`'s solid (#5473).
///
/// With no crossing, each connected shell of `inner` lies entirely on one
/// side of `outer`'s surface up to touching it, so one probe point per shell
/// decides by ray parity — provided the probe is not itself on `outer`'s
/// surface, where parity is a coin flip decided by f32 rounding. The old
/// probe, `inner`'s first vertex, is exactly that point for a flush pair (an
/// element resting against the inside of another's AABB touches it AT its
/// vertices), so a rigid translation re-rolled the verdict.
///
/// Candidates are `inner`'s vertex centroid (when that lies inside `inner`)
/// and every vertex; a candidate is CLEAR when it is more than
/// [`PROBE_CLEAR_ULPS`] f32 ULPs of its largest coordinate off `outer`'s
/// surface, where its parity is trustworthy.
/// 1. Any clear candidate inside `outer` means its shell is buried: `true`.
///    Every candidate is checked, because `inner` may be several
///    disconnected shells and only one of them need be buried (review of
///    #5564); an outside shell must not end the search.
/// 2. Otherwise any clear candidate is outside, and no shell is clearly
///    buried: `false`.
/// 3. With no clear candidate at all — every vertex on `outer`'s surface —
///    the one farthest from it decides. That is what separates an element
///    exactly filling a notch (its centroid is outside) from a duplicate of
///    part of `outer` (its centroid is inside).
///
/// Visit order and strict comparisons keep the pick bit-identical to the TS
/// `containedSolidIsBuried`.
pub(crate) fn contained_solid_is_buried(inner: &TriMesh, outer: &TriMesh) -> bool {
    if inner.count == 0 {
        return false;
    }
    let clear = |p: Vec3, d: f64| {
        let m = p[0].abs().max(p[1].abs()).max(p[2].abs()).max(1.0);
        d > PROBE_CLEAR_ULPS * F32_ULP_SCALE * m
    };
    let centroid = inner.vertex_centroid();
    let candidates: Vec<Vec3> = inner
        .contains_point(centroid)
        .then_some(centroid)
        .into_iter()
        .chain((0..inner.vertex_count()).map(|i| inner.vertex(i as u32)))
        .collect();
    // 1. A clearly buried shell. Parity first: it is the cheaper query, and
    //    only candidates it places inside need their distance.
    if candidates
        .iter()
        .any(|&p| outer.contains_point(p) && clear(p, outer.distance_to_surface(p)))
    {
        return true;
    }
    // 2./3. No shell is clearly buried.
    let mut probe: Option<Vec3> = None;
    let mut farthest = f64::NEG_INFINITY;
    for &p in &candidates {
        let d = outer.distance_to_surface(p);
        if clear(p, d) {
            return false;
        }
        if d > farthest {
            farthest = d;
            probe = Some(p);
        }
    }
    probe.is_some_and(|p| outer.contains_point(p))
}

/// How far off `outer`'s surface a candidate must be for
/// `contained_solid_is_buried` to trust its ray parity, in f32 ULPs of its
/// largest coordinate. Generous on purpose: rounding moves a point on the
/// surface by a few ULPs, and a vertex any closer is treated as touching,
/// which only defers the verdict to a farther candidate.
const PROBE_CLEAR_ULPS: f64 = 64.0;

/// f32-ULP scale factor for a "worst-case" single-precision coordinate: for a
/// value with magnitude in `[2, 4)` the true float32 ULP is `2^-22`, and for
/// larger magnitudes the ULP only grows. Same term/reasoning as
/// `near_band_from_extent` in `rust/geometry/src/kernel/mesh_bridge.rs` —
/// kept here rather than shared since the two crates serve different callers.
/// Shared WITHIN this crate with `obb_detect`, which scales the very same
/// quantity (the f32 quantisation of the same vertex buffer) into a normal-
/// direction error bound.
pub(crate) const F32_ULP_SCALE: f64 = 1.0 / 4_194_304.0; // 2^-22

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
/// Each candidate is tested against the floor OF ITS OWN DIRECTION — the
/// pair's per-axis f32 noise projected onto the direction that candidate was
/// measured along (`depth_floor`, `estimate_floor`; #5405). A single floor
/// from the max coordinate over all axes handed a Z-direction depth the
/// noise of an X coordinate 10 km out: a genuine 2 mm overlap read as Touch
/// there and Hard at the origin, and near the origin the X extent pinned
/// the threshold for contacts that have no X component at all.
///
/// The pair is `Hard` only when EVERY available candidate clears its floor.
/// That is what makes the floor unreachable by depth-source selection: a sub-floor box MTD cannot be promoted by the through-
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
    mesh_evidence: Option<VertexPenetration>,
    aabb_a: &Aabb,
    aabb_b: &Aabb,
    report_touch: bool,
    point: Vec3,
    bounds: Aabb,
) -> Option<NarrowResult> {
    // `||` in the same order as the TS kernel, each comparison `<=` so a
    // NaN candidate never counts as below its floor, on either side.
    let est_floor = estimate_floor(aabb_a, aabb_b);
    let box_floor = box_pen.map(|b| depth_floor(b.axis, aabb_a, aabb_b));
    let below_floor = estimate <= est_floor
        || box_pen.zip(box_floor).is_some_and(|(b, f)| b.mtd <= f)
        || mesh_evidence.is_some_and(|e| e.depth <= depth_floor(e.axis, aabb_a, aabb_b));
    if below_floor {
        if !report_touch {
            return None;
        }
        return Some(NarrowResult {
            status: ClashStatus::Touch,
            distance: 0.0,
            distance_kind: DistanceKind::Mesh, // distance is exact (0)
            point,
            bounds,
            depth_floor: None,
        });
    }
    // Estimate-vs-mesh selection, reachable only above the floor: the box
    // MTD is certified (`Mesh`) unless the pair is a through-penetration,
    // where the AABB estimate is the honest number (see `box_penetration`).
    // The reported depth carries ITS OWN floor out with it (#5639), so the
    // reported touching band is decided by the same rule as this verdict.
    let measured = box_pen.filter(|b| !b.through);
    Some(NarrowResult {
        status: ClashStatus::Hard,
        distance: -measured.map_or(estimate, |b| b.mtd),
        distance_kind: if measured.is_some() {
            DistanceKind::Mesh
        } else {
            DistanceKind::Estimate
        },
        point,
        bounds,
        depth_floor: Some(measured.and(box_floor).unwrap_or(est_floor)),
    })
}
