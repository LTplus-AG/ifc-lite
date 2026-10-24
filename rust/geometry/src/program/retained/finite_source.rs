// SPDX-License-Identifier: MPL-2.0
//! Authored finite halfspace boundaries. No tessellation, repair, or default closure.
use super::clip::{coefficients, refused, validate_axes, RetainedPlaneCoefficients, RetainedPlaneSource};
use crate::{Result, math::mat4::col_major_array};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

pub(super) const MAX_POINTS: usize = 256;
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedBoundaryPlacement {
    pub position_id: u32,
    pub location: RetainedPlaneCoefficients,
    pub axis: Option<RetainedPlaneCoefficients>,
    pub ref_direction: Option<RetainedPlaneCoefficients>,
    /// Unscaled, boundary-local to representation-local.
    pub frame: [f64; 16],
}
#[derive(Debug, Clone, PartialEq)]
pub enum RetainedFiniteBoundary {
    Polygon {
        boundary_id: u32,
        indexed: Option<super::finite_indexed::RetainedIndexedBoundary>,
        placement: RetainedBoundaryPlacement,
        /// Authored order, including the explicit closing point.
        points: Vec<RetainedPlaneCoefficients>,
    },
    Box {
        enclosure_id: u32,
        placement: RetainedBoundaryPlacement,
        corner: RetainedPlaneCoefficients,
        dimensions: [f64; 3],
    },
}
fn reference(entity: &DecodedEntity, slot: usize, decoder: &mut EntityDecoder) -> Result<DecodedEntity> {
    crate::resource::charge(crate::resource::Cost { work: 1, ..Default::default() })?.retain();
    decoder.resolve_ref(entity.get(slot).ok_or_else(|| refused("missing finite halfspace reference"))?)?
        .ok_or_else(|| refused("unresolved finite halfspace reference"))
}
fn point(entity: &DecodedEntity, dim: usize) -> Result<RetainedPlaneCoefficients> {
    if entity.ifc_type != IfcType::IfcCartesianPoint { return Err(refused("finite boundary requires CartesianPoint")); }
    let values = entity.get(0).and_then(|a| a.as_list()).ok_or_else(|| refused("boundary point coordinates missing"))?;
    if values.len() != dim { return Err(refused("finite boundary point dimension")); }
    let mut raw = [0.; 3];
    for (target, value) in raw.iter_mut().zip(values) {
        *target = value.as_float().filter(|v| v.is_finite()).ok_or_else(|| refused("nonfinite boundary coordinate"))?;
    }
    Ok(RetainedPlaneCoefficients { source_id: entity.id, arity: dim, values: raw })
}
fn placement(position: &DecodedEntity, decoder: &mut EntityDecoder, base: &RetainedPlaneSource)
    -> Result<RetainedBoundaryPlacement> {
    if position.ifc_type != IfcType::IfcAxis2Placement3D { return Err(refused("finite boundary requires Axis2Placement3D")); }
    let location = coefficients(position, 0, decoder)?.ok_or_else(|| refused("boundary location missing"))?;
    if location.arity != 3 { return Err(refused("boundary location must be three dimensional")); }
    let axis = coefficients(position, 1, decoder)?;
    let ref_direction = coefficients(position, 2, decoder)?;
    let source = RetainedPlaneSource { location: Some(location.clone()), axis: axis.clone(),
        ref_direction: ref_direction.clone(), ..base.clone() };
    validate_axes(&source)?;
    let frame = crate::processors::helpers::parse_axis2_placement_3d(position, decoder)?;
    super::proper_rigid(&frame)?;
    Ok(RetainedBoundaryPlacement { position_id: position.id, location, axis, ref_direction,
        frame: col_major_array(&frame) })
}
pub(super) fn capture_finite_boundary(half: &DecodedEntity, decoder: &mut EntityDecoder, base: &RetainedPlaneSource)
    -> Result<RetainedFiniteBoundary> {
    match half.ifc_type {
        IfcType::IfcPolygonalBoundedHalfSpace => {
            let position = reference(half, 2, decoder)?;
            let placement = placement(&position, decoder, base)?;
            let boundary = reference(half, 3, decoder)?;
            let (indexed, points) = match boundary.ifc_type {
                IfcType::IfcPolyline => (None, polyline(&boundary, decoder)?),
                IfcType::IfcIndexedPolyCurve => {
                    let (raw, points) = super::finite_indexed::capture_indexed_boundary(&boundary, decoder)?;
                    (Some(raw), points)
                }
                _ => return Err(refused("retained composite/curved boundary requires analytic region support")),
            };
            if points.first().map(|p| p.values) != points.last().map(|p| p.values) {
                return Err(refused("finite boundary is not explicitly closed"));
            }
            Ok(RetainedFiniteBoundary::Polygon { boundary_id: boundary.id, indexed, placement, points })
        }
        IfcType::IfcBoxedHalfSpace => {
            let enclosure = reference(half, 2, decoder)?;
            if enclosure.ifc_type != IfcType::IfcBoundingBox { return Err(refused("boxed halfspace requires BoundingBox")); }
            let corner = point(&reference(&enclosure, 0, decoder)?, 3)?;
            let mut dimensions = [0.; 3];
            for (i, value) in dimensions.iter_mut().enumerate() {
                *value = enclosure.get(i + 1).and_then(|v| v.as_float()).filter(|v| v.is_finite() && *v > 0.)
                    .ok_or_else(|| refused("invalid finite box dimension"))?;
                if !(corner.values[i] + *value).is_finite() || corner.values[i] + *value <= corner.values[i] {
                    return Err(refused("unrepresentable finite box extent"));
                }
            }
            // IFC Enclosure lives in BaseSurface.Position, not world axes.
            let position = decoder.decode_by_id(base.position_id)?;
            let placement = placement(&position, decoder, base)?;
            Ok(RetainedFiniteBoundary::Box { enclosure_id: enclosure.id, placement, corner, dimensions })
        }
        _ => Err(refused("not a finite halfspace")),
    }
}

fn polyline(boundary: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<Vec<RetainedPlaneCoefficients>> {
    let refs = boundary.get(0).and_then(|v| v.as_list()).ok_or_else(|| refused("boundary point list missing"))?;
    if !(4..=MAX_POINTS + 1).contains(&refs.len()) { return Err(refused("finite boundary point budget/arity")); }
    let mut points = Vec::new();
    crate::resource::reserve_headers(&mut points, refs.len())?.retain();
    for attribute in refs {
        crate::resource::charge(crate::resource::Cost { work: 1, ..Default::default() })?.retain();
        let entity = decoder.resolve_ref(attribute)?.ok_or_else(|| refused("missing boundary point"))?;
        points.push(point(&entity, 2)?);
    }
    Ok(points)
}
