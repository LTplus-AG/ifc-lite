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
//! `q0q1` ∩ the plane through ta-edge `(e0,e1)` extruded along the
//! dropped axis. In that projection the auxiliary plane reads as the line
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

/// Exact crossing in the same dropped-axis projection as the clipping tests.
///
/// The auxiliary plane extrudes the host edge along the dropped axis, so its
/// projected outline is exactly that edge even for snap-scattered, nearly
/// coplanar inputs. Extruding along a rounded face normal instead changes the
/// projected crossing when the two faces are not exactly coplanar (#7292).
/// The offset's magnitude is immaterial; only its axis and nonzero value count.
fn crossing_lpi(q0: [f64; 3], q1: [f64; 3], e0: [f64; 3], e1: [f64; 3], axis: DropAxis) -> ImplicitPoint {
    let k = match axis { DropAxis::X => 0, DropAxis::Y => 1, DropAxis::Z => 2 };
    let mut aux = e0;
    aux[k] += if e0[k] >= 0.0 { -1.0 } else { 1.0 };
    if aux[k] == e0[k] {
        aux[k] = if e0[k] >= 0.0 { e0[k].next_down() } else { e0[k].next_up() };
    }
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
) -> Option<(ImplicitPoint, ImplicitPoint)> {
    let in0 = point_in_tri(q0, ta, axis, w0);
    let in1 = point_in_tri(q1, ta, axis, w0);
    let edges = [(ta[0], ta[1]), (ta[1], ta[2]), (ta[2], ta[0])];
    let crossings: Vec<ImplicitPoint> = edges
        .iter()
        .filter(|&&(e0, e1)| seg_seg_cross(q0, q1, e0, e1, axis))
        .map(|&(e0, e1)| crossing_lpi(q0, q1, e0, e1, axis))
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
    let tb_edges = [(tb[0], tb[1]), (tb[1], tb[2]), (tb[2], tb[0])];
    tb_edges
        .iter()
        .filter_map(|&(q0, q1)| clip_seg(q0, q1, ta, axis, w0))
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

    #[test]
    fn issue_7292_near_coplanar_crossings_match_exact_projected_edges_on_all_axes() {
        use super::super::rational::lpi_point;
        use num_rational::BigRational;

        // In projected coordinates, ta's boundary is u+v=4. The two
        // overhanging tb edges cross it at (3,1) and (1,3), regardless of
        // tb's tiny offset from the shared slope w=v/64. A normal-extruded
        // auxiliary plane instead perturbs these projected crossings.
        for axis in [DropAxis::X, DropAxis::Y, DropAxis::Z] {
            let map = |u, v, w| match axis {
                DropAxis::X => [w, u, v],
                DropAxis::Y => [u, w, v],
                DropAxis::Z => [u, v, w],
            };
            let ta = [map(0.0, 0.0, 0.0), map(4.0, 0.0, 0.0), map(0.0, 4.0, 4.0 / 64.0)];
            // Zero is the exact-coplanar control; either sign exercises
            // nearly coplanar faces without changing the projected geometry.
            for offset in [0.0, 1.0 / 65_536.0, -1.0 / 65_536.0] {
                let tb = [map(1.0, 1.0, 1.0 / 64.0 + offset),
                    map(5.0, 1.0, 1.0 / 64.0 + offset),
                    map(1.0, 5.0, 5.0 / 64.0 + offset)];
                let expected = [map(3.0, 1.0, 1.0 / 64.0 + offset),
                    map(1.0, 3.0, 3.0 / 64.0 + offset)]
                    .map(|point| point.map(|value| BigRational::from_float(value).expect("finite dyadic oracle")));
                let mut crossings = Vec::new();
                for (a, b) in coplanar_clip(&ta, &tb) {
                    for point in [a, b] {
                        if let ImplicitPoint::Lpi(lpi) = point {
                            crossings.push(lpi_point(&lpi));
                        }
                    }
                }
                assert_eq!(crossings.len(), 2, "two projected boundary crossings: {axis:?}, {offset}");
                for point in &expected {
                    assert!(crossings.contains(point),
                        "#7292: missing exact projected crossing {point:?} for {axis:?}, offset {offset}; got {crossings:?}");
                }
            }
        }
    }
}
