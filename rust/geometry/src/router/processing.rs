// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Core element processing: resolving representations, processing items, and caching.

use super::GeometryRouter;
use crate::{Error, Mesh, Result, SubMeshCollection};
use ifc_lite_core::{
    has_geometry_by_name, DecodedEntity, EntityDecoder, GeometryCategory, IfcType,
};
use nalgebra::Matrix4;
use rustc_hash::FxHashSet;
use std::sync::Arc;

/// Maximum nested IfcMappedItem depth we will traverse for a single geometry item.
const MAX_MAPPED_ITEM_DEPTH: usize = 32;

impl GeometryRouter {
    /// Compute median-based RTC offset from sampled translations.
    /// Returns `(0,0,0)` if empty or coordinates are within 10km of origin.
    fn rtc_offset_from_translations(translations: &[(f64, f64, f64)]) -> (f64, f64, f64) {
        if translations.is_empty() {
            return (0.0, 0.0, 0.0);
        }

        let mut x: Vec<f64> = translations.iter().map(|(x, _, _)| *x).collect();
        let mut y: Vec<f64> = translations.iter().map(|(_, y, _)| *y).collect();
        let mut z: Vec<f64> = translations.iter().map(|(_, _, z)| *z).collect();

        x.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        y.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        z.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

        let mid = x.len() / 2;
        let centroid = (
            *x.get(mid).unwrap_or(&0.0),
            *y.get(mid).unwrap_or(&0.0),
            *z.get(mid).unwrap_or(&0.0),
        );

        const THRESHOLD: f64 = 10000.0;
        if centroid.0.abs() > THRESHOLD
            || centroid.1.abs() > THRESHOLD
            || centroid.2.abs() > THRESHOLD
        {
            return centroid;
        }

        (0.0, 0.0, 0.0)
    }

    /// Sample a building element's world-space position for RTC offset detection.
    ///
    /// First checks the placement transform translation. If placement is near
    /// the origin (< 100 m), also probes the first geometry vertex — infrastructure
    /// models (12d Model, Civil 3D) embed large world coordinates directly in
    /// Brep/tessellated geometry with an identity placement.
    fn sample_element_translation(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let has_rep = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
        if !has_rep {
            return None;
        }
        let mut transform = self
            .get_placement_transform_from_element(entity, decoder)
            .ok()?;
        self.scale_transform(&mut transform);
        let tx = transform[(0, 3)];
        let ty = transform[(1, 3)];
        let tz = transform[(2, 3)];
        if !tx.is_finite() || !ty.is_finite() || !tz.is_finite() {
            return None;
        }

        // If placement is near origin, also check actual geometry vertex coordinates.
        // Infrastructure models embed world coords (e.g. 280 000, 6 214 000) directly
        // in geometry vertices with identity placement — placement-only sampling
        // would miss the large coordinates and fail to detect the need for RTC.
        const NEAR_ORIGIN: f64 = 1000.0;
        if tx.abs() < NEAR_ORIGIN && ty.abs() < NEAR_ORIGIN && tz.abs() < NEAR_ORIGIN {
            if let Some((vx, vy, vz)) = self.sample_first_geometry_vertex(entity, decoder) {
                // Transform vertex by placement to get world-space position.
                // The vertex is in raw file units but the placement transform is
                // already unit-scaled, so we must scale the vertex first.
                let world = transform.transform_point(&nalgebra::Point3::new(
                    vx * self.unit_scale,
                    vy * self.unit_scale,
                    vz * self.unit_scale,
                ));
                if world.x.is_finite() && world.y.is_finite() && world.z.is_finite() {
                    return Some((world.x, world.y, world.z));
                }
            }
        }

        Some((tx, ty, tz))
    }

    /// Read the first geometry vertex (f64) from an element's representation.
    ///
    /// Navigates the IFC representation hierarchy to extract a single vertex
    /// coordinate without processing the full geometry. Handles the two most
    /// common representation types:
    /// - **Brep**: element → IfcProductDefinitionShape → IfcShapeRepresentation
    ///   → IfcFacetedBrep → IfcClosedShell → IfcFace → IfcFaceBound → IfcPolyLoop
    ///   → first IfcCartesianPoint
    /// - **Tessellated**: element → IfcProductDefinitionShape → IfcShapeRepresentation
    ///   → IfcTriangulatedFaceSet/IfcPolygonalFaceSet → IfcCartesianPointList3D
    ///   → first coordinate triple
    fn sample_first_geometry_vertex(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        // element attr 6 = Representation (IfcProductDefinitionShape)
        let rep_attr = entity.get(6)?;
        if rep_attr.is_null() {
            return None;
        }
        let rep = decoder.resolve_ref(rep_attr).ok()??;
        if rep.ifc_type != IfcType::IfcProductDefinitionShape {
            return None;
        }

        // attr 2 = Representations (list of IfcShapeRepresentation)
        let reps_attr = rep.get(2)?;
        let reps = decoder.resolve_ref_list(reps_attr).ok()?;

        for shape_rep in &reps {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }
            // attr 3 = Items (list of geometry items)
            let items = match shape_rep.get(3).and_then(|a| a.as_list()) {
                Some(list) => list,
                None => continue,
            };

            for item_ref in items {
                let item_id = match item_ref.as_entity_ref() {
                    Some(id) => id,
                    None => continue,
                };

                // Try fast CartesianPoint extraction (if item itself is a point)
                if let Some(coords) = decoder.get_cartesian_point_fast(item_id) {
                    return Some(coords);
                }

                let item = match decoder.decode_by_id(item_id) {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                match item.ifc_type {
                    // ── Brep path ──
                    // IfcFacetedBrep attr 0 = Outer (IfcClosedShell)
                    IfcType::IfcFacetedBrep | IfcType::IfcFacetedBrepWithVoids => {
                        if let Some(pt) = self.brep_first_vertex(&item, decoder) {
                            return Some(pt);
                        }
                    }

                    // ── Tessellated path ──
                    // attr 0 = Coordinates (IfcCartesianPointList3D)
                    IfcType::IfcTriangulatedFaceSet | IfcType::IfcPolygonalFaceSet => {
                        if let Some(pt) = self.tessellated_first_vertex(&item, decoder) {
                            return Some(pt);
                        }
                    }

                    // ── Surface model path ──
                    IfcType::IfcFaceBasedSurfaceModel | IfcType::IfcShellBasedSurfaceModel => {
                        // attr 0 = FbsmFaces / SbsmBoundary (set of shells)
                        if let Some(shells_attr) = item.get(0) {
                            if let Some(shells) = shells_attr.as_list() {
                                if let Some(shell_ref) = shells.first() {
                                    if let Some(shell_id) = shell_ref.as_entity_ref() {
                                        if let Ok(shell) = decoder.decode_by_id(shell_id) {
                                            // Reuse brep_first_vertex which navigates shell → face → loop → point
                                            if let Some(pt) =
                                                self.shell_first_vertex(&shell, decoder)
                                            {
                                                return Some(pt);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    _ => continue,
                }
            }
        }
        None
    }

    /// Extract first vertex from a Brep entity (IfcFacetedBrep).
    /// Navigates: Brep → ClosedShell → Face → FaceBound → PolyLoop → CartesianPoint
    fn brep_first_vertex(
        &self,
        brep: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let shell_id = brep.get_ref(0)?;
        let shell = decoder.decode_by_id(shell_id).ok()?;
        self.shell_first_vertex(&shell, decoder)
    }

    /// Extract first vertex from a shell entity (IfcClosedShell / IfcOpenShell).
    fn shell_first_vertex(
        &self,
        shell: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let faces = shell.get(0)?.as_list()?;
        let face_id = faces.first()?.as_entity_ref()?;
        let face = decoder.decode_by_id(face_id).ok()?;
        let bounds = face.get(0)?.as_list()?;
        let bound_id = bounds.first()?.as_entity_ref()?;
        let bound = decoder.decode_by_id(bound_id).ok()?;
        let loop_id = bound.get_ref(0)?;
        // Try fast cartesian point extraction from polyloop
        if let Some(coords) = decoder.get_polyloop_coords_cached(loop_id) {
            if let Some(&(x, y, z)) = coords.first() {
                return Some((x, y, z));
            }
        }
        // Fallback: decode the loop and get first point
        let loop_entity = decoder.decode_by_id(loop_id).ok()?;
        if loop_entity.ifc_type == IfcType::IfcPolyLoop {
            let polygon = loop_entity.get(0)?.as_list()?;
            let pt_id = polygon.first()?.as_entity_ref()?;
            return decoder.get_cartesian_point_fast(pt_id);
        }
        None
    }

    /// Extract first vertex from a tessellated entity.
    /// Navigates: FaceSet → CartesianPointList3D → first coordinate triple
    fn tessellated_first_vertex(
        &self,
        faceset: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        let coord_id = faceset.get_ref(0)?;
        let coord_entity = decoder.decode_by_id(coord_id).ok()?;
        let coord_list = coord_entity.get(0)?.as_list()?;
        let first_triple = coord_list.first()?.as_list()?;
        let x = first_triple.first()?.as_float()?;
        let y = first_triple.get(1)?.as_float()?;
        let z = first_triple.get(2)?.as_float()?;
        Some((x, y, z))
    }

    fn raw_coordinate_is_large(&self, point: (f64, f64, f64)) -> bool {
        const LARGE_COORD_THRESHOLD_METERS: f64 = 10000.0;
        let max_abs = point.0.abs().max(point.1.abs()).max(point.2.abs());
        max_abs * self.unit_scale > LARGE_COORD_THRESHOLD_METERS
    }

    fn representation_item_uses_raw_large_coordinates(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> bool {
        let first_vertex = match item.ifc_type {
            IfcType::IfcFacetedBrep | IfcType::IfcFacetedBrepWithVoids => {
                self.brep_first_vertex(item, decoder)
            }
            IfcType::IfcTriangulatedFaceSet | IfcType::IfcPolygonalFaceSet => {
                self.tessellated_first_vertex(item, decoder)
            }
            IfcType::IfcFaceBasedSurfaceModel | IfcType::IfcShellBasedSurfaceModel => {
                let Some(shells_attr) = item.get(0) else {
                    return false;
                };
                let Some(shells) = shells_attr.as_list() else {
                    return false;
                };
                let Some(shell_ref) = shells.first() else {
                    return false;
                };
                let Some(shell_id) = shell_ref.as_entity_ref() else {
                    return false;
                };
                match decoder.decode_by_id(shell_id) {
                    Ok(shell) => self.shell_first_vertex(&shell, decoder),
                    Err(_) => None,
                }
            }
            _ => None,
        };

        first_vertex
            .map(|point| self.raw_coordinate_is_large(point))
            .unwrap_or(false)
    }

    /// Detect RTC offset by scanning the file for building elements.
    /// Used by synchronous parse paths.
    pub fn detect_rtc_offset_from_first_element(
        &self,
        content: &str,
        decoder: &mut EntityDecoder,
    ) -> (f64, f64, f64) {
        use ifc_lite_core::EntityScanner;

        let mut scanner = EntityScanner::new(content);
        let mut translations: Vec<(f64, f64, f64)> = Vec::new();
        const MAX_SAMPLES: usize = 50;

        while let Some((_id, type_name, start, end)) = scanner.next_entity() {
            if translations.len() >= MAX_SAMPLES {
                break;
            }
            // Use the canonical has_geometry_by_name check from the schema
            // instead of a hardcoded list — any entity class with geometry
            // is a valid candidate for RTC offset sampling.
            if !has_geometry_by_name(type_name) {
                continue;
            }
            if let Ok(entity) = decoder.decode_at(start, end) {
                if let Some(t) = self.sample_element_translation(&entity, decoder) {
                    translations.push(t);
                }
            }
        }

        Self::rtc_offset_from_translations(&translations)
    }

    /// Detect RTC offset using pre-collected geometry jobs (avoids re-scanning the file).
    /// Returns `None` when no usable translation samples were found, allowing
    /// callers to distinguish "no shift needed" from "detection had no data".
    pub fn detect_rtc_offset_from_jobs(
        &self,
        jobs: &[(u32, usize, usize, IfcType)],
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64)> {
        const MAX_SAMPLES: usize = 50;
        let translations: Vec<(f64, f64, f64)> = jobs
            .iter()
            .take(MAX_SAMPLES)
            .filter_map(|&(id, start, end, _)| {
                let entity = decoder.decode_at_with_id(id, start, end).ok()?;
                self.sample_element_translation(&entity, decoder)
            })
            .collect();

        if translations.is_empty() {
            return None;
        }
        Some(Self::rtc_offset_from_translations(&translations))
    }

    /// Process building element (IfcWall, IfcBeam, etc.) into mesh
    /// Follows the representation chain:
    /// Element → Representation → ShapeRepresentation → Items
    #[inline]
    pub fn process_element(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        // Get representation (attribute 6 for most building elements)
        // IfcProduct: GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry(format!(
                "Element #{} has no representation attribute",
                element.id
            ))
        })?;

        if representation_attr.is_null() {
            return Ok(Mesh::new()); // No geometry
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;

        // IfcProductDefinitionShape has Representations attribute (list of IfcRepresentation)
        if representation.ifc_type != IfcType::IfcProductDefinitionShape {
            return Err(Error::geometry(format!(
                "Expected IfcProductDefinitionShape, got {}",
                representation.ifc_type
            )));
        }

        // Get representations list (attribute 2)
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("IfcProductDefinitionShape missing Representations".to_string())
        })?;

        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Process all representations and merge meshes
        let mut combined_mesh = Mesh::new();

        // First pass: check if we have any direct geometry representations
        // This prevents duplication when both direct and MappedRepresentation exist
        let has_direct_geometry = representations.iter().any(|rep| {
            if rep.ifc_type != IfcType::IfcShapeRepresentation {
                return false;
            }
            if let Some(rep_type_attr) = rep.get(2) {
                if let Some(rep_type) = rep_type_attr.as_string() {
                    matches!(
                        rep_type,
                        "Body"
                            | "SweptSolid"
                            | "SolidModel"
                            | "Brep"
                            | "CSG"
                            | "Clipping"
                            | "SurfaceModel"
                            | "Tessellation"
                            | "AdvancedSweptSolid"
                            | "AdvancedBrep"
                    )
                } else {
                    false
                }
            } else {
                false
            }
        });

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            // Check RepresentationType (attribute 2) - only process geometric representations
            // Skip 'Axis', 'Curve2D', 'FootPrint', etc. - only process 'Body', 'SweptSolid', 'Brep', etc.
            if let Some(rep_type_attr) = shape_rep.get(2) {
                if let Some(rep_type) = rep_type_attr.as_string() {
                    // Skip MappedRepresentation if we already have direct geometry
                    // This prevents duplication when an element has both direct and mapped representations
                    if rep_type == "MappedRepresentation" && has_direct_geometry {
                        continue;
                    }

                    // Only process solid geometry representations
                    if !matches!(
                        rep_type,
                        "Body"
                            | "SweptSolid"
                            | "SolidModel"
                            | "Brep"
                            | "CSG"
                            | "Clipping"
                            | "SurfaceModel"
                            | "Tessellation"
                            | "MappedRepresentation"
                            | "AdvancedSweptSolid"
                            | "AdvancedBrep"
                    ) {
                        continue; // Skip non-solid representations like 'Axis', 'Curve2D', etc.
                    }
                }
            }

            // Get items list (attribute 3)
            let items_attr = shape_rep.get(3).ok_or_else(|| {
                Error::geometry("IfcShapeRepresentation missing Items".to_string())
            })?;

            let items = decoder.resolve_ref_list(items_attr)?;

            // Process each representation item
            for item in items {
                let mesh = self.process_representation_item(&item, decoder)?;
                combined_mesh.merge(&mesh);
            }
        }

        // Apply placement transformation
        self.apply_placement(element, decoder, &mut combined_mesh)?;

        Ok(combined_mesh)
    }

    /// Process element and return sub-meshes with their geometry item IDs.
    /// This preserves per-item identity for color/style lookup.
    ///
    /// For elements with multiple styled geometry items (like windows with frames + glass),
    /// this returns separate sub-meshes that can receive different colors.
    pub fn process_element_with_submeshes(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<SubMeshCollection> {
        // If a material-layer buildup is attached, try slicing single-solid
        // elements (walls / slabs with IfcMaterialLayerSetUsage) first so each
        // layer gets its own sub-mesh keyed by IfcMaterial id. An empty void
        // index is passed — the caller's has_openings branch takes the
        // voids-aware path below.
        if let Some(layered) = self.try_layered_sub_meshes(element, decoder, None) {
            return Ok(layered);
        }

        // Get representation (attribute 6 for most building elements)
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry(format!(
                "Element #{} has no representation attribute",
                element.id
            ))
        })?;

        if representation_attr.is_null() {
            return Ok(SubMeshCollection::new()); // No geometry
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;

        if representation.ifc_type != IfcType::IfcProductDefinitionShape {
            return Err(Error::geometry(format!(
                "Expected IfcProductDefinitionShape, got {}",
                representation.ifc_type
            )));
        }

        // Get representations list (attribute 2)
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("IfcProductDefinitionShape missing Representations".to_string())
        })?;

        let representations = decoder.resolve_ref_list(representations_attr)?;

        let mut sub_meshes = SubMeshCollection::new();

        // Check if we have direct geometry
        let has_direct_geometry = representations.iter().any(|rep| {
            if rep.ifc_type != IfcType::IfcShapeRepresentation {
                return false;
            }
            if let Some(rep_type_attr) = rep.get(2) {
                if let Some(rep_type) = rep_type_attr.as_string() {
                    matches!(
                        rep_type,
                        "Body"
                            | "SweptSolid"
                            | "SolidModel"
                            | "Brep"
                            | "CSG"
                            | "Clipping"
                            | "SurfaceModel"
                            | "Tessellation"
                            | "AdvancedSweptSolid"
                            | "AdvancedBrep"
                    )
                } else {
                    false
                }
            } else {
                false
            }
        });

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            if let Some(rep_type_attr) = shape_rep.get(2) {
                if let Some(rep_type) = rep_type_attr.as_string() {
                    // Skip MappedRepresentation if we have direct geometry
                    if rep_type == "MappedRepresentation" && has_direct_geometry {
                        continue;
                    }

                    // Only process solid geometry representations
                    if !matches!(
                        rep_type,
                        "Body"
                            | "SweptSolid"
                            | "SolidModel"
                            | "Brep"
                            | "CSG"
                            | "Clipping"
                            | "SurfaceModel"
                            | "Tessellation"
                            | "MappedRepresentation"
                            | "AdvancedSweptSolid"
                            | "AdvancedBrep"
                    ) {
                        continue;
                    }
                }
            }

            // Get items list (attribute 3)
            let items_attr = shape_rep.get(3).ok_or_else(|| {
                Error::geometry("IfcShapeRepresentation missing Items".to_string())
            })?;

            let items = decoder.resolve_ref_list(items_attr)?;

            // Process each representation item, preserving geometry IDs
            for item in items {
                self.collect_submeshes_from_item(&item, decoder, &mut sub_meshes)?;
            }
        }

        // Apply placement transformation to all sub-meshes
        // ObjectPlacement translation is in file units (e.g., mm) but geometry is scaled to meters,
        // so we MUST scale the transform to match. Same as apply_placement does.
        if let Some(placement_attr) = element.get(5) {
            if !placement_attr.is_null() {
                if let Some(placement) = decoder.resolve_ref(placement_attr)? {
                    let mut transform = self.get_placement_transform(&placement, decoder)?;
                    self.scale_transform(&mut transform);
                    for sub in &mut sub_meshes.sub_meshes {
                        self.transform_mesh_world(&mut sub.mesh, &transform);
                    }
                }
            }
        }

        Ok(sub_meshes)
    }

    /// Collect sub-meshes from a representation item, following MappedItem references.
    fn collect_submeshes_from_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        sub_meshes: &mut SubMeshCollection,
    ) -> Result<()> {
        let mut visited = FxHashSet::default();
        self.collect_submeshes_from_item_inner(item, decoder, sub_meshes, 0, &mut visited)
    }

    fn collect_submeshes_from_item_inner(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        sub_meshes: &mut SubMeshCollection,
        depth: usize,
        visited: &mut FxHashSet<u32>,
    ) -> Result<()> {
        if depth >= MAX_MAPPED_ITEM_DEPTH {
            return Err(Error::geometry(format!(
                "MappedItem nesting exceeded maximum depth of {} at #{}",
                MAX_MAPPED_ITEM_DEPTH, item.id
            )));
        }

        // For MappedItem, recurse into the mapped representation
        if item.ifc_type == IfcType::IfcMappedItem {
            if !visited.insert(item.id) {
                return Err(Error::geometry(format!(
                    "Detected cyclic IfcMappedItem reference at #{}",
                    item.id
                )));
            }

            // Get MappingSource (RepresentationMap)
            let source_attr = item
                .get(0)
                .ok_or_else(|| Error::geometry("MappedItem missing MappingSource".to_string()))?;

            let source_entity = decoder
                .resolve_ref(source_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve MappingSource".to_string()))?;

            // Get MappedRepresentation from RepresentationMap (attribute 1)
            let mapped_repr_attr = source_entity.get(1).ok_or_else(|| {
                Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
            })?;

            let mapped_repr = decoder.resolve_ref(mapped_repr_attr)?.ok_or_else(|| {
                Error::geometry("Failed to resolve MappedRepresentation".to_string())
            })?;

            // Get MappingTarget transformation
            let mapping_transform = if let Some(target_attr) = item.get(1) {
                if !target_attr.is_null() {
                    if let Some(target_entity) = decoder.resolve_ref(target_attr)? {
                        Some(self.parse_cartesian_transformation_operator(&target_entity, decoder)?)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            // Get items from the mapped representation
            if let Some(items_attr) = mapped_repr.get(3) {
                let items = decoder.resolve_ref_list(items_attr)?;
                for nested_item in items {
                    // Recursively collect sub-meshes (skip unsupported geometry types)
                    let count_before = sub_meshes.len();
                    if let Err(_e) = self.collect_submeshes_from_item_inner(
                        &nested_item,
                        decoder,
                        sub_meshes,
                        depth + 1,
                        visited,
                    ) {
                        #[cfg(debug_assertions)]
                        eprintln!(
                            "[ifc-lite] Skipping unsupported nested geometry #{} ({:?}): {}",
                            nested_item.id, nested_item.ifc_type, _e
                        );
                        continue;
                    }

                    // Apply MappedItem transform to newly added sub-meshes
                    if let Some(mut transform) = mapping_transform.clone() {
                        self.scale_transform(&mut transform);
                        for sub in &mut sub_meshes.sub_meshes[count_before..] {
                            self.transform_mesh_local(&mut sub.mesh, &transform);
                        }
                    }
                }
            }

            visited.remove(&item.id);
        } else {
            // Regular geometry item - process and record with its ID
            // Skip unsupported geometry types (e.g. IfcGeometricSet) instead of failing
            match self.process_representation_item(item, decoder) {
                Ok(mesh) => {
                    if !mesh.is_empty() {
                        sub_meshes.add(item.id, mesh);
                    }
                }
                Err(_e) => {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[ifc-lite] Skipping unsupported geometry #{} ({:?}): {}",
                        item.id, item.ifc_type, _e
                    );
                }
            }
        }

        Ok(())
    }

    /// Process building element and return geometry + transform separately
    /// Used for instanced rendering - geometry is returned untransformed, transform is separate
    #[inline]
    pub fn process_element_with_transform(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Mesh, Matrix4<f64>)> {
        // Get representation (attribute 6 for most building elements)
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry(format!(
                "Element #{} has no representation attribute",
                element.id
            ))
        })?;

        if representation_attr.is_null() {
            return Ok((Mesh::new(), Matrix4::identity())); // No geometry
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;

        if representation.ifc_type != IfcType::IfcProductDefinitionShape {
            return Err(Error::geometry(format!(
                "Expected IfcProductDefinitionShape, got {}",
                representation.ifc_type
            )));
        }

        // Get representations list (attribute 2)
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("IfcProductDefinitionShape missing Representations".to_string())
        })?;

        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Process all representations and merge meshes
        let mut combined_mesh = Mesh::new();

        // Check for direct geometry
        let has_direct_geometry = representations.iter().any(|rep| {
            if rep.ifc_type != IfcType::IfcShapeRepresentation {
                return false;
            }
            if let Some(rep_type_attr) = rep.get(2) {
                if let Some(rep_type) = rep_type_attr.as_string() {
                    matches!(
                        rep_type,
                        "Body"
                            | "SweptSolid"
                            | "SolidModel"
                            | "Brep"
                            | "CSG"
                            | "Clipping"
                            | "SurfaceModel"
                            | "Tessellation"
                            | "AdvancedSweptSolid"
                            | "AdvancedBrep"
                    )
                } else {
                    false
                }
            } else {
                false
            }
        });

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            if let Some(rep_type_attr) = shape_rep.get(2) {
                if let Some(rep_type) = rep_type_attr.as_string() {
                    if rep_type == "MappedRepresentation" && has_direct_geometry {
                        continue;
                    }

                    if !matches!(
                        rep_type,
                        "Body"
                            | "SweptSolid"
                            | "SolidModel"
                            | "Brep"
                            | "CSG"
                            | "Clipping"
                            | "SurfaceModel"
                            | "Tessellation"
                            | "MappedRepresentation"
                            | "AdvancedSweptSolid"
                            | "AdvancedBrep"
                    ) {
                        continue;
                    }
                }
            }

            let items_attr = shape_rep.get(3).ok_or_else(|| {
                Error::geometry("IfcShapeRepresentation missing Items".to_string())
            })?;

            let items = decoder.resolve_ref_list(items_attr)?;

            for item in items {
                let mesh = self.process_representation_item(&item, decoder)?;
                combined_mesh.merge(&mesh);
            }
        }

        // Get placement transform WITHOUT applying it
        let transform = self.get_placement_transform_from_element(element, decoder)?;

        Ok((combined_mesh, transform))
    }

    /// Process a single representation item (IfcExtrudedAreaSolid, etc.)
    /// Uses hash-based caching for geometry deduplication across repeated floors
    #[inline]
    pub fn process_representation_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        // Special handling for MappedItem with caching
        if item.ifc_type == IfcType::IfcMappedItem {
            return self.process_mapped_item_cached(item, decoder);
        }

        // Check FacetedBrep cache first (from batch preprocessing)
        if item.ifc_type == IfcType::IfcFacetedBrep {
            if let Some(mut mesh) = self.take_cached_faceted_brep(item.id) {
                self.scale_mesh(&mut mesh);
                let cached = self.get_or_cache_by_hash(mesh);
                return Ok((*cached).clone());
            }
        }

        // For raw world-coordinate FacetedBrep with RTC: subtract RTC from f64
        // coordinates BEFORE f32 conversion. Do not use this path for ordinary
        // local Breps whose large position comes from IfcObjectPlacement; those
        // are shifted uniformly during the final world transform.
        if item.ifc_type == IfcType::IfcFacetedBrep
            && self.has_rtc_offset()
            && self.representation_item_uses_raw_large_coordinates(item, decoder)
        {
            let processor = crate::processors::FacetedBrepProcessor::new();
            let rtc_file_units = (
                self.rtc_offset.0 / self.unit_scale,
                self.rtc_offset.1 / self.unit_scale,
                self.rtc_offset.2 / self.unit_scale,
            );
            let mut mesh =
                processor.process_with_rtc(item, decoder, &self.schema, rtc_file_units)?;
            mesh.validate_indices();
            self.scale_mesh(&mut mesh);
            // Mark positions as already RTC-shifted by setting a flag
            // (positions are small values near origin, not world-space)
            if !mesh.positions.is_empty() {
                let cached = self.get_or_cache_by_hash(mesh);
                return Ok((*cached).clone());
            }
            return Ok(mesh);
        }

        // Check if we have a processor for this type
        if let Some(processor) = self.processors.get(&item.ifc_type) {
            let mut mesh = processor.process(item, decoder, &self.schema)?;
            // Safety net: strip any out-of-bounds indices before downstream use
            mesh.validate_indices();

            // For raw world-coordinate meshes: apply RTC before unit scaling
            // to avoid jitter from f32 truncation at world-space scale.
            // This covers FaceBasedSurface, ShellBasedSurface, and any other
            // processor that stores raw world-space coordinates as f32.
            if self.has_rtc_offset()
                && !mesh.rtc_applied
                && !mesh.positions.is_empty()
                && self.representation_item_uses_raw_large_coordinates(item, decoder)
            {
                // Positions are in file units (pre-scale). RTC offset is in meters.
                // Convert RTC to file units for consistent subtraction.
                let rtc_fu = (
                    self.rtc_offset.0 / self.unit_scale,
                    self.rtc_offset.1 / self.unit_scale,
                    self.rtc_offset.2 / self.unit_scale,
                );
                for chunk in mesh.positions.chunks_exact_mut(3) {
                    chunk[0] = (chunk[0] as f64 - rtc_fu.0) as f32;
                    chunk[1] = (chunk[1] as f64 - rtc_fu.1) as f32;
                    chunk[2] = (chunk[2] as f64 - rtc_fu.2) as f32;
                }
                mesh.rtc_applied = true;
            }

            self.scale_mesh(&mut mesh);

            // Deduplicate by hash - buildings with repeated floors have identical geometry
            if !mesh.positions.is_empty() {
                let cached = self.get_or_cache_by_hash(mesh);
                return Ok((*cached).clone());
            }
            return Ok(mesh);
        }

        // Check category for fallback handling
        match self.schema.geometry_category(&item.ifc_type) {
            Some(GeometryCategory::SweptSolid) => {
                // For now, return empty mesh - processors will handle this
                Ok(Mesh::new())
            }
            Some(GeometryCategory::ExplicitMesh) => {
                // For now, return empty mesh - processors will handle this
                Ok(Mesh::new())
            }
            Some(GeometryCategory::Boolean) => {
                // For now, return empty mesh - processors will handle this
                Ok(Mesh::new())
            }
            Some(GeometryCategory::MappedItem) => {
                // For now, return empty mesh - processors will handle this
                Ok(Mesh::new())
            }
            _ => Err(Error::geometry(format!(
                "Unsupported representation type: {}",
                item.ifc_type
            ))),
        }
    }

    /// Process MappedItem with caching for repeated geometry
    #[inline]
    fn process_mapped_item_cached(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        // IfcMappedItem attributes:
        // 0: MappingSource (IfcRepresentationMap)
        // 1: MappingTarget (IfcCartesianTransformationOperator)

        // Get mapping source (RepresentationMap)
        let source_attr = item
            .get(0)
            .ok_or_else(|| Error::geometry("MappedItem missing MappingSource".to_string()))?;

        let source_entity = decoder
            .resolve_ref(source_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappingSource".to_string()))?;

        let source_id = source_entity.id;

        // Get MappingTarget transformation (attribute 1: CartesianTransformationOperator)
        let mapping_transform = if let Some(target_attr) = item.get(1) {
            if !target_attr.is_null() {
                if let Some(target_entity) = decoder.resolve_ref(target_attr)? {
                    Some(self.parse_cartesian_transformation_operator(&target_entity, decoder)?)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        // Check cache first
        {
            let cache = self.mapped_item_cache.borrow();
            if let Some(cached_mesh) = cache.get(&source_id) {
                let mut mesh = cached_mesh.as_ref().clone();
                if let Some(mut transform) = mapping_transform {
                    self.scale_transform(&mut transform);
                    self.transform_mesh_local(&mut mesh, &transform);
                }
                return Ok(mesh);
            }
        }

        // Cache miss - process the geometry
        // IfcRepresentationMap has:
        // 0: MappingOrigin (IfcAxis2Placement)
        // 1: MappedRepresentation (IfcRepresentation)

        let mapped_rep_attr = source_entity.get(1).ok_or_else(|| {
            Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
        })?;

        let mapped_rep = decoder
            .resolve_ref(mapped_rep_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))?;

        // Get representation items
        let items_attr = mapped_rep
            .get(3)
            .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;

        let items = decoder.resolve_ref_list(items_attr)?;

        // Process all items and merge
        // Skip nested MappedItems AND IfcBooleanClippingResult that reference MappedItems
        // to prevent stack overflow from deeply nested recursive geometry
        let mut mesh = Mesh::new();
        for sub_item in items {
            if sub_item.ifc_type == IfcType::IfcMappedItem {
                continue;
            }
            if let Some(processor) = self.processors.get(&sub_item.ifc_type) {
                if let Ok(mut sub_mesh) = processor.process(&sub_item, decoder, &self.schema) {
                    sub_mesh.validate_indices();
                    self.scale_mesh(&mut sub_mesh);
                    mesh.merge(&sub_mesh);
                }
            }
        }

        // Store in cache (before transformation, so cached mesh is in source coordinates)
        {
            let mut cache = self.mapped_item_cache.borrow_mut();
            cache.insert(source_id, Arc::new(mesh.clone()));
        }

        // Apply MappingTarget transformation to this instance
        if let Some(mut transform) = mapping_transform {
            self.scale_transform(&mut transform);
            self.transform_mesh_local(&mut mesh, &transform);
        }

        Ok(mesh)
    }
}
