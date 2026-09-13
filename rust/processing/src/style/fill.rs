// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical fill-area colour leaf shared by symbolic and 3D annotations.
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};

/// The entity references in a style-list attribute (`IfcStyledItem.Styles`,
/// `IfcPresentationStyleAssignment.Styles`, `IfcFillAreaStyle.FillStyles`),
/// read by one rule for the 2D symbolic index (`symbolic::color`) and the
/// pre-pass fill reader below: a list is walked, a bare reference is a
/// one-element list, and members that are not references are skipped.
pub(crate) fn style_refs(attr: &AttributeValue) -> Vec<u32> {
    if let Some(list) = attr.as_list() {
        list.iter().filter_map(|v| v.as_entity_ref()).collect()
    } else if let Some(single) = attr.as_entity_ref() {
        vec![single]
    } else {
        Vec::new()
    }
}

pub(crate) fn extract_color_from_fill_area_style(
    style: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<[f32; 4]> {
    for fs_ref in style_refs(style.get(1)?) {
        let Ok(fs) = decoder.decode_by_id(fs_ref) else {
            continue;
        };
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

/// Separate from surface lookup: appearance cloning must never clone a fill as
/// an IfcSurfaceStyle. Only fill-area items acquire this 3D annotation style.
pub(crate) fn fill_style_from_styled_item(
    styled: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<super::GeometryStyleInfo> {
    let item = decoder.decode_by_id(styled.get_ref(0)?).ok()?;
    if item.ifc_type != IfcType::IfcAnnotationFillArea {
        return None;
    }
    let refs = style_refs(styled.get(1)?);
    if refs.len() > 64 {
        return None;
    }
    // An unresolved reference (dangling in a partial export) is skipped, as
    // `symbolic::color` skips it, never fatal for the whole styled item.
    for style_ref in refs {
        let Ok(style) = decoder.decode_by_id(style_ref) else { continue };
        if decoder.get_raw_bytes(style.id).and_then(|raw| {
            ifc_lite_core::EntityScanner::new(raw)
                .next_entity()
                .map(|(_, name, _, _)| ifc_lite_core::keyword_eq(name, "IFCPRESENTATIONSTYLEASSIGNMENT"))
        }) == Some(true)
        {
            let Some(inner_attr) = style.get(0) else { continue };
            let inner = style_refs(inner_attr);
            if inner.len() > 64 {
                return None;
            }
            for fill_ref in inner {
                let Ok(fill) = decoder.decode_by_id(fill_ref) else { continue };
                if let Some(info) = fill_info(&fill, decoder) {
                    return Some(info);
                }
            }
        } else if let Some(info) = fill_info(&style, decoder) {
            return Some(info);
        }
    }
    None
}
fn fill_info(
    style: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<super::GeometryStyleInfo> {
    if style.ifc_type != IfcType::IfcFillAreaStyle {
        return None;
    }
    Some(super::GeometryStyleInfo {
        color: extract_color_from_fill_area_style(style, decoder)?,
        shading_color: None,
        material_name: style
            .get_string(0)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned),
    })
}
