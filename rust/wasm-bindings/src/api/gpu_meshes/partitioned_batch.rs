// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The partitioned batch result, split from `batch.rs` (module-size ratchet).

use crate::zero_copy::MeshCollection;
use wasm_bindgen::prelude::*;

/// Result of [`IfcAPI::process_geometry_batch_partitioned`]: the flat
/// MeshCollection (transparent + type geometry) and the instanced IFNS shard
/// (opaque ordinary occurrences) from ONE produce_batch. Take-once accessors so
/// the JS side moves each out without a clone.
#[wasm_bindgen]
pub struct PartitionedBatch {
    pub(super) meshes: Option<MeshCollection>,
    pub(super) shard: Vec<u8>,
    pub(super) instanced_occurrences: usize,
}

#[wasm_bindgen]
impl PartitionedBatch {
    /// The flat MeshCollection (transparent glass + type-product geometry).
    /// Moves out — call once.
    #[wasm_bindgen(js_name = takeMeshes)]
    pub fn take_meshes(&mut self) -> Option<MeshCollection> {
        self.meshes.take()
    }

    /// The instanced IFNS shard bytes (opaque ordinary occurrences). Moves out.
    #[wasm_bindgen(js_name = takeShard)]
    pub fn take_shard(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.shard)
    }

    /// Number of occurrences routed into the instanced shard this batch. The viewer
    /// folds this into its total mesh count so the count reflects ALL rendered
    /// geometry (flat + instanced), not just the flat MeshCollection.
    #[wasm_bindgen(getter, js_name = instancedOccurrences)]
    pub fn instanced_occurrences(&self) -> usize {
        self.instanced_occurrences
    }
}
