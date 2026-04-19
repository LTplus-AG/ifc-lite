// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Geometry Router - Dynamic dispatch to geometry processors
//!
//! Routes IFC representation entities to appropriate processors based on type.

mod caching;
mod clipping;
mod layers;
mod processing;
mod transforms;
mod voids;
mod voids_2d;

#[cfg(test)]
mod tests;

use crate::material_layer_index::MaterialLayerIndex;
use crate::processors::{
    AdvancedBrepProcessor, BooleanClippingProcessor, ExtrudedAreaSolidProcessor,
    FaceBasedSurfaceModelProcessor, FacetedBrepProcessor, MappedItemProcessor,
    PolygonalFaceSetProcessor, RevolvedAreaSolidProcessor, ShellBasedSurfaceModelProcessor,
    SweptDiskSolidProcessor, TriangulatedFaceSetProcessor,
};
use crate::{Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;
use rustc_hash::FxHashMap;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

/// Geometry processor trait
/// Each processor handles one type of IFC representation
pub trait GeometryProcessor {
    /// Process entity into mesh
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
    ) -> Result<Mesh>;

    /// Get supported IFC types
    fn supported_types(&self) -> Vec<IfcType>;
}

/// Geometry router - routes entities to processors
pub struct GeometryRouter {
    schema: IfcSchema,
    processors: HashMap<IfcType, Arc<dyn GeometryProcessor>>,
    /// Cache for IfcRepresentationMap source geometry (MappedItem instancing)
    /// Key: RepresentationMap entity ID, Value: Processed mesh
    mapped_item_cache: RefCell<FxHashMap<u32, Arc<Mesh>>>,
    /// Cache for FacetedBrep geometry (batch processed)
    /// Key: FacetedBrep entity ID, Value: Processed mesh
    /// Uses Box to avoid copying large meshes, entries are taken (removed) when used
    faceted_brep_cache: RefCell<FxHashMap<u32, Mesh>>,
    /// Cache for geometry deduplication by content hash
    /// Buildings with repeated floors have 99% identical geometry
    /// Key: Hash of mesh content, Value: Processed mesh
    geometry_hash_cache: RefCell<FxHashMap<u64, Arc<Mesh>>>,
    /// Unit scale factor (e.g., 0.001 for millimeters -> meters)
    /// Applied to all mesh positions after processing
    unit_scale: f64,
    /// RTC (Relative-to-Center) offset for handling large coordinates
    /// Subtracted from all world positions in f64 before converting to f32
    /// This preserves precision for georeferenced models (e.g., Swiss UTM)
    rtc_offset: (f64, f64, f64),
    /// Material-layer buildup index. When set, `process_element_with_submeshes`
    /// and `process_element_with_submeshes_and_voids` first attempt to slice
    /// single-solid elements by their `IfcMaterialLayerSetUsage` buildup.
    material_layer_index: Option<Arc<MaterialLayerIndex>>,
}

impl GeometryRouter {
    /// Create new router with default processors
    pub fn new() -> Self {
        let schema = IfcSchema::new();
        let schema_clone = schema.clone();
        let mut router = Self {
            schema,
            processors: HashMap::new(),
            mapped_item_cache: RefCell::new(FxHashMap::default()),
            faceted_brep_cache: RefCell::new(FxHashMap::default()),
            geometry_hash_cache: RefCell::new(FxHashMap::default()),
            unit_scale: 1.0,             // Default to base meters
            rtc_offset: (0.0, 0.0, 0.0), // Default to no offset
            material_layer_index: None,
        };

        // Register default P0 processors
        router.register(Box::new(ExtrudedAreaSolidProcessor::new(
            schema_clone.clone(),
        )));
        router.register(Box::new(TriangulatedFaceSetProcessor::new()));
        router.register(Box::new(PolygonalFaceSetProcessor::new()));
        router.register(Box::new(MappedItemProcessor::new()));
        router.register(Box::new(FacetedBrepProcessor::new()));
        router.register(Box::new(BooleanClippingProcessor::new()));
        router.register(Box::new(SweptDiskSolidProcessor::new(schema_clone.clone())));
        router.register(Box::new(RevolvedAreaSolidProcessor::new(
            schema_clone.clone(),
        )));
        router.register(Box::new(AdvancedBrepProcessor::new()));
        router.register(Box::new(ShellBasedSurfaceModelProcessor::new()));
        router.register(Box::new(FaceBasedSurfaceModelProcessor::new()));

        router
    }

    /// Create router and extract unit scale from IFC file
    /// Automatically finds IFCPROJECT and extracts length unit conversion
    pub fn with_units(content: &str, decoder: &mut EntityDecoder) -> Self {
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        let mut scale = 1.0;

        // Scan through file to find IFCPROJECT
        while let Some((id, type_name, _, _)) = scanner.next_entity() {
            if type_name == "IFCPROJECT" {
                if let Ok(s) = ifc_lite_core::extract_length_unit_scale(decoder, id) {
                    scale = s;
                }
                break;
            }
        }

        Self::with_scale(scale)
    }

    /// Create router with unit scale extracted from IFC file AND RTC offset for large coordinates
    /// This is the recommended method for georeferenced models (Swiss UTM, etc.)
    ///
    /// # Arguments
    /// * `content` - IFC file content
    /// * `decoder` - Entity decoder
    /// * `rtc_offset` - RTC offset to subtract from world coordinates (typically model centroid)
    pub fn with_units_and_rtc(
        content: &str,
        decoder: &mut ifc_lite_core::EntityDecoder,
        rtc_offset: (f64, f64, f64),
    ) -> Self {
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        let mut scale = 1.0;

        // Scan through file to find IFCPROJECT
        while let Some((id, type_name, _, _)) = scanner.next_entity() {
            if type_name == "IFCPROJECT" {
                if let Ok(s) = ifc_lite_core::extract_length_unit_scale(decoder, id) {
                    scale = s;
                }
                break;
            }
        }

        Self::with_scale_and_rtc(scale, rtc_offset)
    }

    /// Create router with pre-calculated unit scale
    pub fn with_scale(unit_scale: f64) -> Self {
        let mut router = Self::new();
        router.unit_scale = unit_scale;
        router
    }

    /// Create router with RTC offset for large coordinate handling
    /// Use this for georeferenced models (e.g., Swiss UTM coordinates)
    pub fn with_rtc(rtc_offset: (f64, f64, f64)) -> Self {
        let mut router = Self::new();
        router.rtc_offset = rtc_offset;
        router
    }

    /// Create router with both unit scale and RTC offset
    pub fn with_scale_and_rtc(unit_scale: f64, rtc_offset: (f64, f64, f64)) -> Self {
        let mut router = Self::new();
        router.unit_scale = unit_scale;
        router.rtc_offset = rtc_offset;
        router
    }

    /// Set the RTC offset for large coordinate handling
    pub fn set_rtc_offset(&mut self, offset: (f64, f64, f64)) {
        self.rtc_offset = offset;
    }

    /// Get the current RTC offset
    pub fn rtc_offset(&self) -> (f64, f64, f64) {
        self.rtc_offset
    }

    /// Check if RTC offset is active (non-zero)
    #[inline]
    pub fn has_rtc_offset(&self) -> bool {
        self.rtc_offset.0 != 0.0 || self.rtc_offset.1 != 0.0 || self.rtc_offset.2 != 0.0
    }

    /// Get the current unit scale factor
    pub fn unit_scale(&self) -> f64 {
        self.unit_scale
    }

    /// Attach a material-layer buildup index. After this, sub-mesh processing
    /// automatically slices single-solid elements whose buildup is sliceable
    /// (walls with `IfcMaterialLayerSetUsage`, etc.) into per-layer slabs.
    pub fn set_material_layer_index(&mut self, index: Arc<MaterialLayerIndex>) {
        self.material_layer_index = Some(index);
    }

    #[inline]
    pub(crate) fn material_layer_index(&self) -> Option<&MaterialLayerIndex> {
        self.material_layer_index.as_deref()
    }

    /// Scale mesh positions from file units to meters
    /// Only applies scaling if unit_scale != 1.0
    #[inline]
    fn scale_mesh(&self, mesh: &mut Mesh) {
        if self.unit_scale != 1.0 {
            let scale = self.unit_scale as f32;
            for pos in mesh.positions.iter_mut() {
                *pos *= scale;
            }
        }
    }

    /// Scale the translation component of a transform matrix from file units to meters
    /// The rotation/scale part stays unchanged, only translation (column 3) is scaled
    #[inline]
    fn scale_transform(&self, transform: &mut Matrix4<f64>) {
        if self.unit_scale != 1.0 {
            transform[(0, 3)] *= self.unit_scale;
            transform[(1, 3)] *= self.unit_scale;
            transform[(2, 3)] *= self.unit_scale;
        }
    }

    /// Register a geometry processor
    pub fn register(&mut self, processor: Box<dyn GeometryProcessor>) {
        let processor_arc: Arc<dyn GeometryProcessor> = Arc::from(processor);
        for ifc_type in processor_arc.supported_types() {
            self.processors.insert(ifc_type, Arc::clone(&processor_arc));
        }
    }

    /// Batch preprocess FacetedBrep entities for maximum parallelism
    /// Call this before processing elements to enable batch triangulation
    /// across all FacetedBrep entities instead of per-entity parallelism
    pub fn preprocess_faceted_breps(&self, brep_ids: &[u32], decoder: &mut EntityDecoder) {
        if brep_ids.is_empty() {
            return;
        }

        // Use batch processing for parallel triangulation.
        // Convert RTC from meters to file units so the Brep processor
        // subtracts the offset in the same coordinate space as the vertices.
        let processor = FacetedBrepProcessor::new();
        let rtc_file_units = (
            self.rtc_offset.0 / self.unit_scale,
            self.rtc_offset.1 / self.unit_scale,
            self.rtc_offset.2 / self.unit_scale,
        );
        let large_coord_threshold_file_units = 10000.0 / self.unit_scale;
        let results = processor.process_batch(
            brep_ids,
            decoder,
            rtc_file_units,
            large_coord_threshold_file_units,
        );

        // Store results in cache (preallocate to avoid rehashing)
        let mut cache = self.faceted_brep_cache.borrow_mut();
        cache.reserve(results.len());
        for (brep_idx, mesh) in results {
            let brep_id = brep_ids[brep_idx];
            cache.insert(brep_id, mesh);
        }
    }

    /// Take FacetedBrep from cache (removes entry since each BREP is only used once)
    /// Returns owned Mesh directly - no cloning needed
    #[inline]
    pub fn take_cached_faceted_brep(&self, brep_id: u32) -> Option<Mesh> {
        self.faceted_brep_cache.borrow_mut().remove(&brep_id)
    }

    /// Resolve an element's ObjectPlacement to a scaled world-space transform matrix.
    /// Returns the 4x4 matrix as a flat column-major array of 16 f64 values.
    /// The translation component is scaled from file units to meters.
    ///
    /// Contributed by Mathias Søndergaard (Sonderwoods/Linkajou).
    pub fn resolve_scaled_placement(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<[f64; 16]> {
        let mut transform = self.get_placement_transform_from_element(entity, decoder)?;
        self.scale_transform(&mut transform);
        let mut result = [0.0f64; 16];
        result.copy_from_slice(transform.as_slice());
        Ok(result)
    }

    /// Get schema reference
    pub fn schema(&self) -> &IfcSchema {
        &self.schema
    }
}

impl Default for GeometryRouter {
    fn default() -> Self {
        Self::new()
    }
}
