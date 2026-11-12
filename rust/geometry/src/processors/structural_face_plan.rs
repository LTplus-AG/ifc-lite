// SPDX-License-Identifier: MPL-2.0
//! Standalone planar surface topology before triangle construction.
use super::advanced_face::{lower_planar_regions, FacePlan};
use crate::{Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

#[derive(Debug, Clone)]
pub(crate) struct StructuralFacePlan {
    faces: Vec<FacePlan>,
    rtc_applied: bool,
}

/// Whether a structural face is planar: a bare `IfcFace`, or a face surface on
/// an `IfcPlane` or an `IfcCurveBoundedPlane` over one (AxisVM, #9668).
fn is_planar(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<bool> {
    if entity.ifc_type == IfcType::IfcFace {
        return Ok(true);
    }
    let surface_attribute = entity
        .get(slot::IfcFaceSurface::FACE_SURFACE.index())
        .ok_or_else(|| Error::geometry("FaceSurface missing FaceSurface"))?;
    let surface = decoder
        .resolve_ref(surface_attribute)?
        .ok_or_else(|| Error::geometry("Failed to resolve FaceSurface"))?;
    if surface.ifc_type != IfcType::IfcCurveBoundedPlane {
        return Ok(surface.ifc_type == IfcType::IfcPlane);
    }
    let basis = surface.get(slot::IfcCurveBoundedPlane::BASIS_SURFACE.index());
    Ok(match basis {
        Some(attribute) => decoder.resolve_ref(attribute)?.is_some_and(|b| b.ifc_type == IfcType::IfcPlane),
        None => false,
    })
}

pub(crate) fn lower(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<StructuralFacePlan> {
    if !is_planar(entity, decoder)? {
        return Ok(StructuralFacePlan {
            faces: Vec::new(),
            rtc_applied: false,
        });
    }
    // Loop winding already expresses the planar face normal, including when
    // SameSense is false. The generic face plan retains that production rule.
    Ok(StructuralFacePlan {
        faces: lower_planar_regions(entity, decoder, quality, rtc_file_units)?,
        rtc_applied: rtc_file_units.is_some(),
    })
}
impl StructuralFacePlan {
    pub(crate) fn evaluate(self) -> Result<Mesh> {
        let mut mesh = Mesh::new();
        for face in self.faces {
            let (positions, indices) = face.evaluate()?;
            let base = (mesh.positions.len() / 3) as u32;
            mesh.positions.extend(positions);
            mesh.indices.extend(indices.into_iter().map(|i| i + base));
        }
        mesh.rtc_applied = self.rtc_applied;
        Ok(mesh)
    }
}

#[cfg(test)]
#[path = "structural_face_plan_tests.rs"]
mod tests;
