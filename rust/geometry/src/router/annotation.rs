// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Product-scoped polygonal annotation fills (#4406). Deliberately not a
//! registry processor: type-level FootPrint/Annotation maps must remain absent.
use super::GeometryRouter;
use crate::{Error, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Point3;

const MAX_VERTICES: usize = 2048;
const MAX_RINGS: usize = 64;

pub(super) fn accepts(product: &DecodedEntity, rep_type: &str) -> bool {
    product.ifc_type == IfcType::IfcAnnotation && matches!(rep_type, "Annotation2D" | "Surface2D")
}

impl GeometryRouter {
    pub(super) fn process_annotation_fill(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Mesh> {
        let result = (|| {
            super::annotation_style::validate(item.id, decoder)?;
            let outer = item
                .get_ref(0)
                .ok_or_else(|| invalid("missing outer boundary"))?;
            let mut refs = vec![outer];
            if let Some(inner) = item.get(1).filter(|a| !a.is_null()) {
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
            let mut mesh = super::annotation_polygon::triangulate(&rings)?;
            self.scale_mesh(&mut mesh);
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
        })();
        if result.is_err() {
            self.record_unsupported_item(item.ifc_type);
        }
        result
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
        .get_list(0)
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
            .get_list(0)
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

pub(super) fn invalid(reason: &str) -> Error {
    Error::geometry(format!("IfcAnnotationFillArea: {reason}"))
}
