// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Conic edge samplers: axis placement reading plus circle and ellipse arc
//! discretization for advanced-face edge loops.

use crate::{scale_segments, Point3, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use super::curves::{resolve_present, Refused};

/// Read a conic's `IfcAxis2Placement3D` or `IfcAxis2Placement2D` and return
/// (location, axis_z, axis_x) through the canonical readers in
/// [`crate::transform`], the frame the profile conic samplers use too.
///
/// This used to be its own reader, which took a 2D placement's RefDirection
/// (attribute 1) for the 3D Axis, standing a planar profile circle on its
/// side (#7687, sibling of PROC-13), and defaulted a missing RefDirection
/// differently from IFC's `FirstProjAxis`. A placement that does not parse
/// keeps the old tolerant fallback, the identity frame at the origin.
pub(super) fn read_axis2_placement_frame(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> (Point3<f64>, nalgebra::Vector3<f64>, nalgebra::Vector3<f64>) {
    use nalgebra::Vector3;

    let frame = if placement.ifc_type == IfcType::IfcAxis2Placement2D {
        crate::transform::parse_axis2_placement_2d(placement, decoder)
    } else {
        crate::transform::parse_axis2_placement_3d(placement, decoder)
    };
    match frame {
        Ok(m) => (
            Point3::new(m[(0, 3)], m[(1, 3)], m[(2, 3)]),
            Vector3::new(m[(0, 2)], m[(1, 2)], m[(2, 2)]),
            Vector3::new(m[(0, 0)], m[(1, 0)], m[(2, 0)]),
        ),
        Err(_) => (Point3::origin(), Vector3::z(), Vector3::x()),
    }
}

/// Sample an `IfcCircle` edge from `start` to `end`, walking the arc in the
/// curve's native (CCW around axis_z) direction when `curve_forward` is true,
/// otherwise CW. Returns `start` plus intermediate samples; the end vertex is
/// omitted because the next edge in the loop starts there.
pub(super) fn sample_circle_edge_curve(
    curve: &DecodedEntity,
    start: &Point3<f64>,
    end: &Point3<f64>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Vec<Point3<f64>>, Refused> {
    use std::f64::consts::TAU;

    // IfcCircle: 0=Position(IfcAxis2Placement3D|2D), 1=Radius
    let radius = match curve.get(1).and_then(|v| v.as_float()) {
        Some(r) if r > 0.0 => r,
        _ => return Ok(vec![*start]),
    };

    let Some(placement) = resolve_present(curve.get(0), decoder)? else {
        return Ok(vec![*start]);
    };

    let (center, axis_z, axis_x) = read_axis2_placement_frame(&placement, decoder);
    let axis_y = axis_z.cross(&axis_x);

    // Project start/end onto the circle plane to recover their angles.
    let project_angle = |p: &Point3<f64>| -> f64 {
        let v = p - center;
        v.dot(&axis_y).atan2(v.dot(&axis_x))
    };

    let a_start = project_angle(start);
    let a_end = project_angle(end);

    // Signed CCW arc length from a_start to a_end, in (0, 2π].
    let mut ccw_delta = (a_end - a_start).rem_euclid(TAU);
    let mut cw_delta = (a_start - a_end).rem_euclid(TAU);

    // Treat coincident endpoints as a full 360° arc (full circle in topology).
    let coincident = (start - end).norm() < 1e-6 * radius.max(1.0);
    if coincident || ccw_delta < 1e-9 {
        ccw_delta = TAU;
        cw_delta = TAU;
    }

    let (delta, sign) = if curve_forward {
        (ccw_delta, 1.0_f64)
    } else {
        (cw_delta, -1.0_f64)
    };

    // ~12° per segment at Medium, clamped to keep simple half-turns affordable;
    // scaled by quality.
    let n_base = (delta / (TAU / 30.0)).ceil() as usize;
    let n_segments = scale_segments(n_base, 2, 32, quality);

    let mut points = Vec::with_capacity(n_segments);
    points.push(*start);
    for i in 1..n_segments {
        let t = delta * (i as f64) / (n_segments as f64);
        let angle = a_start + sign * t;
        let p = center + axis_x * (radius * angle.cos()) + axis_y * (radius * angle.sin());
        points.push(p);
    }
    Ok(points)
}

/// Sample an `IfcEllipse` edge from `start` to `end`, walking the arc in the
/// curve's native (CCW around axis_z) direction when `curve_forward` is true,
/// otherwise CW. Mirrors `sample_circle_edge_curve`; the parametric angle is
/// recovered with the semi-axis scaling folded out so trigonometric parameter
/// t (not geometric angle) drives the walk, matching the IFC parameterization
/// P(t) = C + r1·cos(t)·x + r2·sin(t)·y.
pub(super) fn sample_ellipse_edge_curve(
    curve: &DecodedEntity,
    start: &Point3<f64>,
    end: &Point3<f64>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Vec<Point3<f64>>, Refused> {
    use std::f64::consts::TAU;

    // IfcEllipse: 0=Position(IfcAxis2Placement3D|2D), 1=SemiAxis1, 2=SemiAxis2
    let r1 = match curve.get(1).and_then(|v| v.as_float()) {
        Some(r) if r > 0.0 => r,
        _ => return Ok(vec![*start]),
    };
    let r2 = match curve.get(2).and_then(|v| v.as_float()) {
        Some(r) if r > 0.0 => r,
        _ => return Ok(vec![*start]),
    };

    let Some(placement) = resolve_present(curve.get(0), decoder)? else {
        return Ok(vec![*start]);
    };

    let (center, axis_z, axis_x) = read_axis2_placement_frame(&placement, decoder);
    let axis_y = axis_z.cross(&axis_x);

    // Recover the parametric angle of a point: divide the planar components by
    // their semi-axes first, otherwise a stretched ellipse skews the angle.
    let project_angle = |p: &Point3<f64>| -> f64 {
        let v = p - center;
        (v.dot(&axis_y) / r2).atan2(v.dot(&axis_x) / r1)
    };

    let a_start = project_angle(start);
    let a_end = project_angle(end);

    let mut ccw_delta = (a_end - a_start).rem_euclid(TAU);
    let mut cw_delta = (a_start - a_end).rem_euclid(TAU);

    let coincident = (start - end).norm() < 1e-6 * r1.max(r2).max(1.0);
    if coincident || ccw_delta < 1e-9 {
        ccw_delta = TAU;
        cw_delta = TAU;
    }

    let (delta, sign) = if curve_forward {
        (ccw_delta, 1.0_f64)
    } else {
        (cw_delta, -1.0_f64)
    };

    let n_base = (delta / (TAU / 30.0)).ceil() as usize;
    let n_segments = scale_segments(n_base, 2, 32, quality);

    let mut points = Vec::with_capacity(n_segments);
    points.push(*start);
    for i in 1..n_segments {
        let t = delta * (i as f64) / (n_segments as f64);
        let angle = a_start + sign * t;
        let p = center + axis_x * (r1 * angle.cos()) + axis_y * (r2 * angle.sin());
        points.push(p);
    }
    Ok(points)
}
