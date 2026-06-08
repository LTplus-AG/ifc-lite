// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh arrangement (L3, M3) — the conforming intersection of two operand meshes.
//!
//! For every pair of triangles (one per operand) that cross, the intersection
//! segment becomes a constraint for BOTH triangles (it lies on both planes), and
//! each crossed triangle is re-triangulated with its accumulated constraints.
//! All re-triangulations share ONE interner, so a vertex created on the
//! intersection of A's triangle and B's triangle gets the SAME symbolic Vid in
//! both surfaces — i.e. the two operands' meshes CONFORM along the intersection.
//! The result is a single intersection-free complex, ready for L4 winding
//! classification.
//!
//! This increment: all-pairs broadphase (AABB cull) + the proper-crossing
//! `Segment` case. BVH broadphase, coplanar overlap, and vertex/edge `Touches`
//! degeneracies are later increments.

use super::interner::{Interner, Vid};
use super::retriangulate::{triangulate, Constraint, RetriInput};
use super::tritri::{tri_tri_intersection, TriTri};
use super::ImplicitPoint;

pub type Tri = [[f64; 3]; 3];

/// The conforming arrangement of two operand meshes over a shared interner.
pub struct Arrangement {
    pub interner: Interner,
    /// Operand A's conforming sub-triangles (interned Vids).
    pub tris_a: Vec<[Vid; 3]>,
    /// Operand B's conforming sub-triangles.
    pub tris_b: Vec<[Vid; 3]>,
}

fn aabb(t: &Tri) -> ([f64; 3], [f64; 3]) {
    let mut lo = t[0];
    let mut hi = t[0];
    for p in t.iter().skip(1) {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    (lo, hi)
}

fn bbox_overlap(a: &Tri, b: &Tri) -> bool {
    let (alo, ahi) = aabb(a);
    let (blo, bhi) = aabb(b);
    (0..3).all(|k| alo[k] <= bhi[k] && blo[k] <= ahi[k])
}

/// Compute the conforming arrangement of operand meshes `a` and `b`.
pub fn arrange(a: &[Tri], b: &[Tri]) -> Arrangement {
    // 1. accumulate each triangle's intersection-segment constraints
    let mut ca: Vec<Vec<Constraint>> = vec![Vec::new(); a.len()];
    let mut cb: Vec<Vec<Constraint>> = vec![Vec::new(); b.len()];
    for (i, ta) in a.iter().enumerate() {
        for (j, tb) in b.iter().enumerate() {
            if !bbox_overlap(ta, tb) {
                continue;
            }
            if let TriTri::Segment([s, t]) = tri_tri_intersection(ta, tb) {
                let c = Constraint { a: ImplicitPoint::Lpi(s), b: ImplicitPoint::Lpi(t) };
                ca[i].push(c.clone());
                cb[j].push(c);
            }
        }
    }
    // 2. re-triangulate each operand over the SHARED interner ⇒ conforming surfaces
    let mut interner = Interner::new();
    let tris_a = retriangulate_each(a, &ca, &mut interner);
    let tris_b = retriangulate_each(b, &cb, &mut interner);
    Arrangement { interner, tris_a, tris_b }
}

fn retriangulate_each(tris: &[Tri], cons: &[Vec<Constraint>], it: &mut Interner) -> Vec<[Vid; 3]> {
    let mut out = Vec::new();
    for (i, t) in tris.iter().enumerate() {
        let passthrough = |it: &mut Interner| {
            [
                it.intern(ImplicitPoint::Explicit(t[0])),
                it.intern(ImplicitPoint::Explicit(t[1])),
                it.intern(ImplicitPoint::Explicit(t[2])),
            ]
        };
        if cons[i].is_empty() {
            out.push(passthrough(it));
        } else if let Some(mesh) =
            triangulate(&RetriInput { tri: *t, constraints: cons[i].clone() }, it)
        {
            out.extend(mesh.tris);
        } else {
            out.push(passthrough(it)); // degenerate triangle — pass through
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn arrange_two_crossing_triangles_conform_along_the_intersection() {
        // Two triangles that skewer each other (from the tri-tri tests).
        let ta: Tri = [[-2., 0., -1.], [2., 0., -1.], [0., 0., 2.]]; // plane y=0
        let tb: Tri = [[1., -2., 1.], [1., 2., 1.], [1., 0.5, -3.]]; // plane x=1
        let arr = arrange(&[ta], &[tb]);
        // both operands were subdivided
        assert!(arr.tris_a.len() >= 2, "operand A not subdivided");
        assert!(arr.tris_b.len() >= 2, "operand B not subdivided");
        // CONFORMITY: the intersection segment's two endpoints are shared vertices
        // (same Vid) of BOTH operands' sub-meshes — they have no coincident corners,
        // so the only shared vertices are the intersection endpoints.
        let va: BTreeSet<Vid> = arr.tris_a.iter().flatten().copied().collect();
        let vb: BTreeSet<Vid> = arr.tris_b.iter().flatten().copied().collect();
        let shared: Vec<Vid> = va.intersection(&vb).copied().collect();
        assert_eq!(
            shared.len(),
            2,
            "operands must share exactly the 2 intersection-segment vertices (conformity)"
        );
    }

    #[test]
    fn arrange_disjoint_meshes_are_untouched() {
        let ta: Tri = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]];
        let tb: Tri = [[0., 0., 10.], [1., 0., 10.], [0., 1., 10.]]; // far away
        let arr = arrange(&[ta], &[tb]);
        assert_eq!(arr.tris_a.len(), 1, "disjoint A should pass through");
        assert_eq!(arr.tris_b.len(), 1, "disjoint B should pass through");
    }
}
