/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::{
    LandXmlProfile, LandXmlProfileEvaluationError, LandXmlProfileKind, LandXmlVerticalCurve,
    LandXmlVerticalCurveKind,
};

impl LandXmlProfile {
    /// Evaluate a proposed `ProfAlign` at an authored station without bridging sampled gaps.
    pub fn evaluate_elevation_at(
        &self,
        station: f64,
    ) -> Result<Option<f64>, LandXmlProfileEvaluationError> {
        if self.kind != LandXmlProfileKind::Design || !station.is_finite() {
            return Ok(None);
        }
        validate_curve_declarations(self)?;
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
            if !before.station.is_finite()
                || !pvi.station.is_finite()
                || !after.station.is_finite()
                || !before_elevation.is_finite()
                || !pvi_elevation.is_finite()
                || !after_elevation.is_finite()
                || !incoming_run.is_finite()
                || !outgoing_run.is_finite()
            {
                return Err(LandXmlProfileEvaluationError::NonFiniteEvaluation);
            }
            if incoming_run <= 0.0 || outgoing_run <= 0.0 {
                return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
            }
            let incoming_grade = (pvi_elevation - before_elevation) / incoming_run;
            let outgoing_grade = (after_elevation - pvi_elevation) / outgoing_run;
            if !incoming_grade.is_finite() || !outgoing_grade.is_finite() {
                return Err(LandXmlProfileEvaluationError::NonFiniteEvaluation);
            }
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

fn validate_curve_declarations(
    profile: &LandXmlProfile,
) -> Result<(), LandXmlProfileEvaluationError> {
    let mut previous_end = None;
    for curve in &profile.vertical_curves {
        let Some(index) = profile
            .pvis
            .iter()
            .position(|pvi| pvi.station == curve.station && pvi.elevation == curve.elevation)
        else {
            return Err(LandXmlProfileEvaluationError::MissingTangentPvi);
        };
        let Some((before, pvi, after)) = profile
            .pvis
            .get(index.checked_sub(1).unwrap_or(usize::MAX))
            .zip(profile.pvis.get(index))
            .zip(profile.pvis.get(index + 1))
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
        if ![
            before.station,
            pvi.station,
            after.station,
            before_elevation,
            pvi_elevation,
            after_elevation,
            incoming_run,
            outgoing_run,
        ]
        .iter()
        .all(|value| value.is_finite())
        {
            return Err(LandXmlProfileEvaluationError::NonFiniteEvaluation);
        }
        if incoming_run <= 0.0 || outgoing_run <= 0.0 {
            return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
        }
        let incoming_grade = (pvi_elevation - before_elevation) / incoming_run;
        let outgoing_grade = (after_elevation - pvi_elevation) / outgoing_run;
        if !incoming_grade.is_finite() || !outgoing_grade.is_finite() {
            return Err(LandXmlProfileEvaluationError::NonFiniteEvaluation);
        }
        let (start, end) = curve_bounds(curve, pvi.station, incoming_grade, outgoing_grade)?;
        if start < before.station
            || end > after.station
            || previous_end.is_some_and(|previous| start < previous)
        {
            return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
        }
        previous_end = Some(end);
    }
    Ok(())
}

fn curve_bounds(
    curve: &LandXmlVerticalCurve,
    pvi_station: f64,
    incoming_grade: f64,
    outgoing_grade: f64,
) -> Result<(f64, f64), LandXmlProfileEvaluationError> {
    let (start, end) = match curve.kind {
        LandXmlVerticalCurveKind::Parabolic => {
            let Some(length) = curve
                .length
                .filter(|value| value.is_finite() && *value > 0.0)
            else {
                return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
            };
            (pvi_station - length / 2.0, pvi_station + length / 2.0)
        }
        LandXmlVerticalCurveKind::UnsymmetricalParabolic => {
            let (Some(length_in), Some(length_out)) = (curve.length_in, curve.length_out) else {
                return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
            };
            if !length_in.is_finite()
                || !length_out.is_finite()
                || length_in <= 0.0
                || length_out <= 0.0
            {
                return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
            }
            (pvi_station - length_in, pvi_station + length_out)
        }
        LandXmlVerticalCurveKind::Circular => circular_bounds(
            pvi_station,
            incoming_grade,
            outgoing_grade,
            curve.length,
            curve.radius,
        )?,
    };
    if !start.is_finite() || !end.is_finite() || start >= end {
        return Err(LandXmlProfileEvaluationError::NonFiniteEvaluation);
    }
    Ok((start, end))
}

fn evaluate_parabolic(
    station: f64,
    pvi_station: f64,
    pvi_elevation: f64,
    incoming_grade: f64,
    outgoing_grade: f64,
    length: Option<f64>,
) -> Result<Option<f64>, LandXmlProfileEvaluationError> {
    let Some(length) = length.filter(|value| value.is_finite() && *value > 0.0) else {
        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
    };
    let half = length / 2.0;
    let start = pvi_station - half;
    if station < start || station > pvi_station + half {
        return Ok(None);
    }
    let x = station - start;
    finite_elevation(
        pvi_elevation - incoming_grade * half
            + incoming_grade * x
            + (outgoing_grade - incoming_grade) * x * x / (2.0 * length),
    )
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
    if !length_in.is_finite() || !length_out.is_finite() || length_in <= 0.0 || length_out <= 0.0 {
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
        return finite_elevation(
            start_elevation + incoming_grade * x + incoming_rate * x * x / 2.0,
        );
    }
    let at_pvi =
        start_elevation + incoming_grade * length_in + incoming_rate * length_in * length_in / 2.0;
    let pvi_grade = incoming_grade + incoming_rate * length_in;
    let local = x - length_in;
    finite_elevation(at_pvi + pvi_grade * local + outgoing_rate * local * local / 2.0)
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
    let Some(total) = length.filter(|value| value.is_finite() && *value > 0.0) else {
        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
    };
    let Some(radius) = radius.filter(|value| value.is_finite() && *value > 0.0) else {
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
    let (start, end) = circular_bounds(
        pvi_station,
        incoming_grade,
        outgoing_grade,
        length,
        Some(radius),
    )?;
    let start_relative_to_pvi = start - pvi_station;
    if station < start || station > end {
        return Ok(None);
    }
    let sine = sine_in + curvature * (station - start);
    if sine.abs() > 1.0 + 1.0e-12 {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    finite_elevation(
        pvi_elevation
            + incoming_grade * start_relative_to_pvi
            + ((1.0 - sine_in * sine_in).sqrt() - (1.0 - sine * sine).max(0.0).sqrt()) / curvature,
    )
}

fn circular_bounds(
    pvi_station: f64,
    incoming_grade: f64,
    outgoing_grade: f64,
    length: Option<f64>,
    radius: Option<f64>,
) -> Result<(f64, f64), LandXmlProfileEvaluationError> {
    let Some(total) = length.filter(|value| value.is_finite() && *value > 0.0) else {
        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
    };
    let Some(radius) = radius.filter(|value| value.is_finite() && *value > 0.0) else {
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
    if !rise.is_finite() || !grade_change.is_finite() || grade_change.abs() <= f64::EPSILON {
        return Err(LandXmlProfileEvaluationError::NonFiniteEvaluation);
    }
    let start_relative_to_pvi = (rise - outgoing_grade * total) / grade_change;
    let end_relative_to_pvi = start_relative_to_pvi + total;
    if !start_relative_to_pvi.is_finite() || !end_relative_to_pvi.is_finite() {
        return Err(LandXmlProfileEvaluationError::NonFiniteEvaluation);
    }
    if start_relative_to_pvi >= 0.0 || end_relative_to_pvi <= 0.0 {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    Ok((
        pvi_station + start_relative_to_pvi,
        pvi_station + end_relative_to_pvi,
    ))
}

fn finite_elevation(value: f64) -> Result<Option<f64>, LandXmlProfileEvaluationError> {
    if value.is_finite() {
        Ok(Some(value))
    } else {
        Err(LandXmlProfileEvaluationError::NonFiniteEvaluation)
    }
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
        if !left.station.is_finite()
            || !right.station.is_finite()
            || !left_elevation.is_finite()
            || !right_elevation.is_finite()
            || !run.is_finite()
        {
            return Err(LandXmlProfileEvaluationError::NonFiniteEvaluation);
        }
        if run <= 0.0 {
            return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
        }
        return finite_elevation(
            left_elevation + (station - left.station) * (right_elevation - left_elevation) / run,
        );
    }
    Ok(None)
}
