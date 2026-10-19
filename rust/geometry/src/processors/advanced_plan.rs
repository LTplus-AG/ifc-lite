// SPDX-License-Identifier: MPL-2.0
//! Owned advanced-shell faces and standalone spline surface construction.
use super::advanced_face::{
    lower_bspline, lower_face, note_face_refused, parse_rational_weights, BSplinePlan, FacePlan,
};
use crate::{Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

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

#[derive(Debug, Clone)]
pub(crate) struct AdvancedBrepPlan {
    faces: Vec<FaceEntry>,
    rtc_applied: bool,
    #[cfg(any(feature = "debug_geometry", feature = "observability"))]
    entity_id: u32,
}
#[derive(Debug, Clone)]
struct FaceEntry {
    id: u32,
    plan: Option<FacePlan>,
    #[cfg(any(feature = "debug_geometry", feature = "observability"))]
    surface_kind: String,
}

pub(crate) fn lower_brep(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<AdvancedBrepPlan> {
    let shell_attr = entity
        .get(slot::IfcManifoldSolidBrep::OUTER.index())
        .ok_or_else(|| Error::geometry("AdvancedBrep missing Outer shell".to_string()))?;
    let shell = decoder
        .resolve_ref(shell_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve Outer shell".to_string()))?;
    let faces_attr = shell
        .get(slot::IfcConnectedFaceSet::CFS_FACES.index())
        .ok_or_else(|| Error::geometry("ClosedShell missing CfsFaces".to_string()))?;
    let faces = faces_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected face list".to_string()))?;
    let mut plans = Vec::new();
    for face_ref in faces {
        let Some(id) = face_ref.as_entity_ref() else {
            continue;
        };
        let face = match decoder.decode_by_id(id) {
            Ok(face) => face,
            Err(_) => {
                note_face_refused(&IfcType::IfcAdvancedFace);
                plans.push(FaceEntry {
                    id,
                    plan: None,
                    #[cfg(any(feature = "debug_geometry", feature = "observability"))]
                    surface_kind: "<unresolved>".to_string(),
                });
                continue;
            }
        };
        let plan = match lower_face(&face, decoder, quality, rtc_file_units) {
            Ok(plan) => Some(plan),
            Err(ref error) => {
                trace_capped_advanced_brep_face(id, error);
                None
            }
        };
        #[cfg(any(feature = "debug_geometry", feature = "observability"))]
        let surface_kind = match &plan {
            Some(plan) => plan.surface_kind().to_owned(),
            None => face
                .get(slot::IfcFaceSurface::FACE_SURFACE.index())
                .and_then(|a| decoder.resolve_ref(a).ok().flatten())
                .map(|s| s.ifc_type.as_str().to_string())
                .unwrap_or_else(|| "<unknown>".to_string()),
        };
        plans.push(FaceEntry {
            id,
            plan,
            #[cfg(any(feature = "debug_geometry", feature = "observability"))]
            surface_kind,
        });
    }
    Ok(AdvancedBrepPlan {
        faces: plans,
        rtc_applied: rtc_file_units.is_some(),
        #[cfg(any(feature = "debug_geometry", feature = "observability"))]
        entity_id: entity.id,
    })
}

impl AdvancedBrepPlan {
    pub(crate) fn evaluate(self) -> Result<Mesh> {
        let mut mesh = Mesh::new();
        mesh.rtc_applied = self.rtc_applied;
        #[cfg(any(feature = "debug_geometry", feature = "observability"))]
        let mut empty_faces = Vec::new();
        for entry in self.faces {
            let result = entry.plan.map(FacePlan::evaluate);
            let geometry = match result {
                Some(Ok((positions, indices))) if !positions.is_empty() => {
                    Some((positions, indices))
                }
                Some(Err(ref error)) => {
                    trace_capped_advanced_brep_face(entry.id, error);
                    None
                }
                _ => None,
            };
            if let Some((positions, indices)) = geometry {
                let base_idx = (mesh.positions.len() / 3) as u32;
                mesh.positions.extend(positions);
                mesh.indices
                    .extend(indices.into_iter().map(|index| base_idx + index));
            } else {
                #[cfg(any(feature = "debug_geometry", feature = "observability"))]
                empty_faces.push((entry.id, entry.surface_kind));
            }
        }
        #[cfg(any(feature = "debug_geometry", feature = "observability"))]
        if !empty_faces.is_empty() {
            crate::diag::diag_warn!(
                { entity_id = self.entity_id, empty_faces = empty_faces.len(),
                  faces = ?empty_faces, "advanced_brep: entity produced empty faces" }
                else {
                    #[cfg(feature = "debug_geometry")]
                    eprintln!("[ifc-lite][advanced_brep] entity #{} produced {} empty face(s): {:?}",
                        self.entity_id, empty_faces.len(), empty_faces);
                }
            );
        }
        Ok(mesh)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct BSplineSurfacePlan {
    surface: BSplinePlan,
    rtc_applied: bool,
}
pub(crate) fn lower_bspline_surface(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<BSplineSurfacePlan> {
    let weights = if entity.ifc_type == IfcType::IfcRationalBSplineSurfaceWithKnots {
        Some(parse_rational_weights(entity)?)
    } else {
        None
    };
    let surface = lower_bspline(
        entity,
        decoder,
        weights.as_deref(),
        quality,
        rtc_file_units.unwrap_or((0.0, 0.0, 0.0)),
    )?;
    Ok(BSplineSurfacePlan {
        surface,
        rtc_applied: rtc_file_units.is_some(),
    })
}
impl BSplineSurfacePlan {
    pub(crate) fn evaluate(self) -> Result<Mesh> {
        let (positions, indices) = self.surface.evaluate()?;
        let mut mesh = Mesh::new();
        mesh.positions = positions;
        mesh.indices = indices;
        mesh.rtc_applied = self.rtc_applied;
        Ok(mesh)
    }
}

#[cfg(test)]
#[path = "advanced_plan_tests.rs"]
mod tests;
