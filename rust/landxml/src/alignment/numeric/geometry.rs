// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{diagnostic, Result, EPSILON};
use crate::{
    alignment::{
        LandXmlAlignmentPrimitive, LandXmlAlignmentSegment, LandXmlCurve, LandXmlIrregularLine,
        LandXmlLine, LandXmlPlanPoint, LandXmlPointLocation, LandXmlRadius, LandXmlRotation,
        LandXmlSpiral,
    },
    LandXmlSourceId,
};

pub(super) fn segment_length(segment: &LandXmlAlignmentSegment) -> Result<f64> {
    let length = match &segment.primitive {
        LandXmlAlignmentPrimitive::Line(value) => line_length(&segment.source_id, value)?,
        LandXmlAlignmentPrimitive::IrregularLine(value) => {
            irregular_length(&segment.source_id, value)?
        }
        LandXmlAlignmentPrimitive::Curve(value) => curve_geometry(&segment.source_id, value)?.2,
        LandXmlAlignmentPrimitive::Spiral(value) => value.declared_length,
    };
    valid_length(&segment.source_id, length)
}
pub(super) fn evaluate_segment(
    segment: &LandXmlAlignmentSegment,
    distance: f64,
) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    match &segment.primitive {
        LandXmlAlignmentPrimitive::Line(value) => {
            evaluate_line(&segment.source_id, value, distance)
        }
        LandXmlAlignmentPrimitive::IrregularLine(value) => {
            evaluate_irregular(&segment.source_id, value, distance)
        }
        LandXmlAlignmentPrimitive::Curve(value) => {
            evaluate_curve(&segment.source_id, value, distance)
        }
        LandXmlAlignmentPrimitive::Spiral(value) => {
            evaluate_clothoid(&segment.source_id, value, distance)
        }
    }
}
fn evaluate_line(
    id: &LandXmlSourceId,
    value: &LandXmlLine,
    distance: f64,
) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    interpolate(
        coordinates(id, &value.start)?,
        coordinates(id, &value.end)?,
        distance,
        id,
    )
}
fn evaluate_irregular(
    id: &LandXmlSourceId,
    value: &LandXmlIrregularLine,
    distance: f64,
) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    let mut points = vec![coordinates(id, &value.start)?];
    points.extend(value.points.iter().copied());
    points.push(coordinates(id, &value.end)?);
    let mut remaining = distance;
    for pair in points.windows(2) {
        let length = distance_between(pair[0], pair[1]);
        if remaining <= length + EPSILON {
            return interpolate(pair[0], pair[1], remaining, id);
        }
        remaining -= length;
    }
    Err(diagnostic(
        id,
        "LXMLA208",
        "irregular line has no non-zero geometry",
    ))
}
fn evaluate_curve(
    id: &LandXmlSourceId,
    value: &LandXmlCurve,
    distance: f64,
) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    let (start_angle, signed_sweep, length, center, radius) = curve_geometry(id, value)?;
    let angle = start_angle + signed_sweep * (distance / length).clamp(0.0, 1.0);
    let point = LandXmlPlanPoint {
        northing: center.northing + radius * angle.cos(),
        easting: center.easting + radius * angle.sin(),
        elevation: None,
    };
    let sign = signed_sweep.signum();
    Ok((
        point,
        normalize((-sign * angle.sin(), sign * angle.cos()), id)?,
    ))
}
fn evaluate_clothoid(
    id: &LandXmlSourceId,
    value: &LandXmlSpiral,
    distance: f64,
) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    if value.spi_type != "clothoid" {
        return Err(diagnostic(
            id,
            "LXMLA209",
            "transition is retained but not numerically supported",
        ));
    }
    let start = coordinates(id, &value.start)?;
    let end = coordinates(id, &value.end)?;
    let length = valid_length(id, value.declared_length)?;
    let (k0, k1) = (
        curvature(id, value.radius_start)?,
        curvature(id, value.radius_end)?,
    );
    let signed = value.rotation.sign();
    let local_end = clothoid_integral(length, length, signed * k0, signed * k1)?;
    let heading = (end.easting - start.easting).atan2(end.northing - start.northing)
        - local_end.1.atan2(local_end.0);
    let d = distance.clamp(0.0, length);
    let local = clothoid_integral(d, length, signed * k0, signed * k1)?;
    let (sin, cos) = heading.sin_cos();
    let point = LandXmlPlanPoint {
        northing: start.northing + local.0 * cos - local.1 * sin,
        easting: start.easting + local.0 * sin + local.1 * cos,
        elevation: None,
    };
    let theta = heading + signed * (k0 * d + 0.5 * (k1 - k0) * d * d / length);
    Ok((
        if (length - d).abs() <= EPSILON {
            end
        } else {
            point
        },
        (theta.cos(), theta.sin()),
    ))
}
fn curve_geometry(
    id: &LandXmlSourceId,
    value: &LandXmlCurve,
) -> Result<(f64, f64, f64, LandXmlPlanPoint, f64)> {
    let start = coordinates(id, &value.start)?;
    let end = coordinates(id, &value.end)?;
    let center = coordinates(id, &value.center)?;
    let radius = value.radius.unwrap_or(distance_between(start, center));
    if !radius.is_finite()
        || radius <= EPSILON
        || (distance_between(end, center) - radius).abs() > radius * 1e-7
    {
        return Err(diagnostic(
            id,
            "LXMLA210",
            "curve radius and endpoints are inconsistent",
        ));
    }
    let start_angle = (start.easting - center.easting).atan2(start.northing - center.northing);
    let end_angle = (end.easting - center.easting).atan2(end.northing - center.northing);
    let sweep = sweep(start_angle, end_angle, value.rotation);
    let length = valid_length(id, value.declared_length.unwrap_or(radius * sweep.abs()))?;
    Ok((start_angle, sweep, length, center, radius))
}
fn line_length(id: &LandXmlSourceId, value: &LandXmlLine) -> Result<f64> {
    valid_length(
        id,
        value.declared_length.unwrap_or(distance_between(
            coordinates(id, &value.start)?,
            coordinates(id, &value.end)?,
        )),
    )
}
fn irregular_length(id: &LandXmlSourceId, value: &LandXmlIrregularLine) -> Result<f64> {
    let mut points = vec![coordinates(id, &value.start)?];
    points.extend(value.points.iter().copied());
    points.push(coordinates(id, &value.end)?);
    valid_length(
        id,
        value.declared_length.unwrap_or_else(|| {
            points
                .windows(2)
                .map(|pair| distance_between(pair[0], pair[1]))
                .sum()
        }),
    )
}
fn coordinates(id: &LandXmlSourceId, value: &LandXmlPointLocation) -> Result<LandXmlPlanPoint> {
    match value {
        LandXmlPointLocation::Coordinates { point } => Ok(*point),
        LandXmlPointLocation::PointReference { .. } => Err(diagnostic(
            id,
            "LXMLA211",
            "pntRef requires the later COGO resolver",
        )),
    }
}
fn curvature(id: &LandXmlSourceId, value: LandXmlRadius) -> Result<f64> {
    match value {
        LandXmlRadius::Infinite => Ok(0.0),
        LandXmlRadius::Finite(radius) if radius.is_finite() && radius > EPSILON => Ok(1.0 / radius),
        LandXmlRadius::Finite(_) => Err(diagnostic(
            id,
            "LXMLA212",
            "spiral radius must be positive or INF",
        )),
    }
}
fn clothoid_integral(distance: f64, length: f64, k0: f64, k1: f64) -> Result<(f64, f64)> {
    const NODES: [f64; 8] = [
        0.095_012_509_837_637_4,
        0.281_603_550_779_259,
        0.458_016_777_657_227,
        0.617_876_244_402_644,
        0.755_404_408_355_003,
        0.865_631_202_387_832,
        0.944_575_023_073_233,
        0.989_400_934_991_65,
    ];
    const WEIGHTS: [f64; 8] = [
        0.189_450_610_455_069,
        0.182_603_415_044_924,
        0.169_156_519_395_003,
        0.149_595_988_816_577,
        0.124_628_971_255_534,
        0.095_158_511_682_493_2,
        0.062_253_523_938_647_9,
        0.027_152_459_411_754_1,
    ];
    if !distance.is_finite() || !length.is_finite() || length <= EPSILON {
        return Err(diagnostic(
            &LandXmlSourceId("landxml:spiral".to_owned()),
            "LXMLA213",
            "invalid clothoid length",
        ));
    }
    let half = distance * 0.5;
    let mut x = 0.0;
    let mut y = 0.0;
    for (node, weight) in NODES.into_iter().zip(WEIGHTS) {
        for sign in [-1.0, 1.0] {
            let s = half * (1.0 + sign * node);
            let theta = k0 * s + 0.5 * (k1 - k0) * s * s / length;
            x += weight * theta.cos();
            y += weight * theta.sin();
        }
    }
    Ok((x * half, y * half))
}
fn interpolate(
    start: LandXmlPlanPoint,
    end: LandXmlPlanPoint,
    distance: f64,
    id: &LandXmlSourceId,
) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    let length = distance_between(start, end);
    let tangent = normalize(
        (
            (end.northing - start.northing) / length,
            (end.easting - start.easting) / length,
        ),
        id,
    )?;
    let factor = (distance / length).clamp(0.0, 1.0);
    Ok((
        LandXmlPlanPoint {
            northing: start.northing + (end.northing - start.northing) * factor,
            easting: start.easting + (end.easting - start.easting) * factor,
            elevation: None,
        },
        tangent,
    ))
}
fn normalize(value: (f64, f64), id: &LandXmlSourceId) -> Result<(f64, f64)> {
    let length = (value.0 * value.0 + value.1 * value.1).sqrt();
    if !length.is_finite() || length <= EPSILON {
        return Err(diagnostic(
            id,
            "LXMLA214",
            "primitive has zero-length tangent",
        ));
    }
    Ok((value.0 / length, value.1 / length))
}
fn distance_between(left: LandXmlPlanPoint, right: LandXmlPlanPoint) -> f64 {
    (right.northing - left.northing).hypot(right.easting - left.easting)
}
fn sweep(start: f64, end: f64, rotation: LandXmlRotation) -> f64 {
    let raw = (end - start).rem_euclid(std::f64::consts::TAU);
    match rotation {
        LandXmlRotation::CounterClockwise => raw,
        LandXmlRotation::Clockwise => {
            -(std::f64::consts::TAU - raw).rem_euclid(std::f64::consts::TAU)
        }
    }
}
fn valid_length(id: &LandXmlSourceId, value: f64) -> Result<f64> {
    if !value.is_finite() || value <= EPSILON {
        return Err(diagnostic(
            id,
            "LXMLA215",
            "primitive length must be positive and finite",
        ));
    }
    Ok(value)
}
