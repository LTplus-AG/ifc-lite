// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-entity geometry job execution.
//!
//! Split out of `processor/mod.rs` (module-size ratchet). `process_entity_job`
//! is the body of the parallel batch loop's `map_init` closure — one job = one
//! product, meshed on a fresh router with the worker's warm CartesianPoint
//! cache moved in and back out. `build_color_updates_for_jobs` backfills
//! deferred/orphan-type colours.

use super::*;

/// Per-rayon-worker CartesianPoint caches: one `FxHashMap` behind a `Mutex` per
/// worker thread, indexed by `rayon::current_thread_index()`.
pub(super) type WorkerPointCaches = Vec<std::sync::Mutex<FxHashMap<u32, (f64, f64, f64)>>>;

/// Per-rayon-worker placement-transform caches: one `FxHashMap` behind a `Mutex`
/// per worker thread, indexed by `rayon::current_thread_index()`. Mirrors
/// [`WorkerPointCaches`] exactly; the value is the opaque column-major `[f64; 16]`
/// world transform the geometry router memoizes per IfcObjectPlacement id.
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
/// it is uncontended. The cache is pure memoization of deterministic coordinates,
/// so meshes stay byte-identical (`mesh_determinism` no-diff).
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
/// remaining element in that worker's sub-range and silently defeating the hoist.
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

// Carries the full per-job processing context; factoring the args into a struct
// would not change behavior and is out of scope for the lint gate.
#[allow(clippy::too_many_arguments)]
pub(super) fn process_entity_job(
    job: &EntityJob,
    content: &[u8],
    entity_index_arc: &Arc<EntityIndex>,
    unit_scale: f64,
    rtc_offset: (f64, f64, f64),
    // Pre-resolved scales seeded into this job's decoder so arc tessellation and
    // unit conversion never trigger a per-element full-file IFCPROJECT scan.
    seed_plane_angle_to_radians: f64,
    tessellation_quality: TessellationQuality,
    void_index: &FxHashMap<u32, Vec<u32>>,
    skipped_entity_ids: &HashSet<u32>,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
    indexed_colour_full: &FxHashMap<u32, crate::style::FullIndexedColourMap>,
    element_material_colors: &FxHashMap<u32, Vec<[f32; 4]>>,
    // Surface textures + UV maps keyed by face-set id (#961). Empty for
    // untextured models.
    texture_index: &FxHashMap<u32, ifc_lite_geometry::ResolvedTextureMap>,
    // Present only when the selected coordinate space is `site_local`; rotates
    // mesh vertices into the site's axis frame.
    site_local_rotation: Option<&Vec<f64>>,
    // Shared sink for per-job router CSG diagnostics (parity with the wasm
    // path's `drain_and_log_csg_diagnostics`).
    csg_failure_collector: &std::sync::Mutex<FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>>,
    // Shared sinks for opening classification + per-host opening diagnostics, drained
    // from this job's router so the native pass aggregates the full GeometryDiagnostics.
    classification_collector: &std::sync::Mutex<ifc_lite_geometry::ClassificationStats>,
    host_diag_collector: &std::sync::Mutex<FxHashMap<u32, ifc_lite_geometry::HostOpeningDiagnostic>>,
    rect_fast_collector: &std::sync::Mutex<ifc_lite_geometry::RectFastStats>,
    // Shared tally of degenerate-backstop triangle drops (see
    // `element::build_mesh_data`); relaxed atomic, added to only when non-zero.
    backstop_collector: &std::sync::atomic::AtomicU64,
    // Model-wide content-dedup cache shared by every per-job router so identical
    // geometry is meshed once across the rayon pool (#1109 follow-up).
    item_dedup_cache: &ifc_lite_geometry::ItemDedupCache,
    // Model-wide IfcMappedItem source cache shared by every per-job router so a
    // RepresentationMap source shared across owning elements is meshed once
    // model-wide instead of once per element (a fresh router is built per element,
    // so its RefCell cache only dedups within one element) — #1623.
    mapped_item_cache: &ifc_lite_geometry::SharedMappedItemCache,
    // #1623 Phase 2: don't-bake plan (Some only when enabled) armed on this job's
    // router, + the shared sink for its emitted don't-bake occurrences.
    instancing_plan: Option<&ifc_lite_geometry::MappedInstancePlan>,
    // #858: geometry ids of mapped sources carrying an IfcIndexedColourMap (Some only
    // when the plan is armed AND the model has indexed-colour maps). Armed on this
    // job's router so such a source materializes flat (per-palette split) instead of
    // don't-bake, keeping its per-triangle palette.
    indexed_colour_split_ids: Option<&std::sync::Arc<rustc_hash::FxHashSet<u32>>>,
    raw_instance_collector: &std::sync::Mutex<Vec<crate::RawInstanceOccurrence>>,
    // The current rayon worker's PERSISTENT CartesianPoint cache, reused across
    // every element that worker meshes for the whole model (see the
    // `worker_point_caches` store at the call site). Moved into this job's decoder
    // and moved back out afterwards so a shared point list is parsed once per worker
    // for the entire pass, not once per chunk or once per part.
    worker_point_cache: &mut FxHashMap<u32, (f64, f64, f64)>,
    // The current rayon worker's PERSISTENT placement-transform cache, reused
    // across every element that worker meshes for the whole model (see the
    // `worker_placement_caches` store at the call site). Moved into this job's
    // decoder and moved back out afterwards so a placement chain shared by many
    // elements (storey/building) is composed once per worker, not once per element.
    worker_placement_cache: &mut FxHashMap<u32, [f64; 16]>,
    // Request-local point-cache hit/miss + faceted-brep-timing sinks (see the
    // collectors declared before the chunk loop).
    point_cache_hits_collector: &std::sync::atomic::AtomicU64,
    point_cache_misses_collector: &std::sync::atomic::AtomicU64,
    faceted_brep_ns_collector: &std::sync::atomic::AtomicU64,
) -> Vec<MeshData> {
    if skipped_entity_ids.contains(&job.id) {
        return Vec::new();
    }

    let mut local_decoder = EntityDecoder::with_arc_index(content, entity_index_arc.clone());
    // Adopt this worker's persistent point cache so faceted-brep polyloop points
    // shared across elements are served from memory instead of re-parsed per element.
    local_decoder.set_point_cache(std::mem::take(worker_point_cache));
    // Adopt this worker's persistent placement-transform cache so a placement
    // chain shared across elements (storey/building) is composed once per worker
    // instead of re-resolved per element.
    local_decoder.set_placement_transform_cache(std::mem::take(worker_placement_cache));
    // Seed the unit-scale caches so curve/arc processing skips the O(file)
    // IFCPROJECT scan that each fresh per-element decoder would otherwise repeat.
    local_decoder.seed_unit_scales(unit_scale, seed_plane_angle_to_radians);
    // From here the decoder is owned by the guard, which writes its (warmer)
    // point + placement caches back into the worker slots on Drop — so the early
    // return below, and any panic, still hand the caches to the worker's next element.
    let mut decoder = WorkerCacheGuard {
        decoder: local_decoder,
        slot: worker_point_cache,
        placement_slot: worker_placement_cache,
    };

    let entity = match decoder.decode_at(job.start, job.end) {
        Ok(entity) => entity,
        Err(_) => return Vec::new(),
    };

    let mut local_router = GeometryRouter::with_scale_and_quality(unit_scale, tessellation_quality);
    local_router.set_rtc_offset(rtc_offset);
    local_router.enable_content_dedup_shared(item_dedup_cache.clone());
    local_router.enable_shared_mapped_item_cache(mapped_item_cache.clone());
    // #1623 Phase 2: arm the don't-bake plan so single-solid occurrences of a repeated
    // mapped source emit instance placeholders instead of full meshes.
    if let Some(plan) = instancing_plan {
        local_router.enable_output_instancing(plan.clone());
        // #858: exclude indexed-colour sources from don't-bake so their per-triangle
        // palette survives the flat split (only meaningful with the plan armed).
        if let Some(ids) = indexed_colour_split_ids {
            local_router.enable_indexed_colour_split_guard(ids.clone());
        }
    }
    let local_router = local_router;

    let metadata = crate::element::ElementMeshMetadata {
        global_id: job.global_id.clone(),
        name: job.name.clone(),
        presentation_layer: job.presentation_layer.clone(),
        space_zone_properties: job.space_zone_properties.clone(),
    };
    // #957: the scan loop plans type geometry with `SuppressInstanced` (see
    // `plan_type_geometry`), so a synthetic job's map always renders as an
    // orphan — geometry_class 1.
    let kind = match job.representation_map_id {
        Some(rep_map_id) => crate::element::ElementJobKind::TypeProduct {
            rep_maps: vec![(rep_map_id, 1)],
        },
        None => crate::element::ElementJobKind::Product,
    };
    let ctx = crate::element::MeshProductionContext {
        void_index,
        geometry_style_index,
        indexed_colour_full,
        element_material_colors,
        texture_index,
        site_local_rotation,
    };

    // Per-part faceted-brep phase timing (observability only; Instant traps on
    // wasm32). Attributed below to `faceted_brep_ns_collector` for parts that
    // actually touched the point cache (i.e. faceted breps), mirroring the
    // diag.rs feature-off byte-identity policy.
    #[cfg(all(feature = "observability", not(target_arch = "wasm32")))]
    let brep_timer = std::time::Instant::now();

    let produced = crate::element::produce_element_meshes(
        &crate::element::ElementMeshJob {
            id: job.id,
            ifc_type: job.ifc_type,
            entity: &entity,
            kind,
            element_color: Some(job.element_color),
            metadata: Some(&metadata),
        },
        &ctx,
        // Geometry hashing is a viewer diff feature — off on the native path.
        &crate::element::MeshProductionOptions::default(),
        // Deref-coerces &mut WorkerCacheGuard -> &mut EntityDecoder.
        &mut decoder,
        &local_router,
    );

    // Fold this element's point-cache activity into the pass tallies. The warm
    // cache is moved back to the worker by `WorkerCacheGuard::drop`, on every
    // exit path. `hits + misses > 0` means this element was a faceted brep that
    // walked polyloops.
    let (part_hits, part_misses) = decoder.point_cache_stats();
    if part_hits + part_misses > 0 {
        use std::sync::atomic::Ordering::Relaxed;
        point_cache_hits_collector.fetch_add(part_hits, Relaxed);
        point_cache_misses_collector.fetch_add(part_misses, Relaxed);
        // Faceted-brep wall time is measured only under `observability` (Instant
        // traps on wasm32); the timer/log block compiles out entirely with the
        // feature off, so default builds stay byte-identical. Adding a 0 ns delta
        // in that case keeps `faceted_brep_ns_collector` always-used.
        #[cfg(all(feature = "observability", not(target_arch = "wasm32")))]
        {
            let elapsed_ns = brep_timer.elapsed().as_nanos() as u64;
            faceted_brep_ns_collector.fetch_add(elapsed_ns, Relaxed);
            // Under `observability` this is what the geometry crate's `diag_debug!`
            // expands to (`tracing::debug!`).
            tracing::debug!(
                element_id = job.id,
                point_cache_hits = part_hits,
                point_cache_misses = part_misses,
                faceted_brep_us = elapsed_ns / 1000,
                "faceted-brep part meshed"
            );
        }
        #[cfg(not(all(feature = "observability", not(target_arch = "wasm32"))))]
        faceted_brep_ns_collector.fetch_add(0, Relaxed);
    }

    // Fold this element's degenerate-backstop drops into the pass tally.
    if produced.degenerate_triangles_dropped > 0 {
        backstop_collector.fetch_add(
            produced.degenerate_triangles_dropped,
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    // Surface this element's CSG diagnostics in the shared collector. The
    // wasm path logs them in the browser console; without this the server
    // would silently discard every failed opening cut.
    if !produced.csg_failures.is_empty() {
        if let Ok(mut collector) = csg_failure_collector.lock() {
            for (product_id, fails) in produced.csg_failures {
                collector.entry(product_id).or_default().extend(fails);
            }
        }
    }

    // Drain this job's router opening diagnostics (classification counts +
    // per-host detail) and merge them. Each job uses a FRESH router that
    // processed exactly this one element, so the drained values are this
    // element's only — summing across jobs mirrors the wasm batch router's
    // accumulate-then-drain, giving the same GeometryDiagnostics counts.
    let cls = local_router.take_classification_stats();
    if cls.rectangular != 0 || cls.diagonal != 0 || cls.non_rectangular != 0 {
        if let Ok(mut acc) = classification_collector.lock() {
            acc.rectangular += cls.rectangular;
            acc.diagonal += cls.diagonal;
            acc.non_rectangular += cls.non_rectangular;
        }
    }
    let host_diags = local_router.take_host_opening_diagnostics();
    if !host_diags.is_empty() {
        if let Ok(mut acc) = host_diag_collector.lock() {
            // Product ids are disjoint across jobs (one product = one job), so this
            // is an insert; `extend` is robust if that ever changes.
            acc.extend(host_diags);
        }
    }
    // Drain this job's router rect_fast counters into the request-local collector
    // (process-global counters are gone — see GeometryRouter::record_rect_fast).
    let rf = local_router.take_rect_fast_stats();
    if rf.fired != 0
        || rf.openings_cut != 0
        || rf.defer_host_not_box != 0
        || rf.defer_not_through != 0
        || rf.defer_off_face != 0
        || rf.defer_near_edge != 0
        || rf.defer_no_openings != 0
    {
        if let Ok(mut acc) = rect_fast_collector.lock() {
            acc.fired += rf.fired;
            acc.openings_cut += rf.openings_cut;
            acc.defer_host_not_box += rf.defer_host_not_box;
            acc.defer_not_through += rf.defer_not_through;
            acc.defer_off_face += rf.defer_off_face;
            acc.defer_near_edge += rf.defer_near_edge;
            acc.defer_no_openings += rf.defer_no_openings;
        }
    }

    // #1623 Phase 2: hand this element's don't-bake occurrences to the shared
    // collector (resolved into InstanceRecords later; empty on the flat path).
    if !produced.instance_occurrences.is_empty() {
        if let Ok(mut acc) = raw_instance_collector.lock() {
            acc.extend(produced.instance_occurrences);
        }
    }

    produced.meshes
}

pub(super) fn build_color_updates_for_jobs(
    jobs: &[EntityJob],
    geometry_styles: &FxHashMap<u32, GeometryStyleInfo>,
    content: &[u8],
    entity_index: &Arc<EntityIndex>,
) -> Vec<(u32, [f32; 4])> {
    let mut decoder = EntityDecoder::with_arc_index(content, entity_index.clone());
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

    updates
}
