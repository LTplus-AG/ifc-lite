// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Core element processing: resolving representations, processing items, and caching.

use super::transforms::{instancing_enabled, mat4_to_row_major};
use super::GeometryRouter;
use crate::{Error, InstanceMeta, Mesh, Result, SubMeshCollection};

/// High tag bit distinguishing direct-solid rep_identity (a 128-bit local-mesh
/// content hash) from mapped-item rep_identity (a RepresentationMap entity id,
/// always < 2^32), so the two id spaces can never collide in `collate_instances`.
/// Bit 127 is set on direct-solid ids and clear on mapped ids; it costs one hash
/// bit (127 effective), still content-addressing grade.
const DIRECT_SOLID_TAG: u128 = 1u128 << 127;

/// Row-major 4x4 identity; placeholder `InstanceMeta::transform` before the
/// element's world placement is folded in by `apply_placement`.
const IDENTITY_ROW_MAJOR: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0, //
];
use ifc_lite_core::{
    has_geometry_by_name, DecodedEntity, EntityDecoder, GeometryCategory, IfcType,
};
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
                    IfcType::IfcTriangulatedFaceSet
                    | IfcType::IfcTriangulatedIrregularNetwork
                    | IfcType::IfcPolygonalFaceSet => {
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
            IfcType::IfcTriangulatedFaceSet
            | IfcType::IfcTriangulatedIrregularNetwork
            | IfcType::IfcPolygonalFaceSet => self.tessellated_first_vertex(item, decoder),
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
    pub fn detect_rtc_offset_from_first_element<T>(
        &self,
        content: &T,
        decoder: &mut EntityDecoder,
    ) -> (f64, f64, f64)
    where
        T: AsRef<[u8]> + ?Sized,
    {
        let content = content.as_ref();
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

    /// Detect the RTC offset from sampled jobs, falling back to a full-file
    /// placement-bounds scan when no usable translation samples were found.
    ///
    /// Single shared entry point for the server processing path and the wasm
    /// prepasses so both sides make the identical needs-shift decision: a
    /// model whose sampled placements fail to decode while raw geometry
    /// carries >10 km coordinates must be re-based identically everywhere
    /// (previously the wasm prepasses silently fell back to (0,0,0) and the
    /// browser rendered f32 vertex jitter that the server never saw).
    pub fn detect_rtc_offset_with_fallback(
        &self,
        jobs: &[(u32, usize, usize, IfcType)],
        decoder: &mut EntityDecoder,
        content: &[u8],
    ) -> (f64, f64, f64) {
        match self.detect_rtc_offset_from_jobs(jobs, decoder) {
            Some(offset) => offset,
            None => ifc_lite_core::scan_placement_bounds(content).rtc_offset(),
        }
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
        // IfcAlignment carries its directrix curve in a dedicated `Axis`
        // attribute (IFC4X1) instead of (or in addition to) a normal
        // IfcShapeRepresentation. Route those through the alignment
        // processor before the standard representation walk, since the
        // Representation is often `$` in practice.
        if element.ifc_type == IfcType::IfcAlignment {
            if let Some(mesh) = self.try_alignment_mesh(element, decoder)? {
                return Ok(mesh);
            }
        }

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

        // Instancing: an element is cleanly shareable only when its whole body is
        // exactly ONE representation item that itself carried instance metadata
        // (a mapped item). `Mesh::merge` does not propagate the side-channel, so we
        // capture the single item's metadata here and re-attach it below; any second
        // item disqualifies the element (left as None -> rendered flat).
        let mut single_instance_meta: Option<InstanceMeta> = None;
        let mut instanceable_item_count: usize = 0;

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
                            | "Surface3D"
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
                            | "Surface3D"
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
                if instancing_enabled() && !mesh.positions.is_empty() {
                    instanceable_item_count += 1;
                    single_instance_meta = if instanceable_item_count == 1 {
                        mesh.instance_meta.clone()
                    } else {
                        None
                    };
                }
                combined_mesh.merge(&mesh);
            }
        }

        // Re-attach single-item instance metadata so apply_placement can fold the
        // element's world placement into `transform`.
        if instancing_enabled() {
            combined_mesh.instance_meta = single_instance_meta;
        }

        // Mesh hygiene before placement (rigid transform preserves geometry, so
        // welding/dropping in local coords is identical and uses smaller f32
        // magnitudes). Single chokepoint downstream of every per-item branch,
        // incl. CSG output — restores the cleanup #1024 lost with Manifold:
        // redundant/coincident source vertices that otherwise triangulate into
        // visible needle spikes and jagged silhouettes. See clean_degenerate.
        combined_mesh.clean_degenerate();

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
                            | "Surface3D"
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
                            | "Surface3D"
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

        // Mesh hygiene before placement — same chokepoint as process_element,
        // applied per sub-mesh for the multi-item (per-style) channel. Rigid
        // placement preserves geometry, so order is immaterial. (The layered
        // and textured channels are cleaned at their own sites:
        // try_layered_sub_meshes and process_representation_map_with_texture.)
        for sub in &mut sub_meshes.sub_meshes {
            sub.mesh.clean_degenerate();
        }

        self.apply_submesh_placement(&mut sub_meshes, element, decoder)?;
        Ok(sub_meshes)
    }

    /// Apply the element's `ObjectPlacement` (scaled to metres) to every sub-mesh.
    /// Placement is a rigid per-instance transform, kept OUT of the dedup cache so
    /// instances of one shared geometry land at their own positions.
    fn apply_submesh_placement(
        &self,
        sub_meshes: &mut SubMeshCollection,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<()> {
        // ObjectPlacement translation is in file units (e.g. mm) but geometry is
        // scaled to metres, so the transform MUST be scaled to match.
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
        Ok(())
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

    /// Process a single representation item (IfcExtrudedAreaSolid, etc.), with
    /// content-dedup: a 128-bit structural hash of the item subtree skips the
    /// meshing + CSG for geometry byte-identical to an item meshed earlier (e.g.
    /// the thousands of Tekla connection plates/bolts an exporter failed to share
    /// via `IfcMappedItem`). The cached mesh is colour-free and pre-placement; the
    /// caller keeps this item's own `geometry_id` (so colour/palette/texture stay
    /// per-instance) and applies voids + placement afterwards, so a cache hit is
    /// indistinguishable from a fresh build.
    #[inline]
    pub fn process_representation_item(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        // MappedItem has its own instancing cache (the source representation is
        // already shared), so it never enters the structural-hash path. It also
        // sets its own instance_meta, so the direct-solid tagging below is skipped.
        if item.ifc_type == IfcType::IfcMappedItem {
            return self.process_mapped_item_cached(item, decoder);
        }

        // `None` ⇒ dedup disabled (no hash overhead). On a hit, return a clone of
        // the cached item mesh; meshing is skipped entirely.
        let dedup_key = self.item_dedup_key(item, decoder);
        if let (Some(key), Some(cache)) = (dedup_key, self.item_dedup_cache.as_ref()) {
            let hit = cache.lock().expect("dedup cache poisoned").get(&key).cloned();
            if let Some(mesh) = hit {
                return Ok(self.tag_direct_instance((*mesh).clone()));
            }
        }

        let mesh = self.process_representation_item_uncached(item, decoder)?;

        // Cache the freshly-meshed item under its structural hash. Two exclusions:
        //  - empty meshes (unsupported/degenerate geometry);
        //  - results produced once the per-element CSG budget has tripped. On a
        //    trip the boolean bails and `subtract_mesh` returns the UNCUT host
        //    (records `OperandTooLarge`); since the dedup key is budget-independent
        //    (structure/quality/scale/RTC), caching that fallback would serve the
        //    wrong (uncut) mesh to later identical booleans in a fresh-budget
        //    element (`budget::begin_element()` resets per element). Correctness of
        //    the cut wins over deduping a degraded result. (#1257 review P1.)
        if let (Some(key), Some(cache)) = (dedup_key, self.item_dedup_cache.as_ref()) {
            if !mesh.positions.is_empty() && !crate::kernel::budget::tripped() {
                cache
                    .lock()
                    .expect("dedup cache poisoned")
                    .insert(key, Arc::new(mesh.clone()));
            }
        }

        Ok(self.tag_direct_instance(mesh))
    }

    /// Instancing: tag a direct-solid item mesh with its local-geometry content
    /// hash as `rep_identity`, so identical representations across the model
    /// collate into a single template + per-occurrence transforms. The hash is of
    /// the pre-placement local mesh (the same `compute_mesh_hash` the geometry
    /// cache uses), so two occurrences differing only by `IfcObjectPlacement`
    /// share an id. A high tag bit namespaces these apart from mapped-item ids
    /// (RepresentationMap entity ids). No-op when the flag is off or the mesh
    /// already carries metadata (mapped items) / is empty.
    fn tag_direct_instance(&self, mut mesh: Mesh) -> Mesh {
        if instancing_enabled() && mesh.instance_meta.is_none() && !mesh.positions.is_empty() {
            // FULL 128-bit (non-sampling) hash: rep_identity has no downstream
            // meshes_equal guard at the source and must be cross-worker consistent,
            // so a sampled-hash collision (#833 family) would silently group
            // non-identical geometry. The 128-bit content hash makes that ~2^-127.
            let exact_rep = Self::compute_mesh_hash_full(&mesh) | DIRECT_SOLID_TAG;
            // Stash the PRE-PLACEMENT local mesh (the exact state this hash saw)
            // for the rigid post-pass (build_rigid_map) — needed by both the
            // offline analysis and the production rigid emit.
            if crate::congruence::analysis_enabled() || crate::congruence::rigid_enabled() {
                crate::congruence::record_local(exact_rep, &mesh);
            }
            // NOTE: the rotation-normalized rigid tier (RigidCache) is NOT run here.
            // Verify-on-insert with a shared cache serialises the parallel geometry
            // workers and stalls large streams (measured). Production integration is
            // a rayon POST-PASS on captured local meshes in a collect-all path
            // (coupled with the instanced wire format); the exact-bit tier ships now.
            mesh.instance_meta = Some(InstanceMeta {
                transform: IDENTITY_ROW_MAJOR,
                local_transform: None,
                canonical_transform: None,
                rep_identity: exact_rep,
                instanceable: true,
            });
        }
        mesh
    }

    /// Cache key for an item: its structural hash combined with the router params
    /// that change the meshed output (tessellation quality / unit scale / RTC), or
    /// `None` when dedup is disabled (skips the hash walk so disabled = zero
    /// overhead). The quality fold is what keeps `setTessellationQuality` correct —
    /// the shared cache persists across quality changes on a worker, so the key
    /// must distinguish them (#976).
    fn item_dedup_key(&self, item: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<u128> {
        self.item_dedup_cache.as_ref()?;
        // Dedup the geometry types whose repeated instances dominate real models:
        // IfcFacetedBrep (tessellated steel) AND the procedural boolean/extrusion
        // hot path (clipped beams/columns — IfcBooleanResult /
        // IfcBooleanClippingResult / IfcExtrudedAreaSolid). #1177 had restricted
        // this to IfcFacetedBrep because the structural hash re-decoded the subtree
        // per item; it is now memoized (`content_sig_memo`), so shared subtrees
        // (the same cutter/profile referenced by hundreds of parts) are hashed once
        // and the dedup is a measured net win, byte-identical: a 20 MB boolean-clip
        // steel model (170_KM) drops geometry 16.4 s → 2.8 s (5.8×), and procedural
        // arch models improve too (advanced_model 3.1×, ISSUE_068 1.7×) with no
        // regression on the tested corpus. The IfcMappedItem instancing cache is a
        // separate path, always on.
        if !matches!(
            item.ifc_type,
            IfcType::IfcFacetedBrep
                | IfcType::IfcBooleanResult
                | IfcType::IfcBooleanClippingResult
                | IfcType::IfcExtrudedAreaSolid
        ) {
            return None;
        }
        let structural = {
            let mut memo = self.content_sig_memo.borrow_mut();
            super::content_hash::item_signature(decoder, item.id, &mut memo)
        };
        Some(super::content_hash::key_with_params(
            structural,
            self.tessellation_quality.to_index(),
            self.unit_scale,
            self.rtc_offset,
        ))
    }

    /// The meshing body of [`Self::process_representation_item`] (everything except
    /// the MappedItem path and the content-dedup wrapper).
    fn process_representation_item_uncached(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
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
            let mut mesh =
                processor.process(item, decoder, &self.schema, self.tessellation_quality)?;
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
                let mut local_rm = None;
                if let Some(mut transform) = mapping_transform {
                    self.scale_transform(&mut transform);
                    if instancing_enabled() {
                        local_rm = Some(mat4_to_row_major(&transform));
                    }
                    self.transform_mesh_local(&mut mesh, &transform);
                }
                // Instancing: all occurrences of this RepresentationMap share the
                // cached source-coords geometry; `local_transform` is the mapping
                // (canonical -> element-local), `transform` is filled later by the
                // element's apply_placement (element-local -> world).
                if instancing_enabled() {
                    mesh.instance_meta = Some(InstanceMeta {
                        transform: IDENTITY_ROW_MAJOR,
                        local_transform: local_rm,
                        canonical_transform: None,
                        rep_identity: source_id as u128,
                        instanceable: true,
                    });
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
                if let Ok(mut sub_mesh) =
                    processor.process(&sub_item, decoder, &self.schema, self.tessellation_quality)
                {
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
        let mut local_rm = None;
        if let Some(mut transform) = mapping_transform {
            self.scale_transform(&mut transform);
            if instancing_enabled() {
                local_rm = Some(mat4_to_row_major(&transform));
            }
            self.transform_mesh_local(&mut mesh, &transform);
        }
        if instancing_enabled() {
            mesh.instance_meta = Some(InstanceMeta {
                transform: IDENTITY_ROW_MAJOR,
                local_transform: local_rm,
                        canonical_transform: None,
                rep_identity: source_id as u128,
                instanceable: true,
            });
        }

        Ok(mesh)
    }

    /// Tessellate an `IfcRepresentationMap`'s `MappedRepresentation` and bake
    /// its `MappingOrigin` placement (issue #957).
    ///
    /// Used to render geometry that hangs off an `IfcTypeProduct` (e.g.
    /// `IfcBoilerType`) through its `RepresentationMaps` when no occurrence
    /// instantiates it — the buildingSMART annex-E "tessellated shape with
    /// style" samples ship exactly this shape (geometry on the type, declared
    /// via `IfcRelDeclares`, with no product instance).
    ///
    /// Unlike [`Self::process_mapped_item_cached`], this applies `MappingOrigin`
    /// (`IfcRepresentationMap` attr 0) rather than a `MappingTarget`: there is
    /// no occurrence placement and no `IfcMappedItem` to carry one, so the
    /// MappingOrigin axis placement is the only transform. It is the caller's
    /// responsibility to only invoke this for orphan representation maps so
    /// normally-instanced typed products aren't double-rendered.
    pub fn process_representation_map(
        &self,
        rep_map: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        let empty = rustc_hash::FxHashMap::default();
        let parts = self.process_representation_map_with_texture(rep_map, decoder, &empty)?;
        let mut mesh = Mesh::new();
        for (part, _uvs, _texture) in parts {
            mesh.merge(&part);
        }
        Ok(mesh)
    }

    /// Texture-aware variant of [`Self::process_representation_map`] (issue
    /// #961). Returns one render part per output mesh: each textured
    /// `IfcTriangulatedFaceSet` item becomes its OWN part carrying its UVs +
    /// decoded image (so a representation with several differently-textured
    /// items renders each with the correct image), and all untextured items are
    /// merged into a single part with empty UVs / no texture. The MappingOrigin
    /// placement is baked into every part.
    pub fn process_representation_map_with_texture(
        &self,
        rep_map: &DecodedEntity,
        decoder: &mut EntityDecoder,
        texture_index: &rustc_hash::FxHashMap<u32, crate::processors::texture::ResolvedTextureMap>,
    ) -> Result<Vec<(Mesh, Vec<f32>, Option<crate::processors::MeshTexture>)>> {
        // attr 1: MappedRepresentation (IfcShapeRepresentation)
        let mapped_rep_attr = rep_map.get(1).ok_or_else(|| {
            Error::geometry("RepresentationMap missing MappedRepresentation".to_string())
        })?;
        let mapped_rep = decoder
            .resolve_ref(mapped_rep_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve MappedRepresentation".to_string()))?;

        // attr 3: Items
        let items_attr = mapped_rep
            .get(3)
            .ok_or_else(|| Error::geometry("Representation missing Items".to_string()))?;
        let items = decoder.resolve_ref_list(items_attr)?;

        let mut untextured = Mesh::new();
        // One entry per textured item — keeps each item with its own image.
        let mut textured: Vec<(Mesh, Vec<f32>, crate::processors::MeshTexture)> = Vec::new();
        for item in items {
            // A nested IfcMappedItem inside a type's own representation: process
            // it (applies its MappingTarget) rather than dropping its geometry.
            if item.ifc_type == IfcType::IfcMappedItem {
                if let Ok(sub_mesh) = self.process_mapped_item_cached(&item, decoder) {
                    untextured.merge(&sub_mesh); // already scaled inside the cached path
                }
                continue;
            }

            // Textured tessellated face set → its own part with per-vertex UVs (#961).
            if item.ifc_type == IfcType::IfcTriangulatedFaceSet {
                if let Some(map) = texture_index.get(&item.id) {
                    let proc = crate::processors::TriangulatedFaceSetProcessor::new();
                    if let Ok((mut sub_mesh, sub_uvs)) =
                        proc.process_with_texture(&item, decoder, map)
                    {
                        self.scale_mesh(&mut sub_mesh); // UVs are unaffected by scale
                        textured.push((sub_mesh, sub_uvs, map.texture.clone()));
                        continue;
                    }
                }
            }

            if let Some(processor) = self.processors.get(&item.ifc_type) {
                if let Ok(mut sub_mesh) =
                    processor.process(&item, decoder, &self.schema, self.tessellation_quality)
                {
                    sub_mesh.validate_indices();
                    self.scale_mesh(&mut sub_mesh);
                    untextured.merge(&sub_mesh);
                }
            }
        }

        // attr 0: MappingOrigin (IfcAxis2Placement3D) — the only 3D transform;
        // UVs are 2D and unaffected. Parse once, bake into every part.
        let origin_transform: Option<nalgebra::Matrix4<f64>> = match rep_map.get(0) {
            Some(origin_attr) if !origin_attr.is_null() => {
                match decoder.resolve_ref(origin_attr)? {
                Some(origin) if origin.ifc_type == IfcType::IfcAxis2Placement3D => {
                    let mut t = self.parse_axis2_placement_3d(&origin, decoder)?;
                    self.scale_transform(&mut t);
                    Some(t)
                }
                _ => None,
                }
            }
            _ => None,
        };

        let mut out: Vec<(Mesh, Vec<f32>, Option<crate::processors::MeshTexture>)> = Vec::new();
        for (mut mesh, uvs, texture) in textured {
            if let Some(t) = &origin_transform {
                self.transform_mesh_local(&mut mesh, t);
            }
            // Same sliver hygiene as the other mesh-output chokepoints. This is
            // the type-geometry (RepresentationMap) channel and the only one
            // carrying a parallel per-vertex UV array; clean_degenerate edits
            // only indices (vertices/UVs untouched), so the UVs stay in sync.
            mesh.clean_degenerate();
            out.push((mesh, uvs, Some(texture)));
        }
        if !untextured.is_empty() {
            if let Some(t) = &origin_transform {
                self.transform_mesh_local(&mut untextured, t);
            }
            untextured.clean_degenerate();
            out.push((untextured, Vec::new(), None));
        }

        Ok(out)
    }

    /// Run an `IfcAlignment` through the dedicated alignment processor, then
    /// apply the standard unit scale + placement transform. Returns `None`
    /// when the alignment has no recognisable directrix curve (the caller
    /// falls back to normal representation processing).
    fn try_alignment_mesh(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Mesh>> {
        let processor = match self.processors.get(&IfcType::IfcAlignment) {
            Some(p) => Arc::clone(p),
            None => return Ok(None),
        };
        let mut mesh =
            match processor.process(element, decoder, &self.schema, self.tessellation_quality) {
            Ok(m) => m,
            // Missing Axis or unparseable curve isn't fatal — fall back so
            // the caller can still walk a normal representation if present.
            Err(_) => return Ok(None),
        };
        if mesh.positions.is_empty() {
            return Ok(None);
        }
        mesh.validate_indices();
        self.scale_mesh(&mut mesh);
        self.apply_placement(element, decoder, &mut mesh)?;
        Ok(Some(mesh))
    }
}
