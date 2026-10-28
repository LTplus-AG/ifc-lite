// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! After the last chunk: drain the collectors into `GeometryDiagnostics`,
//! resolve the don't-bake occurrences into instance records, read the
//! georeferencing and assemble the [`ProcessingResult`].

use super::diagnostics;
use super::pass::{PassContext, Passed};
use super::phase_marks::{mark, Clock, Mark};
use super::{csg_summary, instancing, ProcessingResult};
use crate::types::response::{CoordinateInfo, ModelMetadata, ProcessingStats};
use rustc_hash::FxHashMap;
use std::collections::HashMap;

/// The per-reason CSG warning: how many cuts failed, how many were accepted
/// open-topology results rather than dropped cuts.
fn warn_csg_failures(
    csg_failures: &FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>,
    total_csg_failures: usize,
    products_with_failures: u64,
) {
    if total_csg_failures == 0 {
        return;
    }
    let mut by_reason: HashMap<&'static str, usize> = HashMap::new();
    for fails in csg_failures.values() {
        for f in fails {
            *by_reason.entry(f.reason.label()).or_insert(0) += 1;
        }
    }
    // #4067: `KernelError` (the sole production emitter is
    // `topology_diagnostic.rs`) records an ACCEPTED open-topology result -- the
    // returned mesh is unchanged -- not a dropped cut. Partition the count
    // before it's consumed into `breakdown` below.
    let open_topology_accepted = *by_reason.get("KernelError").unwrap_or(&0);
    let dropped = total_csg_failures - open_topology_accepted;
    let mut breakdown: Vec<(&'static str, usize)> = by_reason.into_iter().collect();
    breakdown.sort_by(|a, b| b.1.cmp(&a.1));
    let breakdown = breakdown
        .iter()
        .map(|(reason, count)| format!("{reason}={count}"))
        .collect::<Vec<_>>()
        .join(" ");
    tracing::warn!(target: "ifc_lite_processing::processor",
        total_csg_failures,
        products_with_failures,
        dropped,
        open_topology_accepted,
        %breakdown,
        "{}",
        csg_summary::csg_summary_message(dropped, open_topology_accepted)
    );
}

/// Recover the collector and count its attributed failures before reporting.
struct CsgFailures {
    failures: FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>,
    total: usize,
    products: u64,
}

impl CsgFailures {
    fn collect(
        collector: std::sync::Mutex<FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>>,
    ) -> Self {
        let failures = collector
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let total = failures.values().map(Vec::len).sum();
        let products = ifc_lite_geometry::count_attributed_products(&failures);
        Self {
            failures,
            total,
            products,
        }
    }
}

pub(super) fn finish(
    content: &[u8],
    passed: Passed<'_>,
    total_start: Clock,
    pipeline_span: &tracing::Span,
) -> ProcessingResult {
    let Passed {
        facts,
        decoder,
        ctx,
        mut meshes,
        total_jobs,
        total_meshes,
        total_vertices,
        total_triangles,
        deferred_style_refusals,
        geometry_time,
        geometry_span,
        spent: _spent,
    } = passed;
    let PassContext {
        diag,
        raw_instance_collector,
        mapped_item_cache,
        item_dedup_cache,
        entity_index,
        unit_scale,
        rtc_offset,
        ..
    } = ctx;

    let CsgFailures {
        failures: csg_failures,
        total: total_csg_failures,
        products: products_with_failures,
    } = CsgFailures::collect(diag.csg_failures);
    let backstop_dropped = diag.backstop.into_inner();
    let refused_prepass_records =
        diagnostics::distinct_refusals(&decoder, deferred_style_refusals, &facts.unit_scales);
    // #3421/#3752: refused, not wrapped; surfaced below via GeometryDiagnostics.
    let oversized_ref_drops = diag.oversized_ref_drops.into_inner();
    let point_cache_hits = diag.point_cache_hits.into_inner();
    let point_cache_misses = diag.point_cache_misses.into_inner();
    let faceted_brep_time_ms = diag.faceted_brep_ns.into_inner() / 1_000_000;
    geometry_span.record("mesh_count", total_meshes as u64);
    geometry_span.record("triangle_count", total_triangles as u64);
    geometry_span.record("backstop_count", backstop_dropped);
    geometry_span.record("total_csg_failures", total_csg_failures as u64);
    geometry_span.record("phase_ms", geometry_time.as_millis() as u64);
    warn_csg_failures(&csg_failures, total_csg_failures, products_with_failures);

    let geometry_diagnostics =
        tracing::debug_span!(target: "ifc_lite_processing::processor", "collate_diagnostics")
            .in_scope(|| {
                diagnostics::collate(
                    diag.classification,
                    diag.host_diags,
                    diag.rect_fast,
                    diag.unsupported_items,
                    &csg_failures,
                    oversized_ref_drops,
                )
            });

    // #1623 Phase 2: resolve the don't-bake occurrences into InstanceRecords against
    // the retained template meshes (min-id occurrence per source). Empty on the flat
    // path (no armed plan => no occurrences collected). `meshes` is only appended to
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
    tracing::info!(target: "ifc_lite_processing::processor",
        meshes = meshes.len(),
        instances = instances.len(),
        vertices = total_vertices,
        triangles = total_triangles,
        backstop_count = backstop_dropped,
        geometry_time_ms = geometry_time.as_millis(),
        total_time_ms = total_time.as_millis(),
        "Geometry processing complete"
    );

    let georeferencing = extract_georeferencing(
        content,
        decoder,
        item_dedup_cache,
        &entity_index,
        &facts.georeferencing_candidates,
    );

    let frame = facts.frame;
    ProcessingResult {
        meshes,
        instances,
        mesh_coordinate_space: frame.coordinate_space(),
        frame,
        site_transform: facts.site_transform,
        building_transform: facts.building_transform,
        metadata: ModelMetadata {
            schema_version: facts.schema_version,
            entity_count: facts.total_entities,
            geometry_entity_count: facts.geometry_entity_count,
            coordinate_info: CoordinateInfo {
                origin_shift: [rtc_offset.0, rtc_offset.1, rtc_offset.2],
                is_geo_referenced: frame.needs_shift(),
            },
            georeferencing,
            ..diagnostics::unit_metadata(&facts.unit_scales, unit_scale)
        },
        stats: ProcessingStats {
            total_meshes,
            total_vertices,
            total_triangles,
            parse_time_ms: facts.times.parse.as_millis() as u64,
            entity_scan_time_ms: facts.times.entity_scan.as_millis() as u64,
            lookup_time_ms: facts.times.lookup.as_millis() as u64,
            preprocess_time_ms: facts.times.preprocess.as_millis() as u64,
            geometry_time_ms: geometry_time.as_millis() as u64,
            total_time_ms: total_time.as_millis() as u64,
            from_cache: false,
            total_csg_failures: total_csg_failures as u64,
            products_with_failures,
            degenerate_triangles_dropped: backstop_dropped,
            refused_input_elements: diag.refused_input.into_inner() + facts.refused_unit_jobs,
            refused_prepass_records,
            point_cache_hits,
            point_cache_misses,
            faceted_brep_time_ms,
            geometry_diagnostics,
        },
    }
}

/// Dispose the warm caches before returning, while extracting metadata on the caller.
fn extract_georeferencing(
    content: &[u8],
    decoder: ifc_lite_core::EntityDecoder<'_>,
    item_dedup_cache: ifc_lite_geometry::ItemDedupCache,
    entity_index: &super::entity_index::ProcessingIndex,
    candidates: &[(u32, ifc_lite_core::IfcType)],
) -> Option<crate::georeferencing::Georeferencing> {
    let extract_georeferencing = || {
        crate::georeferencing::extract_georeferencing_from_candidates(
            &mut entity_index.decoder(content),
            candidates,
        )
    };
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
    let georeferencing = {
        let _ = (&decoder, &item_dedup_cache);
        extract_georeferencing()
    };

    georeferencing
}
