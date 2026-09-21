/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::LandXmlProfileEvaluationError;

pub(crate) struct CircularGeometry {
    pub(crate) curvature: f64,
    pub(crate) sine_in: f64,
    pub(crate) cosine_in: f64,
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
    let incoming_norm = incoming_grade.hypot(1.0);
    let outgoing_norm = outgoing_grade.hypot(1.0);
    let sine_in = incoming_grade / incoming_norm;
    let cosine_in = incoming_norm.recip();
    let cosine_out = outgoing_norm.recip();
    let grade_delta = outgoing_grade - incoming_grade;
    if grade_delta == 0.0 {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let norms_product = incoming_norm * outgoing_norm;
    let cross = grade_delta / norms_product;
    let dot = (1.0 + incoming_grade * outgoing_grade) / norms_product;
    let tangent_half = if dot >= 0.0 {
        cross / (1.0 + dot)
    } else {
        (1.0 - dot) / cross
    };
    // sin(theta_out) - sin(theta_in) = tan(delta / 2) *
    // (cos(theta_in) + cos(theta_out)). This stays finite for both nearly
    // parallel steep grades and nearly opposing vertical tangents.
    let change = tangent_half * (cosine_in + cosine_out);
    if change == 0.0 {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let expected_length = radius * change.abs();
    // Both values are already represented f64 source quantities. Compare them
    // at their own scale; do not grant a radius-amplified source allowance.
    let tolerance = 32.0 * f64::EPSILON * length.max(expected_length).max(1.0);
    if !expected_length.is_finite()
        || !tolerance.is_finite()
        || (length - expected_length).abs() > tolerance
    {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let curvature = change.signum() / radius;
    let tangent_length = tangent_half / curvature;
    let start_tangent = tangent_length * cosine_in;
    let end_tangent = tangent_length * cosine_out;
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
        cosine_in,
        start_tangent,
        end_tangent,
    })
}

/// Rise from a curve start, retaining the local sine delta as a separate term.
pub(crate) fn circular_rise(
    geometry: &CircularGeometry,
    horizontal_distance: f64,
) -> Result<f64, LandXmlProfileEvaluationError> {
    let delta_sine = geometry.curvature * horizontal_distance;
    let cosine_squared = geometry.cosine_in * geometry.cosine_in
        - 2.0 * geometry.sine_in * delta_sine
        - delta_sine * delta_sine;
    if !delta_sine.is_finite() || cosine_squared < -1.0e-12 {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let cosine_at_station = cosine_squared.max(0.0).sqrt();
    let denominator = geometry.cosine_in + cosine_at_station;
    let rise = horizontal_distance * (2.0 * geometry.sine_in + delta_sine) / denominator;
    if rise.is_finite() {
        Ok(rise)
    } else {
        Err(LandXmlProfileEvaluationError::NonFiniteEvaluation)
    }
}
