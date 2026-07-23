// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The ONE definition of the server wire's axis convention (issue #1841).
//!
//! IFC is Z-up; WebGL/glTF (and every ifc-lite client) is Y-up. Every server
//! transport therefore emits **Y-up metres**, and this module is the single
//! place that conversion is defined.
//!
//! It used to be open-coded inline in each parquet serializer and simply
//! MISSING from the JSON route, so `POST /api/v1/parse` shipped raw IFC Z-up
//! while the parquet endpoints shipped Y-up — the same class of silent
//! per-transport drift as the dropped `origin`. Keep every transport routed
//! through these helpers so the frame can never diverge again.

use ifc_lite_processing::MeshData;

/// Convert one position/normal triplet from IFC Z-up to WebGL Y-up:
/// X stays, new Y = old Z (vertical), new Z = -old Y (depth).
#[inline]
pub fn zup_to_yup(x: f32, y: f32, z: f32) -> (f32, f32, f32) {
    (x, z, -y)
}

/// The same swap for an f64 triplet — used for the per-mesh `origin`, which
/// must land in the SAME frame as the positions it offsets (the swap is
/// linear, so `swap(origin + position) == swap(origin) + swap(position)`).
#[inline]
pub fn zup_to_yup_f64(v: [f64; 3]) -> [f64; 3] {
    [v[0], v[2], -v[1]]
}

/// Rewrite a mesh into the Y-up wire frame in place: positions, normals, and
/// the per-mesh `origin` together, so the mesh stays internally consistent.
///
/// Used by the JSON transport, which serializes `MeshData` directly. The
/// parquet transports apply [`zup_to_yup`] fused into their columnar extraction
/// instead (same math, no extra pass over the vertices).
pub fn mesh_to_yup_in_place(mesh: &mut MeshData) {
    // Iterate only COMPLETE triplets. A malformed buffer whose length is not a
    // multiple of 3 must not index past the end — `debug_assert` would be a
    // no-op in release and the last partial chunk would panic the handler.
    let positions_end = mesh.positions.len() / 3 * 3;
    for i in (0..positions_end).step_by(3) {
        let (x, y, z) = zup_to_yup(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
        mesh.positions[i] = x;
        mesh.positions[i + 1] = y;
        mesh.positions[i + 2] = z;
    }

    // Normals must end up in the SAME frame as the positions. Some pipelines
    // (advanced_brep) emit positions with absent or mismatched normals; the
    // parquet path emits zero normals for those rather than shipping a buffer
    // that doesn't parallel the vertices. Match that here instead of leaving a
    // half-rotated Z-up normal buffer on the wire — a silently wrong frame is
    // exactly the drift this module exists to prevent. An empty buffer is the
    // documented "client recomputes flat normals" signal.
    if mesh.normals.len() == mesh.positions.len() {
        for i in (0..positions_end).step_by(3) {
            let (x, y, z) = zup_to_yup(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
            mesh.normals[i] = x;
            mesh.normals[i + 1] = y;
            mesh.normals[i + 2] = z;
        }
    } else if !mesh.normals.is_empty() {
        tracing::warn!(
            express_id = mesh.express_id,
            ifc_type = %mesh.ifc_type,
            positions = mesh.positions.len(),
            normals = mesh.normals.len(),
            "Mesh normals length mismatch; dropping normals rather than emitting a Z-up buffer"
        );
        mesh.normals.clear();
    }

    mesh.origin = zup_to_yup_f64(mesh.origin);
}

#[cfg(test)]
#[path = "axis_tests.rs"]
mod axis_tests;
