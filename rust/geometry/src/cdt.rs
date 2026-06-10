// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deterministic Constrained Delaunay Triangulation (CDT) with bounded
//! Ruppert/Chew min-angle refinement.
//!
//! ## Why this exists
//!
//! The coplanar-consolidation path (`csg.rs::consolidate_coplanar`) re-merges
//! per-plane CSG fragments via a 2D union and must re-triangulate the
//! resulting (possibly annular) regions. The previous implementation handed
//! these to greedy ear-clipping (`earcutr`), which fans a small opening notch
//! to a far boundary corner and produces high-aspect sliver triangles (worst
//! rim-incident aspect 25.28:1 on the real #1112 roof opening).
//!
//! This module replaces that with a real quality triangulator:
//!
//! 1. **Constrained Delaunay** over the boundary + hole rings (kept as hard
//!    constraint segments, so a hole stays a hole and the boundary is exact).
//!    The empty-circumcircle property alone already avoids the long ear-clip
//!    slivers.
//! 2. **Bounded Ruppert/Chew refinement**: insert the circumcenter of any
//!    skinny interior triangle; if that circumcenter would *encroach* a
//!    constraint segment (lie inside its diametral circle), split that segment
//!    at its midpoint instead — the classic Ruppert split that keeps the
//!    boundary/holes watertight and makes refinement terminate.
//!
//! ## Determinism (native == wasm)
//!
//! All arithmetic is plain `f64` — **no FMA, no transcendental tie-breaks**.
//! Orientation and in-circle SIGN decisions use Shewchuk's adaptive exact
//! predicates (`geometry_predicates::{orient2d, incircle}`), which are
//! sign-exact and bit-identical across x86_64 / aarch64 / wasm. Every worklist
//! is processed in a **canonical order** (point insertion in index order;
//! refinement queues drained by sorted/lowest-index triangle; segment splits
//! keyed by sorted integer tuples), never via `HashMap` iteration. The same
//! input therefore yields a byte-identical triangle list on every target,
//! which the mesh diff / `geom_hash` relies on.
//!
//! ## Watertightness & T-junctions
//!
//! Constraint segments are recovered exactly and never flipped or crossed. A
//! Steiner point that splits a constraint segment becomes a real shared vertex
//! and BOTH incident triangles are re-filled around it, so no T-junction is
//! left on a shared edge. Hole rings are excluded from the emitted domain by an
//! inside/outside flood-fill across constraint edges.
//!
//! ## Bound
//!
//! Refinement is capped three ways so it always terminates fast and never
//! explodes triangle count: a min-angle target (`COS_MIN_ANGLE`), a hard
//! Steiner-point budget proportional to the boundary size, and an absolute
//! iteration cap. On hitting any cap the CURRENT valid CDT is returned (still
//! constrained-Delaunay, still watertight) — quality is best-effort, validity
//! is not.

use crate::Point2;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// Target minimum angle for refinement, expressed as `cos(angle)` so the
/// skinny test is a transcendental-free `cos θ > COS_MIN_ANGLE` comparison (see
/// `tri_is_skinny`). 20.7° is the proven Ruppert termination ceiling; this is
/// `cos(22°)`, a compile-time literal so it is bit-identical on every platform
/// (computing it at runtime with `to_radians().cos()` would reintroduce a
/// platform-variant transcendental into the decision path).
const COS_MIN_ANGLE: f64 = 0.927_183_854_566_787_4; // cos(22°)

/// Secondary trigger: maximum acceptable edge-length aspect (longest/shortest).
const MAX_ASPECT: f64 = 7.0;

/// Absolute iteration cap on the refinement loop (independent of the budget).
const MAX_REFINE_ITERS: usize = 20_000;

type P2 = [f64; 2];
const NONE: usize = usize::MAX;

#[inline]
fn p2(p: &Point2<f64>) -> P2 {
    [p.x, p.y]
}

/// Exact orientation sign of `(a, b, c)`: `+1` CCW, `-1` CW, `0` collinear.
#[inline]
fn orient(a: P2, b: P2, c: P2) -> i32 {
    let d = geometry_predicates::orient2d(a, b, c);
    if d > 0.0 {
        1
    } else if d < 0.0 {
        -1
    } else {
        0
    }
}

/// Exact in-circle sign: `> 0` when `d` is strictly inside the circumcircle of
/// the CCW triangle `(a, b, c)`.
#[inline]
fn in_circle_sign(a: P2, b: P2, c: P2, d: P2) -> i32 {
    let v = geometry_predicates::incircle(a, b, c, d);
    if v > 0.0 {
        1
    } else if v < 0.0 {
        -1
    } else {
        0
    }
}

/// Canonical undirected-edge key (sorted vertex indices).
#[inline]
fn ekey(a: usize, b: usize) -> (usize, usize) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Triangle: CCW vertex triple + neighbour across each *edge*. Convention:
/// edge `e` runs `verts[e] -> verts[(e+1)%3]`, and `neighbor[e]` is the
/// triangle on the other side of that edge (`NONE` if none).
#[derive(Clone, Copy)]
struct Tri {
    v: [usize; 3],
    n: [usize; 3],
    alive: bool,
}

impl Tri {
    /// Local edge index (0,1,2) whose endpoints are `{a,b}`, or `None`.
    #[inline]
    fn edge_of(&self, a: usize, b: usize) -> Option<usize> {
        for e in 0..3 {
            let x = self.v[e];
            let y = self.v[(e + 1) % 3];
            if (x == a && y == b) || (x == b && y == a) {
                return Some(e);
            }
        }
        None
    }
}

struct Cdt {
    points: Vec<P2>,
    tris: Vec<Tri>,
    /// Constraint segments (canonical edge keys); never flipped, never crossed.
    constraints: BTreeSet<(usize, usize)>,
    n_input: usize,
    super_base: usize,
}

/// The next refinement step chosen for a triangulation (see `Cdt::next_action`).
#[derive(Clone, Copy, PartialEq)]
enum Action {
    /// Split this constraint segment at its midpoint.
    SplitSegment(usize, usize),
    /// Insert this circumcenter as a Steiner point.
    AddPoint(P2),
    /// Quality bound met everywhere — stop.
    Done,
}

impl Cdt {
    /// Build a CDT from an explicit point list + constraint segment list. The
    /// segment list is the source of truth for constraints (so refinement can
    /// add Steiner points and replace a segment with its two halves, then
    /// rebuild cleanly from scratch — no fragile in-place mutation).
    fn build_from(mut points: Vec<P2>, segments: &[(usize, usize)]) -> Option<Cdt> {
        let n_input = points.len();
        if n_input < 3 {
            return None;
        }
        let mut constraints = BTreeSet::new();
        for &(a, b) in segments {
            if a != b && a < n_input && b < n_input {
                constraints.insert(ekey(a, b));
            }
        }

        // Super-triangle containing every input point with wide clearance.
        let (mut minx, mut miny, mut maxx, mut maxy) =
            (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for p in &points {
            if !p[0].is_finite() || !p[1].is_finite() {
                return None;
            }
            minx = minx.min(p[0]);
            miny = miny.min(p[1]);
            maxx = maxx.max(p[0]);
            maxy = maxy.max(p[1]);
        }
        let span = (maxx - minx).max(maxy - miny);
        if !(span > 0.0) || !span.is_finite() {
            return None;
        }
        let cx = (minx + maxx) * 0.5;
        let cy = (miny + maxy) * 0.5;
        let big = span * 32.0;
        let super_base = points.len();
        points.push([cx - big, cy - big]);
        points.push([cx + big, cy - big]);
        points.push([cx, cy + big]);

        let mut cdt = Cdt {
            points,
            tris: Vec::new(),
            constraints,
            n_input,
            super_base,
        };
        cdt.tris.push(Tri {
            v: [super_base, super_base + 1, super_base + 2],
            n: [NONE; 3],
            alive: true,
        });

        // Incremental Delaunay insertion in canonical index order.
        for vi in 0..n_input {
            cdt.insert_point(vi);
        }
        if !cdt.enforce_constraints() {
            return None;
        }
        cdt.restore_constrained_delaunay();
        Some(cdt)
    }

    // ───────────────────────── Delaunay insertion ─────────────────────────

    fn insert_point(&mut self, vi: usize) {
        let p = self.points[vi];
        let Some(start) = self.locate(p) else {
            return;
        };

        // CONSTRAINED Bowyer-Watson cavity: alive triangles whose circumcircle
        // (strictly) contains p, found by BFS over adjacency from `start` — but
        // the cavity is NEVER allowed to cross a constraint edge. Blocking at
        // constraints keeps hole/boundary rings intact (a deleted triangle on
        // the far side of a constraint would dissolve the constraint and merge
        // a hole into the domain). The seed `start` contains p and is always
        // bad; expansion only crosses NON-constraint edges.
        let mut bad: Vec<usize> = Vec::new();
        let mut in_bad: BTreeSet<usize> = BTreeSet::new();
        let mut queue: VecDeque<usize> = VecDeque::new();
        queue.push_back(start);
        let mut visited: BTreeSet<usize> = BTreeSet::new();
        visited.insert(start);
        while let Some(ti) = queue.pop_front() {
            if !self.tris[ti].alive {
                continue;
            }
            let v = self.tris[ti].v;
            if in_circle_sign(self.points[v[0]], self.points[v[1]], self.points[v[2]], p) > 0 {
                bad.push(ti);
                in_bad.insert(ti);
                for e in 0..3 {
                    let a = v[e];
                    let b = v[(e + 1) % 3];
                    if self.constraints.contains(&ekey(a, b)) {
                        continue; // do not let the cavity swallow a constraint
                    }
                    let nb = self.tris[ti].n[e];
                    if nb != NONE && visited.insert(nb) {
                        queue.push_back(nb);
                    }
                }
            }
        }
        if bad.is_empty() {
            // No strictly-containing circumcircle (point on existing edge or
            // collinear). Split the containing triangle directly.
            self.split_in_triangle(start, vi);
            return;
        }

        // Cavity boundary: directed edges (a->b, CCW around the cavity) whose
        // outside triangle is NOT bad. Collect with the outside neighbour.
        let mut boundary: Vec<(usize, usize, usize)> = Vec::new();
        for &ti in &bad {
            let v = self.tris[ti].v;
            for e in 0..3 {
                let nb = self.tris[ti].n[e];
                if nb == NONE || !in_bad.contains(&nb) {
                    let a = v[e];
                    let b = v[(e + 1) % 3];
                    boundary.push((a, b, nb));
                }
            }
        }
        // Canonical order so new-triangle indices are platform-stable.
        boundary.sort_unstable();

        for &ti in &bad {
            self.tris[ti].alive = false;
        }

        // Fan: new triangle (a, b, vi) per boundary edge. (a,b,vi) is CCW
        // because (a->b) was CCW around the (convex) cavity and vi is inside.
        let mut owner: BTreeMap<(usize, usize), (usize, usize)> = BTreeMap::new();
        let mut new_tris: Vec<usize> = Vec::with_capacity(boundary.len());
        for &(a, b, outside) in &boundary {
            let ti = self.tris.len();
            self.tris.push(Tri {
                v: [a, b, vi],
                n: [NONE; 3],
                alive: true,
            });
            new_tris.push(ti);
            // edge 0 is a->b (outer); neighbour = outside triangle.
            self.tris[ti].n[0] = outside;
            if outside != NONE {
                if let Some(e) = self.tris[outside].edge_of(a, b) {
                    self.tris[outside].n[e] = ti;
                }
            }
            // edge 1 is b->vi ; edge 2 is vi->a — internal cavity edges.
            self.link_internal(&mut owner, ekey(b, vi), ti, 1);
            self.link_internal(&mut owner, ekey(vi, a), ti, 2);
        }

        // Legalize the outer edges (edge 0 of each new triangle).
        let mut stack: Vec<(usize, usize)> = new_tris.iter().map(|&t| (t, 0usize)).collect();
        self.legalize(&mut stack);
    }

    /// Wire adjacency for an internal cavity edge once both owners are known.
    fn link_internal(
        &mut self,
        owner: &mut BTreeMap<(usize, usize), (usize, usize)>,
        key: (usize, usize),
        ti: usize,
        e: usize,
    ) {
        if let Some(&(ot, oe)) = owner.get(&key) {
            self.tris[ti].n[e] = ot;
            self.tris[ot].n[oe] = ti;
        } else {
            owner.insert(key, (ti, e));
        }
    }

    /// Split a triangle that strictly contains `vi` (or has `vi` on an edge)
    /// into up to three children and legalize. Fallback for the no-bad-tri case.
    fn split_in_triangle(&mut self, t: usize, vi: usize) {
        if !self.tris[t].alive {
            return;
        }
        let v = self.tris[t].v;
        let n = self.tris[t].n;
        self.tris[t].alive = false;
        let mut owner: BTreeMap<(usize, usize), (usize, usize)> = BTreeMap::new();
        let mut children: Vec<usize> = Vec::new();
        for e in 0..3 {
            let a = v[e];
            let b = v[(e + 1) % 3];
            if orient(self.points[a], self.points[b], self.points[vi]) == 0 {
                continue; // degenerate child (vi on edge a-b)
            }
            let ti = self.tris.len();
            self.tris.push(Tri {
                v: [a, b, vi],
                n: [NONE; 3],
                alive: true,
            });
            children.push(ti);
            self.tris[ti].n[0] = n[e];
            if n[e] != NONE {
                if let Some(oe) = self.tris[n[e]].edge_of(a, b) {
                    self.tris[n[e]].n[oe] = ti;
                }
            }
            self.link_internal(&mut owner, ekey(b, vi), ti, 1);
            self.link_internal(&mut owner, ekey(vi, a), ti, 2);
        }
        let mut stack: Vec<(usize, usize)> = children.iter().map(|&c| (c, 0usize)).collect();
        self.legalize(&mut stack);
    }

    /// Lawson legalization. Each `(ti, e)` names an edge of a just-built
    /// triangle to test for the Delaunay (empty-circumcircle) condition.
    /// Constraint edges are skipped. Diagonal flips never touch constraints.
    fn legalize(&mut self, stack: &mut Vec<(usize, usize)>) {
        let mut guard = 0usize;
        while let Some((ti, e)) = stack.pop() {
            guard += 1;
            if guard > 4_000_000 {
                break;
            }
            if !self.tris[ti].alive {
                continue;
            }
            let a = self.tris[ti].v[e];
            let b = self.tris[ti].v[(e + 1) % 3];
            let apex = self.tris[ti].v[(e + 2) % 3];
            if self.constraints.contains(&ekey(a, b)) {
                continue;
            }
            let opp = self.tris[ti].n[e];
            if opp == NONE || !self.tris[opp].alive {
                continue;
            }
            // Opposite apex = vertex of `opp` not on edge a-b.
            let ov = self.tris[opp].v;
            let q = ov.iter().copied().find(|&x| x != a && x != b);
            let Some(q) = q else { continue };
            // Delaunay test on this triangle's circumcircle.
            let tv = self.tris[ti].v;
            if in_circle_sign(
                self.points[tv[0]],
                self.points[tv[1]],
                self.points[tv[2]],
                self.points[q],
            ) <= 0
            {
                continue;
            }
            // Convexity guard: the flip a-b -> apex-q is only legal when the
            // quad (a, apex, b, q) is strictly convex, i.e. `a` and `b` lie on
            // STRICTLY OPPOSITE sides of the new diagonal apex-q. If apex, a, q
            // (or apex, b, q) are collinear the flip would create a degenerate
            // zero-area triangle and a T-junction (e.g. a segment-split midpoint
            // collinear with the edge it replaced). Skip such non-convex flips.
            let sa = orient(self.points[apex], self.points[q], self.points[a]);
            let sb = orient(self.points[apex], self.points[q], self.points[b]);
            if sa == 0 || sb == 0 || sa == sb {
                continue;
            }
            self.flip(ti, opp, a, b, apex, q, stack);
        }
    }

    /// Flip shared edge `a-b` of triangles `ti=(…apex…)` / `opp=(…q…)` to the
    /// diagonal `apex-q`. Rebuilds both triangles CCW and re-links adjacency,
    /// then queues the four outer edges for re-legalization.
    #[allow(clippy::too_many_arguments)]
    fn flip(
        &mut self,
        ti: usize,
        opp: usize,
        a: usize,
        b: usize,
        apex: usize,
        q: usize,
        stack: &mut Vec<(usize, usize)>,
    ) {
        // Capture the four outer neighbours before rewriting.
        let outer = |s: &Self, t: usize, x: usize, y: usize| -> usize {
            s.tris[t].edge_of(x, y).map(|e| s.tris[t].n[e]).unwrap_or(NONE)
        };
        let n_apex_a = outer(self, ti, apex, a); // ti edge apex-a
        let n_apex_b = outer(self, ti, apex, b); // ti edge apex-b
        let n_q_a = outer(self, opp, q, a); // opp edge q-a
        let n_q_b = outer(self, opp, q, b); // opp edge q-b

        // Build the two CCW children of the quad (a, q, b, apex) split on apex-q.
        let mk = |s: &Self, x: usize, y: usize, z: usize| -> [usize; 3] {
            if orient(s.points[x], s.points[y], s.points[z]) >= 0 {
                [x, y, z]
            } else {
                [x, z, y]
            }
        };
        // T0 carries side `a`: (apex, q, a). T1 carries side `b`: (apex, q, b).
        let t0 = mk(self, apex, q, a);
        let t1 = mk(self, apex, q, b);
        self.tris[ti] = Tri {
            v: t0,
            n: [NONE; 3],
            alive: true,
        };
        self.tris[opp] = Tri {
            v: t1,
            n: [NONE; 3],
            alive: true,
        };

        let set_nb = |s: &mut Self, t: usize, x: usize, y: usize, val: usize| {
            if let Some(e) = s.tris[t].edge_of(x, y) {
                s.tris[t].n[e] = val;
            }
        };
        // Shared diagonal apex-q links the two.
        set_nb(self, ti, apex, q, opp);
        set_nb(self, opp, apex, q, ti);
        // ti = (apex,q,a): outer edges apex-a and q-a.
        set_nb(self, ti, apex, a, n_apex_a);
        set_nb(self, ti, q, a, n_q_a);
        // opp = (apex,q,b): outer edges apex-b and q-b.
        set_nb(self, opp, apex, b, n_apex_b);
        set_nb(self, opp, q, b, n_q_b);
        // Back-pointers on outer neighbours.
        if n_apex_a != NONE {
            if let Some(e) = self.tris[n_apex_a].edge_of(apex, a) {
                self.tris[n_apex_a].n[e] = ti;
            }
        }
        if n_q_a != NONE {
            if let Some(e) = self.tris[n_q_a].edge_of(q, a) {
                self.tris[n_q_a].n[e] = ti;
            }
        }
        if n_apex_b != NONE {
            if let Some(e) = self.tris[n_apex_b].edge_of(apex, b) {
                self.tris[n_apex_b].n[e] = opp;
            }
        }
        if n_q_b != NONE {
            if let Some(e) = self.tris[n_q_b].edge_of(q, b) {
                self.tris[n_q_b].n[e] = opp;
            }
        }

        // Queue the four outer edges.
        for (t, x, y) in [
            (ti, apex, a),
            (ti, q, a),
            (opp, apex, b),
            (opp, q, b),
        ] {
            if let Some(e) = self.tris[t].edge_of(x, y) {
                stack.push((t, e));
            }
        }
    }

    /// Locate an alive triangle whose closed region contains `p`. Canonical
    /// (ascending-index) linear scan — deterministic and robust; regions here
    /// are small so the O(n) cost is acceptable.
    fn locate(&self, p: P2) -> Option<usize> {
        let mut on_edge = None;
        for ti in 0..self.tris.len() {
            if !self.tris[ti].alive {
                continue;
            }
            let v = self.tris[ti].v;
            let o0 = orient(self.points[v[0]], self.points[v[1]], p);
            let o1 = orient(self.points[v[1]], self.points[v[2]], p);
            let o2 = orient(self.points[v[2]], self.points[v[0]], p);
            if o0 >= 0 && o1 >= 0 && o2 >= 0 {
                if o0 > 0 && o1 > 0 && o2 > 0 {
                    return Some(ti);
                }
                on_edge.get_or_insert(ti);
            }
        }
        on_edge
    }

    // ─────────────────────── constraint recovery ──────────────────────────

    /// Ensure every constraint segment appears as an edge of the triangulation.
    /// After Delaunay insertion of the ring vertices, most segments already
    /// exist; any missing one is recovered by flipping the diagonals that cross
    /// it. Returns false if a segment can't be recovered (caller falls back).
    fn enforce_constraints(&mut self) -> bool {
        let segs: Vec<(usize, usize)> = self.constraints.iter().copied().collect();
        for (a, b) in segs {
            if !self.recover_segment(a, b) {
                return false;
            }
        }
        true
    }

    /// Recover a single constraint segment `a-b` by repeatedly flipping the
    /// triangulation edge that crosses it. Deterministic: always processes the
    /// crossing edge nearest `a`.
    fn recover_segment(&mut self, a: usize, b: usize) -> bool {
        if self.edge_exists(a, b) {
            return true;
        }
        let pa = self.points[a];
        let pb = self.points[b];
        let mut guard = 0usize;
        loop {
            guard += 1;
            if guard > 100_000 {
                return false;
            }
            if self.edge_exists(a, b) {
                return true;
            }
            // Find an edge (u,v) strictly crossing segment a-b whose flip is
            // legal (the quad is convex). Scan triangles in index order for
            // determinism; pick the first crossing edge encountered.
            let mut flipped = false;
            'scan: for ti in 0..self.tris.len() {
                if !self.tris[ti].alive {
                    continue;
                }
                for e in 0..3 {
                    let u = self.tris[ti].v[e];
                    let w = self.tris[ti].v[(e + 1) % 3];
                    // Skip edges touching a or b (they can't strictly cross).
                    if u == a || u == b || w == a || w == b {
                        continue;
                    }
                    if self.constraints.contains(&ekey(u, w)) {
                        continue;
                    }
                    if !segments_properly_cross(pa, pb, self.points[u], self.points[w]) {
                        continue;
                    }
                    let opp = self.tris[ti].n[e];
                    if opp == NONE || !self.tris[opp].alive {
                        continue;
                    }
                    // Apex of ti opposite u-w, and apex of opp.
                    let apex = self.tris[ti].v[(e + 2) % 3];
                    let q = self.tris[opp]
                        .v
                        .iter()
                        .copied()
                        .find(|&x| x != u && x != w);
                    let Some(q) = q else { continue };
                    // Flip legal only if quad (u, apex, w, q) is convex, i.e.
                    // apex and q are on opposite sides of u-w (always true for
                    // a shared edge) AND the new diagonal apex-q stays inside.
                    if orient(self.points[u], self.points[apex], self.points[q]) == 0
                        || orient(self.points[w], self.points[apex], self.points[q]) == 0
                    {
                        continue;
                    }
                    // Convexity: apex and q must straddle line u-w (guaranteed),
                    // and u,w must straddle line apex-q for the flip to be valid.
                    let s1 = orient(self.points[apex], self.points[q], self.points[u]);
                    let s2 = orient(self.points[apex], self.points[q], self.points[w]);
                    if s1 == 0 || s2 == 0 || s1 == s2 {
                        continue; // non-convex quad; this diagonal can't flip
                    }
                    let mut tmp = Vec::new();
                    self.flip(ti, opp, u, w, apex, q, &mut tmp);
                    // Do NOT legalize here — constraint recovery must not
                    // re-introduce the crossing edge. Re-Delaunay happens after
                    // all constraints are in (constrained edges stay pinned).
                    flipped = true;
                    break 'scan;
                }
            }
            if !flipped {
                // No flippable crossing edge found — segment already present or
                // unrecoverable. Re-check existence at loop top.
                if self.edge_exists(a, b) {
                    return true;
                }
                return false;
            }
        }
    }

    #[inline]
    fn edge_exists(&self, a: usize, b: usize) -> bool {
        for ti in 0..self.tris.len() {
            if self.tris[ti].alive && self.tris[ti].edge_of(a, b).is_some() {
                return true;
            }
        }
        false
    }

    /// Restore the Delaunay property everywhere EXCEPT across constraint edges
    /// (constrained Delaunay). Pushes every non-constraint edge once.
    fn restore_constrained_delaunay(&mut self) {
        let mut stack: Vec<(usize, usize)> = Vec::new();
        for ti in 0..self.tris.len() {
            if self.tris[ti].alive {
                for e in 0..3 {
                    stack.push((ti, e));
                }
            }
        }
        self.legalize(&mut stack);
    }

    // ─────────────────────── domain classification ────────────────────────

    /// Mark which triangles are INSIDE the domain (outer ring minus holes).
    ///
    /// Single depth-parity flood from the unbounded outside: seed every alive
    /// triangle that touches a super-vertex at depth 0; BFS the whole adjacency
    /// graph, incrementing depth when an edge is a CONSTRAINT and keeping it
    /// when it is not. A triangle is INSIDE iff its depth is odd. This handles
    /// arbitrary nesting (outer ring = depth 1 = inside, holes inside it = depth
    /// 2 = outside, islands in holes = depth 3 = inside, …) and never depends on
    /// HashMap order. Triangles not reached from the super-vertices (isolated by
    /// a fully-constrained shell with no super-vertex contact) are resolved by a
    /// second pass that seeds the lowest-index unvisited triangle as outside;
    /// for the well-formed rings this path produces it is unreachable, but it
    /// keeps the classifier total.
    fn inside_flags(&self) -> Vec<bool> {
        let n = self.tris.len();
        let mut depth: Vec<i32> = vec![-1; n]; // -1 = unvisited
        let mut queue: VecDeque<usize> = VecDeque::new();

        // Seed depth 0 (outside) from every super-vertex-incident triangle.
        for ti in 0..n {
            if !self.tris[ti].alive {
                continue;
            }
            if self.tris[ti].v.iter().any(|&x| x >= self.super_base) {
                if depth[ti] == -1 {
                    depth[ti] = 0;
                    queue.push_back(ti);
                }
            }
        }

        let mut bfs = |start_queue: &mut VecDeque<usize>, depth: &mut [i32]| {
            while let Some(ti) = start_queue.pop_front() {
                let d = depth[ti];
                for e in 0..3 {
                    let nb = self.tris[ti].n[e];
                    if nb == NONE || !self.tris[nb].alive || depth[nb] != -1 {
                        continue;
                    }
                    let a = self.tris[ti].v[e];
                    let b = self.tris[ti].v[(e + 1) % 3];
                    let nd = if self.constraints.contains(&ekey(a, b)) {
                        d + 1
                    } else {
                        d
                    };
                    depth[nb] = nd;
                    start_queue.push_back(nb);
                }
            }
        };
        bfs(&mut queue, &mut depth);

        // Resolve any component the super-flood couldn't reach (defensive).
        for seed in 0..n {
            if self.tris[seed].alive && depth[seed] == -1 {
                depth[seed] = 0;
                let mut q2 = VecDeque::new();
                q2.push_back(seed);
                bfs(&mut q2, &mut depth);
            }
        }

        depth.iter().map(|&d| d > 0 && d % 2 == 1).collect()
    }

    // ──────────────────────────── refinement ──────────────────────────────

    /// Decide the NEXT refinement action for the current triangulation, without
    /// mutating it. Returns:
    /// * `Action::SplitSegment(a,b)` — a constraint segment is encroached (by a
    ///   vertex, or by the circumcenter of a skinny triangle); split it.
    /// * `Action::AddPoint(p)` — insert circumcenter `p` of a skinny interior
    ///   triangle (guaranteed not to encroach any constraint).
    /// * `Action::Done` — every interior triangle meets the quality bound.
    ///
    /// The driver in [`refine_to_fixpoint`] applies the action by editing the
    /// `(points, segments)` lists and REBUILDING a fresh CDT — so this method
    /// never performs fragile in-place topology surgery.
    /// `allow_segment_split` gates whether Ruppert may subdivide a CONSTRAINT
    /// (boundary / hole-ring) segment. The coplanar-consolidation caller sets it
    /// `false`: its region boundary is SHARED with neighbouring plane buckets
    /// that are triangulated independently, so a Steiner point on the boundary
    /// would create a T-junction / open edge at the bucket seam. With splits
    /// disabled, a skinny triangle whose circumcenter encroaches the boundary is
    /// simply LEFT as-is (best-effort quality) rather than torn — interior
    /// circumcenters are always safe because they never touch the boundary.
    fn next_action(&self, cos_min_angle: f64, allow_segment_split: bool) -> Action {
        // 1) Encroached constraint segment (Ruppert priority). Lowest-key first.
        if allow_segment_split {
            if let Some(seg) = self.find_encroached_segment() {
                return Action::SplitSegment(seg.0, seg.1);
            }
        }
        // 2) Worst skinny interior triangle (lowest index wins ties).
        let inside = self.inside_flags();
        for ti in 0..self.tris.len() {
            if !self.tris[ti].alive || !inside[ti] {
                continue;
            }
            if self.tris[ti].v.iter().any(|&x| x >= self.super_base) {
                continue;
            }
            if !self.tri_is_skinny(ti, cos_min_angle) {
                continue;
            }
            let Some(cc) = self.circumcenter(ti) else {
                continue; // degenerate; skip (don't spin)
            };
            // If the circumcenter would encroach a constraint:
            //  * split mode  → split the segment (classic Ruppert);
            //  * no-split mode → leave THIS triangle (skip), keeping the
            //    boundary untouched so bucket seams stay watertight.
            if let Some((a, b)) = self.encroached_by_point(cc) {
                if allow_segment_split {
                    return Action::SplitSegment(a, b);
                }
                continue;
            }
            // The circumcenter must fall inside the domain to be a valid Steiner
            // point. If it lands outside (numerical / near-boundary), skip this
            // triangle rather than inserting a stray point.
            match self.locate(cc) {
                Some(loc) if inside.get(loc).copied().unwrap_or(false) => {
                    return Action::AddPoint(cc);
                }
                _ => continue,
            }
        }
        Action::Done
    }

    /// A constraint segment is encroached if some OTHER vertex lies inside its
    /// diametral circle. Returns the lowest-key such segment.
    fn find_encroached_segment(&self) -> Option<(usize, usize)> {
        for &(a, b) in &self.constraints {
            let pa = self.points[a];
            let pb = self.points[b];
            // Diametral circle: center = midpoint, radius² = |ab|²/4.
            let mid = [(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5];
            let r2 = dist2(pa, pb) * 0.25;
            // Check every vertex that is a corner of a triangle incident to the
            // segment edge — but scanning all points is simplest & determinate.
            for vi in 0..self.points.len() {
                if vi == a || vi == b || vi >= self.super_base {
                    continue;
                }
                if dist2(self.points[vi], mid) < r2 * (1.0 - 1e-12) {
                    // Only counts if the vertex is "visible" — but for a valid
                    // CDT a strictly-inside diametral-circle vertex always
                    // encroaches. Return it.
                    return Some((a, b));
                }
            }
        }
        None
    }

    /// Does point `p` lie inside the diametral circle of any constraint
    /// segment? Returns the lowest-key such segment.
    fn encroached_by_point(&self, p: P2) -> Option<(usize, usize)> {
        for &(a, b) in &self.constraints {
            let pa = self.points[a];
            let pb = self.points[b];
            let mid = [(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5];
            let r2 = dist2(pa, pb) * 0.25;
            if dist2(p, mid) < r2 * (1.0 - 1e-12) {
                return Some((a, b));
            }
        }
        None
    }

    /// Is interior triangle `ti` skinny (smallest angle < the min-angle target)
    /// OR over the aspect bound?
    ///
    /// DETERMINISM: the angle test is done WITHOUT any transcendental. A
    /// triangle's smallest angle `θ` is opposite its shortest edge `e0`; by the
    /// law of cosines `cos θ = (e1² + e2² − e0²) / (2 e1 e2)`. Since `cos` is
    /// strictly decreasing on `[0, π]`, `θ < target` ⟺ `cos θ > cos(target)`,
    /// so we compare against the COMPILE-TIME constant `cos_min_angle`. Only
    /// `+ − × ÷` and IEEE-754 `sqrt` are used (all correctly-rounded, hence
    /// bit-identical across x86_64 / aarch64 / wasm) — no `acos`, whose last-ULP
    /// result varies between libm implementations and could flip a borderline
    /// skinny decision and desync native vs wasm output.
    fn tri_is_skinny(&self, ti: usize, cos_min_angle: f64) -> bool {
        let v = self.tris[ti].v;
        let a = self.points[v[0]];
        let b = self.points[v[1]];
        let c = self.points[v[2]];
        let la2 = dist2(b, c);
        let lb2 = dist2(c, a);
        let lc2 = dist2(a, b);
        let (mut e0, mut e1, mut e2) = (la2.sqrt(), lb2.sqrt(), lc2.sqrt());
        // sort ascending
        if e0 > e1 {
            std::mem::swap(&mut e0, &mut e1);
        }
        if e1 > e2 {
            std::mem::swap(&mut e1, &mut e2);
        }
        if e0 > e1 {
            std::mem::swap(&mut e0, &mut e1);
        }
        if e0 <= 1e-15 {
            return false; // degenerate; leave it (don't spin on it)
        }
        // Aspect trigger (longest/shortest edge).
        if e2 / e0 > MAX_ASPECT {
            return true;
        }
        // Smallest-angle trigger via cos comparison (no acos — see doc above).
        let cos_min = (e1 * e1 + e2 * e2 - e0 * e0) / (2.0 * e1 * e2);
        cos_min > cos_min_angle
    }

    /// Circumcenter of triangle `ti` (plain f64; deterministic). `None` if
    /// degenerate.
    fn circumcenter(&self, ti: usize) -> Option<P2> {
        let v = self.tris[ti].v;
        let a = self.points[v[0]];
        let b = self.points[v[1]];
        let c = self.points[v[2]];
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        let ex = c[0] - a[0];
        let ey = c[1] - a[1];
        let d = 2.0 * (dx * ey - dy * ex);
        if d.abs() < 1e-20 {
            return None;
        }
        let b2 = dx * dx + dy * dy;
        let c2 = ex * ex + ey * ey;
        let ux = (ey * b2 - dy * c2) / d;
        let uy = (dx * c2 - ex * b2) / d;
        let cc = [a[0] + ux, a[1] + uy];
        if !cc[0].is_finite() || !cc[1].is_finite() {
            return None;
        }
        Some(cc)
    }

    // ──────────────────────────── emit ────────────────────────────────────

    /// Emit the interior triangulation as a vertex list + index list. The
    /// vertex list is `points[0..n_input]` followed by every Steiner point
    /// (`points[n_input..super_base]`); the super-triangle vertices are dropped.
    fn emit(&self) -> (Vec<P2>, Vec<usize>) {
        let inside = self.inside_flags();
        // Compact vertex set: keep input + Steiner (drop super verts).
        let keep_upto = self.super_base; // points below super_base are real
        let out_points: Vec<P2> = self.points[..keep_upto].to_vec();
        let mut indices: Vec<usize> = Vec::new();
        for ti in 0..self.tris.len() {
            if !self.tris[ti].alive || !inside[ti] {
                continue;
            }
            let v = self.tris[ti].v;
            // Skip any triangle that (defensively) still references a super
            // vertex — it can't be interior, but guard anyway.
            if v.iter().any(|&x| x >= keep_upto) {
                continue;
            }
            // Ensure CCW emission (positive area) for a stable winding.
            let a = self.points[v[0]];
            let b = self.points[v[1]];
            let c = self.points[v[2]];
            if orient(a, b, c) >= 0 {
                indices.extend_from_slice(&[v[0], v[1], v[2]]);
            } else {
                indices.extend_from_slice(&[v[0], v[2], v[1]]);
            }
        }
        (out_points, indices)
    }
}

#[inline]
fn dist2(a: P2, b: P2) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    dx * dx + dy * dy
}

/// Do open segments `p1-p2` and `p3-p4` strictly cross (proper intersection,
/// not merely touching at an endpoint)? Exact via `orient`.
fn segments_properly_cross(p1: P2, p2: P2, p3: P2, p4: P2) -> bool {
    let d1 = orient(p3, p4, p1);
    let d2 = orient(p3, p4, p2);
    let d3 = orient(p1, p2, p3);
    let d4 = orient(p1, p2, p4);
    (d1 > 0 && d2 < 0 || d1 < 0 && d2 > 0) && (d3 > 0 && d4 < 0 || d3 < 0 && d4 > 0)
}

/// Build the initial (Steiner-free) constraint set + point list from rings.
/// `rings[0]` = outer, `rings[1..]` = holes. Returns `(points, segments)`.
fn rings_to_pslg(rings: &[Vec<P2>]) -> (Vec<P2>, Vec<(usize, usize)>) {
    let mut points: Vec<P2> = Vec::new();
    let mut segments: Vec<(usize, usize)> = Vec::new();
    for ring in rings {
        if ring.len() < 3 {
            continue;
        }
        let base = points.len();
        points.extend_from_slice(ring);
        let m = ring.len();
        for i in 0..m {
            let a = base + i;
            let b = base + (i + 1) % m;
            if a != b {
                segments.push(ekey(a, b));
            }
        }
    }
    (points, segments)
}

/// Run bounded Ruppert refinement on a planar straight-line graph (`points` +
/// `segments`) by REBUILDING a fresh CDT each round. Each round inserts at most
/// ONE Steiner point (a circumcenter) or splits ONE encroached segment, then
/// rebuilds — so every triangulation is a clean from-scratch build with no
/// fragile incremental topology surgery. Deterministic: the same PSLG yields the
/// same action sequence on every platform. Bounded by Steiner budget +
/// iteration cap.
fn refine_to_fixpoint(
    mut points: Vec<P2>,
    mut segments: Vec<(usize, usize)>,
    allow_segment_split: bool,
) -> Option<Cdt> {
    let n_input = points.len();
    let max_steiner = (n_input * 3).max(32);
    let mut steiner = 0usize;
    let mut cdt = Cdt::build_from(points.clone(), &segments)?;

    for _ in 0..MAX_REFINE_ITERS {
        if steiner >= max_steiner {
            break;
        }
        match cdt.next_action(COS_MIN_ANGLE, allow_segment_split) {
            Action::Done => break,
            Action::AddPoint(p) => {
                points.push(p);
                steiner += 1;
                match Cdt::build_from(points.clone(), &segments) {
                    Some(next) => cdt = next,
                    None => {
                        // Rebuild failed (numerical) — drop the point and stop
                        // with the last good triangulation.
                        points.pop();
                        break;
                    }
                }
            }
            Action::SplitSegment(a, b) => {
                let pa = points[a];
                let pb = points[b];
                let mid = [(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5];
                let vi = points.len();
                points.push(mid);
                // Replace segment a-b by its two halves (canonical keys).
                segments.retain(|&s| s != ekey(a, b));
                segments.push(ekey(a, vi));
                segments.push(ekey(vi, b));
                steiner += 1;
                match Cdt::build_from(points.clone(), &segments) {
                    Some(next) => cdt = next,
                    None => {
                        points.pop();
                        segments.retain(|&s| s != ekey(a, vi) && s != ekey(vi, b));
                        segments.push(ekey(a, b));
                        break;
                    }
                }
            }
        }
    }
    Some(cdt)
}

// ─────────────────────────── public entry points ──────────────────────────

/// Quality-triangulate a polygon-with-holes, returning the (possibly
/// Steiner-augmented) 2D vertex list and triangle indices into it.
///
/// `outer` is the boundary; `holes` are the holes. The returned vertex list
/// begins with exactly the input vertices in input order (`outer ++ holes`),
/// followed by any Steiner points; indices reference that combined list.
/// Returns `None` if the CDT can't be built (caller should fall back to
/// ear-clipping).
/// `allow_boundary_split`: when `true`, full Ruppert (may subdivide the outer /
/// hole rings to hit the angle target). When `false`, interior-only refinement
/// that NEVER touches the boundary — required when the boundary is shared with
/// other independently-triangulated regions (the coplanar-consolidation path),
/// so seams stay watertight / T-junction-free.
pub(crate) fn triangulate_refined(
    outer: &[Point2<f64>],
    holes: &[Vec<Point2<f64>>],
    allow_boundary_split: bool,
) -> Option<(Vec<Point2<f64>>, Vec<usize>)> {
    let mut rings: Vec<Vec<P2>> = Vec::with_capacity(1 + holes.len());
    rings.push(outer.iter().map(p2).collect());
    for h in holes {
        if h.len() >= 3 {
            rings.push(h.iter().map(p2).collect());
        }
    }
    let (points, segments) = rings_to_pslg(&rings);
    let cdt = refine_to_fixpoint(points, segments, allow_boundary_split)?;
    let (pts, idx) = cdt.emit();
    if idx.is_empty() {
        return None;
    }
    let out_pts: Vec<Point2<f64>> = pts.iter().map(|p| Point2::new(p[0], p[1])).collect();
    Some((out_pts, idx))
}

/// Quality-triangulate a simple polygon (no holes) WITHOUT adding Steiner
/// points: returns indices into the ORIGINAL `points` only. Used by callers
/// that cannot absorb new vertices (they map indices straight onto a fixed 3D
/// ring). Returns `None` if a constrained-Delaunay over just the input vertices
/// can't be produced (caller falls back to ear-clipping).
pub(crate) fn triangulate_simple_no_steiner(points: &[Point2<f64>]) -> Option<Vec<usize>> {
    let rings = vec![points.iter().map(p2).collect::<Vec<P2>>()];
    let (pts, segs) = rings_to_pslg(&rings);
    let cdt = Cdt::build_from(pts, &segs)?;
    let (_pts, idx) = cdt.emit();
    // All indices must reference original input points only (no Steiner here).
    if idx.is_empty() || idx.iter().any(|&i| i >= points.len()) {
        return None;
    }
    Some(idx)
}

/// Quality-triangulate a polygon-with-holes WITHOUT adding Steiner points:
/// indices reference the combined `outer ++ holes` vertex list only. For
/// callers that lay out exactly those vertices in 3D and index them directly.
pub(crate) fn triangulate_holes_no_steiner(
    outer: &[Point2<f64>],
    holes: &[Vec<Point2<f64>>],
) -> Option<Vec<usize>> {
    let mut rings: Vec<Vec<P2>> = Vec::with_capacity(1 + holes.len());
    rings.push(outer.iter().map(p2).collect());
    let mut total = outer.len();
    for h in holes {
        if h.len() >= 3 {
            rings.push(h.iter().map(p2).collect());
            total += h.len();
        }
    }
    let (pts, segs) = rings_to_pslg(&rings);
    let cdt = Cdt::build_from(pts, &segs)?;
    let (_pts, idx) = cdt.emit();
    if idx.is_empty() || idx.iter().any(|&i| i >= total) {
        return None;
    }
    Some(idx)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(x: f64, y: f64) -> Point2<f64> {
        Point2::new(x, y)
    }

    fn area_of(points: &[Point2<f64>], idx: &[usize]) -> f64 {
        let mut a = 0.0;
        for t in idx.chunks_exact(3) {
            let p0 = points[t[0]];
            let p1 = points[t[1]];
            let p2 = points[t[2]];
            a += ((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)).abs() * 0.5;
        }
        a
    }

    fn worst_aspect(points: &[Point2<f64>], idx: &[usize]) -> f64 {
        let mut worst = 0.0_f64;
        for t in idx.chunks_exact(3) {
            let p0 = points[t[0]];
            let p1 = points[t[1]];
            let p2 = points[t[2]];
            let d = |a: Point2<f64>, b: Point2<f64>| ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt();
            let e0 = d(p0, p1);
            let e1 = d(p1, p2);
            let e2 = d(p2, p0);
            let mn = e0.min(e1).min(e2);
            let mx = e0.max(e1).max(e2);
            if mn > 1e-12 {
                worst = worst.max(mx / mn);
            }
        }
        worst
    }

    #[test]
    fn refined_thin_strip_with_hole_no_far_corner_sliver() {
        // A long thin rectangle (40 x 1) with a small hole near the left end.
        // Ear-clipping fans the hole notch all the way to the far-right corner,
        // producing a ~25:1 sliver. The CDT+refine must keep it well bounded.
        let outer = vec![
            pt(0.0, 0.0),
            pt(40.0, 0.0),
            pt(40.0, 1.0),
            pt(0.0, 1.0),
        ];
        let hole = vec![
            pt(2.0, 0.4),
            pt(2.6, 0.4),
            pt(2.6, 0.6),
            pt(2.0, 0.6),
        ];
        let (pts, idx) =
            triangulate_refined(&outer, &[hole], true).expect("refined triangulation");
        assert_eq!(idx.len() % 3, 0);
        let wa = worst_aspect(&pts, &idx);
        assert!(
            wa <= 8.0,
            "thin-strip-with-hole worst aspect {wa:.2} should be <= 8 after refinement"
        );
    }

    /// Watertight + T-junction-free: every Steiner point on a shared edge must
    /// split BOTH incident triangles. We verify it via the mesh invariant: every
    /// interior triangle edge is shared by exactly one other emitted triangle
    /// (closed manifold interior), except boundary/hole-ring edges which are
    /// used exactly once. A T-junction would leave an interior edge used once
    /// (open) and its colliding vertex on a longer edge used once on the far
    /// side — counted here as a non-matching half-edge.
    #[test]
    fn refined_is_watertight_no_tjunction() {
        let outer = vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 1.0), pt(0.0, 1.0)];
        let hole = vec![pt(2.0, 0.4), pt(2.6, 0.4), pt(2.6, 0.6), pt(2.0, 0.6)];
        let (pts, idx) = triangulate_refined(&outer, &[hole], true).expect("triangulation");

        // Directed half-edge multiset: a watertight, T-junction-free interior
        // triangulation of a CCW domain has every interior edge appear once in
        // each direction; boundary/hole edges appear once total. So no UNDIRECTED
        // edge may be used by more than 2 triangles, and the count of edges used
        // exactly once equals the boundary perimeter vertex count.
        use std::collections::BTreeMap;
        let mut undirected: BTreeMap<(usize, usize), u32> = BTreeMap::new();
        for t in idx.chunks_exact(3) {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *undirected.entry(if a < b { (a, b) } else { (b, a) }).or_insert(0) += 1;
            }
        }
        // No non-manifold edges (used > 2): that is the signature of overlap.
        let non_manifold = undirected.values().filter(|&&c| c > 2).count();
        assert_eq!(non_manifold, 0, "found {non_manifold} non-manifold edges (overlap)");
        // Boundary edges (used once) must form closed rings: their total length
        // must equal the input boundary + hole perimeters (no T-junction gaps).
        let mut boundary_len = 0.0_f64;
        for (&(a, b), &c) in &undirected {
            if c == 1 {
                let pa = pts[a];
                let pb = pts[b];
                boundary_len += ((pa.x - pb.x).powi(2) + (pa.y - pb.y).powi(2)).sqrt();
            }
        }
        // outer perimeter 2*(40+1)=82 ; hole is 0.6 wide x 0.2 tall ->
        // perimeter 2*(0.6+0.2)=1.6. Boundary edges may be SPLIT by Steiner
        // points but the two halves still sum to the original edge length, so
        // the total once-used length is exactly the input perimeter.
        let expected = 82.0 + 1.6;
        assert!(
            (boundary_len - expected).abs() < 1e-6,
            "boundary length {boundary_len} != {expected}: a T-junction left a gap or overlap"
        );
    }

    #[test]
    fn refined_area_is_preserved() {
        let outer = vec![
            pt(0.0, 0.0),
            pt(10.0, 0.0),
            pt(10.0, 10.0),
            pt(0.0, 10.0),
        ];
        let hole = vec![
            pt(3.0, 3.0),
            pt(7.0, 3.0),
            pt(7.0, 7.0),
            pt(3.0, 7.0),
        ];
        let (pts, idx) = triangulate_refined(&outer, &[hole], true).expect("triangulation");
        let area = area_of(&pts, &idx);
        let expected = 100.0 - 16.0; // outer 10x10 minus 4x4 hole
        assert!(
            (area - expected).abs() < 1e-6,
            "area {area} should equal {expected} (outer minus hole)"
        );
    }

    #[test]
    fn refined_is_deterministic() {
        let outer = vec![
            pt(0.0, 0.0),
            pt(12.0, 0.0),
            pt(12.0, 3.0),
            pt(6.0, 5.0),
            pt(0.0, 3.0),
        ];
        let hole = vec![pt(4.0, 1.0), pt(8.0, 1.0), pt(6.0, 2.5)];
        let a = triangulate_refined(&outer, &[hole.clone()], true).unwrap();
        let b = triangulate_refined(&outer, &[hole.clone()], true).unwrap();
        // The full-Ruppert run must actually ADD Steiner points (otherwise this
        // would only exercise the base CDT, not the refinement loop).
        let n_input = outer.len() + hole.len();
        assert!(
            a.0.len() > n_input,
            "expected Steiner points to be added (got {} verts for {n_input} inputs)",
            a.0.len()
        );
        assert_eq!(a.1, b.1, "index lists must be identical run-to-run");
        assert_eq!(a.0.len(), b.0.len(), "vertex counts must match");
        for (pa, pb) in a.0.iter().zip(b.0.iter()) {
            assert_eq!(pa.x.to_bits(), pb.x.to_bits(), "x bits must be identical");
            assert_eq!(pa.y.to_bits(), pb.y.to_bits(), "y bits must be identical");
        }
    }

    #[test]
    fn no_steiner_square_is_two_triangles() {
        let sq = vec![pt(0.0, 0.0), pt(1.0, 0.0), pt(1.0, 1.0), pt(0.0, 1.0)];
        let idx = triangulate_simple_no_steiner(&sq).expect("square");
        assert_eq!(idx.len(), 6);
        assert!(idx.iter().all(|&i| i < 4));
        let pts = sq.clone();
        assert!((area_of(&pts, &idx) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn no_steiner_square_with_hole_preserves_hole() {
        let outer = vec![
            pt(0.0, 0.0),
            pt(10.0, 0.0),
            pt(10.0, 10.0),
            pt(0.0, 10.0),
        ];
        let hole = vec![
            pt(3.0, 3.0),
            pt(7.0, 3.0),
            pt(7.0, 7.0),
            pt(3.0, 7.0),
        ];
        let idx = triangulate_holes_no_steiner(&outer, &[hole.clone()]).expect("holes");
        let mut pts = outer.clone();
        pts.extend(hole);
        let area = area_of(&pts, &idx);
        assert!(
            (area - 84.0).abs() < 1e-6,
            "area {area} should be 84 (100 - 16 hole)"
        );
    }
}
