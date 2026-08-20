// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::collections::HashMap;

use super::item_walk::{extract_symbolic_item_at, ItemWalk};
use super::fill::extract_annotation_fill_area;
use super::primitives::{SymbolicCircle, SymbolicData, SymbolicPolyline};
use super::text::extract_text_literal;
use super::transform::{
    circle_center, compose_transforms, parse_axis2_placement_2d,
    parse_cartesian_transformation_operator, Transform2D,
};
use super::trimmed_curve::extract_trimmed_curve;

// ────────────────────────────────────────────────────────────────────────────
// Item dispatch. One function per IFC representation-item type; recursive
// for set + mapped-item containers.
// ────────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub(super) fn extract_symbolic_item_inner(
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
    depth: u32,
    walk: &mut ItemWalk,
) {
    match item.ifc_type {
        IfcType::IfcGeometricSet | IfcType::IfcGeometricCurveSet => {
            if let Some(elements_attr) = item.get(0) {
                if let Ok(elements) = decoder.resolve_ref_list(elements_attr) {
                    for element in elements {
                        extract_symbolic_item_at(
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
                            depth + 1,
                            walk,
                        );
                    }
                }
            }
        }
        IfcType::IfcMappedItem => {
            let Some(source_id) = item.get_ref(0) else { return };
            let Ok(rep_map) = decoder.decode_by_id(source_id) else { return };

            // MappingOrigin (rep_map attr 0) is MANDATORY on IfcRepresentationMap
            // (unlike ObjectPlacement's optional PlacementRelTo): a dangling ref
            // or an absent/null attribute is malformed data, not a legitimate
            // zero, so both become `unresolved()` (#2256).
            let mapping_origin_transform = match rep_map.get_ref(0) {
                Some(origin_id) => match decoder.decode_by_id(origin_id) {
                    Ok(origin)
                        if origin.ifc_type == IfcType::IfcAxis2Placement2D
                            || origin.ifc_type == IfcType::IfcAxis2Placement3D =>
                    {
                        parse_axis2_placement_2d(&origin, decoder, unit_scale)
                    }
                    Ok(_) => Transform2D::unresolved(), // wrong type (#2355)
                    Err(_) => Transform2D::unresolved(), // dangling ref (#2256)
                },
                None => Transform2D::unresolved(), // mandatory attr absent (#2256)
            };
            // MappingTarget (item attr 1) is likewise MANDATORY on
            // IfcMappedItem — same failure/absence treatment as above.
            let mapping_target_transform = match item.get_ref(1) {
                Some(target_ref) => match decoder.decode_by_id(target_ref) {
                    Ok(target)
                        if matches!(
                            target.ifc_type,
                            IfcType::IfcCartesianTransformationOperator
                                | IfcType::IfcCartesianTransformationOperator2D
                                | IfcType::IfcCartesianTransformationOperator2DnonUniform
                                | IfcType::IfcCartesianTransformationOperator3D
                                | IfcType::IfcCartesianTransformationOperator3DnonUniform
                        ) =>
                    {
                        parse_cartesian_transformation_operator(&target, decoder, unit_scale)
                    }
                    Ok(_) => Transform2D::unresolved(), // wrong type (#2355)
                    Err(_) => Transform2D::unresolved(), // dangling ref (#2256)
                },
                None => Transform2D::unresolved(), // mandatory attr absent (#2256)
            };
            let origin_with_target =
                compose_transforms(&mapping_target_transform, &mapping_origin_transform);
            let composed_transform = compose_transforms(transform, &origin_with_target);

            // Everything that can fail is resolved BEFORE the node goes on
            // the path, so there is no early return between enter and exit --
            // a leaked id would silently skip every later occurrence of this
            // representation for the rest of the walk.
            let Some(mapped_rep_id) = rep_map.get_ref(1) else { return };
            let Ok(mapped_rep) = decoder.decode_by_id(mapped_rep_id) else { return };
            let Some(items_attr) = mapped_rep.get(3) else { return };
            let Ok(items) = decoder.resolve_ref_list(items_attr) else { return };

            // The representation itself is a node on the path: this chain
            // re-enters the walk through something that is not an item, so the
            // item ids alone cannot see the cycle it closes.
            if !walk.enter_node(mapped_rep_id) {
                return;
            }
            for sub_item in items {
                extract_symbolic_item_at(
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
                    depth + 1,
                    walk,
                );
            }
            walk.exit_node(mapped_rep_id);
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
            // × scale(): a scalar radius never passes through transform_point (#1985).
            let r = item.get(1).and_then(|a| a.as_float()).unwrap_or(0.0) as f32;
            let radius = r * unit_scale * transform.scale();
            let (center_x, center_y, center_z) = circle_center(item, decoder, unit_scale);
            if !(radius.is_finite() && radius > 0.0 && center_x.is_finite() && center_y.is_finite()) {
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
            // NOT × scale() (unlike IfcCircle): sampled points go through transform_point.
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
                                extract_symbolic_item_at(
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
                                    depth + 1,
                                    walk,
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

