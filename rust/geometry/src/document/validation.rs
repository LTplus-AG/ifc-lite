// SPDX-License-Identifier: MPL-2.0

use super::DocumentError;
use crate::Mesh;

pub(super) fn validate_mesh(mesh: &Mesh) -> Result<(), DocumentError> {
    let invalid = DocumentError::InvalidMesh;
    if !mesh.positions.len().is_multiple_of(3) || !mesh.indices.len().is_multiple_of(3) {
        return Err(invalid(
            "positions and indices must contain complete triples",
        ));
    }
    if !mesh.positions.iter().all(|v| v.is_finite()) {
        return Err(invalid("positions must be finite"));
    }
    if !mesh.normals.is_empty() && mesh.normals.len() != mesh.positions.len() {
        return Err(invalid("normals must be absent or match vertex positions"));
    }
    if !mesh.normals.iter().all(|v| v.is_finite()) {
        return Err(invalid("normals must be finite"));
    }
    if mesh
        .indices
        .iter()
        .any(|&index| index as usize >= mesh.positions.len() / 3)
    {
        return Err(invalid("triangle index exceeds vertex count"));
    }
    if mesh.origin != [0.0; 3]
        || mesh.rtc_applied
        || mesh.local_to_world.is_some()
        || mesh.instance_meta.is_some()
    {
        return Err(DocumentError::UnsupportedFrame);
    }
    Ok(())
}

pub(super) fn validate_transform(values: &[f64; 16]) -> Result<(), DocumentError> {
    if !values.iter().all(|v| v.is_finite()) || values[12..] != [0.0, 0.0, 0.0, 1.0] {
        return Err(DocumentError::InvalidTransform);
    }
    let matrix = nalgebra::Matrix4::from_row_slice(values);
    match matrix.try_inverse() {
        Some(inverse) if inverse.iter().all(|v| v.is_finite()) => Ok(()),
        _ => Err(DocumentError::InvalidTransform),
    }
}
