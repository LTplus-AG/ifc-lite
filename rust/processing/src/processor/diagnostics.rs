// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The native pass's diagnostic sinks and the collation that turns them into
//! the `GeometryDiagnostics` contract.
//!
//! Split out of `processor/mod.rs`: the seven request-local collectors and the
//! `collate_diagnostics` body are one subject with one lifetime (declared
//! together, filled by every job, drained together at the end), and keeping
//! them in the pipeline function is what pushed that file past its module-size
//! budget when #3691's counter was added. Bundling them also collapses seven
//! `process_entity_job` parameters into one, which is the same subject seen
//! from the job side.

use rustc_hash::FxHashMap;

/// Every request-local diagnostic sink for one native geometry pass.
///
/// Request-local, not process-global: each is filled from this pass's own
/// per-job routers and drained here, so two concurrent in-process passes never
/// cross-contaminate. Drained from the per-job router rather than inside
/// `produce_element_meshes`, because the WASM batch path shares that function
/// and drains from its own warm router at batch end -- draining there would
/// empty it.
pub(super) struct DiagnosticCollectors {
    /// Per-job router CSG diagnostics (parity with the wasm path's
    /// `drain_and_log_csg_diagnostics`).
    pub(super) csg_failures: std::sync::Mutex<FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>>,
    /// Opening classification + per-host opening diagnostics.
    pub(super) classification: std::sync::Mutex<ifc_lite_geometry::ClassificationStats>,
    pub(super) host_diags:
        std::sync::Mutex<FxHashMap<u32, ifc_lite_geometry::HostOpeningDiagnostic>>,
    /// rect_fast engagement, drained per-job router so this pass's `rectFast`
    /// is isolated from any concurrent geometry pass.
    pub(super) rect_fast: std::sync::Mutex<ifc_lite_geometry::RectFastStats>,
    /// Dropped representation items by IFC type: no processor for the type, or
    /// the processor errored. Non-empty means the model has elements whose
    /// geometry the router refused to build.
    pub(super) unsupported_items: std::sync::Mutex<FxHashMap<String, u64>>,
    /// Degenerate-backstop drop tally; non-zero means the f32-collapse safety
    /// net engaged for this model.
    pub(super) backstop: std::sync::atomic::AtomicU64,
    /// Content-hash refs refused above `u32::MAX` (#3421/#3752).
    pub(super) oversized_ref_drops: std::sync::atomic::AtomicU64,
    /// Elements whose geometry read a record refused by input admission
    /// (#7678, D3's refused-element counter).
    pub(super) refused_input: std::sync::atomic::AtomicU64,
}

impl DiagnosticCollectors {
    pub(super) fn new() -> Self {
        Self {
            csg_failures: std::sync::Mutex::new(FxHashMap::default()),
            classification: std::sync::Mutex::new(ifc_lite_geometry::ClassificationStats::default()),
            host_diags: std::sync::Mutex::new(FxHashMap::default()),
            rect_fast: std::sync::Mutex::new(ifc_lite_geometry::RectFastStats::default()),
            unsupported_items: std::sync::Mutex::new(FxHashMap::default()),
            backstop: std::sync::atomic::AtomicU64::new(0),
            oversized_ref_drops: std::sync::atomic::AtomicU64::new(0),
            refused_input: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// The per-job end of the pass: this job router's unsupported items, and
    /// D3's refused-element count for this job's decoder (#7678).
    pub(super) fn drain_job(&self, router: &ifc_lite_geometry::GeometryRouter, decoder: &ifc_lite_core::EntityDecoder) {
        drain_unsupported_items(router, &self.unsupported_items);
        self.note_refused_input(decoder);
    }

    /// D3's refused-element counter (#7678): an element whose geometry read
    /// any record refused by input admission counts once. Call once per job,
    /// with that job's own decoder.
    pub(super) fn note_refused_input(&self, decoder: &ifc_lite_core::EntityDecoder) {
        if decoder.refused_records() > 0 {
            self.refused_input.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

/// A refused length unit (#7678, `UnitScales::length_unit_refused`): no
/// element may be meshed against it, so every geometry job is refused and
/// counted, never meshed at an invented metre scale. Returns how many.
pub(super) fn refuse_jobs_for_unit(units: &crate::prepass::UnitScales, jobs: &mut Vec<super::EntityJob>) -> u64 {
    if units.length_unit_refused.is_none() {
        return 0;
    }
    let refused = jobs.len() as u64;
    jobs.clear();
    refused
}

/// The unit fields of `ModelMetadata` (#7678): a refused length unit reports
/// the refusal (`length_unit_refused`) and no `length_unit_scale`, never an
/// invented `1.0`.
pub(super) fn unit_metadata(units: &crate::prepass::UnitScales, unit_scale: f64) -> super::ModelMetadata {
    super::ModelMetadata {
        length_unit_scale: units.length_unit_refused.is_none().then_some(unit_scale),
        length_unit_refused: units.length_unit_refused,
        ..Default::default()
    }
}

/// The pass router at the geometry scale, refused with the length unit, so no
/// site or building placement it resolves reads file units as metres (#7678).
pub(super) fn unit_router(units: &crate::prepass::UnitScales) -> ifc_lite_geometry::GeometryRouter {
    let mut router = ifc_lite_geometry::GeometryRouter::with_scale(units.geometry_length_scale());
    if units.length_unit_refused.is_some() {
        router.refuse_length_unit();
    }
    router
}

/// `refused_prepass_records`: the distinct records the pre-pass refused
/// (#7678), each counted once however often it was re-read: the scan
/// decoder's, the deferred style decoder's and a refused unit factor.
pub(super) fn distinct_refusals(
    decoder: &ifc_lite_core::EntityDecoder,
    deferred_styles: Vec<u32>,
    units: &crate::prepass::UnitScales,
) -> u64 {
    let mut ids: rustc_hash::FxHashSet<u32> = decoder.refused_record_ids().into_iter().collect();
    ids.extend(deferred_styles);
    ids.extend(units.length_unit_refused);
    ids.len() as u64
}

/// Build the full `GeometryDiagnostics` contract from the drained sinks -- the
/// SAME shape the wasm batch path surfaces, so a native consumer and a browser
/// consumer see identical diagnostics. `None` when nothing diagnostic-worthy
/// happened (mirrors the wasm `is_empty` skip).
pub(super) fn collate(
    classification_collector: std::sync::Mutex<ifc_lite_geometry::ClassificationStats>,
    host_diag_collector: std::sync::Mutex<FxHashMap<u32, ifc_lite_geometry::HostOpeningDiagnostic>>,
    rect_fast_collector: std::sync::Mutex<ifc_lite_geometry::RectFastStats>,
    unsupported_item_collector: std::sync::Mutex<FxHashMap<String, u64>>,
    csg_failures: &FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>,
    oversized_ref_drops: u64,
) -> Option<ifc_lite_geometry::GeometryDiagnostics> {
    // Matches the wasm path's WORST_HOSTS_LIMIT (top-N per-host detail cap).
    const WORST_HOSTS_LIMIT: usize = 16;
    let classification = classification_collector
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let host_diags = host_diag_collector
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let rect_fast = rect_fast_collector
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let unsupported_items = unsupported_item_collector
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    warn_if_dropped(&unsupported_items);
    let diag = ifc_lite_geometry::aggregate_diagnostics(
        classification,
        csg_failures,
        &host_diags,
        rect_fast,
        WORST_HOSTS_LIMIT,
        oversized_ref_drops,
        &unsupported_items,
    );
    (!diag.is_empty()).then_some(diag)
}

pub(super) fn drain_unsupported_items(
    router: &ifc_lite_geometry::GeometryRouter,
    collector: &std::sync::Mutex<FxHashMap<String, u64>>,
) {
    let unsupported = router.take_unsupported_items();
    if unsupported.is_empty() {
        return;
    }
    // Recover from a poisoned lock rather than `if let Ok(..)`, like the drains
    // in `collate` above: `take_unsupported_items` has ALREADY emptied the
    // router, so a dropped lock here loses the counts for good. Elsewhere in
    // the pass a poisoned sink costs a batch of telemetry; here it would silently
    // erase the drops the counter exists to report, on the one run that already
    // had a panic worth explaining.
    let mut acc = collector
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for (ifc_type, count) in unsupported {
        *acc.entry(ifc_type).or_insert(0) += count;
    }
}

/// Native-path parity with the wasm console warning: a `tracing::warn!` when
/// this pass dropped at least one representation item, with a per-type
/// breakdown. No-op on a clean model.
pub(super) fn warn_if_dropped(unsupported_items: &FxHashMap<String, u64>) {
    if unsupported_items.is_empty() {
        return;
    }
    let total: u64 = unsupported_items.values().sum();
    // Shared with the wasm console warning so the two surfaces cannot drift.
    let breakdown = ifc_lite_geometry::format_unsupported_breakdown(unsupported_items);
    tracing::warn!(
        total_unsupported_items = total,
        %breakdown,
        "Representation items dropped (no processor, or the processor failed) — \
         these elements are missing or incomplete in the output"
    );
}
