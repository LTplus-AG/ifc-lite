// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::style::fill::extract_color_from_fill_area_style;
use ifc_lite_core::{keyword_eq, DecodedEntity, EntityDecoder, EntityScanner, IfcType};
use std::collections::HashMap;

// ────────────────────────────────────────────────────────────────────────────
// IfcStyledItem reverse index + colour resolution.
// ────────────────────────────────────────────────────────────────────────────

pub(super) fn build_styled_item_index(content: &[u8], decoder: &mut EntityDecoder) -> HashMap<u32, Vec<u32>> {
    // One scan finds both record kinds (PROCESSING-SYM-18). Decoding still
    // runs every wrapper before any styled item, in file order, so the
    // decoder cache sees the same sequence as the former two scans.
    let mut assignments: Vec<(u32, usize, usize)> = Vec::new();
    let mut styled_items: Vec<(u32, usize, usize)> = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if keyword_eq(type_name, "IFCPRESENTATIONSTYLEASSIGNMENT") {
            assignments.push((id, start, end));
        } else if keyword_eq(type_name, "IFCSTYLEDITEM") {
            styled_items.push((id, start, end));
        }
    }

    // Presentation-style-assignment wrapper map.
    let mut wrappers: HashMap<u32, Vec<u32>> = HashMap::new();
    for (id, start, end) in assignments {
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else { continue };
        if let Some(inner_refs) = entity.get_refs(0) {
            wrappers.insert(id, inner_refs);
        }
    }

    // Item → style index, unwrapping wrappers transparently.
    let mut out: HashMap<u32, Vec<u32>> = HashMap::new();
    for (id, start, end) in styled_items {
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else { continue };
        let Some(item_ref) = entity.get_ref(0) else { continue };
        let Some(styles) = entity.get_refs(1) else { continue };
        let mut final_refs: Vec<u32> = Vec::new();
        for raw_ref in styles {
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

#[cfg(test)]
#[path = "color_tests.rs"]
mod tests;
