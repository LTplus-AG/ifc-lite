// SPDX-License-Identifier: MPL-2.0
//! smooth-within-face/1: angle-weighted, world-space, per-corner normals.
use super::{Context, Requirement, ShapeOnlyProduct};
use super::super::{error::budget_checkpoint, publication::ShapePart, OwnedResourceContext,
    RetainedExecutionError, runtime::RuntimeFault, Storage};
use ifc_lite_geometry::resource;

// Twice the retained model driver's fixed 5 degree tessellation tolerance.
const CREASE_RADIANS: f64 = std::f64::consts::PI / 18.;

pub(super) fn apply(product: &mut ShapeOnlyProduct, context: &Context<'_>)
    -> Result<[Requirement; 1], RetainedExecutionError> {
    for part in &mut product.parts {
        part.normals = Some(corner_normals(part, context.resources, &mut product._storage)?);
    }
    Ok([Requirement::SurfaceNormals])
}

#[derive(Clone, Copy)]
struct Corner {
    normal: [f64; 3],
    angle: f64,
    face: u32,
    next: usize,
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

fn corner_normals(part: &ShapePart, resources: &OwnedResourceContext, storage: &mut Storage)
    -> Result<Vec<f64>, RetainedExecutionError> {
    if !part.positions.len().is_multiple_of(3) || part.indices.is_empty() || !part.indices.len().is_multiple_of(3)
        || part.revision_local_faces.len() != part.indices.len() / 3
        || part.world_from_object.iter().any(|v| !v.is_finite()) {
        return Err(invalid());
    }
    let mut scratch = Storage::default();
    let mut heads = Vec::new();
    let mut corners = Vec::new();
    scratch.reserve(resources, &mut heads, part.positions.len() / 3)?;
    scratch.reserve(resources, &mut corners, part.indices.len())?;
    heads.resize(part.positions.len() / 3, usize::MAX);
    for (t, triangle) in part.indices.chunks_exact(3).enumerate() {
        work(resources, 1)?;
        let mut points = [[0.; 3]; 3];
        for (corner, &index) in triangle.iter().enumerate() {
            let i = (index as usize).checked_mul(3).ok_or_else(invalid)?;
            let end = i.checked_add(3).ok_or_else(invalid)?;
            let xyz = part.positions.get(i..end).ok_or_else(invalid)?;
            if xyz.iter().any(|v| !v.is_finite()) { return Err(invalid()); }
            points[corner].copy_from_slice(xyz);
        }
        // Apply the controller's frame to differences. Translation cancels
        // algebraically, preserving f64 directions even at large world offsets.
        let edges: [[f64; 3]; 3] = std::array::from_fn(|i| {
            world_vector(&part.world_from_object, sub(points[(i + 1) % 3], points[i]))
        });
        let normal = unit(cross(edges[0], edges[1]))?;
        for (i, &vertex) in triangle.iter().enumerate() {
            let a = unit(edges[i])?;
            let b = unit(edges[(i + 2) % 3].map(|v| -v))?;
            let angle = length(cross(a, b)).atan2(dot(a, b));
            if !angle.is_finite() || angle <= 0. { return Err(invalid()); }
            let head = &mut heads[vertex as usize];
            corners.push(Corner { normal, angle, face: part.revision_local_faces[t], next: *head });
            *head = corners.len() - 1;
        }
    }
    let count = part.indices.len().checked_mul(3)
        .ok_or_else(|| RetainedExecutionError::Stopped(resource::overflow()))?;
    let mut normals = Vec::new();
    storage.reserve(resources, &mut normals, count)?;
    let threshold = CREASE_RADIANS.cos();
    for (index, own) in corners.iter().enumerate() {
        let mut sum = [0.; 3];
        let mut adjacent = heads[part.indices[index] as usize];
        // Internally built acyclic adjacency. Charge every comparison so
        // adversarial high-valence meshes cannot evade the work budget.
        while adjacent != usize::MAX {
            work(resources, 1)?;
            let candidate = &corners[adjacent];
            if candidate.face == own.face && dot(own.normal, candidate.normal) >= threshold {
                for (s, n) in sum.iter_mut().zip(candidate.normal) { *s += candidate.angle * n; }
            }
            adjacent = candidate.next;
        }
        normals.extend_from_slice(&unit(sum)?);
    }
    // The corner stream is the split-vertex representation consumed by both
    // exporters. Source positions, topology and revision-local faces stay intact.
    Ok(normals)
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
