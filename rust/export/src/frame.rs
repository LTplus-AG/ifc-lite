// SPDX-License-Identifier: MPL-2.0
//! IFC Z-up → WebGL Y-up frame conversion for the **from-bytes** exporters.
//!
//! `ifc_lite_processing::process_geometry` emits geometry in the producer-native
//! IFC **Z-up** frame. The Z-up→Y-up swap that every rendered/exported mesh
//! normally undergoes happens at the wasm FFI (`MeshDataJs::new`) — which the
//! from-bytes export path (CLI / MCP / SDK) never crosses. glTF 2.0 *mandates*
//! +Y up, and the viewer / legacy GLTFExporter output is Y-up, so the from-bytes
//! GLB/OBJ exporters must redo the identical conversion to match:
//!
//! - positions + normals: `(x, y, z) -> (x, z, -y)`
//! - triangle winding reversed (mirrors `MeshDataJs::new`, keeps front faces)
//! - per-element `origin` swapped the same way
//!
//! The from-meshes GLB path (the viewer's own `MeshData`) is already Y-up and
//! must NOT be re-swapped — only this from-bytes path applies it.

/// Convert a single IFC Z-up point/vector to WebGL Y-up: `(x, y, z) -> (x, z, -y)`.
#[inline]
pub(crate) fn yup_f32(p: [f32; 3]) -> [f32; 3] {
    [p[0], p[2], -p[1]]
}

/// Same conversion for an f64 point (the per-element `origin`).
#[inline]
pub(crate) fn yup_f64(p: [f64; 3]) -> [f64; 3] {
    [p[0], p[2], -p[1]]
}

/// One mesh's geometry converted from the IFC Z-up `process_geometry` frame into
/// the WebGL Y-up frame (owned buffers), ready to feed the shared glTF assembler.
pub(crate) struct YUpMesh {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub origin: [f64; 3],
}

/// Convert Z-up `positions`/`normals`/`indices`/`origin` to Y-up owned buffers.
///
/// The faceted-brep per-face vertex duplication is now collapsed at the mesh
/// SOURCE (`ifc_lite_processing::element::build_mesh_data` runs
/// `ifc_lite_geometry::mesh_weld::weld_indexed` on every element), so
/// `process_geometry`'s `MeshData` arrives pre-welded and this frame conversion
/// is a faithful pass-through — no export-local re-weld.
pub(crate) fn to_yup(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    origin: [f64; 3],
) -> YUpMesh {
    let mut p = Vec::with_capacity(positions.len());
    for c in positions.chunks_exact(3) {
        p.extend_from_slice(&yup_f32([c[0], c[1], c[2]]));
    }
    let mut n = Vec::with_capacity(normals.len());
    for c in normals.chunks_exact(3) {
        n.extend_from_slice(&yup_f32([c[0], c[1], c[2]]));
    }
    // Reverse winding to compensate the handedness convention (identical to
    // `MeshDataJs::new`): swap the 2nd/3rd index of every triangle.
    let mut idx = indices.to_vec();
    let tri_end = idx.len() - idx.len() % 3;
    let mut i = 0;
    while i < tri_end {
        idx.swap(i + 1, i + 2);
        i += 3;
    }
    YUpMesh { positions: p, normals: n, indices: idx, origin: yup_f64(origin) }
}
