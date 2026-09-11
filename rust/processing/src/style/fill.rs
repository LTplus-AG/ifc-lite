// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical fill-area colour leaf shared by symbolic and 3D annotations.
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

pub(crate) fn extract_color_from_fill_area_style(
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
    let refs = styled.get_list(1)?;
    if refs.len() > 64 {
        return None;
    }
    for attr in refs {
        let style = decoder.decode_by_id(attr.as_entity_ref()?).ok()?;
        if decoder.get_raw_bytes(style.id).and_then(|raw| {
            ifc_lite_core::EntityScanner::new(raw)
                .next_entity()
                .map(|(_, name, _, _)| name == "IFCPRESENTATIONSTYLEASSIGNMENT")
        }) == Some(true)
        {
            let inner = style.get_list(0)?;
            if inner.len() > 64 {
                return None;
            }
            for attr in inner {
                let fill = decoder.decode_by_id(attr.as_entity_ref()?).ok()?;
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
