// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Diagnostics / telemetry layer: opening-classification + host-opening + CSG
//! failure accumulators drained by the wasm bindings and tests.

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
    /// Drain the boolean / CSG failures accumulated by the void-subtraction
    /// path since the router was created (or the last `take_csg_failures`
    /// call). Failures are keyed by IFC product express ID — the element
    /// whose opening / clip operation tripped a fallback.
    ///
    /// Only the router-driven CSG path (multi-layer wall sub-meshes,
    /// single-mesh `apply_voids_to_mesh`) is currently attributed. Standalone
    /// `IfcBooleanResult` chains processed via the mapped-item path don't
    /// yet flow their failures here.
    pub fn take_csg_failures(&self) -> FxHashMap<u32, Vec<BoolFailure>> {
        // Fold in any failures from a context without a direct router handle
        // (see `PENDING_MAPPED_BOOL_FAILURES`). They have no product
        // attribution, so we bucket them under product id 0 — keeps the
        // diagnostics surface visible without inventing a fake host id.
        let pending = crate::diagnostics::take_pending_mapped_bool_failures();
        if !pending.is_empty() {
            self.csg_failures
                .borrow_mut()
                .entry(0)
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

    /// Number of products with at least one recorded CSG failure.
    pub fn csg_failure_product_count(&self) -> usize {
        self.csg_failures.borrow().len()
    }

    /// Total number of CSG failures across all products.
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

    /// Internal: tag the per-host diagnostic with the failure summary for
    /// this host. Drained from `ClippingProcessor::take_failures` after
    /// `apply_void_context` finishes.
    pub(crate) fn record_host_failure_summary(&self, host_id: u32, failures: &[BoolFailure]) {
        if failures.is_empty() {
            return;
        }
        let mut log = self.host_opening_diagnostics.borrow_mut();
        let entry = log.entry(host_id).or_default();
        entry.csg_failure_count += failures.len();
        if entry.first_failure_label.is_none() {
            // Short label for at-a-glance grouping. Full BoolFailure list
            // remains in `csg_failures` for callers that want detail.
            let label = match &failures[0].reason {
                crate::diagnostics::BoolFailureReason::OperandTooLarge { .. } => "OperandTooLarge",
                crate::diagnostics::BoolFailureReason::EmptyOperand => "EmptyOperand",
                crate::diagnostics::BoolFailureReason::DegenerateOperand => "DegenerateOperand",
                crate::diagnostics::BoolFailureReason::NoBoundsOverlap => "NoBoundsOverlap",
                crate::diagnostics::BoolFailureReason::KernelOutputInvalid => "KernelOutputInvalid",
                crate::diagnostics::BoolFailureReason::SolidSolidDifferenceSkipped => {
                    "SolidSolidDifferenceSkipped"
                }
                crate::diagnostics::BoolFailureReason::PolygonalBoundedHalfSpaceFallback => {
                    "PolygonalBoundedHalfSpaceFallback"
                }
                crate::diagnostics::BoolFailureReason::CutterUnionUnavailable => {
                    "CutterUnionUnavailable"
                }
                crate::diagnostics::BoolFailureReason::UnknownBooleanOperator(_) => {
                    "UnknownBooleanOperator"
                }
                crate::diagnostics::BoolFailureReason::ManifoldOutputDegenerate { .. } => {
                    "ManifoldOutputDegenerate"
                }
                crate::diagnostics::BoolFailureReason::KernelError(_) => "KernelError",
                crate::diagnostics::BoolFailureReason::DifferenceEmptiedHost => {
                    "DifferenceEmptiedHost"
                }
            };
            entry.first_failure_label = Some(label.to_string());
        }
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

// ───────────────────────── Public diagnostics contract ─────────────────────
// A serializable, wasm-free aggregate of the CSG / opening diagnostics computed
// during a geometry pass. Built by `aggregate_diagnostics` from drained router
// data. Today it is wired on the wasm/viewer path (the @ifc-lite/geometry
// `complete` event); native / server `ProcessingStats` parity reuses this same
// wasm-free aggregator and is a follow-up. camelCase JSON for the TS contract.

/// Opening-classifier outcome counts (rectangular / diagonal / non-rectangular).
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationSummary {
    pub rectangular: u64,
    pub diagonal: u64,
    pub non_rectangular: u64,
    pub total: u64,
}

/// One CSG failure reason and its occurrence count this pass. `reason` is one of
/// the stable [`crate::diagnostics::BoolFailureReason::label`] strings.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasonCount {
    pub reason: String,
    pub count: u64,
}

/// rect_fast fast-path engagement counters (perf observability).
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectFastSummary {
    pub fired: u64,
    pub openings_cut: u64,
    pub defer_host_not_box: u64,
    pub defer_not_through: u64,
    pub defer_off_face: u64,
    pub defer_near_edge: u64,
    pub defer_no_openings: u64,
    pub defer_too_many_openings: u64,
}

/// Axis-aligned bounding box of a worst-failing host's mesh, world coords
/// (post void-subtraction when a cut ran). Mirrors the `{min, max}` shape the
/// rest of the geometry contract already uses for AABBs (see
/// `packages/geometry/src/types.ts` `MeshData.localBounds`), so TS consumers
/// don't need a second bbox convention.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBbox {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

/// One of the worst-failing host elements (bounded top-N, opt-in detail).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorstHost {
    pub product_id: u32,
    pub ifc_type: String,
    pub openings: u64,
    pub csg_failures: u64,
    pub first_failure_label: Option<String>,
    /// World-space AABB of the host mesh, when captured by
    /// `record_host_cut_effect` (opt-in per-product detail, #C1). `None` when
    /// no void cut touched this host (e.g. the failure came from a
    /// non-router CSG path).
    pub bbox: Option<HostBbox>,
    /// Final triangle count of the host's mesh: post-cut (`tris_after`) when a
    /// void subtraction ran, falling back to the pre-cut count
    /// (`tris_before`) when it didn't (the un-cut host is what actually
    /// renders in that case). `None` when neither was captured.
    pub triangle_count: Option<u64>,
}

/// Compatibility handshake for the [`GeometryDiagnostics`] contract, serialized
/// as `schemaVersion`. DISTINCT from the viewer cache `FORMAT_VERSION` (an
/// invalidation token): this is a promise consumers can gate on.
///
/// Bump discipline: bump on any field rename, field removal, or
/// count-semantics change; additive optional fields do NOT bump.
///
/// Changelog:
/// - 1: initial versioned contract (the #1439 shape; a deserialized 0 means a
///   pre-versioned producer).
/// - 2: removed the permanently-dead `guard_saved` signal — every producer
///   passed `false`, so `OpeningDiagnostic.guard_saved` and the
///   `floor_opening_guard_saved` counter were always 0. Field removal, not
///   just a rename, hence the bump.
pub const GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION: u32 = 2;

/// Aggregate CSG / opening diagnostics for one geometry pass — the public
/// diagnostics contract. Built by [`aggregate_diagnostics`] from drained router
/// data and serialized to the @ifc-lite/geometry `complete` event, and reused
/// verbatim by the native `ProcessingStats` path
/// (`rust/processing/src/processor/mod.rs` populates `geometry_diagnostics`).
/// wasm-free (serde only).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryDiagnostics {
    /// Contract version ([`GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION`]); serialized
    /// unconditionally so consumers can gate on it. Deserializes to 0 when the
    /// producer predates versioning.
    #[serde(default)]
    pub schema_version: u32,
    /// Total CSG boolean failures (un-cut openings, emptied hosts, fallbacks).
    pub total_csg_failures: u64,
    /// Distinct products (host elements) with at least one failure.
    pub products_with_failures: u64,
    /// Hosts that had openings processed.
    pub hosts_with_openings: u64,
    /// Opening-classifier outcome counts.
    pub classification: ClassificationSummary,
    /// Failure counts by stable reason label, sorted desc by count.
    pub failures_by_reason: Vec<ReasonCount>,
    /// Hosts where rectangular cutters ran but the triangle count was unchanged
    /// (cut attempted, geometry not modified) — the highest-signal "looks wrong
    /// but did not error" indicator.
    pub silent_no_ops: u64,
    /// rect_fast fast-path engagement.
    pub rect_fast: RectFastSummary,
    /// Bounded top-N worst-failing hosts (opt-in per-product detail).
    pub worst_hosts: Vec<WorstHost>,
}

impl Default for GeometryDiagnostics {
    fn default() -> Self {
        Self {
            schema_version: GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION,
            total_csg_failures: 0,
            products_with_failures: 0,
            hosts_with_openings: 0,
            classification: ClassificationSummary::default(),
            failures_by_reason: Vec::new(),
            silent_no_ops: 0,
            rect_fast: RectFastSummary::default(),
            worst_hosts: Vec::new(),
        }
    }
}

impl GeometryDiagnostics {
    /// Whether any CSG failure or silent no-op was recorded — a cheap gate for
    /// "should this be surfaced to the user".
    pub fn has_issues(&self) -> bool {
        self.total_csg_failures > 0 || self.silent_no_ops > 0
    }

    /// Whether nothing diagnostic-worthy happened this pass — no openings
    /// classified, no failures, no silent no-ops, no rect_fast activity. Callers
    /// skip attaching an all-zero object so a consumer can gate on presence
    /// (`if event.diagnostics`) as well as on counts.
    pub fn is_empty(&self) -> bool {
        self.total_csg_failures == 0
            && self.hosts_with_openings == 0
            && self.classification.total == 0
            && self.silent_no_ops == 0
            && self.rect_fast.fired == 0
    }
}

/// Build a [`GeometryDiagnostics`] from drained router data. wasm-free so both
/// the wasm/viewer path and a future native path can produce the same contract.
/// The caller owns draining: the router accessors are destructive (`mem::take`),
/// so drain once and pass the results here — do not double-`take`.
pub fn aggregate_diagnostics(
    classification: ClassificationStats,
    csg_failures: &FxHashMap<u32, Vec<BoolFailure>>,
    host_diags: &FxHashMap<u32, HostOpeningDiagnostic>,
    rect_fast: crate::rect_fast::RectFastStats,
    worst_hosts_limit: usize,
) -> GeometryDiagnostics {
    let total_csg_failures = csg_failures.values().map(Vec::len).sum::<usize>() as u64;
    let products_with_failures = csg_failures.len() as u64;
    let hosts_with_openings = host_diags.len() as u64;

    let classification = ClassificationSummary {
        rectangular: classification.rectangular as u64,
        diagonal: classification.diagonal as u64,
        non_rectangular: classification.non_rectangular as u64,
        total: (classification.rectangular
            + classification.diagonal
            + classification.non_rectangular) as u64,
    };

    let mut by_reason: FxHashMap<&'static str, u64> = FxHashMap::default();
    for fails in csg_failures.values() {
        for f in fails {
            *by_reason.entry(f.reason.label()).or_insert(0) += 1;
        }
    }
    let mut failures_by_reason: Vec<ReasonCount> = by_reason
        .into_iter()
        .map(|(reason, count)| ReasonCount { reason: reason.to_string(), count })
        .collect();
    failures_by_reason
        .sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.reason.cmp(&b.reason)));

    let silent_no_ops = host_diags
        .values()
        .filter(|hd| {
            // A TRUE silent no-op: rect cutters ran, the triangle count was
            // unchanged, AND the kernel recorded no failure. A host that already
            // failed is a loud failure, not a silent one — excluding it keeps this
            // the precise "ran clean but produced no change" signal (so it is not
            // double-reported alongside total_csg_failures).
            matches!((hd.tris_before, hd.tris_after), (Some(b), Some(a)) if b == a)
                && hd.rect_boxes_processed > 0
                && hd.csg_failure_count == 0
        })
        .count() as u64;

    let mut worst: Vec<(&u32, &HostOpeningDiagnostic)> = host_diags
        .iter()
        .filter(|(_, hd)| hd.csg_failure_count > 0)
        .collect();
    worst.sort_by(|a, b| {
        b.1.csg_failure_count.cmp(&a.1.csg_failure_count).then_with(|| a.0.cmp(b.0))
    });
    let worst_hosts: Vec<WorstHost> = worst
        .into_iter()
        .take(worst_hosts_limit)
        .map(|(pid, hd)| WorstHost {
            product_id: *pid,
            ifc_type: hd.host_type.clone(),
            openings: hd.openings.len() as u64,
            csg_failures: hd.csg_failure_count as u64,
            first_failure_label: hd.first_failure_label.clone(),
            bbox: hd.host_bounds.map(|(min, max)| HostBbox {
                min: [min.0, min.1, min.2],
                max: [max.0, max.1, max.2],
            }),
            triangle_count: hd.tris_after.or(hd.tris_before).map(|t| t as u64),
        })
        .collect();

    GeometryDiagnostics {
        schema_version: GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION,
        total_csg_failures,
        products_with_failures,
        hosts_with_openings,
        classification,
        failures_by_reason,
        silent_no_ops,
        rect_fast: RectFastSummary {
            fired: rect_fast.fired,
            openings_cut: rect_fast.openings_cut,
            defer_host_not_box: rect_fast.defer_host_not_box,
            defer_not_through: rect_fast.defer_not_through,
            defer_off_face: rect_fast.defer_off_face,
            defer_near_edge: rect_fast.defer_near_edge,
            defer_no_openings: rect_fast.defer_no_openings,
            defer_too_many_openings: rect_fast.defer_too_many_openings,
        },
        worst_hosts,
    }
}

#[cfg(test)]
mod diagnostics_contract_tests;
