// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-entity geometry fingerprinting for model diffing.
//!
//! The viewer's "compare two revisions" feature needs a stable per-entity
//! signature so an unchanged element hashes identically across two files,
//! while a genuine edit (moved, reshaped, retriangulated) hashes differently.
//!
//! ## Design invariants
//!
//! * **RTC-invariant.** Each file independently shifts world coordinates toward
//!   the origin (Relative-To-Center) to preserve `f32` precision. That shift is
//!   a property of the *file*, not the element, and the base and head files may
//!   pick different offsets. We therefore hash in reconstructed **world**
//!   coordinates (`local + rtc_offset`), so the same wall in the same world
//!   spot hashes the same regardless of each file's RTC choice.
//! * **Translation-sensitive.** Because we hash absolute world position, an
//!   element that genuinely *moved* hashes differently — a moved element is an
//!   edit ("orange"), not "unchanged".
//! * **Order/winding-invariant.** Triangle order, vertex-buffer order, and
//!   winding are implementation details of the geometry kernel, not the shape.
//!   Each triangle's three quantized vertices are sorted before hashing, and
//!   triangles are combined commutatively, so reordering/rewinding does not move
//!   the hash.
//! * **Tolerance-quantized.** Positions are snapped to a grid of `tolerance`
//!   metres before hashing. Larger tolerance absorbs float noise (fewer false
//!   "changed") at the cost of missing sub-tolerance edits. See
//!   [`DEFAULT_GEOM_HASH_TOLERANCE`] and the `tolerance_sweep` test for the
//!   trade-off — the effective floor is the `f32` precision of the local
//!   positions (~1e-4 m near origin), so tolerances below ~1 mm mostly hash
//!   float noise.
//!
//! All inputs must be in a single consistent frame for both files (i.e. unit
//! scaled to metres, and either both pre- or both post- any axis convention
//! swap). The caller is responsible for feeding `positions` and `rtc_offset`
//! in the same frame.

/// Default quantization grid in metres (1 mm). Chosen as a starting point near
/// the `f32` precision floor of RTC-local coordinates; tune empirically with
/// the `tolerance_sweep` test against real revision pairs.
pub const DEFAULT_GEOM_HASH_TOLERANCE: f64 = 1.0e-3;

/// splitmix64 finalizer — strong avalanche for a single `u64`.
#[inline]
fn mix64(mut x: u64) -> u64 {
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

/// Fold one signed integer into a running hash (order-dependent).
#[inline]
fn fold_i64(acc: u64, v: i64) -> u64 {
    mix64(acc ^ (v as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
}

/// Snap a world coordinate to the quantization grid.
///
/// `inv_tol` is `1.0 / tolerance`, hoisted out of the per-vertex loop.
#[inline]
fn quantize(world: f64, inv_tol: f64) -> i64 {
    // round-half-away-from-zero; `f64::round` is symmetric about 0 so the grid
    // is stable under sign changes.
    (world * inv_tol).round() as i64
}

/// Accumulates a single entity's geometry signature across one or more mesh
/// segments. Segments are combined commutatively, so the order in which the
/// kernel emits an entity's pieces does not affect the result.
#[derive(Clone, Debug)]
pub struct GeometryHasher {
    inv_tol: f64,
    rtc: [f64; 3],
    /// Commutative running sum of per-triangle hashes.
    triangle_accum: u64,
    triangle_count: u64,
}

impl GeometryHasher {
    /// Create a hasher for one entity.
    ///
    /// * `tolerance` — quantization grid in metres (must be `> 0`).
    /// * `rtc_offset` — the file's RTC offset, added back to local positions to
    ///   reconstruct world coordinates. Pass `[0.0; 3]` if positions are
    ///   already in world space.
    pub fn new(tolerance: f64, rtc_offset: [f64; 3]) -> Self {
        debug_assert!(tolerance > 0.0, "geometry hash tolerance must be positive");
        Self {
            inv_tol: 1.0 / tolerance,
            rtc: rtc_offset,
            triangle_accum: 0,
            triangle_count: 0,
        }
    }

    /// Hash the quantized world position of one vertex into a per-corner value.
    #[inline]
    fn corner(&self, positions: &[f32], vi: usize) -> [i64; 3] {
        let base = vi * 3;
        [
            quantize(positions[base] as f64 + self.rtc[0], self.inv_tol),
            quantize(positions[base + 1] as f64 + self.rtc[1], self.inv_tol),
            quantize(positions[base + 2] as f64 + self.rtc[2], self.inv_tol),
        ]
    }

    /// Add one mesh segment (a flat `[x,y,z, ...]` position buffer and a
    /// triangle index buffer). Indices that run past the position buffer or
    /// trailing non-triangle remainder are skipped defensively.
    pub fn add_mesh(&mut self, positions: &[f32], indices: &[u32]) {
        let vertex_limit = positions.len() / 3;
        let triangle_end = indices.len() - (indices.len() % 3);
        let mut i = 0;
        while i < triangle_end {
            let i0 = indices[i] as usize;
            let i1 = indices[i + 1] as usize;
            let i2 = indices[i + 2] as usize;
            i += 3;
            if i0 >= vertex_limit || i1 >= vertex_limit || i2 >= vertex_limit {
                continue;
            }

            // Sort the three quantized corners so triangle winding and the
            // starting vertex don't affect the hash — only the (multiset of)
            // positions and their adjacency as a triangle.
            let mut tri = [
                self.corner(positions, i0),
                self.corner(positions, i1),
                self.corner(positions, i2),
            ];
            tri.sort_unstable();

            // Skip degenerate (zero-area) triangles. After quantization,
            // coincident or colinear corners carry no shape signal, and
            // counting them lets triangulation noise (sliver/zero-area faces)
            // flip the fingerprint even when the rendered geometry is
            // unchanged. The cross product of two edges is the zero vector
            // exactly when the three quantized corners are colinear (which
            // includes the coincident case). i128 avoids overflow on the
            // quantized-coordinate products.
            let e1 = [
                tri[1][0] as i128 - tri[0][0] as i128,
                tri[1][1] as i128 - tri[0][1] as i128,
                tri[1][2] as i128 - tri[0][2] as i128,
            ];
            let e2 = [
                tri[2][0] as i128 - tri[0][0] as i128,
                tri[2][1] as i128 - tri[0][1] as i128,
                tri[2][2] as i128 - tri[0][2] as i128,
            ];
            let cross_x = e1[1] * e2[2] - e1[2] * e2[1];
            let cross_y = e1[2] * e2[0] - e1[0] * e2[2];
            let cross_z = e1[0] * e2[1] - e1[1] * e2[0];
            if cross_x == 0 && cross_y == 0 && cross_z == 0 {
                continue;
            }

            let mut h = 0x5bd1_e995_u64; // arbitrary non-zero seed
            for corner in tri {
                for c in corner {
                    h = fold_i64(h, c);
                }
            }
            // Commutative combine across triangles within and across segments.
            self.triangle_accum = self.triangle_accum.wrapping_add(mix64(h));
            self.triangle_count = self.triangle_count.wrapping_add(1);
        }
    }

    /// `true` until at least one (non-degenerate, in-range) triangle has been
    /// hashed. Lets callers skip emitting a fingerprint for entities that
    /// produced no geometry.
    pub fn is_empty(&self) -> bool {
        self.triangle_count == 0
    }

    /// Finalize the entity's geometry hash. Folds in the triangle count so two
    /// distinct shapes that happen to collide on the commutative triangle sum
    /// are still separated by their cardinality. Vertex count is intentionally
    /// excluded: it is ambiguous under shared-vs-duplicated vertices and under
    /// segment splitting (the same entity may arrive as one mesh or several
    /// sharing a position buffer), whereas the triangle count is intrinsic and
    /// additive across segments.
    pub fn finish(&self) -> u64 {
        let mut h = self.triangle_accum;
        h = fold_i64(h, self.triangle_count as i64);
        mix64(h)
    }
}

/// Convenience: hash a single-segment entity in one call.
pub fn hash_mesh_world(
    positions: &[f32],
    indices: &[u32],
    rtc_offset: [f64; 3],
    tolerance: f64,
) -> u64 {
    let mut hasher = GeometryHasher::new(tolerance, rtc_offset);
    hasher.add_mesh(positions, indices);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit cube (8 verts, 12 triangles) centred near `origin` in world
    /// coordinates. Returns positions already in world space.
    fn cube(origin: [f32; 3]) -> (Vec<f32>, Vec<u32>) {
        let [ox, oy, oz] = origin;
        let mut positions = Vec::with_capacity(8 * 3);
        for &x in &[0.0_f32, 1.0] {
            for &y in &[0.0_f32, 1.0] {
                for &z in &[0.0_f32, 1.0] {
                    positions.extend_from_slice(&[ox + x, oy + y, oz + z]);
                }
            }
        }
        // 12 triangles over the 8 corners (not a watertight ordering — only
        // needs to be a deterministic, non-degenerate triangle soup).
        let indices = vec![
            0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6,
            4, 1, 5, 7, 1, 7, 3,
        ];
        (positions, indices)
    }

    const TOL: f64 = 1.0e-3;

    #[test]
    fn rtc_invariance_same_world_geometry() {
        // Same wall at world position (1_000_000, 0, 0), expressed two ways:
        //   file A: local = world,            rtc = [0,0,0]
        //   file B: local = world - 999_000,  rtc = [999_000,0,0]
        // f32 can't hold 1e6 + sub-metre detail, so build the geometry at a
        // realistic magnitude where the two encodings reconstruct the same
        // world coords within f32 precision.
        let world_origin = [1234.5_f32, -67.25, 8.5];
        let (pos_a, idx) = cube(world_origin);
        let a = hash_mesh_world(&pos_a, &idx, [0.0, 0.0, 0.0], TOL);

        let shift = [999_000.0_f64, -2_000.0, 5_000.0];
        let pos_b: Vec<f32> = pos_a
            .chunks_exact(3)
            .flat_map(|c| {
                [
                    (c[0] as f64 - shift[0]) as f32,
                    (c[1] as f64 - shift[1]) as f32,
                    (c[2] as f64 - shift[2]) as f32,
                ]
            })
            .collect();
        let b = hash_mesh_world(&pos_b, &idx, shift, TOL);

        assert_eq!(a, b, "RTC offset must not change the geometry hash");
    }

    #[test]
    fn translation_is_detected() {
        let (pos, idx) = cube([0.0, 0.0, 0.0]);
        let moved: Vec<f32> = pos.chunks_exact(3).flat_map(|c| [c[0] + 1.0, c[1], c[2]]).collect();
        assert_ne!(
            hash_mesh_world(&pos, &idx, [0.0; 3], TOL),
            hash_mesh_world(&moved, &idx, [0.0; 3], TOL),
            "a 1 m move must change the hash"
        );
    }

    #[test]
    fn degenerate_triangles_do_not_affect_hash() {
        let (pos, idx) = cube([0.0, 0.0, 0.0]);
        let base = hash_mesh_world(&pos, &idx, [0.0; 3], TOL);

        // Append zero-area triangles (repeated/coincident corners) — the kind
        // of triangulation noise that must not move the fingerprint.
        let mut noisy = idx.clone();
        noisy.extend_from_slice(&[0, 0, 1]);
        noisy.extend_from_slice(&[2, 2, 2]);
        let with_noise = hash_mesh_world(&pos, &noisy, [0.0; 3], TOL);

        assert_eq!(base, with_noise, "zero-area triangles must not change the hash");
    }

    #[test]
    fn sub_tolerance_jitter_is_ignored() {
        // `round(v/tol)` puts cell *centres* at integer multiples of `tol` and
        // cell *boundaries* at the half-grid `(k+0.5)*tol`. Place verts at
        // centres (here `10*tol` apart, well clear of boundaries) so a jitter
        // below half a cell stays inside the same quantization cell.
        let cell = TOL * 10.0;
        let base: Vec<f32> = (0..24).map(|i| (i as f32) * (cell as f32)).collect();
        let idx: Vec<u32> = (0..(base.len() as u32 / 3) - 2)
            .flat_map(|i| [i, i + 1, i + 2])
            .collect();

        let jitter = (TOL as f32) * 0.1;
        let perturbed: Vec<f32> = base.iter().map(|v| v + jitter).collect();

        assert_eq!(
            hash_mesh_world(&base, &idx, [0.0; 3], TOL),
            hash_mesh_world(&perturbed, &idx, [0.0; 3], TOL),
            "jitter below the quantization grid must not change the hash"
        );
    }

    #[test]
    fn triangle_and_vertex_order_invariant() {
        let (pos, idx) = cube([3.0, 3.0, 3.0]);
        let canonical = hash_mesh_world(&pos, &idx, [0.0; 3], TOL);

        // Reverse triangle order and rotate each triangle's corners.
        let mut shuffled = Vec::with_capacity(idx.len());
        for tri in idx.chunks_exact(3).rev() {
            shuffled.extend_from_slice(&[tri[1], tri[2], tri[0]]);
        }
        assert_eq!(
            canonical,
            hash_mesh_world(&pos, &shuffled, [0.0; 3], TOL),
            "reordering triangles / rotating corners must not change the hash"
        );
    }

    #[test]
    fn winding_invariant() {
        let (pos, idx) = cube([0.0, 0.0, 0.0]);
        let canonical = hash_mesh_world(&pos, &idx, [0.0; 3], TOL);
        let flipped: Vec<u32> =
            idx.chunks_exact(3).flat_map(|t| [t[0], t[2], t[1]]).collect();
        assert_eq!(
            canonical,
            hash_mesh_world(&pos, &flipped, [0.0; 3], TOL),
            "reversing winding must not change the hash"
        );
    }

    #[test]
    fn segment_split_matches_single_segment() {
        // Hashing an entity as one 12-triangle mesh must equal hashing it as
        // two 6-triangle segments (entities arrive split across submeshes).
        let (pos, idx) = cube([10.0, 0.0, -4.0]);
        let single = hash_mesh_world(&pos, &idx, [0.0; 3], TOL);

        let (first, second) = idx.split_at(idx.len() / 2);
        let mut hasher = GeometryHasher::new(TOL, [0.0; 3]);
        hasher.add_mesh(&pos, first);
        hasher.add_mesh(&pos, second);
        assert_eq!(single, hasher.finish(), "split segments must match a single mesh");
    }

    #[test]
    fn distinct_shapes_differ() {
        let (cube_pos, cube_idx) = cube([0.0, 0.0, 0.0]);
        let (big_pos, big_idx) = cube([0.0, 0.0, 0.0]);
        let scaled: Vec<f32> = big_pos.iter().map(|v| v * 2.0).collect();
        assert_ne!(
            hash_mesh_world(&cube_pos, &cube_idx, [0.0; 3], TOL),
            hash_mesh_world(&scaled, &big_idx, [0.0; 3], TOL),
            "a 2x-scaled cube must hash differently"
        );
    }

    /// Documents the tolerance trade-off empirically: a move of exactly one
    /// grid cell is always detected; the same geometry under pure
    /// reconstruction noise stays stable. This is the harness to extend with
    /// real revision pairs when tuning `DEFAULT_GEOM_HASH_TOLERANCE`.
    #[test]
    fn tolerance_sweep_sensitivity() {
        let (pos, idx) = cube([100.0, 50.0, 25.0]);
        for &tol in &[1.0e-4_f64, 1.0e-3, 1.0e-2, 1.0e-1] {
            let baseline = hash_mesh_world(&pos, &idx, [0.0; 3], tol);

            // A move of one full grid cell must always register as changed.
            let one_cell = tol as f32;
            let moved: Vec<f32> =
                pos.chunks_exact(3).flat_map(|c| [c[0] + one_cell, c[1], c[2]]).collect();
            assert_ne!(
                baseline,
                hash_mesh_world(&moved, &idx, [0.0; 3], tol),
                "tol={tol}: a one-cell move must be detected"
            );

            // A move of one thousandth of a cell must be absorbed. The cube
            // sits at integer coords; for every tolerance here those land on
            // cell centres (integer multiples of `tol`), so a tiny nudge stays
            // in-cell.
            let tiny = (tol as f32) * 1.0e-3;
            let nudged: Vec<f32> = pos.iter().map(|v| v + tiny).collect();
            assert_eq!(
                baseline,
                hash_mesh_world(&nudged, &idx, [0.0; 3], tol),
                "tol={tol}: sub-grid jitter must be absorbed"
            );
        }
    }
}
