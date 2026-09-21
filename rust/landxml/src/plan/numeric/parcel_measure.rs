/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::{
    measure::{arc_delta, cross, distance, finite_measure, finite_point, finite_sum, same_point},
    topology::segments_intersect,
    LandXmlPlanDocument, LandXmlPlanGeometry, LandXmlPlanPoint, ParcelProbeWork,
};

const EPSILON: f64 = 1e-9;
type GeometryMeasure = (f64, f64, Vec<(LandXmlPlanPoint, LandXmlPlanPoint)>);

pub(super) struct LoopProbe {
    pub(super) perimeter: f64,
    pub(super) twice_area: f64,
    pub(super) self_intersects: bool,
    pub(super) segments: Vec<(LandXmlPlanPoint, LandXmlPlanPoint)>,
}

pub(super) fn probe_loop<W: ParcelProbeWork>(
    document: &LandXmlPlanDocument,
    geometry: &[LandXmlPlanGeometry],
    work: &mut W,
) -> std::result::Result<Option<LoopProbe>, crate::LandXmlError> {
    let mut segments = Vec::with_capacity(geometry.len());
    let mut perimeter = 0.0;
    let mut twice_area = 0.0;
    let mut previous_end = None;
    let mut area_origin = None;
    for item in geometry {
        work.check()?;
        let Some(start) = work.resolve(document, item.point_scope_id.as_ref(), &item.start)? else {
            return Ok(None);
        };
        let Some(end) = work.resolve(document, item.point_scope_id.as_ref(), &item.end)? else {
            return Ok(None);
        };
        if !finite_point(start) || !finite_point(end) {
            return Ok(None);
        }
        if previous_end.is_some_and(|previous| !same_point(previous, start)) {
            return Ok(None);
        }
        let origin = *area_origin.get_or_insert(start);
        let Some((length, integral, edges)) =
            geometry_measure(document, item, start, end, origin, work)?
        else {
            return Ok(None);
        };
        perimeter = finite_sum(perimeter, length)?;
        twice_area = finite_sum(twice_area, integral)?;
        segments.extend(edges);
        previous_end = Some(end);
    }
    let (Some(first), Some(last)) = (
        geometry
            .first()
            .map(|item| work.resolve(document, item.point_scope_id.as_ref(), &item.start))
            .transpose()?
            .flatten(),
        previous_end,
    ) else {
        return Ok(None);
    };
    if !same_point(first, last) {
        return Ok(None);
    }
    Ok(Some(LoopProbe {
        perimeter,
        twice_area,
        self_intersects: segments_intersect(&[], &segments, work)?,
        segments,
    }))
}

fn geometry_measure<W: ParcelProbeWork>(
    document: &LandXmlPlanDocument,
    geometry: &LandXmlPlanGeometry,
    start: LandXmlPlanPoint,
    end: LandXmlPlanPoint,
    area_origin: LandXmlPlanPoint,
    work: &mut W,
) -> std::result::Result<Option<GeometryMeasure>, crate::LandXmlError> {
    match geometry.kind {
        super::LandXmlGeometryKind::Line => Ok(Some((
            distance(start, end)?,
            cross(start, end, area_origin)?,
            vec![(start, end)],
        ))),
        super::LandXmlGeometryKind::IrregularLine => {
            let mut points = Vec::with_capacity(geometry.intermediate_points.len() + 2);
            points.push(start);
            points.extend(geometry.intermediate_points.iter().copied());
            points.push(end);
            let mut length = 0.0;
            let mut integral = 0.0;
            for pair in points.windows(2) {
                if !finite_point(pair[0]) || !finite_point(pair[1]) {
                    return Ok(None);
                }
                length = finite_sum(length, distance(pair[0], pair[1])?)?;
                integral = finite_sum(integral, cross(pair[0], pair[1], area_origin)?)?;
            }
            let edges = points.windows(2).map(|pair| (pair[0], pair[1])).collect();
            Ok(Some((length, integral, edges)))
        }
        super::LandXmlGeometryKind::Curve => {
            let Some(center_location) = geometry.center.as_ref() else {
                return Ok(None);
            };
            let Some(center) =
                work.resolve(document, geometry.point_scope_id.as_ref(), center_location)?
            else {
                return Ok(None);
            };
            if !finite_point(center) {
                return Ok(None);
            }
            let radius = geometry.radius.unwrap_or(distance(center, start)?);
            if radius <= EPSILON
                || !radius.is_finite()
                || (distance(center, start)? - radius).abs() > EPSILON
                || (distance(center, end)? - radius).abs() > EPSILON
            {
                return Ok(None);
            }
            let start_angle =
                (start.northing - center.northing).atan2(start.easting - center.easting);
            let end_angle = (end.northing - center.northing).atan2(end.easting - center.easting);
            let Some(delta) = arc_delta(
                start_angle,
                end_angle,
                geometry.rotation.as_deref(),
                geometry.declared_length,
                radius,
            ) else {
                return Ok(None);
            };
            let center_easting = center.easting - area_origin.easting;
            let center_northing = center.northing - area_origin.northing;
            let start_northing = start.northing - area_origin.northing;
            let start_easting = start.easting - area_origin.easting;
            let end_northing = end.northing - area_origin.northing;
            let end_easting = end.easting - area_origin.easting;
            let integral = center_easting * (end_northing - start_northing)
                - center_northing * (end_easting - start_easting)
                + radius * radius * delta;
            let edges = curve_edges(center, start, end, radius, start_angle, delta);
            Ok(Some((
                finite_measure(radius * delta.abs())?,
                finite_measure(integral)?,
                edges,
            )))
        }
    }
}

/// A bounded, deterministic polyline is used only for topology intersection
/// checks; analytic perimeter and area remain the exact circular formulae.
fn curve_edges(
    center: LandXmlPlanPoint,
    start: LandXmlPlanPoint,
    end: LandXmlPlanPoint,
    radius: f64,
    start_angle: f64,
    delta: f64,
) -> Vec<(LandXmlPlanPoint, LandXmlPlanPoint)> {
    const MAX_SEGMENTS: usize = 64;
    let count = ((delta.abs() / std::f64::consts::TAU * MAX_SEGMENTS as f64).ceil() as usize)
        .clamp(1, MAX_SEGMENTS);
    let mut points = Vec::with_capacity(count + 1);
    points.push(start);
    for index in 1..count {
        let angle = start_angle + delta * index as f64 / count as f64;
        points.push(LandXmlPlanPoint {
            northing: center.northing + radius * angle.sin(),
            easting: center.easting + radius * angle.cos(),
            elevation: None,
        });
    }
    points.push(end);
    points.windows(2).map(|pair| (pair[0], pair[1])).collect()
}
