// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::MeshData;
use ifc_lite_processing::{MeshCoordinateSpace, ModelMetadata, ParseResponse, ProcessingStats, SymbolicDataWithProvenance};
use serde::{Deserialize, Serialize};

/// Server wire extension of the published processing response: symbolic data
/// with fill provenance, and meshes carrying their finish (#5984). The fields
/// are `ParseResponse`'s, in its order, so an entry either type wrote decodes
/// as the other; the legacy `symbolic_data` key and this one are the same key,
/// so the processing value is dropped rather than written twice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolicParseResponse {
    pub cache_key: String,
    pub meshes: Vec<MeshData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_coordinate_space: Option<MeshCoordinateSpace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_transform: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub building_transform: Option<Vec<f64>>,
    pub metadata: ModelMetadata,
    pub stats: ProcessingStats,
    #[serde(default, skip_serializing_if = "SymbolicDataWithProvenance::is_empty")]
    pub symbolic_data: SymbolicDataWithProvenance,
}
impl SymbolicParseResponse {
    pub fn mark_from_cache(&mut self) { self.stats.from_cache = true; }
    /// `response.meshes` carry no finish; see [`Self::with_meshes`].
    pub fn new(response: ParseResponse, symbolic_data: SymbolicDataWithProvenance) -> Self {
        Self {
            cache_key: response.cache_key,
            meshes: response.meshes.into_iter().map(MeshData::from).collect(),
            mesh_coordinate_space: response.mesh_coordinate_space,
            site_transform: response.site_transform,
            building_transform: response.building_transform,
            metadata: response.metadata,
            stats: response.stats,
            symbolic_data,
        }
    }
    /// Replace the meshes with ones that carry their finish (`finish_meshes`).
    pub fn with_meshes(mut self, meshes: Vec<MeshData>) -> Self {
        self.meshes = meshes;
        self
    }
}
