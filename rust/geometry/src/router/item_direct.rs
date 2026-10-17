// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The direct-item stages of the item pipeline: content dedup of identical item
//! subtrees, the #4083 diagnostic claim, and the direct-solid instance stamp.

use super::transforms::instancing_enabled;
use super::GeometryRouter;
use crate::{InstanceMeta, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::sync::Arc;

/// High tag bit distinguishing direct-solid rep_identity (a 128-bit local-mesh
/// content hash) from mapped-item rep_identity (a RepresentationMap entity id,
/// always < 2^32), so the two id spaces can never collide in `collate_instances`.
/// Bit 127 is set on direct-solid ids and clear on mapped ids; it costs one hash
/// bit (127 effective), still content-addressing grade.
const DIRECT_SOLID_TAG: u128 = 1u128 << 127;

impl GeometryRouter {
    pub(super) fn process_representation_item_body(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Result<Mesh> {
        // MappedItem has its own instancing cache (the source representation is
        // already shared), so it never enters the structural-hash path. It also
        // sets its own instance_meta, so the direct-solid tagging below is skipped.
        if item.ifc_type == IfcType::IfcMappedItem {
            return self.process_mapped_item_cached(item, decoder);
        }

        // `None` ⇒ dedup disabled (no hash overhead). On a hit, clone the cached
        // item mesh and stamp its STORED rep_identity (no per-occurrence re-hash);
        // meshing is skipped entirely.
        let dedup_key = self.item_dedup_key_in_frame(item, decoder, offset_meters);
        if let (Some(key), Some(cache)) = (dedup_key, self.item_dedup_cache.as_ref()) {
            let hit = cache
                .meshes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&key)
                .cloned();
            if let Some(entry) = hit {
                let (mesh, rep) = (entry.0.clone(), entry.1);
                return Ok(self.stamp_direct_instance(mesh, rep));
            }
        }

        // #4083 (double-count half only — see the module-level cross-reference
        // below): snapshot the item's processor's own failure log BEFORE the
        // uncached build, so any record it adds during THIS call can be
        // attributed to `dedup_key` and, if a racing router sharing this cache
        // already claimed that key, retracted below. `None` when the item's
        // type has no registered processor (nothing to snapshot, nothing to
        // retract) or dedup is disabled (`dedup_key` is `None`).
        let failure_mark = dedup_key.and_then(|_| {
            self.processors
                .get(&item.ifc_type, self.schema)
                .map(|p| p.bool_failure_count())
        });

        let mesh = self.process_representation_item_uncached(item, decoder, offset_meters)?;

        // If this call's processor recorded anything new, decide whether THIS
        // router keeps it: the item-dedup cache's `diagnostic_claimed` set
        // (shared with every router built from the same
        // `enable_content_dedup_shared` cache) lets exactly one racing router
        // keep the diagnostic for one `item_dedup_key`; every other one
        // retracts its own copy of the same logical operation's record.
        //
        // Fixes ONLY the double-count half of #4083: two racing MISSES each
        // computing (and each initially recording) the same tear now collapse
        // to one record. Does NOT fix the omission half — a cache HIT never
        // reaches this code at all (it returns early above, before
        // `process_representation_item_uncached` runs), so it still reports
        // zero diagnostics regardless of what the warm MISS recorded.
        if let (Some(key), Some(before), Some(cache)) =
            (dedup_key, failure_mark, self.item_dedup_cache.as_ref())
        {
            if let Some(processor) = self.processor_for(&item.ifc_type) {
                if processor.bool_failure_count() > before && !cache.claim_diagnostic(key) {
                    processor.truncate_bool_failures_to(before);
                }
            }
        }

        // Compute the instancing rep_identity ONCE for this unique shape so cache
        // hits can reuse it instead of re-hashing the full mesh per occurrence.
        let rep = self.direct_rep_identity(&mesh);

        // Cache the freshly-meshed item under its structural hash. Two exclusions:
        //  - empty meshes (unsupported/degenerate geometry);
        //  - results produced once the per-element CSG budget has tripped. On a
        //    trip the boolean bails and `subtract_mesh` returns the UNCUT host
        //    (records `OperandTooLarge`); since the dedup key is budget-independent
        //    (structure/quality/scale/RTC), caching that fallback would serve the
        //    wrong (uncut) mesh to later identical booleans in a fresh-budget
        //    element (`budget::begin_element()` resets per element). Correctness of
        //    the cut wins over deduping a degraded result. (#1257 review P1.)
        if let (Some(key), Some(cache)) = (dedup_key, self.item_dedup_cache.as_ref()) {
            if !mesh.positions.is_empty() && !crate::kernel::budget::tripped() {
                // Clone into the Arc BEFORE locking: a mesh deep-copy inside the
                // single-Mutex critical section serializes the pool on every miss.
                let cached = Arc::new((mesh.clone(), rep));
                cache
                    .meshes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(key, cached);
            }
        }

        Ok(self.stamp_direct_instance(mesh, rep))
    }

    /// Compute the direct-solid instancing `rep_identity` for a freshly-built,
    /// pre-placement item mesh, or `None` when instancing is off / the mesh is
    /// empty / it already carries metadata (mapped items). FULL 128-bit
    /// (non-sampling) hash: rep_identity has no downstream meshes_equal guard at
    /// the source and must be cross-worker consistent, so a sampled-hash collision
    /// (#833 family) would silently group non-identical geometry; 128-bit makes
    /// that ~2^-127. Computed ONCE per unique shape — cache hits reuse the stored
    /// value via [`Self::stamp_direct_instance`] instead of re-hashing.
    fn direct_rep_identity(&self, mesh: &Mesh) -> Option<u128> {
        if instancing_enabled() && mesh.instance_meta.is_none() && !mesh.positions.is_empty() {
            Some(Self::compute_mesh_hash_full(mesh) | DIRECT_SOLID_TAG)
        } else {
            None
        }
    }

    /// Stamp a direct-solid item mesh with a KNOWN `rep_identity` (no re-hash) so
    /// identical representations collate into a single template + per-occurrence
    /// transforms. `rep` comes from [`Self::direct_rep_identity`] on a fresh build
    /// or from the dedup cache on a hit; `None` is a no-op (instancing off / empty
    /// / already tagged).
    fn stamp_direct_instance(&self, mut mesh: Mesh, rep: Option<u128>) -> Mesh {
        if let Some(exact_rep) = rep {
            mesh.instance_meta = Some(InstanceMeta::instanceable(exact_rep, None));
        }
        mesh
    }

}
