// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pre-triangulation constraint hygiene for [`super::retriangulate::triangulate`].
//!
//! A near-coplanar tri-tri intersection can mis-record a crossing whose interned
//! point keeps a CUTTER vertex's OWN 3D identity, sitting mm-to-cm OFF the face
//! it is recorded as a constraint of. Inserting such a point into that face's 2D
//! CDT is doubly harmful: if the segment runs ALONG the face's drop axis its two
//! endpoints collapse onto one 2D coordinate (two distinct 3D Vids fused), and
//! more generally the off-plane vertex pulls the face's re-triangulated sub-
//! triangles off its plane, so the downstream centroid inside/outside
//! classification then keeps faces lying OUTSIDE the host — the flap/tear on
//! faceted-BREP reveal cutters (the ara3d ISSUE_098 Poroton wall).
//!
//! A genuine in-plane constraint always has 2D extent in the projection and sits
//! on the plane within f32-import + snap noise, so dropping the degenerate /
//! off-plane ones perturbs nothing real. All comparisons are FMA-free f64 over
//! the interned (snapped) coordinates, so native == wasm.

use super::interner::{Interner, Vid};
use super::retriangulate::{project2d, Canonical};
use super::DropAxis;

/// Drop from `canon` every constraint segment / isolated point that does not lie
/// in face `tri`'s plane: (1) a segment whose endpoints project to the SAME 2D
/// point under `axis` (perpendicular to the face), or (2) any vertex farther than
/// a scale-relative tolerance off the plane. The tolerance is `1 mm` at building
/// scale but never below the f32 round-off floor at the operand's own coordinate
/// magnitude (`|coord|·2⁻²²`, matching `mesh_bridge`'s promote band) — so a
/// georeferenced host cut at raw mega-metre coordinates, where a real in-plane
/// vertex already scatters ~0.1 m in f32, keeps every constraint (the filter is a
/// no-op there); only near origin, where the ~0.17 m contaminant towers over the
/// µm snap noise, is it excised.
pub(crate) fn drop_out_of_plane(
    canon: &mut Canonical,
    tri: &[[f64; 3]; 3],
    interner: &Interner,
    axis: DropAxis,
) {
    // (1) degenerate: a segment collapsing to a point in the drop-axis projection.
    let proj = |v: Vid| super::fixed::point_to_f64(interner.get(v)).map(|p| project2d(p, axis));
    canon.segments.retain(|&(lo, hi)| match (proj(lo), proj(hi)) {
        (Some(a), Some(b)) => a[0] != b[0] || a[1] != b[1],
        _ => true,
    });

    // (2) off-plane: farther than the scale-relative tolerance from the face plane.
    let u = [tri[1][0] - tri[0][0], tri[1][1] - tri[0][1], tri[1][2] - tri[0][2]];
    let v = [tri[2][0] - tri[0][0], tri[2][1] - tri[0][1], tri[2][2] - tri[0][2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if nl <= 0.0 {
        return;
    }
    let n = [n[0] / nl, n[1] / nl, n[2] / nl];
    let p0 = tri[0];
    let extent = tri.iter().flat_map(|c| c.iter()).fold(0.0_f64, |m, &x| m.max(x.abs()));
    let tol = 1.0e-3_f64.max(extent * (1.0 / 4_194_304.0));
    let on_plane = |vid: Vid| {
        super::fixed::point_to_f64(interner.get(vid)).is_none_or(|p| {
            ((p[0] - p0[0]) * n[0] + (p[1] - p0[1]) * n[1] + (p[2] - p0[2]) * n[2]).abs() <= tol
        })
    };
    canon.segments.retain(|&(lo, hi)| on_plane(lo) && on_plane(hi));
    canon.points.retain(|&vid| on_plane(vid));
}
