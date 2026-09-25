// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! AdvancedBrep processor - NURBS/B-spline surfaces.
//!
//! Handles IfcAdvancedBrep and IfcAdvancedBrepWithVoids.
//! Delegates per-face processing to shared advanced_face module.

use crate::{Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use crate::router::GeometryProcessor;
use super::advanced_face::{
    parse_rational_weights, process_advanced_face, process_bspline_face,
};

/// A face that fails to triangulate (e.g. an un-triangulable holed planar
/// face, #5053) is skipped rather than aborting the whole solid, mirroring
/// `FaceBasedSurfaceModelProcessor::process` in `brep/surface_model.rs`.
/// `allow`: `diag_debug!` no-ops without a tracing subscriber (wasm
/// release), leaving both params unused there. No legacy `eprintln!`
/// fallback: this is a recovery path, not an anomaly, so it must stay
/// silent on stderr in normal (non-`observability`) builds — see the
/// `diag_debug!` docs on passing an empty `else {}` to compile out
/// entirely.
#[allow(unused_variables)]
fn trace_capped_advanced_brep_face(face_id: u32, error: &Error) {
    crate::diag::diag_debug!(
        { face_id, error = %error, "skipping unsupported advanced face in advanced_brep" }
        else {}
    );
}

/// AdvancedBrep processor
/// Handles IfcAdvancedBrep and IfcAdvancedBrepWithVoids - NURBS/B-spline surfaces
/// Supports planar faces and B-spline surface tessellation
pub struct AdvancedBrepProcessor;

impl AdvancedBrepProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl AdvancedBrepProcessor {
    /// Mesh the Brep; `rtc_file_units` is removed from every face in f64
    /// before f32 narrowing (#5698).
    fn process_rebased(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        // IfcAdvancedBrep attributes:
        // 0: Outer (IfcClosedShell)

        // Get the outer shell
        let shell_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("AdvancedBrep missing Outer shell".to_string()))?;

        let shell = decoder
            .resolve_ref(shell_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Outer shell".to_string()))?;

        // Get faces from the shell (IfcClosedShell.CfsFaces)
        let faces_attr = shell
            .get(0)
            .ok_or_else(|| Error::geometry("ClosedShell missing CfsFaces".to_string()))?;

        let faces = faces_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected face list".to_string()))?;

        let mut all_positions = Vec::new();
        let mut all_indices = Vec::new();

        #[cfg(any(feature = "debug_geometry", feature = "observability"))]
        let mut empty_faces: Vec<(u32, String)> = Vec::new();

        for face_ref in faces {
            if let Some(face_id) = face_ref.as_entity_ref() {
                let face = decoder.decode_by_id(face_id)?;

                // Delegate to shared advanced face processing. A face that
                // fails (rather than one that meshes to nothing) is caught
                // and skipped here too, so one un-triangulable holed face
                // degrades to a per-face loss instead of aborting the whole
                // solid (#5053) — and is still recorded in `empty_faces`
                // below so the loss isn't silent.
                let face_mesh = process_advanced_face(&face, decoder, quality, rtc_file_units);
                let (positions, indices) = match face_mesh {
                    Ok(result) => result,
                    Err(ref e) => {
                        trace_capped_advanced_brep_face(face_id, e);
                        #[cfg(any(feature = "debug_geometry", feature = "observability"))]
                        {
                            let surface_kind = face
                                .get(1)
                                .and_then(|a| decoder.resolve_ref(a).ok().flatten())
                                .map(|s| s.ifc_type.as_str().to_string())
                                .unwrap_or_else(|| "<unknown>".to_string());
                            empty_faces.push((face_id, surface_kind));
                        }
                        continue;
                    }
                };

                if !positions.is_empty() {
                    // Merge into combined mesh
                    let base_idx = (all_positions.len() / 3) as u32;
                    all_positions.extend(positions);
                    for idx in indices {
                        all_indices.push(base_idx + idx);
                    }
                } else {
                    #[cfg(any(feature = "debug_geometry", feature = "observability"))]
                    {
                        let surface_kind = face
                            .get(1)
                            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
                            .map(|s| s.ifc_type.as_str().to_string())
                            .unwrap_or_else(|| "<unknown>".to_string());
                        empty_faces.push((face_id, surface_kind));
                    }
                }
            }
        }

        // Geometry loss on an advanced brep (faces that meshed to nothing) is
        // a genuine anomaly: warn-level under observability. The legacy
        // stderr line stays gated behind debug_geometry as before.
        #[cfg(any(feature = "debug_geometry", feature = "observability"))]
        if !empty_faces.is_empty() {
            crate::diag::diag_warn!(
                { entity_id = entity.id, empty_faces = empty_faces.len(),
                  faces = ?empty_faces, "advanced_brep: entity produced empty faces" }
                else {
                    #[cfg(feature = "debug_geometry")]
                    eprintln!(
                        "[ifc-lite][advanced_brep] entity #{} produced {} empty face(s): {:?}",
                        entity.id,
                        empty_faces.len(),
                        empty_faces
                    );
                }
            );
        }

        Ok(Mesh {
            positions: all_positions,
            normals: Vec::new(),
            indices: all_indices,
            rtc_applied: rtc_file_units.is_some(),
            welded_in_object_frame: false,
            plane_tags: None,
            origin: [0.0; 3],        instance_meta: None, local_bounds: None, local_to_world: None })
    }
}

impl GeometryProcessor for AdvancedBrepProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        Self::process_rebased(entity, decoder, quality, None)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(Self::process_rebased(entity, decoder, quality, Some(rtc_file_units)))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcAdvancedBrep, IfcType::IfcAdvancedBrepWithVoids]
    }
}

impl Default for AdvancedBrepProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Standalone B-spline surface processor.
///
/// Handles `IfcBSplineSurfaceWithKnots` and `IfcRationalBSplineSurfaceWithKnots`
/// when they appear directly as items inside an `IfcShapeRepresentation` (e.g.
/// a `Surface3D` rep), without being wrapped in an `IfcAdvancedFace`.
pub struct BSplineSurfaceProcessor;

impl BSplineSurfaceProcessor {
    pub fn new() -> Self {
        Self
    }

    /// Mesh the surface; `rtc_file_units` shifts the control net in f64
    /// before f32 narrowing (#5698).
    fn process_rebased(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        let weights = if entity.ifc_type == IfcType::IfcRationalBSplineSurfaceWithKnots {
            parse_rational_weights(entity)
        } else {
            None
        };
        let (positions, indices) = process_bspline_face(
            entity,
            decoder,
            weights.as_deref(),
            quality,
            rtc_file_units.unwrap_or((0.0, 0.0, 0.0)),
        )?;
        Ok(Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: rtc_file_units.is_some(),
            welded_in_object_frame: false,
            plane_tags: None,
            origin: [0.0; 3],
            instance_meta: None,
            local_bounds: None,
            local_to_world: None,
        })
    }
}

impl Default for BSplineSurfaceProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for BSplineSurfaceProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        Self::process_rebased(entity, decoder, quality, None)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(Self::process_rebased(entity, decoder, quality, Some(rtc_file_units)))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![
            IfcType::IfcBSplineSurfaceWithKnots,
            IfcType::IfcRationalBSplineSurfaceWithKnots,
        ]
    }
}
