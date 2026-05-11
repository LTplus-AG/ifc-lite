// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! ExtrudedAreaSolidTapered processor — lofted extrusion between two profiles.
//!
//! Adds support for `IfcExtrudedAreaSolidTapered`, a subtype of
//! `IfcExtrudedAreaSolid` with one extra attribute (`EndSweptArea`, attr 4).
//! The cross-section linearly transitions from `SweptArea` at the base to
//! `EndSweptArea` at `Depth` along `ExtrudedDirection`.

use crate::{
    extrusion::{apply_transform, extrude_profile, extrude_profile_lofted},
    profiles::ProfileProcessor,
    Error, Mesh, Result, Vector3,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;

use super::helpers::parse_axis2_placement_3d;
use crate::router::GeometryProcessor;

pub struct ExtrudedAreaSolidTaperedProcessor {
    profile_processor: ProfileProcessor,
}

impl ExtrudedAreaSolidTaperedProcessor {
    pub fn new(schema: IfcSchema) -> Self {
        Self {
            profile_processor: ProfileProcessor::new(schema),
        }
    }
}

impl GeometryProcessor for ExtrudedAreaSolidTaperedProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        // IfcExtrudedAreaSolidTapered attributes (inherits IfcExtrudedAreaSolid):
        // 0: SweptArea       (start profile, IfcProfileDef)
        // 1: Position        (IfcAxis2Placement3D)
        // 2: ExtrudedDirection (IfcDirection)
        // 3: Depth           (IfcPositiveLengthMeasure)
        // 4: EndSweptArea    (end profile, IfcProfileDef)

        let start_attr = entity.get(0).ok_or_else(|| {
            Error::geometry("ExtrudedAreaSolidTapered missing SweptArea".to_string())
        })?;
        let start_entity = decoder
            .resolve_ref(start_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve SweptArea".to_string()))?;
        let start_profile = self.profile_processor.process(&start_entity, decoder)?;
        if start_profile.outer.is_empty() {
            return Ok(Mesh::new());
        }

        let direction_attr = entity.get(2).ok_or_else(|| {
            Error::geometry("ExtrudedAreaSolidTapered missing ExtrudedDirection".to_string())
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

        use ifc_lite_core::AttributeValue;
        let ratios_attr = direction_entity
            .get(0)
            .ok_or_else(|| Error::geometry("IfcDirection missing ratios".to_string()))?;
        let ratios = ratios_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected ratio list".to_string()))?;
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
        let direction = Vector3::new(dir_x, dir_y, dir_z);
        if direction.norm_squared() <= f64::EPSILON {
            return Err(Error::geometry(
                "ExtrudedAreaSolidTapered has zero-length ExtrudedDirection".to_string(),
            ));
        }
        let local_direction = direction.normalize();

        let depth = entity.get_float(3).ok_or_else(|| {
            Error::geometry("ExtrudedAreaSolidTapered missing Depth".to_string())
        })?;

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

        // Same Z-aligned vs shear branch as ExtrudedAreaSolidProcessor — see
        // processors/extrusion.rs for the rationale.
        let is_local_z_aligned =
            local_direction.x.abs() < 0.001 && local_direction.y.abs() < 0.001;
        let transform = if is_local_z_aligned {
            if local_direction.z < 0.0 {
                Some(Matrix4::new_translation(&Vector3::new(0.0, 0.0, -depth)))
            } else {
                None
            }
        } else {
            let mut shear_mat = Matrix4::identity();
            shear_mat[(0, 2)] = local_direction.x;
            shear_mat[(1, 2)] = local_direction.y;
            shear_mat[(2, 2)] = local_direction.z;
            Some(shear_mat)
        };

        // Resolve EndSweptArea (attr 4). If missing, unresolvable, or its
        // profile fails to process, fall back to a uniform extrusion so the
        // element still renders rather than dropping geometry entirely.
        let end_profile_opt = match entity.get(4) {
            Some(attr) if !attr.is_null() => match decoder.resolve_ref(attr)? {
                Some(end_entity) => {
                    match self.profile_processor.process(&end_entity, decoder) {
                        Ok(p) if !p.outer.is_empty() => Some(p),
                        Ok(_) => None,
                        Err(_) => None,
                    }
                }
                None => None,
            },
            _ => None,
        };

        let mut mesh = match end_profile_opt {
            Some(end_profile) => {
                extrude_profile_lofted(&start_profile, &end_profile, depth, transform)?
            }
            None => extrude_profile(&start_profile, depth, transform)?,
        };

        if let Some(pos) = pos_transform {
            apply_transform(&mut mesh, &pos);
        }

        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolidTapered]
    }
}
