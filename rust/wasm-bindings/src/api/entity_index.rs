// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::IfcAPI;
use ifc_lite_core::ColumnarEntityIndex;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Populate `cached_entity_index` from pre-extracted column arrays.
    ///
    /// Used by the streaming pre-pass to share its already-built entity
    /// index across worker realms via SAB-backed Uint32Arrays — every
    /// process worker would otherwise re-scan the entire file in
    /// `processGeometryBatch`'s lazy build path (~5 s on a 1 GB IFC),
    /// even though the pre-pass worker built the same index minutes
    /// earlier.
    ///
    /// Adopts the three binding-owned columns into a compact [`ColumnarEntityIndex`]
    /// (sorted `u32` columns + binary search) instead of a per-worker
    /// `FxHashMap` — ~229 MB vs ~436 MB on a 19.1 M-entity model (#1682).
    /// [`ColumnarEntityIndex::from_owned_columns`] verifies the id ordering once
    /// (O(n)) and only argsorts if the producer did not emit sorted columns.
    ///
    /// `lengths[i]` is the byte length of entity `ids[i]`, so lookup returns
    /// `(start, start + length)` to match the existing `(start, end)` layout.
    ///
    /// Idempotent in the sense that repeated calls REPLACE the cache —
    /// supports the parser-worker pattern of reusing one IfcAPI across
    /// multiple loads with different files.
    #[wasm_bindgen(js_name = setEntityIndex)]
    pub fn set_entity_index_owned_binding(&self, ids: Vec<u32>, starts: Vec<u32>, lengths: Vec<u32>) {
        self.install_entity_index(ColumnarEntityIndex::from_owned_columns(ids, starts, lengths));
    }
}

impl IfcAPI {
    /// Install an entity index from borrowed columns, preserving the public Rust
    /// API. The JavaScript binding consumes its owned ABI buffers separately
    /// so it does not copy them again (#3989).
    pub fn set_entity_index(&self, ids: &[u32], starts: &[u32], lengths: &[u32]) {
        self.install_entity_index(ColumnarEntityIndex::from_columns(ids, starts, lengths));
    }

    fn install_entity_index(&self, index: ColumnarEntityIndex) {
        // Invalid or empty input preserves the previous index and caches.
        if index.is_empty() {
            return;
        }
        let mut slot = self
            .cached_entity_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(index));
        drop(slot);

        // Swapping the entity index means a different file. The other caches are
        // content-scoped (keyed off the previous load) — carrying them into the
        // next file would wrongly suppress/keep orphan type geometry, reuse a
        // stale texture index, or skip the wrong parts. Drop them so they
        // rebuild against the new content (#962 review). Mirrors clearPrePassCache.
        self.cached_parts_to_skip
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_material_layer_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_referenced_repmaps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_instantiated_type_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_mapped_instance_plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_texture_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_indexed_colour_maps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_plane_angle_to_radians
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The geometry-style maps belong to the previous load's wire styles —
        // drop them on content swap so a reused IfcAPI can't reuse a stale map
        // (the (len,first,last) signature would otherwise collide rarely).
        self.cached_geometry_styles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The content-dedup cache holds the previous model's item meshes — drop it
        // on content swap so a reused IfcAPI starts the new file with an empty
        // cache (bounds memory across loads).
        self.cached_item_dedup
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The mapped-item source cache holds the previous model's source meshes —
        // drop it on content swap so a reused IfcAPI starts the new file empty
        // (bounds memory across loads; #1623).
        self.cached_mapped_item
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // A new entity index means a new file — the pipeline diagnostics
        // describe the previous load, so start fresh.
        self.reset_pipeline_diagnostics();
    }
}

#[cfg(test)]
#[path = "entity_index_tests.rs"]
mod tests;
