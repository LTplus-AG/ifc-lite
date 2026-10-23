// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Analytic prism subtraction on the host MESH.
//!
//! The dominant expensive void cut on CSG-heavy models (ISSUE_098 / ISSUE_129)
//! is a PERPENDICULAR prism opening — a window / door / sleeve — on a host the
//! other fast paths cannot serve: faceted-BREP walls, clipped extrusions,
//! multi-item bodies. The exact mesh-arrangement kernel is at its
//! single-threaded floor (~15 ms per cut), yet the cutter is just a polygonal
//! profile swept through the wall (masonry openings are REBATED — stepped
//! multi-vertex profiles, not plain boxes). This path subtracts such a cutter
//! analytically from ANY host mesh:
//!
//! 1. DETECT that the cutter mesh is a genuine prism: a closed 2-manifold with
//!    one depth axis `d` such that every facet is either parallel (the two end
//!    caps, each on one extremal plane) or perpendicular (the sides) to `d`;
//!    the profile polygon is stitched from the cap facet's boundary loop and
//!    the enclosed volume must reconcile with `area × depth`. Any deviation
//!    (curved-cap void, open shell, annular profile, self-intersecting
//!    garbage) is left to the exact kernel.
//! 2. EXTEND each cap past the host surface when (and only when) the swept
//!    slab is provably empty of host material — a flush cap becomes a clean
//!    transversal crossing (the #1112 lesson) while a genuine blind recess
//!    keeps its authored bottom.
//! 3. DECOMPOSE only the host triangles that actually reach the prism: each
//!    such triangle T gets the exact `T ∩ ∂prism` seam segments (cap-plane
//!    chords clipped to the profile in 2D; side-strip chords clipped to the
//!    strip rectangle) as constraints of a per-triangle conforming CDT, whose
//!    sub-triangles are classified inside/outside the prism by centroid.
//!    Shared edges subdivide identically across neighbours (every edge×plane
//!    crossing is computed once through a canonical-order cache and admitted
//!    by a point-deterministic face-membership gate), so the kept surface
//!    stays T-junction-free. Triangles away from the prism pass through
//!    UNTOUCHED — original coordinates and normals.
//! 4. CAP the reveal: each prism face (2 profile caps + one rectangle per
//!    profile edge) is triangulated by a CDT of the face polygon constrained
//!    by the seams from step 3, each sub-triangle kept iff its centroid lies
//!    inside the (pre-cut) host solid by ray parity. Cap boundaries reuse the
//!    exact seam coordinates, so caps weld to the kept host fragments.
//!
//! SELF-CHECKS (failed candidates remain for the exact kernel; a final-surface
//! failure defers the full opening set):
//! * retained and discarded host fragments must conserve the source surface
//!   within host-scale clipping tolerance, independently of the reference;
//! * a geometric envelope and the consolidated result must permit measurable
//!   removal; open fragment divergence is never used as a removed-solid volume;
//! * the host must arrive as a consistently-wound closed solid and the final
//!   emitted mesh must pass the same DIRECTED quantized closed-surface audit
//!   (which also catches doubled coincident faces and flipped caps).
//!
//! The whole computation runs in f64 (host f32 promoted once, stored f32 once
//! at the end), with no FMA-sensitive matrix products and deterministic
//! iteration order, so native == wasm stays byte-identical (#1297). Vertices
//! are never welded (#846); per-element `origin` is preserved exactly.
//!
//! Gate: `IFC_LITE_PRISM_CUT=0` forces every host back through the exact
//! kernel (A/B measurement). Default ON; wasm has no env, so the default holds
//! on both targets.

use std::sync::OnceLock;

use super::admission::{aabb_engulfs, min_opening_volume, ENGULF_TOLERANCE};
use super::geom::opening_mesh_thinnest_axis_dir;
mod depth_axes;
use super::parity::{forward_crossing, PARITY_DIR_A};
use super::{cutter_is_closed_manifold, CutterKind, VoidContext};
use crate::program::openings::execute::Execution;
use crate::cdt::triangulate_pslg;
use crate::mesh::Mesh;
use nalgebra::Point2;
use rustc_hash::FxHashMap;

/// `IFC_LITE_PRISM_CUT=0` disables the analytic prism-subtraction path (exact
/// kernel for every host). Default ON; read once.
mod vertex_dedup;
mod opening_prism;
use opening_prism::prepare_prism;
mod finish;
mod tjunction_close;
mod planar_correction;
#[cfg(test)]
#[path = "prism_cut_tests.rs"]
mod tests;
use crate::mesh_check::{closed_enough_to_emit, directed_closed, ClosureVerdict};
#[cfg(test)]
use crate::mesh_check::closed_or_hairline;
pub(crate) use vertex_dedup::dedup_cut_vertices;
pub(in crate::router::voids) use finish::finish_cut_verdict;
pub(super) use planar_correction::correct_planar_overlap;

pub(super) fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("IFC_LITE_PRISM_CUT").as_deref() != Ok("0"))
}

// ─────────────────────────── diagnostic counters ────────────────────────────
// Per the geometry-crate convention, telemetry is compiled in ONLY under an
// observability feature (`observability` / `csg_capture` / `debug_geometry`).
// The default build carries no process-global atomics on the hot path — no
// per-opening atomic traffic, and no shared mutable state for concurrent unit
// tests to race on. `take_prism_stats` / `take_prism_defers` stay public in
// both configurations (return zeros when the feature is off) so the crate's
// exported surface is stable; unit tests assert path coverage through
// `try_prism_cut`'s RETURN VALUE, not these counters.

#[cfg(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry"))]
mod diag {
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIRES: AtomicU64 = AtomicU64::new(0);
    static OPENINGS_ANALYTIC: AtomicU64 = AtomicU64::new(0);
    static OPENINGS_RESIDUAL: AtomicU64 = AtomicU64::new(0);

    /// Defer-reason counters (diagnostic only): indices into [`DEFER_NAMES`].
    const DEFER_NAMES: [&str; 10] = [
        "host_not_closed",
        "host_promote_fail",
        "op_not_prism",
        "op_tiny",
        "op_no_overlap",
        "op_engulf",
        "op_veto_overlap",
        "cut_cdt_fail",
        "cut_partition_fail",
        "out_not_closed",
    ];
    static DEFERS: [AtomicU64; 10] = [
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
    ];

    #[inline]
    pub(super) fn defer(i: usize) {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| c.prism_defers[i] = c.prism_defers[i].saturating_add(1));
        crate::telemetry_transaction::record(
            crate::telemetry_transaction::Event::PrismDefer { reason: i },
        );
    }

    /// Record one analytic-cut host: (fires, openings cut, openings residual).
    #[inline]
    pub(super) fn record_cut(committed_ops: usize, residual: usize) {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            c.prism_candidate_successes = c.prism_candidate_successes.saturating_add(1);
            c.prism_candidate_openings = c.prism_candidate_openings.saturating_add(committed_ops as u64);
            c.prism_residual_openings = c.prism_residual_openings.saturating_add(residual as u64);
        });
        crate::telemetry_transaction::record(crate::telemetry_transaction::Event::PrismCut {
            committed: committed_ops as u64,
            residual: residual as u64,
        });
    }

    pub(crate) fn publish_defer(reason: usize) {
        DEFERS[reason].fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn publish_cut(committed: u64, residual: u64) {
        FIRES.fetch_add(1, Ordering::Relaxed);
        OPENINGS_ANALYTIC.fetch_add(committed, Ordering::Relaxed);
        OPENINGS_RESIDUAL.fetch_add(residual, Ordering::Relaxed);
    }

    /// Read + reset the per-reason defer counters as (name, count) pairs.
    pub fn take_prism_defers() -> Vec<(&'static str, u64)> {
        DEFER_NAMES
            .iter()
            .enumerate()
            .map(|(i, n)| (*n, DEFERS[i].swap(0, Ordering::Relaxed)))
            .collect()
    }

    /// Read + reset the prism-path telemetry: (hosts cut via the prism path,
    /// openings subtracted analytically, openings routed to the exact residual
    /// on prism-cut hosts). Process-global; the perf harness reports the
    /// fast-path hit-rate from it. Relaxed atomics — a stale read under
    /// concurrency only mis-reports a diagnostic count, never geometry.
    pub fn take_prism_stats() -> (u64, u64, u64) {
        (
            FIRES.swap(0, Ordering::Relaxed),
            OPENINGS_ANALYTIC.swap(0, Ordering::Relaxed),
            OPENINGS_RESIDUAL.swap(0, Ordering::Relaxed),
        )
    }
}

#[cfg(not(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry")))]
mod diag {
    #[inline]
    pub(super) fn defer(_i: usize) {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| c.prism_defers[_i] = c.prism_defers[_i].saturating_add(1));
    }
    #[inline]
    pub(super) fn record_cut(_committed_ops: usize, _residual: usize) {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            c.prism_candidate_successes = c.prism_candidate_successes.saturating_add(1);
            c.prism_candidate_openings = c.prism_candidate_openings.saturating_add(_committed_ops as u64);
            c.prism_residual_openings = c.prism_residual_openings.saturating_add(_residual as u64);
        });
    }
    /// Telemetry disabled in the default build; the perf harness must enable an
    /// observability feature to read real counts.
    pub fn take_prism_defers() -> Vec<(&'static str, u64)> {
        Vec::new()
    }
    pub fn take_prism_stats() -> (u64, u64, u64) {
        (0, 0, 0)
    }
}

use diag::{defer, record_cut};
#[cfg(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry"))]
pub(crate) use diag::{publish_cut, publish_defer};
pub use diag::{take_prism_defers, take_prism_stats};

// ─────────────────────────── small f64 vector kit ───────────────────────────
// Explicit component arithmetic (no nalgebra matrix products) so no FMA can
// sneak in and break native==wasm byte identity.

mod kit;
pub(super) use kit::*;
mod plane2;
use plane2::*;
mod ptri;
use ptri::*;
mod frame;
use frame::*;
mod profile;
use profile::*;
mod cap_extension;
use cap_extension::*;


// ─────────────────────────────── the prism cut ──────────────────────────────

/// Canonical-order edge×face-plane crossing cache. Both triangles sharing an
/// edge compute the crossing from the SAME endpoint order, so the point is
/// bit-identical on both sides — the T-junction-freedom cornerstone.
type CrossCache = FxHashMap<([u64; 3], [u64; 3], u16), V3>;

/// A seam sub-segment on a prism face: exact 3D endpoints plus their
/// face-local 2D coordinates.
struct Seam {
    a3: V3,
    b3: V3,
    a2: V2,
    b2: V2,
}

/// Plane of a face: (unit normal, offset) with the plane `{x : n·x = c}`.
fn face_plane(pf: &PrismFrame, face: Face) -> Option<(V3, f64)> {
    match face {
        Face::Cap { j } => Some((pf.d, pf.planes[j])),
        Face::Strip { k, i } => {
            let prof = &pf.profiles[k];
            let n = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % n];
            let e = [b[0] - a[0], b[1] - a[1]];
            let len = (e[0] * e[0] + e[1] * e[1]).sqrt();
            if len < 1.0e-9 {
                return None;
            }
            // Outward 2D normal of a CCW ring edge.
            let n2 = [e[1] / len, -e[0] / len];
            let n3 = add(scale(pf.u, n2[0]), scale(pf.v, n2[1]));
            let c = n2[0] * a[0] + n2[1] * a[1];
            Some((n3, c))
        }
    }
}

/// Intersection of segment (a, b) with face plane `f` (`{x: m·x = c}`),
/// computed in canonical endpoint order and cached. Endpoint-clamped crossings
/// return the endpoint EXACTLY (bit-equal), so they intern to the same pooled
/// vertex instead of a 1-ulp duplicate.
fn cached_crossing(cache: &mut CrossCache, f: u16, m: V3, c: f64, a: V3, b: V3) -> V3 {
    let (ka, kb) = (bits(a), bits(b));
    let (first, second, key) = if ka <= kb {
        (a, b, (ka, kb, f))
    } else {
        (b, a, (kb, ka, f))
    };
    if let Some(p) = cache.get(&key) {
        return *p;
    }
    let da = dot(first, m) - c;
    let db = dot(second, m) - c;
    let denom = da - db;
    let t = if denom.abs() < 1.0e-300 {
        0.5
    } else {
        (da / denom).clamp(0.0, 1.0)
    };
    let p = if t <= 0.0 {
        first
    } else if t >= 1.0 {
        second
    } else {
        lerp(first, second, t)
    };
    cache.insert(key, p);
    p
}

/// Face-local 2D coordinates of a 3D point.
fn face_coords(pf: &PrismFrame, face: Face, p: V3) -> V2 {
    match face {
        Face::Cap { .. } => pf.to2(p),
        Face::Strip { k, i } => {
            let prof = &pf.profiles[k];
            let n = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % n];
            let e = [b[0] - a[0], b[1] - a[1]];
            let len = (e[0] * e[0] + e[1] * e[1]).sqrt();
            let ed = [e[0] / len, e[1] / len];
            let q = pf.to2(p);
            [
                (q[0] - a[0]) * ed[0] + (q[1] - a[1]) * ed[1],
                dot(p, pf.d),
            ]
        }
    }
}

/// Subtract the stepped solid `pf` from the host triangle list. `Err(defer
/// index)` ⇒ a gate or self-check failed ⇒ the caller must leave the host
/// untouched and route this opening to the exact kernel.
fn cut_prism(tris: &[PTri], pf: &PrismFrame) -> Result<Vec<PTri>, usize> {
    let faces = stack_faces(pf);
    if faces.len() > u16::MAX as usize {
        return Err(7);
    }
    let mut planes: Vec<(V3, f64)> = Vec::with_capacity(faces.len());
    for &face in &faces {
        planes.push(face_plane(pf, face).ok_or(7usize)?);
    }

    let aabbs: Vec<(V3, V3)> = tris.iter().map(PTri::aabb).collect();
    let mut cache: CrossCache = CrossCache::default();

    let mut out: Vec<PTri> = Vec::with_capacity(tris.len() + 16);
    let mut inside: Vec<PTri> = Vec::new();
    let mut seams: Vec<Vec<Seam>> = (0..faces.len()).map(|_| Vec::new()).collect();
    let mut any_cut = false;

    for t in tris {
        // Quick reject: depth interval and 2D bbox versus the overall bbox.
        let w0 = dot(t.p[0], pf.d);
        let w1 = dot(t.p[1], pf.d);
        let w2 = dot(t.p[2], pf.d);
        if w0.max(w1).max(w2) < pf.d0() || w0.min(w1).min(w2) > pf.d1() {
            out.push(t.clone());
            continue;
        }
        {
            let q0 = pf.to2(t.p[0]);
            let q1 = pf.to2(t.p[1]);
            let q2 = pf.to2(t.p[2]);
            let lo = [q0[0].min(q1[0]).min(q2[0]), q0[1].min(q1[1]).min(q2[1])];
            let hi = [q0[0].max(q1[0]).max(q2[0]), q0[1].max(q1[1]).max(q2[1])];
            if hi[0] < pf.bb.0[0]
                || lo[0] > pf.bb.1[0]
                || hi[1] < pf.bb.0[1]
                || lo[1] > pf.bb.1[1]
            {
                out.push(t.clone());
                continue;
            }
        }

        // Gather T ∩ ∂solid seam sub-segments + T-edge subdivision points.
        let mut segs: Vec<(usize, V3, V3)> = Vec::new(); // (face idx, a3, b3)
        let mut edge_pts: [Vec<V3>; 3] = Default::default();
        for (fi, (&face, &(m, c))) in faces.iter().zip(&planes).enumerate() {
            // Chord of T with this face plane (strict >0 side test — symmetric
            // and vertex-exact, so neighbours agree bit-for-bit).
            let dist = [
                dot(t.p[0], m) - c,
                dot(t.p[1], m) - c,
                dot(t.p[2], m) - c,
            ];
            let mut chord: Vec<(V3, usize)> = Vec::new(); // (point, tri edge)
            for e in 0..3 {
                let (da, db) = (dist[e], dist[(e + 1) % 3]);
                if (da > 0.0) != (db > 0.0) {
                    let p = cached_crossing(
                        &mut cache,
                        fi as u16,
                        m,
                        c,
                        t.p[e],
                        t.p[(e + 1) % 3],
                    );
                    chord.push((p, e));
                }
            }
            if chord.len() != 2 {
                continue;
            }
            let (q0, e0) = chord[0];
            let (q1, e1) = chord[1];
            // Face-local membership gate + clipping of the chord to the face's
            // exposed region.
            match face {
                Face::Cap { j } => {
                    let a2 = pf.to2(q0);
                    let b2 = pf.to2(q1);
                    // T-edge subdivision membership (point-deterministic —
                    // both neighbours agree).
                    if cap_xor(pf, j, a2) {
                        edge_pts[e0].push(q0);
                    }
                    if cap_xor(pf, j, b2) {
                        edge_pts[e1].push(q1);
                    }
                    // Subdivide the 2D chord at crossings with BOTH adjacent
                    // profiles' edges; keep sub-segments inside the XOR region.
                    let mut ts: Vec<f64> = vec![0.0, 1.0];
                    for prof in [
                        (j > 0).then(|| &pf.profiles[j - 1]),
                        (j < pf.profiles.len()).then(|| &pf.profiles[j]),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        let npr = prof.len();
                        for i in 0..npr {
                            let (pa, pb) = (prof[i], prof[(i + 1) % npr]);
                            if let Some(tt) = seg_cross_param(a2, b2, pa, pb) {
                                ts.push(tt);
                            }
                        }
                    }
                    ts.sort_by(f64::total_cmp);
                    ts.dedup_by(|x, y| (*x - *y).abs() < 1.0e-12);
                    for wnd in ts.windows(2) {
                        let (ta, tb) = (wnd[0], wnd[1]);
                        if tb - ta < 1.0e-12 {
                            continue;
                        }
                        let mid = [
                            a2[0] + (b2[0] - a2[0]) * (ta + tb) * 0.5,
                            a2[1] + (b2[1] - a2[1]) * (ta + tb) * 0.5,
                        ];
                        if cap_xor(pf, j, mid) {
                            let sa = if ta == 0.0 { q0 } else { lerp(q0, q1, ta) };
                            let sb = if tb == 1.0 { q1 } else { lerp(q0, q1, tb) };
                            segs.push((fi, sa, sb));
                        }
                    }
                }
                Face::Strip { k, i } => {
                    let prof = &pf.profiles[k];
                    let npr = prof.len();
                    let a = prof[i];
                    let b = prof[(i + 1) % npr];
                    let e2 = [b[0] - a[0], b[1] - a[1]];
                    let len = (e2[0] * e2[0] + e2[1] * e2[1]).sqrt();
                    let ed = [e2[0] / len, e2[1] / len];
                    let (w_a, w_b) = (pf.planes[k], pf.planes[k + 1]);
                    let sparam = |p: V3| -> f64 {
                        let q = pf.to2(p);
                        (q[0] - a[0]) * ed[0] + (q[1] - a[1]) * ed[1]
                    };
                    let wparam = |p: V3| dot(p, pf.d);
                    let (s0, s1) = (sparam(q0), sparam(q1));
                    let (wc0, wc1) = (wparam(q0), wparam(q1));
                    // Membership gate for T-edge subdivision.
                    let in_strip =
                        |s: f64, w: f64| (0.0..=len).contains(&s) && (w_a..=w_b).contains(&w);
                    if in_strip(s0, wc0) {
                        edge_pts[e0].push(q0);
                    }
                    if in_strip(s1, wc1) {
                        edge_pts[e1].push(q1);
                    }
                    // τ interval on the chord where both params are in range.
                    let mut t_lo = 0.0f64;
                    let mut t_hi = 1.0f64;
                    for (p0, p1, lo, hi) in [(s0, s1, 0.0, len), (wc0, wc1, w_a, w_b)] {
                        let dp = p1 - p0;
                        if dp.abs() < 1.0e-15 {
                            if p0 < lo || p0 > hi {
                                t_lo = 1.0;
                                t_hi = 0.0;
                            }
                        } else {
                            let (mut ta, mut tb) = ((lo - p0) / dp, (hi - p0) / dp);
                            if ta > tb {
                                std::mem::swap(&mut ta, &mut tb);
                            }
                            t_lo = t_lo.max(ta);
                            t_hi = t_hi.min(tb);
                        }
                    }
                    if t_hi - t_lo > 1.0e-12 {
                        let sa = if t_lo == 0.0 { q0 } else { lerp(q0, q1, t_lo) };
                        let sb = if t_hi == 1.0 { q1 } else { lerp(q0, q1, t_hi) };
                        segs.push((fi, sa, sb));
                    }
                }
            }
        }

        if segs.is_empty() && edge_pts.iter().all(|v| v.is_empty()) {
            // No boundary reaches this triangle: it is wholly inside or wholly
            // outside the (open) solid.
            let centroid = scale(add(add(t.p[0], t.p[1]), t.p[2]), 1.0 / 3.0);
            if pf.contains(centroid) {
                inside.push(t.clone());
                any_cut = true;
            } else {
                out.push(t.clone());
            }
            continue;
        }

        // Conforming decomposition of T by the seam constraints.
        if !decompose_tri(t, pf, &faces, &segs, &edge_pts, &mut out, &mut inside, &mut seams) {
            return Err(7);
        }
        any_cut = true;
    }

    if !any_cut {
        return Err(4); // nothing to remove — a silent no-op belongs to the exact path
    }

    // Canonical per-cap-plane breakpoints: the vertices of both adjacent
    // profiles plus every proper crossing between their ring edges. Injected
    // into the cap AND every strip bordering that plane, so the faces sharing
    // a cutter-edge line subdivide it IDENTICALLY (T-junction freedom across
    // faces — the cap knows about profile corners the strip alone does not).
    let plane_pts: Vec<Vec<V2>> = (0..pf.planes.len())
        .map(|j| cap_plane_breakpoints(pf, j))
        .collect();

    // Caps: one CDT per face, constrained by that face's seams, classified by
    // ray parity against the PRE-CUT host.
    let mut caps: Vec<PTri> = Vec::new();
    for (fi, &face) in faces.iter().enumerate() {
        if !build_face_cap(pf, face, &seams[fi], &plane_pts, tris, &aabbs, &mut caps) {
            return Err(7);
        }
    }

    if !partition_consistent(tris, &out, &inside, &aabbs) {
        return Err(8);
    }
    if !has_measurable_region(&inside, &caps) {
        return Err(4);
    }

    // The inside fragments and caps are not independently closed surfaces.
    // Their divergence sums cannot measure removal (#4627). The extended
    // cutter volumes instead bound the final audited result in the driver.
    // The driver consolidates and audits the actual result before committing.
    out.append(&mut caps);
    Ok(out)
}

/// 2D point pool with tolerance merging: canonical 3D/normal = first-seen.
/// Merging kills the 1e-12 doublets a cutter-edge junction produces when two
/// faces' clips compute the same geometric point through different arithmetic.
struct PointPool {
    pts2: Vec<Point2<f64>>,
    pts3: Vec<V3>,
    nrm: Vec<V3>,
    buckets: FxHashMap<(i64, i64), Vec<usize>>,
    eps: f64,
}

impl PointPool {
    fn new(eps: f64) -> Self {
        Self {
            pts2: Vec::new(),
            pts3: Vec::new(),
            nrm: Vec::new(),
            buckets: FxHashMap::default(),
            eps: eps.max(1.0e-15),
        }
    }
    fn intern(&mut self, q: V2, p3: V3, n: V3) -> usize {
        let cell = |x: f64| (x / (self.eps * 4.0)).floor() as i64;
        let (cx, cy) = (cell(q[0]), cell(q[1]));
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(ids) = self.buckets.get(&(cx + dx, cy + dy)) {
                    for &i in ids {
                        let d0 = self.pts2[i].x - q[0];
                        let d1 = self.pts2[i].y - q[1];
                        if d0.abs() <= self.eps && d1.abs() <= self.eps {
                            return i;
                        }
                    }
                }
            }
        }
        let idx = self.pts2.len();
        self.pts2.push(Point2::new(q[0], q[1]));
        self.pts3.push(p3);
        self.nrm.push(n);
        self.buckets.entry((cx, cy)).or_default().push(idx);
        idx
    }
}

/// Decompose one host triangle by the cutter-boundary seams via a conforming
/// per-triangle CDT; classify each sub-triangle by its centroid; record the
/// seams (with face-local 2D coords) for the cap builder. Returns false when
/// the CDT cannot be built (→ exact kernel for the whole opening).
#[allow(clippy::too_many_arguments)]
fn decompose_tri(
    t: &PTri,
    pf: &PrismFrame,
    faces: &[Face],
    segs: &[(usize, V3, V3)],
    edge_pts: &[Vec<V3>; 3],
    out: &mut Vec<PTri>,
    inside: &mut Vec<PTri>,
    seams: &mut [Vec<Seam>],
) -> bool {
    // 2D basis in the triangle's plane (CCW = triangle winding).
    let Some(u) = normalize(sub(t.p[1], t.p[0])) else {
        out.push(t.clone());
        return true;
    };
    let Some(w) = normalize(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]))) else {
        out.push(t.clone());
        return true;
    };
    let v = cross(w, u);
    let to2 = |x: V3| -> V2 {
        let d = sub(x, t.p[0]);
        [dot(d, u), dot(d, v)]
    };

    let mut mag = 0.0f64;
    for p in &t.p {
        for c in p {
            mag = mag.max(c.abs());
        }
    }
    let mut pool = PointPool::new(1.0e-9 * (1.0 + mag));

    let tri_idx = [
        pool.intern(to2(t.p[0]), t.p[0], t.n[0]),
        pool.intern(to2(t.p[1]), t.p[1], t.n[1]),
        pool.intern(to2(t.p[2]), t.p[2], t.n[2]),
    ];

    let mut segments: Vec<(usize, usize)> = Vec::new();
    // T-edge chains subdivided at the admitted crossing points.
    for e in 0..3 {
        let a3 = t.p[e];
        let b3 = t.p[(e + 1) % 3];
        let dir = sub(b3, a3);
        let len2 = dot(dir, dir);
        if len2 <= 0.0 {
            continue;
        }
        let mut on_edge: Vec<(f64, usize)> = Vec::new();
        for p in &edge_pts[e] {
            // Normal interpolated along the edge.
            let tt = (dot(sub(*p, a3), dir) / len2).clamp(0.0, 1.0);
            let nn = lerp(t.n[e], t.n[(e + 1) % 3], tt);
            let idx = pool.intern(to2(*p), *p, nn);
            on_edge.push((tt, idx));
        }
        on_edge.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut prev = tri_idx[e];
        for &(_, idx) in &on_edge {
            if idx != prev {
                segments.push((prev, idx));
                prev = idx;
            }
        }
        let last = tri_idx[(e + 1) % 3];
        if last != prev {
            segments.push((prev, last));
        }
    }
    // Seam constraints (+ record for the cap builder). Interior seam points
    // carry the triangle's geometric normal (flat-facet hosts: exact).
    let face_n = normalize(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]))).unwrap_or(w);
    for &(fi, a3, b3) in segs {
        let ia = pool.intern(to2(a3), a3, face_n);
        let ib = pool.intern(to2(b3), b3, face_n);
        if ia == ib {
            continue;
        }
        segments.push((ia, ib));
        seams[fi].push(Seam {
            a3,
            b3,
            a2: face_coords(pf, faces[fi], a3),
            b2: face_coords(pf, faces[fi], b3),
        });
    }
    segments.sort();
    segments.dedup();
    let t0 = t.p[0];
    // `resolve_crossings` interns any new seam×seam / T-junction points with a
    // placeholder [0,0,1] normal. These points land on the RETAINED host
    // surface (`out`), so a Z-up placeholder on a non-horizontal face shades
    // wrong. Overwrite every point it created with the host triangle's own
    // face normal.
    let existing_points = pool.nrm.len();
    resolve_crossings(
        &mut pool,
        |q| add(t0, add(scale(u, q[0]), scale(v, q[1]))),
        &mut segments,
    );
    for n in pool.nrm.iter_mut().skip(existing_points) {
        *n = face_n;
    }

    let Some((pts2, idx2)) = triangulate_pslg(&pool.pts2, &segments) else {
        return false;
    };
    if pts2.len() != pool.pts2.len() {
        return false; // CDT must not invent points — mapping back requires identity
    }

    for tri in idx2.chunks_exact(3) {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        let p = [pool.pts3[a], pool.pts3[b], pool.pts3[c]];
        let centroid = scale(add(add(p[0], p[1]), p[2]), 1.0 / 3.0);
        let piece = PTri {
            p,
            n: [pool.nrm[a], pool.nrm[b], pool.nrm[c]],
        };
        if pf.contains(centroid) {
            inside.push(piece);
        } else {
            out.push(piece);
        }
    }
    true
}

/// Canonical 2D breakpoints of cap plane `j`: all vertices of the adjacent
/// slab profiles plus every proper pairwise crossing between the two rings.
fn cap_plane_breakpoints(pf: &PrismFrame, j: usize) -> Vec<V2> {
    let mut profs: Vec<&[V2]> = Vec::new();
    if j > 0 {
        profs.push(&pf.profiles[j - 1]);
    }
    if j < pf.profiles.len() {
        profs.push(&pf.profiles[j]);
    }
    let mut out: Vec<V2> = Vec::new();
    for prof in &profs {
        out.extend_from_slice(prof);
    }
    if profs.len() == 2 {
        let (a, b) = (profs[0], profs[1]);
        let (na, nb) = (a.len(), b.len());
        for i in 0..na {
            let (p, q) = (a[i], a[(i + 1) % na]);
            for k in 0..nb {
                let (c, d) = (b[k], b[(k + 1) % nb]);
                if let Some(t) = seg_cross_param(p, q, c, d) {
                    if (1.0e-9..=1.0 - 1.0e-9).contains(&t) {
                        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
                    }
                }
            }
        }
    }
    out
}

/// Build the cap (reveal face) for one cutter face: CDT of the face domain
/// constrained by the reveal seams (and, for a stepped cap, the adjacent
/// profiles' rings), each sub-triangle kept iff its centroid lies in the
/// face's exposed region AND inside the (pre-cut) host solid by ray parity.
/// Emitted oriented for the RESULT (normal pointing INTO the removed void).
/// Returns false on CDT failure.
fn build_face_cap(
    pf: &PrismFrame,
    face: Face,
    seams: &[Seam],
    plane_pts: &[Vec<V2>],
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
) -> bool {
    match face {
        Face::Strip { k, i } => {
            let prof = &pf.profiles[k];
            let npr = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % npr];
            let e2 = [b[0] - a[0], b[1] - a[1]];
            let len = (e2[0] * e2[0] + e2[1] * e2[1]).sqrt();
            if len < 1.0e-9 {
                return true;
            }
            let ed = [e2[0] / len, e2[1] / len];
            let (w_a, w_b) = (pf.planes[k], pf.planes[k + 1]);
            let lift_s =
                |s: f64, wd: f64| -> V3 { pf.lift(a[0] + ed[0] * s, a[1] + ed[1] * s, wd) };
            let ring2: Vec<V2> = vec![[0.0, w_a], [len, w_a], [len, w_b], [0.0, w_b]];
            let ring3: Vec<V3> = vec![
                lift_s(0.0, w_a),
                lift_s(len, w_a),
                lift_s(len, w_b),
                lift_s(0.0, w_b),
            ];
            // Outward 2D normal of the CCW ring edge; the result-cap normal is
            // its opposite (into the void). CCW-in-(s, w) lifts to the OUTWARD
            // strip normal ⇒ always flip.
            let n2 = [e2[1] / len, -e2[0] / len];
            let outward = add(scale(pf.u, n2[0]), scale(pf.v, n2[1]));
            let desired = scale(outward, -1.0);
            // Inject the canonical breakpoints of BOTH bounding cap planes
            // that lie on this strip's edge line, so the strip subdivides its
            // shared boundary exactly like the neighbouring caps do.
            let mut inject: Vec<(V2, V3)> = Vec::new();
            let on_line_tol = 1.0e-6 * (1.0 + pf.corner_mag());
            for (jj, wj) in [(k, w_a), (k + 1, w_b)] {
                for q in &plane_pts[jj] {
                    let ap = [q[0] - a[0], q[1] - a[1]];
                    let ss = ap[0] * ed[0] + ap[1] * ed[1];
                    if !(0.0..=len).contains(&ss) {
                        continue;
                    }
                    let perp = (ap[0] * ed[1] - ap[1] * ed[0]).abs();
                    if perp <= on_line_tol {
                        inject.push(([ss, wj], lift_s(ss, wj)));
                    }
                }
            }
            if seams.is_empty() && inject.is_empty() {
                // Entirely inside the host (whole-face reveal) or entirely
                // outside — one parity probe decides.
                let mid = |kk: usize| (ring3[0][kk] + ring3[2][kk]) * 0.5;
                if !point_inside(host, aabbs, [mid(0), mid(1), mid(2)]) {
                    return true;
                }
                emit_cap(caps, ring3[0], ring3[1], ring3[2], desired, true);
                emit_cap(caps, ring3[0], ring3[2], ring3[3], desired, true);
                return true;
            }
            if seams.is_empty() {
                // Injected points but no seams: same parity probe decides
                // whole-face vs nothing, but the emission must still be the
                // subdivided CDT so the shared boundary matches the caps.
                let mid = |kk: usize| (ring3[0][kk] + ring3[2][kk]) * 0.5;
                if !point_inside(host, aabbs, [mid(0), mid(1), mid(2)]) {
                    return true;
                }
            }
            cap_cdt(
                pf,
                &ring2,
                &ring3,
                &[],
                seams,
                &inject,
                desired,
                true,
                |q| pip(q, &ring2),
                host,
                aabbs,
                caps,
            )
        }
        Face::Cap { j } => {
            let wdepth = pf.planes[j];
            // Domain ring: the union bbox of the adjacent profiles, slightly
            // inflated so profile rings are strictly interior constraints.
            let mut lo = [f64::INFINITY; 2];
            let mut hi = [f64::NEG_INFINITY; 2];
            let mut aux: Vec<&[V2]> = Vec::new();
            if j > 0 {
                aux.push(&pf.profiles[j - 1]);
            }
            if j < pf.profiles.len() {
                aux.push(&pf.profiles[j]);
            }
            for prof in &aux {
                for p in prof.iter() {
                    for k in 0..2 {
                        lo[k] = lo[k].min(p[k]);
                        hi[k] = hi[k].max(p[k]);
                    }
                }
            }
            let m = 1.0e-3 * (1.0 + (hi[0] - lo[0]).abs().max((hi[1] - lo[1]).abs()));
            let (lo, hi) = ([lo[0] - m, lo[1] - m], [hi[0] + m, hi[1] + m]);
            let ring2: Vec<V2> = vec![
                [lo[0], lo[1]],
                [hi[0], lo[1]],
                [hi[0], hi[1]],
                [lo[0], hi[1]],
            ];
            let ring3: Vec<V3> = ring2
                .iter()
                .map(|&[uu, vv]| pf.lift(uu, vv, wdepth))
                .collect();
            // Orientation per sub-region: where only the LOWER slab exists the
            // removed void is below ⇒ normal −d; where only the UPPER slab
            // exists ⇒ +d. Resolved per emitted triangle inside `cap_cdt` via
            // the classifier below; the `desired`/flip passed in cover the
            // "+d" branch and the emitter flips for the −d case.
            let in_lower = |q: V2| j > 0 && pip(q, &pf.profiles[j - 1]);
            let in_upper = |q: V2| j < pf.profiles.len() && pip(q, &pf.profiles[j]);
            // Fast skip for the OUTERMOST caps with no seams (the common
            // extended-cap case): probe the adjacent slab interior.
            if seams.is_empty() && (j == 0 || j == pf.profiles.len()) {
                let k = if j == 0 { 0 } else { pf.profiles.len() - 1 };
                let interior = pf.slab_interior[k];
                let probe = pf.lift(interior[0], interior[1], wdepth);
                if !point_inside(host, aabbs, probe) {
                    return true;
                }
            }
            let inject: Vec<(V2, V3)> = plane_pts[j]
                .iter()
                .map(|&q| (q, pf.lift(q[0], q[1], wdepth)))
                .collect();
            cap_cdt_xor(
                pf,
                &ring2,
                &ring3,
                &aux,
                seams,
                &inject,
                wdepth,
                in_lower,
                in_upper,
                host,
                aabbs,
                caps,
            )
        }
    }
}

/// Emit one cap triangle with the RESULT orientation: `flip` swaps the winding
/// so the geometric normal matches `desired`.
fn emit_cap(caps: &mut Vec<PTri>, a: V3, b: V3, c: V3, desired: V3, flip: bool) {
    let (b, c) = if flip { (c, b) } else { (b, c) };
    caps.push(PTri {
        p: [a, b, c],
        n: [desired, desired, desired],
    });
}

/// Shared cap CDT for a SINGLE-region face (side strips): domain ring +
/// seams, keep = `region(centroid)` && host parity.
#[allow(clippy::too_many_arguments)]
fn cap_cdt(
    pf: &PrismFrame,
    ring2: &[V2],
    ring3: &[V3],
    aux: &[&[V2]],
    seams: &[Seam],
    inject: &[(V2, V3)],
    desired: V3,
    flip: bool,
    region: impl Fn(V2) -> bool,
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
) -> bool {
    cap_cdt_impl(pf, ring2, ring3, aux, seams, inject, host, aabbs, caps, |q| {
        region(q).then_some((desired, flip))
    })
}

/// Cap CDT for a stepped cap plane: keep = XOR of the adjacent profiles, with
/// per-region orientation (−d where only the lower slab exists, +d where only
/// the upper does).
#[allow(clippy::too_many_arguments)]
fn cap_cdt_xor(
    pf: &PrismFrame,
    ring2: &[V2],
    ring3: &[V3],
    aux: &[&[V2]],
    seams: &[Seam],
    inject: &[(V2, V3)],
    _wdepth: f64,
    in_lower: impl Fn(V2) -> bool,
    in_upper: impl Fn(V2) -> bool,
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
) -> bool {
    let d = pf.d;
    cap_cdt_impl(pf, ring2, ring3, aux, seams, inject, host, aabbs, caps, move |q| {
        let lo = in_lower(q);
        let up = in_upper(q);
        if lo == up {
            return None; // outside the exposed XOR region
        }
        if lo {
            // Cutter below the plane ⇒ solid above ⇒ normal −d. CCW-in-(u,v)
            // lifts to +d ⇒ flip.
            Some((scale(d, -1.0), true))
        } else {
            Some((d, false))
        }
    })
}


/// Make a segment soup CDT-admissible: split every pair of properly-crossing
/// constraints at their intersection (interned through `lift3`), and split
/// every constraint at any pooled point lying strictly in its interior.
/// Needed because adjacent slab profiles of a rebated opening genuinely CROSS
/// (a sill / lintel detail poking past the other slab's outline), and seam
/// endpoints can land in the interior of a ring edge.
fn resolve_crossings(
    pool: &mut PointPool,
    lift3: impl Fn(V2) -> V3,
    segs: &mut Vec<(usize, usize)>,
) {
    let orig = segs.clone();
    let mut splits: Vec<Vec<(f64, usize)>> = vec![Vec::new(); orig.len()];
    // Pairwise proper crossings on the ORIGINAL segments (sub-segment
    // crossings are a subset, so one pass suffices).
    for i in 0..orig.len() {
        for j in (i + 1)..orig.len() {
            let (a, b) = orig[i];
            let (c, d) = orig[j];
            if a == c || a == d || b == c || b == d {
                continue;
            }
            let pa = [pool.pts2[a].x, pool.pts2[a].y];
            let pb = [pool.pts2[b].x, pool.pts2[b].y];
            let pc = [pool.pts2[c].x, pool.pts2[c].y];
            let pd = [pool.pts2[d].x, pool.pts2[d].y];
            let r = [pb[0] - pa[0], pb[1] - pa[1]];
            let sv = [pd[0] - pc[0], pd[1] - pc[1]];
            let den = r[0] * sv[1] - r[1] * sv[0];
            if den.abs() < 1.0e-18 {
                continue;
            }
            let ap = [pc[0] - pa[0], pc[1] - pa[1]];
            let t = (ap[0] * sv[1] - ap[1] * sv[0]) / den;
            let u = (ap[0] * r[1] - ap[1] * r[0]) / den;
            const E: f64 = 1.0e-9;
            if !(E..=1.0 - E).contains(&t) || !(E..=1.0 - E).contains(&u) {
                continue;
            }
            let q = [pa[0] + r[0] * t, pa[1] + r[1] * t];
            let idx = pool.intern(q, lift3(q), [0.0, 0.0, 1.0]);
            splits[i].push((t, idx));
            splits[j].push((u, idx));
        }
    }
    // Pooled points strictly interior to a segment (T-junctions).
    let n_pts = pool.pts2.len();
    for k in 0..n_pts {
        let p = [pool.pts2[k].x, pool.pts2[k].y];
        for (i, &(a, b)) in orig.iter().enumerate() {
            if a == k || b == k {
                continue;
            }
            let pa = [pool.pts2[a].x, pool.pts2[a].y];
            let pb = [pool.pts2[b].x, pool.pts2[b].y];
            let e = [pb[0] - pa[0], pb[1] - pa[1]];
            let len2 = e[0] * e[0] + e[1] * e[1];
            if len2 < 1.0e-18 {
                continue;
            }
            let t = ((p[0] - pa[0]) * e[0] + (p[1] - pa[1]) * e[1]) / len2;
            if !(1.0e-9..=1.0 - 1.0e-9).contains(&t) {
                continue;
            }
            let perp = ((p[0] - pa[0]) * e[1] - (p[1] - pa[1]) * e[0]).abs() / len2.sqrt();
            if perp <= pool.eps * 4.0 {
                splits[i].push((t, k));
            }
        }
    }
    let mut out: Vec<(usize, usize)> = Vec::with_capacity(orig.len() + 8);
    for (i, &(a, b)) in orig.iter().enumerate() {
        if splits[i].is_empty() {
            out.push((a, b));
            continue;
        }
        let mut sp = std::mem::take(&mut splits[i]);
        sp.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut prev = a;
        for &(_, idx) in &sp {
            if idx != prev {
                out.push((prev, idx));
                prev = idx;
            }
        }
        if prev != b {
            out.push((prev, b));
        }
    }
    out.sort();
    out.dedup();
    *segs = out;
}

/// The cap CDT core: pool the ring, aux-profile rings and seams; chain every
/// straight constraint through the pooled points lying on it; run the
/// conforming CDT; classify each sub-triangle by `classify(centroid)` (which
/// returns the emit orientation) && host parity.
#[allow(clippy::too_many_arguments)]
fn cap_cdt_impl(
    pf: &PrismFrame,
    ring2: &[V2],
    ring3: &[V3],
    aux: &[&[V2]],
    seams: &[Seam],
    inject: &[(V2, V3)],
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
    classify: impl Fn(V2) -> Option<(V3, bool)>,
) -> bool {
    let snap_eps = 1.0e-9 * (1.0 + pf.corner_mag());
    let mut pool = PointPool::new(snap_eps);
    let placeholder_n = [0.0, 0.0, 1.0];
    let ring_idx: Vec<usize> = ring2
        .iter()
        .zip(ring3)
        .map(|(&q, &p3)| pool.intern(q, p3, placeholder_n))
        .collect();
    // Aux profile rings (cap planes only): 2D verts lifted on the face plane.
    // Their 3D lift shares the plane depth of ring3[0] along d.
    let wdepth = dot(ring3[0], pf.d);
    let mut aux_idx: Vec<Vec<usize>> = Vec::new();
    for prof in aux {
        aux_idx.push(
            prof.iter()
                .map(|&[uu, vv]| pool.intern([uu, vv], pf.lift(uu, vv, wdepth), placeholder_n))
                .collect(),
        );
    }
    // Canonical shared-boundary breakpoints (pooled so the chains below pick
    // them up — the cross-face T-junction freedom).
    for &(q, p3) in inject {
        pool.intern(q, p3, placeholder_n);
    }
    let mut seam_segs: Vec<(usize, usize)> = Vec::new();
    for s in seams {
        let ia = pool.intern(s.a2, s.a3, placeholder_n);
        let ib = pool.intern(s.b2, s.b3, placeholder_n);
        if ia != ib {
            seam_segs.push((ia, ib));
        }
    }
    // Chain every straight constraint (ring edges + aux profile edges) through
    // the pooled points lying on it, so seam endpoints subdivide them and the
    // CDT stays conforming.
    let n_pool = pool.pts2.len();
    let mut seg_list: Vec<(usize, usize)> = seam_segs;
    let chain = |ia: usize, ib: usize, seg_list: &mut Vec<(usize, usize)>| {
        let a = [pool.pts2[ia].x, pool.pts2[ia].y];
        let b = [pool.pts2[ib].x, pool.pts2[ib].y];
        let eb = [b[0] - a[0], b[1] - a[1]];
        let len2 = eb[0] * eb[0] + eb[1] * eb[1];
        if len2 < 1.0e-18 {
            return;
        }
        let edge_tol = snap_eps * 4.0;
        let mut on_edge: Vec<(f64, usize)> = Vec::new();
        for i in 0..n_pool {
            if i == ia || i == ib {
                continue;
            }
            let p = [pool.pts2[i].x, pool.pts2[i].y];
            let ap = [p[0] - a[0], p[1] - a[1]];
            let tt = (ap[0] * eb[0] + ap[1] * eb[1]) / len2;
            if !(0.0..=1.0).contains(&tt) {
                continue;
            }
            let perp = (ap[0] * eb[1] - ap[1] * eb[0]).abs() / len2.sqrt();
            if perp <= edge_tol {
                on_edge.push((tt, i));
            }
        }
        on_edge.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut prev = ia;
        for &(_, i) in &on_edge {
            if i != prev {
                seg_list.push((prev, i));
                prev = i;
            }
        }
        if prev != ib {
            seg_list.push((prev, ib));
        }
    };
    let nr = ring_idx.len();
    for e in 0..nr {
        chain(ring_idx[e], ring_idx[(e + 1) % nr], &mut seg_list);
    }
    for ridx in &aux_idx {
        let n = ridx.len();
        for e in 0..n {
            chain(ridx[e], ridx[(e + 1) % n], &mut seg_list);
        }
    }
    seg_list.sort();
    seg_list.dedup();
    resolve_crossings(&mut pool, |q| pf.lift(q[0], q[1], wdepth), &mut seg_list);

    let Some((pts2, idx2)) = triangulate_pslg(&pool.pts2, &seg_list) else {
        return false;
    };
    if pts2.len() != pool.pts2.len() {
        return false;
    }
    for tri in idx2.chunks_exact(3) {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        let cu = (pts2[a].x + pts2[b].x + pts2[c].x) / 3.0;
        let cv = (pts2[a].y + pts2[b].y + pts2[c].y) / 3.0;
        let Some((desired, flip)) = classify([cu, cv]) else {
            continue;
        };
        // Lift the centroid to 3D for the host-parity test.
        let c3 = scale(
            add(add(pool.pts3[a], pool.pts3[b]), pool.pts3[c]),
            1.0 / 3.0,
        );
        if point_inside(host, aabbs, c3) {
            let (pa, pb, pc) = (pool.pts3[a], pool.pts3[b], pool.pts3[c]);
            emit_cap(caps, pa, pb, pc, desired, flip);
        }
    }
    true
}

// ─────────────────────────────── the driver ─────────────────────────────────

impl Execution {
    /// Try the analytic prism subtraction on `mesh`.
    ///
    /// Iterates the merged openings in order; each opening whose cutter is a
    /// clean prism AND whose cut passes every self-check is subtracted
    /// analytically; every other opening lands in the returned residual
    /// context (cut by the exact kernel on the analytic result — the caller
    /// recurses through [`Execution::apply_void_context`], mirroring the
    /// 2D path's residual composition). `None` ⇒ no opening was cut and the
    /// caller must run the FULL original context through the exact kernel.
    pub(super) fn try_prism_cut(
        &self,
        mesh: &Mesh,
        ctx: &VoidContext,
    ) -> Option<(Mesh, Option<VoidContext>)> {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| c.prism_attempts = c.prism_attempts.saturating_add(1));
        if ctx.merged_openings.is_empty() || mesh.is_empty() || mesh.indices.len() < 12 {
            return None;
        }
        // Promote to the f64 triangle list FIRST: `ptris_from_mesh` bounds-checks
        // every index, whereas the closure audits index `mesh.positions` straight
        // from `mesh.indices`. Auditing first would PANIC (abort under
        // panic=abort) on a malformed host index instead of recording
        // `host_promote_fail` and deferring. Post-promotion all indices are valid.
        let origin = mesh.origin;
        let Some(mut tris) = ptris_from_mesh(mesh) else {
            defer(1);
            return None;
        };
        // The volume identity, the parity classification, and the closed
        // self-check are only meaningful on a host that arrives as a
        // consistently-wound closed solid (hairline subdivision mismatches
        // tolerated — tessellated hosts routinely carry them).
        if !closed_enough_to_emit(mesh) {
            defer(0);
            return None;
        }
        let min_vol = min_opening_volume(self.tessellation_quality);

        // ── Candidate prisms ────────────────────────────────────────────────
        // Extract a prism per opening, then MERGE prisms whose union is one
        // prism (the wall-leaf half-void pattern: two abutting halves of one
        // window — cutting the union in one pass sidesteps their coplanar
        // interface). Openings without a prism become AABB "blockers".
        struct Cand {
            pf: PrismFrame,
            ops: Vec<usize>, // indices into ctx.merged_openings
        }
        let mut cands: Vec<Cand> = Vec::new();
        let mut blockers: Vec<([V3; 3], V3, V3)> = Vec::new();
        let mut residual_idx: Vec<usize> = Vec::new();
        for (i, op) in ctx.merged_openings.iter().enumerate() {
            match prepare_prism(op, mesh) {
                Some(pf) => cands.push(Cand { pf, ops: vec![i] }),
                None => {
                    defer(2);
                    residual_idx.push(i);
                    if let Some(blk) = opening_aabb_obb(op, origin) {
                        blockers.push(blk);
                    }
                }
            }
        }
        // Profile-equality fusion must weld on NUMERICAL coincidence, not a 2 mm
        // geometric slack: at 2 mm two genuinely distinct leaf profiles could be
        // declared equal and fused, silently collapsing a real slab boundary. Use
        // the same 8·SNAP_GRID weld the depth-concatenation gate already uses.
        const PROFILE_FUSE_TOL: f64 = 8.0 * crate::kernel::mesh_bridge::SNAP_GRID;
        loop {
            let mut merged_pair: Option<(usize, usize, PrismFrame)> = None;
            'search: for i in 0..cands.len() {
                for j in (i + 1)..cands.len() {
                    if let Some(m) = try_merge_prisms(&cands[i].pf, &cands[j].pf, PROFILE_FUSE_TOL) {
                        merged_pair = Some((i, j, m));
                        break 'search;
                    }
                }
            }
            let Some((i, j, m)) = merged_pair else { break };
            let mut absorbed = cands.remove(j);
            cands[i].pf = m;
            cands[i].ops.append(&mut absorbed.ops);
        }
        // Overlap vetoes, decided BEFORE any cut so an abutting-but-unmergeable
        // pair is never half-cut (cutting one against the other's flush caps —
        // here or in the residual exact pass — is the coplanar minefield the
        // exact kernel owns). 1 mm margin, matching the batch pad.
        let mut vetoed = vec![false; cands.len()];
        for i in 0..cands.len() {
            let obb_i = cands[i].pf.obb();
            for (j, cj) in cands.iter().enumerate().skip(i + 1) {
                if obb_overlaps(&obb_i, &cj.pf.obb(), 1.0e-3) {
                    vetoed[i] = true;
                    vetoed[j] = true;
                }
            }
            if blockers.iter().any(|b| obb_overlaps(&obb_i, b, 1.0e-3)) {
                vetoed[i] = true;
            }
        }

        // ── Sequential analytic cuts ────────────────────────────────────────
        let mut committed_ops = 0usize;
        let mut committed_cutter_volume = 0.0;
        // AABB (host-local frame) of every COMMITTED cutter prism, captured
        // post-extension: the region the cut actually re-triangulated. Feeds the
        // scoped sliver refinement below (#1007 targets rim slivers, not the
        // host's own authored long-thin faces). 1 mm pad = the batch/veto margin,
        // comfortably covering the seam vertices shared with kept host fragments.
        const REFINE_REGION_PAD: f64 = 1.0e-3;
        let mut refine_boxes: Vec<([f64; 3], [f64; 3])> = Vec::new();
        for (cand, veto) in cands.iter().zip(&vetoed) {
            crate::progress::tick();
            let mut ok = false;
            if *veto {
                defer(6);
            } else if cand.pf.volume() < min_vol {
                // Tiny cutters keep the exact path's (identical) skip
                // semantics.
                defer(3);
            } else {
                let mut pf = cand.pf.clone();
                // Host projection intervals on the prism axes: no-overlap ⇒
                // silent no-op (the exact path owns that diagnostic); engulf ⇒
                // the exact path owns the redundant-void machinery (#964,
                // #635).
                let axes = [pf.u, pf.v, pf.d];
                let mut hlo = [f64::INFINITY; 3];
                let mut hhi = [f64::NEG_INFINITY; 3];
                for t in &tris {
                    for p in &t.p {
                        for k in 0..3 {
                            let s = dot(*p, axes[k]);
                            hlo[k] = hlo[k].min(s);
                            hhi[k] = hhi[k].max(s);
                        }
                    }
                }
                let plo = [pf.bb.0[0], pf.bb.0[1], pf.d0()];
                let phi = [pf.bb.1[0], pf.bb.1[1], pf.d1()];
                let overlap = (0..3).all(|k| phi[k] > hlo[k] && plo[k] < hhi[k]);
                if !overlap {
                    defer(4);
                } else {
                    let aabbs: Vec<(V3, V3)> = tris.iter().map(PTri::aabb).collect();
                    extend_prism_caps(&mut pf, &tris, &aabbs);
                    extend_profile_edges(&mut pf, &tris, &aabbs);
                    let plo = [pf.bb.0[0], pf.bb.0[1], pf.d0()];
                    let phi = [pf.bb.1[0], pf.bb.1[1], pf.d1()];
                    let engulfs = aabb_engulfs(plo, phi, hlo, hhi, ENGULF_TOLERANCE);
                    if engulfs {
                        defer(5);
                    } else {
                        match cut_prism(&tris, &pf) {
                            Ok(outcome) => {
                                committed_cutter_volume += pf.volume();
                                tris = outcome;
                                committed_ops += cand.ops.len();
                                ok = true;
                                // Committed-cutter AABB (extended pf): lift the
                                // 4 profile-bb corners at both depth planes.
                                let mut lo = [f64::INFINITY; 3];
                                let mut hi = [f64::NEG_INFINITY; 3];
                                for &uu in &[pf.bb.0[0], pf.bb.1[0]] {
                                    for &vv in &[pf.bb.0[1], pf.bb.1[1]] {
                                        for &w in &[pf.d0(), pf.d1()] {
                                            let p = pf.lift(uu, vv, w);
                                            for k in 0..3 {
                                                lo[k] = lo[k].min(p[k]);
                                                hi[k] = hi[k].max(p[k]);
                                            }
                                        }
                                    }
                                }
                                refine_boxes.push((
                                    [
                                        lo[0] - REFINE_REGION_PAD,
                                        lo[1] - REFINE_REGION_PAD,
                                        lo[2] - REFINE_REGION_PAD,
                                    ],
                                    [
                                        hi[0] + REFINE_REGION_PAD,
                                        hi[1] + REFINE_REGION_PAD,
                                        hi[2] + REFINE_REGION_PAD,
                                    ],
                                ));
                            }
                            Err(reason) => defer(reason),
                        }
                    }
                }
            }
            if !ok {
                residual_idx.extend(cand.ops.iter().copied());
            }
        }
        if committed_ops == 0 {
            return None;
        }

        let mut out = mesh_from_ptris(&tris, mesh);
        // Merge the per-triangle CDT fragments and cap scaffolding with the
        // same coplanar consolidation the exact kernel and rect/param fast
        // paths apply (i_overlay union per plane bucket + CDT re-triangulation,
        // watertight-preserving), collapsing each planar face back to a few
        // large triangles — 2-3x fewer output triangles on the advanced_model
        // walls, matching the exact kernel's tessellation density.
        let consolidated = crate::csg::ClippingProcessor::consolidate_prism_cut(out, mesh);
        let boundary = consolidated.boundary;
        out = consolidated.mesh;
        let consolidated_closure = ClosureVerdict::for_mesh(&out);
        if consolidated_closure.closed_enough_to_emit()
            && !consolidated_change_is_measurable(mesh, &out)
        {
            defer(4);
            return None;
        }
        // WATERTIGHT SLIVER REFINEMENT (#1007): the per-triangle CDT can emit a
        // high-aspect corner sliver at an opening rim (a far-corner triangle
        // fanned to two rim vertices) — the visible roof-slope chamfer the
        // exact path also produces and repairs. Run the SAME lockstep-bisection
        // pass the exact kernel output gets (targets aspect <= 8:1, watertight
        // by construction), so the analytic cut meets the same rim-quality bar.
        // The pass fixes one edge per internal round (64 max); the analytic
        // cut can carry more rim fans than that, so drive it to a (bounded)
        // fixpoint — each iteration is a no-op clone once no sliver remains.
        // SELF-CHECKED application, and ONLY when this cut is FINAL (no
        // residual): with a residual, the exact kernel still cuts this mesh and
        // runs its own sliver refinement on ITS output — refining first would
        // hand the arrangement midpoint-split geometry it re-fragments (#1167).
        // On a hairline-tolerated output the lockstep split can also see just
        // one side of an overlapping chain pair and amplify the sub-grid
        // mismatch, and the split slivers can fall below the clean-degenerate
        // grid — so accept the refined mesh only when it is STRICTLY closed
        // and a cleaned probe stays at least hairline-closed.
        if residual_idx.is_empty() && consolidated_closure.is_directed_closed() {
            // SCOPED to the committed cutters' padded AABBs: #1007's target is
            // the high-aspect corner sliver the CUT emits at an opening rim, and
            // every rim-incident sliver touches its cutter's box. The unscoped
            // pass also bisected the host's own authored long-thin faces (a thin
            // steel wall is legitimately full of >8:1 quads), inflating output
            // triangles and paying the full lockstep fixpoint on every
            // analytic-cut host (the Holter 4.1.x regression).
            //
            // Refine straight off `out` first: the scoped pass returns the input
            // unchanged when no in-region sliver fires (the common clean-cut
            // case), and for a NO-OP fixpoint `refined == out` byte-for-byte, so
            // the upfront clone, the probe clean, and the closure audits decided
            // nothing. Only a fixpoint that actually split an edge pays the
            // probe + self-check audits. Same 6-refine budget as before
            // (1 here + up to 5 below). This refinement is not a replacement
            // for the router's source-triangle cleanup and does not promise
            // hygienic output. The probe informs acceptance; `finish_cut`
            // closure-audits and prefers a clean result, but may return its
            // explicit compatibility result (#4797).
            let mut refined =
                crate::facet_weld::refine_high_aspect_slivers_within(&out, &refine_boxes);
            if refined.indices.len() != out.indices.len() {
                for _ in 0..5 {
                    let next =
                        crate::facet_weld::refine_high_aspect_slivers_within(&refined, &refine_boxes);
                    if next.indices.len() == refined.indices.len() {
                        break;
                    }
                    refined = next;
                }
                let mut probe = refined.clone();
                probe.clean_degenerate();
                if finish::can_adopt_refinement(boundary, &refined, &probe) {
                    out = refined;
                }
            }
        }
        // The finalizer cleans before the ulp weld so discarded slivers cannot
        // choose a surviving seam coordinate, then audits the exact mesh it
        // returns. A closed pre-clean result remains the compatibility fallback.
        let Some((finished, directed)) = finish_cut_verdict(out, mesh, boundary) else {
            defer(9);
            return None;
        };
        out = finished;
        // A host stored relative to a per-element origin can keep hairline
        // seams its world-frame twin does not (#5739): its weld is sized by the
        // small stored coordinates. Close them when that leaves the cut
        // strictly closed, else keep it. World-frame cuts are untouched.
        if mesh.origin != [0.0; 3] && !directed {
            let closed = tjunction_close::close_seams(&out, mesh);
            out = finish::adopt_seam_closure(out, closed, boundary);
        }

        // Residual openings in their original classification order.
        residual_idx.sort_unstable();
        let residual: Vec<CutterKind> = residual_idx
            .iter()
            .map(|&i| ctx.merged_openings[i].clone())
            .collect();

        if !result_volume_within_bounds(mesh, &out, committed_cutter_volume) {
            defer(8);
            return None;
        }
        record_cut(committed_ops, residual.len());

        let residual_ctx = if residual.is_empty() {
            None
        } else {
            Some(VoidContext {
                openings: residual.clone(),
                merged_openings: residual,
                param: None,
                bool2d: None,
            })
        };
        Some((out, residual_ctx))
    }
}
