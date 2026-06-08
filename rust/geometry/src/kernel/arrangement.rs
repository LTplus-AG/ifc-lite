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
use super::rational::point_of;
use super::retriangulate::{triangulate, Constraint, RetriInput};
use super::tritri::{tri_tri_intersection, TriTri};
use super::ImplicitPoint;
use num_traits::ToPrimitive;

pub type Tri = [[f64; 3]; 3];

/// Boolean operation.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BoolOp {
    /// `A − B`.
    Difference,
    /// `A ∪ B`.
    Union,
    /// `A ∩ B`.
    Intersection,
}

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

// --- M4: winding classification + boolean extraction ---------------------

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Forward ray (origin `o`, direction `d`) hits triangle `t` at t>0? (Möller–Trumbore.)
fn ray_hits(o: [f64; 3], d: [f64; 3], t: &Tri) -> bool {
    let e1 = sub3(t[1], t[0]);
    let e2 = sub3(t[2], t[0]);
    let h = cross3(d, e2);
    let det = dot3(e1, h);
    if det.abs() < 1e-12 {
        return false; // ray parallel to the triangle
    }
    let f = 1.0 / det;
    let s = sub3(o, t[0]);
    let u = f * dot3(s, h);
    if !(0.0..=1.0).contains(&u) {
        return false;
    }
    let q = cross3(s, e1);
    let v = f * dot3(d, q);
    if v < 0.0 || u + v > 1.0 {
        return false;
    }
    f * dot3(e2, q) > 1e-9
}

/// Is point `p` strictly inside the closed mesh `tris`? (Ray-cast parity along a
/// fixed non-axis-aligned direction — robust for the strictly-inside/outside
/// centroids the conforming arrangement produces.)
fn point_inside(p: [f64; 3], tris: &[Tri]) -> bool {
    let dir = [0.572_581, 0.573_006, 0.586_521]; // generic, dodges grazing
    tris.iter().filter(|t| ray_hits(p, dir, t)).count() % 2 == 1
}

/// Compute the boolean `op` of operand meshes `a` and `b`, materialised to f64
/// triangles. Each arrangement sub-triangle is classified inside/outside the
/// OTHER operand by its centroid, then selected (and flipped where the op needs
/// the inner boundary). `A−B = (A outside B) ∪ flip(B inside A)`;
/// `A∪B = (A outside B) ∪ (B outside A)`; `A∩B = (A inside B) ∪ (B inside A)`.
pub fn boolean(a: &[Tri], b: &[Tri], op: BoolOp) -> Vec<Tri> {
    let arr = arrange(a, b);
    let to_f = |v: Vid| -> [f64; 3] {
        let p = point_of(arr.interner.get(v));
        [
            p[0].to_f64().unwrap(),
            p[1].to_f64().unwrap(),
            p[2].to_f64().unwrap(),
        ]
    };
    let coords = |tri: [Vid; 3]| [to_f(tri[0]), to_f(tri[1]), to_f(tri[2])];
    let centroid = |c: &Tri| {
        [
            (c[0][0] + c[1][0] + c[2][0]) / 3.0,
            (c[0][1] + c[1][1] + c[2][1]) / 3.0,
            (c[0][2] + c[1][2] + c[2][2]) / 3.0,
        ]
    };
    let mut out = Vec::new();
    for &tri in &arr.tris_a {
        let c = coords(tri);
        let inside_b = point_inside(centroid(&c), b);
        let keep = match op {
            BoolOp::Difference | BoolOp::Union => !inside_b,
            BoolOp::Intersection => inside_b,
        };
        if keep {
            out.push(c);
        }
    }
    for &tri in &arr.tris_b {
        let c = coords(tri);
        let inside_a = point_inside(centroid(&c), a);
        let (keep, flip) = match op {
            BoolOp::Difference => (inside_a, true),
            BoolOp::Union => (!inside_a, false),
            BoolOp::Intersection => (inside_a, false),
        };
        if keep {
            out.push(if flip { [c[0], c[2], c[1]] } else { c });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// Axis-aligned cube `[lo,hi]³` as 12 outward-wound triangles.
    fn cube(lo: f64, hi: f64) -> Vec<Tri> {
        let p = [
            [lo, lo, lo], [hi, lo, lo], [hi, hi, lo], [lo, hi, lo],
            [lo, lo, hi], [hi, lo, hi], [hi, hi, hi], [lo, hi, hi],
        ];
        let idx = [
            [0, 3, 2], [0, 2, 1], // z=lo (−z)
            [4, 5, 6], [4, 6, 7], // z=hi (+z)
            [0, 4, 7], [0, 7, 3], // x=lo (−x)
            [1, 2, 6], [1, 6, 5], // x=hi (+x)
            [0, 1, 5], [0, 5, 4], // y=lo (−y)
            [3, 7, 6], [3, 6, 2], // y=hi (+y)
        ];
        idx.iter().map(|f| [p[f[0]], p[f[1]], p[f[2]]]).collect()
    }

    /// Signed volume of a closed mesh (divergence theorem): (1/6)Σ v0·(v1×v2).
    fn volume(m: &[Tri]) -> f64 {
        m.iter().map(|t| dot3(t[0], cross3(t[1], t[2]))).sum::<f64>() / 6.0
    }

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

    #[test]
    fn cube_helper_has_outward_winding() {
        assert!((volume(&cube(0., 2.)) - 8.0).abs() < 1e-9, "cube volume wrong (winding?)");
    }

    #[test]
    fn boolean_containment_cases_have_exact_volumes() {
        // A entirely inside B — no surface intersection, so this exercises the M4
        // classification + extraction WITHOUT the arrangement / seg×seg crossings.
        let a = cube(1., 2.); // vol 1, strictly inside B
        let b = cube(0., 3.); // vol 27
        let diff = boolean(&a, &b, BoolOp::Difference);
        assert!(volume(&diff).abs() < 1e-9, "A−B should be empty, vol={}", volume(&diff));
        let inter = boolean(&a, &b, BoolOp::Intersection);
        assert!((volume(&inter) - 1.0).abs() < 1e-9, "A∩B should be A (vol 1), got {}", volume(&inter));
        let uni = boolean(&a, &b, BoolOp::Union);
        assert!((volume(&uni) - 27.0).abs() < 1e-9, "A∪B should be B (vol 27), got {}", volume(&uni));
    }
}
