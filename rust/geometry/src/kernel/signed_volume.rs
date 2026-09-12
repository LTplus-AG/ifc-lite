// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Six-times-the-signed-volume of a triangle list (divergence theorem), the
//! orientation + volume-magnitude primitive for [`super::mesh_bridge`].

use super::arrangement::Tri;

/// Six times the SIGNED volume of the tetrahedron `(o, a, b, c)`:
/// `(a−o)·((b−o)×(c−o))`.
///
/// THE single tetrahedron determinant behind every divergence-theorem sum in
/// the crate — [`signed_volume6`] below and the per-segment volume in
/// [`crate::geom_hash::GeometryHasher`] both fold this one expression, so the
/// two cannot drift into subtly different arithmetic (or differing
/// associativity, which on a near-cancelling sum is a real difference). Plain
/// FMA-free `f64` for native==wasm bit-parity, same as the caller below.
///
/// Summed over a CLOSED, consistently-wound surface this telescopes to `6·V`
/// and is independent of `o`. Over an OPEN one it is not: the boundary-loop
/// flux scales with `|o|`, which is why callers must establish closedness
/// before reading the total as a volume.
#[inline]
pub(crate) fn tetra_volume6(a: &[f64; 3], b: &[f64; 3], c: &[f64; 3], o: &[f64; 3]) -> f64 {
    let a = [a[0] - o[0], a[1] - o[1], a[2] - o[2]];
    let b = [b[0] - o[0], b[1] - o[1], b[2] - o[2]];
    let c = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
    let cr = [
        b[1] * c[2] - b[2] * c[1],
        b[2] * c[0] - b[0] * c[2],
        b[0] * c[1] - b[1] * c[0],
    ];
    a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
}

/// Twice-the-signed-volume sum for a triangle list (divergence theorem, ×6):
/// `Σ (v0−o)·((v1−o)×(v2−o))`, ABOUT THE OPERAND'S OWN AABB CENTER `o`. A closed
/// outward-wound mesh has this `> 0`; an inward-wound one `< 0`. Computed in
/// plain FMA-free f64 over the snapped operand coords, so only its SIGN is
/// consumed for orientation — byte-identical native==wasm. The MAGNITUDE (6×
/// the volume) is also read by `subtract_many`'s volume-safety check, where a
/// generous 1% tolerance keeps the accept/reject branch parity-stable.
///
/// WHY the local reference point: for a CLOSED mesh
/// the sign is translation-invariant, so the reference is free. But an operand
/// that re-enters a SEQUENTIAL void-cut loop can carry sliver cracks from the
/// previous subtract (flush-interface seams, the open-edge family) — and for an
/// OPEN surface the divergence sum is translation-VARIANT: the boundary-loop
/// flux grows linearly with the distance to the reference point. Referenced to
/// the WORLD origin, a 250–410 m-out tunnel wall with a 2.65 m sliver crack read
/// `vol < 0` (e.g. −59.8 from a +0.30 m³ solid), which made [`orient_outward`]
/// flip the whole host inside-out and invert the next cut (#198779's −49.3
/// cascade). About the AABB center the crack flux is bounded by the operand's
/// own extent — the sign is decided by the solid, not by where the model sits.
pub(crate) fn signed_volume6(tris: &[Tri]) -> f64 {
    let Some(o) = aabb_centre(tris.iter().flatten().copied()) else {
        return 0.0;
    };
    signed_volume6_about(tris.iter().copied(), &o)
}

/// `Σ (v0−o)·((v1−o)×(v2−o))` over `tris` about a caller-chosen `o`.
///
/// The one place the crate folds a divergence sum, so every reader of a
/// volume agrees on the arithmetic AND on the reference-point rule. `o`
/// must sit inside the operand's own extent (its AABB centre, or any of its
/// vertices) for the sum to be translation-stable. Two things go wrong about
/// the WORLD origin on a native host 5-10 km out (positions are absolute
/// there), measured at 9 km on rotated, non-integer fixtures:
/// - rounding: f32-baked coordinates are short dyadics whose cross products
///   stay exact, so a CLOSED f32 mesh reads only ~4e-9 relative off, but the
///   kernel's f64 output on the 2^-16 grid does round, 2e-5 relative on a
///   650-triangle intersection;
/// - boundary flux: any OPEN surface's sum grows with `|v − o| × gap area`,
///   and a single 1 mm crack (one corner one f32 ulp off its copies) moved a
///   0.1 m³ solid's reading by 2-5 %, past every gate that reads it.
///
/// Several sites used to carry that sum inline, one with a tolerance scaled
/// by the world magnitude cubed to absorb it, which made the check vacuous
/// exactly where the model sat far from the origin.
pub(crate) fn signed_volume6_about(tris: impl Iterator<Item = Tri>, o: &[f64; 3]) -> f64 {
    tris.map(|t| tetra_volume6(&t[0], &t[1], &t[2], o)).sum()
}

/// AABB centre of a point stream, `None` when empty. The reference point
/// [`signed_volume6`] and [`mesh_signed_volume`] sum about.
pub(crate) fn aabb_centre(points: impl Iterator<Item = [f64; 3]>) -> Option<[f64; 3]> {
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    let mut any = false;
    for v in points {
        any = true;
        for k in 0..3 {
            lo[k] = lo[k].min(v[k]);
            hi[k] = hi[k].max(v[k]);
        }
    }
    any.then(|| std::array::from_fn(|k| (lo[k] + hi[k]) * 0.5))
}

/// Signed volume of a `Mesh` read straight off its f32 positions (NO snap to
/// the kernel grid), about the mesh's own AABB centre.
///
/// The void router's reader: it compares a host against itself before and
/// after a cut (0.1 % gate), a cutter's shell against a parametric box (3 %),
/// and a removed volume against an upper bound, all on meshes the kernel has
/// not seen yet, so the snapped view [`super::mesh_volume::mesh_volume`]
/// gives would move every reading by `area × SNAP_GRID` for nothing. The
/// reference point is what this shares with that reader: the world-origin sum
/// it replaced was fine on the viewer, where positions are element-relative,
/// and wrong on native, where they are absolute and a 5 km site puts the
/// per-triangle rounding in the same decade as a 0.1 % gate on a small host.
///
/// Indexes `positions` directly, as the sum it replaced did: an
/// out-of-range index is a malformed mesh and panics here rather than being
/// dropped.
pub(crate) fn mesh_signed_volume(mesh: &crate::mesh::Mesh) -> f64 {
    let v = |i: u32| -> [f64; 3] {
        let b = i as usize * 3;
        [
            mesh.positions[b] as f64,
            mesh.positions[b + 1] as f64,
            mesh.positions[b + 2] as f64,
        ]
    };
    let Some(o) = aabb_centre(mesh.positions.chunks_exact(3).map(|c| {
        [c[0] as f64, c[1] as f64, c[2] as f64]
    })) else {
        return 0.0;
    };
    signed_volume6_about(
        mesh.indices.chunks_exact(3).map(|t| [v(t[0]), v(t[1]), v(t[2])]),
        &o,
    ) / 6.0
}

/// Enclosed volume of a closed triangle soup, in the operands' own units.
///
/// [`signed_volume6`] returns SIX times the volume: it skips the constant
/// divide per tetrahedron, which is free for the sign tests the boolean's
/// keep/flip rules use it for. A caller that wants the VOLUME divides once,
/// here, rather than growing a second hand-rolled sum in another module, which
/// is how two producers of the same number start to disagree.
pub(crate) fn signed_volume_of(tris: &[Tri]) -> f64 {
    signed_volume6(tris) / 6.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A near-closed box with a thin sliver crack along one top edge: the
    /// two triangles that should share vertex `p6` instead use two slightly
    /// different copies of it, `eps` apart. The result is an OPEN surface
    /// (not a full missing face, a genuine narrow gap), same defect shape as
    /// #198779's flush-interface seam. `offset` places the whole box at a
    /// given distance from the world origin without changing its own
    /// geometry at all — same sliver, same box, only translated.
    fn box_with_sliver_crack(offset: [f64; 3]) -> Vec<Tri> {
        let lo = [offset[0], offset[1], offset[2]];
        let hi = [offset[0] + 2.2, offset[1] + 2.2, offset[2] + 2.2];
        let eps = 0.9; // sliver, comparable scale to #198779's 2.65 m crack
        let p0 = [lo[0], lo[1], lo[2]];
        let p1 = [hi[0], lo[1], lo[2]];
        let p2 = [hi[0], hi[1], lo[2]];
        let p3 = [lo[0], hi[1], lo[2]];
        let p4 = [lo[0], lo[1], hi[2]];
        let p5 = [hi[0], lo[1], hi[2]];
        let p6 = [hi[0], hi[1], hi[2]];
        // Asymmetric perturbation (NOT parallel to the offset vector below,
        // i.e. not a scalar multiple of [1,1,1]) — a shift parallel to a
        // uniform per-axis translation cancels out of the
        // reference-point-dependence term entirely (t×delta = 0 when both
        // are multiples of the same vector), which would silently make this
        // fixture insensitive to the very regression it exists to catch.
        // Only ONE of the two top-face triangles sees this copy, so the
        // shared edge `(p4, p6)` no longer matches vertex-for-vertex between
        // them: a thin open boundary, not a full missing face.
        let p6_cracked = [hi[0] + eps, hi[1] + eps * 0.6, hi[2] + eps * 1.3];
        let p7 = [lo[0], hi[1], hi[2]];
        vec![
            // bottom (closed)
            [p0, p3, p2],
            [p0, p2, p1],
            // top (cracked: first tri uses p6_cracked, second uses p6)
            [p4, p5, p6_cracked],
            [p4, p6, p7],
            // sides (closed)
            [p0, p4, p7],
            [p0, p7, p3],
            [p1, p2, p6],
            [p1, p6, p5],
            [p0, p1, p5],
            [p0, p5, p4],
            [p3, p7, p6],
            [p3, p6, p2],
        ]
    }

    /// The #198779 orientation-sign regression, directly on
    /// [`signed_volume6`]: a box carrying a thin sliver crack (open surface,
    /// same defect shape as the flush-interface seam in #198779's tunnel
    /// wall) must read the SAME sign whether it sits near the world origin
    /// or hundreds of metres out — because the AABB-centre reference
    /// co-moves with the operand, unlike a world-origin reference, whose
    /// boundary-loop flux term grows with the distance to the reference
    /// point and previously flipped an outward-wound operand's sign
    /// negative purely from being far away (issue #198779's −59.8 from a
    /// +0.30 m³ solid). The control (near the origin, where both reference
    /// choices coincide) and the far case (translated only, same sliver)
    /// isolate the reference-point choice as the only thing that can
    /// explain a sign difference between them.
    #[test]
    fn far_from_origin_sliver_crack_does_not_flip_the_sign_198779() {
        let near = box_with_sliver_crack([0.0, 0.0, 0.0]);
        let far = box_with_sliver_crack([300.0, 250.0, 410.0]); // #198779's tunnel wall sat 250-410 m out

        let v_near = signed_volume6(&near);
        let v_far = signed_volume6(&far);

        assert!(
            v_near > 0.0,
            "control (near origin) should read outward-wound positive, got {v_near}"
        );
        assert!(
            v_far > 0.0,
            "far-from-origin operand flipped sign to {v_far} (near-origin control was \
             {v_near}): the AABB-centre reference should make the sign independent of \
             where the operand sits, same defect shape as #198779"
        );
    }

    /// `mesh_signed_volume` replaced `router::voids::geom`'s world-origin sum,
    /// which every before/after gate in the void router reads (the 0.1 %
    /// `cut_changed_mesh` gate, the 3 % box reconciliation, the removal
    /// bound). On native, positions are absolute.
    ///
    /// The far mesh and the near mesh are the SAME f32 geometry (translated
    /// bit-exactly, see the fixture), so any difference between the two
    /// readings is the reference point and nothing else.
    ///
    /// Two cases, because they are different facts:
    /// - CLOSED: f32 coordinates are short dyadics, so the cross products in
    ///   `a·(b×c)` are exact in f64 whatever the offset and only the final
    ///   dot rounds. The world-origin sum was 3e-9 relative off here: not
    ///   the defect. This is the control that says so.
    /// - CRACKED by one f32 ulp (the seam ingestion really produces, and the
    ///   shape a host carries back into the sequential void loop, #198779):
    ///   the sum is now translation-VARIANT, its boundary flux scales with
    ///   the distance to the reference point, and about the world origin a
    ///   single 1 mm sliver 9 km out moved the reading by 2 % (0.1135
    ///   against 0.1112), twenty times the 0.1 % gate, which would call an
    ///   un-cut host "changed". About the mesh's own AABB centre the flux
    ///   is bounded by the mesh's extent and the two readings are
    ///   bit-identical.
    #[test]
    fn mesh_signed_volume_reads_the_same_volume_9km_out_as_at_the_origin() {
        use crate::world_frame_fixture::{
            crack_one_vertex, placed_sphere_mesh, translated_exactly, FAR_SITE_M,
        };
        let closed_far = placed_sphere_mesh(FAR_SITE_M, 0.3, 20, 25);
        let mut cracked_far = closed_far.clone();
        crack_one_vertex(&mut cracked_far);
        let analytic = 4.0 / 3.0 * std::f64::consts::PI * 0.3f64.powi(3);

        for (label, far, tol) in [("closed", &closed_far, 1e-6), ("cracked", &cracked_far, 1e-3)] {
            let near = translated_exactly(far, FAR_SITE_M);
            let v_near = mesh_signed_volume(&near);
            let v_far = mesh_signed_volume(far);
            assert!(
                (v_near - analytic).abs() < 0.03 * analytic,
                "{label}: near-origin control must read the sphere's volume: {v_near} vs {analytic}"
            );
            assert!(
                ((v_far - v_near) / v_near).abs() < tol,
                "{label}: the same mesh 9 km out read {v_far} against {v_near} at the origin \
                 (relative {:e}): the reading depends on where the model sits",
                (v_far - v_near) / v_near
            );
        }
    }
}
