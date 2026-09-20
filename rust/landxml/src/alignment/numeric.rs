// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deterministic, mesh-free horizontal-alignment evaluation.

mod geometry;

use super::{LandXmlAlignment, LandXmlAlignmentSegment, LandXmlStationEquation};
use crate::LandXmlSourceId;
use geometry::{evaluate_segment, segment_length};

pub(super) const EPSILON: f64 = 1e-9;
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
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LandXmlStationMapping {
    pub geometric_distance: f64,
    pub displayed_back: f64,
    pub displayed_ahead: f64,
    pub is_equation_boundary: bool,
}
/// A source-level pick/probe result, independent of renderer chunks and IFC.
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
        station_mapping(
            &self.source_id,
            self.sta_start,
            self.sta_start + distance.clamp(0.0, self.length),
            &self.station_equations,
        )
    }
    /// Returns every physical distance matching a displayed station. Empty is a station gap.
    pub fn distances_for_station(&self, station: f64) -> Result<Vec<f64>> {
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
        let mut out = Vec::new();
        for (index, window) in boundaries.windows(2).enumerate() {
            let display_start = if index == 0 {
                self.sta_start
            } else {
                self.station_equations[index - 1].sta_ahead
            };
            let candidate = window[0] + (station - display_start);
            if candidate >= window[0] - EPSILON && candidate <= window[1] + EPSILON {
                out.push((candidate - self.sta_start).clamp(0.0, self.length));
            }
        }
        out.sort_by(f64::total_cmp);
        out.dedup_by(|left, right| (*left - *right).abs() <= EPSILON);
        Ok(out)
    }
    /// Evaluates an authored primitive at a physical distance, never a mesh request.
    pub fn probe_at_distance(
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
        let station = self.station_at_distance(distance)?;
        let (segment, local) = self.segment_at_distance(distance)?;
        let (point, tangent) = evaluate_segment(segment, local)?;
        Ok(LandXmlAlignmentProbe {
            alignment_source_id: self.source_id.clone(),
            segment_source_id: segment.source_id.clone(),
            geometric_distance: distance.clamp(0.0, self.length),
            station,
            northing: point.northing + tangent.1 * offset_right,
            easting: point.easting - tangent.0 * offset_right,
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
        match self.distances_for_station(station)?.as_slice() {
            [distance] => self.probe_at_distance(*distance, offset_right),
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
    fn segment_at_distance(&self, distance: f64) -> Result<(&LandXmlAlignmentSegment, f64)> {
        let mut start = 0.0;
        for segment in &self.segments {
            let length = segment_length(segment)?;
            if distance <= start + length + EPSILON {
                return Ok((segment, (distance - start).clamp(0.0, length)));
            }
            start += length;
        }
        Err(diagnostic(
            &self.source_id,
            "LXMLA206",
            "no primitive covers geometric distance",
        ))
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
        if !equation.sta_internal.is_finite()
            || equation.sta_internal <= previous_internal + EPSILON
        {
            return Err(diagnostic(
                source_id,
                "LXMLA207",
                "station equations must be strictly increasing",
            ));
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
                displayed_back: equation
                    .sta_back
                    .unwrap_or(displayed + (internal - previous_internal)),
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
