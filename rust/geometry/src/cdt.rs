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
//! 2. **Bounded, interior-only Ruppert/Chew refinement**: insert the
//!    circumcenter of any skinny interior triangle. The constraint segments
//!    (boundary + hole rings) are NEVER split — the sole production caller
//!    (`consolidate_coplanar`) re-triangulates a region whose boundary is
//!    SHARED with neighbouring plane buckets triangulated independently, so a
//!    boundary Steiner point would open a T-junction at the bucket seam. A
//!    skinny triangle whose circumcenter would *encroach* a constraint segment
//!    (lie inside its diametral circle) is simply left as-is (best-effort
//!    quality, not torn) instead of splitting the segment.
//!
//! ## Determinism (native == wasm)
//!
//! All arithmetic is plain `f64` — **no FMA, no transcendental tie-breaks**.
//! Orientation and in-circle SIGN decisions use Shewchuk's adaptive exact
//! predicates (`geometry_predicates::{orient2d, incircle}`), which are
//! sign-exact and bit-identical across x86_64 / aarch64 / wasm. Every worklist
//! is processed in a **canonical order** (point insertion in index order;
//! refinement queues drained by sorted/lowest-index triangle), never via
//! `HashMap` iteration. The same input therefore yields a byte-identical
//! triangle list on every target, which the mesh diff / `geom_hash` relies on.
//!
//! ## Watertightness & T-junctions
//!
//! Constraint segments are recovered exactly and never flipped, crossed, or
//! split — refinement only ever inserts a Steiner point strictly INTERIOR to
//! the domain, so the boundary/hole rings a caller shares across independently
//! triangulated regions are never touched (no T-junction risk there). An
//! interior Steiner point still splits every triangle incident to its
//! insertion cavity in lockstep, so no T-junction is left on a shared interior
//! edge either. Hole rings are excluded from the emitted domain by an
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

mod predicates;

use crate::Point2;
use predicates::{dist2, rings_to_pslg, segments_properly_cross, strictly_between};
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
    /// `[0, n_real)` = input then Steiner points; `[n_real, super_base)` = the
    /// PRE-RESERVED Steiner slots (placeholders, never referenced by a triangle);
    /// `[super_base, super_base+3)` = the super triangle.
    points: Vec<P2>,
    tris: Vec<Tri>,
    /// Constraint segments (canonical edge keys); never flipped, never crossed.
    /// Ord-keyed so the recovery ORDER in [`Cdt::enforce_constraints`] is
    /// target-independent.
    constraints: BTreeSet<(usize, usize)>,
    /// Membership-only mirror of `constraints`. The cavity BFS, legalization
    /// and the depth-parity flood probe it millions of times per model and only
    /// ever ask "is this edge pinned?", where a tree walk is pure overhead;
    /// every mutation of `constraints` updates both.
    cset: rustc_hash::FxHashSet<(usize, usize)>,
    /// Index of the first super-triangle vertex. FIXED at build time (the
    /// Steiner budget is reserved below it), so a refinement insertion never
    /// renumbers vertices — see [`Cdt::insert_steiner`].
    super_base: usize,
    /// Count of REAL points in use (input + Steiner emitted so far).
    n_real: usize,
    /// Walk-locate hint: a triangle incident to the last inserted point.
    last_loc: usize,
    /// Broad-phase for [`Cdt::is_encroached`], (re)built at
    /// [`Cdt::start_refinement`] and invalidated by a constraint split.
    enc: EncGrid,
    /// Per-triangle inside-domain flag, parallel to `tris`. Maintained
    /// incrementally during NO-SPLIT refinement (after [`Cdt::start_refinement`]):
    /// a flip reuses its two slots within one region (a flipped edge is never a
    /// constraint, so both sides share a region), and a cavity re-fan inherits
    /// the seed's region (the cavity BFS never crosses a constraint). Garbage
    /// before `start_refinement`; [`Cdt::emit`] always recomputes from scratch.
    inside: Vec<bool>,
    /// Ordered worklist of skinny-candidate triangle indices for incremental
    /// refinement. Entries are validated lazily on pop; slot rewrites re-evaluate
    /// via [`Cdt::track_tri`]. Empty / unused outside refinement.
    skinny: BTreeSet<usize>,
    /// Incremental-refinement tracking hooks enabled.
    track: bool,
    /// Quality target used by the tracking hooks.
    cos_min_angle: f64,
    /// Set when an insertion hits a "can't happen" topology invariant (e.g. a
    /// shared edge whose neighbour has no apex vertex). Rather than panic, the
    /// insertion bails and every `Option`-returning entry point (`build_from`,
    /// the incremental refinement driver) treats the CDT as unbuildable and
    /// returns `None`, so the caller falls back to ear-clipping — matching how
    /// every other degenerate case in this module degrades.
    failed: bool,
}

/// Broad-phase over the constraint segments' diametral circles, for the
/// per-candidate encroachment test. CSR uniform grid + an "oversized disk"
/// list; `nx == 0` = not built.
#[derive(Default)]
struct EncGrid {
    mid: Vec<P2>,
    r2: Vec<f64>,
    minx: f64,
    miny: f64,
    inv: f64,
    nx: usize,
    ny: usize,
    starts: Vec<u32>,
    items: Vec<u32>,
    big: Vec<u32>,
}

impl Cdt {
    /// Build a CDT from an explicit point list + constraint segment list. The
    /// segment list is the source of truth for constraints (so refinement can
    /// add Steiner points and replace a segment with its two halves, then
    /// rebuild cleanly from scratch — no fragile in-place mutation).
    fn build_from(
        mut points: Vec<P2>,
        segments: &[(usize, usize)],
        steiner_cap: usize,
    ) -> Option<Cdt> {
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
        // Reserve the whole Steiner budget BELOW the super vertices. Splicing a
        // Steiner point in at `super_base` used to renumber every triangle's
        // vertex ids (an O(T) pass per point — 1.07e9 index touches on
        // ISSUE_129, the single largest cost in the consolidate path). With the
        // slots pre-reserved the super ids are constant, so nothing renumbers.
        // Ids stay in the SAME relative order as before (super still above every
        // real vertex), which is what the index-ordered tie-breaks
        // (`boundary.sort_unstable`, `ekey`) depend on ⇒ output-identical.
        points.resize(n_input + steiner_cap, [0.0, 0.0]);
        let super_base = points.len();
        points.push([cx - big, cy - big]);
        points.push([cx + big, cy - big]);
        points.push([cx, cy + big]);

        let mut cdt = Cdt {
            points,
            tris: Vec::new(),
            cset: constraints.iter().copied().collect(),
            constraints,
            super_base,
            n_real: n_input,
            last_loc: 0,
            enc: EncGrid::default(),
            inside: Vec::new(),
            skinny: BTreeSet::new(),
            track: false,
            cos_min_angle: COS_MIN_ANGLE,
            failed: false,
        };
        cdt.tris.push(Tri {
            v: [super_base, super_base + 1, super_base + 2],
            n: [NONE; 3],
            alive: true,
        });
        cdt.inside.push(false);

        // Incremental Delaunay insertion in canonical index order.
        for vi in 0..n_input {
            cdt.insert_point(vi);
        }
        if cdt.failed {
            return None; // an insertion tripped a topology invariant — fall back to ear-clipping
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
        let start = match self.walk_strict(self.last_loc, p) {
            Some(t) => t,
            None => match self.locate(p) {
                Some(t) => t,
                None => return,
            },
        };
        self.insert_point_at(vi, start);
    }

    /// [`Cdt::insert_point`] with the containing triangle already located —
    /// the incremental-refinement entry skips the O(T) `locate` scan (the
    /// caller walked to it via [`Cdt::locate_from`]).
    fn insert_point_at(&mut self, vi: usize, start: usize) {
        if self.failed {
            return; // a prior insertion tripped a topology invariant; stop touching topology
        }
        let p = self.points[vi];
        // Region of the seed = region of every cavity triangle (the cavity BFS
        // never crosses a constraint), inherited by the re-fan below.
        let region = self.inside.get(start).copied().unwrap_or(false);

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
                    if self.cset.contains(&ekey(a, b)) {
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
            // collinear). Edge-aware split: a point landing EXACTLY on an edge
            // of `start` must split BOTH incident triangles in lockstep —
            // `split_in_triangle` alone skips the degenerate child on the
            // collinear edge, re-filling only one side and leaving a
            // T-junction with the far triangle still linked to the dead
            // parent. Genuinely interior points take the 3-way split.
            self.split_at(start, vi);
            self.last_loc = self.tris.len() - 1;
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
            self.inside.push(region);
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
        for t in new_tris {
            self.track_tri(t);
        }
        self.last_loc = self.tris.len() - 1;
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
        let region = self.inside.get(t).copied().unwrap_or(false);
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
            self.inside.push(region);
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
        for c in children {
            self.track_tri(c);
        }
    }

    /// Insertion fallback for an empty Bowyer–Watson cavity: route a point
    /// lying EXACTLY on an edge of `start` (exact `orient == 0` AND strictly
    /// between the endpoints) to the lockstep both-sides split
    /// ([`Cdt::split_on_edge`]); everything else (genuinely interior) to
    /// [`Cdt::split_in_triangle`].
    fn split_at(&mut self, start: usize, vi: usize) {
        if !self.tris[start].alive {
            return;
        }
        let v = self.tris[start].v;
        let p = self.points[vi];
        for e in 0..3 {
            let a = self.points[v[e]];
            let b = self.points[v[(e + 1) % 3]];
            if orient(a, b, p) == 0 && strictly_between(a, b, p) {
                self.split_on_edge(start, e, vi);
                return;
            }
        }
        self.split_in_triangle(start, vi);
    }

    /// Split triangle `t` around `vi`, which lies EXACTLY on `t`'s local edge
    /// `e` (strictly between its endpoints), together with the neighbour
    /// across that edge when one exists. [`Cdt::split_in_triangle`] cannot be
    /// used here: it skips the degenerate child on the collinear edge, so only
    /// ONE side of the edge would be re-filled around `vi` — a T-junction,
    /// with the far triangle still pointing at the dead parent. This splits
    /// BOTH incident triangles in lockstep (4 children; 2 on a boundary
    /// edge), wires every adjacency, and legalizes the children's outer
    /// (parent-perimeter) edges; the spoke edges are incident to the freshly
    /// inserted `vi` and need no Delaunay test.
    fn split_on_edge(&mut self, t: usize, e: usize, vi: usize) {
        let v = self.tris[t].v;
        let n = self.tris[t].n;
        let a = v[e];
        let b = v[(e + 1) % 3];
        let c = v[(e + 2) % 3];
        let nb = n[e];
        let n_bc = n[(e + 1) % 3];
        let n_ca = n[(e + 2) % 3];
        let region_t = self.inside.get(t).copied().unwrap_or(false);

        // A point landing exactly on a CONSTRAINT edge is a segment split:
        // replace `a-b` with its two halves so every invariant that consults
        // `constraints` (cavity blocking, legalization pinning, the inside
        // depth-parity flood) sees the sub-segments. The production NO-SPLIT
        // refinement driver skips encroaching candidates, so this should be
        // unreachable there — it is required for the split-mode path (which
        // shares this insertion code) and kept as a defensive guarantee.
        if self.constraints.remove(&ekey(a, b)) {
            self.constraints.insert(ekey(a, vi));
            self.constraints.insert(ekey(vi, b));
            self.cset.remove(&ekey(a, b));
            self.cset.insert(ekey(a, vi));
            self.cset.insert(ekey(vi, b));
            self.enc = EncGrid::default(); // stale broad-phase → linear fallback
        }

        self.tris[t].alive = false;

        if nb == NONE {
            // Boundary edge: only `t` exists — split it into 2 children.
            let t1 = self.tris.len(); // (vi, b, c)
            let t2 = t1 + 1; //          (a, vi, c)
            self.tris.push(Tri { v: [vi, b, c], n: [NONE, n_bc, t2], alive: true });
            self.tris.push(Tri { v: [a, vi, c], n: [NONE, t1, n_ca], alive: true });
            self.inside.push(region_t);
            self.inside.push(region_t);
            for (ext, x, y, child) in [(n_bc, b, c, t1), (n_ca, c, a, t2)] {
                if ext != NONE {
                    if let Some(oe) = self.tris[ext].edge_of(x, y) {
                        self.tris[ext].n[oe] = child;
                    }
                }
            }
            let mut stack: Vec<(usize, usize)> = vec![(t1, 1), (t2, 2)];
            self.legalize(&mut stack);
            self.track_tri(t1);
            self.track_tri(t2);
            return;
        }

        // Interior (shared) edge: capture the neighbour's data, then split
        // both parents in lockstep. Each child inherits its OWN parent's
        // region flag — the two regions can differ across a constraint edge.
        let region_nb = self.inside.get(nb).copied().unwrap_or(false);
        let Some(d) = self.tris[nb].v.iter().copied().find(|&x| x != a && x != b) else {
            // "Can't happen": the neighbour across a shared edge must have a
            // third (apex) vertex. Degrade to ear-clipping instead of panicking
            // — `t` is already retired above, so leave the CDT flagged
            // unbuildable and let the entry point return `None`.
            self.failed = true;
            return;
        };
        let outer_of = |s: &Self, t: usize, x: usize, y: usize| -> usize {
            s.tris[t].edge_of(x, y).map(|oe| s.tris[t].n[oe]).unwrap_or(NONE)
        };
        let n_ad = outer_of(self, nb, a, d);
        let n_db = outer_of(self, nb, d, b);
        self.tris[nb].alive = false;

        // Parent `t` is (a, b, c) CCW with vi strictly inside a-b, so all four
        // children below are CCW and non-degenerate by construction.
        let t1 = self.tris.len(); // (vi, b, c) — t's side
        let t2 = t1 + 1; //          (a, vi, c) — t's side
        let t3 = t1 + 2; //          (b, vi, d) — neighbour's side
        let t4 = t1 + 3; //          (vi, a, d) — neighbour's side
        self.tris.push(Tri { v: [vi, b, c], n: [t3, n_bc, t2], alive: true });
        self.tris.push(Tri { v: [a, vi, c], n: [t4, t1, n_ca], alive: true });
        self.tris.push(Tri { v: [b, vi, d], n: [t1, t4, n_db], alive: true });
        self.tris.push(Tri { v: [vi, a, d], n: [t2, n_ad, t3], alive: true });
        self.inside.push(region_t);
        self.inside.push(region_t);
        self.inside.push(region_nb);
        self.inside.push(region_nb);

        // Re-point the four EXTERNAL neighbours at the child replacing their
        // side of each parent (the cross-pairs over the old edge and the
        // internal vi-c / vi-d links were wired in the constructors above).
        for (ext, x, y, child) in [
            (n_bc, b, c, t1),
            (n_ca, c, a, t2),
            (n_db, d, b, t3),
            (n_ad, a, d, t4),
        ] {
            if ext != NONE {
                if let Some(oe) = self.tris[ext].edge_of(x, y) {
                    self.tris[ext].n[oe] = child;
                }
            }
        }

        let mut stack: Vec<(usize, usize)> = vec![(t1, 1), (t2, 2), (t3, 2), (t4, 1)];
        self.legalize(&mut stack);
        for ti in [t1, t2, t3, t4] {
            self.track_tri(ti);
        }
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
            if self.cset.contains(&ekey(a, b)) {
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
        // A flip reuses its two slots; their region is unchanged (the flipped
        // edge is never a constraint, so both sides share one region) but
        // their shape is new — re-evaluate for the skinny worklist.
        self.track_tri(ti);
        self.track_tri(opp);
    }

    /// Incremental-refinement hook: (re-)evaluate triangle slot `ti` for the
    /// skinny worklist. No-op unless [`Cdt::start_refinement`] enabled tracking.
    #[inline]
    fn track_tri(&mut self, ti: usize) {
        if !self.track {
            return;
        }
        let cand = self.tris[ti].alive
            && self.inside.get(ti).copied().unwrap_or(false)
            && !self.tris[ti].v.iter().any(|&x| x >= self.super_base)
            && self.tri_is_skinny(ti, self.cos_min_angle);
        if cand {
            self.skinny.insert(ti);
        } else {
            self.skinny.remove(&ti);
        }
    }

    /// Enable incremental refinement: materialise the per-triangle inside
    /// flags once, then seed the skinny worklist. From here on the tracking
    /// hooks ([`Cdt::track_tri`], the region inheritance in the insertion
    /// paths) keep both maintained under [`Cdt::insert_steiner`] mutations.
    fn start_refinement(&mut self, cos_min_angle: f64) {
        self.inside = self.inside_flags();
        self.build_enc_grid();
        self.cos_min_angle = cos_min_angle;
        self.track = true;
        self.skinny.clear();
        for ti in 0..self.tris.len() {
            self.track_tri(ti);
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

    /// [`Cdt::locate`] by deterministic straight-line walk from alive triangle
    /// `start` (the refinement caller knows a triangle near `p` — its skinny
    /// source — so the walk is a few steps instead of an O(T) scan). At each
    /// triangle, step across the FIRST edge (canonical edge order) that `p` is
    /// strictly outside of; when no edge rejects, the closed triangle contains
    /// `p`. Exact orients ⇒ deterministic path. Falls back to the linear scan
    /// on a dead/missing start, a hull exit, or a step-cap hit (degenerate
    /// cycling), so the result is always the same kind of answer `locate` gives.
    fn locate_from(&self, start: usize, p: P2) -> Option<usize> {
        if !self.tris.get(start).is_some_and(|t| t.alive) {
            return self.locate(p);
        }
        let mut cur = start;
        let cap = self.tris.len() * 2 + 16;
        for _ in 0..cap {
            let v = self.tris[cur].v;
            let mut moved = false;
            for e in 0..3 {
                let a = self.points[v[e]];
                let b = self.points[v[(e + 1) % 3]];
                if orient(a, b, p) < 0 {
                    let nb = self.tris[cur].n[e];
                    if nb == NONE || !self.tris[nb].alive {
                        return self.locate(p); // walked off the hull — fall back
                    }
                    cur = nb;
                    moved = true;
                    break;
                }
            }
            if !moved {
                return Some(cur);
            }
        }
        self.locate(p)
    }

    /// Walk-locate that is EXACTLY [`Cdt::locate`] whenever it answers: it only
    /// returns a triangle that STRICTLY contains `p`, and a strictly-containing
    /// triangle is unique, so the canonical lowest-index scan must return the
    /// same one. Every other outcome — `p` on an edge/vertex (the one case
    /// where `locate`'s lowest-index tie-break is observable), a dead start, a
    /// hull exit, a step-cap hit — answers `None` and the caller falls back to
    /// the scan. That is what makes the walk a pure speedup and not a behaviour
    /// change.
    fn walk_strict(&self, start: usize, p: P2) -> Option<usize> {
        if !self.tris.get(start).is_some_and(|t| t.alive) {
            return None;
        }
        let mut cur = start;
        // Any cap is safe (a miss just takes the scan); this one bounds the
        // pathological "first negative edge" cycle without being O(T) in
        // practice.
        let cap = self.tris.len().min(4096) + 16;
        for _ in 0..cap {
            let v = self.tris[cur].v;
            let o0 = orient(self.points[v[0]], self.points[v[1]], p);
            let o1 = orient(self.points[v[1]], self.points[v[2]], p);
            let o2 = orient(self.points[v[2]], self.points[v[0]], p);
            if o0 > 0 && o1 > 0 && o2 > 0 {
                return Some(cur);
            }
            let e = if o0 < 0 {
                0
            } else if o1 < 0 {
                1
            } else if o2 < 0 {
                2
            } else {
                return None; // on the closed boundary — let `locate` tie-break
            };
            let nb = self.tris[cur].n[e];
            if nb == NONE || !self.tris[nb].alive {
                return None;
            }
            cur = nb;
        }
        None
    }

    // ─────────────────────── constraint recovery ──────────────────────────

    /// Ensure every constraint segment appears as an edge of the triangulation.
    /// After Delaunay insertion of the ring vertices, most segments already
    /// exist; any missing one is recovered by flipping the diagonals that cross
    /// it. Returns false if a segment can't be recovered (caller falls back).
    fn enforce_constraints(&mut self) -> bool {
        // Materialise the alive edge set ONCE instead of re-scanning every
        // triangle per `edge_exists` probe (4.7e8 slot visits on ISSUE_129 —
        // the second-largest cost in the consolidate path). Recovery's only
        // topology mutation is the explicit `flip` below, whose edge delta is
        // exactly "drop u-w, add apex-q", so the set stays exact.
        let mut edges: rustc_hash::FxHashSet<(usize, usize)> = rustc_hash::FxHashSet::default();
        for t in self.tris.iter().filter(|t| t.alive) {
            for e in 0..3 {
                edges.insert(ekey(t.v[e], t.v[(e + 1) % 3]));
            }
        }
        let segs: Vec<(usize, usize)> = self.constraints.iter().copied().collect();
        for (a, b) in segs {
            if !self.recover_segment(a, b, &mut edges) {
                return false;
            }
        }
        true
    }

    /// Recover a single constraint segment `a-b` by repeatedly flipping the
    /// triangulation edge that crosses it. Deterministic: always processes the
    /// crossing edge nearest `a`.
    fn recover_segment(
        &mut self,
        a: usize,
        b: usize,
        edges: &mut rustc_hash::FxHashSet<(usize, usize)>,
    ) -> bool {
        if edges.contains(&ekey(a, b)) {
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
            if edges.contains(&ekey(a, b)) {
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
                    if self.cset.contains(&ekey(u, w)) {
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
                    edges.remove(&ekey(u, w));
                    edges.insert(ekey(apex, q));
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
                return edges.contains(&ekey(a, b));
            }
        }
    }

    /// Does an alive triangle carry undirected edge `a-b`? Test-only since the
    /// recovery loop reads the maintained edge set instead.
    #[cfg(test)]
    fn edge_exists(&self, a: usize, b: usize) -> bool {
        self.tris
            .iter()
            .any(|t| t.alive && t.edge_of(a, b).is_some())
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
            if self.tris[ti].v.iter().any(|&x| x >= self.super_base)
                && depth[ti] == -1 {
                    depth[ti] = 0;
                    queue.push_back(ti);
                }
        }

        let bfs = |start_queue: &mut VecDeque<usize>, depth: &mut [i32]| {
            while let Some(ti) = start_queue.pop_front() {
                let d = depth[ti];
                for e in 0..3 {
                    let nb = self.tris[ti].n[e];
                    if nb == NONE || !self.tris[nb].alive || depth[nb] != -1 {
                        continue;
                    }
                    let a = self.tris[ti].v[e];
                    let b = self.tris[ti].v[(e + 1) % 3];
                    let nd = if self.cset.contains(&ekey(a, b)) {
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

    /// NO-SPLIT refinement step: pull the lowest-index skinny candidate from
    /// the maintained worklist.
    ///
    /// A candidate whose circumcenter encroaches a constraint, or falls outside
    /// the domain, is removed PERMANENTLY: the constraint set and the domain
    /// partition are immutable (boundary/hole-ring segments are never split —
    /// see the module doc), and a triangle's circumcenter is a function of its
    /// own (immutable) vertices — the verdict can never change while the
    /// triangle slot is unchanged. (A slot rewrite re-evaluates via
    /// [`Cdt::track_tri`].)
    ///
    /// Returns the Steiner point and the alive triangle containing it (the
    /// walk-located insertion seed), or `None` when the quality bound is met.
    fn next_steiner(&mut self) -> Option<(P2, usize)> {
        loop {
            let &ti = self.skinny.iter().next()?;
            if !self.tris[ti].alive
                || !self.inside.get(ti).copied().unwrap_or(false)
                || self.tris[ti].v.iter().any(|&x| x >= self.super_base)
                || !self.tri_is_skinny(ti, self.cos_min_angle)
            {
                self.skinny.remove(&ti); // stale slot (killed / rewritten)
                continue;
            }
            let Some(cc) = self.circumcenter(ti) else {
                self.skinny.remove(&ti);
                continue;
            };
            if self.is_encroached(cc) {
                self.skinny.remove(&ti); // no-split mode: leave it (permanent)
                continue;
            }
            match self.locate_from(ti, cc) {
                Some(loc) if self.inside.get(loc).copied().unwrap_or(false) => {
                    // ti is NOT removed: cc lies strictly inside ti's
                    // circumcircle, so the insertion cavity kills ti and the
                    // stale entry drops out on its next pop.
                    return Some((cc, loc));
                }
                _ => {
                    self.skinny.remove(&ti);
                    continue;
                }
            }
        }
    }

    /// Incrementally insert Steiner point `p` (known to lie in alive triangle
    /// `loc`, per [`Cdt::next_steiner`]) into the LIVE CDT — the no-rebuild
    /// refinement step. The point takes the next PRE-RESERVED slot below the
    /// super-triangle vertices, so every index invariant holds unchanged
    /// (`< n_input` = input / constraint vertex, `>= super_base` = super vertex,
    /// emit keeps `< n_real`) and no triangle is renumbered. Reserving the whole
    /// budget up front is what removes the old per-point O(T) renumbering pass.
    fn insert_steiner(&mut self, p: P2, loc: usize) {
        let vi = self.n_real;
        if vi >= self.super_base {
            self.failed = true; // budget exhausted — caller ear-clips (unreachable: the driver caps first)
            return;
        }
        self.points[vi] = p;
        self.n_real += 1;
        // Constraints reference input vertices only (< n_input <= vi): unchanged.
        self.insert_point_at(vi, loc);
    }

    /// Does point `p` lie inside the diametral circle of any constraint
    /// segment?
    ///
    /// Existence only — the refinement driver never looks at WHICH segment — so
    /// the answer is order-independent and a broad-phase is exact rather than
    /// approximate. Every skinny candidate used to test every constraint
    /// (5.9e7 disk tests on ISSUE_129); the grid built once per refinement
    /// answers from one cell plus the few oversized disks.
    fn is_encroached(&self, p: P2) -> bool {
        let hit = |i: u32| {
            let i = i as usize;
            dist2(p, self.enc.mid[i]) < self.enc.r2[i] * (1.0 - 1e-12)
        };
        if self.enc.nx == 0 {
            // No grid (constraints mutated mid-refinement, or none at all).
            return self.constraints.iter().any(|&(a, b)| {
                let (pa, pb) = (self.points[a], self.points[b]);
                let mid = [(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5];
                dist2(p, mid) < dist2(pa, pb) * 0.25 * (1.0 - 1e-12)
            });
        }
        if self.enc.big.iter().copied().any(hit) {
            return true;
        }
        let gx = (p[0] - self.enc.minx) * self.enc.inv;
        let gy = (p[1] - self.enc.miny) * self.enc.inv;
        if !(gx >= 0.0 && gy >= 0.0) {
            return false;
        }
        let (gx, gy) = (gx as usize, gy as usize);
        if gx >= self.enc.nx || gy >= self.enc.ny {
            return false;
        }
        let c = gy * self.enc.nx + gx;
        let (s, e) = (
            self.enc.starts[c] as usize,
            self.enc.starts[c + 1] as usize,
        );
        self.enc.items[s..e].iter().copied().any(hit)
    }

    /// Rebuild [`Cdt::enc`] from the current constraint set. `nx == 0` means
    /// "no grid" and [`Cdt::is_encroached`] falls back to the linear scan.
    fn build_enc_grid(&mut self) {
        let mut mid: Vec<P2> = Vec::with_capacity(self.constraints.len());
        let mut r2: Vec<f64> = Vec::with_capacity(self.constraints.len());
        let mut rad: Vec<f64> = Vec::with_capacity(self.constraints.len());
        for &(a, b) in &self.constraints {
            let (pa, pb) = (self.points[a], self.points[b]);
            mid.push([(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5]);
            let d2 = dist2(pa, pb) * 0.25;
            r2.push(d2);
            rad.push(d2.sqrt());
        }
        self.enc = EncGrid {
            mid,
            r2,
            ..EncGrid::default()
        };
        let n = self.enc.mid.len();
        if n == 0 {
            return;
        }
        let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for (m, r) in self.enc.mid.iter().zip(rad.iter()) {
            minx = minx.min(m[0] - r);
            miny = miny.min(m[1] - r);
            maxx = maxx.max(m[0] + r);
            maxy = maxy.max(m[1] + r);
        }
        let span = (maxx - minx).max(maxy - miny);
        if !(span > 0.0) || !span.is_finite() {
            return;
        }
        // ~1 cell per constraint, capped so the CSR stays small.
        let side = ((n as f64).sqrt().ceil() as usize).clamp(1, 64);
        let cell = span / side as f64;
        let inv = 1.0 / cell;
        let (nx, ny) = (side, side);
        let cellrange = |m: P2, r: f64| -> (usize, usize, usize, usize) {
            let c = |v: f64, lo: f64, hi: usize| {
                let g = ((v - lo) * inv).floor();
                if g < 0.0 {
                    0
                } else if g >= hi as f64 {
                    hi - 1
                } else {
                    g as usize
                }
            };
            (
                c(m[0] - r, minx, nx),
                c(m[0] + r, minx, nx),
                c(m[1] - r, miny, ny),
                c(m[1] + r, miny, ny),
            )
        };
        let mut counts = vec![0u32; nx * ny + 1];
        let mut big: Vec<u32> = Vec::new();
        let mut is_big = vec![false; n];
        for i in 0..n {
            let (x0, x1, y0, y1) = cellrange(self.enc.mid[i], rad[i]);
            if (x1 - x0 + 1) * (y1 - y0 + 1) > 32 {
                big.push(i as u32);
                is_big[i] = true;
                continue;
            }
            for gy in y0..=y1 {
                for gx in x0..=x1 {
                    counts[gy * nx + gx + 1] += 1;
                }
            }
        }
        for i in 1..counts.len() {
            counts[i] += counts[i - 1];
        }
        let total = counts[nx * ny] as usize;
        let mut items = vec![0u32; total];
        let mut cursor = counts.clone();
        for i in 0..n {
            if is_big[i] {
                continue;
            }
            let (x0, x1, y0, y1) = cellrange(self.enc.mid[i], rad[i]);
            for gy in y0..=y1 {
                for gx in x0..=x1 {
                    let c = gy * nx + gx;
                    items[cursor[c] as usize] = i as u32;
                    cursor[c] += 1;
                }
            }
        }
        self.enc.minx = minx;
        self.enc.miny = miny;
        self.enc.inv = inv;
        self.enc.nx = nx;
        self.enc.ny = ny;
        self.enc.starts = counts;
        self.enc.items = items;
        self.enc.big = big;
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
    /// (`points[n_input..n_real]`); the unused reserved slots and the
    /// super-triangle vertices are dropped.
    fn emit(&self) -> (Vec<P2>, Vec<usize>) {
        let inside = self.inside_flags();
        // Compact vertex set: keep input + Steiner (drop super verts AND the
        // unused tail of the reserved Steiner region).
        let keep_upto = self.n_real;
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

/// Run bounded, INTERIOR-ONLY Ruppert/Chew refinement on a planar
/// straight-line graph (`points` + `segments`): the constraint set (boundary /
/// hole-ring segments) is immutable, so every refinement action is an interior
/// circumcenter insertion, applied INCREMENTALLY to the live CDT (never a
/// rebuild). This is the only mode the crate uses — the coplanar-consolidation
/// production path requires it, because its region boundary is SHARED with
/// neighbouring plane buckets triangulated independently; a boundary Steiner
/// point would create a T-junction / open edge at the bucket seam.
///
/// A historical full-Ruppert mode existed that also allowed splitting encroached
/// boundary/hole segments (rebuilding a fresh CDT after every single Steiner
/// point or split); it was deleted as dead code (D4 dead-code sweep) once both
/// production callers were confirmed to always run interior-only. The
/// rebuild-per-point driver was O(P²) per rebuild anyway (each rebuild
/// re-inserts every point with an O(T) `locate` scan), i.e. O(P³) per
/// refinement: 13.8 s for ONE 582-vertex/16-hole slab face, ×2 faces ×16
/// re-consolidates = the 155 s advanced_model #798926 many-void cliff.
/// Incremental insertion + walk-locate + the maintained skinny worklist
/// refines the same face in ~10 ms.
///
/// Deterministic: the same PSLG yields the same Steiner sequence on every
/// platform. Bounded by Steiner budget + iteration cap.
fn refine_to_fixpoint(points: Vec<P2>, segments: Vec<(usize, usize)>) -> Option<Cdt> {
    let n_input = points.len();
    let max_steiner = (n_input * 3).max(32);
    let mut steiner = 0usize;
    let mut cdt = Cdt::build_from(points, &segments, max_steiner.min(MAX_REFINE_ITERS))?;

    cdt.start_refinement(COS_MIN_ANGLE);
    while steiner < max_steiner.min(MAX_REFINE_ITERS) {
        let Some((p, loc)) = cdt.next_steiner() else {
            break;
        };
        cdt.insert_steiner(p, loc);
        if cdt.failed {
            return None; // Steiner insertion tripped a topology invariant — ear-clip fallback
        }
        steiner += 1;
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
///
/// Refinement is interior-only and NEVER touches the boundary/hole rings —
/// required because the boundary is shared with other independently-
/// triangulated regions (the coplanar-consolidation path), so seams stay
/// watertight / T-junction-free. See [`refine_to_fixpoint`] for why this is
/// the only supported mode.
pub(crate) fn triangulate_refined(
    outer: &[Point2<f64>],
    holes: &[Vec<Point2<f64>>],
) -> Option<(Vec<Point2<f64>>, Vec<usize>)> {
    let mut rings: Vec<Vec<P2>> = Vec::with_capacity(1 + holes.len());
    rings.push(outer.iter().map(p2).collect());
    for h in holes {
        if h.len() >= 3 {
            rings.push(h.iter().map(p2).collect());
        }
    }
    let (points, segments) = rings_to_pslg(&rings);
    let cdt = refine_to_fixpoint(points, segments)?;
    let (pts, idx) = cdt.emit();
    if idx.is_empty() {
        return None;
    }
    let out_pts: Vec<Point2<f64>> = pts.iter().map(|p| Point2::new(p[0], p[1])).collect();
    Some((out_pts, idx))
}

/// Constrained Delaunay triangulation of a polygon-with-holes WITHOUT quality
/// (Ruppert) refinement — the minimal boundary-conforming triangulation of the
/// input vertices, no Steiner points. Returned vertex list is exactly the input
/// (`outer ++ holes`) in order; indices reference it. This is the fast,
/// slivers-free cap triangulator for the 2D opening-subtraction extrude: unlike
/// earcut it never bridges holes (so a many-hole cap stays manifold), and unlike
/// [`triangulate_refined`] it never pays the min-angle refinement that dominates
/// on a large multi-hole face. `None` if the CDT can't be built (caller falls
/// back to earcut).
pub(crate) fn triangulate_constrained(
    outer: &[Point2<f64>],
    holes: &[Vec<Point2<f64>>],
) -> Option<(Vec<Point2<f64>>, Vec<usize>)> {
    let mut rings: Vec<Vec<P2>> = Vec::with_capacity(1 + holes.len());
    rings.push(outer.iter().map(p2).collect());
    for h in holes {
        if h.len() >= 3 {
            rings.push(h.iter().map(p2).collect());
        }
    }
    let (points, segments) = rings_to_pslg(&rings);
    let cdt = Cdt::build_from(points, &segments, 0)?;
    let (pts, idx) = cdt.emit();
    if idx.is_empty() {
        return None;
    }
    let out_pts: Vec<Point2<f64>> = pts.iter().map(|p| Point2::new(p[0], p[1])).collect();
    Some((out_pts, idx))
}

/// Conforming (constrained) Delaunay triangulation of an arbitrary PSLG —
/// points plus non-crossing constraint segments — returning EVERY triangle of
/// the convex hull, with NO inside/outside domain filtering. The caller
/// classifies each output triangle itself (e.g. by a centroid test).
///
/// Unlike [`triangulate_constrained`] the segments need not form closed rings:
/// the prism-cut path passes OPEN seam polylines (host-surface cross-sections)
/// as constraints, which would corrupt the ring depth-parity flood that
/// [`Cdt::emit`] uses — so this entry point deliberately skips it. Vertices are
/// exactly the input points in input order (no Steiner insertion); triangles
/// referencing the internal super-triangle are dropped and each triangle is
/// emitted CCW. `None` when the CDT cannot be built (degenerate input, crossing
/// constraints) — callers fall back to their exact path.
pub(crate) fn triangulate_pslg(
    points: &[Point2<f64>],
    segments: &[(usize, usize)],
) -> Option<(Vec<Point2<f64>>, Vec<usize>)> {
    let pts: Vec<P2> = points.iter().map(p2).collect();
    let cdt = Cdt::build_from(pts, segments, 0)?;
    let keep_upto = cdt.super_base;
    let mut indices: Vec<usize> = Vec::new();
    for tri in &cdt.tris {
        if !tri.alive {
            continue;
        }
        let v = tri.v;
        if v.iter().any(|&x| x >= keep_upto) {
            continue;
        }
        let a = cdt.points[v[0]];
        let b = cdt.points[v[1]];
        let c = cdt.points[v[2]];
        if orient(a, b, c) >= 0 {
            indices.extend_from_slice(&[v[0], v[1], v[2]]);
        } else {
            indices.extend_from_slice(&[v[0], v[2], v[1]]);
        }
    }
    if indices.is_empty() {
        return None;
    }
    let out_pts: Vec<Point2<f64>> = cdt.points[..keep_upto]
        .iter()
        .map(|p| Point2::new(p[0], p[1]))
        .collect();
    Some((out_pts, indices))
}

#[cfg(test)]
#[path = "cdt_tests.rs"]
mod tests;
