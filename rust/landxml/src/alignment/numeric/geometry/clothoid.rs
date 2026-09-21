// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounded clothoid evaluation kept separate from primitive dispatch.

use super::super::{diagnostic, Result, EPSILON};
use crate::{alignment::{LandXmlPlanPoint, LandXmlRadius, LandXmlSpiral}, LandXmlSourceId};

pub(super) fn validate_domain(id: &LandXmlSourceId, value: &LandXmlSpiral) -> Result<()> {
    let length = valid_length(id, value.declared_length)?;
    let k0 = curvature(id, value.radius_start)?;
    let k1 = curvature(id, value.radius_end)?;
    if (k0 * length).abs().max((k1 * length).abs()) > 2.0 {
        return Err(diagnostic(id, "LXMLA223", "clothoid exceeds the supported bounded quadrature domain"));
    }
    Ok(())
}

pub(super) fn evaluate(id: &LandXmlSourceId, value: &LandXmlSpiral, distance: f64) -> Result<(LandXmlPlanPoint, (f64, f64))> {
    if value.spi_type != "clothoid" { return Err(diagnostic(id, "LXMLA209", "transition is retained but not numerically supported")); }
    let start = coordinates(id, &value.start)?; let end = coordinates(id, &value.end)?; let pi = coordinates(id, &value.pi)?;
    let length = valid_length(id, value.declared_length)?; let (k0, k1) = (curvature(id, value.radius_start)?, curvature(id, value.radius_end)?);
    validate_domain(id, value)?;
    let signed = value.rotation.sign(); let local_end = integral(length, length, signed * k0, signed * k1)?;
    let heading = (end.northing - start.northing).atan2(end.easting - start.easting) - local_end.1.atan2(local_end.0);
    let tolerance = (length * 1e-6).max(1e-6);
    if distance_between(transform_local(start, local_end, heading), end) > tolerance { return Err(diagnostic(id, "LXMLA216", "clothoid endpoint is inconsistent with length and radii")); }
    let end_theta = heading + signed * (k0 * length + 0.5 * (k1 - k0) * length);
    if tangent_line_distance(start, pi, heading) > tolerance || tangent_line_distance(end, pi, end_theta) > tolerance { return Err(diagnostic(id, "LXMLA217", "clothoid PI is inconsistent with endpoint tangents")); }
    let d = distance.clamp(0.0, length); let local = integral(d, length, signed * k0, signed * k1)?;
    let theta = heading + signed * (k0 * d + 0.5 * (k1 - k0) * d * d / length);
    Ok((transform_local(start, local, heading), (theta.sin(), theta.cos())))
}

fn coordinates(id: &LandXmlSourceId, value: &crate::alignment::LandXmlPointLocation) -> Result<LandXmlPlanPoint> { match value { crate::alignment::LandXmlPointLocation::Coordinates { point } if point.northing.is_finite() && point.easting.is_finite() && point.elevation.is_none_or(f64::is_finite) => Ok(*point), crate::alignment::LandXmlPointLocation::Coordinates { .. } => Err(diagnostic(id, "LXMLA222", "primitive coordinate must be finite")), crate::alignment::LandXmlPointLocation::PointReference { .. } => Err(diagnostic(id, "LXMLA211", "pntRef requires the later COGO resolver")) } }
fn curvature(id: &LandXmlSourceId, value: LandXmlRadius) -> Result<f64> { match value { LandXmlRadius::Infinite => Ok(0.0), LandXmlRadius::Finite(radius) if radius.is_finite() && radius > EPSILON => Ok(1.0 / radius), LandXmlRadius::Finite(_) => Err(diagnostic(id, "LXMLA212", "spiral radius must be positive or INF")) } }
fn valid_length(id: &LandXmlSourceId, value: f64) -> Result<f64> { if !value.is_finite() || value <= EPSILON { Err(diagnostic(id, "LXMLA215", "primitive length must be positive and finite")) } else { Ok(value) } }
fn integral(distance: f64, length: f64, k0: f64, k1: f64) -> Result<(f64, f64)> { const NODES: [f64; 8] = [0.095_012_509_837_637_4, 0.281_603_550_779_259, 0.458_016_777_657_227, 0.617_876_244_402_644, 0.755_404_408_355_003, 0.865_631_202_387_832, 0.944_575_023_073_233, 0.989_400_934_991_65]; const WEIGHTS: [f64; 8] = [0.189_450_610_455_069, 0.182_603_415_044_924, 0.169_156_519_395_003, 0.149_595_988_816_577, 0.124_628_971_255_534, 0.095_158_511_682_493_2, 0.062_253_523_938_647_9, 0.027_152_459_411_754_1]; if !distance.is_finite() || !length.is_finite() || length <= EPSILON { return Err(diagnostic(&LandXmlSourceId("landxml:spiral".to_owned()), "LXMLA213", "invalid clothoid length")); } let half = distance * 0.5; let mut x = 0.0; let mut y = 0.0; for (node, weight) in NODES.into_iter().zip(WEIGHTS) { for sign in [-1.0, 1.0] { let s = half * (1.0 + sign * node); let theta = k0 * s + 0.5 * (k1 - k0) * s * s / length; x += weight * theta.cos(); y += weight * theta.sin(); } } Ok((x * half, y * half)) }
fn transform_local(start: LandXmlPlanPoint, local: (f64, f64), heading: f64) -> LandXmlPlanPoint { let (sin, cos) = heading.sin_cos(); LandXmlPlanPoint { northing: start.northing + local.0 * sin + local.1 * cos, easting: start.easting + local.0 * cos - local.1 * sin, elevation: None } }
fn tangent_line_distance(origin: LandXmlPlanPoint, point: LandXmlPlanPoint, heading: f64) -> f64 { let (sin, cos) = heading.sin_cos(); ((point.northing - origin.northing) * cos - (point.easting - origin.easting) * sin).abs() }
fn distance_between(left: LandXmlPlanPoint, right: LandXmlPlanPoint) -> f64 { (right.northing - left.northing).hypot(right.easting - left.easting) }
