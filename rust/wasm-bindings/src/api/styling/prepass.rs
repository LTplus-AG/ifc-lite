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
    use ifc_lite_core::EntityScanner;
    use ifc_lite_processing::prepass::{resolve_prepass, PrepassSpans, ResolveOptions};

    let estimated_elements = content.len() / 2000;

    let mut spans = PrepassSpans::default();
    let mut project_id: Option<u32> = None;
    let mut site_position: Option<(u32, usize, usize)> = None;
    let mut simple_jobs = Vec::with_capacity(estimated_elements / 2);
    let mut complex_jobs = Vec::with_capacity(estimated_elements / 2);

    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        match type_name {
            "IFCSTYLEDITEM" => spans.styled_items.push((id, start, end)),
            "IFCINDEXEDCOLOURMAP" => spans.indexed_colour_maps.push((id, start, end)),
            "IFCMATERIALDEFINITIONREPRESENTATION" => {
                spans.material_def_reprs.push((id, start, end))
            }
            "IFCRELASSOCIATESMATERIAL" => spans.rel_associates_material.push((id, start, end)),
            "IFCRELVOIDSELEMENT" => spans.void_rels.push((id, start, end)),
            "IFCRELFILLSELEMENT" => spans.fills_rels.push((id, start, end)),
            "IFCRELAGGREGATES" => spans.aggregate_rels.push((id, start, end)),
            "IFCPROJECT" => {
                if project_id.is_none() {
                    project_id = Some(id);
                }
            }
            "IFCSITE" => {
                if site_position.is_none() {
                    site_position = Some((id, start, end));
                }
                let ifc_type = ifc_lite_core::IfcType::from_str(type_name);
                complex_jobs.push((id, start, end, ifc_type));
            }
            _ => {
                if ifc_lite_core::has_geometry_by_name(type_name) {
                    let ifc_type = ifc_lite_core::IfcType::from_str(type_name);
                    if ifc_lite_core::is_simple_geometry_type(type_name) {
                        simple_jobs.push((id, start, end, ifc_type));
                    } else {
                        complex_jobs.push((id, start, end, ifc_type));
                    }
                }
            }
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

    // #957 + Model/Types switch: emit IfcTypeProduct RepresentationMap geometry
    // (annex-E orphan types AND instanced type-library shapes). processGeometryBatch
    // tags each with a geometry_class so the viewer can show/hide it per view mode.
    complex_jobs.extend(collect_type_geometry_jobs(content, decoder));

    PrePassData {
        resolved,
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
    use ifc_lite_core::{EntityScanner, IfcType};

    // Fast bail-out: type geometry can only exist when the file authors at least
    // one IfcRepresentationMap. The overwhelming majority of files pay only a
    // single substring search instead of a full entity scan + decode.
    if !content
        .windows(b"IFCREPRESENTATIONMAP".len())
        .any(|window| window == b"IFCREPRESENTATIONMAP")
    {
        return Vec::new();
    }

    // Single pass: gather the IfcMappedItem-referenced RepresentationMaps and the
    // type-product candidates, then drop types whose maps are all referenced
    // (those are drawn through their occurrence's mapped representation). The
    // orphan-vs-instanced class is assigned later, in the render loop.
    let mut referenced: rustc_hash::FxHashSet<u32> = rustc_hash::FxHashSet::default();
    let mut candidates: Vec<(u32, usize, usize, IfcType, Vec<u32>)> = Vec::new();

    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCMAPPEDITEM" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // IfcMappedItem.MappingSource = attr 0.
                if let Some(source_id) = entity.get_ref(0) {
                    referenced.insert(source_id);
                }
            }
        } else if type_name.ends_with("TYPE") || type_name.ends_with("STYLE") {
            // Cheap suffix pre-filter keeps the is_subtype_of check off the hot
            // path for the all-non-type majority of entities.
            let ifc_type = IfcType::from_str(type_name);
            if !ifc_type.is_subtype_of(IfcType::IfcTypeProduct) {
                continue;
            }
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // IfcTypeProduct.RepresentationMaps = attr 6.
                let rep_maps: Vec<u32> = entity
                    .get(6)
                    .and_then(|a| a.as_list())
                    .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
                    .unwrap_or_default();
                if !rep_maps.is_empty() {
                    candidates.push((id, start, end, ifc_type, rep_maps));
                }
            }
        }
    }

    candidates
        .into_iter()
        .filter(|(_, _, _, _, maps)| maps.iter().any(|rm| !referenced.contains(rm)))
        .map(|(id, start, end, ifc_type, _)| (id, start, end, ifc_type))
        .collect()
}

/// #957: the set of `RepresentationMap`s instantiated by an `IfcMappedItem`, so
/// `processGeometryBatch` can tell which of a type's RepresentationMaps are
/// orphan (rendered directly) vs already drawn through an occurrence.
pub(crate) fn build_referenced_representation_maps(
    content: &[u8],
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> rustc_hash::FxHashSet<u32> {
    use ifc_lite_core::EntityScanner;
    let mut referenced: rustc_hash::FxHashSet<u32> = rustc_hash::FxHashSet::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCMAPPEDITEM" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // IfcMappedItem.MappingSource = attr 0 (the IfcRepresentationMap).
                if let Some(source_id) = entity.get_ref(0) {
                    referenced.insert(source_id);
                }
            }
        }
    }
    referenced
}

/// #957 follow-up: the set of type ids that an `IfcRelDefinesByType` instantiates
/// (i.e. the type has at least one occurrence). `processGeometryBatch` uses it to
/// suppress type-only geometry for such types — their geometry is already drawn
/// through their occurrences, so rendering the type's RepresentationMap as well
/// would double-render it at the MappingOrigin (duplicate at the wrong position).
pub(crate) fn build_instantiated_type_ids(
    content: &[u8],
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> rustc_hash::FxHashSet<u32> {
    use ifc_lite_core::EntityScanner;
    let mut instantiated: rustc_hash::FxHashSet<u32> = rustc_hash::FxHashSet::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELDEFINESBYTYPE" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // IfcRelDefinesByType.RelatingType = attr 5 (the typed product).
                if let Some(type_id) = entity.get_ref(5) {
                    instantiated.insert(type_id);
                }
            }
        }
    }
    instantiated
}

/// Site/building rotation angle (radians) for the viewer's render-frame
/// rotation, or `None` if absent. Derived from the **canonical** resolved
/// placement matrix (`GeometryRouter::resolve_scaled_placement`) + the shared
/// [`ifc_lite_geometry::rotation_angle_about_z`], so it cannot drift from the
/// processor's site-local frame on nested / scaled / tilted placements (the old
/// `atan2`-of-raw-top-level-RefDirection walk was incomplete for those).
pub(crate) fn extract_building_rotation_from_site(
    site_pos: (u32, usize, usize),
    router: &ifc_lite_geometry::GeometryRouter,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<f64> {
    let (site_id, start, end) = site_pos;
    let site_entity = decoder.decode_at_with_id(site_id, start, end).ok()?;
    let matrix = router
        .resolve_scaled_placement(&site_entity, decoder)
        .ok()?;
    ifc_lite_geometry::rotation_angle_about_z(&matrix)
}
