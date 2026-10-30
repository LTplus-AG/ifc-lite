// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Everything between the scan and the first meshed element.
//!
//! [`resolve`] turns the scan's output into a [`Resolved`]: the entity index
//! installed, the shared pre-pass resolution (styles, voids, materials), the
//! lookup phase, the opening and id filters, both unit scales, the quick
//! bootstrap, the auxiliary router, the site and building placements and the
//! mesh frame. It raises `on_omitted_type_records`, `on_bootstrap` and `on_frame`
//! on the sink. The pass
//! after it ([`super::pass`]) only meshes.

use super::diagnostics;
use super::entity_index::{IndexBuilder, ProcessingIndex};
use super::job::{geometry_priority_score, EntityJob};
use super::opening_filter::apply_opening_filter;
use super::phase_marks::{mark, Clock, Mark};
use super::properties::resolve_space_zone_properties_lazy;
use super::scan;
use super::{detect_schema_version, OpeningFilterMode, ProcessingRequest, ProcessingSink};
use crate::mesh_frame::MeshFrame;
use crate::prepass::{ResolvedPrepass, UnitScales};
use crate::style::GeometryStyleInfo;
use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;
use rustc_hash::FxHashMap;
use std::collections::HashSet;
use std::time::Duration;

mod frame;
use frame::placement_phase;

/// Wall-clock windows of the phases before the geometry pass.
pub(super) struct Times {
    pub(super) entity_scan: Duration,
    pub(super) lookup: Duration,
    pub(super) preprocess: Duration,
    pub(super) parse: Duration,
}

/// What the result reports about the model, fixed before the first mesh.
pub(super) struct Facts {
    pub(super) schema_version: String,
    pub(super) total_entities: usize,
    pub(super) geometry_entity_count: usize,
    pub(super) unit_scales: UnitScales,
    /// Jobs dropped because the length unit was refused (#7678).
    pub(super) refused_unit_jobs: u64,
    pub(super) site_transform: Option<Vec<f64>>,
    pub(super) building_transform: Option<Vec<f64>>,
    pub(super) frame: MeshFrame,
    pub(super) georeferencing_candidates: Vec<(u32, IfcType)>,
    pub(super) times: Times,
    /// Kept alive to the end of the pass, like the router: freeing them is not
    /// part of any timed phase.
    pub(super) _prepass_spans: crate::prepass::PrepassSpans,
    pub(super) _prepass_rest: ResolvedPrepass,
    pub(super) _rel_defines_spans: Vec<(usize, usize)>,
    pub(super) router: GeometryRouter,
    pub(super) material_layers: Option<std::sync::Arc<ifc_lite_geometry::MaterialLayerIndex>>,
}

/// The inputs of the geometry pass.
pub(super) struct Resolved<'c> {
    pub(super) facts: Facts,
    pub(super) decoder: EntityDecoder<'c>,
    pub(super) entity_index: ProcessingIndex,
    pub(super) entity_jobs: Vec<EntityJob>,
    pub(super) defer_style_updates: bool,
    pub(super) geometry_style_index: FxHashMap<u32, GeometryStyleInfo>,
    pub(super) indexed_colour_index: FxHashMap<u32, [f32; 4]>,
    pub(super) indexed_colour_full: FxHashMap<u32, crate::style::FullIndexedColourMap>,
    pub(super) element_material_colors: FxHashMap<u32, Vec<[f32; 4]>>,
    pub(super) deferred_styled_item_positions: Vec<(usize, usize)>,
    pub(super) void_index: FxHashMap<u32, Vec<u32>>,
    pub(super) skipped_entity_ids: HashSet<u32>,
    pub(super) presentation_layer_by_assigned_id: FxHashMap<u32, String>,
    pub(super) mapped_item_plan: FxHashMap<u32, (u32, u32)>,
}

/// The scan and the shared post-scan resolution, before any filter.
struct Scanned<'c> {
    decoder: EntityDecoder<'c>,
    entity_index: ProcessingIndex,
    jobs: Vec<EntityJob>,
    spans: crate::prepass::PrepassSpans,
    project_id: Option<u32>,
    layers: FxHashMap<u32, String>,
    rel_defines_spans: Vec<(usize, usize)>,
    georef_candidates: Vec<(u32, IfcType)>,
    mapped_item_plan: FxHashMap<u32, (u32, u32)>,
    quick: Option<super::quick_collector::QuickCollector>,
    total_entities: usize,
    site_pos: Option<(usize, usize)>,
    building_pos: Option<(usize, usize)>,
    defer_style_updates: bool,
    prepass: ResolvedPrepass,
    omitted_type_records: Vec<u32>,
}

pub(super) fn resolve<'c>(
    content: &'c [u8],
    req: &ProcessingRequest,
    sink: &mut dyn ProcessingSink,
    parse_start: Clock,
) -> Resolved<'c> {
    let entity_scan_start = Clock::now();
    let scan_span = tracing::info_span!(target: "ifc_lite_processing::processor",
        "scan_prepass",
        total_entities = tracing::field::Empty,
        geometry_entities = tracing::field::Empty,
        phase_ms = tracing::field::Empty,
    );
    let scan_guard = scan_span.clone().entered();
    let mut scanned = scan_phase(content, req);
    let entity_scan_time = mark(Mark::EntityScanEnd, entity_scan_start.elapsed());
    scan_span.record("total_entities", scanned.total_entities as u64);
    scan_span.record("geometry_entities", scanned.jobs.len() as u64);
    scan_span.record("phase_ms", entity_scan_time.as_millis() as u64);
    drop(scan_guard);
    if !scanned.omitted_type_records.is_empty() {
        tracing::warn!(target: "ifc_lite_processing::processor",
            omitted_type_records = scanned.omitted_type_records.len(),
            "type records the full decoder rejects: their type geometry is omitted (#8341)");
        sink.on_omitted_type_records(&scanned.omitted_type_records);
    }

    let lookup_time = lookup_phase(req, &mut scanned);

    let (skipped_entity_ids, filtered_void_index) = filter_phase(req, &mut scanned);
    let schema_version = detect_schema_version(content).to_string();
    let geometry_entity_count = scanned.jobs.len();
    tracing::info!(target: "ifc_lite_processing::processor",
        total_entities = scanned.total_entities,
        geometry_entities = geometry_entity_count,
        voids = scanned.prepass.void_index.len(),
        schema_version = %schema_version,
        "Entity scanning complete"
    );

    let unit_scales = unit_phase(content, &mut scanned);
    if let Some(quick) = scanned.quick.take() {
        let length_unit_scale = unit_scales.geometry_length_scale();
        sink.on_bootstrap(&quick.finish(
            length_unit_scale,
            &schema_version,
            scanned.total_entities,
        ));
    }

    let preprocess_start = mark(Mark::PreprocessStart, Clock::now());
    let preprocess_span =
        tracing::debug_span!(target: "ifc_lite_processing::processor", "preprocess", phase_ms = tracing::field::Empty).entered();
    // #7782 D66: no index work for the default unsliced native pass.
    let material_layers = req.layer_slicing.then(|| {
        std::sync::Arc::new(ifc_lite_geometry::MaterialLayerIndex::from_spans(
            &scanned.spans.rel_associates_material,
            &mut scanned.decoder,
        ))
    });
    let refused_unit_jobs = diagnostics::refuse_jobs_for_unit(&unit_scales, &mut scanned.jobs);
    let (router, site_transform, building_transform, frame) =
        placement_phase(content, req, sink, &mut scanned, &unit_scales);
    let preprocess_time = mark(Mark::PreprocessEnd, preprocess_start.elapsed());
    preprocess_span.record("phase_ms", preprocess_time.as_millis() as u64);
    drop(preprocess_span);

    let parse_time = mark(Mark::ParseEnd, parse_start.elapsed());
    tracing::info!(target: "ifc_lite_processing::processor",
        entity_scan_time_ms = entity_scan_time.as_millis(),
        lookup_time_ms = lookup_time.as_millis(),
        preprocess_time_ms = preprocess_time.as_millis(),
        parse_time_ms = parse_time.as_millis(),
        "Parse phase complete, starting geometry extraction"
    );

    let total_entities = scanned.total_entities;
    let Scanned {
        decoder,
        entity_index,
        jobs,
        spans,
        layers,
        georef_candidates,
        rel_defines_spans,
        mapped_item_plan,
        defer_style_updates,
        mut prepass,
        ..
    } = scanned;
    Resolved {
        geometry_style_index: std::mem::take(&mut prepass.geometry_style_index),
        indexed_colour_index: std::mem::take(&mut prepass.indexed_colour_index),
        indexed_colour_full: std::mem::take(&mut prepass.indexed_colour_full),
        element_material_colors: std::mem::take(&mut prepass.element_material_colors),
        deferred_styled_item_positions: std::mem::take(&mut prepass.deferred_attached_styled_spans),
        facts: Facts {
            schema_version,
            total_entities,
            geometry_entity_count,
            unit_scales,
            refused_unit_jobs,
            site_transform,
            building_transform,
            frame,
            georeferencing_candidates: georef_candidates,
            times: Times {
                entity_scan: entity_scan_time,
                lookup: lookup_time,
                preprocess: preprocess_time,
                parse: parse_time,
            },
            _prepass_spans: spans,
            _prepass_rest: prepass,
            _rel_defines_spans: rel_defines_spans,
            router,
            material_layers,
        },
        decoder,
        entity_index,
        entity_jobs: jobs,
        defer_style_updates,
        void_index: filtered_void_index,
        skipped_entity_ids,
        presentation_layer_by_assigned_id: layers,
        mapped_item_plan,
    }
}

/// Scan, then install the finished index and run the shared post-scan
/// resolution (`crate::prepass`): styled items (orphan vs attached,
/// defer-aware), IfcIndexedColourMap, the #407 material chain join, voids +
/// fills and the #845 aggregate void propagation: the code the browser
/// pre-passes run too.
fn scan_phase<'c>(content: &'c [u8], req: &ProcessingRequest) -> Scanned<'c> {
    // The entity index (expressId -> byte span) is built INLINE in the scan
    // loop rather than in a separate `build_entity_index` pass, so the file is
    // walked once. A caller that injected an index reuses it and skips the
    // inline build. `decode_at` during the scan needs no index (it parses local
    // bytes), so the scan-phase decoder starts index-less; the completed index
    // is installed before the first ref-resolving call (`resolve_prepass`).
    let provided_index = req.entity_index.clone();
    let building_index = provided_index.is_none();
    let mut inline_index = IndexBuilder::new(content.len(), building_index);
    let mut decoder = match &provided_index {
        // geometry pre-pass: strict reals (#7678)
        Some(idx) => EntityDecoder::with_arc_index(content, idx.clone()).with_strict_reals(),
        None => EntityDecoder::new(content).with_strict_reals(),
    };
    tracing::debug!(target: "ifc_lite_processing::processor", "Entity index will be built inline during the scan");

    let scan::ScanOutput {
        entity_jobs,
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
        omitted_type_records,
    } = scan::scan_entities(
        content,
        req,
        &mut decoder,
        &mut inline_index,
        building_index,
    );

    let defer_style_updates = req.batching.fast_first
        && req.opening_filter == OpeningFilterMode::Default
        && !req.features.presentation_layers;

    // The inline index is now complete, identical to `build_entity_index` over
    // the same scanner.
    let entity_index = match provided_index {
        Some(idx) => ProcessingIndex::hash(idx),
        None => inline_index.finish(),
    };
    entity_index.install(&mut decoder);

    let prepass = crate::prepass::resolve_prepass(
        &prepass_spans,
        &mut decoder,
        crate::prepass::ResolveOptions {
            collect_indexed_colour_full: true,
            defer_attached_styles: defer_style_updates,
        },
    );
    Scanned {
        decoder,
        entity_index,
        jobs: entity_jobs,
        spans: prepass_spans,
        project_id,
        layers: presentation_layer_by_assigned_id,
        rel_defines_spans,
        georef_candidates: georeferencing_candidates,
        mapped_item_plan,
        quick,
        total_entities,
        site_pos: site_entity_pos,
        building_pos: building_entity_pos,
        defer_style_updates,
        prepass,
        omitted_type_records,
    }
}

/// Space/zone properties and, under `fast_first`, the priority order.
fn lookup_phase(req: &ProcessingRequest, s: &mut Scanned<'_>) -> Duration {
    let lookup_start = mark(Mark::LookupStart, Clock::now());
    let lookup_span = tracing::debug_span!(target: "ifc_lite_processing::processor", "lookup", phase_ms = tracing::field::Empty).entered();
    if req.features.properties {
        resolve_space_zone_properties_lazy(&mut s.jobs, &mut s.decoder, &s.rel_defines_spans);
    }
    if req.batching.fast_first {
        s.jobs.sort_by(|left, right| {
            geometry_priority_score(&right.ifc_type).cmp(&geometry_priority_score(&left.ifc_type))
        });
    }
    let lookup_time = mark(Mark::LookupEnd, lookup_start.elapsed());
    lookup_span.record("phase_ms", lookup_time.as_millis() as u64);
    lookup_time
}

/// The opening filter, then the id allow-list. Returns the skipped ids and the
/// void index the pass cuts with.
fn filter_phase(
    req: &ProcessingRequest,
    s: &mut Scanned<'_>,
) -> (HashSet<u32>, FxHashMap<u32, Vec<u32>>) {
    // Fold indexed-colour-map colours in where no IFCSTYLEDITEM already claimed
    // the geometry (styled items win, matching the browser precedence). Before
    // the opening filter, so IgnoreOpaque sees the colours the meshes will get.
    crate::prepass::merge_indexed_colours(
        &mut s.prepass.geometry_style_index,
        &s.prepass.indexed_colour_index,
    );
    let (skipped_entity_ids, filtered_void_index) = apply_opening_filter(
        &s.jobs,
        &s.prepass.void_index,
        &s.prepass.filling_by_opening,
        &s.prepass.geometry_style_index,
        &s.prepass.element_material_colors,
        &mut s.decoder,
        req.opening_filter,
    );

    // Filter output jobs only after the whole-file relationship/style pre-pass
    // and opening-filter resolution. A selected host still needs unselected
    // IfcOpeningElement cutters from `filtered_void_index`, but only selected
    // products should enter the tessellation loop. Keeping `None` apart from
    // `Some(empty)` is part of the public filtering contract.
    if let Some(ids) = req.entity_ids.as_deref() {
        s.jobs.retain(|job| ids.contains(&job.id));
    }
    (skipped_entity_ids, filtered_void_index)
}

/// Resolve BOTH unit scales once via the shared resolver, before the quick
/// bootstrap so its storey elevations come out in metres (PROCESSING-18). The
/// scan recorded IFCPROJECT's id, so this is an O(1) decode. Seed the shared
/// decoder so every later consumer (opening filter, metadata phase,
/// deferred-style replay) inherits them.
fn unit_phase(content: &[u8], s: &mut Scanned<'_>) -> UnitScales {
    let unit_scales = tracing::debug_span!(target: "ifc_lite_processing::processor", "unit_scale")
        .in_scope(|| crate::prepass::resolve_unit_scales(content, s.project_id, &mut s.decoder));
    tracing::debug!(target: "ifc_lite_processing::processor",
        length_unit_scale = unit_scales.length_unit_scale,
        plane_angle_to_radians = unit_scales.plane_angle_to_radians,
        "Resolved unit scales"
    );
    s.decoder.seed_unit_scales(
        unit_scales.geometry_length_scale(),
        unit_scales.plane_angle_to_radians,
    );
    unit_scales
}
