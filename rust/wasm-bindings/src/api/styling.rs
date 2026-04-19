// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Styling, color extraction, and building rotation for IFC-Lite API

/// Build style index: maps geometry express IDs to RGBA colors
/// Follows the chain: IfcStyledItem → IfcSurfaceStyle → IfcSurfaceStyleRendering → IfcColourRgb
pub(crate) fn build_geometry_style_index(
    content: &str,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> rustc_hash::FxHashMap<u32, [f32; 4]> {
    use ifc_lite_core::EntityScanner;
    use rustc_hash::FxHashMap;

    let mut style_index: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);

    // First pass: find all IfcStyledItem entities
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCSTYLEDITEM" {
            continue;
        }

        // Decode the IfcStyledItem
        let styled_item = match decoder.decode_at_with_id(id, start, end) {
            Ok(entity) => entity,
            Err(_) => continue,
        };

        // IfcStyledItem: Item (ref to geometry), Styles (list of style refs), Name
        // Attribute 0: Item (geometry reference)
        let geometry_id = match styled_item.get_ref(0) {
            Some(id) => id,
            None => continue,
        };

        // Skip if we already have a color for this geometry
        if style_index.contains_key(&geometry_id) {
            continue;
        }

        // Attribute 1: Styles (list of style assignment refs)
        let styles_attr = match styled_item.get(1) {
            Some(attr) => attr,
            None => continue,
        };

        // Extract color from styles list
        if let Some(color) = extract_color_from_styles(styles_attr, decoder) {
            style_index.insert(geometry_id, color);
        }
    }

    style_index
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

/// Extract RGBA color from IfcStyledItem.Styles attribute
fn extract_color_from_styles(
    styles_attr: &ifc_lite_core::AttributeValue,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
    // Styles can be a list or a single reference
    if let Some(list) = styles_attr.as_list() {
        for item in list {
            if let Some(style_id) = item.as_entity_ref() {
                if let Some(color) = extract_color_from_style_assignment(style_id, decoder) {
                    return Some(color);
                }
            }
        }
    } else if let Some(style_id) = styles_attr.as_entity_ref() {
        return extract_color_from_style_assignment(style_id, decoder);
    }

    None
}

/// Extract color from IfcPresentationStyleAssignment or IfcSurfaceStyle
fn extract_color_from_style_assignment(
    style_id: u32,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
    use ifc_lite_core::IfcType;

    let style = decoder.decode_by_id(style_id).ok()?;

    match style.ifc_type {
        IfcType::IfcPresentationStyle => {
            // IfcPresentationStyle has Styles at attr 0
            let styles_attr = style.get(0)?;
            if let Some(list) = styles_attr.as_list() {
                for item in list {
                    if let Some(inner_id) = item.as_entity_ref() {
                        if let Some(color) = extract_color_from_surface_style(inner_id, decoder) {
                            return Some(color);
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
                        if let Some(color) = extract_color_from_surface_style(inner_id, decoder) {
                            return Some(color);
                        }
                    }
                }
            }
        }
    }

    None
}

/// Extract color from IfcSurfaceStyle
fn extract_color_from_surface_style(
    style_id: u32,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
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
                if let Some(color) = extract_color_from_rendering(element_id, decoder) {
                    return Some(color);
                }
            }
        }
    }

    None
}

/// Extract color from IfcSurfaceStyleRendering or IfcSurfaceStyleShading
fn extract_color_from_rendering(
    rendering_id: u32,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
    use ifc_lite_core::IfcType;

    let rendering = decoder.decode_by_id(rendering_id).ok()?;

    match rendering.ifc_type {
        IfcType::IfcSurfaceStyleRendering | IfcType::IfcSurfaceStyleShading => {
            // Attr 0: SurfaceColour (inherited from IfcSurfaceStyleShading)
            // Attr 1: Transparency (inherited, 0.0=opaque, 1.0=transparent)
            let color_ref = rendering.get_ref(0)?;
            let [r, g, b, _] = extract_color_rgb(color_ref, decoder)?;

            // Read transparency and convert to alpha
            // Transparency: 0.0 = opaque, 1.0 = fully transparent
            // Alpha: 1.0 = opaque, 0.0 = fully transparent
            // So: alpha = 1.0 - transparency
            let transparency = rendering.get_float(1).unwrap_or(0.0);
            let alpha = 1.0 - transparency as f32;

            return Some([r, g, b, alpha.max(0.0).min(1.0)]);
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
    /// Geometry ID → color (from IfcStyledItem → surface style chain)
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
    /// Element ID → list of material-based colors (from IfcRelAssociatesMaterial chain).
    /// Used as fallback when a sub-mesh has no direct IfcStyledItem style.
    pub element_material_styles: rustc_hash::FxHashMap<u32, Vec<[f32; 4]>>,
    /// Material layer buildup index (IfcMaterialLayerSetUsage → sliceable
    /// layers). Elements here are eligible for per-layer sub-meshes even if
    /// their geometry is a single swept solid. Held in an `Arc` so it can be
    /// attached to the `GeometryRouter` without cloning the map.
    pub material_layer_index: std::sync::Arc<ifc_lite_geometry::MaterialLayerIndex>,
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
                                if let Some(color) = extract_color_from_styles(styles_attr, decoder)
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
                    if is_simple_geometry_type(type_name) {
                        simple_jobs.push((id, start, end, ifc_type));
                    } else {
                        complex_jobs.push((id, start, end, ifc_type));
                    }
                }
            }
        }
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

    // Scan IfcRelAssociatesMaterial → resolved LayerBuildup per element.
    let material_layer_index = std::sync::Arc::new(
        ifc_lite_geometry::MaterialLayerIndex::from_content(content, decoder),
    );

    // Propagate voids from aggregate parents (IfcWall) to children (IfcBuildingElementPart)
    // so that multilayer wall parts also get window/door cutouts.
    ifc_lite_geometry::propagate_voids_to_parts(&mut void_index, content, decoder);

    PrePassData {
        geometry_styles,
        void_index,
        faceted_brep_ids,
        project_id,
        site_position,
        simple_jobs,
        complex_jobs,
        element_material_styles,
        material_layer_index,
    }
}

/// Build material style index: maps material IDs to their colors.
/// Follows: material → IfcMaterialDefinitionRepresentation → IfcStyledRepresentation → orphan IfcStyledItem
fn build_material_style_index(
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
fn build_element_material_styles(
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
fn collect_material_entity(
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

/// Check if an IFC entity class is "simple" geometry (processed first for fast
/// first frame).  Instead of whitelisting known simple classes — which breaks
/// whenever new IFC entity classes appear (e.g. IFC4X3 infrastructure) — we
/// blacklist the classes that are known to be secondary/complex.  Everything
/// else with geometry defaults to "simple" priority.
pub(crate) fn is_simple_geometry_type(type_name: &str) -> bool {
    !matches!(
        type_name,
        // Openings / voids — subtracted, not rendered directly
        "IFCOPENINGELEMENT" | "IFCOPENINGSTANDARDCASE"
        // Windows & doors — detailed geometry, lower priority
        | "IFCWINDOW" | "IFCWINDOWSTANDARDCASE"
        | "IFCDOOR" | "IFCDOORSTANDARDCASE"
        // Furnishing — typically high-poly, secondary
        | "IFCFURNISHINGELEMENT" | "IFCFURNITURE" | "IFCSYSTEMFURNITUREELEMENT"
        // MEP / distribution — dense small elements
        | "IFCDISTRIBUTIONELEMENT" | "IFCDISTRIBUTIONFLOWELEMENT" | "IFCDISTRIBUTIONCONTROLELEMENT"
        | "IFCFLOWSEGMENT" | "IFCFLOWFITTING" | "IFCFLOWTERMINAL"
        | "IFCFLOWCONTROLLER" | "IFCFLOWMOVINGDEVICE" | "IFCFLOWSTORAGEDEVICE"
        | "IFCFLOWTREATMENTDEVICE" | "IFCENERGYCONVERSIONDEVICE"
        // Spatial elements — not structural
        | "IFCSPACE" | "IFCSITE"
        // Annotations & virtual
        | "IFCANNOTATION" | "IFCVIRTUALELEMENT" | "IFCPROXY"
    )
}

/// Resolve element color inline during processing by following its
/// representation chain. Replaces the upfront `build_element_style_index`
/// scan — avoids decoding every building element twice.
pub(crate) fn resolve_element_color(
    entity: &ifc_lite_core::DecodedEntity,
    geometry_styles: &rustc_hash::FxHashMap<u32, [f32; 4]>,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> Option<[f32; 4]> {
    if geometry_styles.is_empty() {
        return None;
    }

    // Building elements have Representation at attribute index 6
    let repr_id = entity.get_ref(6)?;
    let product_shape = decoder.decode_by_id(repr_id).ok()?;
    let reprs_list = product_shape.get(2)?.as_list()?;

    for repr_item in reprs_list {
        let shape_repr_id = repr_item.as_entity_ref()?;
        let shape_repr = decoder.decode_by_id(shape_repr_id).ok()?;
        let items_list = shape_repr.get(3)?.as_list()?;

        for geom_item in items_list {
            let geom_id = geom_item.as_entity_ref()?;
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
