// SPDX-License-Identifier: MPL-2.0
//! Representation-item cache admission and publication, split around the
//! selected item work that [`crate::program`] drives between them.
use super::transforms::instancing_enabled;
use super::GeometryRouter;
use crate::{math::mat4, InstanceMeta, Mesh};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use std::sync::Arc;

/// High tag bit distinguishing direct-solid rep_identity (a 128-bit local-mesh
/// content hash) from mapped-item rep_identity (a RepresentationMap entity id,
/// always < 2^32), so the two id spaces can never collide in `collate_instances`.
/// Bit 127 is set on direct-solid ids and clear on mapped ids; it costs one hash
/// bit (127 effective), still content-addressing grade.
const DIRECT_SOLID_TAG: u128 = 1u128 << 127;

/// Publication capability retained by the cache controller while the item runs.
pub(crate) struct CacheContext {
    dedup_key: Option<u128>,
    failure_mark: Option<usize>,
}
pub(crate) enum CacheAdmission {
    Hit(Mesh),
    Miss(CacheContext),
}

impl GeometryRouter {
    /// The router's execution owner identity: instance plus configuration
    /// generation, bumped by every setter that changes item geometry.
    pub(crate) fn execution_identity(&self) -> ifc_lite_core::execution_owner::ExecutionIdentity {
        self.execution_owner.identity()
    }

    /// Look the item up in the content-dedup cache. A hit clones the cached
    /// item mesh and stamps its STORED rep_identity (no per-occurrence re-hash);
    /// meshing is skipped entirely. `None` dedup key ⇒ dedup disabled (no hash
    /// overhead).
    pub(crate) fn admit_item_cache(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> crate::Result<CacheAdmission> {
        // The shared content-dedup cache has no admission owner: bounded
        // execution refuses it before any lookup.
        self.check_item_dedup_coverage()?;
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
                return Ok(CacheAdmission::Hit(stamp_direct_instance(mesh, rep)));
            }
        }

        // #4083 (double-count half only — see `publish_item_cache`): snapshot
        // the item's processor's own failure log BEFORE the uncached build, so
        // any record it adds during THIS item can be attributed to `dedup_key`
        // and, if a racing router sharing this cache already claimed that key,
        // retracted at publication. `None` when the item's type has no
        // registered processor (nothing to snapshot, nothing to retract) or
        // dedup is disabled (`dedup_key` is `None`).
        let failure_mark = dedup_key.and_then(|_| {
            self.processors
                .get(&item.ifc_type, self.schema)
                .map(|p| p.bool_failure_count())
        });
        Ok(CacheAdmission::Miss(CacheContext { dedup_key, failure_mark }))
    }

    /// Router-local content-hash dedup of a freshly meshed item: buildings with
    /// repeated floors have identical geometry.
    ///
    /// Accounted execution admits the moved backing (spare Vec capacity
    /// included) before publication and keeps the publishing account alive with
    /// the router, so the residency outlives the request; every occurrence's
    /// returned copy is charged, hit or miss.
    pub(crate) fn accept_local_item_cache(&self, mesh: Mesh) -> crate::Result<Mesh> {
        if mesh.positions.is_empty() {
            return Ok(mesh);
        }
        if crate::resource::is_active() {
            return self.accept_local_item_cache_accounted(mesh);
        }
        Ok((*self.get_or_cache_by_hash(mesh)).clone())
    }

    /// The accounted publication of [`Self::accept_local_item_cache`], kept out
    /// of line so the default (unaccounted) item drain does not carry it.
    #[cold]
    #[inline(never)]
    fn accept_local_item_cache_accounted(&self, mesh: Mesh) -> crate::Result<Mesh> {
        let bytes = crate::resource::mesh::resident_bytes(&mesh)
            .map_err(|_| crate::resource::overflow())?;
        crate::resource::charge(crate::resource::Cost {
            live_bytes: bytes,
            ..Default::default()
        })?
        .retain();
        self.retain_local_resource_account()?;
        let cached = self.get_or_cache_by_hash(mesh);
        let (mesh, permit) = crate::resource::mesh::clone_mesh(&cached)?;
        permit.retain();
        Ok(mesh)
    }

    /// Publish a freshly meshed item under its structural hash and stamp the
    /// direct-solid rep identity computed by [`direct_rep_identity`].
    pub(crate) fn publish_item_cache(
        &self,
        item: &DecodedEntity,
        context: CacheContext,
        mesh: Mesh,
        rep: Option<u128>,
    ) -> Mesh {
        let CacheContext { dedup_key, failure_mark } = context;
        // If this item's processor recorded anything new, decide whether THIS
        // router keeps it: the item-dedup cache's `diagnostic_claimed` set
        // (shared with every router built from the same
        // `enable_content_dedup_shared` cache) lets exactly one racing router
        // keep the diagnostic for one `item_dedup_key`; every other one
        // retracts its own copy of the same logical operation's record.
        //
        // Fixes ONLY the double-count half of #4083: two racing MISSES each
        // computing (and each initially recording) the same tear now collapse
        // to one record. Does NOT fix the omission half — a cache HIT never
        // reaches publication at all, so it still reports zero diagnostics
        // regardless of what the warm MISS recorded.
        if let (Some(key), Some(before), Some(cache)) =
            (dedup_key, failure_mark, self.item_dedup_cache.as_ref())
        {
            if let Some(processor) = self.processor_for(&item.ifc_type) {
                if processor.bool_failure_count() > before && !cache.claim_diagnostic(key) {
                    processor.truncate_bool_failures_to(before);
                }
            }
        }

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
        stamp_direct_instance(mesh, rep)
    }
}

/// The direct-solid instancing `rep_identity` for a freshly-built,
/// pre-placement item mesh, or `None` when instancing is off / the mesh is
/// empty / it already carries metadata (mapped items). Source-free: FULL
/// 128-bit (non-sampling) hash, because rep_identity has no downstream
/// meshes_equal guard at the source and must be cross-worker consistent, so a
/// sampled-hash collision (#833 family) would silently group non-identical
/// geometry; 128-bit makes that ~2^-127. Computed ONCE per unique shape —
/// cache hits reuse the stored value instead of re-hashing.
pub(crate) fn direct_rep_identity(mesh: &Mesh) -> Option<u128> {
    if instancing_enabled() && mesh.instance_meta.is_none() && !mesh.positions.is_empty() {
        Some(GeometryRouter::compute_mesh_hash_full(mesh) | DIRECT_SOLID_TAG)
    } else {
        None
    }
}

/// Stamp a direct-solid item mesh with a KNOWN `rep_identity` (no re-hash) so
/// identical representations collate into a single template + per-occurrence
/// transforms. `None` is a no-op (instancing off / empty / already tagged).
fn stamp_direct_instance(mut mesh: Mesh, rep: Option<u128>) -> Mesh {
    if let Some(exact_rep) = rep {
        mesh.instance_meta = Some(InstanceMeta {
            transform: mat4::IDENTITY,
            local_transform: None,
            canonical_transform: None,
            rep_identity: exact_rep,
            instanceable: true,
        });
    }
    mesh
}
