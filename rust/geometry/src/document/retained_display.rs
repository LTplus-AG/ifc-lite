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
    validate_source_winding(data)?;
    let mut mesh = Mesh::new();
    // Expand source corners verbatim: no averaging across faces or seams.
    // The historical wire field name does not imply flat shading.
    for (corner, &index) in data.indices.iter().enumerate() {
        let point = indexed_point(data, index)?;
        let normal = &data.flat_corner_normals[corner * 3..corner * 3 + 3];
        let length = normal.iter().map(|n| n * n).sum::<f64>().sqrt();
        if !length.is_finite() || (length - 1.0).abs() > crate::math::tol::RETAINED_NORMAL_UNIT_EPS {
            return Err(invalid("normal must be finite nonzero unit length"));
        }
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
    for (triangle, normals) in mesh.positions.chunks_exact(9).zip(mesh.normals.chunks_exact(9)) {
        let p = |i: usize| {
            nalgebra::Vector3::new(
                f64::from(triangle[i]),
                f64::from(triangle[i + 1]),
                f64::from(triangle[i + 2]),
            )
        };
        let cross = (p(3) - p(0)).cross(&(p(6) - p(0)));
        let area = cross.norm();
        if !area.is_finite() || area == 0.0 {
            return Err(invalid("display narrowing collapses triangle"));
        }
        for n in normals.chunks_exact(3) {
            let normal = nalgebra::Vector3::new(f64::from(n[0]), f64::from(n[1]), f64::from(n[2]));
            if normal.dot(&(cross / area)) <= 0.0 {
                return Err(invalid("normal disagrees with display winding"));
            }
        }
    }
    Ok(mesh)
}

fn indexed_point(data: &RetainedTessellation, index: u32) -> Result<&[f64], RetainedRefusal> {
    let invalid = RetainedRefusal::InvalidTessellation;
    let offset = (index as usize).checked_mul(3).ok_or(invalid("index overflow"))?;
    offset.checked_add(3)
        .and_then(|end| data.positions.get(offset..end))
        .ok_or(invalid("position index"))
}

// Public completions need the same source-winding contract as worker output.
// Narrowing can reverse a tiny triangle, so display validation alone is insufficient.
fn validate_source_winding(data: &RetainedTessellation) -> Result<(), RetainedRefusal> {
    let invalid = RetainedRefusal::InvalidTessellation;
    for (indices, normals) in data.indices.chunks_exact(3)
        .zip(data.flat_corner_normals.chunks_exact(9))
    {
        let mut points = [nalgebra::Vector3::zeros(); 3];
        for (point, &index) in points.iter_mut().zip(indices) {
            let source = indexed_point(data, index)?;
            if source.iter().any(|v| !v.is_finite()) {
                return Err(invalid("source triangle must be finite nondegenerate"));
            }
            *point = nalgebra::Vector3::new(source[0], source[1], source[2]);
        }
        let cross = (points[1] - points[0]).cross(&(points[2] - points[0]));
        let area = cross.norm();
        if !area.is_finite() || area == 0.0 {
            return Err(invalid("source triangle must be finite nondegenerate"));
        }
        for n in normals.chunks_exact(3) {
            let dot = nalgebra::Vector3::new(n[0], n[1], n[2]).dot(&(cross / area));
            if !dot.is_finite() || dot <= 0.0 {
                return Err(invalid("normal disagrees with source winding"));
            }
        }
    }
    Ok(())
}
