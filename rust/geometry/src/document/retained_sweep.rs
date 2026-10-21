// SPDX-License-Identifier: MPL-2.0
//! Ordered-region extrusion request encoding. The source recipe is never
//! modified; this module grants no execution qualification.
//!
//! Supported family: a linear extrusion of one planar region (one outer and up
//! to `MAX_LOOPS - 1` inner boundaries) whose boundaries are XY lines, partial
//! circular arcs or isolated full circles, under rigid profile and solid
//! placements. Everything else is refused.
//!
//! Wire format 1 (little-endian, evaluation frame in metres):
//! - header: `u32` format = 1, loop count, segment count, reserved 0;
//!   then `f64` unit extrusion direction x, y, z and depth.
//! - per loop: `u32` role (0 outer, 1 inner) and segment count.
//! - per segment: `u32` kind (1 line, 2 full circle, 3 arc), reserved 0, then
//!   twelve `f64`. Line: start xyz, end xyz, six zeros. Circle/arc: centre
//!   xyz, normal xyz, x-axis xyz, radius, start angle, signed sweep.
//!
//! Loops are emitted outer counter-clockwise and inner clockwise; the source
//! keeps its authored order, winding, trims and composite metadata.

use super::retained::validate_source;
use super::{RetainedExtrusion, RetainedRefusal};
use crate::analytic::AnalyticCurveSegment;
use crate::math::tol;
use nalgebra::{Matrix4, Vector4};

#[path = "retained_region.rs"]
mod region;

pub(super) const MAX_LOOPS: usize = 128;
pub(super) const MAX_SEGMENTS: usize = 8192;
/// Largest admitted coordinate or depth in the local evaluation frame (metres).
const MAX_LOCAL_M: f64 = 1e9;

/// Evidence the executing runtime must hold before evaluating a request. The
/// variant is derived from geometry, never from a type name alone, and holding
/// a request grants no execution authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RegionQualification {
    /// One parameterized rectangle with axis-aligned edges.
    Rectangle,
    /// Any other supported ordered region of lines, arcs and circles.
    OrderedRegion,
}

/// One encoded retained request.
#[derive(Debug)]
#[non_exhaustive]
pub struct SweepPayload {
    pub format: u32,
    pub bytes: Vec<u8>,
    pub segments: u32,
    pub loops: u32,
    pub qualification: RegionQualification,
    /// Column-major evaluation metres -> raw solid-local file units. Profile
    /// anchor, profile and solid placements stay here in f64, outside the
    /// worker, including survey-scale origins.
    pub source_from_evaluation: [f64; 16],
    pub evaluation_from_source: [f64; 16],
}

pub(super) fn lower(recipe: &RetainedExtrusion) -> Result<SweepPayload, RetainedRefusal> {
    validate_source(recipe)?;
    let source = &recipe.source;
    let profile = source
        .profile
        .as_ref()
        .ok_or(RetainedRefusal::InvalidSource("missing profile"))?;
    let p = rigid(profile.profile_position)?;
    let solid = rigid(source.position_matrix)?;
    let units = recipe.length_unit_scale;
    let anchor = match profile.loops[0].segments.first() {
        Some(AnalyticCurveSegment::Line { start, .. }) => *start,
        Some(AnalyticCurveSegment::Arc { center, .. }) => *center,
        None => return Err(RetainedRefusal::InvalidSource("empty boundary")),
    };
    if anchor[2] != 0.0 {
        return Err(RetainedRefusal::InvalidSource(
            "profile must be in its XY plane",
        ));
    }
    let translation = Matrix4::new_translation(&nalgebra::Vector3::from(anchor));
    let source_from_evaluation = solid * p * translation * Matrix4::new_scaling(1.0 / units);
    let inverse = source_from_evaluation
        .try_inverse()
        .ok_or(RetainedRefusal::InvalidSource("singular evaluation frame"))?;
    if source_from_evaluation
        .iter()
        .chain(inverse.iter())
        .any(|v| !v.is_finite())
    {
        return Err(RetainedRefusal::InvalidSource("evaluation frame overflows"));
    }
    let axis = source
        .axis_unit_vector
        .ok_or(RetainedRefusal::InvalidSource("missing direction"))?;
    // Direction lives in the solid frame, independently of profile Position.
    let profile_inverse = p
        .try_inverse()
        .ok_or(RetainedRefusal::InvalidSource("singular profile frame"))?;
    let vector = profile_inverse * Vector4::new(axis[0], axis[1], axis[2], 0.0);
    let norm = vector[0].hypot(vector[1]).hypot(vector[2]);
    let depth = source
        .depth
        .ok_or(RetainedRefusal::InvalidSource("missing depth"))?
        * units;
    if !norm.is_finite() || norm <= 0.0 || !depth.is_finite() || depth <= 0.0 || vector[2] == 0.0 {
        return Err(RetainedRefusal::InvalidSource("invalid sweep extent"));
    }
    if depth > MAX_LOCAL_M || depth * (vector[2] / norm).abs() <= tol::RETAINED_MIN_LENGTH_M {
        return Err(RetainedRefusal::InvalidSource(
            "sweep outside local numerical domain",
        ));
    }
    let (curves, qualification) = region::lower(profile, anchor, units)?;
    let segments: usize = curves.iter().map(Vec::len).sum();
    let mut bytes = Vec::with_capacity(48 + curves.len() * 8 + segments * 104);
    // Bounded by MAX_LOOPS and MAX_SEGMENTS in validate_source.
    let (loops, segments) = (curves.len() as u32, segments as u32);
    for value in [1, loops, segments, 0] {
        bytes.extend(value.to_le_bytes());
    }
    for value in [vector[0] / norm, vector[1] / norm, vector[2] / norm, depth] {
        f64_bytes(&mut bytes, value)?;
    }
    for (index, boundary) in curves.iter().enumerate() {
        bytes.extend(u32::from(index != 0).to_le_bytes());
        bytes.extend((boundary.len() as u32).to_le_bytes());
        for curve in boundary {
            bytes.extend(curve.kind.to_le_bytes());
            bytes.extend(0u32.to_le_bytes());
            for value in curve.values {
                f64_bytes(&mut bytes, value)?;
            }
        }
    }
    Ok(SweepPayload {
        format: 1,
        bytes,
        segments,
        loops,
        qualification,
        source_from_evaluation: array(source_from_evaluation),
        evaluation_from_source: array(inverse),
    })
}

/// Absent placements are identity; present ones must be proper rigid motions.
fn rigid(values: Option<[f64; 16]>) -> Result<Matrix4<f64>, RetainedRefusal> {
    let matrix = values.map_or_else(Matrix4::identity, |values| {
        Matrix4::from_column_slice(&values)
    });
    let orthonormal = (0..3).all(|i| {
        (0..3).all(|j| {
            let dot = (0..3).map(|k| matrix[(k, i)] * matrix[(k, j)]).sum::<f64>();
            (dot - if i == j { 1.0 } else { 0.0 }).abs() < tol::RETAINED_RIGID_DOT_EPS
        })
    });
    if matrix.iter().any(|v| !v.is_finite())
        || !orthonormal
        || matrix.fixed_view::<1, 4>(3, 0) != nalgebra::RowVector4::new(0.0, 0.0, 0.0, 1.0)
        || matrix.fixed_view::<3, 3>(0, 0).determinant() < 0.0
    {
        return Err(RetainedRefusal::InvalidSource(
            "source placement must be rigid",
        ));
    }
    Ok(matrix)
}

fn array(matrix: Matrix4<f64>) -> [f64; 16] {
    std::array::from_fn(|i| matrix.as_slice()[i])
}

fn f64_bytes(bytes: &mut Vec<u8>, value: f64) -> Result<(), RetainedRefusal> {
    if !value.is_finite() {
        return Err(RetainedRefusal::InvalidSource(
            "nonfinite curve coefficient",
        ));
    }
    bytes.extend(value.to_le_bytes());
    Ok(())
}

#[cfg(test)]
#[path = "retained_sweep_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "retained_region_tests.rs"]
mod region_tests;
