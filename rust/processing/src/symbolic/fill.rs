// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::output_cap::SymbolicAccumulator;
use super::rebase::RenderFrameRebase;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::collections::HashMap;

use super::color::resolve_color_via_styles;
use super::primitives::{SymbolicFillArea};
use super::conic::{conic_basis, Conic};
use super::transform::{push_finite_point, Transform2D};

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
    rebase: RenderFrameRebase,
    styled_items: &HashMap<u32, Vec<u32>>,
    out: &mut SymbolicAccumulator,
    geometry_item_id: Option<u32>,
) {
    let Some(outer_ref) = item.get_ref(0) else { return };
    let mut points = extract_curve_ring(outer_ref, decoder, unit_scale, transform, rebase);
    if points.len() < 6 {
        return;
    }

    let mut holes_offsets: Vec<u32> = Vec::new();
    if let Some(inners_attr) = item.get(1) {
        if let Ok(inner_list) = decoder.resolve_ref_list(inners_attr) {
            for inner in inner_list {
                let hole = extract_curve_ring(inner.id, decoder, unit_scale, transform, rebase);
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
    let world_y = rebase.elevation(sample_curve_world_y(outer_ref, decoder, unit_scale) + transform.tz);

    out.push_fill_with_provenance(SymbolicFillArea {
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
    }, geometry_item_id);
}

/// Extract one ring of `(x, y)` points from any supported boundary curve.
/// Returns an empty vec on unsupported types or parse failure.
fn extract_curve_ring(
    curve_id: u32,
    decoder: &mut EntityDecoder,
    unit_scale: f32,
    transform: &Transform2D,
    rebase: RenderFrameRebase,
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
                let (px, py) = rebase.plan(wx, wy);
                push_finite_point(&mut out, px, py);
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
                let (px, py) = rebase.plan(wx, wy);
                push_finite_point(&mut out, px, py);
            }
            out
        }
        IfcType::IfcCircle | IfcType::IfcEllipse => {
            let Some(conic) = Conic::read(&curve, decoder, unit_scale) else { return Vec::new() };
            let segments = if curve.ifc_type == IfcType::IfcCircle && conic.semi_a < 0.05 { 32 } else { 64 };
            let mut out = Vec::with_capacity(segments * 2);
            for i in 0..segments {
                let theta = (i as f32) * std::f32::consts::TAU / (segments as f32);
                let (lx, ly) = conic.point_at(theta);
                let (wx, wy) = transform.transform_point(lx, ly);
                let (px, py) = rebase.plan(wx, wy);
                push_finite_point(&mut out, px, py);
            }
            out
        }
        _ => Vec::new(),
    }
}

/// Peek at the boundary curve's first 3D point Z so a fill / line can carry
/// its elevation forward. Returns 0.0 for 2D-only curves and NaN (unresolved,
/// serialised as `null`) for a conic whose mandatory `Position` is missing.
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
        IfcType::IfcCircle | IfcType::IfcEllipse => conic_basis(&curve, decoder, unit_scale).tz,
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
