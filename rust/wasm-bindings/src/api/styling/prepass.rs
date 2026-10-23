// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ---------------------------------------------------------------------------
// Combined single-pass pre-scan (replaces 4 separate EntityScanner passes)
// ---------------------------------------------------------------------------

/// Data collected during the combined single-pass scan.
/// For a 487 MB file this saves ~2-3 s by eliminating redundant full-file scans.
pub(crate) struct PrePassData {
    /// The shared post-scan resolution (styles, material chain, voids) — the
    /// exact resolver the native pipeline and the streaming prepass run.
    pub resolved: ifc_lite_processing::prepass::ResolvedPrepass,
    /// #5582 authored finish per styled representation item, from the same
    /// styled-item spans (`resolve_geometry_finishes`); feeds `styleFinishes`.
    pub geometry_finishes: rustc_hash::FxHashMap<u32, ifc_lite_processing::style::SpecularMaterial>,
    /// IfcProject entity ID (for unit extraction)
    pub project_id: Option<u32>,
    /// IfcSite entity position (id, start, end) — for building rotation extraction
    pub site_position: Option<(u32, usize, usize)>,
    /// Simple geometry jobs (walls, slabs …) — processed first for fast first frame
    pub simple_jobs: Vec<(u32, usize, usize, ifc_lite_core::IfcType)>,
    /// Complex geometry jobs (windows, doors, furniture …)
    pub complex_jobs: Vec<(u32, usize, usize, ifc_lite_core::IfcType)>,
}

/// Single EntityScanner pass that collects everything needed before geometry
/// processing: the scan loop stashes spans, and ALL semantic resolution
/// (styled-item precedence, #663/#858 indexed colours, the #407 material
/// chain, voids + #845 aggregate propagation) runs in the SHARED
/// `ifc_lite_processing::prepass::resolve_prepass` — the same code the native
/// pipeline and `buildPrePassStreaming` run.
pub(crate) fn combined_pre_pass(
    content: &[u8],
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> PrePassData {
    use ifc_lite_core::{keyword_eq, EntityScanner};
    use ifc_lite_processing::prepass::{
        resolve_geometry_finishes, resolve_prepass, PrepassSpans, ResolveOptions,
    };

    let estimated_elements = content.len() / 2000;

    let mut spans = PrepassSpans::default();
    let mut project_id: Option<u32> = None;
    let mut site_position: Option<(u32, usize, usize)> = None;
    let mut simple_jobs = Vec::with_capacity(estimated_elements / 2);
    let mut complex_jobs = Vec::with_capacity(estimated_elements / 2);

    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if spans.stash(type_name, id, start, end) {
            continue;
        }
        if keyword_eq(type_name, "IFCPROJECT") {
            if project_id.is_none() {
                project_id = Some(id);
            }
        } else if keyword_eq(type_name, "IFCSITE") {
            if site_position.is_none() {
                site_position = Some((id, start, end));
            }
            let ifc_type = ifc_lite_core::ifc_type_from_keyword(type_name);
            complex_jobs.push((id, start, end, ifc_type));
        } else if ifc_lite_core::has_geometry_by_name(type_name) {
            let ifc_type = ifc_lite_core::ifc_type_from_keyword(type_name);
            if ifc_lite_core::is_simple_geometry_type(type_name) {
                simple_jobs.push((id, start, end, ifc_type));
            } else {
                complex_jobs.push((id, start, end, ifc_type));
            }
        } else if ifc_lite_core::is_representationless_spatial_container_by_name(type_name)
            && ifc_lite_core::nth_attribute_is_present(&content[start..end], 6)
        {
            // #1910 (third instance, Greptile-flagged displaced-path
            // gap: this single-shot `buildPrePassOnce` combined scan
            // is a third geometry-job discovery path, alongside the
            // serial streaming scan (`gpu_meshes/prepass.rs`) and the
            // sharded column scan (`processing/shard_classes.rs`),
            // and had the identical `has_geometry_by_name` gap. A
            // spatial container it blocks by name (`IfcBuilding` et
            // al.) that exceptionally carries a non-null
            // Representation must still be scheduled, or small files
            // routed through this one-shot path keep rendering
            // nothing. Filed as complex (not simple) — it is never
            // one of the named simple element types.
            let ifc_type = ifc_lite_core::ifc_type_from_keyword(type_name);
            complex_jobs.push((id, start, end, ifc_type));
        }
    }

    // Shared post-scan resolution. Full per-triangle palettes stay per-worker
    // rebuilds (`get_or_build_indexed_colour_maps`); the prepass only ships
    // the dominant colours on the wire.
    let resolved = resolve_prepass(
        &spans,
        decoder,
        ResolveOptions {
            collect_indexed_colour_full: false,
            defer_attached_styles: false,
        },
    );
    // Full resolution (never defer mode here), so every styled item is walked.
    let geometry_finishes = resolve_geometry_finishes(&spans.styled_items, decoder);

    // #957 + Model/Types switch: emit IfcTypeProduct RepresentationMap geometry
    // (annex-E orphan types AND instanced type-library shapes). processGeometryBatch
    // tags each with a geometry_class so the viewer can show/hide it per view mode.
    complex_jobs.extend(collect_type_geometry_jobs(content, decoder));

    PrePassData {
        resolved,
        geometry_finishes,
        project_id,
        site_position,
        simple_jobs,
        complex_jobs,
    }
}

/// Collect render jobs for `IfcTypeProduct` `RepresentationMap` geometry — every
/// type carrying at least one map that no `IfcMappedItem` already draws.
///
/// Returns `(id, start, end, ifc_type)` per type, appended to the prepass job
/// list. `processGeometryBatch` turns each into geometry via
/// [`ifc_lite_geometry::GeometryRouter::process_representation_map`] and tags it
/// with a `geometry_class` — orphan (no occurrence) vs instanced (an
/// `IfcRelDefinesByType` links it to an occurrence) — so the viewer's Model/Types
/// switch can show or hide it (see `gpu_meshes.rs`). A map already referenced by
/// an `IfcMappedItem` is drawn through its occurrence's mapped representation, so
/// a type whose maps are ALL referenced yields no renderable job and is skipped.
///
/// buildingSMART annex-E "tessellated shape with style" files declare geometry
/// only on the type (orphan, class 1); ArchiCAD/AC20 files attach a map to nearly
/// every instanced type while the occurrence carries its own body (class 2,
/// hidden in Model mode so it does not double-render at the MappingOrigin).
pub(crate) fn collect_type_geometry_jobs(
    content: &[u8],
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Vec<(u32, usize, usize, ifc_lite_core::IfcType)> {
    use ifc_lite_core::{keyword_eq, EntityScanner};
    use ifc_lite_processing::plan::{TypeGeometryCandidate, TypeGeometryPlan};

    // Fast bail-out: type geometry can only exist when the file authors at least
    // one IfcRepresentationMap. The overwhelming majority of files pay only a
    // single substring search instead of a full entity scan + decode.
    if ifc_lite_core::find_keyword(content, b"IFCREPRESENTATIONMAP").is_none() {
        return Vec::new();
    }

    // Single pass: gather the IfcMappedItem-referenced RepresentationMaps and the
    // type-product candidates, then drop types whose maps are all referenced
    // (those are drawn through their occurrence's mapped representation). The
    // orphan-vs-instanced class is assigned later, in the render loop.
    let mut plan = TypeGeometryPlan::default();

    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if keyword_eq(type_name, "IFCMAPPEDITEM") {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // IfcMappedItem.MappingSource = attr 0.
                if let Some(source_id) = entity.get_ref(0) {
                    plan.observe_mapped(id, source_id, false);
                }
            }
        } else if let Some(ifc_type) = ifc_lite_core::type_product_ifc_type(type_name) {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // IfcTypeProduct.RepresentationMaps = attr 6.
                let rep_maps: Vec<u32> = entity
                    .get(6)
                    .and_then(|a| a.as_list())
                    .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
                    .unwrap_or_default();
                if !rep_maps.is_empty() {
                    plan.observe_candidate(TypeGeometryCandidate { id, start, end, ifc_type, maps: rep_maps });
                }
            }
        }
    }

    plan.into_browser_jobs()
}

/// Consume the streaming prepass's existing facts without re-reading mapped items.
pub(crate) fn collect_type_geometry_jobs_with_plan(
    mut plan: ifc_lite_processing::plan::TypeGeometryPlan,
    spans: &[(u32, usize, usize, ifc_lite_core::IfcType)],
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Vec<(u32, usize, usize, ifc_lite_core::IfcType)> {
    for (id, start, end, ifc_type) in spans {
        if let Ok(entity) = decoder.decode_at_with_id(*id, *start, *end) {
            // Keep the existing list-only admission: bare refs are not candidates.
            let maps = entity.attr(ifc_lite_core::slot::IfcTypeProduct::REPRESENTATION_MAPS)
                .and_then(|value| value.as_list())
                .map(|list| list.iter().filter_map(|value| value.as_entity_ref()).collect())
                .unwrap_or_default();
            plan.observe_candidate(ifc_lite_processing::plan::TypeGeometryCandidate {
                id: *id, start: *start, end: *end, ifc_type: ifc_type.clone(), maps,
            });
        }
    }
    plan.into_browser_jobs()
}

/// Build shared type/instance facts once for browser prepass columns (#7782).
/// Read mapped items before type relationships, preserving admission order.
pub(crate) fn build_type_geometry_plan_from_spans(
    mapped: &[(u32, usize, usize)],
    defined_types: &[(u32, usize, usize)],
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> ifc_lite_processing::plan::TypeGeometryPlan {
    use ifc_lite_core::slot;
    let mut plan = ifc_lite_processing::plan::TypeGeometryPlan::default();
    for &(id, start, end) in mapped {
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            if let Some(source) = entity.ref_at(slot::IfcMappedItem::MAPPING_SOURCE) {
                plan.observe_mapped(id, source, true);
            }
        }
    }
    for &(id, start, end) in defined_types {
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            if let Some(type_id) = entity.ref_at(slot::IfcRelDefinesByType::RELATING_TYPE) {
                plan.observe_instantiated_type(type_id);
            }
        }
    }
    plan
}

// Site/building rotation now lives in the shared streaming-prepass meta
// resolver (`ifc_lite_processing::stream_meta`) alongside the unit-scale and
// RTC resolution the three pre-pass emission points all consume, so it can no
// longer drift between them. (It is still derived from the canonical resolved
// placement matrix `GeometryRouter::resolve_scaled_placement` + the shared
// `ifc_lite_geometry::rotation_angle_about_z`.)

#[cfg(test)]
#[path = "prepass_orphan_type_tests.rs"]
mod orphan_type_from_spans_tests;

#[cfg(test)]
#[path = "prepass_issue_1910_tests.rs"]
mod combined_pre_pass_issue_1910_tests;

#[cfg(test)]
#[path = "prepass_issue_3187_tests.rs"]
mod combined_pre_pass_issue_3187_tests;
