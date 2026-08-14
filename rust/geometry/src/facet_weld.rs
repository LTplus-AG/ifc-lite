// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deterministic near-coplanar facet weld for faceted-BREP host meshes.
//!
//! ## Why this exists (issue #1007, host #1112)
//!
//! A faceted-BREP roof slope is authored as ONE flat plane in the modeller, but
//! the f32 import re-quantises every facet vertex independently. The facets that
//! were authored exactly coplanar come back with NEARLY identical normals but
//! their plane OFFSET jittered by ~10–15 µm (verified on host #1112: the two
//! slope normals `(0, ∓0.521, 0.854)` each carry 4 facets spread across 3
//! distinct 1 µm offset buckets, while a genuinely-different parallel slope at
//! the same normal sits 0.4 m away — clearly separable).
//!
//! That sub-bucket offset jitter is what fragments the authored slope inside
//! `consolidate_coplanar` (which keys plane buckets on a FINE 1 µm offset grid,
//! deliberately — coarsening it reopens the opening-hole bridge, #1007). A
//! fragment that lands alone in its bucket is a single-triangle bucket: it has
//! no region to re-triangulate, bypasses the CDT, and is emitted as-is — a 25:1
//! far-corner sliver fanned across the slope.
//!
//! The fix is at the ROOT: cluster the facets of each authored plane (same
//! quantised normal, offsets within a tight jitter tolerance) and project their
//! vertices onto ONE fitted common plane BEFORE the kernel cut. After welding,
//! those facets share an EXACT offset, so `consolidate_coplanar` coalesces them
//! into one region, the CDT refines the slope-with-opening-hole, and the
//! far-corner sliver fan is gone — while the opening stays a clean hole.
//!
//! ## Geometry-faithful (over-weld guard)
//!
//! Two independent guards keep the weld from flattening a real feature:
//!
//! 1. **Normal bucket** (`NORMAL_QUANT`): facets only cluster if their normals
//!    quantise to the same direction (~0.06° resolution) — a real roof pitch /
//!    dormer has a distinct normal bucket and never clusters with the slope.
//! 2. **Offset jitter tolerance** (`MAX_OFFSET_JITTER`): within a normal
//!    bucket, facets only cluster if their plane offsets are within this tight
//!    band. Two genuinely-distinct parallel planes (e.g. the 0.4 m-apart slopes
//!    on #1112) stay in separate clusters.
//!
//! On top of that the per-vertex MOVE is hard-capped (`MAX_VERTEX_MOVE`): a
//! vertex is only projected if it lands within that cap of the fitted plane, so
//! a vertex on a real crease between the slope and a perpendicular cap is moved
//! by at most the jitter (sub-100 µm) and never dragged onto a far plane. The
//! correction is sub-millimetre at building scale; cut volume is preserved
//! within the kernel's snap grid.
//!
//! ## Determinism (native == wasm)
//!
//! - All arithmetic is plain FMA-free `f64` (no fused multiply-add).
//! - Vertex dedup, plane clustering, and vertex iteration are over `BTreeMap`
//!   / sorted keys keyed on integer grids — never `HashMap` iteration.
//! - The fitted plane is the area-weighted average normal/offset (a sum taken
//!   in a fixed, facet-index-sorted order), and projected vertices are snapped
//!   to the same `1/2^16` grid the kernel uses, so the welded mesh is
//!   byte-identical on every target.
//! - Normals and offsets are computed in a frame anchored at the canonical
//!   vertex set's bounding-box minimum (order-independent) rather than raw
//!   world position, which removes a magnitude-amplification bug in `n·v` at
//!   large site coordinates — see Step 1.5 below for the derivation.
//!
//! ## Watertightness
//!
//! Welding moves SHARED canonical vertices (deduped by snapped position), so
//! every facet incident to a moved vertex moves WITH it — no gaps and no
//! T-junctions. When a vertex is eligible for more than one plane cluster, the
//! candidate projected positions are averaged (deterministic order) and the
//! result is still bounded by `MAX_VERTEX_MOVE`, so a single final position is
//! used by all incident facets.

use crate::mesh::Mesh;
use std::collections::BTreeMap;

/// f32-snap / kernel-reconcile grid (metres). Power of two ⇒ `(c/G).round()*G`
/// is an EXACT f64 op, bit-deterministic across targets. The kernel's own
/// canonical grid, so welded vertices land exactly where the kernel would
/// snap them anyway.
use crate::kernel::mesh_bridge::SNAP_GRID;

/// Normal-direction quantisation for the plane bucket. 1e3 ⇒ ~0.057° resolution
/// — the shared grid also used by `consolidate_coplanar`'s `NORMAL_QUANT`, so
/// a weld merges exactly the facets that bucket would otherwise scatter. A
/// real roof pitch / dormer has a distinct normal bucket and never clusters
/// with the slope.
use crate::grid::NORMAL_QUANT_F64 as NORMAL_QUANT;

/// Max plane-offset jitter (metres) for two same-normal facets to weld into one
/// plane cluster. 50 µm comfortably spans the ~15 µm f32 offset jitter but is
/// far below any genuinely-distinct parallel plane (the #1112 twin slopes are
/// 0.4 m apart), so distinct planes never merge.
const MAX_OFFSET_JITTER: f64 = 50.0e-6;

/// Hard cap on how far (metres) any single vertex may be moved by the weld. The
/// jitter correction is sub-`MAX_OFFSET_JITTER`; this cap rejects any vertex
/// whose projection onto a cluster plane would exceed it — the over-weld guard
/// for a crease vertex shared with a perpendicular face, so it is nudged by at
/// most the jitter and never dragged onto a far plane.
const MAX_VERTEX_MOVE: f64 = 200.0e-6;

/// Position dedup grid (metres). Coarser than the offset jitter so two facet
/// corners the f32 import left ~15 µm apart are recognised as the SAME shared
/// vertex (so the weld moves them together). 100 µm is well below any BIM
/// feature size yet above the import jitter.
const POSITION_DEDUP_GRID: f64 = 1.0e-4;

#[inline]
fn snap_grid(c: f64) -> f64 {
    (c / SNAP_GRID).round() * SNAP_GRID
}

#[inline]
fn dedup_key(c: f64) -> i64 {
    (c / POSITION_DEDUP_GRID).round() as i64
}

#[inline]
fn qnorm(c: f64) -> i64 {
    (c * NORMAL_QUANT).round() as i64
}

/// Unit normal of a triangle (FMA-free f64) + twice its area (the fit weight).
/// Returns `None` for a degenerate (zero-area) triangle.
#[inline]
fn tri_normal(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> Option<([f64; 3], f64)> {
    let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len <= 0.0 {
        return None;
    }
    Some(([n[0] / len, n[1] / len, n[2] / len], len))
}

/// Weld near-coplanar facets (same quantised normal, offsets within the jitter
/// tolerance) of a faceted host mesh to a common fitted plane, correcting f32
/// import jitter, BEFORE the exact-kernel opening cut.
///
/// Returns the input mesh unchanged when nothing welds — a safe no-op for
/// already-planar extrusion hosts and for meshes whose facets are genuinely
/// distinct planes (the offset / move guards keep real features apart).
///
/// The returned mesh keeps the SAME topology (same indices); only positions of
/// welded shared vertices move, snapped to the kernel grid.
pub fn weld_near_coplanar_facets(mesh: &Mesh) -> Mesh {
    let vertex_count = mesh.positions.len() / 3;
    let tri_count = mesh.indices.len() / 3;
    if vertex_count < 3 || tri_count < 2 {
        return mesh.clone();
    }

    let pos = |i: usize| -> [f64; 3] {
        [
            mesh.positions[i * 3] as f64,
            mesh.positions[i * 3 + 1] as f64,
            mesh.positions[i * 3 + 2] as f64,
        ]
    };

    // ── Step 1: dedup vertices by snapped position so shared corners are one
    // canonical vertex. The weld moves canonical vertices, so every facet
    // incident to a moved corner moves WITH it (watertight).
    let mut canon_of: Vec<usize> = vec![0; vertex_count];
    let mut canon_pos: Vec<[f64; 3]> = Vec::new();
    {
        let mut seen: BTreeMap<(i64, i64, i64), usize> = BTreeMap::new();
        for i in 0..vertex_count {
            let p = pos(i);
            let key = (dedup_key(p[0]), dedup_key(p[1]), dedup_key(p[2]));
            let id = *seen.entry(key).or_insert_with(|| {
                let id = canon_pos.len();
                canon_pos.push(p);
                id
            });
            canon_of[i] = id;
        }
    }
    let n_canon = canon_pos.len();

    // ── Step 1.5: local-frame anchor (issue: large-site amplification). The
    // plane offset below is a dot product `n·v` against the RAW vertex; at
    // ordinary site coordinates (hundreds to thousands of metres — well under
    // `LARGE_COORD_THRESHOLD_METERS`, so never recentred upstream) a tiny
    // per-facet normal-direction error δn — itself just independent f32
    // re-quantisation of each facet's vertices, the same jitter this module
    // exists to correct — gets amplified by the vertex's absolute magnitude:
    // `δ(n·v) ≈ δn · |v|`. At 5000 m that turns a µm-scale normal wobble into
    // a decimetre-scale offset error, blowing through `MAX_OFFSET_JITTER` and
    // leaving the authored plane fragmented.
    //
    // Working in a frame anchored near the mesh — subtract `anchor` before
    // any dot product, add it back before returning positions — replaces `|v|`
    // with `|v - anchor|` (bounded by the mesh's own extent, not the site's
    // distance from the world origin), which removes the amplification without
    // touching any tolerance constant.
    //
    // Anchor = the bounding-box minimum corner over all canonical vertices, a
    // per-axis min-reduction. Unlike `canon_pos[0]` (the first canonical
    // vertex), this is a function of the vertex SET, not of vertex ordering
    // or visit order — permuting the input's vertex/triangle order (e.g. a
    // different triangulator diagonal choice) yields the same min-reduction
    // and therefore the same anchor, so the weld result no longer depends on
    // which vertex happened to be numbered first. It is still within the
    // mesh's own extent (an axis-wise min of vertices it contains), which is
    // the property Step 1.5 needs: it bounds `|v - anchor|` by the mesh's own
    // extent rather than the site's distance from the world origin.
    let anchor = canon_pos.iter().fold([f64::INFINITY; 3], |acc, p| {
        [acc[0].min(p[0]), acc[1].min(p[1]), acc[2].min(p[2])]
    });
    let anchored = |p: [f64; 3]| -> [f64; 3] {
        [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]]
    };

    // ── Step 2: per-facet canonical triangle, unit normal, area, plane
    // offset — normal and offset computed in the anchor-local frame (Step 1.5).
    struct Facet {
        tri: [usize; 3],
        normal: [f64; 3],
        offset: f64, // signed-normal plane offset, anchor-local: n·(v0 - anchor)
        area2: f64,
    }
    let mut facets: Vec<Facet> = Vec::with_capacity(tri_count);
    for c in mesh.indices.chunks_exact(3) {
        let (i0, i1, i2) = (c[0] as usize, c[1] as usize, c[2] as usize);
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            continue;
        }
        let (a, b, d) = (canon_of[i0], canon_of[i1], canon_of[i2]);
        if a == b || b == d || a == d {
            continue;
        }
        let (la, lb, ld) = (anchored(canon_pos[a]), anchored(canon_pos[b]), anchored(canon_pos[d]));
        if let Some((normal, area2)) = tri_normal(la, lb, ld) {
            let offset = normal[0] * la[0] + normal[1] * la[1] + normal[2] * la[2];
            facets.push(Facet {
                tri: [a, b, d],
                normal,
                offset,
                area2,
            });
        }
    }
    if facets.len() < 2 {
        return mesh.clone();
    }

    // ── Step 3: bucket facets by quantised normal direction, canonicalising the
    // normal SIGN (a faceted shell can carry either winding of the same plane)
    // so anti-parallel facets bucket together. Iteration is over a BTreeMap ⇒
    // deterministic.
    let mut normal_buckets: BTreeMap<(i64, i64, i64), Vec<usize>> = BTreeMap::new();
    for (fi, f) in facets.iter().enumerate() {
        let n = f.normal;
        // Deterministic sign canon: first non-zero quantised component positive.
        let qx = qnorm(n[0]);
        let qy = qnorm(n[1]);
        let qz = qnorm(n[2]);
        let sgn = if qx != 0 {
            qx.signum()
        } else if qy != 0 {
            qy.signum()
        } else if qz != 0 {
            qz.signum()
        } else {
            1
        };
        let key = (qx * sgn, qy * sgn, qz * sgn);
        normal_buckets.entry(key).or_default().push(fi);
    }

    // ── Step 4: within each normal bucket, cluster facets by plane offset
    // (sign-aligned to the bucket's canonical normal) using a single-linkage
    // sweep with the tight `MAX_OFFSET_JITTER` gap. Each cluster = one authored
    // plane; fit ONE area-weighted plane per cluster.
    //
    // A "plane" is `(unit normal, offset)`. We accumulate per-vertex candidate
    // projected positions and average them (Step 5) so a crease vertex shared by
    // two clusters gets one deterministic final position.
    let mut vertex_moves: Vec<Vec<[f64; 3]>> = vec![Vec::new(); n_canon];

    for fis in normal_buckets.values() {
        if fis.len() < 2 {
            continue;
        }
        // Sign-aligned offset + a stable reference normal (the bucket's
        // lowest-index facet, flipped to a canonical hemisphere).
        let ref_n = facets[fis[0]].normal;
        // (offset_aligned, facet_index), sorted by offset then index ⇒
        // deterministic clustering.
        let mut keyed: Vec<(f64, usize)> = fis
            .iter()
            .map(|&fi| {
                let n = facets[fi].normal;
                let dotv = n[0] * ref_n[0] + n[1] * ref_n[1] + n[2] * ref_n[2];
                let off = if dotv < 0.0 {
                    -facets[fi].offset
                } else {
                    facets[fi].offset
                };
                (off, fi)
            })
            .collect();
        debug_assert!(
            keyed.iter().all(|k| k.0.is_finite()),
            "facet offsets must be finite before the deterministic offset sort"
        );
        keyed.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));

        // Single-linkage sweep: start a new cluster whenever the offset gap to
        // the previous facet exceeds MAX_OFFSET_JITTER.
        let mut cluster_start = 0usize;
        let mut process_cluster = |slice: &[(f64, usize)]| {
            if slice.len() < 2 {
                return;
            }
            // Area-weighted average normal (sign-aligned to ref_n) + offset, in
            // facet-index order for a deterministic FMA-free sum.
            let mut members: Vec<usize> = slice.iter().map(|&(_, fi)| fi).collect();
            members.sort_unstable();
            let mut acc_n = [0.0f64, 0.0, 0.0];
            let mut acc_off = 0.0f64;
            let mut wsum = 0.0f64;
            for &fi in &members {
                let n = facets[fi].normal;
                let dotv = n[0] * ref_n[0] + n[1] * ref_n[1] + n[2] * ref_n[2];
                let s = if dotv < 0.0 { -1.0 } else { 1.0 };
                let w = facets[fi].area2;
                acc_n[0] += s * n[0] * w;
                acc_n[1] += s * n[1] * w;
                acc_n[2] += s * n[2] * w;
                acc_off += s * facets[fi].offset * w;
                wsum += w;
            }
            if wsum <= 0.0 {
                return;
            }
            let len = (acc_n[0] * acc_n[0] + acc_n[1] * acc_n[1] + acc_n[2] * acc_n[2]).sqrt();
            if len <= 0.0 {
                return;
            }
            // Plane: unit normal `pn`, offset `pd` so pn·x = pd (anchor-local —
            // `acc_off` was accumulated from anchor-local per-facet offsets).
            // `acc_off` is Σ wᵢ (nᵢ·vᵢ) with each |nᵢ|=1 and sign-aligned, so the
            // weighted mean offset `acc_off / wsum` is already expressed against
            // a unit normal and is consistent with `pn` (the same area-weighted
            // mean direction, renormalised).
            let pn = [acc_n[0] / len, acc_n[1] / len, acc_n[2] / len];
            let pd = acc_off / wsum;
            // Project each cluster vertex onto the plane, capped by MAX_VERTEX_MOVE.
            // Same anchor-local frame as the plane: `p` is `v - anchor`, so
            // `dist` multiplies a mesh-extent magnitude, not the raw world
            // position — the anchor is added back once the projection is done.
            let mut seen_v: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
            for &fi in &members {
                for &cv in &facets[fi].tri {
                    if !seen_v.insert(cv) {
                        continue;
                    }
                    let p = anchored(canon_pos[cv]);
                    let dist = p[0] * pn[0] + p[1] * pn[1] + p[2] * pn[2] - pd;
                    if dist.abs() > MAX_VERTEX_MOVE {
                        continue; // crease / far vertex — over-weld guard
                    }
                    let proj = [
                        p[0] - dist * pn[0] + anchor[0],
                        p[1] - dist * pn[1] + anchor[1],
                        p[2] - dist * pn[2] + anchor[2],
                    ];
                    vertex_moves[cv].push(proj);
                }
            }
        };

        for i in 1..keyed.len() {
            if keyed[i].0 - keyed[i - 1].0 > MAX_OFFSET_JITTER {
                process_cluster(&keyed[cluster_start..i]);
                cluster_start = i;
            }
        }
        process_cluster(&keyed[cluster_start..]);
    }

    // ── Step 5: resolve each canonical vertex's final position. A vertex with
    // candidate projections (from one or more clusters) gets their average
    // (deterministic — they were pushed in cluster-iteration order), snapped to
    // the kernel grid; a vertex with none stays put.
    let mut new_canon_pos = canon_pos.clone();
    let mut any_moved = false;
    for cv in 0..n_canon {
        let cands = &vertex_moves[cv];
        if cands.is_empty() {
            continue;
        }
        let mut s = [0.0f64, 0.0, 0.0];
        for c in cands {
            s[0] += c[0];
            s[1] += c[1];
            s[2] += c[2];
        }
        let inv = 1.0 / cands.len() as f64;
        let avg = [s[0] * inv, s[1] * inv, s[2] * inv];
        // Final move cap (the average could exceed the per-cluster cap when two
        // clusters pull opposite ways at a crease).
        let p = canon_pos[cv];
        let d2 = (avg[0] - p[0]).powi(2) + (avg[1] - p[1]).powi(2) + (avg[2] - p[2]).powi(2);
        if d2 > MAX_VERTEX_MOVE * MAX_VERTEX_MOVE {
            continue;
        }
        new_canon_pos[cv] = [snap_grid(avg[0]), snap_grid(avg[1]), snap_grid(avg[2])];
        any_moved = true;
    }

    if !any_moved {
        return mesh.clone();
    }

    // ── Step 6: rebuild with the SAME indices/normals, replacing each ORIGINAL
    // vertex position with its (possibly welded) canonical position.
    let mut out = mesh.clone();
    for i in 0..vertex_count {
        let np = new_canon_pos[canon_of[i]];
        out.positions[i * 3] = np[0] as f32;
        out.positions[i * 3 + 1] = np[1] as f32;
        out.positions[i * 3 + 2] = np[2] as f32;
    }
    out
}

/// Max output-triangle aspect ratio tolerated before [`refine_high_aspect_slivers`]
/// bisects it. 8:1 matches the #1007 success bar; well-shaped cut triangles are
/// far below it, so the pass is a no-op on clean output.
const SLIVER_ASPECT: f64 = 8.0;

/// Absolute cap on bisection rounds so the pass always terminates fast and never
/// explodes triangle count on a pathological mesh.
const MAX_BISECT_ROUNDS: usize = 64;

/// Aspect ratio (longest / shortest edge) of a triangle, `INFINITY` if degenerate.
#[inline]
fn aspect(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let d = |p: [f64; 3], q: [f64; 3]| {
        ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
    };
    let (e0, e1, e2) = (d(a, b), d(b, c), d(c, a));
    let mn = e0.min(e1).min(e2);
    let mx = e0.max(e1).max(e2);
    if mn > 1.0e-9 {
        mx / mn
    } else {
        f64::INFINITY
    }
}

/// WATERTIGHT sliver refinement (issue #1007): bisect the LONGEST edge of any
/// triangle whose aspect ratio exceeds [`SLIVER_ASPECT`], splitting BOTH
/// triangles incident to that edge at the SAME midpoint so the mesh stays
/// watertight (no T-junction) and the midpoint lies ON the original straight
/// edge so VOLUME is preserved exactly. Repeats until no sliver remains or the
/// round cap is hit.
///
/// This is the post-cut complement to [`weld_near_coplanar_facets`]: the host
/// weld fixes the f32 facet jitter, but the exact-kernel cut of a long, tilted
/// host facet can still emit a high-aspect corner sliver (a far-corner triangle
/// fanned to two new rim vertices a few cm apart) that lands ALONE in its plane
/// bucket and bypasses the coplanar CDT. Bisecting its long edge breaks the
/// sliver without touching the opening hole (the hole boundary is framed by its
/// non-degenerate neighbours) or the cut volume.
///
/// ## Determinism (native == wasm)
///
/// FMA-free f64; canonical vertices via the position dedup grid; the sliver
/// worklist is drained in a fixed order (lowest canonical-edge key first) so the
/// same input yields a byte-identical output on every target.
///
/// Returns the input unchanged when no triangle exceeds the threshold (the
/// common case for clean cuts).
pub fn refine_high_aspect_slivers(mesh: &Mesh) -> Mesh {
    refine_high_aspect_slivers_impl(mesh, None)
}

/// Region-scoped [`refine_high_aspect_slivers`]: only triangles whose AABB
/// intersects one of `boxes` are sliver candidates; everything outside is left
/// exactly as authored.
///
/// Motivation (Holter-class steel models): the sliver pass exists to repair
/// high-aspect corner slivers a CUT emits at an opening rim (#1007). Scanning
/// the WHOLE host instead also bisects the mesh's pre-existing long-thin
/// authored faces (a thin steel wall is legitimately full of >8:1 quads the
/// un-cut render path never touches), inflating triangle output and paying the
/// full lockstep-bisection fixpoint on every analytic-cut host. Scoping to the
/// cutter volumes keeps the #1007 rim-quality bar (every rim-incident sliver
/// touches its cutter's box) without refining geometry the cut never created.
/// Callers pad `boxes` for their own seam tolerance; this function adds the
/// canonicalization slack itself.
pub(crate) fn refine_high_aspect_slivers_within(
    mesh: &Mesh,
    boxes: &[([f64; 3], [f64; 3])],
) -> Mesh {
    if boxes.is_empty() {
        return mesh.clone();
    }
    refine_high_aspect_slivers_impl(mesh, Some(boxes))
}

fn refine_high_aspect_slivers_impl(
    mesh: &Mesh,
    region: Option<&[([f64; 3], [f64; 3])]>,
) -> Mesh {
    let vertex_count = mesh.positions.len() / 3;
    if vertex_count < 3 || mesh.indices.len() < 6 {
        return mesh.clone();
    }

    // RAW NO-SLIVER PRE-SCAN (perf; Holter-class hosts fire the prism void
    // fast path on hundreds of clean cuts): the canonicalization below hashes
    // every vertex BEFORE the existing no-sliver fast path can fire, so a
    // clean cut still paid an O(V) hash build per call. Scan the raw f64
    // triangles first with a CONSERVATIVE margin: a canonical (deduped)
    // position differs from its raw one by at most one dedup cell
    // (≤ √3·POSITION_DEDUP_GRID per endpoint, so ≤ 2·√3·POSITION_DEDUP_GRID
    // per edge length), so any triangle whose canonical aspect could exceed
    // SLIVER_ASPECT is caught by widening the raw test by EDGE_SLACK. A raw
    // "maybe" just falls through to the exact canonical scan below; a raw
    // "clean" is proof the canonical scan would find nothing, so returning
    // the input unchanged here is byte-identical to that no-op path.
    const EDGE_SLACK: f64 = 4.0e-4; // > 2·√3·POSITION_DEDUP_GRID
    // TWO paddings, because the raw pre-scan and the canonical scans test
    // DIFFERENT coordinates against the same caller boxes:
    //   - canonical scans use `cpos` (deduped) → EDGE_SLACK.
    //   - the raw pre-scan uses the mesh's raw f64 → 2·EDGE_SLACK.
    // Canonicalization can move a vertex up to one dedup cell (√3·grid) INTO
    // the region, so a triangle sitting raw-OUTSIDE the once-padded box can be
    // canonically INSIDE it. With only one padding the pre-scan would answer
    // "no sliver here" for a triangle the canonical scan would have refined —
    // silently disabling the #1007 rim repair for it. The wider raw box makes
    // the pre-scan's "clean" verdict a genuine proof again, which is what lets
    // it early-out byte-identically.
    let pad_region = |slack: f64| -> Option<Vec<([f64; 3], [f64; 3])>> {
        region.map(|boxes| {
            boxes
                .iter()
                .map(|(lo, hi)| {
                    (
                        [lo[0] - slack, lo[1] - slack, lo[2] - slack],
                        [hi[0] + slack, hi[1] + slack, hi[2] + slack],
                    )
                })
                .collect()
        })
    };
    let padded_region = pad_region(EDGE_SLACK);
    let prescan_region = pad_region(2.0 * EDGE_SLACK);
    let tri_in_boxes = |boxes: Option<&[([f64; 3], [f64; 3])]>,
                        a: [f64; 3],
                        b: [f64; 3],
                        c: [f64; 3]|
     -> bool {
        let Some(boxes) = boxes else {
            return true;
        };
        let lo = [
            a[0].min(b[0]).min(c[0]),
            a[1].min(b[1]).min(c[1]),
            a[2].min(b[2]).min(c[2]),
        ];
        let hi = [
            a[0].max(b[0]).max(c[0]),
            a[1].max(b[1]).max(c[1]),
            a[2].max(b[2]).max(c[2]),
        ];
        boxes
            .iter()
            .any(|(blo, bhi)| (0..3).all(|k| lo[k] <= bhi[k] && hi[k] >= blo[k]))
    };
    let tri_in_region = |a: [f64; 3], b: [f64; 3], c: [f64; 3]| -> bool {
        tri_in_boxes(padded_region.as_deref(), a, b, c)
    };
    let raw_may_have_sliver = mesh.indices.chunks_exact(3).any(|c| {
        let (i0, i1, i2) = (c[0] as usize, c[1] as usize, c[2] as usize);
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            return false; // the canonical tri build drops it too
        }
        let p = |i: usize| -> [f64; 3] {
            [
                mesh.positions[i * 3] as f64,
                mesh.positions[i * 3 + 1] as f64,
                mesh.positions[i * 3 + 2] as f64,
            ]
        };
        let (a, b, c3) = (p(i0), p(i1), p(i2));
        // Raw coordinates ⇒ the WIDER pre-scan boxes (see pad_region above).
        if !tri_in_boxes(prescan_region.as_deref(), a, b, c3) {
            return false;
        }
        let d = |x: [f64; 3], y: [f64; 3]| {
            ((x[0] - y[0]).powi(2) + (x[1] - y[1]).powi(2) + (x[2] - y[2]).powi(2)).sqrt()
        };
        let (e0, e1, e2) = (d(a, b), d(b, c3), d(c3, a));
        let mn = e0.min(e1).min(e2);
        let mx = e0.max(e1).max(e2);
        // A short-min-edge triangle may canonically merge (dropped) or snap to
        // aspect INFINITY; either way it must take the exact scan.
        mn - EDGE_SLACK <= 1.0e-9 || (mx + EDGE_SLACK) > SLIVER_ASPECT * (mn - EDGE_SLACK)
    });
    if !raw_may_have_sliver {
        return mesh.clone();
    }

    // Canonicalise vertices by snapped position so a shared edge is ONE key.
    let pos = |i: usize| -> [f64; 3] {
        [
            mesh.positions[i * 3] as f64,
            mesh.positions[i * 3 + 1] as f64,
            mesh.positions[i * 3 + 2] as f64,
        ]
    };
    let mut canon_of: Vec<usize> = vec![0; vertex_count];
    let mut cpos: Vec<[f64; 3]> = Vec::new();
    {
        // FxHashMap (canonical ids are insertion-ordered via `cpos.len()`, the
        // map is only queried by key — output identical, no tree-balance cost).
        let mut seen: rustc_hash::FxHashMap<(i64, i64, i64), usize> =
            rustc_hash::FxHashMap::default();
        for i in 0..vertex_count {
            let p = pos(i);
            let key = (dedup_key(p[0]), dedup_key(p[1]), dedup_key(p[2]));
            let id = *seen.entry(key).or_insert_with(|| {
                let id = cpos.len();
                cpos.push(p);
                id
            });
            canon_of[i] = id;
        }
    }

    // Triangles as canonical-id triples; drop degenerate / out-of-range.
    let mut tris: Vec<[usize; 3]> = Vec::with_capacity(mesh.indices.len() / 3);
    for c in mesh.indices.chunks_exact(3) {
        let (i0, i1, i2) = (c[0] as usize, c[1] as usize, c[2] as usize);
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            continue;
        }
        let (a, b, d) = (canon_of[i0], canon_of[i1], canon_of[i2]);
        if a == b || b == d || a == d {
            continue;
        }
        tris.push([a, b, d]);
    }

    let edge_key = |u: usize, v: usize| -> (usize, usize) {
        if u < v {
            (u, v)
        } else {
            (v, u)
        }
    };

    // Fast path (common case: a clean cut leaves no slivers). A split only fires
    // for a triangle whose aspect exceeds SLIVER_ASPECT; if none does, the round
    // loop would build its edge map, find nothing, and return the mesh unchanged.
    // One O(T) scan detects that and skips it — byte-identical to that no-op.
    if !tris.iter().any(|t| {
        aspect(cpos[t[0]], cpos[t[1]], cpos[t[2]]) > SLIVER_ASPECT
            && tri_in_region(cpos[t[0]], cpos[t[1]], cpos[t[2]])
    }) {
        return mesh.clone();
    }

    let mut changed_any = false;
    // SCOPED-mode split budget. The unscoped loop is inherently bounded (ONE
    // split per round × MAX_BISECT_ROUNDS). The scoped batched loop splits many
    // edges per round, so a triangle that bisection cannot improve — a
    // DEGENERATE needle (aspect INFINITY: its min edge survives every split)
    // — would re-qualify every round and DOUBLE its fragments each time.
    // Guard twice: scoped candidacy requires a FINITE aspect (splitting an
    // INFINITY needle never helps; `clean_degenerate` drops it downstream),
    // and a hard cap on total splits bounds the worst case regardless.
    const MAX_SCOPED_SPLITS: usize = 2048;
    let mut splits_done = 0usize;
    for _round in 0..MAX_BISECT_ROUNDS {
        // Build edge → incident triangle indices (deterministic BTreeMap).
        let mut edge_tris: BTreeMap<(usize, usize), Vec<usize>> = BTreeMap::new();
        for (ti, t) in tris.iter().enumerate() {
            for (u, v) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                edge_tris.entry(edge_key(u, v)).or_default().push(ti);
            }
        }

        // Collect this round's split edges — lowest-keyed long edges of
        // triangles over the aspect threshold. Deterministic (BTreeMap order).
        //
        // UNSCOPED (`region == None`, the exact-kernel caller): exactly ONE
        // edge per round — the original, byte-pinned behavior.
        //
        // SCOPED (the prism void fast path): every qualifying edge whose
        // incident triangles are not already claimed this round. A rim cut on
        // a thin host emits DOZENS of independent reveal slivers per element;
        // fixing one edge per round re-built this whole edge map once per
        // split (the Holter 4.1.x void fast-path regression). Batching
        // disjoint splits keeps the lockstep-midpoint watertightness argument
        // per edge (each triangle splits at most once per round, both
        // incident triangles split at the same snapped midpoint) and stays
        // deterministic (BTreeMap iteration order; midpoint ids assigned in
        // that same order).
        let mut round_edges: Vec<(usize, usize)> = Vec::new();
        let mut claimed: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
        'outer: for (ek, incident) in &edge_tris {
            // Only split a manifold (2-incident) or boundary (1-incident) edge;
            // a non-manifold (>2) edge is skipped (splitting it can't stay
            // watertight without splitting all incident tris in lockstep, and
            // such edges don't occur on a clean cut sliver).
            if incident.len() > 2 {
                continue;
            }
            if incident.iter().any(|ti| claimed.contains(ti)) {
                continue;
            }
            for &ti in incident {
                let t = tris[ti];
                let a = cpos[t[0]];
                let b = cpos[t[1]];
                let c = cpos[t[2]];
                let asp = aspect(a, b, c);
                if asp <= SLIVER_ASPECT || !tri_in_region(a, b, c) {
                    continue;
                }
                // Scoped mode: finite-aspect slivers only (see MAX_SCOPED_SPLITS).
                if region.is_some() && !asp.is_finite() {
                    continue;
                }
                // Is THIS edge the triangle's LONGEST? Bisecting the longest
                // edge is what reduces the aspect; splitting a short edge of a
                // sliver makes it worse.
                let d = |p: [f64; 3], q: [f64; 3]| {
                    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
                };
                let e01 = d(a, b);
                let e12 = d(b, c);
                let e20 = d(c, a);
                let longest = e01.max(e12).max(e20);
                let this_len = {
                    let (x, y) = *ek;
                    let px = cpos[x];
                    let py = cpos[y];
                    d(px, py)
                };
                if (this_len - longest).abs() < 1.0e-9 {
                    round_edges.push(*ek);
                    claimed.extend(incident.iter().copied());
                    if region.is_none() {
                        break 'outer; // original one-edge-per-round behavior
                    }
                    if splits_done + round_edges.len() >= MAX_SCOPED_SPLITS {
                        break 'outer;
                    }
                    break;
                }
            }
        }

        if round_edges.is_empty() {
            break; // no sliver left
        }

        // New midpoint canonical vertex per split edge, ON the original
        // straight edge ⇒ volume preserved. Snap to the kernel grid for
        // downstream consistency. Ids assigned in `round_edges` (BTreeMap key)
        // order — deterministic.
        let mut edge_mid: BTreeMap<(usize, usize), usize> = BTreeMap::new();
        for &(eu, ev) in &round_edges {
            let a = cpos[eu];
            let b = cpos[ev];
            let pm = [
                snap_grid(0.5 * (a[0] + b[0])),
                snap_grid(0.5 * (a[1] + b[1])),
                snap_grid(0.5 * (a[2] + b[2])),
            ];
            let mid = cpos.len();
            cpos.push(pm);
            edge_mid.insert((eu, ev), mid);
        }

        // Replace each claimed triangle with its two halves about its split
        // edge's midpoint, preserving winding. Each triangle carries at most
        // one split edge (the claim rule above).
        let mut new_tris: Vec<[usize; 3]> = Vec::with_capacity(tris.len() + round_edges.len() * 2);
        for (ti, t) in tris.iter().enumerate() {
            if !claimed.contains(&ti) {
                new_tris.push(*t);
                continue;
            }
            // Rotate so the split edge is (t[k], t[k+1]); the apex is t[k+2].
            let mut split = false;
            for k in 0..3 {
                let u = t[k];
                let v = t[(k + 1) % 3];
                let w = t[(k + 2) % 3];
                if let Some(&mid) = edge_mid.get(&edge_key(u, v)) {
                    // u → mid → w  and  mid → v → w  preserves [u,v,w] winding.
                    new_tris.push([u, mid, w]);
                    new_tris.push([mid, v, w]);
                    split = true;
                    break;
                }
            }
            if !split {
                new_tris.push(*t);
            }
        }
        tris = new_tris;
        changed_any = true;
        splits_done += round_edges.len();
        if region.is_some() && splits_done >= MAX_SCOPED_SPLITS {
            break;
        }
    }

    if !changed_any {
        return mesh.clone();
    }

    // Rebuild a flat mesh from the refined canonical triangles, re-deriving a
    // per-face flat normal (the input may not carry usable normals after a cut).
    let mut positions: Vec<f32> = Vec::with_capacity(tris.len() * 9);
    let mut normals: Vec<f32> = Vec::with_capacity(tris.len() * 9);
    let mut indices: Vec<u32> = Vec::with_capacity(tris.len() * 3);
    for t in &tris {
        let a = cpos[t[0]];
        let b = cpos[t[1]];
        let c = cpos[t[2]];
        let n = tri_normal(a, b, c).map(|(n, _)| n).unwrap_or([0.0, 0.0, 1.0]);
        let base = (positions.len() / 3) as u32;
        for p in [a, b, c] {
            positions.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
            normals.extend_from_slice(&[n[0] as f32, n[1] as f32, n[2] as f32]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    // Carry the host's placement / frame metadata (origin, rtc, #1474 capture)
    // forward. This pass runs AFTER placement, so a bare rebuild would reset the
    // local-frame origin + #1474 capture to defaults and mis-place exactly the
    // hosts whose cuts slivered. `instance_meta` is dropped (the refined mesh no
    // longer matches its canonical rep) — see `Mesh::rebuilt_like`.
    mesh.rebuilt_like(positions, normals, indices)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mesh_from_tris(tris: &[[[f64; 3]; 3]]) -> Mesh {
        let mut m = Mesh::new();
        for t in tris {
            let base = (m.positions.len() / 3) as u32;
            for p in t {
                m.positions
                    .extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
                m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        }
        m
    }

    fn vert(m: &Mesh, i: usize) -> [f64; 3] {
        [
            m.positions[i * 3] as f64,
            m.positions[i * 3 + 1] as f64,
            m.positions[i * 3 + 2] as f64,
        ]
    }

    /// Distinct 1 µm-offset planes within one quantised-normal group — this is
    /// exactly what `consolidate_coplanar` buckets on.
    fn distinct_offset_buckets(m: &Mesh) -> usize {
        use std::collections::BTreeSet;
        let mut set: BTreeSet<i64> = BTreeSet::new();
        for c in m.indices.chunks_exact(3) {
            let a = vert(m, c[0] as usize);
            let b = vert(m, c[1] as usize);
            let d = vert(m, c[2] as usize);
            if let Some((n, _)) = super::tri_normal(a, b, d) {
                let s = if n[0] + n[1] + n[2] < 0.0 { -1.0 } else { 1.0 };
                let off = (n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) * s;
                set.insert((off * 1.0e6).round() as i64);
            }
        }
        set.len()
    }

    /// Same as [`distinct_offset_buckets`] but anchored at the mesh's vertex
    /// centroid, not the raw vertex — `distinct_offset_buckets` itself
    /// inherits the amplification bug at site-scale coordinates (`f32` ULP at
    /// ~8.7 km is ~1 mm, a hundred times coarser than the 1 µm bucket grid,
    /// so an already-coplanar mesh reads back as multiple raw-frame buckets
    /// from storage quantization alone). This is the fair check for whether
    /// the weld's OWN clustering worked.
    fn distinct_offset_buckets_anchored(m: &Mesh) -> usize {
        use std::collections::BTreeSet;
        let vertex_count = m.positions.len() / 3;
        if vertex_count == 0 {
            return 0;
        }
        // Centroid, not a single facet's own corner (which would trivially
        // zero the offset for any facet containing it).
        let mut anchor = [0.0f64, 0.0, 0.0];
        for i in 0..vertex_count {
            let p = vert(m, i);
            anchor[0] += p[0];
            anchor[1] += p[1];
            anchor[2] += p[2];
        }
        let inv = 1.0 / vertex_count as f64;
        anchor = [anchor[0] * inv, anchor[1] * inv, anchor[2] * inv];
        let mut set: BTreeSet<i64> = BTreeSet::new();
        for c in m.indices.chunks_exact(3) {
            let sub = |p: [f64; 3]| [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]];
            let a = sub(vert(m, c[0] as usize));
            let b = sub(vert(m, c[1] as usize));
            let d = sub(vert(m, c[2] as usize));
            if let Some((n, _)) = super::tri_normal(a, b, d) {
                let s = if n[0] + n[1] + n[2] < 0.0 { -1.0 } else { 1.0 };
                let off = (n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) * s;
                set.insert((off * 1.0e6).round() as i64);
            }
        }
        set.len()
    }

    /// Two coplanar facets whose plane offset jitters by ~15 µm (the #1112
    /// signature) MUST weld to ONE offset bucket; two facets 0.4 m apart MUST
    /// NOT merge.
    #[test]
    fn welds_offset_jitter_not_distinct_plane() {
        // A flat z=0 slab split into 2 triangles, the second lifted 15 µm in z
        // (a pure offset jitter — same normal).
        let j = 15.0e-6;
        let jitter = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[1.0, 0.0, j], [1.0, 1.0, j], [0.0, 1.0, j]],
        ]);
        assert_eq!(
            distinct_offset_buckets(&jitter),
            2,
            "pre-weld the two facets must sit on distinct 1µm offset buckets"
        );
        let welded = weld_near_coplanar_facets(&jitter);
        assert_eq!(
            distinct_offset_buckets(&welded),
            1,
            "15µm offset jitter must weld to ONE offset bucket"
        );

        // Same normal but 0.4 m apart — a genuinely distinct parallel plane.
        let distinct = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[1.0, 0.0, 0.4], [1.0, 1.0, 0.4], [0.0, 1.0, 0.4]],
        ]);
        let welded_d = weld_near_coplanar_facets(&distinct);
        assert_eq!(
            distinct_offset_buckets(&welded_d),
            2,
            "0.4m-apart planes must NOT merge"
        );
    }

    /// Two facets ~0.09° apart by NORMAL weld; ~0.5° apart do NOT — the angular
    /// over-weld guard (distinct normal buckets keep real pitch apart).
    #[test]
    fn welds_small_angle_not_real_feature() {
        let small = (0.09_f64).to_radians().tan();
        let big = (0.5_f64).to_radians().tan();

        // Shared edge along X at y=0; second facet tilted by the jitter angle.
        let jitter = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.5, 1.0, small]],
        ]);
        let welded = weld_near_coplanar_facets(&jitter);
        // After weld both facets share the fitted plane (offset bucket count 1).
        assert_eq!(
            distinct_offset_buckets(&welded),
            1,
            "0.09° + same-bucket-normal jitter must weld coplanar"
        );

        let feature = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.5, 1.0, big]],
        ]);
        let before = distinct_offset_buckets(&feature);
        let welded_f = weld_near_coplanar_facets(&feature);
        let after = distinct_offset_buckets(&welded_f);
        assert_eq!(
            before, after,
            "a real 0.5° feature must NOT weld (distinct normal bucket)"
        );
    }

    #[test]
    fn flat_pair_is_noop_topology() {
        let flat = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
        ]);
        let welded = weld_near_coplanar_facets(&flat);
        assert_eq!(welded.indices, flat.indices, "topology must be preserved");
        assert_eq!(welded.positions.len(), flat.positions.len());
    }

    #[test]
    fn weld_is_deterministic() {
        let j = 15.0e-6;
        let m = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[1.0, 0.0, j], [1.0, 1.0, j], [0.0, 1.0, j]],
            [[2.0, 0.0, j], [3.0, 0.0, 0.0], [2.0, 1.0, j]],
        ]);
        let a = weld_near_coplanar_facets(&m);
        let b = weld_near_coplanar_facets(&m);
        assert_eq!(a.positions, b.positions);
        assert_eq!(a.indices, b.indices);
    }

    /// Ordinary site coordinates (~150 m, well under
    /// `LARGE_COORD_THRESHOLD_METERS`) must weld exactly as well as the
    /// near-origin case. Same structure as `welds_offset_jitter_not_distinct_plane`,
    /// just translated. 150 m, not thousands: beyond ~840 m `f32`'s ULP
    /// exceeds `POSITION_DEDUP_GRID`, a separate pre-existing dedup
    /// limitation this change doesn't touch (see
    /// `anchored_formula_removes_offset_amplification`); below that, this
    /// isolates the one thing that IS fixed here.
    #[test]
    fn welds_offset_jitter_at_large_site_coordinates() {
        let j = 2.0e-5; // > 1 f32-ULP at ~150m (survives storage), < POSITION_DEDUP_GRID
        let t = [120.123_f64, 150.456, 100.789];
        let add = |p: [f64; 3]| [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
        let jittered = mesh_from_tris(&[
            [
                add([0.0, 0.0, 0.0]),
                add([10.0, 0.0, 0.0]),
                add([0.0, 10.0, 0.0]),
            ],
            [
                add([10.0, 0.0, j]),
                add([10.0, 10.0, j]),
                add([0.0, 10.0, j]),
            ],
        ]);

        // Anchored check — see `distinct_offset_buckets_anchored` doc.
        let pre_buckets = distinct_offset_buckets_anchored(&jittered);
        let welded = weld_near_coplanar_facets(&jittered);
        let post_buckets = distinct_offset_buckets_anchored(&welded);

        eprintln!(
            "large-site weld: anchor={t:?} j={j:e} pre_buckets={pre_buckets} post_buckets={post_buckets}"
        );
        assert_eq!(
            post_buckets, 1,
            "two facets of one authored plane at a real site offset must weld \
             to ONE offset bucket, same as the near-origin \
             `welds_offset_jitter_not_distinct_plane` case — got {post_buckets} \
             (pre-weld: {pre_buckets})"
        );
    }

    /// The invariant this fix restores: the anchor must be a function of the
    /// vertex SET, not of vertex numbering. Builds the same 3 facets (a weld
    /// cluster + one unrelated far facet) in two vertex orders — far facet
    /// first vs. last, so a different physical vertex would have been
    /// `canon_pos[0]` under the old first-vertex anchor — and asserts every
    /// vertex's welded position is bit-identical between the two orderings
    /// once matched back to the same physical vertex.
    ///
    /// This encodes the invariant behind the census's #6588 finding (a host
    /// newly dependent on the triangulator's diagonal choice) rather than
    /// hand-reproducing its exact divergence: that divergence is a
    /// corpus-scale, floating-point-boundary coincidence (the real
    /// duplex.ifc #6426 fixture does not diverge at this synthetic scale
    /// either) that resisted small hand-built reconstruction. The
    /// bit-identity assertion below is correct-by-construction regardless:
    /// two orderings of the same mesh must weld to the same result, full stop.
    #[test]
    fn anchor_is_stable_under_vertex_reordering() {
        let j = 4.9e-5; // just under MAX_OFFSET_JITTER (5e-5): any perturbation can flip the bucket
        let t = [5000.123_f64, 3000.456, 7000.789];
        let add = |p: [f64; 3]| [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
        let facet1 = [add([0.0, 0.0, 0.0]), add([10.0, 0.0, 0.0]), add([0.0, 10.0, 0.0])];
        let facet2 = [add([10.0, 0.0, j]), add([10.0, 10.0, j]), add([0.0, 10.0, j])];
        // Unrelated facet, 1 km from the cluster, distinct normal bucket.
        let d0 = add([1000.0, 0.0, 0.0]);
        let d1 = add([1000.0, 0.0, 1.0]);
        let d2 = add([1001.0, 1.0, 0.5]);
        let far_facet = [d0, d1, d2];

        let vertex0_far = mesh_from_tris(&[far_facet, facet1, facet2]);
        let vertex0_cluster = mesh_from_tris(&[facet1, facet2, far_facet]);

        let welded_far_first = weld_near_coplanar_facets(&vertex0_far);
        let welded_cluster_first = weld_near_coplanar_facets(&vertex0_cluster);

        // `vertex0_far`'s raw vertex order is `vertex0_cluster`'s rotated by
        // the far facet's 3 vertices (moved from last to first): raw index i
        // in `vertex0_cluster` is the SAME physical vertex as raw index
        // `(i + 3) % 9` in `vertex0_far`. Compare every vertex's welded
        // position bit-for-bit through that correspondence.
        for i in 0..9 {
            let far_i = (i + 3) % 9;
            let cluster_pos = &welded_cluster_first.positions[i * 3..i * 3 + 3];
            let far_pos = &welded_far_first.positions[far_i * 3..far_i * 3 + 3];
            assert_eq!(
                cluster_pos, far_pos,
                "vertex {i} (cluster-first raw id) / {far_i} (far-first raw \
                 id) is the SAME physical vertex — its welded position must \
                 be bit-identical regardless of which vertex was numbered \
                 first. cluster-first={cluster_pos:?} far-first={far_pos:?}"
            );
        }
    }

    /// Isolates the offset-formula fix from the full `weld_near_coplanar_facets`
    /// pipeline (so `POSITION_DEDUP_GRID`'s separate limitation, see above,
    /// can't interfere), using the smallest jitter that survives `f32`
    /// storage at ~5000-7000 m (a true 15 µm #1112-scale jitter is
    /// unrepresentable there).
    ///
    /// Asserts the ANCHORED gap clears `MAX_OFFSET_JITTER` when the anchor is
    /// on the shared edge (the common case, since `weld_near_coplanar_facets`
    /// anchors at the mesh's bbox-min corner, typically part of or near the
    /// cluster being welded), against a RAW gap orders of magnitude over
    /// tolerance. Also PRINTS (doesn't assert) the gap for an anchor
    /// progressively farther from the cluster: the residual scales with
    /// anchor-to-cluster distance (mesh-scale) rather than world-origin
    /// distance (site-scale) — a large improvement, not a complete
    /// elimination for a sprawling host.
    #[test]
    fn anchored_formula_removes_offset_amplification() {
        let t = [5000.123_f64, 3000.456, 7000.789];
        // Smallest vertex divergence that survives f32 storage at this magnitude.
        let ulp_at_t2 = {
            let f = t[2] as f32;
            (f32::from_bits(f.to_bits() + 1) - f) as f64
        };
        eprintln!("f32 ULP near {}: {ulp_at_t2:e}", t[2]);

        for edge in [1.0_f64, 10.0_f64] {
            let add = |p: [f64; 3]| [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
            // Facet1 flat, not axis-aligned (avoids a spurious zero dot
            // product from an orthogonal edge/normal). Facet2 shares the
            // (A,B) edge; its unique corner is lifted by one f32 ULP.
            let a = add([0.0, 0.0, 0.0]);
            let b = add([edge, 0.3 * edge, 0.05 * edge]);
            let c1 = add([0.2 * edge, edge, 0.1 * edge]);
            let c2 = add([0.2 * edge, edge, 0.1 * edge + ulp_at_t2]);

            // Evaluate at the vertex that moved (c1/c2) — a shared-edge
            // vertex would vanish by construction regardless of the gap.
            let raw_gap = {
                let n1 = super::tri_normal(a, b, c1).unwrap().0;
                let n2 = super::tri_normal(b, c2, a).unwrap().0;
                let off1 = n1[0] * c1[0] + n1[1] * c1[1] + n1[2] * c1[2];
                let off2 = n2[0] * c2[0] + n2[1] * c2[1] + n2[2] * c2[2];
                (off1 - off2).abs()
            };
            let anchored_gap = {
                let anchor = a;
                let s = |p: [f64; 3]| [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]];
                let (a2, b2, c1a) = (s(a), s(b), s(c1));
                let (b2b, c2a, a2a) = (s(b), s(c2), s(a));
                let n1 = super::tri_normal(a2, b2, c1a).unwrap().0;
                let n2 = super::tri_normal(b2b, c2a, a2a).unwrap().0;
                let off1 = n1[0] * c1a[0] + n1[1] * c1a[1] + n1[2] * c1a[2];
                let off2 = n2[0] * c2a[0] + n2[1] * c2a[1] + n2[2] * c2a[2];
                (off1 - off2).abs()
            };
            eprintln!(
                "edge={edge}m: raw_gap={raw_gap:e} anchored_gap={anchored_gap:e} \
                 MAX_OFFSET_JITTER={MAX_OFFSET_JITTER:e}"
            );
            assert!(
                raw_gap > MAX_OFFSET_JITTER,
                "RAW formula must be shown failing (amplified) for this to \
                 be a meaningful RED case; edge={edge}m raw_gap={raw_gap:e}"
            );
            assert!(
                anchored_gap < MAX_OFFSET_JITTER,
                "ANCHORED formula must bring the gap back under tolerance \
                 when the anchor is on the shared edge; edge={edge}m \
                 anchored_gap={anchored_gap:e}"
            );

            // WORST CASE: the global anchor (bbox-min corner) belongs to a
            // DIFFERENT part of a large host, `far_m` away from this
            // cluster's shared edge — plausible for a big
            // multi-slope roof. Offset is a PLANE property (constant across
            // all 3 of a triangle's own vertices), so the gap is
            // `δn · (shared_edge_point − anchor)`; an anchor ON the shared
            // edge cancels EXACTLY (see the `anchored_gap≈0` result above) —
            // an anchor `far_m` away does not.
            for far_m in [1.0_f64, 10.0_f64, 50.0_f64] {
                let anchor = [a[0] - far_m, a[1], a[2]];
                let s = |p: [f64; 3]| [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]];
                let (a2, b2, c1a) = (s(a), s(b), s(c1));
                let (b2b, c2a, a2a) = (s(b), s(c2), s(a));
                let n1 = super::tri_normal(a2, b2, c1a).unwrap().0;
                let n2 = super::tri_normal(b2b, c2a, a2a).unwrap().0;
                let off1 = n1[0] * c1a[0] + n1[1] * c1a[1] + n1[2] * c1a[2];
                let off2 = n2[0] * c2a[0] + n2[1] * c2a[1] + n2[2] * c2a[2];
                let gap_far = (off1 - off2).abs();
                eprintln!(
                    "  edge={edge}m anchor {far_m}m from cluster: gap={gap_far:e} \
                     ({} MAX_OFFSET_JITTER)",
                    if gap_far < MAX_OFFSET_JITTER { "<" } else { ">=" }
                );
            }
        }
    }
}

#[cfg(test)]
#[path = "facet_weld_scoped_tests.rs"]
mod facet_weld_scoped_tests;
