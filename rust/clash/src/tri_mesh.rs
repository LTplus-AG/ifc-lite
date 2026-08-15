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
use crate::obb::{detect_obb, MeshLike, Obb};
use crate::triangle::closest_pt_point_triangle;
use crate::vec3::{cross, dist_sq, dot, sub, Vec3};
use std::cell::RefCell;

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
    /// Starting half-size for the expanding-cube probe in `distance_to_surface`:
    /// a power-of-two fraction of the mesh's longest axis, scaled down by the
    /// cube root of the triangle count so it lands near the average triangle
    /// size. Derived with exact power-of-two arithmetic (no `powi`/`cbrt`, whose
    /// last bit is not guaranteed to agree with JS) — the TS `TriMesh.probeSeed`
    /// computes the identical value.
    #[allow(dead_code)]
    probe_seed: f64,
    /// Memoized `detect_obb(self)` result; `None` until first requested (the
    /// outer `Option` is the "not yet computed" marker, the inner one is
    /// "not a box"). Computed at most once per element per run, same
    /// lifetime as the mesh — mirrors the TS `TriMesh.obbCache`.
    obb_cache: RefCell<Option<Option<Obb>>>,
}

/// The axis-aligned cube of half-size `h` centred on `p`.
#[allow(dead_code)]
fn cube_around(p: Vec3, h: f64) -> Aabb {
    Aabb::new([p[0] - h, p[1] - h, p[2] - h], [p[0] + h, p[1] + h, p[2] + h])
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
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for t in 0..count {
            let bounds = tri_bounds(&positions, &indices, t);
            for a in 0..3 {
                if bounds.min[a] < lo[a] {
                    lo[a] = bounds.min[a];
                }
                if bounds.max[a] > hi[a] {
                    hi[a] = bounds.max[a];
                }
            }
            items.push((t as u32, bounds));
        }
        let mut extent = 0.0f64;
        for a in 0..3 {
            let e = hi[a] - lo[a];
            if e > extent {
                extent = e;
            }
        }
        // Halve the extent once per factor of 8 in the triangle count (≈ one
        // subdivision step per axis). Both the loop and the division are exact.
        let mut divisor = 1.0f64;
        let mut cap: usize = 8;
        while cap <= count && divisor < 1048576.0 {
            divisor *= 2.0;
            cap *= 8;
        }
        let seed = extent / divisor;
        let probe_seed = if seed > 0.0 && seed < f64::INFINITY {
            seed
        } else {
            1.0
        };
        let bvh = Bvh::build(&items);
        Self {
            positions,
            indices,
            count,
            bvh,
            probe_seed,
            obb_cache: RefCell::new(None),
        }
    }

    /// Memoized `Obb` for this mesh, or `None` when the mesh is not (within
    /// tolerance) a rectangular box. See `obb.rs` for the detection rule.
    pub fn get_obb(&self) -> Option<Obb> {
        if let Some(cached) = *self.obb_cache.borrow() {
            return cached;
        }
        let computed = detect_obb(self);
        *self.obb_cache.borrow_mut() = Some(computed);
        computed
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

    /// Mean of every vertex, summed in index order. A rigid-invariant interior
    /// probe for the volumetric-overlap check in the narrow phase: the midpoint
    /// of two solids' vertex centroids lands in their shared volume for a genuine
    /// overlap (but on/outside the interface for a bare face touch). Iterated in
    /// index order and summed in `f64`, bit-identical to the TS `vertexCentroid`.
    pub fn vertex_centroid(&self) -> Vec3 {
        let n = self.positions.len() / 3;
        if n == 0 {
            return [0.0, 0.0, 0.0];
        }
        let mut s = [0.0f64; 3];
        for i in 0..n {
            let v = self.vertex(i as u32);
            s[0] += v[0];
            s[1] += v[1];
            s[2] += v[2];
        }
        let nf = n as f64;
        [s[0] / nf, s[1] / nf, s[2] / nf]
    }

    /// Minimum point-to-triangle distance over `tris`, as a squared distance.
    #[allow(dead_code)]
    fn min_dist_sq_over(&self, p: Vec3, tris: &[u32]) -> f64 {
        let mut best = f64::INFINITY;
        for &t in tris {
            let [a, b, c] = self.tri(t as usize);
            let q = closest_pt_point_triangle(p, a, b, c);
            let d2 = dist_sq(p, q);
            if d2 < best {
                best = d2;
            }
        }
        best
    }

    /// Exhaustive fallback for `distance_to_surface`: every triangle, index order.
    #[allow(dead_code)]
    fn distance_to_surface_scan(&self, p: Vec3) -> f64 {
        let mut best = f64::INFINITY;
        for t in 0..self.count {
            let [a, b, c] = self.tri(t);
            let q = closest_pt_point_triangle(p, a, b, c);
            let d2 = dist_sq(p, q);
            if d2 < best {
                best = d2;
            }
        }
        best.sqrt()
    }

    /// Exact distance from `p` to this mesh's surface: the minimum point-to-
    /// triangle distance over the whole mesh.
    ///
    /// Not on the narrow-phase hot path as of PR #2536 (its former caller,
    /// `max_penetration_into`, was removed — see `obb.rs`): a nearest-crossing-
    /// VERTEX distance-to-surface probe is a sampling artifact that converges
    /// to 0 under retessellation rather than to the true penetration depth.
    /// Kept as a genuinely exact, independently tested primitive (see the
    /// shared probe fixture in `kernel_tests.rs` / `tri-mesh.test.ts`) for
    /// future callers that need it — e.g. clearance-to-nearest-surface — not
    /// as dead weight. Driven by the triangle BVH rather than a linear scan so
    /// it stays cheap when it IS called:
    ///
    /// TODO(remove-by: no production caller has appeared by the next
    /// clash-engine feature pass, or on maintainer request): tracking issue
    /// https://github.com/LTplus-AG/ifc-lite/issues/2646.
    ///
    /// 1. Query the cube of half-size `h` centred on `p`. Every triangle within
    ///    distance `h` of `p` has its closest point inside that cube, hence its
    ///    AABB intersects the cube, hence it is in the candidate set.
    /// 2. If the candidate minimum `d` satisfies `d <= h`, the true minimum is
    ///    `<= h` too, so its triangle was a candidate and `d` IS the true minimum.
    /// 3. Otherwise `d` is still an upper bound on the true minimum, so one more
    ///    query at half-size `d` provably captures the closest triangle.
    ///
    /// `min` selects an element rather than accumulating, so visiting a superset
    /// of the argmin in a different order returns the identical `f64`. The TS
    /// `distanceToSurface` runs the identical sequence of queries on the
    /// identical BVH, keeping the two kernels bit-identical (see the shared probe
    /// fixture in `kernel_tests.rs` / `tri-mesh.test.ts`).
    ///
    /// The `wider.is_empty()` arm below is unreachable, not a tested fallback:
    /// `cube_around(p, d)` with `d > h` strictly contains `cube_around(p, h)`,
    /// whose query was already non-empty, so every triangle that made `hits`
    /// non-empty also intersects the wider cube — `wider` cannot come back
    /// empty. It is kept only as defence-in-depth against a future
    /// `query_tris` regression, not as a code path with coverage; do not read
    /// it as a tested safety net.
    #[allow(dead_code)]
    pub fn distance_to_surface(&self, p: Vec3) -> f64 {
        if self.count == 0 {
            return f64::INFINITY;
        }
        let mut h = self.probe_seed;
        // 64 doublings from a positive seed overflow to infinity, whose cube
        // intersects every finite box — so the loop only runs out on NaN
        // geometry, which falls through to the exhaustive scan rather than
        // spinning.
        for _ in 0..64 {
            let hits = self.query_tris(&cube_around(p, h));
            if !hits.is_empty() {
                let d = self.min_dist_sq_over(p, &hits).sqrt();
                if d <= h {
                    return d;
                }
                let wider = self.query_tris(&cube_around(p, d));
                if !wider.is_empty() {
                    return self.min_dist_sq_over(p, &wider).sqrt();
                }
                return self.distance_to_surface_scan(p);
            }
            h *= 2.0;
        }
        self.distance_to_surface_scan(p)
    }

    /// True when `p` is inside this closed mesh. Casts a fixed-direction ray and
    /// counts forward crossings against every triangle (Möller–Trumbore,
    /// double-sided so winding doesn't matter); an odd count means inside.
    ///
    /// Only the triangles the BVH reports along the ray are tested. A triangle
    /// the ray hits at `t_hit > RAY_EPS > 0` is hit inside its own AABB, so the
    /// slab test admits it — the candidate set is a superset of the triangles a
    /// linear scan would count, and the crossing count is an integer sum, so the
    /// parity (and hence the verdict) is unchanged by the visit order. `RAY_DIR`
    /// is a unit vector exactly, so `Bvh::raycast`'s normalisation is the
    /// identity and the slab test sees exactly `RAY_DIR`; the TS
    /// `BVH.raycast` mirrors this traversal, keeping the kernels bit-identical.
    // Keep the bare `u < 0.0 || u > 1.0` comparisons (not `RangeInclusive::contains`):
    // they must match the TS kernel's operators EXACTLY, including NaN handling
    // (`contains` would skip a NaN `u`, the comparison does not), or parity breaks.
    #[allow(clippy::manual_range_contains)]
    pub fn contains_point(&self, p: Vec3) -> bool {
        let mut crossings: u32 = 0;
        for t in self.bvh.raycast(p, RAY_DIR) {
            let [v0, v1, v2] = self.tri(t as usize);
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

impl MeshLike for TriMesh {
    fn tri_count(&self) -> usize {
        self.count
    }
    fn tri_verts(&self, t: usize) -> [Vec3; 3] {
        self.tri(t)
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
