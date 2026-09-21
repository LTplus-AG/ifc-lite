/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use crate::LandXmlProfileEvaluationError;

pub(crate) struct CircularGeometry {
    pub(crate) length: f64,
    pub(crate) curvature: f64,
    pub(crate) sine_in: f64,
    pub(crate) sine_out: f64,
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
    if change.abs() <= f64::EPSILON {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    let expected_length = radius * change.abs();
    let tolerance = 1.0e-10 * length.max(expected_length).max(1.0);
    if !expected_length.is_finite() || (length - expected_length).abs() > tolerance {
        return Err(LandXmlProfileEvaluationError::InconsistentCircularCurve);
    }
    Ok(CircularGeometry {
        length,
        curvature: change.signum() / radius,
        sine_in,
        sine_out,
    })
}
