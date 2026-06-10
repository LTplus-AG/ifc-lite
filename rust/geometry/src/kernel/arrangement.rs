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
    /// Per-sub-triangle (parallel to `tris_a`) flag: this sub-triangle's PARENT
    /// face had a COPLANAR overlap with the other operand — so a sub-triangle on
    /// it may lie on a shared interface plane and needs the [`solid_side`] regime-2
    /// classification (`boolean_vids`). `false` ⇒ the parent face is transversal to
    /// the other operand, so the plain centroid ray-cast suffices (the common case;
    /// keeps box−box etc. on the fast single-cast path).
    pub coplanar_a: Vec<bool>,
    /// Per-sub-triangle (parallel to `tris_b`) coplanar-parent flag.
    pub coplanar_b: Vec<bool>,
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
    #[cfg(not(target_arch = "wasm32"))]
    let _ts = std::time::Instant::now();
    // 1. accumulate raw intersection segments (Segment pairs) + coplanar overlaps
    let mut raw_a: Vec<Vec<RawSeg>> = (0..a.len()).map(|_| Vec::new()).collect();
    let mut raw_b: Vec<Vec<RawSeg>> = (0..b.len()).map(|_| Vec::new()).collect();
    let mut cop_a: Vec<Vec<Constraint>> = (0..a.len()).map(|_| Vec::new()).collect();
    let mut cop_b: Vec<Vec<Constraint>> = (0..b.len()).map(|_| Vec::new()).collect();
    let pairs = super::broadphase::candidate_pairs(a, b);
    #[cfg(not(target_arch = "wasm32"))]
    let n_pairs = pairs.len();
    #[cfg(not(target_arch = "wasm32"))]
    let mut n_hit = 0usize;
    for (i, j) in pairs {
        let (ta, tb) = (&a[i], &b[j]);
        let _r = tri_tri_intersection(ta, tb);
        #[cfg(not(target_arch = "wasm32"))]
        if !matches!(_r, TriTri::None | TriTri::Point(_)) {
            n_hit += 1;
        }
        match _r {
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
    #[cfg(not(target_arch = "wasm32"))]
    let t_pairs = _ts.elapsed();
    // Per-ORIGINAL-triangle "had a coplanar overlap with the other operand" flag,
    // captured BEFORE `build` drains the coplanar-constraint accumulators.
    let cop_parent_a: Vec<bool> = cop_a.iter().map(|c| !c.is_empty()).collect();
    let cop_parent_b: Vec<bool> = cop_b.iter().map(|c| !c.is_empty()).collect();
    let ca = build(a, &raw_a, &mut cop_a);
    let cb = build(b, &raw_b, &mut cop_b);
    // 3. re-triangulate each operand over the SHARED interner ⇒ conforming surfaces
    #[cfg(not(target_arch = "wasm32"))]
    let t_build = _ts.elapsed();
    let mut interner = Interner::new();
    let (tris_a, coplanar_a) = retriangulate_each(a, &ca, &cop_parent_a, &mut interner);
    let (tris_b, coplanar_b) = retriangulate_each(b, &cb, &cop_parent_b, &mut interner);
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var("ARRANGE_PROFILE").is_ok() {
        eprintln!(
            "    arrange: pairs {:.0}ms ({} cand, {} hit)  build {:.0}ms  retri {:.0}ms ({} subA {} subB)",
            t_pairs.as_secs_f64() * 1e3,
            n_pairs,
            n_hit,
            (t_build - t_pairs).as_secs_f64() * 1e3,
            (_ts.elapsed() - t_build).as_secs_f64() * 1e3,
            tris_a.len(),
            tris_b.len(),
        );
    }
    Arrangement { interner, tris_a, tris_b, coplanar_a, coplanar_b }
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
    // intersect every unordered mesh pair (i<j); push constraints to BOTH.
    for i in 0..n {
        for j in (i + 1)..n {
            let pairs = super::broadphase::candidate_pairs(meshes[i], meshes[j]);
            for (ti, tj) in pairs {
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
                    TriTri::None | TriTri::Point(_) => {}
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
        let (tris, _coplanar) = retriangulate_each(meshes[k], &cons, &cop_parent, &mut interner);
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
    cop_parent: &[bool],
    it: &mut Interner,
) -> (Vec<[Vid; 3]>, Vec<bool>) {
    let mut out = Vec::new();
    let mut coplanar = Vec::new();
    for (i, t) in tris.iter().enumerate() {
        let parent_cop = cop_parent.get(i).copied().unwrap_or(false);
        let passthrough = |it: &mut Interner| {
            [
                it.intern(ImplicitPoint::Explicit(t[0])),
                it.intern(ImplicitPoint::Explicit(t[1])),
                it.intern(ImplicitPoint::Explicit(t[2])),
            ]
        };
        let before = out.len();
        if cons[i].is_empty() {
            out.push(passthrough(it));
        } else if let Some(mesh) =
            triangulate(&RetriInput { tri: *t, constraints: cons[i].clone() }, it)
        {
            out.extend(mesh.tris);
        } else {
            out.push(passthrough(it)); // degenerate triangle — pass through
        }
        coplanar.resize(out.len(), parent_cop);
        debug_assert!(coplanar.len() == out.len() && before <= out.len());
    }
    (out, coplanar)
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

/// Is point `p` inside the closed mesh `tris`? Exact ray-cast parity to a far
/// point (`far_l` past the extent) along a fixed generic direction; each crossing
/// tested by the exact predicate above.
fn point_inside(p: [f64; 3], tris: &[Tri], far_l: f64) -> bool {
    // Generic direction: no two components near-equal and no pairwise ratio near a
    // simple architectural slope (1:1 roofs, axis planes). The previous direction
    // had x≈y and dz/dx≈1 — nearly PARALLEL to 45° roof slopes/ridge edges, so a
    // roof-clipped wall's ray grazed the roof and edge-crossings (rejected, not
    // counted) miscounted parity → the sub-ridge gable triangle was wrongly judged
    // inside the cutter and removed (the "missing wall" over-clip).
    #[allow(unused_mut)]
    let mut dir = [0.301_511_3, 0.557_328_1, 0.773_890_1];
    #[cfg(not(target_arch = "wasm32"))]
    if let Ok(s) = std::env::var("RAY_DIR") {
        let v: Vec<f64> = s.split(',').filter_map(|x| x.parse().ok()).collect();
        if v.len() == 3 {
            dir = [v[0], v[1], v[2]];
        }
    }
    let far = [p[0] + dir[0] * far_l, p[1] + dir[1] * far_l, p[2] + dir[2] * far_l];
    tris.iter().filter(|t| exact_seg_hits_tri(p, far, t)).count() % 2 == 1
}

fn to_f64_pt(arr: &Arrangement, v: Vid) -> [f64; 3] {
    let pt = arr.interner.get(v);
    // Fast path: materialize via the fixed-width lambda. Falls back to the exact
    // BigRational `point_of` only for off-grid/overflow points (rare).
    if let Some(f) = super::fixed::point_to_f64(pt) {
        return f;
    }
    let p = point_of(pt);
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

/// Power-of-two grid `mesh_bridge` snaps both operands to (metres). Mirrored from
/// `mesh_bridge::SNAP_GRID`; the `near_on_surface_normal` band below is sized to
/// the scatter this snap leaves on a TILTED flush face (kept in sync by the
/// `snap_grid_in_sync` test in `mesh_bridge`).
const SNAP_GRID: f64 = 1.0 / 65536.0;

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
    // band: max perpendicular plane-gap a flush f32 face leaves after the 2-operand
    // snap, widened for far-from-origin coords (8·SNAP_GRID ≈ 0.12 mm; the
    // extent·2^-22 term only dominates past ~32 km from origin).
    let band = (8.0 * SNAP_GRID).max(extent * (1.0 / 4_194_304.0));
    let band2 = band * band;
    for t in others {
        let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
        let nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
        if nn <= 0.0 || !nn.is_finite() {
            continue; // degenerate t
        }
        // squared perpendicular distance of `c` to t's plane = (d·n)² / |n|²
        let d = dot3(sub_f64(c, t[0]), n);
        if (d * d) / nn > band2 {
            continue; // c not within the snap band of t's plane
        }
        let axis = drop_axis_of(n);
        let w0 = orient2d_any(&e(t[0]), &e(t[1]), &e(t[2]), axis);
        if w0 == Sign::Zero {
            continue; // degenerate t in projection
        }
        let inside = |u: [f64; 3], v: [f64; 3]| orient2d_any(&e(u), &e(v), &e(c), axis) != w0.flip();
        if inside(t[0], t[1]) && inside(t[1], t[2]) && inside(t[2], t[0]) {
            return Some(n);
        }
    }
    None
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
    use std::collections::HashSet;
    let (ext_a, ext_b) = (operand_extent(a), operand_extent(b));
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
        if let Some(n_other) = on_surface_normal(c, b).or_else(|| near_on_surface_normal(c, b)) {
            let co_oriented = dot3(tri_normal(arr, tri), n_other) > 0.0;
            keep = match op {
                BoolOp::Union | BoolOp::Intersection => co_oriented,
                BoolOp::Difference => !co_oriented,
            };
        } else if let Some(k) = cop_parent
            .then(|| on_interface_keep(arr, tri, c, b, ext_b, op, true))
            .flatten()
        {
            // regime 2 (only on coplanar-overlap parents): shared interface plane,
            // no coincident face → solid-side probe.
            keep = k;
        } else {
            // regime 3: strictly off-plane → centroid ray-cast (original)
            let inside_b = point_inside(c, b, ext_b);
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
        if on_surface_normal(c, a).is_some() || near_on_surface_normal(c, a).is_some() {
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
        let inside_a = point_inside(c, a, ext_a);
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
    #[cfg(not(target_arch = "wasm32"))]
    let t0 = std::time::Instant::now();
    let arr = arrange(a, b);
    #[cfg(not(target_arch = "wasm32"))]
    let t_arr = t0.elapsed();
    let vids = boolean_vids(&arr, a, b, op);
    #[cfg(not(target_arch = "wasm32"))]
    let t_cls = t0.elapsed();
    let out: Vec<Tri> = vids
        .into_iter()
        .map(|t| [to_f64_pt(&arr, t[0]), to_f64_pt(&arr, t[1]), to_f64_pt(&arr, t[2])])
        .collect();
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var("KERNEL_PROFILE").is_ok() {
        super::prof_add(t_arr.as_secs_f64(), (t_cls - t_arr).as_secs_f64(), (t0.elapsed() - t_cls).as_secs_f64());
    }
    out
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
        // BOTH boxes. Pure geometry ⇒ must pass under --no-default-features AND
        // the default (Manifold) build.
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
