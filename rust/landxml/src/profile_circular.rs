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
    let sine_out = outgoing_grade / outgoing_norm;
    let cosine_in = incoming_norm.recip();
    let cosine_out = outgoing_norm.recip();
    let grade_delta = outgoing_grade - incoming_grade;
    if grade_delta == 0.0 {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let dot = cosine_in * cosine_out + sine_in * sine_out;
    let cosine_sum = cosine_in + cosine_out;
    let (tangent_length, expected_length) = if grade_delta.is_finite() {
        let delta = grade_delta.abs();
        if dot >= 0.0 {
            (
                scaled_ratio(&[radius, delta], &[incoming_norm, outgoing_norm, 1.0 + dot]),
                scaled_ratio(
                    &[radius, delta, cosine_sum],
                    &[incoming_norm, outgoing_norm, 1.0 + dot],
                ),
            )
        } else {
            (
                scaled_ratio(&[radius, 1.0 - dot, incoming_norm, outgoing_norm], &[delta]),
                scaled_ratio(
                    &[radius, 1.0 - dot, incoming_norm, outgoing_norm, cosine_sum],
                    &[delta],
                ),
            )
        }
    } else {
        let cross = cosine_in * sine_out - sine_in * cosine_out;
        if cross == 0.0 {
            return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
        }
        if dot >= 0.0 {
            (
                scaled_ratio(&[radius, cross.abs()], &[1.0 + dot]),
                scaled_ratio(&[radius, cross.abs(), cosine_sum], &[1.0 + dot]),
            )
        } else {
            (
                scaled_ratio(&[radius, 1.0 - dot], &[cross.abs()]),
                scaled_ratio(&[radius, 1.0 - dot, cosine_sum], &[cross.abs()]),
            )
        }
    };
    // sin(theta_out) - sin(theta_in) = tan(delta / 2) *
    // (cos(theta_in) + cos(theta_out)). This stays finite for both nearly
    // parallel steep grades and nearly opposing vertical tangents.
    // Both values are already represented f64 source quantities. Compare them
    // at their own scale; do not grant a radius-amplified source allowance.
    let tolerance = 32.0 * ulp(length).max(ulp(expected_length));
    if !expected_length.is_finite()
        || !tolerance.is_finite()
        || (length - expected_length).abs() > tolerance
    {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let curvature = grade_delta.signum() / radius;
    let start_tangent = scaled_ratio(&[tangent_length, cosine_in], &[]);
    let end_tangent = scaled_ratio(&[tangent_length, cosine_out], &[]);
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

fn ulp(value: f64) -> f64 {
    let magnitude = value.abs();
    let gap = magnitude.next_up() - magnitude;
    if gap.is_finite() && gap > 0.0 {
        gap
    } else {
        f64::from_bits(1)
    }
}

fn scaled_ratio(numerators: &[f64], denominators: &[f64]) -> f64 {
    let mut mantissa = 1.0;
    let mut exponent = 0_i32;
    for value in numerators {
        let (part, power) = binary_parts(*value);
        mantissa *= part;
        exponent += power;
    }
    for value in denominators {
        let (part, power) = binary_parts(*value);
        mantissa /= part;
        exponent -= power;
    }
    mantissa * 2.0_f64.powi(exponent)
}

fn binary_parts(value: f64) -> (f64, i32) {
    let magnitude = value.abs();
    if magnitude == 0.0 {
        return (0.0, 0);
    }
    let bits = magnitude.to_bits();
    let raw_exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    if raw_exponent == 0 {
        let (mantissa, exponent) = binary_parts(magnitude * 4_503_599_627_370_496.0);
        (mantissa, exponent - 52)
    } else {
        (
            f64::from_bits((1023_u64 << 52) | fraction),
            raw_exponent - 1023,
        )
    }
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
