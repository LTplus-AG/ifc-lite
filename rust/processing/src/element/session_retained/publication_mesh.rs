// SPDX-License-Identifier: MPL-2.0
//! Budgeted copy of authenticated mesh evidence, independent of the SDK.
use super::{runtime::ReceiptMesh, publication::ShapePart, Storage, OwnedResourceContext, RetainedExecutionError};

pub(super) fn copy_part(mesh: ReceiptMesh<'_>, world_from_object: [f64; 16], curved: bool,
    resources: &OwnedResourceContext, storage: &mut Storage) -> Result<ShapePart, RetainedExecutionError> {
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    let mut revision_local_faces = Vec::new();
    storage.reserve(resources, &mut positions, mesh.positions.len())?;
    storage.reserve(resources, &mut indices, mesh.indices.len())?;
    storage.reserve(resources, &mut revision_local_faces, mesh.faces.len())?;
    positions.extend_from_slice(mesh.positions);
    indices.extend_from_slice(mesh.indices);
    revision_local_faces.extend_from_slice(mesh.faces);
    Ok(ShapePart {
        halfspace_clipped: false, layer: None, capped_volume_m3: None, positions, indices, world_from_object, curved, revision_local_faces,
        normals: None, appearance: None, faces: None, instance_key: None, source_exact: false })
}
