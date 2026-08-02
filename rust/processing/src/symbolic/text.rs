// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::collections::HashMap;

use super::color::resolve_color_via_styles;
use super::primitives::{SymbolicData, SymbolicText};
use super::transform::{compose_transforms, parse_axis2_placement_2d, Transform2D};

// ────────────────────────────────────────────────────────────────────────────
// Text extraction (IfcTextLiteral / IfcTextLiteralWithExtent).
// ────────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub(super) fn extract_text_literal(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    styled_items: &HashMap<u32, Vec<u32>>,
    out: &mut SymbolicData,
) {
    let content = match item.get(0).and_then(|a| a.as_string()) {
        Some(s) => s.to_string(),
        None => return,
    };

    let placement_transform = match item.get_ref(1) {
        Some(p_ref) => match decoder.decode_by_id(p_ref) {
            Ok(p) => parse_axis2_placement_2d(&p, decoder, unit_scale),
            Err(_) => Transform2D::identity(),
        },
        None => Transform2D::identity(),
    };
    let composed = compose_transforms(transform, &placement_transform);

    const CAP_TO_BOX_RATIO: f32 = 0.7;
    const FALLBACK_CAP_HEIGHT_M: f32 = 0.18;
    let height_model_units = if item.ifc_type == IfcType::IfcTextLiteralWithExtent {
        item.get_ref(3)
            .and_then(|extent_ref| decoder.decode_by_id(extent_ref).ok())
            .and_then(|extent| extent.get(1).and_then(|a| a.as_float()))
            .map(|h| (h as f32) * CAP_TO_BOX_RATIO)
            .unwrap_or(FALLBACK_CAP_HEIGHT_M / unit_scale.max(1e-6))
    } else {
        FALLBACK_CAP_HEIGHT_M / unit_scale.max(1e-6)
    };

    let alignment = if item.ifc_type == IfcType::IfcTextLiteralWithExtent {
        item.get(4)
            .and_then(|a| a.as_string())
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };

    let (wx, wy) = composed.transform_point(0.0, 0.0);
    let color = resolve_color_via_styles(item.id, styled_items, decoder)
        .unwrap_or([0.05, 0.05, 0.05, 1.0]);

    out.texts.push(SymbolicText {
        express_id,
        ifc_type: ifc_type.to_string(),
        x: wx - rtc_x,
        y: -wy + rtc_z,
        dir_x: composed.cos_theta,
        dir_y: -composed.sin_theta, // mirror to match Y-flipped coord system
        height: height_model_units * unit_scale,
        content,
        alignment,
        world_y: composed.tz,
        color,
        target_px: 0.0,
        representation: rep_identifier.to_string(),
    });
}
