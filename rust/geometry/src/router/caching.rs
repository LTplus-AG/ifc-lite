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

    /// FULL (non-sampling) **128-bit** content hash of a mesh's local geometry.
    /// Used for the instancing `rep_identity`, which — unlike `get_or_cache_by_hash`
    /// — has no downstream `meshes_equal` guard at the source AND must be consistent
    /// across rayon workers (so a per-worker equality registry can't cover it). The
    /// 64-bit SAMPLED `compute_mesh_hash` shipped a real wrong-geometry collision
    /// (#833, mirrored slabs). This hashes EVERY position + index into two
    /// independent FxHasher streams (different seeds) → a 128-bit key whose
    /// collision probability (~2^-127, content-addressing grade) makes a
    /// different-content collision effectively impossible. O(verts) once per item,
    /// only on the opt-in instancing path.
    #[inline]
    pub(super) fn compute_mesh_hash_full(mesh: &Mesh) -> u128 {
        use rustc_hash::FxHasher;
        let mut a = FxHasher::default();
        let mut b = FxHasher::default();
        // Decorrelate stream b with a salt prefix (portable; no with_seed dep).
        0x9e37_79b9_7f4a_7c15u64.hash(&mut b);
        mesh.positions.len().hash(&mut a);
        mesh.indices.len().hash(&mut a);
        mesh.positions.len().hash(&mut b);
        mesh.indices.len().hash(&mut b);
        for pos in &mesh.positions {
            let bits = pos.to_bits();
            bits.hash(&mut a);
            bits.hash(&mut b);
        }
        for idx in &mesh.indices {
            idx.hash(&mut a);
            idx.hash(&mut b);
        }
        ((a.finish() as u128) << 64) | (b.finish() as u128)
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

/// Content equality of two meshes for cache-collision disambiguation: every
/// field of [`Mesh`] except the `instance_meta` side-channel, which carries no
/// geometry (see its own doc). The per-vertex buffers compare BIT patterns, the
/// rest by value.
///
/// Both meshes are DESTRUCTURED rather than field-accessed, so a field added to
/// `Mesh` fails to compile here until someone decides whether cache identity
/// depends on it. A field silently left out is the defect this guards against.
/// `normals` were omitted on the premise that they follow from `positions`, and
/// they do not: a processor derives them in f64 from the source coordinates and
/// narrows the result independently, so a source difference below the f32
/// position ULP disappears from `positions` while surviving in the near-zero
/// components of a normalized direction. Two rectangular openings authored at
/// the same size, one ring coordinate at `0.7` and the other at
/// `0.699999999999999`, are that case: identical f32 positions and indices,
/// side-wall normals differing in the last bits. Serving one for the other put
/// a neighbour's normals on an element, and which neighbour won depended on the
/// order the cache happened to be filled in, so the same file did not mesh to
/// the same bytes twice (#8276).
///
/// Bit patterns for those buffers, because `f32::eq` holds for `0.0` and
/// `-0.0`, whose bits differ, and the buffers ship to the consumer as bytes. A
/// signed zero is the same difference one exponent further down: a normalized
/// direction whose component underflows to zero takes the sign of the
/// numerator. `compute_mesh_hash` reads positions and indices only, so such a
/// pair collides on the key with nothing behind it. Bitwise also makes two
/// identical NaN buffers equal where `f32::eq` called them different, which is
/// the right answer for a cache keyed on content.
///
/// Value equality for the rest, on purpose: `rtc_applied`, `origin`,
/// `local_bounds` and `local_to_world` are frame metadata, read as quantities
/// rather than shipped as bytes, and `-0.0` is the same origin as `0.0`. They
/// belong in the key for the reason #5698 gives: equal positions under
/// different frames are different geometry, and a rebased mesh must never be
/// served for an unshifted one. `plane_tags` hold f64 planes, so they carry a
/// smaller source difference still, and they steer `consolidate_coplanar`'s
/// plane buckets, where a swapped array changes a later cut (#5012).
///
/// Cheap fields and all three lengths go first, so a shape mismatch never
/// reaches the buffer data. Each compare does check its own length, but only
/// after the compares ahead of it have already walked their buffers.
#[inline]
fn meshes_equal(a: &Mesh, b: &Mesh) -> bool {
    let Mesh {
        positions,
        normals,
        indices,
        rtc_applied,
        origin,
        instance_meta: _,
        local_bounds,
        local_to_world,
        welded_in_object_frame,
        plane_tags,
    } = a;
    *rtc_applied == b.rtc_applied
        && *welded_in_object_frame == b.welded_in_object_frame
        && *origin == b.origin
        && *local_bounds == b.local_bounds
        && *local_to_world == b.local_to_world
        && positions.len() == b.positions.len()
        && normals.len() == b.normals.len()
        && indices.len() == b.indices.len()
        && f32_bits_eq(positions, &b.positions)
        && f32_bits_eq(normals, &b.normals)
        && *indices == b.indices
        && *plane_tags == b.plane_tags
}

/// Bitwise equality of two f32 buffers. See [`meshes_equal`] for why the
/// per-vertex buffers compare bits rather than values. The length is checked
/// here and not left to the caller: `zip` stops at the shorter side, which
/// would read a prefix match as equality.
#[inline]
fn f32_bits_eq(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

#[cfg(test)]
#[path = "caching_tests.rs"]
mod tests;
