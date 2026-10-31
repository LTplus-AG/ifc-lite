// SPDX-License-Identifier: MPL-2.0
//! Source-exact `IfcTessellatedFaceSet` requests (wire format 3, #8291).
//!
//! The authored triangles are the geometry: an uncut item publishes them with
//! no numerical runtime, and nothing here approximates or repairs them. Only a
//! Boolean or affine copy asks a runtime to build the closed solid they bound.
//!
//! Wire format 3 (little-endian, evaluation frame in metres):
//! - header: `u32` format = 3, vertex count, triangle count, row count.
//! - `f64` xyz per vertex, relative to the first authored vertex.
//! - `u32` corners, three per triangle, wound as published.
//! - `u32` source row per triangle: its `CoordIndex` row or `Faces` position.

use super::{EvaluationBounds, RegionQualification, RetainedCompletion, RetainedRefusal, RetainedTessellation, SweepPayload};
use super::retained_sweep::MAX_LOCAL_M;
use nalgebra::{Matrix4, Vector3};

const HEADER_BYTES: usize = 16;

/// One authored face set after `PnIndex`, triangulation and outward orientation.
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedFaceSet {
    pub source_id: u32,
    /// Flat xyz in raw IFC file length units, full f64.
    pub positions: Vec<f64>,
    /// Three corners per triangle, indexing `positions`.
    pub triangles: Vec<u32>,
    /// One authored row per triangle, below `row_count`.
    pub rows: Vec<u32>,
    pub row_count: u32,
    /// Raw IFC file length unit -> metres.
    pub length_unit_scale: f64,
}

fn invalid(message: &'static str) -> RetainedRefusal {
    RetainedRefusal::InvalidSource(message)
}

impl RetainedFaceSet {
    pub(crate) fn lower(&self) -> Result<SweepPayload, RetainedRefusal> {
        let units = self.length_unit_scale;
        if !units.is_finite() || units <= 0. { return Err(invalid("invalid source length units")); }
        let vertices = self.positions.len() / 3;
        let triangles = self.triangles.len() / 3;
        if !self.positions.len().is_multiple_of(3) || !self.triangles.len().is_multiple_of(3)
            || vertices == 0 || triangles == 0 || self.rows.len() != triangles {
            return Err(invalid("inconsistent or empty face set"));
        }
        if self.triangles.iter().any(|&corner| corner as usize >= vertices)
            || self.rows.iter().any(|&row| row >= self.row_count) {
            return Err(invalid("face set index outside its source lists"));
        }
        let (Ok(vertex_count), Ok(triangle_count)) = (u32::try_from(vertices), u32::try_from(triangles))
            else { return Err(invalid("face set exceeds the request format")) };
        let anchor = [self.positions[0], self.positions[1], self.positions[2]];
        let scale = Matrix4::new_scaling(1. / units);
        let source_from_evaluation = Matrix4::new_translation(&Vector3::from(anchor)) * scale;
        let inverse = source_from_evaluation.try_inverse()
            .ok_or(invalid("singular evaluation frame"))?;
        if source_from_evaluation.iter().chain(inverse.iter()).any(|v| !v.is_finite()) {
            return Err(invalid("evaluation frame overflows"));
        }
        let mut bytes = Vec::with_capacity(HEADER_BYTES + vertices * 24 + triangles * 16);
        for value in [3, vertex_count, triangle_count, self.row_count] { bytes.extend(u32::to_le_bytes(value)); }
        let mut local = Vec::with_capacity(vertices);
        for p in self.positions.chunks_exact(3) {
            let point: [f64; 3] = std::array::from_fn(|i| (p[i] - anchor[i]) * units);
            if point.iter().any(|v| !v.is_finite() || v.abs() > MAX_LOCAL_M) {
                return Err(invalid("face set outside local numerical domain"));
            }
            for value in point { bytes.extend(value.to_le_bytes()); }
            local.push(point);
        }
        for value in self.triangles.iter().chain(&self.rows) { bytes.extend(value.to_le_bytes()); }
        let array = |m: &Matrix4<f64>| -> [f64; 16] { std::array::from_fn(|i| m[i]) };
        Ok(SweepPayload {
            evaluation_bounds: EvaluationBounds::points(local),
            format: 3,
            bytes,
            segments: triangle_count,
            loops: 1,
            qualification: RegionQualification::SourceFaceSet,
            source_from_evaluation: array(&source_from_evaluation),
            evaluation_from_source: array(&inverse),
        })
    }
}

/// Decode wire format 3 into a kernel-free tessellation: `revision_local_faces`
/// are source rows and every triangle keeps its authored corners and order.
fn source_tessellation(bytes: &[u8]) -> Option<RetainedTessellation> {
    let word = |at: usize| Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    let (format, vertices, triangles, row_count) = (word(0)?, word(4)? as usize, word(8)? as usize, word(12)?);
    let corners_at = vertices.checked_mul(24)?.checked_add(HEADER_BYTES)?;
    let rows_at = triangles.checked_mul(12)?.checked_add(corners_at)?;
    if format != 3 || triangles.checked_mul(4)?.checked_add(rows_at)? != bytes.len() { return None; }
    let positions: Vec<f64> = bytes[HEADER_BYTES..corners_at].chunks_exact(8)
        .map(|v| f64::from_le_bytes(v.try_into().unwrap_or_default())).collect();
    let words = |slice: &[u8]| -> Vec<u32> { slice.chunks_exact(4)
        .map(|v| u32::from_le_bytes(v.try_into().unwrap_or_default())).collect() };
    let indices = words(&bytes[corners_at..rows_at]);
    let revision_local_faces = words(&bytes[rows_at..]);
    let mut flat_corner_normals = Vec::with_capacity(triangles * 9);
    for triangle in indices.chunks_exact(3) {
        let point = |i: u32| -> Option<[f64; 3]> {
            let p = positions.get(i as usize * 3..i as usize * 3 + 3)?;
            Some([p[0], p[1], p[2]])
        };
        let (a, b, c) = (point(triangle[0])?, point(triangle[1])?, point(triangle[2])?);
        let normal = Vector3::from(std::array::from_fn(|i| b[i] - a[i]))
            .cross(&Vector3::from(std::array::from_fn(|i| c[i] - a[i])));
        let normal = normal.try_normalize(0.)?;
        for _ in 0..3 { flat_corner_normals.extend([normal.x, normal.y, normal.z]); }
    }
    Some(RetainedTessellation { positions, indices, flat_corner_normals, revision_local_faces,
        source_face_count: row_count, boundary_edges: 0, spine_edges: 0 })
}

impl super::RetainedRequest {
    /// The byte size of the completion [`Self::source_exact_completion`] seals: the same
    /// positions, indices, per-corner normals and faces a kernel mesh must fit its budget with.
    pub fn source_exact_mesh_bytes(&self) -> Option<usize> {
        let super::RetainedRecipe::FaceSet(set) = self.recipe() else { return None };
        set.positions.len().checked_mul(8)?.checked_add((set.triangles.len() / 3).checked_mul(88)?)
    }
    /// The kernel-free completion of a source-exact request, `None` for any other
    /// family. Open shells are valid here: no closed-solid claim is made.
    pub fn source_exact_completion(&self) -> Option<RetainedCompletion> {
        let payload = self.payload();
        if payload.qualification != RegionQualification::SourceFaceSet { return None; }
        Some(RetainedCompletion::new(self.clone(), source_tessellation(&payload.bytes)?,
            payload.source_from_evaluation, payload.evaluation_from_source))
    }
}

#[cfg(test)]
#[path = "retained_face_set_tests.rs"]
mod tests;
