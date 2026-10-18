// SPDX-License-Identifier: MPL-2.0
//! Reached style/ring admission, followed by source-free fill construction.
use crate::router::annotation::invalid;
use crate::{Mesh, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Point3;

const MAX_VERTICES: usize = 2048;
const MAX_RINGS: usize = 64;

pub(crate) struct AnnotationFill {
    rings: Vec<Vec<Point3<f64>>>,
    unit_scale: f64,
}
impl AnnotationFill {
    pub(crate) fn admit(
        item: &DecodedEntity,
        decoder: &mut EntityDecoder<'_>,
        unit_scale: f64,
    ) -> Result<Self> {
        crate::router::annotation_style::validate(item.id, decoder)?;
        let outer = item
            .get_ref(slot::IfcAnnotationFillArea::OUTER_BOUNDARY.index())
            .ok_or_else(|| invalid("missing outer boundary"))?;
        let mut refs = vec![outer];
        if let Some(inner) = item
            .get(slot::IfcAnnotationFillArea::INNER_BOUNDARIES.index())
            .filter(|a| !a.is_null())
        {
            let list = inner
                .as_list()
                .ok_or_else(|| invalid("invalid inner boundaries"))?;
            if list.len() >= MAX_RINGS {
                return Err(invalid("ring budget exceeded"));
            }
            for attr in list {
                refs.push(
                    attr.as_entity_ref()
                        .ok_or_else(|| invalid("invalid boundary reference"))?,
                );
            }
        }
        let mut remaining = MAX_VERTICES;
        let mut rings = Vec::with_capacity(refs.len());
        // Fixed-depth curve→point walk, no recursive reference expansion.
        for id in refs {
            rings.push(read_ring(id, decoder, &mut remaining)?);
        }
        Ok(Self { rings, unit_scale })
    }

    pub(crate) fn evaluate(self) -> Result<Mesh> {
        let mut mesh = crate::router::annotation_polygon::triangulate(&self.rings)?;
        if self.unit_scale != 1.0 {
            let scale = self.unit_scale as f32;
            for pos in &mut mesh.positions {
                *pos *= scale;
            }
        }
        if mesh.positions.iter().any(|p| !p.is_finite()) {
            return Err(invalid("coordinates exceed mesh storage range"));
        }
        for triangle in mesh.indices.chunks_exact(3) {
            let point = |i: u32| {
                let i = i as usize * 3;
                Point3::new(
                    mesh.positions[i] as f64,
                    mesh.positions[i + 1] as f64,
                    mesh.positions[i + 2] as f64,
                )
            };
            let a = point(triangle[0]);
            let b = point(triangle[1]);
            let c = point(triangle[2]);
            if (b - a).cross(&(c - a)).norm_squared() == 0. {
                return Err(invalid("mesh storage precision collapses a fill triangle"));
            }
        }
        Ok(mesh)
    }
}

fn read_ring(
    id: u32,
    decoder: &mut EntityDecoder,
    remaining: &mut usize,
) -> Result<Vec<Point3<f64>>> {
    let curve = decoder.decode_by_id(id)?;
    if curve.ifc_type != IfcType::IfcPolyline {
        return Err(invalid("only closed IfcPolyline boundaries are supported"));
    }
    let refs = curve
        .get_list(slot::IfcPolyline::POINTS.index())
        .ok_or_else(|| invalid("missing polyline points"))?;
    if refs.len() < 4 || refs.len() > *remaining {
        return Err(invalid("vertex budget or ring size invalid"));
    }
    *remaining -= refs.len();
    let mut points = Vec::with_capacity(refs.len());
    for attr in refs {
        let point = decoder.decode_by_id(
            attr.as_entity_ref()
                .ok_or_else(|| invalid("invalid point reference"))?,
        )?;
        if point.ifc_type != IfcType::IfcCartesianPoint {
            return Err(invalid("boundary point has wrong type"));
        }
        let coords = point
            .get_list(slot::IfcCartesianPoint::COORDINATES.index())
            .ok_or_else(|| invalid("missing point coordinates"))?;
        if !(2..=3).contains(&coords.len()) {
            return Err(invalid("point must be 2D or 3D"));
        }
        let mut xyz = [0.; 3];
        for (i, attr) in coords.iter().enumerate() {
            xyz[i] = attr
                .as_float()
                .filter(|v| v.is_finite())
                .ok_or_else(|| invalid("nonfinite point"))?;
        }
        points.push(Point3::from(xyz));
    }
    if points.first() != points.last() {
        return Err(invalid("boundary must be explicitly closed"));
    }
    points.pop();
    Ok(points)
}
