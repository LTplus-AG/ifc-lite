// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{diagnostic, Result, EPSILON};
use crate::{
    alignment::{
        LandXmlAlignmentPrimitive, LandXmlAlignmentSegment, LandXmlCurve, LandXmlIrregularLine,
        LandXmlLine, LandXmlPlanPoint, LandXmlPointLocation, LandXmlRotation,
    },
    LandXmlSourceId,
};

mod clothoid;

pub(super) fn segment_length(segment: &LandXmlAlignmentSegment) -> Result<f64> {
    let length = match &segment.primitive {
        LandXmlAlignmentPrimitive::Line(value) => line_length(&segment.source_id, value)?,
        LandXmlAlignmentPrimitive::IrregularLine(value) => {
            irregular_length(&segment.source_id, value)?
        }
        LandXmlAlignmentPrimitive::Curve(value) => curve_geometry(&segment.source_id, value)?.2,
        LandXmlAlignmentPrimitive::Spiral(value) => value.declared_length,
        LandXmlAlignmentPrimitive::UnsupportedSpiral(value) => value.declared_length,
    };
    valid_length(&segment.source_id, length)
}
/// Validates every numeric field a probe could rely on, even when records
/// arrived through deserialization instead of the XML parser.
pub(super) fn validate_segment(segment: &LandXmlAlignmentSegment) -> Result<f64> {
    let length = segment_length(segment)?;
    match &segment.primitive {
        LandXmlAlignmentPrimitive::Line(_) | LandXmlAlignmentPrimitive::IrregularLine(_) => {}
        LandXmlAlignmentPrimitive::Curve(value) => {
            curve_geometry(&segment.source_id, value)?;
        }
        LandXmlAlignmentPrimitive::Spiral(value) => {
            if value.spi_type == "clothoid" {
                // This is a bounded numerical approximation, not a claim of
                // general exactness for arbitrary LandXML transitions.
                clothoid::validate_domain(&segment.source_id, value)?;
                clothoid::evaluate(&segment.source_id, value, 0.0)?;
            }
        }
        LandXmlAlignmentPrimitive::UnsupportedSpiral(_) => {}
    }
    Ok(length)
}
pub(super) fn segment_endpoints(
    segment: &LandXmlAlignmentSegment,
) -> Result<(LandXmlPlanPoint, LandXmlPlanPoint)> {
    let id = &segment.source_id;
    match &segment.primitive {
        LandXmlAlignmentPrimitive::Line(value) => {
            Ok((coordinates(id, &value.start)?, coordinates(id, &value.end)?))
        }
        LandXmlAlignmentPrimitive::IrregularLine(value) => {
            Ok((coordinates(id, &value.start)?, coordinates(id, &value.end)?))
        }
        LandXmlAlignmentPrimitive::Curve(value) => {
            Ok((coordinates(id, &value.start)?, coordinates(id, &value.end)?))
        }
        LandXmlAlignmentPrimitive::Spiral(value)
        | LandXmlAlignmentPrimitive::UnsupportedSpiral(value) => {
            Ok((coordinates(id, &value.start)?, coordinates(id, &value.end)?))
        }
    }
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
            clothoid::evaluate(&segment.source_id, value, distance)
        }
        LandXmlAlignmentPrimitive::UnsupportedSpiral(_) => Err(diagnostic(
            &segment.source_id,
            "LXMLA209",
            "transition is retained but not numerically supported",
        )),
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
    let points = irregular_vertices(id, value)?;
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
        northing: center.northing + radius * angle.sin(),
        easting: center.easting + radius * angle.cos(),
        elevation: None,
    };
    let sign = signed_sweep.signum();
    Ok((
        point,
        normalize((sign * angle.cos(), -sign * angle.sin()), id)?,
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
    let start_radius = distance_between(start, center);
    let end_radius = distance_between(end, center);
    if !radius.is_finite()
        || radius <= EPSILON
        || (start_radius - radius).abs() > radius * 1e-7
        || (end_radius - radius).abs() > radius * 1e-7
    {
        return Err(diagnostic(
            id,
            "LXMLA210",
            "curve radius and endpoints are inconsistent",
        ));
    }
    let start_angle = (start.northing - center.northing).atan2(start.easting - center.easting);
    let end_angle = (end.northing - center.northing).atan2(end.easting - center.easting);
    // Only a genuinely coincident endpoint declares a full circle. A merely
    // close endpoint is a short arc and must retain its authored sweep.
    let sweep = if distance_between(start, end) <= EPSILON {
        value.rotation.sign() * std::f64::consts::TAU
    } else {
        sweep(start_angle, end_angle, value.rotation)
    };
    let geometric_length = radius * sweep.abs();
    let length = valid_length(id, value.declared_length.unwrap_or(geometric_length))?;
    if (length - geometric_length).abs() > geometry_tolerance(length.max(geometric_length)) {
        return Err(diagnostic(
            id,
            "LXMLA220",
            "curve declared length is inconsistent with radius and sweep",
        ));
    }
    Ok((start_angle, sweep, length, center, radius))
}
fn line_length(id: &LandXmlSourceId, value: &LandXmlLine) -> Result<f64> {
    let chord = distance_between(coordinates(id, &value.start)?, coordinates(id, &value.end)?);
    let length = valid_length(id, value.declared_length.unwrap_or(chord))?;
    if (length - chord).abs() > geometry_tolerance(length.max(chord)) {
        return Err(diagnostic(
            id,
            "LXMLA218",
            "line endpoints are inconsistent with declared length",
        ));
    }
    Ok(length)
}
fn irregular_length(id: &LandXmlSourceId, value: &LandXmlIrregularLine) -> Result<f64> {
    let points = irregular_vertices(id, value)?;
    let geometric_length: f64 = points
        .windows(2)
        .map(|pair| distance_between(pair[0], pair[1]))
        .sum();
    let length = valid_length(id, value.declared_length.unwrap_or(geometric_length))?;
    if (length - geometric_length).abs() > geometry_tolerance(length.max(geometric_length)) {
        return Err(diagnostic(
            id,
            "LXMLA221",
            "irregular line declared length is inconsistent with its authored polyline",
        ));
    }
    Ok(length)
}
fn irregular_vertices(
    id: &LandXmlSourceId,
    value: &LandXmlIrregularLine,
) -> Result<Vec<LandXmlPlanPoint>> {
    let start = coordinates(id, &value.start)?;
    let end = coordinates(id, &value.end)?;
    let first_interior = value
        .points
        .iter()
        .position(|point| distance_between(*point, start) > EPSILON)
        .unwrap_or(value.points.len());
    let last_interior = value
        .points
        .iter()
        .rposition(|point| distance_between(*point, end) > EPSILON)
        .map_or(first_interior, |index| index.saturating_add(1));
    let mut vertices = Vec::with_capacity(last_interior.saturating_sub(first_interior) + 2);
    vertices.push(start);
    for point in &value.points[first_interior..last_interior] {
        ensure_finite_point(id, *point)?;
        if vertices
            .last()
            .is_none_or(|previous| distance_between(*previous, *point) > EPSILON)
        {
            vertices.push(*point);
        }
    }
    if vertices
        .last()
        .is_none_or(|previous| distance_between(*previous, end) > EPSILON)
    {
        vertices.push(end);
    }
    Ok(vertices)
}
fn geometry_tolerance(length: f64) -> f64 {
    (length * 1e-6).max(1e-6)
}
fn coordinates(id: &LandXmlSourceId, value: &LandXmlPointLocation) -> Result<LandXmlPlanPoint> {
    match value {
        LandXmlPointLocation::Coordinates { point } => {
            ensure_finite_point(id, *point)?;
            Ok(*point)
        }
        LandXmlPointLocation::PointReference { .. } => Err(diagnostic(
            id,
            "LXMLA211",
            "pntRef requires the later COGO resolver",
        )),
    }
}
fn ensure_finite_point(id: &LandXmlSourceId, point: LandXmlPlanPoint) -> Result<()> {
    if point.northing.is_finite()
        && point.easting.is_finite()
        && point.elevation.is_none_or(f64::is_finite)
    {
        Ok(())
    } else {
        Err(diagnostic(
            id,
            "LXMLA222",
            "primitive coordinate must be finite",
        ))
    }
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
