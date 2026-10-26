// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC processing service with parallel geometry extraction.
//!
//! Originally contributed by Mathias Søndergaard (Sonderwoods/Linkajou).

use crate::types::mesh::{InstanceRecord, MeshData, RawInstanceOccurrence};
use crate::types::response::{CoordinateInfo, ModelMetadata, ProcessingStats};
use ifc_lite_core::{EntityDecoder, EntityIndex, IfcType};
use ifc_lite_geometry::TessellationQuality;
use ifc_lite_geometry::GeometryRouter;
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

mod color_layer;
mod csg_summary;
#[cfg(test)]
#[path = "csg_summary_tests.rs"]
mod csg_summary_tests;
mod diagnostics;
mod entity_index;
use entity_index::{IndexBuilder, ProcessingIndex};
pub(crate) mod entry_points;
#[allow(deprecated)] // the deprecated delegates stay exported until the next major
pub use entry_points::{
    process_geometry, process_geometry_filtered, process_geometry_filtered_with_quality,
    process_geometry_filtered_with_quality_and_ids, process_geometry_streaming,
    process_geometry_streaming_filtered, process_geometry_streaming_filtered_with_baked_basis,
    process_geometry_streaming_filtered_with_options, process_geometry_streaming_with_options,
    process_geometry_streaming_with_options_and_bootstrap, process_geometry_with_index,
};
mod request;
pub use request::{Batching, Features, ProcessingRequest};
mod sink;
#[doc(hidden)]
pub use sink::ClosureSink;
pub use sink::{FrameEvent, OnBatch, ProcessingSink};
pub(crate) mod instancing;
mod jobs;
mod run_snapshot;
mod opening_filter;
mod phase_marks;
use phase_marks::{mark, Mark};
mod properties;
mod quick_collector;
mod scan;
mod quick_metadata;
mod schema_detection;
mod scheduling;
mod site_local;

pub use quick_metadata::is_quick_spatial_type_ci;
pub use schema_detection::detect_schema_version;
pub use site_local::{convert_mesh_to_site_local, native_to_baked};
pub(crate) use site_local::site_local_rotation_invalidates_captured_transforms;

use jobs::{build_color_updates_for_jobs, process_entity_job};

pub(crate) use color_layer::resolve_element_color_for_product_definition_shape;
use color_layer::resolve_presentation_layer_for_product_definition_shape;
use opening_filter::apply_opening_filter;
use properties::resolve_space_zone_properties_lazy;
use crate::mesh_frame::{MeshCoordinateSpace, MeshFrame};

/// Wall-clock timer for diagnostic `ProcessingStats`. On wasm32
/// `std::time::Instant::now()` traps ("time not implemented on this platform"),
/// so the non-streaming `process_geometry*` entry points (used by the in-browser
/// Rust exporters via `ifc-lite-export`) would panic. Timing is purely diagnostic,
/// so on wasm32 this is a zero-duration no-op; on native it IS `std::time::Instant`
/// (identical behaviour, no overhead).
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant as Clock;

#[cfg(target_arch = "wasm32")]
#[derive(Clone, Copy)]
struct Clock;

#[cfg(target_arch = "wasm32")]
impl Clock {
    #[inline]
    fn now() -> Self {
        Clock
    }
    #[inline]
    fn elapsed(&self) -> std::time::Duration {
        std::time::Duration::ZERO
    }
}

/// Controls how IfcWindow / IfcDoor openings are exported.
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpeningFilterMode {
    /// Export all openings and cut their voids in host walls (default behaviour).
    #[default]
    Default = 0,
    /// Skip all IfcWindow / IfcDoor meshes and do not cut any voids.
    IgnoreAll = 1,
    /// Skip only opaque (non-glazed) windows and doors; glazed ones are kept.
    IgnoreOpaque = 2,
}

impl OpeningFilterMode {
    /// Stable string suffix for disk-cache keys. Unlike `Debug` formatting,
    /// this is guaranteed not to change across compiler versions.
    pub fn cache_key_suffix(&self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::IgnoreAll => "ignore_all",
            Self::IgnoreOpaque => "ignore_opaque",
        }
    }
}

/// Result of processing an IFC file.
pub struct ProcessingResult {
    pub meshes: Vec<MeshData>,
    /// #1623 Phase 2 don't-bake output: per-occurrence instance records emitted when
    /// `StreamingOptions.enable_instancing` is set. Each non-template occurrence of a
    /// repeated single-solid `IfcRepresentationMap` skipped its full materialize; the
    /// template MeshData stays in `meshes` (keyed by `InstanceRecord.template_express_id`)
    /// and each occurrence here places it by a template-relative transform. Always
    /// empty when instancing is off, so exporters/determinism see the flat output.
    pub instances: Vec<InstanceRecord>,
    /// The frame the mesh vertices are expressed in, as its wire tag.
    ///
    /// Always `frame.coordinate_space()`: the constructor below is the only
    /// writer of either field, and `issue_4706_symbolic_shares_the_mesh_frame`
    /// asserts they agree on a live parse.
    pub mesh_coordinate_space: MeshCoordinateSpace,
    /// The frame itself: the tag above PLUS the translation that was
    /// subtracted and the site rotation that was removed.
    ///
    /// A second consumer of the same bytes that has to land in the same frame
    /// reads it here rather than re-deriving the three-tier selection from
    /// `site_transform` and the metadata's origin shift. The server's symbolic
    /// stream is that consumer (#4706): it hands this to
    /// `extract_symbolic_data_with_provenance_in_frame`.
    pub frame: MeshFrame,
    /// IfcSite ObjectPlacement as column-major 4x4 matrix (in meters).
    pub site_transform: Option<Vec<f64>>,
    /// IfcBuilding ObjectPlacement as column-major 4x4 matrix (in meters).
    pub building_transform: Option<Vec<f64>>,
    pub metadata: ModelMetadata,
    pub stats: ProcessingStats,
}

/// Controls the tradeoff between first-frame latency and richer upfront metadata.
// Not `Copy`: `entity_index` holds an `Arc`. Every construction either moves the
// struct into a process call once or `..Default::default()`s it, so `Clone` suffices.
#[derive(Debug, Clone)]
pub struct StreamingOptions {
    /// Batch size used for the very first emitted chunk.
    pub initial_batch_size: usize,
    /// Batch size used after the first emitted chunk for higher throughput.
    pub throughput_batch_size: usize,
    /// Prioritize cheap/high-yield element classes first.
    pub fast_first_batch: bool,
    /// Include expensive property parsing on the first-frame path.
    pub include_properties: bool,
    /// Include expensive presentation-layer resolution on the first-frame path.
    pub include_presentation_layers: bool,
    /// Emit a lightweight spatial bootstrap during the scan phase.
    pub emit_quick_metadata_bootstrap: bool,
    /// Retain emitted meshes in the returned ProcessingResult.
    pub retain_emitted_meshes: bool,
    /// Tessellation detail level (#976). `Medium` reproduces the historical
    /// output byte-for-byte; consumer-selectable on the wasm path via
    /// `setTessellationQuality`, and on the server via the
    /// `tessellation_quality` query parameter. 2D symbolic extraction
    /// (`symbolic.rs`) deliberately ignores the level — symbols are
    /// resolution-independent line work.
    pub tessellation_quality: TessellationQuality,
    /// Pre-built entity index to reuse instead of scanning `content` again. A caller
    /// that runs both the geometry pass and a second pass over the same bytes (e.g. a
    /// server emitting GLB *and* extracting properties) can `build_entity_index`
    /// once and inject it here, skipping the duplicate SIMD scan. `None` builds it
    /// internally, exactly as before. The index MUST come from
    /// `build_entity_index(content)` for the *same* `content`, or decoding will read
    /// the wrong byte ranges.
    pub entity_index: Option<Arc<EntityIndex>>,
    /// Cooperative cancellation: when the flag flips true, the streaming core
    /// stops between job chunks (no further meshing or batch emission). The
    /// returned `ProcessingResult` is then PARTIAL - the caller set the flag,
    /// so it must not present the result as a completed parse. Used by the
    /// server to stop burning a core when an SSE client disconnects.
    pub cancel: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// #1623 Phase 2 "don't-bake" instancing. When `true` (AND
    /// `retain_emitted_meshes`), the geometry phase meshes each repeated single-solid
    /// `IfcRepresentationMap` ONCE (a template occurrence) and emits every OTHER
    /// occurrence as a lightweight `InstanceRecord` (placement + colour + id) instead
    /// of materializing a full world-space mesh per occurrence — killing the
    /// per-occurrence 43M-vertex bake on mapped-item-heavy models. `false` (default)
    /// reproduces the historical materialized output byte-for-byte, so determinism /
    /// parity / every exporter are unaffected (none arm this).
    pub enable_instancing: bool,
}

impl Default for StreamingOptions {
    fn default() -> Self {
        Self {
            initial_batch_size: 50,
            throughput_batch_size: 50,
            fast_first_batch: false,
            include_properties: true,
            include_presentation_layers: true,
            emit_quick_metadata_bootstrap: false,
            retain_emitted_meshes: true,
            tessellation_quality: TessellationQuality::default(),
            entity_index: None,
            cancel: None,
            enable_instancing: false,
        }
    }
}

/// Job for processing a single entity.
pub(super) struct EntityJob {
    pub(super) id: u32,
    pub(super) ifc_type: IfcType,
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) product_definition_shape_id: Option<u32>,
    pub(super) element_color: [f32; 4],
    pub(super) global_id: Option<String>,
    pub(super) name: Option<String>,
    pub(super) presentation_layer: Option<String>,
    pub(super) space_zone_properties: Option<BTreeMap<String, String>>,
    /// Set for synthetic type-only-geometry jobs (#957): the `IfcRepresentationMap`
    /// id to render directly (baking its MappingOrigin) instead of walking the
    /// element's `IfcProductDefinitionShape`. `None` for ordinary product jobs.
    pub(super) representation_map_id: Option<u32>,
}

// Only invoked on the wasm32 serial path; dead on the native build.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
// Threads the full metadata-resolution context; splitting it would not improve clarity.
#[allow(clippy::too_many_arguments)]
fn populate_entity_job_metadata(
    job: &mut EntityJob,
    geometry_style_index: &FxHashMap<u32, GeometryStyleInfo>,
    element_material_color: &FxHashMap<u32, [f32; 4]>,
    layer_by_assigned_representation: &FxHashMap<u32, String>,
    color_cache_by_product_definition_shape: &mut FxHashMap<u32, Option<[f32; 4]>>,
    layer_cache_by_product_definition_shape: &mut FxHashMap<u32, Option<String>>,
    layer_cache_by_representation: &mut FxHashMap<u32, Option<String>>,
    decoder: &mut EntityDecoder,
    include_presentation_layers: bool,
) {
    if job.global_id.is_some() || job.name.is_some() || job.product_definition_shape_id.is_some() {
        return;
    }

    let Ok(entity) = decoder.decode_at(job.start, job.end) else {
        return;
    };

    job.global_id = normalize_optional_string(entity.get_string(0));
    job.name = normalize_optional_string(entity.get_string(2));
    job.product_definition_shape_id = entity.get_ref(6);

    let Some(product_definition_shape_id) = job.product_definition_shape_id else {
        return;
    };

    let resolved_color = color_cache_by_product_definition_shape
        .entry(product_definition_shape_id)
        .or_insert_with(|| {
            resolve_element_color_for_product_definition_shape(
                product_definition_shape_id,
                geometry_style_index,
                decoder,
            )
        });
    if let Some(color) = resolved_color {
        job.element_color = *color;
    } else if let Some(color) = element_material_color.get(&job.id) {
        job.element_color = *color;
    }

    if include_presentation_layers {
        let resolved_layer = layer_cache_by_product_definition_shape
            .entry(product_definition_shape_id)
            .or_insert_with(|| {
                resolve_presentation_layer_for_product_definition_shape(
                    product_definition_shape_id,
                    layer_by_assigned_representation,
                    layer_cache_by_representation,
                    decoder,
                )
            });
        job.presentation_layer = resolved_layer.clone();
    }
}

// `GeometryStyleInfo` moved to `crate::style` — it is shared by this
// orchestrator, the canonical per-element producer (`crate::element`), and
// (via `from_color`) the browser batch path.
use crate::style::GeometryStyleInfo;

pub(super) fn normalize_optional_string(raw: Option<&str>) -> Option<String> {
    ifc_lite_core::optional_text(raw).map(str::to_owned)
}

fn geometry_priority_score(ifc_type: &IfcType) -> u8 {
    match ifc_type {
        IfcType::IfcWall | IfcType::IfcWallStandardCase => 100,
        IfcType::IfcSlab => 95,
        IfcType::IfcColumn => 90,
        IfcType::IfcBeam => 85,
        IfcType::IfcRoof => 80,
        IfcType::IfcStair | IfcType::IfcStairFlight => 75,
        IfcType::IfcCurtainWall => 70,
        IfcType::IfcFooting | IfcType::IfcPile => 65,
        IfcType::IfcDoor | IfcType::IfcWindow => 30,
        IfcType::IfcFurnishingElement => 10,
        _ => 50,
    }
}

/// The native pipeline: scan, resolve, mesh, finalise. The one body behind
/// every entry point; see [`ProcessingRequest`] for the inputs and
/// [`ProcessingSink`] for the events it raises while it runs.
pub fn process(
    content: &[u8],
    req: &ProcessingRequest,
    sink: &mut dyn ProcessingSink,
) -> ProcessingResult {
    let total_start = mark(Mark::PipelineStart, Clock::now());
    let parse_start = Clock::now();
    let entity_scan_start = Clock::now();

    // Span taxonomy for the pipeline phases. Each phase span mirrors an
    // existing ProcessingStats timer window (instrumentation only, no
    // restructuring); `phase_ms` / count fields are recorded post-hoc from the
    // measurements the pipeline already takes. Field names reuse the
    // GeometryDiagnostics vocabulary (total_csg_failures, backstop_count, ...)
    // so events and the wasm PipelineDiagnostics channel share one vocabulary.
    let pipeline_span = tracing::info_span!(
        "geometry_pipeline",
        byte_size = content.len(),
        element_count = tracing::field::Empty,
        total_ms = tracing::field::Empty,
    );
    let _pipeline_guard = pipeline_span.clone().entered();

    tracing::info!(
        content_size = content.len(),
        "Starting IFC geometry processing"
    );

    let scan_span = tracing::info_span!(
        "scan_prepass",
        total_entities = tracing::field::Empty,
        geometry_entities = tracing::field::Empty,
        phase_ms = tracing::field::Empty,
    );
    let scan_guard = scan_span.clone().entered();

    // The entity index (expressId -> byte span) is built INLINE in the scan loop
    // below rather than in a separate `build_entity_index` pass, so the file is
    // walked once instead of twice. A caller that injected an index reuses it and
    // skips the inline build. `decode_at` during the scan needs no index (it parses
    // local bytes), so the scan-phase decoder starts index-less; the completed
    // index is installed before the first ref-resolving call (`resolve_prepass`).
    let provided_index = req.entity_index.clone();
    let building_index = provided_index.is_none();
    let mut inline_index = IndexBuilder::new(content.len(), building_index);
    let mut decoder = match &provided_index { // geometry pre-pass: strict reals (#7678)
        Some(idx) => EntityDecoder::with_arc_index(content, idx.clone()).with_strict_reals(),
        None => EntityDecoder::new(content).with_strict_reals(),
    };
    tracing::debug!("Entity index will be built inline during the scan");

    let scan::ScanOutput {
        mut entity_jobs,
        prepass_spans,
        project_id,
        presentation_layer_by_assigned_id,
        rel_defines_spans,
        georeferencing_candidates,
        mapped_item_plan,
        quick,
        total_entities,
        site_entity_pos,
        building_entity_pos,
    } = scan::scan_entities(content, req, &mut decoder, &mut inline_index, building_index);

    let defer_style_updates = req.batching.fast_first
        && req.opening_filter == OpeningFilterMode::Default
        && !req.features.presentation_layers;


    // The inline index is now complete — identical to `build_entity_index` over
    // the same scanner. Install it into the decoder so `resolve_prepass` and the
    // downstream phases resolve refs against it, and expose it (as before) to the
    // geometry workers further down.
    let entity_index = match provided_index {
        Some(idx) => ProcessingIndex::hash(idx),
        None => inline_index.finish(),
    };
    entity_index.install(&mut decoder);

    // ── Shared post-scan resolution (`crate::prepass`) ──
    // Styled items (orphan vs attached, defer-aware), IfcIndexedColourMap,
    // the #407 material chain join, voids + fills, and the #845 aggregate
    // void propagation — the exact code the browser prepasses run.
    let resolved = crate::prepass::resolve_prepass(
        &prepass_spans,
        &mut decoder,
        crate::prepass::ResolveOptions {
            collect_indexed_colour_full: true,
            defer_attached_styles: defer_style_updates,
        },
    );
    let crate::prepass::ResolvedPrepass {
        mut geometry_style_index,
        indexed_colour_index,
        indexed_colour_full,
        element_material_colors,
        void_index,
        filling_by_opening,
        deferred_attached_styled_spans: deferred_styled_item_positions,
        ..
    } = resolved;

    let entity_scan_time = mark(Mark::EntityScanEnd, entity_scan_start.elapsed());
    scan_span.record("total_entities", total_entities as u64);
    scan_span.record("geometry_entities", entity_jobs.len() as u64);
    scan_span.record("phase_ms", entity_scan_time.as_millis() as u64);
    drop(scan_guard);

    let lookup_start = mark(Mark::LookupStart, Clock::now());
    let lookup_span = tracing::debug_span!("lookup", phase_ms = tracing::field::Empty).entered();
    if req.features.properties {
        resolve_space_zone_properties_lazy(&mut entity_jobs, &mut decoder, &rel_defines_spans);
    }
    if req.batching.fast_first {
        entity_jobs.sort_by(|left, right| {
            geometry_priority_score(&right.ifc_type).cmp(&geometry_priority_score(&left.ifc_type))
        });
    }
    let lookup_time = mark(Mark::LookupEnd, lookup_start.elapsed());
    lookup_span.record("phase_ms", lookup_time.as_millis() as u64);
    drop(lookup_span);

    // Fold indexed-colour-map colours in where no IFCSTYLEDITEM already claimed
    // the geometry (styled items win, matching the browser precedence). Before
    // the opening filter, so IgnoreOpaque sees the colours the meshes will get.
    crate::prepass::merge_indexed_colours(&mut geometry_style_index, &indexed_colour_index);
    let (skipped_entity_ids, filtered_void_index) = apply_opening_filter(
        &entity_jobs,
        &void_index,
        &filling_by_opening,
        &geometry_style_index,
        &element_material_colors,
        &mut decoder,
        req.opening_filter,
    );

    // Filter output jobs only after the whole-file relationship/style pre-pass
    // and opening-filter resolution. A selected host still needs unselected
    // IfcOpeningElement cutters from `filtered_void_index`, but only selected
    // products should enter the tessellation loop below. Keeping `None` apart
    // from `Some(empty)` is part of the public filtering contract.
    if let Some(ids) = req.entity_ids.as_deref() {
        entity_jobs.retain(|job| ids.contains(&job.id));
    }

    let schema_version = detect_schema_version(content).to_string();

    let geometry_entity_count = entity_jobs.len();
    tracing::info!(
        total_entities = total_entities,
        geometry_entities = geometry_entity_count,
        voids = void_index.len(),
        schema_version = %schema_version,
        "Entity scanning complete"
    );

    // Resolve BOTH unit scales once via the shared resolver, before the quick
    // bootstrap so its storey elevations come out in metres (PROCESSING-18)
    // (the scan recorded IFCPROJECT's id, so this is an O(1) decode — no more full-file hunts:
    // the historic `with_units` + `plane_angle_to_radians` pair each re-walked
    // the whole DATA section). Seed the shared decoder so every later consumer
    // (opening filter, metadata phase, deferred-style replay) inherits them.
    let unit_scales = tracing::debug_span!("unit_scale")
        .in_scope(|| crate::prepass::resolve_unit_scales(content, project_id, &mut decoder));
    tracing::debug!(
        length_unit_scale = unit_scales.length_unit_scale,
        plane_angle_to_radians = unit_scales.plane_angle_to_radians,
        "Resolved unit scales"
    );
    decoder.seed_unit_scales(unit_scales.geometry_length_scale(), unit_scales.plane_angle_to_radians);
    if let Some(quick) = quick {
        let length_unit_scale = unit_scales.geometry_length_scale();
        sink.on_bootstrap(&quick.finish(length_unit_scale, &schema_version, total_entities));
    }

    // Preprocess complex geometry
    let preprocess_start = mark(Mark::PreprocessStart, Clock::now());
    let preprocess_span =
        tracing::debug_span!("preprocess", phase_ms = tracing::field::Empty).entered();
    // A refused length unit refuses every element, counted (#7678).
    let refused_unit_jobs = diagnostics::refuse_jobs_for_unit(&unit_scales, &mut entity_jobs);
    // Not drained: meshes nothing. Pinned by rust/geometry/tests/issue_3821_auxiliary_routers_mesh_nothing.rs.
    let mut router = diagnostics::unit_router(&unit_scales); // refused with the unit (#7678)
    router.set_tessellation_quality(req.quality);
    // Build the #563 material-layer index from the IfcRelAssociatesMaterial spans
    // the main scan already stashed (like the wasm pre-pass), not a redundant
    // `from_content` re-walk of the whole file. Byte-identical; saves 6-15% load.
    let material_spans = &prepass_spans.rel_associates_material;
    router.set_material_layer_index(Arc::new(
        ifc_lite_geometry::MaterialLayerIndex::from_spans(material_spans, &mut decoder),
    ));

    // Resolve IfcSite and IfcBuilding placement transforms.
    let site_transform: Option<Vec<f64>> = site_entity_pos.and_then(|(start, end)| {
        let entity = decoder.decode_at(start, end).ok()?;
        let matrix = router
            .resolve_scaled_placement(&entity, &mut decoder)
            .ok()?;
        Some(matrix.to_vec())
    });
    let building_transform: Option<Vec<f64>> = building_entity_pos.and_then(|(start, end)| {
        let entity = decoder.decode_at(start, end).ok()?;
        let matrix = router
            .resolve_scaled_placement(&entity, &mut decoder)
            .ok()?;
        Some(matrix.to_vec())
    });

    // The RTC sample window is the file's, not this pipeline's job list
    // (#4611): `entity_jobs` is a schedule (priority-sorted under
    // `fast_first_batch`, plus the #957 synthetic type jobs appended at the
    // end), and the frame must not be a function of the schedule.
    let detected_rtc_offset = router.detect_rtc_offset_for_file(content, &mut decoder);

    // The three-tier frame selection lives on `MeshFrame::select`; this is
    // the site-tier caller (the browser pre-pass passes no site).
    let frame = MeshFrame::select(site_transform.as_deref(), detected_rtc_offset);
    let coord_space = frame.coordinate_space();
    let has_rtc_offset = frame.needs_shift();
    router.set_rtc_offset(frame.rtc_offset());
    // Basis and frame come from one value, so they cannot disagree; fires before any batch.
    let (rx, ry, rz) = frame.rtc_offset();
    let baked_basis = native_to_baked(coord_space, site_transform.as_deref(), [rx, ry, rz]);
    sink.on_frame(&FrameEvent { frame, baked_basis });
    let preprocess_time = mark(Mark::PreprocessEnd, preprocess_start.elapsed());
    preprocess_span.record("phase_ms", preprocess_time.as_millis() as u64);
    drop(preprocess_span);

    let parse_time = mark(Mark::ParseEnd, parse_start.elapsed());
    tracing::info!(
        entity_scan_time_ms = entity_scan_time.as_millis(),
        lookup_time_ms = lookup_time.as_millis(),
        preprocess_time_ms = preprocess_time.as_millis(),
        parse_time_ms = parse_time.as_millis(),
        "Parse phase complete, starting geometry extraction"
    );

    // PARALLEL GEOMETRY PROCESSING
    let geometry_start = mark(Mark::GeometryStart, Clock::now());
    let entity_index_arc = entity_index; // Immutable and shared across jobs.
    let unit_scale = router.unit_scale();
    let rtc_offset = router.rtc_offset();
    // Resolve the plane-angle scale ONCE on the warm shared decoder, then seed
    // every per-element worker decoder below (EntityDecoder::seed_unit_scales).
    // Resolved once by the shared `prepass::resolve_unit_scales` above — the
    // parallel path builds a fresh (cold-cache) decoder per element, so
    // without seeding every arc-bearing element would re-pay an O(file)
    // IFCPROJECT scan (≈135 ms each on a 75 MB model where IFCPROJECT sits at
    // byte ~68 MB).
    let seed_plane_angle_to_radians = unit_scales.plane_angle_to_radians;
    let void_index_arc = Arc::new(filtered_void_index);
    let skipped_entity_ids = Arc::new(skipped_entity_ids);
    let mut geometry_style_index = Arc::new(geometry_style_index);
    let indexed_colour_full = Arc::new(indexed_colour_full);
    // #961: decode surface textures (IfcBlobTexture PNG / IfcPixelTexture) and
    // their per-triangle UV maps once, keyed by face-set id. `build_texture_index`
    // bails out on a cheap substring check for the (vast majority) untextured
    // files. Consumed by the type-only render path below.
    let texture_index = Arc::new(ifc_lite_geometry::build_texture_index(
        content,
        &mut decoder,
    ));
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
    let element_material_colors = Arc::new(element_material_colors);
    let mut run = run_snapshot::RunSnapshot::new(crate::element::OwnedMeshProductionData {
        void_index: Arc::clone(&void_index_arc),
        geometry_style_index: Arc::clone(&geometry_style_index),
        indexed_colour_full: Arc::clone(&indexed_colour_full),
        element_material_colors: Arc::clone(&element_material_colors),
        texture_index: Arc::clone(&texture_index),
        site_local_rotation: run_snapshot::site_rotation(site_transform.as_deref(), coord_space),
    });

    let total_jobs = entity_jobs.len();
    let initial_chunk_size = req.batching.initial.max(1);
    let throughput_chunk_size = req.batching.throughput.max(initial_chunk_size);
    let mut color_cache_by_product_definition_shape: FxHashMap<u32, Option<[f32; 4]>> =
        FxHashMap::default();
    let mut layer_cache_by_product_definition_shape: FxHashMap<u32, Option<String>> =
        FxHashMap::default();
    let mut layer_cache_by_representation: FxHashMap<u32, Option<String>> = FxHashMap::default();
    let mut meshes: Vec<MeshData> = Vec::new();
    let mut processed_jobs = 0usize;
    let mut total_meshes = 0usize;
    let mut total_vertices = 0usize;
    let mut total_triangles = 0usize;
    let mut chunk_start = 0usize;
    let mut current_chunk_size = initial_chunk_size;

    let mut deferred_styles_applied = !defer_style_updates;
    let mut deferred_style_refusals: Vec<u32> = Vec::new();

    // Every request-local diagnostic sink for this pass, declared and drained as
    // one subject — see `diagnostics::DiagnosticCollectors`.
    let diag_collectors = diagnostics::DiagnosticCollectors::new(sink.product_geometry_audit());

    // Shared content-dedup cache for the whole model: every per-job router dedups
    // against it, so byte-identical geometry the exporter failed to share via
    // IfcMappedItem (Tekla parts) is meshed once across the pool, not once per
    // element. The lock is held only for a hash get/insert; meshing runs outside it.
    let item_dedup_cache = GeometryRouter::new_dedup_cache();
    let brep_signature_cache = GeometryRouter::new_brep_signature_cache();

    // Shared IfcMappedItem source cache for the whole model (#1623): every per-job
    // router meshes each RepresentationMap source once against it, instead of once
    // per owning element. Lock held only for a source-mesh get/insert.
    let mapped_item_cache = GeometryRouter::new_mapped_item_cache();

    // #1623 Phase 2 don't-bake plan (Some only when enabled): filter to repeated
    // sources (count >= 2) — singletons materialize normally — and share it with
    // every per-job router via `enable_output_instancing`. Non-template occurrences
    // of these sources skip the per-occurrence materialize and emit an
    // `InstanceRecord` at finalize. Requires `retain_emitted_meshes` (the template
    // MeshData must survive in `meshes` for the finalize to place instances onto it).
    //
    // NOT armed for the `site_local` coordinate tier (IfcSite has a non-identity
    // placement).
    //
    // The original reason — "`build_mesh_data` drops the template's
    // `instance_meta` there" — is no longer true. It stopped being true for a
    // translation-only site with #4176, and for a rotated one with #4118 part B:
    // `element_mesh_build.rs` now keeps instancing metadata unconditionally, and
    // the frame the baker left the vertices in travels to the collator as a
    // basis (`site_local::native_to_baked`) instead of costing the metadata.
    // The EXPORT path therefore does instance site-local models today.
    //
    // What still holds is the reason this particular gate exists, which is a
    // different thing: the #1623 don't-bake plan replaces an occurrence's
    // geometry with a placeholder that only the renderer's own instancing can
    // draw. Arming it here would strand every occurrence in single-threaded
    // finalize orphan-recovery — a perf REGRESSION on a translated site (re-bake
    // serially, worse than plain flat) and MISPLACED geometry on a rotated site
    // (orphan flats baked in the world frame while siblings sit in the
    // site-local frame). Route the whole model to flat instead — correct, and no
    // slower than today. Lifting this gate needs the renderer to instance in the
    // site frame too, and an in-browser verification that it does; that remains
    // a follow-up, and #4118 part B deliberately does not touch it.
    let instancing_plan: Option<ifc_lite_geometry::MappedInstancePlan> = (req.instancing
        && req.retain_meshes
        && coord_space != MeshCoordinateSpace::SiteLocal)
        .then(|| {
            Arc::new(
                mapped_item_plan
                    .into_iter()
                    .filter(|(_, (count, _))| *count >= 2)
                    .collect::<FxHashMap<u32, (u32, u32)>>(),
            )
        });
    // #858 don't-bake exclusion: geometry ids carrying a MULTI-COLOUR
    // IfcIndexedColourMap, armed on every per-job router so those occurrences
    // route to flat (byte-identical to instancing-off). Built only when the plan
    // is armed; the derivation (and why uniform maps are left out, #1807) lives
    // in `style::indexed_colour_split_guard_ids`, which the browser batch arms
    // from too (EDGE-WASM-5).
    let indexed_colour_split_ids: Option<Arc<FxHashSet<u32>>> = instancing_plan
        .is_some()
        .then(|| crate::style::indexed_colour_split_guard_ids(&indexed_colour_full))
        .flatten();
    // Collect the don't-bake occurrences across all chunks/threads; resolved into
    // `InstanceRecord`s against the retained template meshes after the geometry phase.
    let raw_instance_collector: std::sync::Mutex<Vec<RawInstanceOccurrence>> =
        std::sync::Mutex::new(Vec::new());

    // Per-part point-cache instrumentation (feeds `ProcessingStats` and, through
    // it, `PipelineDiagnostics`). `hits`/`misses` count CartesianPoints served
    // by `EntityDecoder::get_polyloop_coords_cached` across every faceted part;
    // a non-zero `hits` proves the per-worker cache hoist below memoized points
    // ACROSS elements. `faceted_brep_ns` is summed only under the `observability`
    // feature (native), since `std::time::Instant` traps on wasm32. All three are
    // request-local atomics, like `backstop_collector`.
    let point_cache_hits_collector = std::sync::atomic::AtomicU64::new(0);
    let point_cache_misses_collector = std::sync::atomic::AtomicU64::new(0);
    let faceted_brep_ns_collector = std::sync::atomic::AtomicU64::new(0);

    let worker_point_caches = jobs::new_worker_point_caches();
    // Sized identically to `worker_point_caches` (one slot per rayon worker,
    // indexed by thread index). Memoizes each worker's resolved placement world
    // transforms across the whole model — see `new_worker_placement_caches`.
    let worker_placement_caches = jobs::new_worker_placement_caches();

    let geometry_span = tracing::info_span!(
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
        // Cooperative cancellation between chunks: the caller flipped the flag
        // (e.g. its client disconnected), so stop meshing and emitting. The
        // result below is partial by contract; see ProcessingRequest::cancel.
        if req
            .cancel
            .as_ref()
            .is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed))
        {
            break;
        }
        let chunk_end = (chunk_start + current_chunk_size).min(total_jobs);
        let jobs_chunk = &mut entity_jobs[chunk_start..chunk_end];

        // ── Desktop: two-phase parallel metadata population ──
        // Phase 1 (parallel): decode entities, extract GlobalId/Name/ProductDefinitionShapeId
        // Phase 2 (serial): resolve colors from cache (cheap, cache-hit dominated)
        #[cfg(not(target_arch = "wasm32"))]
        {
            // Phase 1: parallel decode with thread-local EntityDecoder
            let entity_index_for_meta = entity_index_arc.clone();
            jobs_chunk.par_iter_mut().for_each(|job| {
                if job.global_id.is_some()
                    || job.name.is_some()
                    || job.product_definition_shape_id.is_some()
                {
                    return;
                }
                let local_decoder = entity_index_for_meta.decoder(content);
                // #3987: this decoder is read once; an entity-cache clone is never reused.
                let Ok(entity) = local_decoder.decode_at_uncached(job.start, job.end) else {
                    return;
                };
                job.global_id = normalize_optional_string(entity.get_string(0));
                job.name = normalize_optional_string(entity.get_string(2));
                job.product_definition_shape_id = entity.get_ref(6);
            });

            // Phase 2: serial color/layer resolution (cache-hit dominated, fast)
            for job in jobs_chunk.iter_mut() {
                let Some(pds_id) = job.product_definition_shape_id else {
                    continue;
                };
                let resolved_color = color_cache_by_product_definition_shape
                    .entry(pds_id)
                    .or_insert_with(|| {
                        resolve_element_color_for_product_definition_shape(
                            pds_id,
                            &geometry_style_index,
                            &mut decoder,
                        )
                    });
                if let Some(color) = resolved_color {
                    job.element_color = *color;
                } else if let Some(color) = element_material_color.get(&job.id) {
                    // No direct/indexed geometry style — inherit the material
                    // appearance (#407).
                    job.element_color = *color;
                }
                if req.features.presentation_layers {
                    let resolved_layer = layer_cache_by_product_definition_shape
                        .entry(pds_id)
                        .or_insert_with(|| {
                            resolve_presentation_layer_for_product_definition_shape(
                                pds_id,
                                &presentation_layer_by_assigned_id,
                                &mut layer_cache_by_representation,
                                &mut decoder,
                            )
                        });
                    job.presentation_layer = resolved_layer.clone();
                }
            }
        }

        // ── WASM: existing serial path (unchanged) ──
        #[cfg(target_arch = "wasm32")]
        for job in jobs_chunk.iter_mut() {
            populate_entity_job_metadata(
                job,
                &geometry_style_index,
                &element_material_color,
                &presentation_layer_by_assigned_id,
                &mut color_cache_by_product_definition_shape,
                &mut layer_cache_by_product_definition_shape,
                &mut layer_cache_by_representation,
                &mut decoder,
                req.features.presentation_layers,
            );
        }
        // Each job borrows its worker's persistent point cache by thread index, so a
        // shared point list is parsed once per worker for the whole model, not per
        // chunk/part. `.map`/`.flatten_iter()` keeps the former `flat_map_iter` order;
        // the cache is pure memoization, so meshes are byte-identical.
        let chunk_meshes: Vec<MeshData> = scheduling::element_tasks(jobs_chunk)
            .map(|job| {
                let widx = rayon::current_thread_index().unwrap_or(0) % worker_point_caches.len();
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
                let mut slot_guard = worker_point_caches[widx].try_lock().ok();
                let worker_point_cache: &mut FxHashMap<u32, (f64, f64, f64)> =
                    match slot_guard.as_deref_mut() {
                        Some(cache) => cache,
                        None => &mut fallback_cache,
                    };
                // Placement-transform slot: the SAME `try_lock` (not `lock`)
                // discipline as the point cache above — a faceted-brep nested
                // `par_iter` can work-steal another job onto this worker's own
                // thread index and re-enter here, and `lock()` on the
                // non-reentrant `Mutex` this thread already holds would
                // self-deadlock (#1587). On that rare re-entrant steal we fall
                // back to a throwaway cache; output stays byte-identical since
                // the cache is pure memoization of a deterministic composition.
                let mut fallback_placement_cache = FxHashMap::default();
                let mut placement_slot_guard = worker_placement_caches[widx].try_lock().ok();
                let worker_placement_cache: &mut FxHashMap<u32, [f64; 16]> =
                    match placement_slot_guard.as_deref_mut() {
                        Some(cache) => cache,
                        None => &mut fallback_placement_cache,
                    };
                process_entity_job(
                    job,
                    content,
                    &entity_index_arc,
                    unit_scale,
                    rtc_offset,
                    seed_plane_angle_to_radians,
                    req.quality,
                    run.context(),
                    skipped_entity_ids.as_ref(),
                    &diag_collectors,
                    &item_dedup_cache,
                    &brep_signature_cache,
                    &mapped_item_cache,
                    instancing_plan.as_ref(),
                    indexed_colour_split_ids.as_ref(),
                    &raw_instance_collector,
                    worker_point_cache,
                    worker_placement_cache,
                    &point_cache_hits_collector,
                    &point_cache_misses_collector,
                    &faceted_brep_ns_collector,
                )
            })
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
                sink.on_batch(emitted_meshes, processed_jobs, total_jobs);
            }
            if req.retain_meshes {
                meshes.extend(chunk_meshes);
            }

            if !deferred_styles_applied {
                // Replay saved IFCSTYLEDITEM positions instead of re-scanning
                // the entire file.  This eliminates ~0.5-1 s for 1 GB files.
                // The replay is the shared resolver's styled-item building
                // block, so deferred and up-front resolution cannot drift.
                let mut style_decoder = entity_index_arc.decoder(content).with_strict_reals();
                let mut rebuilt_styles = crate::prepass::resolve_styled_item_spans(&deferred_styled_item_positions, &mut style_decoder);
                deferred_style_refusals.extend(style_decoder.refused_record_ids());
                crate::prepass::merge_indexed_colours(&mut rebuilt_styles, &indexed_colour_index);
                geometry_style_index = Arc::new(rebuilt_styles);
                run.replace_styles(&geometry_style_index);
                let deferred_color_updates = build_color_updates_for_jobs(
                    &entity_jobs[..processed_jobs], geometry_style_index.as_ref(), content,
                    &entity_index_arc, &mut deferred_style_refusals,
                );
                if !deferred_color_updates.is_empty() {
                    sink.on_color_update(&deferred_color_updates);
                }
                deferred_styles_applied = true;
            }
        }
        chunk_start = chunk_end;
        current_chunk_size = throughput_chunk_size;
    }

    let geometry_time = mark(Mark::GeometryEnd, geometry_start.elapsed());
    // Surface the aggregated CSG diagnostics — same per-reason breakdown the
    // browser console shows on the wasm path.
    let csg_failures = diag_collectors
        .csg_failures
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let total_csg_failures: usize = csg_failures.values().map(Vec::len).sum();
    let products_with_failures = ifc_lite_geometry::count_attributed_products(&csg_failures);
    let backstop_dropped = diag_collectors.backstop.into_inner();
    let refused_prepass_records = diagnostics::distinct_refusals(&decoder, deferred_style_refusals, &unit_scales);
    // #3421/#3752: refused, not wrapped; surfaced below via GeometryDiagnostics.
    let oversized_ref_drops = diag_collectors.oversized_ref_drops.into_inner();
    let point_cache_hits = point_cache_hits_collector.into_inner();
    let point_cache_misses = point_cache_misses_collector.into_inner();
    let faceted_brep_time_ms = faceted_brep_ns_collector.into_inner() / 1_000_000;
    geometry_span.record("mesh_count", total_meshes as u64);
    geometry_span.record("triangle_count", total_triangles as u64);
    geometry_span.record("backstop_count", backstop_dropped);
    geometry_span.record("total_csg_failures", total_csg_failures as u64);
    geometry_span.record("phase_ms", geometry_time.as_millis() as u64);
    drop(geometry_guard);
    if total_csg_failures > 0 {
        let mut by_reason: HashMap<&'static str, usize> = HashMap::new();
        for fails in csg_failures.values() {
            for f in fails {
                *by_reason.entry(f.reason.label()).or_insert(0) += 1;
            }
        }
        // #4067: `KernelError` (the sole production emitter is
        // `topology_diagnostic.rs`) records an ACCEPTED open-topology result —
        // the returned mesh is unchanged — not a dropped cut. Partition the
        // count before it's consumed into `breakdown` below.
        let open_topology_accepted = *by_reason.get("KernelError").unwrap_or(&0);
        let dropped = total_csg_failures - open_topology_accepted;
        let mut breakdown: Vec<(&'static str, usize)> = by_reason.into_iter().collect();
        breakdown.sort_by(|a, b| b.1.cmp(&a.1));
        let breakdown = breakdown
            .iter()
            .map(|(reason, count)| format!("{reason}={count}"))
            .collect::<Vec<_>>()
            .join(" ");
        tracing::warn!(
            total_csg_failures,
            products_with_failures,
            dropped,
            open_topology_accepted,
            %breakdown,
            "{}",
            csg_summary::csg_summary_message(dropped, open_topology_accepted)
        );
    }

    let geometry_diagnostics = tracing::debug_span!("collate_diagnostics").in_scope(|| {
        diagnostics::collate(
            diag_collectors.classification,
            diag_collectors.host_diags,
            diag_collectors.rect_fast,
            diag_collectors.unsupported_items,
            &csg_failures,
            oversized_ref_drops,
        )
    });

    // #1623 Phase 2: resolve the don't-bake occurrences into InstanceRecords against
    // the retained template meshes (min-id occurrence per source). Empty on the flat
    // path (no armed plan ⇒ no occurrences collected). `meshes` is only appended to
    // (orphan recovery), so the flat output stays byte-identical.
    let instances = instancing::finalize_instances(
        raw_instance_collector
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        &mut meshes,
        &mapped_item_cache,
        [rtc_offset.0, rtc_offset.1, rtc_offset.2],
    );

    let total_time = mark(Mark::TotalEnd, total_start.elapsed());
    pipeline_span.record("element_count", total_jobs as u64);
    pipeline_span.record("total_ms", total_time.as_millis() as u64);

    tracing::info!(
        meshes = meshes.len(),
        instances = instances.len(),
        vertices = total_vertices,
        triangles = total_triangles,
        backstop_count = backstop_dropped,
        geometry_time_ms = geometry_time.as_millis(),
        total_time_ms = total_time.as_millis(),
        "Geometry processing complete"
    );

    let extract_georeferencing = || crate::georeferencing::extract_georeferencing_from_candidates(
        &mut entity_index_arc.decoder(content), &georeferencing_candidates,
    );
    // #3987: jobs and instance finalization have finished using these caches.
    // Keep metadata on the caller thread; join ALL disposal before returning,
    // including on unwind. No cleanup survives the full-load readiness boundary.
    #[cfg(not(target_arch = "wasm32"))]
    let georeferencing = rayon::in_place_scope(|scope| {
        scope.spawn(move |_| drop(decoder));
        scope.spawn(move |_| drop(item_dedup_cache));
        extract_georeferencing()
    });
    #[cfg(target_arch = "wasm32")]
    let georeferencing = extract_georeferencing();

    ProcessingResult {
        meshes,
        instances,
        mesh_coordinate_space: coord_space,
        frame,
        site_transform,
        building_transform,
        metadata: ModelMetadata {
            schema_version,
            entity_count: total_entities,
            geometry_entity_count,
            coordinate_info: CoordinateInfo {
                origin_shift: [rtc_offset.0, rtc_offset.1, rtc_offset.2],
                is_geo_referenced: has_rtc_offset,
            },
            georeferencing,
            ..diagnostics::unit_metadata(&unit_scales, unit_scale)
        },
        stats: ProcessingStats {
            total_meshes,
            total_vertices,
            total_triangles,
            parse_time_ms: parse_time.as_millis() as u64,
            entity_scan_time_ms: entity_scan_time.as_millis() as u64,
            lookup_time_ms: lookup_time.as_millis() as u64,
            preprocess_time_ms: preprocess_time.as_millis() as u64,
            geometry_time_ms: geometry_time.as_millis() as u64,
            total_time_ms: total_time.as_millis() as u64,
            from_cache: false,
            total_csg_failures: total_csg_failures as u64,
            products_with_failures,
            degenerate_triangles_dropped: backstop_dropped,
            refused_input_elements: diag_collectors.refused_input.into_inner() + refused_unit_jobs,
            refused_prepass_records,
            point_cache_hits,
            point_cache_misses,
            faceted_brep_time_ms,
            geometry_diagnostics,
        },
    }
}

// Default IFC-type colors now come from the single canonical table in
// `crate::style::default_color_for_type` (issue #913). Do not reintroduce a
// per-module table here — see `tests/styling_parity.rs` for the guard.
//
// `find_geometry_item_color_follows_mapped_item` lives in `crate::element::tests`;
// the resolver it pins moved to `element/element_color.rs`.
