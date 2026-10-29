// SPDX-License-Identifier: MPL-2.0
//! Stable JS entry points: adapt the positional wire, then select output.
use crate::api::IfcAPI;
use crate::zero_copy::MeshCollection;
use super::partitioned_batch::PartitionedBatch;
#[cfg(test)]
use super::batch_output::ElementMeshOutput;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Process geometry for a subset of pre-scanned entities → flat
    /// MeshCollection. Takes raw bytes + pre-pass data from buildPrePassOnce.
    /// Thin wrapper over [`IfcAPI::produce_batch`]; converts each produced mesh
    /// to MeshDataJs (the IFC Z-up→WebGL Y-up rotation with preserved winding happens
    /// there). Flat indices preserve source order through this proper rotation.
    #[wasm_bindgen(js_name = processGeometryBatch)]
    #[allow(clippy::too_many_arguments)]
    pub fn process_geometry_batch(
        &self,
        data: &[u8],
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
        let wire = super::batch_wire::BatchWire {
            jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba,
        };
        self.batch_flat(super::batch_wire::BatchSource::Borrowed(data), wire)
}

    /// Like [`IfcAPI::process_geometry_batch`] but collates the batch's meshes
    /// into a GPU-instancing shard (IFNS wire format) instead of a flat
    /// MeshCollection. Repeated geometry collapses to one template + per-
    /// occurrence transforms; non-instanceable meshes ride as flat singleton
    /// templates so nothing is dropped. The shard stays in the producer-native
    /// (IFC Z-up) frame — the renderer composes the constant Z-up→Y-up swap at
    /// upload. Each batch shard renders independently: affinity routing already
    /// co-locates identical geometry on one worker, so per-batch collation
    /// captures ~all the dedup and no cross-batch merge is needed. Returns empty
    /// bytes only when the batch produced zero non-empty meshes.
    #[wasm_bindgen(js_name = processGeometryBatchInstanced)]
    #[allow(clippy::too_many_arguments)]
    pub fn process_geometry_batch_instanced(
        &self,
        data: &[u8],
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
    ) -> Vec<u8> {
        let wire = super::batch_wire::BatchWire {
            jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba,
        };
        self.batch_instanced(super::batch_wire::BatchSource::Borrowed(data), wire)
}

    /// Produce a batch ONCE and PARTITION it (the instanced-ONLY path): opaque
    /// ordinary occurrences (colour alpha >= 0.99 AND geometry_class == 0) are
    /// collated into the instanced shard; everything else (transparent glass,
    /// type-product geometry) goes to the flat MeshCollection. Each mesh takes
    /// exactly ONE route, so produce_batch runs once (no emit-both 2× meshing)
    /// and the renderer draws opaque occurrences via instancing instead of flat.
    /// Partition mirrors the renderer gates: INSTANCED_ALPHA_CUTOFF (0.99 =
    /// OPAQUE_ALPHA_CUTOFF) for transparency, geometry_class for the Model/Types
    /// split.
    ///
    /// NOTE: the renderer must be instanced-feature-complete (picking / selection
    /// / lens overlays on instanced geometry) before the worker calls this in
    /// place of processGeometryBatch — otherwise those features break for the
    /// opaque bulk. See the instanced-only follow-ups.
    #[wasm_bindgen(js_name = processGeometryBatchPartitioned)]
    #[allow(clippy::too_many_arguments)]
    pub fn process_geometry_batch_partitioned(
        &self,
        data: &[u8],
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
        let wire = super::batch_wire::BatchWire {
            jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba,
        };
        self.batch_partitioned(super::batch_wire::BatchSource::Borrowed(data), wire)
}
}

#[cfg(test)]
#[path = "batch_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "batch_parity_tests.rs"]
pub(super) mod parity;

#[cfg(test)]
#[path = "c4_10a_tests.rs"]
mod c4_10a_tests;
