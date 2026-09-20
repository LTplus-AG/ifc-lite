// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deterministic, mesh-free horizontal-alignment evaluation.

use super::{
    LandXmlAlignment, LandXmlAlignmentPrimitive, LandXmlAlignmentSegment, LandXmlCurve,
    LandXmlLine, LandXmlPlanPoint, LandXmlPointLocation, LandXmlRadius, LandXmlRotation,
    LandXmlSpiral, LandXmlStationEquation,
};
use crate::LandXmlSourceId;

const EPSILON: f64 = 1e-9;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LandXmlNumericDiagnostic {
    pub source_id: LandXmlSourceId,
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for LandXmlNumericDiagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for LandXmlNumericDiagnostic {}

type Result<T> = std::result::Result<T, LandXmlNumericDiagnostic>;

/// All station labels at a geometric boundary. Equations deliberately retain
/// both sides: a displayed label can be duplicated or a numeric gap can occur.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LandXmlStationMapping {
    pub geometric_distance: f64,
    pub displayed_back: f64,
    pub displayed_ahead: f64,
    pub is_equation_boundary: bool,
}

/// A source-level pick/probe result. No renderer chunk, tessellation vertex, or
/// IFC entity participates in its identity.
#[derive(Clone, Debug, PartialEq)]
pub struct LandXmlAlignmentProbe {
    pub alignment_source_id: LandXmlSourceId,
    pub segment_source_id: LandXmlSourceId,
    pub geometric_distance: f64,
    pub station: LandXmlStationMapping,
    pub northing: f64,
    pub easting: f64,
    pub tangent_northing: f64,
    pub tangent_easting: f64,
}

impl LandXmlAlignment {
    /// Maps physical distance to displayed station without conflating the two.
    pub fn station_at_distance(&self, distance: f64) -> Result<LandXmlStationMapping> {
        if !distance.is_finite() || distance < -EPSILON || distance > self.length + EPSILON {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA201",
                "geometric distance is outside the alignment",
            ));
        }
        let internal = self.sta_start + distance.clamp(0.0, self.length);
        station_mapping(&self.source_id, self.sta_start, internal, &self.station_equations)
    }

    /// Returns every geometric distance matching a displayed station. An empty
    /// result is an intentional station gap, not a nearest-station guess.
    pub fn distances_for_station(&self, station: f64) -> Result<Vec<f64>> {
        if !station.is_finite() {
            return Err(diagnostic(&self.source_id, "LXMLA202", "station must be finite"));
        }
        let mut boundaries = vec![self.sta_start];
        boundaries.extend(self.station_equations.iter().map(|equation| equation.sta_internal));
        boundaries.push(self.sta_start + self.length);
        let mut out = Vec::new();
        for (index, window) in boundaries.windows(2).enumerate() {
            let internal_start = window[0];
            let internal_end = window[1];
            let display_start = if index == 0 {
                self.sta_start
            } else {
                self.station_equations[index - 1].sta_ahead
            };
            let candidate = internal_start + (station - display_start);
            if candidate >= internal_start - EPSILON && candidate <= internal_end + EPSILON {
                out.push((candidate - self.sta_start).clamp(0.0, self.length));
            }
        }
        out.sort_by(f64::total_cmp);
        out.dedup_by(|left, right| (*left - *right).abs() <= EPSILON);
        Ok(out)
    }

    /// Evaluates an authored primitive at a physical distance. This is a
    /// numerical probe, never a mesh-generation request.
    pub fn probe_at_distance(&self, distance: f64, offset_right: f64) -> Result<LandXmlAlignmentProbe> {
        if !offset_right.is_finite() {
            return Err(diagnostic(&self.source_id, "LXMLA203", "offset must be finite"));
        }
        let station = self.station_at_distance(distance)?;
        let (segment, local) = self.segment_at_distance(distance)?;
        let (point, tangent) = evaluate_segment(segment, local)?;
        let northing = point.northing + tangent.1 * offset_right;
        let easting = point.easting - tangent.0 * offset_right;
        Ok(LandXmlAlignmentProbe {
            alignment_source_id: self.source_id.clone(),
            segment_source_id: segment.source_id.clone(),
            geometric_distance: distance.clamp(0.0, self.length),
            station,
            northing,
            easting,
            tangent_northing: tangent.0,
            tangent_easting: tangent.1,
        })
    }

    /// Resolves an explicitly selected displayed station. Duplicate labels are
    /// rejected rather than choosing a render piece arbitrarily.
    pub fn probe_at_station(&self, station: f64, offset_right: f64) -> Result<LandXmlAlignmentProbe> {
        let distances = self.distances_for_station(station)?;
        match distances.as_slice() {
            [distance] => self.probe_at_distance(*distance, offset_right),
            [] => Err(diagnostic(&self.source_id, "LXMLA204", "station is in a station equation gap")),
            _ => Err(diagnostic(&self.source_id, "LXMLA205", "station label is duplicated by an equation")),
        }
    }

    fn segment_at_distance(&self, distance: f64) -> Result<(&LandXmlAlignmentSegment, f64)> {
        let mut start = 0.0;
        for segment in &self.segments {
            let length = segment_length(segment)?;
            if distance <= start + length + EPSILON {
                return Ok((segment, (distance - start).clamp(0.0, length)));
            }
            start += length;
        }
        Err(diagnostic(&self.source_id, "LXMLA206", "no primitive covers geometric distance"))
    }
}

fn station_mapping(
    source_id: &LandXmlSourceId,
    sta_start: f64,
    internal: f64,
    equations: &[LandXmlStationEquation],
) -> Result<LandXmlStationMapping> {
    let mut previous_internal = sta_start;
    let mut displayed = sta_start;
    for equation in equations {
        if !equation.sta_internal.is_finite() || equation.sta_internal <= previous_internal + EPSILON {
            return Err(diagnostic(source_id, "LXMLA207", "station equations must be strictly increasing"));
        }
        if internal < equation.sta_internal - EPSILON {
            let value = displayed + (internal - previous_internal);
            return Ok(LandXmlStationMapping {
                geometric_distance: internal - sta_start,
                displayed_back: value,
                displayed_ahead: value,
                is_equation_boundary: false,
            });
        }
        if (internal - equation.sta_internal).abs() <= EPSILON {
            return Ok(LandXmlStationMapping {
                geometric_distance: internal - sta_start,
                displayed_back: equation.sta_back.unwrap_or(displayed + (internal - previous_internal)),
                displayed_ahead: equation.sta_ahead,
                is_equation_boundary: true,
            });
        }
        previous_internal = equation.sta_internal;
        displayed = equation.sta_ahead;
    }
    let value = displayed + (internal - previous_internal);
    Ok(LandXmlStationMapping {
        geometric_distance: internal - sta_start,
        displayed_back: value,
        displayed_ahead: value,
        is_equation_boundary: false,
    })
}

fn segment_length(segment: &LandXmlAlignmentSegment) -> Result<f64> {
    let length = match &segment.primitive {
        LandXmlAlignmentPrimitive::Line(line) => line_length(line)?,
        LandXmlAlignmentPrimitive::IrregularLine(line) => irregular_length(line)?,
        LandXmlAlignmentPrimitive::Curve(curve) => curve_geometry(&segment.source_id, curve)?.2,
        LandXmlAlignmentPrimitive::Spiral(spiral) => spiral.declared_length,
    };
    valid_length(&segment.source_id, length)
}

fn evaluate_segment(segment: &LandXmlAlignmentSegment, distance: f64) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    match &segment.primitive {
        LandXmlAlignmentPrimitive::Line(line) => evaluate_line(&segment.source_id, line, distance),
        LandXmlAlignmentPrimitive::IrregularLine(line) => evaluate_irregular(&segment.source_id, line, distance),
        LandXmlAlignmentPrimitive::Curve(curve) => evaluate_curve(&segment.source_id, curve, distance),
        LandXmlAlignmentPrimitive::Spiral(spiral) => evaluate_clothoid(&segment.source_id, spiral, distance),
    }
}

fn evaluate_line(id: &LandXmlSourceId, line: &LandXmlLine, distance: f64) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    let start = coordinates(id, &line.start)?;
    let end = coordinates(id, &line.end)?;
    interpolate(start, end, distance, id)
}

fn evaluate_irregular(id: &LandXmlSourceId, line: &super::LandXmlIrregularLine, distance: f64) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    let mut points = vec![coordinates(id, &line.start)?];
    points.extend(line.points.iter().copied());
    points.push(coordinates(id, &line.end)?);
    let mut remaining = distance;
    for pair in points.windows(2) {
        let length = distance_between(pair[0], pair[1]);
        if remaining <= length + EPSILON {
            return interpolate(pair[0], pair[1], remaining, id);
        }
        remaining -= length;
    }
    Err(diagnostic(id, "LXMLA208", "irregular line has no non-zero geometry"))
}

fn evaluate_curve(id: &LandXmlSourceId, curve: &LandXmlCurve, distance: f64) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    let (start_angle, signed_sweep, length, center, radius) = curve_geometry(id, curve)?;
    let angle = start_angle + signed_sweep * (distance / length).clamp(0.0, 1.0);
    let point = LandXmlPlanPoint {
        northing: center.northing + radius * angle.cos(),
        easting: center.easting + radius * angle.sin(),
        elevation: None,
    };
    let sign = signed_sweep.signum();
    Ok((point, normalize((-sign * angle.sin(), sign * angle.cos()), id)?))
}

fn evaluate_clothoid(id: &LandXmlSourceId, spiral: &LandXmlSpiral, distance: f64) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    if spiral.spi_type != "clothoid" {
        return Err(diagnostic(id, "LXMLA209", "transition is retained but not numerically supported"));
    }
    let start = coordinates(id, &spiral.start)?;
    let end = coordinates(id, &spiral.end)?;
    let length = valid_length(id, spiral.declared_length)?;
    let (k0, k1) = (curvature(id, spiral.radius_start)?, curvature(id, spiral.radius_end)?);
    let signed = spiral.rotation.sign();
    let local_end = clothoid_integral(length, length, signed * k0, signed * k1)?;
    let heading = (end.easting - start.easting).atan2(end.northing - start.northing)
        - local_end.1.atan2(local_end.0);
    let local = clothoid_integral(distance.clamp(0.0, length), length, signed * k0, signed * k1)?;
    let (sin, cos) = heading.sin_cos();
    let point = LandXmlPlanPoint {
        northing: start.northing + local.0 * cos - local.1 * sin,
        easting: start.easting + local.0 * sin + local.1 * cos,
        elevation: None,
    };
    let d = distance.clamp(0.0, length);
    let theta = heading + signed * (k0 * d + 0.5 * (k1 - k0) * d * d / length);
    // The endpoint is an authored constraint, not a rendering approximation.
    // The fixed quadrature only determines interior positions and heading.
    Ok((if (length - d).abs() <= EPSILON { end } else { point }, (theta.cos(), theta.sin())))
}

fn curve_geometry(id: &LandXmlSourceId, curve: &LandXmlCurve) -> Result<(f64, f64, f64, LandXmlPlanPoint, f64)> {
    let start = coordinates(id, &curve.start)?;
    let end = coordinates(id, &curve.end)?;
    let center = coordinates(id, &curve.center)?;
    let radius = curve.radius.unwrap_or(distance_between(start, center));
    if !radius.is_finite() || radius <= EPSILON || (distance_between(end, center) - radius).abs() > radius * 1e-7 {
        return Err(diagnostic(id, "LXMLA210", "curve radius and endpoints are inconsistent"));
    }
    let start_angle = (start.easting - center.easting).atan2(start.northing - center.northing);
    let end_angle = (end.easting - center.easting).atan2(end.northing - center.northing);
    let signed_sweep = sweep(start_angle, end_angle, curve.rotation);
    let length = valid_length(id, curve.declared_length.unwrap_or(radius * signed_sweep.abs()))?;
    Ok((start_angle, signed_sweep, length, center, radius))
}

fn line_length(line: &LandXmlLine) -> Result<f64> {
    let id = LandXmlSourceId("landxml:line".to_owned());
    let computed = distance_between(coordinates(&id, &line.start)?, coordinates(&id, &line.end)?);
    valid_length(&id, line.declared_length.unwrap_or(computed))
}

fn irregular_length(line: &super::LandXmlIrregularLine) -> Result<f64> {
    let id = LandXmlSourceId("landxml:irregular-line".to_owned());
    let mut points = vec![coordinates(&id, &line.start)?];
    points.extend(line.points.iter().copied());
    points.push(coordinates(&id, &line.end)?);
    let computed = points.windows(2).map(|pair| distance_between(pair[0], pair[1])).sum();
    valid_length(&id, line.declared_length.unwrap_or(computed))
}

fn coordinates(id: &LandXmlSourceId, location: &LandXmlPointLocation) -> Result<LandXmlPlanPoint> {
    match location {
        LandXmlPointLocation::Coordinates { point } => Ok(*point),
        LandXmlPointLocation::PointReference { .. } => Err(diagnostic(id, "LXMLA211", "pntRef requires the later COGO resolver")),
    }
}

fn curvature(id: &LandXmlSourceId, radius: LandXmlRadius) -> Result<f64> {
    match radius {
        LandXmlRadius::Infinite => Ok(0.0),
        LandXmlRadius::Finite(value) if value.is_finite() && value > EPSILON => Ok(1.0 / value),
        LandXmlRadius::Finite(_) => Err(diagnostic(id, "LXMLA212", "spiral radius must be positive or INF")),
    }
}

fn clothoid_integral(distance: f64, length: f64, k0: f64, k1: f64) -> Result<(f64, f64)> {
    // Fixed 16-point Gauss-Legendre quadrature: deterministic across probes,
    // independent of render-tessellation density, and accurate for the exact
    // linear-curvature (clothoid) definition.
    const NODES: [f64; 8] = [0.095_012_509_837_637_4, 0.281_603_550_779_259, 0.458_016_777_657_227, 0.617_876_244_402_644, 0.755_404_408_355_003, 0.865_631_202_387_832, 0.944_575_023_073_233, 0.989_400_934_991_65];
    const WEIGHTS: [f64; 8] = [0.189_450_610_455_069, 0.182_603_415_044_924, 0.169_156_519_395_003, 0.149_595_988_816_577, 0.124_628_971_255_534, 0.095_158_511_682_493_2, 0.062_253_523_938_647_9, 0.027_152_459_411_754_1];
    if !distance.is_finite() || !length.is_finite() || length <= EPSILON {
        return Err(diagnostic(&LandXmlSourceId("landxml:spiral".to_owned()), "LXMLA213", "invalid clothoid length"));
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

fn interpolate(start: LandXmlPlanPoint, end: LandXmlPlanPoint, distance: f64, id: &LandXmlSourceId) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    let length = distance_between(start, end);
    let tangent = normalize(((end.northing - start.northing) / length, (end.easting - start.easting) / length), id)?;
    let factor = (distance / length).clamp(0.0, 1.0);
    Ok((LandXmlPlanPoint {
        northing: start.northing + (end.northing - start.northing) * factor,
        easting: start.easting + (end.easting - start.easting) * factor,
        elevation: None,
    }, tangent))
}

fn normalize(vector: (f64, f64), id: &LandXmlSourceId) -> Result<(f64, f64)> {
    let length = (vector.0 * vector.0 + vector.1 * vector.1).sqrt();
    if !length.is_finite() || length <= EPSILON {
        return Err(diagnostic(id, "LXMLA214", "primitive has zero-length tangent"));
    }
    Ok((vector.0 / length, vector.1 / length))
}

fn distance_between(left: LandXmlPlanPoint, right: LandXmlPlanPoint) -> f64 {
    (right.northing - left.northing).hypot(right.easting - left.easting)
}

fn sweep(start: f64, end: f64, rotation: LandXmlRotation) -> f64 {
    let raw = (end - start).rem_euclid(std::f64::consts::TAU);
    match rotation {
        LandXmlRotation::CounterClockwise => raw,
        LandXmlRotation::Clockwise => -(std::f64::consts::TAU - raw).rem_euclid(std::f64::consts::TAU),
    }
}

fn valid_length(id: &LandXmlSourceId, length: f64) -> Result<f64> {
    if !length.is_finite() || length <= EPSILON {
        return Err(diagnostic(id, "LXMLA215", "primitive length must be positive and finite"));
    }
    Ok(length)
}

fn diagnostic(source_id: &LandXmlSourceId, code: &'static str, message: impl Into<String>) -> LandXmlNumericDiagnostic {
    LandXmlNumericDiagnostic { source_id: source_id.clone(), code, message: message.into() }
}
