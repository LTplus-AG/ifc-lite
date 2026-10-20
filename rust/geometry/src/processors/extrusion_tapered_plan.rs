// SPDX-License-Identifier: MPL-2.0
//! Owned production tapered extrusion over admitted sampled profile regions.
//! Start/end correspondence and uniform-extrusion substitution retain current
//! production admission. Lengths and Position remain in IFC file units.

use crate::{
    extrusion::{apply_transform, extrude_profile_lofted, extrude_regions},
    profile::Profile2D,
    profiles::ProfileProcessor,
    Error, Mesh, Result, TessellationQuality, Vector3,
};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

#[derive(Debug, Clone)]
pub(crate) enum TaperedExtrusionPlan {
    Empty,
    Regions {
        start_regions: Vec<Profile2D>,
        end_regions: Option<Vec<Profile2D>>,
        direction: Vector3<f64>,
        depth: f64,
        position: Option<Matrix4<f64>>,
    },
}

pub(super) fn lower(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    profile_processor: &ProfileProcessor,
) -> Result<TaperedExtrusionPlan> {
    let start_attr = entity
        .get(slot::IfcExtrudedAreaSolidTapered::SWEPT_AREA.index())
        .ok_or_else(|| Error::geometry("ExtrudedAreaSolidTapered missing SweptArea".to_string()))?;
    let start_entity = decoder
        .resolve_ref(start_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve SweptArea".to_string()))?;
    // Start and end draw on one composite budget, armed once per solid.
    profile_processor.arm_solid_budget();
    let mut start_regions = profile_processor.process_regions(&start_entity, decoder, quality)?;
    start_regions.retain(|region| !region.outer.is_empty());
    if start_regions.is_empty() {
        return Ok(TaperedExtrusionPlan::Empty);
    }

    let crate::processors::extrusion_params::ExtrusionParams {
        direction,
        depth,
        position,
    } = crate::processors::extrusion_params::ExtrusionParams::decode(
        entity,
        decoder,
        "ExtrudedAreaSolidTapered",
    )?;
    // Resolve EndSweptArea (attr 4). If missing, unresolvable, its
    // profile fails to process, or its regions do not pair one-to-one
    // with the start's, fall back to a uniform extrusion so the element
    // still renders rather than dropping geometry entirely.
    let end_regions_opt =
        match entity.get(slot::IfcExtrudedAreaSolidTapered::END_SWEPT_AREA.index()) {
            Some(attr) if !attr.is_null() => match decoder.resolve_ref(attr)? {
                Some(end_entity) => {
                    match profile_processor.process_regions(&end_entity, decoder, quality) {
                        Ok(mut end) => {
                            end.retain(|region| !region.outer.is_empty());
                            (end.len() == start_regions.len()).then_some(end)
                        }
                        Err(_) => None,
                    }
                }
                None => None,
            },
            _ => None,
        };

    Ok(TaperedExtrusionPlan::Regions {
        start_regions,
        end_regions: end_regions_opt,
        direction,
        depth,
        position,
    })
}

impl TaperedExtrusionPlan {
    pub(crate) fn evaluate(&self) -> Result<Mesh> {
        let Self::Regions {
            start_regions,
            end_regions,
            direction,
            depth,
            position,
        } = self
        else {
            return Ok(Mesh::new());
        };
        let local_direction = direction.normalize();

        // Same Z-aligned vs shear branch as ExtrudedAreaSolidProcessor — see
        // processors/extrusion.rs for the rationale.
        let is_local_z_aligned = local_direction.x.abs() < 0.001 && local_direction.y.abs() < 0.001;
        let transform = if is_local_z_aligned {
            if local_direction.z < 0.0 {
                Some(Matrix4::new_translation(&Vector3::new(0.0, 0.0, -*depth)))
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

        let mut mesh = match end_regions {
            Some(end_regions) => {
                let mut mesh = Mesh::new();
                for (start, end) in start_regions.iter().zip(end_regions) {
                    mesh.merge(&extrude_profile_lofted(start, end, *depth, transform)?);
                }
                mesh
            }
            None => extrude_regions(start_regions, *depth, transform)?,
        };

        if let Some(pos) = position {
            apply_transform(&mut mesh, pos);
        }

        Ok(mesh)
    }
}

#[cfg(test)]
#[path = "extrusion_tapered_plan_tests.rs"]
mod tests;
