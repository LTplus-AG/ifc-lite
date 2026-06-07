// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Styling, color extraction, and building rotation for IFC-Lite API

/// Resolve the geometry ID + dominant colour from an `IfcIndexedColourMap`.
///
/// Schema (IFC4):
/// - attr 0: `MappedTo` → IfcTessellatedFaceSet (target geometry)
/// - attr 1: `Opacity` (optional REAL, 0..1 — 1.0 when omitted)
/// - attr 2: `Colours` → IfcColourRgbList
/// - attr 3: `ColourIndex` → list of 1-based indices into `Colours`
///
/// CATIA exports almost always reference a single colour, so picking
/// `colour[ColourIndex[0]]` is the right call. For multi-colour maps we
/// pick the most-frequent index — captures the dominant tone, leaves the
/// per-face variation for a future mesh-data upgrade.
///
/// Used by the streaming pre-pass in `gpu_meshes.rs` which has already
/// collected entity spans during its scan — hence the span-based signature
/// rather than entity-id-only.
pub(crate) fn extract_color_from_indexed_colour_map_span(
    id: u32,
    start: usize,
    end: usize,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<(u32, [f32; 4])> {
    extract_color_from_indexed_colour_map(id, start, end, decoder)
}

fn extract_color_from_indexed_colour_map(
    id: u32,
    start: usize,
    end: usize,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<(u32, [f32; 4])> {
    // Delegate to the canonical resolver in `ifc_lite_processing::style`
    // (issue #913, Phase 2e). The browser keeps only the span→entity decode;
    // the dominant-colour logic lives once, shared with the backend.
    let entity = decoder.decode_at_with_id(id, start, end).ok()?;
    let map = ifc_lite_processing::style::resolve_indexed_colour_map_full(&entity, decoder)?;
    Some((map.geometry_id, map.dominant().to_array()))
}

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

/// Extract `(rendering_color, shading_color)` from IfcStyledItem.Styles.
/// See `extract_color_from_rendering` for the tuple semantics.
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

/// Extract color from IfcPresentationStyleAssignment or IfcSurfaceStyle.
/// See `extract_color_from_rendering` for the tuple semantics.
fn extract_color_from_style_assignment(
    style_id: u32,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<([f32; 4], Option<[f32; 4]>)> {
    use ifc_lite_core::IfcType;

    let style = decoder.decode_by_id(style_id).ok()?;

    match style.ifc_type {
        IfcType::IfcPresentationStyle => {
            // IfcPresentationStyle has Styles at attr 0
            let styles_attr = style.get(0)?;
            if let Some(list) = styles_attr.as_list() {
                for item in list {
                    if let Some(inner_id) = item.as_entity_ref() {
                        if let Some(pair) = extract_color_from_surface_style(inner_id, decoder) {
                            return Some(pair);
                        }
                    }
                }
            }
        }
        IfcType::IfcSurfaceStyle => {
            return extract_color_from_surface_style(style_id, decoder);
        }
        _ => {
            // FIX: Handle IfcPresentationStyleAssignment (IFC2x3 entity not in IFC4 schema)
            // IfcPresentationStyleAssignment has Styles list at attribute 0
            // It's decoded as Unknown type, so we check by structure
            let styles_attr = style.get(0)?;
            if let Some(list) = styles_attr.as_list() {
                for item in list {
                    if let Some(inner_id) = item.as_entity_ref() {
                        if let Some(pair) = extract_color_from_surface_style(inner_id, decoder) {
                            return Some(pair);
                        }
                    }
                }
            }
        }
    }

    None
}

/// Extract color from IfcSurfaceStyle. See `extract_color_from_rendering`
/// for the meaning of the tuple.
fn extract_color_from_surface_style(
    style_id: u32,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<([f32; 4], Option<[f32; 4]>)> {
    use ifc_lite_core::IfcType;

    let style = decoder.decode_by_id(style_id).ok()?;

    if style.ifc_type != IfcType::IfcSurfaceStyle {
        return None;
    }

    // IfcSurfaceStyle: Name, Side, Styles (list of surface style elements)
    // Attribute 2: Styles
    let styles_attr = style.get(2)?;

    if let Some(list) = styles_attr.as_list() {
        for item in list {
            if let Some(element_id) = item.as_entity_ref() {
                if let Some(pair) = extract_color_from_rendering(element_id, decoder) {
                    return Some(pair);
                }
            }
        }
    }

    None
}

/// Extract color from IfcSurfaceStyleRendering or IfcSurfaceStyleShading.
///
/// Returns `(rendering_color, shading_color)`:
///   - `rendering_color` is the apparent surface colour: `SurfaceColour`
///     (attr 0) by default, scaled by `DiffuseColour` (attr 2) when the
///     author supplied it as an `IfcNormalisedRatioMeasure` factor.
///     Matches how web-ifc, IfcOpenShell, BlenderBIM, and the IFC spec
///     prose treat the chain — `SurfaceColour` IS the apparent surface
///     colour; `DiffuseColour` is the diffuse-reflection contribution
///     used by full PBR/Phong renderers and is meaningless for the flat
///     viewer pipeline when its only effect is to drop everything to
///     black.
///   - `shading_color` is the alternative the GLB exporter's "Shading"
///     source picks up — populated only when a distinct `DiffuseColour`
///     IfcColourRgb is authored, so downstream pipelines that DO want
///     the per-component diffuse override can still get it.
///
/// Pre-fix this preferred `DiffuseColour` over `SurfaceColour`. That
/// regressed on every IFC file that authors `DiffuseColour =
/// IfcColourRgb(0, 0, 0)` (which the spec defines as "no diffuse
/// reflection contribution", NOT "render the surface in black") — most
/// notably the railway fixture on issue #859 / PR #871, where every
/// IfcSignal / IfcReferent rendered as opaque black on the dark
/// viewport background and the user reported "viewport blank" even
/// though 33 meshes had streamed correctly.
fn extract_color_from_rendering(
    rendering_id: u32,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<([f32; 4], Option<[f32; 4]>)> {
    use ifc_lite_core::IfcType;

    let rendering = decoder.decode_by_id(rendering_id).ok()?;

    match rendering.ifc_type {
        IfcType::IfcSurfaceStyleRendering | IfcType::IfcSurfaceStyleShading => {
            // Attr 0: SurfaceColour (inherited from IfcSurfaceStyleShading)
            // Attr 1: Transparency (inherited, 0.0=opaque, 1.0=transparent)
            // Attr 2: DiffuseColour — SELECT(IfcColourRgb,
            //         IfcNormalisedRatioMeasure). Only on IfcSurfaceStyleRendering.
            let color_ref = rendering.get_ref(0)?;
            let [sr, sg, sb, _] = extract_color_rgb(color_ref, decoder)?;

            let transparency = rendering.get_float(1).unwrap_or(0.0);
            let alpha = (1.0 - transparency as f32).clamp(0.0, 1.0);
            let surface_rgba = [sr, sg, sb, alpha];

            // SurfaceColour is the canonical apparent colour. Only let
            // DiffuseColour modulate it when it's a normalised-ratio
            // factor (which IS a multiplicative modifier of
            // SurfaceColour per spec). When DiffuseColour is an
            // IfcColourRgb we store it as the optional `shading`
            // override for downstream consumers (GLB exporter's
            // "Shading" source) but do NOT use it as the rendered
            // colour — that would replace the entire surface tint
            // with a value the IFC author intended as a reflectance
            // coefficient, which turns most files black on the flat
            // viewer pipeline.
            let mut rendering_rgba = surface_rgba;
            let mut shading: Option<[f32; 4]> = None;

            if rendering.ifc_type == IfcType::IfcSurfaceStyleRendering {
                if let Some(diffuse_id) = rendering.get_ref(2) {
                    if let Some([dr, dg, db, _]) = extract_color_rgb(diffuse_id, decoder) {
                        let diffuse_rgba = [dr, dg, db, alpha];
                        // Surface the diffuse override to the GLB
                        // exporter only when it actually differs from
                        // the surface colour.
                        if diffuse_rgba != surface_rgba {
                            shading = Some(diffuse_rgba);
                        }
                    }
                } else if let Some(factor) = rendering.get_float(2) {
                    let f = (factor as f32).clamp(0.0, 1.0);
                    rendering_rgba = [sr * f, sg * f, sb * f, alpha];
                }
            }

            return Some((rendering_rgba, shading));
        }
        _ => {}
    }

    None
}

/// Extract RGB color from IfcColourRgb
fn extract_color_rgb(
    color_id: u32,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
    use ifc_lite_core::IfcType;

    let color = decoder.decode_by_id(color_id).ok()?;

    if color.ifc_type != IfcType::IfcColourRgb {
        return None;
    }

    // IfcColourRgb: Name, Red, Green, Blue
    // Note: In IFC2x3, attributes are at indices 1, 2, 3 (0 is Name)
    // In IFC4, attributes are also at 1, 2, 3
    let red = color.get_float(1).unwrap_or(0.8);
    let green = color.get_float(2).unwrap_or(0.8);
    let blue = color.get_float(3).unwrap_or(0.8);

    Some([red as f32, green as f32, blue as f32, 1.0])
}

// ---------------------------------------------------------------------------
// Combined single-pass pre-scan (replaces 4 separate EntityScanner passes)
// ---------------------------------------------------------------------------

/// Data collected during the combined single-pass scan.
/// For a 487 MB file this saves ~2-3 s by eliminating redundant full-file scans.
pub(crate) struct PrePassData {
    /// Geometry ID → apparent rendering color (IfcStyledItem →
    /// IfcSurfaceStyleRendering.DiffuseColour with SurfaceColour fallback,
    /// or IfcIndexedColourMap dominant colour).
    pub geometry_styles: rustc_hash::FxHashMap<u32, [f32; 4]>,
    /// Host element → opening elements (from IfcRelVoidsElement)
    pub void_index: rustc_hash::FxHashMap<u32, Vec<u32>>,
    /// FacetedBrep entity IDs for batch preprocessing
    pub faceted_brep_ids: Vec<u32>,
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
/// processing. Replaces the former sequence of:
///   build_geometry_style_index  (full scan)
///   build_element_style_index   (full scan + 208 K decodes)
///   pre-pass for void + brep    (full scan)
///   processing scan              (full scan)
pub(crate) fn combined_pre_pass(
    content: &str,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> PrePassData {
    use ifc_lite_core::EntityScanner;
    use rustc_hash::FxHashMap;

    let estimated_elements = content.len() / 2000;

    let mut geometry_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    // IfcIndexedColourMap side-map (#663). Merged into `geometry_styles` after
    // the scan so IfcStyledItem keeps precedence regardless of scan order.
    let mut colour_map_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut faceted_brep_ids: Vec<u32> = Vec::with_capacity(estimated_elements / 10);
    let mut project_id: Option<u32> = None;
    let mut site_position: Option<(u32, usize, usize)> = None;
    let mut simple_jobs = Vec::with_capacity(estimated_elements / 2);
    let mut complex_jobs = Vec::with_capacity(estimated_elements / 2);

    // Material chain collection: orphan styled items, material def reprs, rel associates
    // Orphan IfcStyledItem (null Item): styled_item_id → color
    let mut orphan_styled_items: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    // IfcMaterialDefinitionRepresentation: material_id → [styled_repr_id, ...]
    let mut material_def_reprs: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    // IfcRelAssociatesMaterial: element_id → material_select_id
    let mut element_to_material: FxHashMap<u32, u32> = FxHashMap::default();

    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        match type_name {
            "IFCSTYLEDITEM" => {
                if let Ok(styled_item) = decoder.decode_at_with_id(id, start, end) {
                    if let Some(geometry_id) = styled_item.get_ref(0) {
                        // Normal IfcStyledItem with Item reference → geometry_styles
                        if !geometry_styles.contains_key(&geometry_id) {
                            if let Some(styles_attr) = styled_item.get(1) {
                                if let Some(color) =
                                    extract_color_from_styles(styles_attr, decoder)
                                {
                                    geometry_styles.insert(geometry_id, color);
                                }
                            }
                        }
                    } else {
                        // Orphan IfcStyledItem (null Item) — material-based color
                        if let Some(styles_attr) = styled_item.get(1) {
                            if let Some(color) = extract_color_from_styles(styles_attr, decoder) {
                                orphan_styled_items.insert(id, color);
                            }
                        }
                    }
                }
            }
            "IFCINDEXEDCOLOURMAP" => {
                // IFC4 per-face-set colour mechanism used by CATIA /
                // 3DEXPERIENCE exports (#663). Held in a side map and merged
                // below with lower precedence than IfcStyledItem.
                if let Some((geometry_id, color)) =
                    extract_color_from_indexed_colour_map(id, start, end, decoder)
                {
                    colour_map_styles.entry(geometry_id).or_insert(color);
                }
            }
            "IFCMATERIALDEFINITIONREPRESENTATION" | "IFCRELASSOCIATESMATERIAL" => {
                collect_material_entity(
                    id,
                    type_name,
                    start,
                    end,
                    decoder,
                    &mut orphan_styled_items,
                    &mut material_def_reprs,
                    &mut element_to_material,
                );
            }
            "IFCRELVOIDSELEMENT" => {
                if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                    if let (Some(host_id), Some(opening_id)) =
                        (entity.get_ref(4), entity.get_ref(5))
                    {
                        void_index.entry(host_id).or_default().push(opening_id);
                    }
                }
            }
            "IFCFACETEDBREP" => {
                faceted_brep_ids.push(id);
            }
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

    // IfcStyledItem wins; only geometries WITHOUT a styled-item entry pick up
    // their IfcIndexedColourMap colour (#663). Done after the scan so scan
    // order doesn't decide precedence.
    for (geometry_id, color) in colour_map_styles {
        geometry_styles.entry(geometry_id).or_insert(color);
    }

    // Build material style index: material_id → [color, ...]
    // Chain: material → IfcMaterialDefinitionRepresentation → IfcStyledRepresentation → orphan IfcStyledItem
    let material_styles =
        build_material_style_index(&material_def_reprs, &orphan_styled_items, decoder);

    // Build element → material colors map
    let element_material_styles =
        build_element_material_styles(&element_to_material, &material_styles, decoder);

    // Flat material_id → color map; merge into geometry_styles so per-layer
    // slices (whose geometry_id = IfcMaterial id) resolve through the normal
    // path. IFC express IDs are globally unique across types so no collision.
    for (&mat_id, &color) in flatten_material_color_index(&material_styles).iter() {
        geometry_styles.entry(mat_id).or_insert(color);
    }

    // Mirror what `buildPrePassStreaming` already does in `gpu_meshes.rs`
    // (the `for (&element_id, colors) in &element_material_styles { … }`
    // block): fold each element's single resolved material colour into
    // `geometry_styles` keyed by the **element** express ID. Without this,
    // the path that goes through `combined_pre_pass` (`buildPrePassOnce`)
    // leaves the colour unread — `resolve_element_color`'s element-id fallback
    // finds nothing and material-chain-only elements render as the
    // per-type grey default on those APIs. The streaming path didn't
    // exhibit the bug because it folds entries inline.
    for (&element_id, colors) in &element_material_styles {
        if let Some(&color) = colors.first() {
            geometry_styles.entry(element_id).or_insert(color);
        }
    }

    // Propagate voids from aggregate parents (IfcWall) to children (IfcBuildingElementPart)
    // so that multilayer wall parts also get window/door cutouts. The returned
    // part→parent map is unused here (the merge-layers skip-set is rebuilt in
    // gpu_meshes), but the call mutates `void_index` in place — keep it.
    let _ = ifc_lite_geometry::propagate_voids_to_parts(&mut void_index, content, decoder);

    // #957: render orphan IfcTypeProduct geometry (annex-E "tessellated shape
    // with style" showcase files attach geometry to the type, not an
    // occurrence). processGeometryBatch turns these type jobs into meshes via
    // process_representation_map.
    complex_jobs.extend(collect_orphan_type_geometry_jobs(content, decoder));

    PrePassData {
        geometry_styles,
        void_index,
        faceted_brep_ids,
        project_id,
        site_position,
        simple_jobs,
        complex_jobs,
    }
}

/// #957: collect render jobs for orphan `IfcTypeProduct` geometry — a type's
/// `RepresentationMap` that no `IfcMappedItem` instantiates.
///
/// Returns `(id, start, end, ifc_type)` for each TYPE entity carrying at least
/// one orphan RepresentationMap, to be appended to the prepass job list so the
/// browser renders them. `processGeometryBatch` turns each into geometry via
/// [`ifc_lite_geometry::GeometryRouter::process_representation_map`]. Normally-
/// instanced typed products keep their geometry on the occurrence (whose
/// IfcMappedItem references the map), so those maps are filtered out here — no
/// double render. buildingSMART annex-E "tessellated shape with style" files
/// declare the geometry only on the type, so without this they render nothing.
pub(crate) fn collect_orphan_type_geometry_jobs(
    content: &str,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Vec<(u32, usize, usize, ifc_lite_core::IfcType)> {
    use ifc_lite_core::{EntityScanner, IfcType};

    // Fast bail-out: type-only geometry can only exist when the file authors at
    // least one IfcRepresentationMap. The overwhelming majority of files (and
    // every file that hits the latency-sensitive prepass without instancing)
    // pay only a single substring search instead of a full entity scan + decode.
    if !content.contains("IFCREPRESENTATIONMAP") {
        return Vec::new();
    }

    // Single pass: gather the IfcMappedItem-referenced RepresentationMaps, the
    // types that an IfcRelDefinesByType instantiates, and the type-product
    // candidates together, then filter to the orphans.
    let mut referenced: rustc_hash::FxHashSet<u32> = rustc_hash::FxHashSet::default();
    // Types with at least one occurrence (IfcRelDefinesByType). Their geometry is
    // already drawn through the occurrence — directly or via IfcMappedItem — so the
    // type's own RepresentationMap must NOT be rendered as orphan type-only
    // geometry. ArchiCAD/AC20 exports attach a RepresentationMap to nearly every
    // typed product while the occurrence carries its own body, so the map is
    // referenced by no IfcMappedItem; without this gate the type double-renders at
    // its MappingOrigin (duplicate boxes at the wrong position).
    let mut instantiated: rustc_hash::FxHashSet<u32> = rustc_hash::FxHashSet::default();
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
        } else if type_name == "IFCRELDEFINESBYTYPE" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // IfcRelDefinesByType.RelatingType = attr 5 (the typed product).
                if let Some(type_id) = entity.get_ref(5) {
                    instantiated.insert(type_id);
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
        .filter(|(id, _, _, _, _)| !instantiated.contains(id))
        .filter(|(_, _, _, _, maps)| maps.iter().any(|rm| !referenced.contains(rm)))
        .map(|(id, start, end, ifc_type, _)| (id, start, end, ifc_type))
        .collect()
}

/// #957: the set of `RepresentationMap`s instantiated by an `IfcMappedItem`, so
/// `processGeometryBatch` can tell which of a type's RepresentationMaps are
/// orphan (rendered directly) vs already drawn through an occurrence.
pub(crate) fn build_referenced_representation_maps(
    content: &str,
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
    content: &str,
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

/// #957: resolve the authored colour for a type's `IfcRepresentationMap` by
/// looking up its mapped geometry items in the prepass geometry-style index
/// (the annex-E samples author a white `IfcSurfaceStyle`). Returns `None` when
/// no item carries a style (caller falls back to the type's default colour).
pub(crate) fn color_for_representation_map(
    rep_map_id: u32,
    geometry_styles: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
    let rep_map = decoder.decode_by_id(rep_map_id).ok()?;
    // IfcRepresentationMap.MappedRepresentation = attr 1.
    let mapped_rep_id = rep_map.get_ref(1)?;
    let mapped_rep = decoder.decode_by_id(mapped_rep_id).ok()?;
    // IfcShapeRepresentation.Items = attr 3.
    let item_ids: Vec<u32> = mapped_rep
        .get(3)
        .and_then(|a| a.as_list())
        .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
        .unwrap_or_default();
    for item_id in item_ids {
        if let Some(color) = find_color_for_geometry(item_id, geometry_styles, decoder) {
            return Some(color);
        }
    }
    None
}

/// Build material style index: maps material IDs to their colors.
/// Follows: material → IfcMaterialDefinitionRepresentation → IfcStyledRepresentation → orphan IfcStyledItem
pub(crate) fn build_material_style_index(
    material_def_reprs: &rustc_hash::FxHashMap<u32, Vec<u32>>,
    orphan_styled_items: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> rustc_hash::FxHashMap<u32, Vec<[f32; 4]>> {
    // Canonical implementation lives in `ifc_lite_processing::style` (#913).
    ifc_lite_processing::style::build_material_style_index(
        material_def_reprs,
        orphan_styled_items,
        decoder,
    )
}

/// Build element → material colors map.
/// Resolves the full chain from element → IfcRelAssociatesMaterial → material select →
/// individual materials → colors.
/// Handles: IfcMaterial, IfcMaterialList, IfcMaterialLayerSet, IfcMaterialLayerSetUsage,
///          IfcMaterialConstituentSet (IFC4), IfcMaterialProfileSet (IFC4)
pub(crate) fn build_element_material_styles(
    element_to_material: &rustc_hash::FxHashMap<u32, u32>,
    material_styles: &rustc_hash::FxHashMap<u32, Vec<[f32; 4]>>,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> rustc_hash::FxHashMap<u32, Vec<[f32; 4]>> {
    use rustc_hash::FxHashMap;

    let mut result: FxHashMap<u32, Vec<[f32; 4]>> = FxHashMap::default();

    for (&element_id, &material_select_id) in element_to_material {
        let mut colors: Vec<[f32; 4]> = Vec::new();

        // Collect all individual material IDs from the material select
        // (canonical SELECT-walk in `ifc_lite_processing::style`, #913).
        let material_ids =
            ifc_lite_processing::style::resolve_material_ids(material_select_id, decoder);

        for material_id in material_ids {
            if let Some(mat_colors) = material_styles.get(&material_id) {
                colors.extend(mat_colors);
            }
        }

        if !colors.is_empty() {
            result.insert(element_id, colors);
        }
    }

    result
}

/// Flatten a `material_id -> Vec<color>` map into `material_id -> color` by
/// picking the first opaque color per material. Used to key layered sub-mesh
/// colour lookups on material ID — each layer slice's `geometry_id` is its
/// `IfcMaterial` entity ID. Canonical impl in `ifc_lite_processing::style` (#913).
pub(crate) fn flatten_material_color_index(
    material_styles: &rustc_hash::FxHashMap<u32, Vec<[f32; 4]>>,
) -> rustc_hash::FxHashMap<u32, [f32; 4]> {
    ifc_lite_processing::style::flatten_material_color_index(material_styles)
}

/// Process a single entity for material-related data collection.
/// Called from both `combined_pre_pass` (inline in the scan loop) and
/// `collect_material_data` (standalone scan).
pub(crate) fn collect_material_entity(
    id: u32,
    type_name: &str,
    start: usize,
    end: usize,
    decoder: &mut ifc_lite_core::EntityDecoder,
    orphan_styled_items: &mut rustc_hash::FxHashMap<u32, [f32; 4]>,
    material_def_reprs: &mut rustc_hash::FxHashMap<u32, Vec<u32>>,
    element_to_material: &mut rustc_hash::FxHashMap<u32, u32>,
) {
    match type_name {
        "IFCSTYLEDITEM" => {
            if let Ok(styled_item) = decoder.decode_at_with_id(id, start, end) {
                // Only collect orphan styled items (null Item attribute)
                if styled_item.get_ref(0).is_none() {
                    if let Some(styles_attr) = styled_item.get(1) {
                        if let Some(color) = extract_color_from_styles(styles_attr, decoder) {
                            orphan_styled_items.insert(id, color);
                        }
                    }
                }
            }
        }
        "IFCMATERIALDEFINITIONREPRESENTATION" => {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let Some(material_id) = entity.get_ref(3) {
                    if let Some(reprs_attr) = entity.get(2) {
                        if let Some(list) = reprs_attr.as_list() {
                            for item in list {
                                if let Some(repr_id) = item.as_entity_ref() {
                                    material_def_reprs
                                        .entry(material_id)
                                        .or_default()
                                        .push(repr_id);
                                }
                            }
                        }
                    }
                }
            }
        }
        "IFCRELASSOCIATESMATERIAL" => {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let Some(material_select_id) = entity.get_ref(5) {
                    if let Some(related_attr) = entity.get(4) {
                        if let Some(list) = related_attr.as_list() {
                            for item in list {
                                if let Some(element_id) = item.as_entity_ref() {
                                    element_to_material.insert(element_id, material_select_id);
                                }
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

/// Resolve color for a sub-mesh using the fallback chain:
/// direct geometry style -> material-based style -> element style -> default.
///
/// `mat_color_idx` is the current index for material color alternation (transparent/opaque).
/// It is incremented when a material fallback is attempted (caller should track this).
pub(crate) fn resolve_submesh_color(
    geometry_id: u32,
    geometry_styles: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    decoder: &mut ifc_lite_core::EntityDecoder,
    material_colors: Option<&Vec<[f32; 4]>>,
    mat_color_idx: &mut usize,
    element_color: Option<[f32; 4]>,
    default_color: [f32; 4],
) -> [f32; 4] {
    // Step 1 (the direct geometry style, incl. IfcMappedItem traversal) is the
    // browser's own lookup over its `[f32; 4]` style map. The precedence below
    // it and the transparent/opaque alternation are the shared resolver, so the
    // browser and the backend can't drift on them (#913 §4.2).
    let direct_color = find_color_for_geometry(geometry_id, geometry_styles, decoder);
    ifc_lite_processing::style::resolve_submesh_color(
        direct_color,
        material_colors.map(|v| v.as_slice()),
        mat_color_idx,
        element_color.unwrap_or(default_color),
    )
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

/// Extract building rotation from a pre-collected IfcSite position (avoids re-scanning).
/// Returns rotation angle in radians, or None if not found.
pub(crate) fn extract_building_rotation_from_site(
    site_pos: (u32, usize, usize),
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<f64> {
    let (site_id, start, end) = site_pos;
    let site_entity = decoder.decode_at_with_id(site_id, start, end).ok()?;

    // Get ObjectPlacement (attribute 5 for IfcProduct)
    let placement_attr = site_entity.get(5).filter(|a| !a.is_null())?;
    let placement = decoder.resolve_ref(placement_attr).ok()??;

    // Find top-level placement (parent is null)
    let top_level_placement = find_top_level_placement(&placement, decoder);

    // Extract rotation from top-level placement's RefDirection
    extract_rotation_from_placement(&top_level_placement, decoder)
}

/// Find the top-level placement (one with null parent)
fn find_top_level_placement(
    placement: &ifc_lite_core::DecodedEntity,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> ifc_lite_core::DecodedEntity {
    use ifc_lite_core::IfcType;

    // Check if this is a local placement
    if placement.ifc_type != IfcType::IfcLocalPlacement {
        return placement.clone();
    }

    // Check parent (attribute 0: PlacementRelTo)
    let parent_attr = match placement.get(0) {
        Some(attr) if !attr.is_null() => attr,
        _ => return placement.clone(), // No parent - this is top-level
    };

    // Resolve parent and recurse
    if let Ok(Some(parent)) = decoder.resolve_ref(parent_attr) {
        find_top_level_placement(&parent, decoder)
    } else {
        placement.clone() // Parent resolution failed - return current
    }
}

/// Extract rotation angle from IfcAxis2Placement3D's RefDirection
/// Returns rotation angle in radians (atan2 of RefDirection Y/X components)
fn extract_rotation_from_placement(
    placement: &ifc_lite_core::DecodedEntity,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<f64> {
    use ifc_lite_core::IfcType;

    // Get RelativePlacement (attribute 1: IfcAxis2Placement3D)
    let rel_attr = match placement.get(1) {
        Some(attr) if !attr.is_null() => attr,
        _ => return None,
    };

    let axis_placement = match decoder.resolve_ref(rel_attr) {
        Ok(Some(p)) => p,
        _ => return None,
    };

    // Check if it's IfcAxis2Placement3D
    if axis_placement.ifc_type != IfcType::IfcAxis2Placement3D {
        return None;
    }

    // Get RefDirection (attribute 2: IfcDirection)
    let ref_dir_attr = match axis_placement.get(2) {
        Some(attr) if !attr.is_null() => attr,
        _ => return None,
    };

    let ref_dir = match decoder.resolve_ref(ref_dir_attr) {
        Ok(Some(d)) => d,
        _ => return None,
    };

    if ref_dir.ifc_type != IfcType::IfcDirection {
        return None;
    }

    // Get direction ratios (attribute 0: list of floats)
    let ratios_attr = match ref_dir.get(0) {
        Some(attr) => attr,
        _ => return None,
    };

    let ratios = match ratios_attr.as_list() {
        Some(list) => list,
        _ => return None,
    };

    // Extract X and Y components (Z is up in IFC)
    let dx = ratios.first().and_then(|v| v.as_float()).unwrap_or(0.0);
    let dy = ratios.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);

    // Calculate rotation angle: atan2(dy, dx)
    // This gives the angle of the building's X-axis relative to world X-axis
    let len_sq = dx * dx + dy * dy;
    if len_sq < 1e-10 {
        return None; // Zero-length direction
    }

    let rotation = dy.atan2(dx);
    Some(rotation)
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
