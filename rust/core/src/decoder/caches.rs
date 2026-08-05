// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `EntityDecoder`'s cache management.
//!
//! Split from `decoder.rs` under the house rule (AGENTS.md). These are one
//! cohesive concern — what is retained, what is handed across rayon workers,
//! and what a caller may drop to bound memory — and they read better together
//! than scattered among the decode paths that populate them.

use rustc_hash::FxHashMap;
use std::sync::Arc;

use super::EntityDecoder;
use crate::DecodedEntity;

impl EntityDecoder<'_> {
    /// Drain the populated cache out of this decoder for sharing across
    /// rayon tasks. After calling this, the decoder is empty (cache
    /// moved out); callers typically then drop the decoder.
    pub fn drain_cache(&mut self) -> FxHashMap<u32, Arc<DecodedEntity>> {
        std::mem::take(&mut self.cache)
    }

    /// Clear all caches to free memory
    pub fn clear_cache(&mut self) {
        self.cache.clear();
        self.point_cache.clear();
        self.placement_transform_cache.clear();
    }

    /// Clear only the decoded-entity cache, keeping the placement memo.
    ///
    /// For a caller that drains on a size trigger while resolving placements.
    /// The two caches have very different value per byte: an entry in the
    /// entity cache saves one re-decode of one entity, while an entry in the
    /// placement memo can save re-walking a chain that thousands of elements
    /// share — a site or building transform is resolved once and read by every
    /// product under it. Dropping the memo to bound the entity cache trades the
    /// expensive one away to bound the cheap one, and does it invisibly: output
    /// stays correct and large models simply get slower.
    pub fn clear_entity_cache(&mut self) {
        self.cache.clear();
    }

    /// Clear only the point coordinate cache (used after BREP preprocessing).
    /// The entity cache is preserved for subsequent geometry processing.
    pub fn clear_point_cache(&mut self) {
        self.point_cache.clear();
    }

    /// Move the CartesianPoint coordinate cache OUT of this decoder, leaving it
    /// empty. Paired with [`Self::set_point_cache`] to hoist the cache across the
    /// per-element decoders a single worker builds within one batch: the cache is
    /// pure memoization of `content` + point id -> coords, so reusing it across
    /// elements is byte-identical (speed only). Cheap: moves the map header, not
    /// its contents.
    pub fn take_point_cache(&mut self) -> FxHashMap<u32, (f64, f64, f64)> {
        std::mem::take(&mut self.point_cache)
    }

    /// Install a previously-accumulated point cache (see [`Self::take_point_cache`]).
    /// Does not reset the hit/miss counters, which stay per-decoder so each job's
    /// [`Self::point_cache_stats`] reflect only that job's activity.
    pub fn set_point_cache(&mut self, cache: FxHashMap<u32, (f64, f64, f64)>) {
        self.point_cache = cache;
    }

    /// `(hits, misses)` served by [`Self::get_polyloop_coords_cached`] over this
    /// decoder's lifetime. A hit is a CartesianPoint served from the cache; a miss
    /// is one parsed for the first time. Non-zero hits after processing more than
    /// one faceted part with a shared point list prove cross-element memoization.
    pub fn point_cache_stats(&self) -> (u64, u64) {
        (self.point_cache_hits, self.point_cache_misses)
    }

    /// Move the placement-transform memo OUT of this decoder, leaving it empty.
    /// Paired with [`Self::set_placement_transform_cache`] to hoist the cache
    /// across the per-element decoders a single worker builds within one batch,
    /// exactly like [`Self::take_point_cache`]. The memo is a pure function of
    /// `content` + placement id (deterministic `parent * local` composition), so
    /// reusing it across elements is byte-identical (speed only). Cheap: moves
    /// the map header, not its contents.
    pub fn take_placement_transform_cache(&mut self) -> FxHashMap<u32, [f64; 16]> {
        std::mem::take(&mut self.placement_transform_cache)
    }

    /// Install a previously-accumulated placement-transform memo (see
    /// [`Self::take_placement_transform_cache`]).
    pub fn set_placement_transform_cache(&mut self, cache: FxHashMap<u32, [f64; 16]>) {
        self.placement_transform_cache = cache;
    }

    /// Read a memoized placement world transform by placement id. Returns a copy
    /// (`[f64; 16]` is `Copy`) so the caller can drop the borrow before
    /// reconstructing its `Matrix4`. The array is the opaque column-major layout
    /// written by [`Self::cache_placement_transform`].
    pub fn get_placement_transform_cached(&self, id: u32) -> Option<[f64; 16]> {
        self.placement_transform_cache.get(&id).copied()
    }

    /// Memoize a resolved placement world transform under its placement id. Only
    /// the geometry router's real computed transforms (IfcLocalPlacement /
    /// linear / grid) are stored here; identity/depth-guard fallbacks are not, so
    /// the memo stays a pure function of the placement id (byte-identical reuse).
    pub fn cache_placement_transform(&mut self, id: u32, transform: [f64; 16]) {
        self.placement_transform_cache.insert(id, transform);
    }

    /// Get cache size
    pub fn cache_size(&self) -> usize {
        self.cache.len()
    }
}
