// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use std::collections::HashMap;

// ────────────────────────────────────────────────────────────────────────────
// IfcStyledItem reverse index + colour resolution.
// ────────────────────────────────────────────────────────────────────────────

pub(super) fn build_styled_item_index(content: &[u8], decoder: &mut EntityDecoder) -> HashMap<u32, Vec<u32>> {
    let collect_refs = |attr: &AttributeValue| -> Vec<u32> {
        if let Some(list) = attr.as_list() {
            list.iter().filter_map(|v| v.as_entity_ref()).collect()
        } else if let Some(single) = attr.as_entity_ref() {
            vec![single]
        } else {
            Vec::new()
        }
    };

    // Pass 1: presentation-style-assignment wrapper map.
    let mut wrappers: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCPRESENTATIONSTYLEASSIGNMENT" {
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else { continue };
        let Some(styles_attr) = entity.get(0) else { continue };
        let inner_refs = collect_refs(styles_attr);
        if !inner_refs.is_empty() {
            wrappers.insert(id, inner_refs);
        }
    }

    // Pass 2: item → style index, unwrapping wrappers transparently.
    let mut out: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCSTYLEDITEM" {
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else { continue };
        let Some(item_ref) = entity.get_ref(0) else { continue };
        let Some(styles_attr) = entity.get(1) else { continue };
        let mut final_refs: Vec<u32> = Vec::new();
        for raw_ref in collect_refs(styles_attr) {
            if let Some(inner) = wrappers.get(&raw_ref) {
                final_refs.extend(inner.iter().copied());
            } else {
                final_refs.push(raw_ref);
            }
        }
        if !final_refs.is_empty() {
            out.entry(item_ref).or_default().extend(final_refs);
        }
    }
    out
}

pub(super) fn resolve_color_via_styles(
    item_id: u32,
    styled_items: &HashMap<u32, Vec<u32>>,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let style_refs = styled_items.get(&item_id)?;
    for style_ref in style_refs {
        if let Some(color) = extract_color_from_style_ref(*style_ref, decoder) {
            return Some(color);
        }
    }
    None
}

fn extract_color_from_style_ref(style_ref: u32, decoder: &mut EntityDecoder) -> Option<[f32; 4]> {
    let style = decoder.decode_by_id(style_ref).ok()?;
    match style.ifc_type {
        IfcType::IfcFillAreaStyle => extract_color_from_fill_area_style(&style, decoder),
        IfcType::IfcTextStyle => extract_color_from_text_style(&style, decoder),
        _ => None,
    }
}

fn extract_color_from_text_style(
    style: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let appearance = decoder.decode_by_id(style.get_ref(1)?).ok()?;
    if appearance.ifc_type != IfcType::IfcTextStyleForDefinedFont {
        return None;
    }
    let colour = decoder.decode_by_id(appearance.get_ref(0)?).ok()?;
    if colour.ifc_type != IfcType::IfcColourRgb {
        return None;
    }
    let r = colour.get(1)?.as_float()? as f32;
    let g = colour.get(2)?.as_float()? as f32;
    let b = colour.get(3)?.as_float()? as f32;
    Some([r, g, b, 1.0])
}

fn extract_color_from_fill_area_style(
    style: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    let fill_styles_attr = style.get(1)?;
    let fill_style_refs: Vec<u32> = if let Some(list) = fill_styles_attr.as_list() {
        list.iter().filter_map(|v| v.as_entity_ref()).collect()
    } else if let Some(single) = fill_styles_attr.as_entity_ref() {
        vec![single]
    } else {
        return None;
    };
    for fs_ref in fill_style_refs {
        let Ok(fs) = decoder.decode_by_id(fs_ref) else { continue };
        if fs.ifc_type == IfcType::IfcColourRgb {
            if let (Some(r), Some(g), Some(b)) = (
                fs.get(1).and_then(|v| v.as_float()),
                fs.get(2).and_then(|v| v.as_float()),
                fs.get(3).and_then(|v| v.as_float()),
            ) {
                return Some([r as f32, g as f32, b as f32, 1.0]);
            }
        }
    }
    None
}
