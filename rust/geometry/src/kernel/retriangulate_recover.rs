// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PHASE D — constraint recovery for [`super::retriangulate::triangulate`].
//!
//! Forces every intersection sub-segment to appear as an edge of the face's
//! re-triangulation. [`enforce_constraint`] splits a constraint at the vertices
//! that lie on it, then [`recover_subsegment`] rebuilds the channel of crossed
//! triangles as two pocket rings sharing the segment. When that boundary-walk
//! bails on a dense self-touching channel, [`recover_via_traversal`] recovers
//! the edge by an ordered segment walk (Sloan) instead (the ara3d ISSUE_098
//! dense faceted-BREP reveal walls).

use super::interner::{Interner, Vid};
use super::retriangulate::{
    cmp_lex_v, coord2d_cached, earcut, edge_exists, insert_point, lex_cmp, orient2d_v, orient_ring,
    tri_aabb_disjoint, tri_edges, Mesh2d, SubTri, PREFILTER_MIN,
};
use super::retriangulate_audit::pocket_rebuild_valid;
use super::Sign;
use std::collections::{BTreeMap, BTreeSet};

/// PHASE D (core) — force sub-segment `(a,b)` (no vertex strictly between them) to
/// be an edge. If it already is, done. Otherwise delete the triangles the open
/// segment crosses (the "channel"), split the channel's boundary loop at `a` and
/// `b` into two pocket rings, and earcut each — after which `a–b` is a shared
/// edge of both pockets. (seg×seg — a crossed edge that is itself a constraint —
/// is a later increment.)
pub(crate) fn recover_subsegment(mesh: &mut Mesh2d, it: &Interner, a: Vid, b: Vid) {
    if edge_exists(mesh, a, b) {
        return;
    }
    // Pessimistically request the final conformity audit; restored below only
    // when this recovery demonstrably forced the edge (a PREVIOUS attempt's
    // request must survive). Every bail path (empty or degenerate channel,
    // non-star swallowed endpoint, earcut failure) leaves it set.
    let audit_before = mesh.audit_needed;
    mesh.audit_needed = true;

    let (axis, w0) = (mesh.axis, mesh.w0);
    // Does any open edge of `tri` PROPERLY cross the open segment (a,b)? The
    // dominant cost of constraint recovery (#1109): runs per triangle for every
    // constraint sub-segment. Each vertex's side of the (a,b) line is computed
    // ONCE (a triangle has only THREE vertices); an edge can only cross when its
    // endpoints straddle that line (opposite nonzero signs), and only then run
    // the reciprocal `orient(edge, a/b)` tests. Identical exact result to the
    // per-edge form, ~3 predicates/triangle instead of up to 12 - byte-identical
    // channel, parity preserved.
    let tri_crosses = |tri: SubTri| {
        let s = [
            orient2d_v(it, a, b, tri[0], axis),
            orient2d_v(it, a, b, tri[1], axis),
            orient2d_v(it, a, b, tri[2], axis),
        ];
        for k in 0..3 {
            let (su, sv) = (s[k], s[(k + 1) % 3]);
            if su == Sign::Zero || sv == Sign::Zero || su == sv {
                continue; // endpoints don't straddle (a,b) ⇒ no proper crossing
            }
            let (u, v) = (tri[k], tri[(k + 1) % 3]);
            let s3 = orient2d_v(it, u, v, a, axis);
            if s3 == Sign::Zero {
                continue;
            }
            let s4 = orient2d_v(it, u, v, b, axis);
            if s4 != Sign::Zero && s3 != s4 {
                return true;
            }
        }
        false
    };
    // Broadphase: only a triangle whose widened 2D f64 AABB overlaps the (a,b)
    // segment's AABB can properly cross it; skip the exact tests otherwise. The
    // margin is conservative (a crossing triangle is never skipped on any
    // platform), so the channel - and recovery - is byte-identical. Engaged
    // only once the triangle set is large enough to amortise the cache.
    let ab_box: Option<[f64; 4]> = if mesh.tris.len() > PREFILTER_MIN {
        match (
            coord2d_cached(it, a, axis, &mut mesh.coords),
            coord2d_cached(it, b, axis, &mut mesh.coords),
        ) {
            (Some(a2), Some(b2)) => Some([
                a2[0].min(b2[0]),
                a2[1].min(b2[1]),
                a2[0].max(b2[0]),
                a2[1].max(b2[1]),
            ]),
            _ => None,
        }
    } else {
        None
    };
    let channel: Vec<usize> = (0..mesh.tris.len())
        .filter(|&ti| {
            let tri = mesh.tris[ti];
            if let Some(bx) = ab_box {
                if tri_aabb_disjoint(it, tri, bx, axis, &mut mesh.coords) {
                    return false;
                }
            }
            tri_crosses(tri)
        })
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
    // Walk the boundary loop. A degenerate channel (non-simply-connected region,
    // or a branching boundary) yields a non-traversable loop - bail gracefully
    // (leave the constraint unrecovered) rather than panic; the triangulation
    // stays valid. The walk starts at `a` when `a` is on the boundary; otherwise
    // at the lexicographically-least boundary vertex (deterministic - Vids and
    // BTreeMap order are platform-stable). `a`/`b` can legitimately be channel-
    // INTERIOR vertices: a long skinny fan triangle incident to the endpoint can
    // re-cross the open segment far from the endpoint, putting the endpoint's
    // whole fan in the channel (the 559171 back-face door jamb - the endpoint is
    // then "swallowed" exactly like 552611's corner, but the a-b pocket split
    // can't run). See the (ia, ib) match below for that case.
    let start = if next.contains_key(&a) {
        a
    } else {
        match next.keys().next() {
            Some(&v) => v,
            None => return,
        }
    };
    let mut loop_v = vec![start];
    let mut cur = match next.get(&start) {
        Some(&v) => v,
        None => return,
    };
    while cur != start {
        loop_v.push(cur);
        cur = match next.get(&cur) {
            Some(&v) => v,
            None => return,
        };
        if loop_v.len() > next.len() + 1 {
            return; // cycle that never returns to the start — degenerate
        }
    }
    // Vertices STRICTLY INTERIOR to the channel (every incident triangle is in
    // the channel, so none of their edges reach the boundary loop): the segment
    // passes so close to a vertex that it properly crosses ALL of the vertex's
    // fan spokes (552611: the tiny middle-quad diagonal (5.027,3.800)->(5.142,3.5)
    // swallows the corner (5.142,3.800) of the adjacent through-slot rectangle).
    // The pocket-ring rebuild below would silently DESTROY such vertices - and
    // every previously-enforced constraint edge through them - leaving host
    // sub-triangles that overlap the cutter footprint (the 552611 4x over-cut).
    // Re-insert them after the rebuild; the enforcement fixed-point loop in
    // [`triangulate`] then re-forces any constraint edge the rebuild broke.
    let loop_set: BTreeSet<Vid> = loop_v.iter().copied().collect();
    let mut lost: Vec<Vid> = channel
        .iter()
        .flat_map(|&ti| mesh.tris[ti])
        .filter(|v| !loop_set.contains(v))
        .collect::<BTreeSet<Vid>>()
        .into_iter()
        .collect();
    lost.sort_by(|&x, &y| lex_cmp(it, x, y)); // deterministic re-insert order
    let ia = loop_v.iter().position(|&x| x == a);
    let ib = loop_v.iter().position(|&x| x == b);
    // The replacement triangles for the channel region: either two earcut
    // pocket rings split along a–b (the normal case), or — when a constraint
    // ENDPOINT is itself channel-interior — a star fan from that endpoint.
    let mut new_tris: Vec<[Vid; 3]> = Vec::new();
    let mut fan_hub: Option<Vid> = None;
    match (ia, ib) {
        (Some(ia), Some(ib)) => {
            // Both endpoints on the boundary: rotate the loop to start at `a`,
            // split at `b` into the two pocket rings — after the earcut `a–b`
            // is a shared edge of both pockets.
            let n = loop_v.len();
            let rot: Vec<Vid> = (0..n).map(|k| loop_v[(ia + k) % n]).collect();
            let jb = (ib + n - ia) % n;
            let arc1: Vec<Vid> = rot[0..=jb].to_vec(); // a .. b
            let mut arc2: Vec<Vid> = rot[jb..].to_vec(); // b .. end
            arc2.push(a); // .. a
            for ring in [arc1, arc2] {
                if ring.len() >= 3 {
                    let oriented = orient_ring(it, ring, axis, w0);
                    new_tris.extend(earcut(it, &oriented, axis, w0));
                }
            }
        }
        _ => {
            // A constraint endpoint is channel-INTERIOR (swallowed): a long
            // skinny fan triangle incident to the endpoint re-crosses the open
            // segment far away, so the endpoint's entire fan is in the channel
            // and the a–b pocket split can't run. Bailing here (the pre-fix
            // behavior) left sub-triangles STRADDLING the unrecovered
            // constraint, whose centroids misclassify — the disjoint-cutter
            // over-cut family (#559171: the door jamb never carved into the
            // back face ⇒ −0.43 m³ + 14 open edges). When the channel region
            // is STAR-SHAPED from the swallowed endpoint (every boundary edge
            // subtends a strictly-w0 triangle — the typical skinny-fan case),
            // re-triangulate it as the fan from that endpoint: the fan
            // contains the edge from the endpoint to EVERY boundary vertex,
            // including the other constraint endpoint ⇒ (a,b) is recovered in
            // THIS pass. Otherwise rebuild the region as one earcut ring and
            // let the fixed-point loop retry.
            let inner = if ia.is_none() { a } else { b };
            let oriented = orient_ring(it, loop_v.clone(), axis, w0);
            let n = oriented.len();
            let star = !loop_set.contains(&inner)
                && (0..n).all(|k| {
                    orient2d_v(it, inner, oriented[k], oriented[(k + 1) % n], axis) == w0
                });
            if star {
                for k in 0..n {
                    new_tris.push([inner, oriented[k], oriented[(k + 1) % n]]);
                }
                fan_hub = Some(inner);
            } else {
                new_tris.extend(earcut(it, &oriented, axis, w0));
            }
        }
    }
    mesh.tris = mesh
        .tris
        .iter()
        .enumerate()
        .filter(|(i, _)| !channel_set.contains(i))
        .map(|(_, t)| *t)
        .collect();
    mesh.tris.extend(new_tris);
    for v in lost {
        if Some(v) == fan_hub {
            continue; // already a vertex of every fan triangle
        }
        insert_point(mesh, it, v);
    }
    if edge_exists(mesh, a, b) {
        mesh.audit_needed = audit_before; // forced — THIS attempt needs no audit
    }
}

/// Strictly-between test for COLLINEAR points: `v` lies strictly inside segment
/// `(s,t)`. The lex order equals the line order for collinear points, so `v` is
/// between iff it compares the same way against both ends.
pub(crate) fn between(it: &Interner, s: Vid, t: Vid, v: Vid) -> bool {
    let sv = cmp_lex_v(it, s, v);
    sv != Sign::Zero && sv == cmp_lex_v(it, v, t)
}

/// PHASE D — force constraint `(s,t)` to be a chain of edges: split it at any
/// mesh vertices lying strictly on it (collinear, ordered s→t), then recover each
/// sub-segment.
/// ROBUST constraint recovery by ORDERED segment traversal (Sloan) — the fallback
/// for `recover_subsegment`. Walks the triangles the open segment `(a,b)` crosses
/// IN ORDER from `a` to `b`, building the two boundary chains directly (upper =
/// the `w0` side of directed line a→b, lower = the other). Because the traversal
/// is ordered ALONG the segment rather than around the channel's edge topology,
/// it is immune to the figure-8 pinch (a channel vertex on the boundary twice)
/// that makes `recover_subsegment`'s boundary walk non-traversable on dense wall
/// faces cut by many windows (issue #098 V5C). It removes the crossed triangles
/// and earcuts the two chains, each closed by `a–b`, forcing `a–b` as their
/// shared edge. Leaves the mesh UNCHANGED (constraint stays unrecovered, never
/// wrong geometry) if the traversal can't start or complete, or if the rebuilt
/// cover fails [`pocket_rebuild_valid`]. Only runs when the fast path failed.
pub(crate) fn recover_via_traversal(mesh: &mut Mesh2d, it: &Interner, a: Vid, b: Vid) {
    let (axis, w0) = (mesh.axis, mesh.w0);
    // Undirected edge -> the (≤2) triangles using it.
    let mut adj: BTreeMap<(Vid, Vid), Vec<usize>> = BTreeMap::new();
    for (ti, t) in mesh.tris.iter().enumerate() {
        for (u, v) in tri_edges(*t) {
            adj.entry(if u < v { (u, v) } else { (v, u) }).or_default().push(ti);
        }
    }
    // Entry triangle at `start`: the one whose opposite edge (u,v) the segment
    // start→end properly CROSSES — u,v straddle line start→end AND start,end
    // straddle line (u,v). The second test matters: without it a complex fan
    // around `start` admits a farther wedge triangle whose edge the segment
    // crosses AWAY from `end`, and the walk overshoots to the mesh boundary (the
    // near-degenerate reveal-step segments, #098 V5C). `eu` is on the `w0` side.
    let find_entry = |start: Vid, end: Vid| -> Option<(usize, Vid, Vid)> {
        for (ti, t) in mesh.tris.iter().enumerate() {
            let Some(ai) = (0..3).find(|&k| t[k] == start) else { continue };
            let (u, v) = (t[(ai + 1) % 3], t[(ai + 2) % 3]);
            let (su, sv) = (orient2d_v(it, start, end, u, axis), orient2d_v(it, start, end, v, axis));
            let (sa, sb) = (orient2d_v(it, u, v, start, axis), orient2d_v(it, u, v, end, axis));
            if su == Sign::Zero || sv == Sign::Zero || su == sv {
                continue;
            }
            if sa == Sign::Zero || sb == Sign::Zero || sa == sb {
                continue;
            }
            return Some(if su == w0 { (ti, u, v) } else { (ti, v, u) });
        }
        None
    };
    // Endpoint order doesn't change the forced edge: try end→start if start has none.
    let (a, b, entry) = if let Some(en) = find_entry(a, b) {
        (a, b, en)
    } else if let Some(en) = find_entry(b, a) {
        (b, a, en)
    } else {
        return;
    };
    let side = |x: Vid| orient2d_v(it, a, b, x, axis);
    let (mut cur_tri, mut eu, mut ev) = entry; // eu: w0 side, ev: other
    let mut upper = vec![a, eu];
    let mut lower = vec![a, ev];
    let mut crossed = vec![cur_tri];
    loop {
        let key = if eu < ev { (eu, ev) } else { (ev, eu) };
        let Some(&nt) = adj.get(&key).and_then(|ts| ts.iter().find(|&&t| t != cur_tri)) else {
            return; // crossed edge is a mesh boundary — degenerate, bail unchanged
        };
        let apex = match mesh.tris[nt].iter().copied().find(|&x| x != eu && x != ev) {
            Some(x) => x,
            None => return,
        };
        crossed.push(nt);
        if apex == b {
            upper.push(b);
            lower.push(b);
            break;
        }
        match side(apex) {
            s if s == w0 => {
                upper.push(apex);
                eu = apex;
            }
            Sign::Zero => return, // apex on the line but not b — should've split; bail
            _ => {
                lower.push(apex);
                ev = apex;
            }
        }
        cur_tri = nt;
        if crossed.len() > mesh.tris.len() {
            return; // safety: never loop past the triangle count
        }
    }
    let mut new_tris: Vec<SubTri> = Vec::new();
    for chain in [upper, lower] {
        if chain.len() >= 3 {
            let ring = orient_ring(it, chain, axis, w0);
            new_tris.extend(earcut(it, &ring, axis, w0));
        }
    }
    // Post-condition (#1660 follow-up): reject a degenerate/overlapping rebuilt
    // cover - bail UNCHANGED so the audit counts the edge unrecovered.
    if !pocket_rebuild_valid(&new_tris) {
        return;
    }
    let crossed_set: BTreeSet<usize> = crossed.into_iter().collect();
    mesh.tris = mesh
        .tris
        .iter()
        .enumerate()
        .filter(|(i, _)| !crossed_set.contains(i))
        .map(|(_, t)| *t)
        .collect();
    mesh.tris.extend(new_tris);
}

pub(crate) fn enforce_constraint(mesh: &mut Mesh2d, it: &Interner, s: Vid, t: Vid) {
    let axis = mesh.axis;
    let verts: BTreeSet<Vid> = mesh.tris.iter().flatten().copied().collect();
    // Broadphase: a vertex collinear with AND between s,t must lie in the
    // segment's 2D f64 AABB. Skip the (i1024, WASM-emulated) exact orient2d for
    // vertices outside the widened box. Same conservative margin as the
    // insert_point prefilter ⇒ a real on-segment vertex is never skipped on any
    // platform, so `on_seg` — and the recovered topology — is byte-identical.
    // This is the hot loop: enforce runs per constraint per fixed-point pass, so
    // the unfiltered O(verts) exact scan is what stalls many-opening facades.
    // Engaged only once the vertex set is large enough to amortise the cache.
    let seg_box: Option<[f64; 4]> = if verts.len() > PREFILTER_MIN {
        match (
            coord2d_cached(it, s, axis, &mut mesh.coords),
            coord2d_cached(it, t, axis, &mut mesh.coords),
        ) {
            (Some(s2), Some(t2)) => Some([
                s2[0].min(t2[0]),
                s2[1].min(t2[1]),
                s2[0].max(t2[0]),
                s2[1].max(t2[1]),
            ]),
            _ => None,
        }
    } else {
        None
    };
    let mut on_seg: Vec<Vid> = verts
        .into_iter()
        .filter(|&v| {
            if v == s || v == t {
                return false;
            }
            if let Some(bx) = seg_box {
                if let Some(vc) = coord2d_cached(it, v, axis, &mut mesh.coords) {
                    let mx = 1e-6 + vc[0].abs() * 1e-9;
                    let my = 1e-6 + vc[1].abs() * 1e-9;
                    if vc[0] < bx[0] - mx
                        || vc[0] > bx[2] + mx
                        || vc[1] < bx[1] - my
                        || vc[1] > bx[3] + my
                    {
                        return false; // outside segment AABB ⇒ cannot lie on it
                    }
                }
            }
            orient2d_v(it, s, t, v, axis) == Sign::Zero && between(it, s, t, v)
        })
        .collect();
    on_seg.sort_by(|&x, &y| lex_cmp(it, x, y));
    if cmp_lex_v(it, s, t) == Sign::Positive {
        on_seg.reverse(); // order from s toward t
    }
    let mut chain = vec![s];
    chain.extend(on_seg);
    chain.push(t);
    for w in chain.windows(2) {
        recover_subsegment(mesh, it, w[0], w[1]);
        // Robust fallback for the dense-face constraints the boundary-walk pocket
        // split can't force (issue #098 V5C). Only runs on that failure, so the
        // common path stays byte-identical.
        if !edge_exists(mesh, w[0], w[1]) {
            recover_via_traversal(mesh, it, w[0], w[1]);
        }
    }
}
