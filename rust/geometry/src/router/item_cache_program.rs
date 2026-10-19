// SPDX-License-Identifier: MPL-2.0
//! Canonical item cache admission and reached publication, split around work.
use super::GeometryRouter;
use crate::{Mesh, Result, InstanceMeta, math::mat4};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::sync::Arc;

pub(crate) struct CacheContext { dedup_key: Option<u128>, failure_mark: Option<usize>, ifc_type: IfcType }
pub(crate) enum CacheAdmission { Hit(Mesh), Miss(CacheContext) }
impl GeometryRouter {
    fn stamp_direct_instance(&self, mut mesh: Mesh, rep: Option<u128>) -> Mesh {
        if let Some(exact_rep) = rep {
            mesh.instance_meta = Some(InstanceMeta { transform: mat4::IDENTITY,
                local_transform: None, canonical_transform: None,
                rep_identity: exact_rep, instanceable: true });
        }
        mesh
    }
    pub(crate) fn admit_item_cache(&self, item: &DecodedEntity, decoder: &mut EntityDecoder<'_>,
        offset_meters: (f64,f64,f64)) -> Result<CacheAdmission> {
        crate::resource::check_current()?;
        if crate::resource::is_active() && self.item_dedup_cache.is_some() {
            return Err(crate::resource::refused(crate::resource::Dimension::Coverage, 0, 0,
                crate::resource::RefusalReason::UnsupportedCoverage).into());
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
                return Ok(super::item_cache_program::CacheAdmission::Hit(self.stamp_direct_instance(mesh, rep)));
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

        Ok(CacheAdmission::Miss(CacheContext { dedup_key, failure_mark, ifc_type:item.ifc_type.clone() }))
    }
    pub(crate) fn accept_local_item_cache(&self, mesh: Mesh) -> Result<Mesh> {
        if mesh.positions.is_empty() { return Ok(mesh) }
        if crate::resource::is_active() {
            let bytes = crate::resource::mesh::resident_bytes(&mesh).map_err(|_| crate::resource::overflow())?;
            crate::resource::charge(crate::resource::Cost { live_bytes: bytes, ..Default::default() })?.retain();
            self.retain_local_resource_account()?;
            let cached = self.get_or_cache_by_hash(mesh);
            let (mesh, permit) = crate::resource::mesh::clone_mesh(&cached)?;
            permit.retain();
            Ok(mesh)
        } else { Ok((*self.get_or_cache_by_hash(mesh)).clone()) }
    }
    pub(crate) fn publish_item_cache(&self, context: CacheContext, mesh: Mesh, rep: Option<u128>) -> Result<Mesh> {
        let CacheContext { dedup_key, failure_mark, ifc_type } = context;
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
            if let Some(processor) = self.processor_for(&ifc_type) {
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

        Ok(self.stamp_direct_instance(mesh, rep))
    }
}
