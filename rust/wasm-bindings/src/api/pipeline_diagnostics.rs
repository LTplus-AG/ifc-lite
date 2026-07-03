// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: getPipelineDiagnostics — structured per-load pipeline
//! diagnostics (the `PipelineDiagnostics` contract from
//! `ifc_lite_processing::pipeline_diagnostics`).
//!
//! Collected on the NORMAL load path: every `processGeometryBatch*` call
//! folds one batch record into the per-worker accumulator (cheap counters
//! plus two `js_sys::Date::now()` reads, so it is always on — no feature
//! flag). `std::time::Instant` traps on wasm32, hence the JS clock; the
//! scan/prepass phases run in JS workers outside this module and report 0
//! here (the native server/CLI surface those numbers through ProcessingStats +
//! GeometryDiagnostics, not through this channel). Crossed to JS via
//! `serde_wasm_bindgen::to_value`, exactly like `diagnoseGeometry`.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Structured pipeline diagnostics accumulated across every
    /// `processGeometryBatch*` call since the last load reset
    /// (`clearPrePassCache` / `setEntityIndex`), as a JS object with a
    /// `schemaVersion` field — or `undefined` when no batch has run yet.
    /// Includes per-batch summed geometry wall time, mesh/triangle counts,
    /// the degenerate-backstop drop count, and the CSG failure aggregates.
    #[wasm_bindgen(js_name = getPipelineDiagnostics)]
    pub fn get_pipeline_diagnostics(&self) -> JsValue {
        let diag = self
            .pipeline_diagnostics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if diag.is_empty() {
            return JsValue::UNDEFINED;
        }
        serde_wasm_bindgen::to_value(&*diag).unwrap_or(JsValue::UNDEFINED)
    }
}

impl IfcAPI {
    /// Fold one produced batch into the per-worker accumulator. Called by
    /// `produce_batch` at the end of every batch; not exposed to JS.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_pipeline_batch(
        &self,
        element_count: u64,
        mesh_count: u64,
        triangle_count: u64,
        backstop_count: u64,
        geometry_ms: u64,
        diag: &ifc_lite_geometry::GeometryDiagnostics,
    ) {
        let mut acc = self
            .pipeline_diagnostics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        acc.record_batch(
            element_count,
            mesh_count,
            triangle_count,
            backstop_count,
            geometry_ms,
            diag,
        );
    }

    /// Reset the accumulator (a new load on a reused IfcAPI). Called from
    /// `clearPrePassCache` and `setEntityIndex`.
    pub(crate) fn reset_pipeline_diagnostics(&self) {
        let mut acc = self
            .pipeline_diagnostics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *acc = ifc_lite_processing::PipelineDiagnostics::default();
    }
}
