// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-entity geometry job execution.
//!
//! [`run_job`] is the body of the parallel pass's `map` closure: one job = one
//! product, meshed on a fresh router with the worker's warm CartesianPoint and
//! placement caches moved in and back out. Everything it reads is the shared
//! [`PassContext`]; everything it reports goes to `ctx.diag`.
//! `build_color_updates_for_jobs` backfills deferred/orphan-type colours.

use super::color_layer::resolve_element_color_for_product_definition_shape;
use super::entity_index::ProcessingIndex;
use super::job::EntityJob;
use super::pass::PassContext;
use crate::style::GeometryStyleInfo;
use crate::types::mesh::MeshData;
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, RouterConfig};
use rustc_hash::FxHashMap;

/// Per-rayon-worker CartesianPoint caches: one `FxHashMap` behind a `Mutex` per
/// worker thread, indexed by `rayon::current_thread_index()`.
pub(super) type WorkerPointCaches = Vec<std::sync::Mutex<FxHashMap<u32, (f64, f64, f64)>>>;

/// Per-rayon-worker placement-transform caches, indexed like [`WorkerPointCaches`];
/// value is the opaque column-major `[f64; 16]` world transform the geometry
/// router memoizes per IfcObjectPlacement id.
pub(super) type WorkerPlacementCaches = Vec<std::sync::Mutex<FxHashMap<u32, [f64; 16]>>>;

/// One persistent CartesianPoint cache per rayon worker thread, indexed by
/// `rayon::current_thread_index()`.
///
/// The former per-chunk `map_init(FxHashMap::default, ...)` reallocated a fresh
/// cache for every worker AND every throughput chunk, and rayon's fine job
/// splitting fragmented it further, so a shared steel point list got re-parsed
/// once per split/chunk under real parallel execution (case-047/048). This store
/// lives across the WHOLE chunk loop, so each shared point is parsed at most once
/// per worker thread for the entire model. Each `Mutex` is only ever locked by the
/// one worker that owns that index (thread indices are unique per pool worker), so
/// no other thread contends for it. The cache is pure memoization of deterministic
/// coordinates, so meshes stay byte-identical (`mesh_determinism` no-diff).
///
/// The per-job body still moves its worker's slot into a local decoder and back,
/// so `WorkerCacheGuard` below is still required to survive a `decode_at` error —
/// and here it matters MORE than under the old per-chunk `map_init`: dropping a
/// persistent slot cold-starts that worker for the whole model, not just a chunk.
pub(super) fn new_worker_point_caches() -> WorkerPointCaches {
    (0..rayon::current_num_threads().max(1))
        .map(|_| std::sync::Mutex::new(FxHashMap::default()))
        .collect()
}

/// One persistent placement-transform cache per rayon worker thread, sized and
/// indexed identically to [`new_worker_point_caches`]. Storey/building
/// placements shared by thousands of elements are composed at most once per
/// worker thread for the whole model instead of re-resolving the placement chain
/// per element. Pure memoization of a deterministic composition, so meshes stay
/// byte-identical (`mesh_determinism` no-diff). Each slot is only ever locked by
/// the one worker that owns that index; see the `try_lock` note at the call site.
pub(super) fn new_worker_placement_caches() -> WorkerPlacementCaches {
    (0..rayon::current_num_threads().max(1))
        .map(|_| std::sync::Mutex::new(FxHashMap::default()))
        .collect()
}

/// RAII guard that returns a worker's warm CartesianPoint cache to its slot on
/// EVERY exit path — the normal return, the `decode_at` error early-return, and
/// a panic. Without it, a decode failure would drop `local_decoder` (holding the
/// worker's whole accumulated cache) before the write-back, cold-starting every
/// later element that worker runs and silently defeating the hoist.
/// `Deref`/`DerefMut` expose the wrapped decoder so call sites are unchanged.
struct WorkerCacheGuard<'c, 's> {
    decoder: EntityDecoder<'c>,
    slot: &'s mut FxHashMap<u32, (f64, f64, f64)>,
    // The worker's persistent placement-transform cache, written back on the
    // same EVERY-exit-path guarantee as `slot` so a `decode_at` error or panic
    // does not cold-start placement resolution for the worker's next element.
    placement_slot: &'s mut FxHashMap<u32, [f64; 16]>,
}

impl Drop for WorkerCacheGuard<'_, '_> {
    fn drop(&mut self) {
        // Cheap: moves the map header (now warmer), not its entries.
        *self.slot = self.decoder.take_point_cache();
        *self.placement_slot = self.decoder.take_placement_transform_cache();
    }
}

impl<'c> std::ops::Deref for WorkerCacheGuard<'c, '_> {
    type Target = EntityDecoder<'c>;
    fn deref(&self) -> &Self::Target {
        &self.decoder
    }
}

impl std::ops::DerefMut for WorkerCacheGuard<'_, '_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.decoder
    }
}

/// Mesh one job on the calling rayon worker, borrowing that worker's persistent
/// caches by thread index so a shared point list is parsed once per worker for
/// the whole model, not per chunk/part. `.map`/`.flatten_iter()` at the call
/// site keeps the former `flat_map_iter` order; the caches are pure
/// memoization, so meshes are byte-identical.
pub(super) fn run_job(job: &EntityJob, ctx: &PassContext<'_>) -> Vec<MeshData> {
    let widx = rayon::current_thread_index().unwrap_or(0) % ctx.worker_point_caches.len();
    // `try_lock`, not `lock`: faceted-brep triangulation nests a rayon
    // `par_iter`, so a worker blocked at that nested join can work-steal
    // another element job onto its OWN thread index and re-enter here.
    // `lock()` on the non-reentrant `Mutex` this thread already holds
    // would self-deadlock (regression from the persistent per-worker
    // cache). Each slot is a thread's own index, so `try_lock` only ever
    // fails on that re-entrant steal; the re-entered job uses a throwaway
    // cache instead. Output is byte-identical: the cache is pure
    // memoization of deterministic coordinates, so a miss just re-decodes.
    let mut fallback_cache = FxHashMap::default();
    let mut slot_guard = ctx.worker_point_caches[widx].try_lock().ok();
    let worker_point_cache: &mut FxHashMap<u32, (f64, f64, f64)> = match slot_guard.as_deref_mut() {
        Some(cache) => cache,
        None => &mut fallback_cache,
    };
    // Placement-transform slot: the SAME `try_lock` (not `lock`) discipline as
    // the point cache above (#1587). On a re-entrant steal we fall back to a
    // throwaway cache; output stays byte-identical since the cache is pure
    // memoization of a deterministic composition.
    let mut fallback_placement_cache = FxHashMap::default();
    let mut placement_slot_guard = ctx.worker_placement_caches[widx].try_lock().ok();
    let worker_placement_cache: &mut FxHashMap<u32, [f64; 16]> =
        match placement_slot_guard.as_deref_mut() {
            Some(cache) => cache,
            None => &mut fallback_placement_cache,
        };
    mesh_job(job, ctx, worker_point_cache, worker_placement_cache)
}

/// The per-job router: a fresh one at the pass scale, armed with the model-wide
/// caches (content dedup #1109, brep signatures, IfcMappedItem sources #1623)
/// and, when enabled, the #1623 Phase 2 don't-bake plan.
fn job_router(ctx: &PassContext<'_>) -> GeometryRouter {
    let mut local_router = GeometryRouter::from_config(RouterConfig {
        unit_scale: ctx.unit_scale,
        tessellation_quality: ctx.quality,
        rtc_offset: ctx.rtc_offset,
        ..RouterConfig::default()
    });
    if let Some(layers) = &ctx.material_layers {
        local_router.set_material_layer_index(std::sync::Arc::clone(layers));
    }
    local_router.enable_content_dedup_shared(ctx.item_dedup_cache.clone());
    local_router.enable_shared_brep_signature_cache(ctx.brep_signature_cache.clone());
    local_router.enable_shared_mapped_item_cache(ctx.mapped_item_cache.clone());
    // #1623 Phase 2: arm the don't-bake plan so single-solid occurrences of a repeated
    // mapped source emit instance placeholders instead of full meshes.
    if let Some(plan) = ctx.instancing_plan.as_ref() {
        local_router.enable_output_instancing(plan.clone());
        // #858: exclude indexed-colour sources from don't-bake so their per-triangle
        // palette survives the flat split (only meaningful with the plan armed).
        if let Some(ids) = ctx.indexed_colour_split_ids.as_ref() {
            local_router.enable_indexed_colour_split_guard(ids.clone());
        }
    }
    local_router
}

fn mesh_job(
    job: &EntityJob,
    ctx: &PassContext<'_>,
    worker_point_cache: &mut FxHashMap<u32, (f64, f64, f64)>,
    worker_placement_cache: &mut FxHashMap<u32, [f64; 16]>,
) -> Vec<MeshData> {
    if ctx.skipped_entity_ids.contains(&job.id) {
        return Vec::new();
    }

    let mut local_decoder = ctx.entity_index.decoder(ctx.content).with_strict_reals(); // #7678
    // Adopt this worker's persistent point cache so faceted-brep polyloop points
    // shared across elements are served from memory instead of re-parsed per element.
    local_decoder.set_point_cache(std::mem::take(worker_point_cache));
    // Adopt this worker's persistent placement-transform cache so a placement
    // chain shared across elements (storey/building) is composed once per worker
    // instead of re-resolved per element.
    local_decoder.set_placement_transform_cache(std::mem::take(worker_placement_cache));
    // Seed the unit-scale caches so curve/arc processing skips the O(file)
    // IFCPROJECT scan that each fresh per-element decoder would otherwise repeat.
    local_decoder.seed_unit_scales(ctx.unit_scale, ctx.seed_plane_angle_to_radians);
    // From here the decoder is owned by the guard, which writes its (warmer)
    // point + placement caches back into the worker slots on Drop, so the early
    // return below, and any panic, still hand the caches to the worker's next element.
    let mut decoder = WorkerCacheGuard {
        decoder: local_decoder,
        slot: worker_point_cache,
        placement_slot: worker_placement_cache,
    };

    let entity = match decoder.decode_at(job.start, job.end) {
        Ok(entity) => entity,
        Err(_) => {
            ctx.diag.note_refused_input(&decoder);
            return Vec::new();
        }
    };

    let local_router = job_router(ctx);
    let metadata = crate::element::ElementMeshMetadata {
        global_id: job.global_id.clone(),
        name: job.name.clone(),
        presentation_layer: job.presentation_layer.clone(),
        space_zone_properties: job.space_zone_properties.clone(),
    };
    // #957: the scan loop plans type geometry with `SuppressInstanced` (see
    // `plan_type_geometry`), so a synthetic job's map always renders as an
    // orphan: geometry_class 1.
    let kind = match job.representation_map_id {
        Some(rep_map_id) => crate::element::ElementJobKind::TypeProduct {
            rep_maps: vec![(rep_map_id, 1)],
        },
        None => crate::element::ElementJobKind::Product,
    };
    // Per-part faceted-brep phase timing (observability only; Instant traps on
    // wasm32), attributed by `note_point_cache` to parts that touched the point
    // cache (i.e. faceted breps).
    #[cfg(all(feature = "observability", not(target_arch = "wasm32")))]
    let brep_timer = std::time::Instant::now();

    let produced = crate::element::produce_element_meshes_owned(
        &crate::element::ElementMeshJob {
            id: job.id,
            ifc_type: job.ifc_type.clone(),
            entity: &entity,
            kind,
            element_color: Some(job.element_color),
            metadata: Some(&metadata),
        },
        ctx.run.context(),
        // Geometry hashing is a viewer diff feature: off on the native path.
        &crate::element::MeshProductionOptions::default(),
        // Deref-coerces &mut WorkerCacheGuard -> &mut EntityDecoder.
        &mut decoder,
        &local_router,
    );
    // The run never invalidates its own model; it refuses only if a callback
    // replaced the decoder or held an owner. Then it publishes nothing.
    let Ok(produced) = produced else {
        return super::run_snapshot::refused_by_context();
    };

    // The warm cache is moved back to the worker by `WorkerCacheGuard::drop`, on
    // every exit path.
    ctx.diag
        .drain_job(job.id, &local_router, &decoder, &produced);

    ctx.diag.note_point_cache(
        job.id,
        decoder.point_cache_stats(),
        #[cfg(all(feature = "observability", not(target_arch = "wasm32")))]
        brep_timer,
    );
    ctx.diag
        .absorb_produced(produced.degenerate_triangles_dropped, produced.csg_failures);
    ctx.diag.drain_router(&local_router);

    // #1623 Phase 2: hand this element's don't-bake occurrences to the shared
    // collector (resolved into InstanceRecords later; empty on the flat path).
    if !produced.instance_occurrences.is_empty() {
        if let Ok(mut acc) = ctx.raw_instance_collector.lock() {
            acc.extend(produced.instance_occurrences);
        }
    }

    produced.meshes
}

pub(super) fn build_color_updates_for_jobs(
    jobs: &[EntityJob],
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    content: &[u8],
    entity_index: &ProcessingIndex,
    refused: &mut Vec<u32>,
) -> Vec<(u32, [f32; 4])> {
    let mut decoder = entity_index.decoder(content).with_strict_reals();
    let mut updates: Vec<(u32, [f32; 4])> = Vec::new();

    for job in jobs {
        // #957: synthetic type-only-geometry jobs resolve their colour from the
        // RepresentationMap (a type has no IfcProductDefinitionShape), so the
        // product-definition path below never corrects them. Backfill them here
        // or a deferred IfcStyledItem (fast_first_batch) leaves the orphan type
        // geometry stuck at its fallback colour.
        if let Some(rep_map_id) = job.representation_map_id {
            if let Some(color) = crate::element::resolve_color_for_representation_map(
                rep_map_id,
                geometry_styles,
                &mut decoder,
            ) {
                if color != job.element_color {
                    updates.push((job.id, color));
                }
            }
            continue;
        }
        let Ok(entity) = decoder.decode_at(job.start, job.end) else {
            continue;
        };
        let Some(product_definition_shape_id) = entity.get_ref(6) else {
            continue;
        };
        let Some(color) = resolve_element_color_for_product_definition_shape(
            product_definition_shape_id,
            geometry_styles,
            &mut decoder,
        ) else {
            continue;
        };
        if color != job.element_color {
            updates.push((job.id, color));
        }
    }
    refused.extend(decoder.refused_record_ids()); // counted once, in `refused_prepass_records`
    updates
}
