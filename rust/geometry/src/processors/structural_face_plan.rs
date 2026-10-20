// SPDX-License-Identifier: MPL-2.0
//! Standalone planar surface topology before triangle construction.
use super::advanced_face::{lower_face, FacePlan};
use crate::{Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

#[derive(Debug, Clone)]
pub(crate) struct StructuralFacePlan {
    face: Option<FacePlan>,
    rtc_applied: bool,
}

pub(crate) fn lower(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<StructuralFacePlan> {
    let surface_attribute = entity
        .get(slot::IfcFaceSurface::FACE_SURFACE.index())
        .ok_or_else(|| Error::geometry("FaceSurface missing FaceSurface"))?;
    let surface = decoder
        .resolve_ref(surface_attribute)?
        .ok_or_else(|| Error::geometry("Failed to resolve FaceSurface"))?;
    if surface.ifc_type != IfcType::IfcPlane {
        return Ok(StructuralFacePlan {
            face: None,
            rtc_applied: false,
        });
    }
    // Loop winding already expresses the planar face normal, including when
    // SameSense is false. The generic face plan retains that production rule.
    let face = lower_face(entity, decoder, quality, rtc_file_units)?;
    Ok(StructuralFacePlan {
        face: Some(face),
        rtc_applied: rtc_file_units.is_some(),
    })
}
impl StructuralFacePlan {
    pub(crate) fn evaluate(self) -> Result<Mesh> {
        let mut mesh = Mesh::new();
        if let Some(face) = self.face {
            let (positions, indices) = face.evaluate()?;
            mesh.positions = positions;
            mesh.indices = indices;
        }
        mesh.rtc_applied = self.rtc_applied;
        Ok(mesh)
    }
}

#[cfg(test)]
#[path = "structural_face_plan_tests.rs"]
mod tests;
