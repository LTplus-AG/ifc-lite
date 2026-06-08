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

use super::coplanar::coplanar_clip;
use super::interner::{Interner, Vid};
use super::predicates::{cmp_lex, orient2d_any, orient3d};
use super::rational::point_of;
use super::retriangulate::{projection_axis, triangulate, Constraint, RetriInput};
use super::tritri::{tri_tri_intersection, TriTri};
use super::{DropAxis, ImplicitPoint, Sign, Tpi};
use num_traits::ToPrimitive;
use std::cmp::Ordering;

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

/// A raw intersection segment on a triangle, tagged with the cutter triangle that
/// produced it (needed to locate seg×seg crossing points as triple points).
struct RawSeg {
    a: ImplicitPoint,
    b: ImplicitPoint,
    cutter: Tri,
}

#[inline]
fn tri_plane(t: &Tri) -> [[f64; 3]; 3] {
    *t
}

/// Do segments `(a1,b1)` and `(a2,b2)` (in `T`'s plane, projected by `axis`)
/// properly cross at an interior point? (Shared endpoints don't count.)
fn segments_cross(a1: &ImplicitPoint, b1: &ImplicitPoint, a2: &ImplicitPoint, b2: &ImplicitPoint, axis: super::DropAxis) -> bool {
    let s1 = orient2d_any(a1, b1, a2, axis);
    let s2 = orient2d_any(a1, b1, b2, axis);
    let s3 = orient2d_any(a2, b2, a1, axis);
    let s4 = orient2d_any(a2, b2, b1, axis);
    s1 != Sign::Zero && s2 != Sign::Zero && s1 != s2 && s3 != Sign::Zero && s4 != Sign::Zero && s3 != s4
}

/// seg×seg pre-pass for one triangle `t`: split every pair of crossing
/// constraint segments at their crossing point — `TPI(t.plane, cutter_i.plane,
/// cutter_j.plane)` (a valid triple point: crossing ⇒ the two cutter lines are
/// non-parallel in `t`'s plane ⇒ the three planes meet at a point). The result
/// is a crossing-free constraint set the re-triangulation can handle directly.
fn split_crossings(t: &Tri, raws: &[RawSeg]) -> Vec<Constraint> {
    let axis = match projection_axis(t) {
        Some((a, _)) => a,
        None => return Vec::new(),
    };
    let n = raws.len();
    let mut splits: Vec<Vec<ImplicitPoint>> = vec![Vec::new(); n];
    for k in 0..n {
        for l in (k + 1)..n {
            if segments_cross(&raws[k].a, &raws[k].b, &raws[l].a, &raws[l].b, axis) {
                let x = ImplicitPoint::Tpi(Tpi {
                    planes: [tri_plane(t), tri_plane(&raws[k].cutter), tri_plane(&raws[l].cutter)],
                });
                splits[k].push(x.clone());
                splits[l].push(x);
            }
        }
    }
    let mut out = Vec::new();
    for k in 0..n {
        let mut chain = vec![raws[k].a.clone()];
        chain.append(&mut splits[k]);
        chain.push(raws[k].b.clone());
        // order along the segment (collinear ⇒ lex order = line order) + dedup coincident
        chain.sort_by(|p, q| match cmp_lex(p, q) {
            Sign::Negative => Ordering::Less,
            Sign::Positive => Ordering::Greater,
            Sign::Zero => Ordering::Equal,
        });
        chain.dedup_by(|p, q| cmp_lex(p, q) == Sign::Zero);
        for w in chain.windows(2) {
            out.push(Constraint { a: w[0].clone(), b: w[1].clone() });
        }
    }
    out
}

/// Compute the conforming arrangement of operand meshes `a` and `b`.
pub fn arrange(a: &[Tri], b: &[Tri]) -> Arrangement {
    // 1. accumulate raw intersection segments (Segment pairs) + coplanar overlaps
    let mut raw_a: Vec<Vec<RawSeg>> = (0..a.len()).map(|_| Vec::new()).collect();
    let mut raw_b: Vec<Vec<RawSeg>> = (0..b.len()).map(|_| Vec::new()).collect();
    let mut cop_a: Vec<Vec<Constraint>> = (0..a.len()).map(|_| Vec::new()).collect();
    let mut cop_b: Vec<Vec<Constraint>> = (0..b.len()).map(|_| Vec::new()).collect();
    for (i, ta) in a.iter().enumerate() {
        for (j, tb) in b.iter().enumerate() {
            if !bbox_overlap(ta, tb) {
                continue;
            }
            match tri_tri_intersection(ta, tb) {
                TriTri::Segment([s, t]) => {
                    raw_a[i].push(RawSeg { a: s.clone(), b: t.clone(), cutter: *tb });
                    raw_b[j].push(RawSeg { a: s, b: t, cutter: *ta });
                }
                TriTri::Coplanar => {
                    cop_a[i].extend(coplanar_clip(ta, tb).into_iter().map(|(a, b)| Constraint { a, b }));
                    cop_b[j].extend(coplanar_clip(tb, ta).into_iter().map(|(a, b)| Constraint { a, b }));
                }
                TriTri::None | TriTri::Point(_) => {}
            }
        }
    }
    // 2. seg×seg pre-pass on the segment constraints, then append the coplanar ones
    let build = |tris: &[Tri], raw: &[Vec<RawSeg>], cop: &mut [Vec<Constraint>]| -> Vec<Vec<Constraint>> {
        (0..tris.len())
            .map(|i| {
                let mut c = split_crossings(&tris[i], &raw[i]);
                c.append(&mut cop[i]);
                c
            })
            .collect()
    };
    let ca = build(a, &raw_a, &mut cop_a);
    let cb = build(b, &raw_b, &mut cop_b);
    // 3. re-triangulate each operand over the SHARED interner ⇒ conforming surfaces
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

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn e(p: [f64; 3]) -> ImplicitPoint {
    ImplicitPoint::Explicit(p)
}

/// EXACT segment–triangle intersection via `orient3d` (no epsilon): the segment
/// `q1→q2` crosses triangle `t` iff its endpoints straddle `t`'s plane AND the
/// line passes the same side of all three edges. A grazing hit (`orient3d == 0`)
/// is rejected — the fixed generic ray direction makes those vanishingly rare.
fn exact_seg_hits_tri(q1: [f64; 3], q2: [f64; 3], t: &Tri) -> bool {
    let s1 = orient3d(&e(t[0]), &e(t[1]), &e(t[2]), &e(q1));
    let s2 = orient3d(&e(t[0]), &e(t[1]), &e(t[2]), &e(q2));
    if s1 == Sign::Zero || s2 == Sign::Zero || s1 == s2 {
        return false;
    }
    let ea = orient3d(&e(q1), &e(q2), &e(t[0]), &e(t[1]));
    let eb = orient3d(&e(q1), &e(q2), &e(t[1]), &e(t[2]));
    let ec = orient3d(&e(q1), &e(q2), &e(t[2]), &e(t[0]));
    ea != Sign::Zero && ea == eb && eb == ec
}

/// Is point `p` inside the closed mesh `tris`? Exact ray-cast parity: a segment
/// from `p` to a far point along a fixed generic direction (guaranteed outside
/// the mesh), each crossing tested by the exact predicate above.
fn point_inside(p: [f64; 3], tris: &[Tri]) -> bool {
    let dir = [0.572_581, 0.573_006, 0.586_521];
    let far = [p[0] + dir[0] * 1e7, p[1] + dir[1] * 1e7, p[2] + dir[2] * 1e7];
    tris.iter().filter(|t| exact_seg_hits_tri(p, far, t)).count() % 2 == 1
}

fn to_f64_pt(arr: &Arrangement, v: Vid) -> [f64; 3] {
    let p = point_of(arr.interner.get(v));
    [p[0].to_f64().unwrap(), p[1].to_f64().unwrap(), p[2].to_f64().unwrap()]
}

fn sub_f64(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn centroid(arr: &Arrangement, tri: [Vid; 3]) -> [f64; 3] {
    let c = [to_f64_pt(arr, tri[0]), to_f64_pt(arr, tri[1]), to_f64_pt(arr, tri[2])];
    [
        (c[0][0] + c[1][0] + c[2][0]) / 3.0,
        (c[0][1] + c[1][1] + c[2][1]) / 3.0,
        (c[0][2] + c[1][2] + c[2][2]) / 3.0,
    ]
}

fn tri_normal(arr: &Arrangement, tri: [Vid; 3]) -> [f64; 3] {
    let (a, b, c) = (to_f64_pt(arr, tri[0]), to_f64_pt(arr, tri[1]), to_f64_pt(arr, tri[2]));
    cross3(sub_f64(b, a), sub_f64(c, a))
}

fn drop_axis_of(n: [f64; 3]) -> DropAxis {
    let an = [n[0].abs(), n[1].abs(), n[2].abs()];
    if an[0] >= an[1] && an[0] >= an[2] {
        DropAxis::X
    } else if an[1] >= an[2] {
        DropAxis::Y
    } else {
        DropAxis::Z
    }
}

/// If point `c` lies exactly on a triangle of `others` (coplanar AND inside it),
/// return that triangle's f64 normal — i.e. detect that a sub-triangle whose
/// centroid is `c` sits on a coplanar SHARED face of the other operand.
fn on_surface_normal(c: [f64; 3], others: &[Tri]) -> Option<[f64; 3]> {
    for t in others {
        if orient3d(&e(t[0]), &e(t[1]), &e(t[2]), &e(c)) != Sign::Zero {
            continue; // c not on t's plane
        }
        let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
        let axis = drop_axis_of(n);
        let w0 = orient2d_any(&e(t[0]), &e(t[1]), &e(t[2]), axis);
        if w0 == Sign::Zero {
            continue; // degenerate t
        }
        let inside = |u: [f64; 3], v: [f64; 3]| orient2d_any(&e(u), &e(v), &e(c), axis) != w0.flip();
        if inside(t[0], t[1]) && inside(t[1], t[2]) && inside(t[2], t[0]) {
            return Some(n);
        }
    }
    None
}

/// The boolean result as ORIENTED Vid triangles. A sub-triangle whose centroid is
/// strictly inside/outside the other operand is classified by exact ray-cast;
/// one whose centroid lies on a coplanar SHARED face of the other operand is
/// classified by NORMAL AGREEMENT (the ray-cast is undefined there): keep only
/// the A-copy, and only when the op's winding agrees — back-to-back faces are an
/// internal interface (union/intersection remove both), the A-copy survives a
/// difference's outer boundary; the B-copy is always dropped (dedup).
fn boolean_vids(arr: &Arrangement, a: &[Tri], b: &[Tri], op: BoolOp) -> Vec<[Vid; 3]> {
    let mut out = Vec::new();
    for &tri in &arr.tris_a {
        let c = centroid(arr, tri);
        if let Some(n_other) = on_surface_normal(c, b) {
            let co_oriented = dot3(tri_normal(arr, tri), n_other) > 0.0;
            let keep = match op {
                BoolOp::Union | BoolOp::Intersection => co_oriented,
                BoolOp::Difference => !co_oriented,
            };
            if keep {
                out.push(tri); // the A-copy, oriented as-is
            }
        } else {
            let inside_b = point_inside(c, b);
            let keep = match op {
                BoolOp::Intersection => inside_b,
                _ => !inside_b,
            };
            if keep {
                out.push(tri);
            }
        }
    }
    for &tri in &arr.tris_b {
        let c = centroid(arr, tri);
        if on_surface_normal(c, a).is_some() {
            continue; // coplanar-shared B-copy: dropped (the A-copy is the kept one)
        }
        let inside_a = point_inside(c, a);
        let (keep, flip) = match op {
            BoolOp::Difference => (inside_a, true),
            BoolOp::Union => (!inside_a, false),
            BoolOp::Intersection => (inside_a, false),
        };
        if keep {
            out.push(if flip { [tri[0], tri[2], tri[1]] } else { tri });
        }
    }
    out
}

/// Compute the boolean `op` of operand meshes `a` and `b`, materialised to f64
/// triangles. `A−B = (A outside B) ∪ flip(B inside A)`;
/// `A∪B = (A outside B) ∪ (B outside A)`; `A∩B = (A inside B) ∪ (B inside A)`.
pub fn boolean(a: &[Tri], b: &[Tri], op: BoolOp) -> Vec<Tri> {
    let arr = arrange(a, b);
    boolean_vids(&arr, a, b, op)
        .into_iter()
        .map(|t| [to_f64_pt(&arr, t[0]), to_f64_pt(&arr, t[1]), to_f64_pt(&arr, t[2])])
        .collect()
}

#[inline]
fn rotate_min_first(t: [Vid; 3]) -> [Vid; 3] {
    let i = (0..3).min_by_key(|&k| t[k]).unwrap();
    [t[i], t[(i + 1) % 3], t[(i + 2) % 3]]
}

/// Topology fingerprint of a boolean result: each oriented Vid triangle rotated
/// min-first (canonical start vertex, winding preserved), the list sorted,
/// FNV-1a-hashed. Platform-stable — Vids are deterministic symbolic identities
/// and the ray-cast classification is FMA-free f64.
pub fn boolean_topology_hash(a: &[Tri], b: &[Tri], op: BoolOp) -> u64 {
    let arr = arrange(a, b);
    let mut tris: Vec<[Vid; 3]> =
        boolean_vids(&arr, a, b, op).into_iter().map(rotate_min_first).collect();
    tris.sort_unstable();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for t in tris {
        for v in t {
            h ^= v as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

/// Axis-aligned box `[lo,hi]` as 12 outward-wound triangles.
pub fn box_mesh(lo: [f64; 3], hi: [f64; 3]) -> Vec<Tri> {
    let p = [
        [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
        [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]],
    ];
    let idx = [
        [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7],
        [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
        [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    ];
    idx.iter().map(|f| [p[f[0]], p[f[1]], p[f[2]]]).collect()
}

/// Axis-aligned cube `[lo,hi]³`.
pub fn cube_mesh(lo: f64, hi: f64) -> Vec<Tri> {
    box_mesh([lo, lo, lo], [hi, hi, hi])
}

/// Cross-platform full-boolean determinism manifest: `cube[0,2]³ − cube[1,3]³`.
pub fn boolean_manifest() -> u64 {
    boolean_topology_hash(&cube_mesh(0.0, 2.0), &cube_mesh(1.0, 3.0), BoolOp::Difference)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn cube(lo: f64, hi: f64) -> Vec<Tri> {
        super::cube_mesh(lo, hi)
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

    #[test]
    fn box_minus_box_real_cut_has_exact_volume() {
        // Two overlapping cubes — a real surface cut, exercising seg×seg crossings
        // (each cut face gets a closed constraint loop with corner X-junctions).
        let a = cube(0., 2.); // vol 8
        let b = cube(1., 3.); // vol 8, overlap [1,2]³ = vol 1
        let diff = volume(&boolean(&a, &b, BoolOp::Difference));
        assert!((diff - 7.0).abs() < 1e-6, "A−B volume = {diff}, expected 7");
        let inter = volume(&boolean(&a, &b, BoolOp::Intersection));
        assert!((inter - 1.0).abs() < 1e-6, "A∩B volume = {inter}, expected 1");
        let uni = volume(&boolean(&a, &b, BoolOp::Union));
        assert!((uni - 15.0).abs() < 1e-6, "A∪B volume = {uni}, expected 15");
    }

    #[test]
    fn abutting_boxes_union_is_manifold_and_correct_volume() {
        use num_rational::BigRational;
        use num_traits::ToPrimitive;
        use std::collections::BTreeMap;
        // two unit cubes sharing the x=1 face (a coplanar SHARED-FACE degeneracy)
        let a = box_mesh([0., 0., 0.], [1., 1., 1.]);
        let b = box_mesh([1., 0., 0.], [2., 1., 1.]);
        let arr = arrange(&a, &b);
        let result = boolean_vids(&arr, &a, &b, BoolOp::Union);
        assert!(!result.is_empty(), "union is empty");
        // manifold: every undirected edge used exactly twice (no doubled face)
        let mut edges: BTreeMap<(Vid, Vid), u32> = BTreeMap::new();
        for t in &result {
            for (u, v) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *edges.entry(if u < v { (u, v) } else { (v, u) }).or_insert(0) += 1;
            }
        }
        assert!(
            edges.values().all(|&c| c == 2),
            "abutting union is non-manifold (the shared x=1 face was not deduped)"
        );
        // volume == 2 (the merged [0,2]×[0,1]×[0,1] box)
        let co = |v: Vid| {
            let p = point_of(arr.interner.get(v));
            [
                BigRational::to_f64(&p[0]).unwrap(),
                BigRational::to_f64(&p[1]).unwrap(),
                BigRational::to_f64(&p[2]).unwrap(),
            ]
        };
        let vol: f64 = result
            .iter()
            .map(|t| dot3(co(t[0]), cross3(co(t[1]), co(t[2]))))
            .sum::<f64>()
            / 6.0;
        assert!((vol - 2.0).abs() < 1e-6, "abutting-boxes union volume = {vol}, expected 2");
    }

    #[test]
    fn boolean_manifest_is_pinned() {
        // The full-boolean topology fingerprint (cube[0,2]³ − cube[1,3]³),
        // byte-identical across x86_64/aarch64/wasm (re-pin + re-run the wasm
        // cross-check if the boolean logic legitimately changes).
        const PINNED: u64 = 0x0465_b83a_5fdb_8b2b;
        let m = super::boolean_manifest();
        assert_eq!(m, PINNED, "boolean topology manifest changed: 0x{m:016x}");
    }
}
