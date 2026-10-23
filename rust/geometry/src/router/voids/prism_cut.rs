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
mod driver;

