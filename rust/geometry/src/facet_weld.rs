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
//! vertices onto one fitted plane per edge-connected patch BEFORE the cut.
//! Remote patches admitted by the same approximate plane bucket do not share
//! a fit (#7633): short f32 edges can give their normals different errors,
//! whose fitted-plane offset grows with the distance between the patches. After welding,
//! those facets share an EXACT offset, so `consolidate_coplanar` coalesces them
//! into one region, the CDT refines the slope-with-opening-hole, and the
//! far-corner sliver fan is gone — while the opening stays a clean hole.
//!
//! ## Geometry-faithful (over-weld guard)
//!
//! Two guards keep the weld from flattening a real feature: facets must share a
//! quantised normal (~0.06° resolution) and offsets within `MAX_OFFSET_JITTER`.
//! Thus real pitches and #1112's distinct parallel slopes remain separated.
//!
//! On top of that the per-vertex MOVE is hard-capped (`MAX_VERTEX_MOVE`): a
//! vertex is only projected if it lands within that cap of the fitted plane, so
//! a vertex on a real crease between the slope and a perpendicular cap is moved
//! by at most the jitter (sub-100 µm) and never dragged onto a far plane. The
//! correction is sub-millimetre at building scale; cut volume is preserved
//! within the kernel's snap grid.
//!
//! Facet passes assume the router's index-only source cleanup (#4797); they neither replace it nor promise hygienic output. New candidates need local handling.
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
//! Welding moves SHARED canonical vertices (deduped on a 100 µm cell), so
//! every facet incident to a moved vertex moves WITH it — no gaps and no
//! T-junctions. When a vertex is eligible for more than one plane cluster, the
//! candidate projected positions are averaged (deterministic order) and the
//! result is still bounded by `MAX_VERTEX_MOVE`, so a single final position is
//! used by all incident facets. Only cells that weld are written back; every
//! other vertex keeps its input position bit-for-bit (#4698).

use crate::mesh::Mesh;
use std::collections::BTreeMap;

mod cut_vertices;
mod components;
mod eligibility;
mod fit;
pub(crate) use cut_vertices::canonicalize_cut_vertices;
use fit::Facet;

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
use crate::math::v3;

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
    let n = v3::tri_normal(a, b, c);
    let len = v3::norm(n);
    // Not `v3::normalize(n, 0.0)`: that also refuses a non-finite length, and
    // this weld has always passed one through (`NaN <= 0.0` is false).
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
/// The returned mesh keeps the SAME topology (same indices); only vertices in
/// welded dedup cells move, snapped to the kernel grid.
///
/// Preserve the router's source cleanup; this is no hygiene guarantee (#4797).
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
    //
    // GATE (watertightness census #2611 regression): the anchor itself is not
    // free. `Facet::offset` (Step 2, below) is `n·(v - anchor)` using EACH
    // FACET'S OWN normal — not one shared reference normal — so comparing two
    // facets' offsets (Step 4's clustering gap) carries a residual
    // `(n_i − n_j)·anchor` cross-term that the pre-anchor `n·v` formulation
    // never had. `(n_i − n_j)` is bounded only by the `NORMAL_QUANT` bucket
    // width (~0.057°) — normal-computation noise from anywhere upstream, not
    // only the f32 import jitter this module targets (measured contributor on
    // the regressed hosts: the void-cut local-frame rotation, `mesh_to_frame`
    // in `router/voids/mod.rs`, perturbs a facet's normal by ~5e-5, two orders
    // above plain f32 jitter) — and `anchor` is a WHOLE-MESH bbox-min, so it
    // can be metres from the specific facet pair being compared even on a
    // small local mesh. At ordinary building scale that cross-term (~tens of
    // µm to single-digit mm here) can swallow a genuine sub-millimetre plane
    // separation (over-merge, losing triangles) or inflate a genuinely-mergeable
    // gap past `MAX_OFFSET_JITTER` in a triangulation-dependent way (the
    // exact two failure shapes the census caught: `dental_clinic.ifc #1311`,
    // `ISSUE_129…IGC_V17.ifc #81562`, `rvt01.ifc #6588` — none of which is a
    // large-site host: `max|raw| < 30 m` on every one, well under this gate).
    //
    // The amplification this anchor exists to fix only bites once `|v|` is
    // large enough for `δn·|v|` (δn ~ genuine f32 import jitter, empirically
    // single-digit µm per component at building scale — see the module's
    // opening comment) to approach `MAX_OFFSET_JITTER` on its own — hundreds
    // of metres at minimum, thousands in the motivating case (this file's own
    // `anchored_formula_removes_offset_amplification` test uses ~5000–7000 m).
    // Below that, subtracting the anchor buys nothing (the un-anchored
    // amplification is already negligible) while still paying the cross-term
    // risk above. So: use the anchor only once the mesh's own raw coordinates
    // are large enough to need it; otherwise anchor at the origin, which
    // reproduces the pre-anchor `n·v` formulation exactly (bit-for-bit) and
    // is what the golden watertightness census was blessed against.
    //
    // `ANCHOR_ENGAGE_METERS = 100.0`: above the three regressed hosts'
    // `max|raw| < 30 m` (with a >3x margin) and below the 150 m this file's
    // own `welds_offset_jitter_at_large_site_coordinates` test validates the
    // anchor at, and far below the ~5000–7000 m scale
    // `anchored_formula_removes_offset_amplification` validates it at.
    const ANCHOR_ENGAGE_METERS: f64 = 100.0;
    let max_raw = canon_pos.iter().fold(0.0f64, |m, p| {
        m.max(p[0].abs()).max(p[1].abs()).max(p[2].abs())
    });
    let anchor = if max_raw >= ANCHOR_ENGAGE_METERS {
        canon_pos.iter().fold([f64::INFINITY; 3], |acc, p| {
            [acc[0].min(p[0]), acc[1].min(p[1]), acc[2].min(p[2])]
        })
    } else {
        [0.0, 0.0, 0.0]
    };
    let anchored = |p: [f64; 3]| -> [f64; 3] {
        [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]]
    };

    // ── Step 2: per-facet canonical triangle, unit normal, area, plane
    // offset — normal and offset computed in the anchor-local frame (Step 1.5).
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
    // plane candidate. Fit each full-edge-connected patch independently (#7633),
    // using the existing canonical vertex IDs and unchanged admission bands.
    //
    // A "plane" is `(unit normal, offset)`. We accumulate per-vertex candidate
    // projected positions and average them (Step 5) so a crease vertex shared by
    // two clusters gets one deterministic final position.
    let mut vertex_moves: Vec<Vec<[f64; 3]>> = vec![Vec::new(); n_canon];
    // Full-edge components are ambiguous on nonconforming triangle soups.
    // Evaluate the source certificate only if a cluster actually splits.
    let mut partition_eligible = None;

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
            let mut members: Vec<usize> = slice.iter().map(|&(_, fi)| fi).collect();
            members.sort_unstable();
            components::for_each(&members, |fi| facets[fi].tri, |groups| {
                *partition_eligible.get_or_insert_with(|| eligibility::source_is_conforming(mesh, &canon_of, &canon_pos))
                    && !eligibility::patch_is_planar(&facets, &members, &canon_pos, anchor)
                    && groups.iter().all(|group| eligibility::patch_is_planar(&facets, group, &canon_pos, anchor))
            }, |component| {
                fit::project_component(&facets, component, ref_n, &canon_pos, anchor, &mut vertex_moves);
            });
        };

        for i in 1..keyed.len() {
            if keyed[i].0 - keyed[i - 1].0 > MAX_OFFSET_JITTER {
                process_cluster(&keyed[cluster_start..i]);
                cluster_start = i;
            }
        }
        process_cluster(&keyed[cluster_start..]);
    }

    // ── Step 5: each canonical vertex's welded position, if any: the average of
    // its candidate projections (deterministic — pushed in cluster-iteration
    // order), snapped to the kernel grid; `None` when it has no candidates or the
    // average breaks `MAX_VERTEX_MOVE`.
    let mut welded: Vec<Option<[f32; 3]>> = vec![None; n_canon];
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
        welded[cv] = Some([
            snap_grid(avg[0]) as f32,
            snap_grid(avg[1]) as f32,
            snap_grid(avg[2]) as f32,
        ]);
    }

    // ── Step 6: same indices/normals; only welded cells are written back (see
    // the module's Watertightness section). With nothing welded this is `mesh`.
    let mut out = mesh.clone();
    for (dst, &cv) in out.positions.chunks_exact_mut(3).zip(&canon_of) {
        if let Some(p) = welded[cv] {
            dst.copy_from_slice(&p);
        }
    }
    out
}

// This test entry point also exists on the parent revision so the revert
// oracle can run the same invariants against the previous bisection path.
#[cfg(test)]
fn refine_high_aspect_slivers_within(mesh: &Mesh, boxes: &[([f64; 3], [f64; 3])]) -> Mesh {
    canonicalize_cut_vertices(mesh, Some(boxes)).unwrap_or_else(|| mesh.clone())
}

#[cfg(test)]
#[path = "facet_weld_scoped_tests.rs"]
mod facet_weld_scoped_tests;

#[cfg(test)]
#[path = "facet_weld/remote_tests.rs"]
mod remote_tests;
