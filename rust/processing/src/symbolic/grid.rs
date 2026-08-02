// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use super::primitives::{SymbolicData, SymbolicGridAxis, SymbolicPolyline, SymbolicText};
use super::transform::Transform2D;

// ────────────────────────────────────────────────────────────────────────────
// Grid extraction (axis lines + bubble/tag pairs).
// ────────────────────────────────────────────────────────────────────────────

const BUBBLE_OFFSET_M: f32 = 1.2;
const BUBBLE_CAP_M: f32 = 2.0;
const BUBBLE_TARGET_PX: f32 = 32.0;
const TAG_CAP_M: f32 = 0.7;
const TAG_TARGET_PX: f32 = 14.0;

#[allow(clippy::too_many_arguments)]
pub(super) fn extract_grid(
    grid: &DecodedEntity,
    grid_id: u32,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    out: &mut SymbolicData,
) {
    for axis_attr_idx in [7usize, 8, 9] {
        let Some(axes_attr) = grid.get(axis_attr_idx) else { continue };
        let Ok(axes) = decoder.resolve_ref_list(axes_attr) else { continue };
        for axis in axes {
            if axis.ifc_type != IfcType::IfcGridAxis {
                continue;
            }
            let axis_id = axis.id;
            let tag = axis.get(0).and_then(|a| a.as_string()).unwrap_or("").to_string();

            let Some(curve_ref) = axis.get_ref(1) else { continue };
            let Ok(curve) = decoder.decode_by_id(curve_ref) else { continue };
            let Some((p0, p1)) = sample_grid_axis_endpoints(&curve, decoder, unit_scale, transform)
            else {
                continue;
            };

            let a = (p0.0 - rtc_x, -p0.1 + rtc_z);
            let b = (p1.0 - rtc_x, -p1.1 + rtc_z);
            let world_y = transform.tz;

            // Compact server-friendly entry — keeps the existing endpoint-pair shape.
            out.grid_axes.push(SymbolicGridAxis {
                express_id: axis_id,
                grid_express_id: grid_id,
                tag: tag.clone(),
                endpoints: [a.0, a.1, b.0, b.1],
                world_y,
            });

            // Axis line (browser pipeline: SymbolicPolyline + bubble texts).
            out.polylines.push(SymbolicPolyline {
                express_id: axis_id,
                ifc_type: "IfcGridAxis".to_string(),
                points: vec![a.0, a.1, b.0, b.1],
                closed: false,
                world_y,
                representation: "Axis".to_string(),
            });

            // Unit direction along the axis for bubble offset.
            let dx = b.0 - a.0;
            let dy = b.1 - a.1;
            let len = (dx * dx + dy * dy).sqrt();
            if len < 1e-4 {
                continue;
            }
            let nx = dx / len;
            let ny = dy / len;

            let cx0 = a.0 - nx * BUBBLE_OFFSET_M;
            let cy0 = a.1 - ny * BUBBLE_OFFSET_M;
            emit_bubble(axis_id, cx0, cy0, world_y, &tag, out);

            let cx1 = b.0 + nx * BUBBLE_OFFSET_M;
            let cy1 = b.1 + ny * BUBBLE_OFFSET_M;
            emit_bubble(axis_id, cx1, cy1, world_y, &tag, out);
        }
    }
}

/// Emit a bubble (transparent interior + black outline ○ + tag text) as
/// two stacked text instances. The shader's per-instance `target_px` keeps
/// them at the right relative size at every zoom level.
fn emit_bubble(axis_id: u32, cx: f32, cy: f32, world_y: f32, tag: &str, out: &mut SymbolicData) {
    out.texts.push(SymbolicText {
        express_id: axis_id,
        ifc_type: "IfcGridAxis".to_string(),
        x: cx,
        y: cy,
        dir_x: 1.0,
        dir_y: 0.0,
        height: BUBBLE_CAP_M,
        content: "\u{25EF}".to_string(),
        alignment: "center".to_string(),
        world_y,
        color: [0.0, 0.0, 0.0, 1.0],
        target_px: BUBBLE_TARGET_PX,
        representation: "Axis".to_string(),
    });
    out.texts.push(SymbolicText {
        express_id: axis_id,
        ifc_type: "IfcGridAxis".to_string(),
        x: cx,
        y: cy,
        dir_x: 1.0,
        dir_y: 0.0,
        height: TAG_CAP_M,
        content: tag.to_string(),
        alignment: "center".to_string(),
        world_y,
        color: [0.0, 0.0, 0.0, 1.0],
        target_px: TAG_TARGET_PX,
        representation: "Axis".to_string(),
    });
}

/// Sample the two endpoints of an `IfcGridAxis` curve. In practice always
/// an `IfcPolyline` of two `IfcCartesianPoint`s, but we accept the general
/// polyline shape — first + last points of the list.
fn sample_grid_axis_endpoints(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
    transform: &Transform2D,
) -> Option<((f32, f32), (f32, f32))> {
    if curve.ifc_type != IfcType::IfcPolyline {
        return None;
    }
    let pts_attr = curve.get(0)?;
    let point_entities = decoder.resolve_ref_list(pts_attr).ok()?;
    if point_entities.len() < 2 {
        return None;
    }
    let extract = |pe: &DecodedEntity| -> Option<(f32, f32)> {
        if pe.ifc_type != IfcType::IfcCartesianPoint {
            return None;
        }
        let coords = pe.get(0)?.as_list()?;
        let x = coords.first()?.as_float()? as f32 * unit_scale;
        let y = coords.get(1)?.as_float()? as f32 * unit_scale;
        Some(transform.transform_point(x, y))
    };
    let first = extract(&point_entities[0])?;
    let last = extract(&point_entities[point_entities.len() - 1])?;
    Some((first, last))
}
