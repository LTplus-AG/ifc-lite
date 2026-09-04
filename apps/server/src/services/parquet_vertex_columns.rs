// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One shape's vertex columns, in the Y-up wire frame.
//!
//! The Z-up to Y-up swap is applied here, once, server-side, so no client
//! repeats it per vertex (IFC is Z-up, WebGL is Y-up). Separate from
//! `parquet_mesh_tables.rs` because it is per-SHAPE work: it knows nothing
//! about which mesh rows point at the block it produces.

use crate::services::axis::zup_to_yup;
use crate::types::MeshData;

/// One shape's six Y-up vertex columns in `vertex_schema()` order,
/// `(x, y, z, nx, ny, nz)`. Named because every slot has the same type and the
/// positional pairing is what keeps positions out of the normal columns.
pub(super) type VertexColumns = (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>);

pub(super) fn shape_vertices(mesh: &MeshData) -> VertexColumns {
    let vert_count = mesh.positions.len() / 3;
    let mut px = Vec::with_capacity(vert_count);
    let mut py = Vec::with_capacity(vert_count);
    let mut pz = Vec::with_capacity(vert_count);
    let mut nx = Vec::with_capacity(vert_count);
    let mut ny = Vec::with_capacity(vert_count);
    let mut nz = Vec::with_capacity(vert_count);

    // Some IFC pipelines (e.g. advanced_brep) yield meshes with positions but
    // no normals. The schema requires non-null normal columns, so pad with
    // zeros and let the client recompute them from positions.
    let has_normals = mesh.normals.len() == mesh.positions.len();
    if !has_normals && !mesh.normals.is_empty() {
        tracing::warn!(
            express_id = mesh.express_id,
            ifc_type = %mesh.ifc_type,
            positions = mesh.positions.len(),
            normals = mesh.normals.len(),
            "Mesh normals length mismatch; emitting zero normals"
        );
    }

    for i in 0..vert_count {
        let (x, y, z) = zup_to_yup(
            mesh.positions[i * 3],
            mesh.positions[i * 3 + 1],
            mesh.positions[i * 3 + 2],
        );
        px.push(x);
        py.push(y);
        pz.push(z);

        if has_normals {
            let (x, y, z) = zup_to_yup(
                mesh.normals[i * 3],
                mesh.normals[i * 3 + 1],
                mesh.normals[i * 3 + 2],
            );
            nx.push(x);
            ny.push(y);
            nz.push(z);
        } else {
            nx.push(0.0);
            ny.push(0.0);
            nz.push(0.0);
        }
    }
    (px, py, pz, nx, ny, nz)
}
