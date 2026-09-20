/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

pub(super) fn arc_delta(
    start: f64,
    end: f64,
    rotation: Option<&str>,
    declared_length: Option<f64>,
    radius: f64,
) -> Option<f64> {
    let tau = std::f64::consts::TAU;
    let primary = match rotation {
        Some("ccw") => Some((end - start).rem_euclid(tau)),
        Some("cw") => Some(-((start - end).rem_euclid(tau))),
        _ => None,
    }?;
    // A closed point pair has no signed sweep under either rotation. Treating
    // it as an analytic arc fabricates a zero-length/zero-area primitive.
    if primary.abs() <= EPSILON {
        return None;
    }
    if let Some(length) = declared_length {
        let tolerance = EPSILON * radius.max(length).max(1.0);
        if (radius * primary.abs() - length).abs() > tolerance {
            return None;
        }
    }
    Some(primary)
}

pub(super) fn same_point(left: LandXmlPlanPoint, right: LandXmlPlanPoint) -> bool {
    (left.northing - right.northing).hypot(left.easting - right.easting) <= EPSILON
}

pub(super) fn distance(
    left: LandXmlPlanPoint,
    right: LandXmlPlanPoint,
) -> std::result::Result<f64, crate::LandXmlError> {
    finite_measure((left.northing - right.northing).hypot(left.easting - right.easting))
}

pub(super) fn cross(
    left: LandXmlPlanPoint,
    right: LandXmlPlanPoint,
    origin: LandXmlPlanPoint,
) -> std::result::Result<f64, crate::LandXmlError> {
    finite_measure(
        (left.easting - origin.easting) * (right.northing - origin.northing)
            - (left.northing - origin.northing) * (right.easting - origin.easting),
    )
}

pub(super) fn finite_point(point: LandXmlPlanPoint) -> bool {
    point.northing.is_finite()
        && point.easting.is_finite()
        && point.elevation.is_none_or(f64::is_finite)
}

pub(super) fn finite_sum(left: f64, right: f64) -> std::result::Result<f64, crate::LandXmlError> {
    finite_measure(left + right)
}

pub(super) fn finite_measure(value: f64) -> std::result::Result<f64, crate::LandXmlError> {
    value.is_finite().then_some(value).ok_or_else(|| {
        crate::LandXmlError::new(
            crate::LandXmlDiagnosticCode::InvalidSemantic,
            "parcel has a non-finite measurement or unit conversion",
        )
    })
}
