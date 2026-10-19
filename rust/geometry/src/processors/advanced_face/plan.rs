// SPDX-License-Identifier: MPL-2.0
//! Owned face surface inputs; curve sampling precedes triangle evaluation.
use super::analytic_plan::{CylinderPlan, PlanarPlan, RevolutionPlan};
use super::bspline_plan::BSplinePlan;
use super::{bounds, note_untrimmed_bspline_face, parse_rational_weights};
use crate::{Error, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};

#[derive(Debug, Clone)]
pub(crate) struct FacePlan {
    geometry: FaceGeometry,
    reverse: bool,
    #[cfg(any(feature = "debug_geometry", feature = "observability"))]
    face_id: u32,
    #[cfg(any(feature = "debug_geometry", feature = "observability"))]
    surface_type: String,
}

#[derive(Debug, Clone)]
pub(super) enum FaceGeometry {
    Empty,
    Planar(PlanarPlan),
    BSpline(BSplinePlan),
    Cylinder(CylinderPlan),
    Revolution(RevolutionPlan),
}
impl FaceGeometry {
    pub(super) fn evaluate(self) -> Result<(Vec<f32>, Vec<u32>)> {
        match self {
            Self::Empty => Ok((Vec::new(), Vec::new())),
            Self::Planar(plan) => plan.evaluate(),
            Self::BSpline(plan) => plan.evaluate(),
            Self::Cylinder(plan) => Ok(plan.evaluate()),
            Self::Revolution(plan) => Ok(plan.evaluate()),
        }
    }
}
impl FacePlan {
    #[cfg(any(feature = "debug_geometry", feature = "observability"))]
    pub(crate) fn surface_kind(&self) -> &str {
        &self.surface_type
    }
    pub(crate) fn evaluate(self) -> Result<(Vec<f32>, Vec<u32>)> {
        let result = self.geometry.evaluate().map(|(positions, mut indices)| {
            if self.reverse {
                for triangle in indices.chunks_exact_mut(3) {
                    triangle.swap(0, 2);
                }
            }
            (positions, indices)
        });
        #[cfg(any(feature = "debug_geometry", feature = "observability"))]
        if let Ok((ref pos, ref idx)) = result {
            if pos.is_empty() || idx.is_empty() {
                crate::diag::diag_debug!(
                    { face_id = self.face_id, surface = %self.surface_type,
                      verts = pos.len() / 3, indices = idx.len() / 3,
                      "advanced_face: face produced zero triangles" }
                    else {
                        #[cfg(feature = "debug_geometry")]
                        eprintln!("[ifc-lite][advanced_face] face #{} surface={} produced 0 tris (verts={}, idx={})",
                            self.face_id, self.surface_type, pos.len() / 3, idx.len() / 3);
                    }
                );
            }
        }
        result
    }
}

pub(crate) fn lower_face(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<FacePlan> {
    // Shell face references were historically read by attribute shape even
    // when their entity class was wrong. Preserve recovery instead of adding
    // a typed-slot owner assertion before the missing-surface error.
    let surface_attr = face
        .get(slot::IfcFaceSurface::FACE_SURFACE.index())
        .ok_or_else(|| Error::geometry("FaceSurface missing FaceSurface".to_string()))?;
    let surface = decoder
        .resolve_ref(surface_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve FaceSurface".to_string()))?;
    let surface_type = surface.ifc_type.as_str().to_uppercase();
    let rtc = rtc_file_units.unwrap_or((0.0, 0.0, 0.0));
    let (geometry, parameterized) = match surface_type.as_str() {
        "IFCPLANE" => (
            super::surfaces::lower_planar(face, decoder, quality, rtc_file_units)?,
            false,
        ),
        "IFCBSPLINESURFACEWITHKNOTS" | "IFCRATIONALBSPLINESURFACEWITHKNOTS" => {
            note_untrimmed_bspline_face(face);
            let plan = bounds::noting_refusal(
                face,
                (|| {
                    let weights = if surface_type == "IFCRATIONALBSPLINESURFACEWITHKNOTS" {
                        Some(parse_rational_weights(&surface)?)
                    } else {
                        None
                    };
                    super::bspline_plan::lower_bspline(
                        &surface,
                        decoder,
                        weights,
                        quality,
                        rtc,
                    )
                })(),
            )?;
            (FaceGeometry::BSpline(plan), true)
        }
        "IFCCYLINDRICALSURFACE" => (
            super::surfaces::lower_cylindrical(face, &surface, decoder, quality, rtc)?
                .map_or(FaceGeometry::Empty, FaceGeometry::Cylinder),
            true,
        ),
        "IFCSURFACEOFREVOLUTION" => (
            super::revolution::lower_revolution(face, &surface, decoder, quality, rtc)?,
            true,
        ),
        "IFCSURFACEOFLINEAREXTRUSION"
        | "IFCCONICALSURFACE"
        | "IFCSPHERICALSURFACE"
        | "IFCTOROIDALSURFACE" => (
            super::surfaces::lower_planar(face, decoder, quality, rtc_file_units)?,
            false,
        ),
        _ => {
            crate::diag::diag_debug!(
                { face_id = face.id, surface = %surface_type,
                  "advanced_face: unsupported surface type, emitting empty geometry" }
                else {
                    #[cfg(feature = "debug_geometry")]
                    eprintln!("[ifc-lite][advanced_face] face #{} unsupported surface {}", face.id, surface_type);
                }
            );
            (FaceGeometry::Empty, false)
        }
    };
    Ok(FacePlan {
        geometry,
        reverse: parameterized
            && !face
                .get(slot::IfcFaceSurface::SAME_SENSE.index())
                .and_then(|value| value.as_bool())
                .unwrap_or(true),
        #[cfg(any(feature = "debug_geometry", feature = "observability"))]
        face_id: face.id,
        #[cfg(any(feature = "debug_geometry", feature = "observability"))]
        surface_type,
    })
}
