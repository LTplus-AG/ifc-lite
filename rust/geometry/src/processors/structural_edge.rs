// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Topological edge processor (#4206 layer 4) — renders a structural curve
//! member's `IfcEdge`, `IfcEdgeCurve`, or `IfcOrientedEdge` as a thin
//! triangulated ribbon. Curved edges reuse the advanced-face sampler so circle,
//! ellipse, B-spline, trimmed, composite, and polyline sense handling cannot
//! drift.

use crate::router::GeometryProcessor;
use crate::{Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::{Point3, Vector3};
use std::collections::HashSet;

use super::advanced_face::edge_loop::sample_edge_curve_points;

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

/// Invalid IFC can chain `IfcOrientedEdge.EdgeElement` cyclically. Bound and
/// cycle-check that file-authored reference walk rather than recursing forever.
const MAX_EDGE_REFERENCE_DEPTH: usize = 64;

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
        quality: crate::TessellationQuality,
    ) -> Result<Mesh> {
        let points = resolve_edge_points(entity, decoder, quality, 0, &mut HashSet::new())?;
        Ok(ribbon_mesh(&points))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![
            IfcType::IfcEdge,
            IfcType::IfcEdgeCurve,
            IfcType::IfcOrientedEdge,
        ]
    }
}

fn resolve_edge_points(
    edge: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: crate::TessellationQuality,
    depth: usize,
    visited: &mut HashSet<u32>,
) -> Result<Vec<Point3<f64>>> {
    if depth >= MAX_EDGE_REFERENCE_DEPTH {
        return Err(crate::Error::geometry(format!(
            "Ifc edge reference walk exceeded {MAX_EDGE_REFERENCE_DEPTH} levels at #{}",
            edge.id
        )));
    }
    if !visited.insert(edge.id) {
        return Err(crate::Error::geometry(format!(
            "Ifc edge reference cycle at #{}",
            edge.id
        )));
    }
    match edge.ifc_type {
        IfcType::IfcEdgeCurve => {
            sample_edge_curve_points(edge, true, decoder, quality).ok_or_else(|| {
                crate::Error::geometry(format!(
                    "IfcEdgeCurve #{} has no resolvable endpoints",
                    edge.id
                ))
            })
        }
        IfcType::IfcOrientedEdge => {
            let edge_id = edge.get_ref(2).ok_or_else(|| {
                crate::Error::geometry(format!("IfcOrientedEdge #{} missing EdgeElement", edge.id))
            })?;
            let underlying = decoder.decode_by_id(edge_id)?;
            if !underlying.ifc_type.is_subtype_of(IfcType::IfcEdge) {
                return Err(crate::Error::geometry(format!(
                    "IfcOrientedEdge #{} EdgeElement #{} is {}, expected IfcEdge",
                    edge.id, edge_id, underlying.ifc_type
                )));
            }
            let mut points =
                resolve_edge_points(&underlying, decoder, quality, depth + 1, visited)?;
            let orientation = edge
                .get(3)
                .and_then(|a| a.as_enum())
                .map(|value| value == "T" || value == "TRUE")
                .unwrap_or(true);
            if !orientation {
                points.reverse();
            }
            Ok(points)
        }
        _ if edge.ifc_type.is_subtype_of(IfcType::IfcEdge) => Ok(vec![
            resolve_vertex_point(edge, 0, decoder)?,
            resolve_vertex_point(edge, 1, decoder)?,
        ]),
        _ => Err(crate::Error::geometry(format!(
            "Expected IfcEdge, got {} #{}",
            edge.ifc_type, edge.id
        ))),
    }
}

fn ribbon_mesh(points: &[Point3<f64>]) -> Mesh {
    let mut points: Vec<_> = points
        .iter()
        .copied()
        .enumerate()
        .filter_map(|(index, point)| (index == 0 || point != points[index - 1]).then_some(point))
        .collect();
    let closed = points.len() > 2 && points.first() == points.last();
    if closed {
        points.pop();
    }
    if points.len() < 2 {
        return Mesh::new();
    }

    let span_count = if closed {
        points.len()
    } else {
        points.len() - 1
    };
    let mut rights = Vec::with_capacity(span_count);
    let mut normals = Vec::with_capacity(span_count);
    for span in 0..span_count {
        let direction = points[(span + 1) % points.len()] - points[span];
        let Some(direction) = stable_unit_direction(direction) else {
            return Mesh::new();
        };
        let (right, normal) = transported_frame(direction, rights.last(), normals.last());
        rights.push(right);
        normals.push(normal);
    }

    let mut mesh = Mesh::with_capacity(points.len() * 2, span_count * 6);
    for index in 0..points.len() {
        let offset = join_offset(index, &rights, closed);
        let normal = join_normal(index, &normals, closed);
        mesh.add_vertex(points[index] - offset, normal);
        mesh.add_vertex(points[index] + offset, normal);
    }
    for span in 0..span_count {
        let base = (span * 2) as u32;
        let next = (((span + 1) % points.len()) * 2) as u32;
        mesh.add_triangle(base, base + 1, next + 1);
        mesh.add_triangle(base, next + 1, next);
    }
    mesh
}

fn stable_unit_direction(direction: Vector3<f64>) -> Option<Vector3<f64>> {
    // Scaling by the largest component before taking the norm avoids both
    // squaring underflow for subnormal/tiny spans and overflow for huge ones.
    // Consecutive exact duplicates were removed above, so zero is genuinely
    // degenerate; returning None keeps the frame arrays aligned with spans.
    let scale = direction
        .x
        .abs()
        .max(direction.y.abs())
        .max(direction.z.abs());
    if scale == 0.0 || !scale.is_finite() {
        return None;
    }
    let scaled = direction / scale;
    Some(scaled / scaled.norm())
}

fn transported_frame(
    direction: Vector3<f64>,
    previous_right: Option<&Vector3<f64>>,
    previous_normal: Option<&Vector3<f64>>,
) -> (Vector3<f64>, Vector3<f64>) {
    let Some(previous_normal) = previous_normal else {
        let right = perpendicular(direction);
        return (right, right.cross(&direction));
    };
    if let Some(normal) = (*previous_normal - direction * previous_normal.dot(&direction))
        .try_normalize(PARALLEL_EPSILON)
    {
        return (direction.cross(&normal).normalize(), normal);
    }
    if let Some(right) = previous_right.and_then(|previous| {
        (*previous - direction * previous.dot(&direction)).try_normalize(PARALLEL_EPSILON)
    }) {
        return (right, right.cross(&direction));
    }
    let right = perpendicular(direction);
    (right, right.cross(&direction))
}

fn perpendicular(direction: Vector3<f64>) -> Vector3<f64> {
    let cross_z = direction.cross(&Vector3::new(0.0, 0.0, 1.0));
    if cross_z.norm() > PARALLEL_EPSILON {
        cross_z.normalize()
    } else {
        direction.cross(&Vector3::new(1.0, 0.0, 0.0)).normalize()
    }
}

fn join_offset(index: usize, rights: &[Vector3<f64>], closed: bool) -> Vector3<f64> {
    let width = RIBBON_HALF_WIDTH_FILE_UNITS;
    if !closed && index == 0 {
        return rights[0] * width;
    }
    if !closed && index == rights.len() {
        return rights[index - 1] * width;
    }

    let incoming = rights[(index + rights.len() - 1) % rights.len()];
    let outgoing = rights[index];
    let Some(miter) = (incoming + outgoing).try_normalize(PARALLEL_EPSILON) else {
        return incoming * width;
    };
    let projection = miter.dot(&incoming).abs();
    if projection <= PARALLEL_EPSILON {
        return incoming * width;
    }
    // Bound near-reversal miters: a diagnostic ribbon must not grow a spike
    // many times longer than its authored half-width.
    miter * (width / projection).min(width * 4.0)
}

fn join_normal(index: usize, normals: &[Vector3<f64>], closed: bool) -> Vector3<f64> {
    if !closed && index == 0 {
        return normals[0];
    }
    if !closed && index == normals.len() {
        return normals[index - 1];
    }
    (normals[(index + normals.len() - 1) % normals.len()] + normals[index])
        .try_normalize(PARALLEL_EPSILON)
        .unwrap_or(normals[(index + normals.len() - 1) % normals.len()])
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

#[cfg(test)]
#[path = "structural_edge_tests.rs"]
mod tests;
