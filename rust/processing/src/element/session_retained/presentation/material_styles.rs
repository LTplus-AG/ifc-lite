// SPDX-License-Identifier: MPL-2.0
//! M4's retained-only material keys, resolved once from exact's style functions.
use crate::prepass::{extract_style_info_from_styled_item, ResolvedPrepass};
use ifc_lite_core::EntityDecoder;

pub(crate) fn join(resolved: &mut ResolvedPrepass, decoder: &mut EntityDecoder) {
    let styles = crate::style::build_material_style_index(
        &resolved.material_def_reprs, &resolved.orphan_styled_items, decoder);
    for (material, color) in crate::style::flatten_material_color_index(&styles) {
        // Keep the selected style's name as well as its colour. Selection and
        // metadata extraction both belong to exact; no second colour policy.
        let mut info = None;
        'selected: for repr_id in resolved.material_def_reprs.get(&material).into_iter().flatten() {
            let Ok(repr) = decoder.decode_by_id(*repr_id) else { continue };
            for id in repr.get_refs(3).unwrap_or_default() {
                let Ok(item) = decoder.decode_by_id(id) else { continue };
                info = extract_style_info_from_styled_item(&item, decoder).filter(|info| info.color == color);
                if info.is_some() { break 'selected; }
            }
        }
        resolved.geometry_style_index.entry(material).or_insert_with(|| info.unwrap_or(
            crate::style::GeometryStyleInfo { color, shading_color: None, material_name: None }));
    }
}
