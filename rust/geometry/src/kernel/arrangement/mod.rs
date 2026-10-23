// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh arrangement — the conforming intersection of two operand meshes.
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
//! Broadphase is a hand-rolled AABB BVH (`super::broadphase`) that filters
//! candidate triangle pairs before the exact per-pair `tri_tri_intersection`
//! test; that test itself resolves both the proper-crossing `Segment` case and
//! the on-plane-vertex/edge `Touches` degeneracies (folded into `Segment`/
//! `Chord`, see `tritri::PlaneInterval`). Coplanar overlaps are handled
//! separately via `coplanar_clip` and accumulated alongside the segment
//! constraints before re-triangulation.

use super::coplanar::{clip_supported, SupportedClip};
use super::interner::{Interner, Vid};
use super::predicates::{cmp_lex, orient2d_any};
use super::retriangulate::{projection_axis, triangulate, Constraint, RetriInput};
use super::tritri::{tri_tri_intersection_with_band, TriTri};
use super::{ImplicitPoint, Sign, Tpi};

mod admission;
mod binary;
mod mixed;
mod boolean;
mod classify;
mod coincident;
pub(super) use coincident::coincident_planes;
mod ray_parity;
#[cfg(test)]
mod tests;

pub use self::admission::{operands_admitted, MAX_OPERAND_COORD};
pub use self::boolean::{
    boolean, boolean_manifest, boolean_topology_hash, boolean_with_conformity, box_mesh, cube_mesh,
    difference_all, difference_all_lenient, difference_all_lenient_with_conformity, union_all,
};
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
    /// Source cutter component, repeated over each original parent's children.
    component_b: Vec<usize>,
    /// Identical per(A,Bk) scatter context for construction and classification.
    bands: Vec<super::near_band::NearBand>,
    /// Total constraint sub-segments the per-triangle re-triangulations could
    /// not force as edges (`Mesh2d::unrecovered`). Non-zero ⇒ the operands do
    /// not fully conform along their intersection; centroid classification of
    /// straddling sub-triangles is unreliable. The N-ary batched difference
    /// treats this as a hard reject; the binary boolean keeps its historical
    /// graceful-degrade behavior.
    pub unrecovered: usize,
    /// Per-sub-triangle (parallel to `tris_a`) flag: this sub-triangle's PARENT
    /// face had a COPLANAR overlap with the other operand — so a sub-triangle on
    /// it may lie on a shared interface plane and needs the [`solid_side`] regime-2
    /// classification (`boolean_vids`). `false` ⇒ the parent face is transversal to
    /// the other operand, so the plain centroid ray-cast suffices (the common case;
    /// keeps box−box etc. on the fast single-cast path).
    pub coplanar_a: Vec<bool>,
    /// Per-sub-triangle (parallel to `tris_b`) coplanar-parent flag.
    pub coplanar_b: Vec<bool>,
    /// Lazy per-Vid materialized f64 point cache. Classification
    /// (`centroid`/`tri_normal` per sub-triangle) and the final output map all
    /// call `to_f64_pt` on the SAME heavily-shared conforming vertices many times;
    /// materialising the interned point (fixed-width lambda, or the BigRational
    /// fallback) is not free, so each Vid is computed once and reused. The cached
    /// value equals a fresh computation exactly, so the boolean output is
    /// unchanged. Indexed by `Vid`; `None` = not yet materialised.
    f64_cache: std::cell::RefCell<Vec<Option<[f64; 3]>>>,
}

/// A raw intersection segment on a triangle, tagged with the cutter triangle that
/// produced it (needed to locate seg×seg crossing points as triple points).
struct RawSeg {
    a: ImplicitPoint,
    b: ImplicitPoint,
    cutter: Tri,
}

/// A segment endpoint paired with its CACHED interval lambda, so `orient2d` can run
/// the f64-interval determinant straight from the lambda (the >95%-resolving fast
/// tier) without re-deriving the degree-4/7 LPI/TPI lambda on every call. The raw
/// `ImplicitPoint` is kept only for the exact-tier fallback on an interval straddle.
type EndLam<'a> = (&'a super::interval::IvLam, &'a ImplicitPoint);

/// 2-D orientation from cached interval lambdas, falling to the full exact cascade
/// (`orient2d_any`) only when the interval determinant straddles zero. Either way
/// the returned sign is the EXACT sign, so callers are byte-identical to recomputing.
#[inline]
fn orient2d_end(a: EndLam, b: EndLam, c: EndLam, axis: super::DropAxis) -> Sign {
    super::interval::orient2d_from_lam_iv(a.0, b.0, c.0, axis)
        .unwrap_or_else(|| orient2d_any(a.1, b.1, c.1, axis))
}

/// Do segments `(a1,b1)` and `(a2,b2)` (in `T`'s plane, projected by `axis`)
/// properly cross at an interior point? (Shared endpoints don't count.) Lambda-
/// cached variant of the classic four-orientation test.
fn segments_cross(a1: EndLam, b1: EndLam, a2: EndLam, b2: EndLam, axis: super::DropAxis) -> bool {
    let s1 = orient2d_end(a1, b1, a2, axis);
    if s1 == Sign::Zero { return false; }
    let s2 = orient2d_end(a1, b1, b2, axis);
    if s2 == Sign::Zero || s1 == s2 { return false; }
    let s3 = orient2d_end(a2, b2, a1, axis);
    if s3 == Sign::Zero { return false; }
    let s4 = orient2d_end(a2, b2, b1, axis);
    s4 != Sign::Zero && s3 != s4
}

/// seg×seg pre-pass for one triangle `t`: split every pair of crossing
/// constraint segments at their crossing point — `TPI(t.plane, cutter_i.plane,
/// cutter_j.plane)` (a valid triple point: crossing ⇒ the two cutter lines are
/// non-parallel in `t`'s plane ⇒ the three planes meet at a point). The result
/// is a crossing-free constraint set the re-triangulation can handle directly.
fn split_crossings(t: &Tri, raws: &[RawSeg]) -> Vec<mixed::Supported> {
    let axis = match projection_axis(t) {
        Some((a, _)) => a,
        None => return Vec::new(),
    };
    let n = raws.len();
    // Cache each endpoint's interval lambda ONCE (Attene "Indirect Predicates" §5.4):
    // the O(n²) crossing loop reuses every endpoint across many `orient2d` calls and
    // would otherwise re-derive its degree-4/7 LPI/TPI lambda on each. Byte-identical
    // — the cached lambda equals a fresh one and the exact tiers are unchanged.
    let iv: Vec<(super::interval::IvLam, super::interval::IvLam)> = raws
        .iter()
        .map(|r| (super::interval::ilambda_cached(&r.a), super::interval::ilambda_cached(&r.b)))
        .collect();
    let mut splits: Vec<Vec<ImplicitPoint>> = vec![Vec::new(); n];
    for k in 0..n {
        let (ka, kb) = ((&iv[k].0, &raws[k].a), (&iv[k].1, &raws[k].b));
        for l in (k + 1)..n {
            let (la, lb) = ((&iv[l].0, &raws[l].a), (&iv[l].1, &raws[l].b));
            if segments_cross(ka, kb, la, lb, axis) {
                let x = ImplicitPoint::Tpi(Tpi {
                    planes: [*t, raws[k].cutter, raws[l].cutter],
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
        chain.sort_by(mixed::order);
        chain.dedup_by(|p, q| cmp_lex(p, q) == Sign::Zero);
        for w in chain.windows(2) {
            out.push(mixed::Supported {
                constraint: Constraint { a: w[0].clone(), b: w[1].clone() },
                support: raws[k].cutter,
            });
        }
    }
    out
}

/// Conforming arrangement of `a` and `b`; refused past [`MAX_OPERAND_COORD`].
pub fn arrange(a: &[Tri], b: &[Tri]) -> Arrangement {
    binary::arrange(a, b)
}

/// The conforming arrangement of `n` operand meshes over one shared interner.
/// `subtris[k]` is mesh `k`'s conforming sub-triangles; there is no separate
/// owner/index table — a sub-triangle's originating mesh is simply its
/// position `k` in `subtris`.
pub struct MultiArrangement {
    pub interner: Interner,
    /// `subtris[k]` = mesh `k`'s conforming sub-triangles (interned Vids).
    pub subtris: Vec<Vec<[Vid; 3]>>,
    /// Total constraint sub-segments the per-mesh re-triangulations could not
    /// force as edges (summed over every mesh's `Mesh2d::unrecovered`). Non-zero
    /// ⇒ the operands do not fully conform along their intersections, so a
    /// straddling sub-triangle's centroid classification in [`union_all`] is
    /// unreliable (the union can silently tear). Mirrors [`Arrangement::unrecovered`]
    /// so [`union_all`] can SIGNAL the same non-conformity condition
    /// [`difference_all`] hard-rejects (it was previously discarded into a `_`).
    pub unrecovered: usize,
}

/// Conforming arrangement of `meshes` (N operands) over ONE interner.
///
/// Every ORDERED pair of distinct meshes is intersected (segment + coplanar)
/// exactly as the binary [`arrange`] does, and the accumulated constraints
/// re-triangulate each mesh over the shared interner — so a vertex created on a
/// shared edge/seam interns to the SAME Vid in every mesh that touches it (full
/// N-way conformity). This is what lets [`union_all`] classify each sub-triangle
/// against all OTHER solids WITHOUT ever re-meshing an intermediate union (the
/// pairwise-accumulation step that compounds coplanar T-junctions).
pub fn arrange_many(meshes: &[&[Tri]]) -> MultiArrangement {
    if !operands_admitted(meshes) { return admission::refused_many(meshes.len()); } // #7677
    let n = meshes.len();
    // per-mesh, per-triangle constraint accumulators
    let mut raw: Vec<Vec<Vec<RawSeg>>> =
        meshes.iter().map(|m| (0..m.len()).map(|_| Vec::new()).collect()).collect();
    let mut cop: Vec<Vec<Vec<SupportedClip>>> =
        meshes.iter().map(|m| (0..m.len()).map(|_| Vec::new()).collect()).collect();
    let mut pts: Vec<Vec<Vec<ImplicitPoint>>> =
        meshes.iter().map(|m| (0..m.len()).map(|_| Vec::new()).collect()).collect();
    // intersect every unordered mesh pair (i<j); push constraints to BOTH.
    for i in 0..n {
        if super::budget::tripped() {
            break;
        }
        for j in (i + 1)..n {
            let band = super::near_band::NearBand::from_operands(meshes[i], meshes[j]);
            let pairs = super::broadphase::candidate_pairs(meshes[i], meshes[j]);
            for (ti, tj) in pairs {
                // Escalation guardrail (#1109) — see `arrange`.
                if super::budget::tripped() {
                    break;
                }
                let (ta, tb) = (&meshes[i][ti], &meshes[j][tj]);
                match tri_tri_intersection_with_band(ta, tb, &band) {
                    TriTri::Segment([s, t]) => {
                        raw[i][ti].push(RawSeg { a: s.clone(), b: t.clone(), cutter: *tb });
                        raw[j][tj].push(RawSeg { a: s, b: t, cutter: *ta });
                    }
                    TriTri::Coplanar => {
                        cop[i][ti].extend(
                            clip_supported(ta, tb),
                        );
                        cop[j][tj].extend(
                            clip_supported(tb, ta),
                        );
                    }
                    TriTri::Point(p) => {
                        // tangential touch — conformity vertex on both sides
                        pts[i][ti].push(p.clone());
                        pts[j][tj].push(p);
                    }
                    TriTri::None => {}
                }
            }
        }
    }
    // Build every carrier before propagating newly constructed exact crossings.
    let has_coplanar = cop.iter().flatten().any(|clips| !clips.is_empty());
    let mut generated = Vec::new();
    let mut cons: Vec<mixed::Built> = (0..n).map(|k| {
        mixed::build(meshes[k], &raw[k], &cop[k], &mut generated, has_coplanar)
    }).collect();
    for k in 0..n {
        mixed::propagate(meshes[k], &mut cons[k], &generated, &mut pts[k]);
    }
    let mut interner = Interner::new();
    let mut subtris = Vec::with_capacity(n);
    // Accumulate unrecovered constraints across EVERY mesh's re-triangulation
    // (mirrors the binary `arrange`, which sums over both operands). `union_all`
    // surfaces any non-zero total as its non-conformity signal, so it must not be
    // discarded here (it previously was, into a `_unrecovered`).
    let mut unrecovered = 0usize;
    for k in 0..n {
        let cop_parent: Vec<bool> = cop[k].iter().map(|c| !c.is_empty()).collect();
        // `union_all` classifies every sub-triangle against each other mesh via the
        // off-plane `solid_side` probe, so it needs no per-sub coplanar flag here.
        let (tris, _coplanar, _) =
            retriangulate_each(meshes[k], &cons[k].constraints, &pts[k], &cop_parent, &mut interner, &mut unrecovered, None);
        subtris.push(tris);
    }
    MultiArrangement { interner, subtris, unrecovered }
}

/// Re-triangulate each original triangle over the shared interner. Returns the
/// conforming sub-triangles AND a parallel `coplanar` flag (each sub-triangle
/// inherits its parent original triangle's `cop_parent[i]` — "had a coplanar
/// overlap with the other operand"). The flag drives the [`solid_side`] regime-2
/// classification in `boolean_vids` only where it can matter.
fn retriangulate_each(
    tris: &[Tri],
    cons: &[Vec<Constraint>],
    pts: &[Vec<ImplicitPoint>],
    cop_parent: &[bool],
    it: &mut Interner,
    unrecovered: &mut usize,
    parent_components: Option<&[usize]>,
) -> (Vec<[Vid; 3]>, Vec<bool>, Vec<usize>) {
    let mut out = Vec::new();
    let mut coplanar = Vec::new();
    let mut components = Vec::new();
    for (i, t) in tris.iter().enumerate() {
        // Escalation guardrail (#1109): the seam retriangulation runs exact
        // orient2d per ear and is the other heavy escalation site. Stop once the
        // budget is blown — the caller discards the partial arrangement.
        if super::budget::tripped() {
            break;
        }
        let parent_cop = cop_parent.get(i).copied().unwrap_or(false);
        let passthrough = |it: &mut Interner| {
            [
                it.intern(ImplicitPoint::Explicit(t[0])),
                it.intern(ImplicitPoint::Explicit(t[1])),
                it.intern(ImplicitPoint::Explicit(t[2])),
            ]
        };
        let before = out.len();
        let tri_pts = pts.get(i).cloned().unwrap_or_default();
        if cons[i].is_empty() && tri_pts.is_empty() {
            out.push(passthrough(it));
        } else if let Some(mesh) = triangulate(
            &RetriInput { tri: *t, constraints: cons[i].clone(), points: tri_pts },
            it,
        ) {
            *unrecovered += mesh.unrecovered;
            out.extend(mesh.tris);
        } else {
            out.push(passthrough(it)); // degenerate triangle — pass through
        }
        coplanar.resize(out.len(), parent_cop);
        if let Some(owners) = parent_components {
            components.resize(out.len(), owners[i]);
        }
        debug_assert!(coplanar.len() == out.len() && before <= out.len());
    }
    (out, coplanar, components)
}
