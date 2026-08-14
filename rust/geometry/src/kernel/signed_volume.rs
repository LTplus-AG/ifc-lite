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
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    for t in tris {
        for v in t {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
    }
    if tris.is_empty() {
        return 0.0;
    }
    let o = [
        (lo[0] + hi[0]) * 0.5,
        (lo[1] + hi[1]) * 0.5,
        (lo[2] + hi[2]) * 0.5,
    ];
    tris.iter()
        .map(|t| tetra_volume6(&t[0], &t[1], &t[2], &o))
        .sum()
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
