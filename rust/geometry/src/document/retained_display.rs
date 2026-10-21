// SPDX-License-Identifier: MPL-2.0
//! The one deliberate f64 retained tessellation -> f32 display mesh boundary.

use super::{RetainedRefusal, RetainedTessellation};
use crate::Mesh;

pub(super) fn display_mesh(data: &RetainedTessellation) -> Result<Mesh, RetainedRefusal> {
    let invalid = RetainedRefusal::InvalidTessellation;
    let corners = data.indices.len();
    if !data.positions.len().is_multiple_of(3)
        || corners == 0
        || !corners.is_multiple_of(3)
        || corners > u32::MAX as usize
        || corners.checked_mul(3) != Some(data.flat_corner_normals.len())
        || data.revision_local_faces.len() != corners / 3
        || data
            .revision_local_faces
            .iter()
            .any(|&face| face >= data.source_face_count)
    {
        return Err(invalid("buffer shape"));
    }
    if data.boundary_edges != 0 || data.spine_edges != 0 {
        return Err(invalid("open or non-manifold solid"));
    }
    let mut mesh = Mesh::new();
    // Flat corners require expansion: averaging would fabricate smooth
    // analytic normals and could cross a revision-local face boundary.
    for (corner, &index) in data.indices.iter().enumerate() {
        let offset = (index as usize)
            .checked_mul(3)
            .ok_or(invalid("index overflow"))?;
        let point = offset
            .checked_add(3)
            .and_then(|end| data.positions.get(offset..end))
            .ok_or(invalid("position index"))?;
        let normal = &data.flat_corner_normals[corner * 3..corner * 3 + 3];
        for (&p, &n) in point.iter().zip(normal) {
            let (narrow_p, narrow_n) = (p as f32, n as f32);
            if !narrow_p.is_finite() || !narrow_n.is_finite() {
                return Err(invalid("display narrowing overflows"));
            }
            mesh.positions.push(narrow_p);
            mesh.normals.push(narrow_n);
        }
        mesh.indices.push(corner as u32);
    }
    for triangle in mesh.positions.chunks_exact(9) {
        let p = |i: usize| {
            nalgebra::Vector3::new(
                f64::from(triangle[i]),
                f64::from(triangle[i + 1]),
                f64::from(triangle[i + 2]),
            )
        };
        let area = (p(3) - p(0)).cross(&(p(6) - p(0))).norm();
        if !area.is_finite() || area == 0.0 {
            return Err(invalid("display narrowing collapses triangle"));
        }
    }
    Ok(mesh)
}
