// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! ExtrudedAreaSolid processor - extrusion of 2D profiles.

use crate::math::tol;
use crate::{
    profiles::ProfileProcessor,
    Mesh, Result, TessellationQuality, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

use crate::router::GeometryProcessor;
use crate::scalar::{magnitude_squared3, GeomScalar};

#[path = "extrusion_plan.rs"]
pub(crate) mod plan;

/// Local (pre-`Position`) transform an `IfcExtrudedAreaSolid` needs for its
/// `ExtrudedDirection`, generic over the scalar.
///
/// `direction` is the raw (unnormalised) ratio triple; callers reject the
/// zero-length case before calling.
///
/// ExtrudedDirection is in the LOCAL coordinate system (before Position transform).
/// We need to determine when to add an extrusion rotation vs. letting Position handle it.
///
/// Two key cases:
/// 1. Opening: local_direction=(0,0,-1), Position rotates local Z to world Y
///    -> local_direction IS along Z, so no rotation needed; Position handles orientation
/// 2. Roof slab: local_direction=(0,-0.5,0.866), Position tilts the profile
///    -> world_direction = Position.rotation * local_direction = (0,0,1) (along world Z!)
///    -> No extra rotation needed; Position handles the tilt
#[inline]
pub(crate) fn extrusion_local_transform<S: GeomScalar>(
    direction: &Vector3<S>,
    depth: S,
) -> Option<Matrix4<S>> {
    let zero = S::from_f64(0.0);
    let one = S::from_f64(1.0);
    // `Vector3::normalize` == `unscale(norm())`.
    let norm = magnitude_squared3(direction).sqrt();
    let local_direction = Vector3::new(
        direction.x / norm,
        direction.y / norm,
        direction.z / norm,
    );

    // Check if local direction is along Z axis
    // Note: We only check local direction because extrusion happens in LOCAL coordinates
    // before the Position transform is applied. What the direction becomes in world
    // space is irrelevant to the extrusion operation.
    let is_local_z_aligned =
        local_direction.x.abs().value() < tol::EXTRUSION_AXIS_COMPONENT_EPS
            && local_direction.y.abs().value() < tol::EXTRUSION_AXIS_COMPONENT_EPS;

    if is_local_z_aligned {
        // Local direction is along Z - no extra rotation needed.
        // Position transform will handle the correct orientation.
        // Only need translation if extruding in negative direction.
        if local_direction.z.value() < 0.0 {
            // Downward extrusion: shift the extrusion down by depth
            #[rustfmt::skip]
            let m = Matrix4::new(
                one,  zero, zero, zero,
                zero, one,  zero, zero,
                zero, zero, one,  -depth,
                zero, zero, zero, one,
            );
            Some(m)
        } else {
            None
        }
    } else {
        // Local direction is NOT along Z - use SHEAR matrix (not rotation!)
        // A shear preserves the profile plane orientation while redirecting extrusion.
        //
        // For ExtrudedDirection (dx, dy, dz), the shear matrix is:
        // | 1    0    dx |
        // | 0    1    dy |
        // | 0    0    dz |
        //
        // This transforms (x, y, depth) to (x + dx*depth, y + dy*depth, dz*depth)
        // while keeping (x, y, 0) unchanged.
        #[rustfmt::skip]
        let shear_mat = Matrix4::new(
            one,  zero, local_direction.x, zero,
            zero, one,  local_direction.y, zero,
            zero, zero, local_direction.z, zero,
            zero, zero, zero,              one,
        );
        Some(shear_mat)
    }
}

/// ExtrudedAreaSolid processor (P0)
/// Handles IfcExtrudedAreaSolid - extrusion of 2D profiles
pub struct ExtrudedAreaSolidProcessor {
    profile_processor: ProfileProcessor,
}

impl ExtrudedAreaSolidProcessor {
    /// Create new processor
    pub fn new(schema: IfcSchema) -> Self {
        Self {
            profile_processor: ProfileProcessor::new(schema),
        }
    }

    /// Decode the admitted production profile and parameters into owned data.
    /// Region boundaries may already approximate curves at `quality`; this
    /// preserves current construction semantics rather than analytic source data.
    pub(crate) fn lower(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<plan::ExtrusionPlan> {
        plan::lower(entity, decoder, quality, &self.profile_processor)
    }
}

impl GeometryProcessor for ExtrudedAreaSolidProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        if rtc_file_units.is_some() { return None; }
        Some(self.lower(entity, decoder, quality).map(|plan| crate::program::OwnedConstructor::new(Constructor::Extrusion(plan))))
    }

    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        self.lower(entity, decoder, quality)?.evaluate()
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
}
