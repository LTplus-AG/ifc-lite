// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Enclosed-cavity removal.
//!
//! Detail-heavy CAD exports (SolidWorks machinery, LOD500) carry closed
//! internal shells — bolt-hole liners, machining detail, hollow-core walls —
//! that are invisible from outside but dominate the triangle budget. This
//! pass position-welds the facet soup into connectivity components, picks the
//! outer shell (largest total triangle area), and drops components whose
//! surface lies strictly inside it (axis-ray parity vote against the outer
//! shell's triangles).
//!
//! Conservative by design: any ambiguity — open (non-watertight) outer
//! shell, grazing ray hits, a component too large to plausibly be hidden
//! detail — keeps geometry. The worst case is a no-op, never a hole in
//! visible geometry. Only `indices` shrink; the vertex buffer is untouched
//! (same contract as `Mesh::drop_thin_triangles`).

use super::ray_parity::point_enclosed;
use crate::mesh::Mesh;
use rustc_hash::FxHashMap;

/// Outer shells with more than this fraction of open (single-use) edges are
/// considered non-watertight; ray parity against them is meaningless, so the
/// whole pass becomes a no-op. Real closed shells sit at ~0; a missing facet
/// or two stays under this, a genuinely open surface (sheet, ripped face)
/// goes far above.
const OUTER_OPEN_EDGE_RATIO_MAX: f64 = 0.05;

/// A component whose area exceeds this fraction of the outer shell's area is
/// never dropped — hidden detail is small by nature, and a "cavity" this
/// large is more likely a mis-classified second body.
const AREA_RATIO_MAX: f64 = 0.25;

/// Bail out entirely above this many candidate components (pathological
/// input; O(candidates x outer_tris) would blow up, and a mesh shattered
/// into that many shells is not one this heuristic understands).
const MAX_CANDIDATES: usize = 10_000;

/// Hard budget on the parity workload in ray-triangle tests
/// (sample points x 3 axis rays x outer-shell triangles). MAX_CANDIDATES
/// alone does not bound the work — a dense outer shell multiplies every ray
/// by its triangle count, and this pass runs synchronously on the wasm/UI
/// thread. Above the budget the whole pass is a conservative no-op
/// (~tens of ns per test, so this caps the pass at well under a second).
const MAX_PARITY_RAY_TRIS: u64 = 30_000_000;

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CavityStats {
    pub components_dropped: u32,
    pub triangles_dropped: u32,
}

/// Drop connected components fully enclosed inside the outer shell.
/// `weld_eps` is the position-weld bucket in metres (1e-6 is safe for IFC,
/// matching `Mesh::welded_by_position`).
pub(crate) fn drop_enclosed_cavities(mesh: &mut Mesh, weld_eps: f32) -> CavityStats {
    let n_verts = mesh.positions.len() / 3;
    let n_tris = mesh.indices.len() / 3;
    if n_verts == 0 || n_tris < 8 {
        return CavityStats::default();
    }

    // -- Position-only weld map (same quantization contract as
    // `mesh::weld_impl`, map only — no rebuilt buffers needed here).
    let pos_scale = 1.0 / weld_eps.max(f32::MIN_POSITIVE);
    let q = |v: f32| -> i64 { (v * pos_scale).round() as i64 };
    let mut canonical: FxHashMap<[i64; 3], u32> = FxHashMap::default();
    let mut weld: Vec<u32> = Vec::with_capacity(n_verts);
    let mut n_welded: u32 = 0;
    for i in 0..n_verts {
        let key = [
            q(mesh.positions[i * 3]),
            q(mesh.positions[i * 3 + 1]),
            q(mesh.positions[i * 3 + 2]),
        ];
        weld.push(*canonical.entry(key).or_insert_with(|| {
            let id = n_welded;
            n_welded += 1;
            id
        }));
    }

    // -- Connectivity over welded vertices.
    let mut uf = UnionFind::new(n_welded as usize);
    let welded_tri = |tri: &[u32]| -> Option<[u32; 3]> {
        if (tri[0] as usize) >= n_verts
            || (tri[1] as usize) >= n_verts
            || (tri[2] as usize) >= n_verts
        {
            return None;
        }
        Some([
            weld[tri[0] as usize],
            weld[tri[1] as usize],
            weld[tri[2] as usize],
        ])
    };
    for tri in mesh.indices.chunks_exact(3) {
        if let Some([a, b, c]) = welded_tri(tri) {
            uf.union(a, b);
            uf.union(b, c);
        }
    }

    // -- Per-component accumulation (area, AABB, triangle count).
    #[derive(Clone)]
    struct Comp {
        area: f64,
        min: [f64; 3],
        max: [f64; 3],
        tris: u32,
        edges: u64,
        open_edges: u64,
        /// The surface vertex realizing each AABB extreme (min x/y/z, then
        /// max x/y/z) — enclosure sample points. The AABB CENTRE alone is not
        /// enough: a component whose centre sits inside the outer solid can
        /// still protrude through it (non-convex outers), and dropping it
        /// would punch visible geometry away. Extremes are where a
        /// protrusion pokes out.
        ext: [[f64; 3]; 6],
    }
    let mut comp_of_root: FxHashMap<u32, usize> = FxHashMap::default();
    let mut comps: Vec<Comp> = Vec::new();
    // Component index per triangle (usize::MAX for invalid-index triangles,
    // which are kept as-is — not this pass's business to drop them).
    let mut comp_of_tri: Vec<usize> = Vec::with_capacity(n_tris);

    let p = |i: u32| -> [f64; 3] {
        let i = i as usize * 3;
        [
            mesh.positions[i] as f64,
            mesh.positions[i + 1] as f64,
            mesh.positions[i + 2] as f64,
        ]
    };

    for tri in mesh.indices.chunks_exact(3) {
        let Some([wa, _, _]) = welded_tri(tri) else {
            comp_of_tri.push(usize::MAX);
            continue;
        };
        let root = uf.find(wa);
        let next = comps.len();
        let ci = *comp_of_root.entry(root).or_insert(next);
        if ci == comps.len() {
            comps.push(Comp {
                area: 0.0,
                min: [f64::INFINITY; 3],
                max: [f64::NEG_INFINITY; 3],
                tris: 0,
                edges: 0,
                open_edges: 0,
                ext: [[0.0; 3]; 6],
            });
        }
        let (a, b, c) = (p(tri[0]), p(tri[1]), p(tri[2]));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let cr = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let comp = &mut comps[ci];
        comp.area += 0.5 * (cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt();
        comp.tris += 1;
        for vert in [a, b, c] {
            for k in 0..3 {
                if vert[k] < comp.min[k] {
                    comp.min[k] = vert[k];
                    comp.ext[k] = vert;
                }
                if vert[k] > comp.max[k] {
                    comp.max[k] = vert[k];
                    comp.ext[3 + k] = vert;
                }
            }
        }
        comp_of_tri.push(ci);
    }

    if comps.len() < 2 {
        return CavityStats::default();
    }
    if comps.len() - 1 > MAX_CANDIDATES {
        return CavityStats::default();
    }

    // -- Edge usage on the welded topology (open edge = used once), for the
    // outer shell's watertightness gate.
    let mut edge_use: FxHashMap<u64, u32> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let Some([wa, wb, wc]) = welded_tri(tri) else {
            continue;
        };
        for (x, y) in [(wa, wb), (wb, wc), (wc, wa)] {
            if x == y {
                continue; // welded-degenerate edge carries no adjacency info
            }
            let key = ((x.min(y) as u64) << 32) | (x.max(y) as u64);
            *edge_use.entry(key).or_insert(0) += 1;
        }
    }
    for (&key, &count) in &edge_use {
        let root = uf.find((key >> 32) as u32);
        if let Some(&ci) = comp_of_root.get(&root) {
            comps[ci].edges += 1;
            if count == 1 {
                comps[ci].open_edges += 1;
            }
        }
    }

    // -- Outer shell = largest total area; must be believably watertight.
    let outer = comps
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.area.total_cmp(&b.area))
        .map(|(i, _)| i)
        .unwrap();
    let outer_comp = comps[outer].clone();
    if !(outer_comp.area > 0.0) || outer_comp.edges == 0 {
        return CavityStats::default();
    }
    if outer_comp.open_edges as f64 / outer_comp.edges as f64 > OUTER_OPEN_EDGE_RATIO_MAX {
        return CavityStats::default();
    }

    let diag = ((outer_comp.max[0] - outer_comp.min[0]).powi(2)
        + (outer_comp.max[1] - outer_comp.min[1]).powi(2)
        + (outer_comp.max[2] - outer_comp.min[2]).powi(2))
    .sqrt();
    if !(diag > 0.0) || !diag.is_finite() {
        return CavityStats::default();
    }

    // Outer shell triangles (f64), the ray-parity target.
    let outer_tris: Vec<[[f64; 3]; 3]> = mesh
        .indices
        .chunks_exact(3)
        .zip(comp_of_tri.iter())
        .filter(|(_, &ci)| ci == outer)
        .map(|(tri, _)| [p(tri[0]), p(tri[1]), p(tri[2])])
        .collect();

    // -- Classify candidates. Phase 1: cheap AABB/area filters, collecting
    // the enclosure sample points (AABB centre + the six extreme surface
    // vertices) per surviving candidate.
    let aabb_pad = 1e-9 * diag; // noise-only: outside the outer AABB => not enclosed
    let mut candidates: Vec<(usize, Vec<[f64; 3]>)> = Vec::new();
    for (ci, comp) in comps.iter().enumerate() {
        if ci == outer || comp.tris == 0 {
            continue;
        }
        let inside_aabb = (0..3).all(|k| {
            comp.min[k] >= outer_comp.min[k] - aabb_pad
                && comp.max[k] <= outer_comp.max[k] + aabb_pad
        });
        if !inside_aabb {
            continue;
        }
        if comp.area > AREA_RATIO_MAX * outer_comp.area {
            continue;
        }
        let center = [
            0.5 * (comp.min[0] + comp.max[0]),
            0.5 * (comp.min[1] + comp.max[1]),
            0.5 * (comp.min[2] + comp.max[2]),
        ];
        let mut points: Vec<[f64; 3]> = Vec::with_capacity(7);
        points.push(center);
        for e in comp.ext {
            if !points.contains(&e) {
                points.push(e);
            }
        }
        candidates.push((ci, points));
    }

    // Workload budget: sample points x 3 rays x outer triangles. Over budget
    // the pass is a conservative no-op (never a stalled UI thread).
    let total_points: u64 = candidates.iter().map(|(_, pts)| pts.len() as u64).sum();
    if total_points
        .saturating_mul(3)
        .saturating_mul(outer_tris.len() as u64)
        > MAX_PARITY_RAY_TRIS
    {
        return CavityStats::default();
    }

    // Phase 2: parity vote. Drop a component only when EVERY sample point is
    // enclosed — one point outside the outer solid means the component
    // protrudes (or grazes), and visible geometry must never be dropped.
    let mut drop: Vec<bool> = vec![false; comps.len()];
    let mut components_dropped = 0u32;
    for (ci, points) in candidates {
        if points
            .iter()
            .all(|&pt| point_enclosed(pt, diag, &outer_tris))
        {
            drop[ci] = true;
            components_dropped += 1;
        }
    }
    if components_dropped == 0 {
        return CavityStats::default();
    }

    // -- Apply: index subset, vertex buffer untouched.
    let mut kept: Vec<u32> = Vec::with_capacity(mesh.indices.len());
    let mut triangles_dropped = 0u32;
    for (tri, &ci) in mesh.indices.chunks_exact(3).zip(comp_of_tri.iter()) {
        if ci != usize::MAX && drop[ci] {
            triangles_dropped += 1;
        } else {
            kept.extend_from_slice(tri);
        }
    }
    mesh.indices = kept;
    CavityStats {
        components_dropped,
        triangles_dropped,
    }
}

/// Minimal union-find with path halving.
struct UnionFind {
    parent: Vec<u32>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n as u32).collect(),
        }
    }

    fn find(&mut self, mut x: u32) -> u32 {
        while self.parent[x as usize] != x {
            let grand = self.parent[self.parent[x as usize] as usize];
            self.parent[x as usize] = grand;
            x = grand;
        }
        x
    }

    fn union(&mut self, a: u32, b: u32) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[rb as usize] = ra;
        }
    }
}
