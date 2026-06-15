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

#[inline]
fn tri_plane(t: &Tri) -> [[f64; 3]; 3] {
    *t
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
    let s2 = orient2d_end(a1, b1, b2, axis);
    let s3 = orient2d_end(a2, b2, a1, axis);
    let s4 = orient2d_end(a2, b2, b1, axis);
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
    let mut pt_a: Vec<Vec<ImplicitPoint>> = (0..a.len()).map(|_| Vec::new()).collect();
    let mut pt_b: Vec<Vec<ImplicitPoint>> = (0..b.len()).map(|_| Vec::new()).collect();
    let pairs = super::broadphase::candidate_pairs(a, b);
    for (i, j) in pairs {
        // Deterministic escalation guardrail (#1109): stop accumulating
        // intersections once this boolean has blown its BigRational budget. The
        // partial arrangement is discarded by the caller (csg.rs checks
        // `budget::tripped()` and falls back), so an early break is safe; it just
        // bounds the wasted work to ~one more triangle pair.
        if super::budget::tripped() {
            break;
        }
        let (ta, tb) = (&a[i], &b[j]);
        match tri_tri_intersection(ta, tb) {
            TriTri::Segment([s, t]) => {
                raw_a[i].push(RawSeg { a: s.clone(), b: t.clone(), cutter: *tb });
                raw_b[j].push(RawSeg { a: s, b: t, cutter: *ta });
            }
            TriTri::Coplanar => {
                cop_a[i].extend(coplanar_clip(ta, tb).into_iter().map(|(a, b)| Constraint { a, b }));
                cop_b[j].extend(coplanar_clip(tb, ta).into_iter().map(|(a, b)| Constraint { a, b }));
            }
            TriTri::Point(p) => {
                // Tangential touch: BOTH triangles must intern the touch point
                // as a conformity vertex. The triangle on whose EDGE the point
                // lies otherwise never splits that edge, while its neighbor
                // (which sees a full crossing segment ending there) does — a
                // T-junction that opens the surface (the flush-corner-on-
                // diagonal family; see `RetriInput::points`).
                pt_a[i].push(p.clone());
                pt_b[j].push(p);
            }
            TriTri::None => {}
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
    // Per-ORIGINAL-triangle "had a coplanar overlap with the other operand" flag,
    // captured BEFORE `build` drains the coplanar-constraint accumulators.
    let cop_parent_a: Vec<bool> = cop_a.iter().map(|c| !c.is_empty()).collect();
    let cop_parent_b: Vec<bool> = cop_b.iter().map(|c| !c.is_empty()).collect();
    let ca = build(a, &raw_a, &mut cop_a);
    let cb = build(b, &raw_b, &mut cop_b);
    // 3. re-triangulate each operand over the SHARED interner ⇒ conforming surfaces
    let mut interner = Interner::new();
    let mut unrecovered = 0usize;
    let (tris_a, coplanar_a) =
        retriangulate_each(a, &ca, &pt_a, &cop_parent_a, &mut interner, &mut unrecovered);
    let (tris_b, coplanar_b) =
        retriangulate_each(b, &cb, &pt_b, &cop_parent_b, &mut interner, &mut unrecovered);
    let n_pts = interner.len();
    Arrangement {
        interner,
        tris_a,
        tris_b,
        coplanar_a,
        coplanar_b,
        unrecovered,
        f64_cache: std::cell::RefCell::new(vec![None; n_pts]),
    }
}

/// The conforming arrangement of `n` operand meshes over one shared interner.
/// `subtris[k]` is mesh `k`'s conforming sub-triangles; `owner[k][t]` is the index
/// in mesh `k`'s sub-tri list (unused externally, kept implicit by position).
pub struct MultiArrangement {
    pub interner: Interner,
    /// `subtris[k]` = mesh `k`'s conforming sub-triangles (interned Vids).
    pub subtris: Vec<Vec<[Vid; 3]>>,
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
    let n = meshes.len();
    // per-mesh, per-triangle constraint accumulators
    let mut raw: Vec<Vec<Vec<RawSeg>>> =
        meshes.iter().map(|m| (0..m.len()).map(|_| Vec::new()).collect()).collect();
    let mut cop: Vec<Vec<Vec<Constraint>>> =
        meshes.iter().map(|m| (0..m.len()).map(|_| Vec::new()).collect()).collect();
    let mut pts: Vec<Vec<Vec<ImplicitPoint>>> =
        meshes.iter().map(|m| (0..m.len()).map(|_| Vec::new()).collect()).collect();
    // intersect every unordered mesh pair (i<j); push constraints to BOTH.
    for i in 0..n {
        if super::budget::tripped() {
            break;
        }
        for j in (i + 1)..n {
            let pairs = super::broadphase::candidate_pairs(meshes[i], meshes[j]);
            for (ti, tj) in pairs {
                // Escalation guardrail (#1109) — see `arrange`.
                if super::budget::tripped() {
                    break;
                }
                let (ta, tb) = (&meshes[i][ti], &meshes[j][tj]);
                match tri_tri_intersection(ta, tb) {
                    TriTri::Segment([s, t]) => {
                        raw[i][ti].push(RawSeg { a: s.clone(), b: t.clone(), cutter: *tb });
                        raw[j][tj].push(RawSeg { a: s, b: t, cutter: *ta });
                    }
                    TriTri::Coplanar => {
                        cop[i][ti].extend(
                            coplanar_clip(ta, tb).into_iter().map(|(a, b)| Constraint { a, b }),
                        );
                        cop[j][tj].extend(
                            coplanar_clip(tb, ta).into_iter().map(|(a, b)| Constraint { a, b }),
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
    let mut interner = Interner::new();
    let mut subtris = Vec::with_capacity(n);
    for k in 0..n {
        let cop_parent: Vec<bool> = cop[k].iter().map(|c| !c.is_empty()).collect();
        let cons: Vec<Vec<Constraint>> = (0..meshes[k].len())
            .map(|t| {
                let mut c = split_crossings(&meshes[k][t], &raw[k][t]);
                c.append(&mut cop[k][t]);
                c
            })
            .collect();
        // `union_all` classifies every sub-triangle against each other mesh via the
        // off-plane `solid_side` probe, so it needs no per-sub coplanar flag here.
        let mut _unrecovered = 0usize;
        let (tris, _coplanar) =
            retriangulate_each(meshes[k], &cons, &pts[k], &cop_parent, &mut interner, &mut _unrecovered);
        subtris.push(tris);
    }
    MultiArrangement { interner, subtris }
}

/// `∪ meshes` as a watertight triangle list — the N-ary union.
///
/// Computed in ONE conforming arrangement ([`arrange_many`]), so it never re-meshes
/// an intermediate union (which is what makes left-deep pairwise accumulation tear
/// along coplanar seams shared by 3+ operands — the #960 segmented-roof cutters).
///
/// A sub-triangle of mesh `k` is on `∂(∪meshes)` iff its OUTER side (`+n`) lies
/// outside every other mesh. Identical co-oriented faces shared by several meshes
/// (e.g. duplicated cutter prisms) are kept once, owned by the LOWEST mesh index.
pub fn union_all(meshes: &[&[Tri]]) -> Vec<Tri> {
    if meshes.is_empty() {
        return Vec::new();
    }
    if meshes.len() == 1 {
        return meshes[0].to_vec();
    }
    use std::collections::HashMap;
    let arr = arrange_many(meshes);
    let exts: Vec<f64> = meshes.iter().map(|m| operand_extent(m)).collect();
    // Owner map: oriented (winding-preserving) Vid key → lowest mesh index that
    // KEEPS that face. A later mesh's identical co-oriented copy is dropped.
    let mut owner: HashMap<[Vid; 3], usize> = HashMap::new();
    // First pass: decide keep per sub-triangle (boundary of the union), recording
    // the canonical owner of each kept oriented face.
    let mut keep: Vec<Vec<bool>> = Vec::with_capacity(meshes.len());
    for (k, sub) in arr.subtris.iter().enumerate() {
        let mut kk = Vec::with_capacity(sub.len());
        for &tri in sub {
            let c = centroid_multi(&arr, tri);
            let n = tri_normal_multi(&arr, tri);
            // outer side just past the face along +n
            let outer = offset_point(c, n, exts[k]);
            // on the union boundary iff the outer side is outside ALL other meshes
            let on_boundary = (0..meshes.len())
                .filter(|&m| m != k)
                .all(|m| !point_inside(outer, meshes[m], exts[m]));
            let mut keep_this = on_boundary;
            if keep_this {
                let key = rotate_min_first(tri);
                match owner.get(&key) {
                    Some(&o) if o != k => keep_this = false, // duplicate; earlier mesh owns it
                    _ => {
                        owner.entry(key).or_insert(k);
                    }
                }
            }
            kk.push(keep_this);
        }
        keep.push(kk);
    }
    // Materialize kept sub-triangles to f64.
    let mut out = Vec::new();
    for (k, sub) in arr.subtris.iter().enumerate() {
        for (t, &tri) in sub.iter().enumerate() {
            if keep[k][t] {
                out.push([
                    point_via_interner(&arr.interner, tri[0]),
                    point_via_interner(&arr.interner, tri[1]),
                    point_via_interner(&arr.interner, tri[2]),
                ]);
            }
        }
    }
    out
}

/// Step `step·n̂` off `c` along the unit-normalised `dir`. Deterministic FMA-free
/// f64 (mirrors [`solid_side`]'s probe).
fn offset_point(c: [f64; 3], dir: [f64; 3], far_l: f64) -> [f64; 3] {
    let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    if len == 0.0 {
        return c;
    }
    let step = far_l * (1.0 / 1_048_576.0);
    [
        c[0] + dir[0] / len * step,
        c[1] + dir[1] / len * step,
        c[2] + dir[2] / len * step,
    ]
}

/// Centroid of a multi-arrangement sub-triangle (interner lookup).
fn centroid_multi(arr: &MultiArrangement, tri: [Vid; 3]) -> [f64; 3] {
    let c = [
        point_via_interner(&arr.interner, tri[0]),
        point_via_interner(&arr.interner, tri[1]),
        point_via_interner(&arr.interner, tri[2]),
    ];
    [
        (c[0][0] + c[1][0] + c[2][0]) / 3.0,
        (c[0][1] + c[1][1] + c[2][1]) / 3.0,
        (c[0][2] + c[1][2] + c[2][2]) / 3.0,
    ]
}

fn tri_normal_multi(arr: &MultiArrangement, tri: [Vid; 3]) -> [f64; 3] {
    let (a, b, c) = (
        point_via_interner(&arr.interner, tri[0]),
        point_via_interner(&arr.interner, tri[1]),
        point_via_interner(&arr.interner, tri[2]),
    );
    cross3(sub_f64(b, a), sub_f64(c, a))
}

#[inline]
fn point_via_interner(it: &Interner, v: Vid) -> [f64; 3] {
    let pt = it.get(v);
    if let Some(f) = super::fixed::point_to_f64(pt) {
        return f;
    }
    let p = point_of(pt);
    [p[0].to_f64().unwrap(), p[1].to_f64().unwrap(), p[2].to_f64().unwrap()]
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
) -> (Vec<[Vid; 3]>, Vec<bool>) {
    let mut out = Vec::new();
    let mut coplanar = Vec::new();
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
        debug_assert!(coplanar.len() == out.len() && before <= out.len());
    }
    (out, coplanar)
}

// --- winding classification + boolean extraction --------------------------

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

/// Ray-cast "far" distance: just past the operand's actual extent. Critically NOT
/// a huge constant (1e7) — that blows the orient3d float-filter error bound so
/// EVERY predicate escalates to BigRational (≈5000× slower). Sized to the operand,
/// the float filter resolves the common case and only true grazing escalates.
fn operand_extent(tris: &[Tri]) -> f64 {
    let mut hi = 1.0f64;
    for t in tris {
        for v in t {
            for &c in v {
                hi = hi.max(c.abs());
            }
        }
    }
    2.0 * hi + 1.0
}

/// The fixed generic ray direction for parity casts. No two components
/// near-equal and no pairwise ratio near a simple architectural slope (1:1
/// roofs, axis planes). The previous direction had x≈y and dz/dx≈1 — nearly
/// PARALLEL to 45° roof slopes/ridge edges, so a roof-clipped wall's ray grazed
/// the roof and edge-crossings (rejected, not counted) miscounted parity → the
/// sub-ridge gable triangle was wrongly judged inside the cutter and removed
/// (the "missing wall" over-clip). Shared by [`point_inside`] and the
/// per-component AABB ray prefilter so they can never disagree.
fn ray_dir() -> [f64; 3] {
    [0.301_511_3, 0.557_328_1, 0.773_890_1]
}

/// Is point `p` inside the closed mesh `tris`? Exact ray-cast parity to a far
/// point (`far_l` past the extent) along a fixed generic direction; each crossing
/// tested by the exact predicate above.
fn point_inside(p: [f64; 3], tris: &[Tri], far_l: f64) -> bool {
    let dir = ray_dir();
    let far = [p[0] + dir[0] * far_l, p[1] + dir[1] * far_l, p[2] + dir[2] * far_l];
    tris.iter().filter(|t| exact_seg_hits_tri(p, far, t)).count() % 2 == 1
}

/// BVH-accelerated [`point_inside`]: the `bvh` (built over `tris`) prunes the ray
/// to the triangles whose AABB it may cross, and the EXACT crossing test runs only
/// on those. The BVH candidate set is a conservative superset of the exact hits,
/// so the crossing-parity — hence the inside/outside verdict — is byte-identical
/// to the linear scan (the pinned boolean determinism manifests are unperturbed).
/// O(N) → O(log N + hits) per query, the win on host operands with many triangles.
fn point_inside_bvh(
    p: [f64; 3],
    tris: &[Tri],
    bvh: &super::broadphase::Bvh,
    far_l: f64,
    scratch: &mut Vec<u32>,
) -> bool {
    let dir = ray_dir();
    let far = [p[0] + dir[0] * far_l, p[1] + dir[1] * far_l, p[2] + dir[2] * far_l];
    scratch.clear();
    bvh.ray_candidates(p, far, scratch);
    scratch
        .iter()
        .filter(|&&i| exact_seg_hits_tri(p, far, &tris[i as usize]))
        .count()
        % 2
        == 1
}

fn to_f64_pt(arr: &Arrangement, v: Vid) -> [f64; 3] {
    let idx = v as usize;
    if let Some(slot) = arr.f64_cache.borrow().get(idx).copied() {
        if let Some(p) = slot {
            return p;
        }
    }
    let pt = arr.interner.get(v);
    // Reuse the interner's already-cached I512 lambda (computed once at intern time)
    // rather than re-deriving it at I1024 in `point_to_f64`; fall to the from-scratch
    // fixed-width path on a cache miss (overflow), then to exact BigRational `point_of`
    // for off-grid points. All three yield the identical f64.
    let p = arr
        .interner
        .lam(v)
        .as_ref()
        .and_then(super::fixed::point_to_f64_from_lam)
        .or_else(|| super::fixed::point_to_f64(pt))
        .unwrap_or_else(|| {
            let q = point_of(pt);
            [q[0].to_f64().unwrap(), q[1].to_f64().unwrap(), q[2].to_f64().unwrap()]
        });
    if let Some(slot) = arr.f64_cache.borrow_mut().get_mut(idx) {
        *slot = Some(p);
    }
    p
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
/// Exact in-plane containment: with `n` the un-normalised face normal of `t`, is
/// `c` strictly inside `t`'s outline projected onto the dropped axis? Shared by the
/// exact and near coplanar-surface tests; false for a degenerate projected `t`.
fn point_in_tri_proj(c: [f64; 3], t: &Tri, n: [f64; 3]) -> bool {
    let axis = drop_axis_of(n);
    let w0 = orient2d_any(&e(t[0]), &e(t[1]), &e(t[2]), axis);
    if w0 == Sign::Zero {
        return false; // degenerate t in projection
    }
    let inside = |u: [f64; 3], v: [f64; 3]| orient2d_any(&e(u), &e(v), &e(c), axis) != w0.flip();
    inside(t[0], t[1]) && inside(t[1], t[2]) && inside(t[2], t[0])
}

/// Per-triangle exact coincident-face test (see [`on_surface_normal`]).
fn on_surface_tri(c: [f64; 3], t: &Tri) -> Option<[f64; 3]> {
    if orient3d(&e(t[0]), &e(t[1]), &e(t[2]), &e(c)) != Sign::Zero {
        return None; // c not on t's plane
    }
    let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
    point_in_tri_proj(c, t, n).then_some(n)
}

/// Per-triangle near-coplanar-flush test (see [`near_on_surface_normal`]); `band2`
/// is the squared perpendicular plane-gap tolerance.
fn near_on_surface_tri(c: [f64; 3], t: &Tri, band2: f64) -> Option<[f64; 3]> {
    let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
    let nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
    if nn <= 0.0 || !nn.is_finite() {
        return None; // degenerate t
    }
    let d = dot3(sub_f64(c, t[0]), n);
    if (d * d) / nn > band2 {
        return None; // c not within the snap band of t's plane
    }
    point_in_tri_proj(c, t, n).then_some(n)
}

/// The near-coplanar perpendicular band (see [`near_on_surface_normal`]) from the
/// operand+`c` coordinate magnitude `extent`.
fn near_band_from_extent(extent: f64) -> f64 {
    (8.0 * SNAP_GRID).max(extent * (1.0 / 4_194_304.0))
}

fn on_surface_normal(c: [f64; 3], others: &[Tri]) -> Option<[f64; 3]> {
    others.iter().find_map(|t| on_surface_tri(c, t))
}

/// Power-of-two grid `mesh_bridge` snaps both operands to (metres); the
/// `near_on_surface_normal` band below is sized to the scatter this snap
/// leaves on a TILTED flush face.
use super::mesh_bridge::SNAP_GRID;

/// The NEAR-coplanar analogue of [`on_surface_normal`], used ONLY for a
/// sub-triangle whose parent face had a near-coplanar overlap with the other
/// operand (`coplanar_a/b[i]` set). Returns the covering `other` face's f64 normal
/// when `c` sits within the snap-scatter band of that face's plane AND projects
/// strictly inside it.
///
/// WHY this exists — the flush-cap defect (#1007 host #1112 openings #2150/#2154):
/// real IFC is f32, so an opening cap authored EXACTLY flush with a TILTED roof
/// surface is NOT exactly coplanar after `mesh_bridge`'s per-axis snap — each
/// operand scatters up to `SNAP_GRID·√3` off the shared tilted plane. The exact
/// [`on_surface_normal`] needs `orient3d == 0` (centroid bit-exactly on the other
/// face's plane), so it MISSES the flush cap; the sub-triangle then falls to the
/// fragile `solid_side` probe (regime 2) or the on-boundary centroid ray-cast
/// (regime 3), both undefined at a µm-flush interface ⇒ the inside-footprint host
/// sub-triangle is wrongly KEPT and bridges the opening.
///
/// DETERMINISM: the only inexactness vs. [`on_surface_normal`] is the perpendicular
/// plane-gap admitted (the `band` test); the in-plane containment still uses the
/// EXACT `orient2d_any`. `band` is an absolute power-of-two multiple of `SNAP_GRID`
/// (≈ the 2-operand scatter envelope) widened only for far-from-origin operands
/// (coarser f32 import) — always THREE orders below the smallest real feature edge
/// (~0.2 m), so a genuinely-distinct parallel face (a thin slab's two surfaces)
/// can never be within it. All FMA-free f64 over input coords ⇒ byte-identical
/// native==wasm. GATED on the near-coplanar-parent flag, so a transversal cut
/// (every pinned box−box manifest face) never reaches it.
fn near_on_surface_normal(c: [f64; 3], others: &[Tri]) -> Option<[f64; 3]> {
    let mut extent = 1.0f64;
    for &x in &c {
        extent = extent.max(x.abs());
    }
    for t in others {
        for v in t {
            for &x in v {
                extent = extent.max(x.abs());
            }
        }
    }
    let band2 = near_band_from_extent(extent).powi(2);
    others.iter().find_map(|t| near_on_surface_tri(c, t, band2))
}

/// BVH-accelerated equivalent of `on_surface_normal(c, a).is_some() ||
/// near_on_surface_normal(c, a).is_some()` — does ANY triangle of `a` carry `c` on
/// its face (exactly or within the snap band)? `a_coord_extent` is the max |coord|
/// over `a` (hoisted once per arrangement, since only `c` varies per call). The
/// query radius is the band, so candidates are a conservative superset and the
/// exact per-triangle predicates decide; the result is `any`, so it is independent
/// of candidate order and byte-identical to the linear scan.
fn c_on_or_near_a(
    c: [f64; 3],
    a: &[Tri],
    bvh: &super::broadphase::Bvh,
    a_coord_extent: f64,
    scratch: &mut Vec<u32>,
) -> bool {
    let extent = c.iter().fold(a_coord_extent, |m, &x| m.max(x.abs()));
    let band = near_band_from_extent(extent);
    let band2 = band * band;
    scratch.clear();
    bvh.point_candidates(c, band, scratch);
    scratch.iter().any(|&i| {
        let t = &a[i as usize];
        on_surface_tri(c, t).is_some() || near_on_surface_tri(c, t, band2).is_some()
    })
}

/// Is the OTHER operand's solid present just off `c` along `±dir`?
///
/// `c` is a sub-triangle centroid that may lie EXACTLY on a shared interface plane
/// where the on-plane ray-cast is undefined. We probe an infinitesimal step to
/// EACH side along the (unit-ish) face normal `dir` and ray-cast each probe point
/// — the probe points are strictly off the plane, so the parity test is
/// well-defined. Returns `(in_plus, in_minus)` = solid present on the `+dir` /
/// `−dir` side.
///
/// DETERMINISM: every operation here is FMA-free f64 over input coordinates, and
/// the ray-cast uses the all-`Explicit` `geometry_predicates::orient3d` path (no
/// implicit points, no BigRational escalation, const float error bounds) — so the
/// keep/drop verdict is byte-identical native==wasm, exactly like the existing
/// on-plane centroid classification.
fn solid_side(c: [f64; 3], dir: [f64; 3], other: &[Tri], far_l: f64) -> (bool, bool) {
    // Unit-normalise `dir` so the step magnitude is plane-independent, then step a
    // small fraction of the operand extent off the plane — far enough that the
    // float predicate resolves the probe vs. the plane, near enough that no other
    // feature is crossed.
    let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    if len == 0.0 {
        return (false, false);
    }
    // far_l = 2*extent + 1; a step of far_l * 2^-20 ≈ extent * 2^-19 is ~µm at
    // building scale — well inside a face yet resolvable by orient3d.
    let step = far_l * (1.0 / 1_048_576.0);
    let u = [dir[0] / len * step, dir[1] / len * step, dir[2] / len * step];
    let p_plus = [c[0] + u[0], c[1] + u[1], c[2] + u[2]];
    let p_minus = [c[0] - u[0], c[1] - u[1], c[2] - u[2]];
    (point_inside(p_plus, other, far_l), point_inside(p_minus, other, far_l))
}

/// The B operand as PAIRWISE-DISJOINT closed components (disjoint-cutter
/// batching). The binary boolean is the 1-component special case. Classification
/// against the union of disjoint closed solids decomposes per component —
/// "inside the union" ⇔ "inside exactly one component" — which (a) caps the ray
/// parity scan at the component the ray can actually reach (the per-component
/// AABB prefilter removes the O(|subA|·Σ|B_k|) blowup of a soup-wide cast), and
/// (b) structurally eliminates cross-component graze-parity fragility (a graze
/// on a FAR component can no longer flip the verdict for a near one).
struct BComponents<'a> {
    comps: &'a [&'a [Tri]],
    /// Per-component AABB, inflated by `pad` (conservative for both the ray
    /// prefilter and the coincident-face band test).
    aabbs: Vec<([f64; 3], [f64; 3])>,
    /// Per-component ray-cast far length (`operand_extent`), exactly as the
    /// binary path computes it for its single operand.
    exts: Vec<f64>,
}

impl<'a> BComponents<'a> {
    fn new(comps: &'a [&'a [Tri]]) -> Self {
        let exts: Vec<f64> = comps.iter().map(|c| operand_extent(c)).collect();
        // Inflation: ≥ 2× the near-coplanar band envelope (`8·SNAP_GRID`,
        // widened far from origin), so a centroid within the coincident-face
        // band of a component face is always inside that component's inflated
        // AABB; also dwarfs any f64 rounding in the slab test. Deterministic
        // FMA-free f64.
        let max_ext = exts.iter().cloned().fold(1.0f64, f64::max);
        let pad = 4.0 * (8.0 * SNAP_GRID).max(max_ext * (1.0 / 4_194_304.0));
        let aabbs = comps
            .iter()
            .map(|c| {
                let mut lo = [f64::MAX; 3];
                let mut hi = [f64::MIN; 3];
                for t in c.iter() {
                    for v in t {
                        for k in 0..3 {
                            lo[k] = lo[k].min(v[k]);
                            hi[k] = hi[k].max(v[k]);
                        }
                    }
                }
                for k in 0..3 {
                    lo[k] -= pad;
                    hi[k] += pad;
                }
                (lo, hi)
            })
            .collect();
        Self { comps, aabbs, exts }
    }

    /// Conservative "could the parity segment from `p` hit component `k`?" —
    /// a slab test of `[p, p + dir·ext_k]` against the inflated AABB. Sound:
    /// the component's triangles lie inside the (un-inflated) AABB, so a
    /// segment that misses the inflated AABB has parity 0 there.
    fn ray_may_hit(&self, k: usize, p: [f64; 3]) -> bool {
        let dir = ray_dir();
        let far_l = self.exts[k];
        let q = [p[0] + dir[0] * far_l, p[1] + dir[1] * far_l, p[2] + dir[2] * far_l];
        let (lo, hi) = (&self.aabbs[k].0, &self.aabbs[k].1);
        let (mut t0, mut t1) = (0.0f64, 1.0f64);
        for i in 0..3 {
            let d = q[i] - p[i];
            if d == 0.0 {
                if p[i] < lo[i] || p[i] > hi[i] {
                    return false;
                }
                continue;
            }
            let (a, b) = ((lo[i] - p[i]) / d, (hi[i] - p[i]) / d);
            let (a, b) = if a <= b { (a, b) } else { (b, a) };
            t0 = t0.max(a);
            t1 = t1.min(b);
            if t0 > t1 {
                return false;
            }
        }
        true
    }

    #[inline]
    fn point_in_aabb(&self, k: usize, p: [f64; 3]) -> bool {
        let (lo, hi) = (&self.aabbs[k].0, &self.aabbs[k].1);
        (0..3).all(|i| p[i] >= lo[i] && p[i] <= hi[i])
    }

    /// Is `p` inside the union of the components? (Pairwise-disjoint closed
    /// solids ⇒ inside exactly one ⇒ a per-component exact ray parity, each
    /// prefiltered by its AABB.)
    fn inside(&self, p: [f64; 3]) -> bool {
        self.comps
            .iter()
            .enumerate()
            .any(|(k, comp)| self.ray_may_hit(k, p) && point_inside(p, comp, self.exts[k]))
    }

    /// Regime-1 coincident-face probe across the components: the EXACT
    /// [`on_surface_normal`] on every AABB-near component first, then the
    /// snap-band [`near_on_surface_normal`] analogue (same priority order as
    /// the binary path). Disjointness makes at most one component eligible.
    fn surface_normal(&self, c: [f64; 3]) -> Option<[f64; 3]> {
        for (k, comp) in self.comps.iter().enumerate() {
            if self.point_in_aabb(k, c) {
                if let Some(n) = on_surface_normal(c, comp) {
                    return Some(n);
                }
            }
        }
        for (k, comp) in self.comps.iter().enumerate() {
            if self.point_in_aabb(k, c) {
                if let Some(n) = near_on_surface_normal(c, comp) {
                    return Some(n);
                }
            }
        }
        None
    }

    /// Multi-component [`solid_side`]: probe an infinitesimal step to each side
    /// of the face along `dir` and test the union-inside on each probe. The
    /// step is sized to the LARGEST component extent (== the binary behavior
    /// for one component).
    fn solid_side(&self, c: [f64; 3], dir: [f64; 3]) -> (bool, bool) {
        let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
        if len == 0.0 {
            return (false, false);
        }
        let max_ext = self.exts.iter().cloned().fold(1.0f64, f64::max);
        let step = max_ext * (1.0 / 1_048_576.0);
        let u = [dir[0] / len * step, dir[1] / len * step, dir[2] / len * step];
        let p_plus = [c[0] + u[0], c[1] + u[1], c[2] + u[2]];
        let p_minus = [c[0] - u[0], c[1] - u[1], c[2] - u[2]];
        (self.inside(p_plus), self.inside(p_minus))
    }
}

/// Regime-2 classifier (see [`boolean_vids`]): a sub-triangle whose centroid `c`
/// lies on the OTHER solid's boundary surface — without a COINCIDENT face there
/// (regime 1 already handled that), so the on-plane centroid ray-cast is undefined.
///
/// Applies ONLY when the other solid's boundary actually passes through `c` —
/// detected by [`solid_side`] reporting DIFFERENT inside/outside verdicts on the
/// two sides of the face (`op_plus != op_minus`). That is exactly the degenerate
/// case the plain ray-cast can't resolve (the #960 seam end-region: the other
/// solid abuts via a NON-coplanar face, so its solid is present on one side of
/// this coplanar sub-triangle but it has no coincident face there). When the two
/// sides AGREE, `c` is strictly inside or outside the other solid → the plain
/// ray-cast is reliable → return `None` so the caller uses it (preserving every
/// existing in/out classification, incl. the pinned box−box manifests).
///
/// `c` is on the boundary, so the other solid occupies exactly one side. With the
/// outward normal `n` (own-solid on `−n`):
/// * Union — keep iff the other solid is NOT outside (`!op_plus`): an interface
///   with the other solid on the `+n` side is interior to `A∪B` → drop.
/// * Intersection — keep iff the other solid is on the inner side: `op_minus`.
/// * Difference — keep iff the other solid is NOT on the inner side: `!op_minus`.
fn on_interface_keep(
    arr: &Arrangement,
    tri: [Vid; 3],
    c: [f64; 3],
    other: &[Tri],
    ext_other: f64,
    op: BoolOp,
    _a_side: bool,
) -> Option<bool> {
    let n = tri_normal(arr, tri);
    let (op_plus, op_minus) = solid_side(c, n, other, ext_other);
    if op_plus == op_minus {
        // `c` is strictly inside/outside the other solid — NOT on its boundary;
        // the plain centroid ray-cast is well-defined, so defer to it. This is the
        // common case for every non-coplanar sub-triangle (incl. the pinned
        // box−box cut faces), so regime 2 perturbs nothing there.
        return None;
    }
    Some(match op {
        BoolOp::Union => !op_plus,
        BoolOp::Intersection => op_minus,
        BoolOp::Difference => !op_minus,
    })
}

/// The boolean result as ORIENTED Vid triangles.
///
/// A sub-triangle's centroid is classified against the OTHER operand in one of
/// three regimes:
/// 1. **On a coincident SHARED face** (`on_surface_normal` finds a covering,
///    coplanar triangle of the other operand): classify by NORMAL AGREEMENT —
///    keep the A-copy for a co-oriented face on a union/intersection, or an
///    opposite face on a difference; drop the B-copy (dedup). This is the
///    original exact handling and is unchanged.
/// 2. **On a shared INTERFACE plane WITHOUT a coincident face** (the segmented-
///    roof seam end-regions, #960 — the other solid abuts via a NON-coplanar
///    face, so regime 1 misses it and the on-plane ray-cast is undefined):
///    classify by the other solid's presence on the `−n` (inner) side, probed an
///    infinitesimal step off the plane ([`solid_side`]). This is the fix: such a
///    sub-triangle is an interior interface for union (drop) but was previously
///    mis-routed to the undefined ray-cast and wrongly kept.
/// 3. **Strictly off any shared plane**: the exact centroid ray-cast, as before.
///
/// For union/intersection, a co-oriented DUPLICATE face (same patch, same winding
/// — e.g. unioning identical/overlapping coplanar solids) survives regime 1's
/// keep test on BOTH operands; because the arrangement conforms over one interner
/// it is the SAME oriented Vid triangle on both, so the B-copy is dropped when its
/// rotation-canonical key already appears among the kept A-copies. (A back-to-back
/// interface shares the unordered vertex set but has OPPOSITE winding, so it never
/// collides; both its copies are dissolved by regime 2.)
fn boolean_vids(arr: &Arrangement, a: &[Tri], b: &[Tri], op: BoolOp) -> Vec<[Vid; 3]> {
    boolean_vids_components(arr, a, &BComponents::new(&[b]), op)
}

/// [`boolean_vids`] with the B operand as pairwise-disjoint closed components
/// (see [`BComponents`]). For a single component this is verdict-identical to
/// the historical binary classifier — the AABB gates are pure prefilters — so
/// the pinned boolean manifest is unperturbed.
fn boolean_vids_components(
    arr: &Arrangement,
    a: &[Tri],
    bc: &BComponents,
    op: BoolOp,
) -> Vec<[Vid; 3]> {
    use std::collections::HashSet;
    let ext_a = operand_extent(a);
    // One BVH over operand A, reused for every B-face inside/outside ray-cast AND
    // coincident/near-surface probe below (the dominant O(|tris_b|·|a|) scans on
    // boolean-heavy meshes). `a_coord_extent` (hoisted) feeds the near-surface band.
    let bvh_a = super::broadphase::Bvh::build(a);
    let a_coord_extent = a
        .iter()
        .flat_map(|t| t.iter())
        .flat_map(|v| v.iter())
        .fold(1.0f64, |m, &x| m.max(x.abs()));
    let mut scratch: Vec<u32> = Vec::new();
    let dedup = matches!(op, BoolOp::Union | BoolOp::Intersection);
    let mut a_kept: HashSet<[Vid; 3]> = HashSet::new();
    let mut out = Vec::new();
    for (i, &tri) in arr.tris_a.iter().enumerate() {
        let c = centroid(arr, tri);
        let cop_parent = arr.coplanar_a.get(i).copied().unwrap_or(false);
        let keep;
        // regime 1: coincident shared face → classify by normal agreement. Tried
        // EXACT first, then the snap-band-flush analogue (`near_on_surface_normal`)
        // which catches a face left a few µm off a TILTED shared plane by per-axis
        // import snapping (the #1007 flush roof-opening cap). The near test is
        // ungated (like the exact one) because a coincident-shared-face DROP/keep is
        // unconditionally correct, and its centroid-inside + µm-perp requirements
        // never match a transversal cut face (every pinned box−box manifest face).
        if let Some(n_other) = bc.surface_normal(c) {
            let co_oriented = dot3(tri_normal(arr, tri), n_other) > 0.0;
            keep = match op {
                BoolOp::Union | BoolOp::Intersection => co_oriented,
                BoolOp::Difference => !co_oriented,
            };
        } else if let Some(k) = cop_parent
            .then(|| {
                // regime 2 (only on coplanar-overlap parents): shared interface
                // plane, no coincident face → solid-side probe (see
                // `on_interface_keep` for the keep table rationale).
                let n = tri_normal(arr, tri);
                let (op_plus, op_minus) = bc.solid_side(c, n);
                if op_plus == op_minus {
                    return None; // strictly in/out — the plain ray-cast decides
                }
                Some(match op {
                    BoolOp::Union => !op_plus,
                    BoolOp::Intersection => op_minus,
                    BoolOp::Difference => !op_minus,
                })
            })
            .flatten()
        {
            keep = k;
        } else {
            // regime 3: strictly off-plane → centroid ray-cast (original)
            let inside_b = bc.inside(c);
            keep = match op {
                BoolOp::Intersection => inside_b,
                _ => !inside_b,
            };
        }
        if keep {
            if dedup {
                a_kept.insert(rotate_min_first(tri));
            }
            out.push(tri);
        }
    }
    for (i, &tri) in arr.tris_b.iter().enumerate() {
        // dedup a true co-oriented duplicate of a kept A face (keep the A-copy)
        if dedup && a_kept.contains(&rotate_min_first(tri)) {
            continue;
        }
        let c = centroid(arr, tri);
        let cop_parent = arr.coplanar_b.get(i).copied().unwrap_or(false);
        // A coincident-shared B face is dropped (the A-copy is the kept one). Tried
        // EXACT first, then the snap-band-flush analogue — ungated, because a B cap
        // fully CONTAINED in a larger host face has NO coplanar constraint of its
        // own (the host imposes none on it) so `coplanar_b` is unset for it, yet it
        // is still a coincident shared face that must drop (the #1007 flush roof cap
        // — without the near drop here it survives and bridges the opening).
        if c_on_or_near_a(c, a, &bvh_a, a_coord_extent, &mut scratch) {
            continue; // coplanar-shared B-copy: dropped (the A-copy is the kept one)
        }
        if cop_parent {
            if let Some(keep) = on_interface_keep(arr, tri, c, a, ext_a, op, false) {
                // regime 2 for B (coplanar-overlap parent only).
                if keep {
                    let flip = matches!(op, BoolOp::Difference);
                    out.push(if flip { [tri[0], tri[2], tri[1]] } else { tri });
                }
                continue;
            }
        }
        let inside_a = point_inside_bvh(c, a, &bvh_a, ext_a, &mut scratch);
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
    let vids = boolean_vids(&arr, a, b, op);
    vids.into_iter()
        .map(|t| [to_f64_pt(&arr, t[0]), to_f64_pt(&arr, t[1]), to_f64_pt(&arr, t[2])])
        .collect()
}

/// `a − (∪ comps)` for PAIRWISE-DISJOINT, per-component-closed, OUTWARD-wound
/// cutter components, computed in ONE conforming arrangement (disjoint-cutter
/// batching).
///
/// Soundness: `arrange` only intersects A×B pairs, and disjoint B components
/// have no B×B intersections to miss; classification decomposes per component
/// (`BComponents`). The #2176 lesson is a PRECONDITION here: every component
/// must be closed and outward-wound on its own — the caller (`mesh_bridge::
/// subtract_many`) orients each component before concatenation, and the router
/// only admits per-component-watertight cutters to a batch.
///
/// vs. sequential per-cutter subtraction this avoids re-arranging the (growing)
/// host once per cutter — each intermediate round-trip through f32 + the snap
/// grid re-jitters carve vertices off shared planes, so cut N+1 re-cracks what
/// cut N reconciled (many-void walls' compounding open edges) — and is
/// ~N× cheaper on N box cutters.
pub fn difference_all(a: &[Tri], comps: &[&[Tri]]) -> Option<Vec<Tri>> {
    if comps.is_empty() {
        return Some(a.to_vec());
    }
    let b_all: Vec<Tri> = comps.iter().flat_map(|c| c.iter().copied()).collect();
    let arr = arrange(a, &b_all);
    // Hard conformity gate (unlike the binary `boolean`'s graceful degrade):
    // an unrecovered constraint means some sub-triangle STRADDLES a cutter
    // boundary and its centroid classification can silently over/under-cut
    // (the #559171 batched-door family: the jamb never carved into the back
    // face ⇒ −0.43 m³ and an open rim). The caller falls back to sequential
    // per-cutter subtraction, which carves few constraints per arrangement and
    // avoids the degenerate channel.
    if arr.unrecovered > 0 {
        return None;
    }
    let bc = BComponents::new(comps);
    let vids = boolean_vids_components(&arr, a, &bc, BoolOp::Difference);
    Some(
        vids.into_iter()
            .map(|t| [to_f64_pt(&arr, t[0]), to_f64_pt(&arr, t[1]), to_f64_pt(&arr, t[2])])
            .collect(),
    )
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

    /// 552611 regression — coplanar host face × cutter face complex where one
    /// cutter corner's entire triangulation fan is swallowed by a constraint
    /// channel: the tiny middle-quad diagonal (5.027,3.800)→(5.142,3.5) crosses
    /// every fan spoke of the adjacent through-rectangle corner (5.142,3.800),
    /// and `recover_subsegment`'s pocket rebuild used to DESTROY that vertex
    /// (and every constraint edge through it). The host sub-triangulation then
    /// overlapped the cutter footprint and the difference over-cut the wall 4×
    /// (advanced_model wall #552611 / opening #552651). The conforming
    /// arrangement must keep every cutter corner as a host vertex.
    #[test]
    fn coplanar_channel_swallowed_corner_survives_552611() {
        let x = 7.7642822265625;
        let host: Vec<Tri> = vec![
            [[x, 7.7840423583984375, 0.09417724609375], [x, -0.6199951171875, 0.09417724609375], [x, -0.6199951171875, 10.600006103515625]],
            [[x, 7.7840423583984375, 0.09417724609375], [x, -0.6199951171875, 10.600006103515625], [x, 7.7840423583984375, 10.600006103515625]],
        ];
        let cutter: Vec<Tri> = vec![
            [[x, -0.160003662109375, 3.8000030517578125], [x, 5.02655029296875, 3.8000030517578125], [x, 5.02655029296875, 3.5]],
            [[x, -0.160003662109375, 3.8000030517578125], [x, 5.02655029296875, 3.5], [x, -0.160003662109375, 3.5]],
            [[x, 5.02655029296875, 3.8000030517578125], [x, 5.14154052734375, 3.8000030517578125], [x, 5.14154052734375, 3.5]],
            [[x, 5.02655029296875, 3.8000030517578125], [x, 5.14154052734375, 3.5], [x, 5.02655029296875, 3.5]],
            [[x, 5.14154052734375, 3.8000030517578125], [x, 7.7840423583984375, 3.8000030517578125], [x, 7.7840423583984375, 3.5]],
            [[x, 5.14154052734375, 3.8000030517578125], [x, 7.7840423583984375, 3.5], [x, 5.14154052734375, 3.5]],
        ];
        let arr = arrange(&host, &cutter);
        // Every cutter corner must be a vertex of the host's conforming
        // sub-triangulation (they all lie strictly inside / on the host face).
        for ct in &cutter {
            for corner in ct {
                let found = arr.tris_a.iter().flatten().any(|&v| {
                    let p = to_f64_pt(&arr, v);
                    p[1] == corner[1] && p[2] == corner[2]
                });
                assert!(
                    found,
                    "cutter corner ({}, {}) lost from the host conforming triangulation",
                    corner[1], corner[2]
                );
            }
        }
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
        // A entirely inside B — no surface intersection, so this exercises the
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

    /// Edge-use audit on a materialised f64 triangle list: returns
    /// `(boundary, nonmanifold)` = count of undirected edges used exactly ONCE
    /// (an open boundary) and MORE THAN twice (a non-manifold fin). Both zero ⇒
    /// the surface is closed and 2-manifold. Vertices are keyed on the snap grid.
    fn edge_audit(tris: &[Tri]) -> (usize, usize) {
        use std::collections::BTreeMap;
        let key = |p: [f64; 3]| {
            (
                (p[0] * 65536.0).round() as i64,
                (p[1] * 65536.0).round() as i64,
                (p[2] * 65536.0).round() as i64,
            )
        };
        let mut edges: BTreeMap<((i64, i64, i64), (i64, i64, i64)), u32> = BTreeMap::new();
        for t in tris {
            let k = [key(t[0]), key(t[1]), key(t[2])];
            for (u, v) in [(k[0], k[1]), (k[1], k[2]), (k[2], k[0])] {
                *edges.entry(if u < v { (u, v) } else { (v, u) }).or_insert(0) += 1;
            }
        }
        (
            edges.values().filter(|&&c| c == 1).count(),
            edges.values().filter(|&&c| c > 2).count(),
        )
    }

    fn bounds(tris: &[Tri]) -> ([f64; 3], [f64; 3]) {
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
        (lo, hi)
    }

    #[test]
    fn abutting_boxes_union_is_watertight_combined_hull() {
        // The MINIMAL coplanar-union repro (the #960 root cause, distilled): two
        // unit boxes sharing the x=1 face union to ONE watertight 1×1×2 hull —
        // every edge shared by exactly two faces, no open boundary, bounds span
        // BOTH boxes. Pure geometry ⇒ must always pass.
        let a = box_mesh([0., 0., 0.], [1., 1., 1.]);
        let b = box_mesh([1., 0., 0.], [2., 1., 1.]);
        let u = boolean(&a, &b, BoolOp::Union);
        let (boundary, nonmanifold) = edge_audit(&u);
        assert_eq!(boundary, 0, "abutting-boxes union has {boundary} open boundary edges (torn)");
        assert_eq!(nonmanifold, 0, "abutting-boxes union has {nonmanifold} non-manifold edges (the shared x=1 face was not dissolved)");
        let (lo, hi) = bounds(&u);
        assert_eq!(lo, [0., 0., 0.], "union lower bound should span both boxes");
        assert_eq!(hi, [2., 1., 1.], "union upper bound should span both boxes");
    }

    #[test]
    fn partial_coplanar_seam_union_is_watertight() {
        // Two boxes sharing the x=1 plane but with only PARTIAL face overlap in Y
        // (A: y∈[0,2], B: y∈[1,3]); each box's x=1 face extends past the shared
        // band. This is the #960 seam END-REGION case: the seam face of one box
        // reaches where the other has NO coincident face (its solid abuts via a
        // perpendicular wall). The end-region must still dissolve, not tear.
        let a = box_mesh([0., 0., 0.], [1., 2., 1.]);
        let b = box_mesh([1., 1., 0.], [2., 3., 1.]);
        let u = boolean(&a, &b, BoolOp::Union);
        let (boundary, nonmanifold) = edge_audit(&u);
        assert_eq!(boundary, 0, "partial-seam union has {boundary} open boundary edges");
        assert_eq!(nonmanifold, 0, "partial-seam union has {nonmanifold} non-manifold edges");
    }

    #[test]
    fn identical_solids_union_is_the_single_solid() {
        // Union of a box with an exact COPY of itself = that box (every face is a
        // co-oriented coincident duplicate; exactly one copy survives). The
        // sloped/rotated variant is the case the narrow coincident-face dedup
        // missed before the Vid-key dedup.
        let a = box_mesh([0., 0., 0.], [2., 2., 2.]);
        let u = boolean(&a, &a, BoolOp::Union);
        let (boundary, nonmanifold) = edge_audit(&u);
        assert_eq!((boundary, nonmanifold), (0, 0), "self-union is not watertight: b={boundary} nm={nonmanifold}");
        assert_eq!(u.len(), 12, "self-union should be the single 12-triangle box, got {}", u.len());
    }

    #[test]
    fn nary_union_of_abutting_and_duplicate_prisms_is_watertight() {
        // The #960 cutter-union shape (distilled to axis-aligned): a strip of
        // three abutting unit boxes PLUS an exact duplicate of the middle one —
        // unioned in ONE conforming arrangement (`union_all`), never re-meshing an
        // intermediate. Result = the 3×1×1 strip, watertight, duplicate dissolved.
        let b0 = box_mesh([0., 0., 0.], [1., 1., 1.]);
        let b1 = box_mesh([1., 0., 0.], [2., 1., 1.]);
        let b2 = box_mesh([2., 0., 0.], [3., 1., 1.]);
        let b1_dup = b1.clone();
        let meshes: Vec<&[Tri]> = vec![&b0, &b1, &b2, &b1_dup];
        let u = super::union_all(&meshes);
        let (boundary, nonmanifold) = edge_audit(&u);
        assert_eq!(boundary, 0, "N-ary union has {boundary} open boundary edges");
        assert_eq!(nonmanifold, 0, "N-ary union has {nonmanifold} non-manifold edges");
        let (lo, hi) = bounds(&u);
        assert_eq!((lo, hi), ([0., 0., 0.], [3., 1., 1.]), "N-ary union bounds wrong");
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
