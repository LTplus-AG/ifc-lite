// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reuse the geometry worker's owned source during prepass assistance (#3989).
//! The byte-taking entry points remain the canonical implementations and are
//! also used by clients that do not install a session source.

use crate::api::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Scan a shard of the source installed by `setSourceBytes`.
    #[wasm_bindgen(js_name = scanEntityIndexShardFromSource)]
    pub fn scan_entity_index_shard_from_source(&self, start: u32, end: u32) -> JsValue {
        let source = self.source_bytes_arc();
        self.scan_entity_index_shard(&source, start, end)
    }

    /// Resolve styled-item spans against the installed source and entity index.
    #[wasm_bindgen(js_name = resolveStyledItemsShardFromSource)]
    pub fn resolve_styled_items_shard_from_source(&self, spans: &[u32]) -> Result<JsValue, JsValue> {
        let source = self.source_bytes_arc();
        self.resolve_styled_items_shard(&source, spans)
    }

    /// Finalize prepass styles against the installed source and entity index.
    #[wasm_bindgen(js_name = finalizePrepassStylesFromSource)]
    #[allow(clippy::too_many_arguments)]
    pub fn finalize_prepass_styles_from_source(
        &self,
        orphan_ids: &[u32],
        orphan_colors: &[f32],
        geom_ids: &[u32],
        geom_colors: &[f32],
        colour_map_spans: &[u32],
        material_def_spans: &[u32],
        rel_material_spans: &[u32],
        void_spans: &[u32],
        fills_spans: &[u32],
        aggregate_spans: &[u32],
        plane_angle_to_radians: f64,
    ) -> Result<JsValue, JsValue> {
        let source = self.source_bytes_arc();
        self.finalize_prepass_styles(
            &source, orphan_ids, orphan_colors, geom_ids, geom_colors,
            colour_map_spans, material_def_spans, rel_material_spans,
            void_spans, fills_spans, aggregate_spans, plane_angle_to_radians,
        )
    }
}
