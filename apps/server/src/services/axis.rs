// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The server wire's axis policy (issue #1841).
//!
//! IFC is Z-up; WebGL/glTF (and every ifc-lite client) is Y-up. Every server
//! transport therefore emits **Y-up metres**. The swap itself is defined once,
//! in `ifc_lite_geometry::math::frame`; this module owns what the transports
//! do with it (the JSON mesh rewrite and the normals-mismatch decision).
//!
//! It used to be open-coded inline in each parquet serializer and simply
//! MISSING from the JSON route, so `POST /api/v1/parse` shipped raw IFC Z-up
//! while the parquet endpoints shipped Y-up — the same class of silent
//! per-transport drift as the dropped `origin`. Keep every transport routed
//! through these helpers so the frame can never diverge again.

use ifc_lite_geometry::math::frame::{zup_to_yup, zup_to_yup_in_place};
use ifc_lite_processing::MeshData;

/// Whether a mesh's normals run parallel to its positions (one normal per
/// vertex): the precondition for rewriting or emitting them at all.
///
/// Some pipelines (advanced_brep) emit positions with absent or mismatched
/// normals. An EMPTY buffer is the documented "client recomputes flat normals"
/// signal and is not a mismatch; a non-empty buffer of the wrong length is,
/// and is logged here with `outcome` (what this format does about it). The
/// outcome itself stays per format because the formats force it: JSON clears
/// the buffer, while Parquet zero-pads because its normal columns are non-null.
/// Pass `None` when the caller does not emit normals and so has nothing to say.
pub(crate) fn normals_parallel(mesh: &MeshData, outcome: Option<&str>) -> bool {
    let parallel = mesh.normals.len() == mesh.positions.len();
    if let (false, false, Some(outcome)) = (parallel, mesh.normals.is_empty(), outcome) {
        tracing::warn!(
            express_id = mesh.express_id,
            ifc_type = %mesh.ifc_type,
            positions = mesh.positions.len(),
            normals = mesh.normals.len(),
            "Mesh normals length mismatch; {outcome}"
        );
    }
    parallel
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
    //
    // Drop the partial tail rather than shipping it: a 1-2 float remainder is
    // not a position, and leaving it would put unrotated Z-up values on the
    // wire next to Y-up ones. Same rule as the normals below.
    let positions_end = mesh.positions.len() / 3 * 3;
    if positions_end != mesh.positions.len() {
        tracing::warn!(
            express_id = mesh.express_id,
            ifc_type = %mesh.ifc_type,
            positions = mesh.positions.len(),
            "Mesh position buffer is not a whole number of triplets; dropping the partial tail"
        );
        mesh.positions.truncate(positions_end);
    }
    zup_to_yup_in_place(&mut mesh.positions);

    // Normals must end up in the SAME frame as the positions. Some pipelines
    // (advanced_brep) emit positions with absent or mismatched normals; the
    // parquet path emits zero normals for those rather than shipping a buffer
    // that doesn't parallel the vertices. Match that here instead of leaving a
    // half-rotated Z-up normal buffer on the wire — a silently wrong frame is
    // exactly the drift this module exists to prevent. An empty buffer is the
    // documented "client recomputes flat normals" signal.
    if normals_parallel(
        mesh,
        Some("dropping normals rather than emitting a Z-up buffer"),
    ) {
        zup_to_yup_in_place(&mut mesh.normals);
    } else if !mesh.normals.is_empty() {
        mesh.normals.clear();
    }

    mesh.origin = zup_to_yup(mesh.origin);
}

#[cfg(test)]
#[path = "axis_tests.rs"]
mod axis_tests;
