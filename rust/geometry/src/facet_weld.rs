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

    // ── Step 2: per-facet canonical triangle, unit normal, area, plane offset.
    struct Facet {
        tri: [usize; 3],
        normal: [f64; 3],
        offset: f64, // signed-normal plane offset (n·v0)
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
        if let Some((normal, area2)) = tri_normal(canon_pos[a], canon_pos[b], canon_pos[d]) {
            let offset =
                normal[0] * canon_pos[a][0] + normal[1] * canon_pos[a][1] + normal[2] * canon_pos[a][2];
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
            // Plane: unit normal `pn`, offset `pd` so pn·x = pd. `acc_off` is
            // Σ wᵢ (nᵢ·vᵢ) with each |nᵢ|=1 and sign-aligned, so the weighted
            // mean offset `acc_off / wsum` is already expressed against a unit
            // normal and is consistent with `pn` (the same area-weighted mean
            // direction, renormalised).
            let pn = [acc_n[0] / len, acc_n[1] / len, acc_n[2] / len];
            let pd = acc_off / wsum;
            // Project each cluster vertex onto the plane, capped by MAX_VERTEX_MOVE.
            let mut seen_v: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
            for &fi in &members {
                for &cv in &facets[fi].tri {
                    if !seen_v.insert(cv) {
                        continue;
                    }
                    let p = canon_pos[cv];
                    let dist = p[0] * pn[0] + p[1] * pn[1] + p[2] * pn[2] - pd;
                    if dist.abs() > MAX_VERTEX_MOVE {
                        continue; // crease / far vertex — over-weld guard
                    }
                    let proj = [
                        p[0] - dist * pn[0],
                        p[1] - dist * pn[1],
                        p[2] - dist * pn[2],
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
    let vertex_count = mesh.positions.len() / 3;
    if vertex_count < 3 || mesh.indices.len() < 6 {
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
    if !tris
        .iter()
        .any(|t| aspect(cpos[t[0]], cpos[t[1]], cpos[t[2]]) > SLIVER_ASPECT)
    {
        return mesh.clone();
    }

    let mut changed_any = false;
    for _round in 0..MAX_BISECT_ROUNDS {
        // Build edge → incident triangle indices (deterministic BTreeMap).
        let mut edge_tris: BTreeMap<(usize, usize), Vec<usize>> = BTreeMap::new();
        for (ti, t) in tris.iter().enumerate() {
            for (u, v) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                edge_tris.entry(edge_key(u, v)).or_default().push(ti);
            }
        }

        // Find the sliver to fix this round: lowest-keyed long edge of any
        // triangle over the aspect threshold. Deterministic (BTreeMap order).
        let mut target: Option<(usize, usize)> = None;
        'outer: for (ek, incident) in &edge_tris {
            // Only split a manifold (2-incident) or boundary (1-incident) edge;
            // a non-manifold (>2) edge is skipped (splitting it can't stay
            // watertight without splitting all incident tris in lockstep, and
            // such edges don't occur on a clean cut sliver).
            if incident.len() > 2 {
                continue;
            }
            for &ti in incident {
                let t = tris[ti];
                let a = cpos[t[0]];
                let b = cpos[t[1]];
                let c = cpos[t[2]];
                if aspect(a, b, c) <= SLIVER_ASPECT {
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
                    target = Some(*ek);
                    break 'outer;
                }
            }
        }

        let Some((eu, ev)) = target else {
            break; // no sliver left
        };
        let incident = edge_tris.get(&(eu, ev)).cloned().unwrap_or_default();
        if incident.is_empty() {
            break;
        }

        // New midpoint canonical vertex, ON the original straight edge ⇒ volume
        // preserved. Snap to the kernel grid for downstream consistency.
        let pm = {
            let a = cpos[eu];
            let b = cpos[ev];
            [
                snap_grid(0.5 * (a[0] + b[0])),
                snap_grid(0.5 * (a[1] + b[1])),
                snap_grid(0.5 * (a[2] + b[2])),
            ]
        };
        let mid = cpos.len();
        cpos.push(pm);

        // Replace each incident triangle with its two halves about the midpoint,
        // preserving winding. Collect the survivors + new tris.
        let inc_set: std::collections::BTreeSet<usize> = incident.iter().copied().collect();
        let mut new_tris: Vec<[usize; 3]> = Vec::with_capacity(tris.len() + incident.len());
        for (ti, t) in tris.iter().enumerate() {
            if !inc_set.contains(&ti) {
                new_tris.push(*t);
                continue;
            }
            // Rotate so the split edge is (t[k], t[k+1]); the apex is t[k+2].
            let mut split = false;
            for k in 0..3 {
                let u = t[k];
                let v = t[(k + 1) % 3];
                let w = t[(k + 2) % 3];
                if edge_key(u, v) == (eu, ev) {
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
}
