// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The geometry pass: chunk the jobs, fill in their metadata, mesh them in
//! parallel, hand each chunk to the sink.
//!
//! [`PassContext`] is everything a job reads (the shared maps and caches) and
//! writes (the diagnostic collectors); [`super::jobs::run_job`] takes it by
//! reference. [`run`] owns the order of the side effects: the cancel check
//! before every chunk, the metadata step, `on_finishes` (when asked for),
//! `on_batch`, mesh retention and the one-time replay of deferred styles as
//! `on_color_update`.

use super::diagnostics::DiagnosticCollectors;
use super::entity_index::ProcessingIndex;
use super::job::{AppearanceResolver, EntityJob};
use super::jobs::{
    new_worker_placement_caches, new_worker_point_caches, run_job, WorkerPlacementCaches,
    WorkerPointCaches,
};
use super::pass_metadata::{populate_metadata, replay_deferred_styles};
use super::phase_marks::{mark, Clock, Mark};
use super::resolve::{Facts, Resolved};
use super::run_snapshot::{self, RunSnapshot};
use super::{ProcessingRequest, ProcessingSink};
use crate::mesh_frame::MeshCoordinateSpace;
use crate::style::{GeometryStyleInfo, ModelFinishes};
use crate::types::mesh::{MeshData, RawInstanceOccurrence};
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, TessellationQuality};
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

/// What every job of one pass reads, and the sinks every job writes.
pub(super) struct PassContext<'c> {
    pub(super) content: &'c [u8],
    pub(super) entity_index: ProcessingIndex,
    pub(super) unit_scale: f64,
    pub(super) rtc_offset: (f64, f64, f64),
    /// Resolved once on the warm shared decoder and seeded into every
    /// per-element decoder, which is cold-cached: without it every arc-bearing
    /// element would re-pay an O(file) IFCPROJECT scan.
    pub(super) seed_plane_angle_to_radians: f64,
    pub(super) quality: TessellationQuality,
    pub(super) material_layers: Option<Arc<ifc_lite_geometry::MaterialLayerIndex>>,
    pub(super) skipped_entity_ids: HashSet<u32>,
    /// Swapped once, after the first batch, when styles were deferred.
    pub(super) geometry_style_index: Arc<FxHashMap<u32, GeometryStyleInfo>>,
    /// One owned model snapshot shared by every job, re-taken on style replay.
    pub(super) run: RunSnapshot,
    pub(super) diag: DiagnosticCollectors,
    /// Model-wide content-dedup cache: every per-job router dedups against it, so
    /// byte-identical geometry the exporter failed to share via IfcMappedItem
    /// (Tekla parts) is meshed once across the pool. Held only for a hash
    /// get/insert; meshing runs outside the lock.
    pub(super) item_dedup_cache: ifc_lite_geometry::ItemDedupCache,
    pub(super) brep_signature_cache: ifc_lite_geometry::SharedBrepSignatureCache,
    /// Shared IfcMappedItem source cache (#1623): each RepresentationMap source is
    /// meshed once, not once per owning element.
    pub(super) mapped_item_cache: ifc_lite_geometry::SharedMappedItemCache,
    /// #1623 Phase 2 don't-bake plan (`Some` only when enabled).
    pub(super) instancing_plan: Option<ifc_lite_geometry::MappedInstancePlan>,
    /// #858 don't-bake exclusion: geometry ids carrying a MULTI-COLOUR
    /// IfcIndexedColourMap, so those occurrences route to flat.
    pub(super) indexed_colour_split_ids: Option<Arc<FxHashSet<u32>>>,
    /// The don't-bake occurrences of every chunk/thread; resolved into
    /// `InstanceRecord`s against the retained template meshes after the pass.
    pub(super) raw_instance_collector: std::sync::Mutex<Vec<RawInstanceOccurrence>>,
    /// One slot per rayon worker, indexed by thread index (see `jobs.rs`).
    pub(super) worker_point_caches: WorkerPointCaches,
    pub(super) worker_placement_caches: WorkerPlacementCaches,
}

/// What the geometry pass leaves for the finalise step.
pub(super) struct Passed<'c> {
    pub(super) facts: Facts,
    pub(super) decoder: EntityDecoder<'c>,
    pub(super) ctx: PassContext<'c>,
    pub(super) meshes: Vec<MeshData>,
    pub(super) total_jobs: usize,
    pub(super) total_meshes: usize,
    pub(super) total_vertices: usize,
    pub(super) total_triangles: usize,
    pub(super) deferred_style_refusals: Vec<u32>,
    pub(super) geometry_time: Duration,
    pub(super) geometry_span: tracing::Span,
    /// Inputs the pass is done with. Held to the end of the pipeline so that
    /// freeing them stays outside the timed phases, as it always was.
    pub(super) spent: Spent,
}

pub(super) struct Spent {
    _jobs: Vec<EntityJob>,
    _indexed_colour_index: FxHashMap<u32, [f32; 4]>,
    _deferred_styled_item_positions: Vec<(usize, usize)>,
    _appearance: AppearanceResolver,
}

impl<'c> PassContext<'c> {
    /// Built after `GeometryStart`: decoding the texture index is part of the pass.
    fn new(
        content: &'c [u8],
        req: &ProcessingRequest,
        facts: &Facts,
        decoder: &mut EntityDecoder<'c>,
        resolved: ResolvedInputs,
        sink: &mut dyn ProcessingSink,
    ) -> Self {
        let ResolvedInputs {
            entity_index,
            geometry_style_index,
            indexed_colour_full,
            element_material_colors,
            void_index,
            skipped_entity_ids,
            mapped_item_plan,
        } = resolved;
        let coord_space = facts.frame.coordinate_space();
        let unit_scale = facts.router.unit_scale();
        let rtc_offset = facts.router.rtc_offset();
        // #961: decode surface textures (IfcBlobTexture PNG / IfcPixelTexture) and
        // their per-triangle UV maps once, keyed by face-set id. `build_texture_index`
        // bails out on a cheap substring check for the (vast majority) untextured
        // files. Consumed by the type-only render path.
        let texture_index = ifc_lite_geometry::build_texture_index(content, decoder);
        let diag = DiagnosticCollectors::new(sink.product_geometry_audit());

        // #1623 Phase 2 don't-bake plan (Some only when enabled): filter to repeated
        // sources (count >= 2), as singletons materialize normally. Requires
        // `retain_meshes` (the template MeshData must survive in `meshes` for the
        // finalize to place instances onto it).
        //
        // NOT armed for the `site_local` coordinate tier (IfcSite has a non-identity
        // placement). The #1623 don't-bake plan replaces an occurrence's geometry
        // with a placeholder that only the renderer's own instancing can draw.
        // Arming it there would strand every occurrence in single-threaded finalize
        // orphan-recovery (a perf REGRESSION on a translated site) and MISPLACE
        // geometry on a rotated site (orphan flats baked in the world frame while
        // siblings sit in the site-local frame). Route the whole model to flat:
        // correct, and no slower than plain flat. Lifting this gate needs the
        // renderer to instance in the site frame too, verified in a browser; #4118
        // part B deliberately does not touch it.
        let instancing_plan: Option<ifc_lite_geometry::MappedInstancePlan> =
            (req.instancing && req.retain_meshes && coord_space != MeshCoordinateSpace::SiteLocal)
                .then(|| {
                    Arc::new(
                        mapped_item_plan
                            .into_iter()
                            .filter(|(_, (count, _))| *count >= 2)
                            .collect::<FxHashMap<u32, (u32, u32)>>(),
                    )
                });
        // #858 don't-bake exclusion, built only when the plan is armed; the
        // derivation (and why uniform maps are left out, #1807) lives in
        // `style::indexed_colour_split_guard_ids`, which the browser batch arms
        // from too (EDGE-WASM-5).
        let indexed_colour_split_ids = instancing_plan
            .is_some()
            .then(|| crate::style::indexed_colour_split_guard_ids(&indexed_colour_full))
            .flatten();
        let geometry_style_index = Arc::new(geometry_style_index);
        let run = RunSnapshot::new(crate::element::OwnedMeshProductionData {
            void_index: Arc::new(void_index),
            geometry_style_index: Arc::clone(&geometry_style_index),
            indexed_colour_full: Arc::new(indexed_colour_full),
            element_material_colors: Arc::new(element_material_colors),
            texture_index: Arc::new(texture_index),
            site_local_rotation: run_snapshot::site_rotation(facts.frame),
        });
        Self {
            content,
            entity_index,
            unit_scale,
            rtc_offset,
            seed_plane_angle_to_radians: facts.unit_scales.plane_angle_to_radians,
            quality: req.quality,
            material_layers: facts.material_layers.clone(),
            skipped_entity_ids,
            geometry_style_index,
            run,
            diag,
            item_dedup_cache: GeometryRouter::new_dedup_cache(),
            brep_signature_cache: GeometryRouter::new_brep_signature_cache(),
            mapped_item_cache: GeometryRouter::new_mapped_item_cache(),
            instancing_plan,
            indexed_colour_split_ids,
            raw_instance_collector: std::sync::Mutex::new(Vec::new()),
            worker_point_caches: new_worker_point_caches(),
            // Sized identically to `worker_point_caches`: memoizes each worker's
            // resolved placement world transforms across the whole model.
            worker_placement_caches: new_worker_placement_caches(),
        }
    }
}

/// The maps of [`Resolved`] the context takes over.
struct ResolvedInputs {
    entity_index: ProcessingIndex,
    geometry_style_index: FxHashMap<u32, GeometryStyleInfo>,
    indexed_colour_full: FxHashMap<u32, crate::style::FullIndexedColourMap>,
    element_material_colors: FxHashMap<u32, Vec<[f32; 4]>>,
    void_index: FxHashMap<u32, Vec<u32>>,
    skipped_entity_ids: HashSet<u32>,
    mapped_item_plan: FxHashMap<u32, (u32, u32)>,
}

/// Cooperative cancellation between chunks: the caller flipped the flag (e.g.
/// its client disconnected), so stop meshing and emitting. The result is
/// partial by contract; see `ProcessingRequest::cancel`.
fn cancelled(req: &ProcessingRequest) -> bool {
    req.cancel
        .as_ref()
        .is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed))
}

/// `on_finishes` for the batch about to be emitted, one entry per mesh.
fn emit_finishes(sink: &mut dyn ProcessingSink, finishes: &mut ModelFinishes<'_>, meshes: &[MeshData]) {
    let batch: Vec<_> = meshes.iter().map(|mesh| finishes.finish_for_mesh(mesh)).collect();
    sink.on_finishes(&batch);
}

pub(super) fn run<'c>(
    content: &'c [u8],
    req: &ProcessingRequest,
    sink: &mut dyn ProcessingSink,
    resolved: Resolved<'c>,
) -> Passed<'c> {
    let Resolved {
        facts,
        mut decoder,
        entity_index,
        mut entity_jobs,
        defer_style_updates,
        geometry_style_index,
        indexed_colour_index,
        indexed_colour_full,
        element_material_colors,
        deferred_styled_item_positions,
        void_index,
        skipped_entity_ids,
        presentation_layer_by_assigned_id,
        mapped_item_plan,
    } = resolved;

    let geometry_start = mark(Mark::GeometryStart, Clock::now());
    // Material chain joined by the shared resolver (#407). The general-path
    // element fallback is `style::element_material_fallback_color`, the rule
    // the browser style wire carries too (PROCESSING-4); the full list feeds
    // the opening sub-mesh transparent/opaque split (#913 §2.3).
    let element_material_color: FxHashMap<u32, [f32; 4]> = element_material_colors
        .iter()
        .filter_map(|(&id, colors)| {
            crate::style::element_material_fallback_color(colors).map(|c| (id, c))
        })
        .collect();
    let mut ctx = PassContext::new(
        content,
        req,
        &facts,
        &mut decoder,
        ResolvedInputs {
            entity_index,
            geometry_style_index,
            indexed_colour_full,
            element_material_colors,
            void_index,
            skipped_entity_ids,
            mapped_item_plan,
        },
        sink,
    );
    // #8341 C4-13a: the finish join over this pass's scan and index, so a
    // consumer that wants finishes need not read the file a second time.
    let mut finishes = req.features.finishes.then(|| {
        ModelFinishes::from_spans(&facts.prepass_spans.styled_items, ctx.entity_index.decoder(content))
    });
    let mut appearance = AppearanceResolver::new(
        element_material_color,
        presentation_layer_by_assigned_id,
        req.features.presentation_layers,
    );

    let total_jobs = entity_jobs.len();
    let initial_chunk_size = req.batching.initial.max(1);
    let throughput_chunk_size = req.batching.throughput.max(initial_chunk_size);
    let mut meshes: Vec<MeshData> = Vec::new();
    let mut processed_jobs = 0usize;
    let mut total_meshes = 0usize;
    let mut total_vertices = 0usize;
    let mut total_triangles = 0usize;
    let mut chunk_start = 0usize;
    let mut current_chunk_size = initial_chunk_size;
    let mut deferred_styles_applied = !defer_style_updates;
    let mut deferred_style_refusals: Vec<u32> = Vec::new();

    let geometry_span = tracing::info_span!(target: "ifc_lite_processing::processor",
        "geometry",
        element_count = total_jobs,
        mesh_count = tracing::field::Empty,
        triangle_count = tracing::field::Empty,
        backstop_count = tracing::field::Empty,
        total_csg_failures = tracing::field::Empty,
        phase_ms = tracing::field::Empty,
    );
    let geometry_guard = geometry_span.clone().entered();

    while chunk_start < total_jobs {
        if cancelled(req) {
            break;
        }
        let chunk_end = (chunk_start + current_chunk_size).min(total_jobs);
        let jobs_chunk = &mut entity_jobs[chunk_start..chunk_end];
        populate_metadata(jobs_chunk, &ctx, &mut appearance, &mut decoder);
        let chunk_meshes: Vec<MeshData> = super::scheduling::element_tasks(jobs_chunk)
            .map(|job| run_job(job, &ctx))
            .flatten_iter()
            .collect();

        processed_jobs += jobs_chunk.len();
        total_vertices += chunk_meshes.iter().map(|m| m.vertex_count()).sum::<usize>();
        total_triangles += chunk_meshes
            .iter()
            .map(|m| m.triangle_count())
            .sum::<usize>();

        if !chunk_meshes.is_empty() {
            total_meshes += chunk_meshes.len();
            let emit_mesh_chunk_size = current_chunk_size.max(1);
            for emitted_meshes in chunk_meshes.chunks(emit_mesh_chunk_size) {
                if let Some(finishes) = finishes.as_mut() {
                    emit_finishes(sink, finishes, emitted_meshes);
                }
                sink.on_batch(emitted_meshes, processed_jobs, total_jobs);
            }
            if req.retain_meshes {
                meshes.extend(chunk_meshes);
            }
            if !deferred_styles_applied {
                replay_deferred_styles(
                    &mut ctx,
                    sink,
                    &entity_jobs[..processed_jobs],
                    &deferred_styled_item_positions,
                    &indexed_colour_index,
                    &mut deferred_style_refusals,
                );
                deferred_styles_applied = true;
            }
        }
        chunk_start = chunk_end;
        current_chunk_size = throughput_chunk_size;
    }

    let geometry_time = mark(Mark::GeometryEnd, geometry_start.elapsed());
    drop(geometry_guard);
    Passed {
        facts,
        decoder,
        ctx,
        meshes,
        total_jobs,
        total_meshes,
        total_vertices,
        total_triangles,
        deferred_style_refusals,
        geometry_time,
        geometry_span,
        spent: Spent {
            _jobs: entity_jobs,
            _indexed_colour_index: indexed_colour_index,
            _deferred_styled_item_positions: deferred_styled_item_positions,
            _appearance: appearance,
        },
    }
}
