// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Grid vertex-clustering decimation.
//!
//! Rust port of the renderer's LOD1 `simplifyIndicesByClustering`
//! (`packages/renderer/src/lod-simplify.ts`): vertices snap to a uniform
//! grid, each occupied cell elects its first vertex as representative, and a
//! triangle survives only when its three corners land in three DISTINCT
//! cells. Keys on POSITION, so it works on the pipeline's unwelded
//! flat-shaded soup (coincident duplicated vertices collapse together). The
//! per-element scope makes the TS version's entity-id key lane unnecessary.
//!
//! Unlike the TS version (a second index buffer over the same vertex
//! buffer), the result here feeds a re-export, so unreferenced vertices are
//! compacted away.

use crate::mesh::Mesh;
use rustc_hash::FxHashMap;

/// Starting cell edge as a fraction of the AABB diagonal for the
/// ratio-search loop. Deliberately far below the renderer's 0.02 LOD budget:
/// the loop only ever GROWS the cell, so it must start fine enough that a
/// mild target ratio (0.5) is reachable on the first iterations.
const BASE_CELL_FRACTION: f32 = 0.0025;

/// Cell growth factor per ratio-search iteration.
const CELL_GROWTH: f32 = 1.6;

/// Maximum ratio-search iterations. Each pass is O(n), so this bounds the
/// whole search at ~10 linear scans; cell size spans a 1.6^10 ≈ 110x range,
/// enough to go from BASE_CELL_FRACTION past the 0.02 renderer budget on any
/// realistic ratio target.
const MAX_ITERATIONS: u32 = 10;

/// One clustering pass at a fixed cell size. Returns the decimated mesh with
/// unreferenced vertices compacted (metadata carried via `rebuilt_like` —
/// representatives are existing vertices, so the extent never grows).
pub(crate) fn cluster_decimate(mesh: &Mesh, cell_size: f32) -> Mesh {
    let n_verts = mesh.positions.len() / 3;
    if n_verts == 0 || mesh.indices.is_empty() || !(cell_size > 0.0) || !cell_size.is_finite() {
        return mesh.clone();
    }

    // Representative vertex per grid cell, first-vertex-wins (deterministic:
    // vertices are visited in buffer order).
    let inv = 1.0f64 / cell_size as f64;
    let mut rep_of_cell: FxHashMap<[i64; 3], u32> = FxHashMap::default();
    let mut rep: Vec<u32> = Vec::with_capacity(n_verts);
    for i in 0..n_verts {
        let key = [
            (mesh.positions[i * 3] as f64 * inv).floor() as i64,
            (mesh.positions[i * 3 + 1] as f64 * inv).floor() as i64,
            (mesh.positions[i * 3 + 2] as f64 * inv).floor() as i64,
        ];
        rep.push(*rep_of_cell.entry(key).or_insert(i as u32));
    }

    // Keep triangles whose corners land in three distinct cells.
    let mut kept: Vec<u32> = Vec::with_capacity(mesh.indices.len());
    for tri in mesh.indices.chunks_exact(3) {
        if (tri[0] as usize) >= n_verts
            || (tri[1] as usize) >= n_verts
            || (tri[2] as usize) >= n_verts
        {
            continue;
        }
        let (a, b, c) = (
            rep[tri[0] as usize],
            rep[tri[1] as usize],
            rep[tri[2] as usize],
        );
        if a == b || b == c || a == c {
            continue;
        }
        kept.extend_from_slice(&[a, b, c]);
    }

    // Compact: remap referenced vertices, drop orphans (same pattern as
    // `Mesh::clip_triangles_to_aabb`). Normals are intentionally DROPPED:
    // the surviving triangles reconnect representatives of different original
    // faces, so a representative's copied face normal no longer matches its
    // new topology. Returning an empty normal buffer makes the consumer
    // rebuild them (the demesher session's `averaged_vertex_normals`
    // fallback) instead of shading with stale ones.
    let mut remap: Vec<i32> = vec![-1; n_verts];
    let mut new_pos: Vec<f32> = Vec::with_capacity(kept.len() * 3);
    let mut new_idx: Vec<u32> = Vec::with_capacity(kept.len());
    for &i in &kept {
        let old = i as usize;
        let slot = if remap[old] < 0 {
            let n = (new_pos.len() / 3) as u32;
            remap[old] = n as i32;
            new_pos.extend_from_slice(&mesh.positions[old * 3..old * 3 + 3]);
            n
        } else {
            remap[old] as u32
        };
        new_idx.push(slot);
    }

    mesh.rebuilt_like(new_pos, Vec::new(), new_idx)
}

/// Decimate toward `target_ratio` of the input triangle count by growing the
/// clustering cell until the count fits. Returns the result and the number
/// of iterations taken (0 = input already at/below target).
///
/// Deterministic: every pass clusters the ORIGINAL mesh (never iteratively
/// re-clusters its own output), and the cell schedule is fixed. If even the
/// largest cell cannot reach the target, the smallest non-empty result wins;
/// a pass that would empty the mesh is discarded (an element must never
/// disappear).
pub(crate) fn cluster_to_ratio(mesh: &Mesh, target_ratio: f32, min_floor: u32) -> (Mesh, u32) {
    let tris_before = mesh.indices.len() / 3;
    if tris_before == 0 {
        return (mesh.clone(), 0);
    }
    // The floor keeps aggressive ratios (0.03) from grinding small-but-real
    // meshes below recognizability; the box level exists for that.
    let target =
        ((tris_before as f64 * target_ratio as f64).ceil() as usize).max(min_floor.max(1) as usize);
    if tris_before <= target {
        return (mesh.clone(), 0);
    }

    let (min, max) = mesh.bounds();
    let diag = ((max.x - min.x).powi(2) + (max.y - min.y).powi(2) + (max.z - min.z).powi(2)).sqrt();
    if !(diag > 0.0) || !diag.is_finite() {
        return (mesh.clone(), 0);
    }

    let mut cell = diag * BASE_CELL_FRACTION;
    let mut best: Option<Mesh> = None;
    for iteration in 1..=MAX_ITERATIONS {
        let candidate = cluster_decimate(mesh, cell);
        let count = candidate.indices.len() / 3;
        if count == 0 {
            // Over-collapsed: keep the finest useful result found so far,
            // reporting the iteration that actually produced it.
            return (best.unwrap_or_else(|| mesh.clone()), iteration.saturating_sub(1));
        }
        let improves = best
            .as_ref()
            .map(|b| count < b.indices.len() / 3)
            .unwrap_or(true);
        if improves {
            best = Some(candidate);
        }
        if count <= target {
            return (best.unwrap(), iteration);
        }
        cell *= CELL_GROWTH;
    }
    (best.unwrap_or_else(|| mesh.clone()), MAX_ITERATIONS)
}
