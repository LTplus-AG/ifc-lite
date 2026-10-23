// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Retained fingerprint models: buffers cross once, comparisons pass options.
//! JS retains adapter references and restores them from returned row indices.
use ifc_lite_diff::{columns::{decode_columns, FingerprintColumns},
    engine::diff_models, model::EntityFingerprint,
    transport_options::options_from_json, transport_result::result_to_json};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct DiffModel {
    entities: Vec<EntityFingerprint<usize>>,
}

#[wasm_bindgen]
impl DiffModel {
    /// Create an owned model from columnar buffers. Call free() when finished;
    /// a model may participate in any number of comparisons before that.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)] // Independent typed columns avoid bulk JSON encoding.
    pub fn new(strings: JsValue, fields: Vec<u32>, flags: Vec<u8>, boxes: Vec<f64>,
        volumes: Vec<f64>, component_offsets: Vec<u32>, component_pairs: Vec<u32>) -> Result<DiffModel, JsValue> {
        let strings: Vec<String> = serde_wasm_bindgen::from_value(strings)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let entities = decode_columns(FingerprintColumns { strings, fields, flags, boxes,
            volumes, component_offsets, component_pairs }).map_err(|error| JsValue::from_str(&error))?;
        Ok(Self { entities })
    }

    /// Compare this base model with a head model, returning row-index records.
    /// No JS reference is serialized, cloned, or retained inside WASM.
    pub fn compare(&self, head: &DiffModel, options: JsValue) -> Result<JsValue, JsValue> {
        let value: serde_json::Value = serde_wasm_bindgen::from_value(options)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let options = options_from_json(&value);
        result_to_json(&diff_models(&self.entities, &head.entities, &options))
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    #[wasm_bindgen(getter, js_name = entityCount)]
    pub fn entity_count(&self) -> usize { self.entities.len() }
}
