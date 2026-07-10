// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Six-times-the-signed-volume of a triangle list (divergence theorem), the
//! orientation + volume-magnitude primitive for [`super::mesh_bridge`].

use super::arrangement::Tri;

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
        .map(|t| {
            let a = [t[0][0] - o[0], t[0][1] - o[1], t[0][2] - o[2]];
            let b = [t[1][0] - o[0], t[1][1] - o[1], t[1][2] - o[2]];
            let c = [t[2][0] - o[0], t[2][1] - o[1], t[2][2] - o[2]];
            let cr = [
                b[1] * c[2] - b[2] * c[1],
                b[2] * c[0] - b[0] * c[2],
                b[0] * c[1] - b[1] * c[0],
            ];
            a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
        })
        .sum()
}
