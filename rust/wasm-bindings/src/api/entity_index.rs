// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::IfcAPI;
use ifc_lite_core::ColumnarEntityIndex;
use wasm_bindgen::prelude::*;

/// The one rule for the stitched entity-index columns at the wasm boundary:
/// the parallel columns must agree in length, or the call fails with an error
/// naming every column. Both entries that take the columns (`setEntityIndex`
/// and the sharded pre-pass) run this before reading them.
///
/// Without it the two entries disagreed on the same malformed input:
/// `ColumnarEntityIndex::from_columns` folds a mismatch into an EMPTY index,
/// which the caller cannot tell from an empty file, while the sharded
/// discovery walk indexed the same columns unchecked and trapped the worker
/// (wasm is `panic=abort`, so that is the end of the instance, not an
/// exception). `classes` is `None` for the three-column `setEntityIndex`.
pub(crate) fn check_index_columns(
    ids: usize,
    starts: usize,
    lengths: usize,
    classes: Option<usize>,
) -> Result<(), String> {
    let agree = starts == ids && lengths == ids && classes.is_none_or(|c| c == ids);
    if agree {
        return Ok(());
    }
    let classes = classes.map_or(String::new(), |c| format!(", classes {c}"));
    Err(format!(
        "entity index columns disagree in length: ids {ids}, starts {starts}, lengths {lengths}{classes}"
    ))
}

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
    ///
    /// Throws when the three columns disagree in length. Every call is a
    /// content swap, the rejected ones included: the previous file's index and
    /// its content-scoped caches are dropped and the pipeline diagnostics
    /// reset BEFORE the error is raised, so a worker that catches it holds no
    /// stale state and its next batch falls back to the lazy scan of the bytes
    /// it is actually given. A silent no-op here kept the previous file's byte
    /// offsets live against the next file's bytes, resolving `#`-references to
    /// whichever entity happened to sit at those offsets.
    #[wasm_bindgen(js_name = setEntityIndex)]
    pub fn set_entity_index_owned_binding(
        &self,
        ids: Vec<u32>,
        starts: Vec<u32>,
        lengths: Vec<u32>,
    ) -> Result<(), JsValue> {
        let checked = check_index_columns(ids.len(), starts.len(), lengths.len(), None)
            .map(|()| ColumnarEntityIndex::from_owned_columns(ids, starts, lengths));
        self.install_entity_index(checked)
            .map_err(|message| JsValue::from_str(&format!("setEntityIndex: {message}")))
    }
}

impl IfcAPI {
    /// Install an entity index from borrowed columns, preserving the public Rust
    /// API. The JavaScript binding consumes its owned ABI buffers separately
    /// so it does not copy them again (#3989). Same contract as `setEntityIndex`:
    /// columns of unequal length are rejected with the error text, after the
    /// previous content state is dropped.
    pub fn set_entity_index(&self, ids: &[u32], starts: &[u32], lengths: &[u32]) -> Result<(), String> {
        let checked = check_index_columns(ids.len(), starts.len(), lengths.len(), None)
            .map(|()| ColumnarEntityIndex::from_columns(ids, starts, lengths));
        self.install_entity_index(checked)
    }

    /// Swap the content state for a new file: install `index` (or, for a
    /// rejected or empty one, nothing) and drop everything scoped to the
    /// previous load. The clearing runs for a rejection too, so the error never
    /// leaves the previous file's index or caches behind. An empty index is
    /// installed as "none" rather than as an index: a batch treats an installed
    /// index as authoritative, so an empty one would resolve no reference at
    /// all, while "none" makes the next batch scan the bytes it is given.
    fn install_entity_index(&self, index: Result<ColumnarEntityIndex, String>) -> Result<(), String> {
        let (installed, outcome) = match index {
            Ok(index) if index.is_empty() => (None, Ok(())),
            Ok(index) => (Some(std::sync::Arc::new(index)), Ok(())),
            Err(message) => (None, Err(message)),
        };
        let mut slot = self
            .cached_entity_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = installed;
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
        outcome
    }
}

#[cfg(test)]
#[path = "entity_index_tests.rs"]
mod tests;
