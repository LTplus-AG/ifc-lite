// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Coplanar triangle overlap — the constraints two coplanar overlapping
//! faces impose on each other.
//!
//! When triangle `tb` is coplanar with `ta`, each of `tb`'s edges is clipped to
//! `ta` and the portion inside becomes a constraint for `ta` (and symmetrically).
//! A clipped endpoint is either an `Explicit` vertex (inside `ta`) or a coplanar
//! edge×edge crossing — represented EXACTLY as an auxiliary-plane LPI: the line
//! `q0q1` ∩ the plane through ta-edge `(e0,e1)` extruded perpendicular to the
//! shared plane (`e0 + n`). Within the shared plane that plane reads as the line
//! `e0e1`, so the LPI is exactly the 2D crossing — and it lies on the shared
//! plane, keeping everything exact and conforming.

use super::predicates::orient2d_any;
use super::retriangulate::projection_axis;
use super::{DropAxis, ImplicitPoint, Lpi, Sign};

type Tri = [[f64; 3]; 3];

#[inline]
fn e(p: [f64; 3]) -> ImplicitPoint {
    ImplicitPoint::Explicit(p)
}

fn plane_normal(t: &Tri) -> [f64; 3] {
    let u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
    let v = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
    [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ]
}

/// Is explicit point `q` inside the closed triangle `tri` (oriented `w0`)?
fn point_in_tri(q: [f64; 3], tri: &Tri, axis: DropAxis, w0: Sign) -> bool {
    let opp = w0.flip();
    let on_inner = |a: [f64; 3], b: [f64; 3]| orient2d_any(&e(a), &e(b), &e(q), axis) != opp;
    on_inner(tri[0], tri[1]) && on_inner(tri[1], tri[2]) && on_inner(tri[2], tri[0])
}

/// Do segments `(q0,q1)` and `(e0,e1)` properly cross in the `axis` projection?
fn seg_seg_cross(q0: [f64; 3], q1: [f64; 3], e0: [f64; 3], e1: [f64; 3], axis: DropAxis) -> bool {
    let s1 = orient2d_any(&e(q0), &e(q1), &e(e0), axis);
    let s2 = orient2d_any(&e(q0), &e(q1), &e(e1), axis);
    let s3 = orient2d_any(&e(e0), &e(e1), &e(q0), axis);
    let s4 = orient2d_any(&e(e0), &e(e1), &e(q1), axis);
    s1 != Sign::Zero && s2 != Sign::Zero && s1 != s2 && s3 != Sign::Zero && s4 != Sign::Zero && s3 != s4
}

/// Auxiliary-plane LPI for the coplanar crossing of `q0q1` with ta-edge `(e0,e1)`:
/// `line(q0,q1) ∩ plane(e0, e1, e0+n)`, `n` = shared-plane normal.
///
/// PERF (off-grid aux fix): the raw `n` is the UN-normalised cross product of two
/// on-grid (`k/2^16`) edge vectors, so its components land on the `1/2^32` grid —
/// OFF the `1/2^16` snap grid. `aux = e0 + n` is then off-grid, every predicate on
/// the resulting LPI fails the fixed-width tier's on-grid `gi` and falls to the
/// ~3 ms BigRational path (the dominant flush-cap/near-coplanar cut cost: 841 had
/// ~2000 BigRational λ-rebuilds per slow opening). The aux point only needs to make
/// the plane `(e0,e1,aux)` read as the LINE `e0e1` in-plane and stay perpendicular
/// to the shared plane — its exact offset along `n` is irrelevant. So we ROUND `n`
/// to a grid-aligned integer direction (scale the max component to ~2^10, round),
/// like `tritri::line_direction` does: `aux` then lands on-grid and the fixed
/// tier resolves the LPI. The SIGN of every predicate is unchanged — `n` still
/// points off the shared plane along the same perpendicular, and the in-plane
/// reading of the plane is still the exact line `e0e1` (which only uses `e0,e1`).
/// Deterministic (FMA-free f64 round) ⇒ byte-identical native==wasm.
///
/// SCALE 2^10, not the original 2^20 (crack-family fix): when `e0` is a WELDED
/// seam vertex on the fine `k/2^36` grid (|coord| < 2^13 ⇒ ≤49 bits), adding an
/// integer component up to 2^20 needs up to 56 bits — `e0 + ng` then ROUNDS and
/// the aux point lands off every grid, kicking every predicate on the LPI to the
/// BigRational tier (~200k residual exact-rational calls on a tunnel corpus).
/// At 2^10 the sum stays ≤50 bits ⇒ exact f64 ⇒ on-grid. The LPI's VALUE is
/// aux-invariant (any off-plane aux reads as the line `e0e1` in-plane), so
/// signs, topology and the pinned manifests are unchanged.
fn crossing_lpi(q0: [f64; 3], q1: [f64; 3], e0: [f64; 3], e1: [f64; 3], n: [f64; 3]) -> ImplicitPoint {
    let m = n[0].abs().max(n[1].abs()).max(n[2].abs());
    let ng = if m > 0.0 && m.is_finite() {
        let s = 1024.0 / m; // normalise the max component to ~2^10, then round
        [(n[0] * s).round(), (n[1] * s).round(), (n[2] * s).round()]
    } else {
        n
    };
    let aux = [e0[0] + ng[0], e0[1] + ng[1], e0[2] + ng[2]];
    ImplicitPoint::Lpi(Lpi { p: q0, q: q1, r: e0, s: e1, t: aux })
}

/// Clip segment `(q0,q1)` to triangle `ta` (2D). Returns the in-`ta` portion as a
/// constraint, or `None` if the segment misses `ta`.
fn clip_seg(
    q0: [f64; 3],
    q1: [f64; 3],
    ta: &Tri,
    axis: DropAxis,
    w0: Sign,
    n: [f64; 3],
) -> Option<(ImplicitPoint, ImplicitPoint)> {
    let in0 = point_in_tri(q0, ta, axis, w0);
    let in1 = point_in_tri(q1, ta, axis, w0);
    let edges = [(ta[0], ta[1]), (ta[1], ta[2]), (ta[2], ta[0])];
    let crossings: Vec<ImplicitPoint> = edges
        .iter()
        .filter(|&&(e0, e1)| seg_seg_cross(q0, q1, e0, e1, axis))
        .map(|&(e0, e1)| crossing_lpi(q0, q1, e0, e1, n))
        .collect();
    match (in0, in1) {
        (true, true) => Some((e(q0), e(q1))),
        (true, false) => crossings.into_iter().next().map(|c| (e(q0), c)),
        (false, true) => crossings.into_iter().next().map(|c| (c, e(q1))),
        (false, false) => {
            if crossings.len() >= 2 {
                Some((crossings[0].clone(), crossings[1].clone()))
            } else {
                None
            }
        }
    }
}

/// Constraints `tb` (coplanar with `ta`) imposes on `ta`: each `tb` edge clipped
/// to `ta`. Empty if `ta` is degenerate or the triangles don't overlap.
pub fn coplanar_clip(ta: &Tri, tb: &Tri) -> Vec<(ImplicitPoint, ImplicitPoint)> {
    let (axis, w0) = match projection_axis(ta) {
        Some(x) => x,
        None => return Vec::new(),
    };
    let n = plane_normal(ta);
    let tb_edges = [(tb[0], tb[1]), (tb[1], tb[2]), (tb[2], tb[0])];
    tb_edges
        .iter()
        .filter_map(|&(q0, q1)| clip_seg(q0, q1, ta, axis, w0, n))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::predicates::orient3d;
    use super::*;

    #[test]
    fn coplanar_clip_of_contained_face_is_its_edges_on_plane() {
        // ta = big triangle in z=0; tb = small triangle fully inside it (z=0).
        let ta: Tri = [[0., 0., 0.], [6., 0., 0.], [0., 6., 0.]];
        let tb: Tri = [[1., 1., 0.], [3., 1., 0.], [1., 3., 0.]];
        let cons = coplanar_clip(&ta, &tb);
        assert_eq!(cons.len(), 3, "contained face should give all 3 edges");
        for (a, b) in &cons {
            // both endpoints explicit (inside) and on ta's plane (z=0)
            assert!(matches!(a, ImplicitPoint::Explicit(_)));
            assert!(matches!(b, ImplicitPoint::Explicit(_)));
            assert_eq!(orient3d(a, &e(ta[0]), &e(ta[1]), &e(ta[2])), Sign::Zero);
        }
    }

    #[test]
    fn coplanar_clip_of_overhanging_face_clips_to_aux_lpi_on_plane() {
        // tb sticks out past ta's hypotenuse → clipped endpoints include an
        // auxiliary-plane LPI crossing, which must lie on ta's plane (z=0).
        let ta: Tri = [[0., 0., 0.], [4., 0., 0.], [0., 4., 0.]]; // hypotenuse x+y=4
        let tb: Tri = [[1., 1., 0.], [5., 1., 0.], [1., 5., 0.]]; // overhangs
        let cons = coplanar_clip(&ta, &tb);
        assert!(!cons.is_empty(), "overlapping faces must produce constraints");
        let mut saw_lpi = false;
        for (a, b) in &cons {
            for ep in [a, b] {
                if matches!(ep, ImplicitPoint::Lpi(_)) {
                    saw_lpi = true;
                }
                // every endpoint lies exactly on ta's plane
                assert_eq!(
                    orient3d(ep, &e(ta[0]), &e(ta[1]), &e(ta[2])),
                    Sign::Zero,
                    "coplanar-clip endpoint off the shared plane"
                );
            }
        }
        assert!(saw_lpi, "an overhanging edge must yield an auxiliary-plane LPI crossing");
    }
}
