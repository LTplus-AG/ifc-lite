// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Signed volume of a triangle mesh by the divergence theorem.

use crate::kernel::signed_volume::tetra_volume6;
use crate::mesh::Mesh;

/// Signed volume of a (closed) triangle mesh via the divergence theorem, about
/// [`volume_reference`] of the same mesh. Reads the f32 positions unsnapped; an
/// out-of-range index panics. Positive for outward (CCW) winding.
pub fn signed_volume(mesh: &Mesh) -> f64 {
    signed_volume_about(mesh, &volume_reference(mesh))
}

/// The point [`signed_volume`] sums `mesh` about: the centre of its position
/// bounds (the origin for an empty mesh). `kernel::signed_volume` uses the same
/// rule over the vertices its triangles reference, so the two agree unless the
/// buffer holds unreferenced positions. On native, positions are absolute, and
/// an open surface's divergence sum grows with the distance to the reference
/// point, so the point must lie within the operand's extent, not at the world
/// origin. Read off `Mesh::bounds`, a linear scan of the position buffer, so
/// the sum itself is the only index walk.
pub fn volume_reference(mesh: &Mesh) -> [f64; 3] {
    if mesh.is_empty() {
        return [0.0; 3];
    }
    let (lo, hi) = mesh.bounds();
    [
        (f64::from(lo.x) + f64::from(hi.x)) * 0.5,
        (f64::from(lo.y) + f64::from(hi.y)) * 0.5,
        (f64::from(lo.z) + f64::from(hi.z)) * 0.5,
    ]
}

/// [`signed_volume`] about a caller-chosen `o`, in one walk. A before/after
/// difference over the same host must read both meshes about ONE point (the
/// host's [`volume_reference`]): the flux of a crack the cut did not touch then
/// cancels, where two per-mesh points would leave `(o_after - o_before)·N/6` of
/// it in the removed volume (#4632).
pub fn signed_volume_about(mesh: &Mesh, o: &[f64; 3]) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|t| tetra_volume6(&vertex(mesh, t[0]), &vertex(mesh, t[1]), &vertex(mesh, t[2]), o))
        .sum::<f64>()
        / 6.0
}

#[inline]
fn vertex(mesh: &Mesh, i: u32) -> [f64; 3] {
    let b = i as usize * 3;
    [mesh.positions[b] as f64, mesh.positions[b + 1] as f64, mesh.positions[b + 2] as f64]
}
