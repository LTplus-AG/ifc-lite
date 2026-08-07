// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcTrimmedCurve` tessellation, split out of `items.rs` to keep that
//! module's dispatch table under the module-size ratchet (#2256 follow-up).

use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};

use super::primitives::{SymbolicData, SymbolicPolyline};
use super::transform::{circle_center, Transform2D};

/// Tessellate an `IfcTrimmedCurve` whose `BasisCurve` is an `IfcCircle`.
/// Honours `PLANEANGLEUNIT` scaling, `SenseAgreement`, and wrap-around so
/// the 2D arc matches the 3D arc on the same curve. Near-collinear arcs
/// (large radius, small sagitta) collapse to a straight segment.
#[allow(clippy::too_many_arguments)]
pub(super) fn extract_trimmed_curve(
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
