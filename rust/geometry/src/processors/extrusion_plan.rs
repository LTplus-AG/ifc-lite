// SPDX-License-Identifier: MPL-2.0
//! Owned production extrusion construction, independent of an IFC decoder.
//!
//! Profiles retain the regions admitted by the existing profile processor.
//! Circular/curved boundaries may already be sampled at the selected quality;
//! this plan does not claim an analytic retained surface representation.

use crate::{extrusion::{apply_transform, extrude_regions}, profile::Profile2D,
    profiles::ProfileProcessor, Error, Mesh, Result, TessellationQuality, Vector3};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

/// Raw file-unit regions and production-decoded parameters, before unit scale,
/// object/mapping placement or RTC publication. Source IDs retain attribution.
/// Empty profiles short-circuit before direction/depth/Position admission.
#[derive(Debug, Clone)]
pub(crate) enum ExtrusionPlan {
    Empty {
        // Retained for shared-DAG attribution; the mesh builder needs neither ID.
        #[allow(dead_code)]
        source_id: u32,
        #[allow(dead_code)]
        profile_id: u32,
    },
    Regions {
        // Retained for shared-DAG attribution; the mesh builder needs neither ID.
        #[allow(dead_code)]
        source_id: u32,
        #[allow(dead_code)]
        profile_id: u32,
        regions: Vec<Profile2D>,
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
) -> Result<ExtrusionPlan> {
    let profile_attr = entity.attr(slot::IfcExtrudedAreaSolid::SWEPT_AREA)
        .ok_or_else(|| Error::geometry("ExtrudedAreaSolid missing SweptArea".to_string()))?;
    let profile = decoder.resolve_ref(profile_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve SweptArea".to_string()))?;
    // Preserve the original admission order and one per-solid profile budget.
    profile_processor.arm_solid_budget();
    let mut regions = profile_processor.process_regions(&profile, decoder, quality)?;
    regions.retain(|region| !region.outer.is_empty());
    if regions.is_empty() {
        return Ok(ExtrusionPlan::Empty { source_id: entity.id, profile_id: profile.id });
    }
    let super::super::extrusion_params::ExtrusionParams { direction, depth, position } =
        super::super::extrusion_params::ExtrusionParams::decode(entity, decoder, "ExtrudedAreaSolid")?;
    Ok(ExtrusionPlan::Regions { source_id: entity.id, profile_id: profile.id,
        regions, direction, depth, position })
}

impl ExtrusionPlan {
    /// Replay through the existing mesh builder with identical transform order.
    /// No IFC bytes, decoder, profile processor or live router is required.
    pub(crate) fn evaluate(&self) -> Result<Mesh> {
        match self {
            Self::Empty { .. } => Ok(Mesh::new()),
            Self::Regions { regions, direction, depth, position, .. } => {
                let transform = super::extrusion_local_transform(direction, *depth);
                let mut mesh = extrude_regions(regions, *depth, transform)?;
                if let Some(position) = position { apply_transform(&mut mesh, position); }
                Ok(mesh)
            }
        }
    }
}

#[cfg(test)]
#[path = "extrusion_plan_tests.rs"]
mod tests;
