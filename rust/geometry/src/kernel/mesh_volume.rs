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
/// to read regardless of where it sits. That reading is translation-stable
/// only up to a bounded QUANTIZATION noise floor, not exactly
/// translation-invariant: [`mesh_to_tris`] rounds every coordinate to
/// `kernel::mesh_bridge::SNAP_GRID` (1/65536 m, ~15.26 µm) before this
/// function ever sees it, and a non-grid-aligned translation moves each
/// vertex's rounding independently, so the sum drifts by roughly
/// `surface_area * SNAP_GRID` (plus, at far-from-origin offsets, the
/// coarser f32-ulp term the `Mesh` positions already carried on the way in).
/// Because it delegates to [`signed_volume6`], which sums about the
/// operand's own AABB centre rather than a fixed point, that drift is the
/// ONLY thing that moves the reading — a world-origin implementation would
/// additionally vary with the reference point itself, wrong by orders of
/// magnitude more (see the
/// `mesh_volume_is_stable_far_from_the_world_origin_for_an_open_mesh` test
/// below, which pins the AABB-centred reading's noise floor and would fail
/// hard against that class of regression). It is still not the mesh's actual
/// volume. Callers that need a trustworthy reading (e.g. reporting a split
/// zone piece's volume) must establish closedness first, same requirement
/// [`signed_volume6`] itself carries.
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
/// This is a raw, UNGATED kernel primitive — it reads whatever `Mesh` it is
/// handed, closed or not, and (via [`mesh_to_tris`]) silently drops any
/// out-of-range-index or non-finite triangle. It is the low-level counterpart
/// to `geom_closure::GeometryHasher::volume`, which is the crate's
/// closedness-GATED, per-entity volume: that one returns `None` unless the
/// hasher's accumulated `GeometryClosure` proves the entity is a single
/// closed orientable solid, but it requires that accumulated per-entity
/// state — it has nothing to gate a bare, freshly-produced `Mesh` (e.g. a
/// zone-split piece) that never went through the hasher. A caller of THIS
/// function that needs the same trustworthiness guarantee must establish
/// closedness itself first — `router::voids::geom::mesh_is_closed_exact` is
/// the crate's existing closed-surface check but is `pub(super)`-scoped to
/// that module today, so a caller outside it needs either that visibility
/// widened or an equivalent check of its own — same requirement
/// `GeometryHasher::volume`'s own gate establishes upstream.
///
/// The other volume readings already in the crate were each wrong for this
/// job for a different reason: `router::voids::geom::mesh_signed_volume`
/// sums about the world origin (fine for its own callers, which only ever see
/// frame-local meshes near the origin — not true of an arbitrary zone piece),
/// and `kernel::mesh_bridge`'s `#[cfg(test)]`-only helper duplicates that same
/// world-origin arithmetic for test-only use. Reusing [`signed_volume6`]
/// avoids adding another divergence-theorem implementation to reconcile.
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
    /// operand, so the reading must hold up to a bounded quantization noise
    /// floor regardless of that translation. A world-origin implementation,
    /// tested the same way, would NOT hold — this is the reproduction shape
    /// for that class of implementation bug.
    ///
    /// Deliberately NOT grid-aligned: an earlier version of this test used
    /// integer cube corners and an offset that was an exact multiple of
    /// `SNAP_GRID` (1/65536 m), which makes BOTH the f32 store and the
    /// reconciliation snap in [`mesh_to_tris`] exact no-ops — so it could
    /// only ever discriminate the AABB-centred-vs-world-origin reference
    /// choice, never the quantization noise those two steps genuinely
    /// introduce for a real-world placement (a caught house review finding:
    /// "a test that can't fail" against the property it was named for). This
    /// version uses off-grid corners and a non-multiple offset, so the snap
    /// noise is real and the tolerance below is sized to it rather than to
    /// bit-exactness — see the `..._is_not_bit_exact_across_a_non_grid_translation`
    /// test for the proof that this specific loosening was necessary.
    #[test]
    fn mesh_volume_is_stable_far_from_the_world_origin_for_an_open_mesh() {
        let mut tris = cube_mesh(0.1, 2.3); // off-grid corners, side 2.2
        tris.pop(); // drop one triangle → open boundary (one missing face)
        let near = tris_to_mesh(&tris);
        let mut far = near.clone();
        for c in far.positions.as_chunks_mut::<3>().0 {
            c[0] += 10_000.1; // off-grid, far-from-origin offset
            c[1] += 10_000.1;
            c[2] += 10_000.1;
        }
        let v_near = mesh_volume(&near);
        let v_far = mesh_volume(&far);
        let drift = (v_near - v_far).abs();
        // Bound sized to the documented noise floor (surface_area * SNAP_GRID
        // plus f32 ulp at a 10 km offset), NOT to bit-exactness — see the doc
        // comment above and `mesh_volume`'s own doc. A world-origin
        // regression drifts by ~6.7e3 on this exact fixture shape (measured
        // separately, see PR #2260 review thread), thousands of times past
        // this bound, so the test still catches that class of bug.
        assert!(
            drift < 1.0e-2,
            "near={v_near} far={v_far} drift={drift} exceeds the documented \
             quantization noise floor for an AABB-centred reading"
        );
    }

    /// Proves the loosened tolerance above is load-bearing, not decorative:
    /// re-run the exact same off-grid fixture at the OLD 1e-6 bit-exactness
    /// bound the previous (grid-exact) test used, and watch it fail. This is
    /// the RED half of the RED/GREEN pair — without the off-grid corners and
    /// offset, this assertion would spuriously pass, which is exactly the
    /// "test that can't fail" defect being fixed.
    #[test]
    fn mesh_volume_is_not_bit_exact_across_a_non_grid_translation() {
        let mut tris = cube_mesh(0.1, 2.3);
        tris.pop();
        let near = tris_to_mesh(&tris);
        let mut far = near.clone();
        for c in far.positions.as_chunks_mut::<3>().0 {
            c[0] += 10_000.1;
            c[1] += 10_000.1;
            c[2] += 10_000.1;
        }
        let drift = (mesh_volume(&near) - mesh_volume(&far)).abs();
        assert!(
            drift > 1.0e-6,
            "expected the off-grid translation to show measurable snap/f32 \
             drift (drift={drift}); if this now passes, mesh_to_tris's \
             quantization changed and the doc/tolerance above need revisiting"
        );
    }
}
