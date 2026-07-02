// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Structured per-load pipeline diagnostics — the cross-target contract.
//!
//! Lives in `ifc-lite-processing` (not the geometry crate) because this is
//! where the per-phase numbers are actually collected: the phase timers
//! (`ProcessingStats.{parse,entity_scan,lookup,preprocess,geometry}_time_ms`)
//! are measured by `processor::process_geometry_*`, and the per-element
//! production counters (degenerate-backstop drops, CSG failure drains) are
//! owned by `element::produce_element_meshes`. The geometry crate only knows
//! router-level CSG/opening data, which it already publishes as
//! [`ifc_lite_geometry::GeometryDiagnostics`]; this struct composes those
//! aggregates with the pipeline-level timings and counts.
//!
//! Serde contract: `camelCase` renames plus an explicit `schema_version`, the
//! same pattern as `GeometryDiagnostics` (see its
//! `serializes_camelcase_keys_matching_the_ts_contract` guard, mirrored
//! below). The wasm getter (`IfcAPI::getPipelineDiagnostics`) crosses it to
//! JS via `serde_wasm_bindgen::to_value`, exactly like `diagnoseGeometry`.
//!
//! Population:
//! - wasm: accumulated on the NORMAL load path — every
//!   `processGeometryBatch*` call folds one [`Self::record_batch`] in
//!   (cheap counters plus two `js_sys::Date::now()` reads per batch, so it
//!   is always on). `std::time::Instant` traps on wasm32, so the wasm side
//!   fills only `phase_ms.geometry_ms` (summed batch wall time); the
//!   scan/prepass phases run in JS workers outside the wasm module and are
//!   reported as 0 there.
//! - native: one-shot from the finished pass via
//!   [`Self::from_processing_stats`], which maps the full `ProcessingStats`
//!   phase timers.

use crate::types::response::ProcessingStats;
use ifc_lite_geometry::{GeometryDiagnostics, RectFastSummary};

/// Version of the `PipelineDiagnostics` wire shape. Bump on any
/// breaking key change so JS consumers can gate on it.
pub const PIPELINE_DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;

/// Pipeline phase wall-times in milliseconds. Field names mirror the
/// `ProcessingStats` timers they are sourced from. On wasm32 only
/// `geometry_ms` is populated (see the module docs).
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelinePhaseTimings {
    /// Entity scan + prepass span-stash/resolve.
    pub entity_scan_ms: u64,
    /// Lookup/style/property resolution.
    pub lookup_ms: u64,
    /// Geometry preprocessing (unit scales, RTC detection, site transforms).
    pub preprocess_ms: u64,
    /// Whole parse phase (scan + lookup + preprocess).
    pub parse_ms: u64,
    /// Per-element geometry extraction (meshing + CSG).
    pub geometry_ms: u64,
    /// End-to-end wall time of the pass. On the NATIVE single-pass builder
    /// this is the true end-to-end figure; on the wasm batch path it is the
    /// SUM of per-batch geometry wall time (the parse-phase timers live in
    /// the pre-pass and JS orchestration there), i.e. a lower bound.
    pub total_ms: u64,
}

/// Aggregate structured diagnostics for one model load. Counter names are
/// aligned with the existing [`GeometryDiagnostics`] contract
/// (`total_csg_failures`, `hosts_with_openings`, `rect_fast`, ...) so a
/// consumer reading both sees one vocabulary.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineDiagnostics {
    /// Wire-shape version ([`PIPELINE_DIAGNOSTICS_SCHEMA_VERSION`]).
    pub schema_version: u32,
    /// Geometry passes folded in: one per `processGeometryBatch*` call on
    /// wasm, exactly 1 for the native single-pass pipeline.
    pub batches: u64,
    /// Element jobs submitted to the per-element producer.
    pub element_count: u64,
    /// Meshes emitted across all batches.
    pub mesh_count: u64,
    /// Triangles emitted across all batches.
    pub triangle_count: u64,
    /// Triangles removed by the f32-collapse degenerate-triangle backstop
    /// (`element::build_mesh_data`). Non-zero means the backstop engaged.
    pub backstop_count: u64,
    /// Total CSG boolean failures (same meaning as
    /// `GeometryDiagnostics::total_csg_failures`).
    pub total_csg_failures: u64,
    /// Distinct products with at least one CSG failure.
    pub products_with_failures: u64,
    /// Hosts that had openings processed.
    pub hosts_with_openings: u64,
    /// Hosts where rect cutters ran clean but the mesh came out unchanged.
    pub silent_no_ops: u64,
    /// rect_fast fast-path engagement, summed across batches.
    pub rect_fast: RectFastSummary,
    /// Phase wall-times (native: full; wasm: geometry only).
    pub phase_ms: PipelinePhaseTimings,
}

impl Default for PipelineDiagnostics {
    fn default() -> Self {
        Self {
            schema_version: PIPELINE_DIAGNOSTICS_SCHEMA_VERSION,
            batches: 0,
            element_count: 0,
            mesh_count: 0,
            triangle_count: 0,
            backstop_count: 0,
            total_csg_failures: 0,
            products_with_failures: 0,
            hosts_with_openings: 0,
            silent_no_ops: 0,
            rect_fast: RectFastSummary::default(),
            phase_ms: PipelinePhaseTimings::default(),
        }
    }
}

impl PipelineDiagnostics {
    /// Fold one geometry batch into the accumulator (the wasm
    /// `processGeometryBatch*` path calls this once per batch).
    /// `geometry_ms` is the batch's wall time; `diag` is the batch's drained
    /// [`GeometryDiagnostics`]. Summing per-batch aggregates is exact because
    /// each batch drains its own router (no double counting).
    #[allow(clippy::too_many_arguments)]
    pub fn record_batch(
        &mut self,
        element_count: u64,
        mesh_count: u64,
        triangle_count: u64,
        backstop_count: u64,
        geometry_ms: u64,
        diag: &GeometryDiagnostics,
    ) {
        self.batches += 1;
        self.element_count += element_count;
        self.mesh_count += mesh_count;
        self.triangle_count += triangle_count;
        self.backstop_count += backstop_count;
        self.total_csg_failures += diag.total_csg_failures;
        self.products_with_failures += diag.products_with_failures;
        self.hosts_with_openings += diag.hosts_with_openings;
        self.silent_no_ops += diag.silent_no_ops;
        self.rect_fast.fired += diag.rect_fast.fired;
        self.rect_fast.openings_cut += diag.rect_fast.openings_cut;
        self.rect_fast.defer_host_not_box += diag.rect_fast.defer_host_not_box;
        self.rect_fast.defer_not_through += diag.rect_fast.defer_not_through;
        self.rect_fast.defer_off_face += diag.rect_fast.defer_off_face;
        self.rect_fast.defer_near_edge += diag.rect_fast.defer_near_edge;
        self.rect_fast.defer_no_openings += diag.rect_fast.defer_no_openings;
        self.phase_ms.geometry_ms += geometry_ms;
        self.phase_ms.total_ms += geometry_ms;
    }

    /// Build the same contract from a finished native pass. The native
    /// pipeline is single-pass, so `batches` is 1 and every phase timer is
    /// available.
    pub fn from_processing_stats(stats: &ProcessingStats, element_count: u64) -> Self {
        let (hosts_with_openings, silent_no_ops, rect_fast) = match &stats.geometry_diagnostics {
            Some(d) => (d.hosts_with_openings, d.silent_no_ops, d.rect_fast),
            None => (0, 0, RectFastSummary::default()),
        };
        Self {
            schema_version: PIPELINE_DIAGNOSTICS_SCHEMA_VERSION,
            batches: 1,
            element_count,
            mesh_count: stats.total_meshes as u64,
            triangle_count: stats.total_triangles as u64,
            backstop_count: stats.degenerate_triangles_dropped,
            total_csg_failures: stats.total_csg_failures,
            products_with_failures: stats.products_with_failures,
            hosts_with_openings,
            silent_no_ops,
            rect_fast,
            phase_ms: PipelinePhaseTimings {
                entity_scan_ms: stats.entity_scan_time_ms,
                lookup_ms: stats.lookup_time_ms,
                preprocess_ms: stats.preprocess_time_ms,
                parse_ms: stats.parse_time_ms,
                geometry_ms: stats.geometry_time_ms,
                total_ms: stats.total_time_ms,
            },
        }
    }

    /// Whether anything has been recorded — the wasm getter returns
    /// `undefined` before the first batch so consumers can gate on presence.
    pub fn is_empty(&self) -> bool {
        self.batches == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camelcase_keys_matching_the_ts_contract() {
        // Guard the serde rename_all against drift from the TS-side consumer.
        // The wasm getter uses the same renames via serde-wasm-bindgen, so
        // this JSON key set is what crosses to JS. Mirrors the
        // GeometryDiagnostics contract test in the geometry crate.
        let mut d = PipelineDiagnostics::default();
        d.record_batch(10, 12, 3000, 2, 42, &GeometryDiagnostics::default());
        let v = serde_json::to_value(&d).expect("serializes");
        for key in [
            "schemaVersion",
            "batches",
            "elementCount",
            "meshCount",
            "triangleCount",
            "backstopCount",
            "totalCsgFailures",
            "productsWithFailures",
            "hostsWithOpenings",
            "silentNoOps",
            "rectFast",
            "phaseMs",
        ] {
            assert!(v.get(key).is_some(), "missing top-level key {key}");
        }
        for key in [
            "entityScanMs",
            "lookupMs",
            "preprocessMs",
            "parseMs",
            "geometryMs",
            "totalMs",
        ] {
            assert!(v["phaseMs"].get(key).is_some(), "missing phaseMs key {key}");
        }
        assert!(v["rectFast"].get("deferHostNotBox").is_some());
        assert_eq!(v["schemaVersion"], PIPELINE_DIAGNOSTICS_SCHEMA_VERSION);
    }

    #[test]
    fn record_batch_accumulates_across_batches() {
        let mut d = PipelineDiagnostics::default();
        assert!(d.is_empty());
        let diag = GeometryDiagnostics {
            total_csg_failures: 2,
            hosts_with_openings: 3,
            ..Default::default()
        };
        d.record_batch(10, 12, 3000, 1, 40, &diag);
        d.record_batch(5, 6, 1500, 0, 10, &GeometryDiagnostics::default());
        assert!(!d.is_empty());
        assert_eq!(d.batches, 2);
        assert_eq!(d.element_count, 15);
        assert_eq!(d.mesh_count, 18);
        assert_eq!(d.triangle_count, 4500);
        assert_eq!(d.backstop_count, 1);
        assert_eq!(d.total_csg_failures, 2);
        assert_eq!(d.hosts_with_openings, 3);
        assert_eq!(d.phase_ms.geometry_ms, 50);
    }

    #[test]
    fn from_processing_stats_maps_all_phase_timers() {
        let stats = ProcessingStats {
            total_meshes: 7,
            total_triangles: 99,
            parse_time_ms: 11,
            entity_scan_time_ms: 5,
            lookup_time_ms: 2,
            preprocess_time_ms: 3,
            geometry_time_ms: 40,
            total_time_ms: 60,
            degenerate_triangles_dropped: 4,
            total_csg_failures: 1,
            products_with_failures: 1,
            ..Default::default()
        };
        let d = PipelineDiagnostics::from_processing_stats(&stats, 20);
        assert_eq!(d.batches, 1);
        assert_eq!(d.element_count, 20);
        assert_eq!(d.mesh_count, 7);
        assert_eq!(d.backstop_count, 4);
        assert_eq!(d.phase_ms.parse_ms, 11);
        assert_eq!(d.phase_ms.entity_scan_ms, 5);
        assert_eq!(d.phase_ms.lookup_ms, 2);
        assert_eq!(d.phase_ms.preprocess_ms, 3);
        assert_eq!(d.phase_ms.geometry_ms, 40);
        assert_eq!(d.phase_ms.total_ms, 60);
    }
}
