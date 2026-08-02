// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Session-source batch variants (cold-load lever 1c).
//!
//! `setSourceBytes` stores the whole IFC file ONCE per load on the `IfcAPI`
//! (see the `cached_source_bytes` field doc in `api::mod`). The `*FromSource`
//! batch entry points then read those held bytes instead of taking a `data`
//! slice, so the wasm-bindgen glue (`passArray8ToWasm0`) no longer mallocs +
//! memcpys the entire file into the wasm heap on EVERY call. On a huge CSG-dense
//! model — which adapts down to 64-job batches and makes 600+ calls/worker —
//! that per-call copy is 15-25 s/worker of pure memcpy; holding one copy removes
//! it. The bytes are identical across a worker's calls (one model per `IfcAPI`),
//! so the meshing reads exactly the same bytes it would have received per-call,
//! making the output byte-for-byte identical to the `data`-taking twins.
//!
//! These are additive: the legacy `data`-taking `processGeometryBatch*` methods
//! in `batch.rs` are unchanged and remain the fallback for native, non-streaming,
//! and older-JS callers. Each `*FromSource` method is a thin wrapper that resolves
//! the held `Arc<Vec<u8>>` and delegates to its legacy twin with that slice — an
//! internal Rust call, so no marshalling/copy happens at that boundary.

use crate::api::IfcAPI;
use crate::zero_copy::MeshCollection;
use wasm_bindgen::prelude::*;

use super::batch::PartitionedBatch;

impl IfcAPI {
    /// Clone the held session source `Arc` (a cheap refcount bump), or an empty
    /// `Arc<Vec<u8>>` when none is installed. The empty case is unreachable from
    /// the JS worker (it gates `*FromSource` on a successful `setSourceBytes`),
    /// but is handled defensively: the decoder validates every byte span, so an
    /// empty source simply yields zero meshes instead of panicking.
    fn source_bytes_arc(&self) -> std::sync::Arc<Vec<u8>> {
        self.cached_source_bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .unwrap_or_default()
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Store the whole IFC source file ONCE per load so the `*FromSource` batch
    /// variants can read it from the wasm heap instead of re-copying it per call.
    ///
    /// Mirrors the `setEntityIndex` lifecycle: called once per worker per load,
    /// and REPLACES the previous file wholesale (repeated calls swap the bytes),
    /// so a parser/geometry worker reusing one `IfcAPI` across loads is safe.
    /// The bytes must be the exact source the batch jobs' byte spans index into
    /// (the same buffer passed as `data` to the legacy `processGeometryBatch*`),
    /// or the decoded entities won't match — the JS worker installs its own
    /// session buffer, so this holds by construction.
    ///
    /// Taking `Vec<u8>` (by value) means wasm-bindgen hands us ownership of the
    /// single JS→wasm copy directly; we wrap it in `Arc` with no second copy.
    #[wasm_bindgen(js_name = setSourceBytes)]
    pub fn set_source_bytes(&self, data: Vec<u8>) {
        let mut slot = self
            .cached_source_bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(data));
    }

    /// Like [`IfcAPI::process_geometry_batch`] but reads the source bytes held by
    /// [`IfcAPI::set_source_bytes`] instead of taking `data`. Byte-for-byte
    /// identical output — it delegates to the legacy twin with the held slice.
    #[wasm_bindgen(js_name = processGeometryBatchFromSource)]
    #[allow(clippy::too_many_arguments)]
    pub fn process_geometry_batch_from_source(
        &self,
        jobs_flat: &[u32],
        unit_scale: f64,
        rtc_x: f64,
        rtc_y: f64,
        rtc_z: f64,
        needs_shift: bool,
        void_keys: &[u32],
        void_counts: &[u32],
        void_values: &[u32],
        style_ids: &[u32],
        style_colors: &[u8],
        plane_angle_to_radians: Option<f64>,
        material_element_ids: Option<Vec<u32>>,
        material_color_counts: Option<Vec<u32>>,
        material_colors_rgba: Option<Vec<u8>>,
    ) -> MeshCollection {
        let source = self.source_bytes_arc();
        self.process_geometry_batch(
            &source,
            jobs_flat,
            unit_scale,
            rtc_x,
            rtc_y,
            rtc_z,
            needs_shift,
            void_keys,
            void_counts,
            void_values,
            style_ids,
            style_colors,
            plane_angle_to_radians,
            material_element_ids,
            material_color_counts,
            material_colors_rgba,
        )
    }

    /// Like [`IfcAPI::process_geometry_batch_partitioned`] but reads the source
    /// bytes held by [`IfcAPI::set_source_bytes`] instead of taking `data`.
    /// Byte-for-byte identical output — it delegates to the legacy twin.
    #[wasm_bindgen(js_name = processGeometryBatchPartitionedFromSource)]
    #[allow(clippy::too_many_arguments)]
    pub fn process_geometry_batch_partitioned_from_source(
        &self,
        jobs_flat: &[u32],
        unit_scale: f64,
        rtc_x: f64,
        rtc_y: f64,
        rtc_z: f64,
        needs_shift: bool,
        void_keys: &[u32],
        void_counts: &[u32],
        void_values: &[u32],
        style_ids: &[u32],
        style_colors: &[u8],
        plane_angle_to_radians: Option<f64>,
        material_element_ids: Option<Vec<u32>>,
        material_color_counts: Option<Vec<u32>>,
        material_colors_rgba: Option<Vec<u8>>,
    ) -> PartitionedBatch {
        let source = self.source_bytes_arc();
        self.process_geometry_batch_partitioned(
            &source,
            jobs_flat,
            unit_scale,
            rtc_x,
            rtc_y,
            rtc_z,
            needs_shift,
            void_keys,
            void_counts,
            void_values,
            style_ids,
            style_colors,
            plane_angle_to_radians,
            material_element_ids,
            material_color_counts,
            material_colors_rgba,
        )
    }
}
