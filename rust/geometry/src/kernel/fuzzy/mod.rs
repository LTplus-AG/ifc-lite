// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fuzzy (tolerance-based f64) boolean SUBTRACT — a FAST TIER in front of the
//! exact mesh-arrangement kernel, ported from web-ifc's `fuzzybools` approach.
//!
//! The exact kernel ([`super::arrangement`]) is correct-by-construction but pays
//! symbolic/BigRational escalation and re-arranges every intersected face over a
//! shared interner. On many-opening hosts (ISSUE_129) that N-ary arrangement is
//! the dominant cost. web-ifc is ~4× faster on the same corpus because it runs a
//! plain f64 tolerance boolean instead. This module adopts that as a fast path:
//!
//! 1. Intersect (BVH-culled) host×cutter triangle pairs → per-face constraint
//!    segments in plain f64 ([`intersect`]).
//! 2. Re-triangulate each INTERSECTED face with those constraints via the
//!    in-tree deterministic CDT ([`retri`]); untouched faces pass through
//!    verbatim (the big win — no global re-arrangement).
//! 3. Classify every resulting sub-triangle inside/outside by a ray-cast from a
//!    NON-barycentric centroid, voting across 3 fixed directions ([`classify`]).
//!    SUBTRACT keeps host tris OUTSIDE the cutters + cutter tris INSIDE the host
//!    (flipped) as reveal caps.
//!
//! This is NOT a replacement: the caller ([`super::mesh_bridge::subtract_many`])
//! STRICT-SELF-CHECKS every fuzzy result (watertight AND removed-volume == the
//! disjoint oracle Σ|host∩cutterᵢ|) and DISCARDS it — running the exact kernel
//! unchanged — on any failure. A bad fuzzy result can therefore never regress
//! correctness; the tier only ever makes a provably-good result faster.
//!
//! DETERMINISM: all f64, FMA-free (no `mul_add`), fixed ray directions,
//! deterministic vertex/face ordering, IEEE `sqrt` only, and the shared CDT is
//! already native==wasm bit-identical (it is used in production by the prism-cut
//! path under the `mesh_determinism` manifest). So the fuzzy output is
//! byte-identical native==wasm too. The tier is env-gated OFF by default
//! (`IFC_LITE_FUZZY_BOOL`), so a default build is byte-identical to the exact
//! kernel and the determinism manifest is unperturbed.

use super::arrangement::Tri;
use super::broadphase::{candidate_pairs, Bvh};

mod classify;
mod intersect;
mod retri;
#[cfg(test)]
mod tests;

// --- small FMA-free f64 vec3 helpers, shared across the submodules ----------

#[inline]
pub(super) fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
pub(super) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

#[inline]
pub(super) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Raw (un-normalised) face normal of a triangle.
#[inline]
pub(super) fn tri_normal(t: &Tri) -> [f64; 3] {
    cross(sub(t[1], t[0]), sub(t[2], t[0]))
}

/// NON-barycentric centroid `(a + 1.02·b + 1.03·c)/3.05`. The asymmetric weights
/// push the sample off any vertex/edge/median so a classification ray is
/// vanishingly unlikely to graze a shared edge or hit a vertex of the operand it
/// probes (web-ifc's degenerate-ray avoidance). FMA-free.
#[inline]
pub(super) fn centroid_nb(t: &Tri) -> [f64; 3] {
    [
        (t[0][0] + 1.02 * t[1][0] + 1.03 * t[2][0]) / 3.05,
        (t[0][1] + 1.02 * t[1][1] + 1.03 * t[2][1]) / 3.05,
        (t[0][2] + 1.02 * t[1][2] + 1.03 * t[2][2]) / 3.05,
    ]
}

/// SHARED-POSITION snap (design step 1). Quantise a coordinate to the kernel's
/// `SNAP_GRID` (a power of two ⇒ the divide/round/multiply is EXACT and
/// bit-deterministic). Applied to BOTH operands' vertices AND every computed
/// intersection endpoint so a point that two different triangle pairs compute
/// independently (e.g. an opening corner shared by two host faces) lands on the
/// SAME grid cell — the coincidence that makes the re-triangulated seams close
/// watertight without a shared symbolic interner. Coarse enough (~15 µm) to
/// merge ULP-scattered duplicates; three orders below the smallest real feature.
#[inline]
pub(super) fn snap_coord(c: f64) -> f64 {
    (c / super::mesh_bridge::SNAP_GRID).round() * super::mesh_bridge::SNAP_GRID
}

#[inline]
pub(super) fn snap_pt(p: [f64; 3]) -> [f64; 3] {
    [snap_coord(p[0]), snap_coord(p[1]), snap_coord(p[2])]
}

fn snap_tris(tris: &[Tri]) -> Vec<Tri> {
    tris.iter().map(|t| [snap_pt(t[0]), snap_pt(t[1]), snap_pt(t[2])]).collect()
}

/// Coordinate magnitude (max |component|) over a triangle list — sizes the
/// intersection epsilon and the ray far-length to the operand.
pub(super) fn coord_extent(tris: &[Tri]) -> f64 {
    let mut hi = 1.0f64;
    for t in tris {
        for v in t {
            for &c in v {
                hi = hi.max(c.abs());
            }
        }
    }
    hi
}

/// Is the fuzzy tier enabled? Env gate `IFC_LITE_FUZZY_BOOL` (read ONCE):
/// `1`/`true`/`on` ⇒ ON, anything else (incl. absent — the default, and the wasm
/// case where env is unavailable) ⇒ OFF. Default OFF keeps a default build
/// byte-identical to the exact kernel (`mesh_determinism` manifest unperturbed);
/// the tier is opted into explicitly for the A/B and, once proven, a follow-up
/// flip of this default.
pub fn enabled() -> bool {
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| {
        matches!(std::env::var("IFC_LITE_FUZZY_BOOL").as_deref(), Ok("1") | Ok("true") | Ok("on"))
    })
}

/// Measurement-only stderr trace of fuzzy claim/fallback decisions, gated by
/// `IFC_LITE_FUZZY_STATS=1` (read once). OFF by default ⇒ zero cost on the hot
/// path (no atomics, no I/O); it exists solely so a bench run can count the
/// fuzzy HIT-RATE (claims vs fallbacks) without instrumenting the caller. Not
/// consulted by any test, so it cannot race a correctness assertion.
fn stats_on() -> bool {
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("IFC_LITE_FUZZY_STATS").as_deref() == Ok("1"))
}

pub(super) fn trace_claim() {
    if stats_on() {
        eprintln!("FUZZY_BOOL claim");
    }
}

pub(super) fn trace_fallback(reason: &str) {
    if stats_on() {
        eprintln!("FUZZY_BOOL fallback:{reason}");
    }
}

/// `host − (∪ comps)` as an f64 triangle list, computed by the fuzzy tolerance
/// boolean. `comps` are the PAIRWISE-DISJOINT, per-component-closed, outward-
/// wound cutter components (exactly what [`super::mesh_bridge::subtract_many`]
/// prepares for the exact path). Returns `None` on any structural failure (a
/// face whose constrained CDT could not be built, a degenerate operand) so the
/// caller falls straight to the exact kernel; a `Some` result is NOT yet trusted
/// — the caller still watertight/volume self-checks it.
///
/// SUBTRACT rule (web-ifc): keep host sub-triangles whose centroid is OUTSIDE
/// the cutter union, plus cutter sub-triangles whose centroid is INSIDE the host
/// — the latter WINDING-FLIPPED so their normals face out of the removed cavity
/// (the reveal/jamb caps), matching `A−B = (A outside B) ∪ flip(B inside A)`.
pub(super) fn subtract(host: &[Tri], comps: &[Vec<Tri>]) -> Option<Vec<Tri>> {
    if host.is_empty() {
        return Some(Vec::new());
    }
    // Reject non-finite / malformed operands up front (defensive: `mesh_to_tris`
    // already drops non-finite, but a caller could pass raw tris).
    if !all_finite(host) || !comps.iter().all(|c| all_finite(c)) {
        return None;
    }
    // Shared-position snap of BOTH operands onto the kernel grid (design step 1),
    // so coincident vertices across operands are bit-identical.
    let host: Vec<Tri> = snap_tris(host);
    // Flatten the disjoint cutter components into one union soup for the
    // host-vs-cutters ray parity. Disjoint closed solids ⇒ parity-of-total-
    // crossings == inside-exactly-one, so a single union mesh + BVH is correct.
    let cutters: Vec<Tri> = comps.iter().flat_map(|c| c.iter().map(|t| [snap_pt(t[0]), snap_pt(t[1]), snap_pt(t[2])])).collect();
    if cutters.is_empty() {
        return Some(host);
    }

    let host_bvh = Bvh::build(&host);
    let cut_bvh = Bvh::build(&cutters);
    let host_ext = coord_extent(&host).max(coord_extent(&cutters));

    // 1+2. Per-face intersection constraint segments (host and cutter sides).
    let mut host_segs: Vec<Vec<intersect::Seg>> = vec![Vec::new(); host.len()];
    let mut cut_segs: Vec<Vec<intersect::Seg>> = vec![Vec::new(); cutters.len()];
    for (i, j) in candidate_pairs(&host, &cutters) {
        if let Some((a, b)) = intersect::tri_tri_segment(&host[i], &cutters[j], host_ext) {
            // Snap the endpoints onto the shared grid so a corner two different
            // triangle pairs compute independently is bit-identical, and feed the
            // SAME f64 endpoints to BOTH faces ⇒ watertight seam (the shared-
            // interner role, done here by shared snapped f64 coordinates).
            let seg = (snap_pt(a), snap_pt(b));
            host_segs[i].push(seg);
            cut_segs[j].push(seg);
        }
    }

    // Global de-duplicated intersection-endpoint sets, one per operand, for the
    // cross-face T-junction resolution: a point that is a seam vertex on ONE
    // face must also split any OTHER face's edge it lies on, or the shared edge
    // tears. `retriangulate` injects the on-edge subset per face.
    let host_pts = dedup_pts(&host_segs);
    let cut_pts = dedup_pts(&cut_segs);

    let ray_far = 4.0 * host_ext + 1.0;
    let mut out: Vec<Tri> = Vec::new();
    let mut scratch: Vec<u32> = Vec::new();

    // 3a. Host faces: re-triangulate, keep sub-triangles OUTSIDE the cutters.
    for (i, ht) in host.iter().enumerate() {
        let pieces = retri::retriangulate(ht, &host_segs[i], &host_pts)?;
        for tri in pieces {
            let c = centroid_nb(&tri);
            if !classify::inside_vote(c, &cutters, &cut_bvh, ray_far, &mut scratch) {
                out.push(tri);
            }
        }
    }
    // 3b. Cutter faces: re-triangulate, keep sub-triangles INSIDE the host,
    // winding-flipped to face out of the removed cavity (reveal caps).
    for (j, ct) in cutters.iter().enumerate() {
        let pieces = retri::retriangulate(ct, &cut_segs[j], &cut_pts)?;
        for tri in pieces {
            let c = centroid_nb(&tri);
            if classify::inside_vote(c, &host, &host_bvh, ray_far, &mut scratch) {
                out.push([tri[0], tri[2], tri[1]]);
            }
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

fn all_finite(tris: &[Tri]) -> bool {
    tris.iter().all(|t| t.iter().all(|v| v.iter().all(|c| c.is_finite())))
}

/// Flatten a per-face segment list into a de-duplicated point set (exact f64
/// bits), the global endpoint pool for cross-face T-junction resolution.
/// Deterministic order (first-seen) via an insertion-ordered dedup.
fn dedup_pts(per_face: &[Vec<intersect::Seg>]) -> Vec<[f64; 3]> {
    use rustc_hash::FxHashSet;
    let mut seen: FxHashSet<(u64, u64, u64)> = FxHashSet::default();
    let mut out: Vec<[f64; 3]> = Vec::new();
    for segs in per_face {
        for &(a, b) in segs {
            for p in [a, b] {
                let k = (p[0].to_bits(), p[1].to_bits(), p[2].to_bits());
                if seen.insert(k) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Run the fuzzy f64 subtract and its STRICT self-check, returning the finished
/// `Mesh` ONLY when the fuzzy result is (a) watertight AND (b) removes exactly
/// the disjoint oracle volume Σ|host∩cutterᵢ| within a tight relative tolerance;
/// `None` otherwise so `subtract_many` uses the exact kernel. This is what makes
/// the tier safe: a torn or over/under-cutting fuzzy result is caught here and
/// never returned.
pub(super) fn subtract_checked(host: &[Tri], comps: &[Vec<Tri>]) -> Option<crate::mesh::Mesh> {
    let f = subtract(host, comps)?;
    if !is_watertight(&f) {
        trace_fallback("not-watertight");
        return None;
    }
    let inter_sum = match oracle_removed_volume(host, comps) {
        Some(s) => s,
        None => {
            trace_fallback("oracle-tripped");
            return None;
        }
    };
    let removed = super::signed_volume::signed_volume6(host).abs()
        - super::signed_volume::signed_volume6(&f).abs();
    let tol = inter_sum.abs().max(1.0e-9) * 0.01;
    if (removed - inter_sum).abs() <= tol {
        trace_claim();
        Some(super::mesh_bridge::tris_to_mesh(&f))
    } else {
        trace_fallback("volume-mismatch");
        None
    }
}

/// The disjoint-cutter volume oracle Σ|host ∩ cutterᵢ| (#1788): batched cutters
/// are pairwise disjoint (the `subtract_many` contract), so the TRUE removed
/// volume is the sum of each cutter's exact intersection with the PRISTINE host
/// — each a small single boolean in the well-conditioned regime. `None` when an
/// oracle intersection trips the escalation budget (its volume is then
/// untrustworthy). Budget snapshot/restore keeps the oracle work OFF the
/// caller's batch budget (codex P2 on #1660). Shared by the fuzzy self-check
/// here AND `mesh_bridge`'s exact lenient-batch acceptance check, so both weigh
/// removed volume against the SAME trusted reference.
pub(super) fn oracle_removed_volume(host: &[Tri], comps: &[Vec<Tri>]) -> Option<f64> {
    use super::arrangement::{boolean, BoolOp};
    let budget_snap = super::budget::snapshot_counters();
    let mut inter_sum = 0.0f64;
    let mut tripped = false;
    for c in comps {
        super::budget::begin();
        let i = boolean(host, c, BoolOp::Intersection);
        if super::budget::tripped() {
            tripped = true;
            break;
        }
        inter_sum += super::signed_volume::signed_volume6(&i).abs();
    }
    super::budget::restore_counters(budget_snap);
    if tripped {
        None
    } else {
        Some(inter_sum)
    }
}

/// Is the f64 triangle list a CLOSED oriented surface — every directed edge
/// matched by its exact reverse? Keyed on the raw f64 bits (no rounding): two
/// seam vertices that differ by even one ULP read as a crack, which is exactly
/// the watertightness bar the self-check needs. Empty ⇒ not watertight.
pub(super) fn is_watertight(tris: &[Tri]) -> bool {
    use rustc_hash::FxHashMap;
    if tris.is_empty() {
        return false;
    }
    let key = |p: [f64; 3]| (p[0].to_bits(), p[1].to_bits(), p[2].to_bits());
    let mut edges: FxHashMap<((u64, u64, u64), (u64, u64, u64)), i32> = FxHashMap::default();
    for t in tris {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *edges.entry((key(a), key(b))).or_insert(0) += 1;
            *edges.entry((key(b), key(a))).or_insert(0) -= 1;
        }
    }
    edges.values().all(|&c| c == 0)
}
