// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Error, Mesh, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::super::advanced_face::process_advanced_face;
use super::super::helpers::{extract_loop_points_by_id, FaceData};
use super::faceted::FacetedBrepProcessor;
use crate::router::GeometryProcessor;

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
        quality: TessellationQuality,
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
                    let (positions, indices) = match process_advanced_face(&face, decoder, quality) {
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
                            // A second outer bound demotes the previous one to a
                            // hole rather than dropping it (parity with
                            // FacetedBrepProcessor); a face is otherwise lost.
                            if outer_points.is_some() && is_outer {
                                if let Some(prev_outer) = outer_points.take() {
                                    hole_points.push(prev_outer);
                                }
                            }
                            outer_points = Some(points);
                        } else {
                            hole_points.push(points);
                        }
                    }

                    // Triangulate the face through the shared FacetedBrep face
                    // triangulator (tri/quad fast paths, convexity test, and
                    // ear-clipping with hole support). The previous naive fan
                    // here mis-triangulated CONCAVE faces — fan triangles from
                    // vertex 0 sweep ACROSS the concavity, rendering folded
                    // sheet-metal profiles (schependomlaan "zinkwerk" covering
                    // flashings, serpentine 30-vertex end-cap loops) as
                    // stretched diagonal flaps with up to 2.4x the authored
                    // surface area — and silently dropped hole bounds.
                    if let Some(outer) = outer_points {
                        if outer.len() >= 3 {
                            let face_data = FaceData {
                                outer_points: outer,
                                hole_points,
                            };
                            let result = FacetedBrepProcessor::triangulate_face(
                                &face_data,
                                (0.0, 0.0, 0.0),
                            );
                            let base_idx = (all_positions.len() / 3) as u32;
                            all_positions.extend(result.positions);
                            for idx in result.indices {
                                all_indices.push(base_idx + idx);
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
            origin: [0.0; 3],        instance_meta: None, })
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
        quality: TessellationQuality,
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
                    let (positions, indices) = match process_advanced_face(&face, decoder, quality) {
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
                            // A second outer bound demotes the previous one to a
                            // hole rather than dropping it (parity with
                            // FacetedBrepProcessor); a face is otherwise lost.
                            if outer_points.is_some() && is_outer {
                                if let Some(prev_outer) = outer_points.take() {
                                    hole_points.push(prev_outer);
                                }
                            }
                            outer_points = Some(points);
                        } else {
                            hole_points.push(points);
                        }
                    }

                    // Triangulate the face through the shared FacetedBrep face
                    // triangulator (tri/quad fast paths, convexity test, and
                    // ear-clipping with hole support). The previous naive fan
                    // here mis-triangulated CONCAVE faces — fan triangles from
                    // vertex 0 sweep ACROSS the concavity, rendering folded
                    // sheet-metal profiles (schependomlaan "zinkwerk" covering
                    // flashings, serpentine 30-vertex end-cap loops) as
                    // stretched diagonal flaps with up to 2.4x the authored
                    // surface area — and silently dropped hole bounds.
                    if let Some(outer) = outer_points {
                        if outer.len() >= 3 {
                            let face_data = FaceData {
                                outer_points: outer,
                                hole_points,
                            };
                            let result = FacetedBrepProcessor::triangulate_face(
                                &face_data,
                                (0.0, 0.0, 0.0),
                            );
                            let base_idx = (all_positions.len() / 3) as u32;
                            all_positions.extend(result.positions);
                            for idx in result.indices {
                                all_indices.push(base_idx + idx);
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
            origin: [0.0; 3],        instance_meta: None, })
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
