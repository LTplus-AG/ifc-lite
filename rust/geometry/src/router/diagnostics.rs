// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Diagnostics / telemetry layer: opening-classification + host-opening + CSG
//! failure accumulators drained by the wasm bindings and tests.

use super::GeometryRouter;
use crate::BoolFailure;
#[cfg(test)]
use rustc_hash::FxHashMap;

pub(crate) use super::diagnostics_recording::ClassificationKind;
pub use super::diagnostics_recording::{
    ClassificationStats, HostOpeningDiagnostic, OpeningDiagnostic, OpeningKindDiag,
};

impl GeometryRouter {
    /// Internal: tag the per-host diagnostic with the failure summary for
    /// this host. Drained from `ClippingProcessor::take_failures` after
    /// `apply_void_context` finishes.
    ///
    /// Kept here (rather than alongside the rest of the recording API in
    /// `diagnostics_recording.rs`) because its `BoolFailureReason` match is
    /// the part of this file most likely to need a new arm alongside a new
    /// failure reason — keeping it next to `HostOpeningDiagnostic` above
    /// avoids that touching two files.
    pub(crate) fn record_host_failure_summary(&self, host_id: u32, failures: &[BoolFailure]) {
        if failures.is_empty() {
            return;
        }
        if let Some(unchanged) = self.unchanged_rectangular_cuts.borrow_mut().get_mut(&host_id) {
            *unchanged = false;
        }
        let mut log = self.host_opening_diagnostics.borrow_mut();
        let entry = log.entry(host_id).or_default();
        entry.csg_failure_count += failures.len();
        if entry.first_failure_label.is_none() {
            // Short label for at-a-glance grouping, from the ONE home shared
            // with the wasm console + native tracing summaries; a second copy
            // of this match lived here, held in lockstep by prose alone.
            let label = failures[0].reason.label();
            entry.first_failure_label = Some(label.to_string());
        }
    }
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
    /// SKIPPED WHEN `None`, like the two fields below. The TypeScript mirrors
    /// declare these as `field?: T`, which means the key is ABSENT; a plain
    /// `Option` writes an explicit `null` through `serde_json` (the server
    /// response path), and a consumer that guards with `!== undefined` then
    /// throws on it. `serde_wasm_bindgen` writes `None` as `undefined`, so the
    /// wasm boundary hid the difference. Deserialization is unaffected: a
    /// missing key and an explicit `null` both read back as `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_failure_label: Option<String>,
    /// World-space AABB of the host mesh, when captured by
    /// `record_host_cut_effect` (opt-in per-product detail, #C1). `None` when
    /// no void cut touched this host (e.g. the failure came from a
    /// non-router CSG path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<HostBbox>,
    /// Final triangle count of the host's mesh: post-cut (`tris_after`) when a
    /// void subtraction ran, falling back to the pre-cut count
    /// (`tris_before`) when it didn't (the un-cut host is what actually
    /// renders in that case). `None` when neither was captured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triangle_count: Option<u64>,
}

/// Compatibility handshake for the [`GeometryDiagnostics`] contract, serialized
/// as `schemaVersion`. DISTINCT from the viewer cache `FORMAT_VERSION` (an
/// invalidation token): this is a promise consumers can gate on.
///
/// Bump discipline: bump on any field rename, field removal, or
/// count-semantics change. Also bump when a field is additive but its absence
/// is otherwise indistinguishable from a real zero, so consumers have
/// something to gate on (`#[serde(default)]` deserializes both cases to 0).
/// A purely additive optional field that no consumer gates on does NOT bump.
///
/// Changelog:
/// - 1: initial versioned contract (the #1439 shape; a deserialized 0 means a
///   pre-versioned producer).
/// - 2: removed the permanently-dead `guard_saved` signal — every producer
///   passed `false`, so `OpeningDiagnostic.guard_saved` and the
///   `floor_opening_guard_saved` counter were always 0. Field removal, not
///   just a rename, hence the bump.
/// - 3: added `total_unsupported_items` / `unsupported_items_by_type` (previously uncounted drops).
/// - 4: total_unsupported_items / unsupported_items_by_type also count openings whose id does not decode or whose body fails/meshes empty (ROUTER-37, #8385).
/// - 5: work-budget refusals carry budget, demand and product/source identity separately from unsupported items.
/// - 6: silent_no_ops uses measured area and volume instead of equal triangle counts (#10510).
pub const GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION: u32 = MEASURED_CUT_SCHEMA_VERSION;

const LEGACY_CUT_SCHEMA_VERSION: u32 = 5;
const MEASURED_CUT_SCHEMA_VERSION: u32 = 6;

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
    /// Hosts where rectangular cutters ran clean and left the area and volume
    /// unchanged within tolerance (v6 onward). Earlier producers used equal triangle counts.
    pub silent_no_ops: u64,
    /// rect_fast fast-path engagement.
    pub rect_fast: RectFastSummary,
    /// Bounded top-N worst-failing hosts (opt-in per-product detail).
    pub worst_hosts: Vec<WorstHost>,
    /// Refs the content-hash pass refused (`u32::MAX`, #3421/#3752). Additive.
    #[serde(default)]
    pub oversized_ref_drops: u64,
    /// Items dropped: no processor, or the processor errored. Additive.
    ///
    /// Counted once per `IfcRepresentationMap` source PER ROUTER, not once per
    /// `IfcMappedItem` occurrence. That is a model-wide "once" on the wasm path,
    /// which walks a whole batch with one router. It is NOT model-wide on the
    /// native pool: `process_entity_job` builds a fresh router per element, and a
    /// source whose items all drop is refused by the shared mapped-item cache
    /// (empty meshes are never published), so every element that instantiates it
    /// walks it again and contributes its own count. Read the number as a lower
    /// bound on affected types, never as a count of distinct sources or elements.
    ///
    /// Also counts an opening that cut nothing because its own body failed or
    /// meshed empty (keyed by the opening's type) or its id did not decode
    /// (keyed `IfcFeatureElementSubtraction`), once per opening per router
    /// (ROUTER-37, since schema version 4).
    #[serde(default)]
    pub total_unsupported_items: u64,
    /// [`Self::total_unsupported_items`] broken down by IFC type, count-desc.
    #[serde(default)]
    pub unsupported_items_by_type: Vec<ReasonCount>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub budget_refusals: Vec<BudgetRefusal>,
    /// Complete count; budget_refusals contains at most sixteen details.
    #[serde(default)]
    pub total_budget_refusals: u64,
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
            oversized_ref_drops: 0,
            total_unsupported_items: 0,
            unsupported_items_by_type: Vec::new(),
            budget_refusals: Vec::new(),
            total_budget_refusals: 0,
        }
    }
}

impl GeometryDiagnostics {
    /// Attach the measured rectangular cut count and advertise its compatibility version.
    pub fn with_measured_silent_no_ops(mut self, count: u64) -> Self {
        self.schema_version = GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION;
        self.silent_no_ops = count;
        self
    }

    /// Whether this producer measured area and volume for the silent no-op count.
    pub fn has_measured_silent_no_ops(&self) -> bool {
        self.schema_version >= MEASURED_CUT_SCHEMA_VERSION
    }

    /// Whether any CSG failure, silent no-op, or dropped item was recorded.
    pub fn has_issues(&self) -> bool {
        self.total_budget_refusals > 0 || !self.budget_refusals.is_empty() || self.total_csg_failures > 0 || self.silent_no_ops > 0 || self.total_unsupported_items > 0
    }

    /// Whether nothing diagnostic-worthy happened this pass — no openings
    /// classified, no failures, no silent no-ops, no rect_fast activity. Callers
    /// skip attaching an all-zero object so a consumer can gate on presence
    /// (`if event.diagnostics`) as well as on counts.
    pub fn is_empty(&self) -> bool {
        self.total_budget_refusals == 0 && self.budget_refusals.is_empty()
            && self.total_csg_failures == 0
            && self.hosts_with_openings == 0
            && self.classification.total == 0
            && self.silent_no_ops == 0
            && self.rect_fast.fired == 0
            && self.oversized_ref_drops == 0
            && self.total_unsupported_items == 0
    }
}

mod aggregate;
pub use aggregate::aggregate_diagnostics;

mod budget;
pub use budget::BudgetRefusal;
pub(crate) use budget::BudgetProductIdentity;
mod attribution;
mod processor_failures;
mod unsupported_items;
pub use unsupported_items::format_unsupported_breakdown;
pub(crate) use unsupported_items::UnsupportedItemState;

#[cfg(test)]
mod unsupported_items_tests;

pub use attribution::{count_attributed_products, UNATTRIBUTED_PRODUCT_ID};

#[cfg(test)]
mod diagnostics_contract_tests;
