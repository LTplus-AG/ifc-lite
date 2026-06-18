// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC Z-up → WebGL Y-up boundary conversion for the native desktop path.
//!
//! The shared [`ifc_lite_processing`] pipeline emits geometry in **IFC Z-up**,
//! native units already resolved. The browser applies the Z-up → Y-up swap at
//! its WASM/JS boundary (`wasm-bindings/src/zero_copy.rs::MeshDataJs::new`); the
//! native desktop bridge feeds the *same* viewer scene, so it must apply the
//! identical conversion here — otherwise native-loaded models render mirrored or
//! axis-swapped relative to WASM-loaded ones.
//!
//! The conversion is intentionally a faithful mirror of `MeshDataJs::new`:
//!
//! - positions/normals: `newX = x`, `newY = z`, `newZ = -y`
//! - triangle winding reversed (`swap(i + 1, i + 2)`) to compensate the
//!   handedness flip
//! - the per-mesh `origin` (the f64 local frame that `positions` are stored
//!   relative to) is **folded into the positions** and swapped the same way, so
//!   the wire format can stay origin-less (the `NativeBridge` packed/mesh-array
//!   contract carries no origin field).

use ifc_lite_processing::MeshData;

/// A mesh prepared for the `NativeBridge` wire: absolute (origin-folded) vertex
/// data already converted to the renderer's WebGL Y-up frame.
#[derive(Debug, Clone, PartialEq)]
pub struct WireMesh {
    /// Express id of the source IFC element.
    pub express_id: u32,
    /// IFC type name (e.g. `IfcWall`). Carried on the mesh-array event; the
    /// packed-shard format drops it (the decoder does not read it).
    pub ifc_type: String,
    /// Vertex positions (x, y, z triplets), WebGL Y-up, origin folded in.
    pub positions: Vec<f32>,
    /// Vertex normals (x, y, z triplets), WebGL Y-up.
    pub normals: Vec<f32>,
    /// Triangle indices, local to this mesh's vertices, winding reversed.
    pub indices: Vec<u32>,
    /// RGBA colour in 0..1.
    pub color: [f32; 4],
}

/// Convert a pipeline [`MeshData`] (IFC Z-up, positions relative to `origin`)
/// into a [`WireMesh`] (WebGL Y-up, absolute positions).
///
/// Takes `&MeshData` and only clones what it must: `positions`/`normals` are
/// rebuilt regardless, and `indices` are cloned so the winding can be reversed
/// in place without mutating the caller's mesh.
pub fn prepare_wire_mesh(mesh: &MeshData) -> WireMesh {
    let origin = mesh.origin; // [f64; 3], world/RTC frame; positions are relative to it.

    // Positions: fold the f64 origin in (precision-preserving add), then swap
    // IFC Z-up → WebGL Y-up. With origin = [0,0,0] this reduces exactly to the
    // `zero_copy.rs` f32 swap (the f32→f64→f32 round-trip is lossless).
    let mut positions = Vec::with_capacity(mesh.positions.len());
    for chunk in mesh.positions.chunks_exact(3) {
        let x = chunk[0] as f64 + origin[0];
        let y = chunk[1] as f64 + origin[1];
        let z = chunk[2] as f64 + origin[2];
        positions.push(x as f32); // new X = old X
        positions.push(z as f32); // new Y = old Z (up)
        positions.push(-(y as f32)); // new Z = -old Y
    }

    // Normals are directions — no origin, just the axis swap.
    let mut normals = Vec::with_capacity(mesh.normals.len());
    for chunk in mesh.normals.chunks_exact(3) {
        normals.push(chunk[0]);
        normals.push(chunk[2]);
        normals.push(-chunk[1]);
    }

    // Reverse winding to compensate the handedness flip.
    let mut indices = mesh.indices.clone();
    let remainder = indices.len() % 3;
    let end = indices.len() - remainder;
    let mut i = 0;
    while i < end {
        indices.swap(i + 1, i + 2);
        i += 3;
    }

    WireMesh {
        express_id: mesh.express_id,
        ifc_type: mesh.ifc_type.clone(),
        positions,
        normals,
        indices,
        color: mesh.color,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mesh_with(positions: Vec<f32>, normals: Vec<f32>, indices: Vec<u32>) -> MeshData {
        MeshData::new(7, "IfcWall".to_string(), positions, normals, indices, [1.0, 0.0, 0.0, 1.0])
    }

    #[test]
    fn axis_swap_matches_zero_copy_convention() {
        // One triangle, no origin. Expect newX=x, newY=z, newZ=-y per vertex.
        let mesh = mesh_with(
            vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0],
            vec![0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0],
            vec![0, 1, 2],
        );
        let wire = prepare_wire_mesh(&mesh);
        assert_eq!(wire.positions, vec![1.0, 3.0, -2.0, 4.0, 6.0, -5.0, 7.0, 9.0, -8.0]);
        assert_eq!(wire.normals, vec![0.0, 1.0, -0.0, 0.0, 0.0, -1.0, 1.0, 0.0, -0.0]);
    }

    #[test]
    fn winding_is_reversed() {
        let mesh = mesh_with(
            vec![0.0; 9],
            vec![0.0; 9],
            vec![0, 1, 2, 10, 11, 12],
        );
        let wire = prepare_wire_mesh(&mesh);
        // swap(i+1, i+2) on each triangle.
        assert_eq!(wire.indices, vec![0, 2, 1, 10, 12, 11]);
    }

    #[test]
    fn origin_is_folded_into_positions() {
        let mut mesh = mesh_with(vec![1.0, 1.0, 1.0], vec![0.0, 0.0, 1.0], vec![]);
        mesh.origin = [100.0, 200.0, 300.0];
        let wire = prepare_wire_mesh(&mesh);
        // world = position + origin = (101, 201, 301), then Z-up→Y-up.
        assert_eq!(wire.positions, vec![101.0, 301.0, -201.0]);
        // normal is unaffected by origin.
        assert_eq!(wire.normals, vec![0.0, 1.0, -0.0]);
    }

    #[test]
    fn non_multiple_of_three_indices_keep_tail_untouched() {
        // Defensive: a stray non-triangle tail must not panic or shuffle.
        let mesh = mesh_with(vec![0.0; 3], vec![0.0; 3], vec![0, 1, 2, 3]);
        let wire = prepare_wire_mesh(&mesh);
        assert_eq!(wire.indices, vec![0, 2, 1, 3]);
    }
}
