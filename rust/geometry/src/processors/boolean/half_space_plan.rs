// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Owned source-space plane of an `IfcHalfSpaceSolid`: the preflight half of
//! the plane clip. Reading the entity (and every default/refusal it carries)
//! happens here; the mesh numerics consume the owned plan afterwards.

use crate::processors::helpers::parse_axis2_placement_3d;
use crate::{Error, Point3, Result, Vector3};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

/// A half-space's clipping plane, in the representation item's local,
/// pre-placement, pre-scale coordinates (the element's `ObjectPlacement` is
/// folded in later by `apply_placement`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct HalfSpacePlan {
    pub(crate) point: Point3<f64>,
    pub(crate) normal: Vector3<f64>,
    /// `AgreementFlag`, defaulting to `true`: the material is on the negative
    /// side of the surface normal.
    pub(crate) agreement: bool,
}

impl HalfSpacePlan {
    /// Read `IfcHalfSpaceSolid.BaseSurface` (an `IfcPlane`) and its Position.
    pub(crate) fn lower(half_space: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<Self> {
        // IfcHalfSpaceSolid attributes: BaseSurface, AgreementFlag.
        let surface_attr = half_space
            .get(slot::IfcHalfSpaceSolid::BASE_SURFACE.index())
            .ok_or_else(|| Error::geometry("HalfSpaceSolid missing BaseSurface".to_string()))?;

        let surface = decoder
            .resolve_ref(surface_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve BaseSurface".to_string()))?;

        let agreement = half_space
            .get_bool(slot::IfcHalfSpaceSolid::AGREEMENT_FLAG.index())
            .unwrap_or(true);

        if surface.ifc_type != IfcType::IfcPlane {
            return Err(Error::geometry(format!(
                "Expected IfcPlane for HalfSpaceSolid, got {}",
                surface.ifc_type
            )));
        }

        let position_attr = surface
            .get(slot::IfcPlane::POSITION.index())
            .ok_or_else(|| Error::geometry("IfcPlane missing Position".to_string()))?;

        let position = decoder
            .resolve_ref(position_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve Plane position".to_string()))?;

        // Location = plane point; Z-axis (Axis) = plane normal.
        let transform = parse_axis2_placement_3d(&position, decoder)?;
        let point = Point3::new(transform[(0, 3)], transform[(1, 3)], transform[(2, 3)]);
        let normal =
            Vector3::new(transform[(0, 2)], transform[(1, 2)], transform[(2, 2)]).normalize();

        Ok(Self {
            point,
            normal,
            agreement,
        })
    }

    pub(crate) fn components(self) -> (Point3<f64>, Vector3<f64>, bool) {
        (self.point, self.normal, self.agreement)
    }
}
