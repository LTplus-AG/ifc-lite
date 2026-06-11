// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! ExtrudedAreaSolid processor - extrusion of 2D profiles.

use crate::{
    extrusion::{apply_transform, extrude_profile},
    profiles::ProfileProcessor,
    Error, Mesh, Result, TessellationQuality, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

use super::helpers::parse_axis2_placement_3d;
use crate::router::GeometryProcessor;

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

        let profile = self
            .profile_processor
            .process(&profile_entity, decoder, quality)?;

        if profile.outer.is_empty() {
            return Ok(Mesh::new());
        }

        // Get extrusion direction
        let direction_attr = entity.get(2).ok_or_else(|| {
            Error::geometry("ExtrudedAreaSolid missing ExtrudedDirection".to_string())
        })?;

        let direction_entity = decoder
            .resolve_ref(direction_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve ExtrudedDirection".to_string()))?;

        if direction_entity.ifc_type != IfcType::IfcDirection {
            return Err(Error::geometry(format!(
                "Expected IfcDirection, got {}",
                direction_entity.ifc_type
            )));
        }

        // Parse direction
        let ratios_attr = direction_entity
            .get(0)
            .ok_or_else(|| Error::geometry("IfcDirection missing ratios".to_string()))?;

        let ratios = ratios_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected ratio list".to_string()))?;

        use ifc_lite_core::AttributeValue;
        let dir_x = ratios
            .first()
            .and_then(|v: &AttributeValue| v.as_float())
            .unwrap_or(0.0);
        let dir_y = ratios
            .get(1)
            .and_then(|v: &AttributeValue| v.as_float())
            .unwrap_or(0.0);
        let dir_z = ratios
            .get(2)
            .and_then(|v: &AttributeValue| v.as_float())
            .unwrap_or(1.0);

        let local_direction = Vector3::new(dir_x, dir_y, dir_z).normalize();

        // Get depth
        let depth = entity
            .get_float(3)
            .ok_or_else(|| Error::geometry("ExtrudedAreaSolid missing Depth".to_string()))?;

        // Parse Position transform first (attribute 1: IfcAxis2Placement3D)
        // We need Position's rotation to transform ExtrudedDirection to world coordinates
        let pos_transform = if let Some(pos_attr) = entity.get(1) {
            if !pos_attr.is_null() {
                if let Some(pos_entity) = decoder.resolve_ref(pos_attr)? {
                    if pos_entity.ifc_type == IfcType::IfcAxis2Placement3D {
                        Some(parse_axis2_placement_3d(&pos_entity, decoder)?)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        // ExtrudedDirection is in the LOCAL coordinate system (before Position transform).
        // We need to determine when to add an extrusion rotation vs. letting Position handle it.
        //
        // Two key cases:
        // 1. Opening: local_direction=(0,0,-1), Position rotates local Z to world Y
        //    -> local_direction IS along Z, so no rotation needed; Position handles orientation
        // 2. Roof slab: local_direction=(0,-0.5,0.866), Position tilts the profile
        //    -> world_direction = Position.rotation * local_direction = (0,0,1) (along world Z!)
        //    -> No extra rotation needed; Position handles the tilt
        //
        // Check if local direction is along Z axis
        // Note: We only check local direction because extrusion happens in LOCAL coordinates
        // before the Position transform is applied. What the direction becomes in world
        // space is irrelevant to the extrusion operation.
        let is_local_z_aligned = local_direction.x.abs() < 0.001 && local_direction.y.abs() < 0.001;

        let transform = if is_local_z_aligned {
            // Local direction is along Z - no extra rotation needed.
            // Position transform will handle the correct orientation.
            // Only need translation if extruding in negative direction.
            if local_direction.z < 0.0 {
                // Downward extrusion: shift the extrusion down by depth
                Some(Matrix4::new_translation(&Vector3::new(0.0, 0.0, -depth)))
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
            let mut shear_mat = Matrix4::identity();
            shear_mat[(0, 2)] = local_direction.x; // X shear from Z
            shear_mat[(1, 2)] = local_direction.y; // Y shear from Z
            shear_mat[(2, 2)] = local_direction.z; // Z scale

            Some(shear_mat)
        };

        // Extrude the profile
        let mut mesh = extrude_profile(&profile, depth, transform)?;

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
