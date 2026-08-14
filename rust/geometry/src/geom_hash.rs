// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-entity geometry fingerprinting for model diffing.
//!
//! The viewer's "compare two revisions" feature needs a stable per-entity
//! signature so an unchanged element hashes identically across two files,
//! while a genuine edit (moved, or reshaped so the surface itself changes)
//! hashes differently. Re-cutting an unchanged surface over the SAME corners is
//! *not* an edit and deliberately does not move the hash — see
//! **Retriangulation-invariant** below for the exact scope of that guarantee,
//! and [`GeometryHasher::finish`] for what the fingerprint can and cannot
//! distinguish.
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
//! * **Retriangulation-invariant, over a fixed vertex set.** So is the
//!   triangulator's DIAGONAL CHOICE. The hash is therefore taken over the
//!   SURFACE, in two channels re-cutting cannot move — the SET of distinct
//!   quantized vertices, and the total area within each supporting PLANE (see
//!   [`surface`]).
//!
//!   The guarantee is exactly this: re-cutting a region over the corners it
//!   already has (a re-split diagonal, a re-rooted fan) does not move the hash.
//!   It does **not** extend to a tessellation that INTRODUCES vertices — a quad
//!   refanned through a new centre point, or an edge split at a new midpoint,
//!   adds a member to the vertex-set channel and so does hash differently, even
//!   though the surface and its per-plane area are unchanged. Distinguishing
//!   that from a genuine edit needs a channel this fingerprint does not have.
//!   See [`GeometryHasher::finish`] for the rest of the limits.
//! * **Tolerance-quantized.** Positions are snapped to a grid of `tolerance`
//!   metres before hashing. Larger tolerance absorbs float noise (fewer false
//!   "changed") at the cost of missing sub-tolerance edits. See
//!   [`DEFAULT_GEOM_HASH_TOLERANCE`] and the `tolerance_sweep` test for the
//!   trade-off — the effective floor is the `f32` precision of the local
//!   positions (~1e-4 m near origin), so tolerances below ~1 mm mostly hash
//!   float noise. A request finer than [`MIN_GEOM_HASH_TOLERANCE`] is clamped
//!   up to it: below that grid, [`surface::plane_of`]'s `i128` plane-offset
//!   arithmetic is an overflow surface on a georeferenced model, not a
//!   precision win — see that constant for the measured bound.
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

/// The two surface channels the fingerprint is built from. A CHILD module, not
/// a sibling, so it can use this module's private `mix64`/`fold_i64`.
#[path = "geom_surface.rs"]
mod surface;

/// The per-segment triangle fold (`add_mesh` / `add_mesh_with_origin` /
/// `add_oriented_mesh`). A CHILD module, not a sibling, so it can read this
/// module's private accumulators without widening their visibility.
#[path = "geom_accumulate.rs"]
mod accumulate;

/// Default quantization grid in metres (1 mm). Chosen as a starting point near
/// the `f32` precision floor of RTC-local coordinates; `tolerance_sweep` only
/// exercises a synthetic cube today; real-revision-pair calibration is still
/// open (see that test's doc comment).
///
/// Safety margin is narrower than the "near-origin" framing above suggests:
/// measured `f32` ULP is 9.77e-4 m (98% of this bucket) at both 8192 m and
/// 10 km, only just under 1 mm before crossing it at 16384 m. It stays safe
/// only because [`LARGE_COORD_THRESHOLD_METERS`](crate::LARGE_COORD_THRESHOLD_METERS)
/// re-centres coordinates before they reach that range — an incidental
/// dependency, not a designed one. Raising that threshold past ~16 km would
/// need this tolerance revisited.
pub const DEFAULT_GEOM_HASH_TOLERANCE: f64 = 1.0e-3;

/// Floor on the quantization tolerance ([`GeometryHasher::new`] clamps any
/// smaller request up to this).
///
/// `plane_of`'s plane offset `d = n·point` is an `i128` product of a quantized
/// normal and a quantized corner, both scaled by `1/tolerance`; it grows
/// roughly as `1/tolerance²`. Measured on a georeferenced point (~2.6e6 m) and
/// a 100 m triangle, `tolerance = 1e-9` pushes `d` to ~1.6e38 — within a factor
/// of ~1 of `i128::MAX` (1.7e38), i.e. one differently-shaped input away from
/// overflow (debug builds panic, release wraps and two unrelated planes can
/// alias to the same key). At this floor the same inputs land `d` around
/// 1.6e26 — six orders of magnitude of headroom. It is also three orders of
/// magnitude finer than the documented useful floor (~1 mm, the `f32`
/// precision limit of RTC-local coordinates — see the module docs'
/// "Tolerance-quantized" bullet), so no real caller loses precision by being
/// clamped to it.
pub const MIN_GEOM_HASH_TOLERANCE: f64 = 1.0e-6;

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
    /// The distinct quantized world vertices seen so far, over every
    /// non-degenerate triangle (a degenerate one's corners are triangulation
    /// noise, and are excluded here for the same reason they are excluded from
    /// the hash). Membership only — [`Self::vertex_accum`] carries the hash.
    vertices: rustc_hash::FxHashSet<[i64; 3]>,
    /// Commutative running sum over the DISTINCT vertices in [`Self::vertices`]
    /// (one term added on first insertion), so vertex-buffer order, duplicated
    /// corners and segment splitting cannot move it.
    vertex_accum: u64,
    /// Commutative running sum of `plane_key * (twice-area)` over every
    /// triangle. Multiplication distributes over the wrapping sum, so this is
    /// exactly `Σ_planes plane_key * (that plane's total twice-area)`: a
    /// per-plane area total in O(1) space, invariant to how each plane's region
    /// was cut into triangles.
    plane_area_accum: u64,
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
    /// * `tolerance` — quantization grid in metres (must be `> 0`). Clamped up
    ///   to [`MIN_GEOM_HASH_TOLERANCE`] — see that constant for why a smaller
    ///   request is an `i128` overflow surface in [`surface::plane_of`], not a
    ///   precision win.
    /// * `rtc_offset` — the file's RTC offset, added back to local positions to
    ///   reconstruct world coordinates. Pass `[0.0; 3]` if positions are
    ///   already in world space.
    pub fn new(tolerance: f64, rtc_offset: [f64; 3]) -> Self {
        debug_assert!(tolerance > 0.0, "geometry hash tolerance must be positive");
        let tolerance = tolerance.max(MIN_GEOM_HASH_TOLERANCE);
        Self {
            inv_tol: 1.0 / tolerance,
            rtc: rtc_offset,
            vertices: rustc_hash::FxHashSet::default(),
            vertex_accum: 0,
            plane_area_accum: 0,
            triangle_count: 0,
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
            volume6: 0.0,
            closure: GeometryClosure::EMPTY,
        }
    }

    /// `true` until at least one (non-degenerate, in-range) triangle has been
    /// hashed. Lets callers skip emitting a fingerprint for entities that
    /// produced no geometry.
    pub fn is_empty(&self) -> bool {
        self.triangle_count == 0
    }

    /// Finalize the entity's geometry hash: the distinct-vertex sum and the
    /// per-plane area total.
    ///
    /// ## What a difference here means, and what it does not
    ///
    /// Two entities hash the same when they use the same set of quantized world
    /// vertices AND every plane carries the same total area. That covers the
    /// invariances the surface actually has — retriangulation, a re-rooted fan,
    /// triangle/segment order, winding — and still separates every genuine edit
    /// measured against it: a move, a scale, a face lifted out of its plane (new
    /// plane key), and faces deleted, whether or not their corners survive
    /// elsewhere in the mesh (the area falls either way).
    ///
    /// It is deliberately a weaker discriminator than the triangle set it
    /// replaced. What it can no longer separate: two arrangements over the SAME
    /// vertex set giving every plane the same total area (retriangulation is
    /// the benign member of that family; a re-cut into a different region of
    /// equal area on the same corners is the malign one, and is not something a
    /// re-export produces), and a change of TRIANGLE COUNT alone — the count is
    /// no longer folded in, being exactly what a retriangulation changes.
    ///
    /// Unchanged from before: winding is invisible, as is anything below the
    /// quantization grid.
    pub fn finish(&self) -> u64 {
        let h = fold_i64(self.vertex_accum, self.plane_area_accum as i64);
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
