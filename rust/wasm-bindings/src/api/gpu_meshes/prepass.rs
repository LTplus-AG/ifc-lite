// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::api::IfcAPI;
use js_sys::Function;
use wasm_bindgen::prelude::*;

use super::prepass_mode::PrepassOptions;

// The per-submesh #858 palette split lives inside the canonical per-element
// producer (`ifc_lite_processing::element`) — shared with the native pipeline.

#[wasm_bindgen]
impl IfcAPI {
    /// Run the pre-pass ONCE and return serialized results for worker distribution.
    /// Takes raw bytes (&[u8]) to avoid TextDecoder overhead.
    #[wasm_bindgen(js_name = buildPrePassOnce)]
    pub fn build_pre_pass_once(&self, data: &[u8]) -> JsValue {
        // C4-0 shares this exact pre-FFI wire with the native-hosted parity gate.
        self.build_prepass_once_data(data).into_js()
    }

    /// Streaming pre-pass: emits geometry jobs in chunks via a JS callback
    /// instead of waiting for the full file scan to complete.
    ///
    /// Single linear walk over the file:
    ///   1. Builds the entity index incrementally from the same scan that
    ///      collects geometry jobs (a separate index scan would double
    ///      wall-clock).
    ///   2. As soon as `IFCPROJECT` has been seen, the unit scale and the
    ///      first ~50 geometry jobs have been collected, resolves
    ///      `unitScale` + `rtcOffset` and emits a `meta` callback so the
    ///      JS host can spin up geometry process workers.
    ///   3. Emits `jobs` callbacks every `chunk_size` jobs (or fewer if
    ///      the meta phase already buffered some).
    ///   4. Emits `complete` with the total job count at end of scan.
    ///
    /// On a 986 MB / 14 M-entity file this drops time-to-first-geometry
    /// from ~17 s (full pre-pass + worker spawn + first batch) to ~3 s
    /// (first 100 K bytes scanned + meta + first chunk).
    ///
    /// The callback receives a single `JsValue` argument shaped as one of:
    ///   `{ type: "meta", unitScale, rtcOffset: [x,y,z], needsShift, buildingRotation? }`
    ///   `{ type: "jobs", jobs: Uint32Array }`     // [id, start, end] triples
    ///   `{ type: "complete", totalJobs }`
    #[wasm_bindgen(js_name = buildPrePassStreaming)]
    pub fn build_pre_pass_streaming(
        &self,
        data: &[u8],
        on_event: &Function,
        chunk_size: u32,
        // #1097 perf: optional load-time visibility filter. `disabled_type_names`
        // (uppercase STEP keywords, e.g. "IFCSPACE", "IFCANNOTATION") are skipped
        // at job generation so their geometry is never decoded/meshed/uploaded;
        // `skip_type_geometry` drops the #957 type-library (IfcTypeProduct) jobs.
        // Both default to "load everything" (None / false) — callers that don't
        // pass them keep the old behaviour. Toggling a type back ON requires a
        // reload (the jobs were never produced).
        disabled_type_names: Option<Vec<String>>,
        skip_type_geometry: bool,
    ) -> Result<JsValue, JsValue> {
        self.pre_pass_streaming_impl(
            data,
            on_event,
            chunk_size,
            disabled_type_names,
            skip_type_geometry,
            PrepassOptions::serial(false),
        )
    }

    pub(super) fn pre_pass_streaming_impl(
        &self, data: &[u8], on_event: &Function, chunk_size: u32,
        disabled_type_names: Option<Vec<String>>, skip_type_geometry: bool,
        options: PrepassOptions<'_>,
    ) -> Result<JsValue, JsValue> {
        self.begin_content_install();
        let disabled_types = disabled_type_names.unwrap_or_default().into_iter()
            .map(|s| s.to_ascii_uppercase()).collect();
        let scan = super::prepass_scan::scan(self, data, on_event, options.mode, &disabled_types)?;
        let total_jobs = super::prepass_emit::emit_scanned(
            self, data, on_event, chunk_size.max(1024) as usize, skip_type_geometry, scan)?;
        let done = js_sys::Object::new();
        crate::api::set_js_prop(&done, "type", &"complete".into());
        crate::api::set_js_prop(&done, "totalJobs", &(total_jobs as f64).into());
        if options.source_fingerprint {
            let key = super::source_fingerprint::source_fingerprint(data);
            crate::api::set_js_prop(&done, "sourceContentKey", &key.into());
        }
        on_event.call1(&JsValue::NULL, &done.into())?;
        Ok(JsValue::UNDEFINED)
    }
}

#[cfg(test)]
#[path = "prepass_tests.rs"]
mod prepass_tests;
