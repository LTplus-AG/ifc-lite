// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Material-chain colour resolution (issue #913 / #407).
//!
//! Ported from the browser pipeline so the backend colours elements whose
//! appearance lives on the *material* rather than on the geometry. Most BIM
//! authoring tools (ArchiCAD IFC2x3, etc.) assign glass-vs-frame appearance via
//!
//! ```text
//! element ─IfcRelAssociatesMaterial→ material select
//!   material ─IfcMaterialDefinitionRepresentation→ IfcStyledRepresentation
//!     └─ orphan IfcStyledItem (null Item) → IfcSurfaceStyle → IfcColourRgb
//! ```
//!
//! Pre-fix the backend only read `IfcStyledItem` attached directly to geometry,
//! so material-only-styled files rendered as the default type colour.
//!
//! The orphan-styled-item colours are extracted by the caller (the processor's
//! existing `IfcStyledItem` walk) and passed in as `orphan_styled_items`; this
//! module walks the material `SELECT` graph and joins the two.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashMap;

use super::TRANSPARENCY_ALPHA_THRESHOLD;

/// Maximum recursion depth for material resolution (guards malformed cycles).
const MAX_MATERIAL_RESOLVE_DEPTH: u8 = 4;

/// Build the `element id → material colours` map: every colour each element
/// inherits from its associated material(s), in resolution order. The single
/// general-path fallback picks the first opaque colour ([`pick_opaque_first`]);
/// the opening sub-mesh path alternates transparent/opaque
/// ([`pick_material_style_for_submesh`]) to split glass vs frame.
///
/// - `material_def_reprs`: material id → its `IfcStyledRepresentation` ids.
/// - `orphan_styled_items`: styled-item id → colour, for styled items with a
///   null `Item` (i.e. material appearances).
/// - `element_to_material`: element id → material `SELECT` id.
pub fn build_element_material_colors(
    material_def_reprs: &FxHashMap<u32, Vec<u32>>,
    orphan_styled_items: &FxHashMap<u32, [f32; 4]>,
    element_to_material: &FxHashMap<u32, u32>,
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, Vec<[f32; 4]>> {
    if element_to_material.is_empty() || orphan_styled_items.is_empty() {
        return FxHashMap::default();
    }

    let material_styles = build_material_style_index(material_def_reprs, orphan_styled_items, decoder);
    if material_styles.is_empty() {
        return FxHashMap::default();
    }

    let mut out: FxHashMap<u32, Vec<[f32; 4]>> = FxHashMap::default();
    for (&element_id, &material_select_id) in element_to_material {
        let mut colors: Vec<[f32; 4]> = Vec::new();
        for material_id in resolve_material_ids(material_select_id, decoder) {
            if let Some(mat_colors) = material_styles.get(&material_id) {
                colors.extend(mat_colors);
            }
        }
        if !colors.is_empty() {
            out.insert(element_id, colors);
        }
    }
    out
}

/// Flatten a `material id → colours` map into `material id → colour` by picking
/// the first opaque colour per material ([`pick_opaque_first`]). Used to key
/// layered sub-mesh colour lookups on material id — each layer slice's
/// `geometry_id` is its `IfcMaterial` entity id.
pub fn flatten_material_color_index(
    material_styles: &FxHashMap<u32, Vec<[f32; 4]>>,
) -> FxHashMap<u32, [f32; 4]> {
    material_styles
        .iter()
        .filter_map(|(&mat_id, colors)| pick_opaque_first(colors).map(|c| (mat_id, c)))
        .collect()
}

/// Pick the first opaque colour (alpha ≥ threshold), else the first colour.
pub fn pick_opaque_first(colors: &[[f32; 4]]) -> Option<[f32; 4]> {
    if colors.is_empty() {
        return None;
    }
    Some(
        colors
            .iter()
            .find(|c| c[3] >= TRANSPARENCY_ALPHA_THRESHOLD)
            .copied()
            .unwrap_or(colors[0]),
    )
}

/// Pick a material colour for one sub-mesh, alternating preference so a window
/// distributes its frame (opaque) and glazing (transparent) colours across
/// sub-meshes instead of painting every part the same. `prefer_transparent`
/// is toggled by the caller per sub-mesh.
pub fn pick_material_style_for_submesh(
    colors: &[[f32; 4]],
    prefer_transparent: bool,
) -> Option<[f32; 4]> {
    if colors.is_empty() {
        return None;
    }
    let matched = if prefer_transparent {
        colors.iter().find(|c| c[3] < TRANSPARENCY_ALPHA_THRESHOLD)
    } else {
        colors.iter().find(|c| c[3] >= TRANSPARENCY_ALPHA_THRESHOLD)
    };
    Some(matched.copied().unwrap_or(colors[0]))
}

/// material id → colours, by following each material's styled representations to
/// the orphan styled items they reference.
pub fn build_material_style_index(
    material_def_reprs: &FxHashMap<u32, Vec<u32>>,
    orphan_styled_items: &FxHashMap<u32, [f32; 4]>,
    decoder: &mut EntityDecoder,
) -> FxHashMap<u32, Vec<[f32; 4]>> {
    let mut material_styles: FxHashMap<u32, Vec<[f32; 4]>> = FxHashMap::default();
    for (&material_id, styled_repr_ids) in material_def_reprs {
        for &styled_repr_id in styled_repr_ids {
            let Ok(styled_repr) = decoder.decode_by_id(styled_repr_id) else {
                continue;
            };
            // IfcStyledRepresentation : IfcRepresentation — Items is attr 3.
            for styled_item_id in extract_refs_from_list(&styled_repr, 3) {
                if let Some(&color) = orphan_styled_items.get(&styled_item_id) {
                    material_styles.entry(material_id).or_default().push(color);
                }
            }
        }
    }
    material_styles
}

/// Resolve a material `SELECT` to the individual `IfcMaterial` ids it contains.
pub fn resolve_material_ids(material_select_id: u32, decoder: &mut EntityDecoder) -> Vec<u32> {
    resolve_material_ids_inner(material_select_id, decoder, 0)
}

fn resolve_material_ids_inner(
    material_select_id: u32,
    decoder: &mut EntityDecoder,
    depth: u8,
) -> Vec<u32> {
    if depth >= MAX_MATERIAL_RESOLVE_DEPTH {
        return vec![];
    }
    let Ok(entity) = decoder.decode_by_id(material_select_id) else {
        return vec![];
    };
    match entity.ifc_type {
        IfcType::IfcMaterial => vec![material_select_id],
        // IfcMaterialList.Materials (attr 0)
        IfcType::IfcMaterialList => extract_refs_from_list(&entity, 0),
        // IfcMaterialLayerSetUsage.ForLayerSet (attr 0) → IfcMaterialLayerSet
        IfcType::IfcMaterialLayerSetUsage => entity
            .get_ref(0)
            .map(|id| resolve_material_ids_inner(id, decoder, depth + 1))
            .unwrap_or_default(),
        // IfcMaterialLayerSet.MaterialLayers (attr 0) → IfcMaterialLayer.Material (attr 0)
        IfcType::IfcMaterialLayerSet => extract_nested_material_ids(&entity, 0, 0, decoder),
        // IfcMaterialConstituentSet.MaterialConstituents (attr 2) → .Material (attr 2)
        IfcType::IfcMaterialConstituentSet => extract_nested_material_ids(&entity, 2, 2, decoder),
        // IfcMaterialProfileSet.MaterialProfiles (attr 2) → IfcMaterialProfile.Material (attr 2)
        IfcType::IfcMaterialProfileSet => extract_nested_material_ids(&entity, 2, 2, decoder),
        IfcType::IfcMaterialProfileSetUsage | IfcType::IfcMaterialProfileSetUsageTapering => entity
            .get_ref(0)
            .map(|id| resolve_material_ids_inner(id, decoder, depth + 1))
            .unwrap_or_default(),
        _ => vec![],
    }
}

/// Read a list of container refs at `container_list_attr_idx`, then the
/// `IfcMaterial` ref at `material_attr_idx` on each container.
fn extract_nested_material_ids(
    entity: &DecodedEntity,
    container_list_attr_idx: usize,
    material_attr_idx: usize,
    decoder: &mut EntityDecoder,
) -> Vec<u32> {
    let mut materials = Vec::new();
    for container_id in extract_refs_from_list(entity, container_list_attr_idx) {
        if let Ok(container) = decoder.decode_by_id(container_id) {
            if let Some(mat_id) = container.get_ref(material_attr_idx) {
                materials.push(mat_id);
            }
        }
    }
    materials
}

fn extract_refs_from_list(entity: &DecodedEntity, index: usize) -> Vec<u32> {
    entity
        .get(index)
        .and_then(|attr| attr.as_list())
        .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
        .unwrap_or_default()
}
