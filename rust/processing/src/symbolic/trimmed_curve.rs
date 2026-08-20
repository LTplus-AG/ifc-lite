// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcTrimmedCurve` tessellation, split out of `items.rs` to keep that
//! module's dispatch table under the module-size ratchet (#2256 follow-up).

use super::output_cap::SymbolicAccumulator;
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};

use super::primitives::{SymbolicPolyline};
use super::transform::{parse_axis2_placement_2d, Transform2D};

/// Tessellate an `IfcTrimmedCurve` whose `BasisCurve` is an `IfcCircle`.
/// Honours `PLANEANGLEUNIT` scaling, `SenseAgreement`, and wrap-around so
/// the 2D arc matches the 3D arc on the same curve. Angles are measured in
/// the circle's own placement basis, and both `IfcTrimmingSelect` forms
/// (parameter and Cartesian point) are accepted — see [`resolve_trim`].
///
/// Near-collinear arcs collapse to a straight segment. The test is purely
/// RELATIVE (sagitta vs chord, radius vs chord): a big circle is not by
/// itself a straight line, and the absolute `radius > 100.0` that used to
/// sit here flattened genuinely curved long-radius arcs.
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
    out: &mut SymbolicAccumulator,
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
    // The trim angles are measured in the circle's OWN placement basis, not
    // in world X/Y: `IfcCircle.Position.RefDirection` defines local +X and the
    // angles run from there. `parse_axis2_placement_2d` yields exactly that
    // basis — translation = the centre, linear block = the RefDirection
    // rotation, which degrades to identity when RefDirection is absent, so a
    // plain world-aligned circle is bit-identical to the old world-XY maths.
    let basis = match basis_curve.get_ref(0) {
        Some(pos_ref) => match decoder.decode_by_id(pos_ref) {
            Ok(position) => parse_axis2_placement_2d(&position, decoder, unit_scale),
            Err(_) => Transform2D::identity(),
        },
        None => Transform2D::identity(),
    };
    if !basis.tx.is_finite() || !basis.ty.is_finite() {
        return;
    }
    let world_y = basis.tz + transform.tz;

    let angle_scale = decoder.plane_angle_to_radians() as f32;
    // MasterRepresentation (attr 4) picks the form when the SET carries both.
    let prefer_cartesian = item
        .get(4)
        .and_then(|v| v.as_enum())
        .is_some_and(|s| s.trim_matches('.').eq_ignore_ascii_case("CARTESIAN"));
    let raw_trim1 = resolve_trim(
        item.get(1),
        decoder,
        &basis,
        unit_scale,
        angle_scale,
        prefer_cartesian,
    );
    let raw_trim2 = resolve_trim(
        item.get(2),
        decoder,
        &basis,
        unit_scale,
        angle_scale,
        prefer_cartesian,
    );
    let sense = item
        .get(3)
        .and_then(|v| match v {
            AttributeValue::Enum(s) => Some(s == "T" || s == "TRUE" || s == ".T."),
            _ => None,
        })
        .unwrap_or(true);

    let start_angle = raw_trim1.unwrap_or(0.0);
    let mut end_angle = raw_trim2.unwrap_or(std::f32::consts::TAU);
    if sense && end_angle < start_angle {
        end_angle += std::f32::consts::TAU;
    } else if !sense && end_angle > start_angle {
        end_angle -= std::f32::consts::TAU;
    }
    if !start_angle.is_finite() || !end_angle.is_finite() {
        return;
    }

    let point_at = |angle: f32| basis.transform_point(radius * angle.cos(), radius * angle.sin());
    let (start_x, start_y) = point_at(start_angle);
    let (end_x, end_y) = point_at(end_angle);
    let chord_dx = end_x - start_x;
    let chord_dy = end_y - start_y;
    let chord_len = (chord_dx * chord_dx + chord_dy * chord_dy).sqrt();
    // A circle is injective mod TAU, so the chord can only shrink toward 0
    // for two reasons: the trim barely moves at all (angle_span ~ 0), or
    // the trim sweeps one or more FULL turns (angle_span ~ k*TAU, k >= 1)
    // and the start/end points coincide by construction. Only the first
    // case is degenerate; the second is a full circle (or a near-full
    // circle, whose small-but-nonzero chord previously slipped through
    // the `radius > chord_len * 10.0` shortcut below) and must still be
    // tessellated as an arc/loop, not collapsed to a 2-point chord.
    let angle_span = (end_angle - start_angle).abs();
    let turns = (angle_span / std::f32::consts::TAU).round();
    let is_full_turn =
        turns >= 1.0 && (angle_span - turns * std::f32::consts::TAU).abs() < 0.02;
    let is_near_collinear = if is_full_turn {
        false
    } else if chord_len > 0.0001 {
        let mid_angle = (start_angle + end_angle) / 2.0;
        let (mid_x, mid_y) = point_at(mid_angle);
        let sagitta = ((end_y - start_y) * mid_x - (end_x - start_x) * mid_y
            + end_x * start_y
            - end_y * start_x)
            .abs()
            / chord_len;
        sagitta < chord_len * 0.02 || radius > chord_len * 10.0
    } else {
        true
    };

    if is_near_collinear {
        let (wsx, wsy) = transform.transform_point(start_x, start_y);
        let (wex, wey) = transform.transform_point(end_x, end_y);
        let points = vec![wsx - rtc_x, -wsy + rtc_z, wex - rtc_x, -wey + rtc_z];
        out.push_polyline(SymbolicPolyline {
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
            let (local_x, local_y) = point_at(angle);
            let (wx, wy) = transform.transform_point(local_x, local_y);
            let x = wx - rtc_x;
            let y = -wy + rtc_z;
            if x.is_finite() && y.is_finite() {
                points.push(x);
                points.push(y);
            }
        }
        if points.len() >= 4 {
            out.push_polyline(SymbolicPolyline {
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

/// Resolve one `IfcTrimmingSelect` SET to an angle in RADIANS on the circle.
///
/// `IfcTrimmingSelect` is `IfcParameterValue | IfcCartesianPoint`, and the
/// SET may carry one of each (`SET [1:2]`). The parser hands a typed value
/// `IFCPARAMETERVALUE(1.57)` back as `List([String(type), Float(v)])` and a
/// point as an `EntityRef`, so both members have to be inspected by shape —
/// looking only at `.first()` silently dropped point-first sets and
/// point-only sets alike, leaving the caller with its full-circle default.
///
/// For a circle the parameter IS the angle, in `PLANEANGLEUNIT`. A Cartesian
/// trim is converted by expressing the point in the circle's local basis and
/// taking `atan2` there, which is why `basis` is needed: the same rotation
/// that places the arc also defines where angle zero points.
fn resolve_trim(
    attr: Option<&AttributeValue>,
    decoder: &mut EntityDecoder,
    basis: &Transform2D,
    unit_scale: f32,
    angle_scale: f32,
    prefer_cartesian: bool,
) -> Option<f32> {
    let members = attr?.as_list()?;
    let mut from_parameter = None;
    let mut from_cartesian = None;
    for member in members {
        match member {
            AttributeValue::EntityRef(id) => {
                if from_cartesian.is_none() {
                    from_cartesian = cartesian_trim_angle(*id, decoder, basis, unit_scale);
                }
            }
            other => {
                // A typed `IFCPARAMETERVALUE(..)` decodes to List([name, value]);
                // a bare number is accepted too, since exporters emit both.
                if from_parameter.is_none() {
                    from_parameter = other.as_float().map(|v| v as f32 * angle_scale);
                }
            }
        }
    }
    if prefer_cartesian {
        from_cartesian.or(from_parameter)
    } else {
        from_parameter.or(from_cartesian)
    }
}

/// Angle of an `IfcCartesianPoint` trim, measured in the circle's local basis.
fn cartesian_trim_angle(
    point_id: u32,
    decoder: &mut EntityDecoder,
    basis: &Transform2D,
    unit_scale: f32,
) -> Option<f32> {
    let point = decoder.decode_by_id(point_id).ok()?;
    if point.ifc_type != IfcType::IfcCartesianPoint {
        return None;
    }
    let coords = point.get(0).and_then(|a| a.as_list())?;
    let px = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
    let py = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0) as f32 * unit_scale;
    let dx = px - basis.tx;
    let dy = py - basis.ty;
    // The linear block is a pure rotation (`parse_axis2_placement_2d`), so its
    // inverse is its transpose — no determinant needed.
    let local_x = basis.m00 * dx + basis.m10 * dy;
    let local_y = basis.m01 * dx + basis.m11 * dy;
    if !local_x.is_finite() || !local_y.is_finite() || (local_x == 0.0 && local_y == 0.0) {
        return None;
    }
    Some(local_y.atan2(local_x))
}
