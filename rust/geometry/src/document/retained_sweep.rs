// SPDX-License-Identifier: MPL-2.0
//! Numerical edge conversion. Source recipes remain unchanged and replayable.
//! This module grants no native/browser execution qualification.
use super::{RetainedExtrusion, RetainedRefusal};
use crate::analytic::AnalyticCurveSegment;
use nalgebra::{Matrix4, Vector4};
#[path = "retained_region.rs"]
mod region;

/// Evidence required from the actual execution path, not an SDK feature bit.
/// Neither variant itself grants execution authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegionQualification {
    Rectangle,
    OrderedRegion,
    RationalDisk,
}

pub struct SweepPayload {
    pub format: u32,
    pub bytes: Vec<u8>,
    pub segments: u32,
    pub loops: u32,
    pub qualification: RegionQualification,
    pub source_from_evaluation: [f64; 16],
    pub evaluation_from_source: [f64; 16],
}

pub fn lower(recipe: &RetainedExtrusion) -> Result<SweepPayload, RetainedRefusal> {
    super::retained::validate_source(recipe)?;
    let source = &recipe.source;
    let profile = source
        .profile
        .as_ref()
        .ok_or(RetainedRefusal::InvalidSource("missing profile"))?;
    let p = matrix(profile.profile_position)?;
    let solid = matrix(source.position_matrix)?;
    let units = recipe.length_unit_scale;
    // Worker coordinates stay in the profile XY frame. Its translation and all
    // solid placement stay in f64 outside the kernel, including survey origins.
    let first = &profile.loops[0].segments[0];
    let anchor = match first {
        AnalyticCurveSegment::Line { start, .. } => *start,
        AnalyticCurveSegment::Arc { center, .. } => *center,
    };
    if anchor[2] != 0.0 {
        return Err(RetainedRefusal::InvalidSource("profile must be in its XY plane"));
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
    // Depth/direction live in solid Position, independently of profile Position.
    let profile_inverse = p
        .try_inverse()
        .ok_or(RetainedRefusal::InvalidSource("profile frame"))?;
    let vector = profile_inverse * Vector4::new(axis[0], axis[1], axis[2], 0.0);
    let norm = vector[0].hypot(vector[1]).hypot(vector[2]);
    let depth = source
        .depth
        .ok_or(RetainedRefusal::InvalidSource("missing depth"))?
        * units;
    if !norm.is_finite() || norm <= 0.0 || !depth.is_finite() || depth <= 0.0 || vector[2] == 0.0 {
        return Err(RetainedRefusal::InvalidSource("invalid sweep extent"));
    }
    let (curves, qualification) = region::lower(profile, anchor, units)?;
    let segments = curves.iter().map(|boundary| boundary.len()).sum::<usize>() as u32;
    let loops = curves.len() as u32;
    let mut bytes = Vec::with_capacity(48 + curves.len() * 8 + segments as usize * 104);
    for value in [1, loops, segments, 0] {
        u32_bytes(&mut bytes, value);
    }
    for value in [vector[0] / norm, vector[1] / norm, vector[2] / norm, depth] {
        f64_bytes(&mut bytes, value)?;
    }
    if depth > 1e9 || depth * (vector[2] / norm).abs() <= 1e-12 {
        return Err(RetainedRefusal::InvalidSource("sweep outside local numerical domain"));
    }
    for (index, boundary) in curves.iter().enumerate() {
        u32_bytes(&mut bytes, u32::from(index != 0));
        u32_bytes(&mut bytes, boundary.len() as u32);
        for curve in boundary {
            u32_bytes(&mut bytes, curve.kind);
            u32_bytes(&mut bytes, 0);
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
fn matrix(values: Option<[f64; 16]>) -> Result<Matrix4<f64>, RetainedRefusal> {
    let matrix = values
        .map(|values| Matrix4::from_column_slice(&values))
        .unwrap_or_else(Matrix4::identity);
    let rigid = (0..3).all(|i| {
        (0..3).all(|j| {
            let dot = (0..3).map(|k| matrix[(k, i)] * matrix[(k, j)]).sum::<f64>();
            (dot - if i == j { 1.0 } else { 0.0 }).abs() < 1e-10
        })
    });
    if matrix.iter().any(|v| !v.is_finite())
        || !rigid
        || matrix[(3, 0)] != 0.0
        || matrix[(3, 1)] != 0.0
        || matrix[(3, 2)] != 0.0
        || matrix[(3, 3)] != 1.0
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
fn u32_bytes(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend(value.to_le_bytes());
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
