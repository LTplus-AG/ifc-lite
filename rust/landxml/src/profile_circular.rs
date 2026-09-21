/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::LandXmlProfileEvaluationError;

pub(crate) struct CircularGeometry {
    pub(crate) curvature: f64,
    pub(crate) sine_in: f64,
    pub(crate) start_tangent: f64,
    pub(crate) end_tangent: f64,
}

/// Validate one circular vertical-curve declaration in length units.
pub(crate) fn circular_geometry(
    incoming_grade: f64,
    outgoing_grade: f64,
    length: Option<f64>,
    radius: Option<f64>,
) -> Result<CircularGeometry, LandXmlProfileEvaluationError> {
    let Some(length) = length.filter(|value| value.is_finite() && *value > 0.0) else {
        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
    };
    let Some(radius) = radius.filter(|value| value.is_finite() && *value > 0.0) else {
        return Err(LandXmlProfileEvaluationError::InvalidCurveDeclaration);
    };
    let sine_in = incoming_grade.atan().sin();
    let sine_out = outgoing_grade.atan().sin();
    let change = sine_out - sine_in;
    if change == 0.0 {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let expected_length = radius * change.abs();
    // Subtracting two nearly equal sines loses a few ulps of each tangent.
    // Convert that round-off to length units before comparing source values.
    let sine_scale = sine_in.abs().max(sine_out.abs());
    let roundoff = 16.0 * f64::EPSILON * radius * sine_scale;
    let tolerance = 1.0e-10 * length.max(expected_length).max(1.0) + roundoff;
    if !expected_length.is_finite()
        || !tolerance.is_finite()
        || (length - expected_length).abs() > tolerance
    {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let curvature = change.signum() / radius;
    let half_angle = (outgoing_grade.atan() - incoming_grade.atan()) / 2.0;
    let tangent_length = half_angle.tan() / curvature;
    let start_tangent = tangent_length * (1.0 - sine_in * sine_in).sqrt();
    let end_tangent = tangent_length * (1.0 - sine_out * sine_out).sqrt();
    if !tangent_length.is_finite()
        || !start_tangent.is_finite()
        || !end_tangent.is_finite()
        || start_tangent <= 0.0
        || end_tangent <= 0.0
    {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    Ok(CircularGeometry {
        curvature,
        sine_in,
        start_tangent,
        end_tangent,
    })
}

/// `sqrt(1 - a²) - sqrt(1 - b²)` without losing shallow vertical offsets.
pub(crate) fn cosine_difference(sine_in: f64, sine_at_station: f64) -> f64 {
    let sine_at_station = sine_at_station.clamp(-1.0, 1.0);
    let cosine_in = (1.0 - sine_in * sine_in).sqrt();
    let cosine_at_station = (1.0 - sine_at_station * sine_at_station).sqrt();
    (sine_at_station - sine_in) * (sine_at_station + sine_in) / (cosine_in + cosine_at_station)
}
