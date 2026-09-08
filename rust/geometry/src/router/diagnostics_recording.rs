// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `GeometryRouter` diagnostics-recording API — the accumulator TYPES plus
//! most of the accumulator methods (`take_*` / `record_*` / `push_*`) that
//! write into and drain the per-router CSG-failure, layer-slice,
//! void-consumption, classification, host-opening and rect_fast
//! accumulators declared on [`super::GeometryRouter`].
//!
//! Split out of `diagnostics.rs` (which keeps the wasm-free
//! [`super::diagnostics::aggregate_diagnostics`] public contract and
//! `record_host_failure_summary`) to stay under the module-size ratchet
//! budget.

use super::diagnostics::{count_attributed_products, UNATTRIBUTED_PRODUCT_ID};
use super::GeometryRouter;
use crate::BoolFailure;
use rustc_hash::FxHashMap;

/// Counts of opening classification outcomes during the most recent
/// geometry pass. Useful for confirming whether the host-aware
/// floor-opening classifier guard (commit `1e033f8`) is taking effect on
/// a given model.
#[derive(Debug, Default, Clone, Copy)]
pub struct ClassificationStats {
    /// Openings classified as `Rectangular` — fast AABB clip path.
    pub rectangular: usize,
    /// Openings classified as `DiagonalRectangular` — rotated AABB.
    pub diagonal: usize,
    /// Openings classified as `NonRectangular` — full CSG path
    /// (no operand cap on the exact kernel).
    pub non_rectangular: usize,
}

/// Per-host opening diagnostic captured during void processing.
///
/// Populated incrementally: `classify_openings` fills in `host_type` and
/// the per-opening classification list; `apply_void_context` adds the
/// CSG failure tally drained from the kernel. Surfaced through
/// [`GeometryRouter::take_host_opening_diagnostics`] for the WASM
/// bindings to forward to JS.
#[derive(Debug, Clone, Default)]
pub struct HostOpeningDiagnostic {
    /// Stringified IFC type of the host (e.g. `"IfcWallStandardCase"`).
    pub host_type: String,
    /// Per-opening classification record.
    pub openings: Vec<OpeningDiagnostic>,
    /// Number of `BoolFailure` records the kernel emitted while
    /// processing this host's voids.
    pub csg_failure_count: usize,
    /// First `BoolFailure` reason recorded for this host, as a short
    /// string label. Useful for grouping at a glance.
    pub first_failure_label: Option<String>,
    /// Triangle count of the host's mesh BEFORE void subtraction.
    /// `None` until `apply_void_context` runs (or doesn't, if there
    /// were no openings to apply).
    pub tris_before: Option<usize>,
    /// Triangle count AFTER void subtraction. Compare with
    /// `tris_before` to spot "cuts attempted, no effect" cases — the
    /// classic silent-no-op signature when an opening box doesn't
    /// actually intersect the host mesh.
    pub tris_after: Option<usize>,
    /// Number of axis-aligned rectangular openings synthesised into penetrating
    /// box cutters and subtracted (exactly) for this host. Compare against
    /// `tris_before == tris_after` to detect the "ran cuts, geometry unchanged"
    /// silent-no-op.
    pub rect_boxes_processed: usize,
    /// Bounding box of the host mesh (min, max) in world coords. Useful
    /// for confirming that an opening box should overlap.
    pub host_bounds: Option<((f32, f32, f32), (f32, f32, f32))>,
}

/// One opening's worth of diagnostic data — what `classify_openings`
/// observed about it.
#[derive(Debug, Clone)]
pub struct OpeningDiagnostic {
    /// Express ID of the `IfcOpeningElement` itself.
    pub opening_id: u32,
    /// Branch the classifier took for this opening.
    pub kind: OpeningKindDiag,
    /// Vertex count of the opening's mesh — high counts (>100) force the
    /// non-rectangular path regardless of extrusion direction.
    pub vertex_count: usize,
}

/// Discriminator for [`OpeningDiagnostic::kind`]. Mirrors `OpeningType`
/// without dragging the geometry data along.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpeningKindDiag {
    Rectangular,
    Diagonal,
    NonRectangular,
}

impl OpeningKindDiag {
    pub fn as_str(self) -> &'static str {
        match self {
            OpeningKindDiag::Rectangular => "Rectangular",
            OpeningKindDiag::Diagonal => "Diagonal",
            OpeningKindDiag::NonRectangular => "NonRectangular",
        }
    }
}

impl GeometryRouter {
    /// Drain every boolean / CSG failure this router knows about since it was
    /// created (or the last `take_csg_failures` call). The single drain point:
    /// the native pipeline and the wasm batch path both call this and nothing
    /// else.
    ///
    /// Two kinds of record come out, distinguished by their key:
    ///
    ///  * Keyed by IFC product express id — the void-subtraction path
    ///    (multi-layer wall sub-meshes, single-mesh `apply_voids_to_mesh`),
    ///    which knows the host element whose opening / clip tripped a fallback.
    ///  * Keyed by [`UNATTRIBUTED_PRODUCT_ID`] — the registered processors' own
    ///    logs (swept by [`Self::drain_processor_failures`], #3821, including
    ///    what the transient boolean under an `IfcCsgSolid` hands back to
    ///    `CsgSolidProcessor`) and the producer-less hatch. Standalone
    ///    `IfcBooleanResult` chains DO flow here now; what they still lack is
    ///    the owning product id. See `drain_processor_failures` for the cost.
    pub fn take_csg_failures(&self) -> FxHashMap<u32, Vec<BoolFailure>> {
        // Sweep the processors' own logs, then fold in any failures from a
        // context with no router handle at all (`PENDING_MAPPED_BOOL_FAILURES`,
        // which has no producer today). Neither carries a product attribution,
        // so both land in the unattributed bucket, not a fake host id.
        self.drain_processor_failures();
        let pending = crate::diagnostics::take_pending_mapped_bool_failures();
        if !pending.is_empty() {
            self.csg_failures
                .borrow_mut()
                .entry(UNATTRIBUTED_PRODUCT_ID)
                .or_default()
                .extend(pending);
        }
        std::mem::take(&mut *self.csg_failures.borrow_mut())
    }

    /// Record why a layered-wall slice attempt did/didn't produce per-layer
    /// sub-meshes (#563 diagnostic). Bounded — only sliceable elements reach it.
    pub(crate) fn push_layer_slice_diag(&self, element_id: u32, reason: &'static str) {
        self.layer_slice_diag.borrow_mut().push((element_id, reason));
    }

    /// Drain the per-element layered-slice diagnostics gathered since the last
    /// call (wasm logs them to the browser console after each batch).
    pub fn take_layer_slice_diag(&self) -> Vec<(u32, &'static str)> {
        std::mem::take(&mut *self.layer_slice_diag.borrow_mut())
    }

    /// Products with at least one recorded CSG failure, under the same
    /// [`count_attributed_products`] rule the pipelines' scalar uses (a bare
    /// `.len()` would make this the one surface counting the synthetic
    /// bucket). PEEKS: no processor sweep, unlike `take_csg_failures`.
    pub fn csg_failure_product_count(&self) -> usize {
        count_attributed_products(&self.csg_failures.borrow()) as usize
    }

    /// Total CSG failures, INCLUDING the unattributed bucket (real failures,
    /// unknown owner). Peeks, like [`Self::csg_failure_product_count`].
    pub fn csg_failure_total(&self) -> usize {
        self.csg_failures.borrow().values().map(|v| v.len()).sum()
    }

    /// Internal: mark a host product as fully consumed by a containing void, so
    /// the element pipeline does NOT fall back to the un-cut host when the void
    /// subtraction yields an empty mesh. See [`Self::host_consumed_by_void`].
    pub(crate) fn record_void_consumed_host(&self, product_id: u32) {
        self.voids_consumed_hosts.borrow_mut().insert(product_id);
    }

    /// Whether a host product was fully consumed by a containing void (its
    /// opening's real solid engulfs the host). An empty void-cut result for
    /// such a host is CORRECT — the element should render nothing — and must
    /// not trigger the un-cut fallback.
    pub fn host_consumed_by_void(&self, product_id: u32) -> bool {
        self.voids_consumed_hosts.borrow().contains(&product_id)
    }

    /// Internal: record a batch of failures against a product. Existing
    /// entries for the same product are appended to.
    pub(crate) fn record_csg_failures(&self, product_id: u32, failures: Vec<BoolFailure>) {
        if failures.is_empty() {
            return;
        }
        let attributed: Vec<BoolFailure> = failures
            .into_iter()
            .map(|f| f.with_product_id(product_id))
            .collect();
        self.csg_failures
            .borrow_mut()
            .entry(product_id)
            .or_default()
            .extend(attributed);
    }

    /// Drain and return the cumulative opening-classification counters
    /// since the router was created (or the last `take_classification_stats`
    /// call). The internal counters are reset to zero.
    pub fn take_classification_stats(&self) -> ClassificationStats {
        std::mem::take(&mut *self.classification_stats.borrow_mut())
    }

    /// Drain and return the per-host opening diagnostic map.
    pub fn take_host_opening_diagnostics(&self) -> FxHashMap<u32, HostOpeningDiagnostic> {
        std::mem::take(&mut *self.host_opening_diagnostics.borrow_mut())
    }

    /// Accumulate one rect_fast cut's counters into THIS router (request-local).
    /// Called from the void-cut fast paths instead of a process-global sink, so
    /// concurrent native geometry passes never steal each other's counters.
    pub(crate) fn record_rect_fast(&self, s: &crate::rect_fast::RectFastStats) {
        let mut acc = self.rect_fast_stats.borrow_mut();
        acc.fired += s.fired;
        acc.openings_cut += s.openings_cut;
        acc.defer_host_not_box += s.defer_host_not_box;
        acc.defer_not_through += s.defer_not_through;
        acc.defer_off_face += s.defer_off_face;
        acc.defer_near_edge += s.defer_near_edge;
        acc.defer_no_openings += s.defer_no_openings;
        acc.defer_too_many_openings += s.defer_too_many_openings;
    }

    /// Drain and return this router's rect_fast counters (resets them to zero).
    pub fn take_rect_fast_stats(&self) -> crate::rect_fast::RectFastStats {
        std::mem::take(&mut *self.rect_fast_stats.borrow_mut())
    }

    /// Total number of hosts with diagnostic records (mostly for tests).
    pub fn host_opening_diagnostic_count(&self) -> usize {
        self.host_opening_diagnostics.borrow().len()
    }

    /// Internal: bump the classification stats. Called from
    /// `classify_openings` for each opening it processes.
    pub(crate) fn bump_classification(&self, kind: ClassificationKind) {
        let mut s = self.classification_stats.borrow_mut();
        match kind {
            ClassificationKind::Rectangular => s.rectangular += 1,
            ClassificationKind::Diagonal => s.diagonal += 1,
            ClassificationKind::NonRectangular => s.non_rectangular += 1,
        }
    }

    /// Internal: record / merge per-host opening diagnostic. Called from
    /// `classify_openings` once per host with the host type + the list of
    /// openings it observed. `apply_void_context` later adds the CSG
    /// failure tally for the same host.
    pub(crate) fn record_host_opening_diagnostic(
        &self,
        host_id: u32,
        host_type: &str,
        openings: Vec<OpeningDiagnostic>,
    ) {
        let mut log = self.host_opening_diagnostics.borrow_mut();
        let entry = log.entry(host_id).or_default();
        if entry.host_type.is_empty() {
            entry.host_type = host_type.to_string();
        }
        entry.openings.extend(openings);
    }

    /// Internal: tag the per-host diagnostic with the cut-effect data
    /// (triangle counts before/after, rectangular boxes processed, host
    /// bounds). Lets callers spot the "rectangular cut attempted but
    /// produced no change" case — the silent-no-op signature when an
    /// opening box's geometry doesn't actually intersect the host mesh
    /// despite passing the AABB classifier.
    pub(crate) fn record_host_cut_effect(
        &self,
        host_id: u32,
        tris_before: usize,
        tris_after: usize,
        rect_boxes_processed: usize,
        host_bounds: ((f32, f32, f32), (f32, f32, f32)),
    ) {
        let mut log = self.host_opening_diagnostics.borrow_mut();
        let entry = log.entry(host_id).or_default();
        entry.tris_before = Some(tris_before);
        entry.tris_after = Some(tris_after);
        entry.rect_boxes_processed = rect_boxes_processed;
        entry.host_bounds = Some(host_bounds);
    }

}

/// Internal classification-branch tag for `bump_classification`. Mirrors
/// the variants of `OpeningType`.
#[derive(Debug, Clone, Copy)]
pub(crate) enum ClassificationKind {
    Rectangular,
    Diagonal,
    NonRectangular,
}
