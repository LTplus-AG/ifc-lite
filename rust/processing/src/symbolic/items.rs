// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use std::collections::HashMap;

use super::fill::extract_annotation_fill_area;
use super::primitives::{SymbolicCircle, SymbolicData, SymbolicPolyline};
use super::text::extract_text_literal;
use super::transform::{
    circle_center, compose_transforms, parse_axis2_placement_2d,
    parse_cartesian_transformation_operator, Transform2D,
};

// ────────────────────────────────────────────────────────────────────────────
// Item dispatch. One function per IFC representation-item type; recursive
// for set + mapped-item containers.
// ────────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub(super) fn extract_symbolic_item(
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
    match item.ifc_type {
        IfcType::IfcGeometricSet | IfcType::IfcGeometricCurveSet => {
            if let Some(elements_attr) = item.get(0) {
                if let Ok(elements) = decoder.resolve_ref_list(elements_attr) {
                    for element in elements {
                        extract_symbolic_item(
                            &element,
                            decoder,
                            express_id,
                            ifc_type,
                            rep_identifier,
                            unit_scale,
                            transform,
                            rtc_x,
                            rtc_z,
                            styled_items,
                            out,
                        );
                    }
                }
            }
        }
        IfcType::IfcMappedItem => {
            let Some(source_id) = item.get_ref(0) else { return };
            let Ok(rep_map) = decoder.decode_by_id(source_id) else { return };

            // MappingOrigin (rep_map attr 0) defines the local coord origin.
            let mapping_origin_transform = match rep_map.get_ref(0) {
                Some(origin_id) => match decoder.decode_by_id(origin_id) {
                    Ok(origin) => parse_axis2_placement_2d(&origin, decoder, unit_scale),
                    Err(_) => Transform2D::identity(),
                },
                None => Transform2D::identity(),
            };
            // MappingTarget (item attr 1) — additional transform.
            let mapping_target_transform = match item.get_ref(1) {
                Some(target_ref) => match decoder.decode_by_id(target_ref) {
                    Ok(target) => parse_cartesian_transformation_operator(&target, decoder, unit_scale),
                    Err(_) => Transform2D::identity(),
                },
                None => Transform2D::identity(),
            };
            let origin_with_target =
                compose_transforms(&mapping_target_transform, &mapping_origin_transform);
            let composed_transform = compose_transforms(transform, &origin_with_target);

            if let Some(mapped_rep_id) = rep_map.get_ref(1) {
                if let Ok(mapped_rep) = decoder.decode_by_id(mapped_rep_id) {
                    if let Some(items_attr) = mapped_rep.get(3) {
                        if let Ok(items) = decoder.resolve_ref_list(items_attr) {
                            for sub_item in items {
                                extract_symbolic_item(
                                    &sub_item,
                                    decoder,
                                    express_id,
                                    ifc_type,
                                    rep_identifier,
                                    unit_scale,
                                    &composed_transform,
                                    rtc_x,
                                    rtc_z,
                                    styled_items,
                                    out,
                                );
                            }
                        }
                    }
                }
            }
        }
        IfcType::IfcPolyline => {
            if let Some(points_attr) = item.get(0) {
                if let Ok(point_entities) = decoder.resolve_ref_list(points_attr) {
                    let mut points: Vec<f32> = Vec::with_capacity(point_entities.len() * 2);
                    let mut first_z: Option<f32> = None;
                    for pe in point_entities.iter() {
                        if pe.ifc_type != IfcType::IfcCartesianPoint {
                            continue;
                        }
                        let coords = match pe.get(0).and_then(|a| a.as_list()) {
                            Some(c) => c,
                            None => continue,
                        };
                        let local_x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                        let local_y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                        let local_z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                        if first_z.is_none() {
                            first_z = Some(local_z);
                        }
                        let (wx, wy) = transform.transform_point(local_x, local_y);
                        let x = wx - rtc_x;
                        let y = -wy + rtc_z; // Y-flip to match section-cut coord system
                        if x.is_finite() && y.is_finite() {
                            points.push(x);
                            points.push(y);
                        }
                    }
                    if points.len() >= 4 {
                        let n = points.len();
                        let is_closed = n >= 4
                            && (points[0] - points[n - 2]).abs() < 0.001
                            && (points[1] - points[n - 1]).abs() < 0.001;
                        let world_y = first_z.unwrap_or(0.0) + transform.tz;
                        out.polylines.push(SymbolicPolyline {
                            express_id,
                            ifc_type: ifc_type.to_string(),
                            points,
                            closed: is_closed,
                            world_y,
                            representation: rep_identifier.to_string(),
                        });
                    }
                }
            }
        }
        IfcType::IfcIndexedPolyCurve => {
            let Some(points_ref) = item.get_ref(0) else { return };
            let Ok(points_list) = decoder.decode_by_id(points_ref) else { return };
            let Some(coord_list_attr) = points_list.get(0) else { return };
            let Some(coord_list) = coord_list_attr.as_list() else { return };
            let mut points: Vec<f32> = Vec::with_capacity(coord_list.len() * 2);
            let mut first_z: Option<f32> = None;
            for coord in coord_list {
                let Some(coords) = coord.as_list() else { continue };
                let local_x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let local_y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                let local_z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
                if first_z.is_none() {
                    first_z = Some(local_z);
                }
                let (wx, wy) = transform.transform_point(local_x, local_y);
                let x = wx - rtc_x;
                let y = -wy + rtc_z;
                if x.is_finite() && y.is_finite() {
                    points.push(x);
                    points.push(y);
                }
            }
            if points.len() >= 4 {
                let n = points.len();
                let is_closed = n >= 4
                    && (points[0] - points[n - 2]).abs() < 0.001
                    && (points[1] - points[n - 1]).abs() < 0.001;
                let world_y = first_z.unwrap_or(0.0) + transform.tz;
                out.polylines.push(SymbolicPolyline {
                    express_id,
                    ifc_type: ifc_type.to_string(),
                    points,
                    closed: is_closed,
                    world_y,
                    representation: rep_identifier.to_string(),
                });
            }
        }
        IfcType::IfcCircle => {
            let radius = item.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            if radius <= 0.0 || !radius.is_finite() {
                return;
            }
            let (center_x, center_y, center_z) = circle_center(item, decoder, unit_scale);
            if !center_x.is_finite() || !center_y.is_finite() {
                return;
            }
            let (wx, wy) = transform.transform_point(center_x, center_y);
            out.circles.push(SymbolicCircle::full(
                express_id,
                ifc_type.to_string(),
                wx - rtc_x,
                -wy + rtc_z,
                radius,
                center_z + transform.tz,
                rep_identifier.to_string(),
            ));
        }
        IfcType::IfcEllipse => {
            let semi_a = item.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            let semi_b = item.get(2).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
            if semi_a <= 0.0 || semi_b <= 0.0 || !semi_a.is_finite() || !semi_b.is_finite() {
                return;
            }
            let (cx_local, cy_local, cz_local) = circle_center(item, decoder, unit_scale);
            const SEGMENTS: usize = 64;
            let mut points: Vec<f32> = Vec::with_capacity((SEGMENTS + 1) * 2);
            for i in 0..=SEGMENTS {
                let t = (i as f32) * std::f32::consts::TAU / (SEGMENTS as f32);
                let lx = cx_local + semi_a * t.cos();
                let ly = cy_local + semi_b * t.sin();
                let (wx, wy) = transform.transform_point(lx, ly);
                let x = wx - rtc_x;
                let y = -wy + rtc_z;
                if x.is_finite() && y.is_finite() {
                    points.push(x);
                    points.push(y);
                }
            }
            if points.len() >= 4 {
                out.polylines.push(SymbolicPolyline {
                    express_id,
                    ifc_type: ifc_type.to_string(),
                    points,
                    closed: true,
                    world_y: cz_local + transform.tz,
                    representation: rep_identifier.to_string(),
                });
            }
        }
        IfcType::IfcTrimmedCurve => {
            extract_trimmed_curve(
                item,
                decoder,
                express_id,
                ifc_type,
                rep_identifier,
                unit_scale,
                transform,
                rtc_x,
                rtc_z,
                out,
            );
        }
        IfcType::IfcCompositeCurve => {
            if let Some(segments_attr) = item.get(0) {
                if let Ok(segments) = decoder.resolve_ref_list(segments_attr) {
                    for segment in segments {
                        if let Some(curve_ref) = segment.get_ref(2) {
                            if let Ok(parent_curve) = decoder.decode_by_id(curve_ref) {
                                extract_symbolic_item(
                                    &parent_curve,
                                    decoder,
                                    express_id,
                                    ifc_type,
                                    rep_identifier,
                                    unit_scale,
                                    transform,
                                    rtc_x,
                                    rtc_z,
                                    styled_items,
                                    out,
                                );
                            }
                        }
                    }
                }
            }
        }
        IfcType::IfcLine => {
            // Infinite — no sensible 2D segment to emit.
        }
        IfcType::IfcTextLiteral | IfcType::IfcTextLiteralWithExtent => {
            extract_text_literal(
                item,
                decoder,
                express_id,
                ifc_type,
                rep_identifier,
                unit_scale,
                transform,
                rtc_x,
                rtc_z,
                styled_items,
                out,
            );
        }
        IfcType::IfcAnnotationFillArea => {
            extract_annotation_fill_area(
                item,
                decoder,
                express_id,
                ifc_type,
                rep_identifier,
                unit_scale,
                transform,
                rtc_x,
                rtc_z,
                styled_items,
                out,
            );
        }
        _ => {
            // Unknown / unsupported curve type — skip silently.
        }
    }
}

/// Tessellate an `IfcTrimmedCurve` whose `BasisCurve` is an `IfcCircle`.
/// Honours `PLANEANGLEUNIT` scaling, `SenseAgreement`, and wrap-around so
/// the 2D arc matches the 3D arc on the same curve. Near-collinear arcs
/// (large radius, small sagitta) collapse to a straight segment.
#[allow(clippy::too_many_arguments)]
fn extract_trimmed_curve(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    out: &mut SymbolicData,
) {
    let Some(basis_ref) = item.get_ref(0) else { return };
    let Ok(basis_curve) = decoder.decode_by_id(basis_ref) else { return };
    if basis_curve.ifc_type != IfcType::IfcCircle {
        return;
    }
    let radius = basis_curve.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32 * unit_scale;
    if radius <= 0.0 || !radius.is_finite() {
        return;
    }
    let (center_x, center_y, center_z) = circle_center(&basis_curve, decoder, unit_scale);
    if !center_x.is_finite() || !center_y.is_finite() {
        return;
    }
    let world_y = center_z + transform.tz;

    let angle_scale = decoder.plane_angle_to_radians() as f32;
    let raw_trim1: Option<f32> = item
        .get(1)
        .and_then(|a| a.as_list().and_then(|l| l.first().and_then(|v| v.as_float())))
        .map(|v| v as f32);
    let raw_trim2: Option<f32> = item
        .get(2)
        .and_then(|a| a.as_list().and_then(|l| l.first().and_then(|v| v.as_float())))
        .map(|v| v as f32);
    let sense = item
        .get(3)
        .and_then(|v| match v {
            AttributeValue::Enum(s) => Some(s == "T" || s == "TRUE" || s == ".T."),
            _ => None,
        })
        .unwrap_or(true);

    let start_angle = raw_trim1.map(|v| v * angle_scale).unwrap_or(0.0);
    let mut end_angle = raw_trim2.map(|v| v * angle_scale).unwrap_or(std::f32::consts::TAU);
    if sense && end_angle < start_angle {
        end_angle += std::f32::consts::TAU;
    } else if !sense && end_angle > start_angle {
        end_angle -= std::f32::consts::TAU;
    }
    if !start_angle.is_finite() || !end_angle.is_finite() {
        return;
    }

    let start_x = center_x + radius * start_angle.cos();
    let start_y = center_y + radius * start_angle.sin();
    let end_x = center_x + radius * end_angle.cos();
    let end_y = center_y + radius * end_angle.sin();
    let chord_dx = end_x - start_x;
    let chord_dy = end_y - start_y;
    let chord_len = (chord_dx * chord_dx + chord_dy * chord_dy).sqrt();
    let is_near_collinear = if chord_len > 0.0001 {
        let mid_angle = (start_angle + end_angle) / 2.0;
        let mid_x = center_x + radius * mid_angle.cos();
        let mid_y = center_y + radius * mid_angle.sin();
        let sagitta = ((end_y - start_y) * mid_x - (end_x - start_x) * mid_y
            + end_x * start_y
            - end_y * start_x)
            .abs()
            / chord_len;
        radius > 100.0 || sagitta < chord_len * 0.02 || radius > chord_len * 10.0
    } else {
        true
    };

    if is_near_collinear {
        let (wsx, wsy) = transform.transform_point(start_x, start_y);
        let (wex, wey) = transform.transform_point(end_x, end_y);
        let points = vec![wsx - rtc_x, -wsy + rtc_z, wex - rtc_x, -wey + rtc_z];
        out.polylines.push(SymbolicPolyline {
            express_id,
            ifc_type: ifc_type.to_string(),
            points,
            closed: false,
            world_y,
            representation: rep_identifier.to_string(),
        });
    } else {
        let arc_length = (end_angle - start_angle).abs();
        let num_segments = ((arc_length * radius / 0.1) as usize).max(8).min(64);
        let mut points = Vec::with_capacity((num_segments + 1) * 2);
        for i in 0..=num_segments {
            let t = i as f32 / num_segments as f32;
            let angle = start_angle + t * (end_angle - start_angle);
            let local_x = center_x + radius * angle.cos();
            let local_y = center_y + radius * angle.sin();
            let (wx, wy) = transform.transform_point(local_x, local_y);
            let x = wx - rtc_x;
            let y = -wy + rtc_z;
            if x.is_finite() && y.is_finite() {
                points.push(x);
                points.push(y);
            }
        }
        if points.len() >= 4 {
            out.polylines.push(SymbolicPolyline {
                express_id,
                ifc_type: ifc_type.to_string(),
                points,
                closed: false,
                world_y,
                representation: rep_identifier.to_string(),
            });
        }
    }
}
