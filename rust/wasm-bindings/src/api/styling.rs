// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Styling, color extraction, and building rotation for IFC-Lite API

/// Build style index: maps geometry express IDs to RGBA colors.
///
/// IFC4 defines two parallel mechanisms for coloring a geometric
/// representation item. This walker handles both:
///
/// 1. `IfcStyledItem` chain — the traditional approach. `Item` points at a
///    geometry item, `Styles` chains through IfcSurfaceStyle →
///    IfcSurfaceStyleRendering → IfcColourRgb to a colour.
///
/// 2. `IfcIndexedColourMap` — the tessellated-face-set approach used by
///    CATIA / 3DEXPERIENCE exports (see #663). `MappedTo` points at an
///    IfcTessellatedFaceSet, `Colours` is an IfcColourRgbList, and `ColourIndex`
///    is a per-face index into that list. For our purposes we pick the most
///    common colour and assign it as the geometry's solid colour; true
///    per-face colour rendering would need a richer mesh-data contract.
///
/// IfcIndexedColourMap entries shadow IfcStyledItem entries when both target
/// the same geometry (rare, but CATIA never emits styled items so the two
/// paths almost never collide in practice).
pub(crate) fn build_geometry_style_index(
    content: &str,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> rustc_hash::FxHashMap<u32, [f32; 4]> {
    build_geometry_style_indexes(content, decoder).colors
}

/// Per-geometry colour maps emitted by the style scan.
///
/// `colors` is the apparent rendering colour (DiffuseColour-with-fallback
/// from IfcSurfaceStyleRendering, or the IfcIndexedColourMap dominant
/// face colour). `shading_colors` carries the SurfaceColour separately,
/// keyed by the same geometry id, *only* when it differs from `colors` —
/// i.e. when the file authored a distinct DiffuseColour. Consumers that
/// don't care (everything except the GLB exporter's "Shading" mode) can
/// simply ignore `shading_colors`.
pub(crate) struct GeometryStyleIndexes {
    pub colors: rustc_hash::FxHashMap<u32, [f32; 4]>,
    pub shading_colors: rustc_hash::FxHashMap<u32, [f32; 4]>,
    /// Geometry IDs that had an `IfcStyledItem` directly authored on
    /// them. Distinct from `colors` because the merge below also folds
    /// in `IfcIndexedColourMap` dominant colours for geometries without
    /// a styled item — once merged, the source is no longer
    /// recoverable. PR #867 review (chatgpt-codex P2): the per-
    /// triangle colour-map splitter in `gpu_meshes.rs` must defer to
    /// IfcStyledItem when both are authored on the same face set.
    pub styled_item_geoms: rustc_hash::FxHashSet<u32>,
}

/// Single-pass variant that also returns the per-geometry shading colour
/// when the IfcSurfaceStyleRendering authored a distinct DiffuseColour.
pub(crate) fn build_geometry_style_indexes(
    content: &str,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> GeometryStyleIndexes {
    use ifc_lite_core::EntityScanner;
    use rustc_hash::FxHashMap;

    let mut style_index: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut shading_index: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut styled_item_geoms: rustc_hash::FxHashSet<u32> = rustc_hash::FxHashSet::default();
    // Stash IfcIndexedColourMap results separately so the merge below can
    // give IfcStyledItem unconditional precedence regardless of scan order
    // — files where an IFCINDEXEDCOLOURMAP appears before its matching
    // IFCSTYLEDITEM otherwise let the colour-map shadow the authored intent
    // (CodeRabbit feedback on #669).
    let mut colour_map_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);

    // One pass over all entities — branch on the relevant type names. Doing
    // both walks in a single pass keeps the file scan cost the same as the
    // pre-#663 single-mechanism implementation.
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        match type_name {
            "IFCSTYLEDITEM" => {
                let Ok(styled_item) = decoder.decode_at_with_id(id, start, end) else { continue };

                // IfcStyledItem: Item (ref to geometry), Styles (list of style refs), Name
                let Some(geometry_id) = styled_item.get_ref(0) else { continue };

                // Skip if we already have a styled-item color for this geometry
                // (an earlier IfcStyledItem already won). IfcIndexedColourMap
                // entries are kept in the side map and merged below with lower
                // precedence than anything we put into `style_index` here.
                if style_index.contains_key(&geometry_id) {
                    continue;
                }

                let Some(styles_attr) = styled_item.get(1) else { continue };
                if let Some((color, shading)) =
                    extract_color_pair_from_styles(styles_attr, decoder)
                {
                    style_index.insert(geometry_id, color);
                    styled_item_geoms.insert(geometry_id);
                    if let Some(s) = shading {
                        shading_index.insert(geometry_id, s);
                    }
                }
            }
            "IFCINDEXEDCOLOURMAP" => {
                if let Some((geometry_id, color)) =
                    extract_color_from_indexed_colour_map(id, start, end, decoder)
                {
                    colour_map_styles.entry(geometry_id).or_insert(color);
                }
            }
            _ => {}
        }
    }

    // Merge: IfcStyledItem (in `style_index`) wins unconditionally. Only
    // geometries WITHOUT a styled-item entry pick up their colour-map colour.
    // IfcIndexedColourMap has no rendering/shading distinction so it
    // contributes nothing to `shading_index`.
    for (geometry_id, color) in colour_map_styles {
        style_index.entry(geometry_id).or_insert(color);
    }

    GeometryStyleIndexes {
        colors: style_index,
        shading_colors: shading_index,
        styled_item_geoms,
    }
}

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

/// Full IfcIndexedColourMap payload: every authored colour + the per-
/// triangle index list, so callers can split a mesh into colour groups
/// instead of collapsing to a single dominant colour.
///
/// Used for issue #858 — `tessellation-with-individual-colors.ifc`
/// authors a 12-triangle cube with three colours (red/green/yellow);
/// the dominant-only path picked red and rendered the whole cube red.
pub(crate) struct IndexedColourMapResolved {
    /// Target IfcTessellatedFaceSet entity id.
    pub geometry_id: u32,
    /// Resolved RGBA palette. 1-based indexing per ISO 10303-21 — index 1
    /// is `colours[0]`, etc.
    pub colours: Vec<[f32; 4]>,
    /// Per-triangle 1-based palette index. Same length as the face-set's
    /// triangle list.
    pub triangle_indices: Vec<u32>,
}

/// Span-based companion to [`extract_color_from_indexed_colour_map_span`]
/// that returns the full per-triangle colour assignment rather than
/// collapsing to a single dominant colour. Returns `None` when the map
/// can't be resolved (bad references, empty index list, etc.).
pub(crate) fn extract_full_indexed_colour_map_span(
    id: u32,
    start: usize,
    end: usize,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<IndexedColourMapResolved> {
    let entity = decoder.decode_at_with_id(id, start, end).ok()?;
    let geometry_id = entity.get_ref(0)?;
    let opacity = entity
        .get(1)
        .and_then(|a| a.as_float())
        .map(|v| v as f32)
        .unwrap_or(1.0)
        .clamp(0.0, 1.0);
    let colours_id = entity.get_ref(2)?;
    let index_list = entity.get(3)?.as_list()?;
    if index_list.is_empty() {
        return None;
    }

    let colours_entity = decoder.decode_by_id(colours_id).ok()?;
    let colour_list = colours_entity.get(0)?.as_list()?;
    // Strict-mode resolution: any malformed entry collapses the whole
    // map to `None` so the caller falls back to the dominant-colour
    // path. PR #867 review (CodeRabbit Major) — `filter_map` previously
    // silently dropped bad rows / negative indices, leaving the
    // resolver returning a palette/index mapping that no longer
    // matched the authored triangle count. The splitter would then
    // emit fewer triangles than the source mesh instead of routing
    // through the single-colour fallback. Reject the whole map up
    // front so the contract `triangle_indices.len() == mesh.tris`
    // holds whenever the resolver returns Some.
    let mut colours: Vec<[f32; 4]> = Vec::with_capacity(colour_list.len());
    for c in colour_list {
        let rgb = c.as_list()?;
        let r = rgb.first().and_then(|v| v.as_float())? as f32;
        let g = rgb.get(1).and_then(|v| v.as_float())? as f32;
        let b = rgb.get(2).and_then(|v| v.as_float())? as f32;
        colours.push([r, g, b, opacity]);
    }
    if colours.is_empty() {
        return None;
    }

    let mut triangle_indices: Vec<u32> = Vec::with_capacity(index_list.len());
    for v in index_list {
        let idx = v.as_int()?;
        if idx <= 0 || (idx as usize) > colours.len() {
            // Out-of-range / non-positive index ⇒ the entire map is
            // structurally invalid; bail.
            return None;
        }
        triangle_indices.push(idx as u32);
    }
    if triangle_indices.is_empty() {
        return None;
    }

    Some(IndexedColourMapResolved {
        geometry_id,
        colours,
        triangle_indices,
    })
}

fn extract_color_from_indexed_colour_map(
    id: u32,
    start: usize,
    end: usize,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<(u32, [f32; 4])> {
    let entity = decoder.decode_at_with_id(id, start, end).ok()?;
    let geometry_id = entity.get_ref(0)?;
    let opacity = entity
        .get(1)
        .and_then(|a| a.as_float())
        .map(|v| v as f32)
        .unwrap_or(1.0);
    let colours_id = entity.get_ref(2)?;
    let index_attr = entity.get(3)?;
    let index_list = index_attr.as_list()?;

    // Pick the dominant colour index. Single-colour maps (the common case)
    // skip the histogram entirely.
    let dominant_index: usize = if index_list.is_empty() {
        return None;
    } else if index_list.len() == 1 {
        index_list[0].as_int()? as usize
    } else {
        let mut counts: rustc_hash::FxHashMap<i64, u32> = rustc_hash::FxHashMap::default();
        for v in index_list {
            if let Some(i) = v.as_int() {
                *counts.entry(i).or_insert(0) += 1;
            }
        }
        let dominant = counts.iter().max_by_key(|(_, c)| *c)?;
        *dominant.0 as usize
    };

    // Resolve IfcColourRgbList.ColourList[dominant_index]. Index is 1-based
    // per ISO 10303-21 LIST conventions.
    let colours = decoder.decode_by_id(colours_id).ok()?;
    let colour_list = colours.get(0)?.as_list()?;
    let colour_idx_zero_based = dominant_index.checked_sub(1).unwrap_or(0);
    let rgb_tuple = colour_list.get(colour_idx_zero_based)?.as_list()?;

    let r = rgb_tuple.first().and_then(|v| v.as_float())? as f32;
    let g = rgb_tuple.get(1).and_then(|v| v.as_float())? as f32;
    let b = rgb_tuple.get(2).and_then(|v| v.as_float())? as f32;

    Some((geometry_id, [r, g, b, opacity.clamp(0.0, 1.0)]))
}

/// Build element style index: maps building element IDs to RGBA colors
/// Follows: Element → IfcProductDefinitionShape → IfcShapeRepresentation → geometry items
pub(crate) fn build_element_style_index(
    content: &str,
    geometry_styles: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> rustc_hash::FxHashMap<u32, [f32; 4]> {
    use ifc_lite_core::EntityScanner;
    use rustc_hash::FxHashMap;

    let mut element_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();

    // Short-circuit: if no geometry has styles, skip the entire traversal.
    // ~85-95% of IFC files have few styled items; for files with zero styles
    // this avoids decoding every building element's representation chain.
    if geometry_styles.is_empty() {
        return element_styles;
    }

    let mut scanner = EntityScanner::new(content);

    // Scan all building elements
    while let Some((element_id, type_name, start, end)) = scanner.next_entity() {
        // Check if this is a building element type
        if !ifc_lite_core::has_geometry_by_name(type_name) {
            continue;
        }

        // Decode the element
        let element = match decoder.decode_at_with_id(element_id, start, end) {
            Ok(entity) => entity,
            Err(_) => continue,
        };

        // Building elements have Representation attribute at index 6
        // IfcProduct: GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation
        let repr_id = match element.get_ref(6) {
            Some(id) => id,
            None => continue,
        };

        // Decode IfcProductDefinitionShape
        let product_shape = match decoder.decode_by_id(repr_id) {
            Ok(entity) => entity,
            Err(_) => continue,
        };

        // IfcProductDefinitionShape: Name, Description, Representations (list)
        // Attribute 2: Representations
        let reprs_attr = match product_shape.get(2) {
            Some(attr) => attr,
            None => continue,
        };

        let reprs_list = match reprs_attr.as_list() {
            Some(list) => list,
            None => continue,
        };

        // Look through representations for geometry with styles
        'repr_loop: for repr_item in reprs_list {
            let shape_repr_id = match repr_item.as_entity_ref() {
                Some(id) => id,
                None => continue,
            };

            // Decode IfcShapeRepresentation
            let shape_repr = match decoder.decode_by_id(shape_repr_id) {
                Ok(entity) => entity,
                Err(_) => continue,
            };

            // IfcShapeRepresentation: ContextOfItems, RepresentationIdentifier, RepresentationType, Items
            // Attribute 3: Items (list of geometry items)
            let items_attr = match shape_repr.get(3) {
                Some(attr) => attr,
                None => continue,
            };

            let items_list = match items_attr.as_list() {
                Some(list) => list,
                None => continue,
            };

            // Check each geometry item for a style
            for geom_item in items_list {
                let geom_id = match geom_item.as_entity_ref() {
                    Some(id) => id,
                    None => continue,
                };

                // Check if this geometry has a style, following MappedItem references if needed
                if let Some(color) = find_color_for_geometry(geom_id, geometry_styles, decoder) {
                    element_styles.insert(element_id, color);
                    break 'repr_loop; // Found a color — stop all representation traversal
                }
            }
        }
    }

    element_styles
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
///   - `rendering_color` is the apparent surface colour. When
///     IfcSurfaceStyleRendering authored a DiffuseColour (attr 2) it wins;
///     otherwise we fall back to SurfaceColour (attr 0). Matches how most
///     IFC viewers display the model and is what the GLB exporter uses by
///     default.
///   - `shading_color` is the SurfaceColour, returned only when it differs
///     from `rendering_color` (i.e. a DiffuseColour was authored). The GLB
///     exporter's "Shading" colour source picks this up.
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

            // Probe DiffuseColour: entity ref first, then inline factor.
            let rendering_rgba = if rendering.ifc_type
                == IfcType::IfcSurfaceStyleRendering
            {
                if let Some(diffuse_id) = rendering.get_ref(2) {
                    if let Some([dr, dg, db, _]) = extract_color_rgb(diffuse_id, decoder)
                    {
                        [dr, dg, db, alpha]
                    } else {
                        surface_rgba
                    }
                } else if let Some(factor) = rendering.get_float(2) {
                    let f = (factor as f32).clamp(0.0, 1.0);
                    [sr * f, sg * f, sb * f, alpha]
                } else {
                    surface_rgba
                }
            } else {
                surface_rgba
            };

            let shading = if rendering_rgba == surface_rgba {
                None
            } else {
                Some(surface_rgba)
            };

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
    /// Geometry ID → SurfaceColour, populated only when the file authored
    /// a distinct DiffuseColour so it differs from `geometry_styles`.
    /// Consumed by the GLB exporter's "Shading" colour source; renderers
    /// and other exporters can ignore it.
    pub geometry_shading_styles: rustc_hash::FxHashMap<u32, [f32; 4]>,
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
    /// Element ID → list of material-based colors (from IfcRelAssociatesMaterial chain).
    /// Used as fallback when a sub-mesh has no direct IfcStyledItem style.
    pub element_material_styles: rustc_hash::FxHashMap<u32, Vec<[f32; 4]>>,
    /// Material layer buildup index (IfcMaterialLayerSetUsage → sliceable
    /// layers). Elements here are eligible for per-layer sub-meshes even if
    /// their geometry is a single swept solid. Held in an `Arc` so it can be
    /// attached to the `GeometryRouter` without cloning the map.
    pub material_layer_index: std::sync::Arc<ifc_lite_geometry::MaterialLayerIndex>,
    /// Map from every emitted `IfcBuildingElementPart` whose parent has its own
    /// `Representation` → parent element id. Captured during
    /// `propagate_voids_to_parts` so the merge-layers toggle (#540) can skip
    /// per-part meshes when the parent is sliceable.
    pub part_to_parent: rustc_hash::FxHashMap<u32, u32>,
    /// Geometry IDs that had an `IfcStyledItem` directly authored. Used by
    /// the per-triangle IfcIndexedColourMap splitter to defer to the
    /// styled-item colour when both mechanisms are authored on the same
    /// face set. PR #867 review (chatgpt-codex P2).
    pub styled_item_geoms: rustc_hash::FxHashSet<u32>,
    /// Full per-face IfcIndexedColourMap payload keyed by face-set geometry
    /// id. Populated only when the streaming / async render loop needs to
    /// split a flat-shaded mesh into per-colour sub-meshes (issue #858).
    /// `None` entry means "no colour map" (cheaper than an absent key for
    /// the hot lookup); the splitter only fires when this map's
    /// `triangle_indices` length matches the source mesh's triangle count.
    pub indexed_colour_maps: rustc_hash::FxHashMap<u32, IndexedColourMapResolved>,
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
    // Sparse side-table populated only when IfcSurfaceStyleRendering
    // authored a DiffuseColour distinct from SurfaceColour. Consumed by the
    // GLB exporter's "Shading" colour source.
    let mut geometry_shading_styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
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
    // PR #867: geometries with a direct IfcStyledItem (so the per-face
    // colour-map splitter can defer to the styled colour), and the full
    // per-face colour-map payload for the splitter itself.
    let mut styled_item_geoms: rustc_hash::FxHashSet<u32> = rustc_hash::FxHashSet::default();
    let mut indexed_colour_maps: FxHashMap<u32, IndexedColourMapResolved> = FxHashMap::default();

    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        match type_name {
            "IFCSTYLEDITEM" => {
                if let Ok(styled_item) = decoder.decode_at_with_id(id, start, end) {
                    if let Some(geometry_id) = styled_item.get_ref(0) {
                        // Normal IfcStyledItem with Item reference → geometry_styles
                        if !geometry_styles.contains_key(&geometry_id) {
                            if let Some(styles_attr) = styled_item.get(1) {
                                if let Some((color, shading)) =
                                    extract_color_pair_from_styles(styles_attr, decoder)
                                {
                                    geometry_styles.insert(geometry_id, color);
                                    styled_item_geoms.insert(geometry_id);
                                    if let Some(s) = shading {
                                        geometry_shading_styles.insert(geometry_id, s);
                                    }
                                }
                            }
                        } else {
                            // Already-styled geometry — still record source so
                            // the colour-map splitter knows to defer to the
                            // styled colour (PR #867).
                            styled_item_geoms.insert(geometry_id);
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
                // ALSO collect the full per-face payload so the streaming /
                // async render loops can split a flat-shaded mesh into per-
                // colour sub-meshes (issue #858 / PR #867). Re-decoding is
                // cheap (~µs) compared to the geometry pass that follows,
                // and the dominant-colour fast path above caches the
                // map's first decode under the hood so this is mostly
                // a re-pull from the entity cache.
                if let Some(resolved) =
                    extract_full_indexed_colour_map_span(id, start, end, decoder)
                {
                    indexed_colour_maps.insert(resolved.geometry_id, resolved);
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
    // the synchronous parse paths that go through `combined_pre_pass`
    // (`parseMeshesAsync`, `parseMeshesSubset`, `buildPrePassOnce`) leave
    // the colour unread — `resolve_element_color`'s element-id fallback
    // finds nothing and material-chain-only elements render as the
    // per-type grey default on those APIs. The streaming path didn't
    // exhibit the bug because it folds entries inline.
    for (&element_id, colors) in &element_material_styles {
        if let Some(&color) = colors.first() {
            geometry_styles.entry(element_id).or_insert(color);
        }
    }

    // Scan IfcRelAssociatesMaterial → resolved LayerBuildup per element.
    let material_layer_index = std::sync::Arc::new(
        ifc_lite_geometry::MaterialLayerIndex::from_content(content, decoder),
    );

    // Propagate voids from aggregate parents (IfcWall) to children (IfcBuildingElementPart)
    // so that multilayer wall parts also get window/door cutouts. Also captures
    // the part → parent map used by the merge-layers toggle (issue #540).
    let part_to_parent =
        ifc_lite_geometry::propagate_voids_to_parts(&mut void_index, content, decoder);

    PrePassData {
        geometry_styles,
        geometry_shading_styles,
        void_index,
        faceted_brep_ids,
        project_id,
        site_position,
        simple_jobs,
        complex_jobs,
        element_material_styles,
        material_layer_index,
        part_to_parent,
        styled_item_geoms,
        indexed_colour_maps,
    }
}

/// Build material style index: maps material IDs to their colors.
/// Follows: material → IfcMaterialDefinitionRepresentation → IfcStyledRepresentation → orphan IfcStyledItem
pub(crate) fn build_material_style_index(
    material_def_reprs: &rustc_hash::FxHashMap<u32, Vec<u32>>,
    orphan_styled_items: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> rustc_hash::FxHashMap<u32, Vec<[f32; 4]>> {
    use rustc_hash::FxHashMap;

    let mut material_styles: FxHashMap<u32, Vec<[f32; 4]>> = FxHashMap::default();

    for (&material_id, styled_repr_ids) in material_def_reprs {
        for &styled_repr_id in styled_repr_ids {
            // Decode the IfcStyledRepresentation
            // Inherits from IfcRepresentation: ContextOfItems(0), RepresentationIdentifier(1),
            //   RepresentationType(2), Items(3)
            let styled_repr = match decoder.decode_by_id(styled_repr_id) {
                Ok(entity) => entity,
                Err(_) => continue,
            };

            let items_attr = match styled_repr.get(3) {
                Some(attr) => attr,
                None => continue,
            };

            let items_list = match items_attr.as_list() {
                Some(list) => list,
                None => continue,
            };

            // Each item should be an orphan IfcStyledItem (already collected)
            for item in items_list {
                if let Some(styled_item_id) = item.as_entity_ref() {
                    if let Some(&color) = orphan_styled_items.get(&styled_item_id) {
                        material_styles.entry(material_id).or_default().push(color);
                    }
                }
            }
        }
    }

    material_styles
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
        let material_ids = resolve_material_ids(material_select_id, decoder);

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

/// Resolve a material select (which could be IfcMaterial, IfcMaterialList,
/// IfcMaterialLayerSet, IfcMaterialLayerSetUsage, IfcMaterialConstituentSet,
/// IfcMaterialProfileSet) into a list of individual IfcMaterial IDs.
fn resolve_material_ids(
    material_select_id: u32,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Vec<u32> {
    resolve_material_ids_inner(material_select_id, decoder, 0)
}

/// Maximum recursion depth for material resolution (guards against cycles in malformed IFC).
const MAX_MATERIAL_RESOLVE_DEPTH: u8 = 4;

fn resolve_material_ids_inner(
    material_select_id: u32,
    decoder: &mut ifc_lite_core::EntityDecoder,
    depth: u8,
) -> Vec<u32> {
    if depth >= MAX_MATERIAL_RESOLVE_DEPTH {
        return vec![];
    }

    use ifc_lite_core::IfcType;

    let entity = match decoder.decode_by_id(material_select_id) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    match entity.ifc_type {
        IfcType::IfcMaterial => {
            vec![material_select_id]
        }
        IfcType::IfcMaterialList => {
            // Attr 0: Materials (list of IfcMaterial refs)
            extract_refs_from_list(&entity, 0)
        }
        IfcType::IfcMaterialLayerSetUsage => {
            // Attr 0: ForLayerSet (ref to IfcMaterialLayerSet)
            if let Some(layer_set_id) = entity.get_ref(0) {
                resolve_material_ids_inner(layer_set_id, decoder, depth + 1)
            } else {
                vec![]
            }
        }
        IfcType::IfcMaterialLayerSet => {
            // Attr 0: MaterialLayers (list of IfcMaterialLayer refs)
            // IfcMaterialLayer: Attr 0: Material (ref to IfcMaterial)
            extract_nested_material_ids(&entity, 0, 0, decoder)
        }
        IfcType::IfcMaterialConstituentSet => {
            // Attr 2: MaterialConstituents (list of IfcMaterialConstituent refs)
            // IfcMaterialConstituent: Attr 2: Material (ref to IfcMaterial)
            extract_nested_material_ids(&entity, 2, 2, decoder)
        }
        IfcType::IfcMaterialProfileSet => {
            // Attr 2: MaterialProfiles (list of IfcMaterialProfile refs)
            // IfcMaterialProfile: Attr 2: Material (ref to IfcMaterial)
            extract_nested_material_ids(&entity, 2, 2, decoder)
        }
        IfcType::IfcMaterialProfileSetUsage | IfcType::IfcMaterialProfileSetUsageTapering => {
            // Attr 0: ForProfileSet (ref to IfcMaterialProfileSet)
            // IfcMaterialProfileSetUsageTapering is a subtype with the same attr layout
            if let Some(profile_set_id) = entity.get_ref(0) {
                resolve_material_ids_inner(profile_set_id, decoder, depth + 1)
            } else {
                vec![]
            }
        }
        _ => {
            // Unknown material type — no colors to extract
            vec![]
        }
    }
}

/// Extract material IDs from a list of container entities (layers, constituents, profiles).
/// `container_list_attr_idx` is the attribute index of the list on the parent entity.
/// `material_attr_idx` is the attribute index of the Material ref on each child entity.
fn extract_nested_material_ids(
    entity: &ifc_lite_core::DecodedEntity,
    container_list_attr_idx: usize,
    material_attr_idx: usize,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Vec<u32> {
    let container_ids = extract_refs_from_list(entity, container_list_attr_idx);
    let mut materials = Vec::new();
    for container_id in container_ids {
        if let Ok(container) = decoder.decode_by_id(container_id) {
            if let Some(mat_id) = container.get_ref(material_attr_idx) {
                materials.push(mat_id);
            }
        }
    }
    materials
}

/// Helper: extract entity references from a list attribute.
fn extract_refs_from_list(entity: &ifc_lite_core::DecodedEntity, index: usize) -> Vec<u32> {
    entity
        .get(index)
        .and_then(|attr| attr.as_list())
        .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
        .unwrap_or_default()
}

/// Build element material styles by scanning the content for material-related entities.
/// Standalone version for use in synchronous parse_meshes path (which doesn't use combined_pre_pass).
pub(crate) fn build_element_material_styles_from_content(
    content: &str,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> rustc_hash::FxHashMap<u32, Vec<[f32; 4]>> {
    let (orphan_styled_items, material_def_reprs, element_to_material) =
        collect_material_data(content, decoder);

    let material_styles =
        build_material_style_index(&material_def_reprs, &orphan_styled_items, decoder);
    build_element_material_styles(&element_to_material, &material_styles, decoder)
}

/// Flatten a `material_id -> Vec<color>` map into `material_id -> color` by
/// picking the first opaque color per material (falling back to the first
/// color overall). Used to key layered sub-mesh colour lookups on material
/// ID — each layer slice's `geometry_id` is its `IfcMaterial` entity ID.
pub(crate) fn flatten_material_color_index(
    material_styles: &rustc_hash::FxHashMap<u32, Vec<[f32; 4]>>,
) -> rustc_hash::FxHashMap<u32, [f32; 4]> {
    use rustc_hash::FxHashMap;
    let mut out: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    for (&mat_id, colors) in material_styles {
        if colors.is_empty() {
            continue;
        }
        // Prefer an opaque color (alpha >= threshold) so walls don't end up
        // rendered as the glass-style color when a material carries both.
        let color = colors
            .iter()
            .find(|c| c[3] >= TRANSPARENCY_ALPHA_THRESHOLD)
            .copied()
            .unwrap_or(colors[0]);
        out.insert(mat_id, color);
    }
    out
}

/// Build a flat `material_id -> color` map from a fresh scan of `content`.
/// Standalone variant for the synchronous parse_meshes path that can't share
/// state with `combined_pre_pass`.
pub(crate) fn build_material_color_index_from_content(
    content: &str,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> rustc_hash::FxHashMap<u32, [f32; 4]> {
    let (orphan_styled_items, material_def_reprs, _element_to_material) =
        collect_material_data(content, decoder);
    let material_styles =
        build_material_style_index(&material_def_reprs, &orphan_styled_items, decoder);
    flatten_material_color_index(&material_styles)
}

/// Collect material-related data from an IFC content scan.
/// Returns: (orphan_styled_items, material_def_reprs, element_to_material)
///
/// Shared between `combined_pre_pass` (which integrates collection into its
/// single-pass loop) and `build_element_material_styles_from_content` (which
/// needs a standalone scan for the synchronous parse_meshes path).
fn collect_material_data(
    content: &str,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> (
    rustc_hash::FxHashMap<u32, [f32; 4]>,
    rustc_hash::FxHashMap<u32, Vec<u32>>,
    rustc_hash::FxHashMap<u32, u32>,
) {
    use ifc_lite_core::EntityScanner;
    use rustc_hash::FxHashMap;

    let mut orphan_styled_items: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut material_def_reprs: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut element_to_material: FxHashMap<u32, u32> = FxHashMap::default();

    let mut scanner = EntityScanner::new(content);

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
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

    (orphan_styled_items, material_def_reprs, element_to_material)
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
    // 1. Direct geometry style (IfcStyledItem -> geometry item)
    if let Some(color) = find_color_for_geometry(geometry_id, geometry_styles, decoder) {
        return color;
    }

    // 2. Material-based fallback (alternating transparent/opaque)
    if let Some(colors) = material_colors {
        let prefer_transparent = *mat_color_idx % 2 == 0;
        *mat_color_idx += 1;
        if let Some(color) = pick_material_style_for_submesh(colors, prefer_transparent) {
            return color;
        }
    }

    // 3. Element-level style or default
    element_color.unwrap_or(default_color)
}

/// Alpha threshold for distinguishing transparent (glass) from opaque materials.
const TRANSPARENCY_ALPHA_THRESHOLD: f32 = 0.95;

/// Pick the best material style for a sub-mesh.
/// Prefers transparent colors (glass) for sub-meshes without a direct style,
/// since glass sub-elements are the most common case where material-based
/// styling is the only source of appearance data.
pub(crate) fn pick_material_style_for_submesh(
    material_colors: &[[f32; 4]],
    prefer_transparent: bool,
) -> Option<[f32; 4]> {
    if material_colors.is_empty() {
        return None;
    }

    if prefer_transparent {
        // Prefer transparent (glass) — alpha < threshold
        if let Some(color) = material_colors
            .iter()
            .find(|c| c[3] < TRANSPARENCY_ALPHA_THRESHOLD)
        {
            return Some(*color);
        }
    } else {
        // Prefer opaque (frame) — alpha >= threshold
        if let Some(color) = material_colors
            .iter()
            .find(|c| c[3] >= TRANSPARENCY_ALPHA_THRESHOLD)
        {
            return Some(*color);
        }
    }

    // Fallback: first available color
    Some(material_colors[0])
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

/// Get default color for IFC type (matches default-materials.ts)
pub(crate) fn get_default_color_for_type(ifc_type: &ifc_lite_core::IfcType) -> [f32; 4] {
    use ifc_lite_core::IfcType;

    match ifc_type {
        // Walls - light gray
        IfcType::IfcWall | IfcType::IfcWallStandardCase => [0.85, 0.85, 0.85, 1.0],

        // Slabs - darker gray
        IfcType::IfcSlab => [0.7, 0.7, 0.7, 1.0],

        // Roofs - brown-ish
        IfcType::IfcRoof => [0.6, 0.5, 0.4, 1.0],

        // Columns/Beams - steel gray
        IfcType::IfcColumn | IfcType::IfcBeam | IfcType::IfcMember => [0.6, 0.65, 0.7, 1.0],

        // Windows - light blue transparent
        IfcType::IfcWindow => [0.6, 0.8, 1.0, 0.4],

        // Doors - wood brown
        IfcType::IfcDoor => [0.6, 0.45, 0.3, 1.0],

        // Stairs
        IfcType::IfcStair => [0.75, 0.75, 0.75, 1.0],

        // Railings
        IfcType::IfcRailing => [0.4, 0.4, 0.45, 1.0],

        // Plates/Coverings
        IfcType::IfcPlate | IfcType::IfcCovering => [0.8, 0.8, 0.8, 1.0],

        // Curtain walls - glass blue
        IfcType::IfcCurtainWall => [0.5, 0.7, 0.9, 0.5],

        // Furniture - wood
        IfcType::IfcFurnishingElement => [0.7, 0.55, 0.4, 1.0],

        // Spaces - cyan transparent (matches MainToolbar)
        IfcType::IfcSpace => [0.2, 0.85, 1.0, 0.3],

        // Opening elements - red-orange transparent
        IfcType::IfcOpeningElement => [1.0, 0.42, 0.29, 0.4],

        // Site - green
        IfcType::IfcSite => [0.4, 0.8, 0.3, 1.0],

        // Default gray
        _ => [0.8, 0.8, 0.8, 1.0],
    }
}

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

/// Extract building rotation from IfcSite's top-level placement (scans file).
/// Used by the synchronous parse_meshes path.
pub(crate) fn extract_building_rotation(
    content: &str,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<f64> {
    use ifc_lite_core::EntityScanner;

    let mut scanner = EntityScanner::new(content);

    while let Some((site_id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCSITE" {
            continue;
        }
        if let Ok(site_entity) = decoder.decode_at_with_id(site_id, start, end) {
            let placement_attr = match site_entity.get(5) {
                Some(attr) if !attr.is_null() => attr,
                _ => continue,
            };
            let placement = match decoder.resolve_ref(placement_attr) {
                Ok(Some(p)) => p,
                _ => continue,
            };
            let top_level_placement = find_top_level_placement(&placement, decoder);
            if let Some(rotation) = extract_rotation_from_placement(&top_level_placement, decoder) {
                return Some(rotation);
            }
        }
    }

    None
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

#[cfg(test)]
mod indexed_colour_map_tests {
    //! Issue #858 — `IfcIndexedColourMap` must surface every authored
    //! colour, not just the dominant one. `extract_full_indexed_colour_map_span`
    //! is the data-extraction half of the fix; `gpu_meshes.rs` consumes the
    //! resolved struct to split a flat-shaded mesh into per-colour groups.
    use super::extract_full_indexed_colour_map_span;
    use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};

    /// Minimal IFC4 fixture: an `IfcTriangulatedFaceSet` with 12 triangles
    /// + an `IfcIndexedColourMap` assigning 3 colours
    /// (red / green / yellow). Matches the reporter's
    /// `tessellation-with-individual-colors.ifc` structure.
    const FIXTURE: &str = "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'),'2;1');
FILE_NAME('','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#200=IFCCARTESIANPOINTLIST3D(((0.0,0.0,0.0),(1.0,0.0,0.0),(1.0,1.0,0.0),(0.0,1.0,0.0),(0.0,0.0,1.0),(1.0,0.0,1.0),(1.0,1.0,1.0),(0.0,1.0,1.0)));
#201=IFCTRIANGULATEDFACESET(#200,$,.T.,((1,6,5),(1,2,6),(6,2,7),(7,2,3),(7,8,6),(6,8,5),(5,8,1),(1,8,4),(4,2,1),(2,4,3),(4,8,7),(7,3,4)),$);
#202=IFCCOLOURRGBLIST(((1.0,0.0,0.0),(0.0,0.5,0.0),(1.0,1.0,0.0)));
#203=IFCINDEXEDCOLOURMAP(#201,$,#202,(1,1,2,2,3,3,1,1,1,1,1,1));
ENDSEC;
END-ISO-10303-21;
";

    #[test]
    fn extracts_three_colours_with_twelve_indices() {
        let mut decoder = EntityDecoder::with_index(FIXTURE, build_entity_index(FIXTURE));
        let mut scanner = EntityScanner::new(FIXTURE);
        let mut resolved = None;
        while let Some((id, name, start, end)) = scanner.next_entity() {
            if name == "IFCINDEXEDCOLOURMAP" {
                resolved = extract_full_indexed_colour_map_span(id, start, end, &mut decoder);
                break;
            }
        }
        let r = resolved.expect("colour map must resolve");
        assert_eq!(r.geometry_id, 201);
        assert_eq!(r.colours.len(), 3, "all three palette entries must surface");
        assert_eq!(r.colours[0], [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(r.colours[1], [0.0, 0.5, 0.0, 1.0]);
        assert_eq!(r.colours[2], [1.0, 1.0, 0.0, 1.0]);
        assert_eq!(
            r.triangle_indices,
            vec![1, 1, 2, 2, 3, 3, 1, 1, 1, 1, 1, 1],
            "per-triangle palette assignment must round-trip verbatim",
        );
    }
}
