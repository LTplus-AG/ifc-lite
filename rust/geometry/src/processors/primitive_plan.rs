// SPDX-License-Identifier: MPL-2.0
//! Owned production primitive parameters before router scale and placement.

use crate::{extrusion::apply_transform, scale_segments, Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

/// Raw IFC file-unit dimensions and optional primitive-local Position.
#[derive(Debug, Clone)]
pub(crate) struct BlockPlan {
    pub dimensions: [f64; 3],
    pub position: Option<Matrix4<f64>>,
}

/// Raw IFC file-unit radius with the production quality's segment counts.
#[derive(Debug, Clone)]
pub(crate) struct SpherePlan {
    pub radius: f64,
    pub slices: usize,
    pub stacks: usize,
    pub position: Option<Matrix4<f64>>,
}

pub(super) fn lower_block(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<BlockPlan> {
    let x = entity.real_at(slot::IfcBlock::X_LENGTH)
        .ok_or_else(|| Error::geometry("IfcBlock missing XLength".to_string()))?;
    let y = entity.real_at(slot::IfcBlock::Y_LENGTH)
        .ok_or_else(|| Error::geometry("IfcBlock missing YLength".to_string()))?;
    let z = entity.real_at(slot::IfcBlock::Z_LENGTH)
        .ok_or_else(|| Error::geometry("IfcBlock missing ZLength".to_string()))?;
    if !(x.is_finite() && y.is_finite() && z.is_finite() && x > 0.0 && y > 0.0 && z > 0.0) {
        return Err(Error::geometry(format!(
            "IfcBlock requires finite positive lengths, got ({}, {}, {})", x, y, z)));
    }
    let position = primitive_position(entity, decoder)?;
    Ok(BlockPlan { dimensions: [x, y, z], position })
}

pub(in crate::processors) fn lower_sphere(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<SpherePlan> {
    let radius = entity.real_at(slot::IfcSphere::RADIUS)
        .ok_or_else(|| Error::geometry("IfcSphere missing Radius".to_string()))?;
    if !radius.is_finite() || radius <= 0.0 {
        return Err(Error::geometry(format!("IfcSphere requires finite positive radius, got {radius}")));
    }
    let slices = scale_segments(24, 8, 96, quality);
    let stacks = scale_segments(16, 4, 64, quality);
    let position = primitive_position(entity, decoder)?;
    Ok(SpherePlan { radius, slices, stacks, position })
}

fn primitive_position(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<Option<Matrix4<f64>>> {
    if let Some(attribute) = entity.attr(slot::IfcCsgPrimitive3D::POSITION) {
        if !attribute.is_null() {
            if let Some(position) = decoder.resolve_ref(attribute)? {
                if position.ifc_type == IfcType::IfcAxis2Placement3D {
                    return super::super::helpers::parse_axis2_placement_3d(&position, decoder).map(Some);
                }
            }
        }
    }
    Ok(None)
}

impl BlockPlan {
    pub(crate) fn evaluate(&self) -> Mesh {
        let [x, y, z] = self.dimensions;
        let mut mesh = super::build_axis_aligned_box(x, y, z);
        if let Some(position) = &self.position { apply_transform(&mut mesh, position); }
        mesh
    }
}

impl SpherePlan {
    pub(crate) fn evaluate(&self) -> Mesh {
        let mut mesh = super::super::sphere::build_uv_sphere(self.radius, self.slices, self.stacks);
        if let Some(position) = &self.position { apply_transform(&mut mesh, position); }
        mesh
    }
}

#[cfg(test)]
#[path = "primitive_plan_tests.rs"]
mod tests;
