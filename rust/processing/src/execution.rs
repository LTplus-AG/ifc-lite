// SPDX-License-Identifier: MPL-2.0
//! Shared scheduler boundaries around the owned element transaction. Worker
//! caches, batch source ownership and output encoding remain with the callers.
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::{
    GeometryRouter, ItemDedupCache, MappedInstancePlan, MaterialLayerIndex, RouterConfig,
    SharedBrepSignatureCache, SharedMappedItemCache,
};
use rustc_hash::{FxHashMap, FxHashSet};
use std::sync::Arc;

/// Native jobs choose the model-wide template; serial browser batches choose
/// their first occurrence. The policy also selects uncached versus warm decode.
#[derive(Clone, Copy)]
pub enum SchedulerPolicy {
    PerJob,
    PerBatch,
}

/// Model-owned cache handles, transferred into the router without extra clones.
pub struct RouterCaches {
    pub items: ItemDedupCache,
    pub brep_signatures: SharedBrepSignatureCache,
    pub mapped_items: SharedMappedItemCache,
}

/// Arm a router completely before the first owned product leases it. Native
/// callers forward the model material-layer index; browser callers retain their
/// merge toggle. Indexed-colour exclusion is meaningful only with instancing armed.
pub fn build_router(
    mut config: RouterConfig,
    policy: SchedulerPolicy,
    caches: RouterCaches,
    layers: Option<Arc<MaterialLayerIndex>>,
    instances: Option<&MappedInstancePlan>,
    indexed_colours: Option<&Arc<FxHashSet<u32>>>,
) -> GeometryRouter {
    config.instancing_batch_local =
        instances.is_some() && matches!(policy, SchedulerPolicy::PerBatch);
    // Preserve the caller's world-frame rebase.
    let mut router = GeometryRouter::from_config(config);
    router.enable_content_dedup_shared(caches.items);
    router.enable_shared_brep_signature_cache(caches.brep_signatures);
    router.enable_shared_mapped_item_cache(caches.mapped_items);
    if let Some(layers) = layers {
        router.set_material_layer_index(layers);
    }
    if let Some(plan) = instances {
        router.enable_output_instancing(plan.clone());
        if let Some(ids) = indexed_colours {
            router.enable_indexed_colour_split_guard(ids.clone());
        }
    }
    router
}

/// A job's original byte span. Cached browser decode may return without reading
/// it, so keyword recovery must use a checked slice even after successful decode.
#[derive(Clone, Copy)]
pub struct JobSpan {
    pub id: u32,
    pub start: usize,
    pub end: usize,
}

/// No new allocation for native jobs; browser cache hits keep their Arc.
pub enum JobEntity {
    Owned(DecodedEntity),
    Cached(Arc<DecodedEntity>),
}
impl std::ops::Deref for JobEntity {
    type Target = DecodedEntity;
    fn deref(&self) -> &Self::Target {
        match self {
            Self::Owned(entity) => entity,
            Self::Cached(entity) => entity,
        }
    }
}

/// Shared decode admission. Error accounting stays scheduler-scoped: per-job
/// decoder on native, cumulative refused-record set on a browser batch.
pub fn decode_job(
    decoder: &mut EntityDecoder,
    span: JobSpan,
    policy: SchedulerPolicy,
) -> ifc_lite_core::Result<JobEntity> {
    match policy {
        SchedulerPolicy::PerJob => decoder
            .decode_at(span.start, span.end)
            .map(JobEntity::Owned),
        SchedulerPolicy::PerBatch => decoder
            .decode_and_cache(span.id, span.start, span.end)
            .map(JobEntity::Cached),
    }
}

/// Native scanning already resolved the exact keyword. Browser jobs carry only
/// spans and recover it here, including on warm-decoder cache hits (#3179).
pub fn job_type(
    entity: &DecodedEntity,
    source: &[u8],
    span: JobSpan,
    scanned: Option<&IfcType>,
) -> IfcType {
    scanned.cloned().unwrap_or_else(|| {
        ifc_lite_core::ifc_type_from_record(
            entity.ifc_type.clone(),
            source.get(span.start..span.end).unwrap_or_default(),
        )
    })
}

/// Router-wide counters are taken once per native job or once per browser
/// batch. Per-element CSG failures and unsupported-item audit remain at their
/// existing owned-production/publication boundaries.
pub struct RouterDrain {
    pub classification: ifc_lite_geometry::ClassificationStats,
    pub hosts: FxHashMap<u32, ifc_lite_geometry::HostOpeningDiagnostic>,
    pub oversized_refs: u64,
    pub rect_fast: ifc_lite_geometry::RectFastStats,
}
impl RouterDrain {
    pub fn take(router: &GeometryRouter) -> Self {
        Self {
            classification: router.take_classification_stats(),
            hosts: router.take_host_opening_diagnostics(),
            oversized_refs: router.take_content_hash_oversized_ref_drops() as u64,
            rect_fast: router.take_rect_fast_stats(),
        }
    }
}

#[cfg(test)]
#[path = "execution_tests.rs"]
mod tests;
