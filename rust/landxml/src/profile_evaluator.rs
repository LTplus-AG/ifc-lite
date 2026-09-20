/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Vertical-alignment evaluation over durable LandXML profile records.

use crate::{
    LandXmlProfile, LandXmlProfileEvaluationError, LandXmlProfileKind, LandXmlVerticalCurveKind,
};

impl LandXmlProfile {
    /// Evaluate a proposed profile at an authored station.
    ///
    /// This is intentionally only available for `ProfAlign`: sampled
    /// `ProfSurf` grade lines retain discontinuities and must not be bridged.
    /// A curve's text coordinate is its PVI. Its incoming/outgoing tangents
    /// come from adjacent finite PVIs. `None` is outside the source extent;
    /// an error means required tangent geometry is absent or contradictory.
    pub fn evaluate_elevation_at(
        &self,
        station: f64,
    ) -> Result<Option<f64>, LandXmlProfileEvaluationError> {
        if self.kind != LandXmlProfileKind::Design || !station.is_finite() {
            return Ok(None);
        }
        for curve in &self.vertical_curves {
            let Some(index) = self
                .pvis
                .iter()
                .position(|pvi| pvi.station == curve.station && pvi.elevation == curve.elevation)
            else {
                return Err(LandXmlProfileEvaluationError::MissingTangentPvi);
            };
            let Some((before, pvi, after)) = self
                .pvis
                .get(index.checked_sub(1).unwrap_or(usize::MAX))
                .zip(self.pvis.get(index))
                .zip(self.pvis.get(index + 1))
                .map(|((before, pvi), after)| (before, pvi, after))
            else {
                return Err(LandXmlProfileEvaluationError::MissingTangentPvi);
            };
            let (Some(before_elevation), Some(pvi_elevation), Some(after_elevation)) =
                (before.elevation, pvi.elevation, after.elevation)
            else {
                return Err(LandXmlProfileEvaluationError::MissingTangentPvi);
            };
            let incoming_run = pvi.station - before.station;
            let outgoing_run = after.station - pvi.station;
            if incoming_run <= 0.0 || outgoing_run <= 0.0 {
                return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
            }
            let incoming_grade = (pvi_elevation - before_elevation) / incoming_run;
            let outgoing_grade = (after_elevation - pvi_elevation) / outgoing_run;
            let result = match curve.kind {
                LandXmlVerticalCurveKind::Parabolic => evaluate_parabolic(
                    station,
                    pvi.station,
                    pvi_elevation,
                    incoming_grade,
                    outgoing_grade,
                    curve.length,
                ),
                LandXmlVerticalCurveKind::UnsymmetricalParabolic => {
                    evaluate_unsymmetrical_parabolic(
                        station,
                        pvi.station,
                        pvi_elevation,
                        incoming_grade,
                        outgoing_grade,
                        curve.length_in,
                        curve.length_out,
                    )
                }
                LandXmlVerticalCurveKind::Circular => evaluate_circular(
                    station,
                    pvi.station,
                    pvi_elevation,
                    incoming_grade,
                    outgoing_grade,
                    curve.length,
                    curve.radius,
                ),
            }?;
            if result.is_some() {
                return Ok(result);
            }
        }
        evaluate_tangent(self, station)
    }
}

fn evaluate_parabolic(
    station: f64,
    pvi_station: f64,
    pvi_elevation: f64,
    incoming_grade: f64,
    outgoing_grade: f64,
    length: Option<f64>,
) -> Result<Option<f64>, LandXmlProfileEvaluationError> {
    let Some(length) = length.filter(|value| *value > 0.0) else {
        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
    };
    let half = length / 2.0;
    let start = pvi_station - half;
    if station < start || station > pvi_station + half {
        return Ok(None);
    }
    let x = station - start;
    Ok(Some(
        pvi_elevation - incoming_grade * half
            + incoming_grade * x
            + (outgoing_grade - incoming_grade) * x * x / (2.0 * length),
    ))
}

fn evaluate_unsymmetrical_parabolic(
    station: f64,
    pvi_station: f64,
    pvi_elevation: f64,
    incoming_grade: f64,
    outgoing_grade: f64,
    length_in: Option<f64>,
    length_out: Option<f64>,
) -> Result<Option<f64>, LandXmlProfileEvaluationError> {
    let (Some(length_in), Some(length_out)) = (length_in, length_out) else {
        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
    };
    if length_in <= 0.0 || length_out <= 0.0 {
        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
    }
    let start = pvi_station - length_in;
    if station < start || station > pvi_station + length_out {
        return Ok(None);
    }
    let total = length_in + length_out;
    let change = outgoing_grade - incoming_grade;
    // The two legs meet at the PVI station, but the PVI is the tangent
    // intersection, not a point on the curve. Solving both tangent endpoints
    // and C1 continuity gives distinct rates for unequal legs.
    let incoming_rate = change * length_out / (length_in * total);
    let outgoing_rate = change * length_in / (length_out * total);
    let x = station - start;
    let start_elevation = pvi_elevation - incoming_grade * length_in;
    if x <= length_in {
        return Ok(Some(
            start_elevation + incoming_grade * x + incoming_rate * x * x / 2.0,
        ));
    }
    let at_pvi =
        start_elevation + incoming_grade * length_in + incoming_rate * length_in * length_in / 2.0;
    let pvi_grade = incoming_grade + incoming_rate * length_in;
    let local = x - length_in;
    Ok(Some(
        at_pvi + pvi_grade * local + outgoing_rate * local * local / 2.0,
    ))
}

fn evaluate_circular(
    station: f64,
    pvi_station: f64,
    pvi_elevation: f64,
    incoming_grade: f64,
    outgoing_grade: f64,
    length: Option<f64>,
    radius: Option<f64>,
) -> Result<Option<f64>, LandXmlProfileEvaluationError> {
    let Some(total) = length.filter(|value| *value > 0.0) else {
        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
    };
    let Some(radius) = radius.filter(|value| *value > 0.0) else {
        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
    };
    let sine_in = incoming_grade.atan().sin();
    let sine_out = outgoing_grade.atan().sin();
    let change = sine_out - sine_in;
    if change.abs() <= f64::EPSILON {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let curvature = change.signum() / radius;
    if (change - curvature * total).abs() > 1.0e-8_f64.max(total * 1.0e-8) {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let rise = ((1.0 - sine_in * sine_in).sqrt() - (1.0 - sine_out * sine_out).sqrt()) / curvature;
    let grade_change = outgoing_grade - incoming_grade;
    if grade_change.abs() <= f64::EPSILON {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let start_relative_to_pvi = (rise - outgoing_grade * total) / grade_change;
    let end_relative_to_pvi = start_relative_to_pvi + total;
    if start_relative_to_pvi >= 0.0 || end_relative_to_pvi <= 0.0 {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let start = pvi_station + start_relative_to_pvi;
    if station < start || station > pvi_station + end_relative_to_pvi {
        return Ok(None);
    }
    let sine = sine_in + curvature * (station - start);
    if sine.abs() > 1.0 + 1.0e-12 {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    Ok(Some(
        pvi_elevation
            + incoming_grade * start_relative_to_pvi
            + ((1.0 - sine_in * sine_in).sqrt() - (1.0 - sine * sine).max(0.0).sqrt()) / curvature,
    ))
}

fn evaluate_tangent(
    profile: &LandXmlProfile,
    station: f64,
) -> Result<Option<f64>, LandXmlProfileEvaluationError> {
    for pair in profile.pvis.windows(2) {
        let (left, right) = (&pair[0], &pair[1]);
        if station < left.station || station > right.station {
            continue;
        }
        let (Some(left_elevation), Some(right_elevation)) = (left.elevation, right.elevation)
        else {
            return Ok(None);
        };
        let run = right.station - left.station;
        if run <= 0.0 {
            return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
        }
        return Ok(Some(
            left_elevation + (station - left.station) * (right_elevation - left_elevation) / run,
        ));
    }
    Ok(None)
}
