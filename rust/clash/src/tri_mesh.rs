// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-element triangle mesh with a per-triangle BVH for narrow-phase queries.
//!
//! Faithful port of `packages/clash/src/engine-ts/tri-mesh.ts`. Geometry is
//! ingested from `f32` buffers but stored and queried in `f64`; vertices are
//! already world-space, so no transform is applied.

use crate::aabb::Aabb;
use crate::bvh::Bvh;
use crate::vec3::{cross, dot, sub, Vec3};

/// Fixed ray direction for point-in-solid tests: `normalize([1, √3, √5])`.
/// NON-axis-aligned so the ray never grazes axis-aligned box edges/vertices
/// (which would double-count). Exact IEEE-754 literals, byte-identical to the
/// TS kernel's `RAY_DIR` — `|RAY_DIR| == 1` exactly.
const RAY_DIR: Vec3 = [0.3333333333333333, 0.5773502691896257, 0.7453559924999299];
/// Parallel-reject + forward-crossing threshold. Same literal in the TS kernel.
const RAY_EPS: f64 = 1e-9;

/// A triangle mesh with a per-triangle BVH over its triangle AABBs.
pub struct TriMesh {
    /// World-space vertex coordinates, packed `[x, y, z, ...]` in `f64`.
    positions: Vec<f64>,
    /// Triangle indices, local (0-based) within this mesh's vertices.
    indices: Vec<u32>,
    /// Number of triangles.
    pub count: usize,
    bvh: Bvh,
}

impl TriMesh {
    /// Build from world-space `positions` (`f64`) and local triangle `indices`.
    pub fn new(positions: Vec<f64>, indices: Vec<u32>) -> Self {
        // Sanitize: keep only triangles whose three indices reference real
        // vertices. A malformed / partial mesh must NOT panic — under the release
        // `panic = abort` profile a panic traps the instance and poisons the
        // entire shared wasm module (geometry, parsing and clash all share it),
        // whereas the TS engine degrades gracefully (NaN coords -> 0 clashes).
        let vertex_count = positions.len() / 3;
        let mut indices = indices;
        let tri_total = indices.len() / 3;
        let all_valid = (0..tri_total).all(|t| {
            let o = t * 3;
            (indices[o] as usize) < vertex_count
                && (indices[o + 1] as usize) < vertex_count
                && (indices[o + 2] as usize) < vertex_count
        });
        if !all_valid {
            let mut clean: Vec<u32> = Vec::with_capacity(indices.len());
            for t in 0..tri_total {
                let o = t * 3;
                let i0 = indices[o] as usize;
                let i1 = indices[o + 1] as usize;
                let i2 = indices[o + 2] as usize;
                if i0 < vertex_count && i1 < vertex_count && i2 < vertex_count {
                    clean.extend_from_slice(&[indices[o], indices[o + 1], indices[o + 2]]);
                }
            }
            indices = clean;
        }

        let count = indices.len() / 3;
        let mut items: Vec<(u32, Aabb)> = Vec::with_capacity(count);
        // Build the per-triangle bounds inline so we can populate the BVH before
        // moving the buffers into the struct.
        for t in 0..count {
            let bounds = tri_bounds(&positions, &indices, t);
            items.push((t as u32, bounds));
        }
        let bvh = Bvh::build(&items);
        Self {
            positions,
            indices,
            count,
            bvh,
        }
    }

    /// World-space vertex `i`.
    #[inline]
    pub fn vertex(&self, i: u32) -> Vec3 {
        let o = (i as usize) * 3;
        [self.positions[o], self.positions[o + 1], self.positions[o + 2]]
    }

    /// The three world-space vertices of triangle `t`.
    #[inline]
    pub fn tri(&self, t: usize) -> [Vec3; 3] {
        let o = t * 3;
        [
            self.vertex(self.indices[o]),
            self.vertex(self.indices[o + 1]),
            self.vertex(self.indices[o + 2]),
        ]
    }

    /// Axis-aligned bounds of triangle `t`.
    #[inline]
    pub fn tri_bounds(&self, t: usize) -> Aabb {
        tri_bounds(&self.positions, &self.indices, t)
    }

    /// Triangle indices whose bounds intersect `bounds`.
    pub fn query_tris(&self, bounds: &Aabb) -> Vec<u32> {
        if self.count == 0 {
            return Vec::new();
        }
        self.bvh.query_aabb(bounds)
    }

    /// True when `p` is inside this closed mesh. Casts a fixed-direction ray and
    /// counts forward crossings against every triangle (Möller–Trumbore,
    /// double-sided so winding doesn't matter); an odd count means inside.
    ///
    /// Iterates all triangles in index order — deliberately NOT the BVH — so the
    /// result is bit-identical to the TS `containsPoint`. Only invoked in the
    /// rare enclosed-solid branch of the narrow phase, so the O(n) cost is fine.
    // Keep the bare `u < 0.0 || u > 1.0` comparisons (not `RangeInclusive::contains`):
    // they must match the TS kernel's operators EXACTLY, including NaN handling
    // (`contains` would skip a NaN `u`, the comparison does not), or parity breaks.
    #[allow(clippy::manual_range_contains)]
    pub fn contains_point(&self, p: Vec3) -> bool {
        let mut crossings: u32 = 0;
        for t in 0..self.count {
            let [v0, v1, v2] = self.tri(t);
            let e1 = sub(v1, v0);
            let e2 = sub(v2, v0);
            let pv = cross(RAY_DIR, e2);
            let det = dot(e1, pv);
            if det > -RAY_EPS && det < RAY_EPS {
                continue; // ray parallel to triangle
            }
            let inv = 1.0 / det;
            let tv = sub(p, v0);
            let u = dot(tv, pv) * inv;
            if u < 0.0 || u > 1.0 {
                continue;
            }
            let qv = cross(tv, e1);
            let v = dot(RAY_DIR, qv) * inv;
            if v < 0.0 || u + v > 1.0 {
                continue;
            }
            let t_hit = dot(e2, qv) * inv;
            if t_hit > RAY_EPS {
                crossings += 1; // strictly forward
            }
        }
        crossings & 1 == 1
    }
}

fn tri_bounds(positions: &[f64], indices: &[u32], t: usize) -> Aabb {
    let o = t * 3;
    let va = vertex(positions, indices[o]);
    let vb = vertex(positions, indices[o + 1]);
    let vc = vertex(positions, indices[o + 2]);
    Aabb::new(
        [
            va[0].min(vb[0]).min(vc[0]),
            va[1].min(vb[1]).min(vc[1]),
            va[2].min(vb[2]).min(vc[2]),
        ],
        [
            va[0].max(vb[0]).max(vc[0]),
            va[1].max(vb[1]).max(vc[1]),
            va[2].max(vb[2]).max(vc[2]),
        ],
    )
}

#[inline]
fn vertex(positions: &[f64], i: u32) -> Vec3 {
    let o = (i as usize) * 3;
    [positions[o], positions[o + 1], positions[o + 2]]
}
