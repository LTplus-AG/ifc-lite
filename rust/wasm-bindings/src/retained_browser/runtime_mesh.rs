// SPDX-License-Identifier: MPL-2.0
//! Admit the wire counts before copying JS arrays into a retained receipt.
use super::{bridge::Mesh, runtime::field, BrowserError};
use ifc_lite_geometry::document::{retained_wire::MeshInfo, RetainedTessellation};
use wasm_bindgen::JsValue;

pub(super) fn decode(value: JsValue, max_bytes: u32) -> Result<RetainedTessellation, BrowserError> {
    let invalid = |message: &str| BrowserError::Driver(message.into());
    let bytes = js_sys::Uint8Array::new(&field(&value, "wire_info")?).to_vec();
    let info = MeshInfo::decode(&bytes).map_err(invalid)?;
    // A malformed mesh is transport failure; a valid but oversized mesh is a
    // resource refusal and can release its result while preserving the inputs.
    info.buffer_bytes(u64::MAX).map_err(invalid)?;
    info.buffer_bytes(u64::from(max_bytes))
        .map_err(|message| BrowserError::ResourceLimit(message.into()))?;
    let mesh: Mesh = serde_wasm_bindgen::from_value(value)
        .map_err(|error| BrowserError::Driver(error.to_string()))?;
    if mesh.positions.len() as u64 != u64::from(info.vertices) * 3
        || mesh.indices.len() as u64 != u64::from(info.triangles) * 3
        || mesh.flat_corner_normals.len() as u64 != u64::from(info.triangles) * 9
        || mesh.revision_local_faces.len() as u64 != u64::from(info.triangles)
        || mesh.source_face_count != info.faces
        || mesh.boundary_edges != info.boundary
        || mesh.spine_edges != info.spine
    {
        return Err(invalid("mesh arrays disagree with wire counts"));
    }
    Ok(RetainedTessellation {
        positions: mesh.positions,
        indices: mesh.indices,
        flat_corner_normals: mesh.flat_corner_normals,
        revision_local_faces: mesh.revision_local_faces,
        source_face_count: mesh.source_face_count,
        boundary_edges: mesh.boundary_edges,
        spine_edges: mesh.spine_edges,
    })
}
