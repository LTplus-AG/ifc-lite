// SPDX-License-Identifier: MPL-2.0
use crate::api::IfcAPI;
use js_sys::Function;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Existing streaming prepass plus an exact full-source key in complete.
    #[wasm_bindgen(js_name = buildPrePassStreamingWithSourceFingerprint)]
    pub fn build_pre_pass_streaming_with_source_fingerprint(
        &self, data: &[u8], on_event: &Function, chunk_size: u32,
        disabled_type_names: Option<Vec<String>>, skip_type_geometry: bool,
    ) -> Result<JsValue, JsValue> {
        self.pre_pass_streaming_impl(data, on_event, chunk_size, disabled_type_names,
            skip_type_geometry, None, false, None, true)
    }

    /// Existing sharded prepass plus an exact full-source key in complete.
    #[wasm_bindgen(js_name = buildPrePassStreamingShardedWithSourceFingerprint)]
    #[allow(clippy::too_many_arguments)]
    pub fn build_pre_pass_streaming_sharded_with_source_fingerprint(
        &self, data: &[u8], on_event: &Function, chunk_size: u32,
        disabled_type_names: Option<Vec<String>>, skip_type_geometry: bool,
        index_ids: &[u32], index_starts: &[u32], index_lengths: &[u32], index_classes: &[u8],
    ) -> Result<JsValue, JsValue> {
        self.pre_pass_streaming_sharded_impl(data, on_event, chunk_size, disabled_type_names,
            skip_type_geometry, index_ids, index_starts, index_lengths, index_classes, true)
    }
}

impl IfcAPI {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn pre_pass_streaming_sharded_impl(
        &self, data: &[u8], on_event: &Function, chunk_size: u32,
        disabled_type_names: Option<Vec<String>>, skip_type_geometry: bool,
        index_ids: &[u32], index_starts: &[u32], index_lengths: &[u32], index_classes: &[u8],
        compute_source_fingerprint: bool,
    ) -> Result<JsValue, JsValue> {
        let prebuilt = ifc_lite_core::ColumnarEntityIndex::from_columns(index_ids, index_starts, index_lengths);
        self.pre_pass_streaming_impl(data, on_event, chunk_size, disabled_type_names,
            skip_type_geometry, Some(prebuilt), true,
            Some((index_ids, index_starts, index_lengths, index_classes)), compute_source_fingerprint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::type_complexity)] // Compile the unchanged external Rust call contracts.
    fn existing_rust_signatures_remain_callable() {
        let _serial: fn(&IfcAPI, &[u8], &Function, u32, Option<Vec<String>>, bool) -> Result<JsValue, JsValue>
            = IfcAPI::build_pre_pass_streaming;
        let _sharded: fn(&IfcAPI, &[u8], &Function, u32, Option<Vec<String>>, bool,
            &[u32], &[u32], &[u32], &[u8]) -> Result<JsValue, JsValue>
            = IfcAPI::build_pre_pass_streaming_sharded;
    }
}
