// SPDX-License-Identifier: MPL-2.0
//! Owned source-space plane and decoder-free production half-space clipping.
use super::halfspace_cap::cap_half_space_clip;
use crate::processors::helpers::parse_axis2_placement_3d;
use crate::{Error, Mesh, Point3, Result, Vector3};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

#[derive(Debug, Clone, Copy)]
pub(crate) struct HalfSpacePlan {
    pub point: Point3<f64>,
    pub normal: Vector3<f64>,
    pub agreement: bool,
}

impl HalfSpacePlan {
    pub(crate) fn lower(half_space: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<Self> {
        let (_, position, agreement) = Self::source(half_space, decoder)?;
        Self::from_position(&position, decoder, agreement)
    }

    pub(crate) fn from_position(position: &DecodedEntity, decoder: &mut EntityDecoder, agreement: bool) -> Result<Self> {
        let transform = parse_axis2_placement_3d(position, decoder)?;
        let point = Point3::new(transform[(0, 3)], transform[(1, 3)], transform[(2, 3)]);
        let normal = Vector3::new(transform[(0, 2)], transform[(1, 2)], transform[(2, 2)]).normalize();
        Ok(Self { point, normal, agreement })
    }

    /// The same reached reference/default policy serves exact and retained admission.
    pub(crate) fn source(half_space: &DecodedEntity, decoder: &mut EntityDecoder)
        -> Result<(u32, DecodedEntity, bool)> {
        // Generic references historically admit positional-compatible records;
        // generated indices retain that leniency without an owner assertion.
        let surface_attr = half_space.get(slot::IfcHalfSpaceSolid::BASE_SURFACE.index())
            .ok_or_else(|| Error::geometry("HalfSpaceSolid missing BaseSurface".to_string()))?;
        let surface = decoder.resolve_ref(surface_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve BaseSurface".to_string()))?;
        let agreement = half_space.get(slot::IfcHalfSpaceSolid::AGREEMENT_FLAG.index())
            .and_then(|value| value.as_bool()).unwrap_or(true);
        if surface.ifc_type != IfcType::IfcPlane {
            return Err(Error::geometry(format!(
                "Expected IfcPlane for HalfSpaceSolid, got {}", surface.ifc_type)));
        }
        let position_attr = surface.get(slot::IfcPlane::POSITION.index())
            .ok_or_else(|| Error::geometry("IfcPlane missing Position".to_string()))?;
        let position = decoder.resolve_ref(position_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Plane position".to_string()))?;
        Ok((surface.id, position, agreement))
    }

    pub(crate) fn components(self) -> (Point3<f64>, Vector3<f64>, bool) {
        (self.point, self.normal, self.agreement)
    }

    /// Keep the same side and cap policy as the production plane subtract.
    /// Coordinates remain in the enclosing representation's unscaled frame.
    pub(crate) fn clip(self, mesh: &Mesh) -> Result<Mesh> {
        let clip_normal = if self.agreement { self.normal } else { -self.normal };
        let plane = crate::csg::Plane::new(self.point, clip_normal);
        let processor = crate::ClippingProcessor::new();
        let mut clipped = processor.clip_mesh(mesh, &plane)?;
        // Capping status has no production consumer; preserve the mesh even
        // when a cut remains partially open, as the current clipper does.
        let _capped = cap_half_space_clip(&mut clipped, self.point, clip_normal);
        Ok(clipped)
    }
}

impl super::BooleanClippingProcessor {
    pub(crate) fn parse_half_space_solid(
        &self, half_space: &DecodedEntity, decoder: &mut EntityDecoder,
    ) -> Result<(Point3<f64>, Vector3<f64>, bool)> {
        HalfSpacePlan::lower(half_space, decoder)
            .map(HalfSpacePlan::components)
    }


}

#[cfg(test)]
#[path = "half_space_plan_tests.rs"]
mod tests;
