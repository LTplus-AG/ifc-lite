// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! ExtrudedAreaSolid processor - extrusion of 2D profiles.

use crate::{
    extrusion::{apply_transform, extrude_regions},
    profiles::ProfileProcessor,
    Error, Mesh, Result, TessellationQuality, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

use crate::router::GeometryProcessor;
use crate::scalar::{magnitude_squared3, GeomScalar};

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
        local_direction.x.abs().value() < 0.001 && local_direction.y.abs().value() < 0.001;

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
}

impl GeometryProcessor for ExtrudedAreaSolidProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        // IfcExtrudedAreaSolid attributes:
        // 0: SweptArea (IfcProfileDef)
        // 1: Position (IfcAxis2Placement3D)
        // 2: ExtrudedDirection (IfcDirection)
        // 3: Depth (IfcPositiveLengthMeasure)

        // Get profile
        let profile_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("ExtrudedAreaSolid missing SweptArea".to_string()))?;

        let profile_entity = decoder
            .resolve_ref(profile_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve SweptArea".to_string()))?;

        // One solid per disjoint area: a composite profile is several (#7685).
        // Its budget is armed once per solid; an extrusion places two copies
        // of each point, within MAX_COMPOSITE_SWEEP_VERTICES by construction.
        self.profile_processor.arm_solid_budget();
        let mut regions = self
            .profile_processor
            .process_regions(&profile_entity, decoder, quality)?;
        regions.retain(|region| !region.outer.is_empty());
        if regions.is_empty() {
            return Ok(Mesh::new());
        }

        let super::extrusion_params::ExtrusionParams { direction, depth, position: pos_transform } =
            super::extrusion_params::ExtrusionParams::decode(entity, decoder, "ExtrudedAreaSolid")?;

        let transform = extrusion_local_transform(&direction, depth);

        // Extrude the profile
        let mut mesh = extrude_regions(&regions, depth, transform)?;

        // Apply Position transform
        if let Some(pos) = pos_transform {
            apply_transform(&mut mesh, &pos);
        }

        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
}
