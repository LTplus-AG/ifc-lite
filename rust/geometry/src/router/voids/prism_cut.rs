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
mod cut;
use cut::*;
mod decompose;
use decompose::*;
mod caps;
use caps::*;
mod crossings;
use crossings::*;
mod cap_cdt;
use cap_cdt::*;

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
