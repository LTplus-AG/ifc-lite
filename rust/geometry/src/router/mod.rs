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
    AdvancedBrepProcessor, BSplineSurfaceProcessor, BlockProcessor, BooleanClippingProcessor,
    CsgSolidProcessor, ExtrudedAreaSolidProcessor, ExtrudedAreaSolidTaperedProcessor,
    FaceBasedSurfaceModelProcessor, FacetedBrepProcessor, IfcAlignmentProcessor,
    MappedItemProcessor, PolygonalFaceSetProcessor, RevolvedAreaSolidProcessor,
    SectionedSolidHorizontalProcessor, ShellBasedSurfaceModelProcessor, SphereProcessor,
    SweptDiskSolidProcessor, TriangulatedFaceSetProcessor,
};
use crate::{BoolFailure, Mesh, Result};
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
    /// Boolean / CSG failures attributed by IFC product express ID. Populated
    /// by the void-subtraction path (`apply_void_context`) when the BSP
    /// kernel falls back to the un-cut host. Drainable via
    /// [`Self::take_csg_failures`].
    csg_failures: RefCell<FxHashMap<u32, Vec<BoolFailure>>>,
    /// Cumulative counters for opening classification (T1.1 / classifier fix
    /// diagnostic). Tracks how many openings went through each branch of
    /// `classify_openings` so a maintainer can verify the fix is firing on
    /// real models. Drainable via [`Self::take_classification_stats`].
    classification_stats: RefCell<ClassificationStats>,
    /// Per-host opening diagnostic, keyed by host product express ID.
    /// Captures everything the geometry pipeline knows about each host's
    /// openings so a maintainer can answer "why didn't this wall's window
    /// get cut?" from a console log alone. Drainable via
    /// [`Self::take_host_opening_diagnostics`].
    host_opening_diagnostics: RefCell<FxHashMap<u32, HostOpeningDiagnostic>>,
}

/// Counts of opening classification outcomes during the most recent
/// geometry pass. Useful for confirming whether the host-aware
/// floor-opening classifier guard (commit `1e033f8`) is taking effect on
/// a given model.
#[derive(Debug, Default, Clone, Copy)]
pub struct ClassificationStats {
    /// Openings classified as `Rectangular` — fast AABB clip path.
    pub rectangular: usize,
    /// Openings classified as `DiagonalRectangular` — rotated AABB.
    pub diagonal: usize,
    /// Openings classified as `NonRectangular` — full CSG path
    /// (cap-limited under the legacy BSP, unlimited under Manifold).
    pub non_rectangular: usize,
    /// Openings the OLD heuristic would have flagged as floor-opening
    /// (vertical extrusion, dir.z.abs() > 0.95) but the host is a
    /// wall-class element — so the classifier fix kept them on the
    /// rectangular path. Non-zero here = the fix activated.
    pub floor_opening_guard_saved: usize,
}

/// Per-host opening diagnostic captured during void processing.
///
/// Populated incrementally: `classify_openings` fills in `host_type` and
/// the per-opening classification list; `apply_void_context` adds the
/// CSG failure tally drained from the kernel. Surfaced through
/// [`GeometryRouter::take_host_opening_diagnostics`] for the WASM
/// bindings to forward to JS.
#[derive(Debug, Clone, Default)]
pub struct HostOpeningDiagnostic {
    /// Stringified IFC type of the host (e.g. `"IfcWallStandardCase"`).
    pub host_type: String,
    /// Per-opening classification record.
    pub openings: Vec<OpeningDiagnostic>,
    /// Number of `BoolFailure` records the kernel emitted while
    /// processing this host's voids.
    pub csg_failure_count: usize,
    /// First `BoolFailure` reason recorded for this host, as a short
    /// string label. Useful for grouping at a glance.
    pub first_failure_label: Option<String>,
    /// Triangle count of the host's mesh BEFORE void subtraction.
    /// `None` until `apply_void_context` runs (or doesn't, if there
    /// were no openings to apply).
    pub tris_before: Option<usize>,
    /// Triangle count AFTER void subtraction. Compare with
    /// `tris_before` to spot "cuts attempted, no effect" cases — the
    /// classic silent-no-op signature when an opening box doesn't
    /// actually intersect the host mesh.
    pub tris_after: Option<usize>,
    /// Number of rectangular opening boxes `cut_multiple_rectangular_openings`
    /// processed for this host. Compare against `tris_before == tris_after`
    /// to detect the "ran cuts, geometry unchanged" silent-no-op.
    pub rect_boxes_processed: usize,
    /// Bounding box of the host mesh (min, max) in world coords. Useful
    /// for confirming that an opening box should overlap.
    pub host_bounds: Option<((f32, f32, f32), (f32, f32, f32))>,
}

/// One opening's worth of diagnostic data — what `classify_openings`
/// observed about it.
#[derive(Debug, Clone)]
pub struct OpeningDiagnostic {
    /// Express ID of the `IfcOpeningElement` itself.
    pub opening_id: u32,
    /// Branch the classifier took for this opening.
    pub kind: OpeningKindDiag,
    /// Vertex count of the opening's mesh — high counts (>100) force the
    /// non-rectangular path regardless of extrusion direction.
    pub vertex_count: usize,
    /// Whether the host-aware floor-opening guard saved this opening
    /// from being mis-routed onto the CSG path.
    pub guard_saved: bool,
}

/// Discriminator for [`OpeningDiagnostic::kind`]. Mirrors `OpeningType`
/// without dragging the geometry data along.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpeningKindDiag {
    Rectangular,
    Diagonal,
    NonRectangular,
}

impl OpeningKindDiag {
    pub fn as_str(self) -> &'static str {
        match self {
            OpeningKindDiag::Rectangular => "Rectangular",
            OpeningKindDiag::Diagonal => "Diagonal",
            OpeningKindDiag::NonRectangular => "NonRectangular",
        }
    }
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
            csg_failures: RefCell::new(FxHashMap::default()),
            classification_stats: RefCell::new(ClassificationStats::default()),
            host_opening_diagnostics: RefCell::new(FxHashMap::default()),
        };

        // Register default P0 processors
        router.register(Box::new(ExtrudedAreaSolidProcessor::new(
            schema_clone.clone(),
        )));
        router.register(Box::new(ExtrudedAreaSolidTaperedProcessor::new(
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
        router.register(Box::new(SectionedSolidHorizontalProcessor::new(
            schema_clone.clone(),
        )));
        router.register(Box::new(AdvancedBrepProcessor::new()));
        router.register(Box::new(BSplineSurfaceProcessor::new()));
        router.register(Box::new(ShellBasedSurfaceModelProcessor::new()));
        router.register(Box::new(FaceBasedSurfaceModelProcessor::new()));
        router.register(Box::new(BlockProcessor::new()));
        router.register(Box::new(SphereProcessor::new()));
        router.register(Box::new(CsgSolidProcessor::new()));
        router.register(Box::new(IfcAlignmentProcessor::new()));

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

    /// Drain the boolean / CSG failures accumulated by the void-subtraction
    /// path since the router was created (or the last `take_csg_failures`
    /// call). Failures are keyed by IFC product express ID — the element
    /// whose opening / clip operation tripped a fallback.
    ///
    /// Only the router-driven CSG path (multi-layer wall sub-meshes,
    /// single-mesh `apply_voids_to_mesh`) is currently attributed. Standalone
    /// `IfcBooleanResult` chains processed via the mapped-item path don't
    /// yet flow their failures here.
    pub fn take_csg_failures(&self) -> FxHashMap<u32, Vec<BoolFailure>> {
        // Fold in any failures from contexts without a direct router handle
        // (notably the transient `BooleanClippingProcessor` inside
        // `MappedItemProcessor`). They have no product attribution, so we
        // bucket them under product id 0 — keeps the diagnostics surface
        // visible without inventing a fake host id.
        let pending = crate::diagnostics::take_pending_mapped_bool_failures();
        if !pending.is_empty() {
            self.csg_failures
                .borrow_mut()
                .entry(0)
                .or_default()
                .extend(pending);
        }
        std::mem::take(&mut *self.csg_failures.borrow_mut())
    }

    /// Number of products with at least one recorded CSG failure.
    pub fn csg_failure_product_count(&self) -> usize {
        self.csg_failures.borrow().len()
    }

    /// Total number of CSG failures across all products.
    pub fn csg_failure_total(&self) -> usize {
        self.csg_failures
            .borrow()
            .values()
            .map(|v| v.len())
            .sum()
    }

    /// Internal: record a batch of failures against a product. Existing
    /// entries for the same product are appended to.
    pub(crate) fn record_csg_failures(&self, product_id: u32, failures: Vec<BoolFailure>) {
        if failures.is_empty() {
            return;
        }
        let attributed: Vec<BoolFailure> = failures
            .into_iter()
            .map(|f| f.with_product_id(product_id))
            .collect();
        self.csg_failures
            .borrow_mut()
            .entry(product_id)
            .or_default()
            .extend(attributed);
    }

    /// Drain and return the cumulative opening-classification counters
    /// since the router was created (or the last `take_classification_stats`
    /// call). The internal counters are reset to zero.
    pub fn take_classification_stats(&self) -> ClassificationStats {
        std::mem::take(&mut *self.classification_stats.borrow_mut())
    }

    /// Drain and return the per-host opening diagnostic map.
    pub fn take_host_opening_diagnostics(&self) -> FxHashMap<u32, HostOpeningDiagnostic> {
        std::mem::take(&mut *self.host_opening_diagnostics.borrow_mut())
    }

    /// Total number of hosts with diagnostic records (mostly for tests).
    pub fn host_opening_diagnostic_count(&self) -> usize {
        self.host_opening_diagnostics.borrow().len()
    }

    /// Internal: bump the classification stats. Called from
    /// `classify_openings` for each opening it processes.
    pub(crate) fn bump_classification(&self, kind: ClassificationKind) {
        let mut s = self.classification_stats.borrow_mut();
        match kind {
            ClassificationKind::Rectangular => s.rectangular += 1,
            ClassificationKind::Diagonal => s.diagonal += 1,
            ClassificationKind::NonRectangular => s.non_rectangular += 1,
            ClassificationKind::FloorOpeningGuardSaved => s.floor_opening_guard_saved += 1,
        }
    }

    /// Internal: record / merge per-host opening diagnostic. Called from
    /// `classify_openings` once per host with the host type + the list of
    /// openings it observed. `apply_void_context` later adds the CSG
    /// failure tally for the same host.
    pub(crate) fn record_host_opening_diagnostic(
        &self,
        host_id: u32,
        host_type: &str,
        openings: Vec<OpeningDiagnostic>,
    ) {
        let mut log = self.host_opening_diagnostics.borrow_mut();
        let entry = log.entry(host_id).or_default();
        if entry.host_type.is_empty() {
            entry.host_type = host_type.to_string();
        }
        entry.openings.extend(openings);
    }

    /// Internal: tag the per-host diagnostic with the cut-effect data
    /// (triangle counts before/after, rectangular boxes processed, host
    /// bounds). Lets callers spot the "rectangular cut attempted but
    /// produced no change" case — the silent-no-op signature when an
    /// opening box's geometry doesn't actually intersect the host mesh
    /// despite passing the AABB classifier.
    pub(crate) fn record_host_cut_effect(
        &self,
        host_id: u32,
        tris_before: usize,
        tris_after: usize,
        rect_boxes_processed: usize,
        host_bounds: ((f32, f32, f32), (f32, f32, f32)),
    ) {
        let mut log = self.host_opening_diagnostics.borrow_mut();
        let entry = log.entry(host_id).or_default();
        entry.tris_before = Some(tris_before);
        entry.tris_after = Some(tris_after);
        entry.rect_boxes_processed = rect_boxes_processed;
        entry.host_bounds = Some(host_bounds);
    }

    /// Internal: tag the per-host diagnostic with the failure summary for
    /// this host. Drained from `ClippingProcessor::take_failures` after
    /// `apply_void_context` finishes.
    pub(crate) fn record_host_failure_summary(
        &self,
        host_id: u32,
        failures: &[BoolFailure],
    ) {
        if failures.is_empty() {
            return;
        }
        let mut log = self.host_opening_diagnostics.borrow_mut();
        let entry = log.entry(host_id).or_default();
        entry.csg_failure_count += failures.len();
        if entry.first_failure_label.is_none() {
            // Short label for at-a-glance grouping. Full BoolFailure list
            // remains in `csg_failures` for callers that want detail.
            let label = match &failures[0].reason {
                crate::diagnostics::BoolFailureReason::OperandTooLarge { .. } => {
                    "OperandTooLarge"
                }
                crate::diagnostics::BoolFailureReason::EmptyOperand => "EmptyOperand",
                crate::diagnostics::BoolFailureReason::DegenerateOperand => "DegenerateOperand",
                crate::diagnostics::BoolFailureReason::NoBoundsOverlap => "NoBoundsOverlap",
                crate::diagnostics::BoolFailureReason::KernelOutputInvalid => {
                    "KernelOutputInvalid"
                }
                crate::diagnostics::BoolFailureReason::SolidSolidDifferenceSkipped => {
                    "SolidSolidDifferenceSkipped"
                }
                crate::diagnostics::BoolFailureReason::PolygonalBoundedHalfSpaceFallback => {
                    "PolygonalBoundedHalfSpaceFallback"
                }
                crate::diagnostics::BoolFailureReason::UnknownBooleanOperator(_) => {
                    "UnknownBooleanOperator"
                }
                crate::diagnostics::BoolFailureReason::ManifoldOutputDegenerate { .. } => {
                    "ManifoldOutputDegenerate"
                }
                crate::diagnostics::BoolFailureReason::KernelError(_) => "KernelError",
                crate::diagnostics::BoolFailureReason::DifferenceEmptiedHost => {
                    "DifferenceEmptiedHost"
                }
            };
            entry.first_failure_label = Some(label.to_string());
        }
    }
}

/// Internal classification-branch tag for `bump_classification`. Mirrors
/// the variants of `OpeningType` plus the "the host-aware guard saved
/// this opening from the floor-opening path" sentinel.
#[derive(Debug, Clone, Copy)]
pub(crate) enum ClassificationKind {
    Rectangular,
    Diagonal,
    NonRectangular,
    /// Retained for backwards compatibility. After main's per-item geometry
    /// classification superseded the host-aware floor-opening heuristic this
    /// variant is no longer bumped (the per-item path makes the same call
    /// without the global guard). The field on `Stats` remains so older
    /// JSON consumers don't see schema breakage.
    #[allow(dead_code)]
    FloorOpeningGuardSaved,
}

impl Default for GeometryRouter {
    fn default() -> Self {
        Self::new()
    }
}
