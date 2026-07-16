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
                comp.min[k] = comp.min[k].min(vert[k]);
                comp.max[k] = comp.max[k].max(vert[k]);
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

    // -- Classify candidates.
    let aabb_pad = 1e-9 * diag; // noise-only: outside the outer AABB => not enclosed
    let mut drop: Vec<bool> = vec![false; comps.len()];
    let mut components_dropped = 0u32;
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
        if point_enclosed(center, diag, &outer_tris) {
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

/// Parity vote: cast the three axis-aligned rays from `point` (each with its
/// own sub-epsilon jitter to dodge edge/vertex grazing) against `tris` and
/// call the point enclosed when at least two rays report an odd crossing
/// count. A ray with any grazing hit is discarded; fewer than two clean rays
/// means "keep" (conservative).
fn point_enclosed(point: [f64; 3], scale: f64, tris: &[[[f64; 3]; 3]]) -> bool {
    let dirs = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut valid = 0u32;
    let mut inside = 0u32;
    for (k, dir) in dirs.iter().enumerate() {
        // Distinct jitter per ray, orders of magnitude below feature size.
        let j = (k as f64 + 1.0) * 1e-7 * scale;
        let origin = [point[0] + j, point[1] + 1.3 * j, point[2] + 1.7 * j];
        match count_crossings(origin, *dir, scale, tris) {
            Some(n) => {
                valid += 1;
                if n % 2 == 1 {
                    inside += 1;
                }
            }
            None => continue, // grazing hit: discard this ray
        }
    }
    valid >= 2 && inside >= 2
}

/// Moller-Trumbore crossing count for one ray; `None` when any hit is too
/// close to a triangle edge/vertex or to the ray origin to trust.
fn count_crossings(
    origin: [f64; 3],
    dir: [f64; 3],
    scale: f64,
    tris: &[[[f64; 3]; 3]],
) -> Option<u32> {
    const BARY_EPS: f64 = 1e-9;
    let t_eps = 1e-9 * scale;
    let mut crossings = 0u32;
    for tri in tris {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let pv = [
            dir[1] * e2[2] - dir[2] * e2[1],
            dir[2] * e2[0] - dir[0] * e2[2],
            dir[0] * e2[1] - dir[1] * e2[0],
        ];
        let det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
        if det.abs() < 1e-16 {
            continue; // parallel: jittered siblings resolve true grazings
        }
        let inv = 1.0 / det;
        let tv = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
        let u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv;
        if u < -BARY_EPS || u > 1.0 + BARY_EPS {
            continue;
        }
        let qv = [
            tv[1] * e1[2] - tv[2] * e1[1],
            tv[2] * e1[0] - tv[0] * e1[2],
            tv[0] * e1[1] - tv[1] * e1[0],
        ];
        let v = (dir[0] * qv[0] + dir[1] * qv[1] + dir[2] * qv[2]) * inv;
        if v < -BARY_EPS || u + v > 1.0 + BARY_EPS {
            continue;
        }
        let t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv;
        if t <= -t_eps {
            continue; // behind the origin
        }
        if t < t_eps {
            return None; // origin on / grazing the surface
        }
        if u < BARY_EPS || v < BARY_EPS || u + v > 1.0 - BARY_EPS {
            return None; // edge/vertex hit: parity untrustworthy
        }
        crossings += 1;
    }
    Some(crossings)
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
