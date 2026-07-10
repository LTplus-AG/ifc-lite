// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! In-plane constrained re-triangulation — phases A–F.
//!
//! Each input triangle `T` crossed by other triangles accumulates intersection
//! sub-segments lying in its plane; this module re-triangulates `T` into a
//! conforming, intersection-free fan of sub-triangles whose vertices are
//! referenced SYMBOLICALLY (via the interner, never a float coordinate), with a
//! topology that is invariant to insertion order and byte-identical across
//! platforms.
//!
//! PHASE A is the exact projection axis + reference winding; PHASE B the
//! canonical lex-rank work list; phases C–F (point insertion, segment
//! insertion, earcut, emit) build on the canonical list produced here.

use super::interner::{Interner, Vid};
use super::predicates::{cmp_lex, orient2d, orient2d_any};
use super::retriangulate_recover::enforce_constraint;
use super::{fixed, interval};
use super::{DropAxis, ImplicitPoint, Lpi, Sign, Tpi};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

#[inline]
fn e(p: [f64; 3]) -> ImplicitPoint {
    ImplicitPoint::Explicit(p)
}

/// Vid-based exact orient2d — the dominant re-triangulation predicate. Tiers, all
/// returning the SAME exact sign (faster ones resolve the easy cases first):
/// all-explicit Shewchuk (f64) → f64 directed-rounding interval from the cached
/// lambdas → cached-I512 determinant → ImplicitPoint cascade (BigRational tail).
/// The interval tier carries the non-degenerate majority of implicit-point
/// predicates in pure f64, so the wasm-emulated I512 path is reached only on a
/// genuine zero-straddle — the fix for the dense-opening-wall wasm cost.
#[inline]
pub(crate) fn orient2d_v(it: &Interner, a: Vid, b: Vid, c: Vid, axis: DropAxis) -> Sign {
    let (pa, pb, pc) = (it.get(a), it.get(b), it.get(c));
    // All-explicit: the Shewchuk adaptive predicate is EXACT yet pure f64.
    if let (ImplicitPoint::Explicit(_), ImplicitPoint::Explicit(_), ImplicitPoint::Explicit(_)) =
        (pa, pb, pc)
    {
        return orient2d(pa, pb, pc, axis);
    }
    // f64 INTERVAL from the cached lambdas — pure f64, no wide-int; resolves the
    // non-degenerate majority and is bit-identical to the exact sign when definite.
    if let Some(s) = interval::orient2d_from_lam_iv(it.lam_iv(a), it.lam_iv(b), it.lam_iv(c), axis) {
        return s;
    }
    if let (Some(la), Some(lb), Some(lc)) = (it.lam(a), it.lam(b), it.lam(c)) {
        if let Some(s) = fixed::orient2d_from_lam(la, lb, lc, axis) {
            return s;
        }
    }
    orient2d_any(pa, pb, pc, axis)
}

/// Vid-based exact lexicographic compare — f64 interval from the cached lambdas
/// first, then the cached-I512 compare, then the ImplicitPoint cascade.
#[inline]
pub(crate) fn cmp_lex_v(it: &Interner, a: Vid, b: Vid) -> Sign {
    if let Some(s) = interval::cmp_lex_from_lam_iv(it.lam_iv(a), it.lam_iv(b)) {
        return s;
    }
    if let (Some(la), Some(lb)) = (it.lam(a), it.lam(b)) {
        if let Some(s) = fixed::cmp_lex_from_lam(la, lb) {
            return s;
        }
    }
    let (pa, pb) = (it.get(a), it.get(b));
    cmp_lex(pa, pb)
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
    /// Isolated CONFORMITY VERTICES (no segment): a `TriTri::Point` tangential
    /// touch of the other operand. When such a point lies exactly ON one of
    /// `T`'s edges, the NEIGHBOR triangle sees a full crossing SEGMENT ending
    /// at that point and splits the shared edge there — `T` must split it too
    /// or the surfaces stop conforming (a T-junction ⇒ exact-coordinate open
    /// edges: the flush-corner-on-diagonal family, e.g. a window box whose
    /// corner lands on the host face triangle's diagonal).
    pub points: Vec<ImplicitPoint>,
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
    /// Isolated conformity vertices (tangential touches), lex-sorted, deduped.
    pub points: Vec<Vid>,
}

pub(crate) fn lex_cmp(it: &Interner, a: Vid, b: Vid) -> Ordering {
    match cmp_lex_v(it, a, b) {
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
    let mut points: Vec<Vid> = input.points.iter().map(|p| interner.intern(p.clone())).collect();
    points.sort_by(|&a, &b| lex_cmp(interner, a, b));
    points.dedup();
    Canonical { corners, segments, points }
}

/// A sub-triangle of `T` (interned Vids), oriented to match `w0`.
pub type SubTri = [Vid; 3];

/// The evolving 2D triangulation of `T` during phases C–E.
pub struct Mesh2d {
    pub tris: Vec<SubTri>,
    pub axis: DropAxis,
    pub w0: Sign,
    /// Constraint sub-segments the enforcement fixed point could NOT force as
    /// edges (degenerate channels the pocket rebuild bails on). Non-zero ⇒ the
    /// triangulation does not fully CONFORM to the other operand: sub-triangles
    /// may straddle an intersection line and their centroid classification is
    /// then unreliable. The batched void path treats this as a hard reject
    /// (fall back to sequential cuts); the binary path keeps its historical
    /// graceful-degrade behavior.
    pub unrecovered: usize,
    /// Set by [`recover_subsegment`] whenever a recovery attempt could not
    /// force its edge (any bail path). Gates the final conformity audit in
    /// [`triangulate`] so the clean common path pays nothing for it.
    pub audit_needed: bool,
    /// Per-`Vid` cached 2D f64 coordinate (dropped to `axis`, `None` when the
    /// implicit point has no finite f64 image). Used ONLY as a conservative
    /// broadphase prefilter in [`insert_point`] / channel detection — the exact
    /// predicate still decides every retained triangle, so this never affects
    /// topology. Cached because the same vertices are re-scanned on every point
    /// insertion AND on every constraint sub-segment's O(tris) channel scan.
    pub coords: BTreeMap<Vid, Option<[f64; 2]>>,
}

enum Locate {
    Interior,
    OnEdge,
    OnVertex,
    Outside,
}

/// Classify point `p` against sub-triangle `tri` (oriented `w0`): the three edge
/// `orient2d` signs say inside (all `w0`), on an edge (one `Zero`), on a vertex,
/// or outside (any sign opposite `w0`).
fn locate(it: &Interner, tri: SubTri, p: Vid, axis: DropAxis, w0: Sign) -> Locate {
    if tri.contains(&p) {
        return Locate::OnVertex;
    }
    let s = [
        orient2d_v(it, tri[0], tri[1], p, axis),
        orient2d_v(it, tri[1], tri[2], p, axis),
        orient2d_v(it, tri[2], tri[0], p, axis),
    ];
    if s.iter().any(|&x| x == w0.flip()) {
        return Locate::Outside;
    }
    match s.iter().filter(|&&x| x == Sign::Zero).count() {
        0 => Locate::Interior,
        1 => Locate::OnEdge,
        _ => Locate::OnVertex, // 2+ zeros ⇒ coincident with a vertex
    }
}

/// Minimum working-set size before the f64-AABB broadphase prefilters engage.
/// Below this the exact scan is already short, so the cache/AABB bookkeeping
/// would be pure overhead (it measurably slowed boolean-dense-but-simple models);
/// above it the O(N²) exact-predicate blow-up dominates and the prefilter wins.
/// Purely a performance gate — it never changes which triangles `locate` accepts.
pub(crate) const PREFILTER_MIN: usize = 32;

/// `p`'s coordinates dropped to the kept 2D plane for projection `axis`.
#[inline]
pub(crate) fn project2d(p: [f64; 3], axis: DropAxis) -> [f64; 2] {
    match axis {
        DropAxis::X => [p[1], p[2]],
        DropAxis::Y => [p[0], p[2]],
        DropAxis::Z => [p[0], p[1]],
    }
}

/// Cached 2D f64 image of vertex `v` (dropped to `axis`). `None` when the
/// implicit point has no finite f64 image (degenerate construction). Used ONLY
/// by the [`insert_point`] broadphase, never by an exact decision; cached
/// because the same vertices are re-scanned on every point insertion.
#[inline]
pub(crate) fn coord2d_cached(
    it: &Interner,
    v: Vid,
    axis: DropAxis,
    cache: &mut BTreeMap<Vid, Option<[f64; 2]>>,
) -> Option<[f64; 2]> {
    if let Some(&c) = cache.get(&v) {
        return c;
    }
    let c = fixed::point_to_f64(it.get(v)).map(|p3| project2d(p3, axis));
    cache.insert(v, c);
    c
}

/// True when `p2` (a point's 2D f64 image) lies outside `tri`'s f64 AABB widened
/// by a generous margin ⇒ `tri` provably cannot contain it. The margin (absolute
/// floor + magnitude-relative term) dwarfs the worst f64 rounding / implicit-
/// point image error by many orders, so this is a CONSERVATIVE reject: it never
/// excludes a triangle that genuinely contains the point, on any platform. A
/// vertex without a finite f64 image disables the reject for `tri` (keep it).
#[inline]
fn aabb_excludes(
    it: &Interner,
    tri: SubTri,
    p2: [f64; 2],
    axis: DropAxis,
    cache: &mut BTreeMap<Vid, Option<[f64; 2]>>,
) -> bool {
    let (a, b, c) = match (
        coord2d_cached(it, tri[0], axis, cache),
        coord2d_cached(it, tri[1], axis, cache),
        coord2d_cached(it, tri[2], axis, cache),
    ) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => return false,
    };
    let min_x = a[0].min(b[0]).min(c[0]);
    let max_x = a[0].max(b[0]).max(c[0]);
    let min_y = a[1].min(b[1]).min(c[1]);
    let max_y = a[1].max(b[1]).max(c[1]);
    let mx = 1e-6 + p2[0].abs() * 1e-9;
    let my = 1e-6 + p2[1].abs() * 1e-9;
    p2[0] < min_x - mx || p2[0] > max_x + mx || p2[1] < min_y - my || p2[1] > max_y + my
}

/// True when triangle `tri`'s 2D f64 AABB is disjoint (beyond a generous margin)
/// from the box `bx` = `[min_x, min_y, max_x, max_y]` ⇒ no edge of `tri` can
/// cross a segment contained in `bx`. Conservative (margin dwarfs the f64 /
/// implicit-point error); a vertex with no finite f64 image disables the reject.
#[inline]
pub(crate) fn tri_aabb_disjoint(
    it: &Interner,
    tri: SubTri,
    bx: [f64; 4],
    axis: DropAxis,
    cache: &mut BTreeMap<Vid, Option<[f64; 2]>>,
) -> bool {
    let (a, b, c) = match (
        coord2d_cached(it, tri[0], axis, cache),
        coord2d_cached(it, tri[1], axis, cache),
        coord2d_cached(it, tri[2], axis, cache),
    ) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => return false,
    };
    let tmin_x = a[0].min(b[0]).min(c[0]);
    let tmax_x = a[0].max(b[0]).max(c[0]);
    let tmin_y = a[1].min(b[1]).min(c[1]);
    let tmax_y = a[1].max(b[1]).max(c[1]);
    let m = 1e-6 + bx[2].abs().max(bx[3].abs()).max(tmax_x.abs()).max(tmax_y.abs()) * 1e-9;
    tmax_x < bx[0] - m || tmin_x > bx[2] + m || tmax_y < bx[1] - m || tmin_y > bx[3] + m
}

/// PHASE C — insert point `p` (interned), splitting the triangle(s) containing
/// it. Uniform cavity-fan: gather the triangles that contain `p` (one if
/// interior, two across a shared edge), take the cavity's boundary edges, and
/// fan `p` to each. `p` is interior to the cavity, so every boundary edge `u→v`
/// has `p` on its left ⇒ `[u,v,p]` preserves `w0`. Handles interior (1→3) and
/// on-edge (→4) uniformly; an already-present vertex is a no-op.
pub(crate) fn insert_point(mesh: &mut Mesh2d, it: &Interner, p: Vid) {
    let axis = mesh.axis;
    let w0 = mesh.w0;
    // Conservative broadphase prefilter. `pc` is `p`'s f64 image dropped to the
    // projection axis; for each triangle we skip the (possibly BigRational)
    // exact `locate` when `p` lies outside that triangle's widened f64 AABB. The
    // margin guarantees a triangle truly containing `p` (interior / on-edge /
    // on-vertex) is NEVER skipped on any platform, so the cavity — and the whole
    // resulting topology — is bit-identical to the unfiltered scan. This
    // collapses the per-host-face O(points·triangles) exact-predicate blowup on
    // heavily fragmented faces (many openings in one wall) toward O(points +
    // triangles) exact calls — the cause of the WASM stall on dense facades.
    // Engaged only once the triangle set is large enough to amortise the cache.
    let pc = if mesh.tris.len() > PREFILTER_MIN {
        coord2d_cached(it, p, axis, &mut mesh.coords)
    } else {
        None
    };
    let mut cavity = Vec::new();
    for ti in 0..mesh.tris.len() {
        let tri = mesh.tris[ti];
        if let Some(p2) = pc {
            if aabb_excludes(it, tri, p2, axis, &mut mesh.coords) {
                continue;
            }
        }
        match locate(it, tri, p, axis, w0) {
            Locate::OnVertex => return,
            Locate::Interior | Locate::OnEdge => cavity.push(ti),
            Locate::Outside => {}
        }
    }
    if cavity.is_empty() {
        return; // p not inside T
    }
    let cavity_set: BTreeSet<usize> = cavity.iter().copied().collect();
    let mut edges: BTreeSet<(Vid, Vid)> = BTreeSet::new();
    for &ti in &cavity {
        let [a, b, c] = mesh.tris[ti];
        edges.insert((a, b));
        edges.insert((b, c));
        edges.insert((c, a));
    }
    // Boundary edges = those whose reverse is not also in the cavity, EXCLUDING
    // any edge `p` lies on (collinear): fanning `p` to an edge it's on would make
    // a degenerate triangle — that edge is split instead, by the adjacent fans.
    let boundary: Vec<(Vid, Vid)> = edges
        .iter()
        .copied()
        .filter(|&(u, v)| !edges.contains(&(v, u)))
        .filter(|&(u, v)| orient2d_v(it, u, v, p, axis) != Sign::Zero)
        .collect();
    mesh.tris = mesh
        .tris
        .iter()
        .enumerate()
        .filter(|(i, _)| !cavity_set.contains(i))
        .map(|(_, t)| *t)
        .collect();
    for (u, v) in boundary {
        mesh.tris.push([u, v, p]);
    }
}

/// Is `p` strictly OUTSIDE the closed triangle `(a,b,c)` (oriented `w0`)? — true
/// iff some edge has `p` on its far (opposite-`w0`) side. Used by the ear test:
/// an ear is valid only when every other vertex is strictly outside (a vertex on
/// the ear's boundary blocks it, else clipping leaves a degenerate sliver).
fn strictly_outside(it: &Interner, a: Vid, b: Vid, c: Vid, p: Vid, axis: DropAxis, w0: Sign) -> bool {
    let opp = w0.flip();
    orient2d_v(it, a, b, p, axis) == opp
        || orient2d_v(it, b, c, p, axis) == opp
        || orient2d_v(it, c, a, p, axis) == opp
}

/// PHASE E — triangulate a simple polygon `ring` (oriented `w0`) by deterministic
/// ear clipping. An ear is a strictly-convex corner whose triangle contains no
/// other ring vertex; among all ears we always clip the one with the
/// lexicographically-least APEX, so the output is a pure function of the ring
/// (independent of where the ring starts). The two-ears theorem guarantees a
/// simple polygon always has an ear → termination.
pub fn earcut(it: &Interner, ring: &[Vid], axis: DropAxis, w0: Sign) -> Vec<SubTri> {
    let mut poly: Vec<Vid> = ring.to_vec();
    // f64 2D images of the ring vertices, maintained parallel to `poly`. Used ONLY
    // as a conservative AABB prefilter in the ear-emptiness test (the dominant
    // #1109 earcut cost on dense-opening slabs): a vertex outside the candidate
    // ear's widened f64 AABB is provably outside the ear, so its exact
    // `strictly_outside` predicate is skipped. The margin dwarfs the f64 /
    // implicit-point image error, exactly as `tri_aabb_disjoint`, so a vertex
    // genuinely inside the ear is NEVER skipped — the chosen ear, and thus the
    // whole triangulation, is byte-identical to the all-exact form (parity).
    let mut pc: Vec<Option<[f64; 2]>> = poly
        .iter()
        .map(|&v| fixed::point_to_f64(it.get(v)).map(|p3| project2d(p3, axis)))
        .collect();
    let mut out = Vec::new();
    while poly.len() > 3 {
        let n = poly.len();
        // Below PREFILTER_MIN the exact emptiness scan is already short, so the
        // AABB bookkeeping would be pure overhead — fall back to all-exact, which
        // is the identical decision. Above it the O(n) exact scan dominates.
        let prefilter = n > PREFILTER_MIN;
        let mut best: Option<usize> = None;
        for i in 0..n {
            let (ia, ic) = ((i + n - 1) % n, (i + 1) % n);
            let a = poly[ia];
            let b = poly[i];
            let c = poly[ic];
            // strictly convex under w0
            if orient2d_v(it, a, b, c, axis) != w0 {
                continue;
            }
            let ear_box: Option<[f64; 4]> = if prefilter {
                match (pc[ia], pc[i], pc[ic]) {
                    (Some(pa), Some(pb), Some(pc2)) => Some([
                        pa[0].min(pb[0]).min(pc2[0]),
                        pa[1].min(pb[1]).min(pc2[1]),
                        pa[0].max(pb[0]).max(pc2[0]),
                        pa[1].max(pb[1]).max(pc2[1]),
                    ]),
                    _ => None,
                }
            } else {
                None
            };
            // empty: every other ring vertex is strictly outside the closed ear
            let empty = (0..n).all(|k| {
                let v = poly[k];
                if v == a || v == b || v == c {
                    return true;
                }
                if let (Some(bx), Some(p)) = (ear_box, pc[k]) {
                    let m = 1e-6
                        + bx[2].abs().max(bx[3].abs()).max(p[0].abs()).max(p[1].abs()) * 1e-9;
                    if p[0] < bx[0] - m || p[0] > bx[2] + m || p[1] < bx[1] - m || p[1] > bx[3] + m
                    {
                        return true; // provably outside the ear ⇒ skip the exact test
                    }
                }
                strictly_outside(it, a, b, c, v, axis, w0)
            });
            if !empty {
                continue;
            }
            best = Some(match best {
                None => i,
                Some(j) if cmp_lex_v(it, b, poly[j]) == Sign::Negative => i,
                Some(j) => j,
            });
        }
        let i = match best {
            Some(i) => i,
            None => {
                // Degenerate pocket (no strictly-convex empty ear — a non-simple or
                // collinear polygon). Fan-triangulate the remainder rather than
                // panic: a panic aborts the wasm worker (panic=abort) and stalls
                // the whole geometry stream. The fan may contain slivers, which
                // consolidate_coplanar cleans up at the seam.
                for k in 1..poly.len() - 1 {
                    out.push([poly[0], poly[k], poly[k + 1]]);
                }
                return out;
            }
        };
        let n = poly.len();
        out.push([poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]]);
        poly.remove(i);
        pc.remove(i);
    }
    out.push([poly[0], poly[1], poly[2]]);
    out
}

#[inline]
pub(crate) fn tri_edges(t: SubTri) -> [(Vid, Vid); 3] {
    [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])]
}

/// Is there a triangle with both `s` and `t` as vertices? (In a triangle any two
/// vertices form an edge, so this is exactly "the segment s–t is already an edge".)
pub(crate) fn edge_exists(mesh: &Mesh2d, s: Vid, t: Vid) -> bool {
    mesh.tris.iter().any(|tri| tri.contains(&s) && tri.contains(&t))
}

/// Reverse `ring` if its winding doesn't match `w0`, so earcut sees a CCW polygon.
/// The lexicographically-least vertex is convex, so its turn gives the winding.
pub(crate) fn orient_ring(it: &Interner, ring: Vec<Vid>, axis: DropAxis, w0: Sign) -> Vec<Vid> {
    let n = ring.len();
    let i = (0..n).min_by(|&x, &y| lex_cmp(it, ring[x], ring[y])).unwrap();
    let w = orient2d_v(it, ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n], axis);
    if w == w0 {
        ring
    } else {
        let mut r = ring;
        r.reverse();
        r
    }
}


/// Phases A–D: project, canonicalise, insert all constraint points, then force
/// every constraint to appear as an edge (chain). `None` ⇒ `T` is degenerate.
pub fn triangulate(input: &RetriInput, interner: &mut Interner) -> Option<Mesh2d> {
    let (axis, w0) = projection_axis(&input.tri)?;
    let mut canon = canonicalize(input, interner);
    super::retriangulate_cleanup::drop_out_of_plane(&mut canon, &input.tri, interner, axis); // #098
    let mut mesh = Mesh2d {
        tris: vec![canon.corners],
        axis,
        w0,
        unrecovered: 0,
        audit_needed: false,
        coords: BTreeMap::new(),
    };
    let mut pts: BTreeSet<Vid> = BTreeSet::new();
    for &(lo, hi) in &canon.segments {
        pts.insert(lo);
        pts.insert(hi);
    }
    pts.extend(canon.points.iter().copied());
    for &c in &canon.corners {
        pts.remove(&c);
    }
    let mut ordered: Vec<Vid> = pts.into_iter().collect();
    ordered.sort_by(|&a, &b| lex_cmp(interner, a, b));
    for p in ordered {
        // #1109 overshoot guard: a heavily-fragmented host face (a slab cut by
        // 24+ openings) inserts thousands of constraint points here, each
        // running exact orient2d in `insert_point`. The per-triangle
        // `tripped()` check in `retriangulate_each` only fires BETWEEN
        // triangles, so without this one `triangulate` call ran ~1.7M
        // escalations (3.3× a 500k cap) — seconds of work — before bailing.
        // Stop mid-insertion: the caller discards the partial arrangement once
        // `tripped()`, so the incomplete triangulation is never emitted.
        if super::budget::tripped() {
            break;
        }
        insert_point(&mut mesh, interner, p);
    }
    // Enforce to a FIXED POINT: recovering one constraint deletes the channel
    // triangles it crosses, which can remove an edge a PREVIOUS constraint had
    // already been forced into (the pocket earcut is not constraint-aware). One
    // extra pass re-forces those; iteration is bounded — each pass is a no-op
    // (`recover_subsegment` early-returns on `edge_exists`) once every
    // constraint chain is present. The cap keeps a pathological ping-pong from
    // looping forever (the constraint set is crossing-free by construction —
    // seg×seg pre-pass for transversal constraints, a planar mesh complex for
    // coplanar ones — so non-convergence would leave at most an unrecovered
    // constraint, the pre-existing graceful-bail behavior). Purely a function
    // of exact predicates ⇒ deterministic, byte-identical native==wasm.
    let mut converged = false;
    for _pass in 0..4 {
        // #1109 overshoot guard: constraint recovery runs exact predicates per
        // sub-segment; a slab face with thousands of seam segments is the other
        // heavy escalation site between per-triangle `tripped()` checks.
        if super::budget::tripped() {
            break;
        }
        let before = mesh.tris.clone();
        for &(s, t) in &canon.segments {
            if super::budget::tripped() {
                break;
            }
            enforce_constraint(&mut mesh, interner, s, t);
        }
        if mesh.tris == before {
            converged = true;
            break;
        }
    }
    // #1109: if the per-element budget tripped while inserting points or recovering
    // constraints above, the boolean caller discards this entire arrangement
    // (csg.rs returns the host un-cut → #635 AABB fallback). Skip the conformity
    // audit below — it runs O(segments × vertices) exact predicates with NO budget
    // check, so without this a tripped, heavily-fragmented face keeps grinding well
    // past the cap. The partial triangulation we return is dropped anyway.
    if super::budget::tripped() {
        return Some(mesh);
    }
    if !converged {
        // Pass-cap exit: the LAST pass's rebuilds may have broken an edge that
        // was forced earlier without any later recover attempt re-flagging it,
        // so the audit-skip soundness argument doesn't hold — audit always.
        mesh.audit_needed = true;
    }
    // Count the constraint sub-segments that stayed unrecovered (see
    // `Mesh2d::unrecovered`). Same chain decomposition as `enforce_constraint`.
    // Gated on `audit_needed`: only triangulations where some recovery attempt
    // bailed pay for the audit — the clean common path skips it entirely.
    if !mesh.audit_needed {
        return Some(mesh);
    }
    super::retriangulate_audit::audit_and_recover(&mut mesh, interner, &canon, axis);
    // Deliberate trade-off: return Some even if a constraint stayed unrecovered —
    // the caller (arrangement.rs) maps None to a FULL passthrough of the input
    // triangle, dropping ALL constraints, which is strictly worse than a mesh
    // missing one.
    Some(mesh)
}

/// PHASE F — a deterministic TOPOLOGY fingerprint of the triangulation: every
/// sub-triangle as its sorted Vid triple, the set sorted, FNV-1a-hashed. Vids are
/// symbolic identities assigned in a deterministic (input-driven, exact-cmp_lex
/// dedup) order and every geometric decision is exact, so this hash is
/// byte-identical across x86_64/aarch64/wasm. (We hash Vid CONNECTIVITY, not
/// coordinates — the determinism bar is topology, not coordinates.)
pub fn triangulation_topology_hash(input: &RetriInput) -> u64 {
    let mut interner = Interner::new();
    let mesh = match triangulate(input, &mut interner) {
        Some(m) => m,
        None => return 0,
    };
    let mut tris: Vec<[Vid; 3]> = mesh
        .tris
        .iter()
        .map(|&t| {
            let mut s = t;
            s.sort_unstable();
            s
        })
        .collect();
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

/// Cross-platform re-triangulation determinism manifest: the topology hash of a
/// fixed fixture (a triangle + constraints with explicit/LPI/TPI endpoints, some
/// requiring recovery / on-edge), for the wasm/ARM cross-check (analogous to the
/// predicate sign manifest).
pub fn retriangulation_manifest() -> u64 {
    let t = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0]];
    // LPI at (3,3,0): vertical line ∩ z=0
    let lpi = ImplicitPoint::Lpi(Lpi {
        p: [3.0, 3.0, -1.0],
        q: [3.0, 3.0, 1.0],
        r: [0.0, 0.0, 0.0],
        s: [1.0, 0.0, 0.0],
        t: [0.0, 1.0, 0.0],
    });
    // TPI at (3,5,0): planes z=0, x=3, y=5
    let tpi = ImplicitPoint::Tpi(Tpi {
        planes: [
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[3.0, 0.0, 0.0], [3.0, 1.0, 0.0], [3.0, 0.0, 1.0]],
            [[0.0, 5.0, 0.0], [1.0, 5.0, 0.0], [0.0, 5.0, 1.0]],
        ],
    });
    let x = ImplicitPoint::Explicit;
    let cons = vec![
        Constraint { a: x([2.0, 2.0, 0.0]), b: x([6.0, 2.0, 0.0]) },
        Constraint { a: x([2.0, 2.0, 0.0]), b: x([2.0, 6.0, 0.0]) },
        Constraint { a: lpi.clone(), b: x([6.0, 2.0, 0.0]) },
        Constraint { a: tpi, b: x([2.0, 6.0, 0.0]) },
        Constraint { a: x([5.0, 1.0, 0.0]), b: lpi },
    ];
    triangulation_topology_hash(&RetriInput { tri: t, constraints: cons, points: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::super::rational::point_of;
    use super::super::retriangulate_recover::recover_subsegment;
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
            let canon = canonicalize(&RetriInput { tri: t, constraints: cons, points: Vec::new() }, &mut it);
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

    #[test]
    fn phase_e_earcut_covers_a_concave_polygon_deterministically() {
        use super::super::rational::tri_area2;
        use num_rational::BigRational;
        use num_traits::Zero;
        // concave polygon (reflex at (2,1.5)) in z=0, wound CCW
        let pts = [[0., 0., 0.], [4., 0., 0.], [4., 3., 0.], [2., 1.5, 0.], [0., 3., 0.]];
        let mut it = Interner::new();
        let ring: Vec<Vid> = pts.iter().map(|&p| it.intern(e(p))).collect();
        let axis = DropAxis::Z;
        let pt = |v: Vid| point_of(it.get(v));
        let origin = point_of(&e([0., 0., 0.]));
        // polygon 2-area (shoelace) + orientation
        let mut poly2a = BigRational::zero();
        for i in 0..ring.len() {
            let j = (i + 1) % ring.len();
            poly2a += tri_area2(&pt(ring[i]), &pt(ring[j]), &origin, axis);
        }
        let w0 = if poly2a > BigRational::zero() { Sign::Positive } else { Sign::Negative };
        let tris = earcut(&it, &ring, axis, w0);
        assert_eq!(tris.len(), ring.len() - 2, "wrong triangle count");
        for &tri in &tris {
            assert_eq!(
                orient2d_v(&it, tri[0], tri[1], tri[2], axis),
                w0,
                "earcut triangle not oriented w0"
            );
        }
        let area_sum = tris
            .iter()
            .fold(BigRational::zero(), |acc, &t| acc + tri_area2(&pt(t[0]), &pt(t[1]), &pt(t[2]), axis));
        assert_eq!(area_sum, poly2a, "earcut does not exactly cover the polygon");
        // determinism: rotating the ring's start vertex yields the SAME triangle set
        let mut rotated = ring.clone();
        rotated.rotate_left(2);
        let tris2 = earcut(&it, &rotated, axis, w0);
        let canon = |ts: &[SubTri]| {
            let mut v: Vec<_> = ts
                .iter()
                .map(|&t| {
                    let mut s = [pt(t[0]), pt(t[1]), pt(t[2])];
                    s.sort();
                    s
                })
                .collect();
            v.sort();
            v
        };
        assert_eq!(canon(&tris), canon(&tris2), "earcut depends on ring start vertex");
    }

    #[test]
    fn phase_d_recovers_a_crossing_diagonal() {
        use super::super::rational::tri_area2;
        use num_rational::BigRational;
        use num_traits::Zero;
        let mut it = Interner::new();
        let a = it.intern(e([0., 0., 0.]));
        let b = it.intern(e([2., 0., 0.]));
        let c = it.intern(e([2., 2., 0.]));
        let d = it.intern(e([0., 2., 0.]));
        // a quad split by the diagonal a–c
        let mut mesh = Mesh2d {
            tris: vec![[a, b, c], [a, c, d]],
            axis: DropAxis::Z,
            w0: Sign::Positive,
            unrecovered: 0,
            audit_needed: false,
            coords: BTreeMap::new(),
        };
        let pt = |v: Vid| point_of(it.get(v));
        let origin = point_of(&e([0., 0., 0.]));
        let ring = [a, b, c, d];
        let quad_area = (0..4).fold(BigRational::zero(), |s, i| {
            s + tri_area2(&pt(ring[i]), &pt(ring[(i + 1) % 4]), &origin, DropAxis::Z)
        });
        // recover the OTHER diagonal b–d, which crosses a–c
        recover_subsegment(&mut mesh, &it, b, d);
        assert!(
            mesh.tris.iter().any(|t| t.contains(&b) && t.contains(&d)),
            "b–d was not recovered as an edge"
        );
        assert!(
            !mesh.tris.iter().any(|t| t.contains(&a) && t.contains(&c)),
            "the crossed diagonal a–c is still present"
        );
        for &tri in &mesh.tris {
            assert_eq!(
                orient2d_v(&it, tri[0], tri[1], tri[2], mesh.axis),
                mesh.w0,
                "recovered triangle not oriented w0"
            );
        }
        let sum = mesh
            .tris
            .iter()
            .fold(BigRational::zero(), |acc, &t| acc + tri_area2(&pt(t[0]), &pt(t[1]), &pt(t[2]), mesh.axis));
        assert_eq!(sum, quad_area, "recovery changed the covered area");
    }

    #[test]
    fn phase_d_full_triangulate_satisfies_constraints_and_covers_t() {
        use super::super::rational::tri_area2;
        use num_rational::BigRational;
        use num_traits::Zero;
        let t = [[0., 0., 0.], [6., 0., 0.], [0., 6., 0.]];
        // an interior quad (1,1)(3,1)(3,3)(1,3); the (3,1)-(1,3) diagonal likely
        // crosses the (1,1)-(3,3) edge Phase C makes ⇒ exercises recovery.
        let cons = vec![
            Constraint { a: e([1., 1., 0.]), b: e([3., 1., 0.]) },
            Constraint { a: e([3., 1., 0.]), b: e([1., 3., 0.]) },
            Constraint { a: e([3., 3., 0.]), b: e([1., 3., 0.]) },
        ];
        let mut it = Interner::new();
        let mesh = triangulate(&RetriInput { tri: t, constraints: cons.clone(), points: Vec::new() }, &mut it).unwrap();
        // intern everything we need (mutable) BEFORE the read-only checks
        let cverts: Vec<(Vid, Vid)> =
            cons.iter().map(|c| (it.intern(c.a.clone()), it.intern(c.b.clone()))).collect();
        let corners = [it.intern(e(t[0])), it.intern(e(t[1])), it.intern(e(t[2]))];
        // every constraint is now an edge
        for &(s, tt) in &cverts {
            assert!(edge_exists(&mesh, s, tt), "constraint {s}-{tt} not satisfied as an edge");
        }
        // orientation + exact coverage of T
        let pt = |v: Vid| point_of(it.get(v));
        for &tri in &mesh.tris {
            assert_eq!(
                orient2d_v(&it, tri[0], tri[1], tri[2], mesh.axis),
                mesh.w0,
                "triangle not oriented w0"
            );
        }
        let sum = mesh
            .tris
            .iter()
            .fold(BigRational::zero(), |acc, &tr| acc + tri_area2(&pt(tr[0]), &pt(tr[1]), &pt(tr[2]), mesh.axis));
        let t_area = tri_area2(&pt(corners[0]), &pt(corners[1]), &pt(corners[2]), mesh.axis);
        assert_eq!(sum, t_area, "triangulation does not exactly cover T");
    }

    #[test]
    fn retriangulation_manifest_is_pinned() {
        // PHASE F (G2) — the full-triangulation topology fingerprint, byte-identical
        // across x86_64/aarch64/wasm (re-pin + re-run the wasm cross-check if the
        // triangulation logic legitimately changes).
        const PINNED: u64 = 0xef5b_32fd_d838_4776;
        let m = super::retriangulation_manifest();
        assert_eq!(m, PINNED, "retriangulation topology manifest changed: 0x{m:016x}");
    }
}
