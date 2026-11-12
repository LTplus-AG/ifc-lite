// SPDX-License-Identifier: MPL-2.0
//! Standalone planar surface topology before triangle construction.
use super::advanced_face::{lower_face, lower_planar_regions, FacePlan};
use crate::{Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

#[derive(Debug, Clone)]
pub(crate) struct StructuralFacePlan {
    /// One plan for an ordinary face; one per region for a member face.
    faces: smallvec::SmallVec<[FacePlan; 1]>,
    rtc_applied: bool,
}

fn face_surface(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<DecodedEntity> {
    let surface_attribute = entity
        .get(slot::IfcFaceSurface::FACE_SURFACE.index())
        .ok_or_else(|| Error::geometry("FaceSurface missing FaceSurface"))?;
    decoder
        .resolve_ref(surface_attribute)?
        .ok_or_else(|| Error::geometry("Failed to resolve FaceSurface"))
}

fn empty() -> StructuralFacePlan {
    StructuralFacePlan { faces: smallvec::SmallVec::new(), rtc_applied: false }
}

/// A face surface on an `IfcPlane`, the shared face processor's rule for every
/// product; any other surface is empty.
pub(crate) fn lower(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<StructuralFacePlan> {
    if face_surface(entity, decoder)?.ifc_type != IfcType::IfcPlane {
        return Ok(empty());
    }
    // Loop winding already expresses the planar face normal, including when
    // SameSense is false. The generic face plan retains that production rule.
    Ok(StructuralFacePlan {
        faces: smallvec::smallvec![lower_face(entity, decoder, quality, rtc_file_units)?],
        rtc_applied: rtc_file_units.is_some(),
    })
}

/// A face in a structural member's topology (#9668). Beyond [`lower`], it
/// admits what analysis exporters write: a bare `IfcFace` (GeometryGym), a
/// face surface on an `IfcCurveBoundedPlane` over a plane, and several
/// `IfcFaceOuterBound`s as separate regions (AxisVM). Only the product walk
/// reaches it, for a structural member; every other product keeps [`lower`].
pub(crate) fn lower_member_face(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<StructuralFacePlan> {
    if entity.ifc_type != IfcType::IfcFace {
        let surface = face_surface(entity, decoder)?;
        let planar = match surface.ifc_type {
            IfcType::IfcPlane => true,
            IfcType::IfcCurveBoundedPlane => match surface.get(slot::IfcCurveBoundedPlane::BASIS_SURFACE.index()) {
                Some(attribute) => decoder.resolve_ref(attribute)?.is_some_and(|b| b.ifc_type == IfcType::IfcPlane),
                None => false,
            },
            _ => false,
        };
        if !planar {
            return Ok(empty());
        }
    }
    Ok(StructuralFacePlan {
        faces: lower_planar_regions(entity, decoder, quality, rtc_file_units)?.into(),
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
