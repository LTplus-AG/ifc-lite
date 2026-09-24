// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Error, Mesh, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::super::advanced_face::process_advanced_face;
use super::super::helpers::{extract_loop_points_by_id, FaceData};
use super::faceted::FacetedBrepProcessor;
use crate::router::GeometryProcessor;

/// A dropped `IfcAdvancedFace` (unsupported surface, or a #4901 degree/work
/// cap) has nowhere else to go here — neither processor has a
/// `GeometryRouter` for `record_unsupported_item`. This trace is the honest
/// floor. `allow`: `diag_debug!` no-ops without a tracing subscriber (wasm
/// release), leaving both params unused there.
#[allow(unused_variables)]
fn trace_capped_face(face_id: u32, error: &Error) {
    crate::diag::diag_debug!(
        { face_id, error = %error, "skipping unsupported advanced face in surface model" }
        else {
            #[cfg(debug_assertions)]
            eprintln!("[ifc-lite] Skipping unsupported advanced face #{face_id} in surface model: {error}");
        }
    );
}

/// Mesh every face of a surface model's face collections.
///
/// `IfcFaceBasedSurfaceModel.FbsmFaces` (connected face sets) and
/// `IfcShellBasedSurfaceModel.SbsmBoundary` (open/closed shells) both hold
/// references to entities whose attribute 0 is the face list, so one walk
/// serves both. Two face kinds are supported:
/// - simple faces with `IfcPolyLoop` bounds (standard BRep from most exporters)
/// - `IfcAdvancedFace` with B-spline/planar/cylindrical surfaces (CATIA, NURBS)
///
/// With `rtc_file_units`, every face subtracts the offset from its f64
/// coordinates BEFORE narrowing to f32, so national-grid surface models keep
/// detail below one f32 ULP (#5698); `None` is the historical output.
fn mesh_face_collections(
    collections: &[ifc_lite_core::AttributeValue],
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
    collection_noun: &str,
) -> Result<Mesh> {
    let mut all_positions = Vec::new();
    let mut all_indices = Vec::new();

    for collection_ref in collections {
        let collection_id = collection_ref.as_entity_ref().ok_or_else(|| {
            Error::geometry(format!("Expected entity reference for {collection_noun}"))
        })?;

        // Face IDs straight from the collection's raw bytes (attribute 0)
        let face_ids = match decoder.get_entity_ref_list_fast(collection_id) {
            Some(ids) => ids,
            None => continue,
        };

        for face_id in face_ids {
            // Decode the face entity to check its type: some exporters use
            // IfcAdvancedFace here, which requires surface processing.
            let face = match decoder.decode_by_id(face_id) {
                Ok(f) => f,
                Err(_) => continue,
            };

            if face.ifc_type == IfcType::IfcAdvancedFace {
                // Advanced face: delegate to shared NURBS/planar/cylindrical handler.
                // A capped B-spline curve EDGE (#4901) inside a still-OK
                // face is deliberately NOT drained here: this processor
                // is always reached through `GeometryRouter` (the
                // processor registry / mapped-item dispatch), and those
                // call sites own the single authoritative drain. Racing
                // them for the same thread-local flag here always won
                // (this runs first), silently swallowing the router's
                // typed diagnostic (caught in review).
                let (positions, indices) =
                    match process_advanced_face(&face, decoder, quality, rtc_file_units) {
                        Ok(result) => result,
                        Err(ref e) => {
                            trace_capped_face(face.id, e);
                            continue;
                        }
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
                    // (loop_id, orientation, is_outer) straight from raw bytes
                    let (loop_id, orientation, is_outer) =
                        match decoder.get_face_bound_fast(bound_id) {
                            Some(data) => data,
                            None => continue,
                        };

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
                            rtc_file_units.unwrap_or((0.0, 0.0, 0.0)),
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
        rtc_applied: rtc_file_units.is_some(),
        welded_in_object_frame: false,
        plane_tags: None,
        origin: [0.0; 3],
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
    })
}

/// Mesh a surface model whose attribute 0 lists its face collections.
/// `names` is the (missing-attribute message, collection noun) for errors.
fn mesh_surface_model(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
    names: (&str, &str),
) -> Result<Mesh> {
    let (missing_attribute, collection) = names;
    let collections = entity
        .get(0)
        .ok_or_else(|| Error::geometry(missing_attribute.to_string()))?
        .as_list()
        .ok_or_else(|| Error::geometry(format!("Expected {collection} list")))?;
    mesh_face_collections(collections, decoder, quality, rtc_file_units, collection)
}

// ---------- FaceBasedSurfaceModelProcessor ----------

/// Handles `IfcFaceBasedSurfaceModel`: FbsmFaces (SET of IfcConnectedFaceSet)
/// -> Face[] -> FaceBound -> PolyLoop, or AdvancedFace[] -> FaceSurface.
pub struct FaceBasedSurfaceModelProcessor;

impl FaceBasedSurfaceModelProcessor {
    const NAMES: (&'static str, &'static str) =
        ("FaceBasedSurfaceModel missing FbsmFaces", "face set");

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
        mesh_surface_model(entity, decoder, quality, None, Self::NAMES)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(mesh_surface_model(
            entity,
            decoder,
            quality,
            Some(rtc_file_units),
            Self::NAMES,
        ))
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

/// Handles `IfcShellBasedSurfaceModel`: SbsmBoundary (SET of IfcOpenShell /
/// IfcClosedShell) -> Face[] -> FaceBound -> PolyLoop, or AdvancedFace[] ->
/// FaceSurface.
pub struct ShellBasedSurfaceModelProcessor;

impl ShellBasedSurfaceModelProcessor {
    const NAMES: (&'static str, &'static str) =
        ("ShellBasedSurfaceModel missing SbsmBoundary", "shell");

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
        mesh_surface_model(entity, decoder, quality, None, Self::NAMES)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(mesh_surface_model(
            entity,
            decoder,
            quality,
            Some(rtc_file_units),
            Self::NAMES,
        ))
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
