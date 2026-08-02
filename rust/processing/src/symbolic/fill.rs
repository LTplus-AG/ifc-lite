// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::collections::HashMap;

use super::color::resolve_color_via_styles;
use super::primitives::{SymbolicData, SymbolicFillArea};
use super::transform::{circle_center, Transform2D};

// ────────────────────────────────────────────────────────────────────────────
// Fill area extraction (IfcAnnotationFillArea).
// ────────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub(super) fn extract_annotation_fill_area(
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
    let Some(outer_ref) = item.get_ref(0) else { return };
    let mut points = extract_curve_ring(outer_ref, decoder, unit_scale, transform, rtc_x, rtc_z);
    if points.len() < 6 {
        return;
    }

    let mut holes_offsets: Vec<u32> = Vec::new();
    if let Some(inners_attr) = item.get(1) {
        if let Ok(inner_list) = decoder.resolve_ref_list(inners_attr) {
            for inner in inner_list {
                let hole = extract_curve_ring(inner.id, decoder, unit_scale, transform, rtc_x, rtc_z);
                if hole.len() >= 6 {
                    let vertex_index = (points.len() / 2) as u32;
                    holes_offsets.push(vertex_index);
                    points.extend(hole);
                }
            }
        }
    }

    let fill_color = resolve_color_via_styles(item.id, styled_items, decoder)
        .unwrap_or([0.0, 0.0, 0.0, 1.0]);
    let world_y = sample_curve_world_y(outer_ref, decoder, unit_scale) + transform.tz;

    out.fills.push(SymbolicFillArea {
        express_id,
        ifc_type: ifc_type.to_string(),
        points,
        holes_offsets,
        fill_color,
        has_hatching: false,
        hatch_spacing: 0.0,
        hatch_angle: 0.0,
        hatch_angle_secondary: f32::NAN,
        hatch_line_width: 0.0,
        world_y,
        representation: rep_identifier.to_string(),
    });
}

/// Extract one ring of `(x, y)` points from any supported boundary curve.
/// Returns an empty vec on unsupported types or parse failure.
fn extract_curve_ring(
    curve_id: u32,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
) -> Vec<f32> {
    let Ok(curve) = decoder.decode_by_id(curve_id) else {
        return Vec::new();
    };
    match curve.ifc_type {
        IfcType::IfcPolyline => {
            let Some(points_attr) = curve.get(0) else { return Vec::new() };
            let Ok(point_entities) = decoder.resolve_ref_list(points_attr) else {
                return Vec::new();
            };
            let mut out = Vec::with_capacity(point_entities.len() * 2);
            for pe in point_entities {
                if pe.ifc_type != IfcType::IfcCartesianPoint {
                    continue;
                }
                let Some(coords) = pe.get(0).and_then(|a| a.as_list()) else { continue };
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let (wx, wy) = transform.transform_point(x, y);
                out.push(wx - rtc_x);
                out.push(-wy + rtc_z);
            }
            out
        }
        IfcType::IfcIndexedPolyCurve => {
            let Some(points_ref) = curve.get_ref(0) else { return Vec::new() };
            let Ok(points_entity) = decoder.decode_by_id(points_ref) else { return Vec::new() };
            let Some(coord_list_attr) = points_entity.get(0) else { return Vec::new() };
            let Some(coord_list) = coord_list_attr.as_list() else { return Vec::new() };
            let mut out = Vec::with_capacity(coord_list.len() * 2);
            for tuple in coord_list {
                let Some(coords) = tuple.as_list() else { continue };
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let (wx, wy) = transform.transform_point(x, y);
                out.push(wx - rtc_x);
                out.push(-wy + rtc_z);
            }
            out
        }
        IfcType::IfcEllipse => {
            let semi_a = curve.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            let semi_b = curve.get(2).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            if semi_a <= 0.0 || semi_b <= 0.0 || !semi_a.is_finite() || !semi_b.is_finite() {
                return Vec::new();
            }
            let (cx_local, cy_local, _) = circle_center(&curve, decoder, unit_scale);
            const SEGMENTS: usize = 64;
            let mut out = Vec::with_capacity(SEGMENTS * 2);
            for i in 0..SEGMENTS {
                let theta = (i as f32) * std::f32::consts::TAU / (SEGMENTS as f32);
                let lx = cx_local + semi_a * theta.cos();
                let ly = cy_local + semi_b * theta.sin();
                let (wx, wy) = transform.transform_point(lx, ly);
                out.push(wx - rtc_x);
                out.push(-wy + rtc_z);
            }
            out
        }
        IfcType::IfcCircle => {
            let radius = curve.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            if radius <= 0.0 || !radius.is_finite() {
                return Vec::new();
            }
            let (cx_local, cy_local, _) = circle_center(&curve, decoder, unit_scale);
            let seg_count = if radius < 0.05 { 32 } else { 64 };
            let mut out = Vec::with_capacity(seg_count * 2);
            let two_pi = std::f32::consts::TAU;
            for i in 0..seg_count {
                let theta = (i as f32) * two_pi / (seg_count as f32);
                let lx = cx_local + radius * theta.cos();
                let ly = cy_local + radius * theta.sin();
                let (wx, wy) = transform.transform_point(lx, ly);
                out.push(wx - rtc_x);
                out.push(-wy + rtc_z);
            }
            out
        }
        _ => Vec::new(),
    }
}

/// Peek at the boundary curve's first 3D point Z so a fill / line can carry
/// its elevation forward. Returns 0.0 for 2D-only curves.
fn sample_curve_world_y(curve_id: u32, decoder: &mut EntityDecoder, unit_scale: f32) -> f32 {
    let Ok(curve) = decoder.decode_by_id(curve_id) else { return 0.0 };
    match curve.ifc_type {
        IfcType::IfcPolyline => {
            let Some(points_attr) = curve.get(0) else { return 0.0 };
            let Ok(point_entities) = decoder.resolve_ref_list(points_attr) else { return 0.0 };
            for pe in point_entities {
                if pe.ifc_type != IfcType::IfcCartesianPoint {
                    continue;
                }
                if let Some(coords) = pe.get(0).and_then(|a| a.as_list()) {
                    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                    return z;
                }
            }
            0.0
        }
        IfcType::IfcCircle | IfcType::IfcEllipse => {
            let (_, _, z) = circle_center(&curve, decoder, unit_scale);
            z
        }
        IfcType::IfcIndexedPolyCurve => {
            let Some(points_ref) = curve.get_ref(0) else { return 0.0 };
            let Ok(points_entity) = decoder.decode_by_id(points_ref) else { return 0.0 };
            let Some(coord_list_attr) = points_entity.get(0) else { return 0.0 };
            let Some(coord_list) = coord_list_attr.as_list() else { return 0.0 };
            if let Some(first) = coord_list.first().and_then(|v| v.as_list()) {
                return first.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            }
            0.0
        }
        _ => 0.0,
    }
}
