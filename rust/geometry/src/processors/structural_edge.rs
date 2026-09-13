// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcEdge` processor (#4206 layer 4) — renders a structural curve member's
//! topological edge as a thin triangulated ribbon, the same shape as
//! [`crate::processors::alignment::IfcAlignmentProcessor`] but without curve
//! sampling: an `IfcEdge` is just two vertex points, so the ribbon is a
//! single quad (two triangles).
//!
//! Only plain `IfcEdge` is handled. `IfcOrientedEdge` (whose `EdgeStart`/
//! `EdgeEnd` are `$` and whose underlying edge is reached via its
//! `EdgeElement` attribute) and `IfcEdgeCurve` (which can carry a curved
//! `EdgeGeometry` instead of implying a straight line between its vertices)
//! are deliberately unhandled — the fixture backing this processor
//! (`tests/models/ifcopenshell/structural_analysis_curve.ifc`) only emits
//! plain `IfcEdge`, and half-implementing either untested would be worse
//! than an explicit gap.

use crate::router::GeometryProcessor;
use crate::{Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::{Point3, Vector3};

/// Half-width of the rendered ribbon, in file length units. Matches the
/// convention documented at `alignment::RIBBON_HALF_WIDTH_FILE_UNITS`
/// (0.25 there); a structural curve member is typically a much shorter,
/// more slender element than an infrastructure alignment, so this uses a
/// visibly thinner 0.1.
const RIBBON_HALF_WIDTH_FILE_UNITS: f64 = 0.1;

/// Below this magnitude a normalized direction vector's cross product with
/// a candidate "up" vector is treated as parallel (degenerate cross
/// product), so the fallback axis is used instead. Both vectors involved
/// are already unit-length, so this is a fixed, scale-invariant bound
/// (the sine of the angle between them), not a tolerance that must be
/// re-checked against coordinate magnitude.
const PARALLEL_EPSILON: f64 = 1e-9;

pub struct IfcEdgeProcessor;

impl IfcEdgeProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl Default for IfcEdgeProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for IfcEdgeProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: crate::TessellationQuality,
    ) -> Result<Mesh> {
        let start = resolve_vertex_point(entity, 0, decoder)?;
        let end = resolve_vertex_point(entity, 1, decoder)?;

        let dir = end - start;
        // Exact-zero check, not a magnitude-scaled epsilon: two identical
        // `IfcCartesianPoint`s subtract to bit-exact zero regardless of
        // coordinate magnitude, so there is no tolerance to get wrong at a
        // tiny or a huge scale. A genuinely tiny but nonzero edge is legitimate
        // geometry and must not be rejected.
        let length = dir.norm();
        if length == 0.0 {
            return Ok(Mesh::new());
        }
        let dir = dir / length;

        let up_z = Vector3::new(0.0, 0.0, 1.0);
        let cross_z = dir.cross(&up_z);
        let right = if cross_z.norm() > PARALLEL_EPSILON {
            cross_z.normalize()
        } else {
            // Edge runs parallel to Z: fall back to a different axis so the
            // cross product doesn't collapse to zero.
            dir.cross(&Vector3::new(1.0, 0.0, 0.0)).normalize()
        };

        let offset = right * RIBBON_HALF_WIDTH_FILE_UNITS;
        // The emitted winding is (start-left, start-right, end-right), whose
        // geometric face normal is right × direction.  This is +Z for the
        // usual horizontal ribbon, but it must rotate with vertical and sloped
        // edges instead of leaving a lighting normal tangent to the face.
        let normal = right.cross(&dir);

        let mut mesh = Mesh::with_capacity(4, 6);
        mesh.add_vertex(start - offset, normal);
        mesh.add_vertex(start + offset, normal);
        mesh.add_vertex(end - offset, normal);
        mesh.add_vertex(end + offset, normal);

        // Two triangles per quad, matching the alignment ribbon's winding.
        mesh.add_triangle(0, 1, 3);
        mesh.add_triangle(0, 3, 2);

        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcEdge]
    }
}

/// Resolve `IfcEdge`'s `EdgeStart` (attribute 0) or `EdgeEnd` (attribute 1)
/// through `IfcVertexPoint.VertexGeometry` (attribute 0) down to its
/// `IfcCartesianPoint` coordinates.
fn resolve_vertex_point(
    edge: &DecodedEntity,
    attr_index: usize,
    decoder: &mut EntityDecoder,
) -> Result<Point3<f64>> {
    let vertex_id = edge.get_ref(attr_index).ok_or_else(|| {
        crate::Error::geometry(format!(
            "IfcEdge #{} missing vertex reference at attribute {}",
            edge.id, attr_index
        ))
    })?;
    let vertex = decoder.decode_by_id(vertex_id)?;
    if vertex.ifc_type != IfcType::IfcVertexPoint {
        return Err(crate::Error::geometry(format!(
            "IfcEdge #{} vertex #{} is {}, expected IfcVertexPoint",
            edge.id, vertex_id, vertex.ifc_type
        )));
    }
    let point_id = vertex.get_ref(0).ok_or_else(|| {
        crate::Error::geometry(format!(
            "IfcVertexPoint #{} missing VertexGeometry",
            vertex.id
        ))
    })?;
    let point = decoder.decode_by_id(point_id)?;
    if point.ifc_type != IfcType::IfcCartesianPoint {
        return Err(crate::Error::geometry(format!(
            "IfcVertexPoint #{} VertexGeometry #{} is {}, expected IfcCartesianPoint",
            vertex.id, point_id, point.ifc_type
        )));
    }
    let coords = point.get_list(0).ok_or_else(|| {
        crate::Error::geometry(format!(
            "IfcCartesianPoint #{} missing coordinates",
            point.id
        ))
    })?;
    if !(2..=3).contains(&coords.len()) {
        return Err(crate::Error::geometry(format!(
            "IfcCartesianPoint #{} must be 2D or 3D",
            point.id
        )));
    }
    let mut xyz = [0.0; 3];
    for (i, attr) in coords.iter().enumerate() {
        xyz[i] = attr.as_float().filter(|v| v.is_finite()).ok_or_else(|| {
            crate::Error::geometry(format!(
                "IfcCartesianPoint #{} has a non-finite coordinate",
                point.id
            ))
        })?;
    }
    Ok(Point3::from(xyz))
}
