// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Public, documented home for reading a [`Mesh`]'s volume.

use super::mesh_bridge::mesh_to_tris;
use super::signed_volume::signed_volume6;
use crate::mesh::Mesh;

/// Signed volume of a `Mesh`, via the divergence theorem.
///
/// Positive for a closed, outward-wound mesh; negative if inward-wound;
/// meaningless if the mesh is not closed — the divergence theorem this sum
/// implements requires a closed surface, and an open one has no true volume
/// to read regardless of where it sits. That reading is translation-STABLE,
/// not translation-dependent: because it delegates to [`signed_volume6`],
/// which sums about the operand's own AABB centre rather than a fixed point,
/// an open mesh reads the same wrong-but-consistent number wherever it is
/// translated (see the `mesh_volume_is_stable_far_from_the_world_origin_for_an_open_mesh`
/// test below) — it just isn't the mesh's actual volume. Callers that need a
/// trustworthy reading (e.g. reporting a split zone piece's volume) must
/// establish closedness first, same requirement [`signed_volume6`] itself
/// carries.
///
/// Delegates to [`signed_volume6`] rather than re-deriving the sum: that is
/// the crate's ONE divergence-theorem implementation, and it deliberately sums
/// about the OPERAND'S OWN AABB CENTRE rather than the world origin. That
/// choice is not cosmetic — see `signed_volume::signed_volume6`'s doc for the
/// #198779 incident where a world-origin reference turned a crack sliver on a
/// far-from-origin operand into a wildly wrong, sign-flipping volume. A split
/// zone piece is exactly the shape of operand that provokes this: it can sit
/// anywhere in a building/national-grid-scale model and can carry the same
/// kind of boundary sliver from the cut that produced it, so this function
/// inherits the AABB-centred reference rather than exposing a second,
/// world-origin-referenced volume primitive alongside it.
///
/// The two other volume readings already in the crate were each wrong for
/// this job for a different reason: `router::voids::geom::mesh_signed_volume`
/// sums about the world origin (fine for its own callers, which only ever see
/// frame-local meshes near the origin — not true of an arbitrary zone piece),
/// and `kernel::mesh_bridge`'s `#[cfg(test)]`-only helper duplicates that same
/// world-origin arithmetic for test-only use. Reusing [`signed_volume6`]
/// avoids adding a THIRD divergence-theorem implementation to reconcile.
pub fn mesh_volume(mesh: &Mesh) -> f64 {
    signed_volume6(&mesh_to_tris(mesh)) / 6.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::arrangement::cube_mesh;
    use crate::kernel::mesh_bridge::tris_to_mesh;

    #[test]
    fn mesh_volume_of_a_closed_cube_is_correct() {
        let cube = tris_to_mesh(&cube_mesh(0.0, 2.0)); // side 2 → vol 8
        let v = mesh_volume(&cube);
        assert!((v - 8.0).abs() < 1.0e-9, "expected 8.0, got {v}");
    }

    /// The property that makes this the right function to expose (see the
    /// fn's own doc, and `signed_volume::signed_volume6`'s doc for the
    /// #198779 incident this reproduces the shape of): for an OPEN surface —
    /// a mesh with an unresolved boundary, e.g. a zone piece carrying a
    /// boundary sliver from the cut that produced it — the divergence sum
    /// referenced to a FIXED point is translation-variant, so a world-origin
    /// implementation reads a different (and for a far-from-origin operand,
    /// wildly different) value depending only on where the model sits. The
    /// AABB-centred reference this function actually uses co-moves with the
    /// operand, so the reading must hold regardless of that translation. A
    /// world-origin implementation, tested the same way, would NOT hold —
    /// this is the reproduction shape for that class of implementation bug.
    #[test]
    fn mesh_volume_is_stable_far_from_the_world_origin_for_an_open_mesh() {
        let mut tris = cube_mesh(0.0, 2.0);
        tris.pop(); // drop one triangle → open boundary (one missing face)
        let near = tris_to_mesh(&tris);
        let mut far = near.clone();
        for c in far.positions.as_chunks_mut::<3>().0 {
            c[0] += 10_000.0;
            c[1] += 10_000.0;
            c[2] += 10_000.0;
        }
        let v_near = mesh_volume(&near);
        let v_far = mesh_volume(&far);
        assert!(
            (v_near - v_far).abs() < 1.0e-6,
            "near={v_near} far={v_far} should match for an AABB-centred reading"
        );
    }
}
