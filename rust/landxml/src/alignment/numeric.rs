// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deterministic, mesh-free horizontal-alignment evaluation.

mod geometry;

use super::{LandXmlAlignment, LandXmlAlignmentSegment, LandXmlStationEquation};
use crate::LandXmlSourceId;
use geometry::{evaluate_segment, segment_endpoints, validate_segment};

pub(super) const EPSILON: f64 = 1e-9;
/// Maximum number of equal displayed-station matches returned to an
/// interactive caller. More is an explicit refusal, not an unbounded result.
pub const MAX_INTERACTIVE_STATION_PROBES: usize = 128;
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
pub(super) type Result<T> = std::result::Result<T, LandXmlNumericDiagnostic>;

/// All station labels at a geometric boundary. Equations deliberately retain
/// both sides: a displayed label can be duplicated or a numeric gap can occur.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct LandXmlStationMapping {
    pub geometric_distance: f64,
    pub displayed_back: f64,
    pub displayed_ahead: f64,
    pub is_equation_boundary: bool,
}
/// A source-level pick/probe result, independent of renderer chunks and IFC.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
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
        validate_numeric_alignment(self)?;
        if !distance.is_finite() || distance < -EPSILON || distance > self.length + EPSILON {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA201",
                "geometric distance is outside the alignment",
            ));
        }
        station_mapping(
            &self.source_id,
            self.sta_start,
            self.sta_start + distance.clamp(0.0, self.length),
            &self.station_equations,
        )
    }
    /// Returns every physical distance matching a displayed station. Empty is a station gap.
    pub fn distances_for_station(&self, station: f64) -> Result<Vec<f64>> {
        validate_numeric_alignment(self)?;
        self.distances_for_station_validated(station, None)
    }

    fn distances_for_station_validated(
        &self,
        station: f64,
        max_matches: Option<usize>,
    ) -> Result<Vec<f64>> {
        if !station.is_finite() {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA202",
                "station must be finite",
            ));
        }
        let mut boundaries = vec![self.sta_start];
        boundaries.extend(
            self.station_equations
                .iter()
                .map(|equation| equation.sta_internal),
        );
        boundaries.push(self.sta_start + self.length);
        let mut out: Vec<f64> = Vec::new();
        let mut direction = 1.0;
        for (index, window) in boundaries.windows(2).enumerate() {
            let display_start = if index == 0 {
                self.sta_start
            } else {
                self.station_equations[index - 1].sta_ahead
            };
            let candidate = window[0] + (station - display_start) / direction;
            if candidate >= window[0] - EPSILON && candidate <= window[1] + EPSILON {
                let distance = (candidate - self.sta_start).clamp(0.0, self.length);
                if out.last().is_none_or(|previous| (distance - *previous).abs() > EPSILON) {
                    out.push(distance);
                    if max_matches.is_some_and(|maximum| out.len() > maximum) {
                        return Err(diagnostic(
                            &self.source_id,
                            "LXMLA230",
                            "station label has too many physical matches for an interactive probe",
                        ));
                    }
                }
            }
            if let Some(equation) = self.station_equations.get(index) {
                direction = equation_direction(equation);
            }
        }
        Ok(out)
    }
    /// Evaluates an authored primitive at a physical distance, never a mesh request.
    pub fn probe_at_distance(
        &self,
        distance: f64,
        offset_right: f64,
    ) -> Result<LandXmlAlignmentProbe> {
        validate_numeric_alignment(self)?;
        self.probe_at_distance_validated(distance, offset_right)
    }

    fn probe_at_distance_validated(
        &self,
        distance: f64,
        offset_right: f64,
    ) -> Result<LandXmlAlignmentProbe> {
        if !offset_right.is_finite() {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA203",
                "offset must be finite",
            ));
        }
        if !distance.is_finite() || distance < -EPSILON || distance > self.length + EPSILON {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA201",
                "geometric distance is outside the alignment",
            ));
        }
        let station = station_mapping(
            &self.source_id,
            self.sta_start,
            self.sta_start + distance.clamp(0.0, self.length),
            &self.station_equations,
        )?;
        let (segment, local) = self.segment_at_distance(distance)?;
        let (point, tangent) = evaluate_segment(segment, local)?;
        Ok(LandXmlAlignmentProbe {
            alignment_source_id: self.source_id.clone(),
            segment_source_id: segment.source_id.clone(),
            geometric_distance: distance.clamp(0.0, self.length),
            station,
            // LandXML coordinates are Northing/Easting; right of travel is
            // clockwise in the conventional Easting/Northing plane.
            northing: point.northing - tangent.1 * offset_right,
            easting: point.easting + tangent.0 * offset_right,
            tangent_northing: tangent.0,
            tangent_easting: tangent.1,
        })
    }
    /// Resolves one displayed label, refusing duplicate labels rather than guessing.
    pub fn probe_at_station(
        &self,
        station: f64,
        offset_right: f64,
    ) -> Result<LandXmlAlignmentProbe> {
        validate_numeric_alignment(self)?;
        match self.distances_for_station_validated(station, None)?.as_slice() {
            [distance] => self.probe_at_distance_validated(*distance, offset_right),
            [] => Err(diagnostic(
                &self.source_id,
                "LXMLA204",
                "station is in a station equation gap",
            )),
            _ => Err(diagnostic(
                &self.source_id,
                "LXMLA205",
                "station label is duplicated by an equation",
            )),
        }
    }

    /// Validate once, then evaluate a bounded number of displayed-station
    /// matches. This avoids repeated O(n) validation for duplicate equations.
    pub fn probes_at_station(
        &self,
        station: f64,
        offset_right: f64,
        max_matches: usize,
    ) -> Result<Vec<LandXmlAlignmentProbe>> {
        if max_matches == 0 {
            return Err(diagnostic(
                &self.source_id,
                "LXMLA230",
                "interactive station probe limit must be positive",
            ));
        }
        validate_numeric_alignment(self)?;
        self.distances_for_station_validated(station, Some(max_matches))?
            .into_iter()
            .map(|distance| self.probe_at_distance_validated(distance, offset_right))
            .collect()
    }
    fn segment_at_distance(&self, distance: f64) -> Result<(&LandXmlAlignmentSegment, f64)> {
        let mut start = 0.0;
        for (index, segment) in self.segments.iter().enumerate() {
            let length = validate_segment(segment)?;
            let end = start + length;
            // A shared boundary belongs to the following authored span. This
            // keeps source provenance deterministic at a station equation and
            // avoids returning a prior segment after its geometric end.
            if distance < end - EPSILON || index + 1 == self.segments.len() {
                return Ok((segment, (distance - start).clamp(0.0, length)));
            }
            start = end;
        }
        Err(diagnostic(
            &self.source_id,
            "LXMLA206",
            "no primitive covers geometric distance",
        ))
    }
}
fn validate_numeric_alignment(alignment: &LandXmlAlignment) -> Result<()> {
    valid_alignment_length(alignment)?;
    let end = finite_add(
        &alignment.source_id,
        alignment.sta_start,
        alignment.length,
        "alignment station range overflows",
    )?;
    if alignment.segments.is_empty() {
        return Err(diagnostic(
            &alignment.source_id,
            "LXMLA224",
            "alignment has no numeric geometry",
        ));
    }
    let mut total: f64 = 0.0;
    let mut previous_end = None;
    for segment in &alignment.segments {
        let length = validate_segment(segment)?;
        let (start, finish) = segment_endpoints(segment)?;
        if let Some(previous) = previous_end {
            if planar_distance(previous, start) > geometry_tolerance(total.max(length)) {
                return Err(diagnostic(
                    &segment.source_id,
                    "LXMLA225",
                    "ordered alignment segments are discontinuous",
                ));
            }
        }
        total = finite_add(
            &alignment.source_id,
            total,
            length,
            "alignment segment lengths overflow",
        )?;
        previous_end = Some(finish);
    }
    if (alignment.length - total).abs() > geometry_tolerance(alignment.length.max(total)) {
        return Err(diagnostic(
            &alignment.source_id,
            "LXMLA226",
            "alignment length is inconsistent with ordered segment spans",
        ));
    }
    validate_station_equations(alignment, end)
}
fn valid_alignment_length(alignment: &LandXmlAlignment) -> Result<()> {
    if !alignment.length.is_finite() || alignment.length <= EPSILON {
        return Err(diagnostic(
            &alignment.source_id,
            "LXMLA200",
            "alignment length must be positive and finite",
        ));
    }
    if !alignment.sta_start.is_finite() {
        return Err(diagnostic(
            &alignment.source_id,
            "LXMLA200",
            "alignment start station must be finite",
        ));
    }
    Ok(())
}
fn station_mapping(
    source_id: &LandXmlSourceId,
    sta_start: f64,
    internal: f64,
    equations: &[LandXmlStationEquation],
) -> Result<LandXmlStationMapping> {
    let mut previous_internal = sta_start;
    let mut displayed = sta_start;
    let mut direction = 1.0;
    for (index, equation) in equations.iter().enumerate() {
        if !equation.sta_internal.is_finite()
            || (index == 0 && equation.sta_internal < previous_internal - EPSILON)
            || (index > 0 && equation.sta_internal <= previous_internal + EPSILON)
        {
            return Err(diagnostic(
                source_id,
                "LXMLA207",
                "station equations must be strictly increasing",
            ));
        }
        if internal < equation.sta_internal - EPSILON {
            let value = displayed + direction * (internal - previous_internal);
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
                displayed_back: equation
                    .sta_back
                    .unwrap_or(displayed + direction * (internal - previous_internal)),
                displayed_ahead: equation.sta_ahead,
                is_equation_boundary: true,
            });
        }
        previous_internal = equation.sta_internal;
        displayed = equation.sta_ahead;
        direction = equation_direction(equation);
    }
    let value = displayed + direction * (internal - previous_internal);
    Ok(LandXmlStationMapping {
        geometric_distance: internal - sta_start,
        displayed_back: value,
        displayed_ahead: value,
        is_equation_boundary: false,
    })
}
fn validate_station_equations(alignment: &LandXmlAlignment, end: f64) -> Result<()> {
    let mut previous = alignment.sta_start;
    let mut displayed = alignment.sta_start;
    let mut direction = 1.0;
    for (index, equation) in alignment.station_equations.iter().enumerate() {
        if !equation.sta_internal.is_finite()
            || !equation.sta_ahead.is_finite()
            || equation.sta_back.is_some_and(|value| !value.is_finite())
            || equation.sta_internal > end + EPSILON
            || (index == 0 && equation.sta_internal < previous - EPSILON)
            || (index > 0 && equation.sta_internal <= previous + EPSILON)
        {
            return Err(diagnostic(
                &alignment.source_id,
                "LXMLA207",
                "station equations must lie on the alignment and be strictly ordered",
            ));
        }
        let expected_back = finite_add(
            &alignment.source_id,
            displayed,
            direction * (equation.sta_internal - previous),
            "station equation derived station overflows",
        )?;
        if equation.sta_back.is_some_and(|back| {
            (back - expected_back).abs() > station_tolerance(back, expected_back)
        }) {
            return Err(diagnostic(
                &equation.source_id,
                "LXMLA227",
                "StaEquation staBack is inconsistent with the preceding station axis",
            ));
        }
        previous = equation.sta_internal;
        displayed = equation.sta_ahead;
        direction = equation_direction(equation);
    }
    let _ = finite_add(
        &alignment.source_id,
        displayed,
        direction * (end - previous),
        "station equation derived station overflows",
    )?;
    Ok(())
}
fn finite_add(
    source_id: &LandXmlSourceId,
    left: f64,
    right: f64,
    message: &'static str,
) -> Result<f64> {
    let value = left + right;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(diagnostic(source_id, "LXMLA228", message))
    }
}
fn planar_distance(
    left: crate::alignment::LandXmlPlanPoint,
    right: crate::alignment::LandXmlPlanPoint,
) -> f64 {
    (right.northing - left.northing).hypot(right.easting - left.easting)
}
fn geometry_tolerance(length: f64) -> f64 {
    (length * 1e-6).max(1e-6)
}
fn station_tolerance(left: f64, right: f64) -> f64 {
    left.abs().max(right.abs()).mul_add(1e-12, EPSILON)
}
fn equation_direction(equation: &LandXmlStationEquation) -> f64 {
    if equation.sta_increment.as_deref() == Some("decreasing") {
        -1.0
    } else {
        1.0
    }
}
pub(super) fn diagnostic(
    source_id: &LandXmlSourceId,
    code: &'static str,
    message: impl Into<String>,
) -> LandXmlNumericDiagnostic {
    LandXmlNumericDiagnostic {
        source_id: source_id.clone(),
        code,
        message: message.into(),
    }
}
