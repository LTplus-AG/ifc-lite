// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Retained fingerprint models: buffers cross once, comparisons pass options.
//! JS retains adapter references and restores them from returned row indices.
use ifc_lite_diff::{columns::{decode_columns, FingerprintColumns},
    engine::diff_models, model::EntityFingerprint,
    transport_options::options_from_document, transport_result::result_to_document};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct DiffModel {
    entities: Vec<EntityFingerprint<usize>>,
    non_ascii_classes: Vec<ifc_lite_diff::JsString>,
}

#[wasm_bindgen]
impl DiffModel {
    /// Create an owned model from columnar buffers. Call free() when finished;
    /// a model may participate in any number of comparisons before that.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)] // Independent typed columns avoid bulk JSON encoding.
    pub fn new(strings: JsValue, fields: Vec<u32>, flags: Vec<u8>, boxes: Vec<f64>,
        volumes: Vec<f64>, component_offsets: Vec<u32>, component_pairs: Vec<u32>) -> Result<DiffModel, JsValue> {
        let strings: Vec<ifc_lite_diff::JsString> = crate::diff_transport::from_value(strings)?;
        let entities = decode_columns(FingerprintColumns { strings, fields, flags, boxes,
            volumes, component_offsets, component_pairs }).map_err(|error| JsValue::from_str(&error))?;
        let non_ascii_classes = crate::diff_class_normalization::model_classes(&entities);
        Ok(Self { entities, non_ascii_classes })
    }

    /// Compare this base model with a head model, returning row-index records.
    /// No JS reference is serialized, cloned, or retained inside WASM.
    pub fn compare(&self, head: &DiffModel, options: JsValue) -> Result<JsValue, JsValue> {
        let value = crate::diff_transport::document(options)?;
        let options = options_from_document(&value);
        let mappings = crate::diff_class_normalization::mappings(
            &self.non_ascii_classes, &head.non_ascii_classes, &options)?;
        let result = ifc_lite_diff::class_normalization::with_overrides(mappings, || {
            diff_models(&self.entities, &head.entities, &options)
        });
        // Restore the core context before any host result conversion can run.
        crate::diff_transport::host_value(&result_to_document(&result))
    }

    #[wasm_bindgen(getter, js_name = entityCount)]
    pub fn entity_count(&self) -> usize { self.entities.len() }
}
