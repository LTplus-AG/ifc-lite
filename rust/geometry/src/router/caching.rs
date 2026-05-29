// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Geometry hash caching for deduplication of repeated geometry.

use super::GeometryRouter;
use crate::Mesh;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

impl GeometryRouter {
    /// Compute hash of mesh geometry for deduplication.
    /// Uses FxHasher for speed — we don't need cryptographic hashing.
    ///
    /// For meshes with >MAX_HASH_ELEMENTS values, samples positions evenly
    /// instead of hashing all data. Combined with vertex/index count matching,
    /// this gives excellent collision resistance at O(1) cost per mesh.
    #[inline]
    pub(super) fn compute_mesh_hash(mesh: &Mesh) -> u64 {
        use rustc_hash::FxHasher;
        let mut hasher = FxHasher::default();

        // Hash vertex count and index count first for fast rejection
        let pos_len = mesh.positions.len();
        let idx_len = mesh.indices.len();
        pos_len.hash(&mut hasher);
        idx_len.hash(&mut hasher);

        // For small meshes, hash everything. For large meshes, sample evenly.
        // 128 samples × (positions + indices) = 256 hash ops max, regardless of mesh size.
        const MAX_HASH_ELEMENTS: usize = 128;

        if pos_len <= MAX_HASH_ELEMENTS {
            for pos in &mesh.positions {
                pos.to_bits().hash(&mut hasher);
            }
        } else {
            // Sample evenly across positions
            let step = pos_len / MAX_HASH_ELEMENTS;
            for i in (0..pos_len).step_by(step).take(MAX_HASH_ELEMENTS) {
                mesh.positions[i].to_bits().hash(&mut hasher);
            }
            // Always include last few values (catch tail differences)
            if pos_len >= 3 {
                mesh.positions[pos_len - 1].to_bits().hash(&mut hasher);
                mesh.positions[pos_len - 2].to_bits().hash(&mut hasher);
                mesh.positions[pos_len - 3].to_bits().hash(&mut hasher);
            }
        }

        if idx_len <= MAX_HASH_ELEMENTS {
            for idx in &mesh.indices {
                idx.hash(&mut hasher);
            }
        } else {
            let step = idx_len / MAX_HASH_ELEMENTS;
            for i in (0..idx_len).step_by(step).take(MAX_HASH_ELEMENTS) {
                mesh.indices[i].hash(&mut hasher);
            }
            if idx_len >= 3 {
                mesh.indices[idx_len - 1].hash(&mut hasher);
                mesh.indices[idx_len - 2].hash(&mut hasher);
                mesh.indices[idx_len - 3].hash(&mut hasher);
            }
        }

        hasher.finish()
    }

    /// Try to get a cached mesh by hash, or cache the provided one.
    /// Returns `Arc<Mesh>` — either the previously cached identical mesh
    /// or a fresh `Arc` wrapping the provided mesh.
    ///
    /// **Collision handling.** The old fast path returned a hash match
    /// without checking equality, on the theory that FxHasher's 64-bit
    /// output collides only ~1 in 2^64. That assumption broke on
    /// schependomlaan.ifc under wasm32 codegen (issue #833): two slabs
    /// with mirrored cross-sections (a 7.43 m × 3 m rectangle in +X+Y
    /// vs −X−Y) hashed to the same value, so the second slab inherited
    /// the first's local mesh and rendered at the wrong location after
    /// placement. The pos/idx sample density is high enough to catch
    /// most "different mesh same hash" cases, but two near-mirror
    /// meshes sharing the same `(0,0,0)` corner and a lot of axis-
    /// aligned vertices apparently land close enough in hasher state
    /// space to collide.
    ///
    /// We now do a full `(positions, indices)` equality check on every
    /// hash hit. On a true match (the common case — repeated geometry
    /// across an N-storey building) we return the cached `Arc`. On a
    /// false positive we return a fresh `Arc` *without* overwriting the
    /// existing entry, so subsequent lookups for the first mesh still
    /// dedupe. The equality check costs one pass over the mesh data,
    /// which is much cheaper than the worst-case repercussions of a
    /// silent collision.
    #[inline]
    pub(super) fn get_or_cache_by_hash(&self, mesh: Mesh) -> Arc<Mesh> {
        let hash = Self::compute_mesh_hash(&mesh);

        {
            let cache = self.geometry_hash_cache.borrow();
            if let Some(cached) = cache.get(&hash) {
                if meshes_equal(cached, &mesh) {
                    return Arc::clone(cached);
                }
                // Hash collision with different content — return a
                // fresh Arc, leave the cache entry alone so other
                // callers of the first mesh keep deduping.
                return Arc::new(mesh);
            }
        }

        let arc_mesh = Arc::new(mesh);
        {
            let mut cache = self.geometry_hash_cache.borrow_mut();
            cache.insert(hash, Arc::clone(&arc_mesh));
        }
        arc_mesh
    }
}

/// Byte-exact equality of two meshes for cache-collision disambiguation.
/// Compares `positions` and `indices` only — `normals` are derived from
/// `positions` and follow lock-step, and `rtc_applied` is a flag rather
/// than geometry. Lengths are checked first so the slice compare is
/// short-circuited cheaply when shapes differ.
#[inline]
fn meshes_equal(a: &Mesh, b: &Mesh) -> bool {
    a.positions.len() == b.positions.len()
        && a.indices.len() == b.indices.len()
        && a.positions == b.positions
        && a.indices == b.indices
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router::GeometryRouter;

    /// Issue #833 regression. Two distinct meshes that happen to share
    /// the same `compute_mesh_hash` output must not be deduped — the
    /// previous hash-only-equality cache caused slab #783200 in
    /// schependomlaan.ifc to inherit the local mesh of slab #605217
    /// because both rectangular profiles hashed identically under
    /// wasm32 codegen.
    ///
    /// We can't easily reproduce the wasm32 hash collision in a native
    /// unit test, so we forge one: build a second `Mesh` that differs
    /// from the first only in position data, manually insert it into
    /// the cache under the *first* mesh's hash, and assert
    /// `get_or_cache_by_hash` falls through to a fresh `Arc` instead of
    /// silently returning the wrong cached mesh.
    #[test]
    fn collision_does_not_silently_swap_meshes() {
        let router = GeometryRouter::new();
        let mut mesh_a = Mesh::new();
        mesh_a.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        mesh_a.indices = vec![0, 1, 2];
        mesh_a.normals = vec![0.0; 9];
        let mut mesh_b = Mesh::new();
        // Mirror of mesh_a about the X axis — distinct geometry that
        // *would* render at the wrong place if the cache returned A in
        // place of B.
        mesh_b.positions = vec![0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0, 0.0];
        mesh_b.indices = vec![0, 1, 2];
        mesh_b.normals = vec![0.0; 9];

        // Force a "collision" by inserting mesh_a under mesh_b's hash.
        let collision_hash = GeometryRouter::compute_mesh_hash(&mesh_b);
        let cached_a = Arc::new(mesh_a.clone());
        router
            .geometry_hash_cache
            .borrow_mut()
            .insert(collision_hash, Arc::clone(&cached_a));

        let returned = router.get_or_cache_by_hash(mesh_b.clone());
        // Pre-fix: returned would be `Arc::clone(&cached_a)` (wrong
        // mesh!). Post-fix: returned is a fresh Arc wrapping mesh_b.
        assert_eq!(
            returned.positions, mesh_b.positions,
            "cache returned mesh_a after hash collision — issue #833 regression",
        );
        assert!(
            !Arc::ptr_eq(&returned, &cached_a),
            "cache returned the same Arc as the collision-inserted entry",
        );
    }

    /// Identical meshes should still dedupe — the fix must not regress
    /// the cache's main job (sharing repeated geometry across N-storey
    /// buildings, instanced doors, etc.).
    #[test]
    fn identical_meshes_still_dedupe() {
        let router = GeometryRouter::new();
        let mut mesh = Mesh::new();
        mesh.positions = vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0, 0.0];
        mesh.indices = vec![0, 1, 2];
        mesh.normals = vec![0.0; 9];

        let first = router.get_or_cache_by_hash(mesh.clone());
        let second = router.get_or_cache_by_hash(mesh.clone());
        assert!(
            Arc::ptr_eq(&first, &second),
            "two identical meshes did not share the cached Arc",
        );
    }
}
