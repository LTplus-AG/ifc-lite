// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Styling, color extraction, and building rotation for IFC-Lite API

/// Find color for a geometry item, following MappedItem references if needed.
/// This handles the case where IfcStyledItem points to geometry inside a MappedRepresentation,
/// not to the MappedItem itself.
pub(crate) fn find_color_for_geometry(
    geom_id: u32,
    geometry_styles: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
    use ifc_lite_core::IfcType;

    // First check if this geometry ID directly has a color
    if let Some(&color) = geometry_styles.get(&geom_id) {
        return Some(color);
    }

    // If not, check if it's an IfcMappedItem and follow the reference
    let geom = decoder.decode_by_id(geom_id).ok()?;

    if geom.ifc_type == IfcType::IfcMappedItem {
        // IfcMappedItem: MappingSource (IfcRepresentationMap ref), MappingTarget
        let map_source_id = geom.get_ref(0)?;

        // Decode the IfcRepresentationMap
        let rep_map = decoder.decode_by_id(map_source_id).ok()?;

        // IfcRepresentationMap: MappingOrigin (IfcAxis2Placement), MappedRepresentation (IfcShapeRepresentation)
        let mapped_repr_id = rep_map.get_ref(1)?;

        // Decode the mapped IfcShapeRepresentation
        let mapped_repr = decoder.decode_by_id(mapped_repr_id).ok()?;

        // IfcShapeRepresentation: ContextOfItems, RepresentationIdentifier, RepresentationType, Items
        // Attribute 3: Items (list of geometry items)
        let items_attr = mapped_repr.get(3)?;
        let items_list = items_attr.as_list()?;

        // Check each underlying geometry item for a color
        for item in items_list {
            if let Some(underlying_geom_id) = item.as_entity_ref() {
                // Recursively find color (handles nested MappedItems)
                if let Some(color) =
                    find_color_for_geometry(underlying_geom_id, geometry_styles, decoder)
                {
                    return Some(color);
                }
            }
        }
    }

    None
}

/// Extract `(apparent_color, shading_color)` from IfcStyledItem.Styles.
/// See [`ifc_lite_processing::style::extract_surface_style_colors`] for the
/// tuple semantics.
pub(crate) fn extract_color_pair_from_styles(
    styles_attr: &ifc_lite_core::AttributeValue,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<([f32; 4], Option<[f32; 4]>)> {
    // Styles can be a list or a single reference
    if let Some(list) = styles_attr.as_list() {
        for item in list {
            if let Some(style_id) = item.as_entity_ref() {
                if let Some(pair) = extract_color_from_style_assignment(style_id, decoder) {
                    return Some(pair);
                }
            }
        }
    } else if let Some(style_id) = styles_attr.as_entity_ref() {
        return extract_color_from_style_assignment(style_id, decoder);
    }

    None
}

/// Convenience wrapper returning only the rendering colour. Most callers
/// don't need the shading variant — the GLB-export pre-pass is the only
/// consumer of the pair today.
pub(crate) fn extract_color_from_styles(
    styles_attr: &ifc_lite_core::AttributeValue,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
    extract_color_pair_from_styles(styles_attr, decoder).map(|(c, _)| c)
}

/// Extract colour from `IfcPresentationStyle(Assignment)` or `IfcSurfaceStyle`,
/// delegating the surface-style colour leaf to the canonical
/// [`ifc_lite_processing::style::extract_surface_style_colors`] (#913-style
/// single source of truth — so the viewer and server can't disagree on
/// `SurfaceColour` vs `DiffuseColour` precedence). Returns
/// `(apparent_color, optional_shading_color)`.
fn extract_color_from_style_assignment(
    style_id: u32,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<([f32; 4], Option<[f32; 4]>)> {
    use ifc_lite_core::IfcType;

    let style = decoder.decode_by_id(style_id).ok()?;

    match style.ifc_type {
        IfcType::IfcPresentationStyle => {
            // IfcPresentationStyle has Styles at attr 0.
            let styles_attr = style.get(0)?;
            if let Some(list) = styles_attr.as_list() {
                for item in list {
                    if let Some(inner_id) = item.as_entity_ref() {
                        if let Some(pair) = ifc_lite_processing::style::extract_surface_style_colors(
                            inner_id, decoder,
                        ) {
                            return Some(pair);
                        }
                    }
                }
            }
        }
        IfcType::IfcSurfaceStyle => {
            return ifc_lite_processing::style::extract_surface_style_colors(style_id, decoder);
        }
        _ => {
            // IfcPresentationStyleAssignment (IFC2x3 entity absent from the IFC4
            // schema) decodes as Unknown; its Styles list is at attribute 0.
            let styles_attr = style.get(0)?;
            if let Some(list) = styles_attr.as_list() {
                for item in list {
                    if let Some(inner_id) = item.as_entity_ref() {
                        if let Some(pair) = ifc_lite_processing::style::extract_surface_style_colors(
                            inner_id, decoder,
                        ) {
                            return Some(pair);
                        }
                    }
                }
            }
        }
    }

    None
}

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


/// Resolve element color inline during processing by following its
/// representation chain. Replaces the upfront `build_element_style_index`
/// scan — avoids decoding every building element twice.
///
/// Resolution order (preserves IFC precedence — direct IfcStyledItem on a
/// geometry item must win over an element-level material chain):
///
/// 1. **Direct geometry-item colour.** Walk every `IfcShapeRepresentation`
///    in the product definition and ask `geometry_styles` for any item's
///    colour. Items here are `IfcExtrudedAreaSolid`, `IfcMappedItem`, etc.;
///    `find_color_for_geometry` chases `IfcMappedItem` into its underlying
///    representation map.
///
/// 2. **Element-keyed material fallback.** When the prepass folded the
///    element's resolved material colour into `geometry_styles` keyed by
///    the element's own express ID (`buildPrePassStreaming` does this for
///    every entry in `element_material_styles` — see the prepass body in
///    `gpu_meshes.rs`), pick that colour up here. Files that author colour
///    **only** through the `IfcMaterial` → orphan `IfcStyledItem` →
///    `IfcStyledRepresentation` → `IfcMaterialDefinitionRepresentation`
///    chain — schependomlaan.ifc and most ArchiCAD / Revit IFC2x3 exports
///    — land here. Without this fallback the data the prepass already
///    computed sits unused and every such element renders as the per-type
///    grey default.
pub(crate) fn resolve_element_color(
    entity: &ifc_lite_core::DecodedEntity,
    geometry_styles: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
    if geometry_styles.is_empty() {
        return None;
    }

    if let Some(color) = walk_representation_for_direct_color(entity, geometry_styles, decoder) {
        return Some(color);
    }

    geometry_styles.get(&entity.id).copied()
}

/// Walk an element's representation chain looking for a colour attached
/// directly to a geometry item. Split out so a missing or malformed
/// representation can't short-circuit past the material-chain fallback in
/// [`resolve_element_color`].
fn walk_representation_for_direct_color(
    entity: &ifc_lite_core::DecodedEntity,
    geometry_styles: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
    let repr_id = entity.get_ref(6)?;
    let product_shape = decoder.decode_by_id(repr_id).ok()?;
    let reprs_list = product_shape.get(2)?.as_list()?;

    for repr_item in reprs_list {
        let Some(shape_repr_id) = repr_item.as_entity_ref() else {
            continue;
        };
        let Ok(shape_repr) = decoder.decode_by_id(shape_repr_id) else {
            continue;
        };
        let Some(items_list) = shape_repr.get(3).and_then(|a| a.as_list()) else {
            continue;
        };

        for geom_item in items_list {
            let Some(geom_id) = geom_item.as_entity_ref() else {
                continue;
            };
            if let Some(color) = find_color_for_geometry(geom_id, geometry_styles, decoder) {
                return Some(color);
            }
        }
    }

    None
}

// Default IFC-type colors now come from the single canonical table in
// `ifc_lite_processing::default_color_for_type` (issue #913). The browser path
// calls it directly (see `gpu_meshes.rs`); do not reintroduce a table here.

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

#[cfg(test)]
mod resolve_element_color_tests {
    //! Locks in `resolve_element_color`'s precedence: direct
    //! `IfcStyledItem`-on-geometry-item wins over the element-keyed
    //! material-chain fallback that the streaming prepass folds into
    //! `geometry_styles`. The fallback exists so files that author colour
    //! **only** via the material chain (schependomlaan.ifc and most
    //! ArchiCAD/Revit IFC2x3 exports) stop rendering as default grey.
    use super::resolve_element_color;
    use ifc_lite_core::{build_entity_index, EntityDecoder};
    use rustc_hash::FxHashMap;

    /// Minimal IFC4 wall whose body is a single `IfcExtrudedAreaSolid`.
    /// Express IDs:
    ///   #1 wall, #2 product-def-shape, #3 shape-rep, #5 extrusion.
    /// Tests put colours under #1 (element-keyed material chain) and/or
    /// #5 (direct geometry-item) to exercise each resolution path.
    const WALL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test','2026-05-27',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('w',$,'Wall',$,$,$,#2,$,.NOTDEFINED.);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#5));
#4=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#6,$);
#5=IFCEXTRUDEDAREASOLID(#7,#6,#8,3000.);
#6=IFCAXIS2PLACEMENT3D(#9,$,$);
#7=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,200.,4000.);
#8=IFCDIRECTION((0.,0.,1.));
#9=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
"#;

    fn decode_wall() -> (EntityDecoder<'static>, ifc_lite_core::DecodedEntity) {
        // Leak the content so the decoder can hold a 'static borrow — only
        // safe inside `#[cfg(test)]` and keeps the call sites tidy.
        let content: &'static str = Box::leak(WALL_IFC.to_string().into_boxed_str());
        let idx = build_entity_index(content);
        let mut decoder = EntityDecoder::with_index(content, idx);
        let wall = decoder.decode_by_id(1).expect("decode wall #1");
        (decoder, wall)
    }

    #[test]
    fn empty_geometry_styles_returns_none() {
        let (mut decoder, wall) = decode_wall();
        let styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        assert_eq!(resolve_element_color(&wall, &styles, &mut decoder), None);
    }

    #[test]
    fn direct_geometry_item_color_resolves_via_rep_walk() {
        let (mut decoder, wall) = decode_wall();
        let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        // Colour keyed on the extrusion #5 — direct IfcStyledItem path.
        styles.insert(5, [0.1, 0.8, 0.2, 1.0]);
        assert_eq!(
            resolve_element_color(&wall, &styles, &mut decoder),
            Some([0.1, 0.8, 0.2, 1.0]),
        );
    }

    #[test]
    fn element_id_keyed_material_color_resolves_via_fallback() {
        let (mut decoder, wall) = decode_wall();
        let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        // Colour keyed on the wall itself — material-chain fallback path
        // (prepass folds element_material_styles into geometry_styles
        // keyed by element express ID).
        styles.insert(1, [0.8, 0.2, 0.1, 1.0]);
        assert_eq!(
            resolve_element_color(&wall, &styles, &mut decoder),
            Some([0.8, 0.2, 0.1, 1.0]),
        );
    }

    #[test]
    fn direct_color_wins_over_material_fallback() {
        let (mut decoder, wall) = decode_wall();
        let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        // Both present — the IfcStyledItem on the extrusion must win per
        // IFC precedence. Inverting this order was the bug in the first
        // attempt at the fix (PR-reverted) and would silently override
        // direct authoring with material defaults.
        styles.insert(1, [0.8, 0.2, 0.1, 1.0]); // material → red
        styles.insert(5, [0.1, 0.8, 0.2, 1.0]); // direct  → green
        assert_eq!(
            resolve_element_color(&wall, &styles, &mut decoder),
            Some([0.1, 0.8, 0.2, 1.0]),
            "direct geometry-item colour must win over material fallback",
        );
    }

    #[test]
    fn unrelated_colors_yield_none() {
        let (mut decoder, wall) = decode_wall();
        let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        // Unrelated express ID — neither the wall nor any item in its rep.
        styles.insert(999, [0.5, 0.5, 0.5, 1.0]);
        assert_eq!(resolve_element_color(&wall, &styles, &mut decoder), None);
    }
}
