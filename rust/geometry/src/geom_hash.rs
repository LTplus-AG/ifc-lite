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
//!
//! ## World AABB (#1891 follow-on)
//!
//! The same pass also accumulates an UNQUANTIZED `f64` world axis-aligned
//! bounding box ([`GeometryHasher::world_aabb`]). The hash alone cannot say
//! WHY two revisions differ — "hash changed" conflates moved, reshaped and
//! re-tessellated — so the diff engine needs a second, interpretable signal.
//! The box is free here: `add_mesh_with_origin` already reconstructs the exact
//! `f64` world coordinate of every triangle corner in order to quantize it.
//!
//! ## Volume, and its gate (#1891)
//!
//! [`GeometryHasher::volume`] is the divergence-theorem volume of the same
//! geometry — but only for entities whose produced mesh is PROVABLY a single
//! closed orientable solid. That proof comes from
//! [`crate::orient_mesh_outward_verdict`], which the producer runs on each
//! segment immediately before feeding it here; the hasher cannot derive it
//! itself, because the adjacency needed to decide closedness is exactly what
//! that pass builds.
//!
//! Everything else gets `None`. Read [`GeometryHasher::volume`] before
//! loosening any clause of that gate — each one is there because a specific,
//! measured class of element reports a confidently wrong number without it,
//! and none of the wrong numbers look wrong. [`GeometryClosure`] rides along so
//! a consumer can say WHICH clause refused.

use crate::kernel::signed_volume::tetra_volume6;
use crate::mesh_orient::OrientVerdict;

/// The volume gate (`GeometryClosure` + `GeometryHasher::volume`). A CHILD
/// module, not a sibling, so it can read this module's private accumulators
/// without widening their visibility.
#[path = "geom_closure.rs"]
mod closure;
pub use closure::GeometryClosure;

/// The world AABB (`GeometryHasher::extend_bounds` + `::world_aabb`). A CHILD
/// module, not a sibling, so it can read this module's private accumulators
/// without widening their visibility.
#[path = "geom_bounds.rs"]
mod bounds;

/// Default quantization grid in metres (1 mm). Chosen as a starting point near
/// the `f32` precision floor of RTC-local coordinates; tune empirically with
/// the `tolerance_sweep` test against real revision pairs.
pub const DEFAULT_GEOM_HASH_TOLERANCE: f64 = 1.0e-3;

/// splitmix64 finalizer — strong avalanche for a single `u64`. Shared with
/// `router::content_hash`'s 128-bit content hash, which uses this SAME
/// finalizer per lane.
#[inline]
pub(crate) fn mix64(mut x: u64) -> u64 {
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
    /// Unquantized `f64` world bounds over every in-range triangle corner.
    /// An axis still holding its `INFINITY..NEG_INFINITY` sentinel never
    /// accumulated; axes can diverge here, so [`Self::world_aabb`] tests all
    /// three rather than assuming they move together.
    min: [f64; 3],
    max: [f64; 3],
    /// Running Σ 6·V over every contributing segment. Only read through
    /// [`GeometryHasher::volume`], which decides whether it means anything.
    volume6: f64,
    /// Folded [`GeometryClosure`] over the segments seen so far.
    closure: GeometryClosure,
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
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
            volume6: 0.0,
            closure: GeometryClosure::EMPTY,
        }
    }

    /// Reconstruct the full `f64` WORLD coordinate of one vertex. `origin` is
    /// the per-mesh local-frame origin (`world = origin + position`); pass
    /// `[0.0; 3]` for absolute-coordinate positions.
    #[inline]
    fn world(&self, positions: &[f32], vi: usize, origin: &[f64; 3]) -> [f64; 3] {
        let base = vi * 3;
        [
            positions[base] as f64 + origin[0] + self.rtc[0],
            positions[base + 1] as f64 + origin[1] + self.rtc[1],
            positions[base + 2] as f64 + origin[2] + self.rtc[2],
        ]
    }

    /// Snap a reconstructed world corner to the quantization grid.
    #[inline]
    fn quantize_corner(&self, world: &[f64; 3]) -> [i64; 3] {
        [
            quantize(world[0], self.inv_tol),
            quantize(world[1], self.inv_tol),
            quantize(world[2], self.inv_tol),
        ]
    }

    /// Add one mesh segment (a flat `[x,y,z, ...]` position buffer and a
    /// triangle index buffer). Indices that run past the position buffer or
    /// trailing non-triangle remainder are skipped defensively.
    pub fn add_mesh(&mut self, positions: &[f32], indices: &[u32]) {
        self.add_mesh_with_origin(positions, indices, [0.0; 3]);
    }

    /// Like [`add_mesh`] but for positions stored in a per-element LOCAL frame:
    /// `origin` (the per-mesh AABB-centre origin) is folded back so the hash is
    /// over absolute world coordinates. This keeps the fingerprint identical
    /// whether the producer emitted absolute positions (native) or local +
    /// origin (the wasm local-frame path), and still detects element MOVES.
    ///
    /// The segment carries no topology verdict, so it counts as NOT a closed
    /// solid and permanently disarms [`Self::volume`]. Producers that ran
    /// [`crate::orient_mesh_outward_verdict`] on this exact buffer should call
    /// [`Self::add_oriented_mesh`] instead.
    pub fn add_mesh_with_origin(&mut self, positions: &[f32], indices: &[u32], origin: [f64; 3]) {
        self.add_oriented_mesh(positions, indices, origin, OrientVerdict::INDETERMINATE);
    }

    /// [`Self::add_mesh_with_origin`] for a segment the producer just ran the
    /// outward-orienter over, passing that pass's [`OrientVerdict`] along.
    ///
    /// `verdict` MUST describe this exact position/index buffer — the volume
    /// below is only as honest as the closedness claim behind it. Anything
    /// short of a single closed orientable component disarms the element's
    /// volume permanently; see [`Self::volume`].
    pub fn add_oriented_mesh(
        &mut self,
        positions: &[f32],
        indices: &[u32],
        origin: [f64; 3],
        verdict: OrientVerdict,
    ) {
        // Σ 6·V for THIS segment, referenced to its own first in-range corner
        // (`vol_ref`). Any reference gives the same total on a closed surface,
        // but referencing a point ON the surface keeps every operand bounded by
        // the segment's own diameter — a georeferenced model at 1e5 m would
        // otherwise multiply three ~1e5 coordinates and cancel a ~1 m³ answer
        // out of ~1e15, losing every significant digit.
        let mut seg_volume6 = 0.0f64;
        let mut vol_ref: Option<[f64; 3]> = None;
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

            let world = [
                self.world(positions, i0, &origin),
                self.world(positions, i1, &origin),
                self.world(positions, i2, &origin),
            ];

            // Bounds take EVERY in-range corner, including those of triangles
            // the hash rejects as post-quantization degenerate below. A sliver
            // or zero-area face carries no shape signal for the fingerprint,
            // but its corners are real geometry and do contribute extent —
            // dropping them would under-report the element's box.
            for corner in &world {
                self.extend_bounds(corner);
            }

            // Volume accumulates HERE, from `world`, whose corners are still in
            // the buffer's authored order. The quantized copy `tri` below is
            // SORTED (that is what makes the fingerprint winding-invariant), so
            // anything downstream of that sort has no winding left to integrate.
            //
            // Every in-range triangle counts, including the ones the hash drops
            // as post-quantization degenerate: a sub-millimetre sliver carries
            // no shape signal for a fingerprint, but it is part of the closed
            // surface, and its (near-zero) flux belongs in the sum.
            let o = *vol_ref.get_or_insert(world[0]);
            seg_volume6 += tetra_volume6(&world[0], &world[1], &world[2], &o);

            // Sort the three quantized corners so triangle winding and the
            // starting vertex don't affect the hash — only the (multiset of)
            // positions and their adjacency as a triangle.
            let mut tri = [
                self.quantize_corner(&world[0]),
                self.quantize_corner(&world[1]),
                self.quantize_corner(&world[2]),
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

        // A call that contributed no in-range triangle is not a segment: it has
        // no geometry, so its verdict says nothing about the element.
        if vol_ref.is_none() {
            return;
        }
        self.closure.fold_segment(&verdict);
        self.volume6 += seg_volume6;
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
#[path = "geom_hash_tests.rs"]
mod tests;
