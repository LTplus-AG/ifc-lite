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
use super::predicates::{cmp_lex, orient2d, orient2d_any};
use super::{DropAxis, ImplicitPoint, Lpi, Sign, Tpi};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

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

/// A sub-triangle of `T` (interned Vids), oriented to match `w0`.
pub type SubTri = [Vid; 3];

/// The evolving 2D triangulation of `T` during phases C–E.
pub struct Mesh2d {
    pub tris: Vec<SubTri>,
    pub axis: DropAxis,
    pub w0: Sign,
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
    let g = |v: Vid| it.get(v);
    let s = [
        orient2d_any(g(tri[0]), g(tri[1]), g(p), axis),
        orient2d_any(g(tri[1]), g(tri[2]), g(p), axis),
        orient2d_any(g(tri[2]), g(tri[0]), g(p), axis),
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

/// PHASE C — insert point `p` (interned), splitting the triangle(s) containing
/// it. Uniform cavity-fan: gather the triangles that contain `p` (one if
/// interior, two across a shared edge), take the cavity's boundary edges, and
/// fan `p` to each. `p` is interior to the cavity, so every boundary edge `u→v`
/// has `p` on its left ⇒ `[u,v,p]` preserves `w0`. Handles interior (1→3) and
/// on-edge (→4) uniformly; an already-present vertex is a no-op.
fn insert_point(mesh: &mut Mesh2d, it: &Interner, p: Vid) {
    let mut cavity = Vec::new();
    for ti in 0..mesh.tris.len() {
        match locate(it, mesh.tris[ti], p, mesh.axis, mesh.w0) {
            Locate::OnVertex => return,
            Locate::Interior | Locate::OnEdge => cavity.push(ti),
            Locate::Outside => {}
        }
    }
    if cavity.is_empty() {
        return; // p not inside T
    }
    let axis = mesh.axis;
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
        .filter(|&(u, v)| orient2d_any(it.get(u), it.get(v), it.get(p), axis) != Sign::Zero)
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

/// Phases A–C: project, canonicalise, and insert every constraint-endpoint point
/// into a triangulation of `T`. `None` ⇒ `T` is degenerate. (Phase D — forcing
/// the constraint segments to be edges — is a later increment.)
pub fn triangulate_points(input: &RetriInput, interner: &mut Interner) -> Option<Mesh2d> {
    let (axis, w0) = projection_axis(&input.tri)?;
    let canon = canonicalize(input, interner);
    // The initial triangle is T's corners in input order; by Phase A its
    // orientation is exactly w0.
    let mut mesh = Mesh2d { tris: vec![canon.corners], axis, w0 };
    let mut pts: BTreeSet<Vid> = BTreeSet::new();
    for &(lo, hi) in &canon.segments {
        pts.insert(lo);
        pts.insert(hi);
    }
    for &c in &canon.corners {
        pts.remove(&c);
    }
    // insert in canonical lex order ⇒ order-independent topology
    let mut ordered: Vec<Vid> = pts.into_iter().collect();
    ordered.sort_by(|&a, &b| lex_cmp(interner, a, b));
    for p in ordered {
        insert_point(&mut mesh, interner, p);
    }
    Some(mesh)
}

/// Is `p` strictly OUTSIDE the closed triangle `(a,b,c)` (oriented `w0`)? — true
/// iff some edge has `p` on its far (opposite-`w0`) side. Used by the ear test:
/// an ear is valid only when every other vertex is strictly outside (a vertex on
/// the ear's boundary blocks it, else clipping leaves a degenerate sliver).
fn strictly_outside(it: &Interner, a: Vid, b: Vid, c: Vid, p: Vid, axis: DropAxis, w0: Sign) -> bool {
    let g = |v: Vid| it.get(v);
    let opp = w0.flip();
    orient2d_any(g(a), g(b), g(p), axis) == opp
        || orient2d_any(g(b), g(c), g(p), axis) == opp
        || orient2d_any(g(c), g(a), g(p), axis) == opp
}

/// PHASE E — triangulate a simple polygon `ring` (oriented `w0`) by deterministic
/// ear clipping. An ear is a strictly-convex corner whose triangle contains no
/// other ring vertex; among all ears we always clip the one with the
/// lexicographically-least APEX, so the output is a pure function of the ring
/// (independent of where the ring starts). The two-ears theorem guarantees a
/// simple polygon always has an ear → termination.
pub fn earcut(it: &Interner, ring: &[Vid], axis: DropAxis, w0: Sign) -> Vec<SubTri> {
    let mut poly: Vec<Vid> = ring.to_vec();
    let mut out = Vec::new();
    while poly.len() > 3 {
        let n = poly.len();
        let mut best: Option<usize> = None;
        for i in 0..n {
            let a = poly[(i + n - 1) % n];
            let b = poly[i];
            let c = poly[(i + 1) % n];
            // strictly convex under w0
            if orient2d_any(it.get(a), it.get(b), it.get(c), axis) != w0 {
                continue;
            }
            // empty: every other ring vertex is strictly outside the closed ear
            let empty = poly
                .iter()
                .all(|&v| v == a || v == b || v == c || strictly_outside(it, a, b, c, v, axis, w0));
            if !empty {
                continue;
            }
            best = Some(match best {
                None => i,
                Some(j) if cmp_lex(it.get(b), it.get(poly[j])) == Sign::Negative => i,
                Some(j) => j,
            });
        }
        let i = best.expect("earcut: no ear found — pocket is not a simple polygon");
        let n = poly.len();
        out.push([poly[(i + n - 1) % n], poly[i], poly[(i + 1) % n]]);
        poly.remove(i);
    }
    out.push([poly[0], poly[1], poly[2]]);
    out
}

#[inline]
fn tri_edges(t: SubTri) -> [(Vid, Vid); 3] {
    [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])]
}

/// Is there a triangle with both `s` and `t` as vertices? (In a triangle any two
/// vertices form an edge, so this is exactly "the segment s–t is already an edge".)
fn edge_exists(mesh: &Mesh2d, s: Vid, t: Vid) -> bool {
    mesh.tris.iter().any(|tri| tri.contains(&s) && tri.contains(&t))
}

/// Reverse `ring` if its winding doesn't match `w0`, so earcut sees a CCW polygon.
/// The lexicographically-least vertex is convex, so its turn gives the winding.
fn orient_ring(it: &Interner, ring: Vec<Vid>, axis: DropAxis, w0: Sign) -> Vec<Vid> {
    let n = ring.len();
    let i = (0..n).min_by(|&x, &y| lex_cmp(it, ring[x], ring[y])).unwrap();
    let w = orient2d_any(
        it.get(ring[(i + n - 1) % n]),
        it.get(ring[i]),
        it.get(ring[(i + 1) % n]),
        axis,
    );
    if w == w0 {
        ring
    } else {
        let mut r = ring;
        r.reverse();
        r
    }
}

/// PHASE D (core) — force sub-segment `(a,b)` (no vertex strictly between them) to
/// be an edge. If it already is, done. Otherwise delete the triangles the open
/// segment crosses (the "channel"), split the channel's boundary loop at `a` and
/// `b` into two pocket rings, and earcut each — after which `a–b` is a shared
/// edge of both pockets. (seg×seg — a crossed edge that is itself a constraint —
/// is a later increment.)
fn recover_subsegment(mesh: &mut Mesh2d, it: &Interner, a: Vid, b: Vid) {
    if edge_exists(mesh, a, b) {
        return;
    }
    let (axis, w0) = (mesh.axis, mesh.w0);
    let g = |v: Vid| it.get(v);
    // open segment (a,b) properly crosses open edge (u,v)?
    let crosses = |u: Vid, v: Vid| {
        let s1 = orient2d_any(g(a), g(b), g(u), axis);
        let s2 = orient2d_any(g(a), g(b), g(v), axis);
        let s3 = orient2d_any(g(u), g(v), g(a), axis);
        let s4 = orient2d_any(g(u), g(v), g(b), axis);
        s1 != Sign::Zero && s2 != Sign::Zero && s1 != s2
            && s3 != Sign::Zero && s4 != Sign::Zero && s3 != s4
    };
    let channel: Vec<usize> = (0..mesh.tris.len())
        .filter(|&ti| tri_edges(mesh.tris[ti]).iter().any(|&(u, v)| crosses(u, v)))
        .collect();
    if channel.is_empty() {
        return;
    }
    // boundary loop of the channel (directed edges whose reverse isn't internal)
    let channel_set: BTreeSet<usize> = channel.iter().copied().collect();
    let mut edges: BTreeSet<(Vid, Vid)> = BTreeSet::new();
    for &ti in &channel {
        for e in tri_edges(mesh.tris[ti]) {
            edges.insert(e);
        }
    }
    let mut next: BTreeMap<Vid, Vid> = BTreeMap::new();
    for &(u, v) in &edges {
        if !edges.contains(&(v, u)) {
            next.insert(u, v);
        }
    }
    let mut loop_v = vec![a];
    let mut cur = next[&a];
    while cur != a {
        loop_v.push(cur);
        cur = next[&cur];
    }
    let ib = loop_v.iter().position(|&x| x == b).expect("b not on channel boundary");
    let arc1: Vec<Vid> = loop_v[0..=ib].to_vec(); // a .. b
    let mut arc2: Vec<Vid> = loop_v[ib..].to_vec(); // b .. end
    arc2.push(a); // .. a
    mesh.tris = mesh
        .tris
        .iter()
        .enumerate()
        .filter(|(i, _)| !channel_set.contains(i))
        .map(|(_, t)| *t)
        .collect();
    for ring in [arc1, arc2] {
        if ring.len() >= 3 {
            let oriented = orient_ring(it, ring, axis, w0);
            mesh.tris.extend(earcut(it, &oriented, axis, w0));
        }
    }
}

/// Strictly-between test for COLLINEAR points: `v` lies strictly inside segment
/// `(s,t)`. The lex order equals the line order for collinear points, so `v` is
/// between iff it compares the same way against both ends.
fn between(it: &Interner, s: Vid, t: Vid, v: Vid) -> bool {
    let sv = cmp_lex(it.get(s), it.get(v));
    sv != Sign::Zero && sv == cmp_lex(it.get(v), it.get(t))
}

/// PHASE D — force constraint `(s,t)` to be a chain of edges: split it at any
/// mesh vertices lying strictly on it (collinear, ordered s→t), then recover each
/// sub-segment.
fn enforce_constraint(mesh: &mut Mesh2d, it: &Interner, s: Vid, t: Vid) {
    let axis = mesh.axis;
    let verts: BTreeSet<Vid> = mesh.tris.iter().flatten().copied().collect();
    let mut on_seg: Vec<Vid> = verts
        .into_iter()
        .filter(|&v| {
            v != s
                && v != t
                && orient2d_any(it.get(s), it.get(t), it.get(v), axis) == Sign::Zero
                && between(it, s, t, v)
        })
        .collect();
    on_seg.sort_by(|&x, &y| lex_cmp(it, x, y));
    if cmp_lex(it.get(s), it.get(t)) == Sign::Positive {
        on_seg.reverse(); // order from s toward t
    }
    let mut chain = vec![s];
    chain.extend(on_seg);
    chain.push(t);
    for w in chain.windows(2) {
        recover_subsegment(mesh, it, w[0], w[1]);
    }
}

/// Phases A–D: project, canonicalise, insert all constraint points, then force
/// every constraint to appear as an edge (chain). `None` ⇒ `T` is degenerate.
/// (seg×seg crossings and coplanar/touching cases are deferred increments.)
pub fn triangulate(input: &RetriInput, interner: &mut Interner) -> Option<Mesh2d> {
    let (axis, w0) = projection_axis(&input.tri)?;
    let canon = canonicalize(input, interner);
    let mut mesh = Mesh2d { tris: vec![canon.corners], axis, w0 };
    let mut pts: BTreeSet<Vid> = BTreeSet::new();
    for &(lo, hi) in &canon.segments {
        pts.insert(lo);
        pts.insert(hi);
    }
    for &c in &canon.corners {
        pts.remove(&c);
    }
    let mut ordered: Vec<Vid> = pts.into_iter().collect();
    ordered.sort_by(|&a, &b| lex_cmp(interner, a, b));
    for p in ordered {
        insert_point(&mut mesh, interner, p);
    }
    for &(s, t) in &canon.segments {
        enforce_constraint(&mut mesh, interner, s, t);
    }
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
    triangulation_topology_hash(&RetriInput { tri: t, constraints: cons })
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

    #[test]
    fn phase_c_covers_t_exactly_with_correct_orientation() {
        use super::super::rational::tri_area2;
        use num_rational::BigRational;
        use num_traits::Zero;
        let t = [[0., 0., 0.], [6., 0., 0.], [0., 6., 0.]]; // z=0, CCW
        let lpi = ImplicitPoint::Lpi(Lpi {
            p: [2., 2., -1.],
            q: [2., 2., 1.],
            r: [0., 0., 0.],
            s: [1., 0., 0.],
            t: [0., 1., 0.],
        }); // (2,2,0), interior
        let cons = vec![
            Constraint { a: lpi, b: e([3., 3., 0.]) }, // (3,3,0) on the hypotenuse x+y=6
            Constraint { a: e([1., 1., 0.]), b: e([4., 1., 0.]) },
        ];
        let mut it = Interner::new();
        let mesh = triangulate_points(&RetriInput { tri: t, constraints: cons }, &mut it).unwrap();
        // every sub-triangle is oriented w0 (none flipped or degenerate)
        for &tri in &mesh.tris {
            assert_eq!(
                orient2d_any(it.get(tri[0]), it.get(tri[1]), it.get(tri[2]), mesh.axis),
                mesh.w0,
                "sub-tri not oriented w0: {tri:?}"
            );
        }
        // exact coverage: Σ sub-triangle area == T's area
        let area2 = |tri: SubTri| {
            tri_area2(
                &point_of(it.get(tri[0])),
                &point_of(it.get(tri[1])),
                &point_of(it.get(tri[2])),
                mesh.axis,
            )
        };
        let sum = mesh.tris.iter().fold(BigRational::zero(), |acc, &tr| acc + area2(tr));
        let t_area = tri_area2(
            &point_of(&e(t[0])),
            &point_of(&e(t[1])),
            &point_of(&e(t[2])),
            mesh.axis,
        );
        assert_eq!(sum, t_area, "sub-triangles do not exactly cover T");
    }

    #[test]
    fn phase_c_topology_is_input_order_independent() {
        let t = [[0., 0., 0.], [5., 0., 0.], [0., 5., 0.]];
        let lpi = ImplicitPoint::Lpi(Lpi {
            p: [1., 1., -1.],
            q: [1., 1., 1.],
            r: [0., 0., 0.],
            s: [1., 0., 0.],
            t: [0., 1., 0.],
        });
        let c1 = Constraint { a: lpi, b: e([2., 2., 0.]) };
        let c2 = Constraint { a: e([3., 1., 0.]), b: e([1., 3., 0.]) };
        let topo = |cons: Vec<Constraint>| {
            let mut it = Interner::new();
            let mesh = triangulate_points(&RetriInput { tri: t, constraints: cons }, &mut it).unwrap();
            let mut tris: Vec<_> = mesh
                .tris
                .iter()
                .map(|&tri| {
                    let mut p = [
                        point_of(it.get(tri[0])),
                        point_of(it.get(tri[1])),
                        point_of(it.get(tri[2])),
                    ];
                    p.sort();
                    p
                })
                .collect();
            tris.sort();
            tris
        };
        assert_eq!(
            topo(vec![c1.clone(), c2.clone()]),
            topo(vec![c2, c1]),
            "Phase C topology depends on input order"
        );
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
                orient2d_any(it.get(tri[0]), it.get(tri[1]), it.get(tri[2]), axis),
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
        let mut mesh = Mesh2d { tris: vec![[a, b, c], [a, c, d]], axis: DropAxis::Z, w0: Sign::Positive };
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
                orient2d_any(it.get(tri[0]), it.get(tri[1]), it.get(tri[2]), mesh.axis),
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
        let mesh = triangulate(&RetriInput { tri: t, constraints: cons.clone() }, &mut it).unwrap();
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
                orient2d_any(it.get(tri[0]), it.get(tri[1]), it.get(tri[2]), mesh.axis),
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
