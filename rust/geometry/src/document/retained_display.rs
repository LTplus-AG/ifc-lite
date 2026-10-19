// SPDX-License-Identifier: MPL-2.0
//! Deliberate flat-corner f64 -> display mesh boundary.
use super::{RetainedCompletion, RetainedRefusal};
use crate::Mesh;
pub(super) fn display_mesh(packet: &RetainedCompletion) -> Result<Mesh, RetainedRefusal> {
    let data = &packet.tessellation;
    let corners = data.indices.len();
    if !data.positions.len().is_multiple_of(3)
        || corners == 0
        || !corners.is_multiple_of(3)
        || corners.checked_mul(3) != Some(data.flat_corner_normals.len())
        || data.revision_local_faces.len() != corners / 3
        || data
            .revision_local_faces
            .iter()
            .any(|&face| face >= data.source_face_count)
        || data.boundary_edges != 0
        || data.spine_edges != 0
        || corners > u32::MAX as usize
    {
        return Err(RetainedRefusal::InvalidSource(
            "invalid retained tessellation",
        ));
    }
    let mut mesh = Mesh::new();
    // Flat-corner shading requires expansion; averaging would fabricate smooth
    // analytic normals and could cross a revision-local surface boundary.
    for (corner, &index) in data.indices.iter().enumerate() {
        let offset = (index as usize)
            .checked_mul(3)
            .ok_or(RetainedRefusal::InvalidSource("index overflow"))?;
        let end = offset
            .checked_add(3)
            .ok_or(RetainedRefusal::InvalidSource("index overflow"))?;
        let point = data
            .positions
            .get(offset..end)
            .ok_or(RetainedRefusal::InvalidSource("position index"))?;
        for (&p, &n) in point
            .iter()
            .zip(&data.flat_corner_normals[corner * 3..corner * 3 + 3])
        {
            if !p.is_finite()
                || !n.is_finite()
                || !(p as f32).is_finite()
                || !(n as f32).is_finite()
            {
                return Err(RetainedRefusal::InvalidSource(
                    "display narrowing overflows",
                ));
            }
            mesh.positions.push(p as f32);
            mesh.normals.push(n as f32);
        }
        mesh.indices.push(corner as u32);
    }
    for triangle in mesh.positions.chunks_exact(9) {
        let p = |i| {
            nalgebra::Vector3::<f64>::new(
                f64::from(triangle[i]),
                f64::from(triangle[i + 1]),
                f64::from(triangle[i + 2]),
            )
        };
        let area = (p(3) - p(0)).cross(&(p(6) - p(0))).norm();
        if !area.is_finite() || area == 0.0 {
            return Err(RetainedRefusal::InvalidSource(
                "display narrowing collapses triangle",
            ));
        }
    }
    Ok(mesh)
}

#[cfg(test)]
#[path = "retained_display_tests.rs"]
mod tests;
