// SPDX-License-Identifier: MPL-2.0
//! smooth-within-face/1: angle-weighted, world-space, per-corner normals.
use super::super::super::{error::budget_checkpoint, publication::ShapePart, OwnedResourceContext,
    RetainedExecutionError, runtime::RuntimeFault, Storage};
use ifc_lite_geometry::resource;
use super::super::face_attribution::oriented;

#[path = "normals_plane.rs"]
pub(super) mod plane;

#[derive(Clone, Copy)]
struct Corner {
    normal: [f64; 3],
    angle: f64,
    face: u32,
}

fn invalid() -> RetainedExecutionError {
    RetainedExecutionError::Runtime(RuntimeFault::contract("invalid retained normal mesh"))
}

fn work(resources: &OwnedResourceContext, count: usize) -> Result<(), RetainedExecutionError> {
    resources.with_scope(|| {
        budget_checkpoint()?;
        resource::charge(resource::Cost { work: count as u64, ..Default::default() })
            .map_err(RetainedExecutionError::Stopped)?.retain();
        Ok(())
    })
}

pub(super) fn validate(part: &ShapePart) -> Result<(), RetainedExecutionError> {
    if !part.positions.len().is_multiple_of(3) || part.indices.is_empty() || !part.indices.len().is_multiple_of(3)
        || part.revision_local_faces.len() != part.indices.len() / 3
        || part.world_from_object.iter().chain(&part.positions).any(|v| !v.is_finite())
        || part.indices.iter().any(|&i| i as usize >= part.positions.len() / 3) {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn positive_frame(part: &ShapePart) -> Result<bool, RetainedExecutionError> {
    let m = &part.world_from_object;
    let determinant = dot([m[0],m[1],m[2]],cross([m[4],m[5],m[6]],[m[8],m[9],m[10]]));
    if !determinant.is_finite() || determinant == 0. { return Err(invalid()); }
    Ok(determinant > 0.)
}

pub(super) fn corner_normals(part: &ShapePart, angle_degrees: f64,
    resources: &OwnedResourceContext, storage: &mut Storage) -> Result<Vec<f64>, RetainedExecutionError> {
    validate(part)?;
    if !angle_degrees.is_finite() || angle_degrees <= 0. || angle_degrees > 180. { return Err(invalid()); }
    let mut scratch = Storage::default();
    let count = part.indices.len().checked_mul(3)
        .ok_or_else(|| RetainedExecutionError::Stopped(resource::overflow()))?;
    let mut normals = Vec::new();
    storage.reserve(resources, &mut normals, count)?;
    normals.resize(count, 0.);
    if let Some(planes) = &part.normals {
        if planes.len() != count { return Err(invalid()); }
        normals.copy_from_slice(planes);
    }
    let mut corners = Vec::new();
    let mut order = Vec::new();
    scratch.reserve(resources, &mut corners, part.indices.len())?;
    scratch.reserve(resources, &mut order, part.indices.len())?;
    for (t, triangle) in part.indices.chunks_exact(3).enumerate() {
        work(resources, 1)?;
        let face = part.revision_local_faces[t];
        // M11-F already verified every vertex of this source plane. No
        // adjacency or angle evaluation is needed, even for a huge cap fan.
        if normals[t*9..t*9+3].iter().any(|&n| n != 0.) {
            corners.extend([Corner { normal: [0.;3], angle: 0., face }; 3]);
            continue;
        }
        let points: [[f64;3];3] = std::array::from_fn(|c| {
            let i = triangle[c] as usize * 3;
            [part.positions[i],part.positions[i+1],part.positions[i+2]]
        });
        // Translation cancels before the f64 world transform, including survey offsets.
        let edges: [[f64;3];3] = std::array::from_fn(|i|
            world_vector(&part.world_from_object,sub(points[(i+1)%3],points[i])));
        // Same M11-F rule/registry key: non-oriented facets have no weight and
        // no crease-reference authority. Keep the test in the mesh's own frame.
        let normal = if oriented(&points) { Some(unit(cross(edges[0],edges[1]))?) } else { None };
        for i in 0..3 {
            let angle = if normal.is_some() {
                let a = unit(edges[i])?;
                let b = unit(edges[(i+2)%3].map(|v| -v))?;
                let angle = libm::atan2(length(cross(a,b)),dot(a,b));
                if !angle.is_finite() || angle <= 0. { return Err(invalid()); }
                angle
            } else { 0. };
            order.push(corners.len());
            corners.push(Corner { normal: normal.unwrap_or([0.;3]), angle, face });
        }
    }
    // Bucket by vertex AND face before comparing; unrelated faces never cost
    // quadratic work. Charge a comparison-sort upper bound as well as scans.
    work(resources, order.len().saturating_mul(order.len().max(1).ilog2() as usize + 1))?;
    order.sort_unstable_by_key(|&i| (part.indices[i],corners[i].face,i));
    let threshold = libm::cos((2. * angle_degrees).min(180.).to_radians());
    let mut start = 0;
    while start < order.len() {
        let first = order[start];
        let mut end = start+1;
        while end < order.len() && part.indices[order[end]] == part.indices[first]
            && corners[order[end]].face == corners[first].face { end += 1; }
        smooth_group(&corners,&order[start..end],threshold,&mut normals,resources)?;
        start = end;
    }
    Ok(normals)
}

fn smooth_group(corners: &[Corner], group: &[usize], threshold: f64, normals: &mut [f64],
    resources: &OwnedResourceContext) -> Result<(),RetainedExecutionError> {
    let mut mean = [0.;3];
    for &index in group {
        work(resources,1)?;
        let c = corners[index];
        for (s,n) in mean.iter_mut().zip(c.normal) { *s += c.angle * n; }
    }
    for &index in group {
        let own = corners[index];
        let mut sum = mean;
        if own.angle > 0. {
            sum = [0.;3];
            for &adjacent in group {
                work(resources,1)?;
                let candidate = corners[adjacent];
                if candidate.angle > 0. && dot(own.normal,candidate.normal) >= threshold {
                    for (s,n) in sum.iter_mut().zip(candidate.normal) { *s += candidate.angle * n; }
                }
            }
        }
        normals[index*3..index*3+3].copy_from_slice(&unit(sum)?);
    }
    Ok(())
}

fn world_vector(m: &[f64; 16], p: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2])
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { std::array::from_fn(|i| a[i] - b[i]) }
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 { a.into_iter().zip(b).map(|(a,b)| a*b).sum() }
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
}
fn length(a: [f64; 3]) -> f64 { dot(a, a).sqrt() }
fn unit(a: [f64; 3]) -> Result<[f64; 3], RetainedExecutionError> {
    let norm = length(a);
    if !norm.is_finite() || norm == 0. { return Err(invalid()); }
    Ok(a.map(|v| v / norm))
}

#[cfg(test)]
#[path = "normals_tests.rs"]
mod tests;
