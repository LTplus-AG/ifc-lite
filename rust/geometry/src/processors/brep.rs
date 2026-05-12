// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! BRep/surface model processors.
//!
//! Handles IfcFacetedBrep, IfcFaceBasedSurfaceModel, and IfcShellBasedSurfaceModel.
//! All deal with boundary representations composed of face loops.

use crate::{Error, Mesh, Point3, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::advanced_face::process_advanced_face;
use super::helpers::{extract_loop_points_by_id, FaceData, FaceResult};
use crate::router::GeometryProcessor;

// ---------- FacetedBrepProcessor ----------

/// FacetedBrep processor
/// Handles IfcFacetedBrep - explicit mesh with faces
/// Supports faces with inner bounds (holes)
/// Uses parallel triangulation for large BREPs
pub struct FacetedBrepProcessor;

impl FacetedBrepProcessor {
    pub fn new() -> Self {
        Self
    }

    /// Extract polygon points from a loop entity
    /// Uses fast path for CartesianPoint extraction to avoid decode overhead
    #[allow(dead_code)]
    #[inline]
    fn extract_loop_points(
        &self,
        loop_entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Vec<Point3<f64>>> {
        // Try to get Polygon attribute (attribute 0) - IfcPolyLoop has this
        let polygon_attr = loop_entity.get(0)?;

        // Get the list of point references directly
        let point_refs = polygon_attr.as_list()?;

        // Pre-allocate with known size
        let mut polygon_points = Vec::with_capacity(point_refs.len());

        for point_ref in point_refs {
            let point_id = point_ref.as_entity_ref()?;

            // Try fast path first
            if let Some((x, y, z)) = decoder.get_cartesian_point_fast(point_id) {
                polygon_points.push(Point3::new(x, y, z));
            } else {
                // Fallback to standard path if fast extraction fails
                let point = decoder.decode_by_id(point_id).ok()?;
                let coords_attr = point.get(0)?;
                let coords = coords_attr.as_list()?;
                use ifc_lite_core::AttributeValue;
                let x = coords.first().and_then(|v: &AttributeValue| v.as_float())?;
                let y = coords.get(1).and_then(|v: &AttributeValue| v.as_float())?;
                let z = coords.get(2).and_then(|v: &AttributeValue| v.as_float())?;
                polygon_points.push(Point3::new(x, y, z));
            }
        }

        if polygon_points.len() >= 3 {
            Some(polygon_points)
        } else {
            None
        }
    }

    /// Extract polygon points using ultra-fast path from loop entity ID
    /// Uses cached coordinate extraction - points are cached across faces
    /// This is the fastest path for files with shared cartesian points
    #[inline]
    fn extract_loop_points_fast(
        &self,
        loop_entity_id: u32,
        decoder: &mut EntityDecoder,
    ) -> Option<Vec<Point3<f64>>> {
        // ULTRA-FAST PATH with CACHING: Get coordinates with point cache
        // Many faces share the same cartesian points, so caching avoids
        // re-parsing the same point data multiple times
        let coords = decoder.get_polyloop_coords_cached(loop_entity_id)?;

        // Convert to Point3 - pre-allocated in get_polyloop_coords_cached
        let polygon_points: Vec<Point3<f64>> = coords
            .into_iter()
            .map(|(x, y, z)| Point3::new(x, y, z))
            .collect();

        if polygon_points.len() >= 3 {
            Some(polygon_points)
        } else {
            None
        }
    }

    /// Triangulate a single face (can be called in parallel)
    /// Optimized with fast paths for simple faces.
    ///
    /// `rtc`: RTC offset subtracted from f64 coordinates BEFORE f32 conversion.
    /// For infrastructure models with world-space coordinates (e.g. Y ≈ 6.2M),
    /// f32 only has ~0.5m precision. Subtracting RTC in f64 first brings
    /// values near origin where f32 has sub-mm precision, eliminating jitter.
    #[inline]
    fn triangulate_face(face: &FaceData, rtc: (f64, f64, f64)) -> FaceResult {
        let n = face.outer_points.len();

        // FAST PATH: Triangle without holes - no triangulation needed
        if n == 3 && face.hole_points.is_empty() {
            let mut positions = Vec::with_capacity(9);
            for point in &face.outer_points {
                positions.push((point.x - rtc.0) as f32);
                positions.push((point.y - rtc.1) as f32);
                positions.push((point.z - rtc.2) as f32);
            }
            return FaceResult {
                positions,
                indices: vec![0, 1, 2],
            };
        }

        // FAST PATH: Quad without holes - simple fan
        if n == 4 && face.hole_points.is_empty() {
            let mut positions = Vec::with_capacity(12);
            for point in &face.outer_points {
                positions.push((point.x - rtc.0) as f32);
                positions.push((point.y - rtc.1) as f32);
                positions.push((point.z - rtc.2) as f32);
            }
            return FaceResult {
                positions,
                indices: vec![0, 1, 2, 0, 2, 3],
            };
        }

        // FAST PATH: Simple convex polygon without holes
        if face.hole_points.is_empty() && n <= 8 {
            // Check if convex by testing cross products in 3D
            let mut is_convex = true;
            if n > 4 {
                use crate::triangulation::calculate_polygon_normal;
                let normal = calculate_polygon_normal(&face.outer_points);
                let mut sign = 0i8;

                for i in 0..n {
                    let p0 = &face.outer_points[i];
                    let p1 = &face.outer_points[(i + 1) % n];
                    let p2 = &face.outer_points[(i + 2) % n];

                    let v1 = p1 - p0;
                    let v2 = p2 - p1;
                    let cross = v1.cross(&v2);
                    let dot = cross.dot(&normal);

                    if dot.abs() > 1e-10 {
                        let current_sign = if dot > 0.0 { 1i8 } else { -1i8 };
                        if sign == 0 {
                            sign = current_sign;
                        } else if sign != current_sign {
                            is_convex = false;
                            break;
                        }
                    }
                }
            }

            if is_convex {
                let mut positions = Vec::with_capacity(n * 3);
                for point in &face.outer_points {
                    positions.push((point.x - rtc.0) as f32);
                    positions.push((point.y - rtc.1) as f32);
                    positions.push((point.z - rtc.2) as f32);
                }
                let mut indices = Vec::with_capacity((n - 2) * 3);
                for i in 1..n - 1 {
                    indices.push(0);
                    indices.push(i as u32);
                    indices.push(i as u32 + 1);
                }
                return FaceResult { positions, indices };
            }
        }

        // SLOW PATH: Complex polygon or polygon with holes
        use crate::triangulation::{
            calculate_polygon_normal, project_to_2d, project_to_2d_with_basis,
            triangulate_polygon_with_holes,
        };

        let mut positions = Vec::new();
        let mut indices = Vec::new();

        // Calculate face normal from outer boundary
        let normal = calculate_polygon_normal(&face.outer_points);

        // Project outer boundary to 2D and get the coordinate system
        let (outer_2d, u_axis, v_axis, origin) = project_to_2d(&face.outer_points, &normal);

        // Project holes to 2D using the SAME coordinate system as the outer boundary
        let holes_2d: Vec<Vec<nalgebra::Point2<f64>>> = face
            .hole_points
            .iter()
            .map(|hole| project_to_2d_with_basis(hole, &u_axis, &v_axis, &origin))
            .collect();

        // Triangulate with holes
        let tri_indices = match triangulate_polygon_with_holes(&outer_2d, &holes_2d) {
            Ok(idx) => idx,
            Err(_) => {
                // Fallback to simple fan triangulation without holes
                for point in &face.outer_points {
                    positions.push((point.x - rtc.0) as f32);
                    positions.push((point.y - rtc.1) as f32);
                    positions.push((point.z - rtc.2) as f32);
                }
                for i in 1..face.outer_points.len() - 1 {
                    indices.push(0);
                    indices.push(i as u32);
                    indices.push(i as u32 + 1);
                }
                return FaceResult { positions, indices };
            }
        };

        // Combine all 3D points (outer + holes) in the same order as 2D
        let mut all_points_3d: Vec<&Point3<f64>> = face.outer_points.iter().collect();
        for hole in &face.hole_points {
            all_points_3d.extend(hole.iter());
        }

        // Add vertices (with RTC subtraction in f64 for full precision)
        for point in &all_points_3d {
            positions.push((point.x - rtc.0) as f32);
            positions.push((point.y - rtc.1) as f32);
            positions.push((point.z - rtc.2) as f32);
        }

        // Add triangle indices
        for i in (0..tri_indices.len()).step_by(3) {
            if i + 2 >= tri_indices.len() {
                break;
            }
            indices.push(tri_indices[i] as u32);
            indices.push(tri_indices[i + 1] as u32);
            indices.push(tri_indices[i + 2] as u32);
        }

        FaceResult { positions, indices }
    }

    /// Batch process multiple FacetedBrep entities for maximum parallelism
    /// Extracts all face data sequentially, then triangulates ALL faces in one parallel batch
    /// Returns Vec of (brep_index, Mesh) pairs.
    /// `rtc`: RTC offset applied during f64→f32 conversion for precision.
    pub fn process_batch(
        &self,
        brep_ids: &[u32],
        decoder: &mut EntityDecoder,
        rtc: (f64, f64, f64),
        large_coord_threshold_file_units: f64,
    ) -> Vec<(usize, Mesh)> {
        use rayon::prelude::*;

        // PHASE 1: Sequential - Extract all face data from all BREPs
        // Each entry: (brep_index, face_data)
        let mut all_faces: Vec<(usize, FaceData)> = Vec::with_capacity(brep_ids.len() * 10);
        let mut raw_large_by_brep = vec![false; brep_ids.len()];

        for (brep_idx, &brep_id) in brep_ids.iter().enumerate() {
            // FAST PATH: Get shell ID directly from raw bytes (avoids full entity decode)
            let shell_id = match decoder.get_first_entity_ref_fast(brep_id) {
                Some(id) => id,
                None => continue,
            };

            // FAST PATH: Get face IDs from shell using raw bytes
            let face_ids = match decoder.get_entity_ref_list_fast(shell_id) {
                Some(ids) => ids,
                None => continue,
            };

            // Extract face data for each face
            for face_id in face_ids {
                let bound_ids = match decoder.get_entity_ref_list_fast(face_id) {
                    Some(ids) => ids,
                    None => continue,
                };

                let mut outer_bound_points: Option<Vec<Point3<f64>>> = None;
                let mut hole_points: Vec<Vec<Point3<f64>>> = Vec::new();

                for bound_id in bound_ids {
                    // FAST PATH: Extract loop_id, orientation, is_outer from raw bytes
                    // get_face_bound_fast returns (loop_id, orientation, is_outer)
                    let (loop_id, orientation, is_outer) =
                        match decoder.get_face_bound_fast(bound_id) {
                            Some(data) => data,
                            None => continue,
                        };

                    // FAST PATH: Get loop points directly from entity ID
                    let mut points = match self.extract_loop_points_fast(loop_id, decoder) {
                        Some(p) => p,
                        None => continue,
                    };

                    if !raw_large_by_brep[brep_idx]
                        && points.iter().any(|point| {
                            point.x.abs().max(point.y.abs()).max(point.z.abs())
                                > large_coord_threshold_file_units
                        })
                    {
                        raw_large_by_brep[brep_idx] = true;
                    }

                    if !orientation {
                        points.reverse();
                    }

                    if is_outer || outer_bound_points.is_none() {
                        if outer_bound_points.is_some() && is_outer {
                            if let Some(prev_outer) = outer_bound_points.take() {
                                hole_points.push(prev_outer);
                            }
                        }
                        outer_bound_points = Some(points);
                    } else {
                        hole_points.push(points);
                    }
                }

                if let Some(outer_points) = outer_bound_points {
                    all_faces.push((
                        brep_idx,
                        FaceData {
                            outer_points,
                            hole_points,
                        },
                    ));
                }
            }
        }

        // PHASE 2: Triangulate ALL faces from ALL BREPs in one parallel batch
        // Uses rayon thread pool on both native and WASM (via wasm-bindgen-rayon)
        let face_results: Vec<(usize, FaceResult)> = all_faces
            .par_iter()
            .map(|(brep_idx, face)| {
                let face_rtc = if raw_large_by_brep[*brep_idx] {
                    rtc
                } else {
                    (0.0, 0.0, 0.0)
                };
                (*brep_idx, Self::triangulate_face(face, face_rtc))
            })
            .collect();

        // PHASE 3: Group results back by BREP index
        // First, count faces per BREP to pre-allocate
        let mut face_counts = vec![0usize; brep_ids.len()];
        for (brep_idx, _) in &face_results {
            face_counts[*brep_idx] += 1;
        }

        // Initialize mesh builders for each BREP
        let mut mesh_builders: Vec<(Vec<f32>, Vec<u32>)> = face_counts
            .iter()
            .map(|&count| {
                (
                    Vec::with_capacity(count * 100),
                    Vec::with_capacity(count * 50),
                )
            })
            .collect();

        // Merge face results into their respective meshes
        for (brep_idx, result) in face_results {
            let (positions, indices) = &mut mesh_builders[brep_idx];
            let base_idx = (positions.len() / 3) as u32;
            positions.extend(result.positions);
            for idx in result.indices {
                indices.push(base_idx + idx);
            }
        }

        // Convert to final meshes
        mesh_builders
            .into_iter()
            .enumerate()
            .filter(|(_, (positions, _))| !positions.is_empty())
            .map(|(brep_idx, (positions, indices))| {
                (
                    brep_idx,
                    Mesh {
                        positions,
                        normals: Vec::new(),
                        indices,
                        // RTC is pre-subtracted only for raw world-coordinate Breps.
                        rtc_applied: raw_large_by_brep[brep_idx]
                            && (rtc.0 != 0.0 || rtc.1 != 0.0 || rtc.2 != 0.0),
                    },
                )
            })
            .collect()
    }
}

impl FacetedBrepProcessor {
    /// Process FacetedBrep with RTC offset applied during f64→f32 conversion.
    /// This preserves sub-centimeter precision for infrastructure models where
    /// vertices have large world coordinates (e.g. Y ≈ 6.2M meters).
    pub fn process_with_rtc(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        rtc: (f64, f64, f64),
    ) -> Result<Mesh> {
        use rayon::prelude::*;

        let shell_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("FacetedBrep missing Outer shell".to_string()))?;
        let shell_id = shell_attr
            .as_entity_ref()
            .ok_or_else(|| Error::geometry("Expected entity ref for Outer shell".to_string()))?;
        let face_ids = decoder
            .get_entity_ref_list_fast(shell_id)
            .ok_or_else(|| Error::geometry("Failed to get faces from ClosedShell".to_string()))?;

        let mut face_data_list: Vec<FaceData> = Vec::with_capacity(face_ids.len());
        for face_id in face_ids {
            let bound_ids = match decoder.get_entity_ref_list_fast(face_id) {
                Some(ids) => ids,
                None => continue,
            };
            let mut outer_bound_points: Option<Vec<Point3<f64>>> = None;
            let mut hole_points: Vec<Vec<Point3<f64>>> = Vec::new();
            for bound_id in bound_ids {
                let (loop_id, orientation, is_outer) = match decoder.get_face_bound_fast(bound_id) {
                    Some(data) => data,
                    None => continue,
                };
                let mut points = match self.extract_loop_points_fast(loop_id, decoder) {
                    Some(p) => p,
                    None => continue,
                };
                if !orientation {
                    points.reverse();
                }
                if is_outer || outer_bound_points.is_none() {
                    if outer_bound_points.is_some() && is_outer {
                        if let Some(prev_outer) = outer_bound_points.take() {
                            hole_points.push(prev_outer);
                        }
                    }
                    outer_bound_points = Some(points);
                } else {
                    hole_points.push(points);
                }
            }
            if let Some(outer_points) = outer_bound_points {
                face_data_list.push(FaceData {
                    outer_points,
                    hole_points,
                });
            }
        }

        let face_results: Vec<FaceResult> = face_data_list
            .par_iter()
            .map(|face| Self::triangulate_face(face, rtc))
            .collect();

        let total_positions: usize = face_results.iter().map(|r| r.positions.len()).sum();
        let total_indices: usize = face_results.iter().map(|r| r.indices.len()).sum();
        let mut positions = Vec::with_capacity(total_positions);
        let mut indices = Vec::with_capacity(total_indices);
        for result in face_results {
            let base_idx = (positions.len() / 3) as u32;
            positions.extend(result.positions);
            for idx in result.indices {
                indices.push(base_idx + idx);
            }
        }
        Ok(Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: true, // RTC already subtracted during f64→f32 conversion
        })
    }
}

impl GeometryProcessor for FacetedBrepProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        use rayon::prelude::*;

        // IfcFacetedBrep attributes:
        // 0: Outer (IfcClosedShell)

        // Get closed shell ID
        let shell_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("FacetedBrep missing Outer shell".to_string()))?;

        let shell_id = shell_attr
            .as_entity_ref()
            .ok_or_else(|| Error::geometry("Expected entity ref for Outer shell".to_string()))?;

        // FAST PATH: Get face IDs directly from ClosedShell raw bytes
        let face_ids = decoder
            .get_entity_ref_list_fast(shell_id)
            .ok_or_else(|| Error::geometry("Failed to get faces from ClosedShell".to_string()))?;

        // PHASE 1: Sequential - Extract all face data from IFC entities
        let mut face_data_list: Vec<FaceData> = Vec::with_capacity(face_ids.len());

        for face_id in face_ids {
            // FAST PATH: Get bound IDs directly from Face raw bytes
            let bound_ids = match decoder.get_entity_ref_list_fast(face_id) {
                Some(ids) => ids,
                None => continue,
            };

            // Separate outer bound from inner bounds (holes)
            let mut outer_bound_points: Option<Vec<Point3<f64>>> = None;
            let mut hole_points: Vec<Vec<Point3<f64>>> = Vec::new();

            for bound_id in bound_ids {
                // FAST PATH: Extract loop_id, orientation, is_outer from raw bytes
                // get_face_bound_fast returns (loop_id, orientation, is_outer)
                let (loop_id, orientation, is_outer) = match decoder.get_face_bound_fast(bound_id) {
                    Some(data) => data,
                    None => continue,
                };

                // FAST PATH: Get loop points directly from entity ID
                let mut points = match self.extract_loop_points_fast(loop_id, decoder) {
                    Some(p) => p,
                    None => continue,
                };

                if !orientation {
                    points.reverse();
                }

                if is_outer || outer_bound_points.is_none() {
                    if outer_bound_points.is_some() && is_outer {
                        if let Some(prev_outer) = outer_bound_points.take() {
                            hole_points.push(prev_outer);
                        }
                    }
                    outer_bound_points = Some(points);
                } else {
                    hole_points.push(points);
                }
            }

            if let Some(outer_points) = outer_bound_points {
                face_data_list.push(FaceData {
                    outer_points,
                    hole_points,
                });
            }
        }

        // PHASE 2: Triangulate all faces in parallel (via rayon on both native and WASM)
        // Standard processor path uses no RTC (0,0,0) — the router applies RTC
        // via transform_mesh. For full-precision infra models, the router calls
        // process_with_rtc instead which passes the actual offset.
        let face_results: Vec<FaceResult> = face_data_list
            .par_iter()
            .map(|face| Self::triangulate_face(face, (0.0, 0.0, 0.0)))
            .collect();

        // PHASE 3: Sequential - Merge all face results into final mesh
        // Pre-calculate total sizes for efficient allocation
        let total_positions: usize = face_results.iter().map(|r| r.positions.len()).sum();
        let total_indices: usize = face_results.iter().map(|r| r.indices.len()).sum();

        let mut positions = Vec::with_capacity(total_positions);
        let mut indices = Vec::with_capacity(total_indices);

        for result in face_results {
            let base_idx = (positions.len() / 3) as u32;
            positions.extend(result.positions);

            // Offset indices by base
            for idx in result.indices {
                indices.push(base_idx + idx);
            }
        }

        Ok(Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
        })
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcFacetedBrep]
    }
}

impl Default for FacetedBrepProcessor {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- FaceBasedSurfaceModelProcessor ----------

/// FaceBasedSurfaceModel processor
/// Handles IfcFaceBasedSurfaceModel - surface model made of connected face sets
///
/// Supports two face types within connected face sets:
/// - Simple faces with IfcPolyLoop bounds (standard BRep from most exporters)
/// - IfcAdvancedFace with B-spline/planar/cylindrical surfaces (CATIA, NURBS exports)
///
/// Structure (simple): FaceBasedSurfaceModel -> ConnectedFaceSet[] -> Face[] -> FaceBound -> PolyLoop
/// Structure (advanced): FaceBasedSurfaceModel -> ConnectedFaceSet[] -> AdvancedFace[] -> FaceSurface
pub struct FaceBasedSurfaceModelProcessor;

impl FaceBasedSurfaceModelProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl GeometryProcessor for FaceBasedSurfaceModelProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        // IfcFaceBasedSurfaceModel attributes:
        // 0: FbsmFaces (SET of IfcConnectedFaceSet)

        let faces_attr = entity.get(0).ok_or_else(|| {
            Error::geometry("FaceBasedSurfaceModel missing FbsmFaces".to_string())
        })?;

        let face_set_refs = faces_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected face set list".to_string()))?;

        let mut all_positions = Vec::new();
        let mut all_indices = Vec::new();

        // Process each connected face set
        for face_set_ref in face_set_refs {
            let face_set_id = face_set_ref.as_entity_ref().ok_or_else(|| {
                Error::geometry("Expected entity reference for face set".to_string())
            })?;

            // Get face IDs from ConnectedFaceSet
            let face_ids = match decoder.get_entity_ref_list_fast(face_set_id) {
                Some(ids) => ids,
                None => continue,
            };

            // Process each face in the set
            for face_id in face_ids {
                // Decode the face entity to check its type.
                // Some exporters use IfcAdvancedFace within ConnectedFaceSet,
                // which requires B-spline surface processing.
                let face = match decoder.decode_by_id(face_id) {
                    Ok(f) => f,
                    Err(_) => continue,
                };

                if face.ifc_type == IfcType::IfcAdvancedFace {
                    // Advanced face: delegate to shared NURBS/planar/cylindrical handler
                    let (positions, indices) = match process_advanced_face(&face, decoder) {
                        Ok(result) => result,
                        Err(_) => continue,
                    };

                    if !positions.is_empty() {
                        let base_idx = (all_positions.len() / 3) as u32;
                        all_positions.extend(positions);
                        for idx in indices {
                            all_indices.push(base_idx + idx);
                        }
                    }
                } else {
                    // Simple face: extract PolyLoop points via fast path
                    let bound_ids = match decoder.get_entity_ref_list_fast(face_id) {
                        Some(ids) => ids,
                        None => continue,
                    };

                    let mut outer_points: Option<Vec<Point3<f64>>> = None;
                    let mut hole_points: Vec<Vec<Point3<f64>>> = Vec::new();

                    for bound_id in bound_ids {
                        // FAST PATH: Extract loop_id, orientation, is_outer from raw bytes
                        // get_face_bound_fast returns (loop_id, orientation, is_outer)
                        let (loop_id, orientation, is_outer) =
                            match decoder.get_face_bound_fast(bound_id) {
                                Some(data) => data,
                                None => continue,
                            };

                        // Get loop points using shared helper
                        let mut points = match extract_loop_points_by_id(loop_id, decoder) {
                            Some(p) => p,
                            None => continue,
                        };

                        if !orientation {
                            points.reverse();
                        }

                        if is_outer || outer_points.is_none() {
                            outer_points = Some(points);
                        } else {
                            hole_points.push(points);
                        }
                    }

                    // Triangulate the face
                    if let Some(outer) = outer_points {
                        if outer.len() >= 3 {
                            let base_idx = (all_positions.len() / 3) as u32;

                            // Add positions
                            for p in &outer {
                                all_positions.push(p.x as f32);
                                all_positions.push(p.y as f32);
                                all_positions.push(p.z as f32);
                            }

                            // Simple fan triangulation (works for convex faces)
                            for i in 1..outer.len() - 1 {
                                all_indices.push(base_idx);
                                all_indices.push(base_idx + i as u32);
                                all_indices.push(base_idx + i as u32 + 1);
                            }
                        }
                    }
                }
            }
        }

        Ok(Mesh {
            positions: all_positions,
            normals: Vec::new(),
            indices: all_indices,
            rtc_applied: false,
        })
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcFaceBasedSurfaceModel]
    }
}

impl Default for FaceBasedSurfaceModelProcessor {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- ShellBasedSurfaceModelProcessor ----------

/// ShellBasedSurfaceModel processor
/// Handles IfcShellBasedSurfaceModel - surface model made of shells
///
/// Supports two face types within shells:
/// - Simple faces with IfcPolyLoop bounds (standard BRep from most exporters)
/// - IfcAdvancedFace with B-spline/planar/cylindrical surfaces (CATIA, NURBS exports)
///
/// Structure (simple): ShellBasedSurfaceModel -> Shell[] -> Face[] -> FaceBound -> PolyLoop
/// Structure (advanced): ShellBasedSurfaceModel -> Shell[] -> AdvancedFace[] -> FaceSurface
pub struct ShellBasedSurfaceModelProcessor;

impl ShellBasedSurfaceModelProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl GeometryProcessor for ShellBasedSurfaceModelProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        // IfcShellBasedSurfaceModel attributes:
        // 0: SbsmBoundary (SET of IfcShell - either IfcOpenShell or IfcClosedShell)

        let shells_attr = entity.get(0).ok_or_else(|| {
            Error::geometry("ShellBasedSurfaceModel missing SbsmBoundary".to_string())
        })?;

        let shell_refs = shells_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected shell list".to_string()))?;

        let mut all_positions = Vec::new();
        let mut all_indices = Vec::new();

        // Process each shell
        for shell_ref in shell_refs {
            let shell_id = shell_ref.as_entity_ref().ok_or_else(|| {
                Error::geometry("Expected entity reference for shell".to_string())
            })?;

            // Get face IDs from Shell (IfcOpenShell or IfcClosedShell)
            // Both have CfsFaces as attribute 0
            let face_ids = match decoder.get_entity_ref_list_fast(shell_id) {
                Some(ids) => ids,
                None => continue,
            };

            // Process each face in the shell
            for face_id in face_ids {
                // Decode the face entity to check its type.
                // CATIA and other NURBS-based exporters use IfcAdvancedFace within
                // IfcOpenShell/IfcClosedShell, which requires B-spline surface processing
                // instead of simple PolyLoop extraction.
                let face = match decoder.decode_by_id(face_id) {
                    Ok(f) => f,
                    Err(_) => continue,
                };

                if face.ifc_type == IfcType::IfcAdvancedFace {
                    // Advanced face: delegate to shared NURBS/planar/cylindrical handler
                    let (positions, indices) = match process_advanced_face(&face, decoder) {
                        Ok(result) => result,
                        Err(_) => continue,
                    };

                    if !positions.is_empty() {
                        let base_idx = (all_positions.len() / 3) as u32;
                        all_positions.extend(positions);
                        for idx in indices {
                            all_indices.push(base_idx + idx);
                        }
                    }
                } else {
                    // Simple face: extract PolyLoop points via fast path
                    let bound_ids = match decoder.get_entity_ref_list_fast(face_id) {
                        Some(ids) => ids,
                        None => continue,
                    };

                    let mut outer_points: Option<Vec<Point3<f64>>> = None;
                    let mut hole_points: Vec<Vec<Point3<f64>>> = Vec::new();

                    for bound_id in bound_ids {
                        // FAST PATH: Extract loop_id, orientation, is_outer from raw bytes
                        let (loop_id, orientation, is_outer) =
                            match decoder.get_face_bound_fast(bound_id) {
                                Some(data) => data,
                                None => continue,
                            };

                        // Get loop points using shared helper
                        let mut points = match extract_loop_points_by_id(loop_id, decoder) {
                            Some(p) => p,
                            None => continue,
                        };

                        if !orientation {
                            points.reverse();
                        }

                        if is_outer || outer_points.is_none() {
                            outer_points = Some(points);
                        } else {
                            hole_points.push(points);
                        }
                    }

                    // Triangulate the face
                    if let Some(outer) = outer_points {
                        if outer.len() >= 3 {
                            let base_idx = (all_positions.len() / 3) as u32;

                            // Add positions
                            for p in &outer {
                                all_positions.push(p.x as f32);
                                all_positions.push(p.y as f32);
                                all_positions.push(p.z as f32);
                            }

                            // Simple fan triangulation (works for convex faces)
                            for i in 1..outer.len() - 1 {
                                all_indices.push(base_idx);
                                all_indices.push(base_idx + i as u32);
                                all_indices.push(base_idx + i as u32 + 1);
                            }
                        }
                    }
                }
            }
        }

        Ok(Mesh {
            positions: all_positions,
            normals: Vec::new(),
            indices: all_indices,
            rtc_applied: false,
        })
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcShellBasedSurfaceModel]
    }
}

impl Default for ShellBasedSurfaceModelProcessor {
    fn default() -> Self {
        Self::new()
    }
}
