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
use crate::vec3::Vec3;

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
