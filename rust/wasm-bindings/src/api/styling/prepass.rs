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
pub(crate) fn combined_pre_pass(content: &[u8], decoder: &mut ifc_lite_core::EntityDecoder) -> PrePassData {
    use ifc_lite_core::EntityScanner;
    use ifc_lite_processing::prepass::{resolve_geometry_finishes, resolve_prepass, ResolveOptions};

    let estimated_elements = content.len() / 2000;

    let mut discovery = ifc_lite_processing::discovery::Discovery::default();
    let mut site_position: Option<(u32, usize, usize)> = None;
    let mut simple_jobs = Vec::with_capacity(estimated_elements / 2);
    let mut complex_jobs = Vec::with_capacity(estimated_elements / 2);

    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        let class = ifc_lite_processing::scan::ScanClass::classify(type_name);
        let job = discovery.observe_browser(content, class, id, type_name, start, end);
        if class == ifc_lite_processing::scan::ScanClass::Site {
            site_position.get_or_insert((id, start, end));
        }
        if let Some(ty) = job {
            let jobs = if ifc_lite_core::has_geometry_by_name(type_name) && ifc_lite_core::is_simple_geometry_type(type_name) {
                &mut simple_jobs
            } else {
                &mut complex_jobs
            };
            jobs.push((id, start, end, ty));
        }
    }
    let spans = discovery.prepass_spans;
    let project_id = discovery.project_id;

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

    // Fast bail-out: type geometry can only exist when the file authors at least
    // one IfcRepresentationMap. The overwhelming majority of files pay only a
    // single substring search instead of a full entity scan + decode.
    if ifc_lite_core::find_keyword(content, b"IFCREPRESENTATIONMAP").is_none() {
        return Vec::new();
    }

    let mut mapped = Vec::new();
    let mut candidates = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if keyword_eq(type_name, "IFCMAPPEDITEM") {
            mapped.push((id, start, end));
        } else if let Some(ty) = ifc_lite_core::type_product_ifc_type(type_name) {
            candidates.push((id, start, end, ty));
        }
    }
    collect_type_geometry_jobs_from_spans(content, &mapped, &candidates, decoder)
}

/// Span-based twin of [`collect_type_geometry_jobs`]. The streaming pre-pass
/// stashes both the `IfcMappedItem` spans and the `IfcTypeProduct` candidate
/// spans (with their resolved `IfcType`, computed from the scanner's `type_name`)
/// during its single scan, so this reuses them instead of re-walking the whole
/// file — the #957/#962 second `EntityScanner` pass. Byte-identical: same
/// referenced set (same mapped-item spans, file order), same candidates (same
/// type spans in file order, same attr-6 RepresentationMaps decode), same
/// unreferenced-map filter, same output order.
pub(crate) fn collect_type_geometry_jobs_from_spans(
    content: &[u8],
    mapped_item_spans: &[(u32, usize, usize)],
    type_candidate_spans: &[(u32, usize, usize, ifc_lite_core::IfcType)],
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Vec<(u32, usize, usize, ifc_lite_core::IfcType)> {
    ifc_lite_processing::discovery::TypeGeometryPlan::from_spans(
        content, mapped_item_spans, &[], type_candidate_spans, decoder,
        ifc_lite_processing::element::TypeGeometryMode::EmitTagged,
    ).jobs()
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
