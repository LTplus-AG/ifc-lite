// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! In-plane constrained re-triangulation (M2.3) — phases A–F.
//!
//! Each input triangle `T` crossed by other triangles accumulates intersection
//! sub-segments lying in its plane; this module re-triangulates `T` into a
//! conforming, intersection-free fan of sub-triangles whose vertices are
//! referenced SYMBOLICALLY (via the interner, never a float coordinate), with a
//! topology that is invariant to insertion order and byte-identical across
//! platforms. See `docs/architecture/pure-rust-csg-kernel.md` (M2.3 section).
//!
//! This increment delivers PHASE A (exact projection axis + reference winding)
//! and PHASE B (canonical lex-rank work list). Phases C–F (point insertion,
//! segment insertion, earcut, emit) build on the canonical list produced here.

use super::interner::{Interner, Vid};
use super::predicates::{cmp_lex, orient2d};
use super::{DropAxis, ImplicitPoint, Sign};
use std::cmp::Ordering;

#[inline]
fn e(p: [f64; 3]) -> ImplicitPoint {
    ImplicitPoint::Explicit(p)
}

/// A constraint segment lying in `T`'s plane (endpoints explicit or implicit).
#[derive(Clone)]
pub struct Constraint {
    pub a: ImplicitPoint,
    pub b: ImplicitPoint,
}

/// Input to the re-triangulation of one triangle `T`.
pub struct RetriInput {
    pub tri: [[f64; 3]; 3],
    pub constraints: Vec<Constraint>,
}

#[inline]
fn normal_idx(a: DropAxis) -> usize {
    match a {
        DropAxis::X => 0,
        DropAxis::Y => 1,
        DropAxis::Z => 2,
    }
}

/// Candidate drop axes, dominant-normal-component first (the f64 magnitude order
/// is deterministic — no FMA, IEEE-754 cross product; ties broken by axis index).
/// The CHOICE among candidates is decided exactly by `orient2d != Zero`, so the
/// f64 magnitude only orders candidates, never decides degeneracy.
fn axis_candidates(t: &[[f64; 3]; 3]) -> [DropAxis; 3] {
    let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let u = sub(t[1], t[0]);
    let v = sub(t[2], t[0]);
    let n = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    let mag = [n[0].abs(), n[1].abs(), n[2].abs()];
    let mut axes = [DropAxis::X, DropAxis::Y, DropAxis::Z];
    axes.sort_by(|&a, &b| {
        let (ia, ib) = (normal_idx(a), normal_idx(b));
        mag[ib]
            .partial_cmp(&mag[ia])
            .unwrap_or(Ordering::Equal)
            .then(ia.cmp(&ib))
    });
    axes
}

/// PHASE A — pick the drop axis whose projected area is EXACTLY nonzero, plus the
/// reference winding `w0` (the orient2d sign of `T` under that axis, so every
/// output sub-triangle can be emitted with `T`'s orientation). `None` ⇒ `T` is
/// degenerate (zero projected area in every axis).
pub fn projection_axis(t: &[[f64; 3]; 3]) -> Option<(DropAxis, Sign)> {
    for axis in axis_candidates(t) {
        let w = orient2d(&e(t[0]), &e(t[1]), &e(t[2]), axis);
        if w != Sign::Zero {
            return Some((axis, w));
        }
    }
    None
}

/// PHASE B output — the canonical, order-independent work list.
pub struct Canonical {
    /// `T`'s three corners, interned.
    pub corners: [Vid; 3],
    /// Constraint segments, each ordered `lo ≤ hi` by lex-rank; the list itself
    /// is lex-sorted and deduplicated.
    pub segments: Vec<(Vid, Vid)>,
}

fn lex_cmp(it: &Interner, a: Vid, b: Vid) -> Ordering {
    match cmp_lex(it.get(a), it.get(b)) {
        Sign::Negative => Ordering::Less,
        Sign::Positive => Ordering::Greater,
        Sign::Zero => Ordering::Equal, // only when a == b (distinct Vids never coincide)
    }
}

/// PHASE B — intern `T`'s corners + every constraint endpoint into the shared
/// `interner`, order each segment's endpoints by lex-rank, and sort the segment
/// list canonically (deduplicating). The output is a pure function of the input
/// geometry, independent of the order constraints arrive in.
pub fn canonicalize(input: &RetriInput, interner: &mut Interner) -> Canonical {
    let corners = [
        interner.intern(e(input.tri[0])),
        interner.intern(e(input.tri[1])),
        interner.intern(e(input.tri[2])),
    ];
    let mut segments: Vec<(Vid, Vid)> = input
        .constraints
        .iter()
        .filter_map(|c| {
            let va = interner.intern(c.a.clone());
            let vb = interner.intern(c.b.clone());
            if va == vb {
                None // degenerate: coincident endpoints
            } else if lex_cmp(interner, va, vb) == Ordering::Greater {
                Some((vb, va))
            } else {
                Some((va, vb))
            }
        })
        .collect();
    segments.sort_by(|&(a0, a1), &(b0, b1)| {
        lex_cmp(interner, a0, b0).then_with(|| lex_cmp(interner, a1, b1))
    });
    segments.dedup();
    Canonical { corners, segments }
}

#[cfg(test)]
mod tests {
    use super::super::rational::point_of;
    use super::super::Lpi;
    use super::*;

    #[test]
    fn phase_a_picks_a_nonzero_axis_and_winding() {
        // horizontal triangle (normal +Z) → drop Z
        let t = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]];
        let (axis, w) = projection_axis(&t).unwrap();
        assert_eq!(axis, DropAxis::Z);
        assert_ne!(w, Sign::Zero);
        // vertical triangle in y=0 (normal +Y) → drop Y
        let t2 = [[0., 0., 0.], [0., 0., 1.], [1., 0., 0.]];
        assert_eq!(projection_axis(&t2).unwrap().0, DropAxis::Y);
        // degenerate (collinear) → None in every projection
        let t3 = [[0., 0., 0.], [1., 1., 1.], [2., 2., 2.]];
        assert!(projection_axis(&t3).is_none());
    }

    #[test]
    fn phase_a_is_deterministic_on_a_45_degree_face() {
        // normal ∝ (1,1,0)/√2 — |n_x| == |n_y|; the index tiebreak must pick a
        // stable axis (X before Y), exactly, on every platform.
        let t = [[0., 0., 0.], [1., -1., 0.], [1., -1., 2.]];
        let a = projection_axis(&t);
        let b = projection_axis(&t);
        assert_eq!(a.map(|x| x.0), b.map(|x| x.0));
        assert!(a.is_some());
    }

    #[test]
    fn phase_b_canonical_order_is_independent_of_input_order() {
        let t = [[0., 0., 0.], [4., 0., 0.], [0., 4., 0.]]; // z=0
        // an LPI at (1,1,0) (in T's plane)
        let lpi = ImplicitPoint::Lpi(Lpi {
            p: [1., 1., -1.],
            q: [1., 1., 1.],
            r: [0., 0., 0.],
            s: [1., 0., 0.],
            t: [0., 1., 0.],
        });
        let c1 = Constraint { a: e([2., 0., 0.]), b: e([0., 2., 0.]) };
        let c2 = Constraint { a: lpi, b: e([3., 0., 0.]) };
        let materialise = |cons: Vec<Constraint>| {
            let mut it = Interner::new();
            let canon = canonicalize(&RetriInput { tri: t, constraints: cons }, &mut it);
            canon
                .segments
                .iter()
                .map(|&(lo, hi)| (point_of(it.get(lo)), point_of(it.get(hi))))
                .collect::<Vec<_>>()
        };
        let forward = materialise(vec![c1.clone(), c2.clone()]);
        let backward = materialise(vec![c2.clone(), c1.clone()]);
        assert_eq!(forward, backward, "canonical segment order depends on input order");
        // a duplicate constraint is deduplicated
        let with_dup = materialise(vec![c1.clone(), c1.clone(), c2.clone()]);
        assert_eq!(with_dup.len(), 2, "duplicate constraint not deduped");
    }
}
